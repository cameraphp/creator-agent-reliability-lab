-- 002: least-privilege grants and row-level security.
-- lab_app    = API role: submit/read its own creator's records only.
-- lab_worker = worker role: may claim jobs across creators (jobs table only);
--              every other read/write is scoped by a transaction-local creator context.
-- Neither role is superuser, table owner or BYPASSRLS (asserted by tests).

REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA lab FROM PUBLIC;

GRANT USAGE ON SCHEMA lab TO lab_app, lab_worker;
GRANT SELECT ON lab.lab_meta TO lab_app, lab_worker;

-- API role
GRANT SELECT, INSERT ON lab.jobs TO lab_app;
GRANT SELECT ON lab.drafts TO lab_app;
GRANT SELECT, INSERT ON lab.trace_events TO lab_app;
GRANT USAGE ON SEQUENCE lab.trace_events_event_id_seq TO lab_app, lab_worker;

-- Worker role (no DELETE / TRUNCATE anywhere in lab; no UPDATE of identity columns)
GRANT SELECT ON lab.jobs TO lab_worker;
GRANT UPDATE (state, claim_count, fencing_token, lease_owner, lease_expires_at, next_run_at, error_code,
              accepted_candidate_id, updated_at) ON lab.jobs TO lab_worker;
GRANT SELECT, INSERT ON lab.stage_results, lab.candidates, lab.drafts, lab.trace_events TO lab_worker;
GRANT SELECT, INSERT ON lab.provider_calls TO lab_worker;
GRANT UPDATE (status, invocations, response_content, response_source, usage, error_code, updated_at)
  ON lab.provider_calls TO lab_worker;

-- Simulated provider storage is reached through the worker process (in-process double).
GRANT USAGE ON SCHEMA sim_provider TO lab_worker;
GRANT SELECT, INSERT ON sim_provider.invocations, sim_provider.operations TO lab_worker;
GRANT USAGE ON SEQUENCE sim_provider.invocations_invocation_id_seq TO lab_worker;

-- Row-level security. FORCE also applies policies to the table owner.
ALTER TABLE lab.jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE lab.jobs FORCE ROW LEVEL SECURITY;
ALTER TABLE lab.stage_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE lab.stage_results FORCE ROW LEVEL SECURITY;
ALTER TABLE lab.provider_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE lab.provider_calls FORCE ROW LEVEL SECURITY;
ALTER TABLE lab.candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE lab.candidates FORCE ROW LEVEL SECURITY;
ALTER TABLE lab.drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE lab.drafts FORCE ROW LEVEL SECURITY;
ALTER TABLE lab.trace_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE lab.trace_events FORCE ROW LEVEL SECURITY;

-- current_setting(..., true) returns NULL/'' without context: comparisons fail closed.
CREATE POLICY app_jobs ON lab.jobs TO lab_app
  USING (creator_id = current_setting('app.creator_id', true))
  WITH CHECK (creator_id = current_setting('app.creator_id', true));
CREATE POLICY app_drafts ON lab.drafts FOR SELECT TO lab_app
  USING (creator_id = current_setting('app.creator_id', true));
CREATE POLICY app_traces ON lab.trace_events TO lab_app
  USING (creator_id = current_setting('app.creator_id', true))
  WITH CHECK (creator_id = current_setting('app.creator_id', true));

-- Worker: cross-creator visibility on jobs ONLY (needed to claim work).
CREATE POLICY worker_jobs ON lab.jobs TO lab_worker USING (true) WITH CHECK (true);
CREATE POLICY worker_stage_results ON lab.stage_results TO lab_worker
  USING (creator_id = current_setting('app.creator_id', true))
  WITH CHECK (creator_id = current_setting('app.creator_id', true));
CREATE POLICY worker_provider_calls ON lab.provider_calls TO lab_worker
  USING (creator_id = current_setting('app.creator_id', true))
  WITH CHECK (creator_id = current_setting('app.creator_id', true));
CREATE POLICY worker_candidates ON lab.candidates TO lab_worker
  USING (creator_id = current_setting('app.creator_id', true))
  WITH CHECK (creator_id = current_setting('app.creator_id', true));
CREATE POLICY worker_drafts ON lab.drafts TO lab_worker
  USING (creator_id = current_setting('app.creator_id', true))
  WITH CHECK (creator_id = current_setting('app.creator_id', true));
CREATE POLICY worker_traces ON lab.trace_events TO lab_worker
  USING (creator_id = current_setting('app.creator_id', true))
  WITH CHECK (creator_id = current_setting('app.creator_id', true));
