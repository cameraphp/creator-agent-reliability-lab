import { config } from "../src/config.js";
import { FakeClock } from "../src/core/clock.js";
import { FaultInjector, type FaultRule } from "../src/core/faults.js";
import { defaultPolicy, type Policy } from "../src/core/policy.js";
import { resetLabData } from "../src/db/migrate.js";
import { createPool, type Pool } from "../src/db/pool.js";
import { CatalogState } from "../src/fixtures.js";
import { type ProviderScript, SimulatedProvider } from "../src/providers/simulated.js";
import type { ServiceDeps } from "../src/service.js";
import { type Regressions, Worker } from "../src/worker/worker.js";

export const TEST_DB = config.testDbName;

export interface Lab {
  appPool: Pool;
  workerPool: Pool;
  clock: FakeClock;
  catalogState: CatalogState;
  policy: Policy;
  provider: SimulatedProvider;
  faults: FaultInjector;
  svc: ServiceDeps;
  worker(id: string, regressions?: Regressions): Worker;
  drain(id?: string, max?: number): Promise<string[]>;
  close(): Promise<void>;
}

export async function makeLab(
  opts: { script?: ProviderScript; faults?: FaultRule[]; policy?: Partial<Policy> } = {},
): Promise<Lab> {
  await resetLabData(TEST_DB);
  const appPool = createPool("app", TEST_DB);
  const workerPool = createPool("worker", TEST_DB);
  const clock = new FakeClock();
  const catalogState = new CatalogState();
  const policy = defaultPolicy(opts.policy);
  const provider = new SimulatedProvider(workerPool, clock, opts.script ?? {});
  const faults = new FaultInjector(opts.faults ?? []);
  const svc: ServiceDeps = { appPool, clock, catalogState, policy };
  const worker = (id: string, regressions?: Regressions) =>
    new Worker(id, { pool: workerPool, provider, clock, catalogState, policy, faults, regressions });
  const lab: Lab = {
    appPool,
    workerPool,
    clock,
    catalogState,
    policy,
    provider,
    faults,
    svc,
    worker,
    /** Runs one worker until idle, advancing logical time to due retries. */
    async drain(id = "w1", max = 20) {
      const w = worker(id);
      const kinds: string[] = [];
      for (let i = 0; i < max; i++) {
        const out = await w.runOnce();
        if (out.kind === "idle") {
          const next = await workerPool.query<{ t: Date | null }>(
            "SELECT min(next_run_at) AS t FROM lab.jobs WHERE state IN ('READY', 'RETRY_WAIT')",
          );
          const t = next.rows[0]?.t;
          if (!t) break;
          clock.set(new Date(t));
          continue;
        }
        kinds.push(out.kind);
      }
      return kinds;
    },
    async close() {
      await lab.appPool.end();
      await lab.workerPool.end();
    },
  };
  return lab;
}

export const deskRequest = (key: string, over: Record<string, string> = {}) => ({
  conversation_id: "dn-conv-1",
  product_id: "tallycube",
  video_id: "vid-dn-001",
  brief_id: "brief-desk-reset",
  idempotency_key: key,
  ...over,
});
export const sparksRequest = (key: string, over: Record<string, string> = {}) => ({
  conversation_id: "ss-conv-1",
  product_id: "tallycube",
  video_id: "vid-ss-001",
  brief_id: "brief-exam-sprint",
  idempotency_key: key,
  ...over,
});
