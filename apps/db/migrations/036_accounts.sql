-- AUTH-01-CORE: isolated Google account, session, login-attempt, throttle, and audit state.
-- This migration is also usable by the account-only local PGlite harness.
CREATE SCHEMA IF NOT EXISTS waspada;

CREATE TABLE IF NOT EXISTS waspada.accounts (
  account_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_mode text NOT NULL CHECK (dataset_mode IN ('live', 'demo')),
  identity_issuer text NOT NULL CHECK (identity_issuer = 'https://accounts.google.com'),
  identity_subject text NOT NULL CHECK (length(identity_subject) BETWEEN 1 AND 255),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  email text NOT NULL CHECK (length(email) BETWEEN 3 AND 320),
  role text NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'moderator', 'admin')),
  active boolean NOT NULL DEFAULT true,
  onboarding_version smallint NOT NULL DEFAULT 0 CHECK (onboarding_version IN (0, 1)),
  onboarding_completed_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT accounts_identity_unique UNIQUE (dataset_mode, identity_issuer, identity_subject),
  CONSTRAINT accounts_id_dataset_unique UNIQUE (account_id, dataset_mode),
  CONSTRAINT accounts_onboarding_completion_consistent CHECK (
    (onboarding_version = 0 AND onboarding_completed_at IS NULL)
    OR (onboarding_version = 1 AND onboarding_completed_at IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS waspada.account_sessions (
  session_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  token_sha256 text NOT NULL UNIQUE CHECK (token_sha256 ~ '^[0-9a-f]{64}$'),
  channel text NOT NULL CHECK (channel IN ('web', 'mobile')),
  dataset_mode text NOT NULL CHECK (dataset_mode IN ('live', 'demo')),
  csrf_token text,
  created_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  idle_expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CONSTRAINT account_sessions_expiry_order CHECK (
    created_at <= last_seen_at
    AND last_seen_at < absolute_expires_at
    AND idle_expires_at <= absolute_expires_at
  ),
  CONSTRAINT account_sessions_channel_csrf CHECK (
    (channel = 'web' AND csrf_token IS NOT NULL AND length(csrf_token) BETWEEN 32 AND 256)
    OR (channel = 'mobile' AND csrf_token IS NULL)
  ),
  FOREIGN KEY (account_id, dataset_mode)
    REFERENCES waspada.accounts(account_id, dataset_mode) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS waspada.account_login_attempts (
  attempt_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_mode text NOT NULL CHECK (dataset_mode IN ('live', 'demo')),
  state_sha256 text NOT NULL UNIQUE CHECK (state_sha256 ~ '^[0-9a-f]{64}$'),
  browser_cookie_sha256 text NOT NULL CHECK (browser_cookie_sha256 ~ '^[0-9a-f]{64}$'),
  prior_session_token_sha256 text CHECK (
    prior_session_token_sha256 IS NULL OR prior_session_token_sha256 ~ '^[0-9a-f]{64}$'
  ),
  code_verifier text NOT NULL CHECK (length(code_verifier) BETWEEN 43 AND 128),
  nonce text NOT NULL CHECK (length(nonce) BETWEEN 16 AND 256),
  return_to text NOT NULL CHECK (return_to IN ('#akun', '#mulai', '#admin', '#tinjau-bukti')),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CHECK (created_at < expires_at)
);

CREATE TABLE IF NOT EXISTS waspada.account_login_throttles (
  dataset_mode text NOT NULL CHECK (dataset_mode IN ('live', 'demo')),
  scope text NOT NULL CHECK (scope IN ('web_start', 'web_callback', 'native_exchange')),
  client_key_sha256 text NOT NULL CHECK (client_key_sha256 ~ '^[0-9a-f]{64}$'),
  window_started_at timestamptz NOT NULL,
  request_count integer NOT NULL CHECK (request_count > 0),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (dataset_mode, scope, client_key_sha256),
  CHECK (window_started_at < expires_at)
);

CREATE TABLE IF NOT EXISTS waspada.account_admin_audit (
  audit_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_mode text NOT NULL CHECK (dataset_mode IN ('live', 'demo')),
  actor_kind text NOT NULL CHECK (actor_kind IN ('admin', 'operator')),
  actor_account_id uuid,
  target_account_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('account_updated', 'account_provisioned')),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  actor_role_at_action text CHECK (
    actor_role_at_action IS NULL OR actor_role_at_action IN ('user', 'moderator', 'admin')
  ),
  target_role_before text CHECK (
    target_role_before IS NULL OR target_role_before IN ('user', 'moderator', 'admin')
  ),
  target_role_after text NOT NULL CHECK (target_role_after IN ('user', 'moderator', 'admin')),
  target_active_before boolean,
  target_active_after boolean NOT NULL,
  expected_version integer,
  target_version_after integer NOT NULL CHECK (target_version_after > 0),
  occurred_at timestamptz NOT NULL,
  CHECK (
    (actor_kind = 'admin' AND actor_account_id IS NOT NULL AND actor_role_at_action = 'admin')
    OR (actor_kind = 'operator' AND actor_account_id IS NULL AND actor_role_at_action IS NULL)
  ),
  CHECK (
    (action = 'account_provisioned' AND actor_kind = 'operator' AND expected_version IS NULL)
    OR (action = 'account_updated' AND actor_kind = 'admin' AND expected_version IS NOT NULL)
  ),
  FOREIGN KEY (actor_account_id, dataset_mode)
    REFERENCES waspada.accounts(account_id, dataset_mode) ON DELETE RESTRICT,
  FOREIGN KEY (target_account_id, dataset_mode)
    REFERENCES waspada.accounts(account_id, dataset_mode) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS accounts_dataset_id_idx
  ON waspada.accounts (dataset_mode, account_id);
CREATE INDEX IF NOT EXISTS accounts_dataset_role_idx
  ON waspada.accounts (dataset_mode, role, active, account_id);
CREATE INDEX IF NOT EXISTS account_sessions_account_active_idx
  ON waspada.account_sessions (dataset_mode, account_id, absolute_expires_at)
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS account_sessions_expiry_idx
  ON waspada.account_sessions (idle_expires_at, absolute_expires_at);
CREATE INDEX IF NOT EXISTS account_login_attempts_expiry_idx
  ON waspada.account_login_attempts (expires_at, consumed_at);
CREATE INDEX IF NOT EXISTS account_login_throttles_expiry_idx
  ON waspada.account_login_throttles (dataset_mode, expires_at);
CREATE INDEX IF NOT EXISTS account_admin_audit_target_time_idx
  ON waspada.account_admin_audit (dataset_mode, target_account_id, occurred_at DESC);

CREATE OR REPLACE FUNCTION waspada.reject_account_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'account audit rows are append-only';
END;
$$;

DROP TRIGGER IF EXISTS account_admin_audit_append_only ON waspada.account_admin_audit;
CREATE TRIGGER account_admin_audit_append_only
  BEFORE UPDATE OR DELETE ON waspada.account_admin_audit
  FOR EACH ROW EXECUTE FUNCTION waspada.reject_account_audit_mutation();

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'waspada_auth_service') THEN
    CREATE ROLE waspada_auth_service NOLOGIN;
  END IF;
END;
$$;

ALTER ROLE waspada_auth_service
  NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

REVOKE ALL PRIVILEGES ON SCHEMA waspada FROM waspada_auth_service;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA waspada FROM waspada_auth_service;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA waspada FROM waspada_auth_service;

DO $$
DECLARE membership record;
DECLARE role_name text;
BEGIN
  FOR membership IN
    SELECT granted.rolname AS granted_role
    FROM pg_auth_members AS m
    JOIN pg_roles AS granted ON granted.oid = m.roleid
    WHERE m.member = (SELECT oid FROM pg_roles WHERE rolname = 'waspada_auth_service')
  LOOP
    EXECUTE format('REVOKE %I FROM waspada_auth_service', membership.granted_role);
  END LOOP;

  FOR membership IN
    SELECT member_role.rolname AS member_role
    FROM pg_auth_members AS m
    JOIN pg_roles AS member_role ON member_role.oid = m.member
    WHERE m.roleid = (SELECT oid FROM pg_roles WHERE rolname = 'waspada_auth_service')
  LOOP
    EXECUTE format('REVOKE waspada_auth_service FROM %I', membership.member_role);
  END LOOP;

  FOREACH role_name IN ARRAY ARRAY[
    'waspada_public_reader',
    'waspada_l1_pipeline',
    'waspada_l2_grounding_reader',
    'waspada_l2_grounding_writer',
    'waspada_l2_proposal_writer',
    'waspada_l3_coordinator',
    'waspada_l4_freshness_writer',
    'waspada_l4_publication_outbox_delivery',
    'waspada_l4_publication_writer',
    'waspada_l4_report_revision_impact_reader',
    'waspada_l4_moderator_publication_writer'
  ]
  LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format(
        'REVOKE ALL PRIVILEGES ON TABLE waspada.accounts, waspada.account_sessions, waspada.account_login_attempts, waspada.account_login_throttles, waspada.account_admin_audit FROM %I',
        role_name
      );
    END IF;
  END LOOP;
END;
$$;

REVOKE ALL PRIVILEGES ON TABLE waspada.accounts, waspada.account_sessions,
  waspada.account_login_attempts, waspada.account_login_throttles,
  waspada.account_admin_audit FROM PUBLIC;
REVOKE ALL PRIVILEGES ON SCHEMA waspada FROM PUBLIC;

GRANT USAGE ON SCHEMA waspada TO waspada_auth_service;
GRANT SELECT, INSERT, UPDATE ON waspada.accounts TO waspada_auth_service;
GRANT SELECT, INSERT, UPDATE, DELETE ON waspada.account_sessions,
  waspada.account_login_attempts, waspada.account_login_throttles TO waspada_auth_service;
GRANT SELECT, INSERT ON waspada.account_admin_audit TO waspada_auth_service;
