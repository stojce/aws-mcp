# Full review: mcp-http-api — 2026-11-03

Scope: all current code in `modules/mcp-http-api/`, including Terraform, the Lambda runtime, and tests. `examples/mcp-http-api/` was used as supporting context. This is a working-tree review, not a diff review; the module and example were untracked at review time.

The review identified **0 Standards findings and 13 Spec findings, all P2**. No P1 findings were identified in this snapshot. Finding numbers such as R01 are identifiers, not priority ratings. The highest repair priority was the shared Lambda ZIP path across module instances. **R02 is now fixed; the other 12 findings remain open.**

No implementation files were changed during the original review. This report was updated after the R02 repair on 2026-11-03; see its status and verification below.

## Findings index

| ID | Priority | Issue | Status |
|---|---|---|---|
| R01 | P2 | Advertised AWS provider v5 support is incompatible | Open |
| R02 | P2 | Module instances share the generated Lambda ZIP | Fixed |
| R03 | P2 | Resource-server identifiers collide in a shared pool | Open |
| R04 | P2 | Tool arguments are not validated against the full schema | Open |
| R05 | P2 | Protocol headers and negotiated versions are inconsistent | Open |
| R06 | P2 | Incoming Origin headers are not validated | Open |
| R07 | P2 | Browser clients cannot complete CORS preflight | Open |
| R08 | P2 | Request IDs and initialization parameters are not validated | Open |
| R09 | P2 | Incoming JSON-RPC responses receive the wrong HTTP status | Open |
| R10 | P2 | The public Cognito client does not rotate refresh tokens | Open |
| R11 | P2 | Timeout inputs can produce invalid HTTP API integrations | Open |
| R12 | P2 | Authentication documentation contradicts the strict default | Open |
| R13 | P2 | Discovery tests fail before their assertions run | Open |

## Implementation priority

The user clarified that "P1" means the highest-priority findings to repair first. Start with **R02, the shared Lambda ZIP path**, because it can deploy the wrong tool manifest to an endpoint. The original review's severity ratings remain P2; R01 is a finding number, not the requested priority.

R02's repair gives separate module instances their own generated packages and verifies the actual ZIP contents for two different tool manifests. Verified identity and unrelated working-tree edits are preserved. Its status and verification results are recorded below.

## Standards

**0 findings.** The current module follows the consequential requirements in [AGENTS.md](../AGENTS.md): trusted identity is kept separate from client arguments, authorization denies invalid identities, password authentication defaults to disabled, and the Lambda uses Node.js 22 and ES modules. No substantial baseline code smells were identified. Mechanical formatting was checked separately.

The API Gateway HTTP API implementation is an intentional alternative to the original AgentCore design. Architecture-specific interceptor requirements from the original Gateway spec were not applied to this module.

## Spec

### R01 — P2: Advertised AWS provider v5 support is incompatible

Locations: `modules/mcp-http-api/variables.tf:91`; `modules/mcp-http-api/versions.tf:7`.

The module permits `hashicorp/aws >= 5.80, < 7.0.0` but constructs its Cognito issuer with `data.aws_region.current.region`. Official provider source for v5.80.0 and v5.100.0 exposes `name`, `id`, `description`, and `endpoint`, without `region`.

**Trigger and impact:** a consumer retaining a permitted v5 provider cannot validate the module because the referenced attribute does not exist. Passing validation with installed provider v6.69.1 does not establish v5 compatibility.

**Fix:** use a region attribute supported by the advertised range, or raise the provider floor and align the example's constraint. Verify the resulting minimum supported version as well as the installed version.

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

The resource-server identifier is always `mcp`. AWS requires a "unique resource server identifier" in a user pool. Changing `name` or `scope_name` does not change that identifier.

**Trigger and impact:** deploy two instances into one existing pool, or use a pool where the sibling `mcp-gateway` module already owns `mcp`. The additional create fails or introduces conflicting Terraform ownership.

**Fix:** allow a configurable identifier, support an existing resource server, or centralize shared ownership. Document any intentional one-owner restriction.

Source: [Cognito CreateResourceServer](https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_CreateResourceServer.html).

### R04 — P2: Tool arguments are not validated against the full schema

Location: `modules/mcp-http-api/lambda/mcp-server/runtime.mjs:49`–`54`.

Validation only checks that arguments are an object and required keys are present. Types, enum values, bounds, nested schemas, and `additionalProperties` are ignored. MCP requires servers to "Validate all tool inputs."

**Observed behavior:** for an object schema requiring an integer `count`, an enum `status`, and no additional properties, `{ count: "many", status: "invalid", extra: true }` reached the injected backend and returned `isError: false`.

**Fix:** validate against the complete advertised JSON Schema before invoking the backend, and reject malformed schema definitions during configuration or initialization. Verify that invalid arguments never invoke the backend and valid arguments still preserve trusted identity.

Source: [MCP tool security considerations](https://modelcontextprotocol.io/specification/2025-06-18/server/tools#security-considerations).

### R05 — P2: Protocol headers and negotiated versions are inconsistent

Locations: `modules/mcp-http-api/lambda/mcp-server/runtime.mjs:4`–`5`, `:87`–`91`, and `:139`–`156`.

The adapter ignores `MCP-Protocol-Version`. The advertised transport requires "400 Bad Request" for an invalid or unsupported version. Initialization also advertises support for `2025-03-26`, while every array body is rejected using the later protocol's batch-removal rule.

**Observed behavior:** an authenticated ping with `MCP-Protocol-Version: 1900-01-01` returned 200. A batch sent with `2025-03-26` returned 400 despite that version being negotiable.

**Fix:** honor the request's protocol header and the specified fallback for absent headers. Implement transport behavior for every advertised version, or stop advertising versions whose required behavior is missing.

Sources: [2025-06-18 protocol version header](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#protocol-version-header); [2025-03-26 transport](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports#sending-messages-to-the-server).

### R06 — P2: Incoming Origin headers are not validated

Location: `modules/mcp-http-api/lambda/mcp-server/runtime.mjs:118`–`139`.

There is no Origin policy or allowlist. MCP requires servers to "validate the Origin header" on incoming connections.

**Observed behavior:** an authenticated request with `Origin: https://untrusted.invalid` returned 200. JWT authentication still applies; this reproduction did not demonstrate an authentication bypass or DNS-rebinding exploit.

**Fix:** define and enforce a policy for supplied Origin headers while accommodating native clients that omit them. Coordinate it with R07's browser-origin configuration.

Source: [MCP transport security](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#security-warning).

### R07 — P2: Browser clients cannot complete CORS preflight

Locations: `modules/mcp-http-api/main.tf:24`, `:145`–`149`, and `:177`–`183`.

The app-client comment explicitly includes browser clients, but the HTTP API has no CORS configuration. A cross-origin POST with Authorization and JSON content requires preflight. Unauthenticated OPTIONS reaches the JWT-protected `ANY /mcp` route; actual responses also lack CORS headers.

**Observed behavior:** the local adapter returned 401 for a representative unauthenticated browser preflight. The Terraform route also requires JWT authentication before integration.

**Fix:** configure trusted browser origins, required methods and headers, and unauthenticated preflight handling. Expose `WWW-Authenticate` so browser clients can read OAuth discovery challenges. Keep server-side Origin validation explicit as described in R06.

Source: [API Gateway HTTP API CORS](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-cors.html).

### R08 — P2: Request IDs and initialization parameters are not validated

Location: `modules/mcp-http-api/lambda/mcp-server/runtime.mjs:80`–`95`.

MCP requests must include a "string or integer ID" and must not use null. Initialization requires a protocol version, client capabilities, and client information. The runtime checks neither those ID constraints nor the required initialization fields before dispatch.

**Observed behavior:** null, object, and fractional IDs were echoed in successful ping results. Initialization with `params: {}` also returned a successful result. The same dispatch path allows malformed-ID tool requests to invoke the backend.

**Fix:** validate the message envelope and method-specific parameters before routing. Reject malformed requests without invoking tools; retain notification behavior for valid notifications.

Sources: [MCP request IDs](https://modelcontextprotocol.io/specification/2025-06-18/basic#requests); [MCP initialization](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle#initialization).

### R09 — P2: Incoming JSON-RPC responses receive the wrong HTTP status

Location: `modules/mcp-http-api/lambda/mcp-server/runtime.mjs:156`–`158`.

An incoming JSON-RPC response is treated as an invalid request, but the adapter returns its error with HTTP 200. Streamable HTTP requires 202 with no body when a response is accepted, or an "HTTP error status code" when it is rejected.

**Observed behavior:** a syntactically valid JSON-RPC response produced HTTP 200 with error code `-32600`.

**Fix:** classify responses explicitly and return the required HTTP status. This stateless server can reject unexpected responses without adding server-initiated messaging.

Source: [MCP sending messages to the server](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#sending-messages-to-the-server).

### R10 — P2: The public Cognito client does not rotate refresh tokens

Location: `modules/mcp-http-api/main.tf:24`–`40`.

The client has no secret, issues 30-day refresh tokens, and does not enable rotation. MCP states that public clients' authorization servers "MUST rotate refresh tokens." The configured `ALLOW_REFRESH_TOKEN_AUTH` flow is incompatible with Cognito rotation.

**Impact:** a refresh token remains reusable for its lifetime, and enabling rotation alone would leave an incompatible authentication-flow configuration.

**Fix:** configure refresh-token rotation and remove `ALLOW_REFRESH_TOKEN_AUTH`. Refresh through the OAuth token endpoint or Cognito's supported replacement API. Check the provider floor required by the rotation configuration and update relevant documentation.

Sources: [MCP token theft protections](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization#token-theft); [Cognito refresh token rotation](https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-using-the-refresh-token.html).

### R11 — P2: Timeout inputs can produce invalid HTTP API integrations

Locations: `modules/mcp-http-api/main.tf:173`; `modules/mcp-http-api/variables.tf:70`–`74`; `modules/mcp-http-api/README.md:63`.

The integration timeout is `(lambda_timeout_s * 1000) - 1000`, with no corresponding bounds. AWS's HTTP API maximum integration timeout is "30 seconds," not the README's claimed 29-second hard limit.

**Trigger and impact:** input 60 produces 59,000 ms and exceeds the limit; input 1 produces zero. The configuration can validate but fail when AWS creates the integration. The default integration is 28 seconds.

**Fix:** separate Lambda and integration deadlines, or constrain the coupled setting to a valid range. Budget cold starts and backend calls so the application can return before the gateway expires. Correct the documented quota.

Source: [HTTP API quotas](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-quotas.html).

### R12 — P2: Authentication documentation contradicts the strict default

Locations: `modules/mcp-http-api/README.md:21`–`34`; `modules/mcp-http-api/main.tf:157`–`164`; `modules/mcp-http-api/variables.tf:59`–`62`.

The README describes "audience (= MCP client id)" and acceptance of access tokens without `aud`. The current default instead requires the canonical MCP URL as the audience; unbound tokens require an explicit legacy option.

**Trigger and impact:** a reader follows the documented client-ID/unbound-token path and receives 401 under the example's default module configuration. The old live observation remains historically valid but no longer describes the default.

**Fix:** document the complete pre-registered authorization-code/PKCE flow, including `resource=mcp_url` in authorization and token requests. Explain the legacy option and update the supporting example's positive-login instructions and verification claims.

Sources: [MCP resource indicators](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization#resource-parameter-implementation); [Cognito authorization endpoint](https://docs.aws.amazon.com/cognito/latest/developerguide/authorization-endpoint.html).

### R13 — P2: Discovery tests fail before their assertions run

Location: `modules/mcp-http-api/tests/oauth-discovery.tftest.hcl:1`–`17`.

The mock provider supplies no valid defaults for IAM-role or CloudWatch log-group ARNs. Generated random strings fail AWS provider validation before the audience/discovery assertions can run.

**Observed behavior:** `terraform -chdir=modules/mcp-http-api test -no-color` failed at `aws_lambda_function.mcp.role` and `aws_apigatewayv2_stage.default.access_log_settings.destination_arn` with invalid-ARN errors. The first run failed and the second was skipped: **0 passed, 1 failed, 1 skipped**.

**Fix:** supply valid ARN defaults for mocked resources and rerun both discovery scenarios. Address any further validator failures revealed after those defaults are corrected.

## Verification and limits

### R02 repair verification

| Check | Result |
|---|---|
| Real archive isolation, ZIP contents/hashes, and saved-plan apply | 1/1 passed; original configuration failed the distinct-path assertion |
| Combined repository Node unit suites | 34/34 passed |
| Module and supporting example Terraform formatting | Passed |
| Module Terraform validation | Passed with AWS provider 6.69.1 |
| Supporting example Terraform validation | Passed with AWS provider 6.69.1 |
| Repository-wide Terraform formatting | Flags unrelated `examples/customer-assistant/variables.tf` and `modules/mcp-gateway/variables.tf`; left unchanged |

The packaging test uses the real archive provider 2.8.1 and Terraform 1.17.1 with Node 26.13.0. Saved-plan apply is verified locally against archive data sources, without deploying AWS resources. Discovery tests and live OAuth interoperability were not rerun for R02; their original limitations below remain applicable.

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

Available tools were Node 26.13.0 and Terraform 1.17.1; archive provider 2.8.1 was installed. Node 22 was not independently tested. No AWS deployment, state refresh, live token minting, or full OAuth login was performed.

During the original review, provider-v5 incompatibility and module ZIP collisions were established from configuration and official source/documentation; a v5 binary and a two-instance AWS deployment were not used. R02 now also has real ZIP regression verification as described above. Origin acceptance does not establish an authentication bypass.

Cognito discovery and the complete public authorization-code/PKCE flow still require live interoperability verification. The current public metadata routes, CloudFront authentication challenge, and resource-audience checks address the older review's absent-discovery and audience-configuration findings in code; this does not prove a positive end-to-end login. The saved-plan ignore rule is also present in the current working tree. Do not treat the older report's P1 findings as unchanged current findings without checking the implementation.

Standards: **0 findings**. Spec: **13 P2 findings identified; R02 fixed, 12 still open**.
