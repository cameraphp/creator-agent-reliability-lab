# Baseline vs hardened — eval-v1

Compatible complete reports (dataset sha256 `5c1e8f40c022b239…`). Baseline generated 2026-11-07T23:59:46.100Z; hardened generated 2026-11-07T23:59:32.789Z.
Baseline verdict: **EXPECTED_BASELINE_FAILURE** (exit 3). Hardened verdict: **HARDENED_GATES_PASSED** (exit 0).

Synthetic fixture scenarios with scripted provider doubles. This shows fixture-defined invariants, not model quality or production readiness.

## By category

| Category | Scenarios | Baseline with defects | Hardened with defects |
|---|---|---|---|
| CONTROL | 6 | 1 | 0 |
| F01 | 10 | 7 | 0 |
| F02 | 6 | 6 | 0 |
| F03 | 10 | 9 | 0 |

## Metrics

| Metric | Baseline | Hardened |
|---|---|---|
| Accepted / saved drafts | 21/36 | 28/28 |
| Saved valid on server / eligible | 18/25 | 25/25 |
| Delivered valid on reopen / eligible | 17/25 | 25/25 |
| Recovery success / recoverable | 3/14 | 14/14 |
| Safe rejection / unrecoverable | 2/7 | 7/7 |
| Route agreement | 4/8 | 8/8 |
| Wrong-context drafts saved | 12 | 0 |
| Invalid final artifacts | 13 | 0 |
| Accepted provider operations | 92 | 70 |
| Excess billable operations | 25 | 0 |
| Duplicate simulated charge units | 34.854 | 0 |
| Simulated cost per accepted analysis (credits) | 4.863 | 2.696 |

## Per scenario

| Scenario | Baseline defects | Hardened defects | Billable ops (B → H) |
|---|---|---|---|
| C01-happy-desk-notes | none | none | 2 → 2 |
| C02-happy-study-sparks | none | none | 2 → 2 |
| C03-two-conversations-sequential | INVALID_FINAL_ARTIFACT, WRONG_CONTEXT_DELIVERY | none | 4 → 4 |
| C04-revision-published-before-submit | none | none | 2 → 2 |
| C05-expired-account | none | none | 0 → 0 |
| C06-known-transport-error | none | none | 2 → 2 |
| F01-01-fast-brief-incompatible-route | INVALID_FINAL_ARTIFACT, WRONG_CONTEXT_DELIVERY, EXCESS_BILLABLE_OPERATIONS | none | 3 → 2 |
| F01-02-timeout-after-acceptance-idempotent | EXCESS_BILLABLE_OPERATIONS | none | 3 → 2 |
| F01-03-late-result-after-deadline | EXCESS_BILLABLE_OPERATIONS | none | 3 → 2 |
| F01-04-timeout-before-acceptance | none | none | 2 → 2 |
| F01-05-backup-unknown-acceptance | DUPLICATE_JOB, OUTCOME_MISMATCH, INVALID_FINAL_ARTIFACT, WRONG_CONTEXT_DELIVERY, DRAFT_COUNT_MISMATCH, EXCESS_BILLABLE_OPERATIONS | none | 5 → 2 |
| F01-06-wrong-schema-then-repair | INVALID_FINAL_ARTIFACT, WRONG_CONTEXT_DELIVERY | none | 2 → 3 |
| F01-07-truncated-twice | OUTCOME_MISMATCH, INVALID_FINAL_ARTIFACT, WRONG_CONTEXT_DELIVERY, DRAFT_COUNT_MISMATCH | none | 2 → 3 |
| F01-08-budget-exhausted | none | none | 1 → 1 |
| F01-09-stale-attempt-late-result | TERMINAL_OVERWRITTEN, EXCESS_BILLABLE_OPERATIONS | none | 4 → 2 |
| F01-10-empty-then-repair | none | none | 3 → 3 |
| F02-01-chat-switch-same-creator | WRONG_CONTEXT_DELIVERY, DRAFT_COUNT_MISMATCH | none | 2 → 2 |
| F02-02-switch-to-other-creator | WRONG_CONTEXT_DELIVERY, DRAFT_COUNT_MISMATCH | none | 2 → 2 |
| F02-03-warm-cache-other-creator | INVALID_FINAL_ARTIFACT, WRONG_CONTEXT_DELIVERY | none | 4 → 4 |
| F02-04-revision-between-jobs | INVALID_FINAL_ARTIFACT, WRONG_CONTEXT_DELIVERY | none | 4 → 4 |
| F02-05-revision-mid-job | OUTCOME_MISMATCH, INVALID_FINAL_ARTIFACT, WRONG_CONTEXT_DELIVERY, DRAFT_COUNT_MISMATCH, EXCESS_BILLABLE_OPERATIONS | none | 2 → 1 |
| F02-06-evidence-missing | OUTCOME_MISMATCH, INVALID_FINAL_ARTIFACT, DRAFT_COUNT_MISMATCH, EXCESS_BILLABLE_OPERATIONS | none | 2 → 1 |
| F03-01-close-poll-reopen | none | none | 2 → 2 |
| F03-02-repeated-submission-after-reconnect | DUPLICATE_JOB, INVALID_FINAL_ARTIFACT, WRONG_CONTEXT_DELIVERY, DRAFT_COUNT_MISMATCH, EXCESS_BILLABLE_OPERATIONS | none | 6 → 2 |
| F03-03-crash-between-result-and-save | READY_WITHOUT_ARTIFACT, REGENERATED_ON_CLIENT_STEP, EXCESS_BILLABLE_OPERATIONS | none | 4 → 2 |
| F03-04-db-failure-during-save | READY_WITHOUT_ARTIFACT, REGENERATED_ON_CLIENT_STEP, EXCESS_BILLABLE_OPERATIONS | none | 4 → 2 |
| F03-05-crash-after-receipt | EXCESS_BILLABLE_OPERATIONS | none | 4 → 2 |
| F03-06-wrong-cta-repair-replaces | INVALID_FINAL_ARTIFACT | none | 3 → 3 |
| F03-07-failed-repair | OUTCOME_MISMATCH, INVALID_FINAL_ARTIFACT, DRAFT_COUNT_MISMATCH | none | 2 → 3 |
| F03-08-stale-worker-terminal-overwrite | TERMINAL_OVERWRITTEN, EXCESS_BILLABLE_OPERATIONS | none | 4 → 2 |
| F03-09-crash-after-acceptance-before-receipt | EXCESS_BILLABLE_OPERATIONS | none | 4 → 2 |
| F03-10-crash-before-submission | EXCESS_BILLABLE_OPERATIONS | none | 3 → 2 |
