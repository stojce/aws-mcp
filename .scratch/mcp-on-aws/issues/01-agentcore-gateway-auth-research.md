# Ticket 01: Research AgentCore Gateway auth: Cognito inbound per-user, Lambda target outbound

Type: research
Status: resolved

## Question

How does Amazon Bedrock AgentCore Gateway handle **inbound** auth when the caller is an **end user** of the existing app (Cognito User Pool authorizer like the existing API GW), and does that per-user identity propagate to a **Lambda target**: does the Gateway's `Lambda.invoke` carry caller identity/claims through to the wrapper Lambda, e.g. via `SecurityToken`/writer context, JWT claims, or nothing (only the Gateway's own principal)? Also what the inbound token exchange looks like: which Cognito grant types / custom scopes does the Gateway's authorizer config accept, and is the Cognito User Pool the supported IdP?

Also cover: does the Gateway support an **outbound** credential configuration (API key / OAuth 2.0 provider) to call the **existing GraphQL endpoint** through the existing API Gateway authorizer, and which outbound credential provider types exist.

Deliverable: fact sheet with primary-source links (AWS docs), listing supported grant types, credential provider types, whether per-user identity context reaches the Lambda target and how.

## Answer

**Fact sheet (verified 2026-10-16, AWS docs AgentCore Dev Guide + provider docs).**

**Inbound:** three authorizer types: `CUSTOM_JWT` (IdP-agnostic OIDC: `discovery_url` + at least one of `allowedAudience`/`allowedClients`/`allowedScopes`/`customClaims`), `AWS_IAM` (SigV4 + `bedrock-agentcore:InvokeGateway`), `NONE`/`AUTHENTICATE_ONLY` (delegated to interceptors/policy engine). No Lambda-authorizer type; custom authorization = request interceptor Lambdas (REQUEST/RESPONSE) or Cedar policy engine. Cognito User Pool supported: reuse existing pool as CUSTOM_JWT with discovery URL `https://cognito-idp.<region>.amazonaws.com/<userPoolId>/.well-known/openid-configuration`. Grant-type agnostic: client_credentials, authorization_code+PKCE, or tokens minted for the existing API GW client all validate, if `aud`/`client_id`/scope match config. Caveat: client_credentials tokens carry `sub` = app client id, NOT the end user.
Refs: inbound-jwt-authorizer, gateway-inbound-auth, gateway-using-auth-ex-starter (docs.aws.amazon.com/bedrock-agentcore/latest/devguide/), auth-code-flow blog.

**Per-user identity propagation to Lambda target: NO automatic propagation (the crux).** Lambda target invocation contract (gateway-add-target-lambda): event = tool input args only; `context.client_context.custom` carries only `bedrockAgentCore{MessageVersion,AwsRequestId,McpMessageId,GatewayId,TargetId,ToolName}` (no JWT, no claims, no SecurityToken). Lambda targets support only `GATEWAY_IAM_ROLE` outbound (invoked under Gateway service role). Per-user identity channels that DO exist: (1) **JWT_PASSTHROUGH**, HTTP targets only, not Lambda; (2) **OAuth on-behalf-of token exchange (RFC 8693 TOKEN_EXCHANGE)**, MCP-server/OpenAPI targets, preserves `sub`+actor; (3) **request interceptor Lambda**, documented pattern to inject selected claims into the request body/headers before the target Lambda runs (preferred for Lambda targets, least-privilege); (4) trust-the-agent: declare user_id/claims in tool inputSchema (weaker). Consequence for us: per-user isolation behind Lambda targets requires an interceptor; or move boundary to HTTP/MCP targets where passthrough/OBO exist.

**Outbound credential providers:** `GATEWAY_IAM_ROLE` (SigV4 under gateway role, works for API GW targets but NOT through a Cognito authorizer), `CALLER_IAM_CREDENTIALS` (FAS, IAM-ready targets, only with IAM/AUTHENTICATE_ONLY inbound), `OAUTH` (24 built-in vendors incl. **CognitoOauth2**; `grantType ∈ {CLIENT_CREDENTIALS, AUTHORIZATION_CODE, TOKEN_EXCHANGE}`), `JWT_PASSTHROUGH` (HTTP targets only), `API_KEY` (header/query, usage-plan-key pattern). **Compatibility matrix: API GW stage targets = only GATEWAY_IAM_ROLE/API_KEY/NONE (no OAuth); Lambda targets = only GATEWAY_IAM_ROLE.** To speak Cognito OAuth to the existing API GW, register it as an OpenAPI-schema or MCP-server target instead of an API-GW-stage target. (TF: `aws_bedrockagentcore_api_key_credential_provider`, `aws_bedrockagentcore_oauth2_credential_provider` (see ticket 02).)

**Private ingress:** PrivateLink `com.amazonaws.<region>.bedrock-agentcore.gateway`; VPC-endpoint policy must use `Principal: "*"` for OAuth-ingress gateways (can't filter OAuth principals), so per-user network restriction = SGs + gateway-level authz. `PutResourcePolicy` authorizes IAM principals only. Gateway supports `private_endpoint`/`private_endpoint_overrides` for VPC-hosted IdPs; outbound to VPC targets via resource gateway/Lattice.

**App-case recommendation:** reuse existing Cognito pool as inbound CUSTOM_JWT (MCP-specific app client in `allowed_audience`/`allowed_clients`); per-user isolation via interceptor-injected claims (Lambda targets) or OBO/passthrough (HTTP/MCP targets); existing API GW+GraphQL reachable via CognitoOauth2 outbound provider (CLIENT_CREDENTIALS stateless, or TOKEN_EXCHANGE for per-user) on an OpenAPI/MCP-server target. CloudTrail logs JWT `sub`, so avoid putting PII in sub.
