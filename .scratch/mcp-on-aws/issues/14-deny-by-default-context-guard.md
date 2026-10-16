# Ticket 14: Deny-by-default context guard in the existing app Lambda

Type: task
Status: resolved

## Answer

Implemented in the mono worktree (`~/Projects/gy/guryou-mono/stage2`, two commits on `stage2`: d10778387 + f8b3b5dff after review fixes):

- **`libs/auth-cognito/src/gatewayClaims.js`** (new): route discriminator + claims verifier.
  - Gateway-route detection: `bedrock.?agent.?core` markers (camelCase and hyphenated).
  - **Trust anchor is the HMAC, not the marker** (review P0 fix): the claims JSON in `x-mcp-claims` must carry `x-mcp-claims-sig` = HMAC-SHA256 (base64url) over the exact header payload with `MCP_CLAIMS_SIGNING_SECRET`. Verified with a timing-safe compare. Because the same Lambda serves the public `authorization_type = NONE` API edge, a client *can* spoof marker-like headers — but forged or tampered claims fail signature verification; unsigned/absent claims on a gateway-routed request throw `GatewayIdentityError` (deny-by-default). Non-gateway events return null (bearer path untouched).
  - Normalizes `isAnonymous` (string `true` → boolean) and carries `sub`/`email` for the claims-fallback resolution.
- **`libs/auth-cognito/src/index.js` + `index.d.ts`**: exports `GatewayIdentityError`, `gatewayClaims` with typed surface.
- **`api/proxy/src/lambdas/graphql.ts`** (`f8b3b5dff`): context builder calls `gatewayClaims(event)` first; a verified gateway identity becomes `appContext.claims` (authorization stays undefined) and the bearer-token path is never consulted; anything thrown propagates as a failed context → explicit tool error. Non-gateway events hit exactly the pre-existing path (extracted `buildContextDataSources()` shared by both branches to kill the initializer duplication).

## Verification

- lib vitest: **10/10 pass** (`gatewayClaims.test.js`) — resolved signed claims via requestContext/headers markers; deny: absent headers, claims-without-sig, **forged claims signed with attacker secret (cross-user spoof)**, tampered payload, non-JSON, missing userId; isAnonymous normalization; null for non-gateway.
- proxy jest: **5/5 pass** (`gatewayIdentity.test.ts`) — signed claims resolved; deny on absent; spoof denial through the real lib export; authorization never forwarded on the gateway route; plain HTTP bearer events unclassified (regression). Also `authorizer.test.ts` 3/3 unchanged.
- `tsc --noEmit -p api/proxy/tsconfig.json`: clean. Babel lib build: clean.

## Acceptance criteria

- [x] Gateway route deny-by-default with explicit error; forged/unsigned claims rejected.
- [x] Existing HTTP-API auth path unchanged (regression-covered).
- [x] Unit tests in mono's auth test style for both sides of the seam.
- [x] Consistent with ADR-0001 (guard = identity plumbing, HMAC-verified).
