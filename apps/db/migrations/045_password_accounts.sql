-- AUTH-PW-01: username and password accounts replace Google sign-in for new accounts.
-- Additive and append-only: 036_accounts is never edited.
--
-- Design: a password account has no external identity, so identity_issuer and
-- identity_subject become nullable instead of inventing a fake issuer. The existing
-- UNIQUE(dataset_mode, identity_issuer, identity_subject) constraint ignores rows with
-- NULL identity columns (NULLs are distinct), so password accounts never collide there.
-- Legacy Google rows from 036 keep their identity columns and remain valid.
-- email is also nullable because password accounts have no verified email.

ALTER TABLE waspada.accounts
  ALTER COLUMN identity_issuer DROP NOT NULL,
  ALTER COLUMN identity_subject DROP NOT NULL,
  ALTER COLUMN email DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS username text,
  ADD COLUMN IF NOT EXISTS password_hash text;

ALTER TABLE waspada.accounts
  ADD CONSTRAINT accounts_username_format CHECK (
    username IS NULL OR username ~ '^[a-z0-9_.]{3,32}$'
  ),
  ADD CONSTRAINT accounts_password_hash_format CHECK (
    password_hash IS NULL
    OR password_hash ~ '^pbkdf2-sha256\$[1-9][0-9]{4,6}\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$'
  ),
  -- A password account has both a username and a hash; neither exists without the other.
  ADD CONSTRAINT accounts_password_credentials_paired CHECK (
    (username IS NULL) = (password_hash IS NULL)
  ),
  -- Every account has a login method: a password credential or a complete external identity.
  ADD CONSTRAINT accounts_has_login_method CHECK (
    username IS NOT NULL
    OR (identity_issuer IS NOT NULL AND identity_subject IS NOT NULL)
  ),
  ADD CONSTRAINT accounts_identity_paired CHECK (
    (identity_issuer IS NULL) = (identity_subject IS NULL)
  ),
  ADD CONSTRAINT accounts_identity_has_email CHECK (
    identity_issuer IS NULL OR email IS NOT NULL
  );

CREATE UNIQUE INDEX IF NOT EXISTS accounts_dataset_username_unique
  ON waspada.accounts (dataset_mode, username)
  WHERE username IS NOT NULL;

-- Login and registration throttles add username-keyed and self-registration scopes.
-- The legacy Google scopes stay allowed so existing rows remain valid.
ALTER TABLE waspada.account_login_throttles
  DROP CONSTRAINT IF EXISTS account_login_throttles_scope_check;
ALTER TABLE waspada.account_login_throttles
  ADD CONSTRAINT account_login_throttles_scope_check CHECK (
    scope IN ('web_start', 'web_callback', 'native_exchange', 'register', 'login_client', 'login_username')
  );

-- The auth role already holds table-level SELECT/INSERT/UPDATE on accounts from 036, which
-- covers the new columns. The explicit column grant documents the sensitive hash column.
GRANT SELECT (username, password_hash), INSERT (username, password_hash),
  UPDATE (username, password_hash) ON waspada.accounts TO waspada_auth_service;
