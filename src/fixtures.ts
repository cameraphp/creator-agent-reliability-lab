import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const FactSchema = z.strictObject({
  fact_id: z.string().min(1),
  key: z.string().min(1),
  status: z.enum(["approved", "unapproved"]),
  value: z.string().min(1),
  source_ref: z.string().min(1),
  supersedes: z.string().optional(),
});
export type Fact = z.infer<typeof FactSchema>;

const ProfileSchema = z.strictObject({
  profile_id: z.string(),
  description: z.string(),
  tasks: z.array(z.enum(["classify_video", "analyze_profile", "draft_dialogue"])),
  output_modes: z.array(z.enum(["json_schema", "text"])),
  max_context_tokens: z.number().int().positive(),
  credits_per_1k_tokens: z.number().positive(),
  supports_idempotency_key: z.boolean(),
  supports_status_lookup: z.boolean(),
});
export type ProviderProfile = z.infer<typeof ProfileSchema>;
export type ProviderTask = ProviderProfile["tasks"][number];

const CatalogSchema = z.strictObject({
  catalog_version: z.literal("v1"),
  notice: z.string(),
  policy_version: z.string(),
  actors: z.array(z.strictObject({ actor_id: z.string(), creator_id: z.string() })),
  creators: z.array(
    z.strictObject({
      creator_id: z.string(),
      display_name: z.string(),
      profile_revision: z.string(),
      audience: z.string(),
      tone: z.string(),
      account: z.strictObject({ account_ref: z.string(), state: z.enum(["CONNECTED", "EXPIRED"]) }),
      conversations: z.array(z.string()),
      videos: z.array(z.string()),
    }),
  ),
  videos: z.array(
    z.strictObject({
      video_id: z.string(),
      creator_id: z.string(),
      analysis: z.strictObject({
        duration_seconds: z.number().int(),
        topic: z.string(),
        hook_moment_seconds: z.number().int(),
        on_screen_product: z.string(),
        pacing: z.enum(["steady", "quick", "energetic"]),
      }),
    }),
  ),
  products: z.array(
    z.strictObject({
      product_id: z.string(),
      name: z.string(),
      description: z.string(),
      initial_revision: z.string(),
      revisions: z.array(z.strictObject({ revision: z.string(), facts: z.array(FactSchema) })),
    }),
  ),
  briefs: z.array(
    z.strictObject({
      brief_id: z.string(),
      brief_revision: z.string(),
      creator_id: z.string(),
      product_id: z.string(),
      hook_angle: z.string(),
      line_count: z.number().int().positive(),
      cta: z.string().min(1),
      word_range: z.tuple([z.number().int(), z.number().int()]),
      required_fact_keys: z.array(z.string()),
      turnaround: z.enum(["standard", "fast"]),
    }),
  ),
  provider_profiles: z.array(ProfileSchema),
});
export type Catalog = z.infer<typeof CatalogSchema>;
export type Creator = Catalog["creators"][number];
export type Brief = Catalog["briefs"][number];
export type Product = Catalog["products"][number];

const catalogPath = fileURLToPath(new URL("../fixtures/v1/catalog.json", import.meta.url));
export const catalog: Catalog = CatalogSchema.parse(JSON.parse(readFileSync(catalogPath, "utf8")));

export function creatorForActor(actorId: string): string | undefined {
  return catalog.actors.find((a) => a.actor_id === actorId)?.creator_id;
}
export function getCreator(id: string): Creator | undefined {
  return catalog.creators.find((c) => c.creator_id === id);
}
export function getBrief(id: string): Brief | undefined {
  return catalog.briefs.find((b) => b.brief_id === id);
}
export function getProduct(id: string): Product | undefined {
  return catalog.products.find((p) => p.product_id === id);
}
export function getVideo(id: string) {
  return catalog.videos.find((v) => v.video_id === id);
}
export function getProfile(id: string): ProviderProfile {
  const p = catalog.provider_profiles.find((x) => x.profile_id === id);
  if (!p) throw new Error(`unknown profile ${id}`);
  return p;
}

/**
 * Mutable "current state" of the synthetic catalog (current product revision,
 * account connection). Evaluation scenarios mutate it in-process to simulate a
 * revision being published or an account expiring mid-job. Fixture files are
 * never modified.
 */
export class CatalogState {
  private productRevision = new Map<string, string>();
  private accountState = new Map<string, "CONNECTED" | "EXPIRED">();

  constructor() {
    for (const p of catalog.products) this.productRevision.set(p.product_id, p.initial_revision);
    for (const c of catalog.creators) this.accountState.set(c.creator_id, c.account.state);
  }
  currentProductRevision(productId: string): string {
    const r = this.productRevision.get(productId);
    if (!r) throw new Error(`unknown product ${productId}`);
    return r;
  }
  publishProductRevision(productId: string, revision: string): void {
    const product = getProduct(productId);
    if (!product?.revisions.some((r) => r.revision === revision)) throw new Error("unknown revision");
    this.productRevision.set(productId, revision);
  }
  account(creatorId: string): "CONNECTED" | "EXPIRED" {
    return this.accountState.get(creatorId) ?? "EXPIRED";
  }
  setAccount(creatorId: string, state: "CONNECTED" | "EXPIRED"): void {
    this.accountState.set(creatorId, state);
  }
}

export function factsAt(productId: string, revision: string): Fact[] {
  const rev = getProduct(productId)?.revisions.find((r) => r.revision === revision);
  if (!rev) throw new Error(`unknown revision ${productId}@${revision}`);
  return rev.facts;
}
