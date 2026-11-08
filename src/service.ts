import { createHash, randomUUID } from "node:crypto";
import { type JobState, type Pinned, SubmitRequestSchema, TERMINAL_STATES } from "./contracts.js";
import type { Clock } from "./core/clock.js";
import { currentRevisions } from "./core/context.js";
import type { Policy } from "./core/policy.js";
import { trace } from "./core/trace.js";
import { type Pool, withActor } from "./db/pool.js";
import {
  type CatalogState,
  creatorForActor,
  getBrief,
  getCreator,
  getProduct,
  getVideo,
} from "./fixtures.js";

/** One service layer reused by the HTTP API, the CLI demo client and the evaluation. */
export interface ServiceDeps {
  appPool: Pool;
  clock: Clock;
  catalogState: CatalogState;
  policy: Policy;
}

export class ServiceError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export interface SubmitResult {
  status: 200 | 202;
  job: JobView;
  replay: boolean;
  deduplicated_by?: "idempotency_key" | "semantic_operation";
}

export async function submitJob(
  d: ServiceDeps,
  actorId: string,
  body: unknown,
  correlationId?: string,
): Promise<SubmitResult> {
  const creatorId = creatorForActor(actorId);
  if (!creatorId) throw new ServiceError(401, "UNKNOWN_ACTOR", "Actor is not on the synthetic allowlist.");
  const parsed = SubmitRequestSchema.safeParse(body);
  if (!parsed.success)
    throw new ServiceError(400, "INVALID_REQUEST", "Request does not match the submission contract.");
  const req = parsed.data;
  const creator = getCreator(creatorId);
  const brief = getBrief(req.brief_id);
  const video = getVideo(req.video_id);
  if (!creator?.conversations.includes(req.conversation_id))
    throw new ServiceError(404, "UNKNOWN_CONVERSATION", "Unknown conversation.");
  if (!getProduct(req.product_id)) throw new ServiceError(404, "UNKNOWN_PRODUCT", "Unknown product.");
  if (!video || video.creator_id !== creatorId)
    throw new ServiceError(404, "UNKNOWN_VIDEO", "Unknown video.");
  if (!brief || brief.creator_id !== creatorId || brief.product_id !== req.product_id) {
    throw new ServiceError(404, "UNKNOWN_BRIEF", "Unknown brief.");
  }

  const selectors = {
    creator_id: creatorId,
    conversation_id: req.conversation_id,
    product_id: req.product_id,
    video_id: req.video_id,
    brief_id: req.brief_id,
  };
  // Server-scoped canonical fingerprint of the client-meaningful input.
  const fingerprint = sha(`lab-fp-v1|${canonical(selectors)}`);
  const jobId = randomUUID();
  const revisions = currentRevisions(d.catalogState, creatorId, req.product_id, req.brief_id);
  const pinned: Pinned = {
    creator_id: creatorId,
    conversation_id: req.conversation_id,
    job_id: jobId,
    ...revisions,
    policy_version: d.policy.version,
  };
  // Fixture-scoped semantic operation: exact selectors + pinned revisions + policy.
  const semanticKey = sha(
    `lab-sem-v1|${canonical({ ...selectors, ...revisions, policy_version: d.policy.version })}`,
  );
  const now = d.clock.now();

  return withActor(d.appPool, actorId, async (c) => {
    const ins = await c.query(
      `INSERT INTO lab.jobs (job_id, creator_id, conversation_id, idempotency_key, request_fingerprint, semantic_key,
                             request, pinned, state, next_run_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'READY', $9, $9, $9)
       ON CONFLICT DO NOTHING RETURNING job_id`,
      [
        jobId,
        creatorId,
        req.conversation_id,
        req.idempotency_key,
        fingerprint,
        semanticKey,
        JSON.stringify(selectors),
        JSON.stringify(pinned),
        now,
      ],
    );
    if (ins.rowCount === 1) {
      await trace(c, {
        jobId,
        creatorId,
        at: now,
        event: "job.submitted",
        attrs: {
          state: "READY",
          pinned,
          conversation_id: req.conversation_id,
          correlation_id: correlationId,
        },
      });
      const job = await readJob(c, jobId);
      return { status: 202, job: toView(job!), replay: false };
    }
    const byKey = await c.query<JobRow>(
      "SELECT * FROM lab.jobs WHERE creator_id = $1 AND conversation_id = $2 AND idempotency_key = $3",
      [creatorId, req.conversation_id, req.idempotency_key],
    );
    const existing = byKey.rows[0];
    if (existing) {
      if (existing.request_fingerprint !== fingerprint) {
        throw new ServiceError(
          409,
          "IDEMPOTENCY_KEY_REUSED",
          "This idempotency key was already used with different input.",
        );
      }
      return { status: 200, job: toView(existing), replay: true, deduplicated_by: "idempotency_key" };
    }
    const bySemantic = await c.query<JobRow>(
      "SELECT * FROM lab.jobs WHERE creator_id = $1 AND conversation_id = $2 AND semantic_key = $3 AND state <> 'FAILED'",
      [creatorId, req.conversation_id, semanticKey],
    );
    const same = bySemantic.rows[0];
    if (same) {
      await trace(c, {
        jobId: same.job_id,
        creatorId,
        at: now,
        event: "job.resubmission_deduplicated",
        attrs: { deduplicated_by: "semantic_operation", correlation_id: correlationId },
      });
      return { status: 200, job: toView(same), replay: true, deduplicated_by: "semantic_operation" };
    }
    throw new ServiceError(409, "SUBMISSION_CONFLICT", "Submission conflicted with an existing job.");
  });
}

export interface JobRow {
  job_id: string;
  creator_id: string;
  conversation_id: string;
  idempotency_key: string;
  request_fingerprint: string;
  semantic_key: string;
  request: {
    creator_id: string;
    conversation_id: string;
    product_id: string;
    video_id: string;
    brief_id: string;
  };
  pinned: Pinned;
  state: JobState;
  claim_count: number;
  fencing_token: string;
  lease_owner: string | null;
  lease_expires_at: Date | null;
  next_run_at: Date;
  error_code: string | null;
  accepted_candidate_id: string | null;
  created_at: Date;
  updated_at: Date;
}

async function readJob(c: { query: Pool["query"] }, jobId: string): Promise<JobRow | undefined> {
  return (await c.query<JobRow>("SELECT * FROM lab.jobs WHERE job_id = $1", [jobId])).rows[0];
}

export interface JobView {
  job_id: string;
  conversation_id: string;
  state: JobState;
  terminal: boolean;
  error_code: string | null;
  pinned: Pinned;
  created_at: string;
  updated_at: string;
  client_guidance: {
    action: "poll" | "show_draft" | "show_error" | "await_operator";
    poll_after_ms?: number;
    message: string;
  };
}

const SAFE_MESSAGES: Record<string, string> = {
  ACCOUNT_RECONNECT_REQUIRED: "The synthetic account connection expired. Reconnect, then submit again.",
  EVIDENCE_MISSING: "Approved product facts required by the brief are missing. No draft was produced.",
  STALE_REVISION: "Product or brief changed while drafting. Submit again to use the current revision.",
  CONTRACT_INVALID_AFTER_REPAIR: "The draft failed validation after one repair. No draft was saved.",
  BUDGET_EXHAUSTED: "The attempt budget was used up. No draft was saved.",
  NO_COMPATIBLE_PROFILE: "No compatible provider profile is available for this request.",
  UPSTREAM_ACCEPTANCE_UNKNOWN: "A provider outcome is unknown. An operator must reconcile before any retry.",
};

export function toView(j: JobRow): JobView {
  const terminal = TERMINAL_STATES.includes(j.state);
  let guidance: JobView["client_guidance"];
  switch (j.state) {
    case "DRAFT_READY":
      guidance = { action: "show_draft", message: "Draft saved. Load it from the conversation's drafts." };
      break;
    case "FAILED":
      guidance = {
        action: "show_error",
        message: SAFE_MESSAGES[j.error_code ?? ""] ?? "The job failed safely. No draft was saved.",
      };
      break;
    case "RECONCILIATION_REQUIRED":
      guidance = { action: "await_operator", message: SAFE_MESSAGES.UPSTREAM_ACCEPTANCE_UNKNOWN! };
      break;
    default:
      guidance = {
        action: "poll",
        poll_after_ms: j.state === "RETRY_WAIT" ? 2_000 : 1_000,
        message: "Working. Safe to close the app.",
      };
  }
  return {
    job_id: j.job_id,
    conversation_id: j.conversation_id,
    state: j.state,
    terminal,
    error_code: j.error_code,
    pinned: j.pinned,
    created_at: new Date(j.created_at).toISOString(),
    updated_at: new Date(j.updated_at).toISOString(),
    client_guidance: guidance,
  };
}

export async function getJob(d: ServiceDeps, actorId: string, jobId: string): Promise<JobView> {
  if (!/^[0-9a-f-]{36}$/.test(jobId)) throw new ServiceError(404, "NOT_FOUND", "Job not found.");
  const row = await withActor(d.appPool, actorId, (c) => readJob(c, jobId));
  if (!row) throw new ServiceError(404, "NOT_FOUND", "Job not found.");
  return toView(row);
}

export async function getTrace(d: ServiceDeps, actorId: string, jobId: string) {
  if (!/^[0-9a-f-]{36}$/.test(jobId)) throw new ServiceError(404, "NOT_FOUND", "Job not found.");
  return withActor(d.appPool, actorId, async (c) => {
    if (!(await readJob(c, jobId))) throw new ServiceError(404, "NOT_FOUND", "Job not found.");
    const r = await c.query(
      "SELECT event_id, at, stage, event, attrs FROM lab.trace_events WHERE job_id = $1 ORDER BY event_id",
      [jobId],
    );
    return r.rows.map((e) => ({ ...e, event_id: Number(e.event_id) }));
  });
}

export interface DraftView {
  draft_id: string;
  job_id: string;
  conversation_id: string;
  candidate_id: string;
  artifact: import("./contracts.js").DraftArtifact;
  pinned: Pinned;
  created_at: string;
}

/** Reopen path: reads persisted drafts only. Never triggers generation or provider work. */
export async function listDrafts(
  d: ServiceDeps,
  actorId: string,
  conversationId: string,
): Promise<DraftView[]> {
  const creatorId = creatorForActor(actorId);
  if (!creatorId) throw new ServiceError(401, "UNKNOWN_ACTOR", "Actor is not on the synthetic allowlist.");
  if (!getCreator(creatorId)?.conversations.includes(conversationId))
    throw new ServiceError(404, "NOT_FOUND", "Conversation not found.");
  return withActor(d.appPool, actorId, async (c) => {
    const r = await c.query(
      `SELECT draft_id, job_id, conversation_id, candidate_id, artifact, pinned, created_at
         FROM lab.drafts WHERE conversation_id = $1 ORDER BY created_at, draft_id`,
      [conversationId],
    );
    return r.rows.map((x) => ({ ...x, created_at: new Date(x.created_at).toISOString() }));
  });
}
