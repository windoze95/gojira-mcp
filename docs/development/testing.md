# Testing

vitest with `v8` coverage. 40 tests across 8 files at the time of
writing — covering encryption, OAuth provider rotation + reuse detection,
operation journal, rate limiter with NearLimit feedback, Atlassian error
mapping, dry-run consent, registry filtering with operator-floor, and
site-pinning enforcement.

## Commands

```bash
npm test                # one-shot run
npm run test:watch      # interactive
npm run test:coverage   # with coverage report

npx vitest run path/to/file.test.ts             # single file
npx vitest run -t "reset_floor_until"           # by test name
```

Coverage reports land in `coverage/` (HTML, lcov, text).

## Mock boundaries

| Boundary | How |
|---|---|
| Redis | `ioredis-mock` — in-memory, ioredis-compatible. Helper at `tests/helpers/redis.ts` flushes per-instance to isolate. |
| Atlassian HTTP | Not stubbed in unit tests — covered indirectly via `mapAtlassianError` (constructs `AtlassianApiError` directly). For integration-style tests against real Atlassian, mock `axios` per test. |
| MCP transport | Not exercised in unit tests — the SDK's transport is well-tested upstream and our `wrapHandler` is the integration point. |
| Encryption | Never mocked. The implementation is deterministic given a fixed key and side-effects-free. |

## What's covered

The 8 test files target the safety-critical paths called out in the
project's design properties:

| Property | Test file |
|---|---|
| AES-GCM encrypt/decrypt + tamper detection | `tests/auth/encryption.test.ts` |
| RT rotation + reuse detection | `tests/auth/oauthProvider.test.ts` |
| Operation journal write + paged read + failure handling | `tests/operations/journal.test.ts` |
| Rate-limiter capacity, NearLimit feedback, soft-cap | `tests/middleware/rateLimiter.test.ts` |
| Atlassian error mapping (every code path of `mapAtlassianError`) | `tests/atlassian/errors.test.ts` |
| Dry-run + JSON Patch generator | `tests/consent/dryRun.test.ts` |
| Registry filtering — operator allowlist (`GOJIRA_ENABLED_GROUPS`) and admin_org gate | `tests/tools/registry.test.ts` |
| Site pinning resolveCloudId | `tests/tools/sitePinning.test.ts` |

## What's NOT covered by unit tests

- End-to-end HTTP flows. We trust express + the SDK + helmet/cors at
  their published versions.
- Real Atlassian responses. That's an integration-test concern; out of
  scope for the unit suite.
- The audit sink's HTTP/syslog targets. Stdout and file are exercised
  indirectly through every `tool_call`-emitting test.

## Adding a test

1. Mirror the source path: source at `src/foo/bar.ts` →
   test at `tests/foo/bar.test.ts`.
2. Use the `makeRedis()` helper for anything Redis-shaped:
   ```ts
   import { makeRedis } from "../helpers/redis.js";
   beforeEach(() => { redis = makeRedis(); });
   ```
3. Don't share Redis instances across tests — `ioredis-mock` instances
   share state by default but our helper calls `flushall()` for you.
4. For tools, use `defineTool(...)` to construct fixtures in the test —
   don't import live tool defs unless the test is specifically about
   the live registry.
5. Keep tests **focused**: one tool, one behaviour, one expected
   outcome per `it()`. Long compound tests are hard to debug when the
   one assertion at the end fails.

## CI conventions (suggested)

This repo doesn't ship a CI config, but these are the gates we
recommend:

- `npm ci` (lockfile-strict install)
- `npm run typecheck`
- `npm test`
- `npm run docs:tools && git diff --exit-code docs/tools/catalog.md`
  (catches "added a tool, forgot to regenerate")

Coverage thresholds: aim for 80% line coverage on `src/auth/`,
`src/operations/`, `src/middleware/`, `src/atlassian/errors.ts`,
`src/consent/`. `src/tools/defs/*` doesn't need high coverage — they're
mostly thin upstream pass-throughs.

## Running against real Atlassian

There's no integration-test rig in the repo. The pragmatic loop:

1. Stand up a local instance: `npm run dev` with a `.env` pointing at
   a sandbox Atlassian site.
2. Use Claude Code or `mcp-inspector` to issue tool calls.
3. Watch logs (pino dev mode is colourized).

Be careful with destructive tools — keep `commit:true` off until you
mean it.

## See also

- [Repo layout](repo-layout.md)
- [Adding a tool](adding-a-tool.md)
