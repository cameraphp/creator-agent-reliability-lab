# Audit methodology — stabilizing an EXISTING creator-agent product

How this lab's method would be applied to a real, existing product **with written authorization**. The lab
itself contains no client code or data; nothing here describes any specific company's system.

## Principles

- Read-only first: no writes, deploys, account edits or provider calls during discovery.
- One complete journey end to end before any breadth: **account data → video stage → provider/router →
  persistence → app reopen**.
- Evidence over opinion: every finding needs a reproducible case, the stage where it occurs and a trace or
  database row that shows it. No rewrite is prescribed without that evidence.
- Separate three lists: **keep** (works, has tests or clear invariants), **patch** (specific defect with a
  local cause), **remove** (complexity that adds failure modes without measured benefit).

## Steps

1. **Scope and access (authorized).** Confirm repositories, environments, read-only database role, provider
   dashboards, and which data is synthetic vs real. Agree what may not be copied off-system.
2. **Journey map.** For the one journey, record each hop: entry point, durable state written, idempotency
   key (if any), provider call and its capability (idempotency key? status lookup? billing on accept?),
   timeout/retry policy, where the result is stored and how the app finds it after reopen.
3. **Invariant checklist** (from this lab):
   - Is a job durable before the client is told "accepted"? Does a disconnect cancel or orphan it?
   - Is there a durable intent before each paid call and an immutable receipt after it?
   - What happens on timeout: reconcile, retry, fallback? Can a fallback double-charge?
   - Are context/cache keys scoped by actor, conversation, job and revisions?
   - Is the destination the job's original conversation, independent of the UI's current screen?
   - Are final artifact + terminal state written atomically? Can a stale worker overwrite them?
   - Does reopening ever trigger generation?
   - Is creator isolation enforced in the database (RLS/role), or only in application code?
4. **Reproduce locally.** Build the smallest fixture-driven reproduction for each suspected defect (as in
   `evaluations/v1/dataset.json`): identical inputs before and after, scripted provider outcomes, fake clock.
5. **Classify and rate.** For each finding: observed behavior, local cause, illustrative impact, severity
   rationale, evidence path, fix, linked regression test, residual risk (format of `docs/audit-report.md`).
6. **Patch in order of impact,** each with a sentinel test that fails if the fix is removed.
7. **Measure** with the same dataset: wrong-context deliveries, invalid final artifacts, duplicate
   simulated charge units, recovery success and safe rejection — server persistence and client delivery as
   separate stages.

## Out of scope for an audit

Model-quality claims, app-store review, real-user metrics and production security certification. These need
their own access, data and explicit agreement.
