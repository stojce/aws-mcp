output "issuer" {
  description = "Cognito issuer trusted by the MCP JWT authorizer."
  value       = "https://cognito-idp.${data.aws_region.current.region}.amazonaws.com/${var.user_pool_id}"
}

output "client_id" {
  description = "Dedicated public MCP app client ID."
  value       = aws_cognito_user_pool_client.mcp.id
}

output "resource_server_identifier" {
  description = "Identifier of the resource server owned by this module."
  value       = aws_cognito_resource_server.mcp.identifier
}

output "required_scope" {
  description = "Fully qualified MCP OAuth scope."
  value       = local.full_scope
}

output "authorization_server" {
  description = "Cognito configuration for the mcp-http-api module's cognito_authorization_server input."
  value = {
    issuer                     = "https://cognito-idp.${data.aws_region.current.region}.amazonaws.com/${var.user_pool_id}"
    client_id                  = aws_cognito_user_pool_client.mcp.id
    required_scope             = local.full_scope
    resource_server_identifier = aws_cognito_resource_server.mcp.identifier
  }
}
