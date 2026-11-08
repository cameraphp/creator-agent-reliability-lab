import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { config, connectionFor, LAB_ID } from "../config.js";

const migrationsDir = fileURLToPath(new URL("../../migrations/", import.meta.url));

async function adminClient(database: string): Promise<pg.Client> {
  const c = new pg.Client(connectionFor("admin", database));
  await c.connect();
  return c;
}

/** Fails unless the connected database is a lab database carrying the lab identity marker. */
export async function assertLabIdentity(c: pg.Client | pg.PoolClient): Promise<void> {
  const db = (await c.query<{ db: string }>("SELECT current_database() AS db")).rows[0]?.db;
  if (db !== config.dbName && db !== config.testDbName && db !== config.evalDbName)
    throw new Error(`IDENTITY: unexpected database ${db}`);
  const meta = await c.query<{ value: string }>("SELECT value FROM lab.lab_meta WHERE key = 'lab_id'");
  if (meta.rows[0]?.value !== LAB_ID) throw new Error(`IDENTITY: ${db} is not marked as ${LAB_ID}`);
}

export async function migrateAll(): Promise<string[]> {
  const log: string[] = [];
  const root = await adminClient(config.dbName);
  try {
    for (const name of [config.testDbName, config.evalDbName]) {
      const exists = await root.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
      if (exists.rowCount === 0) {
        await root.query(`CREATE DATABASE ${pg.escapeIdentifier(name)}`);
        log.push(`created database ${name}`);
      }
    }
  } finally {
    await root.end();
  }
  for (const db of [config.dbName, config.testDbName, config.evalDbName])
    log.push(...(await migrateDatabase(db)));
  return log;
}

export async function migrateDatabase(database: string): Promise<string[]> {
  const log: string[] = [];
  const c = await adminClient(database);
  try {
    await c.query(
      `CREATE TABLE IF NOT EXISTS public.lab_schema_migrations (
         version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`,
    );
    const hasLabSchema = (await c.query("SELECT 1 FROM pg_namespace WHERE nspname = 'lab'")).rowCount === 1;
    if (hasLabSchema) await assertLabIdentity(c);

    const applied = new Map(
      (
        await c.query<{ version: string; checksum: string }>(
          "SELECT version, checksum FROM public.lab_schema_migrations",
        )
      ).rows.map((r) => [r.version, r.checksum]),
    );
    const files = readdirSync(migrationsDir)
      .filter((f) => /^\d{3}_.+\.sql$/.test(f))
      .sort();
    for (const file of files) {
      const sql = readFileSync(migrationsDir + file, "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const prior = applied.get(file);
      if (prior) {
        if (prior !== checksum)
          throw new Error(`MIGRATION_DRIFT: ${file} changed after being applied to ${database}`);
        continue;
      }
      await c.query("BEGIN");
      try {
        await c.query(sql);
        await c.query("INSERT INTO public.lab_schema_migrations (version, checksum) VALUES ($1, $2)", [
          file,
          checksum,
        ]);
        await c.query("COMMIT");
        log.push(`${database}: applied ${file}`);
      } catch (err) {
        await c.query("ROLLBACK");
        throw err;
      }
    }
    // Local throwaway passwords + connect rights (idempotent).
    await c.query(`ALTER ROLE lab_app PASSWORD ${pg.escapeLiteral(config.appPassword)}`);
    await c.query(`ALTER ROLE lab_worker PASSWORD ${pg.escapeLiteral(config.workerPassword)}`);
    await c.query(`REVOKE CONNECT ON DATABASE ${pg.escapeIdentifier(database)} FROM PUBLIC`);
    await c.query(`GRANT CONNECT ON DATABASE ${pg.escapeIdentifier(database)} TO lab_app, lab_worker`);
    if (log.length === 0) log.push(`${database}: up to date`);
    return log;
  } finally {
    await c.end();
  }
}

export const LAB_TABLES = [
  "lab.trace_events",
  "lab.drafts",
  "lab.candidates",
  "lab.provider_calls",
  "lab.stage_results",
  "lab.jobs",
  "sim_provider.operations",
  "sim_provider.invocations",
  "lab_baseline.drafts",
  "lab_baseline.jobs",
];

/** Clears lab data ONLY, after verifying the lab identity marker. Never drops anything else. */
export async function resetLabData(database: string): Promise<void> {
  const c = await adminClient(database);
  try {
    await assertLabIdentity(c);
    await c.query(`TRUNCATE ${LAB_TABLES.join(", ")} RESTART IDENTITY`);
  } finally {
    await c.end();
  }
}

export async function dbStatus(database: string) {
  const c = await adminClient(database);
  try {
    await assertLabIdentity(c);
    const migrations = (
      await c.query("SELECT version FROM public.lab_schema_migrations ORDER BY version")
    ).rows.map((r) => r.version as string);
    const roles = (
      await c.query(
        `SELECT rolname, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb
           FROM pg_roles WHERE rolname IN ('lab_app', 'lab_worker') ORDER BY rolname`,
      )
    ).rows;
    const server = (await c.query("SELECT current_setting('server_version') AS v")).rows[0]?.v as string;
    return { database, server, migrations, roles };
  } finally {
    await c.end();
  }
}
