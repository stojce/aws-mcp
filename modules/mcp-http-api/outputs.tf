output "mcp_url" {
  description = "Public MCP endpoint (Streamable HTTP). Send Authorization: Bearer <access token> on every request."
  value       = local.mcp_url
}

output "resource_metadata_url" {
  description = "Public protected-resource metadata URL advertised by the MCP authentication challenge."
  value       = local.resource_metadata_url
}

output "authorization_server_issuer" {
  description = "Configured OAuth/OIDC issuer, advertised in protected-resource metadata."
  value       = local.authorization_issuer
}

output "mcp_app_client_id" {
  description = "Dedicated MCP client ID, created in Cognito or supplied for the external server. The Lambda pins the configured client claim to it."
  value       = local.mcp_client_id
}

output "required_scope" {
  description = "Required OAuth scope: supplied by the external authorization server, or <resource_server_identifier>/<scope_name> in Cognito mode (defaults to <mcp_url>/read)."
  value       = local.full_scope
}

output "mcp_resource_server_identifier" {
  description = "Identifier of the Cognito resource server owned by this module instance; null in external authorization mode."
  value       = var.external_authorization_server == null ? aws_cognito_resource_server.mcp[0].identifier : null
}

output "authorization_mode" {
  description = "cognito or external; use this with the smoke client's --authorization-mode option."
  value       = local.authorization_mode
}

output "client_id_claim" {
  description = "Verified access-token claim used to identify the MCP client."
  value       = local.client_id_claim
}

output "mcp_server_function_name" {
  value = aws_lambda_function.mcp.function_name
}

output "tool_names" {
  value = [for t in var.tools : t.name]
}
