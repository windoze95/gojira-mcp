# Testing

vitest with `v8` coverage. 154 tests across 24 files at the time of
writing — covering encryption, atomic OAuth rotation, bounded concurrent
refresh idempotency + reuse detection,
registered-client storage, operation journal, rate limiter with NearLimit
feedback, Atlassian error mapping and retry/backoff, dry-run consent,
registry filtering with operator-floor, the org-admin allowlist gate,
op-tool construction and dispatch, revert context/scope/coverage, and
site-pinning enforcement.

Live-tenant coverage is a **separate** suite: `npm run e2e` (see
[battle-testing.md](battle-testing.md)).

## Commands

```bash
npm test                # one-shot unit run
npm run test:watch      # interactive
npm run test:coverage   # with coverage report
npm run e2e             # live battle tests (skips without .env.e2e)

npx vitest run path/to/file.test.ts             # single file
npx vitest run -t "reset_floor_until"           # by test name
```

`vitest.config.ts` includes `tests/**/*.test.ts` only; the e2e suites are
`tests/e2e/**/*.e2e.ts` under `vitest.e2e.config.ts`, so they never run as
part of `npm test`.

Coverage reports land in `coverage/` (HTML, lcov, text).

## Mock boundaries

| Boundary | How |
|---|---|
| Redis | `ioredis-mock` — in-memory, ioredis-compatible. Helper at `tests/helpers/redis.ts` flushes per-instance to isolate. |
| Atlassian HTTP | Not stubbed in unit tests — covered indirectly via `mapAtlassianError` (constructs `AtlassianApiError` directly) and `withRetry` (fake transports). Real round-trips belong in the e2e suite, not here. |
| MCP transport | Not exercised in unit tests — the SDK's transport is well-tested upstream and our `wrapHandler` is the integration point. |
| Encryption | Never mocked. The implementation is deterministic given a fixed key and side-effects-free. |

## What's covered

Each safety-critical path called out in the project's design properties has
a test that owns it:

| Property | Test file |
|---|---|
| AES-GCM encrypt/decrypt + tamper detection | `tests/auth/encryption.test.ts` |
| Atomic RT rotation, bounded duplicate replay, strict reuse burn, contained reuse, binding, and legacy migration | `tests/auth/oauthProvider.test.ts` |
| DCR client storage — secret only for confidential clients | `tests/auth/clientsStore.test.ts` |
| admin_org gate — operator-declared allowlist, fails closed | `tests/auth/orgAdminVerifier.test.ts` |
| Operation journal write + paged read + failure handling | `tests/operations/journal.test.ts` |
| Rate-limiter capacity, NearLimit feedback, soft-cap | `tests/middleware/rateLimiter.test.ts` |
| Atlassian error mapping (every code path of `mapAtlassianError`) | `tests/atlassian/errors.test.ts` |
| Idempotency-aware retry/backoff (no duplicate writes) | `tests/atlassian/retry.test.ts` |
| Dry-run + JSON Patch generator | `tests/consent/dryRun.test.ts` |
| Registry filtering — operator allowlist (`GOJIRA_ENABLED_GROUPS`) and admin_org gate | `tests/tools/registry.test.ts` |
| `oauth_or_api_token` credential resolution + client-factory tenant guard | `tests/tools/revertContext.test.ts` |
| Op-tool schema merge, build-time guards, dispatch, `request.op` injection | `tests/tools/defineOpTool.test.ts` |
| Every op that claims revertibility has a reverter, and no dead keys | `tests/tools/opRevertCoverage.test.ts` |
| Revert demands the *original* tool's group, incl. via the legacy alias map | `tests/tools/revertScope.test.ts` |
| Site pinning resolveCloudId | `tests/tools/sitePinning.test.ts` |

### Revert coverage is manifest-driven, not source-walked

The old `tests/tools/revertCoverage.test.ts` read the tool `defs/` sources and
regexed for `revertible: true` / `reverters.register(...)` pairs. That is gone.
It could only see literals in source text, so it went blind the moment an op's
revertibility became a manifest field rather than a line of code, and it had no
way to express `tool#op` keys at all.

`tests/tools/opRevertCoverage.test.ts` replaces it by asserting against the
machine truth `defineOpTool` already builds — the per-tool op manifest
(`def.ops`), the reverter registry, and the legacy alias map:

- every op with `claimsRevertible` has a reverter registered under `tool#op`;
- every `tool#op` key resolves to a live tool *and* a live op — no dead keys;
- the bare (non-`#`) keys are exactly the three revertible single-op keepers:
  `automation.createRuleFromTemplate`, `confluence.setContentRestrictions`,
  `projects.delete`. One extra is dead; one missing is a keeper whose revert
  promise silently broke;
- `admin_org` tools register no reverters and claim no revertibility;
- every legacy alias points at a live tool and op, and no alias shadows a live
  tool name (which would make canonicalization ambiguous);
- op tools stay homogeneous — all-destructive or all-read — and annotate to
  match.

Nothing here parses source, so it stays true as the defs are refactored.

## What's NOT covered by unit tests

- End-to-end HTTP flows. We trust express + the SDK + helmet/cors at
  their published versions.
- Real Atlassian responses. That's what `npm run e2e` is for — see
  [battle-testing.md](battle-testing.md).
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
  (catches "added a tool or an op, forgot to regenerate"). The generated file
  ends with the **Legacy name map** appendix — the pre-collapse → current
  name table, emitted from the live alias registry — so the same gate also
  catches a legacy alias added, dropped, or repointed without the
  audit/SIEM migration table being updated to match.
- `npm run e2e` is safe to add — the suites skip themselves when the
  `E2E_*` env is absent — but it only proves anything on a runner that
  holds live sandbox credentials.

Coverage thresholds: aim for 80% line coverage on `src/auth/`,
`src/operations/`, `src/middleware/`, `src/atlassian/errors.ts`,
`src/consent/`. `src/tools/defs/*` doesn't need high coverage — they're
mostly thin upstream pass-throughs.

## Running against real Atlassian

Use the e2e rig — `tests/e2e/`, run with `npm run e2e`. It drives the real
tool pipeline (permission gate, rate limit, credential resolution, cloudId
pinning, client factories, journaling, error mapping) over real HTTP against
a live tenant; only the OAuth refresher and the API-token store are
substituted from env, and Redis stays in-memory. Credentials come from
`.env.e2e` (copy `.env.e2e.example`); suites skip themselves when `E2E_*` is
absent. Point it at a **non-production tenant** — the suites create and
delete real objects. Full detail in
[battle-testing.md](battle-testing.md).

For exploratory work, the manual loop still applies:

1. Stand up a local instance: `npm run dev` with a `.env` pointing at
   a sandbox Atlassian site.
2. Use Claude Code or `mcp-inspector` to issue tool calls.
3. Watch logs (pino dev mode is colourized).

Be careful with destructive tools — keep `commit:true` off until you
mean it.

## See also

- [Battle-testing (live e2e)](battle-testing.md)
- [Repo layout](repo-layout.md)
- [Adding a tool](adding-a-tool.md)
