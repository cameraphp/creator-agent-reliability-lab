import { mkdirSync, writeFileSync } from "node:fs";
import { config } from "../config.js";
import { createPool } from "../db/pool.js";
import { EXIT, renderMarkdown, runEvaluation } from "../eval/report.js";

/**
 * npm run evaluate:hardened          -> exit 0 only if every gate passes
 * npm run evaluate:baseline          -> EXPECTED BASELINE FAILURE: exit 3
 * npm run evaluate:baseline:expect   -> asserts exit 3 and returns 0 (for CI)
 * Uses only the dedicated creator_lab_eval database; resets lab tables per scenario.
 */
const impl = process.argv[2];
const expectDefects = process.argv.includes("--expect-defects");
if (impl !== "baseline" && impl !== "hardened") {
  console.error("usage: evaluate.ts baseline|hardened [--expect-defects]");
  process.exit(EXIT.HARNESS_ERROR);
}

async function main(): Promise<number> {
  const db = config.evalDbName;
  const appPool = createPool("app", db);
  const workerPool = createPool("worker", db);
  try {
    const report = await runEvaluation(impl as "baseline" | "hardened", {
      appPool,
      workerPool,
      database: db,
    });
    mkdirSync(".artifacts/eval", { recursive: true });
    const base = `.artifacts/eval/${impl}-${report.dataset_version}`;
    writeFileSync(`${base}.json`, JSON.stringify(report, null, 2));
    writeFileSync(`${base}.md`, renderMarkdown(report));
    const failed = report.results.filter((r) => !r.passed).map((r) => r.id);
    console.log(`${impl}: ${report.verdict.label} (exit ${report.verdict.exit_code})`);
    console.log(
      `scenarios ${report.scenario_count}, passed ${report.scenario_count - failed.length}, with defects ${failed.length}`,
    );
    if (failed.length) console.log(`scenarios with defects: ${failed.join(", ")}`);
    console.log(`reports: ${base}.json, ${base}.md`);
    if (expectDefects) {
      const ok = report.verdict.exit_code === EXIT.EXPECTED_BASELINE_FAILURE;
      console.log(
        ok
          ? "asserted EXPECTED BASELINE FAILURE (exit 3) -> 0"
          : `baseline did not fail as expected (exit ${report.verdict.exit_code})`,
      );
      return ok ? EXIT.PASS : EXIT.GATE_FAILED;
    }
    return report.verdict.exit_code;
  } finally {
    await appPool.end();
    await workerPool.end();
  }
}

main().then(
  (c) => process.exit(c),
  (err: { code?: string; message?: string }) => {
    console.error(`evaluation harness error: ${err.code ?? ""} ${err.message ?? ""}`);
    process.exit(EXIT.HARNESS_ERROR);
  },
);
