# BUILD_REPORT — Creator Agent Reliability Lab

Status: **all four checkpoints complete locally (2026-11-07).** Every declared local gate passed in the
final run below. _Historical (local build phase):_ at build time hosted CI was configured but not verified
(no remote existed), and nothing was initialized in Git, committed, pushed, published or deployed.

## Publication note (2026-11-07, after the local build)

- At the owner's request the lab was initialized in Git and the initial commit
  [`55aae03`](https://github.com/cameraphp/creator-agent-reliability-lab/commit/55aae0308b5fe15d2a32fff39f8c919c00a84d10) was pushed to `main` of `cameraphp/creator-agent-reliability-lab`.
- The first hosted GitHub Actions run, [#1](https://github.com/cameraphp/creator-agent-reliability-lab/actions/runs/42429152724), succeeded on that commit. Only its step conclusions were
  checked; hosted job logs were not read, so hosted test/scenario counts are not independently confirmed.
- Local evidence (this report) and hosted evidence (step conclusions of run #1) are separate. Later commits
  need their own hosted runs.
- Still open: owner review, video recording, real-provider validation and a project-license decision. Nothing
  was released, tagged or deployed.

## Resume instructions

From the lab folder (`creator-agent-reliability-lab/` inside the improvement-plan workspace), in PowerShell:
`npm ci; npm run db:up; npm run db:migrate`, then rerun the gates in `docs/runbook.md` §6.

## Checkpoints

- [x] 1. Requirements, schemas, fixtures, migrations (`specs/…/requirements.md`, `fixtures/v1`, `migrations/001–004`)
- [x] 2. Happy journey with save/reopen and local isolation (`tests/journey`, `api`, `rls`, `claims`)
- [x] 3. Three failure classes, before/after evidence, regression evaluation (`evaluations/v1`, `src/eval`, `tests/recovery`, `sentinels`, `process-crash`)
- [x] 4. CI configuration, audit/runbook and handoff (`.github/workflows/ci.yml`, `docs/`, method/plan docs)

## Environment

| Item         | Value                                                                                                                                                            |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OS           | Windows 11 Pro 10.0.26200                                                                                                                                        |
| Node / npm   | v24.9.0 / 11.6.0 (engines `^22.12.0 \|\| ^24.0.0`)                                                                                                               |
| Docker       | 29.9.1 (Docker Desktop was stopped at preflight; launched once, no repair/installation)                                                                          |
| Postgres     | `postgres:17.11-alpine` → server 17.11                                                                                                                           |
| Runtime deps | fastify 5.12.7, pg 8.23.1, zod 4.6.7                                                                                                                             |
| Dev deps     | typescript 6.0.3, vitest 5.0.5, eslint 10.14.0, typescript-eslint 8.72.1, @eslint/js 10.0.1, prettier 3.9.10, tsx 4.23.15, @types/node 24.19.2, @types/pg 8.23.1 |

TypeScript 7.0.2 was available but not used: typescript-eslint 8.72.1 requires `typescript <6.1.0`.

Preflight: target folder absent (no previous Python build, no conflict); ports 55439 and 38471 free; no
containers existed; four pre-existing volumes belong to other projects and were not touched.
`C:\Program Files\PostgreSQL\17|18` hold only leftover `data` folders (no server binaries); untouched.

## Final gate run (PowerShell, `$LASTEXITCODE` per command)

| Command                            | Exit  | Time   | Notes                                                                                  |
| ---------------------------------- | ----- | ------ | -------------------------------------------------------------------------------------- |
| `npm ci`                           | 0     | 32.4 s | 250 packages, lockfile v3                                                              |
| `npm run typecheck`                | 0     | 6.8 s  | strict, `noUncheckedIndexedAccess`                                                     |
| `npm run lint`                     | 0     | 6.0 s  | 3 inline `no-explicit-any` exceptions, all in demo/smoke HTTP clients, documented      |
| `npm run format:check`             | 0     | 4.1 s  |                                                                                        |
| `npm run db:up`                    | 0     | 2.1 s  | healthy container                                                                      |
| `npm run db:migrate`               | 0     | 1.9 s  | idempotent; checksum drift check                                                       |
| `npm test`                         | 0     | 36 s   | **8 files, 55 tests passed**, 0 skipped                                                |
| `npm run build`                    | 0     | 4.4 s  |                                                                                        |
| `npm run evaluate:hardened`        | 0     | 17.1 s | HARDENED_GATES_PASSED, 32/32 scenarios, routing 8/8                                    |
| `npm run evaluate:baseline`        | **3** | 6.3 s  | **EXPECTED BASELINE FAILURE**: 23/32 scenarios defective; F01, F02, F03 all reproduced |
| `npm run evaluate:baseline:expect` | 0     | 7.0 s  | asserts exit 3                                                                         |
| `npm run compare`                  | 0     | 1.2 s  | same dataset sha256 `5c1e8f40c022b239…`, complete reports                              |
| `npm run smoke`                    | 0     | 9.8 s  | 13/13 checks; real API + 2 worker processes; crash exit 137 → recovery                 |
| `npm run demo`                     | 0     | 4.6 s  | narrated walkthrough                                                                   |

Exit-code contract: hardened 0 pass / 1 gate failed / 2 harness error; baseline 3 expected failure /
4 baseline no longer reproduces all categories.

## Evaluation counts (eval-v1, actual run)

32 scenarios: 6 controls, F01 10, F02 6, F03 10; classes 11 happy, 14 recoverable, 7 unrecoverable; 8 routing cases.

| Metric                                                 | Baseline      | Hardened      |
| ------------------------------------------------------ | ------------- | ------------- |
| Scenarios with defects (CONTROL / F01 / F02 / F03)     | 1 / 7 / 6 / 9 | 0 / 0 / 0 / 0 |
| Accepted / saved drafts                                | 21/36         | 28/28         |
| Saved valid on server / eligible                       | 18/25         | 25/25         |
| Delivered valid on reopen / eligible                   | 17/25         | 25/25         |
| Recovery success / recoverable                         | 3/14          | 14/14         |
| Safe rejection / unrecoverable                         | 2/7           | 7/7           |
| Route agreement                                        | 4/8           | 8/8           |
| Wrong-context drafts / invalid final artifacts         | 12 / 13       | 0 / 0         |
| Accepted provider operations                           | 92            | 70            |
| Excess billable ops / duplicate simulated charge units | 25 / 34.854   | 0 / 0         |
| Simulated cost per accepted analysis                   | 4.863 credits | 2.696 credits |
| Time to first saved draft (logical, happy, median)     | 2200 ms       | 2200 ms       |
| Local wall clock per scenario (median)                 | ~138 ms       | ~446 ms       |

Credits are fixture price × synthetic tokens, not money. Logical time is a fake clock; wall-clock is a
local measurement that includes per-scenario DB resets. The baseline control failure (C03) comes from the
same product-only cache that causes F02 (provenance from a previous job); it is reported, not hidden.

## Evidence paths

- `.artifacts/eval/{baseline,hardened}-eval-v1.{json,md}`, `.artifacts/eval/comparison-eval-v1.{json,md}` (git-ignored)
- Selected copies: `docs/evidence/` · Findings: `docs/audit-report.md` · Validation matrix: `specs/…/validation.md`
- Per-scenario hardened trace events: `results[].trace_evidence` in the hardened JSON report

## Tested vs simulated

| Real (exercised)                                                    | Simulated                                       |
| ------------------------------------------------------------------- | ----------------------------------------------- |
| TypeScript/Node runtime, Fastify API over HTTP (smoke)              | Provider profiles, scripted outcomes, latencies |
| Postgres migrations, transactions, rollback on crash/failure        | Charge ledger (`sim_provider`, synthetic units) |
| RLS with non-privileged roles, FORCE RLS, transaction-local context | Video analysis (precomputed fixture metadata)   |
| `FOR UPDATE SKIP LOCKED`, leases, fencing, DB triggers/constraints  | Catalog revisions/account state (in-process)    |
| OS-process hard crash (exit 137) + reclaim by another process       | Client app (API reads; no mobile app)           |

## Database roles and isolation checks

- `lab_admin`: superuser in the container; migrations and identity-checked resets only.
- `lab_app`: `NOSUPERUSER NOBYPASSRLS`, not owner; SELECT/INSERT jobs, SELECT drafts, SELECT/INSERT traces.
- `lab_worker`: `NOSUPERUSER NOBYPASSRLS`, not owner; cross-creator SELECT/UPDATE(columns) on jobs for
  claiming; all other lab tables scoped by `app.creator_id`; no DELETE; no UPDATE of checkpoints; SELECT/INSERT on
  `sim_provider`; SELECT/INSERT/UPDATE on the eval-only `lab_baseline` schema (documented).
- Verified by `T-R1..T-R5`: role flags and ownership, FORCE RLS on 6 tables, cross-creator read invisibility,
  cross-creator write rejection (42501), no-context fail-closed reads/writes, single-connection pool reuse
  without context leakage (incl. after a failed transaction), worker privilege limits.
- Not proven: Supabase JWT/RLS integration or production security. `x-demo-actor` is not authentication.

## Interruptions, fixes found during the build, limits

- Docker Desktop was stopped; launched once at preflight. No other system changes.
- Harness bugs found and fixed before results were recorded: (1) a revision published at the same logical
  millisecond as a save was misattributed (publication now takes 1 logical ms); (2) byte-identical
  stale-worker overwrites were invisible (now detected via Postgres `xmin`); (3) the malformed-JSON fixture had
  unbalanced brackets (looked truncated); (4) the CLI crash switch lacked a stage filter.
- A temporary gate log was briefly written to `%TEMP%` (outside the lab folder) during an intermediate run
  and was deleted.
- Not implemented: circuit breaker (optional); idempotent replay _without_ status lookup has no fixture
  profile (covered by the provider contract test `T-I1` only).
- Docker resources left in place: container `creator-agent-reliability-lab-pg` (running, 127.0.0.1:55439),
  volume `creator-agent-reliability-lab-pgdata`, network `creator-agent-reliability-lab_default`, images
  `postgres:17.11-alpine` and `postgres:17-alpine` (same image id, pulled to pin the version). Stop:
  `npm run db:down` (keeps data); remove: `docker compose -p creator-agent-reliability-lab down` (add `-v` to
  delete the volume); optional `docker image rm postgres:17-alpine`.

## Next steps

1. Owner review of code, docs and claims; record the demo (`docs/demo-script.md`).
2. Decide on a project license (Git publication and a first hosted CI run are done; see the publication note).
3. Validate one real provider's idempotency/status/billing semantics in a sandbox before trusting reconciliation.
