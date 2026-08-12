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
│   │   ├── revert.ts                  # reverter registry + assertRevertible
│   │   └── legacyAliases.ts           # pre-collapse name → tool+op; canonical keys
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
│           ├── defineTool.ts          # author-facing helper (single-op tools)
│           ├── defineOpTool.ts        # op-parameterized tools: merged schema,
│           │                          #   per-op strict validation + dispatch,
│           │                          #   request.op injection, reverter/alias
│           │                          #   registration, machine op manifest
│           ├── index.ts               # allTools() aggregator
│           │                          # counts below are `tools (ops)`
│           ├── utility.ts             # gojira.* — 6 (7)
│           ├── jsm.ts                 # jsm.* — 4 (16)
│           ├── requestBuild.ts        # jsm.inspectRequestBuild — 1 (1)
│           ├── forms.ts               # forms.* — 3 (8)
│           ├── workitems.ts           # workitems.* — 3 (6)
│           ├── assets.ts              # assets.* — 7 (23)
│           ├── automation.ts          # automation.* — 6 (11)
│           ├── customfields.ts        # customfields.* — 3 (8)
│           ├── projects.ts            # projects.* read+create+archive — 2 (5)
│           ├── deleteProjects.ts      # projects.delete — 1 (isolated group)
│           ├── schemes.ts             # schemes.* — 6 (20)
│           ├── workflows.ts           # workflows.* — 4 (11)
│           ├── confluence.ts          # confluence.* — 5 (10)
│           ├── agile.ts               # agile.* — 2 (8)
│           ├── filtersDashboards.ts   # filters.* + dashboards.* — 6 (10)
│           └── orgAdmin.ts            # orgAdmin.* — 6 (17)
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

No circular imports. `defs/utility.ts` is the only module that uses the
lazy-import pattern, and it does so twice, both inside handlers so the cycle
never forms at module load:

- `gojira.listEnabledTools` imports `defs/index.ts` to enumerate the catalog.
- `gojira.revertOperation` imports `defs/index.ts` **and**
  `operations/legacyAliases.ts` for its group gate — it resolves the journal
  entry's tool (through the alias map, for pre-collapse entries) back to a def
  so it can require the *original* tool's permission group rather than
  `utility`.

`defineOpTool.ts` imports `operations/revert.ts` and
`operations/legacyAliases.ts` eagerly; both are leaf modules under
`src/operations/` with no dependency back on `src/tools/`, so registration at
module load is safe.

## File-naming conventions

- camelCase for source files: `oauthProvider.ts`, `tokenStore.ts`.
- Test files mirror source layout under `tests/` with `.test.ts`
  suffix.
- Each tool file under `defs/` exports a single named function returning
  an `AnyToolDef[]`: e.g. `export const customFieldTools = (): AnyToolDef[] => [...]`.
- `defineOpTool(...)` must be called at **module** level — a `const` beside
  that exported function, never inside it. The factory registers reverters and
  legacy aliases as side effects, and both registries reject a second,
  different registration under the same key, which is exactly what a per-call
  invocation produces.
- Reverters for op tools are declared inline as the op's `revert:` field;
  `defineOpTool` registers them under `<tool>#<op>`. The three single-op tools
  that still have one register it by hand at the bottom of their own file:
  `reverters.register("<tool name>", async (entry, anyCtx) => {...})`.

## Build artefacts

- `dist/` — emitted by `tsc`. Mirrors `src/` structure with `.js`,
  `.d.ts`, `.js.map` per file. Production runtime.
- `coverage/` — emitted by `vitest run --coverage`. Open
  `coverage/index.html`.

Both are gitignored.

## See also

- [Adding a tool](adding-a-tool.md)
- [Testing](testing.md)
