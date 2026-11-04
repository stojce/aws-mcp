import Ajv from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

// Each tool gets an isolated schema namespace: different tools may reuse $id.
export function compileSchema(schema) {
  const draft = schema.$schema;
  const Validator = draft === 'http://json-schema.org/draft-07/schema#' ? Ajv : Ajv2020;
  if (draft !== undefined && draft !== 'https://json-schema.org/draft/2020-12/schema'
    && draft !== 'http://json-schema.org/draft-07/schema#') {
    throw new Error(`unsupported JSON Schema dialect: ${draft}`);
  }
  const validator = new Validator({
    strictSchema: true,
    strictTypes: false,
    strictTuples: false,
    strictRequired: false,
    ownProperties: true,
    // Validate without coercing types, adding defaults, or stripping properties.
    coerceTypes: false,
    useDefaults: false,
    removeAdditional: false,
  });
  // MCP 2026-07-28 transport annotation; the runtime validates its placement
  // and header-name constraints separately from JSON Schema validation.
  validator.addKeyword({ keyword: 'x-mcp-header', schemaType: 'string', valid: true });
  addFormats(validator);
  const validate = validator.compile(schema);
  // Tool validation must finish synchronously before the backend is invoked.
  if (validate.$async) throw new Error('asynchronous tool schemas are unsupported');
  return validate;
}
