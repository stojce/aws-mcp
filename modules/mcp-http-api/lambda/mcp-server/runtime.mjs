// Stateless MCP server runtime (Streamable HTTP, single JSON response per POST).
// Pure: no AWS SDK imports. The Lambda entrypoint injects the tool invoker.

import { compileSchema } from './schema-validator.mjs';

export const LATEST_PROTOCOL_VERSION = '2025-06-18';
export const SUPPORTED_PROTOCOL_VERSIONS = [LATEST_PROTOCOL_VERSION];
const DEFAULT_PROTOCOL_VERSION = '2025-03-26';

const ERR = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
};

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isRequestId = id => typeof id === 'string' || Number.isSafeInteger(id);
const requestMethods = new Set(['initialize', 'ping', 'tools/list', 'tools/call']);

function classifyMessage(msg) {
  if (!isObject(msg) || msg.jsonrpc !== '2.0') return 'invalid';
  if ('method' in msg) {
    if (typeof msg.method !== 'string' || 'result' in msg || 'error' in msg) return 'invalid';
    if ('params' in msg && !isObject(msg.params)) return 'invalid';
    if (msg.params && '_meta' in msg.params && !isObject(msg.params._meta)) return 'invalid';
    if (!('id' in msg)) {
      if (requestMethods.has(msg.method)) return 'invalid';
      if (msg.method === 'notifications/cancelled' && (!isObject(msg.params)
        || !isRequestId(msg.params.requestId)
        || ('reason' in msg.params && typeof msg.params.reason !== 'string'))) return 'invalid';
      return 'notification';
    }
    if (!isRequestId(msg.id) || msg.method.startsWith('notifications/')) return 'invalid';
    return 'request';
  }
  if (!isRequestId(msg.id) || ('result' in msg) === ('error' in msg)) return 'invalid';
  if ('error' in msg && (!isObject(msg.error) || !Number.isInteger(msg.error.code)
    || typeof msg.error.message !== 'string')) return 'invalid';
  return 'response';
}

function validInitializeParams(params) {
  if (!isObject(params) || typeof params.protocolVersion !== 'string' || !params.protocolVersion
    || !isObject(params.capabilities) || !isObject(params.clientInfo)
    || typeof params.clientInfo.name !== 'string' || !params.clientInfo.name
    || typeof params.clientInfo.version !== 'string' || !params.clientInfo.version) return false;
  if ('title' in params.clientInfo && typeof params.clientInfo.title !== 'string') return false;
  for (const name of ['experimental', 'roots', 'sampling', 'elicitation']) {
    if (name in params.capabilities && !isObject(params.capabilities[name])) return false;
  }
  if (params.capabilities.experimental && !Object.values(params.capabilities.experimental).every(isObject)) return false;
  const roots = params.capabilities.roots;
  return !roots || !('listChanged' in roots) || typeof roots.listChanged === 'boolean';
}

const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });

const toolResult = (text, isError) => ({
  content: [{ type: 'text', text }],
  isError,
});

// Authorization double-check. API Gateway's JWT authorizer already enforced the
// issuer and the route scope; this re-verifies that the token was issued to the
// MCP app client (ID tokens and web-client tokens are rejected here).
export function authorize(claims, { clientId, requiredScope, resourceUrl, allowUnboundAccessTokens = false }) {
  if (typeof resourceUrl !== 'string' || resourceUrl === '') {
    return { ok: false, status: 401, error: 'invalid_token' };
  }
  if (!isObject(claims) || typeof claims.sub !== 'string' || claims.sub === '') {
    return { ok: false, status: 401, error: 'invalid_token' };
  }
  if (claims.token_use !== 'access' || claims.client_id !== clientId) {
    return { ok: false, status: 401, error: 'invalid_token' };
  }
  if (claims.aud === undefined) {
    if (!allowUnboundAccessTokens) return { ok: false, status: 401, error: 'invalid_token' };
  } else if (!(Array.isArray(claims.aud) ? claims.aud : [claims.aud]).includes(resourceUrl)) {
    return { ok: false, status: 401, error: 'invalid_token' };
  }
  const scopes = String(claims.scope ?? '').split(' ');
  if (!scopes.includes(requiredScope)) {
    return { ok: false, status: 403, error: 'insufficient_scope', scope: requiredScope };
  }
  return { ok: true, identity: { sub: claims.sub, clientId: claims.client_id } };
}

const toolValidators = new WeakMap();

// Called at Lambda startup, before serving initialize or advertising any tools.
// Direct runtime callers use the same initialization path on their first message.
export function initializeTools(tools) {
  if (toolValidators.has(tools)) return toolValidators.get(tools);
  if (!Array.isArray(tools)) throw new Error('tools must be an array');
  const validators = new Map();
  for (const tool of tools) {
    try {
      if (!isObject(tool.inputSchema) || tool.inputSchema.type !== 'object') {
        throw new Error('inputSchema must be an object schema with type "object"');
      }
      validators.set(tool, compileSchema(tool.inputSchema));
    } catch (error) {
      throw new Error(`Invalid input schema for tool ${tool.name}: ${error.message}`, { cause: error });
    }
  }
  toolValidators.set(tools, validators);
  return validators;
}

function validateArguments(args, validate) {
  if (!isObject(args)) return 'arguments must be an object';
  if (!validate(args)) {
    const error = validate.errors[0];
    if (error.keyword === 'required' && error.instancePath === '') {
      return `missing required argument: ${error.params.missingProperty}`;
    }
    return `invalid arguments at ${error.instancePath || '/'}: ${error.message}`;
  }
  return null;
}

class ToolTimeoutError extends Error {}

async function invokeToolWithDeadline(input, ctx) {
  const timeoutMs = (ctx.toolDeadlineMs ?? Date.now() + (ctx.toolTimeoutMs ?? 27000)) - Date.now();
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new ToolTimeoutError();
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      reject(new ToolTimeoutError());
      controller.abort();
    }, timeoutMs);
  });
  try {
    return await Promise.race([ctx.invokeTool(input, { abortSignal: controller.signal }), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function handleToolsCall(id, params, ctx) {
  if (!isObject(params) || typeof params.name !== 'string' || !params.name) {
    return rpcError(id, ERR.invalidParams, 'tools/call requires a string name');
  }
  const tool = ctx.tools.find(t => t.name === params.name);
  if (!tool) {
    return rpcError(id, ERR.invalidParams, `unknown tool: ${params.name}`);
  }
  const args = params.arguments === undefined ? {} : params.arguments;
  const invalid = validateArguments(args, initializeTools(ctx.tools).get(tool));
  if (invalid) return rpcResult(id, toolResult(invalid, true));

  try {
    const payload = await invokeToolWithDeadline({ tool: tool.name, arguments: args, identity: ctx.identity }, ctx);
    return rpcResult(id, toolResult(JSON.stringify(payload ?? null), false));
  } catch (error) {
    // Backend internals are not returned to the client.
    return rpcResult(id, toolResult(error instanceof ToolTimeoutError ? 'Tool execution timed out' : 'Tool execution failed', true));
  }
}

// Returns a JSON-RPC response object, or null for notifications.
export async function handleMessage(msg, ctx) {
  initializeTools(ctx.tools);
  const kind = classifyMessage(msg);
  if (kind === 'invalid' || kind === 'response') {
    return rpcError(null, ERR.invalidRequest, 'invalid JSON-RPC request');
  }
  if (kind === 'notification') return null;

  const { id, method, params } = msg;
  switch (method) {
    case 'initialize': {
      if (!validInitializeParams(params)) {
        return rpcError(id, ERR.invalidParams, 'initialize requires protocolVersion, capabilities, and complete clientInfo');
      }
      const requested = params.protocolVersion;
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
        ? requested
        : LATEST_PROTOCOL_VERSION;
      return rpcResult(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: ctx.serverInfo,
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      if (params?.cursor !== undefined && typeof params.cursor !== 'string') {
        return rpcError(id, ERR.invalidParams, 'tools/list cursor must be a string');
      }
      return rpcResult(id, {
        tools: ctx.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      });
    case 'tools/call':
      return handleToolsCall(id, params, ctx);
    default:
      return rpcError(id, ERR.methodNotFound, `method not found: ${method}`);
  }
}

const json = (statusCode, body, headers = {}) => ({
  statusCode,
  headers: { 'content-type': 'application/json', ...headers },
  body: body === undefined ? '' : JSON.stringify(body),
});

const corsMethods = ['GET', 'POST', 'OPTIONS'];
const corsRequestHeaders = ['authorization', 'content-type', 'mcp-protocol-version', 'accept'];

function allowedOrigin(origin, origins) {
  if (typeof origin !== 'string' || !origins.includes(origin)) return false;
  try {
    const url = new URL(origin);
    return ['http:', 'https:'].includes(url.protocol) && url.origin === origin;
  } catch {
    return false;
  }
}

// HTTP adapter for API Gateway HTTP API payload format 2.0.
export async function handleHttpEvent(event, cfg) {
  const method = event?.requestContext?.http?.method ?? event?.httpMethod;
  const headers = Object.entries(event?.headers ?? {});
  const originHeaders = headers.filter(([name]) => name.toLowerCase() === 'origin');
  const origin = originHeaders[0]?.[1];
  if (originHeaders.length > 1 || (originHeaders.length === 1 && !allowedOrigin(origin, cfg.allowedOrigins ?? []))) {
    return json(403, { error: 'origin_not_allowed' });
  }
  const corsHeaders = originHeaders.length === 0 ? {} : {
    'access-control-allow-origin': origin,
    'access-control-expose-headers': 'WWW-Authenticate',
    vary: 'Origin',
  };
  const respond = (status, body, extraHeaders = {}) => json(status, body, { ...corsHeaders, ...extraHeaders });

  if (method === 'OPTIONS') {
    if (originHeaders.length === 0) return respond(400, { error: 'invalid_preflight' });
    const requestedMethods = headers.filter(([name]) => name.toLowerCase() === 'access-control-request-method');
    const requestedHeaders = headers.filter(([name]) => name.toLowerCase() === 'access-control-request-headers');
    if (requestedMethods.length !== 1 || !corsMethods.includes(requestedMethods[0][1])
      || requestedHeaders.length > 1 || (requestedHeaders.length === 1
        && (typeof requestedHeaders[0][1] !== 'string' || !requestedHeaders[0][1].split(',')
          .every(name => corsRequestHeaders.includes(name.trim().toLowerCase()))))) {
      return respond(403, { error: 'preflight_not_allowed' });
    }
    return {
      statusCode: 204,
      headers: {
        ...corsHeaders,
        'access-control-allow-methods': corsMethods.join(', '),
        'access-control-allow-headers': corsRequestHeaders.join(', '),
        'access-control-max-age': '300',
        vary: 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers',
      },
      body: '',
    };
  }

  if (method === 'GET' && [
    'GET /.well-known/oauth-protected-resource/mcp',
    'GET /.well-known/oauth-protected-resource',
  ].includes(event?.routeKey)) {
    return respond(200, {
      resource: cfg.resourceUrl,
      authorization_servers: [cfg.authorizationServer],
      scopes_supported: [cfg.requiredScope],
      bearer_methods_supported: ['header'],
    }, { 'cache-control': 'no-store' });
  }

  const claims = event?.requestContext?.authorizer?.jwt?.claims;
  const auth = authorize(claims, cfg);
  if (!auth.ok) {
    const challenge = `Bearer resource_metadata="${cfg.resourceMetadataUrl}", error="${auth.error}", scope="${cfg.requiredScope}"`;
    return respond(auth.status, { error: auth.error }, { 'www-authenticate': challenge });
  }

  let msg;
  if (method === 'POST') {
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body ?? '', 'base64').toString('utf8')
      : (event.body ?? '');
    try {
      msg = JSON.parse(raw);
    } catch {
      return respond(400, rpcError(null, ERR.parse, 'parse error'));
    }
  }

  const kind = classifyMessage(msg);
  const protocolHeaders = headers
    .filter(([name]) => name.toLowerCase() === 'mcp-protocol-version');
  const isInitialization = kind === 'request' && msg.method === 'initialize';
  // Initialization negotiates its version before a header is required. There
  // is no session state here: later headerless requests use the spec's fallback.
  const protocolVersion = protocolHeaders.length === 0
    ? (isInitialization ? LATEST_PROTOCOL_VERSION : DEFAULT_PROTOCOL_VERSION)
    : protocolHeaders[0][1];
  if (protocolHeaders.length > 1 || !SUPPORTED_PROTOCOL_VERSIONS.includes(protocolVersion)) {
    return respond(400, { error: 'unsupported_protocol_version' });
  }

  if (method !== 'POST') return respond(405, { error: 'method_not_allowed' }, { allow: 'POST' });

  if (Array.isArray(msg)) {
    // Batch requests were removed in protocol 2025-06-18; not supported.
    return respond(400, rpcError(null, ERR.invalidRequest, 'batch requests are not supported'));
  }
  if (kind === 'invalid' || kind === 'response') {
    return respond(400, rpcError(null, ERR.invalidRequest,
      kind === 'response' ? 'unexpected JSON-RPC response' : 'invalid JSON-RPC message'));
  }

  const startedAt = Number.isFinite(event.requestContext?.timeEpoch)
    ? Math.min(event.requestContext.timeEpoch, Date.now()) : Date.now();
  const response = await handleMessage(msg, {
    ...cfg, identity: auth.identity, toolDeadlineMs: startedAt + (cfg.toolTimeoutMs ?? 27000),
  });
  if (response === null) return { statusCode: 202, headers: corsHeaders, body: '' };
  return respond(200, response);
}
