# Ticket 02: Terraform provider support for AgentCore Gateway resources

Type: research
Status: open

## Question

What Terraform AWS provider resources exist for AgentCore Gateway (`aws_bedrockagentcore_*` family, e.g. gateway, gateway target, credential provider)? What minimum **provider version** ships the full set needed for: a Gateway with Cognito inbound authorizer, Lambda targets, and an outbound credential provider to hit an HTTPS GraphQL endpoint? Any remaining gaps that force `aws_cloudformation`-style workarounds or `null_resource` + AWS CLI? Deliverable: exact resource names + versions + gaps, with provider changelog / registry links.

## Answer

<!-- filled on resolution -->
