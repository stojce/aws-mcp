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

module "mcp" {
  for_each = toset(["bookings", "catalog"])
  source   = "../../.."

  name                       = "mcp-${each.key}"
  user_pool_id               = local.user_pool_id
  resource_server_identifier = "mcp-${each.key}"
  tool_backend_arn           = "arn:aws:lambda:eu-west-1:123456789012:function:${each.key}"
  server_name                = "${each.key}-mcp"
  callback_urls              = ["http://localhost:8080/callback"]
  tools                      = []
}

output "identifiers" {
  value = { for name, instance in module.mcp : name => instance.mcp_resource_server_identifier }
}

output "scopes" {
  value = { for name, instance in module.mcp : name => instance.required_scope }
}
