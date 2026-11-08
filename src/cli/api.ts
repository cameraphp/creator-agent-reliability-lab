import { buildServer } from "../api/server.js";
import { config } from "../config.js";
import { SystemClock } from "../core/clock.js";
import { defaultPolicy } from "../core/policy.js";
import { createPool } from "../db/pool.js";
import { CatalogState } from "../fixtures.js";

const appPool = createPool("app", config.dbName);
const app = buildServer({
  appPool,
  clock: new SystemClock(),
  catalogState: new CatalogState(),
  policy: defaultPolicy(),
});

app
  .listen({ host: config.apiHost, port: config.apiPort })
  .then(() =>
    console.log(
      `api listening on http://${config.apiHost}:${config.apiPort} (localhost only, synthetic lab)`,
    ),
  )
  .catch((err: { code?: string }) => {
    console.error(
      err.code === "EADDRINUSE"
        ? `port ${config.apiPort} is already in use; set LAB_API_PORT`
        : "api failed to start",
    );
    process.exit(1);
  });

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void app
      .close()
      .then(() => appPool.end())
      .then(() => process.exit(0));
  });
}
