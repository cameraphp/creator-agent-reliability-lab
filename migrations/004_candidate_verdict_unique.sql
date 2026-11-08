-- 004: one recorded verdict per provider receipt (re-validation after restart is idempotent).
ALTER TABLE lab.candidates ADD CONSTRAINT candidates_one_verdict_per_call UNIQUE (call_id);
