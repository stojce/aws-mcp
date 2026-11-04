#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfiguration } from '../login/config.mjs';

const email = process.env.TEST_USER_EMAIL ?? 'inspector@example.com';
const password = process.env.TEST_USER_PASSWORD ?? `Mcp-${randomBytes(18).toString('base64url')}!9aA`;
let temporaryDirectory;

try {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('TEST_USER_EMAIL must be an email address.');
  const config = loadConfiguration();
  const aws = (args) => execFileSync('aws', [...args, '--region', config.region, '--output', 'json'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  const account = JSON.parse(aws(['sts', 'get-caller-identity'])).Account;
  const pool = JSON.parse(aws(['cognito-idp', 'describe-user-pool', '--user-pool-id', config.userPoolId])).UserPool;
  if (pool.Arn.split(':')[4] !== account || (config.accountId && config.accountId !== account)) {
    throw new Error('AWS credentials do not belong to this example\'s deployed account.');
  }

  let user;
  try {
    user = JSON.parse(aws(['cognito-idp', 'admin-get-user', '--user-pool-id', config.userPoolId, '--username', email]));
  } catch (error) {
    if (!error.stderr?.includes('UserNotFoundException')) throw error;
  }
  if (user && user.UserStatus !== 'FORCE_CHANGE_PASSWORD') {
    throw new Error('This user already exists. Cognito cannot reveal its password. Choose a different TEST_USER_EMAIL to create a new user.');
  }

  temporaryDirectory = mkdtempSync(join(tmpdir(), 'mcp-test-user-'));
  chmodSync(temporaryDirectory, 0o700);
  const inputFile = join(temporaryDirectory, 'request.json');
  const request = (action, input) => {
    writeFileSync(inputFile, JSON.stringify(input), { mode: 0o600 });
    return aws(['cognito-idp', action, '--cli-input-json', `file://${inputFile}`]);
  };
  if (!user) {
    request('admin-create-user', {
      UserPoolId: config.userPoolId, Username: email, MessageAction: 'SUPPRESS',
      UserAttributes: [{ Name: 'email', Value: email }, { Name: 'email_verified', Value: 'true' }],
    });
  }
  request('admin-set-user-password', {
    UserPoolId: config.userPoolId, Username: email, Password: password, Permanent: true,
  });
  user = JSON.parse(aws(['cognito-idp', 'admin-get-user', '--user-pool-id', config.userPoolId, '--username', email]));
  if (user.UserStatus !== 'CONFIRMED') throw new Error('Cognito did not confirm the test user.');
  console.log(`User pool: ${config.userPoolId}`);
  console.log(`Username: ${email}`);
  console.log(`Password: ${password}`);
  console.log('This test user has no seeded bookings. Keep its password out of commits.');
} catch (error) {
  console.error(error.stderr?.trim() || error.message);
  process.exitCode = 1;
} finally {
  if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
}
