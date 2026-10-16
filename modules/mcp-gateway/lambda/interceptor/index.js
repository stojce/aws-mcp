// REQUEST interceptor for the AgentCore Gateway (AWS documented contract:
// gateway-interceptors-types + gateway-headers docs, verified 2026-10-16).
//
// Input (interceptorInputVersion 1.0):
//   event.mcp.gatewayRequest.headers lands ONLY when passRequestHeaders=true
//   (the module sets it). The user's JWT is in headers.Authorization; its
//   signature was already verified by the Gateway's CUSTOM_JWT authorizer
//   before the interceptor runs, so decoding the payload here needs no
//   re-verification.
//
// Output (interceptorOutputVersion 1.0):
//   success → mcp.transformedGatewayRequest = {
//     headers: { "x-mcp-claims": <claims JSON>, "x-mcp-claims-sig": <HMAC> },
//     body: event.mcp.gatewayRequest.body (unchanged)
//   }
//   The claims header "x-mcp-claims" is OVERRIDES any client-supplied value
//   of the same name (AWS: interceptor header wins over client header), and
//   must be allowlisted on the target via metadata_configuration.allowed_request_headers.
//   deny    → mcp.transformedGatewayResponse short-circuits (Gateway never
//   calls the target): 401 jsonrpc error.
//
// Signing: the claims JSON is HMAC-SHA256-signed with MCP_CLAIMS_SIGNING_SECRET
// (shared secret, SSM SecureString created by the module). The target's
// context guard (libs/auth-cognito gatewayClaims) verifies the signature and
// rejects unsigned or forged claims — WebSocket-free identity trust on both
// ingress routes: an HTTP-edge attacker forging marker + claims still fails
// the signature check (they hold no secret).
//
// The forwarded claims are exactly: userId, userRole, providerId,
// isAnonymous (+ sub, email, required by the target's claims-fallback
// resolution in libs/auth-cognito resolveMissingClaims). No other JWT
// content leaves the interceptor.

const crypto = require('crypto');

const SELECT_KEYS = ['userId', 'userRole', 'providerId', 'isAnonymous', 'sub', 'email'];
// Cognito custom attributes and standard claims carry the same identity
// facts under different names; normalize to the app-level names.
const SOURCE_KEYS = {
  userId: ['custom:user_id', 'userId', 'user_id'],
  userRole: ['custom:role', 'userRole', 'role'],
  providerId: ['custom:provider_id', 'providerId', 'provider_id'],
  isAnonymous: ['custom:is_anonymous', 'isAnonymous', 'is_anonymous'],
  sub: ['sub'],
  email: ['email'],
};

const decodeJwtPayload = authHeader => {
  const token = authHeader && authHeader.replace(/^Bearer\s+/i, '');
  if (!token || token.split('.').length !== 3) return null;
  try {
    const payload = token.split('.')[1];
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
};

const pickClaims = claims => {
  const out = {};
  for (const field of SELECT_KEYS) {
    const key = (SOURCE_KEYS[field] || [field]).find(k => claims[k] !== undefined && claims[k] !== null);
    if (key !== undefined) {
      out[field] = field === 'isAnonymous' ? String(claims[key]) === 'true' : claims[key];
    }
  }
  // The app-level claims set always carries isAnonymous (normalizeClaims
  // contract); an absent flag means a real user.
  if (!('isAnonymous' in out)) out.isAnonymous = false;
  return out;
};

const signClaims = claims =>
  crypto.createHmac('sha256', process.env.MCP_CLAIMS_SIGNING_SECRET).update(JSON.stringify(claims)).digest('base64url');

const ERROR = -32602;

const denyEnvelope = reason => ({
  interceptorOutputVersion: '1.0',
  mcp: {
    transformedGatewayResponse: {
      statusCode: 401,
      body: {
        jsonrpc: '2.0',
        error: {
          code: ERROR,
          message: `gateway identity: ${reason}`,
        },
      },
    },
  },
});

exports.handler = async event => {
  const mcp = event?.mcp ?? {};
  const gatewayRequest = mcp.gatewayRequest ?? {};
  const headers = gatewayRequest.headers ?? {};

  const bearer = headers.Authorization ?? headers.authorization;
  if (!bearer) {
    return denyEnvelope('no bearer token at the MCP edge');
  }

  const claims = decodeJwtPayload(bearer);
  if (!claims || !claims.sub) {
    return denyEnvelope('token payload not decodable or sub absent');
  }

  const selected = pickClaims(claims);
  if (!selected.userId) {
    return denyEnvelope('userId not resolvable from token claims');
  }

  const claimsJson = JSON.stringify(selected);
  return {
    interceptorOutputVersion: '1.0',
    mcp: {
      transformedGatewayRequest: {
        headers: {
          'x-mcp-claims': claimsJson,
          'x-mcp-claims-sig': signClaims(selected),
        },
        body: gatewayRequest.body,
      },
    },
  };
};
