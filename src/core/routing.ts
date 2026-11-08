import { catalog, type ProviderProfile, type ProviderTask } from "../fixtures.js";

/** Fictional task requirements. Not claims about any named commercial model. */
export const TASK_REQUIREMENTS: Record<ProviderTask, { output: "json_schema"; minContextTokens: number }> = {
  classify_video: { output: "json_schema", minContextTokens: 1_000 },
  analyze_profile: { output: "json_schema", minContextTokens: 16_000 },
  draft_dialogue: { output: "json_schema", minContextTokens: 4_000 },
};

const PREFERENCE: Record<ProviderTask, string[]> = {
  classify_video: ["quick-classify", "deep-profile"],
  analyze_profile: ["deep-profile"],
  draft_dialogue: ["structured-dialogue", "compatible-backup"],
};

export type ProfileHealth = "healthy" | "failed_pre_acceptance" | "acceptance_unknown";

export interface RouteRequest {
  task: ProviderTask;
  contextTokens: number;
  turnaround: "standard" | "fast";
  health?: Record<string, ProfileHealth>;
}

export interface RouteDecision {
  selected: string | null;
  reason: string;
  considered: Array<{ profile_id: string; eligible: boolean; exclusions: string[] }>;
}

export function estimateTokens(payload: unknown): number {
  return Math.ceil(JSON.stringify(payload).length / 4);
}

/** Hardened router: compatibility first, never routes around an unresolved upstream acceptance. */
export function routeHardened(
  req: RouteRequest,
  profiles: ProviderProfile[] = catalog.provider_profiles,
): RouteDecision {
  const need = TASK_REQUIREMENTS[req.task];
  const required = Math.max(need.minContextTokens, req.contextTokens);
  const considered = profiles.map((p) => {
    const exclusions: string[] = [];
    if (!p.tasks.includes(req.task)) exclusions.push("TASK_UNSUPPORTED");
    if (!p.output_modes.includes(need.output)) exclusions.push("OUTPUT_MODE_UNSUPPORTED");
    if (p.max_context_tokens < required)
      exclusions.push(`CONTEXT_WINDOW_${p.max_context_tokens}_LT_${required}`);
    const h = req.health?.[p.profile_id] ?? "healthy";
    if (h === "failed_pre_acceptance") exclusions.push("RECENT_PRE_ACCEPTANCE_FAILURES");
    if (h === "acceptance_unknown") exclusions.push("ACCEPTANCE_UNKNOWN");
    return { profile_id: p.profile_id, eligible: exclusions.length === 0, exclusions };
  });
  const unknown = Object.entries(req.health ?? {}).find(
    ([id, h]) =>
      h === "acceptance_unknown" && profiles.find((p) => p.profile_id === id)?.tasks.includes(req.task),
  );
  if (unknown) {
    return { selected: null, reason: `HOLD_FOR_RECONCILIATION:${unknown[0]}`, considered };
  }
  const order = PREFERENCE[req.task];
  const eligible = considered.filter((c) => c.eligible).map((c) => c.profile_id);
  const selected = order.find((id) => eligible.includes(id)) ?? null;
  return {
    selected,
    reason: selected
      ? selected === order[0]
        ? "PRIMARY_COMPATIBLE"
        : "PRIMARY_UNAVAILABLE_BACKUP_COMPATIBLE"
      : "NO_COMPATIBLE_PROFILE",
    considered,
  };
}

/**
 * BASELINE router (CLI evaluation only): fixed default per task, cheapest
 * listed profile for "fast" turnaround, ignores context window and output
 * mode, and routes to the backup whenever the primary had ANY problem.
 */
export function routeBaseline(
  req: RouteRequest,
  profiles: ProviderProfile[] = catalog.provider_profiles,
): RouteDecision {
  const listing = profiles.filter((p) => p.tasks.includes(req.task));
  const order = PREFERENCE[req.task];
  let selected: string | null = order[0] ?? null;
  let reason = "DEFAULT";
  if (req.turnaround === "fast") {
    selected =
      [...listing].sort((a, b) => a.credits_per_1k_tokens - b.credits_per_1k_tokens)[0]?.profile_id ?? null;
    reason = "CHEAPEST_FOR_FAST";
  }
  if (selected && (req.health?.[selected] ?? "healthy") !== "healthy") {
    selected = order[1] ?? selected;
    reason = "FALLBACK_ON_ANY_PROBLEM";
  }
  return { selected, reason, considered: [] };
}
