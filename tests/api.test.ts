import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/api/server.js";
import { deskRequest, type Lab, makeLab, sparksRequest } from "./helpers.js";

let lab: Lab;
afterEach(async () => lab?.close());

const H = (actor: string) => ({ "x-demo-actor": actor, "content-type": "application/json" });

describe("T-A HTTP API contract (R1, R2, R9, R19)", () => {
  it("T-A1 submit/poll/trace/drafts with safe errors and trace ids", async () => {
    lab = await makeLab();
    const app = buildServer(lab.svc);
    try {
      expect((await app.inject({ method: "GET", url: "/health" })).json()).toMatchObject({
        status: "ok",
        real_providers: false,
      });

      const post = await app.inject({
        method: "POST",
        url: "/v1/analysis-jobs",
        headers: H("actor-desk-notes"),
        payload: deskRequest("api-key-00001"),
      });
      expect(post.statusCode).toBe(202);
      expect(post.headers["x-trace-id"]).toBeTruthy();
      const { job, poll } = post.json();
      expect(post.headers.location).toBe(`/v1/analysis-jobs/${job.job_id}`);
      expect(poll.url).toBe(post.headers.location);

      const replay = await app.inject({
        method: "POST",
        url: "/v1/analysis-jobs",
        headers: H("actor-desk-notes"),
        payload: deskRequest("api-key-00001"),
      });
      expect(replay.statusCode).toBe(200);
      expect(replay.json().idempotent_replay).toBe(true);

      const conflict = await app.inject({
        method: "POST",
        url: "/v1/analysis-jobs",
        headers: H("actor-desk-notes"),
        payload: deskRequest("api-key-00001", { video_id: "vid-dn-002" }),
      });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json().error).toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
      expect(conflict.json().error.trace_id).toBe(conflict.headers["x-trace-id"]);

      const bad = await app.inject({
        method: "POST",
        url: "/v1/analysis-jobs",
        headers: H("actor-desk-notes"),
        payload: { ...deskRequest("api-key-00002"), provider: "compatible-backup" },
      });
      expect(bad.statusCode).toBe(400);
      expect(JSON.stringify(bad.json())).not.toMatch(/stack|at .*\.ts|zod/i);
      const malformed = await app.inject({
        method: "POST",
        url: "/v1/analysis-jobs",
        headers: H("actor-desk-notes"),
        payload: "{not json",
      });
      expect(malformed.statusCode).toBe(400);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/v1/analysis-jobs",
            payload: deskRequest("api-key-00003"),
          })
        ).statusCode,
      ).toBe(401);

      const pending = await app.inject({
        method: "GET",
        url: `/v1/analysis-jobs/${job.job_id}`,
        headers: H("actor-desk-notes"),
      });
      expect(pending.json().job.client_guidance.action).toBe("poll");
      // Another creator cannot see the job (RLS) -> 404, not 403 (no existence leak).
      expect(
        (
          await app.inject({
            method: "GET",
            url: `/v1/analysis-jobs/${job.job_id}`,
            headers: H("actor-study-sparks"),
          })
        ).statusCode,
      ).toBe(404);

      await lab.drain();
      const done = await app.inject({
        method: "GET",
        url: `/v1/analysis-jobs/${job.job_id}`,
        headers: H("actor-desk-notes"),
      });
      expect(done.json().job).toMatchObject({ state: "DRAFT_READY", terminal: true });
      const trace = await app.inject({
        method: "GET",
        url: `/v1/analysis-jobs/${job.job_id}/trace`,
        headers: H("actor-desk-notes"),
      });
      const events = trace.json().events as Array<{ event: string; attrs: Record<string, unknown> }>;
      expect(events.map((e) => e.event)).toContain("route.decision");
      expect(JSON.stringify(events)).not.toMatch(/response_content|password|stack/i);
      const drafts = await app.inject({
        method: "GET",
        url: "/v1/conversations/dn-conv-1/drafts",
        headers: H("actor-desk-notes"),
      });
      expect(drafts.json().drafts).toHaveLength(1);
      const other = await app.inject({
        method: "GET",
        url: "/v1/conversations/dn-conv-2/drafts",
        headers: H("actor-desk-notes"),
      });
      expect(other.json().drafts).toHaveLength(0);
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/v1/conversations/dn-conv-1/drafts",
            headers: H("actor-study-sparks"),
          })
        ).statusCode,
      ).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("T-A2 polling a safely failed job returns an actionable terminal state, not endless loading", async () => {
    lab = await makeLab();
    const app = buildServer(lab.svc);
    try {
      const post = await app.inject({
        method: "POST",
        url: "/v1/analysis-jobs",
        headers: H("actor-study-sparks"),
        payload: sparksRequest("api-key-00004"),
      });
      lab.catalogState.setAccount("study-sparks", "EXPIRED");
      await lab.drain();
      const s = await app.inject({
        method: "GET",
        url: `/v1/analysis-jobs/${post.json().job.job_id}`,
        headers: H("actor-study-sparks"),
      });
      expect(s.json().job).toMatchObject({
        state: "FAILED",
        terminal: true,
        error_code: "ACCOUNT_RECONNECT_REQUIRED",
      });
      expect(s.json().job.client_guidance.action).toBe("show_error");
    } finally {
      await app.close();
    }
  });
});
