-- Up Migration
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), cookie_hash bytea NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), session_id uuid NOT NULL REFERENCES sessions(id),
  defendant text NOT NULL CHECK (char_length(defendant) BETWEEN 2 AND 200),
  act text NOT NULL CHECK (char_length(act) BETWEEN 10 AND 2000),
  question text NOT NULL CHECK (char_length(question) BETWEEN 5 AND 300),
  status text NOT NULL CHECK (status IN ('queued','running','completed','partial','failed','cancelled')),
  stage text NOT NULL CHECK (stage IN ('intake','advocates','advocates_complete','judges','finished')),
  termination_reason text, budget_usd numeric(12,6) NOT NULL, spent_usd numeric(12,6) NOT NULL DEFAULT 0,
  protocol_version text NOT NULL, idempotency_key uuid NOT NULL UNIQUE, indictment_hash bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz, finished_at timestamptz,
  deadline_at timestamptz NOT NULL, deleted_at timestamptz,
  CHECK (spent_usd <= budget_usd * 1.05), CHECK (finished_at IS NULL OR finished_at >= created_at)
);
CREATE TABLE runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), case_id uuid NOT NULL REFERENCES cases(id),
  role text NOT NULL CHECK (role IN ('advocate','judge')), instance_no smallint NOT NULL,
  stance text, slot text NOT NULL, status text NOT NULL CHECK (status IN ('pending','in_flight','succeeded','failed','aborted')),
  prompt_name text NOT NULL, prompt_version text NOT NULL, prompt_hash bytea NOT NULL,
  provider text, model text, attempt_count smallint NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 5),
  input_tokens integer NOT NULL DEFAULT 0, output_tokens integer NOT NULL DEFAULT 0,
  cost_usd numeric(12,6) NOT NULL DEFAULT 0, latency_ms integer, normalized_json jsonb,
  error_code text, error_message text, lease_owner uuid, lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
  UNIQUE (case_id, role, instance_no), UNIQUE (id, role),
  CHECK ((role='advocate' AND ((instance_no IN (1,2) AND stance='justified') OR (instance_no IN (3,4) AND stance='not_justified'))) OR (role='judge' AND instance_no BETWEEN 1 AND 3 AND stance IS NULL)),
  CHECK ((status='succeeded') = (normalized_json IS NOT NULL)),
  CHECK (NOT (status='succeeded' AND error_code IS NOT NULL))
);
CREATE TABLE run_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), run_id uuid NOT NULL REFERENCES runs(id),
  attempt_no smallint NOT NULL, attempt_kind text NOT NULL CHECK (attempt_kind IN ('initial','repair','manual')),
  outcome text NOT NULL CHECK (outcome IN ('succeeded','provider_error','timeout','contract_violation','aborted','in_flight')),
  http_status smallint, provider_generation_id text, input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0, reasoning_tokens integer NOT NULL DEFAULT 0,
  cached_input_tokens integer NOT NULL DEFAULT 0, cost_usd numeric(12,6) NOT NULL DEFAULT 0,
  latency_ms integer, failure_layer text, error_code text, error_message text,
  started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz, UNIQUE(run_id, attempt_no)
);
CREATE TABLE advocate_arguments (
  run_id uuid PRIMARY KEY, case_id uuid NOT NULL REFERENCES cases(id), role text NOT NULL DEFAULT 'advocate' CHECK(role='advocate'),
  position text NOT NULL CHECK(position IN ('justified','not_justified')),
  reasoning text NOT NULL CHECK(char_length(reasoning) BETWEEN 200 AND 4000), created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (run_id, role) REFERENCES runs(id, role)
);
CREATE TABLE judge_verdicts (
  run_id uuid PRIMARY KEY, case_id uuid NOT NULL REFERENCES cases(id), role text NOT NULL DEFAULT 'judge' CHECK(role='judge'),
  decision text NOT NULL CHECK(decision IN ('justified','not_justified')),
  reasoning text NOT NULL CHECK(char_length(reasoning) BETWEEN 200 AND 4000), created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (run_id, role) REFERENCES runs(id, role)
);
CREATE TABLE raw_model_responses (
  attempt_id uuid PRIMARY KEY REFERENCES run_attempts(id), raw_body text NOT NULL, parse_mode text,
  created_at timestamptz NOT NULL DEFAULT now(), purge_after timestamptz NOT NULL DEFAULT now() + interval '30 days'
);
CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), case_id uuid NOT NULL REFERENCES cases(id),
  kind text NOT NULL CHECK(kind IN ('advocates','judges')), state text NOT NULL CHECK(state IN ('pending','running','done','failed')),
  attempts smallint NOT NULL DEFAULT 0, run_after timestamptz NOT NULL DEFAULT now(), lease_owner uuid,
  lease_expires_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX jobs_one_active_stage ON jobs(case_id,kind) WHERE state IN ('pending','running');
CREATE INDEX cases_session_history ON cases(session_id,created_at DESC,id DESC) WHERE deleted_at IS NULL;
CREATE INDEX cases_active_deadline ON cases(status,deadline_at) WHERE status IN ('queued','running');
CREATE INDEX jobs_pending ON jobs(state,run_after) WHERE state='pending';
CREATE INDEX raw_purge ON raw_model_responses(purge_after);

-- Down Migration
DROP TABLE IF EXISTS raw_model_responses, judge_verdicts, advocate_arguments, run_attempts, jobs, runs, cases, sessions CASCADE;
