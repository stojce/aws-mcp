# Ticket 12: Interceptor Lambda: claims injection

Type: task
Status: resolved

## Answer

Delivered in this repo (`modules/mcp-gateway`); **revised after code review (P0/P1 fixes, AWS interceptor/header docs verified)**:

- **Contract per AWS docs** (gateway-interceptors-types/-configuration, gateway-headers; verified 2026-10-16): the interceptor receives `event.mcp.gatewayRequest` with `headers` ONLY when `passRequestHeaders = true`; the JWT rides in `headers.Authorization`, already verified by the Gateway's `CUSTOM_JWT` authorizer; output MUST be `{interceptorOutputVersion: "1.0", mcp: {transformedGatewayRequest: {headers, body}}}` or `{...transformedGatewayResponse}` for short-circuit.
- **Handler** (`lambda/interceptor/index.js`): decodes the JWT payload (no re-verification needed — already validated), selects exactly `userId`, `userRole`, `providerId`, `isAnonymous` (+ `sub`, `email` required by the target's claims-fallback resolution), normalizes Cognito custom attributes and `isAnonymous`, **HMAC-signs** the claims JSON with `MCP_CLAIMS_SIGNING_SECRET` and emits:
  - `x-mcp-claims` (claims JSON) and `x-mcp-claims-sig` (base64url HMAC) in `transformedGatewayRequest.headers`; body unchanged.
  - Deny: `transformedGatewayResponse` short-circuit 401 jsonrpc error when the bearer is absent, payload undecodable, or `userId` unresolvable — the Gateway never calls the target.
- **Signing key**: `random_password` → `aws_ssm_parameter` SecureString → interceptor env var. Interceptor header values override client-supplied headers of the same name (AWS-documented), and the header pair is allowlisted per-target via `metadata_configuration.allowed_request_headers`.
- **Terraform**: `interceptor.tf` (lambda + role + SSM secret), `gateway.tf` `interceptor_configuration` with `pass_request_headers = true`, gateway role invoke policy incl. the interceptor ARN.
- **Unit tests** (Node test runner, pure seam): 7 cases — signed-header injection with exact selected-field set, signature verification with the shared secret, body pass-through, standard-claim-name aliasing, isAnonymous boolean normalization, three deny branches. **All pass (7/7).**

## Acceptance criteria

- [x] Handler event-in → event-out per the AWS interceptor payload contract; deny short-circuits at the edge.
- [x] Claims HMAC-signed; no other JWT content forwarded.
- [x] Module creates the interceptor + request-headers passing + target allowlist.
- [x] Least-privilege role; no secrets/PII in logs.
