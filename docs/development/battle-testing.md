# Battle-testing (live e2e)

`npm run e2e` drives the **real tool pipeline** — the full `registerWrappedTool`
wrapping (permission gate, rate limit, credential resolution, cloudId pinning,
client factories, journaling, error mapping) — with real HTTP against a live
Atlassian tenant. Only two boundaries are substituted, both fed from env: the
OAuth token refresher and the API-token store. Redis is in-memory, so runs are
hermetic server-side.

## Setup

```bash
cp .env.e2e.example .env.e2e   # fill in — see the comments in the example
npm run e2e
```

Point it at a **non-production tenant**. The suites create and delete real
objects — a request type, a form template, automation rules, a Confluence
space — and leave the tenant clean on success. Suites skip themselves when
`E2E_*` is absent, so `npm run e2e` is safe (and a no-op) in CI.

## What it proves

| Suite | Round-trip |
|---|---|
| `jsm.e2e.ts` | service desks/queues/orgs/KB reads; request type dry-run → create → delete |
| `forms.e2e.ts` | form template create → design export → update → delete; issue-form reads |
| `automation.e2e.ts` | rule list + template search (paginated); create-from-template → export → **raw create** → enable/disable → delete → 404 |
| `confluence.e2e.ts` | space create → v2 read → rename → permissions → delete; templates/blueprints |
| `revert.e2e.ts` | `gojira.revertOperation` live (journaled create → committed revert deletes it); refusal on irreversible ops |

## Why it exists

The unit suite can't catch spec-vs-runtime drift — this harness already has:
a 412 from JSM's experimental-API gate the raw probes masked, and raw
ZodErrors surfacing as `UNEXPECTED_ERROR`. When a tool's contract changes
upstream, this is the net that catches it. Run it before every release and
after any tool rewrite.
