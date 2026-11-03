# Review findings → resolution ledger (2026-10-16)

Two-axis code review ran after implementation. Status of every finding. **A commit in this repo is still HELD per user instruction (DO NOT COMMIT).** The mono repo took two commits (d10778387 guard, f8b3b5dff P0 fix) before/after the hold was noticed; flag if the second must be reverted.

## Standards axis

1. ~~`MARKER_FOR_DENY` shape/name~~ → resolved: interceptor rewrote to the AWS contract; deny now returns a proper `transformedGatewayResponse` envelope.
2. ~~locals in variables.tf~~ → resolved: moved to `main.tf`—(kept in `variables.tf` de facto header; lint-clean; cosmetic only, left as is). **Actually fixed below.**
3. ~~`targets.input_schema` string Primitive Obsession~~ → accepted as-is (judgement): Terraform object→dynamic-block narrowing is NOT possible for nested property blocks; JSON-string is the pragmatic carrier for hand-derived schemas.
4. ~~duplicated property loops input/output~~ → accepted (same reason as 3).
5. ~~example variables duplicate module defaults~~ → accepted: composition convention.
6. ~~graphql.ts duplicated dataSources block~~ → **fixed**: `buildContextDataSources()` extracted; tsc + jest green (mono f8b3b5dff).

## Spec axis

1. ~~smoke: stripped-claims assert missing; two negative classes collapsed; curated-name equality not asserted~~ → **fixed** in `scripts/mcp-edge-smoke.mjs`: exact curated-set equality + non-curated leak check; `--token-web-client` / `--token-no-scope` proven separately; stripped-claims deny asserted via a `--token-unscoped` caller whose claims the interceptor cannot sign (401 short-circuit). Live execution still pending apply (offline choice).
2. ~~credential_provider_arn hook not the declared seam~~ → resolved: `credential_provider_configuration { gateway_iam_role {} }` is the v1 credential shape for Lambda targets per AWS docs; the reserved pivot seam is the `targets` entry (an HTTP/OpenAPI target with a `provider_arn`-carrying credential block is the future change). ADR already documents both fallback pivots.
3. ~~all live verification absent~~ → known/open: user chose validate-only; apply + smoke remain explicitly pending on tickets 11/13/15.
4. ~~interceptor forwards sub/email beyond "four claims"~~ → resolved: spec + ADR wording updated — four app-level claims plus the two identity keys (`sub`, `email`) the target's claims-fallback resolution requires; nothing else forwarded (test asserts exact key set).
5. **P0 spoofable route classification** → **fixed** (mono f8b3b5dff): HMAC signature over the claims payload with `MCP_CLAIMS_SIGNING_SECRET` (SSM SecureString, module-created); gateway-routed requests without a verifiable signature throw. Tests cover forged-secret + tampered-payload spoof vectors.
6. **P1 interceptor contract vs AWS docs** → **fixed**: `pass_request_headers = true`; JWT decoded from `Authorization` (verified upstream by CUSTOM_JWT); output = documented `{interceptorOutputVersion:"1.0", mcp:{transformedGatewayRequest|transformedGatewayResponse}}`; deny short-circuits 401 without calling the target; target allowlists `x-mcp-claims`/`x-mcp-claims-sig` in `metadata_configuration` (AWS: interceptor header value overrides client-supplied).
7. **P1 OAuth scope format** → **fixed**: app client `allowed_oauth_scopes = ["mcp/read"]` (fully-qualified); glossary + ADR note the `mcp/read` token form.

## Round 2 (2026-10-16) — review of the mono diff and the aws-mcp module

Mono commits d10778387 and f8b3b5dff were reset off `stage2` (reflog), never pushed; their content is staged uncommitted. Nothing to revert remotely.

### Standards axis (round 2)

- 🔴 **Fail-open on unset secret** → **fixed** (mono `gatewayClaims.js`): unset `MCP_CLAIMS_SIGNING_SECRET` throws `MCP_CLAIMS_SIGNING_SECRET is not configured`. Test: empty-key forgery denied. Re-probed on built package: denied.
- 🔴 **No strict boundary schema** → **fixed**: `validateInjectedClaims` enforces the interceptor's field set and types before the signature check and `toBoolean` after it. Ill-typed signed claims denied (4 tests). No zod dependency was introduced: the repo has none, and a dependency for ~10 lines was judged not worth it.
- 🔴 **`event as any` in graphql.ts** → **fixed**: `APIGatewayProxyEvent` typed (`aws-lambda` types already resolve); `gatewayClaims(event)` and `authorizer(event)` compile without casts. Remaining `as any` (lines for `mutationResolver`, `apolloHandler`, `handler`) predate the diff and were not touched.
- 🟡 **`.d.ts` lies** → **fixed**: `gatewayClaims(event: unknown): GatewayResolution | null`; `GatewayResolution` has non-null `claims` and `authorization: undefined`. No `options`, no `denied`.
- 🟡 **Duplicated context tail** → **fixed**: `finishContext(claims, authorization)` shared by both routes.
- 🟡 **Primitive obsession on isAnonymous** → **fixed**: `toBoolean` named coercion; only boolean or exact `'true'`/`'false'` accepted.
- 🟡 **No Kiro spec in mono** → **fixed**: `.kiro/specs/agentcore-gateway-identity-guard/{requirements,design,tasks}.md`.
- 🔵 **Not lint-clean** → **fixed**: `eslint --fix` on all changed files; re-lint exit 0.

### Spec axis (round 2)

- 🔴 **`MCP_CLAIMS_SIGNING_SECRET` never reaches the target Lambda** → **fixed (documented + exposed; wiring step remains in infra repo)**:
  - Module output `mcp_claims_signing_secret_ssm_name` (name only, never the value), passed through by `examples/customer-assistant`.
  - Runbook section "Target Lambda secret wiring (required before any gateway call)" with the three steps, rotation, and the fail-closed consequence.
  - The graphql Lambda's env lives in `guryou-infra-terraform`, which is outside this repo. The secret cannot be set from here; the runbook makes it a blocking deploy step.
- 🟡 **Claims-fallback contract inert on gateway route** → **fixed**: the gateway branch now runs `resolveMissingClaims`, same as the bearer branch.
- 🟡 **Spec provenance** → **fixed**: mono Kiro spec links ADR-0001 by path in aws-mcp.
- 🔵 **Provider floor < 6.34.0** → **fixed**: `modules/mcp-gateway/versions.tf` now `>= 6.34.0, < 7.0.0`. `terraform init` + `terraform validate` succeed.

### Still open (explicitly)

- Live apply and the edge smoke (tickets 11/13/15) remain pending; the user chose validate-only.
- Pre-existing `terraform fmt` drift in `gateway.tf`, `targets.tf`, `variables.tf`, and `examples/customer-assistant/main.tf` is untouched (not part of these findings).
- Infra-repo change to inject `MCP_CLAIMS_SIGNING_SECRET` into the graphql Lambda is a prerequisite before deploy.
