import { BaselineSystem, type ClientSession } from "../baseline/naive.js";
import type { FakeClock } from "../core/clock.js";
import { type FaultInjector, SimulatedCrash, SimulatedDbFailure } from "../core/faults.js";
import type { Policy } from "../core/policy.js";
import { type Pool, withCreatorContext } from "../db/pool.js";
import { type CatalogState, catalog } from "../fixtures.js";
import type { SimulatedProvider } from "../providers/simulated.js";
import { listDrafts, getJob, ServiceError, submitJob } from "../service.js";
import { type Regressions, Worker } from "../worker/worker.js";

export interface ObservedJob {
  job_id: string;
  creator_id: string;
  conversation_id: string;
  state: string;
  error_code: string | null;
  brief_id: string;
  product_id: string;
  video_id: string;
  created_at: Date;
}
export interface ObservedDraft {
  key: string;
  job_id: string;
  conversation_id: string;
  artifact: { candidate?: unknown } | null;
  created_at: Date;
  updated_at: Date;
  /** Postgres xmin: changes on EVERY physical rewrite, even with identical content. */
  row_version: string;
}
export type WorkOutcome = "idle" | "crashed" | "suspended" | "error";

export interface EvalSystem {
  readonly name: "baseline" | "hardened";
  submit(
    actor: string,
    body: Record<string, string>,
  ): Promise<{ jobId: string | null; status: number; code?: string }>;
  work(worker: string): Promise<WorkOutcome>;
  resume(worker: string): Promise<WorkOutcome>;
  reopen(actor: string, conversation: string): Promise<Array<{ job_id: string }>>;
  poll(actor: string, jobId: string): Promise<string>;
  jobs(): Promise<ObservedJob[]>;
  drafts(): Promise<ObservedDraft[]>;
  trace(jobId: string, creatorId: string): Promise<string[]>;
}

export interface EvalEnv {
  appPool: Pool;
  workerPool: Pool;
  clock: FakeClock;
  catalogState: CatalogState;
  policy: Policy;
  provider: SimulatedProvider;
  faults: FaultInjector;
  session: ClientSession;
}

async function nextDue(pool: Pool, sql: string): Promise<Date | null> {
  const r = await pool.query<{ t: Date | null }>(sql);
  return r.rows[0]?.t ?? null;
}

export class HardenedEvalSystem implements EvalSystem {
  readonly name = "hardened" as const;
  private pending = new Map<string, Promise<WorkOutcome>>();
  constructor(
    private env: EvalEnv,
    private regressions?: Regressions,
    private sharedUnscopedCache = regressions?.F02_unscoped_context_cache ? new Map() : undefined,
  ) {}

  private svc() {
    return {
      appPool: this.env.appPool,
      clock: this.env.clock,
      catalogState: this.env.catalogState,
      policy: this.env.policy,
    };
  }

  async submit(actor: string, body: Record<string, string>) {
    try {
      const r = await submitJob(this.svc(), actor, body);
      return { jobId: r.job.job_id, status: r.status };
    } catch (err) {
      if (err instanceof ServiceError) return { jobId: null, status: err.status, code: err.code };
      throw err;
    }
  }

  private async drain(id: string): Promise<WorkOutcome> {
    const w = new Worker(id, {
      pool: this.env.workerPool,
      provider: this.env.provider,
      clock: this.env.clock,
      catalogState: this.env.catalogState,
      policy: this.env.policy,
      faults: this.env.faults,
      regressions: this.regressions,
      sharedUnscopedCache: this.sharedUnscopedCache,
    });
    let last: WorkOutcome = "idle";
    for (let i = 0; i < 40; i++) {
      let out;
      try {
        out = await w.runOnce();
      } catch (err) {
        if (err instanceof SimulatedCrash) return "crashed";
        throw err;
      }
      if (out.kind === "error") last = "error";
      if (out.kind !== "idle") continue;
      const t = await nextDue(
        this.env.workerPool,
        "SELECT min(next_run_at) AS t FROM lab.jobs WHERE state IN ('READY', 'RETRY_WAIT')",
      );
      if (!t) break;
      this.env.clock.set(new Date(t));
    }
    return last;
  }

  async work(worker: string): Promise<WorkOutcome> {
    const run = this.drain(worker);
    const r = await Promise.race([
      run,
      this.env.faults.whenSuspended(worker).then(() => "suspended" as const),
    ]);
    if (r === "suspended") this.pending.set(worker, run);
    return r;
  }
  async resume(worker: string): Promise<WorkOutcome> {
    this.env.faults.resume(worker);
    const r = await this.pending.get(worker)!;
    this.pending.delete(worker);
    return r;
  }
  async reopen(actor: string, conversation: string) {
    try {
      return await listDrafts(this.svc(), actor, conversation);
    } catch (err) {
      if (err instanceof ServiceError) return [];
      throw err;
    }
  }
  async poll(actor: string, jobId: string) {
    return (await getJob(this.svc(), actor, jobId)).state;
  }
  async jobs(): Promise<ObservedJob[]> {
    const r = await this.env.workerPool.query("SELECT * FROM lab.jobs ORDER BY created_at");
    return r.rows.map((j) => ({ ...j, ...j.request }));
  }
  async drafts(): Promise<ObservedDraft[]> {
    const out: ObservedDraft[] = [];
    for (const c of catalog.creators) {
      const rows = await withCreatorContext(
        this.env.workerPool,
        c.creator_id,
        async (cl) =>
          (await cl.query("SELECT *, xmin::text AS row_version FROM lab.drafts ORDER BY created_at")).rows,
      );
      for (const d of rows)
        out.push({
          key: d.draft_id,
          job_id: d.job_id,
          conversation_id: d.conversation_id,
          artifact: d.artifact,
          created_at: d.created_at,
          updated_at: d.created_at,
          row_version: d.row_version,
        });
    }
    return out;
  }
  async trace(jobId: string, creatorId: string): Promise<string[]> {
    return withCreatorContext(this.env.workerPool, creatorId, async (c) =>
      (
        await c.query("SELECT event, stage FROM lab.trace_events WHERE job_id = $1 ORDER BY event_id", [
          jobId,
        ])
      ).rows.map((e) => `${e.event}${e.stage ? "@" + e.stage : ""}`),
    );
  }
}

export class BaselineEvalSystem implements EvalSystem {
  readonly name = "baseline" as const;
  private sys: BaselineSystem;
  private pending = new Map<string, Promise<WorkOutcome>>();
  constructor(private env: EvalEnv) {
    this.sys = new BaselineSystem(
      env.workerPool,
      env.provider,
      env.clock,
      env.catalogState,
      env.session,
      env.faults,
    );
  }
  async submit(actor: string, body: Record<string, string>) {
    const r = await this.sys.submit(actor, body);
    return { jobId: r.jobId, status: 202 };
  }
  private async drain(id: string): Promise<WorkOutcome> {
    let last: WorkOutcome = "idle";
    for (let i = 0; i < 40; i++) {
      try {
        if ((await this.sys.runOnce(id)) === "idle") break;
      } catch (err) {
        if (err instanceof SimulatedCrash) return "crashed";
        if (err instanceof SimulatedDbFailure) {
          last = "error";
          continue;
        }
        throw err;
      }
    }
    return last;
  }
  async work(worker: string): Promise<WorkOutcome> {
    const run = this.drain(worker);
    const r = await Promise.race([
      run,
      this.env.faults.whenSuspended(worker).then(() => "suspended" as const),
    ]);
    if (r === "suspended") this.pending.set(worker, run);
    return r;
  }
  async resume(worker: string): Promise<WorkOutcome> {
    this.env.faults.resume(worker);
    const r = await this.pending.get(worker)!;
    this.pending.delete(worker);
    return r;
  }
  async reopen(_actor: string, conversation: string) {
    return (await this.sys.reopen("reopen-client", conversation)) as Array<{ job_id: string }>;
  }
  async poll(_actor: string, jobId: string) {
    const r = await this.env.workerPool.query<{ state: string }>(
      "SELECT state FROM lab_baseline.jobs WHERE job_id = $1",
      [jobId],
    );
    return r.rows[0]?.state ?? "UNKNOWN";
  }
  async jobs(): Promise<ObservedJob[]> {
    const r = await this.env.workerPool.query("SELECT * FROM lab_baseline.jobs ORDER BY created_at");
    return r.rows.map((j) => ({ ...j, error_code: null, ...j.request }));
  }
  async drafts(): Promise<ObservedDraft[]> {
    const r = await this.env.workerPool.query(
      "SELECT *, xmin::text AS row_version FROM lab_baseline.drafts ORDER BY draft_row",
    );
    return r.rows.map((d) => ({
      key: String(d.draft_row),
      job_id: d.job_id,
      conversation_id: d.conversation_id,
      artifact: d.artifact,
      created_at: d.created_at,
      updated_at: d.updated_at,
      row_version: d.row_version,
    }));
  }
  async trace(): Promise<string[]> {
    return []; // the baseline has no tracing (itself an audit finding)
  }
}
