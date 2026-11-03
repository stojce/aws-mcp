import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.BOOKINGS_TABLE;

// Tool implementations. Every query is keyed on identity.sub, which the MCP
// Lambda took from the verified access token. Arguments never choose the owner.
const tools = {
  async get_my_bookings({ identity, arguments: args }) {
    const params = {
      TableName: TABLE,
      KeyConditionExpression: 'pk = :u',
      ExpressionAttributeValues: { ':u': `USER#${identity.sub}` },
    };
    if (args.status) {
      params.FilterExpression = '#s = :s';
      params.ExpressionAttributeNames = { '#s': 'status' };
      params.ExpressionAttributeValues[':s'] = args.status;
    }
    const out = await ddb.send(new QueryCommand(params));
    return {
      owner: identity.sub,
      bookings: (out.Items ?? []).map(({ pk, ...b }) => b),
    };
  },
};

export const handler = async event => {
  if (!event || typeof event.tool !== 'string' || !event.identity?.sub) {
    throw new Error('malformed invocation');
  }
  const fn = tools[event.tool];
  if (!fn) throw new Error(`unknown tool ${event.tool}`);
  return fn(event);
};
