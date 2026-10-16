# Ticket 02: Terraform provider support for AgentCore Gateway resources

Type: research
Status: resolved

## Question

What Terraform AWS provider resources exist for AgentCore Gateway (`aws_bedrockagentcore_*` family, e.g. gateway, gateway target, credential provider)? What minimum **provider version** ships the full set needed for: a Gateway with Cognito inbound authorizer, Lambda targets, and an outbound credential provider to hit an HTTPS GraphQL endpoint? Any remaining gaps that force `aws_cloudformation`-style workarounds or `null_resource` + AWS CLI? Deliverable: exact resource names + versions + gaps, with provider changelog / registry links.

## Answer

**Every resource the module needs exists natively in `hashicorp/aws`** (no `awscc_*` fallback, no `null_resource`/CLI workarounds). Facts (provider v6.69.1 as of 2026-10-15):

- **Gateway + Cognito inbound authorizer:** `aws_bedrockagentcore_gateway` (`authorizer_type = "CUSTOM_JWT"`, `authorizer_configuration.custom_jwt_authorizer` with Cognito `discovery_url` = `https://cognito-idp.<region>.amazonaws.com/<userPoolId>/.well-known/openid-configuration` + `allowed_audience` = app client ids). Shipped **v6.17.0**.
- **Lambda targets:** `aws_bedrockagentcore_gateway_target` with `target_configuration.mcp.lambda.lambda_arn` + `tool_schema` from **v6.17.0**.
- **Outbound credential providers:** `aws_bedrockagentcore_api_key_credential_provider` (**6.17.0**) and `aws_bedrockagentcore_oauth2_credential_provider` (**6.18.0**), referenced from target `credential_provider_configuration.{api_key|oauth}.provider_arn`.
- **Minimum provider version: >= 6.21.0** for the stable full set (optional `credential_provider_configuration` on targets); bare support >= 6.18.0. Prefer **>= 6.34.0** (avoids a `metadata_configuration` forced-replacement bug fixed in 6.34.0); note `custom_jwt_authorizer` translator regression in 6.36.0, fixed 6.37.0.
- **Remaining gaps (none needed here):** CFN-only types without provider resources (`GatewayRateLimit`, `CapacityProvider`, `ConfigurationBundle`, `ConsentPortal`, `Dataset`, `HarnessEndpoint`, `Payment*`) would go via `awscc_bedrockagentcore_*` if ever required. `aws_bedrockagentcore_registry` deprecated in 6.53.0 (registry moved to `agent-registry` namespace; renamed `aws_agentregistry_registry`). Gateway/target data sources still sparse in 6.69.x.

Sources: terraform-provider-aws changelog (6.17.0 -> 6.69.1 entries); [AWS CFN BedrockAgentCore reference](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/AWS_BedrockAgentCore.html); [Agent Registry FAQ](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/registry-faq.html). Full transcript: history://TfResearch.
