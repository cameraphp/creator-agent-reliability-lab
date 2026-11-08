import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { config } from "../config.js";
import { migrateAll, resetLabData } from "../db/migrate.js";

/**
 * Release smoke over REAL processes: built API process + built worker processes
 * + the lab's Docker Postgres. Uses the throwaway test database (identity-checked
 * reset). Includes a hard process crash after provider acceptance and recovery
 * by a second worker process after a real (short) lease expiry.
 */
const DB = config.testDbName;
const PORT = Number(process.env.LAB_SMOKE_PORT ?? config.apiPort + 1);
const BASE = `http://127.0.0.1:${PORT}`;
const LEASE_MS = 1500;
const env = { ...process.env, LAB_DB_NAME: DB, LAB_API_PORT: String(PORT), LAB_LEASE_MS: String(LEASE_MS) };
const results: Array<{ check: string; ok: boolean; detail?: string }> = [];
const check = (name: string, ok: boolean, detail?: string) => {
  results.push({ check: name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) throw new Error(`smoke check failed: ${name}`);
};
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createServer();
    s.once("error", () => resolve(false));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
  });
}

async function http(method: string, path: string, body?: unknown, actor = "actor-desk-notes") {
  const r = await fetch(BASE + path, {
    method,
    headers: { "x-demo-actor": actor, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped JSON from the local lab API (demo/smoke client only)
  return { status: r.status, json: (await r.json()) as Record<string, any> };
}

function runWorker(extra: Record<string, string>) {
  return spawnSync(process.execPath, ["dist/cli/worker.js", "--once"], {
    env: { ...env, ...extra },
    encoding: "utf8",
    timeout: 60_000,
  });
}

async function main(): Promise<number> {
  if (!(await portFree(PORT))) {
    console.error(`port ${PORT} is in use; set LAB_SMOKE_PORT`);
    return 1;
  }
  await migrateAll();
  await resetLabData(DB);
  const api = spawn(process.execPath, ["dist/cli/api.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
  try {
    let healthy = false;
    for (let i = 0; i < 50 && !healthy; i++) {
      await pause(200);
      healthy = await fetch(`${BASE}/health`).then(
        (r) => r.ok,
        () => false,
      );
    }
    check("API process healthy on 127.0.0.1", healthy);

    const key = `smoke-${Date.now()}`;
    const body = {
      conversation_id: "dn-conv-1",
      product_id: "tallycube",
      video_id: "vid-dn-001",
      brief_id: "brief-desk-reset",
      idempotency_key: key,
    };
    const sub = await http("POST", "/v1/analysis-jobs", body);
    check("POST returns 202 after durable commit", sub.status === 202, sub.json.job?.state);
    const jobId = sub.json.job.job_id as string;
    const replay = await http("POST", "/v1/analysis-jobs", body);
    check(
      "exact resubmission returns the same job",
      replay.status === 200 && replay.json.job.job_id === jobId,
    );
    const changed = await http("POST", "/v1/analysis-jobs", { ...body, brief_id: "brief-desk-battery" });
    check("same key + changed input -> 409", changed.status === 409, changed.json.error?.code);

    const crashed = runWorker({
      LAB_CRASH_AT: "after_provider_accept_before_receipt",
      LAB_CRASH_STAGE: "dialogue_draft",
      LAB_WORKER_ID: "smoke-w1",
    });
    check(
      "worker process hard-crashes after provider acceptance (exit 137)",
      crashed.status === 137,
      `exit ${crashed.status}`,
    );
    const mid = await http("GET", `/v1/analysis-jobs/${jobId}`);
    check(
      "job is still RUNNING (lease held by the dead worker), client told to keep polling",
      mid.json.job.state === "RUNNING" && mid.json.job.client_guidance.action === "poll",
    );

    await pause(LEASE_MS + 400);
    const recovered = runWorker({ LAB_WORKER_ID: "smoke-w2" });
    check(
      "second worker process reclaims the expired lease and completes",
      recovered.status === 0 && recovered.stdout.includes("draft_ready"),
      recovered.stdout.trim().split("\n").at(-1),
    );

    const done = await http("GET", `/v1/analysis-jobs/${jobId}`);
    check(
      "polling shows DRAFT_READY (terminal, show_draft)",
      done.json.job.state === "DRAFT_READY" && done.json.job.client_guidance.action === "show_draft",
    );
    const tr = await http("GET", `/v1/analysis-jobs/${jobId}/trace`);
    const events = (tr.json.events as Array<{ event: string; attrs: Record<string, unknown> }>).map(
      (e) => e.event,
    );
    check(
      "trace shows lease reclaim + status-lookup reconciliation",
      events.includes("lease.reclaimed_expired") && events.includes("reconciliation.status_lookup"),
    );

    // "Close the app and reopen": independent requests, no client state.
    const first = await http("GET", "/v1/conversations/dn-conv-1/drafts");
    const again = await http("GET", "/v1/conversations/dn-conv-1/drafts");
    const mine = (r: typeof first) =>
      (r.json.drafts as Array<{ job_id: string; draft_id: string }>).filter((d) => d.job_id === jobId);
    check(
      "reopen returns exactly one saved draft, identical across reopens",
      mine(first).length === 1 && mine(first)[0]!.draft_id === mine(again)[0]!.draft_id,
    );
    const other = await http("GET", "/v1/conversations/ss-conv-1/drafts", undefined, "actor-study-sparks");
    check("other creator sees none of it (RLS via API)", (other.json.drafts as unknown[]).length === 0);
    const foreign = await http("GET", `/v1/analysis-jobs/${jobId}`, undefined, "actor-study-sparks");
    check("other creator gets 404 for the job", foreign.status === 404);

    const ledger = spawnSync(
      process.execPath,
      [
        "-e",
        "import('./dist/db/pool.js').then(async m=>{const p=m.createPool('worker',process.env.LAB_DB_NAME,1);const r=await p.query(\"SELECT count(*) FILTER (WHERE accepted AND NOT replayed)::int AS a FROM sim_provider.invocations\");console.log(r.rows[0].a);await p.end();})",
      ],
      { env, encoding: "utf8" },
    );
    check(
      "simulated ledger: exactly 2 accepted billable operations (no duplicate after crash)",
      ledger.stdout.trim() === "2",
      `accepted=${ledger.stdout.trim()}`,
    );
    return 0;
  } finally {
    api.kill("SIGTERM");
    await pause(200);
    console.log(
      `\nsmoke: ${results.filter((r) => r.ok).length}/${results.length} checks passed (database ${DB}, port ${PORT})`,
    );
  }
}

main().then(
  (c) => process.exit(c),
  (e: Error) => {
    console.error(e.message);
    process.exit(1);
  },
);
