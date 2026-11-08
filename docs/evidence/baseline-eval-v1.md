# Evaluation report — BASELINE (eval-v1)

Generated 2026-11-07T23:59:46.100Z from an actual local run. Dataset sha256 `5c1e8f40c022b239…`.
Verdict: **EXPECTED_BASELINE_FAILURE** (exit code 3). Categories with defects: F01, F02, F03.

> Synthetic, fixture-defined scenarios. Outcomes are scripted provider-double behaviours, not real model quality. Identical inputs and scripts are used for baseline and hardened runs. Simulated credits are fixture units, not money. Logical time is a fake clock.

## Metrics

| Metric | Value |
|---|---|
| Completed analyses / labeled jobs | 33/35 (94%) |
| Accepted (valid, right-context) / saved drafts | 21/36 (58%) |
| Saved valid on server / eligible (happy+recoverable) | 18/25 (72%) |
| Delivered valid to client on reopen / eligible | 17/25 (68%) |
| Recovery success / recoverable scenarios | 3/14 (21%) |
| Safe rejection / unrecoverable scenarios | 2/7 (29%) |
| Route agreement / annotated routing cases | 4/8 (50%) |
| Wrong-context drafts saved | 12 (F02 scenarios affected 6/6) |
| Invalid final artifacts / saved drafts | 13/36 |
| Caller attempts / provider invocations / accepted ops / replays | 101 / 101 / 92 / 0 |
| Excess billable ops / duplicate simulated charge units | 25 / 34.854 |
| Time to first saved draft (logical, median/max, happy) | 2200 / 2200 ms |
| Local wall-clock per scenario (median/max) | 152.5 / 555 ms |
| Simulated cost per accepted analysis | 4.863 simulated credits |

## Scenarios

| Scenario | Cat | Class | Expected | Observed | Billable ops | Defects |
|---|---|---|---|---|---|---|
| C01-happy-desk-notes | CONTROL | happy | DRAFT_READY | DRAFT_READY | 2 | none |
| C02-happy-study-sparks | CONTROL | happy | DRAFT_READY | DRAFT_READY | 2 | none |
| C03-two-conversations-sequential | CONTROL | happy | DRAFT_READY | DRAFT_READY | 4 | INVALID_FINAL_ARTIFACT (second: PROVENANCE_MISMATCH); WRONG_CONTEXT_DELIVERY (second: WRONG_PROVENANCE) |
| C04-revision-published-before-submit | CONTROL | happy | DRAFT_READY | DRAFT_READY | 2 | none |
| C05-expired-account | CONTROL | unrecoverable | FAILED:ACCOUNT_RECONNECT_REQUIRED | FAILED | 0 | none |
| C06-known-transport-error | CONTROL | recoverable | DRAFT_READY | DRAFT_READY | 2 | none |
| F01-01-fast-brief-incompatible-route | F01 | happy | DRAFT_READY | DRAFT_READY | 3 | INVALID_FINAL_ARTIFACT (main: SCHEMA_INVALID); WRONG_CONTEXT_DELIVERY (main: WRONG_AUDIENCE,WRONG_PROVENANCE); EXCESS_BILLABLE_OPERATIONS (3 accepted billable ops > annotated max 2) |
| F01-02-timeout-after-acceptance-idempotent | F01 | recoverable | DRAFT_READY | DRAFT_READY | 3 | EXCESS_BILLABLE_OPERATIONS (3 accepted billable ops > annotated max 2) |
| F01-03-late-result-after-deadline | F01 | recoverable | DRAFT_READY | DRAFT_READY | 3 | EXCESS_BILLABLE_OPERATIONS (3 accepted billable ops > annotated max 2) |
| F01-04-timeout-before-acceptance | F01 | recoverable | DRAFT_READY | DRAFT_READY | 2 | none |
| F01-05-backup-unknown-acceptance | F01 | unrecoverable | RECONCILIATION_REQUIRED | DRAFT_READY | 5 | DUPLICATE_JOB (resubmit_new_key of 'main' created a new job); OUTCOME_MISMATCH (main: expected RECONCILIATION_REQUIRED, observed DRAFT_READY); INVALID_FINAL_ARTIFACT (8ade22c0: PROVENANCE_MISMATCH); WRONG_CONTEXT_DELIVERY (8ade22c0: WRONG_PROVENANCE); DRAFT_COUNT_MISMATCH (dn-conv-1: expected 0, observed 2); EXCESS_BILLABLE_OPERATIONS (5 accepted billable ops > annotated max 2) |
| F01-06-wrong-schema-then-repair | F01 | recoverable | DRAFT_READY | DRAFT_READY | 2 | INVALID_FINAL_ARTIFACT (main: SCHEMA_INVALID); WRONG_CONTEXT_DELIVERY (main: WRONG_AUDIENCE,WRONG_PROVENANCE) |
| F01-07-truncated-twice | F01 | unrecoverable | FAILED:CONTRACT_INVALID_AFTER_REPAIR | DRAFT_READY | 2 | OUTCOME_MISMATCH (main: expected FAILED:CONTRACT_INVALID_AFTER_REPAIR, observed DRAFT_READY); INVALID_FINAL_ARTIFACT (main: SCHEMA_INVALID); WRONG_CONTEXT_DELIVERY (main: WRONG_AUDIENCE,WRONG_PROVENANCE); DRAFT_COUNT_MISMATCH (dn-conv-1: expected 0, observed 1) |
| F01-08-budget-exhausted | F01 | unrecoverable | FAILED:BUDGET_EXHAUSTED | FAILED | 1 | none |
| F01-09-stale-attempt-late-result | F01 | recoverable | DRAFT_READY | DRAFT_READY | 4 | TERMINAL_OVERWRITTEN (main artifact rewritten at step 5 (resume)); EXCESS_BILLABLE_OPERATIONS (4 accepted billable ops > annotated max 2) |
| F01-10-empty-then-repair | F01 | recoverable | DRAFT_READY | DRAFT_READY | 3 | none |
| F02-01-chat-switch-same-creator | F02 | happy | DRAFT_READY | DRAFT_READY | 2 | WRONG_CONTEXT_DELIVERY (main: WRONG_DESTINATION_CONVERSATION); DRAFT_COUNT_MISMATCH (dn-conv-1: expected 1, observed 0); DRAFT_COUNT_MISMATCH (dn-conv-2: expected 0, observed 1) |
| F02-02-switch-to-other-creator | F02 | happy | DRAFT_READY | DRAFT_READY | 2 | WRONG_CONTEXT_DELIVERY (main: WRONG_DESTINATION_CONVERSATION,CROSS_CREATOR_DELIVERY); DRAFT_COUNT_MISMATCH (dn-conv-1: expected 1, observed 0); DRAFT_COUNT_MISMATCH (ss-conv-1: expected 0, observed 1) |
| F02-03-warm-cache-other-creator | F02 | happy | DRAFT_READY | DRAFT_READY | 4 | INVALID_FINAL_ARTIFACT (main: AUDIENCE_MISMATCH,PROVENANCE_MISMATCH); WRONG_CONTEXT_DELIVERY (main: WRONG_AUDIENCE,WRONG_PROVENANCE) |
| F02-04-revision-between-jobs | F02 | happy | DRAFT_READY | DRAFT_READY | 4 | INVALID_FINAL_ARTIFACT (main: AUDIENCE_MISMATCH,PROVENANCE_MISMATCH,FACT_SUPERSEDED,UNCLAIMED_FACTUAL_TEXT,REQUIRED_FACT_MISSING,EVIDENCE_STATUS_INCONSISTENT); WRONG_CONTEXT_DELIVERY (main: WRONG_AUDIENCE,WRONG_PROVENANCE,STALE_OR_FOREIGN_FACT) |
| F02-05-revision-mid-job | F02 | unrecoverable | FAILED:STALE_REVISION | DRAFT_READY | 2 | OUTCOME_MISMATCH (main: expected FAILED:STALE_REVISION, observed DRAFT_READY); INVALID_FINAL_ARTIFACT (main: PROVENANCE_MISMATCH,FACT_SUPERSEDED,UNCLAIMED_FACTUAL_TEXT,REQUIRED_FACT_MISSING,EVIDENCE_STATUS_INCONSISTENT); WRONG_CONTEXT_DELIVERY (main: STALE_OR_FOREIGN_FACT); DRAFT_COUNT_MISMATCH (dn-conv-1: expected 0, observed 1); EXCESS_BILLABLE_OPERATIONS (2 accepted billable ops > annotated max 1) |
| F02-06-evidence-missing | F02 | unrecoverable | FAILED:EVIDENCE_MISSING | DRAFT_READY | 2 | OUTCOME_MISMATCH (main: expected FAILED:EVIDENCE_MISSING, observed DRAFT_READY); INVALID_FINAL_ARTIFACT (main: NO_VALID_ARTIFACT_POSSIBLE:EVIDENCE_MISSING); DRAFT_COUNT_MISMATCH (dn-conv-1: expected 0, observed 1); EXCESS_BILLABLE_OPERATIONS (2 accepted billable ops > annotated max 1) |
| F03-01-close-poll-reopen | F03 | happy | DRAFT_READY | DRAFT_READY | 2 | none |
| F03-02-repeated-submission-after-reconnect | F03 | happy | DRAFT_READY | DRAFT_READY | 6 | DUPLICATE_JOB (resubmit of 'main' created a new job); DUPLICATE_JOB (resubmit of 'main' created a new job); INVALID_FINAL_ARTIFACT (e0a18c63: PROVENANCE_MISMATCH); WRONG_CONTEXT_DELIVERY (e0a18c63: WRONG_PROVENANCE); INVALID_FINAL_ARTIFACT (b538cb24: PROVENANCE_MISMATCH); WRONG_CONTEXT_DELIVERY (b538cb24: WRONG_PROVENANCE); DRAFT_COUNT_MISMATCH (dn-conv-1: expected 1, observed 3); EXCESS_BILLABLE_OPERATIONS (6 accepted billable ops > annotated max 2) |
| F03-03-crash-between-result-and-save | F03 | recoverable | DRAFT_READY | DRAFT_READY | 4 | READY_WITHOUT_ARTIFACT (main observed after step 2 (work)); REGENERATED_ON_CLIENT_STEP (2 provider invocations during poll/reopen); EXCESS_BILLABLE_OPERATIONS (4 accepted billable ops > annotated max 2) |
| F03-04-db-failure-during-save | F03 | recoverable | DRAFT_READY | DRAFT_READY | 4 | READY_WITHOUT_ARTIFACT (main observed after step 2 (work)); REGENERATED_ON_CLIENT_STEP (2 provider invocations during poll/reopen); EXCESS_BILLABLE_OPERATIONS (4 accepted billable ops > annotated max 2) |
| F03-05-crash-after-receipt | F03 | recoverable | DRAFT_READY | DRAFT_READY | 4 | EXCESS_BILLABLE_OPERATIONS (4 accepted billable ops > annotated max 2) |
| F03-06-wrong-cta-repair-replaces | F03 | recoverable | DRAFT_READY | DRAFT_READY | 3 | INVALID_FINAL_ARTIFACT (main: LINE_COUNT,WORD_COUNT,UNCLAIMED_FACTUAL_TEXT) |
| F03-07-failed-repair | F03 | unrecoverable | FAILED:CONTRACT_INVALID_AFTER_REPAIR | DRAFT_READY | 2 | OUTCOME_MISMATCH (main: expected FAILED:CONTRACT_INVALID_AFTER_REPAIR, observed DRAFT_READY); INVALID_FINAL_ARTIFACT (main: LINE_COUNT,SPEAKER_ORDER); DRAFT_COUNT_MISMATCH (dn-conv-1: expected 0, observed 1) |
| F03-08-stale-worker-terminal-overwrite | F03 | recoverable | DRAFT_READY | DRAFT_READY | 4 | TERMINAL_OVERWRITTEN (main artifact rewritten at step 5 (resume)); EXCESS_BILLABLE_OPERATIONS (4 accepted billable ops > annotated max 2) |
| F03-09-crash-after-acceptance-before-receipt | F03 | recoverable | DRAFT_READY | DRAFT_READY | 4 | EXCESS_BILLABLE_OPERATIONS (4 accepted billable ops > annotated max 2) |
| F03-10-crash-before-submission | F03 | recoverable | DRAFT_READY | DRAFT_READY | 3 | EXCESS_BILLABLE_OPERATIONS (3 accepted billable ops > annotated max 2) |

## Routing cases

| Case | Expected | Selected | Reason | Agree |
|---|---|---|---|---|
| RT01 | quick-classify | quick-classify | DEFAULT | yes |
| RT02 | deep-profile | quick-classify | DEFAULT | NO |
| RT03 | structured-dialogue | structured-dialogue | DEFAULT | yes |
| RT04 | structured-dialogue | quick-classify | CHEAPEST_FOR_FAST | NO |
| RT05 | compatible-backup | compatible-backup | FALLBACK_ON_ANY_PROBLEM | yes |
| RT06 | none | structured-dialogue | DEFAULT | NO |
| RT07 | deep-profile | deep-profile | DEFAULT | yes |
| RT08 | none | compatible-backup | FALLBACK_ON_ANY_PROBLEM | NO |
