# Session lifecycle

The MCP transport is **per-session, in-memory, ephemeral**.

```ts
interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  createdAt: number;
}
const sessions = new Map<string, SessionEntry>();
```

## Creation

- `POST /mcp` **without** an `Mcp-Session-Id` header — `createMcpSession()`:
  1. instantiate `new McpServer({ name: "gojira-mcp", version: "0.1.0" })`
  2. read `clientId` from `req.auth`
  3. `registerSessionTools(server, deps, { clientId })`
     filters and registers tools through `registerWrappedTool`
  4. instantiate `new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() })`
  5. `transport.onclose = () => sessions.delete(transport.sessionId)`
  6. `await server.connect(transport)`
  7. `transport.handleRequest(req, res, req.body)` — the `onsessioninitialized`
     hook fires inside the SDK and writes the session id into our map

## Continuation

- `POST /mcp` **with** an `Mcp-Session-Id` matching an entry in the map →
  route directly to that transport.
- `GET /mcp` opens an SSE stream for server-initiated notifications on the
  same transport.
- `DELETE /mcp` closes the transport and removes the entry.

## Cleanup

- `transport.onclose` removes the entry if the transport dies for any
  reason (client disconnect, transport-level error).
- **Server restart wipes the session map** entirely. Clients must re-call
  `initialize`. They do **not** need to re-OAuth — the MCP bearer is still
  valid in Redis (1h AT, 30d RT).
- Session IDs never identify a user. Identity is re-derived from the bearer
  on every request via `requireBearerAuth` → `verifyAccessToken`.

## Tool registration is per-session

`registerSessionTools` builds a `RegistrationFilter` from the
deployment config:

```ts
const filter = {
  orgAdminEnabled: config.orgAdmin.enabled,
  enabledGroups: config.enabledGroups, // operator allowlist
};
```

Then it iterates `allTools()` and registers only those that pass the
filter. The same predicate is enforced again at dispatch time inside
`wrapHandler` as defense in depth — if a tool somehow leaked into the
registered set, the dispatch layer still refuses it.

A single `McpServer` instance is created per session, but tool handlers
close over `getContext()` not over a captured user — the user is resolved
from `extra.authInfo.extra.accountId` on every call. The pattern would
survive a shared `McpServer` instance across users; we keep one per session
purely because the SDK's tool registry is session-scoped.

## Practical implications

- **Adding a tool** doesn't require a server restart; on the next
  `initialize` call the new tool is registered.
- **Revoking a token** via `POST /revoke` invalidates future calls
  immediately, but does not actively tear down live sessions. Live sessions
  fail at the next bearer-protected hop because `verifyAccessToken` will
  return `invalid_grant`.
- **Changing the operator allowlist** (`GOJIRA_ENABLED_GROUPS`) requires
  a process restart. Existing sessions stay registered with the previous
  filter set; new sessions pick up the new allowlist. Defense-in-depth
  at dispatch time means newly-disallowed tools still fail-closed even
  if they somehow leaked into a long-lived session. The session map's
  registered tools came from the old bearer's scopes and are not mutated
  in place.

## See also

- [Auth bridge](auth-bridge.md)
- [Tool registry overview](../tools/overview.md)
- [Permission groups](../tools/permission-groups.md)
