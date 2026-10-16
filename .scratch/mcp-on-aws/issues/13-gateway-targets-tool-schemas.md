# Ticket 13: Gateway targets: verified tools, hand-derived toolSchema, interceptor attached

**What to build:** the curated v1 reads become real MCP tools on the live Gateway: `targets` entries for the ticket-10-verified operation list, each with a **Tool schema** hand-derived from its GraphQL operation's input/output types; the **Interceptor** attached in the request path; `lambda:InvokeFunction` permissions for the existing Apollo `graphql.ts` Lambda target. Verifiable end-to-end at the MCP edge: an MCP client authenticated as a real end-user token sees exactly the curated tool names, and invoking one reaches the target Lambda.

**Blocked by:** 10 (verified tool list + types), 11 (module core), 12 (interceptor to attach).

**Status:** ready-for-agent

- [ ] `targets` populated from the verified v1 list only; every schema derived from the captured GraphQL types, not invented.
- [ ] Interceptor wired as the Gateway's request interceptor; claims reach the target invocation path.
- [ ] Invoke permissions grant the Gateway role exactly the target Lambda(s) it needs.
- [ ] Apply in dev; `ListTools` through the real MCP edge returns the curated tool names.
- [ ] Credential-provider hook remains empty/unset on every target (reserved seam, no outbound providers at v1).
