/**
 * Controlled local fault scheduler. Faults fire at NAMED boundaries inside the
 * worker; they are configured by evaluation scenarios and tests only. The API
 * never accepts fault input.
 */
export type Boundary =
  | "after_claim"
  | "after_intent_before_submit"
  | "after_provider_accept_before_receipt"
  | "after_receipt"
  | "before_stage:context_assembly"
  | "before_stage:dialogue_draft"
  | "before_final_commit"
  | "inside_final_commit";

export type FaultKind = "crash" | "db_fail" | "suspend" | "event";

export interface FaultRule {
  at: Boundary;
  kind: FaultKind;
  stage?: string;
  worker?: string;
  /** For kind=event: name of the scenario event to fire (e.g. publish_revision). */
  event?: string;
  args?: Record<string, string>;
  times?: number;
}

export interface FaultSite {
  worker: string;
  jobId: string;
  stage?: string;
}

/** Simulated process death. Propagates out of the worker without any cleanup. */
export class SimulatedCrash extends Error {
  constructor(public readonly boundary: Boundary) {
    super(`SIMULATED_CRASH at ${boundary}`);
  }
}
export class SimulatedDbFailure extends Error {
  constructor(public readonly boundary: Boundary) {
    super(`SIMULATED_DB_FAILURE at ${boundary}`);
  }
}

export class FaultInjector {
  private remaining: Array<FaultRule & { left: number }>;
  readonly fired: Array<{ at: Boundary; kind: FaultKind; worker: string; jobId: string }> = [];
  private suspended = new Map<string, () => void>();
  private suspendListeners = new Map<string, () => void>();

  constructor(
    rules: FaultRule[] = [],
    private onEvent: (name: string, args: Record<string, string>) => void | Promise<void> = () => undefined,
  ) {
    this.remaining = rules.map((r) => ({ ...r, left: r.times ?? 1 }));
  }

  add(rules: FaultRule[]): void {
    this.remaining.push(...rules.map((r) => ({ ...r, left: r.times ?? 1 })));
  }

  async hit(at: Boundary, site: FaultSite): Promise<void> {
    for (const rule of this.remaining) {
      if (rule.left <= 0 || rule.at !== at) continue;
      if (rule.stage && rule.stage !== site.stage) continue;
      if (rule.worker && rule.worker !== site.worker) continue;
      rule.left -= 1;
      this.fired.push({ at, kind: rule.kind, worker: site.worker, jobId: site.jobId });
      switch (rule.kind) {
        case "crash":
          throw new SimulatedCrash(at);
        case "db_fail":
          throw new SimulatedDbFailure(at);
        case "event":
          await this.onEvent(rule.event ?? "", rule.args ?? {});
          break;
        case "suspend":
          await new Promise<void>((resolve) => {
            this.suspended.set(site.worker, resolve);
            this.suspendListeners.get(site.worker)?.();
          });
          break;
      }
    }
  }

  /** Resolves when the named worker reaches a suspend fault. */
  whenSuspended(worker: string): Promise<void> {
    if (this.suspended.has(worker)) return Promise.resolve();
    return new Promise((resolve) => this.suspendListeners.set(worker, resolve));
  }

  resume(worker: string): void {
    const r = this.suspended.get(worker);
    if (!r) throw new Error(`worker ${worker} is not suspended`);
    this.suspended.delete(worker);
    this.suspendListeners.delete(worker);
    r();
  }
}
