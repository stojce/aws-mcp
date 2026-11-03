output "mcp_url" {
  value = module.mcp.mcp_url
}

output "mcp_app_client_id" {
  value = module.mcp.mcp_app_client_id
}

output "required_scope" {
  value = module.mcp.required_scope
}

output "resource_metadata_url" {
  value = module.mcp.resource_metadata_url
}

output "authorization_server_issuer" {
  value = module.mcp.authorization_server_issuer
}

output "user_pool_id" {
  value = aws_cognito_user_pool.example.id
}

output "user_subs" {
  description = "Cognito sub per test user; used by the smoke test to assert ownership."
  value       = { for k, u in aws_cognito_user.test : k => u.sub }
}
