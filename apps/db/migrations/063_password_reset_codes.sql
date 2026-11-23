-- AUTH-RESET-01: an administrator issues a one-time password reset code. Additive and forward-only:
-- 036_accounts and 045_password_accounts are never edited.
--
-- Design. A password account has no email, so the code is handed over out of band by an administrator.
--   * Only a PBKDF2 hash of the code is stored, in the worker's existing hashPassword encoding. The code is never stored.
--   * At most one unused code exists per account. Issuing a new code burns the older unused one.
--   * A code expires 30 minutes after issue. Five wrong attempts burn it. A correct attempt burns it too.
--   * Consumption, the password change and the revocation of every session of the account run in one transaction.
--   * The admin audit trail gets one row per issue (action password_reset_code_issued). The code is never written there.

CREATE TABLE IF NOT EXISTS waspada.password_reset_codes (
  reset_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_mode text NOT NULL CHECK (dataset_mode IN ('live', 'demo')),
  account_id uuid NOT NULL,
  issued_by_account_id uuid NOT NULL,
  code_hash text NOT NULL CHECK (
    code_hash ~ '^pbkdf2-sha256\$[1-9][0-9]{4,6}\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$'
  ),
  failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts BETWEEN 0 AND 5),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  CONSTRAINT password_reset_codes_expiry_order CHECK (created_at < expires_at),
  CONSTRAINT password_reset_codes_used_after_issue CHECK (used_at IS NULL OR used_at >= created_at),
  FOREIGN KEY (account_id, dataset_mode)
    REFERENCES waspada.accounts(account_id, dataset_mode) ON DELETE RESTRICT,
  FOREIGN KEY (issued_by_account_id, dataset_mode)
    REFERENCES waspada.accounts(account_id, dataset_mode) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS password_reset_codes_one_unused_idx
  ON waspada.password_reset_codes (dataset_mode, account_id)
  WHERE used_at IS NULL;
CREATE INDEX IF NOT EXISTS password_reset_codes_cleanup_idx
  ON waspada.password_reset_codes (dataset_mode, expires_at);

-- Widen the audit vocabulary. The two CHECKs that name account_updated are found by their content, not by a
-- guessed constraint name, dropped, and re-added with the same rules plus the new action.
DO $$
DECLARE
  stale record;
BEGIN
  FOR stale IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'waspada.account_admin_audit'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%account_updated%'
  LOOP
    EXECUTE format('ALTER TABLE waspada.account_admin_audit DROP CONSTRAINT %I', stale.conname);
  END LOOP;
END;
$$;

ALTER TABLE waspada.account_admin_audit
  ADD CONSTRAINT account_admin_audit_action_vocabulary CHECK (
    action IN ('account_updated', 'account_provisioned', 'password_reset_code_issued')
  ),
  ADD CONSTRAINT account_admin_audit_action_shape CHECK (
    (action = 'account_provisioned' AND actor_kind = 'operator' AND expected_version IS NULL)
    OR (action = 'account_updated' AND actor_kind = 'admin' AND expected_version IS NOT NULL)
    OR (action = 'password_reset_code_issued' AND actor_kind = 'admin' AND expected_version IS NULL)
  );

-- Reset attempts get their own throttle scope, so they never spend the login budget of the same username.
ALTER TABLE waspada.account_login_throttles
  DROP CONSTRAINT IF EXISTS account_login_throttles_scope_check;
ALTER TABLE waspada.account_login_throttles
  ADD CONSTRAINT account_login_throttles_scope_check CHECK (
    scope IN (
      'web_start', 'web_callback', 'native_exchange',
      'register', 'login_client', 'login_username', 'password_reset'
    )
  );

REVOKE ALL PRIVILEGES ON TABLE waspada.password_reset_codes FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON waspada.password_reset_codes TO waspada_auth_service;
