# Runbook: connecting an MCP client to the Guryou Gateway

The MCP edge for Guryou's per-user API. Architecture: Amazon Bedrock AgentCore
Gateway with `CUSTOM_JWT` Cognito auth; the existing Apollo `graphql.ts` Lambda
is the Gateway target; a request interceptor injects the per-user Claims
(`userId`, `userRole`, `providerId`, `isAnonymous`) before the target runs.
Decisions: `docs/adr/0001-agentcore-gateway-mcp.md`. Vocabulary: `GLOSSARY.md`.

## Tools as deployed (verified per-user reads)

| MCP tool | Answers | Source operation (recruter-dev-api) |
|---|---|---|
| `get_my_jobs` | "What jobs are in the system?" | Gateway adapter `handle_list_my_jobs` (GET /jobs parity) |
| `get_job_details` | "Tell me about this job" | `handle_get_job_details` (GET /jobs/{id} parity) |
| `get_job_candidates` | "Who applied and how did they match?" | `handle_get_job_candidates` (GET /jobs/{id}/candidates parity) |

The guryou-era `get_my_booked_events` / `get_my_memberships` were replaced when
the example was deployed against `recruter-dev-api` (this account's python
API); see `examples/customer-assistant/main.tf` and
`recruter/services/functions/gateway_tools.py`. The guryou Apollo `graphql.ts`
lambda lives in another account (org role not assumable by `mcp-demo`).

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
cd examples/customer-assistant
export MCP_TEST_CLIENT_ID=$(terraform output -raw mcp_app_client_id)
export MCP_TEST_USERNAME=tester
export MCP_TEST_USER='{"email":"tester@example.com","password":"..."}'
node tests/run.js
```

Two suites: `user-tools.test.mjs` (real hosted-UI login → tools/list → live
reads → edge negatives) and `isolated-token.test.mjs` (forged/unsuitable JWTs
all rejected). `scripts/mcp-edge-smoke.mjs` remains as the raw wire-level
script with explicit token arguments for ad-hoc runs.

Expected: `tools/list` returns the three curated tools; the read returns only
the deployed data; negative token → HTTP 40x with no tool list.

## Target Lambda secret wiring (required before any gateway call)

The request interceptor signs the claims with `MCP_CLAIMS_SIGNING_SECRET`; the
graphql target Lambda must verify with the same value. The module creates the
SSM SecureString and exposes its **name** as the output
`mcp_claims_signing_secret_ssm_name` (never the value).

1. In `guryou-infra-terraform`, grant the graphql Lambda's execution role
   `ssm:GetParameter` (+ `kms:Decrypt` for the SecureString key) on that name.
2. Set `MCP_CLAIMS_SIGNING_SECRET` in the graphql Lambda environment, resolved
   from the parameter (e.g. `data "aws_ssm_parameter"` with `with_decryption = true`,
   value passed into the Lambda `environment` block). Do not commit the value.
3. Verify: an unset variable makes the target deny every gateway invocation
   (`MCP_CLAIMS_SIGNING_SECRET is not configured`). A deploy without step 2 is
   therefore visibly broken, not silently open.

Rotating the secret means changing the SSM value and redeploying both the
interceptor and the graphql Lambda together; until both match, every gateway
call is denied.

## Operational notes

- **Isolation is interceptor-mediated and HMAC-verified.** Every tool invocation's claims are injected by the request interceptor and signed with the shared `MCP_CLAIMS_SIGNING_SECRET` (SSM SecureString); the target verifies the signature and **denies by default** when missing/invalid (GatewayIdentityError). Adding a future tool MUST keep reading identity from the injected claims only — review checkpoint.
- The Gateway execution role can invoke ONLY the graphql Lambda and the
  interceptor. Adding a target = add a `targets` entry, not a role edit.
- JWT `sub` values land in CloudTrail; keep `sub` PII-free.
- Outbound credential providers and HTTP/OpenAPI targets are reserved seams
  (`credential_provider_arn` per target), not v1. Pivot path (JWT passthrough /
  OBO) is in the ADR if interceptor-injection ever proves insufficient.
