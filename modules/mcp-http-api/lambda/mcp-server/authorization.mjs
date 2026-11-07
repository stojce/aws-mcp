import { isObject } from './protocol.mjs';

const invalidToken = () => ({ ok: false, status: 401, error: 'invalid_token' });
const isNonemptyString = value => typeof value === 'string' && value !== '';
const isStringArray = value => Array.isArray(value) && value.every(item => typeof item === 'string');

function hasAccessTokenMarker(claims, marker) {
  if (claims.token_use === 'id') return false;
  if (marker === null) return claims.token_use === undefined || claims.token_use === 'access';
  return isObject(marker) && isNonemptyString(marker.name) && isNonemptyString(marker.value)
    && claims[marker.name] === marker.value;
}

function readScopes(claims, verifiedScopes) {
  // API Gateway supplies normalized scopes separately from its claims map.
  // An invalid verified list must fail closed, never fall back to raw claims.
  if (verifiedScopes !== undefined) return isStringArray(verifiedScopes) ? verifiedScopes : [];
  return [claims.scope, claims.scp].flatMap(scope => {
    if (typeof scope === 'string') return scope.split(' ');
    return isStringArray(scope) ? scope : [];
  });
}

// Authorization double-check. API Gateway's JWT authorizer already enforced the
// issuer and the route scope; this pins the client and resource again. Cognito
// requires token_use=access; external issuers can require their own token marker.
export function authorize(claims, {
  clientId, requiredScope, resourceUrl, authorizationServer,
  authorizationMode = 'cognito', clientIdClaim = 'client_id', accessTokenClaim = null,
  allowUnboundAccessTokens = false, verifiedScopes,
}) {
  if (![resourceUrl, clientId, requiredScope].every(isNonemptyString)
    || !['cognito', 'external'].includes(authorizationMode)) {
    return invalidToken();
  }
  if (!isObject(claims) || !isNonemptyString(claims.sub)) {
    return invalidToken();
  }
  const clientClaim = authorizationMode === 'cognito' ? 'client_id' : clientIdClaim;
  if (!isNonemptyString(clientClaim) || claims[clientClaim] !== clientId) {
    return invalidToken();
  }
  if (authorizationMode === 'external'
    && (!isNonemptyString(authorizationServer) || claims.iss !== authorizationServer)) {
    return invalidToken();
  }
  const marker = authorizationMode === 'cognito' ? { name: 'token_use', value: 'access' } : accessTokenClaim;
  if (!hasAccessTokenMarker(claims, marker)) return invalidToken();

  if (claims.aud === undefined) {
    if (authorizationMode === 'external' || !allowUnboundAccessTokens) {
      return invalidToken();
    }
  } else {
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.includes(resourceUrl)) return invalidToken();
  }

  const scopes = readScopes(claims, verifiedScopes);
  if (!scopes.includes(requiredScope)) {
    return { ok: false, status: 403, error: 'insufficient_scope', scope: requiredScope };
  }
  return { ok: true, identity: { sub: claims.sub, clientId: claims[clientClaim] } };
}
