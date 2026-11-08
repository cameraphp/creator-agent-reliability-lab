import type { Clock } from "../core/clock.js";
import { estimateTokens, TASK_REQUIREMENTS } from "../core/routing.js";
import type { Pool } from "../db/pool.js";
import { getProfile, type ProviderTask } from "../fixtures.js";
import {
  type ContentOutcome,
  type DialoguePayload,
  renderDialogue,
  renderVideoAnalysis,
  type VideoPayload,
} from "./generator.js";

/**
 * Scripted outcomes for the deterministic provider double. Consumed in order
 * per profile for each NEW (non-replayed) invocation; default afterwards: ok.
 */
export type ScriptedOutcome =
  ContentOutcome | "transport_error" | "timeout_before_acceptance" | "timeout_after_acceptance" | "late_ok";
export type ProviderScript = Partial<Record<string, ScriptedOutcome[]>>;

export interface InvokeRequest {
  profileId: string;
  task: ProviderTask;
  operationId: string;
  payload: DialoguePayload | VideoPayload;
  deadlineMs: number;
}

export type InvokeResult =
  | {
      kind: "response";
      accepted: true;
      content: string;
      replayed: boolean;
      usage: { tokens: number; charge_units: number };
    }
  | { kind: "transport_error"; accepted: false; code: "CONNECTION_REFUSED" }
  | { kind: "timeout"; accepted: boolean; lateContent?: string };

const LATENCY_MS: Record<ProviderTask, number> = {
  classify_video: 400,
  analyze_profile: 3_000,
  draft_dialogue: 1_800,
};

export class UnsupportedCapabilityError extends Error {}

/**
 * Persistent simulated provider. Its ledger (schema sim_provider) stands in for
 * the REMOTE side: invocations, acceptances and synthetic charge units survive
 * worker crashes. No network, model, or money is involved.
 */
export class SimulatedProvider {
  private cursor = new Map<string, number>();
  /** Every invoke() call made by any caller, for evidence (caller attempts). */
  callerInvocations = 0;

  constructor(
    private pool: Pool,
    private clock: Clock,
    private script: ProviderScript = {},
  ) {}

  private next(profileId: string): ScriptedOutcome {
    const list = this.script[profileId] ?? [];
    const i = this.cursor.get(profileId) ?? 0;
    this.cursor.set(profileId, i + 1);
    return list[i] ?? "ok";
  }

  async invoke(req: InvokeRequest): Promise<InvokeResult> {
    this.callerInvocations += 1;
    const profile = getProfile(req.profileId);
    const at = this.clock.now();
    if (profile.supports_idempotency_key) {
      const prior = await this.pool.query<{ response_content: string }>(
        "SELECT response_content FROM sim_provider.operations WHERE profile_id = $1 AND operation_key = $2",
        [profile.profile_id, req.operationId],
      );
      const hit = prior.rows[0];
      if (hit) {
        await this.record(
          profile.profile_id,
          req.operationId,
          true,
          true,
          true,
          "idempotent_replay",
          0,
          0,
          at,
        );
        this.clock.elapse(200);
        return {
          kind: "response",
          accepted: true,
          content: hit.response_content,
          replayed: true,
          usage: { tokens: 0, charge_units: 0 },
        };
      }
    }
    let outcome = this.next(profile.profile_id);
    const contentOutcome = !["transport_error", "timeout_before_acceptance"].includes(outcome);
    // A profile whose window cannot hold the task requirement truncates its output.
    if (contentOutcome && profile.max_context_tokens < TASK_REQUIREMENTS[req.task].minContextTokens)
      outcome = "truncated";

    if (outcome === "transport_error") {
      await this.record(
        profile.profile_id,
        req.operationId,
        profile.supports_idempotency_key,
        false,
        false,
        outcome,
        0,
        0,
        at,
      );
      this.clock.elapse(100);
      return { kind: "transport_error", accepted: false, code: "CONNECTION_REFUSED" };
    }
    if (outcome === "timeout_before_acceptance") {
      await this.record(
        profile.profile_id,
        req.operationId,
        profile.supports_idempotency_key,
        false,
        false,
        outcome,
        0,
        0,
        at,
      );
      this.clock.elapse(req.deadlineMs);
      return { kind: "timeout", accepted: false };
    }
    const render: ContentOutcome =
      outcome === "timeout_after_acceptance" || outcome === "late_ok" ? "ok" : (outcome as ContentOutcome);
    const content =
      req.task === "draft_dialogue"
        ? renderDialogue(req.payload as DialoguePayload, render)
        : renderVideoAnalysis(req.payload as VideoPayload, render);
    const tokens = estimateTokens(req.payload) + Math.ceil(content.length / 4);
    const charge = Math.round((tokens / 1000) * profile.credits_per_1k_tokens * 1000) / 1000;
    const invocationId = await this.record(
      profile.profile_id,
      req.operationId,
      profile.supports_idempotency_key,
      true,
      false,
      outcome,
      tokens,
      charge,
      at,
    );
    // Without idempotency/status support the provider cannot correlate retries:
    // its record is keyed by its own invocation id (audit only).
    const key =
      profile.supports_idempotency_key || profile.supports_status_lookup
        ? req.operationId
        : `inv:${invocationId}`;
    await this.pool.query(
      `INSERT INTO sim_provider.operations (profile_id, operation_key, first_invocation_id, response_content)
       VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [profile.profile_id, key, invocationId, content],
    );
    if (outcome === "timeout_after_acceptance") {
      this.clock.elapse(req.deadlineMs);
      return { kind: "timeout", accepted: true };
    }
    if (outcome === "late_ok") {
      this.clock.elapse(req.deadlineMs);
      return { kind: "timeout", accepted: true, lateContent: content };
    }
    this.clock.elapse(LATENCY_MS[req.task]);
    return {
      kind: "response",
      accepted: true,
      content,
      replayed: false,
      usage: { tokens, charge_units: charge },
    };
  }

  /** Synthetic operation-status capability. Free; never charges. */
  async lookup(
    profileId: string,
    operationId: string,
  ): Promise<{ status: "ACCEPTED"; content: string } | { status: "NOT_FOUND" }> {
    const profile = getProfile(profileId);
    if (!profile.supports_status_lookup)
      throw new UnsupportedCapabilityError(`${profileId} has no status lookup`);
    const r = await this.pool.query<{ response_content: string }>(
      "SELECT response_content FROM sim_provider.operations WHERE profile_id = $1 AND operation_key = $2",
      [profileId, operationId],
    );
    const row = r.rows[0];
    return row ? { status: "ACCEPTED", content: row.response_content } : { status: "NOT_FOUND" };
  }

  private async record(
    profileId: string,
    operationId: string,
    honored: boolean,
    accepted: boolean,
    replayed: boolean,
    outcome: string,
    tokens: number,
    charge: number,
    at: Date,
  ): Promise<number> {
    const r = await this.pool.query<{ invocation_id: string }>(
      `INSERT INTO sim_provider.invocations
         (profile_id, operation_id, idempotency_key_honored, accepted, replayed, outcome, tokens, charge_units, logical_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING invocation_id`,
      [profileId, honored ? operationId : null, honored, accepted, replayed, outcome, tokens, charge, at],
    );
    return Number(r.rows[0]?.invocation_id);
  }
}

export interface LedgerSummary {
  invocations: number;
  accepted_operations: number;
  replays: number;
  rejected_before_acceptance: number;
  billable_units: number;
  billable: Array<{ invocation_id: number; profile_id: string; charge_units: number; outcome: string }>;
}

export async function ledgerSummary(pool: Pool): Promise<LedgerSummary> {
  const rows = (
    await pool.query<{
      invocation_id: string;
      profile_id: string;
      accepted: boolean;
      replayed: boolean;
      charge_units: string;
      outcome: string;
    }>(
      "SELECT invocation_id, profile_id, accepted, replayed, charge_units, outcome FROM sim_provider.invocations ORDER BY invocation_id",
    )
  ).rows;
  const billable = rows
    .filter((r) => r.accepted && !r.replayed)
    .map((r) => ({
      invocation_id: Number(r.invocation_id),
      profile_id: r.profile_id,
      charge_units: Number(r.charge_units),
      outcome: r.outcome,
    }));
  return {
    invocations: rows.length,
    accepted_operations: billable.length,
    replays: rows.filter((r) => r.replayed).length,
    rejected_before_acceptance: rows.filter((r) => !r.accepted).length,
    billable_units: Math.round(billable.reduce((s, b) => s + b.charge_units, 0) * 1000) / 1000,
    billable,
  };
}
