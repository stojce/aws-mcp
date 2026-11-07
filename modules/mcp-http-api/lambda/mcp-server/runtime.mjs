// Stateless MCP server runtime (Streamable HTTP, single JSON response per POST).
// Pure: no AWS SDK imports. The Lambda entrypoint injects the tool invoker.

import { compileSchema } from './schema-validator.mjs';

export const LATEST_PROTOCOL_VERSION = '2026-07-28';
export const LEGACY_PROTOCOL_VERSION = '2025-06-18';
export const SUPPORTED_PROTOCOL_VERSIONS = [LATEST_PROTOCOL_VERSION, LEGACY_PROTOCOL_VERSION];

const META = {
  protocolVersion: 'io.modelcontextprotocol/protocolVersion',
  clientCapabilities: 'io.modelcontextprotocol/clientCapabilities',
  clientInfo: 'io.modelcontextprotocol/clientInfo',
  serverInfo: 'io.modelcontextprotocol/serverInfo',
  logLevel: 'io.modelcontextprotocol/logLevel',
};

const ERR = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  headerMismatch: -32020,
  unsupportedVersion: -32022,
};

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isRequestId = id => typeof id === 'string' || Number.isSafeInteger(id);
const requestMethods = new Set([
  'initialize', 'ping', 'server/discover', 'tools/list', 'tools/call',
  'resources/list', 'resources/templates/list', 'resources/read',
  'prompts/list', 'prompts/get', 'completion/complete', 'subscriptions/listen',
]);

function classifyMessage(msg, protocolVersion = LEGACY_PROTOCOL_VERSION) {
  if (!isObject(msg) || msg.jsonrpc !== '2.0') return 'invalid';
  if ('method' in msg) {
    if (typeof msg.method !== 'string' || 'result' in msg || 'error' in msg) return 'invalid';
    if ('params' in msg && !isObject(msg.params)) return 'invalid';
    if (protocolVersion === LEGACY_PROTOCOL_VERSION && msg.params
      && '_meta' in msg.params && !isObject(msg.params._meta)) return 'invalid';
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

const rpcError = (id, code, message, data) => ({
  jsonrpc: '2.0',
  ...(id === undefined ? {} : { id }),
  error: { code, message, ...(data === undefined ? {} : { data }) },
});
const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });
const unsupportedVersion = (id, requested) => rpcError(id, ERR.unsupportedVersion,
  'Unsupported protocol version', { supported: [...SUPPORTED_PROTOCOL_VERSIONS], requested });

function validClientCapabilities(capabilities) {
  if (!isObject(capabilities)) return false;
  for (const name of ['experimental', 'roots', 'sampling', 'elicitation', 'extensions']) {
    if (name in capabilities && !isObject(capabilities[name])) return false;
  }
  for (const name of ['experimental', 'extensions']) {
    if (capabilities[name] && !Object.values(capabilities[name]).every(isObject)) return false;
  }
  for (const [name, fields] of [['sampling', ['context', 'tools']], ['elicitation', ['form', 'url']]]) {
    if (capabilities[name] && fields.some(field => field in capabilities[name]
      && !isObject(capabilities[name][field]))) return false;
  }
  return true;
}

function validClientInfo(info) {
  if (!isObject(info) || typeof info.name !== 'string' || typeof info.version !== 'string') return false;
  for (const field of ['title', 'description', 'websiteUrl']) {
    if (field in info && typeof info[field] !== 'string') return false;
  }
  return !('icons' in info) || (Array.isArray(info.icons) && info.icons.every(icon => isObject(icon)
    && typeof icon.src === 'string' && (!('mimeType' in icon) || typeof icon.mimeType === 'string')
    && (!('sizes' in icon) || (Array.isArray(icon.sizes) && icon.sizes.every(size => typeof size === 'string')))
    && (!('theme' in icon) || ['light', 'dark'].includes(icon.theme))));
}

function validRequestMetadata(params) {
  const meta = params?._meta;
  if (!isObject(meta) || typeof meta[META.protocolVersion] !== 'string'
    || !validClientCapabilities(meta[META.clientCapabilities])) return false;
  if (META.clientInfo in meta && !validClientInfo(meta[META.clientInfo])) return false;
  if ('progressToken' in meta && typeof meta.progressToken !== 'string'
    && !(typeof meta.progressToken === 'number' && Number.isFinite(meta.progressToken))) return false;
  return !(META.logLevel in meta)
    || ['debug', 'info', 'notice', 'warning', 'error', 'critical', 'alert', 'emergency'].includes(meta[META.logLevel]);
}

const toolResult = (text, isError) => ({
  content: [{ type: 'text', text }],
  isError,
});

// Authorization double-check. API Gateway's JWT authorizer already enforced the
// issuer and the route scope; this pins the client and resource again. Cognito
// requires token_use=access; external issuers can require their own token marker.
export function authorize(claims, {
  clientId, requiredScope, resourceUrl, authorizationServer,
  authorizationMode = 'cognito', clientIdClaim = 'client_id', accessTokenClaim = null,
  allowUnboundAccessTokens = false, verifiedScopes,
}) {
  if (typeof resourceUrl !== 'string' || resourceUrl === ''
    || typeof clientId !== 'string' || clientId === ''
    || typeof requiredScope !== 'string' || requiredScope === ''
    || !['cognito', 'external'].includes(authorizationMode)) {
    return { ok: false, status: 401, error: 'invalid_token' };
  }
  if (!isObject(claims) || typeof claims.sub !== 'string' || claims.sub === '') {
    return { ok: false, status: 401, error: 'invalid_token' };
  }
  const clientClaim = authorizationMode === 'cognito' ? 'client_id' : clientIdClaim;
  if (typeof clientClaim !== 'string' || !clientClaim || claims[clientClaim] !== clientId) {
    return { ok: false, status: 401, error: 'invalid_token' };
  }
  if (authorizationMode === 'external' && (typeof authorizationServer !== 'string'
    || !authorizationServer || claims.iss !== authorizationServer)) {
    return { ok: false, status: 401, error: 'invalid_token' };
  }
  if (claims.token_use === 'id') return { ok: false, status: 401, error: 'invalid_token' };
  const marker = authorizationMode === 'cognito' ? { name: 'token_use', value: 'access' } : accessTokenClaim;
  if (marker !== null) {
    if (!isObject(marker) || typeof marker.name !== 'string' || !marker.name
      || typeof marker.value !== 'string' || !marker.value || claims[marker.name] !== marker.value) {
      return { ok: false, status: 401, error: 'invalid_token' };
    }
  } else if (claims.token_use !== undefined && claims.token_use !== 'access') {
    return { ok: false, status: 401, error: 'invalid_token' };
  }
  if (claims.aud === undefined) {
    if (authorizationMode === 'external' || !allowUnboundAccessTokens) {
      return { ok: false, status: 401, error: 'invalid_token' };
    }
  } else if (!(Array.isArray(claims.aud) ? claims.aud : [claims.aud]).includes(resourceUrl)) {
    return { ok: false, status: 401, error: 'invalid_token' };
  }
  // HTTP API supplies normalized scopes separately from its string-valued claim
  // map. Prefer that verified array; direct callers can use scope/scp claims.
  const scopes = verifiedScopes === undefined
    ? [claims.scope, claims.scp].flatMap(scope => typeof scope === 'string' ? scope.split(' ')
      : (Array.isArray(scope) && scope.every(value => typeof value === 'string') ? scope : []))
    : (Array.isArray(verifiedScopes) && verifiedScopes.every(value => typeof value === 'string') ? verifiedScopes : []);
  if (!scopes.includes(requiredScope)) {
    return { ok: false, status: 403, error: 'insufficient_scope', scope: requiredScope };
  }
  return { ok: true, identity: { sub: claims.sub, clientId: claims[clientClaim] } };
}

const toolValidators = new WeakMap();

// Annotations must be on primitive properties reachable through properties only.
// Walk schema keywords, not literal data in const, enum, examples, or defaults.
function collectHeaderParameters(schema) {
  const parameters = [];
  const names = new Set();
  const visit = (node, propertyPath) => {
    if (!isObject(node)) return;
    if ('x-mcp-header' in node) {
      const name = node['x-mcp-header'];
      if (typeof name !== 'string' || !/^[!#$%&'*+.^_\x60|~0-9A-Za-z-]+$/.test(name)
        || names.has(name.toLowerCase()) || !propertyPath?.length
        || !['string', 'integer', 'boolean'].includes(node.type)) {
        throw new Error('x-mcp-header must be a unique HTTP token on a statically reachable string, integer, or boolean property');
      }
      names.add(name.toLowerCase());
      parameters.push({ name: `mcp-param-${name.toLowerCase()}`, path: propertyPath, type: node.type });
    }
    for (const [name, child] of Object.entries(node.properties ?? {})) {
      visit(child, propertyPath === null ? null : [...propertyPath, name]);
    }
    for (const keyword of ['$defs', 'definitions', 'patternProperties', 'dependentSchemas', 'dependencies']) {
      for (const child of Object.values(node[keyword] ?? {})) visit(child, null);
    }
    for (const keyword of ['allOf', 'anyOf', 'oneOf', 'prefixItems']) {
      for (const child of node[keyword] ?? []) visit(child, null);
    }
    for (const keyword of [
      'additionalProperties', 'unevaluatedProperties', 'propertyNames', 'additionalItems',
      'unevaluatedItems', 'contains', 'not', 'if', 'then', 'else', 'contentSchema',
    ]) visit(node[keyword], null);
    if (Array.isArray(node.items)) {
      for (const child of node.items) visit(child, null);
    } else {
      visit(node.items, null);
    }
  };
  visit(schema, []);
  return parameters;
}

// Called at Lambda startup, before discovery, legacy initialization, or tool listing.
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
      validators.set(tool, {
        validate: compileSchema(tool.inputSchema),
        headers: collectHeaderParameters(tool.inputSchema),
      });
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
  if (ctx.protocolVersion === LATEST_PROTOCOL_VERSION && (
    ('arguments' in params && !isObject(params.arguments))
    || ('inputResponses' in params && !isObject(params.inputResponses))
    || ('requestState' in params && typeof params.requestState !== 'string')
  )) return rpcError(id, ERR.invalidParams, 'Invalid tools/call parameters');
  const tool = ctx.tools.find(t => t.name === params.name);
  if (!tool) {
    return rpcError(id, ERR.invalidParams, `unknown tool: ${params.name}`);
  }
  const args = params.arguments === undefined ? {} : params.arguments;
  const invalid = validateArguments(args, initializeTools(ctx.tools).get(tool).validate);
  if (invalid) return rpcResult(id, toolResult(invalid, true));

  try {
    const payload = await invokeToolWithDeadline({ tool: tool.name, arguments: args, identity: ctx.identity }, ctx);
    const result = toolResult(JSON.stringify(payload ?? null), false);
    if (ctx.protocolVersion === LATEST_PROTOCOL_VERSION) result.structuredContent = payload ?? null;
    return rpcResult(id, result);
  } catch (error) {
    // Backend internals are not returned to the client.
    return rpcResult(id, toolResult(error instanceof ToolTimeoutError ? 'Tool execution timed out' : 'Tool execution failed', true));
  }
}

// Returns a JSON-RPC response object, or null for notifications.
export async function handleMessage(msg, ctx) {
  initializeTools(ctx.tools);
  const protocolVersion = ctx.protocolVersion ?? msg?.params?._meta?.[META.protocolVersion]
    ?? LEGACY_PROTOCOL_VERSION;
  const modern = protocolVersion !== LEGACY_PROTOCOL_VERSION;
  const kind = classifyMessage(msg, protocolVersion);
  if (kind === 'invalid' || kind === 'response') {
    return rpcError(modern ? (isRequestId(msg?.id) ? msg.id : undefined) : null,
      ERR.invalidRequest, 'invalid JSON-RPC request');
  }
  if (kind === 'notification') return null;

  const bodyVersion = msg.params?._meta?.[META.protocolVersion];
  if (typeof bodyVersion === 'string' && bodyVersion !== protocolVersion) {
    return rpcError(msg.id, ERR.headerMismatch, 'MCP-Protocol-Version must match params._meta protocolVersion');
  }
  if (modern && !validRequestMetadata(msg.params)) {
    return rpcError(msg.id, ERR.invalidParams, 'Requests require valid protocolVersion and clientCapabilities in params._meta');
  }
  if (!SUPPORTED_PROTOCOL_VERSIONS.includes(protocolVersion)) return unsupportedVersion(msg.id, protocolVersion);
  const response = await dispatchMessage(msg, { ...ctx, protocolVersion });
  if (modern && response.result) {
    response.result.resultType = 'complete';
    response.result._meta = { [META.serverInfo]: ctx.serverInfo };
  }
  return response;
}

async function dispatchMessage(msg, ctx) {
  const { id, method, params } = msg;
  const modern = ctx.protocolVersion === LATEST_PROTOCOL_VERSION;
  switch (method) {
    case 'server/discover':
      if (!modern) return rpcError(id, ERR.methodNotFound, `method not found: ${method}`);
      return rpcResult(id, {
        supportedVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
        capabilities: { tools: { listChanged: false } },
        ttlMs: 0,
        cacheScope: 'private',
      });
    case 'initialize': {
      if (modern) return rpcError(id, ERR.methodNotFound, `method not found: ${method}`);
      if (!validInitializeParams(params)) {
        return rpcError(id, ERR.invalidParams, 'initialize requires protocolVersion, capabilities, and complete clientInfo');
      }
      return rpcResult(id, {
        // The modern version has no initialize handshake. Legacy negotiation
        // can only select a version that implements that lifecycle.
        protocolVersion: LEGACY_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: ctx.serverInfo,
      });
    }
    case 'ping':
      if (modern) return rpcError(id, ERR.methodNotFound, `method not found: ${method}`);
      return rpcResult(id, {});
    case 'tools/list':
      if (modern && params?.cursor !== undefined) {
        return rpcError(id, ERR.invalidParams, 'Invalid cursor: this server returns the complete tool list');
      }
      if (params?.cursor !== undefined && typeof params.cursor !== 'string') {
        return rpcError(id, ERR.invalidParams, 'tools/list cursor must be a string');
      }
      return rpcResult(id, {
        tools: ctx.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
        ...(modern ? { ttlMs: 0, cacheScope: 'private' } : {}),
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
const corsRequestHeaders = [
  'authorization', 'content-type', 'mcp-protocol-version', 'accept', 'mcp-method', 'mcp-name',
];

function singleHeader(headers, name) {
  const matches = headers.filter(([field]) => field.toLowerCase() === name);
  return matches.length === 1 ? matches[0][1] : undefined;
}

function decodeHeader(value, allowEncoding = true) {
  if (typeof value !== 'string' || !/^[\x20-\x7E\t]*$/.test(value) || value.trim() !== value) return null;
  if (allowEncoding && value.startsWith('=?base64?') && value.endsWith('?=')) {
    const encoded = value.slice(9, -2);
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) return null;
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.toString('base64') !== encoded) return null;
    try {
      return { value: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) };
    } catch {
      return null;
    }
  }
  return { value };
}

function validateRequestHeaders(msg, headers, cfg) {
  const mismatch = name => rpcError(msg.id, ERR.headerMismatch,
    `${name} header is missing, malformed, or does not match the request body`);
  const method = decodeHeader(singleHeader(headers, 'mcp-method'), false);
  if (!method || method.value !== msg.method) return mismatch('Mcp-Method');
  const nameField = { 'tools/call': 'name', 'prompts/get': 'name', 'resources/read': 'uri' }[msg.method];
  if (nameField) {
    const name = decodeHeader(singleHeader(headers, 'mcp-name'));
    if (!name || name.value !== msg.params[nameField]) return mismatch('Mcp-Name');
  }
  if (msg.method !== 'tools/call') return null;
  const tool = cfg.tools.find(t => t.name === msg.params.name);
  if (!tool) return null;
  for (const parameter of initializeTools(cfg.tools).get(tool).headers) {
    let value = msg.params.arguments;
    for (const name of parameter.path) {
      value = isObject(value) && Object.hasOwn(value, name) ? value[name] : undefined;
    }
    const entries = headers.filter(([name]) => name.toLowerCase() === parameter.name);
    if (value === undefined || value === null) {
      if (entries.length > 0) return mismatch(parameter.name);
      continue;
    }
    const header = decodeHeader(singleHeader(headers, parameter.name));
    if (!header) return mismatch(parameter.name);
    if (parameter.type === 'integer' && typeof value === 'number') {
      if (!Number.isSafeInteger(value) || !/^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/.test(header.value)
        || Number(header.value) !== value) return mismatch(parameter.name);
    } else if (!['string', 'boolean', 'number'].includes(typeof value) || header.value !== String(value)) {
      return mismatch(parameter.name);
    }
  }
  return null;
}

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

  console.log(event)
  console.log(cfg)

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
    const allowedHeaders = [...corsRequestHeaders, ...[...initializeTools(cfg.tools).values()]
      .flatMap(tool => tool.headers.map(parameter => parameter.name))];
    if (requestedMethods.length !== 1 || !corsMethods.includes(requestedMethods[0][1])
      || requestedHeaders.length > 1 || (requestedHeaders.length === 1
        && (typeof requestedHeaders[0][1] !== 'string' || !requestedHeaders[0][1].split(',')
          .every(name => allowedHeaders.includes(name.trim().toLowerCase()))))) {
      return respond(403, { error: 'preflight_not_allowed' });
    }
    return {
      statusCode: 204,
      headers: {
        ...corsHeaders,
        'access-control-allow-methods': corsMethods.join(', '),
        'access-control-allow-headers': [...new Set(allowedHeaders)].join(', '),
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

  if (method === 'GET' && event?.routeKey === 'GET /.well-known/oauth-authorization-server') {
    if (!cfg.authorizationServerMetadata) return respond(404, { error: 'not_found' });
    return respond(200, cfg.authorizationServerMetadata, { 'cache-control': 'no-store' });
  }

  const claims = event?.requestContext?.authorizer?.jwt?.claims;
  const auth = authorize(claims, { ...cfg, verifiedScopes: event?.requestContext?.authorizer?.jwt?.scopes });
  if (!auth.ok) {
    const challenge = `Bearer resource_metadata="${cfg.resourceMetadataUrl}", error="${auth.error}", scope="${cfg.requiredScope}"`;
    return respond(auth.status, { error: auth.error }, { 'www-authenticate': challenge });
  }

  if (method !== 'POST') return respond(405, { error: 'method_not_allowed' }, { allow: 'POST' });

  const protocolHeader = singleHeader(headers, 'mcp-protocol-version');
  let msg;
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body ?? '', 'base64').toString('utf8')
    : (event.body ?? '');
  try {
    msg = JSON.parse(raw);
  } catch {
    return respond(400, rpcError(protocolHeader === LEGACY_PROTOCOL_VERSION ? null : undefined,
      ERR.parse, 'parse error'));
  }

  const protocolHeaders = headers
    .filter(([name]) => name.toLowerCase() === 'mcp-protocol-version');
  // Only the legacy initialize handshake may omit the version header.
  const legacyInitialization = protocolHeaders.length === 0 && msg?.method === 'initialize'
    && msg?.params?._meta?.[META.protocolVersion] === undefined;
  const protocolVersion = legacyInitialization ? LEGACY_PROTOCOL_VERSION : protocolHeader;
  const modern = protocolVersion !== LEGACY_PROTOCOL_VERSION;
  const kind = classifyMessage(msg, protocolVersion);
  const errorId = modern ? (isRequestId(msg?.id) ? msg.id : undefined) : null;

  if (Array.isArray(msg)) {
    // Batch requests were removed in protocol 2025-06-18; not supported.
    return respond(400, rpcError(errorId, ERR.invalidRequest, 'batch requests are not supported'));
  }
  if (kind === 'invalid' || kind === 'response') {
    return respond(400, rpcError(errorId, ERR.invalidRequest,
      kind === 'response' ? 'unexpected JSON-RPC response' : 'invalid JSON-RPC message'));
  }

  const decodedVersion = decodeHeader(protocolHeader, false);
  if (!legacyInitialization && (!decodedVersion || !decodedVersion.value || decodedVersion.value.includes(','))) {
    return respond(400, rpcError(kind === 'request' ? msg.id : undefined, ERR.headerMismatch,
      'MCP-Protocol-Version header is required and must contain a single protocol version'));
  }
  const bodyVersion = msg.params?._meta?.[META.protocolVersion];
  if (kind === 'request' && typeof bodyVersion === 'string' && bodyVersion !== protocolVersion) {
    return respond(400, rpcError(msg.id, ERR.headerMismatch, 'MCP-Protocol-Version must match params._meta protocolVersion'));
  }
  if (!SUPPORTED_PROTOCOL_VERSIONS.includes(protocolVersion)) {
    return respond(400, unsupportedVersion(kind === 'request' ? msg.id : undefined, protocolVersion));
  }
  if (modern && kind === 'request') {
    if (!validRequestMetadata(msg.params)) {
      return respond(400, rpcError(msg.id, ERR.invalidParams,
        'Requests require valid protocolVersion and clientCapabilities in params._meta'));
    }
    const mismatch = validateRequestHeaders(msg, headers, cfg);
    if (mismatch) return respond(400, mismatch);
  }

  const startedAt = Number.isFinite(event.requestContext?.timeEpoch)
    ? Math.min(event.requestContext.timeEpoch, Date.now()) : Date.now();
  const response = await handleMessage(msg, {
    ...cfg, protocolVersion, identity: auth.identity, toolDeadlineMs: startedAt + (cfg.toolTimeoutMs ?? 27000),
  });
  if (response === null) return { statusCode: 202, headers: corsHeaders, body: '' };
  const status = modern && response.error
    ? (response.error.code === ERR.methodNotFound ? 404 : 400) : 200;
  return respond(status, response);
}
