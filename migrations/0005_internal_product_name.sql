-- products.name is now an internal label, never shown to visitors. The scan page
-- shows name_translations only. So existing scan pages keep the name they show
-- today, copy the current name into every language that has no name of its own.
UPDATE products
SET name_translations =
  jsonb_build_object('en', name, 'nl', name, 'fr', name, 'de', name) || name_translations;
