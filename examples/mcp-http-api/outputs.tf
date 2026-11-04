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

output "authorization_endpoint" {
  value = "https://${aws_cognito_user_pool_domain.example.domain}.auth.${var.region}.amazoncognito.com/oauth2/authorize"
}

output "token_endpoint" {
  value = "https://${aws_cognito_user_pool_domain.example.domain}.auth.${var.region}.amazoncognito.com/oauth2/token"
}

output "user_pool_id" {
  value = aws_cognito_user_pool.example.id
}

output "region" {
  value = var.region
}

output "account_id" {
  value = data.aws_caller_identity.current.account_id
}

output "callback_urls" {
  value = var.callback_urls
}

output "user_subs" {
  description = "Cognito sub per test user; used by the smoke test to assert ownership."
  value       = { for k, u in aws_cognito_user.test : k => u.sub }
}
