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

# Historical extraction address. The caller moves this former module instance
# to its separately composed Cognito module; see examples/mcp-http-api/moved.tf.
moved {
  from = aws_cognito_resource_server.mcp[0]
  to   = module.cognito[0].aws_cognito_resource_server.mcp
}

moved {
  from = aws_cognito_user_pool_client.mcp[0]
  to   = module.cognito[0].aws_cognito_user_pool_client.mcp
}
