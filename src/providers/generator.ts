import type { Candidate, Pinned } from "../contracts.js";
import { getVideo } from "../fixtures.js";

/** What the caller sends to the dialogue profile. Baseline may (wrongly) include unapproved facts. */
export interface DialoguePayload {
  pinned: Pinned;
  audience: string;
  tone: string;
  brief: { hook_angle: string; line_count: number; cta: string; word_range: [number, number] };
  facts: Array<{ fact_id: string; value: string; source_ref: string }>;
  video: { video_id: string; topic: string; pacing: string };
  repair?: { issues: string[] };
}
export interface VideoPayload {
  video_id: string;
}

export type ContentOutcome =
  | "ok"
  | "empty"
  | "malformed_json"
  | "truncated"
  | "wrong_schema"
  | "wrong_cta"
  | "wrong_line_count"
  | "unapproved_claim";

/** Deterministic stand-in for a model. Output depends only on payload + scripted outcome. */
export function renderDialogue(p: DialoguePayload, outcome: ContentOutcome): string {
  const [f1, f2] = p.facts;
  const lines: Candidate["lines"] = [
    { speaker: "CREATOR", text: `${p.brief.hook_angle}, made for ${p.audience}.` },
    { speaker: "COHOST", text: `Where do we start on today's ${p.video.topic}?` },
    {
      speaker: "CREATOR",
      text: f1
        ? `Here is the TallyCube detail, ${f1.value}.`
        : "Here is TallyCube, sitting quietly on the corner.",
    },
    {
      speaker: "COHOST",
      text: f2 ? `Plus one more detail, ${f2.value}.` : "I like that it stays out of the way.",
    },
    { speaker: "CREATOR", text: `Keep the routine ${p.tone} and give each task one clear block.` },
    { speaker: "COHOST", text: `Try it once this week and tell us how it went. ${p.brief.cta}` },
  ];
  const claims: Candidate["claims"] = [];
  if (f1) claims.push({ fact_id: f1.fact_id, value: f1.value, line_index: 2 });
  if (f2) claims.push({ fact_id: f2.fact_id, value: f2.value, line_index: 3 });
  const candidate: Candidate = {
    candidate_version: "1",
    hook: p.brief.hook_angle,
    audience: p.audience,
    lines,
    claims,
    references: p.facts.slice(0, 2).map((f) => ({ fact_id: f.fact_id, source_ref: f.source_ref })),
    evidence_status: "COMPLETE",
    needs_human_review: true,
    provenance: p.pinned,
  };
  const json = JSON.stringify(candidate);
  switch (outcome) {
    case "ok":
      return json;
    case "empty":
      return "";
    case "malformed_json":
      return `{"candidate_version": "1", "hook": ${p.brief.hook_angle}, "lines": []}`;
    case "truncated":
      return json.slice(0, Math.floor(json.length * 0.55));
    case "wrong_schema":
      return JSON.stringify({ script: lines.map((l) => `${l.speaker}: ${l.text}`).join("\n"), version: 2 });
    case "wrong_cta": {
      const last = lines[5];
      if (last) last.text = "Try it once this week and tell us how it went. Thanks for watching.";
      return JSON.stringify(candidate);
    }
    case "wrong_line_count":
      return JSON.stringify({ ...candidate, lines: lines.filter((_, i) => i !== 4) });
    case "unapproved_claim": {
      const l4 = lines[4];
      if (l4) l4.text = "Keep the routine simple, it is guaranteed to double productivity.";
      return JSON.stringify(candidate);
    }
  }
}

export function renderVideoAnalysis(p: VideoPayload, outcome: ContentOutcome): string {
  const v = getVideo(p.video_id);
  if (!v) return JSON.stringify({ error: "unknown video" });
  const json = JSON.stringify({ video_id: v.video_id, ...v.analysis });
  if (outcome === "ok") return json;
  if (outcome === "empty") return "";
  return json.slice(0, Math.floor(json.length / 2));
}
