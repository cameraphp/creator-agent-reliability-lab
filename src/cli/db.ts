import { config } from "../config.js";
import { dbStatus, migrateAll, resetLabData } from "../db/migrate.js";

const [cmd, ...rest] = process.argv.slice(2);

async function main(): Promise<number> {
  switch (cmd) {
    case "migrate":
      for (const line of await migrateAll()) console.log(line);
      return 0;
    case "reset": {
      // Explicit target required; resets lab tables only after the identity check.
      const target = rest.includes("--test")
        ? config.testDbName
        : rest.includes("--eval")
          ? config.evalDbName
          : rest.includes("--main")
            ? config.dbName
            : null;
      if (!target) {
        console.error(
          "usage: npm run db:reset -- --main | --test | --eval   (clears lab tables only; schema and volume kept)",
        );
        return 2;
      }
      await resetLabData(target);
      console.log(`reset lab data in ${target} (identity verified)`);
      return 0;
    }
    case "status":
      for (const db of [config.dbName, config.testDbName, config.evalDbName])
        console.log(JSON.stringify(await dbStatus(db), null, 2));
      return 0;
    default:
      console.error("usage: db.ts migrate|reset|status");
      return 2;
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    const e = err as { code?: string; message?: string };
    console.error(`db command failed: ${e.code ?? ""} ${e.message ?? String(err)}`);
    if (e.code === "ECONNREFUSED") console.error("Is the lab database running? Try: npm run db:up");
    process.exit(1);
  },
);
