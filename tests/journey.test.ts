import { afterEach, describe, expect, it } from "vitest";
import { createPool } from "../src/db/pool.js";
import { ledgerSummary } from "../src/providers/simulated.js";
import { getJob, getTrace, listDrafts, ServiceError, submitJob } from "../src/service.js";
import { deskRequest, type Lab, makeLab, TEST_DB } from "./helpers.js";

let lab: Lab;
afterEach(async () => lab?.close());

describe("T-J happy journey with durable save and reopen (R2, R3, R10, R11)", () => {
  it("T-J1 submit -> 202 after commit, worker drafts, save, close/reopen returns the same artifact with no new provider work", async () => {
    lab = await makeLab();
    const sub = await submitJob(lab.svc, "actor-desk-notes", deskRequest("journey-key-0001"));
    expect(sub.status).toBe(202);
    expect(sub.job.state).toBe("READY");

    // Committed before 202: visible from an independent connection.
    const other = createPool("app", TEST_DB, 1);
    expect((await getJob({ ...lab.svc, appPool: other }, "actor-desk-notes", sub.job.job_id)).state).toBe(
      "READY",
    );

    const kinds = await lab.drain("w1");
    expect(kinds).toEqual(["draft_ready"]);
    const done = await getJob(lab.svc, "actor-desk-notes", sub.job.job_id);
    expect(done.state).toBe("DRAFT_READY");
    expect(done.client_guidance.action).toBe("show_draft");

    const before = await ledgerSummary(lab.workerPool);
    expect(before.accepted_operations).toBe(2); // video analysis + dialogue

    // "Close the app": drop every pool. "Reopen": brand-new pool, fetch by conversation.
    await lab.appPool.end();
    const reopened = createPool("app", TEST_DB, 1);
    const drafts = await listDrafts({ ...lab.svc, appPool: reopened }, "actor-desk-notes", "dn-conv-1");
    expect(drafts).toHaveLength(1);
    const d = drafts[0]!;
    expect(d.job_id).toBe(sub.job.job_id);
    expect(d.artifact.review_state).toBe("NEEDS_HUMAN_REVIEW");
    expect(d.artifact.candidate.needs_human_review).toBe(true);
    expect(d.artifact.candidate.lines).toHaveLength(6);
    expect(d.artifact.candidate.lines.at(-1)!.text.endsWith("Follow for the full desk reset.")).toBe(true);
    expect(d.artifact.candidate.audience).toBe("remote workers resetting small home desks");

    const again = await listDrafts({ ...lab.svc, appPool: reopened }, "actor-desk-notes", "dn-conv-1");
    expect(again.map((x) => x.draft_id)).toEqual([d.draft_id]);
    const after = await ledgerSummary(lab.workerPool);
    expect(after.invocations).toBe(before.invocations); // reopen never calls the provider

    const events = (
      await getTrace({ ...lab.svc, appPool: reopened }, "actor-desk-notes", sub.job.job_id)
    ).map((e) => e.event);
    expect(events[0]).toBe("job.submitted");
    expect(events).toContain("provider.intent_recorded");
    expect(events).toContain("provider.receipt_committed");
    expect(events.at(-1)).toBe("draft.saved");
    lab.appPool = reopened; // so afterEach closes the live pool
    await other.end();
  });

  it("T-J2 exact resubmission returns the same job; changed input with the same key is 409", async () => {
    lab = await makeLab();
    const a = await submitJob(lab.svc, "actor-desk-notes", deskRequest("journey-key-0002"));
    const b = await submitJob(lab.svc, "actor-desk-notes", deskRequest("journey-key-0002"));
    expect(b.status).toBe(200);
    expect(b.replay).toBe(true);
    expect(b.job.job_id).toBe(a.job.job_id);
    await expect(
      submitJob(
        lab.svc,
        "actor-desk-notes",
        deskRequest("journey-key-0002", { brief_id: "brief-desk-battery" }),
      ),
    ).rejects.toMatchObject({ status: 409, code: "IDEMPOTENCY_KEY_REUSED" });
  });

  it("T-J3 fixture-scoped semantic rule: new key, identical selectors and revisions -> existing job", async () => {
    lab = await makeLab();
    const a = await submitJob(lab.svc, "actor-desk-notes", deskRequest("journey-key-0003"));
    const b = await submitJob(lab.svc, "actor-desk-notes", deskRequest("journey-key-0003-new-transport-id"));
    expect(b.status).toBe(200);
    expect(b.deduplicated_by).toBe("semantic_operation");
    expect(b.job.job_id).toBe(a.job.job_id);
    // Different conversation is a different operation, never deduplicated across journeys.
    const c = await submitJob(
      lab.svc,
      "actor-desk-notes",
      deskRequest("journey-key-0003-other", { conversation_id: "dn-conv-2" }),
    );
    expect(c.status).toBe(202);
    expect(c.job.job_id).not.toBe(a.job.job_id);
  });

  it("T-J4 strict request contract rejects client-controlled internals and foreign selectors", async () => {
    lab = await makeLab();
    for (const bad of [
      { ...deskRequest("journey-key-0004"), provider: "compatible-backup" },
      { ...deskRequest("journey-key-0004"), fault_schedule: "crash" },
      { ...deskRequest("journey-key-0004"), retry_policy: { max: 99 } },
      { ...deskRequest("journey-key-0004"), callback_url: "http://example.invalid" },
      { ...deskRequest("journey-key-0004"), creator_id: "study-sparks" },
      { ...deskRequest("journey-key-0004"), state: "DRAFT_READY" },
      { ...deskRequest("journey-key-0004"), video_id: "../../etc" },
    ]) {
      await expect(submitJob(lab.svc, "actor-desk-notes", bad)).rejects.toMatchObject({ status: 400 });
    }
    await expect(
      submitJob(
        lab.svc,
        "actor-desk-notes",
        deskRequest("journey-key-0004", { conversation_id: "ss-conv-1" }),
      ),
    ).rejects.toBeInstanceOf(ServiceError);
    await expect(
      submitJob(lab.svc, "actor-desk-notes", deskRequest("journey-key-0004", { video_id: "vid-ss-001" })),
    ).rejects.toMatchObject({
      code: "UNKNOWN_VIDEO",
    });
    await expect(submitJob(lab.svc, "actor-unknown", deskRequest("journey-key-0004"))).rejects.toMatchObject({
      status: 401,
    });
  });

  it("T-J5 expired synthetic account fails safely without any provider call", async () => {
    lab = await makeLab();
    lab.catalogState.setAccount("desk-notes", "EXPIRED");
    const s = await submitJob(lab.svc, "actor-desk-notes", deskRequest("journey-key-0005"));
    await lab.drain();
    const j = await getJob(lab.svc, "actor-desk-notes", s.job.job_id);
    expect(j.state).toBe("FAILED");
    expect(j.error_code).toBe("ACCOUNT_RECONNECT_REQUIRED");
    expect(j.client_guidance.action).toBe("show_error");
    expect((await ledgerSummary(lab.workerPool)).invocations).toBe(0);
    expect(await listDrafts(lab.svc, "actor-desk-notes", "dn-conv-1")).toHaveLength(0);
  });
});
