# Live integration tests for the deployed MCP gateway

Real Cognito user → real AgentCore Gateway → real Lambda target (recruter-dev-api).
No mocks, no SDK: raw streamable-HTTP MCP JSON-RPC, headless Cognito hosted-UI
login (authorization-code + PKCE).

## Suites

| File | Asserts |
|---|---|
| `user-tools.test.mjs` | real user login; `tools/list` = the 3 curated tools; live reads (`get_my_jobs`, `get_job_details`, `get_job_candidates`) with real data; tool-level 404 for unknown jobId; edge rejects: no header, forged JWT, expired token, wrong-client token |
| `isolated-token.test.mjs` | JWT attacks must all be rejected: `alg=none`, HS256-forged, random-RS256 key, missing scope, foreign issuer, wrong client, expired, unresolvable-sub `tools/call` |
| `run.js` | zero-dep runner for both files |

## Prereqs (the Python target side)

The tools are implemented by the recruter repo's gateway adapter
(`services/functions/gateway_tools.py`): per-user identity arrives via the
interceptor-signed `x-mcp-claims`/`x-mcp-claims-sig` headers (propagated into
`context.client_context.custom['bedrockAgentCorePropagatedHeaders']` — observed
live, NOT in `event.headers`) and is HMAC-verified against
`MCP_CLAIMS_SIGNING_SECRET` (deny-by-default).

## Run

```bash
cd examples/customer-assistant
export MCP_TEST_CLIENT_ID=$(terraform output -raw mcp_app_client_id)
# Username/password of a pool user; the hosted-UI form is submitted headlessly.
# MCP_TEST_USERNAME overrides the form username if it differs from the email.
export MCP_TEST_USERNAME=tester
export MCP_TEST_USER='{"email":"tester@example.com","password":"..."}'
node tests/run.js
```

Optional overrides: `MCP_TEST_GATEWAY_URL`, `MCP_TEST_USER_POOL_ID`
(`eu-west-1_Q7QTpRXPO`), `MCP_TEST_USER_POOL_DOMAIN`
(`claude-gateway-a9f136c8`), `MCP_TEST_REGION` (`eu-west-1`),
`MCP_TEST_ADMIN_TOKEN`, `MCP_TEST_WEB_APP_CLIENT_ID`.

## Python-side unit tests

`recruter/services/tests/test_gateway_tools.py` covers the adapter's identity
and routing logic offline (23 tests): claims signature verification (forged /
wrong-secret / anonymous / ill-typed claims all denied), tool-name strip +
unknown-tool 404, missing-tool-name denial, route formatting, Decimal → number
coercion. Run with `python3.14 -m venv .venv && .venv/bin/pip install pytest boto3 pyjwt requests && .venv/bin/pytest tests/`.

## Deployment contract discovered during this work (live-verified)

- Cognito **v2** access tokens carry **no `aud`** → the gateway authorizer must
  **not** set `allowedAudience` (every otherwise-valid token gets
  `insufficient_scope`); `allowed_clients` + `allowed_scopes` keep the edge
  bound.
- Cognito hosteed-UI config changes propagate with a delay (~30 s).
- The MCP app client must have `ALLOW_USER_PASSWORD_AUTH` only if tests log in
  via `USER_PASSWORD_AUTH`; the canonical path is the hosted-UI code+PKCE flow
  (what `user-tools.test.mjs` performs headlessly).
- Gateway Lambda targets receive tool **arguments as the event** and metadata
  (tool name, **propagated headers**) in `context.client_context.custom`;
  claims headers land in `bedrockAgentCorePropagatedHeaders`, not in the event
  body.
- The gateway interceptor config is lost when `update-gateway` is called
  without `--interceptor-configuration` — always pass it.

⚠ both suites run **live reads against the deployed recruter-dev target**.
