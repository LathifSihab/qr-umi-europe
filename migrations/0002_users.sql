CREATE TABLE users (
  email               TEXT PRIMARY KEY CHECK (email = lower(email)),  -- login name, stored lowercase
  password_hash       TEXT NOT NULL,                                   -- pbkdf2-sha256$iterations$salt$hash
  password_changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),              -- for the record; sessions use a hash fingerprint
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE password_resets (
  token_hash  TEXT PRIMARY KEY,                                        -- SHA-256 of the emailed token, never the token
  email       TEXT NOT NULL REFERENCES users(email) ON DELETE CASCADE,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
