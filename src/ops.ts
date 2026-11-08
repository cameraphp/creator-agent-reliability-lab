import type { Clock } from "./core/clock.js";
import { trace } from "./core/trace.js";
import { type Pool, withCreatorContext } from "./db/pool.js";

/**
 * Operator actions for the runbook. Deliberately NO bulk "retry everything":
 * each reconciliation names one job, one upstream finding and an operator.
 */
export async function listJobs(pool: Pool, state?: string) {
  const r = await pool.query(
    `SELECT job_id, creator_id, conversation_id, state, error_code, claim_count, lease_owner, lease_expires_at, next_run_at, updated_at
       FROM lab.jobs ${state ? "WHERE state = $1" : ""} ORDER BY updated_at DESC LIMIT 50`,
    state ? [state] : [],
  );
  return r.rows;
}

export async function inspectJob(pool: Pool, jobId: string) {
  const job = (await pool.query("SELECT * FROM lab.jobs WHERE job_id = $1", [jobId])).rows[0];
  if (!job) return null;
  return withCreatorContext(pool, job.creator_id, async (c) => ({
    job: { ...job, request_fingerprint: undefined, semantic_key: undefined },
    stages: (
      await c.query("SELECT stage, created_at FROM lab.stage_results WHERE job_id = $1 ORDER BY created_at", [
        jobId,
      ])
    ).rows,
    provider_calls: (
      await c.query(
        "SELECT stage, purpose, operation_id, profile_id, status, invocations, response_source, error_code, updated_at FROM lab.provider_calls WHERE job_id = $1 ORDER BY created_at",
        [jobId],
      )
    ).rows,
    candidates: (
      await c.query(
        "SELECT kind, verdict, errors, created_at FROM lab.candidates WHERE job_id = $1 ORDER BY created_at",
        [jobId],
      )
    ).rows,
    draft:
      (
        await c.query("SELECT draft_id, conversation_id, created_at FROM lab.drafts WHERE job_id = $1", [
          jobId,
        ])
      ).rows[0] ?? null,
    trace: (
      await c.query(
        "SELECT at, stage, event, attrs FROM lab.trace_events WHERE job_id = $1 ORDER BY event_id",
        [jobId],
      )
    ).rows,
  }));
}

export type UpstreamFinding = "not-accepted" | "accepted-no-result";

/**
 * Resolves ONE job in RECONCILIATION_REQUIRED after the operator checked the
 * provider out of band (dashboard/support ticket):
 *  - not-accepted       -> the unresolved call is marked NOT_ACCEPTED; job READY (retry within budget)
 *  - accepted-no-result -> job FAILED with OPERATOR_CONFIRMED_CHARGED; never retried automatically
 */
export async function resolveReconciliation(
  pool: Pool,
  clock: Clock,
  jobId: string,
  finding: UpstreamFinding,
  operator: string,
) {
  if (!/^[a-z][a-z0-9-]{1,40}$/.test(operator)) throw new Error("operator must be a short lowercase id");
  const job = (await pool.query("SELECT job_id, creator_id, state FROM lab.jobs WHERE job_id = $1", [jobId]))
    .rows[0];
  if (!job) throw new Error("job not found");
  if (job.state !== "RECONCILIATION_REQUIRED")
    throw new Error(`job is ${job.state}, not RECONCILIATION_REQUIRED; nothing to resolve`);
  const now = clock.now();
  return withCreatorContext(pool, job.creator_id, async (c) => {
    const locked = await c.query("SELECT state FROM lab.jobs WHERE job_id = $1 FOR UPDATE", [jobId]);
    if (locked.rows[0]?.state !== "RECONCILIATION_REQUIRED") throw new Error("job changed concurrently");
    if (finding === "not-accepted") {
      await c.query(
        "UPDATE lab.provider_calls SET status = 'NOT_ACCEPTED', error_code = 'OPERATOR_CONFIRMED_NOT_ACCEPTED', updated_at = $2 WHERE job_id = $1 AND status = 'UNRESOLVED'",
        [jobId, now],
      );
      await c.query(
        "UPDATE lab.jobs SET state = 'READY', error_code = NULL, next_run_at = $2, updated_at = $2 WHERE job_id = $1",
        [jobId, now],
      );
    } else {
      await c.query(
        "UPDATE lab.jobs SET state = 'FAILED', error_code = 'OPERATOR_CONFIRMED_CHARGED', updated_at = $2 WHERE job_id = $1",
        [jobId, now],
      );
    }
    await trace(c, {
      jobId,
      creatorId: job.creator_id,
      at: now,
      stage: "reconciliation",
      event: "operator.reconciled",
      attrs: { outcome: finding, worker: operator, state: finding === "not-accepted" ? "READY" : "FAILED" },
    });
    return { job_id: jobId, finding, new_state: finding === "not-accepted" ? "READY" : "FAILED" };
  });
}
