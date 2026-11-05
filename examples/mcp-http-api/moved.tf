# The MCP module's historical resource moves lead to this former module address.
# Move that state to the independently composed Cognito module.
moved {
  from = module.mcp.module.cognito[0]
  to   = module.cognito
}
