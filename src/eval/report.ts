import { evaluateRouting, loadDataset, runScenario, type RunOptions, type ScenarioResult } from "./runner.js";
import type { Pool } from "../db/pool.js";

export const EXIT = {
  PASS: 0,
  GATE_FAILED: 1,
  HARNESS_ERROR: 2,
  EXPECTED_BASELINE_FAILURE: 3,
  BASELINE_DID_NOT_REPRODUCE: 4,
} as const;

export interface EvalReport {
  report_version: "1";
  implementation: "baseline" | "hardened";
  dataset_version: string;
  dataset_sha256: string;
  generated_at: string;
  complete: boolean;
  notice: string;
  scenario_count: number;
  results: ScenarioResult[];
  routing: ReturnType<typeof evaluateRouting>;
  metrics: ReturnType<typeof computeMetrics>;
  verdict: { exit_code: number; label: string; categories_with_defects: string[] };
}

const median = (xs: number[]) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

export function computeMetrics(results: ScenarioResult[], routing: ReturnType<typeof evaluateRouting>) {
  const allJobs = results.flatMap((r) => r.jobs);
  const completed = allJobs.filter((j) => j.state === "DRAFT_READY").length;
  const saved = results.flatMap((r) => r.saved_drafts);
  const acceptedDrafts = saved.filter((d) => d.valid).length;
  const eligible = results.filter((r) => r.class !== "unrecoverable");
  const recoverable = results.filter((r) => r.class === "recoverable");
  const unrecoverable = results.filter((r) => r.class === "unrecoverable");
  const f02 = results.filter((r) => r.category === "F02");
  const billable = results.reduce((a, r) => a + r.ledger.billable_units, 0);
  const happyLogical = results
    .filter((r) => r.class === "happy" && r.logical_ms_to_saved_draft !== null)
    .map((r) => r.logical_ms_to_saved_draft!);
  const wall = results.map((r) => r.wall_ms);
  return {
    completed_analyses: {
      numerator: completed,
      denominator_label: "labeled jobs",
      denominator: allJobs.length,
    },
    accepted_analyses: {
      numerator: acceptedDrafts,
      denominator_label: "saved drafts (valid + right context)",
      denominator: saved.length,
    },
    saved_and_reopened_valid: {
      server_persisted: eligible.filter((r) => r.server_persisted_valid).length,
      client_delivered: eligible.filter((r) => r.client_delivered_valid).length,
      denominator_label: "happy + recoverable scenarios",
      denominator: eligible.length,
    },
    recovery_success: {
      numerator: recoverable.filter((r) => r.passed).length,
      denominator: recoverable.length,
    },
    safe_rejection: {
      numerator: unrecoverable.filter((r) => r.passed).length,
      denominator: unrecoverable.length,
      note: "expected FAILED/RECONCILIATION_REQUIRED, no artifact, no excess billable ops",
    },
    route_agreement: { numerator: routing.filter((x) => x.agree).length, denominator: routing.length },
    wrong_context_deliveries: {
      drafts: saved.filter((d) => d.wrong_context.length > 0).length,
      f02_scenarios_affected: f02.filter((r) =>
        r.defects.some((d) => d.code === "WRONG_CONTEXT_DELIVERY" || d.code === "DRAFT_COUNT_MISMATCH"),
      ).length,
      f02_scenarios: f02.length,
    },
    invalid_final_artifacts: {
      drafts: saved.filter((d) => d.invalid_reasons.length > 0).length,
      saved_drafts: saved.length,
    },
    provider: {
      caller_attempts: results.reduce((a, r) => a + r.ledger.caller_attempts, 0),
      invocations: results.reduce((a, r) => a + r.ledger.invocations, 0),
      accepted_operations: results.reduce((a, r) => a + r.ledger.accepted_operations, 0),
      idempotent_replays: results.reduce((a, r) => a + r.ledger.replays, 0),
      excess_billable_operations: results.reduce((a, r) => a + r.excess_billable_operations, 0),
      duplicate_simulated_charge_units:
        Math.round(results.reduce((a, r) => a + r.duplicate_charge_units, 0) * 1000) / 1000,
      simulated_billable_units_total: Math.round(billable * 1000) / 1000,
    },
    time_to_first_saved_draft: {
      logical_simulated_ms: {
        median: median(happyLogical),
        max: happyLogical.length ? Math.max(...happyLogical) : null,
        n: happyLogical.length,
        scope: "happy scenarios, fake clock incl. scripted latencies",
      },
      local_wall_clock_ms_per_scenario: {
        median: median(wall),
        max: Math.max(...wall),
        note: "measured locally; includes DB reset; not a production latency",
      },
    },
    simulated_cost_per_accepted_analysis: {
      value: acceptedDrafts > 0 ? Math.round((billable / acceptedDrafts) * 1000) / 1000 : null,
      unit: "simulated credits (fixture price x synthetic tokens); NOT actual API spend",
      numerator: "all simulated billable units in the run",
      denominator: "accepted saved drafts",
    },
  };
}

export async function runEvaluation(
  impl: "baseline" | "hardened",
  pools: { appPool: Pool; workerPool: Pool; database: string },
  opts: RunOptions = {},
): Promise<EvalReport> {
  const ds = loadDataset();
  const results: ScenarioResult[] = [];
  for (const s of ds.scenarios) results.push(await runScenario(s, impl, pools, opts));
  const routing = evaluateRouting(ds, impl);
  const metrics = computeMetrics(results, routing);
  const harnessErrors = results.filter((r) => r.error);
  const cats: string[] = [
    ...new Set(
      results
        .filter((r) => r.defects.length > 0 && r.category !== "CONTROL")
        .map((r) => r.category as string),
    ),
  ].sort();
  let verdict: EvalReport["verdict"];
  if (harnessErrors.length > 0 && impl === "hardened")
    verdict = { exit_code: EXIT.HARNESS_ERROR, label: "HARNESS_ERROR", categories_with_defects: cats };
  else if (impl === "hardened") {
    const ok = results.every((r) => r.passed) && routing.every((r) => r.agree);
    verdict = {
      exit_code: ok ? EXIT.PASS : EXIT.GATE_FAILED,
      label: ok ? "HARDENED_GATES_PASSED" : "HARDENED_GATES_FAILED",
      categories_with_defects: cats,
    };
  } else {
    const all = ["F01", "F02", "F03"].every((c) => cats.includes(c));
    verdict = all
      ? {
          exit_code: EXIT.EXPECTED_BASELINE_FAILURE,
          label: "EXPECTED_BASELINE_FAILURE",
          categories_with_defects: cats,
        }
      : {
          exit_code: EXIT.BASELINE_DID_NOT_REPRODUCE,
          label: "BASELINE_DID_NOT_REPRODUCE_ALL_CATEGORIES",
          categories_with_defects: cats,
        };
  }
  return {
    report_version: "1",
    implementation: impl,
    dataset_version: ds.dataset_version,
    dataset_sha256: ds.sha256,
    generated_at: new Date().toISOString(),
    complete: results.length === ds.scenarios.length,
    notice: ds.notice,
    scenario_count: results.length,
    results,
    routing,
    metrics,
    verdict,
  };
}

const pct = (n: number, d: number) => (d === 0 ? "n/a" : `${n}/${d} (${Math.round((n / d) * 100)}%)`);

export function renderMarkdown(r: EvalReport): string {
  const m = r.metrics;
  const lines = [
    `# Evaluation report — ${r.implementation.toUpperCase()} (${r.dataset_version})`,
    "",
    `Generated ${r.generated_at} from an actual local run. Dataset sha256 \`${r.dataset_sha256.slice(0, 16)}…\`.`,
    `Verdict: **${r.verdict.label}** (exit code ${r.verdict.exit_code}). Categories with defects: ${r.verdict.categories_with_defects.join(", ") || "none"}.`,
    "",
    `> ${r.notice} Simulated credits are fixture units, not money. Logical time is a fake clock.`,
    "",
    "## Metrics",
    "",
    "| Metric | Value |",
    "|---|---|",
    `| Completed analyses / labeled jobs | ${pct(m.completed_analyses.numerator, m.completed_analyses.denominator)} |`,
    `| Accepted (valid, right-context) / saved drafts | ${pct(m.accepted_analyses.numerator, m.accepted_analyses.denominator)} |`,
    `| Saved valid on server / eligible (happy+recoverable) | ${pct(m.saved_and_reopened_valid.server_persisted, m.saved_and_reopened_valid.denominator)} |`,
    `| Delivered valid to client on reopen / eligible | ${pct(m.saved_and_reopened_valid.client_delivered, m.saved_and_reopened_valid.denominator)} |`,
    `| Recovery success / recoverable scenarios | ${pct(m.recovery_success.numerator, m.recovery_success.denominator)} |`,
    `| Safe rejection / unrecoverable scenarios | ${pct(m.safe_rejection.numerator, m.safe_rejection.denominator)} |`,
    `| Route agreement / annotated routing cases | ${pct(m.route_agreement.numerator, m.route_agreement.denominator)} |`,
    `| Wrong-context drafts saved | ${m.wrong_context_deliveries.drafts} (F02 scenarios affected ${m.wrong_context_deliveries.f02_scenarios_affected}/${m.wrong_context_deliveries.f02_scenarios}) |`,
    `| Invalid final artifacts / saved drafts | ${m.invalid_final_artifacts.drafts}/${m.invalid_final_artifacts.saved_drafts} |`,
    `| Caller attempts / provider invocations / accepted ops / replays | ${m.provider.caller_attempts} / ${m.provider.invocations} / ${m.provider.accepted_operations} / ${m.provider.idempotent_replays} |`,
    `| Excess billable ops / duplicate simulated charge units | ${m.provider.excess_billable_operations} / ${m.provider.duplicate_simulated_charge_units} |`,
    `| Time to first saved draft (logical, median/max, happy) | ${m.time_to_first_saved_draft.logical_simulated_ms.median} / ${m.time_to_first_saved_draft.logical_simulated_ms.max} ms |`,
    `| Local wall-clock per scenario (median/max) | ${m.time_to_first_saved_draft.local_wall_clock_ms_per_scenario.median} / ${m.time_to_first_saved_draft.local_wall_clock_ms_per_scenario.max} ms |`,
    `| Simulated cost per accepted analysis | ${m.simulated_cost_per_accepted_analysis.value ?? "undefined (no accepted analysis)"} simulated credits |`,
    "",
    "## Scenarios",
    "",
    "| Scenario | Cat | Class | Expected | Observed | Billable ops | Defects |",
    "|---|---|---|---|---|---|---|",
    ...r.results.map((x) => {
      const mainJob = x.jobs.find((j) => j.label === "main");
      return `| ${x.id} | ${x.category} | ${x.class} | ${mainJob?.expected ?? "-"} | ${mainJob ? mainJob.state + (mainJob.error_code ? ":" + mainJob.error_code : "") : "-"} | ${x.ledger.accepted_operations} | ${
        x.defects.length === 0 ? "none" : x.defects.map((d) => `${d.code} (${d.detail})`).join("; ")
      } |`;
    }),
    "",
    "## Routing cases",
    "",
    "| Case | Expected | Selected | Reason | Agree |",
    "|---|---|---|---|---|",
    ...r.routing.map(
      (x) =>
        `| ${x.id} | ${x.expected ?? "none"} | ${x.selected ?? "none"} | ${x.reason} | ${x.agree ? "yes" : "NO"} |`,
    ),
    "",
  ];
  return lines.join("\n");
}
