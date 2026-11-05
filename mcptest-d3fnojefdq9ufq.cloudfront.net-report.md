# mcptest Evaluation Report

- Schema: 2.0.0
- Generated: 2026-11-05T12:42:03.755Z
- Generator: mcptest 1.0.0 (0401f688eaa0689efa1d1bac9e35b4dbfd062585)
- Tested endpoint: https://d3fnojefdq9ufq.cloudfront.net/mcp

## Outcome

**scored** — The evaluation completed and was scored.

## Score

86 / 110 (78.18%)

## Endpoint and provenance

- Tested endpoint: https://d3fnojefdq9ufq.cloudfront.net/mcp
- Negotiated endpoint: https://d3fnojefdq9ufq.cloudfront.net/mcp
- Route: authenticated-proxy
- Proxy used: yes

## Protocol and transport

- Protocol era: modern
- Protocol version: 2026-07-28
- Transport: streamable-http

## Capabilities provided

Observed 2026-11-05T12:41:55.881Z at https://d3fnojefdq9ufq.cloudfront.net/mcp via authenticated-proxy; authenticated.

### Tools

Complete discovery: 1 retained of 1 observed.

- get\_my\_bookings — List the signed-in user's bookings. Optionally filter by status. (status: string (optional))

### Resources

This discovery method is unsupported.

This discovery method is unsupported.

### Resource templates

This discovery method is unsupported.

This discovery method is unsupported.

### Prompts

This discovery method is unsupported.

This discovery method is unsupported.

## Timings

- Connection setup (endpoint selection through MCP negotiation): 554 ms
- tools/list: 191 ms

## Release readiness

**review** — Review before shipping

No confirmed blocker was found, but caveats or unknowns still need a release-owner decision.

- [medium] Inputs accept unconstrained values (Tool surface)
  - Id: tool.schema.unconstrained-inputs
  - 0 strings and 1 objects lack structural constraints.
  - Remediation: Add enums, formats, patterns, length limits, declared properties, and additionalProperties: false where the contract permits.
- [unknown] Session behavior is unknown (chatgpt) (Host compatibility)
  - Id: chatgpt.protocol.session-behavior
  - The observations do not establish whether requests require server-held session state.
  - Remediation: Record whether the server issues or requires an MCP session identifier.
- [unknown] OAuth client registration is unknown (chatgpt) (Host compatibility)
  - Id: chatgpt.authorization.oauth.registration
  - The authorization server registration modes were not observed.
  - Remediation: Inspect registration\_endpoint and client\_id\_metadata\_document\_supported in OAuth metadata.
- [unknown] Token refresh is unknown (chatgpt) (Host compatibility)
  - Id: chatgpt.authorization.oauth.refresh-tokens
  - This does not block initial authorization, but session longevity is unverified.
  - Remediation: Confirm refresh\_token issuance and refresh-token grant support.
- [unknown] OAuth redirect compatibility is unknown (chatgpt) (Host compatibility)
  - Id: chatgpt.authorization.oauth.redirects
  - ChatGPT's callback URI depends on how the server is connected, so it cannot be compared with the authorization server's exact-match policy.
  - Remediation: Compare the callback URI ChatGPT shows for this server with the registered redirect URIs.
- [unknown] Capability support is not material (chatgpt) (Host compatibility)
  - Id: chatgpt.capabilities.tasks
  - tasks was not conclusively observed.
  - Remediation: Collect the missing observation and rerun the report.
- [unknown] Session scaling behavior is unknown (chatgpt) (Host compatibility)
  - Id: chatgpt.protocol.stateful-scaling-caveat
  - Statefulness was not established.
  - Remediation: Collect the missing observation and rerun the report.
- [unknown] Session behavior is unknown (claude) (Host compatibility)
  - Id: claude.protocol.session-behavior
  - The observations do not establish whether requests require server-held session state.
  - Remediation: Record whether the server issues or requires an MCP session identifier.
- [unknown] OAuth client registration is unknown (claude) (Host compatibility)
  - Id: claude.authorization.oauth.registration
  - The authorization server registration modes were not observed.
  - Remediation: Inspect registration\_endpoint and client\_id\_metadata\_document\_supported in OAuth metadata.
- [unknown] Token refresh is unknown (claude) (Host compatibility)
  - Id: claude.authorization.oauth.refresh-tokens
  - This does not block initial authorization, but session longevity is unverified.
  - Remediation: Confirm refresh\_token issuance and refresh-token grant support.
- [unknown] OAuth redirect compatibility is unknown (claude) (Host compatibility)
  - Id: claude.authorization.oauth.redirects
  - The available redirect evidence does not establish whether the authorization server accepts the host callback URI.
  - Remediation: Record accepted redirect URI classes or the exact registered callbacks.
- [unknown] Capability support is not material (claude) (Host compatibility)
  - Id: claude.capabilities.tasks
  - tasks was not conclusively observed.
  - Remediation: Collect the missing observation and rerun the report.
- [unknown] Session behavior is unknown (cursor) (Host compatibility)
  - Id: cursor.protocol.session-behavior
  - The observations do not establish whether requests require server-held session state.
  - Remediation: Record whether the server issues or requires an MCP session identifier.
- [unknown] OAuth client registration is unknown (cursor) (Host compatibility)
  - Id: cursor.authorization.oauth.registration
  - The authorization server registration modes were not observed.
  - Remediation: Inspect registration\_endpoint and client\_id\_metadata\_document\_supported in OAuth metadata.
- [unknown] Token refresh is unknown (cursor) (Host compatibility)
  - Id: cursor.authorization.oauth.refresh-tokens
  - This does not block initial authorization, but session longevity is unverified.
  - Remediation: Confirm refresh\_token issuance and refresh-token grant support.
- [unknown] OAuth redirect compatibility is unknown (cursor) (Host compatibility)
  - Id: cursor.authorization.oauth.redirects
  - The available redirect evidence does not establish whether the authorization server accepts the host callback URI.
  - Remediation: Record accepted redirect URI classes or the exact registered callbacks.
- [unknown] Capability support is not material (cursor) (Host compatibility)
  - Id: cursor.capabilities.tasks
  - tasks was not conclusively observed.
  - Remediation: Collect the missing observation and rerun the report.
- [unknown] Session behavior is unknown (vscode-copilot) (Host compatibility)
  - Id: vscode-copilot.protocol.session-behavior
  - The observations do not establish whether requests require server-held session state.
  - Remediation: Record whether the server issues or requires an MCP session identifier.
- [unknown] OAuth client registration is unknown (vscode-copilot) (Host compatibility)
  - Id: vscode-copilot.authorization.oauth.registration
  - The authorization server registration modes were not observed.
  - Remediation: Inspect registration\_endpoint and client\_id\_metadata\_document\_supported in OAuth metadata.
- [unknown] Token refresh is unknown (vscode-copilot) (Host compatibility)
  - Id: vscode-copilot.authorization.oauth.refresh-tokens
  - This does not block initial authorization, but session longevity is unverified.
  - Remediation: Confirm refresh\_token issuance and refresh-token grant support.
- [unknown] OAuth redirect compatibility is unknown (vscode-copilot) (Host compatibility)
  - Id: vscode-copilot.authorization.oauth.redirects
  - The available redirect evidence does not establish whether the authorization server accepts the host callback URI.
  - Remediation: Record accepted redirect URI classes or the exact registered callbacks.
- [unknown] Capability support is not material (vscode-copilot) (Host compatibility)
  - Id: vscode-copilot.capabilities.tasks
  - tasks was not conclusively observed.
  - Remediation: Collect the missing observation and rerun the report.
- [unknown] Session behavior is unknown (generic-sdk) (Host compatibility)
  - Id: generic-sdk.protocol.session-behavior
  - The observations do not establish whether requests require server-held session state.
  - Remediation: Record whether the server issues or requires an MCP session identifier.
- [unknown] OAuth client registration is unknown (generic-sdk) (Host compatibility)
  - Id: generic-sdk.authorization.oauth.registration
  - The authorization server registration modes were not observed.
  - Remediation: Inspect registration\_endpoint and client\_id\_metadata\_document\_supported in OAuth metadata.
- [unknown] Token refresh is unknown (generic-sdk) (Host compatibility)
  - Id: generic-sdk.authorization.oauth.refresh-tokens
  - This does not block initial authorization, but session longevity is unverified.
  - Remediation: Confirm refresh\_token issuance and refresh-token grant support.
- [unknown] OAuth redirect compatibility is unknown (generic-sdk) (Host compatibility)
  - Id: generic-sdk.authorization.oauth.redirects
  - No verified Generic MCP SDK callback URI is available to compare with the authorization server's exact-match policy.
  - Remediation: Verify Generic MCP SDK's exact callback URI and compare it with the registered redirect URIs.
- [unknown] Capability support is not material (generic-sdk) (Host compatibility)
  - Id: generic-sdk.capabilities.tasks
  - tasks was not conclusively observed.
  - Remediation: Collect the missing observation and rerun the report.

## Host compatibility

- chatgpt: unknown
  - Session behavior is unknown: The observations do not establish whether requests require server-held session state.
    - Remediation: Record whether the server issues or requires an MCP session identifier.
  - OAuth client registration is unknown: The authorization server registration modes were not observed.
    - Remediation: Inspect registration\_endpoint and client\_id\_metadata\_document\_supported in OAuth metadata.
  - Token refresh is unknown: This does not block initial authorization, but session longevity is unverified.
    - Remediation: Confirm refresh\_token issuance and refresh-token grant support.
  - OAuth redirect compatibility is unknown: ChatGPT's callback URI depends on how the server is connected, so it cannot be compared with the authorization server's exact-match policy.
    - Remediation: Compare the callback URI ChatGPT shows for this server with the registered redirect URIs.
  - Capability support is not material: resourceSubscriptions was not conclusively observed.
  - Capability support is not material: sampling was not conclusively observed.
  - Capability support is not material: tasks was not conclusively observed.
  - Session scaling behavior is unknown: Statefulness was not established.
- claude: unknown
  - Session behavior is unknown: The observations do not establish whether requests require server-held session state.
    - Remediation: Record whether the server issues or requires an MCP session identifier.
  - OAuth client registration is unknown: The authorization server registration modes were not observed.
    - Remediation: Inspect registration\_endpoint and client\_id\_metadata\_document\_supported in OAuth metadata.
  - Token refresh is unknown: This does not block initial authorization, but session longevity is unverified.
    - Remediation: Confirm refresh\_token issuance and refresh-token grant support.
  - OAuth redirect compatibility is unknown: The available redirect evidence does not establish whether the authorization server accepts the host callback URI.
    - Remediation: Record accepted redirect URI classes or the exact registered callbacks.
  - Capability support is not material: resourceSubscriptions was not conclusively observed.
  - Capability support is not material: sampling was not conclusively observed.
  - Capability support is not material: elicitation was not conclusively observed.
  - Capability support is not material: tasks was not conclusively observed.
- cursor: unknown
  - Session behavior is unknown: The observations do not establish whether requests require server-held session state.
    - Remediation: Record whether the server issues or requires an MCP session identifier.
  - OAuth client registration is unknown: The authorization server registration modes were not observed.
    - Remediation: Inspect registration\_endpoint and client\_id\_metadata\_document\_supported in OAuth metadata.
  - Token refresh is unknown: This does not block initial authorization, but session longevity is unverified.
    - Remediation: Confirm refresh\_token issuance and refresh-token grant support.
  - OAuth redirect compatibility is unknown: The available redirect evidence does not establish whether the authorization server accepts the host callback URI.
    - Remediation: Record accepted redirect URI classes or the exact registered callbacks.
  - Capability support is not material: resourceSubscriptions was not conclusively observed.
  - Capability support is not material: sampling was not conclusively observed.
  - Capability support is not material: tasks was not conclusively observed.
- generic-sdk: unknown
  - Session behavior is unknown: The observations do not establish whether requests require server-held session state.
    - Remediation: Record whether the server issues or requires an MCP session identifier.
  - OAuth client registration is unknown: The authorization server registration modes were not observed.
    - Remediation: Inspect registration\_endpoint and client\_id\_metadata\_document\_supported in OAuth metadata.
  - Token refresh is unknown: This does not block initial authorization, but session longevity is unverified.
    - Remediation: Confirm refresh\_token issuance and refresh-token grant support.
  - OAuth redirect compatibility is unknown: No verified Generic MCP SDK callback URI is available to compare with the authorization server's exact-match policy.
    - Remediation: Verify Generic MCP SDK's exact callback URI and compare it with the registered redirect URIs.
  - Capability support is not material: tasks was not conclusively observed.
  - Browser runtimes need CORS access: Node-based SDK clients can connect, but browser-based SDK clients need an allowed origin or a trusted backend proxy.
    - Remediation: Allow the intended browser origin and MCP request headers, or connect from a server-side runtime.
- vscode-copilot: unknown
  - Session behavior is unknown: The observations do not establish whether requests require server-held session state.
    - Remediation: Record whether the server issues or requires an MCP session identifier.
  - OAuth client registration is unknown: The authorization server registration modes were not observed.
    - Remediation: Inspect registration\_endpoint and client\_id\_metadata\_document\_supported in OAuth metadata.
  - Token refresh is unknown: This does not block initial authorization, but session longevity is unverified.
    - Remediation: Confirm refresh\_token issuance and refresh-token grant support.
  - OAuth redirect compatibility is unknown: The available redirect evidence does not establish whether the authorization server accepts the host callback URI.
    - Remediation: Record accepted redirect URI classes or the exact registered callbacks.
  - Capability support is not material: tasks was not conclusively observed.

## Tool surface analysis

- Tools: 1
- Resources: 0
- Prompts: 0
- Estimated context tokens: 60
- Fingerprint: fnv1a-64-v1:32ac67e9c36435a3

- [medium] Inputs accept unconstrained values
  - 0 strings and 1 objects lack structural constraints.
  - Remediation: Add enums, formats, patterns, length limits, declared properties, and additionalProperties: false where the contract permits.
- [low] Input properties lack descriptions
  - 1 of 1 declared properties have no description.
  - Remediation: Document the meaning, accepted units or format, and effect of each input property.

## Sections

### Core Protocol Adherence

Status: evaluated

Score: 15 / 15

Validates MCP lifecycle and JSON-RPC negotiation

- ✓ Negotiated the stateless server/discover lifecycle
  - Context: The server accepted MCP 2026 self-describing requests without a transport session.
  - Metadata:

    ```json
    {
      "authorizationCredentialProvenance": "[REDACTED]",
      "authorizationSchemes": "[REDACTED]",
      "endpoint": "https://d3fnojefdq9ufq.cloudfront.net/mcp",
      "evaluationRuntime": "browser",
      "protocolEra": "modern",
      "protocolVersion": "2026-07-28",
      "route": "authenticated proxy"
    }
    ```
- ✓ JSON-RPC messages passed official SDK validation
  - Context: Successful SDK negotiation verifies the JSON-RPC envelope and lifecycle response schemas.

### MCP Capabilities

Status: evaluated

Score: 4 / 10

Exercises standardized tools, resources, resource templates, and prompts discovery methods

- ✓ tools/list succeeded (1 tools)
  - Context: The server implements the standard tools discovery method, including valid empty lists.
  - Metadata:

    ```json
    {
      "durationMs": 191,
      "itemCount": 1,
      "method": "tools/list"
    }
    ```
- ⚠ resources/templates/list is not supported
  - Context: resourceTemplates are optional; the server correctly returned method-not-found.
  - Metadata:

    ```json
    {
      "error": "Error POSTing to endpoint: {\"error\":{\"code\":\"[REDACTED]\",\"message\":\"method not found: resources/templates/list\"},\"id\":1,\"jsonrpc\":\"2.0\"}",
      "method": "resources/templates/list"
    }
    ```
- ⚠ resources/list is not supported
  - Context: resources are optional; the server correctly returned method-not-found.
  - Metadata:

    ```json
    {
      "error": "Error POSTing to endpoint: {\"error\":{\"code\":\"[REDACTED]\",\"message\":\"method not found: resources/list\"},\"id\":2,\"jsonrpc\":\"2.0\"}",
      "method": "resources/list"
    }
    ```
- ⚠ prompts/list is not supported
  - Context: prompts are optional; the server correctly returned method-not-found.
  - Metadata:

    ```json
    {
      "error": "Error POSTing to endpoint: {\"error\":{\"code\":\"[REDACTED]\",\"message\":\"method not found: prompts/list\"},\"id\":3,\"jsonrpc\":\"2.0\"}",
      "method": "prompts/list"
    }
    ```
- ℹ 2 playground tool calls recorded, 0 failures
  - Context: Counted from the recent tool calls this browser keeps for this server; call contents are not included.
  - Metadata:

    ```json
    {
      "playgroundCallFailures": 0,
      "playgroundCalls": 2
    }
    ```

### Transport Layer Modernity

Status: evaluated

Score: 15 / 15

Identifies Streamable HTTP or deprecated HTTP+SSE

- ✓ Streamable HTTP negotiated successfully
  - Context: Streamable HTTP uses POST with JSON or per-request SSE responses and supports both MCP lifecycle eras.
  - Metadata:

    ```json
    {
      "endpoint": "https://d3fnojefdq9ufq.cloudfront.net/mcp",
      "protocolEra": "modern",
      "transportType": "streamable-http"
    }
    ```
- ℹ Check not performed: Browser cannot read Mcp-Session-Id (Access-Control-Expose-Headers missing) ([transport.cors-expose-headers-missing](https://mcptest.io/learn/mcp-transport-diagnostics-reference#transport-cors-expose-headers-missing))
  - Context: The connection went through the mcptest proxy, so the browser read the proxy's response headers, not the MCP server's. Access-Control-Expose-Headers on the server could not be checked.
  - Metadata:

    ```json
    {
      "transportDiagnostic": {
        "evidence": [],
        "explanation": "A cross-origin browser client can only read response headers that the server lists in Access-Control-Expose-Headers. The initialize request succeeded, but the browser could not read an Mcp-Session-Id header, so the next request was sent without a session and the server rejected it. The server most likely issues a session id without exposing it. The same applies to MCP-Protocol-Version. Non-browser clients are unaffected, which is why this often looks like a confusing stateful fallback failure only in web clients.",
        "id": "transport.cors-expose-headers-missing",
        "notCheckedReason": "The connection went through the mcptest proxy, so the browser read the proxy's response headers, not the MCP server's. Access-Control-Expose-Headers on the server could not be checked.",
        "referenceUrl": "https://mcptest.io/learn/mcp-transport-diagnostics-reference#transport-cors-expose-headers-missing",
        "remediation": {
          "hints": [
            {
              "code": "[REDACTED]",
              "stack": "TypeScript SDK"
            },
            {
              "code": "[REDACTED]",
              "stack": "Python SDK"
            },
            {
              "code": "[REDACTED]",
              "stack": "Cloudflare Workers"
            }
          ],
          "summary": "Add Access-Control-Expose-Headers: Mcp-Session-Id, MCP-Protocol-Version to every MCP response (including the initialize response), and allow Mcp-Session-Id and MCP-Protocol-Version in Access-Control-Allow-Headers for preflight requests."
        },
        "severity": "info",
        "status": "not-checked",
        "title": "Browser cannot read Mcp-Session-Id (Access-Control-Expose-Headers missing)"
      }
    }
    ```

### Security Posture

Status: evaluated

Score: 40 / 40

Evaluates OAuth protected-resource and authorization-server metadata

- ✓ OAuth protected-resource metadata available
  - Context: The MCP endpoint publishes standardized metadata identifying its authorization servers and protected resource.
  - Metadata:

    ```json
    {
      "authorizationServers": "[REDACTED]",
      "endpoint": "https://d3fnojefdq9ufq.cloudfront.net/mcp",
      "resource": "https://d3fnojefdq9ufq.cloudfront.net/mcp",
      "scopesSupported": [
        "https://d3fnojefdq9ufq.cloudfront.net/mcp/read"
      ]
    }
    ```
- ✓ OAuth authorization-server metadata available
  - Context: Standard metadata allows clients to configure authorization endpoints without hard-coded assumptions.
  - Metadata:

    ```json
    {
      "authorizationEndpoint": "[REDACTED]",
      "authorizationServer": "[REDACTED]",
      "issuer": "https://d3fnojefdq9ufq.cloudfront.net/"
    }
    ```
- ✓ Token endpoint properly configured
  - Context: A published token endpoint enables the secure exchange of authorization grants for access tokens.
  - Metadata:

    ```json
    {
      "supportedGrantTypes": [
        "authorization_code",
        "refresh_token"
      ],
      "tokenEndpoint": "[REDACTED]"
    }
    ```
- ✓ PKCE support enabled
  - Context: S256 PKCE protects authorization codes used by public clients.
  - Metadata:

    ```json
    {
      "requiredMethod": "S256",
      "supportedMethods": [
        "S256"
      ]
    }
    ```

### Web Client Accessibility

Status: evaluated

Score: 0 / 15

Validates direct-browser MCP access at the negotiated endpoint

- ✗ Direct browser negotiation failed; the mcptest proxy was required
  - Context: All connections failed: Load failed
  - Metadata:

    ```json
    {
      "endpoint": "https://d3fnojefdq9ufq.cloudfront.net/mcp",
      "requiredHeaders": [
        "content-type",
        "accept",
        "mcp-protocol-version",
        "mcp-method",
        "mcp-name",
        "authorization"
      ]
    }
    ```

### Performance Baseline

Status: evaluated

Score: 12 / 15

Measures end-to-end endpoint selection and protocol negotiation

- ✓ good negotiation time: 554ms
  - Metadata:

    ```json
    {
      "category": "good",
      "durationMs": 554,
      "measurement": "Endpoint selection, MCP connect, and era negotiation"
    }
    ```
