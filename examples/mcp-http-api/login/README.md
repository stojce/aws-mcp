# Optional local OAuth test page

This directory is manual test tooling. The deployed MCP Lambda uses public
Cognito authorization and token endpoints and does not package or depend on
this server. Keep `oauth_proxy_endpoints = null` when deploying the example.

To inspect a token locally, explicitly add `http://localhost:8080/callback` to
the Cognito `callback_urls` list while retaining the hosted clients you use.
Apply that callback configuration in your sandbox, then run from the example
directory with Node.js 22:

```bash
node login/server.mjs
```

Open `http://localhost:8080`. **Continue to Cognito** starts an authorization-code
login with S256 PKCE and `resource=mcp_url`. Cognito collects the credentials,
then redirects to this page's registered callback. The page validates state,
exchanges the code, and lets you copy the access token for a manual MCP request.
The helper reads the public Cognito endpoint outputs from Terraform.

Tokens stay in memory. Reloading or **Clear token** clears the page's tokens; it
does not revoke copies or end the Cognito browser session. The helper supports
refresh-token rotation. Keep token files outside the checkout.

To change the test page's port, set `MCP_LOGIN_PORT` and register the matching
callback in your sandbox. Restart the helper after applying configuration
changes. Its optional Inspector configuration uses local overrides for a client
on the same machine; the deployed discovery document continues to use Cognito.

The bundled Geist font uses the [SIL Open Font License](geist.LICENSE.txt).
