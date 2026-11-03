# Example: mcp-http-api

Deploys the `modules/mcp-http-api` module end to end in a sandbox account:
its own Cognito pool with two test users, a DynamoDB bookings table, a tool
backend Lambda, and the MCP endpoint.

## Deploy

```bash
cd examples/mcp-http-api
terraform init
terraform apply
export TEST_PASSWORD_ALICE='...' TEST_PASSWORD_BOB='...'   # not stored in state
./scripts/set-test-passwords.sh
```

Outputs: `mcp_url`, `mcp_app_client_id`, `required_scope`, `user_subs`.

## What was verified against the deployed stack

| Check | Result |
|---|---|
| No bearer token at the edge | `401` |
| Access token without `mcp/read` at the edge | `403 insufficient_scope` |
| Tool backend returns only the caller's bookings (Alice, Bob) | Pass (direct Lambda invoke with verified-claims event) |
| MCP runtime rejects a token from another client | `401 invalid_token` |
| MCP runtime rejects a token without `mcp/read` | `403 insufficient_scope` |
| Runtime unit tests | 21/21 pass (`node --test lambda/mcp-server/runtime.test.mjs`) |

**Not yet verified:** a full positive call through the public URL with a real
authorization-code token that carries `mcp/read`. The hosted-UI login could not
be completed headlessly in this session. To finish it: sign in as a test user
through `https://<domain>.auth.<region>.amazoncognito.com/oauth2/authorize`
with `scope=openid email mcp/read`, then `POST` `tools/list` and `tools/call`
to `mcp_url`.

## Notes

- Test users use `USER_PASSWORD_AUTH` only when `enable_password_auth_for_tests = true` (default in this example). It cannot grant `mcp/read`, so it is useful only for negative tests.
- Passwords are set with `scripts/set-test-passwords.sh` and never enter state.
- `*.tfstate` is git-ignored here, unlike the legacy example.
- Destroy with `terraform destroy` when finished; the Cognito domain and pool are otherwise left running.
