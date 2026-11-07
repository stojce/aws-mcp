import { readFile } from 'node:fs/promises';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { handleHttpEvent, initializeTools } from './runtime.mjs';

const { tools, serverName, serverVersion } = JSON.parse(
  await readFile(new URL('./tools.json', import.meta.url), 'utf8')
);

initializeTools(tools);

const lambda = new LambdaClient({});

async function invokeTool({ tool, arguments: args, identity }, { abortSignal }) {
  // Identity comes only from the verified token. Client arguments cannot set it.
  const response = await lambda.send(
    new InvokeCommand({
      FunctionName: process.env.TOOL_BACKEND_ARN,
      InvocationType: 'RequestResponse',
      Payload: Buffer.from(JSON.stringify({ tool, arguments: args, identity })),
    }),
    { abortSignal }
  );
  if (response.FunctionError) throw new Error(`backend error: ${response.FunctionError}`);
  return JSON.parse(Buffer.from(response.Payload).toString('utf8'));
}

const config = {
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
  invokeTool,
};

export const handler = async event => handleHttpEvent(event, config);
