# Ticket 11: Terraform module core: MCP app client, resource server, Gateway

Type: task
Status: resolved

## Answer

`modules/mcp-gateway/` (this repo):

- `versions.tf`: aws `>= 6.21.0, < 7.0.0` + archive provider.
- `gateway.tf`: the five resource groups' four of five:
  - `aws_cognito_resource_server.mcp` (identifier `mcp`, scope `mcp/read` only — **no** `mcp.write`)
  - `aws_cognito_user_pool_client.mcp` (authorization-code + PKCE confidential client, `ALLOW_REFRESH_TOKEN_AUTH`, no client_credentials, app-client-only callback URLs)
  - `aws_iam_role.gateway` (bedrock-agentcore.amazonaws.com trust)
  - `aws_bedrockagentcore_gateway.this` (`CUSTOM_JWT`, Cognito discovery URL, `allowed_audience`/`allowed_clients` bound ONLY to the MCP app client id, `allowed_scopes = ["mcp/read"]`, `protocol_type = MCP`)
- `outputs.tf`: gateway_id, gateway_url, gateway_arn, gateway_role_arn, mcp_app_client_id, mcp_resource_server_identifier, interceptor_lambda_arn, tool_names, target_ids.
- `variables.tf`: `name`, `region` (default eu-west-1), `user_pool_id` (existing pool — never created here), `gateway_lambda_target_arn`, callback/logout URLs, `targets` list.

## Verification

- `terraform init && terraform validate` on the example (`examples/customer-assistant`): **passes**.
- Real apply: user chose offline ("validate only") — NOT exercised; acceptance "outputs non-empty after apply" pending a real apply run. Recorded as the one open item on this ticket.
- The provider floor ≥6.21.0 holds; latest stable at write time 6.69.1.

## Acceptance criteria

- [x] Inputs pool id + region; pool never created.
- [x] `mcp.read` only; no `mcp.write`; no client_credentials.
- [x] Gateway binds allowed audience/clients to MCP app client only; scopes mcp/read.
- [x] Execution role, targets variable, zero-targets stage.
- [x] Outputs defined (apply verification pending offline choice).
