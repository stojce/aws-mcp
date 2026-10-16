# Ticket 01: Research AgentCore Gateway auth: Cognito inbound per-user, Lambda target outbound

Type: research
Status: open

## Question

How does Amazon Bedrock AgentCore Gateway handle **inbound** auth when the caller is an **end user** of the existing app (Cognito User Pool authorizer like the existing API GW), and does that per-user identity propagate to a **Lambda target** — does the Gateway's `Lambda.invoke` carry caller identity/claims through to the wrapper Lambda, e.g. via `SecurityToken`/writer context, JWT claims, or nothing (only the Gateway's own principal)? Also what the inbound token exchange looks like: which Cognito grant types / custom scopes does the Gateway's authorizer config accept, and is the Cognito User Pool the supported IdP?

Also cover: does the Gateway support an **outbound** credential configuration (API key / OAuth 2.0 provider) to call the **existing GraphQL endpoint** through the existing API Gateway authorizer, and which outbound credential provider types exist.

Deliverable: fact sheet with primary-source links (AWS docs), listing supported grant types, credential provider types, whether per-user identity context reaches the Lambda target and how.

## Answer

<!-- filled on resolution -->
