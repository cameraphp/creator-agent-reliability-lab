-- 001: lab identity, roles, hardened schema, constraints and guards.
-- Applied by the migration/admin role only. Local throwaway lab database.

-- Cluster-wide roles (idempotent). Passwords are set by the migration runner
-- from local non-production config values.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lab_app') THEN
    CREATE ROLE lab_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT NOREPLICATION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lab_worker') THEN
    CREATE ROLE lab_worker LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT NOREPLICATION;
  END IF;
END $$;

CREATE SCHEMA lab;
CREATE SCHEMA sim_provider;

CREATE TABLE lab.lab_meta (
  key text PRIMARY KEY,
  value text NOT NULL
);
INSERT INTO lab.lab_meta (key, value) VALUES ('lab_id', 'creator-agent-reliability-lab');

CREATE TABLE lab.jobs (
  job_id uuid PRIMARY KEY,
  creator_id text NOT NULL CHECK (creator_id <> ''),
  conversation_id text NOT NULL CHECK (conversation_id <> ''),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  request_fingerprint text NOT NULL,
  semantic_key text NOT NULL,
  request jsonb NOT NULL,
  pinned jsonb NOT NULL,
  state text NOT NULL CHECK (state IN ('READY', 'RUNNING', 'RETRY_WAIT', 'DRAFT_READY', 'FAILED', 'RECONCILIATION_REQUIRED')),
  claim_count integer NOT NULL DEFAULT 0,
  fencing_token bigint NOT NULL DEFAULT 0,
  lease_owner text,
  lease_expires_at timestamptz,
  next_run_at timestamptz NOT NULL,
  error_code text,
  accepted_candidate_id uuid,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT jobs_idempotency_unique UNIQUE (creator_id, conversation_id, idempotency_key),
  CONSTRAINT jobs_identity_unique UNIQUE (job_id, creator_id, conversation_id),
  CONSTRAINT jobs_running_has_lease CHECK (state <> 'RUNNING' OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CONSTRAINT jobs_ready_has_candidate CHECK (state <> 'DRAFT_READY' OR accepted_candidate_id IS NOT NULL),
  CONSTRAINT jobs_failure_has_code CHECK (state NOT IN ('FAILED', 'RECONCILIATION_REQUIRED') OR error_code IS NOT NULL)
);
-- Fixture-scoped semantic-operation rule: at most one non-failed job per
-- (creator, conversation, exact selectors + pinned revisions).
CREATE UNIQUE INDEX jobs_semantic_active ON lab.jobs (creator_id, conversation_id, semantic_key) WHERE state <> 'FAILED';
CREATE INDEX jobs_claimable ON lab.jobs (next_run_at) WHERE state IN ('READY', 'RETRY_WAIT');
CREATE INDEX jobs_running_lease ON lab.jobs (lease_expires_at) WHERE state = 'RUNNING';

-- Terminal results can never be overwritten, whoever writes.
CREATE FUNCTION lab.guard_terminal_job() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state IN ('DRAFT_READY', 'FAILED')
     AND (NEW.state IS DISTINCT FROM OLD.state
          OR NEW.accepted_candidate_id IS DISTINCT FROM OLD.accepted_candidate_id
          OR NEW.error_code IS DISTINCT FROM OLD.error_code) THEN
    RAISE EXCEPTION 'TERMINAL_GUARD: job % is terminal (%)', OLD.job_id, OLD.state USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER jobs_terminal_guard BEFORE UPDATE ON lab.jobs FOR EACH ROW EXECUTE FUNCTION lab.guard_terminal_job();

-- Immutable stage checkpoints: one row per (job, stage); worker has no UPDATE grant.
CREATE TABLE lab.stage_results (
  job_id uuid NOT NULL,
  creator_id text NOT NULL,
  stage text NOT NULL CHECK (stage IN ('account_check', 'video_analysis', 'context_assembly', 'dialogue_draft')),
  result jsonb NOT NULL,
  fencing_token bigint NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (job_id, stage),
  FOREIGN KEY (job_id) REFERENCES lab.jobs (job_id)
);

-- Local provider-call intents and receipts (the app's side of the ledger).
CREATE TABLE lab.provider_calls (
  call_id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES lab.jobs (job_id),
  creator_id text NOT NULL,
  stage text NOT NULL CHECK (stage IN ('video_analysis', 'dialogue_draft')),
  purpose text NOT NULL CHECK (purpose IN ('initial', 'repair')),
  operation_id text NOT NULL UNIQUE,
  profile_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('INTENT', 'RECEIVED', 'NOT_ACCEPTED', 'AMBIGUOUS', 'UNRESOLVED')),
  invocations integer NOT NULL DEFAULT 0,
  response_content text,
  response_source text CHECK (response_source IN ('direct', 'status_lookup', 'idempotent_replay')),
  usage jsonb,
  error_code text,
  fencing_token bigint NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT receipt_has_content CHECK (status <> 'RECEIVED' OR response_content IS NOT NULL)
);
-- While an operation is open, unknown or received for a stage/purpose, a second
-- operation cannot even be recorded: blocks blind duplicate paid calls.
CREATE UNIQUE INDEX provider_calls_one_open ON lab.provider_calls (job_id, stage, purpose)
  WHERE status IN ('INTENT', 'AMBIGUOUS', 'RECEIVED', 'UNRESOLVED');

CREATE FUNCTION lab.guard_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'RECEIVED' THEN
    RAISE EXCEPTION 'RECEIPT_GUARD: committed receipt % is immutable', OLD.operation_id USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER provider_calls_receipt_guard BEFORE UPDATE ON lab.provider_calls FOR EACH ROW EXECUTE FUNCTION lab.guard_receipt();

-- Every validated candidate, accepted or rejected (rejected = diagnostic only).
CREATE TABLE lab.candidates (
  candidate_id uuid PRIMARY KEY,
  job_id uuid NOT NULL,
  creator_id text NOT NULL,
  call_id uuid REFERENCES lab.provider_calls (call_id),
  kind text NOT NULL CHECK (kind IN ('initial', 'repair')),
  verdict text NOT NULL CHECK (verdict IN ('ACCEPTED', 'REJECTED')),
  errors jsonb NOT NULL DEFAULT '[]',
  content jsonb,
  created_at timestamptz NOT NULL,
  FOREIGN KEY (job_id) REFERENCES lab.jobs (job_id)
);

-- Saved artifact. Composite FK forces the ORIGINAL job conversation as destination.
CREATE TABLE lab.drafts (
  draft_id uuid PRIMARY KEY,
  job_id uuid NOT NULL UNIQUE,
  creator_id text NOT NULL,
  conversation_id text NOT NULL,
  candidate_id uuid NOT NULL UNIQUE REFERENCES lab.candidates (candidate_id),
  artifact jsonb NOT NULL,
  pinned jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  FOREIGN KEY (job_id, creator_id, conversation_id) REFERENCES lab.jobs (job_id, creator_id, conversation_id)
);
CREATE INDEX drafts_by_conversation ON lab.drafts (creator_id, conversation_id, created_at);

CREATE TABLE lab.trace_events (
  event_id bigserial PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES lab.jobs (job_id),
  creator_id text NOT NULL,
  at timestamptz NOT NULL,
  stage text,
  event text NOT NULL,
  attrs jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX trace_events_by_job ON lab.trace_events (job_id, event_id);

-- Simulated provider's OWN storage (stands in for the remote side). Records
-- synthetic invocations, acceptances and charge units. No real money exists.
CREATE TABLE sim_provider.invocations (
  invocation_id bigserial PRIMARY KEY,
  profile_id text NOT NULL,
  operation_id text,
  idempotency_key_honored boolean NOT NULL,
  accepted boolean NOT NULL,
  replayed boolean NOT NULL DEFAULT false,
  outcome text NOT NULL,
  tokens integer NOT NULL DEFAULT 0,
  charge_units numeric(12, 3) NOT NULL DEFAULT 0,
  logical_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sim_provider.operations (
  profile_id text NOT NULL,
  operation_key text NOT NULL,
  first_invocation_id bigint NOT NULL REFERENCES sim_provider.invocations (invocation_id),
  response_content text NOT NULL,
  PRIMARY KEY (profile_id, operation_key)
);
