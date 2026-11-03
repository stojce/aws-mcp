# Full review: mcp-http-api — 2026-11-03

Scope: all current code in `modules/mcp-http-api/`, including Terraform, the Lambda runtime, and tests. `examples/mcp-http-api/` was used as supporting context. This is a working-tree review, not a diff review; the module and example were untracked at review time.

The review identified **0 Standards findings and 13 Spec findings, all P2**. No P1 findings were identified in this snapshot. Finding numbers such as R01 are identifiers, not priority ratings. The highest repair priority was the shared Lambda ZIP path across module instances. **All 13 findings are now fixed; zero remain open.**

No implementation files were changed during the original review. This report was updated after the R01–R13 repairs on 2026-11-03; see their status and verification below. Original observations and earlier verification results are retained as history.

## Findings index

| ID | Priority | Issue | Status |
|---|---|---|---|
| R01 | P2 | Advertised AWS provider v5 support is incompatible | Fixed |
| R02 | P2 | Module instances share the generated Lambda ZIP | Fixed |
| R03 | P2 | Resource-server identifiers collide in a shared pool | Fixed |
| R04 | P2 | Tool arguments are not validated against the full schema | Fixed |
| R05 | P2 | Protocol headers and negotiated versions are inconsistent | Fixed |
| R06 | P2 | Incoming Origin headers are not validated | Fixed |
| R07 | P2 | Browser clients cannot complete CORS preflight | Fixed |
| R08 | P2 | Request IDs and initialization parameters are not validated | Fixed |
| R09 | P2 | Incoming JSON-RPC responses receive the wrong HTTP status | Fixed |
| R10 | P2 | The public Cognito client does not rotate refresh tokens | Fixed |
| R11 | P2 | Timeout inputs can produce invalid HTTP API integrations | Fixed |
| R12 | P2 | Authentication documentation contradicts the strict default | Fixed |
| R13 | P2 | Discovery tests fail before their assertions run | Fixed |

## Implementation priority

The user clarified that "P1" means the highest-priority findings to repair first. Start with **R02, the shared Lambda ZIP path**, because it can deploy the wrong tool manifest to an endpoint. The original review's severity ratings remain P2; R01 is a finding number, not the requested priority.

R02's repair gives separate module instances their own generated packages and verifies the actual ZIP contents for two different tool manifests. Verified identity and unrelated working-tree edits are preserved. Its status and verification results are recorded below.

## Standards

**0 findings.** The current module follows the consequential requirements in [AGENTS.md](../AGENTS.md): trusted identity is kept separate from client arguments, authorization denies invalid identities, password authentication defaults to disabled, and the Lambda uses Node.js 22 and ES modules. No substantial baseline code smells were identified. Mechanical formatting was checked separately.

The API Gateway HTTP API implementation is an intentional alternative to the original AgentCore design. Architecture-specific interceptor requirements from the original Gateway spec were not applied to this module.

## Spec

### R01 — P2: Advertised AWS provider v5 support is incompatible

Locations: `modules/mcp-http-api/variables.tf:91`; `modules/mcp-http-api/versions.tf:7`.

At review time, the module permitted `hashicorp/aws >= 5.80, < 7.0.0` but constructed its Cognito issuer with `data.aws_region.current.region`. Official provider source for v5.80.0 and v5.100.0 exposes `name`, `id`, `description`, and `endpoint`, without `region`.

**Trigger and impact:** a consumer retaining a permitted v5 provider cannot validate the module because the referenced attribute does not exist. Passing validation with installed provider v6.69.1 does not establish v5 compatibility.

**Fix:** use a region attribute supported by the advertised range, or raise the provider floor and align the example's constraint. Verify the resulting minimum supported version as well as the installed version.

**Status: Fixed (2026-11-03).** The module and supporting example both require `hashicorp/aws >= 6.0.0, < 7.0.0`, excluding the incompatible v5 schema. The module README states this requirement, and the provider constraint records why the v6 floor is needed. Local lockfiles were refreshed to record the matching constraints while retaining their selected provider versions.

**Compatibility verification:** temporary copies of the complete module and supporting example were pinned to the real AWS provider **6.0.0**, and both passed `terraform validate`. The provider ZIP matched HashiCorp's published SHA-256 checksum. Its schema exposes `aws_region.region`; a targeted plan evaluated the actual issuer expression to `https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_example` and contained no AWS resource changes. The working module and example also passed validation with their installed providers, **6.69.1** and **6.71.0**, respectively. No AWS deployment or live authentication was performed.

Sources: [v5.80.0 region schema](https://github.com/hashicorp/terraform-provider-aws/blob/v5.80.0/internal/service/meta/region_data_source.go); [v5.100.0 region schema](https://github.com/hashicorp/terraform-provider-aws/blob/v5.100.0/internal/service/meta/region_data_source.go).

### R02 — P2: Module instances share the generated Lambda ZIP

Location: `modules/mcp-http-api/main.tf:54`–`56`.

At review time, every local module instance wrote its generated code and tool manifest to `${path.module}/.build/mcp-server.zip`. Local instances share the same source directory. Terraform explicitly warns that multiple local invocations can overwrite data written under `path.module`.

**Trigger and impact:** instantiate the module twice with different names, pools, and tool manifests. Both Lambda resources reference the same ZIP path, so an archive generated for one instance can be uploaded to the other endpoint. Separating the pools avoids R03 but does not prevent this collision.

**Fix:** give each instance its own artifact path, preferably outside the module source directory. Verify that two distinct manifests produce separate archives with the expected contents, including when planning and applying a saved plan.

**Status: Fixed (2026-11-03).** ZIPs now use `${path.root}/.terraform/mcp-http-api/<name>-<source-hash>.zip`. The hash covers the exact `tools.json`, `index.mjs`, and `runtime.mjs` contents used by the archive provider. Instance names separate otherwise identical packages; changed manifests or code produce new paths, preserving packages referenced by earlier saved plans. Lambda `filename` and `source_code_hash` still come from the same archive data source. The generated directory is covered by the existing `.terraform/` ignore rule.

**Regression verification:** `node --test modules/mcp-http-api/tests/package-isolation.test.mjs` first failed on the original configuration because both instances recorded `mcp-http-api/.build/mcp-server.zip`. After the fix, it passed with two instances sharing one copied source directory and using distinct names, pools, and manifests. The test inspects actual ZIP entries, both manifests, both JavaScript files, and the SHA-256 hashes recorded in the plan. It generates an intervening plan with changed manifests, checks that the original ZIPs remain intact, applies the original saved plan, and verifies the original archive references and bytes again. Changes to each JavaScript file also produce new package paths. The fixture targets only real archive data sources and asserts that saved plans contain no AWS resource changes; it performs no AWS deployment. Generated ZIPs must accompany saved plans when moving between workspaces, as documented in the module README.

Source: [Terraform references and filesystem paths](https://developer.hashicorp.com/terraform/language/expressions/references#filesystem-and-workspace-info).

### R03 — P2: Resource-server identifiers collide in a shared pool

Locations: `modules/mcp-http-api/variables.tf:87`–`88`; `modules/mcp-http-api/main.tf:5`–`8`.

At review time, the resource-server identifier was always `mcp`. AWS requires a "unique resource server identifier" in a user pool. Changing `name` or `scope_name` did not change that identifier.

**Trigger and impact:** deploy two instances into one existing pool, or use a pool where the sibling `mcp-gateway` module already owns `mcp`. The additional create fails or introduces conflicting Terraform ownership.

**Fix:** allow a configurable identifier, support an existing resource server, or centralize shared ownership. Document any intentional one-owner restriction.

**Status: Fixed (2026-11-03).** The module now accepts `resource_server_identifier`, defaulting to `mcp` to preserve existing deployments. The resource server and fully qualified scope use that input, and `mcp_resource_server_identifier` exposes the managed identifier. Input validation matches Cognito's documented 1–256 character limit and character pattern, including URL identifiers. The README documents one owner per pool/identifier pair, distinct identifiers for shared pools and coexistence with `mcp-gateway`, and the replacement and token-scope implications of changing a deployed identifier. This module continues to create its own resource server; it does not adopt another owner's existing resource server.

**Regression verification:** the new Terraform suite first reproduced the hard-coded identifier: a configured URL identifier still yielded `mcp` and `mcp/bookings.read`. After the repair, all **8 scenarios passed**. They cover default compatibility, a custom identifier and scope propagated to the app client, JWT route, Lambda environment, and OAuth challenge, two module instances sharing one pool alongside a resource server representing the gateway's `mcp` ownership, and invalid empty, space-containing, quoted, backslash-containing, and overlong identifiers. The fixture asserts three distinct identifiers and separate HTTP API scopes. Both AWS and archive providers are mocked; no AWS deployment or live Cognito uniqueness check was performed. At the time of this repair, R13's separate discovery suite remained open and was not changed or rerun; its subsequent repair is recorded below.

Source: [Cognito CreateResourceServer](https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_CreateResourceServer.html).

### R04 — P2: Tool arguments are not validated against the full schema

Location: `modules/mcp-http-api/lambda/mcp-server/runtime.mjs:49`–`54`.

Validation only checks that arguments are an object and required keys are present. Types, enum values, bounds, nested schemas, and `additionalProperties` are ignored. MCP requires servers to "Validate all tool inputs."

**Observed behavior:** for an object schema requiring an integer `count`, an enum `status`, and no additional properties, `{ count: "many", status: "invalid", extra: true }` reached the injected backend and returned `isError: false`.

**Fix:** validate against the complete advertised JSON Schema before invoking the backend, and reject malformed schema definitions during configuration or initialization. Verify that invalid arguments never invoke the backend and valid arguments still preserve trusted identity.

**Status: Fixed (2026-11-03).** Ajv now compiles every advertised input schema at Lambda startup and validates tool arguments before backend invocation. JSON Schema 2020-12 is the default; explicit 2020-12 and draft-07 dialects are supported, with standard `ajv-formats` checks. Malformed definitions, unsupported dialects, unknown keywords or formats, unresolved references, and asynchronous schemas fail initialization. References resolve within each tool's own schema namespace; no remote schema loading is enabled. Invalid arguments produce `isError: true` without invoking the backend. Validation preserves supplied arguments without coercion, defaults, or property removal, and verified identity remains separate. Omitted arguments use `{}`; explicit null and other non-object values are rejected.

The validator source, pinned npm lockfile, generated bundle, and dependency license notices are checked in. Terraform packages the bundle and notices alongside the runtime, including them in the artifact hash. Consumers need no npm installation or deployment-time build. The README documents schema support and the regeneration procedure.

**Regression verification:** the new HTTP test first reproduced the review's exact invalid object reaching the backend. After repair, the combined Node suites passed **42/42 tests** on Node 22.23.4 and Node 26.13.0. New cases exercise types, enums, bounds, nested schemas, arrays, string lengths and patterns, formats, references, composition, conditional schemas, dependencies, unevaluated properties, both supported dialects, malformed-schema rejection before initialization/listing, unchanged arguments, reused schema identifiers, and trusted identity. The real ZIP isolation/saved-plan suite also passed with the validator and notices included, checking that changes to either produce new package paths. It runs the extracted runtime in a separate Node process without the development dependencies, verifies invalid arguments cannot invoke the backend, and checks valid arguments and identity reach it unchanged. Rebuilding the bundle and notices on Node 22 produced identical bytes. The module and example passed Terraform validation and formatting. No AWS deployment or live tool invocation was performed.

Source: [MCP tool security considerations](https://modelcontextprotocol.io/specification/2025-06-18/server/tools#security-considerations).

### R05 — P2: Protocol headers and negotiated versions are inconsistent

Locations: `modules/mcp-http-api/lambda/mcp-server/runtime.mjs:4`–`5`, `:87`–`91`, and `:139`–`156`.

At review time, the adapter ignored `MCP-Protocol-Version`. The advertised transport requires "400 Bad Request" for an invalid or unsupported version. Initialization also advertised support for `2025-03-26`, while every array body was rejected using the later protocol's batch-removal rule.

**Observed behavior:** an authenticated ping with `MCP-Protocol-Version: 1900-01-01` returned 200. A batch sent with `2025-03-26` returned 400 despite that version being negotiable.

**Fix:** honor the request's protocol header and the specified fallback for absent headers. Implement transport behavior for every advertised version, or stop advertising versions whose required behavior is missing.

**Status: Fixed (2026-11-03).** The endpoint now supports only `2025-06-18`, matching its single-message transport and batch rejection. Initialization echoes that version when requested and offers it as the supported alternative for other versions, including `2025-03-26`. The HTTP adapter checks protocol headers case-insensitively and returns HTTP 400 for explicitly invalid, unsupported, or ambiguous values before dispatching tools. Headerless initialization can negotiate normally. Later requests without a header use the specification's `2025-03-26` fallback, which is unsupported and returns HTTP 400; no negotiated version is retained between stateless requests. Clients must send `MCP-Protocol-Version: 2025-06-18` on subsequent MCP requests, including notifications and GET. Public OAuth metadata routes do not require the header. The module README documents this behavior, and the example smoke client sends the supported header.

**Regression verification:** the new adapter test first reproduced the reported authenticated ping returning **200 instead of 400** with `MCP-Protocol-Version: 1900-01-01`. The expanded protocol checks also failed on the original version negotiation and missing-header handling. After repair, the combined Node suites passed **47/47 tests** on Node 22.23.4 and Node 26.13.0. Cases cover unsupported and malformed headers, empty and non-string values, comma-joined and conflicting headers, case-insensitive valid headers, initialization negotiation, the post-initialization missing-header fallback, GET status handling, and rejection of batches without invoking the backend. Valid tool calls still preserve verified identity. The real ZIP isolation and saved-plan suite passed on Node 22, both Terraform configurations validated, scoped formatting passed, and the updated smoke script passed its Bash syntax check. No AWS deployment or live protocol smoke test was performed.

Sources: [2025-06-18 protocol version header](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#protocol-version-header); [2025-03-26 transport](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports#sending-messages-to-the-server).

### R06 — P2: Incoming Origin headers are not validated

Location: `modules/mcp-http-api/lambda/mcp-server/runtime.mjs:118`–`139`.

There is no Origin policy or allowlist. MCP requires servers to "validate the Origin header" on incoming connections.

**Observed behavior:** an authenticated request with `Origin: https://untrusted.invalid` returned 200. JWT authentication still applies; this reproduction did not demonstrate an authentication bypass or DNS-rebinding exploit.

**Fix:** define and enforce a policy for supplied Origin headers while accommodating native clients that omit them. Coordinate it with R07's browser-origin configuration.

**Status: Fixed (2026-11-03).** `allowed_origins` configures exact canonical HTTP(S) origins and defaults to an empty set. The Lambda validates supplied Origin headers before dispatch, rejecting untrusted, malformed, or ambiguous values with HTTP 403. Native clients may omit Origin. The same input configures API Gateway and CloudFront CORS; wildcard, path-containing, credential-bearing, opaque, and invalid-port inputs are rejected during Terraform planning.

**Regression verification:** runtime cases reject the original untrusted origin, deceptive suffixes, opaque origins, paths, credentials, combined values, and non-string values without invoking tools. Trusted origins are recognized case-insensitively by header name, and native requests still succeed. Terraform scenarios verify allowlist propagation and invalid configuration rejection. The extracted Lambda entrypoint also enforces the policy. These are local checks; no live DNS-rebinding or browser test was performed.

Source: [MCP transport security](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#security-warning).

### R07 — P2: Browser clients cannot complete CORS preflight

Locations: `modules/mcp-http-api/main.tf:24`, `:145`–`149`, and `:177`–`183`.

The app-client comment explicitly includes browser clients, but the HTTP API has no CORS configuration. A cross-origin POST with Authorization and JSON content requires preflight. Unauthenticated OPTIONS reaches the JWT-protected `ANY /mcp` route; actual responses also lack CORS headers.

**Observed behavior:** the local adapter returned 401 for a representative unauthenticated browser preflight. The Terraform route also requires JWT authentication before integration.

**Fix:** configure trusted browser origins, required methods and headers, and unauthenticated preflight handling. Expose `WWW-Authenticate` so browser clients can read OAuth discovery challenges. Keep server-side Origin validation explicit as described in R06.

**Status: Fixed (2026-11-03).** Configured browser origins enable CORS for GET, POST, and OPTIONS with `Authorization`, `Content-Type`, `MCP-Protocol-Version`, and `Accept`. Explicit public OPTIONS routes take priority over `ANY /mcp`; the Lambda can return a bodyless 204 preflight response without JWT or protocol-version headers. API Gateway and CloudFront expose `WWW-Authenticate`, including native JWT failures that bypass Lambda. Ordinary MCP routes retain JWT, scope, and resource-audience checks. Cookie credentials are not enabled.

**Regression verification:** local adapter and packaged-entrypoint tests verify public preflight and CORS on authentication challenges, and reject untrusted origins, disallowed methods, and unapproved headers. Terraform tests verify all three OPTIONS routes, shared API/CloudFront policies, and unchanged MCP authorization. Live preflight through API Gateway and CloudFront remains unverified.

Source: [API Gateway HTTP API CORS](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-cors.html).

### R08 — P2: Request IDs and initialization parameters are not validated

Location: `modules/mcp-http-api/lambda/mcp-server/runtime.mjs:80`–`95`.

MCP requests must include a "string or integer ID" and must not use null. Initialization requires a protocol version, client capabilities, and client information. The runtime checks neither those ID constraints nor the required initialization fields before dispatch.

**Observed behavior:** null, object, and fractional IDs were echoed in successful ping results. Initialization with `params: {}` also returned a successful result. The same dispatch path allows malformed-ID tool requests to invoke the backend.

**Fix:** validate the message envelope and method-specific parameters before routing. Reject malformed requests without invoking tools; retain notification behavior for valid notifications.

**Status: Fixed (2026-11-03).** Message classification validates string or safe-integer request IDs, object parameters and `_meta`, and the separation of requests, notifications, and responses. Initialization requires a nonempty protocol version, capabilities object, and complete client information; known capability fields and cancellation parameters are checked. Invalid envelopes return HTTP 400 with JSON-RPC `-32600` and a null error ID. Invalid initialization parameters return `-32602` correlated to the valid request ID. Valid notifications still receive HTTP 202 without a body.

**Regression verification:** cases cover the reported null, object, and fractional IDs, additional malformed IDs/envelopes, valid string and safe-integer IDs, missing initialization fields, invalid capability types, and valid/malformed cancellation notifications. Malformed tool requests cannot invoke the backend. The real ZIP test also checks malformed IDs through the extracted entrypoint.

Sources: [MCP request IDs](https://modelcontextprotocol.io/specification/2025-06-18/basic#requests); [MCP initialization](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle#initialization).

### R09 — P2: Incoming JSON-RPC responses receive the wrong HTTP status

Location: `modules/mcp-http-api/lambda/mcp-server/runtime.mjs:156`–`158`.

An incoming JSON-RPC response is treated as an invalid request, but the adapter returns its error with HTTP 200. Streamable HTTP requires 202 with no body when a response is accepted, or an "HTTP error status code" when it is rejected.

**Observed behavior:** a syntactically valid JSON-RPC response produced HTTP 200 with error code `-32600`.

**Fix:** classify responses explicitly and return the required HTTP status. This stateless server can reject unexpected responses without adding server-initiated messaging.

**Status: Fixed (2026-11-03).** Incoming JSON-RPC responses are classified explicitly and rejected with HTTP 400 and `-32600`. The stateless server does not initiate requests needing client replies, so it does not accept responses with HTTP 202.

**Regression verification:** incoming result and error responses, including mixed result/error envelopes, receive HTTP 400 without backend invocation. The extracted Lambda entrypoint verifies the transport status from the actual package.

Source: [MCP sending messages to the server](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#sending-messages-to-the-server).

### R10 — P2: The public Cognito client does not rotate refresh tokens

Location: `modules/mcp-http-api/main.tf:24`–`40`.

The client has no secret, issues 30-day refresh tokens, and does not enable rotation. MCP states that public clients' authorization servers "MUST rotate refresh tokens." The configured `ALLOW_REFRESH_TOKEN_AUTH` flow is incompatible with Cognito rotation.

**Impact:** a refresh token remains reusable for its lifetime, and enabling rotation alone would leave an incompatible authentication-flow configuration.

**Fix:** configure refresh-token rotation and remove `ALLOW_REFRESH_TOKEN_AUTH`. Refresh through the OAuth token endpoint or Cognito's supported replacement API. Check the provider floor required by the rotation configuration and update relevant documentation.

**Status: Fixed (2026-11-03).** The public app client enables refresh-token rotation with a five-second retry grace period and token revocation. `ALLOW_REFRESH_TOKEN_AUTH` is removed. An explicit SRP flow keeps Cognito's defaults from restoring legacy refresh authentication; direct password authentication remains test-only. Documentation describes OAuth refresh, atomic replacement of rotated refresh tokens, the original 30-day expiry window, and `GetTokensFromRefreshToken` for API integrations.

**Regression verification:** Terraform scenarios verify rotation, revocation, and authentication flows with password authentication both disabled and explicitly enabled for tests. The complete module and example validate against the real minimum AWS provider 6.0.0, which supports rotation, so the provider floor is unchanged. No live refresh token was minted or rotated.

Sources: [MCP token theft protections](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization#token-theft); [Cognito refresh token rotation](https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-using-the-refresh-token.html).

### R11 — P2: Timeout inputs can produce invalid HTTP API integrations

Locations: `modules/mcp-http-api/main.tf:173`; `modules/mcp-http-api/variables.tf:70`–`74`; `modules/mcp-http-api/README.md:63`.

The integration timeout is `(lambda_timeout_s * 1000) - 1000`, with no corresponding bounds. AWS's HTTP API maximum integration timeout is "30 seconds," not the README's claimed 29-second hard limit.

**Trigger and impact:** input 60 produces 59,000 ms and exceeds the limit; input 1 produces zero. The configuration can validate but fail when AWS creates the integration. The default integration is 28 seconds.

**Fix:** separate Lambda and integration deadlines, or constrain the coupled setting to a valid range. Budget cold starts and backend calls so the application can return before the gateway expires. Correct the documented quota.

**Status: Fixed (2026-11-03).** `lambda_timeout_s` accepts integers from 3 to 31 and defaults to 29. The integration expires one second earlier, and tool waiting ends another second earlier: defaults are 28 and 27 seconds, respectively. The tool deadline starts at API Gateway's request timestamp, accounting for authorization, cold starts, and validation. Expired requests cannot invoke the backend; stalled calls return a tool timeout result and pass an abort signal into AWS SDK `send`. Timers are cleared after completion. The README now states the actual 30-second integration quota and explains that aborting the wait cannot stop an already running backend Lambda.

**Regression verification:** Terraform cases verify the minimum and maximum budgets and reject inputs 1, 2, 32, 60, and fractional seconds. Runtime tests cover elapsed request time and a stalled backend; the real ZIP test verifies expired-deadline rejection, successful identity propagation, and the SDK abort signal through the entrypoint. These checks do not measure live cold starts or guarantee response latency through AWS.

Source: [HTTP API quotas](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-quotas.html).

### R12 — P2: Authentication documentation contradicts the strict default

Locations: `modules/mcp-http-api/README.md:21`–`34`; `modules/mcp-http-api/main.tf:157`–`164`; `modules/mcp-http-api/variables.tf:59`–`62`.

The README describes "audience (= MCP client id)" and acceptance of access tokens without `aud`. The current default instead requires the canonical MCP URL as the audience; unbound tokens require an explicit legacy option.

**Trigger and impact:** a reader follows the documented client-ID/unbound-token path and receives 401 under the example's default module configuration. The old live observation remains historically valid but no longer describes the default.

**Fix:** document the complete pre-registered authorization-code/PKCE flow, including `resource=mcp_url` in authorization and token requests. Explain the legacy option and update the supporting example's positive-login instructions and verification claims.

**Status: Fixed (2026-11-03).** The module and example guides now describe pre-registered authorization-code/PKCE login, verifier and state handling, `resource=mcp_url` in authorization and token requests, resource-bound access tokens, refresh rotation, and the explicit legacy option. Historical unbound-token observations are labeled as historical. The example exposes authorization/token endpoints and configurable callback URLs and browser origins. Its smoke client checks the resource audience and negotiated protocol version; the optional resource-bound scope-denial fixture expects HTTP 403 without depending on a challenge header that CloudFront overrides.

**Verification:** documentation matches the configured strict audience, dedicated app client, scope, Origin, protocol, and refresh policies. Both Terraform configurations validate, and the smoke script passes Bash syntax checking. The script was not executed against AWS; a complete resource-bound PKCE login remains a live interoperability check.

Sources: [MCP resource indicators](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization#resource-parameter-implementation); [Cognito authorization endpoint](https://docs.aws.amazon.com/cognito/latest/developerguide/authorization-endpoint.html).

### R13 — P2: Discovery tests fail before their assertions run

Location: `modules/mcp-http-api/tests/oauth-discovery.tftest.hcl:1`–`17`.

The mock provider supplies no valid defaults for IAM-role or CloudWatch log-group ARNs. Generated random strings fail AWS provider validation before the audience/discovery assertions can run.

**Observed behavior:** `terraform -chdir=modules/mcp-http-api test -no-color` failed at `aws_lambda_function.mcp.role` and `aws_apigatewayv2_stage.default.access_log_settings.destination_arn` with invalid-ARN errors. The first run failed and the second was skipped: **0 passed, 1 failed, 1 skipped**.

**Fix:** supply valid ARN defaults for mocked resources and rerun both discovery scenarios. Address any further validator failures revealed after those defaults are corrected.

**Status: Fixed (2026-11-03).** The discovery fixture supplies valid IAM-role, CloudWatch log-group, and API execution ARNs and mocks the archive provider. Subsequent assertion failures were corrected by comparing provider sets with `toset` and selecting the single CloudFront header item with `one` instead of indexing a set.

**Regression verification:** both discovery scenarios now pass, including strict resource binding and explicit legacy compatibility. The complete Terraform suite passes **29/29 scenarios** with both the installed AWS provider and minimum provider 6.0.0. AWS execution is mocked; these tests do not contact Cognito or deploy resources.

## Verification and limits

### R01 repair verification

| Check | Result |
|---|---|
| Complete module and supporting example validation at minimum AWS provider 6.0.0 | Both passed |
| Actual Cognito issuer evaluation with AWS provider 6.0.0 | Passed; expected issuer, no AWS resource changes |
| Working module validation with AWS provider 6.69.1 | Passed |
| Working supporting example validation with AWS provider 6.71.0 | Passed |
| Combined repository Node unit suites | 34/34 passed |
| Module and supporting example Terraform formatting | Passed |
| Repository-wide Terraform formatting | Flags existing `examples/customer-assistant/variables.tf` and `modules/mcp-gateway/variables.tf`; left unchanged |

Minimum-version checks used temporary copies with a provider-version override and a local provider mirror, leaving the working configurations' selected provider versions intact. Terraform 1.17.1 and archive provider 2.8.1 were used. These checks exercise the real provider schema and issuer expression; they do not establish live OAuth interoperability.

### R02 repair verification

| Check | Result |
|---|---|
| Real archive isolation, ZIP contents/hashes, and saved-plan apply | 1/1 passed; original configuration failed the distinct-path assertion |
| Combined repository Node unit suites | 34/34 passed |
| Module and supporting example Terraform formatting | Passed |
| Module Terraform validation | Passed with AWS provider 6.69.1 |
| Supporting example Terraform validation | Passed with AWS provider 6.69.1 |
| Repository-wide Terraform formatting | Flags unrelated `examples/customer-assistant/variables.tf` and `modules/mcp-gateway/variables.tf`; left unchanged |

The packaging test uses the real archive provider 2.8.1 and Terraform 1.17.1 with Node 26.13.0. Saved-plan apply is verified locally against archive data sources, without deploying AWS resources. Discovery tests and live OAuth interoperability were not rerun for R02. Later local discovery results are recorded below; live interoperability remains unverified.

### R03 repair verification

| Check | Result |
|---|---|
| Resource-server Terraform regression suite | 8/8 passed with mocked AWS and archive providers |
| Combined repository Node unit suites | 34/34 passed |
| Module and supporting example Terraform formatting | Passed |
| Module Terraform validation | Passed with AWS provider 6.69.1 |
| Supporting example Terraform validation | Passed with AWS provider 6.71.0 |

The regression suite runs with `terraform -chdir=modules/mcp-http-api test -filter=tests/resource-server.tftest.hcl -no-color` after `terraform init -backend=false`. Verification used Terraform 1.17.1 and Node 26.13.0. The shared-pool fixture uses the real module twice with mocked providers; these checks establish the configured identifiers and scope wiring, without contacting Cognito or deploying resources. No live OAuth login was performed. Keeping the default identifier preserves existing resource-server identity; overriding a deployed identifier requires replacement and new token scopes.

### R04 repair verification

| Check | Result |
|---|---|
| Combined repository Node unit suites, including schema regressions | 42/42 passed; original code failed the invalid-arguments backend assertion |
| Real archive isolation, all source contents/hashes, extracted runtime, and saved-plan apply | 1/1 passed on Node 22, including validator bundle and notices |
| Validator bundle and license notice rebuild on Node 22 | Identical bytes |
| Module and supporting example Terraform formatting | Passed |
| Module Terraform validation | Passed with AWS provider 6.69.1 |
| Supporting example Terraform validation | Passed with AWS provider 6.71.0 |

Verification used Node 22.23.4, Node 26.13.0, and Terraform 1.17.1. The generated bundle targets Node 22. Runtime dependencies are pinned to Ajv 8.20.0 and ajv-formats 3.0.1, bundled with esbuild 0.28.2. All checks ran locally without AWS deployment or live OAuth login. At the time of the R04 repair, R05–R13 remained open; their subsequent repairs are recorded below. The separate discovery suite was not rerun for R04.

### R05 repair verification

| Check | Result |
|---|---|
| Combined repository Node unit suites, including protocol regressions | 47/47 passed on Node 22 and Node 26; original adapter returned 200 for the unsupported-header reproduction |
| Real archive isolation, ZIP contents/hashes, extracted runtime, and saved-plan apply | 1/1 passed on Node 22 |
| Example smoke script Bash syntax | Passed |
| Module and supporting example Terraform formatting | Passed |
| Module Terraform validation | Passed |
| Supporting example Terraform validation | Passed |
| Repository-wide Terraform formatting | Flags existing `examples/customer-assistant/variables.tf` and `modules/mcp-gateway/variables.tf`; left unchanged |

Verification used Node 22.23.4, Node 26.13.0, and Terraform 1.17.1. The smoke script was checked with `bash -n examples/mcp-http-api/scripts/smoke.sh`; it was not run against deployed resources. The archive regression uses local data-source plans and saved-plan apply, without AWS deployment. At the time of the R05 repair, R06–R13 remained open and the separate discovery suite was not rerun; their subsequent repairs are recorded above.

### R06–R13 repair verification

| Check | Result |
|---|---|
| Combined repository Node unit suites, including Origin, envelope, response, and deadline regressions | 57/57 passed on Node 22.23.4 and Node 26.13.0 |
| Complete module Terraform test suite with installed AWS provider 6.69.1 | 29/29 passed, including both discovery scenarios |
| Complete module Terraform test suite with minimum AWS provider 6.0.0 | 29/29 passed |
| Complete module and supporting example validation at minimum AWS provider 6.0.0 | Both passed |
| Working module and supporting example validation | Both passed with AWS providers 6.69.1 and 6.71.0, respectively |
| Real archive isolation, ZIP contents/hashes, extracted runtime and entrypoint, and saved-plan apply | 1/1 passed on Node 22 |
| Module and supporting example Terraform formatting | Passed |
| Example smoke script Bash syntax | Passed |
| Working-tree whitespace check | Passed |
| Repository-wide Terraform formatting | Flags existing `examples/customer-assistant/variables.tf` and `modules/mcp-gateway/variables.tf`; left unchanged |

Verification used Terraform 1.17.1 and archive provider 2.8.1. Minimum-provider checks used temporary copies of the complete module and example and a local provider mirror; the AWS 6.0.0 ZIP matched HashiCorp's published SHA-256 checksum. Terraform scenarios mock AWS and archive execution. The separate packaging regression uses real archive data sources and saved-plan apply, then runs the extracted Lambda with a local SDK stub to verify Origin/preflight behavior, malformed IDs, response status, schema rejection, expired deadlines, trusted identity, and SDK abort signals.

All checks were local. No AWS deployment, live OAuth login, browser preflight through AWS, refresh-token minting/rotation, or live smoke execution was performed. Aborting an SDK request does not cancel a backend Lambda that is already running. Local regression results establish the repairs in code and configuration; complete resource-bound OAuth and browser interoperability still require verification after deployment.

### Original review verification

| Check | Result |
|---|---|
| Combined repository Node unit suites | 34/34 passed |
| Module and supporting example Terraform formatting | Passed |
| Module Terraform validation | Passed with AWS provider 6.69.1 |
| Supporting example Terraform validation | Passed with AWS provider 6.69.1 |
| Module discovery Terraform tests | 0 passed, 1 failed, 1 skipped; see R13 |
| Local runtime probes | Confirmed R04–R09 behavior |

Commands used:

```bash
node --test modules/mcp-gateway/lambda/interceptor/index.test.js modules/mcp-http-api/lambda/mcp-server/runtime.test.mjs
terraform fmt -check -recursive modules/mcp-http-api examples/mcp-http-api
terraform -chdir=modules/mcp-http-api validate -no-color
terraform -chdir=examples/mcp-http-api validate -no-color
terraform -chdir=modules/mcp-http-api test -no-color
```

At original review time, available tools were Node 26.13.0 and Terraform 1.17.1; archive provider 2.8.1 was installed. Node 22 was not independently tested during that review. No AWS deployment, state refresh, live token minting, or full OAuth login was performed.

During the original review, provider-v5 incompatibility and module ZIP collisions were established from configuration and official source/documentation; a v5 binary and a two-instance AWS deployment were not used. R02 now also has real ZIP regression verification as described above. Origin acceptance does not establish an authentication bypass.

Cognito discovery and the complete public authorization-code/PKCE flow still require live interoperability verification. The current public metadata routes, CloudFront authentication challenge, and resource-audience checks address the older review's absent-discovery and audience-configuration findings in code; this does not prove a positive end-to-end login. The saved-plan ignore rule is also present in the current working tree. Do not treat the older report's P1 findings as unchanged current findings without checking the implementation.

Standards: **0 findings**. Spec: **13 P2 findings identified; all 13 fixed, zero open**.
