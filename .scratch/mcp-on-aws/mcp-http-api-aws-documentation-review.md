# HTTP API MCP module: AWS documentation review

Reviewed **2026-11-02** against live-fetched primary documentation and the current files in `modules/mcp-http-api/`. This is a source/documentation review, not an AWS deployment test. No AWS account APIs were called and no Terraform state was read or changed. Documentation schedules and service features can change after this date.

The existing native JWT authorizer, required custom scope, and Lambda checks of `token_use`, `client_id`, and `sub` form a sound identity boundary for the documented manually configured access-token path. The main compatibility defect is that this authorizer rejects Cognito's resource-bound access tokens, including tokens requested by conforming MCP OAuth clients. The module also lacks the protected-resource discovery endpoint required by the MCP authorization specification it advertises.

## Confirmed defects and compatibility gaps

### Resource-bound access tokens fail the authorizer

**Code:** `modules/mcp-http-api/main.tf:153` configures the authorizer audience to the dedicated app-client ID only. Its comment, and the README's verified-facts section, generalize an earlier observation that a Cognito access token has no `aud`.

AWS explicitly documents the JWT-authorizer precedence rule: **“API Gateway validates client_id only if aud is not present. When both aud and client_id are present, API Gateway evaluates aud.”** [S1]

Cognito now supports OAuth resource indicators. A request such as `resource=https://example.execute-api.eu-west-1.amazonaws.com/mcp` produces an access token whose `aud` is that URL, while `client_id` still identifies the app client. Cognito documents that `aud` is present when a resource binding was requested, and that refresh grants preserve this claim. [S2, S3, S4]

Consequently, a token with the correct app-client ID, `token_use=access`, and `mcp/read`, but with `aud=<mcp_url>`, is rejected by the current edge authorizer before the Lambda can check it. This conclusion follows from the documented claim rules and the module configuration; it was not reproduced against a deployed endpoint during this review.

This is relevant even to the advertised `2025-06-18` protocol: its authorization specification requires clients to send the canonical MCP resource URI in authorization and token requests, regardless of whether the authorization server supports it. [S12]

**Recommended direction:** configure the accepted audience to the canonical MCP endpoint URI and preserve the Lambda's independent app-client and access-token checks. Decide explicitly whether to keep accepting legacy tokens without resource binding during migration. Adding the resource URI alongside the client ID would retain that compatibility, but it would continue accepting unbound tokens through API Gateway's `client_id` fallback. Resource binding and the scope identifier are separate concepts: Cognito permits a resource URL of the client's choosing, so changing `mcp/read` to a URL-prefixed scope is not necessary solely to add `aud`. [S3]

### OAuth protected-resource discovery is absent

**Code:** `main.tf:172` creates only `ANY /mcp`; `runtime.mjs:110` authorizes before dispatching methods; its challenge at line 114 has no `resource_metadata` parameter. There is no well-known protected-resource metadata route in this module.

The official MCP `2025-06-18` authorization specification says servers **MUST** implement RFC 9728 protected-resource metadata, including `authorization_servers`, and **MUST** use `WWW-Authenticate` on 401 responses to indicate the metadata location. Clients use that metadata to discover the authorization server. [S12]

An agent can still work with manually supplied Cognito endpoints, client ID, scope, and token. That integration mode does not establish automatic MCP OAuth discovery conformance. Adding Lambda response headers alone does not fix missing-token responses: this module's native authorizer rejects those requests before integration invocation. Any implementation must ensure that both unauthenticated metadata retrieval and the actual edge 401 response provide the required discovery information.

### Timeout documentation and variable contract disagree with AWS

**Code:** `variables.tf:64` defaults `lambda_timeout_s` to 29; `main.tf:168` subtracts one second to configure the integration. The default HTTP integration therefore times out at **28 seconds**, while the function times out at 29 seconds. The README describes an AWS 29-second integration limit.

Current AWS HTTP API quotas list **“Maximum integration timeout: 30 seconds”**, with no increase available. The API reference independently specifies an integer integration timeout between **50 and 30,000 milliseconds**, defaulting to 30 seconds for HTTP APIs. The 29-second value in that same API reference belongs to WebSocket APIs. [S5, S6]

The input lacks validation for its derived integration value. For example, `lambda_timeout_s=32` produces 31,000 milliseconds, outside the service limit; `lambda_timeout_s=1` produces zero. Add an explicit variable contract or separate the Lambda and integration timeouts. Document the configured deadline separately from the AWS ceiling. Allowing Lambda to run slightly beyond the HTTP deadline can be intentional, but an HTTP timeout does not guarantee that a backend invocation has stopped. AWS also documents continued Lambda execution after streaming connections close; avoid treating client disconnection as cancellation. [S7]

## Confirmed platform limits

| Area | Current official documentation | Implication for this module |
|---|---|---|
| HTTP API buffered payload | 10 MB, not increasable. [S5] | This is not the effective maximum for the complete Lambda path. |
| Lambda synchronous invocation | 6 MB each for request and response. [S8] | Applies to the HTTP API Lambda invocation and the explicit `RequestResponse` backend invocation in `index.mjs:20`. Event envelopes, HTTP response envelopes, JSON-RPC wrapping, and JSON escaping consume part of that allowance. A single exact maximum tool-result size cannot be stated from the service quota alone. |
| HTTP API streaming | REST API: yes; HTTP API: no. [S9] | The current HTTP API cannot gain SSE by merely wrapping the Node handler with a streaming API. |
| API Gateway REST response streaming | REST APIs only; `HTTP_PROXY` or `AWS_PROXY`; response transfer mode `STREAM`; up to 15 minutes; no request streaming. [S7] | A useful alternative architecture for progress/SSE or longer tool execution, requiring an API product/integration change. |
| REST stream idle timeout | 5 minutes for Regional/private endpoints; 30 seconds for edge-optimized endpoints. [S7] | A 15-minute maximum is not permission for a silent 15-minute connection. |

The HTTP API module deliberately returns one JSON response and 405 for GET. That transport limitation is accurately documented. New REST response streaming does not remove the HTTP API timeout, and the backend's current buffered invocation would still constrain results and execution even after changing the frontend integration.

## Cognito OAuth behavior and session lifecycle

### Custom scopes require the appropriate token-issuance path

Cognito documents that ordinary `InitiateAuth` / `AdminInitiateAuth` access tokens contain only `aws.cognito.signin.user.admin`. Custom resource-server scopes require OAuth endpoint issuance; access-token scope customization through pre-token generation is another documented route and depends on the feature plan. [S2, S3]

Therefore, enabling `ALLOW_USER_PASSWORD_AUTH` for smoke tests does **not**, by itself, create a token carrying `mcp/read`. Such tokens should fail the configured scope check. A test using password-auth tokens must state whether it expects denial or depends on an external pre-token-generation trigger. Do not weaken the route scope to make the password flow pass.

### Public code-flow configuration supports PKCE; it does not enforce its use

`main.tf:24` describes a public PKCE client, but the concrete settings are a public client with authorization-code grants. Cognito's authorize endpoint lists `code_challenge_method` and `code_challenge` as optional; when PKCE is used, Cognito supports **S256 only**. Its token endpoint requires `code_verifier` only when the authorization request supplied the challenge. [S4, S10, S11]

The client must generate the verifier/challenge pair, send the S256 challenge during authorization, and submit the verifier during code exchange. A Terraform `allowed_oauth_flows=["code"]` setting is not evidence that a caller did this. The MCP specification explicitly requires MCP clients to implement PKCE. [S12] This is a client integration/documentation requirement, not a claim that the current resource settings cannot support PKCE.

### Refresh rotation is available, with a migration constraint

Cognito documents refresh-token rotation as optional and recommends enabling it. Each successful refresh can issue a new refresh token; retry grace can be up to 60 seconds. Rotation keeps the original expiry window rather than extending the session indefinitely. [S13]

The module does not configure rotation and explicitly permits `ALLOW_REFRESH_TOKEN_AUTH`. Rotation is incompatible with that flow: remove it and use `GetTokensFromRefreshToken` or the OAuth token endpoint, both of which support rotation. [S13]

Absence of rotation is an AWS hardening opportunity rather than, by itself, proof of an authorization bypass. There is a stricter conformance distinction: the official MCP `2025-06-18` authorization specification requires public-client authorization servers to rotate refresh tokens. A claim of complete conformance to that authorization profile must account for this setting. [S12]

### Revocation does not guarantee immediate HTTP API denial

Cognito's create-client API states that omitting `EnableTokenRevocation` **automatically activates revocation for a new client**. Therefore, the missing Terraform argument is not evidence that Cognito revocation is disabled. [S14]

Cognito separately warns: **“revoked tokens will still be valid if they are verified using any JWT library that verifies the signature and expiration of the token.”** [S15] API Gateway's documented JWT checks are signature, issuer, audience/client ID, time claims, and scopes; no revocation lookup is described. [S1] This module performs no revocation check either.

The documented design consequently provides no immediate per-session revocation guarantee at the MCP endpoint. Existing access tokens may remain usable until expiry even after their refresh token is revoked. With the current one-hour access-token lifetime, the nominal remaining exposure can approach one hour. This is a design limitation to document; rotation alone does not add a revocation lookup to the resource server.

## Node.js runtime and SDK

The live AWS Node runtime table lists `nodejs22.x` on Amazon Linux 2023 as supported, with a scheduled deprecation of **2027-04-30**, create blocking on **2027-07-29**, and update blocking on **2027-08-31**. These are the published dates retrieved during this review, not guarantees about future service policy. [S16]

The `@aws-sdk/client-lambda` import without an archived `node_modules` directory is supported: current Node Lambda runtimes include AWS SDK for JavaScript v3, and AWS explicitly permits archives containing only code when dependencies are runtime-included libraries. [S16, S17] This is not a missing-package deployment defect.

AWS also says the included SDK is a specific minor version, depends on runtime and Region, and changes with runtime updates. Packaging a chosen SDK version would improve dependency reproducibility and allow local testing of the entrypoint, while making the repository responsible for updates. [S16, S17] Do not infer a particular deployed SDK version from this documentation; no runtime invocation was performed.

## Source register and verification boundaries

All sources below were fetched successfully with `curl -L --fail --silent --show-error` during this review. AWS HTML was converted to text locally to inspect the quoted passages. Sources S1–S11 and S13–S17 are official AWS documentation; S12 is the official MCP specification, used because AWS documentation does not own MCP's discovery and client requirements. Successful retrieval is not evidence that the current AWS account, Region, provider version, or deployed endpoint has exercised every feature. No undocumented release date is inferred.

- **S1:** [HTTP API JWT authorizers](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-jwt-authorizer.html).
- **S2:** [Understanding the Cognito access token](https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-using-the-access-token.html).
- **S3:** [Cognito scopes, resource servers, and resource binding](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-define-resource-servers.html#cognito-user-pools-resource-binding).
- **S4:** [Cognito authorization endpoint](https://docs.aws.amazon.com/cognito/latest/developerguide/authorization-endpoint.html).
- **S5:** [HTTP API quotas](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-quotas.html).
- **S6:** [API Gateway V2 integration API reference](https://docs.aws.amazon.com/apigatewayv2/latest/api-reference/apis-apiid-integrations-integrationid.html).
- **S7:** [API Gateway response transfer mode](https://docs.aws.amazon.com/apigateway/latest/developerguide/response-transfer-mode.html).
- **S8:** [Lambda quotas](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html).
- **S9:** [REST API and HTTP API feature comparison](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-vs-rest.html).
- **S10:** [Cognito PKCE authorization-code grants](https://docs.aws.amazon.com/cognito/latest/developerguide/using-pkce-in-authorization-code.html).
- **S11:** [Cognito token endpoint](https://docs.aws.amazon.com/cognito/latest/developerguide/token-endpoint.html).
- **S12:** [MCP 2025-06-18 authorization specification](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization).
- **S13:** [Cognito refresh tokens and rotation](https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-using-the-refresh-token.html).
- **S14:** [CreateUserPoolClient API reference](https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_CreateUserPoolClient.html).
- **S15:** [Cognito token revocation](https://docs.aws.amazon.com/cognito/latest/developerguide/token-revocation.html).
- **S16:** [Lambda Node.js runtime, lifecycle, and included SDK](https://docs.aws.amazon.com/lambda/latest/dg/lambda-nodejs.html).
- **S17:** [Lambda Node.js archive packaging](https://docs.aws.amazon.com/lambda/latest/dg/nodejs-package.html).

Still requiring deployment or client evidence: native authorizer failure response headers/status bodies in the intended Region; actual bound-token grant and refresh behavior with the chosen managed-login domain; Terraform-provider support for any selected newer Cognito settings; exact deployed SDK version; and the maximum application payload after all serialization layers. The module's earlier live-test observations remain historical evidence and do not establish these newer paths.
