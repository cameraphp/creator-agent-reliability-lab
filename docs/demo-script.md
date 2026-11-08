# Five-minute demo script (English)

Prerequisite (off camera): `npm run db:up; npm run db:migrate; npm run evaluate:hardened;
npm run evaluate:baseline:expect; npm run compare`.

**0:00 — Framing (20 s).** "This is a local, synthetic lab. Real TypeScript and real Postgres; the providers,
creators, product and videos are fictional doubles. It shows a method for stabilizing an agent workflow, not
a shipped product."

**0:20 — Complete journey (60 s).** Run `npm run demo`. Point out: `POST` returns 202 only after the job
commits; the client closes the app; the worker drafts; reopening reads the saved draft (six alternating
lines, the literal CTA last, `NEEDS_HUMAN_REVIEW`, claims mapped to approved fact ids).

**1:20 — Three baseline defects (70 s).** In the demo output:

- F01: the timeout after acceptance → baseline falls back blindly: 3 billable ops instead of 2.
- F02: the user switches chats → baseline saves the draft into the wrong conversation.
- F03: crash between "ready" and "saved" → ready-without-artifact, then reopen pays to regenerate.

**2:30 — Hardened on the same inputs (60 s).** Same scenarios: no defects, 2 billable ops; show the trace
`lease.reclaimed_expired → provider.receipt_reused → draft.saved` and `reconciliation.status_lookup`.
Optionally run `npm run smoke` to show a real worker process exiting 137 and a second process recovering.

**3:30 — Regressions and metrics (50 s).** Show the category table and metrics (from `compare`): baseline
defects in F01/F02/F03, hardened 32/32; duplicate simulated charge units vs 0. Mention the sentinels: each
fix, when removed, makes a test fail. Baseline exit code 3 is the documented expected failure.

**4:20 — Boundaries and next step (40 s).** "Simulated credits are not money; fixture checks are not model
quality. Before production I would validate one real provider's idempotency and status semantics, map the
real account/video/persistence path read-only, and only then patch the highest-impact recovery gaps."

PowerShell note: check `$LASTEXITCODE` after each command; `npm run evaluate:baseline` is expected to be 3.
