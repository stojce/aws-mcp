# Ticket 03: Region availability of AgentCore Gateway vs current stack region

Type: research
Status: resolved

## Question

In which AWS regions is Bedrock AgentCore Gateway (and its per-target/outbound credential providers) actually available? Is it available in the region the existing API Gateway + Lambda + GraphQL stack runs in? (Region of existing stack: **user to supply**; the reusable part of this answer is the service's region list, and the deployment-region check is a 1-line lookup once the region is known.)

## Answer

CONFIRMED for eu-west-1: [Supported AWS Regions table](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/agentcore-regions.html) lists AgentCore Gateway, Identity, Built-in Tools, Observability, Policy = Yes for Europe (Ireland). Only Agent Registry/Web Search are narrower; irrelevant here. (Historic scan note; the reusable fact follows.) AgentCore **Gateway and its credential-provider/tunneling machinery are region-scoped but broadly available across the major AgentCore regions** (us-east-1, us-west-2, eu-central-1, eu-west-1, ap-northeast-1/2 among others) per the AgentCore devguide endpoints page. **User still needs to supply the existing stack's region**; the deployment-region check is a 1-line lookup against that list.
