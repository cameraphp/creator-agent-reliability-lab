import { afterEach, describe, expect, it } from "vitest";
import { FaultInjector } from "../src/core/faults.js";
import { withCreatorContext } from "../src/db/pool.js";
import { resolveReconciliation } from "../src/ops.js";
import { ledgerSummary } from "../src/providers/simulated.js";
import { getJob, getTrace, listDrafts, submitJob } from "../src/service.js";
import { Worker } from "../src/worker/worker.js";
import { deskRequest, type Lab, makeLab } from "./helpers.js";

let lab: Lab;
afterEach(async () => lab?.close());

async function run(opts: Parameters<typeof makeLab>[0], key: string, over: Record<string, string> = {}) {
  lab = await makeLab(opts);
  const s = await submitJob(lab.svc, "actor-desk-notes", deskRequest(key, over));
  return s.job.job_id;
}
const events = async (jobId: string) =>
  (await getTrace(lab.svc, "actor-desk-notes", jobId)).map((e) => e.event);
const calls = (jobId: string) =>
  withCreatorContext(
    lab.workerPool,
    "desk-notes",
    async (c) =>
      (
        await c.query(
          "SELECT stage, purpose, profile_id, status, invocations, response_source FROM lab.provider_calls WHERE job_id = $1 ORDER BY created_at",
          [jobId],
        )
      ).rows,
  );

describe("T-U provider uncertainty: intents, receipts, reconciliation (R13-R15)", () => {
  it("T-U1 crash BEFORE submission: lookup proves non-acceptance, same operation id is retried, one billable op", async () => {
    const id = await run(
      { faults: [{ at: "after_intent_before_submit", stage: "dialogue_draft", kind: "crash" }] },
      "unc-key-0001",
    );
    await expect(lab.worker("w1").runOnce()).rejects.toThrow(/SIMULATED_CRASH/);
    lab.clock.advance(lab.policy.leaseMs + 1);
    await lab.drain("w2");
    expect((await getJob(lab.svc, "actor-desk-notes", id)).state).toBe("DRAFT_READY");
    const dialogue = (await calls(id)).filter((c) => c.stage === "dialogue_draft");
    expect(dialogue).toHaveLength(1);
    expect(dialogue[0]).toMatchObject({ status: "RECEIVED", invocations: 2, response_source: "direct" });
    expect((await ledgerSummary(lab.workerPool)).accepted_operations).toBe(2);
    expect(await events(id)).toContain("reconciliation.status_lookup");
  });

  it("T-U2 crash AFTER provider acceptance, BEFORE local receipt: status lookup recovers the accepted result, no second charge", async () => {
    const id = await run(
      { faults: [{ at: "after_provider_accept_before_receipt", stage: "dialogue_draft", kind: "crash" }] },
      "unc-key-0002",
    );
    await expect(lab.worker("w1").runOnce()).rejects.toThrow(/SIMULATED_CRASH/);
    const mid = await ledgerSummary(lab.workerPool);
    expect(mid.accepted_operations).toBe(2); // provider already charged the dialogue op
    lab.clock.advance(lab.policy.leaseMs + 1);
    await lab.drain("w2");
    expect((await getJob(lab.svc, "actor-desk-notes", id)).state).toBe("DRAFT_READY");
    const after = await ledgerSummary(lab.workerPool);
    expect(after.accepted_operations).toBe(2);
    expect(after.invocations).toBe(mid.invocations); // lookup is not an invocation
    expect((await calls(id)).find((c) => c.stage === "dialogue_draft")?.response_source).toBe(
      "status_lookup",
    );
  });

  it("T-U3 crash AFTER durable receipt: restart reuses the receipt, zero new invocations", async () => {
    const id = await run(
      { faults: [{ at: "after_receipt", stage: "dialogue_draft", kind: "crash" }] },
      "unc-key-0003",
    );
    await expect(lab.worker("w1").runOnce()).rejects.toThrow(/SIMULATED_CRASH/);
    const mid = await ledgerSummary(lab.workerPool);
    lab.clock.advance(lab.policy.leaseMs + 1);
    await lab.drain("w2");
    expect((await getJob(lab.svc, "actor-desk-notes", id)).state).toBe("DRAFT_READY");
    expect((await ledgerSummary(lab.workerPool)).invocations).toBe(mid.invocations);
    expect(await events(id)).toContain("provider.receipt_reused");
  });

  it("T-U4 ambiguous timeout on a profile WITHOUT idempotency/status: RECONCILIATION_REQUIRED, no blind retry, no paid fallback", async () => {
    const id = await run(
      {
        script: {
          "structured-dialogue": ["transport_error", "transport_error"],
          "compatible-backup": ["timeout_after_acceptance"],
        },
      },
      "unc-key-0004",
    );
    await lab.drain("w1");
    const j = await getJob(lab.svc, "actor-desk-notes", id);
    expect(j.state).toBe("RECONCILIATION_REQUIRED");
    expect(j.error_code).toBe("UPSTREAM_ACCEPTANCE_UNKNOWN");
    expect(j.client_guidance.action).toBe("await_operator");
    const ledger = await ledgerSummary(lab.workerPool);
    expect(ledger.accepted_operations).toBe(2); // video + the one uncertain backup op; nothing after it
    expect(await lab.drain("w2")).toEqual([]); // not claimable: never auto-retried
    expect(await listDrafts(lab.svc, "actor-desk-notes", "dn-conv-1")).toHaveLength(0);
    const c = await calls(id);
    expect(c.map((x) => `${x.profile_id}:${x.status}`)).toEqual([
      "quick-classify:RECEIVED",
      "structured-dialogue:NOT_ACCEPTED",
      "compatible-backup:UNRESOLVED",
    ]);
  });

  it("T-U4b operator resolution names one job and one upstream finding; not-accepted requeues within budget", async () => {
    const id = await run(
      {
        script: {
          "structured-dialogue": ["transport_error", "transport_error"],
          "compatible-backup": ["timeout_after_acceptance"],
        },
      },
      "unc-key-0004b",
    );
    await lab.drain("w1");
    await expect(
      resolveReconciliation(lab.workerPool, lab.clock, id, "not-accepted", "Bad Operator"),
    ).rejects.toThrow(/operator/);
    const res = await resolveReconciliation(lab.workerPool, lab.clock, id, "not-accepted", "ops-oncall");
    expect(res.new_state).toBe("READY");
    await expect(
      resolveReconciliation(lab.workerPool, lab.clock, id, "not-accepted", "ops-oncall"),
    ).rejects.toThrow(/not RECONCILIATION_REQUIRED/);
    await lab.drain("w2");
    expect((await getJob(lab.svc, "actor-desk-notes", id)).state).toBe("DRAFT_READY");
    expect(await events(id)).toContain("operator.reconciled");
  });

  it("T-U5 known pre-acceptance failures retry with deterministic backoff inside the shared budget", async () => {
    const id = await run({ script: { "structured-dialogue": ["transport_error"] } }, "unc-key-0005");
    const out = await lab.worker("w1").runOnce();
    expect(out.kind).toBe("retry_wait");
    const row = (
      await lab.workerPool.query("SELECT state, next_run_at FROM lab.jobs WHERE job_id = $1", [id])
    ).rows[0];
    expect(row.state).toBe("RETRY_WAIT");
    expect(new Date(row.next_run_at).getTime() - lab.clock.now().getTime()).toBe(2_000); // backoff(1)
    expect((await lab.worker("w1").runOnce()).kind).toBe("idle"); // not due yet
    lab.clock.advance(2_000);
    expect((await lab.worker("w1").runOnce()).kind).toBe("draft_ready");
    expect((await calls(id)).find((c) => c.stage === "dialogue_draft")).toMatchObject({
      profile_id: "structured-dialogue",
      invocations: 2,
    });
  });

  it("T-U6 exhausted budget fails safely with no artifact", async () => {
    const id = await run(
      {
        script: {
          "structured-dialogue": ["transport_error", "transport_error", "transport_error"],
          "compatible-backup": ["transport_error", "transport_error"],
        },
      },
      "unc-key-0006",
    );
    await lab.drain("w1");
    const j = await getJob(lab.svc, "actor-desk-notes", id);
    expect(j).toMatchObject({ state: "FAILED", error_code: "BUDGET_EXHAUSTED" });
    const used = (await calls(id)).reduce((a, c) => a + c.invocations, 0);
    expect(used).toBe(lab.policy.maxCallerAttemptsPerJob);
  });

  it("T-U7 late result after the deadline is discarded and recovered by reconciliation", async () => {
    const id = await run({ script: { "structured-dialogue": ["late_ok"] } }, "unc-key-0007");
    await lab.drain("w1");
    expect((await getJob(lab.svc, "actor-desk-notes", id)).state).toBe("DRAFT_READY");
    const t = await getTrace(lab.svc, "actor-desk-notes", id);
    expect(t.find((e) => e.event === "provider.ambiguous_timeout")?.attrs).toMatchObject({
      late_result_discarded: true,
    });
    expect((await ledgerSummary(lab.workerPool)).accepted_operations).toBe(2);
  });

  it("T-U8 fast-turnaround brief is routed by compatibility, with exclusion reasons traced", async () => {
    const id = await run({}, "unc-key-0008", { brief_id: "brief-desk-fast", video_id: "vid-dn-002" });
    await lab.drain("w1");
    const route = (await getTrace(lab.svc, "actor-desk-notes", id)).filter(
      (e) => e.event === "route.decision" && e.stage === "dialogue_draft",
    )[0];
    expect(route?.attrs).toMatchObject({ selected: "structured-dialogue", reason: "PRIMARY_COMPATIBLE" });
    expect(JSON.stringify(route?.attrs)).toMatch(/quick-classify:CONTEXT_WINDOW_2000_LT_4000/);
  });
});

describe("T-I provider double idempotency contract (supported vs unsupported)", () => {
  it("T-I1 same operation id: honoured key replays without a new charge; unsupported profile charges twice", async () => {
    lab = await makeLab();
    const payload = { video_id: "vid-dn-001" };
    const req = { task: "classify_video" as const, payload, deadlineMs: 20_000 };
    const a = await lab.provider.invoke({ ...req, profileId: "quick-classify", operationId: "op-same-1" });
    const b = await lab.provider.invoke({ ...req, profileId: "quick-classify", operationId: "op-same-1" });
    expect(a.kind === "response" && !a.replayed).toBe(true);
    expect(b.kind === "response" && b.replayed && b.usage.charge_units === 0).toBe(true);
    expect(a.kind === "response" && b.kind === "response" && a.content === b.content).toBe(true);
    let s = await ledgerSummary(lab.workerPool);
    expect([s.accepted_operations, s.replays]).toEqual([1, 1]);
    // compatible-backup ignores the key: the "retry" is a second billable operation.
    const c = deskContextPayload();
    await lab.provider.invoke({
      task: "draft_dialogue",
      payload: c,
      deadlineMs: 20_000,
      profileId: "compatible-backup",
      operationId: "op-same-2",
    });
    await lab.provider.invoke({
      task: "draft_dialogue",
      payload: c,
      deadlineMs: 20_000,
      profileId: "compatible-backup",
      operationId: "op-same-2",
    });
    s = await ledgerSummary(lab.workerPool);
    expect(s.accepted_operations).toBe(3);
    await expect(lab.provider.lookup("compatible-backup", "op-same-2")).rejects.toThrow(/no status lookup/);
  });
});

function deskContextPayload() {
  return {
    pinned: {
      creator_id: "desk-notes",
      conversation_id: "dn-conv-1",
      job_id: "j",
      profile_revision: "dn-p1",
      product_revision: "tc-r1",
      brief_revision: "bdr-1",
      policy_version: "policy-v1",
    },
    audience: "remote workers resetting small home desks",
    tone: "calm",
    brief: {
      hook_angle: "h",
      line_count: 6,
      cta: "Follow for the full desk reset.",
      word_range: [45, 120] as [number, number],
    },
    facts: [],
    video: { video_id: "vid-dn-001", topic: "t", pacing: "steady" },
  };
}

describe("T-K output contract, repair and atomic persistence (R4, R5, R10, R17)", () => {
  for (const bad of [
    "empty",
    "malformed_json",
    "truncated",
    "wrong_schema",
    "wrong_cta",
    "wrong_line_count",
    "unapproved_claim",
  ] as const) {
    it(`T-K1 ${bad} -> one targeted repair -> complete replacement validated from scratch`, async () => {
      const id = await run({ script: { "structured-dialogue": [bad] } }, `contract-key-${bad}`);
      await lab.drain("w1");
      expect((await getJob(lab.svc, "actor-desk-notes", id)).state).toBe("DRAFT_READY");
      const drafts = await listDrafts(lab.svc, "actor-desk-notes", "dn-conv-1");
      expect(drafts).toHaveLength(1);
      expect(drafts[0]!.artifact.candidate.lines).toHaveLength(6);
      const cands = await withCreatorContext(
        lab.workerPool,
        "desk-notes",
        async (c) =>
          (
            await c.query("SELECT kind, verdict FROM lab.candidates WHERE job_id = $1 ORDER BY created_at", [
              id,
            ])
          ).rows,
      );
      expect(cands).toEqual([
        { kind: "initial", verdict: "REJECTED" },
        { kind: "repair", verdict: "ACCEPTED" },
      ]);
    });
  }

  it("T-K2 failed repair -> FAILED, rejected candidates stay diagnostic, nothing masquerades as ready", async () => {
    const id = await run(
      { script: { "structured-dialogue": ["wrong_line_count", "wrong_cta"] } },
      "contract-key-failed-repair",
    );
    await lab.drain("w1");
    expect(await getJob(lab.svc, "actor-desk-notes", id)).toMatchObject({
      state: "FAILED",
      error_code: "CONTRACT_INVALID_AFTER_REPAIR",
    });
    expect(await listDrafts(lab.svc, "actor-desk-notes", "dn-conv-1")).toHaveLength(0);
    expect((await ledgerSummary(lab.workerPool)).accepted_operations).toBe(3); // no second repair
  });

  it("T-K3 database transaction failure inside the final commit rolls back atomically; recovery reuses receipts", async () => {
    const id = await run({ faults: [{ at: "inside_final_commit", kind: "db_fail" }] }, "contract-key-dbfail");
    const out = await lab.worker("w1").runOnce();
    expect(out.kind).toBe("error");
    const j = await getJob(lab.svc, "actor-desk-notes", id);
    expect(j.state).toBe("RUNNING");
    expect(await listDrafts(lab.svc, "actor-desk-notes", "dn-conv-1")).toHaveLength(0);
    const accepted = await withCreatorContext(
      lab.workerPool,
      "desk-notes",
      async (c) =>
        (await c.query("SELECT count(*)::int AS n FROM lab.candidates WHERE verdict = 'ACCEPTED'")).rows[0].n,
    );
    expect(accepted).toBe(0);
    const before = await ledgerSummary(lab.workerPool);
    lab.clock.advance(lab.policy.leaseMs + 1);
    await lab.drain("w2");
    expect((await getJob(lab.svc, "actor-desk-notes", id)).state).toBe("DRAFT_READY");
    expect((await ledgerSummary(lab.workerPool)).invocations).toBe(before.invocations);
  });

  it("T-K4 stale revision mid-job is rejected explicitly before the paid dialogue call", async () => {
    lab = await makeLab();
    const s = await submitJob(
      lab.svc,
      "actor-desk-notes",
      deskRequest("contract-key-stale", { brief_id: "brief-desk-battery" }),
    );
    const faults = new FaultInjector(
      [{ at: "before_stage:dialogue_draft", kind: "event", event: "publish" }],
      () => lab.catalogState.publishProductRevision("tallycube", "tc-r2"),
    );
    const w = new Worker("w1", {
      pool: lab.workerPool,
      provider: lab.provider,
      clock: lab.clock,
      catalogState: lab.catalogState,
      policy: lab.policy,
      faults,
    });
    expect(await w.runOnce()).toMatchObject({ kind: "failed", code: "STALE_REVISION" });
    expect(await getJob(lab.svc, "actor-desk-notes", s.job.job_id)).toMatchObject({
      state: "FAILED",
      error_code: "STALE_REVISION",
    });
    expect((await ledgerSummary(lab.workerPool)).accepted_operations).toBe(1); // video only; no dialogue spend
    expect(await listDrafts(lab.svc, "actor-desk-notes", "dn-conv-1")).toHaveLength(0);
  });

  it("T-K5 required fact only available as an unapproved note -> EVIDENCE_MISSING, never substituted", async () => {
    const id = await run({}, "contract-key-evidence", { brief_id: "brief-desk-outcome" });
    await lab.drain("w1");
    expect(await getJob(lab.svc, "actor-desk-notes", id)).toMatchObject({
      state: "FAILED",
      error_code: "EVIDENCE_MISSING",
    });
    expect((await ledgerSummary(lab.workerPool)).accepted_operations).toBe(1); // only video analysis
  });
});
