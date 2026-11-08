import { z } from "zod";

export const JOB_STATES = [
  "READY",
  "RUNNING",
  "RETRY_WAIT",
  "DRAFT_READY",
  "FAILED",
  "RECONCILIATION_REQUIRED",
] as const;
export type JobState = (typeof JOB_STATES)[number];
export const TERMINAL_STATES: readonly JobState[] = ["DRAFT_READY", "FAILED"];

const selector = z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/, "invalid selector");

/** POST /v1/analysis-jobs body. Strict: no provider, fault, retry, URL, ownership or state fields. */
export const SubmitRequestSchema = z.strictObject({
  conversation_id: selector,
  product_id: selector,
  video_id: selector,
  brief_id: selector,
  idempotency_key: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/, "invalid idempotency key"),
});
export type SubmitRequest = z.infer<typeof SubmitRequestSchema>;

export const SPEAKERS = ["CREATOR", "COHOST"] as const;
export const EVIDENCE_STATUS = ["COMPLETE", "PARTIAL", "MISSING"] as const;

const nonEmpty = z.string().trim().min(1);

export const PinnedSchema = z.strictObject({
  creator_id: nonEmpty,
  conversation_id: nonEmpty,
  job_id: nonEmpty,
  profile_revision: nonEmpty,
  product_revision: nonEmpty,
  brief_revision: nonEmpty,
  policy_version: nonEmpty,
});
export type Pinned = z.infer<typeof PinnedSchema>;

/** Typed draft candidate returned (as JSON text) by the dialogue provider double. */
export const CandidateSchema = z.strictObject({
  candidate_version: z.literal("1"),
  hook: nonEmpty,
  audience: nonEmpty,
  lines: z.array(z.strictObject({ speaker: z.enum(SPEAKERS), text: nonEmpty })).min(1),
  claims: z.array(
    z.strictObject({
      fact_id: nonEmpty,
      value: nonEmpty,
      line_index: z.number().int().min(0),
    }),
  ),
  references: z.array(z.strictObject({ fact_id: nonEmpty, source_ref: nonEmpty })),
  evidence_status: z.enum(EVIDENCE_STATUS),
  needs_human_review: z.literal(true),
  provenance: PinnedSchema,
});
export type Candidate = z.infer<typeof CandidateSchema>;

export const VideoAnalysisSchema = z.strictObject({
  video_id: nonEmpty,
  duration_seconds: z.number().int().positive(),
  topic: nonEmpty,
  hook_moment_seconds: z.number().int().min(0),
  on_screen_product: nonEmpty,
  pacing: z.enum(["steady", "quick", "energetic"]),
});
export type VideoAnalysis = z.infer<typeof VideoAnalysisSchema>;

/** The saved, reopenable artifact. Not human-approved; never auto-published. */
export interface DraftArtifact {
  artifact_version: "1";
  candidate: Candidate;
  word_count: number;
  /** Words / 2.5 per second. An estimate from text length, NOT audio/video timing. */
  estimated_spoken_seconds: number;
  /** Verified required facts / required facts. A completeness heuristic, NOT a calibrated probability. */
  evidence_completeness: number;
  review_state: "NEEDS_HUMAN_REVIEW";
}
