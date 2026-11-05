import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { access, appendFile, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const moduleDirectory = fileURLToPath(new URL('../', import.meta.url));
const instances = ['first', 'second'];
const codeFiles = ['index.mjs', 'runtime.mjs', 'schema-validator.mjs', 'schema-validator.LICENSE.txt'];
const inputSchema = {
  type: 'object',
  properties: { count: { type: 'integer', minimum: 1, 'x-mcp-header': 'Count' } },
  required: ['count'],
  additionalProperties: false,
};

test('module packages remain isolated through intervening plans and saved-plan apply', { timeout: 120000 }, async t => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'mcp-package-isolation-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const sharedModule = path.join(workspace, 'mcp-http-api');
  await mkdir(sharedModule);
  for (const entry of await readdir(moduleDirectory)) {
    if (entry.endsWith('.tf')) {
      await cp(path.join(moduleDirectory, entry), path.join(sharedModule, entry));
    }
  }
  await cp(path.join(moduleDirectory, 'lambda'), path.join(sharedModule, 'lambda'), { recursive: true });
  // Expose the private archive values in the copied module so Terraform retains
  // these data sources in a plan that has no AWS resources.
  await writeFile(path.join(sharedModule, 'package-test-output.tf.json'), JSON.stringify({
    output: {
      test_package: {
        value: {
          output_path: '${data.archive_file.mcp_server.output_path}',
          output_base64sha256: '${data.archive_file.mcp_server.output_base64sha256}',
        },
      },
    },
  }));

  // Target the real archive data sources only: this fixture never plans AWS resources.
  await writeFile(path.join(workspace, 'main.tf.json'), JSON.stringify({
    provider: {
      aws: {
        region: 'eu-west-1',
        access_key: 'unused',
        secret_key: 'unused',
        skip_credentials_validation: true,
        skip_requesting_account_id: true,
        skip_metadata_api_check: true,
      },
    },
    variable: { tool_suffix: { type: 'string', default: '' } },
    output: {
      packages: { value: instances.map(instance => '${module.' + instance + '.test_package}') },
    },
    module: Object.fromEntries(instances.map(instance => [instance, {
      source: './mcp-http-api',
      name: `mcp-${instance}`,
      cognito_authorization_server: {
        issuer: 'https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_example',
        client_id: `client-${instance}`,
        required_scope: 'https://mcp.example.com/mcp/read',
        resource_server_identifier: 'https://mcp.example.com/mcp',
      },
      tool_backend_arn: `arn:aws:lambda:eu-west-1:123456789012:function:${instance}`,
      server_name: `${instance}-server`,
      tools: [{
        name: 'get_' + instance + '${var.tool_suffix}',
        description: `Tool for ${instance}.`,
        input_schema: JSON.stringify(inputSchema),
      }],
    }])),
  }));

  const terraform = async (...args) => {
    try {
      const { stdout } = await execute('terraform', args, {
        cwd: workspace,
        env: { ...process.env, TF_IN_AUTOMATION: '1', TF_DATA_DIR: path.join(workspace, '.terraform') },
        maxBuffer: 16 * 1024 * 1024,
        timeout: 30000,
      });
      return stdout;
    } catch (error) {
      throw new Error(`terraform ${args.join(' ')} failed:\n${error.stdout || ''}${error.stderr || ''}`, { cause: error });
    }
  };

  const initArgs = ['init', '-backend=false', '-input=false', '-no-color'];
  const pluginDirectory = process.env.MCP_TERRAFORM_PLUGIN_DIR || path.join(moduleDirectory, '.terraform/providers');
  try {
    await access(pluginDirectory);
    initArgs.push(`-plugin-dir=${pluginDirectory}`);
  } catch {
    // A fresh checkout uses the normal provider installation workflow.
  }
  await terraform(...initArgs);

  const plan = async (filename, toolSuffix = '') => {
    await terraform('plan', '-input=false', '-refresh=false', '-no-color', `-out=${filename}`,
      `-var=tool_suffix=${toolSuffix}`, ...instances.map(instance => `-target=module.${instance}.data.archive_file.mcp_server`));
    const savedPlan = JSON.parse(await terraform('show', '-json', filename));
    assert.ok((savedPlan.resource_changes || []).every(change => change.mode === 'data' && change.type === 'archive_file'),
      'Saved plans must never contain AWS resource changes.');
    return savedPlan.planned_values.outputs.packages.value;
  };

  const verifyPackages = async (archives, toolSuffix = '') => {
    assert.equal(archives.length, instances.length);
    assert.notEqual(archives[0].output_path, archives[1].output_path, 'Module instances must use separate ZIP paths.');
    for (const [index, archive] of archives.entries()) {
      const zipPath = path.resolve(workspace, archive.output_path);
      assert.ok(zipPath.startsWith(`${path.join(workspace, '.terraform')}${path.sep}`),
        'Generated ZIPs must be outside the shared module source.');
      const zip = await readFile(zipPath);
      assert.equal(createHash('sha256').update(zip).digest('base64'), archive.output_base64sha256,
        'The ZIP bytes must match the hash recorded in the plan.');
      const { stdout: entries } = await execute('unzip', ['-Z1', zipPath]);
      assert.deepEqual(entries.trim().split('\n').sort(), [...codeFiles, 'tools.json'].sort());
      const { stdout: manifest } = await execute('unzip', ['-p', zipPath, 'tools.json']);
      assert.deepEqual(JSON.parse(manifest), {
        serverName: `${instances[index]}-server`,
        serverVersion: '1.0.0',
        tools: [{
          name: `get_${instances[index]}${toolSuffix}`,
          description: `Tool for ${instances[index]}.`,
          inputSchema,
        }],
      });
      for (const filename of codeFiles) {
        const { stdout: source } = await execute('unzip', ['-p', zipPath, filename]);
        assert.equal(source, await readFile(path.join(sharedModule, 'lambda/mcp-server', filename), 'utf8'));
      }
    }
  };

  const original = await plan('original.tfplan');
  await verifyPackages(original);

  // Run the extracted runtime away from the validator's development dependencies.
  const extractedPackage = path.join(workspace, 'extracted-package');
  await execute('unzip', ['-q', path.resolve(workspace, original[0].output_path), '-d', extractedPackage]);
  await execute(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { readFile } from 'node:fs/promises';
    import { handleMessage, initializeTools } from './runtime.mjs';
    const { tools } = JSON.parse(await readFile('tools.json', 'utf8'));
    initializeTools(tools);
    const seen = [];
    const identity = { sub: 'verified-user', clientId: 'verified-client' };
    const ctx = { tools, identity, invokeTool: async input => { seen.push(input); return {}; } };
    const call = args => handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: tools[0].name, arguments: args } }, ctx);
    assert.equal((await call({ count: 'many' })).result.isError, true);
    assert.equal(seen.length, 0);
    assert.equal((await call({ count: 1 })).result.isError, false);
    assert.deepEqual(seen, [{ tool: tools[0].name, arguments: { count: 1 }, identity }]);
  `], { cwd: extractedPackage });

  // Exercise the packaged entrypoint with the runtime-provided AWS SDK replaced
  // by a local stub. No credentials or AWS requests are used by this process.
  const sdkDirectory = path.join(extractedPackage, 'node_modules/@aws-sdk/client-lambda');
  await mkdir(sdkDirectory, { recursive: true });
  await writeFile(path.join(sdkDirectory, 'package.json'), JSON.stringify({
    name: '@aws-sdk/client-lambda', type: 'module', exports: './index.mjs',
  }));
  await writeFile(path.join(sdkDirectory, 'index.mjs'), `
    export const calls = [];
    export class InvokeCommand {
      constructor(input) { this.input = input; }
    }
    export class LambdaClient {
      async send(command, options = {}) {
        const payload = JSON.parse(Buffer.from(command.input.Payload).toString('utf8'));
        calls.push({ input: command.input, payload, signal: options.abortSignal });
        if (payload.arguments.count === 2) {
          return new Promise((resolve, reject) => {
            options.abortSignal.addEventListener('abort', () => reject(new Error('SDK request aborted')), { once: true });
          });
        }
        return { Payload: Buffer.from(JSON.stringify({ owner: payload.identity.sub })) };
      }
    }
  `);
  await execute(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { readFile } from 'node:fs/promises';
    import { calls } from '@aws-sdk/client-lambda';
    const resource = 'https://mcp.example.com/mcp';
    const origin = 'https://app.example.com';
    const identity = { sub: 'verified-user', clientId: 'verified-client' };
    Object.assign(process.env, {
      MCP_CLIENT_ID: identity.clientId, MCP_REQUIRED_SCOPE: 'mcp/read', MCP_RESOURCE_URL: resource,
      MCP_RESOURCE_METADATA_URL: 'https://api.example.com/.well-known/oauth-protected-resource/mcp',
      MCP_AUTHORIZATION_SERVER: 'https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_example',
      MCP_ALLOWED_ORIGINS: JSON.stringify([origin]), MCP_TOOL_TIMEOUT_MS: '20',
      TOOL_BACKEND_ARN: 'arn:aws:lambda:eu-west-1:123456789012:function:backend',
    });
    const { handler } = await import('./index.mjs');
    const { tools } = JSON.parse(await readFile('tools.json', 'utf8'));
    const claims = { sub: identity.sub, client_id: identity.clientId, token_use: 'access', aud: resource, scope: 'mcp/read' };
    const event = body => ({ headers: { origin, 'mcp-protocol-version': '2025-06-18' },
      requestContext: { http: { method: 'POST' }, authorizer: { jwt: { claims } } }, body: JSON.stringify(body) });
    const request = args => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tools[0].name, arguments: args } });
    const forbidden = event(request({ count: 1 })); forbidden.headers.origin = 'https://evil.invalid';
    assert.equal((await handler(forbidden)).statusCode, 403);
    assert.equal((await handler(event({ ...request({ count: 1 }), id: null }))).statusCode, 400);
    assert.equal((await handler(event({ jsonrpc: '2.0', id: 1, result: {} }))).statusCode, 400);
    assert.equal(JSON.parse((await handler(event(request({ count: 'many' })))).body).result.isError, true);
    const expired = event(request({ count: 1 })); expired.requestContext.timeEpoch = Date.now() - 1000;
    assert.equal(JSON.parse((await handler(expired)).body).result.isError, true);
    assert.equal(calls.length, 0);
    const preflight = await handler({ requestContext: { http: { method: 'OPTIONS' } },
      headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'Authorization, MCP-Protocol-Version' } });
    assert.equal(preflight.statusCode, 204);
    assert.equal(preflight.body, '');
    assert.equal(preflight.headers['access-control-allow-origin'], origin);
    assert.equal(calls.length, 0);
    const result = await handler(event(request({ count: 1 })));
    assert.equal(result.statusCode, 200);
    assert.equal(JSON.parse(result.body).result.isError, false);
    assert.equal(result.headers['access-control-allow-origin'], origin);
    assert.deepEqual(calls[0].payload, { tool: tools[0].name, arguments: { count: 1 }, identity });
    assert.equal(calls[0].input.FunctionName, process.env.TOOL_BACKEND_ARN);
    assert.equal(calls[0].signal instanceof AbortSignal, true);
    const timeout = await handler(event(request({ count: 2 })));
    assert.equal(JSON.parse(timeout.body).result.isError, true);
    assert.match(JSON.parse(timeout.body).result.content[0].text, /timed out/i);
    assert.equal(calls[1].signal.aborted, true);

    const metadata = {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientCapabilities': {},
    };
    const modernEvent = (method, params = {}) => ({
      headers: {
        origin, 'mcp-protocol-version': '2026-07-28', 'mcp-method': method,
        ...(method === 'tools/call' ? {
          'mcp-name': params.name, 'mcp-param-count': String(params.arguments.count),
        } : {}),
      },
      requestContext: { http: { method: 'POST' }, authorizer: { jwt: { claims } } },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { _meta: metadata, ...params } }),
    });
    const discovery = await handler(modernEvent('server/discover'));
    assert.equal(discovery.statusCode, 200);
    const discovered = JSON.parse(discovery.body).result;
    assert.deepEqual(discovered.supportedVersions, ['2026-07-28', '2025-06-18']);
    assert.equal(discovered.resultType, 'complete');
    assert.equal(discovered.ttlMs, 0);
    assert.equal(discovered.cacheScope, 'private');
    assert.equal(discovered._meta['io.modelcontextprotocol/serverInfo'].name, 'first-server');
    const modernCall = modernEvent('tools/call', { name: tools[0].name, arguments: { count: 1 } });
    modernCall.headers['mcp-param-count'] = '2';
    const mismatch = await handler(modernCall);
    assert.equal(mismatch.statusCode, 400);
    assert.equal(JSON.parse(mismatch.body).error.code, -32020);
    assert.equal(calls.length, 2);
    modernCall.headers['mcp-param-count'] = '1';
    const modernResult = await handler(modernCall);
    assert.equal(modernResult.statusCode, 200);
    assert.equal(JSON.parse(modernResult.body).result.resultType, 'complete');
    assert.deepEqual(JSON.parse(modernResult.body).result.structuredContent, { owner: identity.sub });
    assert.deepEqual(calls[2].payload, { tool: tools[0].name, arguments: { count: 1 }, identity });
    const modernPreflight = await handler({
      requestContext: { http: { method: 'OPTIONS' } },
      headers: {
        origin, 'access-control-request-method': 'POST',
        'access-control-request-headers': 'MCP-Protocol-Version, Mcp-Method, Mcp-Name, Mcp-Param-Count',
      },
    });
    assert.equal(modernPreflight.statusCode, 204);

    const externalIssuer = 'https://identity.example.com/realms/app';
    Object.assign(process.env, {
      MCP_AUTHORIZATION_MODE: 'external', MCP_AUTHORIZATION_SERVER: externalIssuer,
      MCP_CLIENT_ID: 'external-client', MCP_CLIENT_ID_CLAIM: 'azp',
      MCP_ACCESS_TOKEN_CLAIM: JSON.stringify({ name: 'kind', value: 'access' }),
    });
    const { handler: externalHandler } = await import('./index.mjs?external');
    const externalCall = modernEvent('tools/call', { name: tools[0].name, arguments: { count: 1 } });
    externalCall.requestContext.authorizer.jwt = {
      claims: { iss: externalIssuer, sub: 'external-user', azp: 'external-client', aud: resource },
      scopes: ['mcp/read'],
    };
    assert.equal((await externalHandler(externalCall)).statusCode, 401);
    assert.equal(calls.length, 3);
    externalCall.requestContext.authorizer.jwt.claims.kind = 'access';
    const externalResult = await externalHandler(externalCall);
    assert.equal(externalResult.statusCode, 200);
    assert.deepEqual(JSON.parse(externalResult.body).result.structuredContent, { owner: 'external-user' });
    assert.deepEqual(calls[3].payload.identity, { sub: 'external-user', clientId: 'external-client' });
  `], { cwd: extractedPackage });

  const updated = await plan('updated.tfplan', '_updated');
  await verifyPackages(updated, '_updated');
  for (let index = 0; index < instances.length; index++) {
    assert.notEqual(updated[index].output_path, original[index].output_path,
      'A changed manifest must not overwrite an earlier saved plan\'s package.');
  }
  await verifyPackages(original);

  await terraform('apply', '-input=false', '-no-color', 'original.tfplan');
  const state = JSON.parse(await terraform('show', '-json'));
  const applied = state.values.outputs.packages.value;
  assert.deepEqual(applied, original, 'Saved-plan apply must retain the originally planned archives.');
  await verifyPackages(applied);

  let previous = original;
  for (const filename of codeFiles) {
    await appendFile(path.join(sharedModule, 'lambda/mcp-server', filename), '\n// Package regression fixture.\n');
    const changedCode = await plan(`${filename}.tfplan`);
    await verifyPackages(changedCode);
    for (let index = 0; index < instances.length; index++) {
      assert.notEqual(changedCode[index].output_path, previous[index].output_path,
        'A source change must produce a new artifact path.');
    }
    previous = changedCode;
  }
});
