/** Server-owned execution policy. Clients can never set any of these values. */
export interface Policy {
  version: string;
  leaseMs: number;
  providerDeadlineMs: number;
  /** One shared budget of caller attempts across all stages, retries, fallback and repair. */
  maxCallerAttemptsPerJob: number;
  maxClaimsPerJob: number;
  maxRepairs: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  /** Known pre-acceptance failures on the primary before the compatible backup may be used. */
  primaryFailuresBeforeBackup: number;
  /** Phrases that are never admissible, regardless of source strings. */
  restrictedPhrases: string[];
}

export function defaultPolicy(overrides: Partial<Policy> = {}): Policy {
  const leaseFromEnv = Number(process.env.LAB_LEASE_MS ?? "");
  return {
    version: "policy-v1",
    leaseMs: Number.isInteger(leaseFromEnv) && leaseFromEnv > 0 ? leaseFromEnv : 30_000,
    providerDeadlineMs: 20_000,
    maxCallerAttemptsPerJob: 5,
    maxClaimsPerJob: 6,
    maxRepairs: 1,
    backoffBaseMs: 2_000,
    backoffMaxMs: 30_000,
    primaryFailuresBeforeBackup: 2,
    restrictedPhrases: ["guaranteed", "double productivity", "clinically proven", "100%"],
    ...overrides,
  };
}

/** Deterministic exponential backoff (no jitter) so tests can assert exact schedules. */
export function backoffMs(policy: Policy, retryNumber: number): number {
  const n = Math.max(1, retryNumber);
  return Math.min(policy.backoffMaxMs, policy.backoffBaseMs * 2 ** (n - 1));
}
