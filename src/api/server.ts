import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { UnknownActorError } from "../db/pool.js";
import { getJob, getTrace, listDrafts, ServiceError, type ServiceDeps, submitJob } from "../service.js";

/**
 * Localhost-only API. `x-demo-actor` selects a SYNTHETIC allowlisted actor; it is
 * NOT authentication and proves nothing about Supabase JWT/RLS integration.
 */
export function buildServer(deps: ServiceDeps): FastifyInstance {
  const app = Fastify({ logger: false, genReqId: () => randomUUID(), bodyLimit: 8 * 1024 });

  app.addHook("onSend", async (req, reply) => {
    reply.header("x-trace-id", req.id);
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ServiceError) {
      return reply
        .code(err.status)
        .send({ error: { code: err.code, message: err.message, trace_id: req.id } });
    }
    if (err instanceof UnknownActorError) {
      return reply
        .code(401)
        .send({ error: { code: "UNKNOWN_ACTOR", message: "Unknown actor.", trace_id: req.id } });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply
        .code(status)
        .send({ error: { code: "INVALID_REQUEST", message: "Malformed request.", trace_id: req.id } });
    }
    // No stack traces, SQL or provider internals leave the process.
    return reply
      .code(503)
      .send({ error: { code: "TEMPORARILY_UNAVAILABLE", message: "Try again shortly.", trace_id: req.id } });
  });

  const actor = (headers: Record<string, unknown>): string => {
    const a = headers["x-demo-actor"];
    if (typeof a !== "string" || a.length === 0)
      throw new ServiceError(401, "UNKNOWN_ACTOR", "Missing x-demo-actor header.");
    return a;
  };

  app.get("/health", async () => {
    await deps.appPool.query("SELECT 1");
    return { status: "ok", database: "reachable", mode: "local synthetic lab", real_providers: false };
  });

  app.post("/v1/analysis-jobs", async (req, reply) => {
    const res = await submitJob(deps, actor(req.headers), req.body, req.id);
    const url = `/v1/analysis-jobs/${res.job.job_id}`;
    return reply
      .code(res.status)
      .header("location", url)
      .send({
        job: res.job,
        idempotent_replay: res.replay,
        deduplicated_by: res.deduplicated_by ?? null,
        poll: { url, after_ms: 1_000 },
      });
  });

  app.get<{ Params: { jobId: string } }>("/v1/analysis-jobs/:jobId", async (req) => ({
    job: await getJob(deps, actor(req.headers), req.params.jobId),
  }));

  app.get<{ Params: { jobId: string } }>("/v1/analysis-jobs/:jobId/trace", async (req) => ({
    job_id: req.params.jobId,
    events: await getTrace(deps, actor(req.headers), req.params.jobId),
  }));

  app.get<{ Params: { conversationId: string } }>(
    "/v1/conversations/:conversationId/drafts",
    async (req) => ({
      conversation_id: req.params.conversationId,
      drafts: await listDrafts(deps, actor(req.headers), req.params.conversationId),
    }),
  );

  return app;
}
