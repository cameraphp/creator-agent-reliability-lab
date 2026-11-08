import { afterEach, describe, expect, it } from "vitest";
import { createPool, withActor, withCreatorContext } from "../src/db/pool.js";
import { listDrafts, submitJob } from "../src/service.js";
import { deskRequest, type Lab, makeLab, sparksRequest, TEST_DB } from "./helpers.js";

let lab: Lab;
afterEach(async () => lab?.close());

async function twoCreatorsWithDrafts() {
  lab = await makeLab();
  const a = await submitJob(lab.svc, "actor-desk-notes", deskRequest("rls-key-desk-01"));
  const b = await submitJob(lab.svc, "actor-study-sparks", sparksRequest("rls-key-sparks-01"));
  await lab.drain();
  return { a: a.job.job_id, b: b.job.job_id };
}

describe("T-R real Postgres RLS with non-privileged roles (R18)", () => {
  it("T-R1 app and worker roles are not superuser, BYPASSRLS or table owners; tables FORCE RLS", async () => {
    lab = await makeLab();
    const roles = await lab.appPool.query(
      "SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname IN ('lab_app', 'lab_worker') ORDER BY rolname",
    );
    expect(roles.rows).toEqual([
      { rolname: "lab_app", rolsuper: false, rolbypassrls: false },
      { rolname: "lab_worker", rolsuper: false, rolbypassrls: false },
    ]);
    const owners = await lab.appPool.query(
      `SELECT c.relname, pg_get_userbyid(c.relowner) AS owner, c.relrowsecurity, c.relforcerowsecurity
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'lab' AND c.relkind = 'r' AND c.relname <> 'lab_meta'`,
    );
    expect(owners.rows.length).toBe(6);
    for (const r of owners.rows) {
      expect(r.owner).not.toMatch(/^lab_(app|worker)$/);
      expect(r.relrowsecurity).toBe(true);
      expect(r.relforcerowsecurity).toBe(true);
    }
    const who = await lab.appPool.query("SELECT current_user AS u");
    expect(who.rows[0].u).toBe("lab_app");
  });

  it("T-R2 cross-creator reads are invisible and cross-creator writes are rejected", async () => {
    const { a, b } = await twoCreatorsWithDrafts();
    const seen = await withActor(lab.appPool, "actor-desk-notes", async (c) => {
      const jobs = await c.query("SELECT job_id, creator_id FROM lab.jobs");
      const drafts = await c.query("SELECT creator_id FROM lab.drafts");
      const traces = await c.query("SELECT DISTINCT creator_id FROM lab.trace_events");
      const foreign = await c.query("SELECT 1 FROM lab.jobs WHERE job_id = $1", [b]);
      return { jobs: jobs.rows, drafts: drafts.rows, traces: traces.rows, foreign: foreign.rowCount };
    });
    expect(seen.jobs).toEqual([{ job_id: a, creator_id: "desk-notes" }]);
    expect(seen.drafts.every((r) => r.creator_id === "desk-notes")).toBe(true);
    expect(seen.traces).toEqual([{ creator_id: "desk-notes" }]);
    expect(seen.foreign).toBe(0);
    expect(await listDrafts(lab.svc, "actor-desk-notes", "dn-conv-1")).toHaveLength(1);
    await expect(listDrafts(lab.svc, "actor-desk-notes", "ss-conv-1")).rejects.toMatchObject({ status: 404 });

    // Write as desk-notes context but claim a study-sparks row: WITH CHECK rejects.
    await expect(
      withActor(lab.appPool, "actor-desk-notes", (c) =>
        c.query(
          `INSERT INTO lab.jobs (job_id, creator_id, conversation_id, idempotency_key, request_fingerprint, semantic_key, request, pinned, state, next_run_at, created_at, updated_at)
           VALUES (gen_random_uuid(), 'study-sparks', 'ss-conv-1', 'forged-key-001', 'x', 'x', '{}', '{}', 'READY', now(), now(), now())`,
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    // App role has no UPDATE/DELETE on jobs at all.
    await expect(
      withActor(lab.appPool, "actor-desk-notes", (c) => c.query("UPDATE lab.jobs SET state = 'FAILED'")),
    ).rejects.toMatchObject({
      code: "42501",
    });
    await expect(
      withActor(lab.appPool, "actor-desk-notes", (c) => c.query("DELETE FROM lab.drafts")),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("T-R3 missing context fails closed for reads and writes", async () => {
    await twoCreatorsWithDrafts();
    const reads = await lab.appPool.query("SELECT count(*)::int AS n FROM lab.jobs");
    expect(reads.rows[0].n).toBe(0);
    const drafts = await lab.appPool.query("SELECT count(*)::int AS n FROM lab.drafts");
    expect(drafts.rows[0].n).toBe(0);
    await expect(
      lab.appPool.query(
        `INSERT INTO lab.jobs (job_id, creator_id, conversation_id, idempotency_key, request_fingerprint, semantic_key, request, pinned, state, next_run_at, created_at, updated_at)
         VALUES (gen_random_uuid(), 'desk-notes', 'dn-conv-1', 'no-context-001', 'x', 'x', '{}', '{}', 'READY', now(), now(), now())`,
      ),
    ).rejects.toMatchObject({ code: "42501" });
    // Worker without context: may see jobs (to claim) but no creator-scoped rows.
    const w = await lab.workerPool.query("SELECT count(*)::int AS n FROM lab.drafts");
    expect(w.rows[0].n).toBe(0);
  });

  it("T-R4 pooled connection reuse never leaks actor context", async () => {
    await twoCreatorsWithDrafts();
    const single = createPool("app", TEST_DB, 1); // forces reuse of ONE physical connection
    try {
      const pid1 = await withActor(
        single,
        "actor-desk-notes",
        async (c) => (await c.query("SELECT pg_backend_pid() AS p")).rows[0].p,
      );
      const leaked = await single.query(
        "SELECT current_setting('app.creator_id', true) AS v, pg_backend_pid() AS p",
      );
      expect(leaked.rows[0].p).toBe(pid1);
      expect(leaked.rows[0].v ?? "").toBe("");
      expect((await single.query("SELECT count(*)::int AS n FROM lab.jobs")).rows[0].n).toBe(0);
      const sparks = await withActor(
        single,
        "actor-study-sparks",
        async (c) => (await c.query("SELECT creator_id FROM lab.jobs")).rows,
      );
      expect(sparks).toEqual([{ creator_id: "study-sparks" }]);
      // A failed transaction also clears context.
      await expect(
        withActor(single, "actor-desk-notes", async (c) => c.query("SELECT 1/0")),
      ).rejects.toBeTruthy();
      expect(
        (await single.query("SELECT current_setting('app.creator_id', true) AS v")).rows[0].v ?? "",
      ).toBe("");
    } finally {
      await single.end();
    }
  });

  it("T-R5 worker role privileges are narrow: no UPDATE of checkpoints, no DELETE, scoped writes", async () => {
    const { a } = await twoCreatorsWithDrafts();
    await expect(
      withCreatorContext(lab.workerPool, "desk-notes", (c) =>
        c.query("UPDATE lab.stage_results SET result = '{}' WHERE job_id = $1", [a]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      withCreatorContext(lab.workerPool, "desk-notes", (c) =>
        c.query("DELETE FROM lab.jobs WHERE job_id = $1", [a]),
      ),
    ).rejects.toMatchObject({
      code: "42501",
    });
    await expect(
      withCreatorContext(lab.workerPool, "desk-notes", (c) =>
        c.query("UPDATE lab.jobs SET creator_id = 'study-sparks' WHERE job_id = $1", [a]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    // Worker in study-sparks context cannot write a desk-notes trace.
    await expect(
      withCreatorContext(lab.workerPool, "study-sparks", (c) =>
        c.query(
          "INSERT INTO lab.trace_events (job_id, creator_id, at, event) VALUES ($1, 'desk-notes', now(), 'forged')",
          [a],
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(lab.workerPool.query("SELECT * FROM lab_baseline.jobs LIMIT 1")).resolves.toBeTruthy(); // eval-only schema, documented
    await expect(lab.appPool.query("SELECT * FROM sim_provider.invocations LIMIT 1")).rejects.toMatchObject({
      code: "42501",
    });
  });
});
