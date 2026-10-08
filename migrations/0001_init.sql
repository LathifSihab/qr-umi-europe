CREATE TABLE products (
  code        TEXT PRIMARY KEY CHECK (code ~ '^[A-Z0-9][A-Z0-9-]{1,31}$'), -- e.g. "X200", uppercase, immutable
  name        TEXT NOT NULL,                                                 -- display name, editable
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE manuals (
  product_code  TEXT NOT NULL REFERENCES products(code) ON DELETE CASCADE,
  lang          TEXT NOT NULL CHECK (lang IN ('en','nl','fr','de')),
  r2_key        TEXT NOT NULL,           -- manuals/{CODE}/{lang}/{uuid}.pdf
  original_name TEXT NOT NULL,           -- filename as uploaded
  size_bytes    INTEGER NOT NULL,
  uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  uploaded_by   TEXT,                    -- email from Access JWT
  PRIMARY KEY (product_code, lang)
);
