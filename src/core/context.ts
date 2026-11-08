import type { Pinned, VideoAnalysis } from "../contracts.js";
import { type CatalogState, factsAt, type Fact, getBrief, getCreator } from "../fixtures.js";

export interface AssembledContext {
  pinned: Pinned;
  product_id: string;
  audience: string;
  tone: string;
  brief: {
    brief_id: string;
    hook_angle: string;
    line_count: number;
    cta: string;
    word_range: [number, number];
    required_fact_keys: string[];
  };
  /** Only approved facts of the PINNED product revision for the brief's required keys. */
  facts: Array<Pick<Fact, "fact_id" | "key" | "value" | "source_ref">>;
  video: Pick<VideoAnalysis, "video_id" | "topic" | "pacing">;
}

export type ContextResult =
  | { ok: true; context: AssembledContext }
  | { ok: false; code: "EVIDENCE_MISSING" | "STALE_REVISION" | "CONTEXT_INVALID"; detail: string };

export interface JobScope {
  job_id: string;
  creator_id: string;
  conversation_id: string;
  product_id: string;
  brief_id: string;
  pinned: Pinned;
}

/** Current revisions for a submission; pinned on the job row at submit time. */
export function currentRevisions(state: CatalogState, creatorId: string, productId: string, briefId: string) {
  const creator = getCreator(creatorId);
  const brief = getBrief(briefId);
  if (!creator || !brief) throw new Error("unknown creator or brief");
  return {
    profile_revision: creator.profile_revision,
    product_revision: state.currentProductRevision(productId),
    brief_revision: brief.brief_revision,
  };
}

/**
 * Assembles grounded context strictly from the job's own scope and pinned
 * revisions. Missing approved evidence is a safe rejection; unapproved notes are
 * never substituted. A revision published after submission is rejected
 * explicitly (the client must resubmit) rather than silently mixed in.
 */
export function assembleContext(job: JobScope, state: CatalogState, video: VideoAnalysis): ContextResult {
  const creator = getCreator(job.creator_id);
  const brief = getBrief(job.brief_id);
  if (!creator || !brief || brief.creator_id !== job.creator_id || brief.product_id !== job.product_id) {
    return { ok: false, code: "CONTEXT_INVALID", detail: "scope mismatch" };
  }
  const now = currentRevisions(state, job.creator_id, job.product_id, job.brief_id);
  for (const k of ["profile_revision", "product_revision", "brief_revision"] as const) {
    if (now[k] !== job.pinned[k]) {
      return { ok: false, code: "STALE_REVISION", detail: `${k} ${job.pinned[k]} -> ${now[k]}` };
    }
  }
  const approved = factsAt(job.product_id, job.pinned.product_revision).filter(
    (f) => f.status === "approved",
  );
  const facts: AssembledContext["facts"] = [];
  const missing: string[] = [];
  for (const key of brief.required_fact_keys) {
    const f = approved.find((x) => x.key === key);
    if (f) facts.push({ fact_id: f.fact_id, key: f.key, value: f.value, source_ref: f.source_ref });
    else missing.push(key);
  }
  if (missing.length > 0) return { ok: false, code: "EVIDENCE_MISSING", detail: missing.join(",") };
  return {
    ok: true,
    context: {
      pinned: job.pinned,
      product_id: job.product_id,
      audience: creator.audience,
      tone: creator.tone,
      brief: {
        brief_id: brief.brief_id,
        hook_angle: brief.hook_angle,
        line_count: brief.line_count,
        cta: brief.cta,
        word_range: brief.word_range,
        required_fact_keys: brief.required_fact_keys,
      },
      facts,
      video: { video_id: video.video_id, topic: video.topic, pacing: video.pacing },
    },
  };
}

/**
 * Convenience cache only. The key carries every ownership and revision field;
 * the durable source of truth is the immutable context_assembly checkpoint.
 */
export class ScopedContextCache {
  private m = new Map<string, AssembledContext>();
  static key(job: JobScope): string {
    const p = job.pinned;
    return [
      p.creator_id,
      p.conversation_id,
      p.job_id,
      p.profile_revision,
      p.product_revision,
      p.brief_revision,
      p.policy_version,
    ].join("|");
  }
  get(job: JobScope): AssembledContext | undefined {
    return this.m.get(ScopedContextCache.key(job));
  }
  set(job: JobScope, ctx: AssembledContext): void {
    this.m.set(ScopedContextCache.key(job), ctx);
  }
}
