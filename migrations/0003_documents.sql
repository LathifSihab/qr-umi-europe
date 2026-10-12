-- A product can have several documents per language, each with its own title
-- and PDF. Replaces the one-manual-per-language table.
CREATE TABLE documents (
  id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,                -- used in /f/{CODE}/{id}
  product_code  TEXT NOT NULL REFERENCES products(code) ON DELETE CASCADE,
  lang          TEXT NOT NULL CHECK (lang IN ('en','nl','fr','de')),
  title         TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),         -- shown on the scan page
  position      INTEGER NOT NULL,                                              -- order within product + language
  r2_key        TEXT NOT NULL,                                                 -- manuals/{CODE}/{uuid}.pdf
  original_name TEXT NOT NULL,                                                 -- filename as uploaded
  size_bytes    INTEGER NOT NULL,
  uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  uploaded_by   TEXT
);

CREATE INDEX documents_product_lang ON documents (product_code, lang, position);

-- Existing manuals become one document each, titled in their own language.
-- The manuals table stays for now, so the previous Worker version keeps working
-- until the new one is deployed. A later migration can drop it.
INSERT INTO documents (product_code, lang, title, position, r2_key, original_name, size_bytes, uploaded_at, uploaded_by)
SELECT product_code, lang,
       CASE lang WHEN 'nl' THEN 'Handleiding' WHEN 'fr' THEN 'Mode d’emploi' WHEN 'de' THEN 'Bedienungsanleitung' ELSE 'Manual' END,
       1, r2_key, original_name, size_bytes, uploaded_at, uploaded_by
FROM manuals;
