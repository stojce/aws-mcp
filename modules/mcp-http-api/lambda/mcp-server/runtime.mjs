// Stateless MCP request orchestration. AWS dependencies are injected by index.mjs.

import { authorize } from './authorization.mjs';
import { initializeTools, handleToolsCall } from './tools.mjs';
import {
  RPC_ERRORS, METADATA_KEYS, LATEST_PROTOCOL_VERSION, LEGACY_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS,
  classifyMessage, isRequestId, rpcError, rpcResult, unsupportedVersion,
  validInitializeParams, validRequestMetadata,
} from './protocol.mjs';
import {
  checkOrigin, decodeHeader, handlePreflight, jsonResponse, singleHeader, validateRequestHeaders,
} from './http.mjs';

// Keep the existing interface for the entrypoint and direct runtime callers.
export { authorize, initializeTools, LATEST_PROTOCOL_VERSION, LEGACY_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS };

// Returns a JSON-RPC response object, or null for notifications.
export async function handleMessage(message, context) {
  initializeTools(context.tools);
  const protocolVersion = context.protocolVersion ?? message?.params?._meta?.[METADATA_KEYS.protocolVersion]
    ?? LEGACY_PROTOCOL_VERSION;
  const modern = protocolVersion !== LEGACY_PROTOCOL_VERSION;
  const kind = classifyMessage(message, protocolVersion);
  if (kind === 'invalid' || kind === 'response') {
    return rpcError(modern ? (isRequestId(message?.id) ? message.id : undefined) : null,
      RPC_ERRORS.invalidRequest, 'invalid JSON-RPC request');
  }
  if (kind === 'notification') return null;

  const bodyVersion = message.params?._meta?.[METADATA_KEYS.protocolVersion];
  if (typeof bodyVersion === 'string' && bodyVersion !== protocolVersion) {
    return rpcError(message.id, RPC_ERRORS.headerMismatch, 'MCP-Protocol-Version must match params._meta protocolVersion');
  }
  if (modern && !validRequestMetadata(message.params)) {
    return rpcError(message.id, RPC_ERRORS.invalidParams, 'Requests require valid protocolVersion and clientCapabilities in params._meta');
  }
  if (!SUPPORTED_PROTOCOL_VERSIONS.includes(protocolVersion)) return unsupportedVersion(message.id, protocolVersion);
  const response = await dispatchMessage(message, { ...context, protocolVersion });
  if (modern && response.result) {
    response.result.resultType = 'complete';
    response.result._meta = { [METADATA_KEYS.serverInfo]: context.serverInfo };
  }
  return response;
}

async function dispatchMessage(message, context) {
  const { id, method, params } = message;
  const modern = context.protocolVersion === LATEST_PROTOCOL_VERSION;
  switch (method) {
    case 'server/discover':
      if (!modern) return rpcError(id, RPC_ERRORS.methodNotFound, `method not found: ${method}`);
      return rpcResult(id, {
        supportedVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
        capabilities: { tools: { listChanged: false } },
        ttlMs: 0,
        cacheScope: 'private',
      });
    case 'initialize': {
      if (modern) return rpcError(id, RPC_ERRORS.methodNotFound, `method not found: ${method}`);
      if (!validInitializeParams(params)) {
        return rpcError(id, RPC_ERRORS.invalidParams, 'initialize requires protocolVersion, capabilities, and complete clientInfo');
      }
      return rpcResult(id, {
        // The modern version has no initialize handshake. Legacy negotiation
        // can only select a version that implements that lifecycle.
        protocolVersion: LEGACY_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: context.serverInfo,
      });
    }
    case 'ping':
      if (modern) return rpcError(id, RPC_ERRORS.methodNotFound, `method not found: ${method}`);
      return rpcResult(id, {});
    case 'tools/list':
      if (modern && params?.cursor !== undefined) {
        return rpcError(id, RPC_ERRORS.invalidParams, 'Invalid cursor: this server returns the complete tool list');
      }
      if (params?.cursor !== undefined && typeof params.cursor !== 'string') {
        return rpcError(id, RPC_ERRORS.invalidParams, 'tools/list cursor must be a string');
      }
      return rpcResult(id, {
        tools: context.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
        ...(modern ? { ttlMs: 0, cacheScope: 'private' } : {}),
      });
    case 'tools/call':
      return handleToolsCall(id, params, context);
    default:
      return rpcError(id, RPC_ERRORS.methodNotFound, `method not found: ${method}`);
  }
}

// HTTP adapter for API Gateway HTTP API payload format 2.0.
export async function handleHttpEvent(event, config) {
  const method = event?.requestContext?.http?.method ?? event?.httpMethod;
  const headers = Object.entries(event?.headers ?? {});
  const cors = checkOrigin(headers, config.allowedOrigins ?? []);
  if (cors.response) return cors.response;
  const corsHeaders = cors.headers;
  const respond = (status, body, extraHeaders = {}) => jsonResponse(status, body, { ...corsHeaders, ...extraHeaders });

  if (method === 'OPTIONS') return handlePreflight(headers, config.tools, corsHeaders);

  if (method === 'GET' && [
    'GET /.well-known/oauth-protected-resource/mcp',
    'GET /.well-known/oauth-protected-resource',
  ].includes(event?.routeKey)) {
    return respond(200, {
      resource: config.resourceUrl,
      authorization_servers: [config.authorizationServer],
      scopes_supported: [config.requiredScope],
      bearer_methods_supported: ['header'],
    }, { 'cache-control': 'no-store' });
  }

  if (method === 'GET' && event?.routeKey === 'GET /.well-known/oauth-authorization-server') {
    if (!config.authorizationServerMetadata) return respond(404, { error: 'not_found' });
    return respond(200, config.authorizationServerMetadata, { 'cache-control': 'no-store' });
  }

  const claims = event?.requestContext?.authorizer?.jwt?.claims;
  const auth = authorize(claims, { ...config, verifiedScopes: event?.requestContext?.authorizer?.jwt?.scopes });
  if (!auth.ok) {
    const challenge = `Bearer resource_metadata="${config.resourceMetadataUrl}", error="${auth.error}", scope="${config.requiredScope}"`;
    return respond(auth.status, { error: auth.error }, { 'www-authenticate': challenge });
  }

  if (method !== 'POST') return respond(405, { error: 'method_not_allowed' }, { allow: 'POST' });

  const protocolHeader = singleHeader(headers, 'mcp-protocol-version');
  let message;
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body ?? '', 'base64').toString('utf8')
    : (event.body ?? '');
  try {
    message = JSON.parse(raw);
  } catch {
    return respond(400, rpcError(protocolHeader === LEGACY_PROTOCOL_VERSION ? null : undefined,
      RPC_ERRORS.parse, 'parse error'));
  }

  const protocolHeaders = headers
    .filter(([name]) => name.toLowerCase() === 'mcp-protocol-version');
  // Only the legacy initialize handshake may omit the version header.
  const legacyInitialization = protocolHeaders.length === 0 && message?.method === 'initialize'
    && message?.params?._meta?.[METADATA_KEYS.protocolVersion] === undefined;
  const protocolVersion = legacyInitialization ? LEGACY_PROTOCOL_VERSION : protocolHeader;
  const modern = protocolVersion !== LEGACY_PROTOCOL_VERSION;
  const kind = classifyMessage(message, protocolVersion);
  const errorId = modern ? (isRequestId(message?.id) ? message.id : undefined) : null;

  if (Array.isArray(message)) {
    // Batch requests were removed in protocol 2025-06-18; not supported.
    return respond(400, rpcError(errorId, RPC_ERRORS.invalidRequest, 'batch requests are not supported'));
  }
  if (kind === 'invalid' || kind === 'response') {
    return respond(400, rpcError(errorId, RPC_ERRORS.invalidRequest,
      kind === 'response' ? 'unexpected JSON-RPC response' : 'invalid JSON-RPC message'));
  }

  const decodedVersion = decodeHeader(protocolHeader, false);
  if (!legacyInitialization && (!decodedVersion || !decodedVersion.value || decodedVersion.value.includes(','))) {
    return respond(400, rpcError(kind === 'request' ? message.id : undefined, RPC_ERRORS.headerMismatch,
      'MCP-Protocol-Version header is required and must contain a single protocol version'));
  }
  const bodyVersion = message.params?._meta?.[METADATA_KEYS.protocolVersion];
  if (kind === 'request' && typeof bodyVersion === 'string' && bodyVersion !== protocolVersion) {
    return respond(400, rpcError(message.id, RPC_ERRORS.headerMismatch, 'MCP-Protocol-Version must match params._meta protocolVersion'));
  }
  if (!SUPPORTED_PROTOCOL_VERSIONS.includes(protocolVersion)) {
    return respond(400, unsupportedVersion(kind === 'request' ? message.id : undefined, protocolVersion));
  }
  if (modern && kind === 'request') {
    if (!validRequestMetadata(message.params)) {
      return respond(400, rpcError(message.id, RPC_ERRORS.invalidParams,
        'Requests require valid protocolVersion and clientCapabilities in params._meta'));
    }
    const mismatch = validateRequestHeaders(message, headers, config.tools);
    if (mismatch) return respond(400, mismatch);
  }

  const startedAt = Number.isFinite(event.requestContext?.timeEpoch)
    ? Math.min(event.requestContext.timeEpoch, Date.now()) : Date.now();
  const response = await handleMessage(message, {
    ...config, protocolVersion, identity: auth.identity, toolDeadlineMs: startedAt + (config.toolTimeoutMs ?? 27000),
  });
  if (response === null) return { statusCode: 202, headers: corsHeaders, body: '' };
  const status = modern && response.error
    ? (response.error.code === RPC_ERRORS.methodNotFound ? 404 : 400) : 200;
  return respond(status, response);
}
