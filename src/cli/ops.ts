import { config } from "../config.js";
import { SystemClock } from "../core/clock.js";
import { createPool } from "../db/pool.js";
import { inspectJob, listJobs, resolveReconciliation, type UpstreamFinding } from "../ops.js";

/**
 * npm run ops -- list [--state RECONCILIATION_REQUIRED]
 * npm run ops -- inspect --job <id>
 * npm run ops -- resolve --job <id> --upstream not-accepted|accepted-no-result --operator <id>
 * Runs as the narrow worker role against the main lab database (override with LAB_DB_NAME).
 */
const [cmd, ...args] = process.argv.slice(2);
const opt = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};

async function main(): Promise<number> {
  const pool = createPool("worker", config.dbName, 2);
  try {
    switch (cmd) {
      case "list":
        console.table(await listJobs(pool, opt("state")));
        return 0;
      case "inspect": {
        const r = await inspectJob(pool, opt("job") ?? "");
        if (!r) {
          console.error("job not found");
          return 1;
        }
        console.log(JSON.stringify(r, null, 2));
        return 0;
      }
      case "resolve": {
        const finding = opt("upstream") as UpstreamFinding;
        if (finding !== "not-accepted" && finding !== "accepted-no-result") {
          console.error("--upstream must be not-accepted or accepted-no-result (verified out of band)");
          return 2;
        }
        console.log(
          JSON.stringify(
            await resolveReconciliation(
              pool,
              new SystemClock(),
              opt("job") ?? "",
              finding,
              opt("operator") ?? "",
            ),
            null,
            2,
          ),
        );
        return 0;
      }
      default:
        console.error("usage: ops list|inspect|resolve (there is intentionally no bulk retry command)");
        return 2;
    }
  } finally {
    await pool.end();
  }
}

main().then(
  (c) => process.exit(c),
  (e: Error) => {
    console.error(`ops error: ${e.message}`);
    process.exit(1);
  },
);
