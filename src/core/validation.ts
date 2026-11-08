import { CandidateSchema, type Candidate, type DraftArtifact } from "../contracts.js";
import { getProduct } from "../fixtures.js";
import type { AssembledContext } from "./context.js";

export interface ValidationIssue {
  code: string;
  detail?: string;
}

export type ValidationResult =
  | { ok: true; candidate: Candidate; artifact: DraftArtifact }
  | { ok: false; issues: ValidationIssue[]; parsed: unknown };

export function wordCount(lines: Array<{ text: string }>): number {
  return lines.reduce((n, l) => n + l.text.trim().split(/\s+/).filter(Boolean).length, 0);
}

function parseRaw(raw: string): { ok: true; value: unknown } | { ok: false; issue: ValidationIssue } {
  if (raw.trim() === "") return { ok: false, issue: { code: "EMPTY_OUTPUT" } };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    const opens = (raw.match(/[{[]/g) ?? []).length;
    const closes = (raw.match(/[}\]]/g) ?? []).length;
    if (raw.trim().startsWith("{") && opens > closes)
      return { ok: false, issue: { code: "TRUNCATED_OUTPUT" } };
    return { ok: false, issue: { code: "MALFORMED_JSON" } };
  }
}

/**
 * Validates a raw provider response FROM SCRATCH against the job's grounded
 * context. Checks structured fixture claims only; this is not semantic
 * entailment or general hallucination detection.
 */
export function validateCandidate(
  raw: string,
  ctx: AssembledContext,
  restrictedPhrases: string[],
): ValidationResult {
  const parsed = parseRaw(raw);
  if (!parsed.ok) return { ok: false, issues: [parsed.issue], parsed: null };
  const schema = CandidateSchema.safeParse(parsed.value);
  if (!schema.success) {
    return {
      ok: false,
      issues: [
        {
          code: "SCHEMA_INVALID",
          detail: schema.error.issues
            .map((i) => i.path.join("."))
            .slice(0, 5)
            .join(","),
        },
      ],
      parsed: parsed.value,
    };
  }
  const c = schema.data;
  const issues: ValidationIssue[] = [];
  const { brief } = ctx;

  if (c.lines.length !== brief.line_count) issues.push({ code: "LINE_COUNT", detail: `${c.lines.length}` });
  c.lines.forEach((l, i) => {
    const expected = i % 2 === 0 ? "CREATOR" : "COHOST";
    if (l.speaker !== expected) issues.push({ code: "SPEAKER_ORDER", detail: `line ${i}` });
  });
  const last = c.lines[c.lines.length - 1];
  if (!last || !last.text.trim().endsWith(brief.cta)) issues.push({ code: "CTA_NOT_IN_FINAL_LINE" });
  const words = wordCount(c.lines);
  if (words < brief.word_range[0] || words > brief.word_range[1])
    issues.push({ code: "WORD_COUNT", detail: `${words}` });
  if (c.audience !== ctx.audience) issues.push({ code: "AUDIENCE_MISMATCH" });
  for (const k of Object.keys(ctx.pinned) as Array<keyof AssembledContext["pinned"]>) {
    if (c.provenance[k] !== ctx.pinned[k]) issues.push({ code: "PROVENANCE_MISMATCH", detail: k });
  }

  // Claims: each must be an approved fact of the pinned revision, exact value, present in its line.
  const product = getProduct(ctx.product_id);
  const allFacts =
    product?.revisions.flatMap((r) => r.facts.map((f) => ({ ...f, revision: r.revision }))) ?? [];
  const pinnedFacts = allFacts.filter((f) => f.revision === ctx.pinned.product_revision);
  const verifiedKeys = new Set<string>();
  const claimedValuesByLine = new Map<number, string[]>();
  for (const claim of c.claims) {
    const inPinned = pinnedFacts.find((f) => f.fact_id === claim.fact_id);
    if (!inPinned) {
      const elsewhere = allFacts.find((f) => f.fact_id === claim.fact_id);
      const superseded =
        elsewhere &&
        pinnedFacts.some(
          (f) => f.supersedes === claim.fact_id || (f.key === elsewhere.key && f.status === "approved"),
        );
      issues.push({ code: superseded ? "FACT_SUPERSEDED" : "FACT_UNKNOWN", detail: claim.fact_id });
      continue;
    }
    if (inPinned.status !== "approved") {
      issues.push({ code: "FACT_UNAPPROVED", detail: claim.fact_id });
      continue;
    }
    if (claim.value !== inPinned.value) {
      issues.push({ code: "FACT_VALUE_MISMATCH", detail: claim.fact_id });
      continue;
    }
    const line = c.lines[claim.line_index];
    if (!line || !line.text.includes(claim.value)) {
      issues.push({ code: "CLAIM_NOT_IN_LINE", detail: claim.fact_id });
      continue;
    }
    const ref = c.references.find((r) => r.fact_id === claim.fact_id);
    // A source-looking string is not evidence: it must equal the retrieved fact's ref.
    if (
      !ref ||
      ref.source_ref !== inPinned.source_ref ||
      !ctx.facts.some((f) => f.fact_id === claim.fact_id)
    ) {
      issues.push({ code: "REFERENCE_NOT_RETRIEVED", detail: claim.fact_id });
      continue;
    }
    verifiedKeys.add(inPinned.key);
    claimedValuesByLine.set(claim.line_index, [
      ...(claimedValuesByLine.get(claim.line_index) ?? []),
      claim.value,
    ]);
  }
  for (const r of c.references) {
    if (!c.claims.some((cl) => cl.fact_id === r.fact_id))
      issues.push({ code: "ORPHAN_REFERENCE", detail: r.fact_id });
  }

  // Controlled factual text: restricted phrases are never admissible; digits must be covered by a verified claim.
  c.lines.forEach((l, i) => {
    const lower = l.text.toLowerCase();
    for (const p of restrictedPhrases)
      if (lower.includes(p.toLowerCase())) issues.push({ code: "RESTRICTED_PHRASE", detail: `line ${i}` });
    let rest = l.text;
    for (const v of claimedValuesByLine.get(i) ?? []) rest = rest.split(v).join(" ");
    if (/\d/.test(rest)) issues.push({ code: "UNCLAIMED_FACTUAL_TEXT", detail: `line ${i}` });
  });

  const required = brief.required_fact_keys;
  const missingRequired = required.filter((k) => !verifiedKeys.has(k));
  for (const k of missingRequired) issues.push({ code: "REQUIRED_FACT_MISSING", detail: k });
  const completeness =
    required.length === 0 ? 1 : (required.length - missingRequired.length) / required.length;
  if ((completeness === 1) !== (c.evidence_status === "COMPLETE"))
    issues.push({ code: "EVIDENCE_STATUS_INCONSISTENT" });

  if (issues.length > 0) return { ok: false, issues: dedupe(issues), parsed: c };
  return {
    ok: true,
    candidate: c,
    artifact: {
      artifact_version: "1",
      candidate: c,
      word_count: words,
      estimated_spoken_seconds: Math.round((words / 2.5) * 10) / 10,
      evidence_completeness: completeness,
      review_state: "NEEDS_HUMAN_REVIEW",
    },
  };
}

function dedupe(issues: ValidationIssue[]): ValidationIssue[] {
  const seen = new Set<string>();
  return issues.filter((i) => {
    const k = `${i.code}:${i.detail ?? ""}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
