import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { Env } from "./config";
import { Db } from "./db";
import { b64url } from "./password";

export const DEV_EMAIL = "dev@localhost";

const jwksCache = new Map<string, JWTVerifyGetKey>();

function remoteJwks(teamDomain: string): JWTVerifyGetKey {
  let jwks = jwksCache.get(teamDomain);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`));
    jwksCache.set(teamDomain, jwks);
  }
  return jwks;
}

// ---------- Account login ----------
// Email + password accounts (users table). A successful login sets a signed
// session cookie. With SESSION_SECRET unset, all of this is inert and only
// Access logins work.

export const SESSION_COOKIE = "__Host-umi_session";
export const SESSION_MAX_AGE = 7 * 24 * 60 * 60;

const enc = new TextEncoder();

export function accountsEnabled(env: Env): boolean {
  return Boolean(env.SESSION_SECRET);
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(text)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function sign(data: string, env: Env): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(`umi-session:${env.SESSION_SECRET}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

/**
 * Identifies the account's current password. Stored in the session, so a
 * password change ends all earlier sessions without comparing clocks.
 */
export async function passwordVersion(passwordHash: string): Promise<string> {
  return (await sha256Hex(`pv:${passwordHash}`)).slice(0, 16);
}

/** Cookie value: "<email b64url>.<password version>.<issued-at seconds>.<signature b64url>". */
export async function createSession(email: string, version: string, env: Env, now = Date.now()): Promise<string> {
  const data = `${b64url(enc.encode(email))}.${version}.${Math.floor(now / 1000)}`;
  return `${data}.${b64url(await sign(data, env))}`;
}

export function sessionCookie(value: string): string {
  return `${SESSION_COOKIE}=${value}; Path=/; Max-Age=${SESSION_MAX_AGE}; HttpOnly; Secure; SameSite=Lax`;
}
export const CLEAR_SESSION_COOKIE = `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;

function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/** Checks the cookie's signature and age. Returns its email and password version, or null. */
export async function readSession(
  request: Request,
  env: Env,
  now = Date.now(),
): Promise<{ email: string; version: string } | null> {
  if (!accountsEnabled(env)) return null;
  const parts = readCookie(request, SESSION_COOKIE)?.split(".");
  if (!parts || parts.length !== 4) return null;
  const [emailPart, version, iat, sig] = parts;

  const expected = b64url(await sign(`${emailPart}.${version}.${iat}`, env));
  // Compare digests so the comparison is constant-time regardless of length.
  const [a, b] = await Promise.all([sha256Hex(sig), sha256Hex(expected)]);
  if (!crypto.subtle.timingSafeEqual(enc.encode(a), enc.encode(b))) return null;

  const issuedAt = Number(iat);
  if (!Number.isInteger(issuedAt) || issuedAt + SESSION_MAX_AGE <= now / 1000) return null;
  try {
    const email = new TextDecoder().decode(Uint8Array.from(
      atob(emailPart.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0),
    ));
    return { email, version };
  } catch {
    return null;
  }
}

/**
 * A valid session whose account still exists and whose password hasn't
 * changed since it was issued. A password reset therefore logs out every
 * other session of that account.
 */
export async function accountLogin(request: Request, env: Env): Promise<string | null> {
  const session = await readSession(request, env);
  if (!session) return null;
  const user = await Db.from(env).getUser(session.email);
  if (!user || (await passwordVersion(user.password_hash)) !== session.version) return null;
  return user.email;
}

/**
 * Returns the logged-in email, or null if the request isn't authenticated.
 *
 * Verifies the Cloudflare Access JWT even though Access already sits in front of
 * /admin and /api, so a misconfigured Access policy can't expose the admin.
 * The bypass applies only when ENVIRONMENT is exactly "development".
 */
export async function authenticate(
  request: Request,
  env: Env,
  getKey: JWTVerifyGetKey = remoteJwks(env.ACCESS_TEAM_DOMAIN || "invalid.local"),
): Promise<string | null> {
  if (env.ENVIRONMENT === "development") return DEV_EMAIL;

  const account = await accountLogin(request, env);
  if (account) return account;

  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token || !env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return null;

  try {
    const { payload } = await jwtVerify(token, getKey, {
      issuer: `https://${env.ACCESS_TEAM_DOMAIN}`,
      audience: env.ACCESS_AUD,
    });
    return typeof payload.email === "string" ? payload.email : null;
  } catch {
    return null;
  }
}
