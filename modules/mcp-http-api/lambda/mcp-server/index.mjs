import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { handleHttpEvent, initializeTools } from './runtime.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const { tools, serverName, serverVersion } = JSON.parse(
  await readFile(path.join(here, 'tools.json'), 'utf8')
);

initializeTools(tools);

const lambda = new LambdaClient({});
const cfg = {
  clientId: process.env.MCP_CLIENT_ID,
  requiredScope: process.env.MCP_REQUIRED_SCOPE,
  resourceUrl: process.env.MCP_RESOURCE_URL,
  resourceMetadataUrl: process.env.MCP_RESOURCE_METADATA_URL,
  authorizationServer: process.env.MCP_AUTHORIZATION_SERVER,
  authorizationServerMetadata: JSON.parse(process.env.MCP_AUTHORIZATION_SERVER_METADATA ?? 'null'),
  authorizationMode: process.env.MCP_AUTHORIZATION_MODE ?? 'cognito',
  clientIdClaim: process.env.MCP_CLIENT_ID_CLAIM ?? 'client_id',
  accessTokenClaim: JSON.parse(process.env.MCP_ACCESS_TOKEN_CLAIM ?? 'null'),
  allowUnboundAccessTokens: process.env.MCP_ALLOW_UNBOUND_ACCESS_TOKENS === 'true',
  allowedOrigins: JSON.parse(process.env.MCP_ALLOWED_ORIGINS ?? '[]'),
  toolTimeoutMs: Number(process.env.MCP_TOOL_TIMEOUT_MS ?? 27000),
  serverInfo: { name: serverName, version: serverVersion },
  tools,
  invokeTool: async ({ tool, arguments: args, identity }, { abortSignal }) => {
    // Identity comes ONLY from the verified token. Client arguments cannot set it.
    const res = await lambda.send(
      new InvokeCommand({
        FunctionName: process.env.TOOL_BACKEND_ARN,
        InvocationType: 'RequestResponse',
        Payload: Buffer.from(JSON.stringify({ tool, arguments: args, identity })),
      }),
      { abortSignal }
    );
    if (res.FunctionError) throw new Error(`backend error: ${res.FunctionError}`);
    return JSON.parse(Buffer.from(res.Payload).toString('utf8'));
  },
};

export const handler = async event => handleHttpEvent(event, cfg);
