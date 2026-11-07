// HTTP header validation, browser origin policy, and preflight responses.

import { RPC_ERRORS, isObject, rpcError } from './protocol.mjs';
import { getParameterHeaderNames, getToolHeaderParameters } from './tools.mjs';

export const jsonResponse = (statusCode, body, headers = {}) => ({
  statusCode,
  headers: { 'content-type': 'application/json', ...headers },
  body: body === undefined ? '' : JSON.stringify(body),
});

const corsMethods = ['GET', 'POST', 'OPTIONS'];
const corsRequestHeaders = [
  'authorization', 'content-type', 'mcp-protocol-version', 'accept', 'mcp-method', 'mcp-name',
];

export function singleHeader(headers, name) {
  const matches = headers.filter(([field]) => field.toLowerCase() === name);
  return matches.length === 1 ? matches[0][1] : undefined;
}

export function decodeHeader(value, allowEncoding = true) {
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

export function validateRequestHeaders(message, headers, tools) {
  const mismatch = name => rpcError(message.id, RPC_ERRORS.headerMismatch,
    `${name} header is missing, malformed, or does not match the request body`);
  const method = decodeHeader(singleHeader(headers, 'mcp-method'), false);
  if (!method || method.value !== message.method) return mismatch('Mcp-Method');
  const nameField = { 'tools/call': 'name', 'prompts/get': 'name', 'resources/read': 'uri' }[message.method];
  if (nameField) {
    const name = decodeHeader(singleHeader(headers, 'mcp-name'));
    if (!name || name.value !== message.params[nameField]) return mismatch('Mcp-Name');
  }
  if (message.method !== 'tools/call') return null;
  for (const parameter of getToolHeaderParameters(tools, message.params.name)) {
    let value = message.params.arguments;
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

export function checkOrigin(headers, allowedOrigins = []) {
  const originHeaders = headers.filter(([name]) => name.toLowerCase() === 'origin');
  const origin = originHeaders[0]?.[1];
  if (originHeaders.length > 1 || (originHeaders.length === 1 && !allowedOrigin(origin, allowedOrigins))) {
    return { response: jsonResponse(403, { error: 'origin_not_allowed' }) };
  }
  const corsHeaders = originHeaders.length === 0 ? {} : {
    'access-control-allow-origin': origin,
    'access-control-expose-headers': 'WWW-Authenticate',
    vary: 'Origin',
  };
  return { headers: corsHeaders };
}

export function handlePreflight(headers, tools, corsHeaders) {
  const respond = (status, body) => jsonResponse(status, body, corsHeaders);
  if (singleHeader(headers, 'origin') === undefined) return respond(400, { error: 'invalid_preflight' });
  const requestedMethods = headers.filter(([name]) => name.toLowerCase() === 'access-control-request-method');
  const requestedHeaders = headers.filter(([name]) => name.toLowerCase() === 'access-control-request-headers');
  const allowedHeaders = [...corsRequestHeaders, ...getParameterHeaderNames(tools)];
  if (requestedMethods.length !== 1 || !corsMethods.includes(requestedMethods[0][1])) {
    return respond(403, { error: 'preflight_not_allowed' });
  }
  if (requestedHeaders.length > 1) return respond(403, { error: 'preflight_not_allowed' });
  if (requestedHeaders.length === 1) {
    const value = requestedHeaders[0][1];
    if (typeof value !== 'string'
      || !value.split(',').every(name => allowedHeaders.includes(name.trim().toLowerCase()))) {
      return respond(403, { error: 'preflight_not_allowed' });
    }
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
