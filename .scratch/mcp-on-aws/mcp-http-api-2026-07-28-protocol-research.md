# MCP HTTP API: protocol 2026-07-28 research

Type: research
Status: resolved
Verified: 2026-11-04

## Question

What must change in `modules/mcp-http-api` to support MCP `2026-07-28`, while preserving the module's stateless Lambda execution, native JWT authorizer, verified per-user identity, and optional compatibility with `2025-06-18`?

## Sources and availability

The user-supplied [TypeScript schema][schema-main] and [versioned introduction][intro] are available. The official [release announcement][release] is dated 2026-07-28 and announces the released specification and updated SDKs. `LATEST_PROTOCOL_VERSION` in the schema is `2026-07-28`; this is an available released revision, not an unavailable future version. The introduction and release announcement explain the direction; the versioned specification and schemas establish the requirements. [Schema][schema], [Release][release]

Research source snapshot: official `modelcontextprotocol/modelcontextprotocol` repository commit `3c4d91b7e832d9b74338d56eed03403ccc662123`, obtained through its GitHub tree API. The references below pin normative source files to that commit. The generated JSON schema was also checked for required fields. The local module was read at the beginning of the upgrade, when it supported only `2025-06-18`; implementation files were not edited by this research task.

## Answer

The module can retain one JSON response per POST. Supporting the new revision requires a separate modern request path: required per-request metadata, `server/discover`, mirrored HTTP headers and validation, modern error codes/statuses, and new result fields. Modern clients do not initialize a session. Legacy initialization can remain in a separate compatibility path; the new revision explicitly permits implementations to serve both eras on the same endpoint. [HTTP][http], [Versioning][versioning]

| Area | Required modern behavior | Gap in the reviewed module |
| --- | --- | --- |
| Version and context | Each request supplies its protocol version and client capabilities in `params._meta`; no context may be inferred from previous requests. | Only legacy `initialize` validates these fields. |
| Discovery | Implement `server/discover` with supported versions and actual server capabilities. | Method absent; capabilities and identity only returned by `initialize`. |
| Result envelope | Every result includes `resultType`; ordinary results use `"complete"`. | Results lack the field. |
| Cacheable results | `server/discover` and `tools/list` complete results include `ttlMs >= 0` and `cacheScope`. | Fields absent. |
| HTTP metadata | Require `MCP-Protocol-Version` and `Mcp-Method`; require `Mcp-Name` for `tools/call`, `resources/read`, and `prompts/get`. Compare headers with body fields. | Only version header is examined. |
| Error envelope | Preserve readable request IDs; omit an unreadable ID instead of using `null`. | Generic errors use `id: null`. |
| Removed methods | `initialize`, `ping`, and `notifications/initialized` are absent from modern core. | These are accepted under the existing single-version implementation. |
| Browser access | Permit required new request headers consistently at Lambda, API Gateway, and CloudFront. | CORS allowlists omit `Mcp-Method` and `Mcp-Name`. |

The requirements in this table come from the [core specification][basic], [HTTP binding][http], [discovery specification][discover], [caching specification][caching], and [changelog][changelog]. The baseline is [runtime.mjs](../../modules/mcp-http-api/lambda/mcp-server/runtime.mjs), [README.md](../../modules/mcp-http-api/README.md), and [variables.tf](../../modules/mcp-http-api/variables.tf).

## Versioning, metadata, and discovery

Every modern request **MUST** have a `params._meta` object containing these fields:

| Metadata key | Requirement |
| --- | --- |
| `io.modelcontextprotocol/protocolVersion` | Required string specifying this request's protocol version. |
| `io.modelcontextprotocol/clientCapabilities` | Required capability object; `{}` means no optional capabilities. |
| `io.modelcontextprotocol/clientInfo` | Optional `Implementation`; clients **SHOULD** include it unless configured otherwise. `name` and `version` are required if the field is supplied. |
| `io.modelcontextprotocol/logLevel` | Optional, deprecated logging opt-in. Without it a server **MUST NOT** emit `notifications/message` for this request. |

A missing required metadata field **MUST** cause JSON-RPC `-32602` (Invalid params), and HTTP **400**. Capabilities are per-request: servers **MUST NOT** infer them, the protocol version, or client identity from previous requests or the underlying connection. Client software information is self-reported and **SHOULD NOT** be used for security decisions. Continue deriving user identity exclusively from verified token claims. [Core: `_meta` and statelessness][basic], [RequestMetaObject][schema]

An unsupported version **MUST** produce `UnsupportedProtocolVersionError`, code **-32022**, HTTP **400**, with required `error.data.supported: string[]` and `error.data.requested: string`. Do not silently replace the version of a modern request. Clients can choose a common supported version and retry. [Versioning][versioning], [UnsupportedProtocolVersionError][schema]

Servers **MUST** implement **`server/discover`**. Clients **MAY** call it, but may also call `tools/list` or `tools/call` immediately. The discovery result requires `supportedVersions`, `capabilities`, `resultType`, `ttlMs`, and `cacheScope`. Servers **SHOULD** put their `Implementation` in every result's `_meta['io.modelcontextprotocol/serverInfo']`; it is no longer a mandatory top-level `serverInfo` supplied by initialization. Optional discovery `instructions` can be omitted. For this module, advertise only `tools`, with no list-change support. [Discovery][discover], [DiscoverResult and ServerCapabilities][schema], [Caching][caching]

`initialize`/`notifications/initialized`, `ping`, `logging/setLevel`, and `notifications/roots/list_changed` were removed from modern core. Preserve initialization and ping only for explicitly selected legacy semantics. A well-formed modern request for an unimplemented method, including modern `initialize` or `ping`, receives **404** and JSON-RPC **-32601**. [Changelog][changelog], [HTTP: protocol version header][http]

Modern requests carry their own metadata, while legacy `initialize` selects legacy behavior. Serving both eras concurrently is **MAY**, not a requirement. The current no-session legacy JSON mode can remain; modern behavior must not depend on a prior legacy or modern request reaching the same Lambda instance. [Versioning: backward compatibility][versioning]

## JSON-RPC messages, IDs, and errors

Requests **MUST** have string or integer IDs, **MUST NOT** use `null`, and must not reuse an ID while another request with that ID is still awaiting its response. Result responses **MUST** echo the request ID. Error responses **MUST** echo it when it was readable; an unreadable ID may be omitted. The new `JSONRPCErrorResponse` and generated schema allow an optional string/integer `id`, not `id: null`. The module's documented JavaScript safe-integer limit is an implementation limit; clients can use strings for larger identifiers. [Core: messages][basic], [JSONRPCErrorResponse and RequestId][schema], [Generated schema][schema-json]

Every result **MUST** include `resultType`. Use `"complete"` for ordinary tool results, including tool execution errors reported with `isError: true`. `"input_required"` is used when the server needs another round trip to complete a request. The core also permits extension-defined result types, but clients must reject unrecognized types. Adding `resultType` only to discovery would leave `tools/list` and `tools/call` nonconforming. [Core: result responses][basic], [Result and CallToolResult][schema]

Notifications **MUST NOT** have an ID and **MUST NOT** receive a JSON-RPC reply. An accepted HTTP notification **MUST** receive **202 with an empty body**; rejection must be an HTTP error, with an optional JSON-RPC error body having no ID. No core client-to-server notifications are defined for modern Streamable HTTP: `notifications/cancelled` is now a stdio cancellation mechanism, while HTTP cancellation is closing the request's SSE response stream. Do not invent mandatory request metadata for notification POSTs; the HTTP text explicitly says their header requirements are not defined in this revision. [Core: notifications][basic], [HTTP: sending messages and cancellation][http]

Each HTTP POST body **MUST** be one request or notification. Clients **MUST NOT** POST JSON-RPC responses. JSON-RPC batches remain unsupported; existing batch rejection and unexpected-response rejection can remain. [HTTP: sending messages][http]

### HTTP status requirements

| Condition | Status | JSON-RPC error or response | Normative scope |
| --- | --- | --- | --- |
| Missing/malformed/mismatched required mirrored header | 400 | `-32020`, HeaderMismatch | **MUST**; `error.data` is optional. |
| Unsupported requested protocol | 400 | `-32022`; `data: { supported, requested }` | **MUST**. |
| Missing required per-request metadata | 400 | `-32602`, Invalid params | **MUST**. |
| Feature needs an undeclared client capability | 400 | `-32021`; `data: { requiredCapabilities }` | **MUST**, when a supported feature needs that capability. |
| Unimplemented RPC method | 404 | `-32601`, Method not found | **MUST** for modern HTTP. |
| Accepted notification | 202 | Empty body | **MUST**. |
| Invalid supplied Origin | 403 | HTTP error; optional JSON-RPC error without ID | **MUST**. |
| Authorization absent, invalid, or expired | 401 | OAuth authorization error/challenge | **MUST**. |
| Insufficient scopes/permissions | 403 | OAuth error; scope challenge recommended | **MUST** appropriate auth status; additional scope guidance is **SHOULD**. |
| GET or DELETE on an endpoint serving modern core only | 405 | Method not allowed | **SHOULD**; no standalone stream or protocol session. |
| Malformed JSON, invalid envelope, batch, or unexpected response | Existing 400 is appropriate | `-32700` or `-32600` as applicable | Error codes and transport rejection apply; no new universal status table is specified. |
| Other semantic invalid params, such as unknown tool/cursor | JSON-RPC response; existing 200 can remain | `-32602` | No unconditional HTTP mapping for every `-32602` is specified. |

Sources: [HTTP][http], [Core][basic], [Error definitions][schema], [Authorization][authorization]. Missing metadata and missing/mismatched headers are distinct failure classes. The specification does not establish a total precedence order if several validations fail simultaneously.

## Streamable HTTP headers and stateless transport

The server **MUST** expose one POST endpoint. A request result can be a single `application/json` object or request-scoped `text/event-stream`; the server is not required to stream every response. Clients **MUST** list both content types in `Accept` and support both response formats. The spec does not prescribe a server rejection status for an absent/incomplete `Accept`; choosing strict rejection is an implementation decision. JSON-only operation remains suitable for this module's Lambda/API Gateway response path. [HTTP: sending and receiving messages][http]

Required request headers and matching fields:

| Header | Body field |
| --- | --- |
| `MCP-Protocol-Version` | `params._meta['io.modelcontextprotocol/protocolVersion']` |
| `Mcp-Method` | `method` |
| `Mcp-Name` | `params.name` for `tools/call`/`prompts/get`, or `params.uri` for `resources/read` |

Header names **MUST** be compared case-insensitively; values are case-sensitive. Servers processing the body **MUST** reject missing required headers, invalid header characters, and mismatches with **400/-32020**. This validation prevents a gateway routing by headers from disagreeing with the runtime executing the body. Apply it before backend invocation, including standard-name headers on unsupported named RPCs. [HTTP: request metadata and server validation][http]

Headerless compatibility is allowed only for servers supporting clients earlier than `2025-06-18`; such a server **MAY** assume `2025-03-26`. Supporting only `2025-06-18` as the legacy version does not add support for that fallback. Preserve the existing headerless legacy initialization exception separately from modern requests' required metadata. [HTTP: protocol version header][http], [Legacy HTTP binding][legacy-http]

Modern core has no protocol session: no `Mcp-Session-Id` needs to be generated or returned. A modern-only endpoint receiving legacy session or `Last-Event-ID` headers **SHOULD** ignore them; it **SHOULD** return 405 for legacy GET/DELETE requests. Modern SSE streams cannot be resumed with `Last-Event-ID`; server-to-client RPCs must be embedded in MRTR results instead of emitted as independent JSON-RPC requests. `X-Accel-Buffering: no` is **SHOULD** only when streaming, not a required stateless JSON response header. [HTTP: receiving messages and earlier revisions][http]

Add `mcp-method` and `mcp-name` to the explicit request-header lists used by Lambda preflight handling, API Gateway CORS, and CloudFront's response policy. If parameter-header annotations are supported, include the configured `mcp-param-*` names too. These are consequences of the protocol's required client headers and the module's browser support, not a new MCP-specific CORS header schema. Existing `WWW-Authenticate` exposure remains useful. The current `Managed-AllViewerExceptHostHeader` CloudFront origin policy already forwards MCP headers. [HTTP][http]; local [runtime.mjs](../../modules/mcp-http-api/lambda/mcp-server/runtime.mjs), [variables.tf](../../modules/mcp-http-api/variables.tf), [discovery.tf](../../modules/mcp-http-api/discovery.tf)

### Optional `x-mcp-header` annotations

Servers **MAY** annotate tool parameters with `x-mcp-header`; clients **MUST** support the feature when a server advertises it. Server support is optional, but advertising annotations creates mandatory extraction and validation behavior. The current strict Ajv compiler rejects this unknown keyword, so either document that annotated tool schemas are unsupported or register the annotation and implement its rules. [HTTP: custom headers][http], [Tools: x-mcp-header][tools]; local [schema-validator.mjs](../../modules/mcp-http-api/validation/schema-validator.mjs)

An annotation specifies the suffix in `Mcp-Param-{suffix}` and **MUST** satisfy all of these constraints:

- Nonempty valid HTTP field-name token, with no control characters or CR/LF.
- Case-insensitively unique across the tool's input schema.
- Applied only to a `string`, `integer`, or `boolean` parameter; `number` is prohibited and mirrored integer values must be in JavaScript's safe integer range.
- Reachable from the schema root solely through chains of `properties`. Nested object properties are allowed; annotations reached through arrays, `$ref`, composition keywords, or conditional keywords make the definition invalid.

Clients must exclude tools with invalid annotations. For a valid definition, extract the argument at that precise property path. Missing/null values cause the header to be omitted and the server must not expect it; provided values require the header and matching validation. Servers processing the body **MUST** reject mismatching or invalid recognized parameter headers with **400/-32020**. For integers they **SHOULD** compare numeric values, allowing equivalent representations such as `42.0` and `42`. [HTTP: schema extension, server behavior, and validation][http], [Tools][tools]

Strings are mirrored as strings, integers as decimal text, and booleans as lowercase `true`/`false`. A value containing non-ASCII/control characters or leading/trailing whitespace, or one matching the sentinel itself, **MUST** be represented as UTF-8 Base64 with the exact case-sensitive wrapper `=?base64?{encoded}?=`. This also applies to `Mcp-Name`. Servers **MUST** decode the wrapper before comparing with the body. Plain safe header values allow visible ASCII, spaces, and horizontal tabs. Do not forward parameter-header values as verified user identity. [HTTP: value encoding and server validation][http]

## Tools, results, and capabilities

The module already validates full JSON Schema 2020-12 by default, permits explicit draft-07, rejects unsupported dialects, and resolves only references local to each tool schema. Modern implementations **MUST** support 2020-12 and validate schemas using their declared/default dialect; they **MUST NOT** automatically fetch network `$ref` targets. Keeping local-only references and startup schema compilation is consistent with the requested deployment model. Composition/reference keywords are allowed alongside the required root `type: "object"`; a reduced ad hoc validator would be insufficient. [Core: JSON Schema usage][basic], [Tool][schema]; local [schema-validator.mjs](../../modules/mcp-http-api/validation/schema-validator.mjs)

`tools/list` **MUST** return the current caller-visible set and **MUST NOT** vary by connection or as a side effect of another request. It **MAY** vary by the authorization presented on that request. Deterministic ordering is **SHOULD**, and the module's fixed configured order satisfies it. Declare only implemented capabilities; keep `listChanged` false/absent without a subscription implementation. [Tools: capabilities][tools]

`ttlMs` and `cacheScope` are required body fields for complete discovery/list results even if caching is not otherwise implemented. Use **`ttlMs: 0, cacheScope: "private"`** as a conservative implementation choice that adds no freshness guarantee or shared reuse. TTL must be nonnegative; the generated schema specifies integer TTL. No additional HTTP `Cache-Control` response header is mandated by the caching specification. Cache scope does not replace authorization. [Caching][caching], [CacheableResult][schema], [Generated schema][schema-json]

Text-only tool results remain valid. `structuredContent`, `outputSchema`, titles, icons, annotations, and extra tool metadata are optional. Modern `structuredContent` may be any JSON value, including arrays and primitives; if an `outputSchema` is advertised, the server **MUST** provide structured results that conform to it. No new output schema or structured-result feature is required for the module's existing JSON-serialized text contract. [Tools: tool result and structured content][tools], [Tool and CallToolResult][schema]

Keep the distinction between protocol errors and actionable tool failures. Unknown tools and malformed `CallToolRequest` structures are JSON-RPC errors. A valid argument object failing the tool's advertised schema, a business validation error, or a backend failure belongs in a tool result with `isError: true` and `resultType: "complete"`. Explicit `arguments: null`, arrays, or primitive values fail the request schema itself; classify those as modern protocol errors rather than relying on the legacy behavior that wraps every invalid arguments shape in a tool result. [Tools: error handling][tools], [CallToolRequestParams][schema]

Subscriptions and MRTR define how richer features work; they do not justify advertising capabilities the module does not implement. A server with no list-change or resource-update capability can keep its JSON-only scope and reject unsupported optional methods with the prescribed method-not-found response. If future tools need elicitation/sampling/roots, use `InputRequiredResult` plus retries carrying `inputResponses`/`requestState`, never independent server-to-client RPC messages. Missing required client capabilities then use **400/-32021**. Roots, Sampling, and Logging are deprecated, and Tasks moved to an optional extension; none must be added for this tool-only upgrade. [Patterns][patterns], [MRTR][mrtr], [Subscriptions][subscriptions], [ServerCapabilities and MethodNotFoundError][schema], [Changelog][changelog]

## Authorization and discovery

Authorization is optional for the protocol overall, but this module intentionally provides it. The default resource-bound Cognito runtime checks match the key token requirements: verify tokens issued for this MCP resource, use the canonical MCP URL as OAuth `resource` in authorization and token requests, authenticate each protected request, reject invalid tokens with 401 and insufficient scope with 403, and never pass the inbound bearer token through to a tool backend. These checks do not by themselves establish authorization-server discovery compatibility; the later public metadata observation below identifies a Cognito PKCE-advertisement gap. Keep verified `sub`/client identity and deny-by-default checks. Per-request `clientInfo` and client capabilities cannot replace token verification. [Authorization][authorization], [Authorization security][auth-security]

The Protected Resource Metadata document **MUST** contain at least one `authorization_servers` issuer. Modern servers **MUST** provide either a `WWW-Authenticate` `resource_metadata` URL on 401 responses or the appropriate well-known metadata endpoint. Clients must support both, prefer a supplied challenge URL, and otherwise probe the endpoint-specific path before the root path. This is relaxed compared with the `2025-06-18` requirement to include the discovery challenge on 401. The existing two public well-known routes and CloudFront challenge decoration satisfy the discovery shape; no new endpoint is required. [Authorization discovery][auth-discovery], [Legacy authorization][legacy-authorization]; local [discovery.tf](../../modules/mcp-http-api/discovery.tf)

For Cognito's issuer with a user-pool path, modern clients must try OAuth metadata by path insertion, OIDC metadata by path insertion, then OIDC by path appending. Retrieved issuer metadata must match the issuer used to construct the discovery URL exactly. The module documents the final Cognito OIDC path; clients are responsible for implementing the fallback sequence. [Authorization discovery][auth-discovery]

Static pre-registration remains valid. Client ID Metadata Documents are **SHOULD** for authorization servers and clients, not a required module feature. Dynamic Client Registration is now **MAY** and deprecated; its absence is not a conformance gap. Clients with pre-registered information should prefer it and key persisted credentials/tokens by the authorization server's issuer. [Client registration][registration]

Provider/client requirements worth preserving or verifying:

- Clients **MUST** use PKCE and verify `code_challenge_methods_supported` in authorization-server metadata, including OIDC discovery; absence means they must refuse to continue. OIDC authorization servers **MUST** advertise that field for MCP compatibility. PKCE working in a manual authorization flow alone does not prove this discovery requirement. A later public read on 2026-11-04 confirmed the deployed Cognito issuer omits this field; see the external-authorization follow-up below. [Authorization security][auth-security], [Observed Cognito metadata][cognito-oidc-observed]
- Authorization servers **SHOULD** return callback `iss` and must advertise `authorization_response_iss_parameter_supported: true` when doing so. Clients **MUST** validate a present `iss` against the recorded issuer before redeeming a code; absence is rejected only if support was advertised. This affects OAuth clients/examples, not JSON-RPC runtime routing. [Authorization: response validation][authorization]
- Public-client refresh-token rotation is a **MUST**; the module already enables rotation. The MCP scope metadata should not claim `offline_access` as a resource requirement. [Authorization][authorization], [Authorization security][auth-security]; local [main.tf](../../modules/mcp-http-api/main.tf)
- Insufficient-scope challenges **SHOULD** include `error="insufficient_scope"`, the scopes required for the operation, and the resource metadata URL. The current CloudFront response policy overrides Lambda challenges with a resource-metadata-only challenge; discovery still works via metadata, but the public edge loses this recommended step-up detail. This is a pre-existing recommendation gap, not a new mandatory protocol envelope change. [Authorization: scope challenge handling][authorization]; local [discovery.tf](../../modules/mcp-http-api/discovery.tf)

## Conflicts, abbreviations, and interpretation limits

- The versioned specification overview still says extensions are negotiated "during initialization". The dedicated versioning specification, changelog, request metadata schema, and generated required fields explicitly remove initialization and establish per-request capabilities. Treat the overview wording as stale. [Overview][overview], [Versioning][versioning], [Schema][schema]
- The release announcement's HTTP example omits required protocol-version/client-capability metadata. The tools page also abbreviates examples, but explicitly warns that every real request needs required `_meta` fields. Do not copy abbreviated examples as literal valid wire requests. [Release][release], [Tools][tools], [Core][basic]
- The HTTP binding first says every POST includes metadata headers, then explicitly says modern notification POST header requirements are undefined. For request POSTs, the standard header table and validation rules are clear; notification handling needs an explicit extension/compatibility policy instead of invented core requirements. [HTTP][http]
- TypeScript uses `number` for IDs and TTL, whereas prose and the generated JSON schema specify integers. Use integer IDs/TTL and nonnegative TTL; `ttlMs: 0` satisfies both. [Core][basic], [Caching][caching], [Generated schema][schema-json]
- Generic `InvalidParamsError` commentary lists "invalid tool arguments", while the tools page treats actionable input validation failures as tool execution errors. Distinguish malformed `CallToolRequest` fields from a well-formed argument object that fails the tool input schema. [Error definitions][schema], [Tools: error handling][tools]
- The core overview broadly requires support for message patterns, but no unconditional requirement to advertise list-change/subscription, sampling, elicitation, or resource capabilities was found. Streamable HTTP permits a single JSON response, and method-not-found explicitly covers methods gated by unadvertised server capabilities. Keep these features unadvertised; adding richer features would require their full pattern rules. [Core][basic], [HTTP][http], [MethodNotFoundError][schema]

## Actionable verification for the upgrade

1. Send modern `server/discover`, `tools/list`, and `tools/call` without initialization. Verify required result fields, actual capabilities, and unchanged verified backend identity.
2. Reject missing required metadata, unsupported versions, missing/mismatched method/name headers, duplicate/ambiguous header representations, and invalid name encodings before invoking tools; check the distinct required error codes/statuses.
3. Verify modern `ping`/`initialize` do not succeed, while legacy initialization, ping, tools, notification 202 behavior, and legacy header rules remain intact when compatibility is enabled.
4. Preserve IDs on readable request errors; omit unreadable IDs on modern malformed-message errors. Continue rejecting null/fractional IDs, responses, and batches.
5. Verify browser preflights permit the new required headers through all configured layers and still deny untrusted Origins.
6. If enabling `x-mcp-header`, verify startup annotation constraints, nested property extraction, missing/null arguments, numeric/boolean conversion, Base64 sentinel decoding, and header/body mismatch rejection.
7. Keep tool schema validation and backend denial tests; verify malformed modern call fields differ from actionable schema-validation errors. Confirm cache hints are present on both discover and list results.
8. Verify the selected authorization server's OIDC/OAuth metadata advertises PKCE and `S256`; the checked Cognito issuer currently omits this advertisement. Update OAuth client examples to validate callback issuer information when provided.

These checks derive from the requirements above. Unit tests can verify runtime and CORS behavior; Terraform validation can verify generated header configuration. Provider metadata and native-authorizer/CloudFront behavior require public metadata or live endpoint checks. The follow-up fetched the public Cognito metadata; this research did not run authenticated external-provider or native-authorizer wire checks.

## External authorization server follow-up

Verified: 2026-11-04. The user requested support for selecting another authorization server after the Cognito discovery gap was observed. This section reviews the proposed `external_authorization_server` configuration against current official AWS and MCP sources; it does not claim that an unspecified external provider has been deployed or tested.

### Concrete Cognito public metadata observation

Fetched this public OIDC discovery document without credentials:

`https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_vaNyAkA6X/.well-known/openid-configuration`

| Field | Observed value | Meaning |
| --- | --- | --- |
| `issuer` | `https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_vaNyAkA6X` | Matches the deployed issuer specified for the check. |
| `jwks_uri` | The same issuer followed by `/.well-known/jwks.json` | Signing-key discovery is advertised. |
| `id_token_signing_alg_values_supported` | `["RS256"]` | The document advertises RSA ID-token signing. |
| `response_types_supported` | `["code", "token"]` | Authorization-code flow is advertised, but this does not advertise PKCE. |
| `code_challenge_methods_supported` | **Field absent** | `S256` is not advertised; this is not an empty-list or unsupported-method observation. |

Source: the [issuer-owned public metadata response][cognito-oidc-observed], checked 2026-11-04. A local fetched copy was held at `/private/tmp/mcp-http-api-cognito-public-oidc-2026-11-04.json`; no token or credential was fetched.

The missing field conflicts with the modern MCP rule that clients **MUST** verify PKCE support through authorization-server metadata, including OIDC discovery, and **MUST** refuse to proceed if `code_challenge_methods_supported` is absent. OIDC authorization servers **MUST** include the field for MCP compatibility, and technically capable clients **MUST** use `S256`. This proves a discovery-compatibility gap for the observed document; it does not prove that Cognito cannot execute an authorization-code/S256 exchange. The module's optional external issuer mode addresses provider selection while preserving strict token validation. [Authorization security: authorization code protection][auth-security]

### Native HTTP API JWT authorizer constraints

AWS explicitly supports JWTs used with OIDC and OAuth 2.0 identity providers; the native authorizer is not restricted to Cognito. Its configuration selects an issuer and audience entries, while route configuration selects required authorization scopes. The issuer and signing keys must be reachable by the AWS authorizer so that it can retrieve the issuer's `jwks_uri`; provider metadata and keys are an integration prerequisite rather than Lambda-supplied credentials. The examined native-authorizer guide does not promise an arbitrary RFC8414-only discovery-path fallback, so use a provider with usable OIDC discovery and verify native authorizer compatibility. [AWS native JWT authorizers][aws-native-jwt], [AWS JWT configuration reference][aws-jwt-config]

| Check or constraint | Official AWS behavior | Implication for external mode |
| --- | --- | --- |
| Token format/signature | Decode and validate a signed JWT using issuer keys; **currently only RSA-based algorithms are supported**. | Do not claim support for opaque access tokens, HMAC, EC, or EdDSA tokens through this native authorizer. RS256 is a suitable provider contract. |
| Signing key | JWT header `kid` must identify the signing key from `jwks_uri`. Keys may be cached for up to two hours on a best-effort basis. | Publish discoverable RSA keys; overlap old/new keys during rotation. |
| Issuer | Token `iss` must match configured issuer. | Use the actual metadata issuer, including any tenant/path component. |
| Audience | Validate `aud` against configured audience entries; fall back to `client_id` only when `aud` is absent. If both are present, validate `aud`. | Configure only the canonical MCP resource audience. An edge-valid resource audience does **not** pin the application client ID; the Lambda must do that separately. |
| Time claims | `exp` must be after current UTC; `nbf` and `iat` must be before current UTC. | Tokens must satisfy AWS time validation before reaching Lambda. |
| Route scope | `scope` **or** `scp` must include at least one configured route scope. Multiple route scopes are alternatives, not an all-scopes requirement. | A single `required_scope` maps directly to the existing route. |
| Token purpose | AWS explicitly says there is no general mechanism to distinguish JWT access tokens from ID tokens; it recommends scopes and access-token-only issuer/audience contracts. | Keep resource audience and scopes strict, and use a configured purpose marker when the provider supplies one. |
| Custom claims | Native JWT configuration has no arbitrary client-claim or purpose-marker predicate. Validated claims are forwarded to the integration. | Enforce `client_id_claim`, optional access-token marker, and nonempty `sub` in the runtime. |
| Bearer transport | AWS allows a configured header or query-string identity source. | Keep `$request.header.Authorization`; MCP prohibits bearer tokens in the query string. |

Sources: [AWS native JWT authorizer validation][aws-native-jwt], [AWS authorizer API/configuration][aws-jwt-config], [MCP access-token usage][authorization]. The RSA restriction describes the current AWS native implementation, not a restriction imposed by MCP itself.

### Lambda payload v2.0 claim serialization

The official API Gateway payload-v2 example exposes two separate members:

```json
{
  "requestContext": {
    "authorizer": {
      "jwt": {
        "claims": { "claim1": "value1", "claim2": "value2" },
        "scopes": ["scope1", "scope2"]
      }
    }
  }
}
```

The first-party AWS Go event model declares `Claims map[string]string` and `Scopes []string`. The first-party Java model likewise declares `Map<String, String> claims` and `List<String> scopes`; the .NET model declares `IDictionary<string, string> Claims` and `string[] Scopes`. These are affirmative evidence that the native event contract treats claim values as strings, while scopes have a separate real list representation. They do **not** establish that raw JWT `aud` or `scp` arrays are preserved as JavaScript arrays in the integration event. [AWS HTTP API Lambda payload][aws-http-lambda-payload], [AWS Go event type][aws-go-jwt-event], [AWS Java event type][aws-java-jwt-event], [AWS .NET event type][aws-dotnet-jwt-event]

No primary specification or checked first-party fixture supplied an escaping/serialization grammar for **multi-valued `aud`/`scp` becoming claim strings**. The checked Go/Java/.NET standard fixtures show scalar example claims plus `jwt.scopes`; the .NET authorization fixture also uses string-valued claims. It would be unsupported to assert whether arbitrary array claims become JSON-encoded strings, comma-separated lists, or another representation. A real gateway event from the selected issuer is needed to establish any broader handling. [AWS Go fixture][aws-go-jwt-fixture], [AWS Java fixture][aws-java-jwt-fixture], [AWS .NET fixture][aws-dotnet-jwt-fixture]

Concrete implementation recommendation: require a **single scalar audience exactly equal to `mcp_url`** in external-provider JWTs, and use the trusted **`event.requestContext.authorizer.jwt.scopes` list** for HTTP scope verification when provided. Raw `scope`/`scp` parsing can support direct-runtime callers or tested scalar representations, but must not substitute undocumented bracket/comma parsing for audience membership. Existing unit fixtures with real `aud` arrays demonstrate only direct-runtime acceptance, not native gateway preservation. Scope lists must come from the authorizer context, never client arguments or ordinary request headers. This is a deliberate provider-compatibility contract based on the documented event shape. [AWS HTTP API Lambda payload][aws-http-lambda-payload], [AWS Go event type][aws-go-jwt-event]

### Review of the proposed configuration

The proposed optional object is suitable with an explicit provider contract:

| Configuration | Required interpretation |
| --- | --- |
| `issuer` | Exact HTTPS authorization-server issuer, used both in API Gateway JWT configuration and protected-resource `authorization_servers` metadata. The provider must publish usable signing-key discovery. |
| `client_id` | Existing registered public OAuth client identifier; external mode does not create this client or store a client secret. |
| `required_scope` | One nonempty OAuth scope token that the provider issues for this MCP resource; configure it on the route and verify exact scope membership in the trusted context. |
| `client_id_claim`, default `client_id` | Exact scalar JWT payload claim identifying the configured application client. A provider-specific claim such as `azp` may be selected when the provider documents that access-token contract; do not infer it from `aud`. |
| Optional `access_token_claim: { name, value }` | Additional exact scalar payload-claim predicate. If configured, absence or mismatch denies the token. |
| External audience policy | Always require the canonical `mcp_url` audience; no client-ID audience fallback or unbound-token compatibility opt-in. |

The mapping of issuer/audience/scope to native authorizer fields follows [AWS JWT authorizers][aws-native-jwt]. A default `client_id` predicate also aligns with the [RFC9068 JWT access-token profile][rfc9068], which requires that payload claim. Alternative claim names remain a provider contract rather than a guarantee of generic OAuth interoperability. [MCP resource binding][authorization], [Client registration][registration]

Requiring the resource audience is consistent with MCP's **MUST** to verify tokens specifically issued for this resource. Clients **MUST** send `resource=mcp_url` in both authorization and token requests, and the selected provider must produce a token whose accepted audience corresponds to that resource. Rejecting absent `aud` in the runtime prevents AWS's `client_id` fallback from weakening this policy even in an edge-valid corner case. Callback/logout URLs and OAuth client setup are managed at the external provider; no Cognito resource server, app client, or password-flow configuration is needed in this selected mode. [MCP authorization][authorization], [AWS audience precedence][aws-native-jwt]

The optional marker checks a **payload claim**, not the JOSE header. RFC9068 places `typ: "at+jwt"` in the JWT header; the documented native-authorizer `claims` member does not expose that header. Without a configured marker, the provider must reserve the selected resource audience/scope contract for access tokens. Rejecting a supplied `token_use` other than `"access"` is a conservative compatibility rule, while allowing the claim to be absent supports providers that do not use Cognito's marker. Do not claim that these predicates universally identify every provider's access and ID tokens. [AWS token-purpose caveat][aws-native-jwt], [RFC9068 header typing][rfc9068], [AWS Lambda event shape][aws-http-lambda-payload]

Keep `identity.sub` and `identity.clientId` derived from the validated context and configured client-claim mapping, never from tool arguments. A subject is local to its issuer; switching from Cognito to another provider does not imply that its `sub` equals an existing Cognito user ID. Backends whose records are keyed by Cognito subjects may need an explicit mapping or migration. A single selected issuer avoids accepting multiple subject namespaces concurrently, but does not perform that migration. [OIDC subject definition][oidc-core], [RFC9068 subject claim][rfc9068]

### Provider qualification and remaining verification

Before claiming a specific provider works, verify its public metadata has the exact issuer, usable RSA JWKS, and `code_challenge_methods_supported` including `S256`; verify a registered public client can request the canonical MCP resource and required scope with authorization-code/PKCE. Then inspect a native JWT-authorizer event privately to confirm scalar `aud`, configured client claim, subject, optional marker, and normalized `jwt.scopes` meet the documented contract. A scope string or true-array unit fixture alone does not verify gateway serialization. Public metadata checks need no bearer token; live token/event checks must keep tokens and credentials out of repo artifacts. [MCP authorization security][auth-security], [MCP resource parameter][authorization], [AWS native JWT validation][aws-native-jwt], [AWS Lambda payload][aws-http-lambda-payload]

The concrete public Cognito metadata check was completed. An external provider was not specified or live-tested by this research task, and the exact string encoding of multi-valued native claim values remains unverified. These are verification limits, not reasons to weaken the configured audience, client, scope, or subject checks.

[schema-main]: https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/schema/2026-07-28/schema.ts
[intro]: https://modelcontextprotocol.io/docs/2026-07-28/getting-started/intro
[schema]: https://github.com/modelcontextprotocol/modelcontextprotocol/blob/3c4d91b7e832d9b74338d56eed03403ccc662123/schema/2026-07-28/schema.ts
[schema-json]: https://github.com/modelcontextprotocol/modelcontextprotocol/blob/3c4d91b7e832d9b74338d56eed03403ccc662123/schema/2026-07-28/schema.json
[release]: https://github.com/modelcontextprotocol/modelcontextprotocol/blob/3c4d91b7e832d9b74338d56eed03403ccc662123/blog/content/posts/2026-07-28-spec-ga/index.md
[basic]: https://github.com/modelcontextprotocol/modelcontextprotocol/blob/3c4d91b7e832d9b74338d56eed03403ccc662123/docs/specification/2026-07-28/basic/index.mdx
[http]: https://github.com/modelcontextprotocol/modelcontextprotocol/blob/3c4d91b7e832d9b74338d56eed03403ccc662123/docs/specification/2026-07-28/basic/transports/streamable-http.mdx
[versioning]: https://github.com/modelcontextprotocol/modelcontextprotocol/blob/3c4d91b7e832d9b74338d56eed03403ccc662123/docs/specification/2026-07-28/basic/versioning.mdx
[discover]: https://github.com/modelcontextprotocol/modelcontextprotocol/blob/3c4d91b7e832d9b74338d56eed03403ccc662123/docs/specification/2026-07-28/server/discover.mdx
[caching]: https://github.com/modelcontextprotocol/modelcontextprotocol/blob/3c4d91b7e832d9b74338d56eed03403ccc662123/docs/specification/2026-07-28/server/utilities/caching.mdx
[tools]: https://github.com/modelcontextprotocol/modelcontextprotocol/blob/3c4d91b7e832d9b74338d56eed03403ccc662123/docs/specification/2026-07-28/server/tools.mdx
[patterns]: https://github.com/modelcontextprotocol/modelcontextprotocol/blob/3c4d91b7e832d9b74338d56eed03403ccc662123/docs/specification/2026-07-28/basic/patterns/index.mdx
[mrtr]: https://github.com/modelcontextprotocol/modelcontextprotocol/blob/3c4d91b7e832d9b74338d56eed03403ccc662123/docs/specification/2026-07-28/basic/patterns/mrtr.mdx
[subscriptions]: https://github.com/modelcontextprotocol/modelcontextprotocol/blob/3c4d91b7e832d9b74338d56eed03403ccc662123/docs/specification/2026-07-28/basic/patterns/subscriptions.mdx
[authorization]: https://github.com/modelcontextprotocol/modelcontextprotocol/blob/3c4d91b7e832d9b74338d56eed03403ccc662123/docs/specification/2026-07-28/basic/authorization/index.mdx
[auth-discovery]: https://github.com/modelcontextprotocol/modelcontextprotocol/blob/3c4d91b7e832d9b74338d56eed03403ccc662123/docs/specification/2026-07-28/basic/authorization/authorization-server-discovery.mdx
[registration]: https://github.com/modelcontextprotocol/modelcontextprotocol/blob/3c4d91b7e832d9b74338d56eed03403ccc662123/docs/specification/2026-07-28/basic/authorization/client-registration.mdx
[auth-security]: https://github.com/modelcontextprotocol/modelcontextprotocol/blob/3c4d91b7e832d9b74338d56eed03403ccc662123/docs/specification/2026-07-28/basic/authorization/security-considerations.mdx
[changelog]: https://github.com/modelcontextprotocol/modelcontextprotocol/blob/3c4d91b7e832d9b74338d56eed03403ccc662123/docs/specification/2026-07-28/changelog.mdx
[overview]: https://github.com/modelcontextprotocol/modelcontextprotocol/blob/3c4d91b7e832d9b74338d56eed03403ccc662123/docs/specification/2026-07-28/index.mdx
[legacy-http]: https://github.com/modelcontextprotocol/modelcontextprotocol/blob/3c4d91b7e832d9b74338d56eed03403ccc662123/docs/specification/2025-06-18/basic/transports.mdx
[legacy-authorization]: https://github.com/modelcontextprotocol/modelcontextprotocol/blob/3c4d91b7e832d9b74338d56eed03403ccc662123/docs/specification/2025-06-18/basic/authorization.mdx
[cognito-oidc-observed]: https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_vaNyAkA6X/.well-known/openid-configuration
[aws-native-jwt]: https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-jwt-authorizer.html
[aws-jwt-config]: https://docs.aws.amazon.com/apigatewayv2/latest/api-reference/apis-apiid-authorizers.html#apis-apiid-authorizers-model-jwtconfiguration
[aws-http-lambda-payload]: https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-develop-integrations-lambda.html#http-api-develop-integrations-lambda.proxy-format
[aws-go-jwt-event]: https://github.com/aws/aws-lambda-go/blob/41118539f90fa1989458560031d82a16b3686722/events/apigw.go#L156
[aws-java-jwt-event]: https://github.com/aws/aws-lambda-java-libs/blob/1b59889e10f99369e6133adac117f6fb55333e3f/aws-lambda-java-events/src/main/java/com/amazonaws/services/lambda/runtime/events/APIGatewayV2HTTPEvent.java#L75
[aws-dotnet-jwt-event]: https://github.com/aws/aws-lambda-dotnet/blob/3ff8ae1ba913ffc1113b49531016f6d1c019bb78/Libraries/src/Amazon.Lambda.APIGatewayEvents/APIGatewayHttpApiV2ProxyRequest.cs#L331
[aws-go-jwt-fixture]: https://github.com/aws/aws-lambda-go/blob/41118539f90fa1989458560031d82a16b3686722/events/testdata/apigw-v2-request-jwt-authorizer.json
[aws-java-jwt-fixture]: https://github.com/aws/aws-lambda-java-libs/blob/1b59889e10f99369e6133adac117f6fb55333e3f/aws-lambda-java-tests/src/test/resources/apigw_http_event.json
[aws-dotnet-jwt-fixture]: https://github.com/aws/aws-lambda-dotnet/blob/3ff8ae1ba913ffc1113b49531016f6d1c019bb78/Libraries/test/EventsTests.Shared/http-api-v2-request.json
[rfc9068]: https://www.rfc-editor.org/rfc/rfc9068
[oidc-core]: https://openid.net/specs/openid-connect-core-1_0.html#IDToken
