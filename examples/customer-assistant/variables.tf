variable "name" {
  description = "Deployment short name (e.g. guryou-stage2)."
  type        = string
}

variable "region" {
  type    = string
  default = "eu-west-1"
}

# From guryou-infra-terraform stage2: output id of the existing User Pool.
variable "user_pool_id" {
  type = string
}

# From guryou-infra-terraform stage2: invoke ARN of the existing Apollo
# graphql.ts Lambda (module.lambda_graphql.lambda_invoke_arn).
variable "gateway_lambda_target_arn" {
  type = string
}

variable "mcp_client_callback_url" {
  description = "Callback URL for the MCP app client's authorization-code flow (the consuming agent app's redirect)."
  type        = string
  default     = "http://localhost:8080/callback"
}

variable "mcp_client_logout_url" {
  type    = string
  default = "http://localhost:8080/"
}
