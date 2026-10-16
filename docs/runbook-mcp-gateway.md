# Runbook: connecting an MCP client to the Guryou Gateway

The MCP edge for Guryou's per-user API. Architecture: Amazon Bedrock AgentCore
Gateway with `CUSTOM_JWT` Cognito auth; the existing Apollo `graphql.ts` Lambda
is the Gateway target; a request interceptor injects the per-user Claims
(`userId`, `userRole`, `providerId`, `isAnonymous`) before the target runs.
Decisions: `docs/adr/0001-agentcore-gateway-mcp.md`. Vocabulary: `GLOSSARY.md`.

## Tools at v1 (verified per-user reads)

| MCP tool | Answers | Source operation |
|---|---|---|
| `get_my_booked_events` | "What have I booked this month?" | `getMyBookedEvents(startTime?)` |
| `get_my_memberships` | "What memberships do I hold?" | `getMyMemberships(all?)` |

No mutations at v1. `mcp.write` does not exist yet by design.

## Preconditions

- Terraform module applied (this repo: `modules/mcp-gateway`; example wiring in
  `examples/customer-assistant`). Needs from `guryou-infra-terraform`: the
  existing User Pool id and the graphql Lambda invoke ARN.
- Outputs needed for a connection: `gateway_url`, `mcp_app_client_id`.

## Connect (agent vendor)

1. **Log the user in** with the dedicated MCP app client (`mcp_app_client_id`),
   standard Cognito **authorization-code + PKCE**, scope `mcp.read`
   (token reference: `mcp/read`). Callbacks must be one of the registered
   `callback_urls`.
2. **Take the access token** of that flow. It carries:
   - `client_id` = the MCP app client (web-app tokens are rejected here)
   - scope including `mcp/read`
   - `sub` = the real end user (per-user isolation)
3. **Point the MCP client** at `gateway_url` as a streamable-HTTP MCP endpoint,
   sending `Authorization: Bearer <access_token>` on every call.

## Smoke-verify the deployment

```bash
node scripts/mcp-edge-smoke.mjs \
  --url "<gateway_url>" \
  --token "<user_access_token>" \
  --token-web-client "<web_app_client_token>" \
  --token-no-scope "<mcp_client_token_without_read>" \
  --token-unscoped "<valid_jwt_lacking_resolvable_user_id>"
# omit the two read asserts with --call skip; pick the other read:
#   --call get_my_memberships --args '{"all":true}'
```

Expected: `tools/list` returns the two curated tools; the read returns only the
calling user's data; negative token → HTTP 40x with no tool list.

## Operational notes

- **Isolation is interceptor-mediated and HMAC-verified.** Every tool invocation's claims are injected by the request interceptor and signed with the shared `MCP_CLAIMS_SIGNING_SECRET` (SSM SecureString); the target verifies the signature and **denies by default** when missing/invalid (GatewayIdentityError). Adding a future tool MUST keep reading identity from the injected claims only — review checkpoint.
- The Gateway execution role can invoke ONLY the graphql Lambda and the
  interceptor. Adding a target = add a `targets` entry, not a role edit.
- JWT `sub` values land in CloudTrail; keep `sub` PII-free.
- Outbound credential providers and HTTP/OpenAPI targets are reserved seams
  (`credential_provider_arn` per target), not v1. Pivot path (JWT passthrough /
  OBO) is in the ADR if interceptor-injection ever proves insufficient.
