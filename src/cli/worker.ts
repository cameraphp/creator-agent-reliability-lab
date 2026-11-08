import { config } from "../config.js";
import { SystemClock } from "../core/clock.js";
import { type Boundary, FaultInjector, SimulatedCrash } from "../core/faults.js";
import { defaultPolicy } from "../core/policy.js";
import { createPool } from "../db/pool.js";
import { CatalogState } from "../fixtures.js";
import { type ProviderScript, SimulatedProvider } from "../providers/simulated.js";
import { Worker } from "../worker/worker.js";

/**
 * Worker CLI. `--once` processes at most one claim. Two LOCAL TEST-ONLY env
 * switches exist for the process-level smoke test:
 *   LAB_CRASH_AT=<boundary>   hard-exits the process (exit 137) at that boundary
 *   LAB_CRASH_STAGE=<stage>   optional stage filter for LAB_CRASH_AT
 *   LAB_PROVIDER_SCRIPT=<json> scripted synthetic provider outcomes
 */
const once = process.argv.includes("--once");
const workerId = process.env.LAB_WORKER_ID ?? `worker-${process.pid}`;
const pool = createPool("worker", config.dbName);
const clock = new SystemClock();
const script = process.env.LAB_PROVIDER_SCRIPT
  ? (JSON.parse(process.env.LAB_PROVIDER_SCRIPT) as ProviderScript)
  : {};
const crashAt = process.env.LAB_CRASH_AT as Boundary | undefined;
const crashStage = process.env.LAB_CRASH_STAGE;
const faults = new FaultInjector(
  crashAt ? [{ at: crashAt, kind: "crash", ...(crashStage ? { stage: crashStage } : {}) }] : [],
);
const worker = new Worker(workerId, {
  pool,
  provider: new SimulatedProvider(pool, clock, script),
  clock,
  catalogState: new CatalogState(),
  policy: defaultPolicy(),
  faults,
});

let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => (stopping = true));

async function main(): Promise<void> {
  do {
    let outcome;
    try {
      outcome = await worker.runOnce();
    } catch (err) {
      if (err instanceof SimulatedCrash) {
        console.log(JSON.stringify({ worker: workerId, simulated_crash: err.boundary }));
        process.exit(137); // abrupt: no lease release, open transactions die with the connection
      }
      throw err;
    }
    if (outcome.kind !== "idle") console.log(JSON.stringify({ worker: workerId, ...outcome }));
    if (once) break;
    if (outcome.kind === "idle") await new Promise((r) => setTimeout(r, 500));
  } while (!stopping);
  await pool.end();
}

main().catch((err: { code?: string }) => {
  console.error(`worker error: ${err.code ?? "UNKNOWN"}`);
  process.exit(1);
});
