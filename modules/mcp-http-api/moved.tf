# Preserve existing Cognito deployments when introducing optional external auth.
moved {
  from = aws_cognito_resource_server.mcp
  to   = aws_cognito_resource_server.mcp[0]
}

moved {
  from = aws_cognito_user_pool_client.mcp
  to   = aws_cognito_user_pool_client.mcp[0]
}

moved {
  from = aws_apigatewayv2_authorizer.cognito
  to   = aws_apigatewayv2_authorizer.jwt
}
