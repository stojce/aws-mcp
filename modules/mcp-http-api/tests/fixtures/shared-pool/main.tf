locals {
  user_pool_id = "eu-west-1_shared"
}

# Represents the resource server already owned by the sibling gateway module.
resource "aws_cognito_resource_server" "gateway" {
  identifier   = "mcp"
  name         = "existing-gateway-mcp"
  user_pool_id = local.user_pool_id

  scope {
    scope_name        = "read"
    scope_description = "Read-only gateway access"
  }
}

module "bookings_cognito" {
  source = "../../../../cognito"

  name          = "mcp-bookings"
  user_pool_id  = local.user_pool_id
  mcp_url       = module.bookings.mcp_url
  callback_urls = ["http://localhost:8080/callback"]
}

module "bookings" {
  source = "../../.."

  name                         = "mcp-bookings"
  cognito_authorization_server = module.bookings_cognito.authorization_server
  tool_backend_arn             = "arn:aws:lambda:eu-west-1:123456789012:function:bookings"
  server_name                  = "bookings-mcp"
  tools                        = []
}

module "catalog_cognito" {
  source = "../../../../cognito"

  name          = "mcp-catalog"
  user_pool_id  = local.user_pool_id
  mcp_url       = module.catalog.mcp_url
  callback_urls = ["http://localhost:8080/callback"]
}

module "catalog" {
  source = "../../.."

  name                         = "mcp-catalog"
  cognito_authorization_server = module.catalog_cognito.authorization_server
  tool_backend_arn             = "arn:aws:lambda:eu-west-1:123456789012:function:catalog"
  server_name                  = "catalog-mcp"
  tools                        = []
}

output "identifiers" {
  value = {
    bookings = module.bookings.mcp_resource_server_identifier
    catalog  = module.catalog.mcp_resource_server_identifier
  }
}

output "scopes" {
  value = {
    bookings = module.bookings.required_scope
    catalog  = module.catalog.required_scope
  }
}
