# Repository Guidelines

## Project Structure & Module Organization

This repository provisions authenticated AWS MCP endpoints with Terraform and Node.js Lambda code.

- `modules/mcp-gateway/`: AgentCore Gateway, Cognito configuration, tool targets, and the request interceptor.
- `modules/mcp-http-api/`: API Gateway HTTP API alternative, MCP server Lambda, and runtime tests.
- `scripts/`: wire-level smoke checks. `docs/adr/` records architecture decisions; `docs/runbook-mcp-gateway.md` covers gateway operation. Consult `GLOSSARY.md` for terminology and `.scratch/mcp-on-aws/` for design tickets.

## Build, Test, and Development Commands

Use Terraform 1.9+ and Node.js 22 to match the Lambda runtime.

- `terraform fmt -check -recursive`: check Terraform formatting from the repository root. Format changed files with `terraform fmt <file>`.
- From an example directory, run `terraform init`, then `terraform validate` and `terraform plan` to initialize providers, validate configuration, and inspect infrastructure changes.
- `terraform apply`: deploy an inspected plan in the intended sandbox account.

Terraform `archive_file` resources package Lambda code; there is no root npm build or local development server.

## Coding Style & Naming Conventions

Use two-space indentation. Follow Terraform formatting and snake_case resource, variable, and tool names, such as `get_job_details`. JavaScript uses camelCase, semicolons, and single quotes. Preserve CommonJS in the interceptor and ES modules in `.mjs` files. No repository-wide JavaScript formatter or linter is configured.

## Testing Guidelines

Unit tests use `node:test` and Node assertions. Run both suites from the root:

```bash
node --test modules/mcp-gateway/lambda/interceptor/index.test.js modules/mcp-http-api/lambda/mcp-server/runtime.test.mjs
```

Name tests `*.test.js` or `*.test.mjs`. Cover identity validation, denial paths, tool routing, and response behavior; no numerical coverage threshold is configured.

## Commit & Pull Request Guidelines

History uses short subjects such as `docs` and `ticket 08: ADR written; map complete`. Use descriptive, scoped subjects and ticket references when applicable. PRs should explain behavior changes, link relevant issues or ADRs, and report unit-test and Terraform validation results. Include plan summaries for infrastructure changes.

## Security & Configuration Tips

Keep credentials, tokens, signing secrets, Terraform state, and saved plans out of commits. Supply test credentials through environment variables. Preserve verified per-user identity and deny-by-default authorization; keep password authentication disabled outside test sandboxes.
