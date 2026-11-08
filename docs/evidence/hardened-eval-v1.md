# Evaluation report — HARDENED (eval-v1)

Generated 2026-11-07T23:59:32.789Z from an actual local run. Dataset sha256 `5c1e8f40c022b239…`.
Verdict: **HARDENED_GATES_PASSED** (exit code 0). Categories with defects: none.

> Synthetic, fixture-defined scenarios. Outcomes are scripted provider-double behaviours, not real model quality. Identical inputs and scripts are used for baseline and hardened runs. Simulated credits are fixture units, not money. Logical time is a fake clock.

## Metrics

| Metric | Value |
|---|---|
| Completed analyses / labeled jobs | 28/35 (80%) |
| Accepted (valid, right-context) / saved drafts | 28/28 (100%) |
| Saved valid on server / eligible (happy+recoverable) | 25/25 (100%) |
| Delivered valid to client on reopen / eligible | 25/25 (100%) |
| Recovery success / recoverable scenarios | 14/14 (100%) |
| Safe rejection / unrecoverable scenarios | 7/7 (100%) |
| Route agreement / annotated routing cases | 8/8 (100%) |
| Wrong-context drafts saved | 0 (F02 scenarios affected 0/6) |
| Invalid final artifacts / saved drafts | 0/28 |
| Caller attempts / provider invocations / accepted ops / replays | 78 / 78 / 70 / 0 |
| Excess billable ops / duplicate simulated charge units | 0 / 0 |
| Time to first saved draft (logical, median/max, happy) | 2200 / 2200 ms |
| Local wall-clock per scenario (median/max) | 449 / 775 ms |
| Simulated cost per accepted analysis | 2.696 simulated credits |

## Scenarios

| Scenario | Cat | Class | Expected | Observed | Billable ops | Defects |
|---|---|---|---|---|---|---|
| C01-happy-desk-notes | CONTROL | happy | DRAFT_READY | DRAFT_READY | 2 | none |
| C02-happy-study-sparks | CONTROL | happy | DRAFT_READY | DRAFT_READY | 2 | none |
| C03-two-conversations-sequential | CONTROL | happy | DRAFT_READY | DRAFT_READY | 4 | none |
| C04-revision-published-before-submit | CONTROL | happy | DRAFT_READY | DRAFT_READY | 2 | none |
| C05-expired-account | CONTROL | unrecoverable | FAILED:ACCOUNT_RECONNECT_REQUIRED | FAILED:ACCOUNT_RECONNECT_REQUIRED | 0 | none |
| C06-known-transport-error | CONTROL | recoverable | DRAFT_READY | DRAFT_READY | 2 | none |
| F01-01-fast-brief-incompatible-route | F01 | happy | DRAFT_READY | DRAFT_READY | 2 | none |
| F01-02-timeout-after-acceptance-idempotent | F01 | recoverable | DRAFT_READY | DRAFT_READY | 2 | none |
| F01-03-late-result-after-deadline | F01 | recoverable | DRAFT_READY | DRAFT_READY | 2 | none |
| F01-04-timeout-before-acceptance | F01 | recoverable | DRAFT_READY | DRAFT_READY | 2 | none |
| F01-05-backup-unknown-acceptance | F01 | unrecoverable | RECONCILIATION_REQUIRED | RECONCILIATION_REQUIRED:UPSTREAM_ACCEPTANCE_UNKNOWN | 2 | none |
| F01-06-wrong-schema-then-repair | F01 | recoverable | DRAFT_READY | DRAFT_READY | 3 | none |
| F01-07-truncated-twice | F01 | unrecoverable | FAILED:CONTRACT_INVALID_AFTER_REPAIR | FAILED:CONTRACT_INVALID_AFTER_REPAIR | 3 | none |
| F01-08-budget-exhausted | F01 | unrecoverable | FAILED:BUDGET_EXHAUSTED | FAILED:BUDGET_EXHAUSTED | 1 | none |
| F01-09-stale-attempt-late-result | F01 | recoverable | DRAFT_READY | DRAFT_READY | 2 | none |
| F01-10-empty-then-repair | F01 | recoverable | DRAFT_READY | DRAFT_READY | 3 | none |
| F02-01-chat-switch-same-creator | F02 | happy | DRAFT_READY | DRAFT_READY | 2 | none |
| F02-02-switch-to-other-creator | F02 | happy | DRAFT_READY | DRAFT_READY | 2 | none |
| F02-03-warm-cache-other-creator | F02 | happy | DRAFT_READY | DRAFT_READY | 4 | none |
| F02-04-revision-between-jobs | F02 | happy | DRAFT_READY | DRAFT_READY | 4 | none |
| F02-05-revision-mid-job | F02 | unrecoverable | FAILED:STALE_REVISION | FAILED:STALE_REVISION | 1 | none |
| F02-06-evidence-missing | F02 | unrecoverable | FAILED:EVIDENCE_MISSING | FAILED:EVIDENCE_MISSING | 1 | none |
| F03-01-close-poll-reopen | F03 | happy | DRAFT_READY | DRAFT_READY | 2 | none |
| F03-02-repeated-submission-after-reconnect | F03 | happy | DRAFT_READY | DRAFT_READY | 2 | none |
| F03-03-crash-between-result-and-save | F03 | recoverable | DRAFT_READY | DRAFT_READY | 2 | none |
| F03-04-db-failure-during-save | F03 | recoverable | DRAFT_READY | DRAFT_READY | 2 | none |
| F03-05-crash-after-receipt | F03 | recoverable | DRAFT_READY | DRAFT_READY | 2 | none |
| F03-06-wrong-cta-repair-replaces | F03 | recoverable | DRAFT_READY | DRAFT_READY | 3 | none |
| F03-07-failed-repair | F03 | unrecoverable | FAILED:CONTRACT_INVALID_AFTER_REPAIR | FAILED:CONTRACT_INVALID_AFTER_REPAIR | 3 | none |
| F03-08-stale-worker-terminal-overwrite | F03 | recoverable | DRAFT_READY | DRAFT_READY | 2 | none |
| F03-09-crash-after-acceptance-before-receipt | F03 | recoverable | DRAFT_READY | DRAFT_READY | 2 | none |
| F03-10-crash-before-submission | F03 | recoverable | DRAFT_READY | DRAFT_READY | 2 | none |

## Routing cases

| Case | Expected | Selected | Reason | Agree |
|---|---|---|---|---|
| RT01 | quick-classify | quick-classify | PRIMARY_COMPATIBLE | yes |
| RT02 | deep-profile | deep-profile | PRIMARY_UNAVAILABLE_BACKUP_COMPATIBLE | yes |
| RT03 | structured-dialogue | structured-dialogue | PRIMARY_COMPATIBLE | yes |
| RT04 | structured-dialogue | structured-dialogue | PRIMARY_COMPATIBLE | yes |
| RT05 | compatible-backup | compatible-backup | PRIMARY_UNAVAILABLE_BACKUP_COMPATIBLE | yes |
| RT06 | none | none | NO_COMPATIBLE_PROFILE | yes |
| RT07 | deep-profile | deep-profile | PRIMARY_COMPATIBLE | yes |
| RT08 | none | none | HOLD_FOR_RECONCILIATION:structured-dialogue | yes |
