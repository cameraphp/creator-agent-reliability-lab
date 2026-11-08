import type { Pinned } from "../contracts.js";
import { assembleContext } from "../core/context.js";
import { defaultPolicy } from "../core/policy.js";
import { validateCandidate } from "../core/validation.js";
import { CatalogState, catalog, factsAt, getBrief, getCreator, getVideo } from "../fixtures.js";
import type { ObservedDraft, ObservedJob } from "./systems.js";

export interface ArtifactJudgement {
  valid: boolean;
  invalid_reasons: string[];
  wrong_context: string[];
}

/**
 * Independent ground truth for a saved artifact, computed from fixtures only:
 * the job's ORIGINAL creator, conversation and brief, and the product revision
 * that was current when the artifact was saved.
 */
export function judgeArtifact(
  draft: ObservedDraft,
  job: ObservedJob,
  revisionAtSave: string,
): ArtifactJudgement {
  const wrong: string[] = [];
  const candidate = (draft.artifact?.candidate ?? null) as Record<string, unknown> | null;
  const owner = catalog.creators.find((c) => c.conversations.includes(draft.conversation_id))?.creator_id;
  if (draft.conversation_id !== job.conversation_id) wrong.push("WRONG_DESTINATION_CONVERSATION");
  if (owner !== job.creator_id) wrong.push("CROSS_CREATOR_DELIVERY");
  const creator = getCreator(job.creator_id)!;
  if (candidate?.audience !== creator.audience) wrong.push("WRONG_AUDIENCE");
  const prov = (candidate?.provenance ?? {}) as Partial<Pinned>;
  if (
    prov.creator_id !== job.creator_id ||
    prov.conversation_id !== job.conversation_id ||
    prov.job_id !== job.job_id
  ) {
    wrong.push("WRONG_PROVENANCE");
  }
  const currentIds = new Set(factsAt(job.product_id, revisionAtSave).map((f) => f.fact_id));
  const claims = Array.isArray(candidate?.claims) ? (candidate.claims as Array<{ fact_id?: string }>) : [];
  if (claims.some((c) => c.fact_id && !currentIds.has(c.fact_id))) wrong.push("STALE_OR_FOREIGN_FACT");

  const brief = getBrief(job.brief_id)!;
  const pinned: Pinned = {
    creator_id: job.creator_id,
    conversation_id: job.conversation_id,
    job_id: job.job_id,
    profile_revision: creator.profile_revision,
    product_revision: revisionAtSave,
    brief_revision: brief.brief_revision,
    policy_version: defaultPolicy().version,
  };
  const state = new CatalogState();
  state.publishProductRevision(job.product_id, revisionAtSave);
  const v = getVideo(job.video_id)!;
  const ctx = assembleContext(
    {
      job_id: job.job_id,
      creator_id: job.creator_id,
      conversation_id: job.conversation_id,
      product_id: job.product_id,
      brief_id: job.brief_id,
      pinned,
    },
    state,
    { video_id: v.video_id, ...v.analysis },
  );
  const invalid: string[] = [];
  if (!ctx.ok) invalid.push(`NO_VALID_ARTIFACT_POSSIBLE:${ctx.code}`);
  else {
    const res = validateCandidate(JSON.stringify(candidate), ctx.context, defaultPolicy().restrictedPhrases);
    if (!res.ok) invalid.push(...res.issues.map((i) => i.code));
  }
  return {
    valid: invalid.length === 0 && wrong.length === 0,
    invalid_reasons: [...new Set(invalid)],
    wrong_context: wrong,
  };
}
