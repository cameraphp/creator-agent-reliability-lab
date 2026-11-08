# Founder runbook (local lab)

Short, safe procedures. All commands run from the lab folder in PowerShell. There is intentionally **no
"retry everything" command**: each recovery action targets one job and is either automatic-and-safe
(expired lease, known pre-acceptance failure) or requires an explicit human finding.

## 1. Start and check

```powershell
npm run db:up; npm run db:migrate
npm run api            # terminal 1 (127.0.0.1:38471)
npm run worker         # terminal 2 (Ctrl+C to stop)
npm run client -- health
```

## 2. Inspect a job and its trace

```powershell
npm run client -- status --job <jobId>
npm run client -- trace  --job <jobId>
npm run ops -- inspect --job <jobId>     # stages, provider calls, candidates, draft, trace
npm run ops -- list --state RUNNING
```

## 3. Interpret states

| State                     | Meaning                                                                                                                 | What to do                                                                                |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `READY`                   | Committed, waiting for a worker                                                                                         | Make sure a worker is running                                                             |
| `RUNNING`                 | Leased by a worker                                                                                                      | If the worker died, the lease expires (30 s) and another worker reclaims it automatically |
| `RETRY_WAIT`              | Known not-accepted provider failure; `next_run_at` set by deterministic backoff                                         | Nothing; it resumes when due, inside the attempt budget                                   |
| `DRAFT_READY`             | Draft saved atomically in the original conversation                                                                     | Client loads drafts; reopening never calls a provider                                     |
| `FAILED`                  | Safe terminal failure, no artifact (`error_code` explains)                                                              | Fix the cause (reconnect account, approve facts, resubmit for new revision)               |
| `RECONCILIATION_REQUIRED` | A provider may have accepted (and charged) but the outcome is unknown and the profile has no status/idempotency support | Investigate (section 5). Do not resubmit; a new key is deduplicated to this job anyway    |

## 4. Recover known safe work

```powershell
npm run worker:once    # claims only READY/RETRY_WAIT that are due, or RUNNING with an expired lease
```

Completed stages and committed provider receipts are reused; nothing is re-billed.

## 5. Investigate an ambiguous charge

1. `npm run ops -- inspect --job <jobId>` → find the provider call with status `UNRESOLVED`, its
   `profile_id` and `operation_id`, and the `reconciliation.required` trace event.
2. Check the provider's own records out of band (dashboard, invoice, support ticket). In this lab, the
   synthetic ledger is `sim_provider.invocations`.
3. Record the finding for this one job:

```powershell
# Provider confirms it never accepted the operation -> job returns to READY (retries stay within budget)
npm run ops -- resolve --job <jobId> --upstream not-accepted --operator your-id
# Provider confirms it accepted/charged but no result is recoverable -> FAILED, never auto-retried
npm run ops -- resolve --job <jobId> --upstream accepted-no-result --operator your-id
```

A prompt change cannot resolve an uncertain external charge; only provider evidence can.

## 6. Rerun release gates

```powershell
npm run typecheck; if ($LASTEXITCODE -ne 0) { throw "typecheck" }
npm run lint;      if ($LASTEXITCODE -ne 0) { throw "lint" }
npm test;          if ($LASTEXITCODE -ne 0) { throw "tests" }
npm run evaluate:hardened; if ($LASTEXITCODE -ne 0) { throw "hardened gates" }
npm run evaluate:baseline; if ($LASTEXITCODE -ne 3) { throw "baseline must exit 3 (EXPECTED BASELINE FAILURE)" }
npm run compare;   if ($LASTEXITCODE -ne 0) { throw "compare" }
npm run smoke;     if ($LASTEXITCODE -ne 0) { throw "smoke" }
```
