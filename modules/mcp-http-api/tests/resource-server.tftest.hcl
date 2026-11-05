mock_provider "aws" {
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::123456789012:role/mcp-test" }
  }

  mock_resource "aws_cloudwatch_log_group" {
    defaults = { arn = "arn:aws:logs:eu-west-1:123456789012:log-group:/aws/mcp-test" }
  }

  mock_resource "aws_apigatewayv2_api" {
    defaults = {
      api_endpoint  = "https://api.example.com"
      execution_arn = "arn:aws:execute-api:eu-west-1:123456789012:testapi"
    }
  }

  mock_resource "aws_cloudfront_distribution" {
    defaults = { domain_name = "mcp.example.cloudfront.net" }
  }

  mock_data "aws_region" {
    defaults = { region = "eu-west-1" }
  }
}

mock_provider "archive" {}

variables {
  name = "mcp-resource-server-test"
  cognito_authorization_server = {
    issuer                     = "https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_shared"
    client_id                  = "mcp-client"
    required_scope             = "https://mcp.example.cloudfront.net/mcp/read"
    resource_server_identifier = "https://mcp.example.cloudfront.net/mcp"
  }
  tool_backend_arn = "arn:aws:lambda:eu-west-1:123456789012:function:backend"
  server_name      = "resource-server-test"
  tools            = []
}

run "default_identifier_matches_the_bound_resource" {
  command = apply

  assert {
    condition = (
      output.mcp_resource_server_identifier == output.mcp_url &&
      output.authorization_server_issuer == "https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_shared" &&
      aws_apigatewayv2_authorizer.jwt.jwt_configuration[0].issuer == output.authorization_server_issuer &&
      output.mcp_app_client_id == var.cognito_authorization_server.client_id &&
      aws_lambda_function.mcp.environment[0].variables.MCP_CLIENT_ID == output.mcp_app_client_id &&
      output.required_scope == "${output.mcp_url}/read" &&
      aws_apigatewayv2_route.mcp.authorization_scopes == toset([output.required_scope]) &&
      aws_lambda_function.mcp.environment[0].variables.MCP_REQUIRED_SCOPE == output.required_scope
    )
    error_message = "Every scope consumer must use the supplied Cognito configuration for the canonical resource URL."
  }
}

run "custom_identifier_reaches_every_scope_consumer" {
  command = apply

  variables {
    cognito_authorization_server = {
      issuer                     = "https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_shared"
      client_id                  = "bookings-client"
      required_scope             = "https://bookings.example.com/bookings.read"
      resource_server_identifier = "https://bookings.example.com"
    }
    allow_unbound_access_tokens = true
  }

  assert {
    condition = (
      output.mcp_resource_server_identifier == "https://bookings.example.com" &&
      output.required_scope == "https://bookings.example.com/bookings.read"
    )
    error_message = "The module outputs must retain the supplied resource-server identifier and scope."
  }

  assert {
    condition = (
      aws_apigatewayv2_route.mcp.authorization_type == "JWT" &&
      aws_apigatewayv2_route.mcp.authorization_scopes == toset([output.required_scope]) &&
      aws_lambda_function.mcp.environment[0].variables.MCP_REQUIRED_SCOPE == output.required_scope
    )
    error_message = "The JWT route and Lambda must enforce the scope supplied by the Cognito module."
  }

  assert {
    condition = (
      one(aws_cloudfront_response_headers_policy.discovery.custom_headers_config[0].items).value ==
      "Bearer resource_metadata=\"${output.resource_metadata_url}\""
    )
    error_message = "The authentication challenge must link to metadata without depending on the URL-derived scope."
  }
}

run "distinct_instances_share_a_pool_with_a_gateway_owner" {
  command = apply

  module {
    source = "./tests/fixtures/shared-pool"
  }

  override_resource {
    target = module.bookings.aws_cloudfront_distribution.mcp
    values = { domain_name = "bookings.example.cloudfront.net" }
  }

  override_resource {
    target = module.catalog.aws_cloudfront_distribution.mcp
    values = { domain_name = "catalog.example.cloudfront.net" }
  }

  assert {
    condition = (
      aws_cognito_resource_server.gateway.identifier == "mcp" &&
      aws_cognito_resource_server.gateway.user_pool_id == "eu-west-1_shared" &&
      output.identifiers == { bookings = "https://bookings.example.cloudfront.net/mcp", catalog = "https://catalog.example.cloudfront.net/mcp" } &&
      length(distinct(concat([aws_cognito_resource_server.gateway.identifier], values(output.identifiers)))) == 3
    )
    error_message = "Two HTTP API instances must own distinct identifiers in the pool where the gateway already owns mcp."
  }

  assert {
    condition     = output.scopes == { bookings = "https://bookings.example.cloudfront.net/mcp/read", catalog = "https://catalog.example.cloudfront.net/mcp/read" }
    error_message = "Shared-pool instances must advertise their own fully qualified scopes."
  }
}
