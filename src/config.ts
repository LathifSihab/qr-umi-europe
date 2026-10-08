export interface Env {
  MANUALS: R2Bucket;
  DATABASE_URL: string;
  ENVIRONMENT: string;
  PUBLIC_BASE_URL: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
}

/**
 * Manual languages, in default display order. Adding a language means adding a
 * row here plus a migration that updates the CHECK constraint on manuals.lang.
 */
export const LANGUAGES = [
  { code: "en", label: "English", english: "English" },
  { code: "nl", label: "Nederlands", english: "Dutch" },
  { code: "fr", label: "Français", english: "French" },
  { code: "de", label: "Deutsch", english: "German" },
] as const;

export type Lang = (typeof LANGUAGES)[number]["code"];

export function isLang(value: string): value is Lang {
  return LANGUAGES.some((l) => l.code === value);
}

export const PRODUCT_CODE_RE = /^[A-Z0-9][A-Z0-9-]{1,31}$/;
export const PRODUCT_NAME_MAX = 200;
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

export function normalizeCode(code: string): string {
  return code.trim().toUpperCase();
}
