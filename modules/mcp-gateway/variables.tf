variable "name" {
  description = "Application short name used in every resource name (e.g. \"guryou-stage2\")."
  type        = string
}

variable "region" {
  description = "AWS region. The existing stack runs in eu-west-1; AgentCore Gateway is available there."
  type        = string
  default     = "eu-west-1"
}

variable "user_pool_id" {
  description = "Existing Cognito User Pool id. The module never creates the pool; it is owned by guryou-infra-terraform."
  type        = string
}

variable "gateway_lambda_target_arn" {
  description = "ARN of the existing Apollo graphql.ts Lambda, invoked as the Gateway's Lambda target."
  type        = string
  default     = null
}

variable "web_client_callback_url" {
  description = "The MCP app client is an authorization-code (+PKCE) confidential client; the consuming agent app registers its callback here."
  type        = string
  default     = "http://localhost:8080/callback"
}

variable "web_client_logout_url" {
  description = "Logout URL for the MCP app client."
  type        = string
  default     = "http://localhost:8080/"
}

# v1 tool list (ticket 10, verified against the real proxy schema):
#   getMyBookedEvents → user bookings/subscriptions/reservations
#   getMyMemberships  → active user memberships
# Schema per tool is the Gateway toolSchema, hand-derived from the GraphQL op.
variable "targets" {
  description = "Gateway targets. Each entry: { name, description, lambda_arn, tool_name, tool_description, input_schema, output_schema }. The credential_provider_arn hook for a future HTTP/OpenAPI pivot is reserved in the module's target resource; leave unused at v1."
  type = list(object({
    name             = string
    description      = optional(string)
    lambda_arn       = string
    tool_name        = string
    tool_description = string
    input_schema     = string # JSON-encoded JSON-Schema object
    output_schema    = optional(string)
  }))
  default = []
}

locals {
  scope_prefix   = "mcp"
  gateway_name   = "${var.name}-mcp-gateway"
  client_name    = "${var.name}-mcp-app-client"
  resource_server_name = "${var.name}-mcp"
}
