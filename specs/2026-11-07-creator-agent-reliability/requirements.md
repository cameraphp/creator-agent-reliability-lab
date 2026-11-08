# Requirements — Creator Agent Reliability Lab (2026-11-07)

Scope: one synthetic journey — synthetic account check → mock video-metadata analysis → grounded
dialogue draft → durable save → close/reopen → retrieve the same result. TypeScript + Node + real
local PostgreSQL. All data, providers and faults are synthetic. No real platform, model or money.

## Journey and contracts

- **R1** API accepts only allowlisted synthetic selectors (`conversation_id`, `product_id`, `video_id`,
  `brief_id`) plus an `idempotency_key`; actor comes from a server-side allowlist header. Unknown fields
  (provider, faults, retry policy, URL, ownership, state) are rejected.
- **R2** Submission returns `202` only after the job row and its `job.submitted` trace commit.
- **R3** A separate worker processes jobs; HTTP disconnect neither owns nor cancels a job.
- **R4** Candidate contract: exactly `line_count` lines alternating CREATOR/COHOST starting with CREATOR,
  final line ends with the literal CTA, total words within `word_range`, audience equals the original
  creator profile, `needs_human_review = true`, provenance equals the job's pinned revisions.
- **R5** Every claim maps to an approved fact of the pinned product revision with the exact value, the
  value appears in the cited line, and its reference equals the retrieved fact's `source_ref`. Unknown,
  unapproved, mismatched or superseded facts are rejected; digits or restricted phrases not covered by a
  verified claim are rejected. (Structured fixture-claim checking only — not semantic entailment.)
- **R6** Required facts missing from approved evidence → safe rejection (`EVIDENCE_MISSING`); unapproved
  notes are never substituted.

## Durability and lifecycle

- **R7** Jobs use explicit states `READY, RUNNING, RETRY_WAIT, DRAFT_READY, FAILED,
RECONCILIATION_REQUIRED`; stage results are immutable checkpoints that recovery reuses.
- **R8** Claims use `FOR UPDATE SKIP LOCKED`, leases and a fencing token; no transaction is held open across
  provider work; only the current owner can advance a job; terminal results cannot be overwritten.
- **R9** Exact resubmission (same key + same canonical fingerprint) returns the existing job; same key with
  changed input → `409`. A fixture-scoped semantic rule returns the existing non-failed job for a new key
  with identical selectors and pinned revisions.
- **R10** Final artifact, accepted candidate and terminal state commit atomically; the artifact belongs to
  the job's original conversation regardless of the client's active chat.
- **R11** Reopen/poll/reconnect read the saved artifact without any new provider operation.
- **R12** Restart reclaims only expired leases and retry-due jobs; completed stages/receipts are reused.

## Provider calls

- **R13** A durable call intent precedes every invocation; receipts are immutable once committed.
- **R14** Ambiguous outcomes reconcile via status lookup / idempotent replay when the profile supports it;
  otherwise → `RECONCILIATION_REQUIRED`, with no blind retry and no paid fallback.
- **R15** Known pre-acceptance failures retry with deterministic backoff inside one shared per-job
  invocation budget; a backup profile is used only when the primary is known not to have accepted.
- **R16** Routing checks task, output mode and context requirements and records selection/exclusion reasons.
- **R17** At most one targeted repair; the repair is a complete replacement validated from scratch.

## Isolation, observability, evaluation

- **R18** Real RLS: app and worker roles are not superuser/owner/BYPASSRLS; creator context is
  transaction-local; missing context fails closed; no cross-creator reads/writes; no pool leakage.
- **R19** Sanitized trace events for stage transitions, routing, attempts, reconciliation and persistence.
- **R20** Versioned dataset ≥ 24 scenarios, positive controls and exactly three defect categories
  (F01 routing/retry/fallback, F02 wrong context/destination, F03 save/reopen corruption), executed with
  identical inputs against baseline and hardened; metrics computed from actual runs.
- **R21** Baseline exits with code 3 when it exhibits defects; hardened gates exit 0 only if every
  invariant holds; sentinels prove each F-category gate fails when its regression is reintroduced.
- **R22** CI config with disposable Postgres; local smoke drives real API + worker + Postgres processes.
