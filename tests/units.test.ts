import { describe, expect, it } from "vitest";
import { lenientParse } from "../src/baseline/naive.js";
import { SubmitRequestSchema } from "../src/contracts.js";
import { assembleContext, type AssembledContext, ScopedContextCache } from "../src/core/context.js";
import { backoffMs, defaultPolicy } from "../src/core/policy.js";
import { routeBaseline, routeHardened } from "../src/core/routing.js";
import { sanitize } from "../src/core/trace.js";
import { validateCandidate } from "../src/core/validation.js";
import { CatalogState, getVideo } from "../src/fixtures.js";
import { renderDialogue } from "../src/providers/generator.js";

const policy = defaultPolicy();
const pinned = {
  creator_id: "desk-notes",
  conversation_id: "dn-conv-1",
  job_id: "00000000-0000-4000-8000-000000000001",
  profile_revision: "dn-p1",
  product_revision: "tc-r1",
  brief_revision: "bdr-1",
  policy_version: "policy-v1",
};
function ctx(brief = "brief-desk-reset", state = new CatalogState(), pin = pinned): AssembledContext {
  const v = getVideo("vid-dn-001")!;
  const r = assembleContext(
    {
      job_id: pin.job_id,
      creator_id: "desk-notes",
      conversation_id: "dn-conv-1",
      product_id: "tallycube",
      brief_id: brief,
      pinned: pin,
    },
    state,
    { video_id: v.video_id, ...v.analysis },
  );
  if (!r.ok) throw new Error(r.code);
  return r.context;
}
const payload = (c: AssembledContext) => ({
  pinned: c.pinned,
  audience: c.audience,
  tone: c.tone,
  brief: c.brief,
  facts: c.facts,
  video: c.video,
});
const codes = (raw: string, c = ctx()) => {
  const r = validateCandidate(raw, c, policy.restrictedPhrases);
  return r.ok ? [] : r.issues.map((i) => i.code);
};

describe("T-V candidate validator (R4, R5)", () => {
  it("T-V1 accepts a grounded candidate and labels it as needing human review", () => {
    const c = ctx();
    const r = validateCandidate(renderDialogue(payload(c), "ok"), c, policy.restrictedPhrases);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.artifact.review_state).toBe("NEEDS_HUMAN_REVIEW");
      expect(r.artifact.evidence_completeness).toBe(1);
      expect(r.artifact.estimated_spoken_seconds).toBeCloseTo(r.artifact.word_count / 2.5, 1);
    }
  });
  it("T-V2 rejects each output-contract violation with a specific code", () => {
    const c = ctx();
    expect(codes(renderDialogue(payload(c), "empty"))).toEqual(["EMPTY_OUTPUT"]);
    expect(codes(renderDialogue(payload(c), "malformed_json"))).toEqual(["MALFORMED_JSON"]);
    expect(codes(renderDialogue(payload(c), "truncated"))).toEqual(["TRUNCATED_OUTPUT"]);
    expect(codes(renderDialogue(payload(c), "wrong_schema"))).toEqual(["SCHEMA_INVALID"]);
    expect(codes(renderDialogue(payload(c), "wrong_cta"))).toContain("CTA_NOT_IN_FINAL_LINE");
    expect(codes(renderDialogue(payload(c), "wrong_line_count"))).toEqual(
      expect.arrayContaining(["LINE_COUNT", "SPEAKER_ORDER"]),
    );
    expect(codes(renderDialogue(payload(c), "unapproved_claim"))).toContain("RESTRICTED_PHRASE");
  });
  it("T-V3 rejects unapproved, unknown, mismatched and superseded fact references and fake sources", () => {
    const c = ctx();
    const base = JSON.parse(renderDialogue(payload(c), "ok"));
    const mutate = (f: (x: typeof base) => void) => {
      const x = structuredClone(base);
      f(x);
      return codes(JSON.stringify(x));
    };
    expect(mutate((x) => (x.claims[0].fact_id = "tc-note-productivity"))).toContain("FACT_UNAPPROVED");
    expect(mutate((x) => (x.claims[0].fact_id = "tc-made-up"))).toContain("FACT_UNKNOWN");
    expect(mutate((x) => (x.claims[0].value = "counts from 1 to 99 minutes"))).toContain(
      "FACT_VALUE_MISMATCH",
    );
    expect(mutate((x) => (x.references[0].source_ref = "https://example.invalid/study"))).toContain(
      "REFERENCE_NOT_RETRIEVED",
    );
    expect(mutate((x) => (x.lines[4].text = "It lasts 7 years, trust me."))).toContain(
      "UNCLAIMED_FACTUAL_TEXT",
    );
    expect(mutate((x) => (x.audience = "university students planning exam weeks"))).toContain(
      "AUDIENCE_MISMATCH",
    );
    expect(mutate((x) => (x.provenance.conversation_id = "dn-conv-2"))).toContain("PROVENANCE_MISMATCH");
    expect(mutate((x) => (x.needs_human_review = false))).toEqual(["SCHEMA_INVALID"]);
    expect(mutate((x) => (x.lines[0].speaker = "NARRATOR"))).toEqual(["SCHEMA_INVALID"]);

    // Superseded: a tc-r1 battery claim checked against a tc-r2 pinned context.
    const state = new CatalogState();
    state.publishProductRevision("tallycube", "tc-r2");
    const r2 = ctx("brief-desk-battery", state, {
      ...pinned,
      product_revision: "tc-r2",
      brief_revision: "bdb-1",
    });
    const stale = JSON.parse(renderDialogue(payload(r2), "ok"));
    stale.claims[0] = { fact_id: "tc-r1-battery", value: "runs about 30 days per charge", line_index: 2 };
    expect(codes(JSON.stringify(stale), r2)).toContain("FACT_SUPERSEDED");
  });
  it("T-V4 context assembly never substitutes unapproved notes and rejects stale pins", () => {
    const v = getVideo("vid-dn-001")!;
    const scope = {
      job_id: pinned.job_id,
      creator_id: "desk-notes",
      conversation_id: "dn-conv-1",
      product_id: "tallycube",
      brief_id: "brief-desk-outcome",
      pinned: { ...pinned, brief_revision: "bdo-1" },
    };
    expect(assembleContext(scope, new CatalogState(), { video_id: v.video_id, ...v.analysis })).toMatchObject(
      { ok: false, code: "EVIDENCE_MISSING" },
    );
    const s = new CatalogState();
    s.publishProductRevision("tallycube", "tc-r2");
    expect(
      assembleContext({ ...scope, brief_id: "brief-desk-reset", pinned }, s, {
        video_id: v.video_id,
        ...v.analysis,
      }),
    ).toMatchObject({ ok: false, code: "STALE_REVISION" });
  });
  it("T-V5 scoped cache key includes actor, conversation, job and every revision", () => {
    const k = ScopedContextCache.key({
      job_id: "j",
      creator_id: "c",
      conversation_id: "v",
      product_id: "p",
      brief_id: "b",
      pinned,
    });
    for (const v of Object.values(pinned)) expect(k).toContain(v);
  });
});

describe("T-P routing, policy, trace sanitization (R15, R16, R19)", () => {
  it("T-P1 hardened router checks compatibility and never routes around unknown acceptance", () => {
    expect(routeHardened({ task: "draft_dialogue", contextTokens: 900, turnaround: "fast" }).selected).toBe(
      "structured-dialogue",
    );
    expect(
      routeHardened({ task: "draft_dialogue", contextTokens: 9000, turnaround: "standard" }).selected,
    ).toBeNull();
    const hold = routeHardened({
      task: "draft_dialogue",
      contextTokens: 900,
      turnaround: "standard",
      health: { "structured-dialogue": "acceptance_unknown" },
    });
    expect(hold.selected).toBeNull();
    expect(hold.reason).toMatch(/HOLD_FOR_RECONCILIATION/);
    expect(
      routeHardened({
        task: "draft_dialogue",
        contextTokens: 900,
        turnaround: "standard",
        health: { "structured-dialogue": "failed_pre_acceptance" },
      }).selected,
    ).toBe("compatible-backup");
  });
  it("T-P2 baseline router reproduces the F01 routing defects (documented, CLI-only)", () => {
    expect(routeBaseline({ task: "draft_dialogue", contextTokens: 900, turnaround: "fast" }).selected).toBe(
      "quick-classify",
    );
    expect(
      routeBaseline({
        task: "draft_dialogue",
        contextTokens: 900,
        turnaround: "standard",
        health: { "structured-dialogue": "acceptance_unknown" },
      }).selected,
    ).toBe("compatible-backup");
  });
  it("T-P3 deterministic capped exponential backoff", () => {
    expect([1, 2, 3, 4, 5, 6].map((n) => backoffMs(policy, n))).toEqual([
      2000, 4000, 8000, 16000, 30000, 30000,
    ]);
  });
  it("T-P4 trace sanitization drops unknown keys and truncates strings", () => {
    const s = sanitize({ worker: "w", password: "x", response_content: "secret", reason: "r".repeat(500) });
    expect(Object.keys(s).sort()).toEqual(["reason", "worker"]);
    expect((s.reason as string).length).toBe(200);
  });
  it("T-P5 submission schema is strict and selector-shaped", () => {
    expect(
      SubmitRequestSchema.safeParse({
        conversation_id: "dn-conv-1",
        product_id: "tallycube",
        video_id: "vid-dn-001",
        brief_id: "brief-desk-reset",
        idempotency_key: "short",
      }).success,
    ).toBe(false);
    expect(lenientParse("")).toBeNull();
  });
});
