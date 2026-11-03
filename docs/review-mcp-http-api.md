# Full review: mcp-http-api

Reviewed: 2026-11-02. Scope: the complete current `modules/mcp-http-api/` implementation, with `examples/mcp-http-api/` as supporting deployment and verification code. These directories are currently untracked, so this is a snapshot review rather than a historical diff. Existing edits elsewhere were left untouched.

Companion research: [AWS documentation evidence](../.scratch/mcp-on-aws/mcp-http-api-aws-documentation-review.md).

The architecture is suitable for short, authenticated, stateless tool calls, but the implementation needs work before it can be presented as an interoperable OAuth MCP endpoint. A preconfigured client using an unbound Cognito access token can use the intended authentication path. Standard OAuth discovery is absent, and resource-bound access tokens produced by current Cognito features are rejected. Passing unit tests and Terraform validation do not cover these problems.

Priorities: P1 should be addressed before release or adding the affected artifacts to a commit; P2 is a concrete correctness, compatibility, or verification defect. Optional operational improvements are listed separately.

## Standards axis

### S1 — P1: The example's saved plan is eligible for committing

Location: `examples/mcp-http-api/.gitignore:1` and the currently untracked `examples/mcp-http-api/tfplan`.

`git status --short --untracked-files=all` lists `tfplan`, and `git check-ignore examples/mcp-http-api/tfplan` does not match a rule. Its archive includes Terraform state snapshots. Adding the example directory would therefore add a saved plan containing state. `AGENTS.md` explicitly requires keeping credentials, Terraform state, and saved plans out of commits. Ignore saved-plan artifacts and exclude this file before committing. No disclosure in an existing commit was established.

No additional consequential documented naming or indentation violations were found. Mechanical formatting results are recorded under validation. Maintainability heuristics did not reveal another substantial finding.

## Spec and AWS behavior axis

### A1 — P1: Standard MCP OAuth discovery cannot start

Locations: `modules/mcp-http-api/main.tf:172`; `modules/mcp-http-api/lambda/mcp-server/runtime.mjs:111`.

The only API route is JWT-protected `ANY /mcp`. There is no public protected-resource metadata endpoint, and the runtime's `WWW-Authenticate` challenge contains no `resource_metadata` URL. Missing or invalid tokens are rejected by API Gateway before this runtime can generate a challenge, so changing the Lambda's challenge alone will not repair the unauthenticated path.

MCP 2025-06-18's standard authorization flow requires protected-resource metadata identifying the authorization server, with metadata discovery from the 401 challenge. A client given only `mcp_url` cannot discover Cognito and initiate this flow. Provide public metadata and ensure the actual edge 401 path supports discovery. Document pre-registration of the dedicated client and callback URLs; dynamic client registration is not mandatory.

This is an interoperability gap, not an authentication bypass. MCP permits custom authentication strategies, so a deliberately preconfigured bearer-token integration can still work. Sources: [MCP authorization](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization), [MCP base protocol](https://modelcontextprotocol.io/specification/2025-06-18/basic).

### A2 — P1: Cognito resource-bound tokens fail the JWT authorizer

Locations: `modules/mcp-http-api/main.tf:153`; `modules/mcp-http-api/README.md:33`.

The authorizer accepts only the app client ID as its configured audience. Current Cognito authorization supports `resource=<canonical MCP URL>` and sets that resource URL in the access token's `aud` claim. AWS explicitly states that its HTTP API JWT authorizer checks `client_id` only when `aud` is absent; when both are present, it evaluates `aud`.

Consequently, a token with the correct `client_id`, user `sub`, and `mcp/read` scope is rejected when `aud` is the MCP URL. Standard MCP clients must send the resource indicator, making this a practical incompatibility with the current authorization flow. Configure the canonical resource audience and continue checking `client_id` and `token_use` in the runtime. Decide explicitly whether legacy tokens without resource binding remain supported, and test both paths. The existing observation about tokens without `aud` is valid but incomplete.

Sources: [AWS JWT authorizer claim precedence](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-jwt-authorizer.html), [Cognito authorization endpoint and resource binding](https://docs.aws.amazon.com/cognito/latest/developerguide/authorization-endpoint.html), [MCP resource indicators](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization#resource-parameter-implementation). This finding follows directly from fetched documentation and configuration; a fresh live resource-bound token was not minted during this review.

### A3 — P2: Tool input schemas are advertised but largely ignored

Location: `modules/mcp-http-api/lambda/mcp-server/runtime.mjs:41`.

Validation checks only whether arguments are an object and required keys exist. Types, enums, nested schemas, bounds, and `additionalProperties` are ignored. With a schema requiring a string enum, `{status: 42, extra: true}` reached the injected backend and returned `isError: false` in a local reproduction. The example's `status` enum is likewise unenforced.

Validate arguments against the complete advertised JSON Schema before invoking the backend, and reject malformed schema definitions during configuration or initialization. MCP explicitly requires validating all tool inputs. Source: [MCP tools security considerations](https://modelcontextprotocol.io/specification/2025-06-18/server/tools#security-considerations).

### A4 — P2: Protocol-version handling contradicts negotiated capabilities

Locations: `modules/mcp-http-api/lambda/mcp-server/runtime.mjs:4`, `:110`, `:134`.

The HTTP adapter ignores `MCP-Protocol-Version`. An authenticated `ping` with an unsupported header returned 200 locally; the advertised 2025-06-18 transport requires 400 for invalid or unsupported versions. Also, initialization can negotiate 2025-03-26, whose transport permits batched messages, while every array body is rejected using the later version's batch-removal rule.

Use the request header to select supported transport behavior, including the documented fallback for absent headers. Either implement 2025-03-26 batches or stop advertising that version. Advertising an older supported version is itself acceptable; upgrading the version string alone would not solve these defects.

Sources: [2025-06-18 transport](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#protocol-version-header), [2025-03-26 transport](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports#sending-messages-to-the-server).

### A5 — P2: Required Origin validation is absent

Location: `modules/mcp-http-api/lambda/mcp-server/runtime.mjs:110`.

No origin allowlist or origin policy exists. An authenticated request with `Origin: https://untrusted.invalid` returned 200 locally. Both advertised MCP transports require validation of incoming Origin headers. Add an explicit policy for requests that supply an Origin, while accommodating native clients that omit it. JWT checks still protect the public endpoint; this review did not demonstrate a DNS-rebinding exploit or authentication bypass. Source: [MCP transport security](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#security-warning).

### A6 — P2: Malformed MCP requests produce successful responses

Locations: `modules/mcp-http-api/lambda/mcp-server/runtime.mjs:72`, `:79`.

The runtime accepts object and null request IDs and echoes them in successful results. MCP requires a string or integer ID and explicitly forbids null. Initialization with empty params also succeeds despite lacking protocol version, client capabilities, and client information. Validate message envelopes and method-specific parameter shapes before dispatch. Local reproductions returned 200 results for these malformed inputs.

Sources: [MCP request IDs](https://modelcontextprotocol.io/specification/2025-06-18/basic#requests), [MCP initialization](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle#initialization).

### A7 — P2: The advertised AWS provider v5 range is incompatible

Locations: `modules/mcp-http-api/main.tf:154`; `modules/mcp-http-api/versions.tf:7`; `examples/mcp-http-api/main.tf:6`.

The module reads `data.aws_region.current.region`, but permits AWS provider versions starting at 5.80. Official provider source for both v5.80.0 and v5.100.0 exposes `name`, `id`, `description`, and `endpoint`, without `region`. A caller retaining provider v5 cannot resolve this expression. Raise the provider floor to v6 or use a compatible region attribute. Validation against installed provider v6.69.1 does not establish v5 compatibility.

Sources: [v5.80.0 schema](https://github.com/hashicorp/terraform-provider-aws/blob/v5.80.0/internal/service/meta/region_data_source.go), [v5.100.0 schema](https://github.com/hashicorp/terraform-provider-aws/blob/v5.100.0/internal/service/meta/region_data_source.go). The schema mismatch was verified from source; a v5 binary was not installed for a separate CLI reproduction.

### A8 — P2: Browser clients cannot complete CORS preflight

Locations: `modules/mcp-http-api/main.tf:141`, `:172`.

The app-client comment explicitly includes browser clients, but the HTTP API has no CORS configuration. A cross-origin POST carrying Authorization and application/json requires preflight. OPTIONS reaches the protected ANY route without a bearer token and is rejected; actual responses also lack CORS headers.

Expose trusted browser origins and required headers/methods, and ensure preflight succeeds without authentication. Keep the runtime's Origin validation as a separate explicit policy. Source: [AWS HTTP API CORS](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-cors.html).

### A9 — P2: Timeout configuration permits invalid integrations

Locations: `modules/mcp-http-api/main.tf:168`; `modules/mcp-http-api/variables.tf:64`; `modules/mcp-http-api/README.md:63`.

The integration timeout is `(lambda_timeout_s * 1000) - 1000`, with no validation. Setting the variable to 60, which its description does not forbid, computes 59,000 ms and exceeds the HTTP API maximum. Setting it to 1 computes zero. The default creates a 28-second integration, and the README incorrectly describes an AWS 29-second hard limit.

HTTP APIs have a non-increasable 30-second maximum. Separate or constrain the integration timeout, budget backend/network/cold-start time, and arrange for an application deadline to return a controlled error before the gateway expires. Source: [HTTP API quotas](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-quotas.html).

### A10 — P2: Resource-server ownership prevents reuse with an existing mcp scope

Locations: `modules/mcp-http-api/variables.tf:81`; `modules/mcp-http-api/main.tf:5`.

Every module instance creates the resource-server identifier `mcp` in the input pool. Cognito identifiers must be unique. The sibling `mcp-gateway` module also manages this identifier. Using this alternative against a pool that already has an `mcp` resource server, or deploying two instances in one pool, creates an ownership/collision problem; changing `name` or `scope_name` does not change the identifier.

Support using an existing resource server, centralize shared ownership, or expose an instance-specific identifier. Document the one-owner constraint if intentional. Source: [Cognito CreateResourceServer](https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_CreateResourceServer.html).

## Supporting example findings

These affect demonstration and verification code rather than the module's generic backend contract.

### E1 — P2: The ownership smoke assertion cannot detect another user's rows

Locations: `examples/mcp-http-api/scripts/smoke.sh:183`, `:194`; `examples/mcp-http-api/lambda/tool-backend/index.mjs:23`.

The smoke script checks that `owner` equals token `sub` and that booking keys begin with `BOOKING#`. The backend copies `owner` from the request identity and removes the owner-bearing `pk` from returned rows. A regression that queries another user's partition while retaining the caller's owner field would pass both checks. Compare returned booking IDs against distinct per-user fixtures and assert absence of the other user's IDs for both Alice and Bob.

### E2 — P2: DynamoDB results silently truncate

Location: `examples/mcp-http-api/lambda/tool-backend/index.mjs:21`.

The backend runs one Query and drops `LastEvaluatedKey`. DynamoDB paginates queries at up to 1 MB; filtering can yield an empty first page even when matching rows remain. The tool then presents an incomplete list as the result. Iterate pages within an explicit response/time budget or return a pagination cursor. Sources: [DynamoDB Query pagination](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Query.Pagination.html), [Query filtering](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Query.FilterExpression.html).

### E3 — P2: Password setup ignores the configurable users and region

Location: `examples/mcp-http-api/scripts/set-test-passwords.sh:9`, `:26`.

The deployment accepts `var.region` and `var.test_users`, but its documented setup script defaults to eu-west-1 and hardcodes Alice/Bob email addresses. Changing those inputs produces a deployment whose setup command targets the wrong region or users unless manually overridden or edited. Resolve the deployed region and usernames from outputs.

## Current AWS features and operational considerations

- **Streaming:** HTTP API still does not support response streaming. Current API Gateway REST API does support streaming; that is a possible alternate architecture for SSE or longer calls, with a different authentication/integration design. The current single-JSON response and authenticated GET 405 are valid for the intended stateless transport. Do not replace HTTP API just to use an optional feature. [AWS response transfer mode](https://docs.aws.amazon.com/apigateway/latest/developerguide/response-transfer-mode.html).
- **Payloads:** HTTP API's 10 MB payload quota does not remove synchronous Lambda's 6 MB request/response limit. This implementation invokes two Lambdas synchronously and adds event and JSON/text envelopes. Bound tool arguments and results using the effective Lambda limits; large outputs may need pagination or references. [HTTP API quotas](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-quotas.html), [Lambda quotas](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html).
- **Refresh tokens:** Cognito supports refresh-token rotation, but it is absent here. AWS makes rotation optional and recommends it; standard MCP OAuth authorization requires it for public clients. Enable it when implementing that flow and remove incompatible `ALLOW_REFRESH_TOKEN_AUTH`, using the OAuth refresh grant or supported replacement API. [Cognito refresh tokens](https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-using-the-refresh-token.html).
- **Revocation:** JWT signature/time validation does not provide immediate Cognito revocation enforcement. Document the remaining access-token lifetime after logout or revocation; introduce additional enforcement only if immediate termination is required. [Cognito token revocation](https://docs.aws.amazon.com/cognito/latest/developerguide/token-revocation.html).
- **PKCE:** Code-only OAuth plus a public client supports PKCE; these Terraform settings do not themselves force clients to send a challenge. Cognito documents PKCE parameters as optional and supports S256 when used. Document and test the complete client flow rather than calling the app-client configuration PKCE enforcement. [Cognito authorization endpoint](https://docs.aws.amazon.com/cognito/latest/developerguide/authorization-endpoint.html).
- **Runtime/dependencies:** Node.js 22 remains supported. AWS SDK v3 is supplied by the managed runtime, so the current import is not automatically a missing-package deployment defect. Packaging a pinned SDK improves reproducibility because the managed SDK minor version varies with runtime/region updates. [Node.js runtime](https://docs.aws.amazon.com/lambda/latest/dg/lambda-nodejs.html).
- **Operations:** SDK reuse, resource-scoped backend invocation, explicit log retention, edge throttling, and identity separation are good foundations. Tool failures are currently swallowed without a diagnostic log (`runtime.mjs:64`), returned as HTTP 200 tool errors, and consequently do not count as Lambda invocation Errors. Add sanitized error/correlation logging and tool-failure metrics before relying on infrastructure error alarms. Consider configurable throttling, reserved concurrency, and deployment aliases when workload requirements justify them. [Lambda best practices](https://docs.aws.amazon.com/lambda/latest/dg/best-practices.html).
- **Reuse/portability:** The manifest ZIP uses one module-relative output path, so multiple instances with different manifests need unique build paths to avoid artifact overwrites. Hardcoded `arn:aws` and `amazonaws.com` assume the standard AWS partition; China/GovCloud deployment requires partition-aware values. These are additional deployment constraints, not failures of the provided single-instance eu-west-1 example.

## Validation and limits of the review

- Repository-required combined unit suites: **29/29 passed**, including **21/21** HTTP runtime tests.
- Module/example `terraform fmt -check -recursive`: **passed**.
- `terraform -chdir=examples/mcp-http-api validate -no-color`: **passed** with AWS provider **6.69.1** and archive provider **2.8.1**, after running outside the sandbox because provider startup was blocked inside it.
- Root formatting check: **failed on existing files outside this review's scope**, `examples/customer-assistant/variables.tf` and `modules/mcp-gateway/variables.tf`.
- Local runtime reproductions confirmed schema-invalid backend calls, unsupported protocol-header acceptance, untrusted Origin acceptance, malformed IDs, and incomplete initialize acceptance.
- Tools available here were Node **26.13.0** and Terraform **1.17.1**. The unit suites were not independently rerun on the repository's required Node 22 runtime.
- Official AWS/MCP pages and HashiCorp provider source were fetched during the review. Current documentation describes availability; it does not establish which optional features are enabled in the existing account or pool.
- No Terraform apply, state refresh, infrastructure plan, AWS account mutation, or fresh live OAuth login was performed. The example README already records that the successful authorization-code path through the public URL remains unverified. Direct backend invocations with manufactured authorizer claims are not an end-to-end authentication test.
- Implementation files were not changed. This report and the companion source research note are the review artifacts.

Standards: **1 finding**, worst S1 (saved-plan commit exposure). Spec/AWS behavior: **10 findings**, worst A1/A2 (standard OAuth interoperability). Supporting example: **3 findings**. Optional feature and operational observations are not included in those counts.
