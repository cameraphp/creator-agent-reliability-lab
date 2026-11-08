import { afterEach, describe, expect, it } from "vitest";
import { withCreatorContext } from "../src/db/pool.js";
import { ledgerSummary } from "../src/providers/simulated.js";
import { getJob, listDrafts, submitJob } from "../src/service.js";
import { deskRequest, type Lab, makeLab } from "./helpers.js";

let lab: Lab;
afterEach(async () => lab?.close());

describe("T-C concurrent claims, leases and fencing on real Postgres (R8, R12)", () => {
  it("T-C1 FOR UPDATE SKIP LOCKED: a second claimer skips a row locked by an open claim transaction", async () => {
    lab = await makeLab();
    await submitJob(lab.svc, "actor-desk-notes", deskRequest("claim-key-0001"));
    const holder = await lab.workerPool.connect();
    try {
      await holder.query("BEGIN");
      const locked = await holder.query(
        "SELECT job_id FROM lab.jobs WHERE state = 'READY' FOR UPDATE SKIP LOCKED LIMIT 1",
      );
      expect(locked.rowCount).toBe(1);
      expect(await lab.worker("w2").claim()).toBeNull(); // skipped, not blocked
      await holder.query("ROLLBACK");
    } finally {
      holder.release();
    }
    expect(await lab.worker("w2").claim()).not.toBeNull();
  });

  it("T-C2 two workers racing for one job: exactly one wins", async () => {
    lab = await makeLab();
    await submitJob(lab.svc, "actor-desk-notes", deskRequest("claim-key-0002"));
    const results = await Promise.all([
      lab.worker("w1").claim(),
      lab.worker("w2").claim(),
      lab.worker("w3").claim(),
    ]);
    const winners = results.filter(Boolean);
    expect(winners).toHaveLength(1);
    expect(Number(winners[0]!.fencing_token)).toBe(1);
  });

  it("T-C3 only expired leases are reclaimed; the stale owner can no longer advance the job", async () => {
    lab = await makeLab();
    const s = await submitJob(lab.svc, "actor-desk-notes", deskRequest("claim-key-0003"));
    const a = await lab.worker("wA").claim();
    expect(a).not.toBeNull();
    expect(await lab.worker("wB").claim()).toBeNull(); // lease still valid
    lab.clock.advance(lab.policy.leaseMs + 1);
    const b = await lab.worker("wB").claim();
    expect(b?.prev_state).toBe("RUNNING");
    expect(Number(b!.fencing_token)).toBe(2);
    // Stale owner A tries a fenced-style conditional update with its old token: 0 rows.
    const stale = await lab.workerPool.query(
      "UPDATE lab.jobs SET state = 'FAILED', error_code = 'X' WHERE job_id = $1 AND fencing_token = $2 AND state = 'RUNNING'",
      [s.job.job_id, a!.fencing_token],
    );
    expect(stale.rowCount).toBe(0);
  });

  it("T-C4 terminal results cannot be overwritten (DB trigger), even by a direct worker-role update", async () => {
    lab = await makeLab();
    const s = await submitJob(lab.svc, "actor-desk-notes", deskRequest("claim-key-0004"));
    await lab.drain();
    expect((await getJob(lab.svc, "actor-desk-notes", s.job.job_id)).state).toBe("DRAFT_READY");
    await expect(
      lab.workerPool.query("UPDATE lab.jobs SET state = 'RUNNING' WHERE job_id = $1", [s.job.job_id]),
    ).rejects.toThrow(/TERMINAL_GUARD/);
    await expect(
      withCreatorContext(lab.workerPool, "desk-notes", (c) =>
        c.query("UPDATE lab.provider_calls SET status = 'AMBIGUOUS' WHERE job_id = $1", [s.job.job_id]),
      ),
    ).rejects.toThrow(/RECEIPT_GUARD/);
  });

  it("T-C5 stale worker suspended mid-call cannot overwrite the result committed by the reclaiming worker", async () => {
    lab = await makeLab({
      faults: [
        {
          at: "after_provider_accept_before_receipt",
          stage: "dialogue_draft",
          kind: "suspend",
          worker: "w1",
        },
      ],
    });
    const s = await submitJob(lab.svc, "actor-desk-notes", deskRequest("claim-key-0005"));
    const p1 = lab.worker("w1").runOnce();
    await lab.faults.whenSuspended("w1");
    lab.clock.advance(lab.policy.leaseMs + 1);
    const out2 = await lab.worker("w2").runOnce();
    expect(out2.kind).toBe("draft_ready");
    lab.faults.resume("w1");
    const out1 = await p1;
    expect(out1.kind).toBe("lease_lost");
    const drafts = await listDrafts(lab.svc, "actor-desk-notes", "dn-conv-1");
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.job_id).toBe(s.job.job_id);
    // w2 reconciled w1's accepted operation by status lookup: still one billable dialogue op.
    const ledger = await ledgerSummary(lab.workerPool);
    expect(ledger.accepted_operations).toBe(2);
  });

  it("T-C6 claim transaction is short: no lab transaction stays open while a provider call is suspended", async () => {
    lab = await makeLab({
      faults: [{ at: "after_intent_before_submit", stage: "dialogue_draft", kind: "suspend", worker: "w1" }],
    });
    await submitJob(lab.svc, "actor-desk-notes", deskRequest("claim-key-0006"));
    const p1 = lab.worker("w1").runOnce();
    await lab.faults.whenSuspended("w1");
    const open = await lab.workerPool.query(
      "SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename = 'lab_worker' AND state LIKE 'idle in transaction%'",
    );
    expect(open.rows[0].n).toBe(0);
    lab.faults.resume("w1");
    expect((await p1).kind).toBe("draft_ready");
  });
});
