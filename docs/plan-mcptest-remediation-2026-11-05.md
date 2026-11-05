# MCP evaluation remediation plan

Proposed on 2026-11-05 for `https://d3fnojefdq9ufq.cloudfront.net/mcp`.
Source: [mcptest report](../mcptest-d3fnojefdq9ufq.cloudfront.net-report.md), generated at 12:42 UTC by mcptest 1.0.0 (`0401f688eaa0689efa1d1bac9e35b4dbfd062585`). Baseline: **86/110 (78.18%)**.

**Implementation status — prepared and tested on 2026-11-05**

The user requested repository changes and local tests without deployment. The
fixable configuration and schema changes are implemented, with verification
tools for the observations that require a deployed endpoint. The original
report and deployed score remain unchanged. A live AWS Terraform plan was not
produced; the account's SSO session had expired and the user selected local
preparation and testing.

| Work | Local result | Remaining live verification |
| --- | --- | --- |
| Browser access | mcptest's exact origin is in the example defaults; CORS, public discovery, and denial regressions pass | Apply the configuration, then connect directly from mcptest's browser |
| Tool inputs | Undeclared properties are rejected and `status` is described; smoke checks catch both regressions | Confirm the published tools/list schema and valid/invalid calls after deployment |
| OAuth registration and callbacks | Metadata explicitly declares no Client ID Metadata Documents; setup and host verification limits are documented; existing callback tests pass | Verify each actual host's callback, sign-in, and registration mode |
| Statelessness and optional capabilities | Independent runtime instances keep concurrent users and protocol versions separate; smoke checks verify session-header absence and method-not-found responses | Capture direct endpoint observations for the next report |
| Refresh tokens | A verifier exercises two rotations, binding/identity, tool access, and retired-token rejection; local regressions and private token persistence pass | Run with a fresh authorization-code token response against the intended provider |
| Performance | Direct tools/list sample counts and p50/p95 reporting are available | Measure deployed performance and mcptest negotiation; no latency gain is claimed locally |

Validation passed with Node.js 22.23.4 and Terraform 1.17.1: **117 Node tests**, the
separate **package-isolation test**, **44 module Terraform tests**, **2 example
Terraform tests**, both Terraform validations, recursive formatting, and shell
syntax. Terraform tests use mocked providers; packaging uses local archive
plans. A pre-existing three-line alignment issue in the gateway variables was
formatted so the repository-wide check passes.

Reproduction and operational commands are in the
[example README](../examples/mcp-http-api/README.md#local-verification).

The original plan below prioritizes direct browser access and the bookings input contract, followed by transport/OAuth evidence, performance measurements, and a fresh evaluation. It was written against the OAuth and protocol changes already present in the workspace.

**Evidence collected for this plan**

Public endpoint checks on 2026-11-05 reproduced the browser failure without credentials:

```bash
curl -sS --max-time 15 -i -X OPTIONS \
  'https://d3fnojefdq9ufq.cloudfront.net/mcp' \
  -H 'Origin: https://mcptest.io' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: content-type,accept,mcp-protocol-version,mcp-method,mcp-name,authorization'
```

Result: **HTTP 403**, `{"error":"origin_not_allowed"}`, with no `Access-Control-Allow-Origin`. Changing only Origin to `http://localhost:6274` returns **HTTP 204**, the matching allowed origin, and all six requested headers. An unauthenticated POST from that allowed origin returns **HTTP 401** and exposes `WWW-Authenticate`. These observations identify origin configuration as the immediate cause; the required modern request headers already work for an allowed origin.

At baseline, the example's `allowed_origins` defaults contained only the two Inspector loopback origins. Its callbacks already included `https://mcptest.io/oauth/callback`; callback registration does not grant browser access.

Public authorization metadata advertises `authorization_code`, `refresh_token`, S256 PKCE, and public-client token authentication. Both `registration_endpoint` and `client_id_metadata_document_supported` are absent. Live token issuance, refresh, and individual host login flows were not exercised while preparing this plan.

The existing gateway interceptor, MCP runtime/protocol/authentication, and login suites passed under Node.js 22.23.4:

```bash
node --test --test-reporter=dot \
  modules/mcp-gateway/lambda/interceptor/index.test.js \
  modules/mcp-http-api/lambda/mcp-server/*.test.mjs \
  examples/mcp-http-api/login/*.test.mjs
```

**Coverage of every finding**

Here `*` covers `chatgpt`, `claude`, `cursor`, `vscode-copilot`, and `generic-sdk`.

| Report finding | Assessment | Planned resolution |
| --- | --- | --- |
| Direct browser negotiation failed; Web Client Accessibility 0/15 | Confirmed origin rejection | Step 1, then direct browser verification in step 5 |
| Generic SDK browser runtimes need CORS | Same configuration gap for intended browser origins | Steps 1 and 5 |
| `tool.schema.unconstrained-inputs` | Confirmed: the example object allows undeclared properties | Step 2 |
| Input properties lack descriptions | Confirmed: `status` has no description | Step 2 |
| `transport.cors-expose-headers-missing` | Explicitly **not checked** through the proxy; no session-header defect established | Steps 1 and 4 verify actual response headers directly |
| `*.protocol.session-behavior`; `chatgpt.protocol.stateful-scaling-caveat` | Missing report evidence; code and the report's core section describe stateless operation | Step 4 records behavior across independent requests and runtime instances |
| `*.authorization.oauth.registration` | Static pre-registration is implemented; automatic registration is unavailable | Step 3 documents the supported mode and verifies each host can use it |
| `*.authorization.oauth.refresh-tokens` | Grant support is advertised; issuance and continued access remain unverified | Step 5 exercises real authorization-code and refresh exchanges |
| `*.authorization.oauth.redirects` | Exact host callbacks and deployed client configuration need comparison | Steps 3 and 5 |
| Unsupported `resources/list`, `resources/templates/list`, `prompts/list`; Capabilities 4/10 | Optional functionality; current method-not-found behavior is correct | Step 4 records the supported tool-only contract and retains regression coverage |
| Tasks, resource subscriptions, sampling, and elicitation not conclusively observed | Optional or unused features; not established compatibility failures | Step 4 captures actual client/server capabilities and marks each as unused or unsupported as appropriate |
| Performance 12/15; negotiation 554 ms, tools/list 191 ms | Rated good; one measurement through a proxy is insufficient to diagnose a regression | Step 6 measures direct access and optimizes demonstrated server costs |

**1. P1 — Enable the intended browser origins**

Update [example variables](../examples/mcp-http-api/variables.tf) to include `https://mcptest.io` alongside the existing Inspector origins. Update any deployment-specific variable override that replaces this list. Keep the module's default browser policy closed and keep callback URLs and browser origins separately explicit.

The same input already configures Lambda Origin validation, API Gateway CORS, and CloudFront response headers through [main.tf](../modules/mcp-http-api/main.tf), [discovery.tf](../modules/mcp-http-api/discovery.tf), and [runtime.mjs](../modules/mcp-http-api/lambda/mcp-server/runtime.mjs). Preserve exact origins, JWT authorization, resource audience, scope enforcement, and the existing modern request-header list, including configured `Mcp-Param-*` headers.

Extend the example's deployed smoke checks to cover the reported Origin and header combination, public preflight, readable authentication challenges, public discovery, and a disallowed origin. Run the existing Terraform tests that verify consistency across the three CORS layers. Update the example README with both the callback and origin needed by mcptest.

Acceptance: unauthenticated preflight from mcptest succeeds with HTTP 204 and the exact allowed origin; all six requested headers are allowed; browser JavaScript can read the 401 discovery challenge and fetch its metadata URL, including the advertised API Gateway metadata URL. Authenticated browser discovery and tool calls succeed directly. Unknown origins remain denied and native clients still work without Origin.

Inspect exposed headers on real success and error responses. `WWW-Authenticate` is already exposed for trusted origins. This implementation does not issue a session ID or a protocol-version response header, so the report's generic advice to expose those headers does not justify adding session state. Expose any additional response headers only if the selected client contract actually needs them.

**2. P1 — Tighten and describe the bookings schema**

In [the example tool definition](../examples/mcp-http-api/main.tf), add `additionalProperties = false` to the root input object. Keep `status` optional and retain its existing enum: `confirmed`, `cancelled`, `past`. Give it a description such as: “Filter bookings by status. Omit to return bookings of every status for the signed-in user.” Update the module README's minimal tool-schema example to demonstrate a closed object too.

The runtime already enforces JSON Schema with Ajv. Apply the restriction to this tool's declared contract; the reusable module should continue honoring each consumer's schema.

Extend the deployed smoke test to inspect the schema returned by `tools/list` and exercise `{}`, each permitted status, an invalid status, a wrong type, and an undeclared property such as `owner` or `identity`. Reuse existing validator tests for rejection before backend invocation. Valid but schema-invalid argument objects should produce the existing tool error result with `isError: true`; preserve the distinction from malformed JSON-RPC requests.

Acceptance: both tool-surface warnings disappear; valid calls still work; unknown keys fail validation; identity continues to come from verified claims. Verify user isolation with two sandbox users and their known bookings.

**3. P2 — Make OAuth registration and callback support explicit**

Document static pre-registration as the supported Cognito mode: use `mcp_app_client_id`, an empty client secret, authorization code with S256, and exact registered callbacks. In the module-owned Cognito OAuth metadata in [variables.tf](../modules/mcp-http-api/variables.tf), publish `client_id_metadata_document_supported = false`; retain the absent `registration_endpoint`. Extend the existing OAuth metadata tests for this truthful declaration. External provider metadata remains the provider's responsibility.

Build a compatibility table in the example README containing host/version, registration mode, exact callback, browser Origin when relevant, initial authorization result, refresh result, and evidence date. Populate it by inspecting the actual client configuration and the deployed Cognito app client; Terraform defaults alone do not prove what is registered.

| Client | Callback work |
| --- | --- |
| mcptest | Verify the already configured `https://mcptest.io/oauth/callback`; add its browser origin in step 1 |
| Claude | Verify the already configured `https://claude.ai/api/mcp/auth_callback` against the connector being tested |
| ChatGPT | Obtain the callback shown for this specific connector and register that exact value |
| Cursor | Record the installed client's callback and whether it can use a fixed callback and pre-registered public client |
| VS Code Copilot | Record the actual configured callback and public-client support for the tested version |
| Generic SDK | Select and record the SDK/version/runtime; register its exact callback and any intended browser origin |

Preserve existing callbacks when adding verified ones. Test exact-match rejection for an unregistered callback. For a client with changing loopback ports, configure a fixed supported port where possible. A host that cannot use the available registration/callback contract needs a concrete compatibility decision based on its observed behavior. If an authorization broker or external provider is required, scope that integration with the module's existing client-claim binding and resource-bound token requirements; changing discovery metadata alone cannot implement dynamic registration.

Acceptance: each host's registration and redirect findings have an observed result and repeatable setup instructions, or a specific documented incompatibility. Missing host access remains explicitly unverified. There is no requirement to implement optional dynamic registration merely to remove an unknown label.

**4. P2 — Capture the stateless transport and capability contract**

Extend [the HTTP API smoke test](../examples/mcp-http-api/scripts/smoke.sh) for direct requests and sanitized evidence output. Use the actual modern request metadata and mirrored headers; retain coverage of legacy `2025-06-18` separately.

Check modern `server/discover`, `tools/list`, and `tools/call` without initialization, cookies, or a session identifier. Record that responses do not mint `Mcp-Session-Id`, and subsequent requests work without one. Exercise requests in fresh runtime instances in local tests and repeated/concurrent requests against the deployed endpoint. Alternate users and protocol versions to detect retained identity or request context. Fresh HTTP connections alone do not prove distinct Lambda instances, so use the local instance checks to establish that property.

Capture discovery's actual capabilities: tools with `listChanged: false`. Preserve version-appropriate method-not-found responses for unimplemented resources, resource templates, prompts, and task methods. Record sampling, elicitation, and subscriptions in terms of the actual client/server roles and their absence from this tool workflow.

Acceptance: the session and scaling findings have direct evidence of stateless behavior; optional features are accurately classified. The MCP 2026 transport specification explicitly removes the legacy session mechanism. Adding empty discovery methods or invented capability flags would expand the declared contract without solving an observed defect.

**5. P2 — Validate, deploy, and verify complete authorization flows**

After steps 1–4 are implemented, run Node 22 tests, Terraform formatting, module/example validation, mocked Terraform tests, and the existing package-isolation test. Initialize providers where needed:

```bash
terraform fmt -check -recursive
terraform -chdir=modules/mcp-http-api validate
terraform -chdir=examples/mcp-http-api validate
terraform -chdir=modules/mcp-http-api test
terraform -chdir=examples/mcp-http-api test
node --test modules/mcp-http-api/tests/package-isolation.test.mjs
```

Prepare and inspect a Terraform plan for the example that owns the reported endpoint, including its actual variable overrides. Expected changes are origin/CORS configuration, the packaged tool manifest, explicit metadata, and any verified callback additions. Review any unrelated changes or resource replacements against the pre-existing working-tree changes before applying. Use the intended sandbox account and record the previous configuration and artifact versions so a rollback can be planned if needed. Wait for CloudFront configuration propagation before testing.

Run a fresh authorization-code/S256 login from mcptest in direct-browser mode. Verify access-token and refresh-token issuance, then refresh at the advertised public token endpoint with the same client and MCP resource. Check that refreshed access retains the expected Cognito issuer, user subject, client binding, resource audience, and required scope, and use it successfully for `tools/list` and `tools/call`.

Exercise refresh-token rotation: store the replacement token, perform a second refresh, and verify rejection of a rotated-out token after the configured five-second grace period. Check expired or invalid refresh behavior without logging tokens. Repeat the relevant login/refresh checks for each available host in step 3. Use fresh sandbox sessions and environment variables or protected temporary files for credentials.

Acceptance: direct browser negotiation, discovery, tool calls, OAuth renewal, and the applicable host callbacks pass. Capture request metadata, response statuses, header presence, and assertion results with credentials, codes, cookies, and booking data removed. A metadata declaration of `refresh_token` alone does not close the refresh finding.

**6. P3 — Measure and address demonstrable latency costs**

After direct access works, measure negotiation and tool-list latency without the proxy using a fixed client/version and location. Record repeated warm samples and separately identified cold samples, with sample counts and p50/p95; retain the original 554 ms and 191 ms as single-sample reference values. A practical initial run is 30 warm samples, with cold behavior correlated to Lambda initialization evidence where available.

If latency remains material, use API Gateway integration latency and Lambda duration/initialization measurements to identify the cost. Preserve the existing AWS client reuse and startup schema compilation. Tune memory or package/startup work only when measurements support the change. Evaluate provisioned concurrency only if a defined latency target justifies its ongoing cost.

Acceptance: document comparable before/after measurements and any optimization's cost. Maintain private per-user results and the existing disabled CloudFront response caching. The report already rates performance good; a small regional network difference is not proof that the server needs architectural changes.

**7. P2 — Rerun the report and close the evidence ledger**

Start a fresh mcptest authorization/evaluation after deployment and confirm its provenance records a direct connection to the same endpoint, without the authenticated proxy. Save the new report and sanitized transport/OAuth observations, recording deployed revision, variable configuration, client versions, and verification date. Map every row above to fixed, verified behavior, intentionally unsupported optional functionality, or a concrete remaining external dependency.

If mcptest still labels sessions or registration unknown despite direct evidence, retain the observations and prepare a minimal evaluator reproduction. The current report already combines successful stateless negotiation with unknown session behavior. The refresh metadata/issuance distinction should remain explicit. Do not claim another host is compatible merely because mcptest passes.

Expected score effect: restoring Web Client Accessibility from 0/15 to 15/15 would produce **101/110 (91.82%)** if the other scores remain unchanged. Schema improvements address the separate tool-surface findings. The remaining six capability points represent optional resources/prompts functionality, and the remaining three performance points depend on fresh measurements. A perfect score is not the completion criterion.

Completion of live remediation means the confirmed browser/schema defects are deployed, direct tests and required regression checks pass, and every compatibility unknown has evidence or a clearly stated reason it cannot yet be verified. Implementation and local validation are complete as recorded above. Deployment, host sign-ins, authenticated provider refresh checks, and a fresh evaluation remain deferred at the user's request.

References: [MCP 2026 HTTP transport](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/3c4d91b7e832d9b74338d56eed03403ccc662123/docs/specification/2026-07-28/basic/transports/streamable-http.mdx), [MCP client registration](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/3c4d91b7e832d9b74338d56eed03403ccc662123/docs/specification/2026-07-28/basic/authorization/client-registration.mdx), and the repository's [protocol research](../.scratch/mcp-on-aws/mcp-http-api-2026-07-28-protocol-research.md).
