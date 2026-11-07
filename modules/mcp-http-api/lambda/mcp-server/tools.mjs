// Compile each tool manifest once and validate every call before invoking its backend.

import { compileSchema } from './schema-validator.mjs';
import { RPC_ERRORS, LATEST_PROTOCOL_VERSION, isObject, rpcError, rpcResult } from './protocol.mjs';

const toolResult = (text, isError) => ({
  content: [{ type: 'text', text }],
  isError,
});

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

export function getToolHeaderParameters(tools, toolName) {
  const tool = tools.find(candidate => candidate.name === toolName);
  return tool ? initializeTools(tools).get(tool).headers : [];
}

export function getParameterHeaderNames(tools) {
  return [...initializeTools(tools).values()]
    .flatMap(tool => tool.headers.map(parameter => parameter.name));
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

async function invokeToolWithDeadline(input, context) {
  const timeoutMs = (context.toolDeadlineMs ?? Date.now() + (context.toolTimeoutMs ?? 27000)) - Date.now();
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new ToolTimeoutError();
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new ToolTimeoutError());
      controller.abort();
    }, timeoutMs);
  });
  try {
    return await Promise.race([context.invokeTool(input, { abortSignal: controller.signal }), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function handleToolsCall(id, params, context) {
  if (!isObject(params) || typeof params.name !== 'string' || !params.name) {
    return rpcError(id, RPC_ERRORS.invalidParams, 'tools/call requires a string name');
  }
  const invalidModernParams = context.protocolVersion === LATEST_PROTOCOL_VERSION && (
    ('arguments' in params && !isObject(params.arguments))
    || ('inputResponses' in params && !isObject(params.inputResponses))
    || ('requestState' in params && typeof params.requestState !== 'string')
  );
  if (invalidModernParams) return rpcError(id, RPC_ERRORS.invalidParams, 'Invalid tools/call parameters');
  const tool = context.tools.find(candidate => candidate.name === params.name);
  if (!tool) {
    return rpcError(id, RPC_ERRORS.invalidParams, `unknown tool: ${params.name}`);
  }
  const args = params.arguments === undefined ? {} : params.arguments;
  const invalid = validateArguments(args, initializeTools(context.tools).get(tool).validate);
  if (invalid) return rpcResult(id, toolResult(invalid, true));

  try {
    const payload = await invokeToolWithDeadline({ tool: tool.name, arguments: args, identity: context.identity }, context);
    const result = toolResult(JSON.stringify(payload ?? null), false);
    if (context.protocolVersion === LATEST_PROTOCOL_VERSION) result.structuredContent = payload ?? null;
    return rpcResult(id, result);
  } catch (error) {
    // Backend internals are not returned to the client.
    const message = error instanceof ToolTimeoutError ? 'Tool execution timed out' : 'Tool execution failed';
    return rpcResult(id, toolResult(message, true));
  }
}
