# Spec: MCP server for Guryou's per-user API via Amazon Bedrock AgentCore Gateway

Status: ready-for-agent

## Problem Statement

Guryou's end users want to interact with their bookings and subscriptions through AI agents (an MCP client), but the existing API surface is only reachable through the web app's own HTTP API boundary. There is no world-facing MCP endpoint that authenticates a real end user, scopes every read to that user's data, and exposes a small, stable tool surface that an agent can call.

## Solution

Expose a curated slice of the existing per-user API surface as an MCP server reachable from the public internet, implemented with Amazon Bedrock AgentCore Gateway (inbound `CUSTOM_JWT` authorizer against the existing Cognito User Pool) and a **Lambda target** invoking the existing Apollo `graphql.ts` Lambda unchanged. Per-user identity travels via an **Interceptor** request-Lambda that copies validated JWT claims (`userId`, `userRole`, `providerId`, `isAnonymous`) into the request; the target Lambda must **deny-by-default** when those injected claims are absent. All Terraform lives in this repo; guryou-mono and guryou-infra-terraform are untouched. ADR-0001 and GLOSSARY.md are the governing decisions and vocabulary.

## User Stories

1. As a Guryou end user (customer), I want an AI agent to answer "my bookings" questions on my behalf, so that I don't have to click through the app.
2. As a Guryou end user, I want the agent to see only my own bookings and subscriptions, so that another customer's data is never exposed to me or my agent.
3. As a Guryou end user, I want to log in once for the MCP client via the same Cognito account I use in the web app, so that there is no second identity to manage.
4. As a Guryou end user, I want MCP-issued tokens to be distinct from my web-app tokens, so that a leaked agent token cannot be replayed against the web app's API edge.
5. As a Guryou end user, I want the MCP tool surface limited to reads, so that no agent can mutate my bookings at v1.
6. As an MCP client author (agent vendor), I want a documented MCP endpoint URL, so that I can connect my agent.
7. As an MCP client author, I want each tool to have a stable, hand-derived input/output schema, so that my agent's tool calls stay valid even as the GraphQL schema evolves behind the Gateway.
8. As an MCP client author, I want tool names that mirror the underlying operations, so that tool selection is obvious to the model.
9. As a Guryou platform engineer, I want the Gateway to accept only tokens from the dedicated MCP app client, so that web-client tokens are rejected at the MCP edge.
10. As a Guryou platform engineer, I want the Gateway to enforce `mcp.read` scope presence, so that tokens without the MCP scope cannot invoke any tool.
11. As a Guryou platform engineer, I want per-user claims injected by an interceptor rather than derived in the target, so that there is exactly one identity-propagation mechanism.
12. As a Guryou platform engineer, I want the target Lambda to reject requests that lack injected claims, so that a misconfigured Gateway degrades to an error, never to wrongly-scoped data.
13. As a Guryou platform engineer, I want the interceptor to forward only the four claim fields the app-level authorization needs, so that no unneeded JWT content reaches the target.
14. As a Guryou platform engineer, I want the Gateway execution role and `lambda:InvokeFunction` permissions created by the module, so that apply needs zero manual post-steps.
15. As a Guryou platform engineer, I want `mcp.write` absent from the app client at v1, so that mutation tools cannot ship before their review checkpoint exists.
16. As a Guryou platform engineer, I want each new tool's claims-reading behavior to be a review checkpoint, so that no tool silently bypasses per-user scoping.
17. As a repo maintainer, I want the wayfinder map for this effort closed, so that no session resurrects resolved fog.
18. As a repo maintainer, I want the v1 tool list verified against the real `proxy` GraphQL schema, so that the ADR and MCP surface name operations that actually exist and are per-user-scoped.
19. As a future maintainer, I want the ADR to distinguish "no business-logic changes to `graphql.ts`" from the deny-by-default context guard, so that the guard isn't mistaken for a violation of ADR-0001.
20. As a future maintainer, I want the target-scoped `credential_provider_arn` hook reserved on each target, so that a future outbound-auth pivot has a documented seam.
21. As a security reviewer, I want CloudTrail-visible JWT `sub` values free of PII, so that audit logs don't capture personal data.
22. As a security reviewer, I want the two auth boundaries (existing API GW edge `NONE` + Lambda-side auth; Gateway edge JWT) documented as deliberate, so that a hardening pass doesn't "fix" one into the other.
23. As an operator, I want module outputs (gateway URL, gateway id, role ARN, MCP app client id, tool names), so that consumer configuration is a copy-paste.
24. As an operator, I want the provider pinned to `hashicorp/aws` ≥ 6.21.0 (prefer ≥ 6.34.0), so that all `aws_bedrockagentcore_*` resources exist.

## Implementation Decisions

- **Architecture**: per ADR-0001 — Amazon Bedrock AgentCore Gateway with `authorizer_type = CUSTOM_JWT` against the existing Cognito User Pool's OIDC discovery URL; the existing Apollo `graphql.ts` Lambda is the single **Lambda target**; a request **Interceptor** Lambda injects selected claims into the request before the target runs.
- **Modules built (this repo)**: a new Terraform module creating five resource groups: (1) MCP app client + MCP resource server with scope `mcp.read`; (2) the Gateway; (3) gateway targets driven by a `targets` variable list of `{ name, lambda_arn, tool_name, tool_schema, credential_provider_arn? }`; (4) the Gateway execution role; (5) `lambda:InvokeFunction` permissions for its targets.
- **Module inputs**: existing pool id, region. The module does **not** create the User Pool; pool/web-client ownership stays in guryou-infra-terraform.
- **Module outputs**: Gateway endpoint URL, gateway id, Gateway execution role ARN, MCP app client id, tool names.
- **Inbound auth binding**: Gateway `allowed_audience`/`allowed_clients` binds to the dedicated **MCP app client** only; `allowed_scopes = ["mcp.read"]`. End-user tokens via the existing authorization-code (+PKCE) flow, so `sub` is the real user. No `client_credentials` on the MCP app client at v1. No `mcp.write` scope on the app client at v1 (added only when the first mutation tool is designed).
- **Identity propagation**: no automatic per-user propagation exists for Lambda targets (event carries tool args; `client_context.custom` carries gateway metadata only). Compensation: the **Interceptor** copies `userId`, `userRole`, `providerId`, `isAnonymous` from the validated inbound JWT into the request. **Deny-by-default**: the target's context builder rejects requests lacking the injected-claims marker with an explicit error; the header-bearer fallback path is not taken on the Gateway-ingress route. This is a context-builder guard in guryou-mono, not a business-logic change; ADR-0001's "no code changes to `graphql.ts`" is scoped to business logic.
- **v1 tool curation**: per-user booking/subscription **reads** — `getMyBookedEvents`, `getCustomerEvents`, plus 1–3 sibling subscription/reservation reads finalized at module-consumption time. Each tool's `toolSchema` is hand-derived from the matching GraphQL operation's input/output types. No mutations at v1. Crons/infra Lambdas excluded.
- **Tool-list verification gate**: before the targets are shipped, the v1 list is checked against the real `proxy` GraphQL schema in guryou-mono; any operation that is not per-user-scoped by the caller's identity is dropped from the list and the ADR tool table corrected. Per-user scoping must derive from injected claims, never from a client-supplied id.
- **No outbound credential providers at v1**; the target-scoped `credential_provider_arn` variable hook is the reserved seam for a future HTTP/OpenAPI-target pivot.
- **Provider floor**: `hashicorp/aws` ≥ 6.21.0, prefer ≥ 6.34.0. Region `eu-west-1` (AgentCore Gateway family available).
- **Map closure**: the `.scratch/mcp-on-aws/` wayfinder map is closed (Status updated, "Not yet specified" cleared) as part of this work; the dual-boundary consequence (existing API GW edge stays `NONE` + Lambda-side auth; MCP edge enforces JWT at the Gateway) stays documented in the ADR.
- **Privacy**: JWT `sub` values appear in CloudTrail; `sub` carries no PII.

## Testing Decisions

- **Good test**: asserts external, observable behavior only — what an MCP client receives at the Gateway edge and what a caller with/without injected claims gets from the target route. No assertions on Terraform resource internals, resolver wiring, or module variable plumbing.
- **Seam 1 (highest, interactive): the deployed Gateway MCP endpoint.** Post-apply smoke test speaking MCP to the Gateway with a real Cognito token from the MCP app client: assert a `getMyBookedEvents`-class read succeeds and returns only the calling user's data; assert a web-app-client token and a token without `mcp.read` are rejected at the edge; assert a request stripped of injected claims is rejected by the target route rather than returning data.
- **Seam 2 (pure): the interceptor Lambda handler.** Unit-tested as event-in → event-out: claims present → selected four claims copied into the request; claims absent → request marked for denial downstream. This is the only pure-function seam; it stays a unit seam because its behavior is fully determined by its input event.
- **Not tested**: GraphQL resolvers, generated schema files, Terraform internals, module variable forwarding, echo-style wiring. No seams are added for these; two seams total is the goal.
- **Prior art**: none in this repo (no code exists yet); the interceptor unit test follows the mono's `libs/auth-cognito` claim-normalization test style; the edge smoke test follows the existing stack's post-apply API smoke habit.

## Out of Scope

- Shipping any code in guryou-mono or guryou-infra-terraform beyond the deny-by-default context guard.
- Mutation tools at v1; `mcp.write` scope on the app client.
- Outbound credential providers; HTTP-target `JWT_PASSTHROUGH` and OpenAPI-target `CognitoOauth2` pivots (documented fallbacks, not built).
- Per-user network restriction beyond gateway-level authz (SGs/PolicyEngine work).
- The `training` API surface; only the `proxy` GraphQL API's curated reads are exposed.
- Implementation itself: tickets 09–15 (see `issues/`, broken down via to-tickets).

## Further Notes

- Round-1 grilling answers (map closure, deny-by-default, tool-list verification, no `mcp.write` at v1, implementation in this repo) were adopted as recommended without explicit user confirmation; treat those five as decided-but-confirmable if the user revisits.
- The wayfinder map for this effort is complete; the ADR (ADR-0001) and GLOSSARY.md are the canonical decisions and vocabulary. Terms used here (Gateway, Lambda target, Interceptor, Claims, MCP app client, Tool schema, mcp.read/mcp.write) are defined there.
- The interceptor-isolation review checkpoint applies to every future tool: a tool that ignored injected claims would silently lose per-user scoping.
