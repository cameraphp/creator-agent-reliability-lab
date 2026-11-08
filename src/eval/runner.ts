import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import { FakeClock } from "../core/clock.js";
import { FaultInjector, type FaultRule } from "../core/faults.js";
import { defaultPolicy } from "../core/policy.js";
import { routeBaseline, routeHardened, type ProfileHealth } from "../core/routing.js";
import { resetLabData } from "../db/migrate.js";
import type { Pool } from "../db/pool.js";
import { CatalogState, type ProviderTask } from "../fixtures.js";
import { ledgerSummary, type ProviderScript, SimulatedProvider } from "../providers/simulated.js";
import type { Regressions } from "../worker/worker.js";
import { judgeArtifact } from "./judge.js";
import {
  BaselineEvalSystem,
  type EvalEnv,
  type EvalSystem,
  HardenedEvalSystem,
  type ObservedDraft,
} from "./systems.js";

const StepSchema = z.looseObject({ op: z.string() });
const ScenarioSchema = z.strictObject({
  id: z.string(),
  category: z.enum(["CONTROL", "F01", "F02", "F03"]),
  class: z.enum(["happy", "recoverable", "unrecoverable"]),
  title: z.string(),
  script: z.record(z.string(), z.array(z.string())),
  steps: z.array(StepSchema),
  expect: z.strictObject({
    jobs: z.record(z.string(), z.strictObject({ state: z.string(), error_code: z.string().optional() })),
    max_billable_ops: z.number().int().min(0),
    drafts: z.record(z.string(), z.number().int().min(0)),
  }),
});
export type Scenario = z.infer<typeof ScenarioSchema>;
const DatasetSchema = z.strictObject({
  dataset_version: z.string(),
  catalog_version: z.string(),
  notice: z.string(),
  defect_categories: z.record(z.string(), z.string()),
  routing_cases: z.array(
    z.strictObject({
      id: z.string(),
      task: z.enum(["classify_video", "analyze_profile", "draft_dialogue"]),
      context_tokens: z.number(),
      turnaround: z.enum(["standard", "fast"]),
      health: z.record(z.string(), z.enum(["healthy", "failed_pre_acceptance", "acceptance_unknown"])),
      expected: z.string().nullable(),
    }),
  ),
  scenarios: z.array(ScenarioSchema),
});
export type Dataset = z.infer<typeof DatasetSchema>;

const datasetPath = fileURLToPath(new URL("../../evaluations/v1/dataset.json", import.meta.url));
export function loadDataset(): Dataset & { sha256: string } {
  const raw = readFileSync(datasetPath, "utf8");
  return { ...DatasetSchema.parse(JSON.parse(raw)), sha256: createHash("sha256").update(raw).digest("hex") };
}

export interface Defect {
  code: string;
  detail: string;
}

export interface ScenarioResult {
  id: string;
  category: Scenario["category"];
  class: Scenario["class"];
  title: string;
  implementation: "baseline" | "hardened";
  passed: boolean;
  defects: Defect[];
  jobs: Array<{ label: string; job_id: string; state: string; error_code: string | null; expected: string }>;
  drafts_by_conversation: Record<string, number>;
  saved_drafts: Array<{
    job_label: string;
    conversation_id: string;
    valid: boolean;
    invalid_reasons: string[];
    wrong_context: string[];
  }>;
  server_persisted_valid: boolean;
  client_delivered_valid: boolean;
  ledger: {
    caller_attempts: number;
    invocations: number;
    accepted_operations: number;
    replays: number;
    billable_units: number;
  };
  excess_billable_operations: number;
  duplicate_charge_units: number;
  provider_invocations_during_client_steps: number;
  logical_ms_to_saved_draft: number | null;
  wall_ms: number;
  trace_evidence: Record<string, string[]>;
  error?: string;
}

export interface RunOptions {
  regressions?: Regressions;
}

/** Executes ONE scenario with identical inputs for either implementation. */
export async function runScenario(
  s: Scenario,
  impl: "baseline" | "hardened",
  pools: { appPool: Pool; workerPool: Pool; database: string },
  opts: RunOptions = {},
): Promise<ScenarioResult> {
  const t0 = performance.now();
  await resetLabData(pools.database);
  const clock = new FakeClock();
  const catalogState = new CatalogState();
  const revisions: Array<{ at: number; product: string; revision: string }> = [
    { at: 0, product: "tallycube", revision: "tc-r1" },
  ];
  const session = { activeConversation: "dn-conv-1" };
  const onEvent = (name: string, args: Record<string, string>) => {
    if (name === "set_active") session.activeConversation = args.conversation!;
    if (name === "publish_revision") {
      clock.advance(1); // publication takes logical time: strictly orders it after earlier saves
      catalogState.publishProductRevision(args.product!, args.revision!);
      revisions.push({ at: clock.now().getTime(), product: args.product!, revision: args.revision! });
    }
  };
  const faults = new FaultInjector([], onEvent);
  const provider = new SimulatedProvider(pools.workerPool, clock, s.script as ProviderScript);
  const env: EvalEnv = {
    appPool: pools.appPool,
    workerPool: pools.workerPool,
    clock,
    catalogState,
    policy: defaultPolicy(),
    provider,
    faults,
    session,
  };
  const sys: EvalSystem =
    impl === "hardened" ? new HardenedEvalSystem(env, opts.regressions) : new BaselineEvalSystem(env);

  const defects: Defect[] = [];
  const labels = new Map<string, { jobId: string; actor: string; body: Record<string, string> }>();
  const terminalSnapshot = new Map<string, string>();
  let clientStepInvocations = 0;
  const lastReopen = new Map<string, Array<{ job_id: string }>>();
  let error: string | undefined;

  const transient = new Set<string>();
  const snapshot = async (stepNo: number, op: string) => {
    const jobs = await sys.jobs();
    const drafts = await sys.drafts();
    for (const j of jobs) {
      if (j.state !== "DRAFT_READY" && j.state !== "FAILED") continue;
      const mine = drafts.filter((d) => d.job_id === j.job_id);
      if (j.state === "DRAFT_READY" && mine.length === 0 && !transient.has(j.job_id)) {
        transient.add(j.job_id);
        defects.push({
          code: "READY_WITHOUT_ARTIFACT",
          detail: `${labelOf(j.job_id)} observed after step ${stepNo} (${op})`,
        });
      }
      const sig = `${j.state}|${mine.map((d) => `${d.key}@${d.row_version}#${hash(d.artifact)}`).join(",")}`;
      const prior = terminalSnapshot.get(j.job_id);
      // Overwrite = an artifact that already existed for a terminal job was physically rewritten or replaced.
      if (prior && prior.split("|")[1] !== "" && prior !== sig) {
        defects.push({
          code: "TERMINAL_OVERWRITTEN",
          detail: `${labelOf(j.job_id)} artifact rewritten at step ${stepNo} (${op})`,
        });
      }
      terminalSnapshot.set(j.job_id, sig);
    }
  };
  const labelOf = (jobId: string) =>
    [...labels.entries()].find(([, v]) => v.jobId === jobId)?.[0] ?? jobId.slice(0, 8);
  const invocationsNow = async () => (await ledgerSummary(pools.workerPool)).invocations;

  try {
    for (const [stepNo, step] of s.steps.entries()) {
      const st = step as Record<string, unknown> & { op: string };
      const str = (k: string) => String(st[k]);
      switch (st.op) {
        case "submit": {
          const body = {
            conversation_id: str("conversation"),
            product_id: (st.product as string) ?? "tallycube",
            video_id: str("video"),
            brief_id: str("brief"),
            idempotency_key: str("key"),
          };
          const r = await sys.submit(str("actor"), body);
          if (!r.jobId) throw new Error(`submit rejected ${r.status} ${r.code}`);
          labels.set(str("job"), { jobId: r.jobId, actor: str("actor"), body });
          break;
        }
        case "resubmit":
        case "resubmit_new_key": {
          const l = labels.get(str("job"))!;
          const body = st.op === "resubmit" ? l.body : { ...l.body, idempotency_key: str("key") };
          const r = await sys.submit(l.actor, body);
          if (r.jobId !== l.jobId)
            defects.push({ code: "DUPLICATE_JOB", detail: `${st.op} of '${str("job")}' created a new job` });
          break;
        }
        case "work": {
          const rules = ((st.faults as FaultRule[]) ?? []).map((f) => ({ ...f, worker: str("worker") }));
          faults.add(rules);
          await sys.work(str("worker"));
          break;
        }
        case "resume":
          await sys.resume(str("worker"));
          break;
        case "advance":
          clock.advance(Number(st.ms));
          break;
        case "set_active":
          session.activeConversation = str("conversation");
          break;
        case "publish_revision":
          onEvent("publish_revision", { product: str("product"), revision: str("revision") });
          break;
        case "expire_account":
          catalogState.setAccount(str("creator"), "EXPIRED");
          break;
        case "close_app":
          break; // client memory dropped; nothing on the server is owned by the connection
        case "poll":
        case "reopen": {
          const before = await invocationsNow();
          if (st.op === "poll") {
            const l = labels.get(str("job"))!;
            for (let i = 0; i < Number(st.times ?? 1); i++) await sys.poll(l.actor, l.jobId);
          } else {
            lastReopen.set(str("conversation"), await sys.reopen(str("actor"), str("conversation")));
          }
          clientStepInvocations += (await invocationsNow()) - before;
          break;
        }
        default:
          throw new Error(`unknown step ${st.op}`);
      }
      await snapshot(stepNo + 1, st.op);
    }
  } catch (err) {
    error = (err as Error).message;
  }

  // ---------- Observe and judge ----------
  const jobs = await sys.jobs();
  const drafts = await sys.drafts();
  const ledger = await ledgerSummary(pools.workerPool);
  const revisionAt = (d: ObservedDraft) =>
    revisions.filter((r) => r.at <= new Date(d.created_at).getTime()).at(-1)?.revision ?? "tc-r1";

  const jobRows = [...labels.entries()].map(([label, l]) => {
    const j = jobs.find((x) => x.job_id === l.jobId);
    const exp = s.expect.jobs[label];
    return {
      label,
      job_id: l.jobId,
      state: j?.state ?? "MISSING",
      error_code: j?.error_code ?? null,
      expected: exp ? `${exp.state}${exp.error_code ? ":" + exp.error_code : ""}` : "-",
    };
  });
  for (const [label, exp] of Object.entries(s.expect.jobs)) {
    const row = jobRows.find((r) => r.label === label);
    const okState = row?.state === exp.state;
    const okCode = !exp.error_code || impl === "baseline" || row?.error_code === exp.error_code;
    if (!okState || !okCode)
      defects.push({
        code: "OUTCOME_MISMATCH",
        detail: `${label}: expected ${row?.expected}, observed ${row?.state}${row?.error_code ? ":" + row.error_code : ""}`,
      });
  }

  const saved = drafts.map((d) => {
    const job = jobs.find((j) => j.job_id === d.job_id);
    const judgement = job
      ? judgeArtifact(d, job, revisionAt(d))
      : { valid: false, invalid_reasons: ["ORPHAN"], wrong_context: [] };
    return { d, job, judgement };
  });
  for (const x of saved) {
    if (x.judgement.invalid_reasons.length > 0)
      defects.push({
        code: "INVALID_FINAL_ARTIFACT",
        detail: `${labelOf(x.d.job_id)}: ${x.judgement.invalid_reasons.join(",")}`,
      });
    if (x.judgement.wrong_context.length > 0)
      defects.push({
        code: "WRONG_CONTEXT_DELIVERY",
        detail: `${labelOf(x.d.job_id)}: ${x.judgement.wrong_context.join(",")}`,
      });
  }
  for (const j of jobs) {
    const n = drafts.filter((d) => d.job_id === j.job_id).length;
    if (j.state === "DRAFT_READY" && n === 0 && !transient.has(j.job_id))
      defects.push({ code: "READY_WITHOUT_ARTIFACT", detail: labelOf(j.job_id) });
    if (j.state !== "DRAFT_READY" && n > 0)
      defects.push({ code: "ARTIFACT_WITHOUT_READY", detail: labelOf(j.job_id) });
    if (n > 1) defects.push({ code: "MULTIPLE_ARTIFACTS", detail: `${labelOf(j.job_id)}: ${n}` });
  }
  const byConv: Record<string, number> = {};
  for (const d of drafts) byConv[d.conversation_id] = (byConv[d.conversation_id] ?? 0) + 1;
  for (const [conv, n] of Object.entries(s.expect.drafts)) {
    if ((byConv[conv] ?? 0) !== n)
      defects.push({
        code: "DRAFT_COUNT_MISMATCH",
        detail: `${conv}: expected ${n}, observed ${byConv[conv] ?? 0}`,
      });
  }
  if (clientStepInvocations > 0)
    defects.push({
      code: "REGENERATED_ON_CLIENT_STEP",
      detail: `${clientStepInvocations} provider invocations during poll/reopen`,
    });
  const excess = Math.max(0, ledger.accepted_operations - s.expect.max_billable_ops);
  const dupUnits = round3(
    ledger.billable.slice(s.expect.max_billable_ops).reduce((a, b) => a + b.charge_units, 0),
  );
  if (excess > 0)
    defects.push({
      code: "EXCESS_BILLABLE_OPERATIONS",
      detail: `${ledger.accepted_operations} accepted billable ops > annotated max ${s.expect.max_billable_ops}`,
    });
  if (error) defects.push({ code: "HARNESS_ERROR", detail: error });

  // Main job: server persistence vs client delivery are separate evidence stages.
  const main = labels.get("main");
  const mainJob = jobs.find((j) => j.job_id === main?.jobId);
  const mainSaved = saved.filter((x) => x.d.job_id === main?.jobId);
  const serverOk =
    mainSaved.length === 1 && mainSaved[0]!.judgement.valid && mainJob?.state === "DRAFT_READY";
  const delivered = mainJob ? (lastReopen.get(mainJob.conversation_id) ?? []) : [];
  const clientOk = serverOk && delivered.length === 1 && delivered[0]!.job_id === main?.jobId;
  const logicalMs =
    serverOk && mainJob
      ? new Date(mainSaved[0]!.d.created_at).getTime() - new Date(mainJob.created_at).getTime()
      : null;

  const traceEvidence: Record<string, string[]> = {};
  for (const [label, l] of labels) {
    const j = jobs.find((x) => x.job_id === l.jobId);
    if (j) traceEvidence[label] = await sys.trace(l.jobId, j.creator_id);
  }

  return {
    id: s.id,
    category: s.category,
    class: s.class,
    title: s.title,
    implementation: impl,
    passed: defects.length === 0,
    defects,
    jobs: jobRows,
    drafts_by_conversation: byConv,
    saved_drafts: saved.map((x) => ({
      job_label: labelOf(x.d.job_id),
      conversation_id: x.d.conversation_id,
      valid: x.judgement.valid,
      invalid_reasons: x.judgement.invalid_reasons,
      wrong_context: x.judgement.wrong_context,
    })),
    server_persisted_valid: serverOk,
    client_delivered_valid: clientOk,
    ledger: {
      caller_attempts: provider.callerInvocations,
      invocations: ledger.invocations,
      accepted_operations: ledger.accepted_operations,
      replays: ledger.replays,
      billable_units: ledger.billable_units,
    },
    excess_billable_operations: excess,
    duplicate_charge_units: dupUnits,
    provider_invocations_during_client_steps: clientStepInvocations,
    logical_ms_to_saved_draft: logicalMs,
    wall_ms: Math.round(performance.now() - t0),
    trace_evidence: traceEvidence,
    ...(error ? { error } : {}),
  };
}

function hash(v: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(v ?? null))
    .digest("hex")
    .slice(0, 12);
}
function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export function evaluateRouting(ds: Dataset, impl: "baseline" | "hardened") {
  return ds.routing_cases.map((c) => {
    const req = {
      task: c.task as ProviderTask,
      contextTokens: c.context_tokens,
      turnaround: c.turnaround,
      health: c.health as Record<string, ProfileHealth>,
    };
    const d = impl === "hardened" ? routeHardened(req) : routeBaseline(req);
    return {
      id: c.id,
      expected: c.expected,
      selected: d.selected,
      reason: d.reason,
      agree: d.selected === c.expected,
    };
  });
}
