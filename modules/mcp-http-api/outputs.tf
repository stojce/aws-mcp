output "mcp_url" {
  description = "Public MCP endpoint (Streamable HTTP). Send Authorization: Bearer <access token> on every request."
  value       = local.mcp_url
}

output "resource_metadata_url" {
  description = "Public protected-resource metadata URL advertised by the MCP authentication challenge."
  value       = local.resource_metadata_url
}

output "authorization_server_issuer" {
  description = "Cognito issuer; its OpenID discovery document advertises the existing pool's OAuth endpoints."
  value       = local.cognito_issuer
}

output "mcp_app_client_id" {
  description = "MCP app client id. Tokens must come from this client (client_id claim); the Lambda rejects others."
  value       = aws_cognito_user_pool_client.mcp.id
}

output "required_scope" {
  description = "Scope the token must carry: <resource_server_identifier>/<scope_name>, e.g. mcp/read by default."
  value       = local.full_scope
}

output "mcp_resource_server_identifier" {
  description = "Identifier of the Cognito resource server owned by this module instance."
  value       = aws_cognito_resource_server.mcp.identifier
}

output "mcp_server_function_name" {
  value = aws_lambda_function.mcp.function_name
}

output "tool_names" {
  value = [for t in var.tools : t.name]
}
