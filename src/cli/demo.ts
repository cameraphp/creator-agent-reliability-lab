import { existsSync, readFileSync } from "node:fs";
import { buildServer } from "../api/server.js";
import { config } from "../config.js";
import { SystemClock } from "../core/clock.js";
import { defaultPolicy } from "../core/policy.js";
import { createPool } from "../db/pool.js";
import { loadDataset, runScenario } from "../eval/runner.js";
import { CatalogState } from "../fixtures.js";
import { SimulatedProvider } from "../providers/simulated.js";
import { Worker } from "../worker/worker.js";

/** Five-minute narrated demo. Synthetic data only; nothing leaves 127.0.0.1. */
const say = (s = "") => console.log(s);
const h = (s: string) => say(`\n=== ${s} ===`);

async function main(): Promise<number> {
  const clock = new SystemClock();
  const catalogState = new CatalogState();
  const policy = defaultPolicy();
  const appPool = createPool("app", config.dbName);
  const workerPool = createPool("worker", config.dbName);
  const app = buildServer({ appPool, clock, catalogState, policy });
  const port = Number(process.env.LAB_DEMO_PORT ?? config.apiPort + 2);
  await app.listen({ host: "127.0.0.1", port });
  const base = `http://127.0.0.1:${port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(base + path, {
      method,
      headers: {
        "x-demo-actor": "actor-desk-notes",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped JSON from the local lab API (demo/smoke client only)
    return { status: r.status, json: (await r.json()) as Record<string, any> };
  };
  try {
    h("1. Complete synthetic journey (real API + worker + local Postgres)");
    const key = `demo-${Date.now()}`;
    const sub = await call("POST", "/v1/analysis-jobs", {
      conversation_id: "dn-conv-1",
      product_id: "tallycube",
      video_id: "vid-dn-001",
      brief_id: "brief-desk-reset",
      idempotency_key: key,
    });
    const jobId = sub.json.job.job_id as string;
    say(
      `POST /v1/analysis-jobs -> ${sub.status} job ${jobId} state ${sub.json.job.state} (committed before 202)`,
    );
    say(`client: "${sub.json.job.client_guidance.message}"  -> closing the app now`);
    const worker = new Worker("demo-worker", {
      pool: workerPool,
      provider: new SimulatedProvider(workerPool, clock),
      clock,
      catalogState,
      policy,
    });
    for (let i = 0; i < 5; i++) if ((await worker.runOnce()).kind === "idle") break;
    const st = await call("GET", `/v1/analysis-jobs/${jobId}`);
    say(`worker finished; poll -> ${st.json.job.state} (${st.json.job.client_guidance.action})`);
    const drafts = await call("GET", "/v1/conversations/dn-conv-1/drafts");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped JSON from the local lab API (demo/smoke client only)
    const d = (drafts.json.drafts as Array<Record<string, any>>).find((x) => x.job_id === jobId)!;
    say(
      `app reopened -> GET drafts for dn-conv-1: draft ${d.draft_id} (${d.artifact.review_state}, ~${d.artifact.estimated_spoken_seconds}s estimated from word count)`,
    );
    for (const l of d.artifact.candidate.lines as Array<{ speaker: string; text: string }>)
      say(`   ${l.speaker.padEnd(7)} ${l.text}`);
    say(
      `   claims: ${(d.artifact.candidate.claims as Array<{ fact_id: string }>).map((c) => c.fact_id).join(", ")}  evidence_completeness=${d.artifact.evidence_completeness}`,
    );

    h("2-3. Same workloads: deliberately defective BASELINE vs HARDENED (eval database)");
    const evalApp = createPool("app", config.evalDbName);
    const evalWorker = createPool("worker", config.evalDbName);
    const ds = loadDataset();
    for (const id of [
      "F01-02-timeout-after-acceptance-idempotent",
      "F02-01-chat-switch-same-creator",
      "F03-03-crash-between-result-and-save",
    ]) {
      const s = ds.scenarios.find((x) => x.id === id)!;
      const pools = { appPool: evalApp, workerPool: evalWorker, database: config.evalDbName };
      const b = await runScenario(s, "baseline", pools);
      const hd = await runScenario(s, "hardened", pools);
      say(`\n${id} — ${s.title}`);
      say(
        `  BASELINE: ${[...new Set(b.defects.map((x) => x.code))].join(", ") || "no defects"}; billable ops ${b.ledger.accepted_operations}`,
      );
      say(
        `  HARDENED: ${[...new Set(hd.defects.map((x) => x.code))].join(", ") || "no defects"}; billable ops ${hd.ledger.accepted_operations}`,
      );
      const ev = (hd.trace_evidence.main ?? []).filter((e) =>
        /reconciliation|reclaimed|receipt_reused|draft.saved/.test(e),
      );
      if (ev.length) say(`  hardened trace: ${ev.join(" -> ")}`);
    }
    await evalApp.end();
    await evalWorker.end();

    h("4. Regression gates and metrics (from the last full evaluation run)");
    const cmp = ".artifacts/eval/comparison-eval-v1.md";
    if (existsSync(cmp)) {
      const text = readFileSync(cmp, "utf8").split("\n");
      const start = text.findIndex((l) => l.startsWith("## By category"));
      say(text.slice(start, start + 8).join("\n"));
      const ms = text.findIndex((l) => l.startsWith("## Metrics"));
      say(text.slice(ms, ms + 16).join("\n"));
    } else
      say(
        "No comparison yet: run npm run evaluate:hardened, npm run evaluate:baseline:expect, npm run compare.",
      );

    h("5. Boundaries");
    say(
      "- Real: TypeScript runtime, local Postgres transactions/RLS/locking, real process crash in smoke tests.",
    );
    say(
      "- Simulated: provider profiles, outcomes and the charge ledger; video analysis is precomputed fixture metadata.",
    );
    say(
      "- Not here: real TikTok/media/LLM calls, Supabase auth, Vercel, hosted telemetry, mobile app, real money or users.",
    );
    say(
      "- Next: validate one real provider's idempotency/status semantics before trusting reconciliation in production.",
    );
    return 0;
  } finally {
    await app.close();
    await appPool.end();
    await workerPool.end();
  }
}

main().then(
  (c) => process.exit(c),
  (e: { code?: string; message?: string }) => {
    console.error(`demo failed: ${e.code ?? ""} ${e.message ?? ""}`);
    if (e.code === "ECONNREFUSED")
      console.error("Start the database first: npm run db:up; npm run db:migrate");
    process.exit(1);
  },
);
