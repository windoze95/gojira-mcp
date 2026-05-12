# Repo layout

```
gojira-mcp/
├── README.md                          # high-level overview, doc map
├── package.json                       # scripts, deps, engines
├── tsconfig.json                      # strict, ES2022, NodeNext
├── vitest.config.ts                   # vitest + v8 coverage
├── Dockerfile                         # multi-stage node:22-alpine
├── docker-compose.yml                 # gojira-mcp + redis sidecar
├── docker-compose.caddy.yml           # TLS overlay
├── Caddyfile                          # minimal TLS reverse-proxy config
├── .env.example                       # documented env-var template
├── .gitignore
├── .dockerignore
├── docs/                              # everything in this tree
├── scripts/
│   ├── generate-encryption-key.ts     # `npm run generate-key`
│   └── gen-tool-docs.ts               # `npm run docs:tools`
├── src/
│   ├── index.ts                       # entrypoint: config → redis → app → listen
│   ├── server.ts                      # createApp: helmet, cors, /health, OAuth, /mcp
│   ├── config.ts                      # zod-validated config singleton
│   ├── auth/
│   │   ├── encryption.ts              # AES-256-GCM
│   │   ├── clientsStore.ts            # RFC 7591 dynamic client registration
│   │   ├── oauthProvider.ts           # OAuthServerProvider impl (D1, D3)
│   │   ├── oauthCallback.ts           # Atlassian callback (D4 pinning)
│   │   ├── tokenStore.ts              # token:<accountId> encrypted store
│   │   ├── apiTokenStore.ts           # apitoken:<accountId> encrypted store
│   │   ├── tokenRefresh.ts            # distributed lock + CAD release
│   │   ├── refreshFamily.ts           # D1 RT family + reuse detection
│   │   └── orgAdminVerifier.ts        # admin_org caller verification + cache
│   ├── atlassian/
│   │   ├── client.ts                  # axios wrapper with rate-limit-header callback
│   │   ├── retry.ts                   # withRetry + Retry-After
│   │   ├── errors.ts                  # mapAtlassianError (D7)
│   │   ├── identity.ts                # /me, accessible-resources, code+refresh exchange
│   │   └── assetsWorkspace.ts         # workspaceId discovery + 24h cache
│   ├── middleware/
│   │   ├── errorHandler.ts            # uniform tool error envelope
│   │   └── rateLimiter.ts             # token-bucket Lua (D6)
│   ├── consent/
│   │   ├── jsonPatch.ts               # RFC 6902 generator
│   │   └── dryRun.ts                  # commit-positive consent helpers (D5)
│   ├── operations/
│   │   ├── journal.ts                 # operation journal (D2)
│   │   └── revert.ts                  # reverter registry + assertRevertible
│   ├── redis/
│   │   └── client.ts                  # ioredis wrapper with retry/reconnect
│   ├── utils/
│   │   ├── logger.ts                  # pino with redact paths
│   │   ├── validators.ts              # issue-key, project-key, JQL escaping
│   │   └── audit.ts                   # AuditSink: stdout|file|http|syslog
│   └── tools/
│       ├── types.ts                   # ToolDefinition, ToolContext, re-exports PermissionGroup
│       ├── permissionGroups.ts        # ALL_PERMISSION_GROUPS + derived PermissionGroup type
│       ├── registry.ts                # filterTools, registerSessionTools
│       ├── wrapHandler.ts             # registerWrappedTool (per-call wrapper)
│       └── defs/
│           ├── defineTool.ts          # author-facing helper
│           ├── index.ts               # allTools() aggregator
│           ├── utility.ts             # gojira.* (7)
│           ├── jsm.ts                 # jsm.* (33)
│           ├── assets.ts              # assets.* (23)
│           ├── automation.ts          # automation.* (9)
│           ├── customfields.ts        # customfields.* (8)
│           ├── projects.ts            # projects.* read+create+archive (5)
│           ├── deleteProjects.ts      # projects.deleteJiraProject (1, isolated group)
│           ├── schemes.ts             # schemes.* (20)
│           ├── workflows.ts           # workflows.* (12)
│           ├── confluence.ts          # confluence.* (10)
│           ├── agile.ts               # agile.* (8)
│           ├── filtersDashboards.ts   # filters.* + dashboards.* (10)
│           └── orgAdmin.ts            # orgAdmin.* (24)
└── tests/
    ├── helpers/
    │   └── redis.ts                   # ioredis-mock helper for unit tests
    ├── auth/
    │   ├── encryption.test.ts
    │   └── oauthProvider.test.ts
    ├── atlassian/
    │   └── errors.test.ts
    ├── consent/
    │   └── dryRun.test.ts
    ├── middleware/
    │   └── rateLimiter.test.ts
    ├── operations/
    │   └── journal.test.ts
    └── tools/
        ├── registry.test.ts
        └── sitePinning.test.ts
```

## Boundaries between layers

The dependency arrow points from caller to callee:

```
src/index.ts
   ↓
src/server.ts ──► src/auth/oauthProvider.ts
   ↓                  ↓
src/tools/registry.ts ──► src/tools/defs/* ──► src/atlassian/client.ts
                                                    ↓
                                                  axios
   tools/wrapHandler.ts uses:
     src/auth/tokenRefresh.ts
     src/auth/apiTokenStore.ts
     src/auth/orgAdminVerifier.ts
     src/middleware/rateLimiter.ts
     src/operations/journal.ts
     src/middleware/errorHandler.ts
     src/utils/audit.ts
     src/atlassian/errors.ts
```

No circular imports. `defs/utility.ts` lazy-imports `defs/index.ts` for
the `gojira.listEnabledTools` tool — the only place that pattern
appears.

## File-naming conventions

- camelCase for source files: `oauthProvider.ts`, `tokenStore.ts`.
- Test files mirror source layout under `tests/` with `.test.ts`
  suffix.
- Each tool file under `defs/` exports a single named function returning
  an `AnyToolDef[]`: e.g. `export const customFieldTools = (): AnyToolDef[] => [...]`.
- Reverter registrations live at the bottom of the same file as the
  tool definition: `reverters.register("<tool name>", async (entry, anyCtx) => {...})`.

## Build artefacts

- `dist/` — emitted by `tsc`. Mirrors `src/` structure with `.js`,
  `.d.ts`, `.js.map` per file. Production runtime.
- `coverage/` — emitted by `vitest run --coverage`. Open
  `coverage/index.html`.

Both are gitignored.

## See also

- [Adding a tool](adding-a-tool.md)
- [Testing](testing.md)
