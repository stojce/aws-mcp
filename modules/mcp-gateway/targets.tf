# ──────────────────────────────────────────────────────────────────────────────
# 4. Gateway targets: one per entry in var.targets, Lambda MCP type
# ──────────────────────────────────────────────────────────────────────────────

# The Gateway invokes each Lambda target under its own execution role. Per-user
# identity is NOT carried in the tool args; the interceptor (interceptor.tf)
# injects the four Claims into the request before the target runs.
resource "aws_bedrockagentcore_gateway_target" "lambda_targets" {
  for_each = { for t in var.targets : t.name => t }

  name               = each.key
  description        = each.value.description
  gateway_identifier = aws_bedrockagentcore_gateway.this.gateway_id

  # Interceptor-provided headers reach the target ONLY if allowlisted here
  # (AWS header-propagation docs); the interceptor value overrides any
  # client-supplied header of the same name.
  metadata_configuration {
    allowed_request_headers = ["x-mcp-claims", "x-mcp-claims-sig"]
  }

  credential_provider_configuration {
    gateway_iam_role {}
  }

  target_configuration {
    mcp {
      lambda {
        lambda_arn = each.value.lambda_arn

        tool_schema {
          inline_payload {
            name        = each.value.tool_name
            description = each.value.tool_description

            input_schema {
              type        = "object"
              description = "Arguments for ${each.value.tool_name}"

              dynamic "property" {
                for_each = jsondecode(each.value.input_schema).properties != null ? jsondecode(each.value.input_schema).properties : {}
                content {
                  name        = property.key
                  type        = property.value.type
                  description = lookup(property.value, "description", null)
                  required    = contains(try(jsondecode(each.value.input_schema).required, []), property.key)
                }
              }
            }

            dynamic "output_schema" {
              for_each = each.value.output_schema != null ? [each.value.output_schema] : []
              content {
                type = "object"
                description = "Result envelope"

                dynamic "property" {
                  for_each = jsondecode(output_schema.value).properties != null ? jsondecode(output_schema.value).properties : {}
                  content {
                    name        = property.key
                    type        = property.value.type
                    description = lookup(property.value, "description", null)
                    required    = contains(try(jsondecode(output_schema.value).required, []), property.key)
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  depends_on = [aws_iam_role_policy.invoke_targets]
}
