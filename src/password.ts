// Password hashing with PBKDF2-SHA256 (Web Crypto, so it runs in Workers and Node).
// Format: "pbkdf2-sha256$<iterations>$<salt b64url>$<hash b64url>".
// scripts/add-user.mjs implements the same format; test/password.test.ts pins it.

// Workers cap PBKDF2 at 100,000 iterations.
export const PBKDF2_ITERATIONS = 100_000;
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 200;

const enc = new TextEncoder();

export function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

export async function hashPassword(password: string, iterations = PBKDF2_ITERATIONS): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2-sha256$${iterations}$${b64url(salt)}$${b64url(await derive(password, salt, iterations))}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iter, salt, hash] = stored.split("$");
  const iterations = Number(iter);
  if (scheme !== "pbkdf2-sha256" || !Number.isInteger(iterations) || iterations < 1 || iterations > PBKDF2_ITERATIONS) {
    return false;
  }
  try {
    const expected = fromB64url(hash);
    const actual = await derive(password, fromB64url(salt), iterations);
    return actual.length === expected.length && crypto.subtle.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/**
 * Checked against when the email has no account, so a login takes the same
 * time whether or not the account exists.
 */
export const DUMMY_HASH = "pbkdf2-sha256$100000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

export function passwordProblem(password: string): string | null {
  if (password.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`;
  if (password.length > PASSWORD_MAX) return `Use at most ${PASSWORD_MAX} characters.`;
  return null;
}

export function normalizeEmail(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
