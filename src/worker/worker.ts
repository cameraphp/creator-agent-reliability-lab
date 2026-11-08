import { randomUUID } from "node:crypto";
import { VideoAnalysisSchema, type VideoAnalysis } from "../contracts.js";
import type { Clock } from "../core/clock.js";
import {
  type AssembledContext,
  assembleContext,
  type JobScope,
  ScopedContextCache,
} from "../core/context.js";
import { type FaultInjector, type Boundary, SimulatedCrash } from "../core/faults.js";
import { backoffMs, type Policy } from "../core/policy.js";
import { estimateTokens, type ProfileHealth, routeHardened } from "../core/routing.js";
import { trace } from "../core/trace.js";
import { validateCandidate, type ValidationResult } from "../core/validation.js";
import { type Client, type Pool, withCreatorContext } from "../db/pool.js";
import { type CatalogState, getBrief, getCreator, getProfile, type ProviderTask } from "../fixtures.js";
import type { DialoguePayload, VideoPayload } from "../providers/generator.js";
import type { InvokeResult, SimulatedProvider } from "../providers/simulated.js";
import type { JobRow } from "../service.js";

/**
 * Internal-only switches used by sentinel tests to prove that each gate fails
 * when its fix is removed. Never reachable from the API or normal CLI paths.
 */
export interface Regressions {
  F01_blind_fallback?: boolean;
  F02_unscoped_context_cache?: boolean;
  F03_non_atomic_final_write?: boolean;
}

export interface WorkerDeps {
  pool: Pool;
  provider: SimulatedProvider;
  clock: Clock;
  catalogState: CatalogState;
  policy: Policy;
  faults?: FaultInjector;
  regressions?: Regressions;
  /** Regression-only shared cache (F02 sentinel). */
  sharedUnscopedCache?: Map<string, AssembledContext>;
}

export type RunOutcome =
  | { kind: "idle" }
  | {
      kind: "draft_ready" | "failed" | "retry_wait" | "reconciliation_required";
      jobId: string;
      code?: string;
    }
  | { kind: "lease_lost"; jobId: string }
  | { kind: "error"; jobId: string; code: string };

export class LeaseLostError extends Error {
  constructor() {
    super("LEASE_LOST");
  }
}
class Stop extends Error {
  constructor(public readonly outcome: RunOutcome) {
    super("stop");
  }
}

interface CallRow {
  call_id: string;
  stage: "video_analysis" | "dialogue_draft";
  purpose: "initial" | "repair";
  operation_id: string;
  profile_id: string;
  status: "INTENT" | "RECEIVED" | "NOT_ACCEPTED" | "AMBIGUOUS" | "UNRESOLVED";
  invocations: number;
  response_content: string | null;
  created_at: Date;
}

interface Claimed extends JobRow {
  prev_state: string;
}

export class Worker {
  private cache = new ScopedContextCache();
  constructor(
    public readonly id: string,
    private d: WorkerDeps,
  ) {}

  private now(): Date {
    return this.d.clock.now();
  }

  /** Short claim transaction: SKIP LOCKED + lease + fencing token. Never spans provider work. */
  async claim(): Promise<Claimed | null> {
    const now = this.now();
    const leaseUntil = new Date(now.getTime() + this.d.policy.leaseMs);
    const c = await this.d.pool.connect();
    try {
      await c.query("BEGIN");
      const r = await c.query<Claimed>(
        `WITH candidate AS (
           SELECT job_id, state AS prev_state FROM lab.jobs
            WHERE (state IN ('READY', 'RETRY_WAIT') AND next_run_at <= $1)
               OR (state = 'RUNNING' AND lease_expires_at <= $1)
            ORDER BY next_run_at, created_at, job_id
            LIMIT 1
            FOR UPDATE SKIP LOCKED)
         UPDATE lab.jobs j
            SET state = 'RUNNING', lease_owner = $2, lease_expires_at = $3,
                fencing_token = j.fencing_token + 1, claim_count = j.claim_count + 1, updated_at = $1
           FROM candidate
          WHERE j.job_id = candidate.job_id
        RETURNING j.*, candidate.prev_state`,
        [now, this.id, leaseUntil],
      );
      const job = r.rows[0];
      if (job) {
        await c.query("SELECT set_config('app.creator_id', $1, true)", [job.creator_id]);
        await trace(c, {
          jobId: job.job_id,
          creatorId: job.creator_id,
          at: now,
          event: job.prev_state === "RUNNING" ? "lease.reclaimed_expired" : "job.claimed",
          attrs: {
            worker: this.id,
            fencing_token: Number(job.fencing_token),
            claim_count: job.claim_count,
            prev_state: job.prev_state,
          },
        });
      }
      await c.query("COMMIT");
      return job ?? null;
    } catch (err) {
      await c.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      c.release();
    }
  }

  async runOnce(): Promise<RunOutcome> {
    const job = await this.claim();
    if (!job) return { kind: "idle" };
    try {
      await this.hit("after_claim", job);
      if (job.claim_count > this.d.policy.maxClaimsPerJob)
        return await this.fail(job, "CLAIM_BUDGET_EXHAUSTED", null);
      return await this.execute(job);
    } catch (err) {
      if (err instanceof Stop) return err.outcome;
      if (err instanceof SimulatedCrash) throw err; // process death: no cleanup, lease simply expires
      if (err instanceof LeaseLostError) return { kind: "lease_lost", jobId: job.job_id };
      // Unexpected/DB error: leave the job RUNNING; its lease expires and it is reclaimed later.
      const code = (err as { code?: string }).code ?? (err as Error).message?.slice(0, 60) ?? "UNKNOWN";
      return { kind: "error", jobId: job.job_id, code };
    }
  }

  private async hit(at: Boundary, job: JobRow, stage?: string): Promise<void> {
    await this.d.faults?.hit(at, { worker: this.id, jobId: job.job_id, stage });
  }

  /** Every write after the claim re-checks ownership (state RUNNING + same fencing token) under a row lock. */
  private async fenced<T>(job: JobRow, fn: (c: Client) => Promise<T>): Promise<T> {
    return withCreatorContext(this.d.pool, job.creator_id, async (c) => {
      const r = await c.query<{ state: string; fencing_token: string }>(
        "SELECT state, fencing_token FROM lab.jobs WHERE job_id = $1 FOR UPDATE",
        [job.job_id],
      );
      const row = r.rows[0];
      if (!row || row.state !== "RUNNING" || row.fencing_token !== String(job.fencing_token))
        throw new LeaseLostError();
      await c.query("UPDATE lab.jobs SET lease_expires_at = $2, updated_at = $3 WHERE job_id = $1", [
        job.job_id,
        new Date(this.now().getTime() + this.d.policy.leaseMs),
        this.now(),
      ]);
      return fn(c);
    });
  }

  private ev(
    c: Client,
    job: JobRow,
    stage: string | null,
    event: string,
    attrs: Record<string, unknown> = {},
  ) {
    return trace(c, {
      jobId: job.job_id,
      creatorId: job.creator_id,
      at: this.now(),
      stage,
      event,
      attrs: { worker: this.id, ...attrs },
    });
  }

  private async execute(job: JobRow): Promise<RunOutcome> {
    const stages = await withCreatorContext(this.d.pool, job.creator_id, async (c) => {
      const r = await c.query<{ stage: string; result: unknown }>(
        "SELECT stage, result FROM lab.stage_results WHERE job_id = $1",
        [job.job_id],
      );
      return new Map(r.rows.map((x) => [x.stage, x.result]));
    });
    const scope: JobScope = {
      job_id: job.job_id,
      creator_id: job.creator_id,
      conversation_id: job.conversation_id,
      product_id: job.request.product_id,
      brief_id: job.request.brief_id,
      pinned: job.pinned,
    };

    // 1. Synthetic account connection state (no real login).
    if (!stages.has("account_check")) {
      if (this.d.catalogState.account(job.creator_id) !== "CONNECTED")
        return this.fail(job, "ACCOUNT_RECONNECT_REQUIRED", "account_check");
      await this.saveStage(job, "account_check", {
        account_ref: getCreator(job.creator_id)?.account.account_ref,
        state: "CONNECTED",
      });
    }

    // 2. Video metadata analysis (mock boundary over precomputed fixture metadata).
    let video = stages.get("video_analysis") as VideoAnalysis | undefined;
    if (!video) {
      const payload: VideoPayload = { video_id: job.request.video_id };
      const content = await this.providerStep(
        job,
        "video_analysis",
        "initial",
        "classify_video",
        payload,
        "standard",
      );
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(content);
      } catch {
        /* handled below */
      }
      const v = VideoAnalysisSchema.safeParse(parsed);
      if (!v.success || v.data.video_id !== job.request.video_id)
        return this.fail(job, "VIDEO_ANALYSIS_INVALID", "video_analysis");
      video = v.data;
      await this.saveStage(job, "video_analysis", video);
    }

    // 3. Grounded context: job-scoped, pinned revisions, approved evidence only.
    await this.hit("before_stage:context_assembly", job, "context_assembly");
    let ctx = stages.get("context_assembly") as AssembledContext | undefined;
    if (!ctx) {
      if (this.d.regressions?.F02_unscoped_context_cache) {
        ctx = this.d.sharedUnscopedCache?.get(job.request.product_id);
      }
      if (!ctx) {
        const cached = this.cache.get(scope);
        const res = cached
          ? ({ ok: true, context: cached } as const)
          : assembleContext(scope, this.d.catalogState, video);
        if (!res.ok) return this.fail(job, res.code, "context_assembly", { reason: res.detail });
        ctx = res.context;
        this.cache.set(scope, ctx);
        this.d.sharedUnscopedCache?.set(job.request.product_id, ctx);
      }
      await this.saveStage(job, "context_assembly", ctx);
    }

    // 4. Dialogue draft + at most one targeted repair (complete replacement, validated from scratch).
    await this.hit("before_stage:dialogue_draft", job, "dialogue_draft");
    // Do not spend a paid call on a draft that could only be rejected as stale.
    const preCheck = assembleContext(scope, this.d.catalogState, video);
    if (!preCheck.ok && preCheck.code === "STALE_REVISION")
      return this.fail(job, "STALE_REVISION", "dialogue_draft", { reason: preCheck.detail });
    const brief = getBrief(job.request.brief_id)!;
    const basePayload: DialoguePayload = {
      pinned: ctx.pinned,
      audience: ctx.audience,
      tone: ctx.tone,
      brief: {
        hook_angle: ctx.brief.hook_angle,
        line_count: ctx.brief.line_count,
        cta: ctx.brief.cta,
        word_range: ctx.brief.word_range,
      },
      facts: ctx.facts.map((f) => ({ fact_id: f.fact_id, value: f.value, source_ref: f.source_ref })),
      video: ctx.video,
    };
    const first = await this.providerStep(
      job,
      "dialogue_draft",
      "initial",
      "draft_dialogue",
      basePayload,
      brief.turnaround,
    );
    let verdict = await this.judge(job, ctx, first, "initial");
    if (!verdict.result.ok) {
      if (this.d.policy.maxRepairs < 1) return this.fail(job, "CONTRACT_INVALID", "dialogue_draft");
      const repairPayload: DialoguePayload = {
        ...basePayload,
        repair: { issues: verdict.result.issues.map((i) => i.code) },
      };
      const second = await this.providerStep(
        job,
        "dialogue_draft",
        "repair",
        "draft_dialogue",
        repairPayload,
        brief.turnaround,
      );
      verdict = await this.judge(job, ctx, second, "repair");
      if (!verdict.result.ok) return this.fail(job, "CONTRACT_INVALID_AFTER_REPAIR", "dialogue_draft");
    }

    // 5. Revisions must still be current at save time; otherwise reject explicitly.
    const fresh = assembleContext(scope, this.d.catalogState, video);
    if (!fresh.ok && fresh.code === "STALE_REVISION")
      return this.fail(job, "STALE_REVISION", "dialogue_draft", { reason: fresh.detail });

    await this.hit("before_final_commit", job, "dialogue_draft");
    return this.finalize(job, verdict.callId, verdict.result);
  }

  private async judge(job: JobRow, ctx: AssembledContext, step: string, kind: "initial" | "repair") {
    const call = await this.loadOpenCall(job, "dialogue_draft", kind);
    const result = validateCandidate(step, ctx, this.d.policy.restrictedPhrases);
    if (!result.ok) {
      await this.fenced(job, async (c) => {
        await c.query(
          `INSERT INTO lab.candidates (candidate_id, job_id, creator_id, call_id, kind, verdict, errors, content, created_at)
           VALUES ($1, $2, $3, $4, $5, 'REJECTED', $6, $7, $8) ON CONFLICT (call_id) DO NOTHING`,
          [
            randomUUID(),
            job.job_id,
            job.creator_id,
            call?.call_id ?? null,
            kind,
            JSON.stringify(result.issues),
            JSON.stringify(result.parsed),
            this.now(),
          ],
        );
        await this.ev(c, job, "dialogue_draft", "candidate.rejected", {
          purpose: kind,
          verdict: "REJECTED",
          errors: result.issues.map((i) => i.code),
        });
      });
    }
    return { result, callId: call?.call_id ?? null };
  }

  private async finalize(job: JobRow, callId: string | null, result: ValidationResult): Promise<RunOutcome> {
    if (!result.ok) throw new Error("finalize requires an accepted candidate");
    const candidateId = randomUUID();
    const draftId = randomUUID();
    const insertCandidate = (c: Client) =>
      c.query(
        `INSERT INTO lab.candidates (candidate_id, job_id, creator_id, call_id, kind, verdict, errors, content, created_at)
         VALUES ($1, $2, $3, $4, (SELECT purpose FROM lab.provider_calls WHERE call_id = $4), 'ACCEPTED', '[]', $5, $6)`,
        [candidateId, job.job_id, job.creator_id, callId, JSON.stringify(result.candidate), this.now()],
      );
    const insertDraft = (c: Client) =>
      c.query(
        `INSERT INTO lab.drafts (draft_id, job_id, creator_id, conversation_id, candidate_id, artifact, pinned, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        // Destination is ALWAYS the job's original conversation (also enforced by a composite FK).
        [
          draftId,
          job.job_id,
          job.creator_id,
          job.conversation_id,
          candidateId,
          JSON.stringify(result.artifact),
          JSON.stringify(job.pinned),
          this.now(),
        ],
      );
    const markReady = (c: Client) =>
      c.query(
        `UPDATE lab.jobs SET state = 'DRAFT_READY', accepted_candidate_id = $2, lease_owner = NULL, lease_expires_at = NULL, updated_at = $3
          WHERE job_id = $1`,
        [job.job_id, candidateId, this.now()],
      );

    if (this.d.regressions?.F03_non_atomic_final_write) {
      // REGRESSION (sentinel only): terminal state and artifact in separate transactions.
      await this.fenced(job, async (c) => {
        await insertCandidate(c);
        await markReady(c);
      });
      await this.hit("inside_final_commit", job, "dialogue_draft");
      await withCreatorContext(this.d.pool, job.creator_id, async (c) => insertDraft(c));
      return { kind: "draft_ready", jobId: job.job_id };
    }

    await this.fenced(job, async (c) => {
      await insertCandidate(c);
      await c.query(
        "INSERT INTO lab.stage_results (job_id, creator_id, stage, result, fencing_token, created_at) VALUES ($1, $2, 'dialogue_draft', $3, $4, $5)",
        [
          job.job_id,
          job.creator_id,
          JSON.stringify({ candidate_id: candidateId, draft_id: draftId }),
          job.fencing_token,
          this.now(),
        ],
      );
      await insertDraft(c);
      await markReady(c);
      await this.ev(c, job, "persist", "draft.saved", {
        candidate_id: candidateId,
        draft_id: draftId,
        conversation_id: job.conversation_id,
        state: "DRAFT_READY",
      });
      // Fault point INSIDE the transaction: a crash/db failure here rolls back everything above.
      await this.hit("inside_final_commit", job, "dialogue_draft");
    });
    return { kind: "draft_ready", jobId: job.job_id };
  }

  private async saveStage(job: JobRow, stage: string, result: unknown): Promise<void> {
    await this.fenced(job, async (c) => {
      await c.query(
        `INSERT INTO lab.stage_results (job_id, creator_id, stage, result, fencing_token, created_at)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (job_id, stage) DO NOTHING`,
        [job.job_id, job.creator_id, stage, JSON.stringify(result), job.fencing_token, this.now()],
      );
      await this.ev(c, job, stage, "stage.completed");
    });
  }

  private async fail(
    job: JobRow,
    code: string,
    stage: string | null,
    attrs: Record<string, unknown> = {},
  ): Promise<never> {
    await this.fenced(job, async (c) => {
      await c.query(
        "UPDATE lab.jobs SET state = 'FAILED', error_code = $2, lease_owner = NULL, lease_expires_at = NULL, updated_at = $3 WHERE job_id = $1",
        [job.job_id, code, this.now()],
      );
      await this.ev(c, job, stage, "job.failed", { error_code: code, state: "FAILED", ...attrs });
    });
    throw new Stop({ kind: "failed", jobId: job.job_id, code });
  }

  private async retryLater(job: JobRow, stage: string, reason: string): Promise<never> {
    const wait = backoffMs(this.d.policy, job.claim_count);
    await this.fenced(job, async (c) => {
      await c.query(
        "UPDATE lab.jobs SET state = 'RETRY_WAIT', next_run_at = $2, lease_owner = NULL, lease_expires_at = NULL, updated_at = $3 WHERE job_id = $1",
        [job.job_id, new Date(this.now().getTime() + wait), this.now()],
      );
      await this.ev(c, job, stage, "job.retry_scheduled", { reason, retry_in_ms: wait, state: "RETRY_WAIT" });
    });
    throw new Stop({ kind: "retry_wait", jobId: job.job_id, code: reason });
  }

  private async needsReconciliation(job: JobRow, call: CallRow): Promise<never> {
    await this.fenced(job, async (c) => {
      await c.query(
        "UPDATE lab.provider_calls SET status = 'UNRESOLVED', error_code = 'UPSTREAM_ACCEPTANCE_UNKNOWN', updated_at = $2 WHERE call_id = $1",
        [call.call_id, this.now()],
      );
      await c.query(
        `UPDATE lab.jobs SET state = 'RECONCILIATION_REQUIRED', error_code = 'UPSTREAM_ACCEPTANCE_UNKNOWN',
                lease_owner = NULL, lease_expires_at = NULL, updated_at = $2 WHERE job_id = $1`,
        [job.job_id, this.now()],
      );
      await this.ev(c, job, call.stage, "reconciliation.required", {
        operation_id: call.operation_id,
        profile_id: call.profile_id,
        error_code: "UPSTREAM_ACCEPTANCE_UNKNOWN",
        state: "RECONCILIATION_REQUIRED",
      });
    });
    throw new Stop({
      kind: "reconciliation_required",
      jobId: job.job_id,
      code: "UPSTREAM_ACCEPTANCE_UNKNOWN",
    });
  }

  private async loadCalls(job: JobRow, stage: string, purpose: string): Promise<CallRow[]> {
    return withCreatorContext(
      this.d.pool,
      job.creator_id,
      async (c) =>
        (
          await c.query<CallRow>(
            "SELECT * FROM lab.provider_calls WHERE job_id = $1 AND stage = $2 AND purpose = $3 ORDER BY created_at, operation_id",
            [job.job_id, stage, purpose],
          )
        ).rows,
    );
  }
  private async loadOpenCall(job: JobRow, stage: string, purpose: string): Promise<CallRow | undefined> {
    return (await this.loadCalls(job, stage, purpose)).find((x) => x.status === "RECEIVED");
  }
  private async attemptsUsed(job: JobRow): Promise<number> {
    return withCreatorContext(this.d.pool, job.creator_id, async (c) => {
      const r = await c.query<{ n: string }>(
        "SELECT COALESCE(SUM(invocations), 0) AS n FROM lab.provider_calls WHERE job_id = $1",
        [job.job_id],
      );
      return Number(r.rows[0]?.n ?? 0);
    });
  }

  /**
   * One logical provider operation for (stage, purpose). Reuses a committed
   * receipt; reconciles an open/unknown intent; otherwise records a durable
   * intent BEFORE invoking. Returns raw content or stops the run (retry wait,
   * reconciliation required, or failure).
   */
  private async providerStep(
    job: JobRow,
    stage: CallRow["stage"],
    purpose: CallRow["purpose"],
    task: ProviderTask,
    payload: DialoguePayload | VideoPayload,
    turnaround: "standard" | "fast",
    excludeProfiles: string[] = [],
  ): Promise<string> {
    const calls = await this.loadCalls(job, stage, purpose);
    const received = calls.find((x) => x.status === "RECEIVED");
    if (received?.response_content != null) {
      await this.fenced(job, (c) =>
        this.ev(c, job, stage, "provider.receipt_reused", { operation_id: received.operation_id, purpose }),
      );
      return received.response_content;
    }
    const open = calls.find((x) => x.status === "INTENT" || x.status === "AMBIGUOUS");
    if (open) return this.reconcile(job, open, task, payload);
    if (calls.some((x) => x.status === "UNRESOLVED"))
      return this.needsReconciliation(
        job,
        calls.find((x) => x.status === "UNRESOLVED")!,
      );

    const health: Record<string, ProfileHealth> = {};
    for (const x of calls) {
      if (x.status === "NOT_ACCEPTED" && x.invocations >= this.d.policy.primaryFailuresBeforeBackup)
        health[x.profile_id] = "failed_pre_acceptance";
    }
    for (const id of excludeProfiles) health[id] = "failed_pre_acceptance";
    let decision = routeHardened({ task, contextTokens: estimateTokens(payload), turnaround, health });
    if (
      !decision.selected &&
      decision.reason === "NO_COMPATIBLE_PROFILE" &&
      Object.keys(health).length > 0 &&
      excludeProfiles.length === 0
    ) {
      // Every compatible profile has known pre-acceptance failures: keep using them
      // (safe: nothing was accepted) until the shared attempt budget decides.
      decision = routeHardened({ task, contextTokens: estimateTokens(payload), turnaround, health: {} });
    }
    await this.fenced(job, (c) =>
      this.ev(c, job, stage, "route.decision", {
        purpose,
        selected: decision.selected,
        reason: decision.reason,
        considered: decision.considered.map(
          (x) => `${x.profile_id}:${x.eligible ? "ok" : x.exclusions.join("+")}`,
        ),
      }),
    );
    if (!decision.selected) return this.fail(job, "NO_COMPATIBLE_PROFILE", stage);

    // Retry of a known-not-accepted operation on the same profile reuses its operation id.
    const reusable = calls.find((x) => x.status === "NOT_ACCEPTED" && x.profile_id === decision.selected);
    const call = await this.openIntent(job, stage, purpose, decision.selected, calls.length, reusable);
    return this.invokeAndRecord(job, call, task, payload);
  }

  private async openIntent(
    job: JobRow,
    stage: CallRow["stage"],
    purpose: CallRow["purpose"],
    profileId: string,
    seq: number,
    reusable?: CallRow,
  ): Promise<CallRow> {
    const used = await this.attemptsUsed(job);
    if (used >= this.d.policy.maxCallerAttemptsPerJob)
      return this.fail(job, "BUDGET_EXHAUSTED", stage, { budget_used: used });
    return this.fenced(job, async (c) => {
      let row: CallRow | undefined;
      if (reusable) {
        row = (
          await c.query<CallRow>(
            "UPDATE lab.provider_calls SET status = 'INTENT', invocations = invocations + 1, updated_at = $2 WHERE call_id = $1 RETURNING *",
            [reusable.call_id, this.now()],
          )
        ).rows[0];
      } else {
        const operationId = `${job.job_id}:${stage}:${purpose}:${seq + 1}`;
        row = (
          await c.query<CallRow>(
            `INSERT INTO lab.provider_calls (call_id, job_id, creator_id, stage, purpose, operation_id, profile_id, status, invocations,
                                             fencing_token, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'INTENT', 1, $8, $9, $9) RETURNING *`,
            [
              randomUUID(),
              job.job_id,
              job.creator_id,
              stage,
              purpose,
              operationId,
              profileId,
              job.fencing_token,
              this.now(),
            ],
          )
        ).rows[0];
      }
      await this.ev(c, job, stage, "provider.intent_recorded", {
        operation_id: row!.operation_id,
        profile_id: profileId,
        purpose,
        caller_attempt: used + 1,
        budget_used: used + 1,
        budget_max: this.d.policy.maxCallerAttemptsPerJob,
      });
      return row!;
    });
  }

  private async invokeAndRecord(
    job: JobRow,
    call: CallRow,
    task: ProviderTask,
    payload: DialoguePayload | VideoPayload,
  ): Promise<string> {
    await this.hit("after_intent_before_submit", job, call.stage);
    const res: InvokeResult = await this.d.provider.invoke({
      profileId: call.profile_id,
      task,
      operationId: call.operation_id,
      payload,
      deadlineMs: this.d.policy.providerDeadlineMs,
    });
    if (res.accepted) await this.hit("after_provider_accept_before_receipt", job, call.stage);

    if (res.kind === "response") {
      await this.commitReceipt(
        job,
        call,
        res.content,
        res.replayed ? "idempotent_replay" : "direct",
        res.usage,
      );
      return res.content;
    }
    if (res.kind === "transport_error") {
      await this.fenced(job, async (c) => {
        await c.query(
          "UPDATE lab.provider_calls SET status = 'NOT_ACCEPTED', error_code = $2, updated_at = $3 WHERE call_id = $1",
          [call.call_id, res.code, this.now()],
        );
        await this.ev(c, job, call.stage, "provider.failed_before_acceptance", {
          operation_id: call.operation_id,
          error_code: res.code,
        });
      });
      return this.retryLater(job, call.stage, "PROVIDER_NOT_ACCEPTED");
    }
    // Timeout: the caller cannot know whether the provider accepted. Late results are discarded.
    await this.fenced(job, async (c) => {
      await c.query(
        "UPDATE lab.provider_calls SET status = 'AMBIGUOUS', error_code = 'DEADLINE_EXCEEDED', updated_at = $2 WHERE call_id = $1",
        [call.call_id, this.now()],
      );
      await this.ev(c, job, call.stage, "provider.ambiguous_timeout", {
        operation_id: call.operation_id,
        late_result_discarded: res.lateContent !== undefined,
      });
    });
    if (this.d.regressions?.F01_blind_fallback) {
      // REGRESSION (sentinel only): treat the timeout as "not accepted" and fall back immediately.
      await this.fenced(job, (c) =>
        c.query("UPDATE lab.provider_calls SET status = 'NOT_ACCEPTED' WHERE call_id = $1", [call.call_id]),
      );
      return this.providerStep(job, call.stage, call.purpose, task, payload, "standard", [call.profile_id]);
    }
    return this.reconcile(job, { ...call, status: "AMBIGUOUS" }, task, payload);
  }

  private async commitReceipt(
    job: JobRow,
    call: CallRow,
    content: string,
    source: string,
    usage?: unknown,
  ): Promise<void> {
    await this.fenced(job, async (c) => {
      const r = await c.query(
        `UPDATE lab.provider_calls SET status = 'RECEIVED', response_content = $2, response_source = $3, usage = $4, error_code = NULL, updated_at = $5
          WHERE call_id = $1 AND status IN ('INTENT', 'AMBIGUOUS')`,
        [call.call_id, content, source, usage ? JSON.stringify(usage) : null, this.now()],
      );
      if (r.rowCount !== 1) throw new LeaseLostError();
      await this.ev(c, job, call.stage, "provider.receipt_committed", {
        operation_id: call.operation_id,
        source,
        idempotent_replay: source === "idempotent_replay",
      });
    });
    await this.hit("after_receipt", job, call.stage);
  }

  /** Ambiguous or crash-interrupted operation: resolve via capabilities, never by a blind new paid call. */
  private async reconcile(
    job: JobRow,
    call: CallRow,
    task: ProviderTask,
    payload: DialoguePayload | VideoPayload,
  ): Promise<string> {
    const profile = getProfile(call.profile_id);
    if (profile.supports_status_lookup) {
      const status = await this.d.provider.lookup(call.profile_id, call.operation_id);
      if (status.status === "ACCEPTED") {
        await this.fenced(job, (c) =>
          this.ev(c, job, call.stage, "reconciliation.status_lookup", {
            operation_id: call.operation_id,
            outcome: "ACCEPTED",
          }),
        );
        await this.commitReceipt(job, call, status.content, "status_lookup");
        return status.content;
      }
      await this.fenced(job, async (c) => {
        await c.query(
          "UPDATE lab.provider_calls SET status = 'NOT_ACCEPTED', error_code = 'RECONCILED_NOT_ACCEPTED', updated_at = $2 WHERE call_id = $1",
          [call.call_id, this.now()],
        );
        await this.ev(c, job, call.stage, "reconciliation.status_lookup", {
          operation_id: call.operation_id,
          outcome: "NOT_FOUND",
        });
      });
      return this.retryLater(job, call.stage, "RECONCILED_NOT_ACCEPTED");
    }
    if (profile.supports_idempotency_key) {
      const used = await this.attemptsUsed(job);
      if (used >= this.d.policy.maxCallerAttemptsPerJob)
        return this.fail(job, "BUDGET_EXHAUSTED", call.stage);
      const reopened = await this.fenced(job, async (c) => {
        const r = await c.query<CallRow>(
          "UPDATE lab.provider_calls SET status = 'INTENT', invocations = invocations + 1, updated_at = $2 WHERE call_id = $1 RETURNING *",
          [call.call_id, this.now()],
        );
        await this.ev(c, job, call.stage, "reconciliation.idempotent_retry", {
          operation_id: call.operation_id,
        });
        return r.rows[0]!;
      });
      return this.invokeAndRecord(job, reopened, task, payload);
    }
    return this.needsReconciliation(job, call);
  }
}
