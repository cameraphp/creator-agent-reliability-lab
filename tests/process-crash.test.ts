import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { SystemClock } from "../src/core/clock.js";
import { defaultPolicy } from "../src/core/policy.js";
import { resetLabData } from "../src/db/migrate.js";
import { createPool, type Pool, withCreatorContext } from "../src/db/pool.js";
import { CatalogState } from "../src/fixtures.js";
import { ledgerSummary } from "../src/providers/simulated.js";
import { getJob, listDrafts, submitJob } from "../src/service.js";
import { deskRequest, TEST_DB } from "./helpers.js";

/**
 * Real OS-process crash: a child worker process hard-exits (exit 137) at a
 * boundary; Postgres aborts its open transaction with the dropped connection.
 * A second child process reclaims the expired lease. Real wall-clock lease (1.5 s).
 */
const LEASE_MS = 1500;
const tsx = process.platform === "win32" ? "node_modules\\.bin\\tsx.cmd" : "node_modules/.bin/tsx";
function worker(env: Record<string, string>) {
  return spawnSync(tsx, ["src/cli/worker.ts", "--once"], {
    env: { ...process.env, LAB_DB_NAME: TEST_DB, LAB_LEASE_MS: String(LEASE_MS), ...env },
    encoding: "utf8",
    shell: process.platform === "win32",
    timeout: 60_000,
  });
}
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

let pools: Pool[] = [];
afterEach(async () => {
  await Promise.all(pools.map((p) => p.end()));
  pools = [];
});

describe("T-X real process crash and Postgres recovery (R10, R12, R13)", () => {
  for (const boundary of ["inside_final_commit", "after_provider_accept_before_receipt"] as const) {
    it(`T-X ${boundary}: process dies, transaction is aborted, a new process recovers without a second charge`, async () => {
      await resetLabData(TEST_DB);
      const appPool = createPool("app", TEST_DB);
      const workerPool = createPool("worker", TEST_DB);
      pools = [appPool, workerPool];
      const svc = {
        appPool,
        clock: new SystemClock(),
        catalogState: new CatalogState(),
        policy: defaultPolicy(),
      };
      const s = await submitJob(svc, "actor-desk-notes", deskRequest(`proc-crash-${boundary}`.slice(0, 60)));

      const crashed = worker({
        LAB_CRASH_AT: boundary,
        LAB_CRASH_STAGE: "dialogue_draft",
        LAB_WORKER_ID: "proc-w1",
      });
      expect(crashed.status, crashed.stderr).toBe(137);
      expect(crashed.stdout).toContain("simulated_crash");

      const mid = await getJob(svc, "actor-desk-notes", s.job.job_id);
      expect(mid.state).toBe("RUNNING"); // nothing from the aborted transaction is visible
      expect(await listDrafts(svc, "actor-desk-notes", "dn-conv-1")).toHaveLength(0);
      const charged = await ledgerSummary(workerPool);
      expect(charged.accepted_operations).toBe(2);

      await pause(LEASE_MS + 300); // real lease expiry for a real process
      const recovered = worker({ LAB_WORKER_ID: "proc-w2" });
      expect(recovered.status, recovered.stderr).toBe(0);
      expect(recovered.stdout).toContain("draft_ready");

      expect((await getJob(svc, "actor-desk-notes", s.job.job_id)).state).toBe("DRAFT_READY");
      expect(await listDrafts(svc, "actor-desk-notes", "dn-conv-1")).toHaveLength(1);
      expect((await ledgerSummary(workerPool)).accepted_operations).toBe(2);
      const ev = await withCreatorContext(workerPool, "desk-notes", async (c) =>
        (
          await c.query("SELECT event FROM lab.trace_events WHERE job_id = $1 ORDER BY event_id", [
            s.job.job_id,
          ])
        ).rows.map((r) => r.event),
      );
      expect(ev).toContain("lease.reclaimed_expired");
    });
  }
});
