output "gateway_id" {
  description = "The AgentCore Gateway identifier."
  value       = aws_bedrockagentcore_gateway.this.gateway_id
}

output "gateway_url" {
  description = "The public MCP endpoint URL (gateway_identifier + region); consumers point their MCP client here."
  value       = aws_bedrockagentcore_gateway.this.gateway_url
}

output "gateway_arn" {
  description = "The AgentCore Gateway ARN."
  value       = aws_bedrockagentcore_gateway.this.gateway_arn
}

output "gateway_role_arn" {
  description = "IAM role assumed by the Gateway to invoke its targets."
  value       = aws_iam_role.gateway.arn
}

output "mcp_app_client_id" {
  description = "The dedicated MCP app client id; the ONLY audience/client the Gateway accepts. Tokens come from the existing pool via authorization-code + PKCE."
  value       = aws_cognito_user_pool_client.mcp.id
}

output "mcp_resource_server_identifier" {
  description = "Resource-server identifier for the mcp.* scopes (e.g. \"mcp\"). Scopes are referenced as \"mcp/read\" in tokens."
  value       = aws_cognito_resource_server.mcp.identifier
}

output "interceptor_lambda_arn" {
  description = "Request interceptor Lambda ARN (injects Claims into the target invocation)."
  value       = aws_lambda_function.interceptor.arn
}

output "tool_names" {
  description = "MCP tool names exposed by the Gateway targets (ordered as declared)."
  value       = [for t in var.targets : t.tool_name]
}

output "target_ids" {
  description = "Gateway target ids, keyed by target name."
  value       = { for name, t in aws_bedrockagentcore_gateway_target.lambda_targets : name => t.target_id }
}
