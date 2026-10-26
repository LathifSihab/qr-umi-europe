-- Optional product name per language, e.g. {"nl": "Mini fietspomp", "de": "Mini-Fahrradpumpe"}.
-- The scan page uses the visitor's language when it has an entry, else products.name.
ALTER TABLE products
  ADD COLUMN name_translations JSONB NOT NULL DEFAULT '{}'
  CHECK (jsonb_typeof(name_translations) = 'object');
