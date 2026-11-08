import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, type Pool } from "../src/db/pool.js";
import { loadDataset, runScenario } from "../src/eval/runner.js";
import type { Regressions } from "../src/worker/worker.js";
import { TEST_DB } from "./helpers.js";

/**
 * Sentinels: each F-category gate must FAIL when its fix is removed. These run
 * real dataset scenarios on real Postgres with an internal regression switch.
 * No skip/xfail: if a sentinel stops detecting its regression, this suite fails.
 */
let appPool: Pool;
let workerPool: Pool;
const ds = loadDataset();
const scenario = (id: string) => ds.scenarios.find((s) => s.id === id)!;

beforeAll(() => {
  appPool = createPool("app", TEST_DB);
  workerPool = createPool("worker", TEST_DB);
});
afterAll(async () => {
  await appPool.end();
  await workerPool.end();
});

const cases: Array<{ cat: string; id: string; regression: Regressions; mustDetect: string }> = [
  {
    cat: "F01",
    id: "F01-02-timeout-after-acceptance-idempotent",
    regression: { F01_blind_fallback: true },
    mustDetect: "EXCESS_BILLABLE_OPERATIONS",
  },
  {
    cat: "F02",
    id: "F02-03-warm-cache-other-creator",
    regression: { F02_unscoped_context_cache: true },
    mustDetect: "WRONG_CONTEXT_DELIVERY",
  },
  {
    cat: "F03",
    id: "F03-03-crash-between-result-and-save",
    regression: { F03_non_atomic_final_write: true },
    mustDetect: "READY_WITHOUT_ARTIFACT",
  },
];

describe("T-S sentinels per defect category (R21)", () => {
  for (const c of cases) {
    it(`T-S ${c.cat}: ${c.id} passes hardened and FAILS with the regression reintroduced`, async () => {
      const pools = { appPool, workerPool, database: TEST_DB };
      const ok = await runScenario(scenario(c.id), "hardened", pools);
      expect(ok.defects).toEqual([]);
      const regressed = await runScenario(scenario(c.id), "hardened", pools, { regressions: c.regression });
      expect(regressed.passed).toBe(false);
      expect(regressed.defects.map((d) => d.code)).toContain(c.mustDetect);
    });
  }

  it("T-S baseline still reproduces at least one defect in every category (no silent harness drift)", async () => {
    const pools = { appPool, workerPool, database: TEST_DB };
    for (const id of [
      "F01-02-timeout-after-acceptance-idempotent",
      "F02-01-chat-switch-same-creator",
      "F03-09-crash-after-acceptance-before-receipt",
    ]) {
      const r = await runScenario(scenario(id), "baseline", pools);
      expect(r.defects.length, id).toBeGreaterThan(0);
    }
  });
});
