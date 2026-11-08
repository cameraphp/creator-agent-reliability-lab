# Design (2026-11-07)

## Processes

- **API** (`src/cli/api.ts`, Fastify, 127.0.0.1:38471): validates, pins revisions, inserts the job + trace in
  one transaction as `lab_app`, returns 202 after commit.
- **Worker** (`src/cli/worker.ts`): `lab_worker` role; claims with `FOR UPDATE SKIP LOCKED`, lease + fencing
  token; every later write re-checks `state = RUNNING AND fencing_token = mine` under a row lock.
- **CLI client / demo / evaluation / ops** reuse `src/service.ts` and `src/worker/worker.ts`.

## Stages (immutable checkpoints in `lab.stage_results`)

`account_check` → `video_analysis` (provider double, fixture metadata) → `context_assembly` (scoped,
pinned, approved facts only) → `dialogue_draft` (+ ≤1 repair) → atomic finalize.

## Provider calls (`lab.provider_calls` + `sim_provider.*`)

Intent row (`INTENT`, operation id `job:stage:purpose:n`) → invoke → `RECEIVED` (immutable via trigger) |
`NOT_ACCEPTED` (retry same op id with backoff) | `AMBIGUOUS` → status lookup / idempotent replay →
otherwise `UNRESOLVED` + job `RECONCILIATION_REQUIRED`. A partial unique index forbids a second open/received
operation per (job, stage, purpose). One shared caller-attempt budget per job (5).

## Database roles and RLS

`lab_admin` (owner, migrations, identity-checked resets) · `lab_app` (SELECT/INSERT jobs, SELECT drafts,
SELECT/INSERT traces; RLS by `app.creator_id`) · `lab_worker` (jobs cross-creator for claiming; all other
tables scoped by transaction-local `app.creator_id`; no DELETE, no checkpoint UPDATE). FORCE RLS on all
creator-scoped tables. Context is set with `set_config(..., true)` inside each transaction.

## Integrity guards

`jobs_idempotency_unique`, partial `jobs_semantic_active`, `jobs_ready_has_candidate`, composite FK
draft→(job, creator, conversation), `drafts.job_id UNIQUE`, `candidates.call_id UNIQUE`, terminal-guard and
receipt-guard triggers.

## Evaluation

`evaluations/v1/dataset.json` (32 scenarios, 8 routing cases) → `src/eval/runner.ts` runs identical steps
against `HardenedEvalSystem` or `BaselineEvalSystem` (schema `lab_baseline`, CLI-only) on
`creator_lab_eval` with a fake clock; `src/eval/judge.ts` re-derives ground truth from fixtures.
Defect codes: OUTCOME_MISMATCH, EXCESS_BILLABLE_OPERATIONS, INVALID_FINAL_ARTIFACT, WRONG_CONTEXT_DELIVERY,
READY_WITHOUT_ARTIFACT, ARTIFACT_WITHOUT_READY, MULTIPLE_ARTIFACTS, DRAFT_COUNT_MISMATCH,
REGENERATED_ON_CLIENT_STEP, TERMINAL_OVERWRITTEN (Postgres `xmin`), DUPLICATE_JOB, HARNESS_ERROR.

## Deliberate non-goals

No LLM/agent framework, Redis, vector store, frontend, Supabase, Vercel, telemetry SaaS, circuit breaker.
