# Remediation plan template

A phased intervention for an existing product. Hours are intentionally blank: real estimates require
access, a local reproduction and an explicitly agreed scope.

## Phase 1 — Discovery (read-only)

- Map one journey (account → video → provider/router → persistence → reopen); collect traces/rows.
- Inventory provider capabilities: idempotency keys, status lookup, billing-on-accept, timeout behavior.
- **Acceptance:** written journey map; invariant checklist answered with evidence; keep/patch/remove lists.

## Phase 2 — Highest-impact recovery fixes

- Durable submission (commit before 202) + idempotency key + server fingerprint (409 on changed input).
- Durable call intent → immutable receipt; reconciliation or `RECONCILIATION_REQUIRED`; no blind fallback.
- Job-scoped context and destination; revision pinning; approved-evidence-only grounding.
- Atomic final save; fenced ownership; terminal-overwrite guard; read-only reopen.
- **Acceptance:** each fix ships with a sentinel test that fails when the fix is removed; zero
  wrong-context deliveries, zero invalid saved artifacts and zero duplicate simulated charges on the agreed
  dataset; no increase in safe-rejection failures.

## Phase 3 — Measurement and CI

- Versioned scenario dataset; baseline vs hardened reports from the same dataset hash; release smoke over
  real processes; CI with a disposable database.
- **Acceptance:** CI green on a hosted run (verified, not just configured); reports reproducible locally.

## Phase 4 — Founder handoff

- Runbook (states, safe recovery, ambiguous-charge investigation, gate rerun); a recorded walkthrough.
- **Acceptance:** founder can run gates and resolve one reconciliation case unaided.

## Hour estimation (fill in only after discovery)

| Phase | Item                              | Assumptions | Estimate (h) | Confidence |
| ----- | --------------------------------- | ----------- | ------------ | ---------- |
| 1     | Journey map + invariant checklist |             |              |            |
| 2     | Durable submission + idempotency  |             |              |            |
| 2     | Intents/receipts/reconciliation   |             |              |            |
| 2     | Scoped context + destination      |             |              |            |
| 2     | Atomic save + fencing             |             |              |            |
| 3     | Dataset + reports + CI            |             |              |            |
| 4     | Runbook + handoff                 |             |              |            |

Subsequent client work, not certified by this lab: app-store launch review, real-user metrics, real
provider validation and production security review.
