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
  properties: { count: { type: 'integer', minimum: 1 } },
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
      user_pool_id: `eu-west-1_${instance}`,
      tool_backend_arn: `arn:aws:lambda:eu-west-1:123456789012:function:${instance}`,
      server_name: `${instance}-server`,
      callback_urls: ['http://localhost:8080/callback'],
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
