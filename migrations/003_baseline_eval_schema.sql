-- 003: EVALUATION-ONLY naive schema that models the pre-remediation code path.
-- Used exclusively by the CLI baseline evaluation (never by the API).
-- Deliberately has no idempotency key, no lease/fencing, no unique draft per job,
-- no destination FK, no terminal guard and no RLS.

CREATE SCHEMA lab_baseline;

CREATE TABLE lab_baseline.jobs (
  job_id uuid PRIMARY KEY,
  creator_id text,
  conversation_id text,
  request jsonb,
  state text,
  created_at timestamptz,
  updated_at timestamptz
);

CREATE TABLE lab_baseline.drafts (
  draft_row bigserial PRIMARY KEY,
  job_id uuid,
  creator_id text,
  conversation_id text,
  artifact jsonb,
  created_at timestamptz,
  updated_at timestamptz
);

GRANT USAGE ON SCHEMA lab_baseline TO lab_worker;
GRANT SELECT, INSERT, UPDATE ON lab_baseline.jobs, lab_baseline.drafts TO lab_worker;
GRANT USAGE ON SEQUENCE lab_baseline.drafts_draft_row_seq TO lab_worker;
