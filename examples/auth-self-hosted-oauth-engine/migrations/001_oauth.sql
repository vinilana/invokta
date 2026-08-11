BEGIN;

CREATE TABLE IF NOT EXISTS oauth_users (
  id text PRIMARY KEY,
  email text NOT NULL,
  password_hash text NOT NULL,
  disabled boolean NOT NULL DEFAULT false,
  failed_login_count integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT oauth_users_email_normalized CHECK (email = lower(email)),
  CONSTRAINT oauth_users_email_unique UNIQUE (email)
);

CREATE TABLE IF NOT EXISTS oauth_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS oauth_artifacts (
  model text NOT NULL,
  id text NOT NULL,
  payload jsonb NOT NULL,
  grant_id text,
  user_code text,
  uid text,
  expires_at timestamptz,
  consumed_at timestamptz,
  PRIMARY KEY (model, id)
);

CREATE INDEX IF NOT EXISTS oauth_artifacts_grant_idx
  ON oauth_artifacts (model, grant_id)
  WHERE grant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS oauth_artifacts_user_code_idx
  ON oauth_artifacts (model, user_code)
  WHERE user_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS oauth_artifacts_uid_idx
  ON oauth_artifacts (model, uid)
  WHERE uid IS NOT NULL;
CREATE INDEX IF NOT EXISTS oauth_artifacts_expiry_idx
  ON oauth_artifacts (expires_at)
  WHERE expires_at IS NOT NULL;

COMMIT;
