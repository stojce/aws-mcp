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
  name             = "mcp-resource-server-test"
  user_pool_id     = "eu-west-1_shared"
  tool_backend_arn = "arn:aws:lambda:eu-west-1:123456789012:function:backend"
  server_name      = "resource-server-test"
  callback_urls    = ["http://localhost:8080/callback"]
  tools            = []
}

run "default_identifier_is_compatible" {
  command = apply

  assert {
    condition     = aws_cognito_resource_server.mcp.identifier == "mcp" && output.required_scope == "mcp/read"
    error_message = "Existing deployments must retain the mcp resource server and mcp/read scope by default."
  }
}

run "custom_identifier_reaches_every_scope_consumer" {
  command = apply

  variables {
    resource_server_identifier = "https://bookings.example.com"
    scope_name                 = "bookings.read"
  }

  assert {
    condition = (
      aws_cognito_resource_server.mcp.identifier == "https://bookings.example.com" &&
      aws_cognito_resource_server.mcp.user_pool_id == "eu-west-1_shared" &&
      output.required_scope == "https://bookings.example.com/bookings.read"
    )
    error_message = "The configured identifier must determine the resource server and fully qualified scope."
  }

  assert {
    condition = (
      contains(aws_cognito_user_pool_client.mcp.allowed_oauth_scopes, output.required_scope) &&
      !contains(aws_cognito_user_pool_client.mcp.allowed_oauth_scopes, "mcp/bookings.read") &&
      aws_apigatewayv2_route.mcp.authorization_type == "JWT" &&
      aws_apigatewayv2_route.mcp.authorization_scopes == toset([output.required_scope]) &&
      aws_lambda_function.mcp.environment[0].variables.MCP_REQUIRED_SCOPE == output.required_scope
    )
    error_message = "The client, JWT route, and Lambda must agree on the custom scope without granting the default scope."
  }

  assert {
    condition = (
      one(aws_cloudfront_response_headers_policy.discovery.custom_headers_config[0].items).value ==
      "Bearer resource_metadata=\"${output.resource_metadata_url}\", scope=\"${output.required_scope}\""
    )
    error_message = "OAuth discovery must advertise the same custom scope enforced by the endpoint."
  }
}

run "distinct_instances_share_a_pool_with_a_gateway_owner" {
  command = apply

  module {
    source = "./tests/fixtures/shared-pool"
  }

  assert {
    condition = (
      aws_cognito_resource_server.gateway.identifier == "mcp" &&
      aws_cognito_resource_server.gateway.user_pool_id == "eu-west-1_shared" &&
      output.identifiers == { bookings = "mcp-bookings", catalog = "mcp-catalog" } &&
      length(distinct(concat([aws_cognito_resource_server.gateway.identifier], values(output.identifiers)))) == 3
    )
    error_message = "Two HTTP API instances must own distinct identifiers in the pool where the gateway already owns mcp."
  }

  assert {
    condition     = output.scopes == { bookings = "mcp-bookings/read", catalog = "mcp-catalog/read" }
    error_message = "Shared-pool instances must advertise their own fully qualified scopes."
  }
}

run "empty_identifier_is_rejected" {
  command = plan
  variables {
    resource_server_identifier = ""
  }
  expect_failures = [var.resource_server_identifier]
}

run "identifier_with_spaces_is_rejected" {
  command = plan
  variables {
    resource_server_identifier = "mcp bookings"
  }
  expect_failures = [var.resource_server_identifier]
}

run "identifier_with_quotes_is_rejected" {
  command = plan
  variables {
    resource_server_identifier = "mcp\"bookings"
  }
  expect_failures = [var.resource_server_identifier]
}

run "identifier_with_backslashes_is_rejected" {
  command = plan
  variables {
    resource_server_identifier = "mcp\\bookings"
  }
  expect_failures = [var.resource_server_identifier]
}

run "overlong_identifier_is_rejected" {
  command = plan
  variables {
    resource_server_identifier = join("", [for i in range(257) : "a"])
  }
  expect_failures = [var.resource_server_identifier]
}
