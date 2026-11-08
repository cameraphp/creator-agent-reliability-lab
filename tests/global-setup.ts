import { migrateAll } from "../src/db/migrate.js";

/** Applies migrations to the throwaway lab databases. Fails loudly (never silently skips) if Postgres is down. */
export default async function setup(): Promise<void> {
  try {
    await migrateAll();
  } catch (err) {
    const e = err as { code?: string; message?: string };
    throw new Error(
      `BLOCKED: lab Postgres not reachable or migration failed (${e.code ?? ""} ${e.message ?? ""}). Run: npm run db:up && npm run db:migrate`,
      { cause: err },
    );
  }
}
