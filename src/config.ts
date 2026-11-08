// Local, throwaway, NON-PRODUCTION defaults. Every value can be overridden by env.
const env = process.env;

function int(name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`Invalid integer for ${name}`);
  return n;
}

export const LAB_ID = "creator-agent-reliability-lab";
export const ALLOWED_DATABASES = ["creator_lab", "creator_lab_test", "creator_lab_eval"] as const;

export const config = {
  pgHost: env.LAB_PG_HOST ?? "127.0.0.1",
  pgPort: int("LAB_PG_PORT", 55439),
  dbName: env.LAB_DB_NAME ?? "creator_lab",
  testDbName: env.LAB_TEST_DB_NAME ?? "creator_lab_test",
  evalDbName: env.LAB_EVAL_DB_NAME ?? "creator_lab_eval",
  adminUser: env.LAB_ADMIN_USER ?? "lab_admin",
  adminPassword: env.LAB_ADMIN_PASSWORD ?? "lab_admin_local_only",
  appPassword: env.LAB_APP_PASSWORD ?? "lab_app_local_only",
  workerPassword: env.LAB_WORKER_PASSWORD ?? "lab_worker_local_only",
  apiHost: "127.0.0.1",
  apiPort: int("LAB_API_PORT", 38471),
};

export type DbRole = "admin" | "app" | "worker";

export function connectionFor(role: DbRole, database: string) {
  if (!(ALLOWED_DATABASES as readonly string[]).includes(database)) {
    throw new Error(`Refusing to connect: '${database}' is not a lab database`);
  }
  const user = role === "admin" ? config.adminUser : role === "app" ? "lab_app" : "lab_worker";
  const password =
    role === "admin" ? config.adminPassword : role === "app" ? config.appPassword : config.workerPassword;
  return {
    host: config.pgHost,
    port: config.pgPort,
    database,
    user,
    password,
    application_name: `${LAB_ID}:${role}`,
  };
}
