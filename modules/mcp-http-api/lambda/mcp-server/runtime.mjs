// Stateless MCP server runtime (Streamable HTTP, single JSON response per POST).
// Pure: no AWS SDK imports. The Lambda entrypoint injects the tool invoker.

import { compileSchema } from './schema-validator.mjs';

export const LATEST_PROTOCOL_VERSION = '2025-06-18';
export const SUPPORTED_PROTOCOL_VERSIONS = [LATEST_PROTOCOL_VERSION, '2025-03-26'];

const ERR = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
};

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

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

async function handleToolsCall(id, params, ctx) {
  if (!isObject(params) || typeof params.name !== 'string') {
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
    const payload = await ctx.invokeTool({ tool: tool.name, arguments: args, identity: ctx.identity });
    return rpcResult(id, toolResult(JSON.stringify(payload ?? null), false));
  } catch {
    // Backend internals are not returned to the client.
    return rpcResult(id, toolResult('Tool execution failed', true));
  }
}

// Returns a JSON-RPC response object, or null for notifications.
export async function handleMessage(msg, ctx) {
  initializeTools(ctx.tools);
  if (!isObject(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return rpcError(msg?.id ?? null, ERR.invalidRequest, 'invalid JSON-RPC request');
  }
  if (!('id' in msg)) return null; // notification: no response body

  const { id, method, params } = msg;
  switch (method) {
    case 'initialize': {
      const requested = isObject(params) ? params.protocolVersion : undefined;
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

// HTTP adapter for API Gateway HTTP API payload format 2.0.
export async function handleHttpEvent(event, cfg) {
  const method = event?.requestContext?.http?.method ?? event?.httpMethod;
  if (method === 'GET' && [
    'GET /.well-known/oauth-protected-resource/mcp',
    'GET /.well-known/oauth-protected-resource',
  ].includes(event?.routeKey)) {
    return json(200, {
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
    return json(auth.status, { error: auth.error }, { 'www-authenticate': challenge });
  }

  if (method !== 'POST') return json(405, { error: 'method_not_allowed' }, { allow: 'POST' });

  const raw = event.isBase64Encoded
    ? Buffer.from(event.body ?? '', 'base64').toString('utf8')
    : (event.body ?? '');

  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return json(400, rpcError(null, ERR.parse, 'parse error'));
  }
  if (Array.isArray(msg)) {
    // Batch requests were removed in protocol 2025-06-18; not supported.
    return json(400, rpcError(null, ERR.invalidRequest, 'batch requests are not supported'));
  }

  const response = await handleMessage(msg, { ...cfg, identity: auth.identity });
  if (response === null) return { statusCode: 202, headers: {}, body: '' };
  return json(200, response);
}
