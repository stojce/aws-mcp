mock_provider "aws" {
  mock_data "aws_region" {
    defaults = { region = "eu-west-1" }
  }
}

variables {
  name          = "mcp-cognito-test"
  user_pool_id  = "eu-west-1_shared"
  mcp_url       = "https://mcp.example.cloudfront.net/mcp"
  callback_urls = ["http://localhost:8080/callback"]
  logout_urls   = ["http://localhost:8080/logout"]
}

run "public_client_rotates_refresh_tokens" {
  command = apply

  assert {
    condition = (
      !aws_cognito_user_pool_client.mcp.generate_secret &&
      aws_cognito_user_pool_client.mcp.enable_token_revocation &&
      length(aws_cognito_user_pool_client.mcp.refresh_token_rotation) == 1 &&
      try(aws_cognito_user_pool_client.mcp.refresh_token_rotation[0].feature, "") == "ENABLED" &&
      try(aws_cognito_user_pool_client.mcp.refresh_token_rotation[0].retry_grace_period_seconds, -1) == 5 &&
      !contains(aws_cognito_user_pool_client.mcp.explicit_auth_flows, "ALLOW_REFRESH_TOKEN_AUTH") &&
      !contains(aws_cognito_user_pool_client.mcp.explicit_auth_flows, "ALLOW_USER_PASSWORD_AUTH")
    )
    error_message = "The public OAuth client must rotate refresh tokens without re-enabling password or legacy refresh authentication."
  }
}

run "sandbox_password_auth_keeps_rotation" {
  command = apply
  variables {
    enable_password_auth_for_tests = true
  }
  assert {
    condition = (
      contains(aws_cognito_user_pool_client.mcp.explicit_auth_flows, "ALLOW_USER_PASSWORD_AUTH") &&
      !contains(aws_cognito_user_pool_client.mcp.explicit_auth_flows, "ALLOW_REFRESH_TOKEN_AUTH") &&
      try(aws_cognito_user_pool_client.mcp.refresh_token_rotation[0].feature, "") == "ENABLED"
    )
    error_message = "Test password authentication must remain opt-in and compatible with refresh-token rotation."
  }
}

run "client_registration_and_scope_match_the_resource" {
  command = apply

  assert {
    condition = (
      aws_cognito_resource_server.mcp.user_pool_id == var.user_pool_id &&
      aws_cognito_resource_server.mcp.identifier == var.mcp_url &&
      aws_cognito_user_pool_client.mcp.user_pool_id == var.user_pool_id &&
      aws_cognito_user_pool_client.mcp.callback_urls == toset(var.callback_urls) &&
      aws_cognito_user_pool_client.mcp.logout_urls == toset(var.logout_urls) &&
      aws_cognito_user_pool_client.mcp.allowed_oauth_flows == toset(["code"]) &&
      aws_cognito_user_pool_client.mcp.allowed_oauth_flows_user_pool_client &&
      aws_cognito_user_pool_client.mcp.allowed_oauth_scopes == toset(["openid", "email", "${var.mcp_url}/read"]) &&
      output.required_scope == "${var.mcp_url}/read" &&
      output.issuer == "https://cognito-idp.eu-west-1.amazonaws.com/${var.user_pool_id}" &&
      output.authorization_server == {
        issuer                     = output.issuer
        client_id                  = output.client_id
        required_scope             = output.required_scope
        resource_server_identifier = output.resource_server_identifier
      }
    )
    error_message = "The public code-flow client must register the supplied callbacks and use the resource-bound scope in the existing pool."
  }
}

run "legacy_custom_scope_reaches_the_client" {
  command = apply
  variables {
    resource_server_identifier  = "mcp-bookings"
    scope_name                  = "bookings.read"
    allow_unbound_access_tokens = true
  }
  assert {
    condition = (
      output.resource_server_identifier == "mcp-bookings" &&
      output.required_scope == "mcp-bookings/bookings.read" &&
      aws_cognito_user_pool_client.mcp.allowed_oauth_scopes == toset(["openid", "email", output.required_scope])
    )
    error_message = "Legacy compatibility must use the configured identifier and scope on the client."
  }
}

run "legacy_short_identifier_requires_explicit_compatibility" {
  command = plan
  variables {
    resource_server_identifier = "mcp"
  }
  expect_failures = [aws_cognito_resource_server.mcp]
}

run "different_resource_url_is_rejected_in_strict_mode" {
  command = plan
  variables {
    resource_server_identifier = "https://different.example.com/mcp"
  }
  expect_failures = [aws_cognito_resource_server.mcp]
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

run "empty_callback_registration_is_rejected" {
  command = plan
  variables { callback_urls = [] }
  expect_failures = [var.callback_urls]
}

run "empty_user_pool_is_rejected" {
  command = plan
  variables { user_pool_id = "" }
  expect_failures = [var.user_pool_id]
}
