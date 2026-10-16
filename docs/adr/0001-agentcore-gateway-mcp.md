# ADR-0001: Expose guryou's per-user API as MCP via Amazon Bedrock AgentCore Gateway

## Status

accepted 2026-10-16

## Context

Guryou's existing stack (region `eu-west-1`, infra in `guryou-infra-terraform`, app code in `guryou-mono`) exposes two HTTP APIs through API Gateway (HTTP API, `authorization_type = "NONE"` at the edge) backed by Lambdas: the `proxy` GraphQL API (Apollo Server, `api/proxy/src/lambdas/graphql.ts`) and the `training` API. Authentication is **not** at the API GW edge: each Lambda runs `libs/auth-cognito`'s `authorizer()`, verifying Cognito JWTs (with a legacy-token fallback) and resolving claims (`userId`, `userRole`, `providerId`, `isAnonymous`) that per-user data isolation depends on.

The decision: expose a curated slice of this surface to AI agents as an **MCP server, reachable from the public internet**, for end users of the app (per-user data isolation required), with the module written in Terraform.

Two shapes were weighed:

1. **Self-built MCP server** behind our own API GW + Cognito: full control of per-user claims, but we own protocol plumbing, tool registry, and token validation ourselves.
2. **Amazon Bedrock AgentCore Gateway**: managed MCP protocol endpoint, `CUSTOM_JWT` inbound authorizer, Lambda targets with auto-generated tool schemas, and a first-class Terraform story (`aws_bedrockagentcore_*` resources complete since provider v6.21.0).

## Decision

**Use Amazon Bedrock AgentCore Gateway.** The gateway lives on top of the existing stack: the Apollo `graphql.ts` Lambda is invoked as a Lambda target; no changes to its **business logic**. Identity plumbing only: the outbound context builder rejects Gateway-ingress requests lacking interceptor-injected claims (deny-by-default; see Consequences).

The full decision set, each resolved on the wayfinder map (`.scratch/mcp-on-aws/`):

| Concern | Decision |
|---|---|
| Inbound IdP | Reuse the existing Cognito User Pool; Gateway `authorizer_type = CUSTOM_JWT` with the pool's OIDC discovery URL |
| MCP app client | New dedicated app client on the existing pool; Gateway `allowed_audience`/`allowed_clients` binds to **it only**, so web-app tokens cannot be replayed at the MCP edge |
| Scopes | Cognito resource server with `mcp.read` (v1; issued in tokens as `mcp/read`) and `mcp.write` (reserved); Gateway `allowed_scopes = ["mcp/read"]` enforces "at least one scope in token matches" |
| Token flow | End-user tokens via the existing authorization-code (+PKCE) flow, so `sub` = real user (per-user isolation holds at the MCP edge). No `client_credentials` on the MCP app client at v1, since its `sub` is the client id, not a user |
| Gateway target | **Lambda target** wrapping the existing Apollo `graphql.ts` Lambda. HTTP-target `JWT_PASSTHROUGH` and OpenAPI-target + `CognitoOauth2` outbound provider are documented fallback pivots, not v1 |
| Tool curation | Customer-facing assistant: per-user **reads** verified against the real `proxy` schema: `getMyBookedEvents(startTime) → [BookingEvent]` (scopes by injected `userId`), `getMyMemberships(all) → [UserMembership]` (same). `getCustomerEvents` was **dropped** at verification: it `verifyAccessToken([owner|collaborator|director|manager])` and scopes by the caller's `providerId` — a provider-side view, not customer-readable. Each tool's schema hand-derived from its GraphQL operation. No mutations at v1 |
| Identity propagation | Automatic propagation does **not** exist for Lambda targets: the event carries tool args only, and `context.client_context.custom` carries gateway metadata (`bedrockAgentCoreGatewayId`, `bedrockAgentCoreToolName`, …) but no JWT/claims. Compensation: a request interceptor Lambda (with `passRequestHeaders = true`) decodes the already-validated JWT, injects the selected claims into `x-mcp-claims` — HMAC-signed with a shared secret (`x-mcp-claims-sig`), allowlisted on the target's `metadata_configuration` so the interceptor value (which overrides any client-supplied header) reaches the target — and the target verifies the signature (deny-by-default) |
| Module ownership | New Terraform module in this repo creates: MCP app client + resource server, the Gateway, the `targets` variable-driven gateway targets, the Gateway execution role, and `lambda:InvokeFunction` permissions. It does **not** create the User Pool (that stays with `guryou-infra-terraform/modules/cognito`) and ships no outbound credential providers at v1 (a `credential_provider_arn` hook on each target reserves the seam) |
| Module outputs | Gateway endpoint URL, gateway id, role ARN, MCP app client id, tool names |

## Consequences

- The existing API GW keeps `authorization_type = NONE` and its Lambda-side auth unchanged; the MCP path adds a **new, separate public ingress** whose auth is enforced at the Gateway edge instead. Two auth boundaries coexist deliberately.
- Per-user isolation on the MCP path depends on the interceptor injecting claims from the validated inbound JWT **and on the target verifying the injection's HMAC signature** (shared `MCP_CLAIMS_SIGNING_SECRET`); a tool that ignored/failed to verify injected claims would silently lose per-user scoping or accept forged claims, which makes this a review checkpoint for every new tool.
- Provider floor for consumers: `hashicorp/aws` ≥ 6.21.0, prefer ≥ 6.34.0.
- No additional outbound credential providers at v1. If a future tool needs the Gateway to call an external HTTP API, the target-scoped `credential_provider_arn` hook is the integration point; JWT passthrough and OBO token exchange (RFC 8693) remain available pivots if Lambda-target identity injection proves insufficient.
- CloudTrail logs JWT `sub` values; avoid putting PII in `sub`.
- Gateway is available in `eu-west-1` (AWS "Supported AWS Regions" table); no region blocker for the existing stack.

## References

- Wayfinder map + resolved tickets 01 through 08: `.scratch/mcp-on-aws/map.md`
- AWS AgentCore Gateway inbound auth: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-inbound-auth.html
- Lambda target invocation contract: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-add-target-lambda.html
- Outbound auth / provider matrix: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-outbound-auth.html
- terraform-provider-aws `aws_bedrockagentcore_*` resources: https://registry.terraform.io/providers/hashicorp/aws/latest/docs
