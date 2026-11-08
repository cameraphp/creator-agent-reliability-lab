/** Presentation only: describes the actual outcome of the demo's POST /v1/analysis-jobs call. */
export interface SubmissionBody {
  job?: { job_id?: string; state?: string };
  deduplicated_by?: string | null;
  error?: { code?: string };
}

export function describeSubmission(status: number, body: SubmissionBody): { ok: boolean; line: string } {
  const prefix = `POST /v1/analysis-jobs -> ${status}`;
  const job = body.job?.job_id ? ` job ${body.job.job_id} state ${body.job.state ?? "unknown"}` : "";
  if (status === 202 && job)
    return { ok: true, line: `${prefix}${job} (new job; acknowledged after durable commit)` };
  if (status === 200 && job) {
    const reason = body.deduplicated_by ? `; deduplicated_by ${body.deduplicated_by}` : "";
    return { ok: true, line: `${prefix}${job} (existing job returned, no new job created${reason})` };
  }
  return {
    ok: false,
    line: `${prefix} (not accepted: ${body.error?.code ?? "unexpected response"})`,
  };
}
