import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { EvalReport } from "../eval/report.js";

/** Compares ONLY complete reports from the same dataset version and content hash. */
const dir = ".artifacts/eval";
const version = process.argv[2] ?? "eval-v1";

function load(impl: string): EvalReport {
  const p = `${dir}/${impl}-${version}.json`;
  if (!existsSync(p)) throw new Error(`missing ${p}; run npm run evaluate:${impl} first`);
  return JSON.parse(readFileSync(p, "utf8")) as EvalReport;
}

function main(): number {
  const b = load("baseline");
  const h = load("hardened");
  const problems: string[] = [];
  if (b.dataset_version !== h.dataset_version) problems.push("dataset_version differs");
  if (b.dataset_sha256 !== h.dataset_sha256)
    problems.push("dataset content hash differs (re-run both evaluations)");
  if (!b.complete || !h.complete) problems.push("a report is incomplete");
  const ids = (r: EvalReport) => r.results.map((x) => x.id).join(",");
  if (ids(b) !== ids(h)) problems.push("scenario sets differ");
  if (b.results.some((r) => r.error) || h.results.some((r) => r.error))
    problems.push("a report contains harness errors");
  if (problems.length > 0) {
    console.error(`INCOMPATIBLE REPORTS: ${problems.join("; ")}`);
    return 2;
  }

  const rows = b.results.map((bx) => {
    const hx = h.results.find((x) => x.id === bx.id)!;
    return {
      id: bx.id,
      category: bx.category,
      baseline_defects: [...new Set(bx.defects.map((d) => d.code))],
      hardened_defects: [...new Set(hx.defects.map((d) => d.code))],
      baseline_billable_ops: bx.ledger.accepted_operations,
      hardened_billable_ops: hx.ledger.accepted_operations,
      hardened_trace: hx.trace_evidence.main ?? [],
    };
  });
  const byCat = (r: EvalReport, c: string) =>
    r.results.filter((x) => x.category === c && x.defects.length > 0).length;
  const cats = ["CONTROL", "F01", "F02", "F03"].map((c) => ({
    category: c,
    scenarios: b.results.filter((x) => x.category === c).length,
    baseline_with_defects: byCat(b, c),
    hardened_with_defects: byCat(h, c),
  }));
  const mb = b.metrics;
  const mh = h.metrics;
  const metric = (label: string, bv: unknown, hv: unknown) => `| ${label} | ${bv} | ${hv} |`;
  const md = [
    `# Baseline vs hardened — ${version}`,
    "",
    `Compatible complete reports (dataset sha256 \`${b.dataset_sha256.slice(0, 16)}…\`). Baseline generated ${b.generated_at}; hardened generated ${h.generated_at}.`,
    `Baseline verdict: **${b.verdict.label}** (exit ${b.verdict.exit_code}). Hardened verdict: **${h.verdict.label}** (exit ${h.verdict.exit_code}).`,
    "",
    "Synthetic fixture scenarios with scripted provider doubles. This shows fixture-defined invariants, not model quality or production readiness.",
    "",
    "## By category",
    "",
    "| Category | Scenarios | Baseline with defects | Hardened with defects |",
    "|---|---|---|---|",
    ...cats.map(
      (c) => `| ${c.category} | ${c.scenarios} | ${c.baseline_with_defects} | ${c.hardened_with_defects} |`,
    ),
    "",
    "## Metrics",
    "",
    "| Metric | Baseline | Hardened |",
    "|---|---|---|",
    metric(
      "Accepted / saved drafts",
      `${mb.accepted_analyses.numerator}/${mb.accepted_analyses.denominator}`,
      `${mh.accepted_analyses.numerator}/${mh.accepted_analyses.denominator}`,
    ),
    metric(
      "Saved valid on server / eligible",
      `${mb.saved_and_reopened_valid.server_persisted}/${mb.saved_and_reopened_valid.denominator}`,
      `${mh.saved_and_reopened_valid.server_persisted}/${mh.saved_and_reopened_valid.denominator}`,
    ),
    metric(
      "Delivered valid on reopen / eligible",
      `${mb.saved_and_reopened_valid.client_delivered}/${mb.saved_and_reopened_valid.denominator}`,
      `${mh.saved_and_reopened_valid.client_delivered}/${mh.saved_and_reopened_valid.denominator}`,
    ),
    metric(
      "Recovery success / recoverable",
      `${mb.recovery_success.numerator}/${mb.recovery_success.denominator}`,
      `${mh.recovery_success.numerator}/${mh.recovery_success.denominator}`,
    ),
    metric(
      "Safe rejection / unrecoverable",
      `${mb.safe_rejection.numerator}/${mb.safe_rejection.denominator}`,
      `${mh.safe_rejection.numerator}/${mh.safe_rejection.denominator}`,
    ),
    metric(
      "Route agreement",
      `${mb.route_agreement.numerator}/${mb.route_agreement.denominator}`,
      `${mh.route_agreement.numerator}/${mh.route_agreement.denominator}`,
    ),
    metric(
      "Wrong-context drafts saved",
      mb.wrong_context_deliveries.drafts,
      mh.wrong_context_deliveries.drafts,
    ),
    metric("Invalid final artifacts", mb.invalid_final_artifacts.drafts, mh.invalid_final_artifacts.drafts),
    metric("Accepted provider operations", mb.provider.accepted_operations, mh.provider.accepted_operations),
    metric(
      "Excess billable operations",
      mb.provider.excess_billable_operations,
      mh.provider.excess_billable_operations,
    ),
    metric(
      "Duplicate simulated charge units",
      mb.provider.duplicate_simulated_charge_units,
      mh.provider.duplicate_simulated_charge_units,
    ),
    metric(
      "Simulated cost per accepted analysis (credits)",
      mb.simulated_cost_per_accepted_analysis.value,
      mh.simulated_cost_per_accepted_analysis.value,
    ),
    "",
    "## Per scenario",
    "",
    "| Scenario | Baseline defects | Hardened defects | Billable ops (B → H) |",
    "|---|---|---|---|",
    ...rows.map(
      (r) =>
        `| ${r.id} | ${r.baseline_defects.join(", ") || "none"} | ${r.hardened_defects.join(", ") || "none"} | ${r.baseline_billable_ops} → ${r.hardened_billable_ops} |`,
    ),
    "",
  ].join("\n");
  writeFileSync(`${dir}/comparison-${version}.md`, md);
  writeFileSync(
    `${dir}/comparison-${version}.json`,
    JSON.stringify({ version, categories: cats, rows }, null, 2),
  );
  const ok = h.verdict.exit_code === 0 && b.verdict.exit_code === 3;
  console.log(md.split("\n").slice(0, 16).join("\n"));
  console.log(`\nwrote ${dir}/comparison-${version}.md`);
  console.log(
    ok
      ? "COMPARISON OK: baseline reproduces F01/F02/F03; hardened passes every gate."
      : "COMPARISON FAILED: verdicts not as required.",
  );
  return ok ? 0 : 1;
}

try {
  process.exit(main());
} catch (e) {
  console.error((e as Error).message);
  process.exit(2);
}
