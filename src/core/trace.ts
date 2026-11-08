import type { Client } from "../db/pool.js";

/** Attribute keys allowed in trace events. Anything else is dropped (no free-form payloads). */
const ALLOWED_KEYS = new Set([
  "worker",
  "fencing_token",
  "claim_count",
  "prev_state",
  "state",
  "error_code",
  "profile_id",
  "operation_id",
  "call_id",
  "purpose",
  "caller_attempt",
  "outcome",
  "source",
  "selected",
  "considered",
  "reason",
  "retry_in_ms",
  "candidate_id",
  "verdict",
  "errors",
  "pinned",
  "conversation_id",
  "draft_id",
  "budget_used",
  "budget_max",
  "late_result_discarded",
  "idempotent_replay",
  "deduplicated_by",
  "correlation_id",
]);

export function sanitize(attrs: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (!ALLOWED_KEYS.has(k) || v === undefined) continue;
    out[k] = typeof v === "string" ? v.slice(0, 200) : v;
  }
  return out;
}

export async function trace(
  c: Client,
  e: {
    jobId: string;
    creatorId: string;
    at: Date;
    stage?: string | null;
    event: string;
    attrs?: Record<string, unknown>;
  },
): Promise<void> {
  await c.query(
    "INSERT INTO lab.trace_events (job_id, creator_id, at, stage, event, attrs) VALUES ($1, $2, $3, $4, $5, $6)",
    [e.jobId, e.creatorId, e.at, e.stage ?? null, e.event, JSON.stringify(sanitize(e.attrs ?? {}))],
  );
}
