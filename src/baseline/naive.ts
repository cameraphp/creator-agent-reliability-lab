/**
 * DELIBERATELY DEFECTIVE BASELINE — CLI evaluation only, never exposed by the API.
 * Models a plausible pre-remediation implementation so the SAME versioned
 * workloads can show before/after evidence. Defects (on purpose):
 *  F01: cheapest/default routing ignoring compatibility; blind fallback on ANY
 *       problem (incl. ambiguous timeouts); lenient parsing accepts invalid output.
 *  F02: context cache keyed by product only (no creator/conversation/revision);
 *       substitutes unapproved notes when evidence is missing; delivers to the
 *       client's CURRENT active conversation.
 *  F03: no idempotency, no leases/fencing, no checkpoints; marks the job ready
 *       before writing the artifact; appends repairs; reopen regenerates a
 *       missing artifact with a new paid call; restart reruns everything.
 */
import { randomUUID } from "node:crypto";
import { SubmitRequestSchema } from "../contracts.js";
import type { Clock } from "../core/clock.js";
import { type Boundary, type FaultInjector, SimulatedCrash } from "../core/faults.js";
import { estimateTokens, routeBaseline } from "../core/routing.js";
import type { Pool } from "../db/pool.js";
import {
  type CatalogState,
  creatorForActor,
  factsAt,
  getBrief,
  getCreator,
  getProduct,
} from "../fixtures.js";
import type { DialoguePayload } from "../providers/generator.js";
import type { SimulatedProvider } from "../providers/simulated.js";

export interface ClientSession {
  activeConversation: string;
}

interface CachedContext {
  pinned: DialoguePayload["pinned"];
  audience: string;
  tone: string;
  facts: DialoguePayload["facts"];
}

interface BJob {
  job_id: string;
  creator_id: string;
  conversation_id: string;
  request: { product_id: string; video_id: string; brief_id: string };
  state: string;
}

export class BaselineSystem {
  private cache = new Map<string, CachedContext>();
  private started = new Set<string>();

  constructor(
    private pool: Pool,
    private provider: SimulatedProvider,
    private clock: Clock,
    private catalogState: CatalogState,
    private session: ClientSession,
    private faults: FaultInjector,
  ) {}

  /** No idempotency key handling: every submission creates a new job. */
  async submit(actorId: string, body: unknown): Promise<{ jobId: string }> {
    const creatorId = creatorForActor(actorId);
    const req = SubmitRequestSchema.parse(body);
    if (!creatorId) throw new Error("unknown actor");
    const jobId = randomUUID();
    await this.pool.query(
      "INSERT INTO lab_baseline.jobs (job_id, creator_id, conversation_id, request, state, created_at, updated_at) VALUES ($1, $2, $3, $4, 'READY', $5, $5)",
      [jobId, creatorId, req.conversation_id, JSON.stringify(req), this.clock.now()],
    );
    return { jobId };
  }

  private hit(at: Boundary, worker: string, jobId: string, stage?: string) {
    return this.faults.hit(at, { worker, jobId, stage });
  }

  /** One naive pass. A newly started worker requeues EVERY running job (no lease check). */
  async runOnce(worker: string): Promise<"idle" | "done" | "failed"> {
    if (!this.started.has(worker)) {
      this.started.add(worker);
      await this.pool.query("UPDATE lab_baseline.jobs SET state = 'READY' WHERE state = 'RUNNING'");
    }
    const r = await this.pool.query<BJob>(
      "SELECT * FROM lab_baseline.jobs WHERE state = 'READY' ORDER BY created_at LIMIT 1",
    );
    const job = r.rows[0];
    if (!job) return "idle";
    await this.pool.query(
      "UPDATE lab_baseline.jobs SET state = 'RUNNING', updated_at = $2 WHERE job_id = $1",
      [job.job_id, this.clock.now()],
    );
    return this.execute(worker, job);
  }

  private async execute(worker: string, job: BJob): Promise<"done" | "failed"> {
    if (this.catalogState.account(job.creator_id) !== "CONNECTED") {
      await this.pool.query("UPDATE lab_baseline.jobs SET state = 'FAILED' WHERE job_id = $1", [job.job_id]);
      return "failed";
    }
    const video = await this.call(
      worker,
      job,
      "classify_video",
      { video_id: job.request.video_id },
      "standard",
      "video_analysis",
    );
    if (video === null) {
      await this.pool.query("UPDATE lab_baseline.jobs SET state = 'FAILED' WHERE job_id = $1", [job.job_id]);
      return "failed";
    }
    let videoMeta: { topic?: string; pacing?: string } = {};
    try {
      videoMeta = JSON.parse(video) as typeof videoMeta;
    } catch {
      /* lenient */
    }

    await this.hit("before_stage:context_assembly", worker, job.job_id, "context_assembly");
    const ctx = this.contextFor(job);
    await this.hit("before_stage:dialogue_draft", worker, job.job_id, "dialogue_draft");
    const brief = getBrief(job.request.brief_id)!;
    const payload: DialoguePayload = {
      pinned: ctx.pinned,
      audience: ctx.audience,
      tone: ctx.tone,
      brief: {
        hook_angle: brief.hook_angle,
        line_count: brief.line_count,
        cta: brief.cta,
        word_range: brief.word_range,
      },
      facts: ctx.facts,
      video: {
        video_id: job.request.video_id,
        topic: videoMeta.topic ?? "desk",
        pacing: videoMeta.pacing ?? "steady",
      },
    };
    const raw = await this.call(worker, job, "draft_dialogue", payload, brief.turnaround, "dialogue_draft");
    let candidate = raw === null ? null : lenientParse(raw);
    if (!candidate || candidate.lines.length === 0 || !candidate.lines.at(-1)?.text.includes(brief.cta)) {
      const repairRaw = await this.call(
        worker,
        job,
        "draft_dialogue",
        { ...payload, repair: { issues: ["CTA"] } },
        brief.turnaround,
        "dialogue_draft",
      );
      const repaired = repairRaw === null ? null : lenientParse(repairRaw);
      if (repaired) {
        // "Repair" appended onto whatever partial candidate exists.
        candidate = candidate ? { ...candidate, lines: [...candidate.lines, ...repaired.lines] } : repaired;
      }
    }
    if (!candidate || candidate.lines.length === 0) {
      await this.pool.query("UPDATE lab_baseline.jobs SET state = 'FAILED' WHERE job_id = $1", [job.job_id]);
      return "failed";
    }
    await this.hit("before_final_commit", worker, job.job_id, "dialogue_draft");
    // Terminal state FIRST, artifact SECOND, separate autocommit statements, no fencing.
    await this.pool.query(
      "UPDATE lab_baseline.jobs SET state = 'DRAFT_READY', updated_at = $2 WHERE job_id = $1",
      [job.job_id, this.clock.now()],
    );
    await this.hit("inside_final_commit", worker, job.job_id, "dialogue_draft");
    await this.saveDraft(job, candidate);
    return "done";
  }

  private async saveDraft(job: BJob, candidate: unknown): Promise<void> {
    // Destination = whatever conversation the client has open NOW.
    const destination = this.session.activeConversation;
    const artifact = JSON.stringify({ artifact_version: "1", candidate, review_state: "NEEDS_HUMAN_REVIEW" });
    const upd = await this.pool.query(
      "UPDATE lab_baseline.drafts SET artifact = $2, conversation_id = $3, updated_at = $4 WHERE job_id = $1",
      [job.job_id, artifact, destination, this.clock.now()],
    );
    if (upd.rowCount === 0) {
      await this.pool.query(
        "INSERT INTO lab_baseline.drafts (job_id, creator_id, conversation_id, artifact, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $5)",
        [job.job_id, job.creator_id, destination, artifact, this.clock.now()],
      );
    }
  }

  /** Product-only cache key; unapproved notes substituted when approved evidence is missing. */
  private contextFor(job: BJob): CachedContext {
    const key = `ctx:${job.request.product_id}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const creator = getCreator(job.creator_id)!;
    const brief = getBrief(job.request.brief_id)!;
    const rev = this.catalogState.currentProductRevision(job.request.product_id);
    const all = factsAt(job.request.product_id, rev);
    const facts = brief.required_fact_keys
      .map((k) => all.find((f) => f.key === k && f.status === "approved") ?? all.find((f) => f.key === k))
      .filter((f): f is NonNullable<typeof f> => Boolean(f))
      .map((f) => ({ fact_id: f.fact_id, value: f.value, source_ref: f.source_ref }));
    const ctx: CachedContext = {
      pinned: {
        creator_id: job.creator_id,
        conversation_id: job.conversation_id,
        job_id: job.job_id,
        profile_revision: creator.profile_revision,
        product_revision: rev,
        brief_revision: brief.brief_revision,
        policy_version: "policy-v1",
      },
      audience: creator.audience,
      tone: creator.tone,
      facts,
    };
    if (getProduct(job.request.product_id)) this.cache.set(key, ctx);
    return ctx;
  }

  /** Naive call: random operation id, no intent, no receipt, blind fallback on any problem. */
  private async call(
    worker: string,
    job: BJob,
    task: "classify_video" | "draft_dialogue",
    payload: unknown,
    turnaround: "standard" | "fast",
    stage: string,
  ): Promise<string | null> {
    let decision = routeBaseline({ task, contextTokens: estimateTokens(payload), turnaround });
    for (let attempt = 0; attempt < 2 && decision.selected; attempt++) {
      await this.hit("after_intent_before_submit", worker, job.job_id, stage);
      const res = await this.provider.invoke({
        profileId: decision.selected,
        task,
        operationId: randomUUID(),
        payload: payload as DialoguePayload,
        deadlineMs: 20_000,
      });
      if (res.accepted) await this.hit("after_provider_accept_before_receipt", worker, job.job_id, stage);
      if (res.kind === "response") {
        await this.hit("after_receipt", worker, job.job_id, stage);
        return res.content;
      }
      decision = routeBaseline({
        task,
        contextTokens: 0,
        turnaround: "standard",
        health: { [decision.selected]: "failed_pre_acceptance" },
      });
      if (task === "classify_video") decision = { ...decision, selected: "deep-profile" };
    }
    return null;
  }

  /** Reopen: if a job claims DRAFT_READY but no artifact exists, regenerate it (new paid call). */
  async reopen(worker: string, conversationId: string): Promise<unknown[]> {
    const jobs = await this.pool.query<BJob>(
      "SELECT * FROM lab_baseline.jobs WHERE conversation_id = $1 AND state = 'DRAFT_READY'",
      [conversationId],
    );
    for (const job of jobs.rows) {
      const d = await this.pool.query("SELECT 1 FROM lab_baseline.drafts WHERE job_id = $1", [job.job_id]);
      if (d.rowCount === 0) {
        try {
          await this.execute(worker, job);
        } catch (err) {
          if (!(err instanceof SimulatedCrash)) throw err;
        }
      }
    }
    const r = await this.pool.query(
      "SELECT * FROM lab_baseline.drafts WHERE conversation_id = $1 ORDER BY draft_row",
      [conversationId],
    );
    return r.rows;
  }
}

interface LooseCandidate {
  lines: Array<{ speaker: string; text: string }>;
  [k: string]: unknown;
}

/** Accepts almost anything that looks like dialogue. */
export function lenientParse(raw: string): LooseCandidate | null {
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    if (Array.isArray(j.lines)) return j as LooseCandidate;
    if (typeof j.script === "string") {
      return {
        lines: j.script
          .split("\n")
          .filter(Boolean)
          .map((l, i) => ({
            speaker: i % 2 === 0 ? "CREATOR" : "COHOST",
            text: l.replace(/^(CREATOR|COHOST):\s*/, ""),
          })),
      };
    }
  } catch {
    /* salvage below */
  }
  const texts = [...raw.matchAll(/"text":"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1] ?? "");
  if (texts.length === 0) return null;
  return { lines: texts.map((t, i) => ({ speaker: i % 2 === 0 ? "CREATOR" : "COHOST", text: t })) };
}
