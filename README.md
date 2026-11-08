# Creator Agent Reliability Lab

Local, synthetic reference lab for one dependable creator workflow:

```text
synthetic account check -> mock video-metadata analysis -> grounded dialogue draft
-> durable save -> close/reopen -> retrieve the same result
```

TypeScript (strict) + Node 24 + Fastify + Zod + `pg` + **real local PostgreSQL 17** (Docker, loopback only).

> **What is real and what is not**
>
> - **Real:** TypeScript runtime, PostgreSQL migrations, transactions, row-level security with non-privileged
>   roles, `FOR UPDATE SKIP LOCKED` claims, leases and fencing, and real OS-process crashes in smoke/tests.
> - **Simulated (deterministic doubles):** provider profiles, scripted outcomes and a persistent
>   _synthetic_ charge ledger; "video analysis" returns precomputed fictional metadata.
> - **Not here:** no real TikTok connection, media-provider call, ffmpeg, LLM inference, Vercel, Supabase
>   cloud/JWT, Langfuse/PostHog, mobile app, real money, users, testimonials or client outcomes.
> - Synthetic evaluation proves **fixture-defined** routing, contract, state and recovery invariants — not
>   real-model quality or production readiness. The `x-demo-actor` header is **not** authentication.
> - AI-assisted implementation. Owner review and the live demonstration remain human steps.
> - All creators (`desk-notes`, `study-sparks`), the product (`TallyCube`), videos, briefs and faults are
>   original and fictional.

## Quick start (PowerShell)

Requires Node 22.12+/24 and a running Docker Desktop. Everything installs project-locally.

```powershell
npm ci
npm run db:up        # project-scoped container on 127.0.0.1:55439, named lab volume
npm run db:migrate   # creates creator_lab, creator_lab_test, creator_lab_eval; roles; RLS
npm test             # 55 tests on real Postgres (RLS, claims, crash recovery, sentinels)
npm run evaluate:hardened          # exit 0 = every gate passed
npm run evaluate:baseline          # EXPECTED BASELINE FAILURE: exit 3
if ($LASTEXITCODE -ne 3) { throw "baseline did not reproduce its defects (exit $LASTEXITCODE)" }
npm run compare      # requires both complete reports from the same dataset hash
npm run smoke        # real API process + worker processes + Postgres, incl. a hard crash
npm run demo         # five-minute narrated walkthrough
```

`npm run evaluate:baseline:expect` asserts the exit-3 contract and returns 0 (used by CI).

| Command                                               | Purpose                                                  |
| ----------------------------------------------------- | -------------------------------------------------------- |
| `npm run api`                                         | Start the localhost API on 127.0.0.1:38471               |
| `npm run worker` / `npm run worker:once`              | Worker loop / one claim                                  |
| `npm run client -- submit --key my-key-0001`          | Tiny HTTP client (`status`, `trace`, `drafts`, `health`) |
| `npm run ops -- list --state RECONCILIATION_REQUIRED` | Operator inspection (see `docs/runbook.md`)              |
| `npm run db:reset -- --main` / `--test` / `--eval`    | Clears lab tables only, after an identity check          |
| `npm run db:down`                                     | Stops the lab container; **keeps** the volume            |

Cleanup: `docker compose -p creator-agent-reliability-lab down` keeps the named volume
`creator-agent-reliability-lab-pgdata`; adding `-v` **explicitly deletes it** (full reset). Nothing else is
touched. Credentials in `compose.yaml`/`.env.example` are local, throwaway, non-production values.

## API (localhost only)

```text
GET  /health
POST /v1/analysis-jobs                     -> 202 after commit | 200 replay | 409 key reuse
GET  /v1/analysis-jobs/:jobId              -> state + client_guidance (poll | show_draft | show_error | await_operator)
GET  /v1/analysis-jobs/:jobId/trace        -> sanitized trace events
GET  /v1/conversations/:conversationId/drafts
```

POST accepts only `conversation_id`, `product_id`, `video_id`, `brief_id`, `idempotency_key` (strict schema).
Clients cannot set provider, faults, retry policy, URLs, ownership or state.

## How it works (short)

- **Durable jobs:** `READY → RUNNING → RETRY_WAIT | DRAFT_READY | FAILED | RECONCILIATION_REQUIRED`.
  Short claim transaction (`SKIP LOCKED`, lease, fencing token); no transaction spans provider work.
- **Checkpoints:** immutable `stage_results`; provider **intent** recorded before every invocation; immutable
  **receipt** after. Restart reuses receipts and reconciles open intents.
- **Uncertainty:** ambiguous timeouts reconcile by synthetic status lookup / idempotent replay; without either
  capability the job enters `RECONCILIATION_REQUIRED` — no blind retry, no paid fallback. Local fencing stops
  stale commits; it **cannot** cancel remote work or guarantee exactly-once external side effects.
- **Grounding:** context is scoped to creator, original conversation, job and pinned profile/product/brief
  revisions; claims must match approved facts of the pinned revision. This is structured fixture-claim checking,
  not semantic entailment or general hallucination detection.
- **Atomic save:** accepted candidate + draft + terminal state in one transaction; composite FK pins the
  draft to the job's original conversation; a trigger forbids rewriting terminal results.

## Evidence

- Reports from actual runs: `.artifacts/eval/` (git-ignored). Selected synthetic samples: `docs/evidence/`.
- Audit findings: `docs/audit-report.md`. Runbook: `docs/runbook.md`. Demo script: `docs/demo-script.md`.
- Specs: `specs/2026-11-07-creator-agent-reliability/`. Progress and exact results: `BUILD_REPORT.md`.
- Method: `AUDIT_METHODOLOGY.md`, `REMEDIATION_PLAN.md`. Dependency licenses: `docs/THIRD_PARTY_LICENSES.md`.
- CI: `.github/workflows/ci.yml` is **configured, not verified** on hosted GitHub Actions (no remote yet).

Project license: not yet chosen (owner decision).
