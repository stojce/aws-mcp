// MCP versions, JSON-RPC envelopes, and request validation. No HTTP or AWS dependencies.

export const LATEST_PROTOCOL_VERSION = '2026-07-28';
export const LEGACY_PROTOCOL_VERSION = '2025-06-18';
export const SUPPORTED_PROTOCOL_VERSIONS = [LATEST_PROTOCOL_VERSION, LEGACY_PROTOCOL_VERSION];

export const METADATA_KEYS = {
  protocolVersion: 'io.modelcontextprotocol/protocolVersion',
  clientCapabilities: 'io.modelcontextprotocol/clientCapabilities',
  clientInfo: 'io.modelcontextprotocol/clientInfo',
  serverInfo: 'io.modelcontextprotocol/serverInfo',
  logLevel: 'io.modelcontextprotocol/logLevel',
};

export const RPC_ERRORS = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  headerMismatch: -32020,
  unsupportedVersion: -32022,
};

export const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const isRequestId = id => typeof id === 'string' || Number.isSafeInteger(id);
const requestMethods = new Set([
  'initialize', 'ping', 'server/discover', 'tools/list', 'tools/call',
  'resources/list', 'resources/templates/list', 'resources/read',
  'prompts/list', 'prompts/get', 'completion/complete', 'subscriptions/listen',
]);

export function classifyMessage(message, protocolVersion = LEGACY_PROTOCOL_VERSION) {
  if (!isObject(message) || message.jsonrpc !== '2.0') return 'invalid';
  if ('method' in message) {
    if (typeof message.method !== 'string' || 'result' in message || 'error' in message) return 'invalid';
    if ('params' in message && !isObject(message.params)) return 'invalid';
    if (protocolVersion === LEGACY_PROTOCOL_VERSION && message.params
      && '_meta' in message.params && !isObject(message.params._meta)) return 'invalid';
    if (!('id' in message)) {
      if (requestMethods.has(message.method)) return 'invalid';
      if (message.method === 'notifications/cancelled' && !validCancellationParams(message.params)) {
        return 'invalid';
      }
      return 'notification';
    }
    if (!isRequestId(message.id) || message.method.startsWith('notifications/')) return 'invalid';
    return 'request';
  }
  if (!isRequestId(message.id) || ('result' in message) === ('error' in message)) return 'invalid';
  if ('error' in message && (!isObject(message.error) || !Number.isInteger(message.error.code)
    || typeof message.error.message !== 'string')) return 'invalid';
  return 'response';
}

function validCancellationParams(params) {
  return isObject(params) && isRequestId(params.requestId)
    && (!('reason' in params) || typeof params.reason === 'string');
}

export function validInitializeParams(params) {
  if (!isObject(params)) return false;
  const { protocolVersion, capabilities, clientInfo } = params;
  if (typeof protocolVersion !== 'string' || !protocolVersion) return false;
  if (!isObject(capabilities) || !isObject(clientInfo)) return false;
  if (typeof clientInfo.name !== 'string' || !clientInfo.name) return false;
  if (typeof clientInfo.version !== 'string' || !clientInfo.version) return false;
  if ('title' in clientInfo && typeof clientInfo.title !== 'string') return false;
  for (const name of ['experimental', 'roots', 'sampling', 'elicitation']) {
    if (name in capabilities && !isObject(capabilities[name])) return false;
  }
  if (capabilities.experimental && !Object.values(capabilities.experimental).every(isObject)) return false;
  const roots = capabilities.roots;
  return !roots || !('listChanged' in roots) || typeof roots.listChanged === 'boolean';
}

export const rpcError = (id, code, message, data) => ({
  jsonrpc: '2.0',
  ...(id === undefined ? {} : { id }),
  error: { code, message, ...(data === undefined ? {} : { data }) },
});
export const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });
export const unsupportedVersion = (id, requested) => rpcError(id, RPC_ERRORS.unsupportedVersion,
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
    const capability = capabilities[name];
    if (!capability) continue;
    for (const field of fields) {
      if (field in capability && !isObject(capability[field])) return false;
    }
  }
  return true;
}

function validClientInfo(info) {
  if (!isObject(info) || typeof info.name !== 'string' || typeof info.version !== 'string') return false;
  for (const field of ['title', 'description', 'websiteUrl']) {
    if (field in info && typeof info[field] !== 'string') return false;
  }
  return !('icons' in info) || (Array.isArray(info.icons) && info.icons.every(validIcon));
}

function validIcon(icon) {
  if (!isObject(icon) || typeof icon.src !== 'string') return false;
  if ('mimeType' in icon && typeof icon.mimeType !== 'string') return false;
  if ('sizes' in icon
    && (!Array.isArray(icon.sizes) || !icon.sizes.every(size => typeof size === 'string'))) {
    return false;
  }
  return !('theme' in icon) || ['light', 'dark'].includes(icon.theme);
}

export function validRequestMetadata(params) {
  const meta = params?._meta;
  if (!isObject(meta) || typeof meta[METADATA_KEYS.protocolVersion] !== 'string'
    || !validClientCapabilities(meta[METADATA_KEYS.clientCapabilities])) return false;
  if (METADATA_KEYS.clientInfo in meta && !validClientInfo(meta[METADATA_KEYS.clientInfo])) return false;
  if ('progressToken' in meta) {
    const token = meta.progressToken;
    if (typeof token !== 'string' && !(typeof token === 'number' && Number.isFinite(token))) return false;
  }
  return !(METADATA_KEYS.logLevel in meta)
    || ['debug', 'info', 'notice', 'warning', 'error', 'critical', 'alert', 'emergency'].includes(meta[METADATA_KEYS.logLevel]);
}
