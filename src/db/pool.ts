import pg from "pg";
import { connectionFor, type DbRole } from "../config.js";
import { creatorForActor } from "../fixtures.js";

export type Pool = pg.Pool;
export type Client = pg.PoolClient;

export function createPool(role: DbRole, database: string, max = 5): pg.Pool {
  const pool = new pg.Pool({ ...connectionFor(role, database), max, idleTimeoutMillis: 5_000 });
  // An idle-client error must not crash the process; the next checkout reconnects.
  pool.on("error", () => undefined);
  return pool;
}

/**
 * Runs fn inside one transaction with a TRANSACTION-LOCAL creator context.
 * The creator is derived from a server-side synthetic actor allowlist; no
 * client-supplied creator id is trusted. Context disappears at COMMIT/ROLLBACK,
 * so a pooled connection never carries it into the next checkout.
 */
export async function withActor<T>(
  pool: pg.Pool,
  actorId: string,
  fn: (c: Client) => Promise<T>,
): Promise<T> {
  const creatorId = creatorForActor(actorId);
  if (!creatorId) throw new UnknownActorError();
  return withCreatorContext(pool, creatorId, fn);
}

/** Worker-side variant: creator comes from the claimed job row, never from a client. */
export async function withCreatorContext<T>(
  pool: pg.Pool,
  creatorId: string,
  fn: (c: Client) => Promise<T>,
): Promise<T> {
  return withTx(pool, async (c) => {
    await c.query("SELECT set_config('app.creator_id', $1, true)", [creatorId]);
    return fn(c);
  });
}

export async function withTx<T>(pool: pg.Pool, fn: (c: Client) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      broken = true;
    }
    throw err;
  } finally {
    client.release(broken);
  }
}

export class UnknownActorError extends Error {
  constructor() {
    super("UNKNOWN_ACTOR");
  }
}
