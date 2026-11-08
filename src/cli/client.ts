import { config } from "../config.js";

/** Tiny HTTP test/demo client for the local API. Sends nothing anywhere else. */
const base = process.env.LAB_API_URL ?? `http://${config.apiHost}:${config.apiPort}`;
const [cmd, ...args] = process.argv.slice(2);
const flag = (name: string, fallback?: string): string => {
  const i = args.indexOf(`--${name}`);
  const v = i >= 0 ? args[i + 1] : fallback;
  if (v === undefined) throw new Error(`missing --${name}`);
  return v;
};

async function call(method: string, path: string, actor: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: { "x-demo-actor": actor, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: (await res.json()) as unknown };
}

async function main(): Promise<number> {
  const actor = flag("actor", "actor-desk-notes");
  let r;
  switch (cmd) {
    case "submit":
      r = await call("POST", "/v1/analysis-jobs", actor, {
        conversation_id: flag("conversation", "dn-conv-1"),
        product_id: flag("product", "tallycube"),
        video_id: flag("video", "vid-dn-001"),
        brief_id: flag("brief", "brief-desk-reset"),
        idempotency_key: flag("key"),
      });
      break;
    case "status":
      r = await call("GET", `/v1/analysis-jobs/${flag("job")}`, actor);
      break;
    case "trace":
      r = await call("GET", `/v1/analysis-jobs/${flag("job")}/trace`, actor);
      break;
    case "drafts":
      r = await call("GET", `/v1/conversations/${flag("conversation", "dn-conv-1")}/drafts`, actor);
      break;
    case "health":
      r = await call("GET", "/health", actor);
      break;
    default:
      console.error(
        "usage: client.ts submit|status|trace|drafts|health [--actor a] [--key k] [--job id] [--conversation c]",
      );
      return 2;
  }
  console.log(JSON.stringify(r, null, 2));
  return r.status < 400 ? 0 : 1;
}

main().then(
  (c) => process.exit(c),
  (e: Error) => {
    console.error(`client error: ${e.message}`);
    process.exit(1);
  },
);
