import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { Env } from "./config";

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

// ---------- Staging login ----------
// Used until Cloudflare Access is set up: a login page checks the STAGING_PASSWORD
// secret and sets a signed session cookie. With the secret unset, all of this is
// inert and only Access logins work.

export const SESSION_COOKIE = "__Host-umi_session";
const SESSION_DAYS = 7;
export const SESSION_MAX_AGE = SESSION_DAYS * 24 * 60 * 60;
export const NAME_MAX = 100;

const enc = new TextEncoder();

async function sha256(text: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", enc.encode(text));
}

/** Constant-time password check (digests make the lengths equal). */
export async function checkStagingPassword(password: string, env: Env): Promise<boolean> {
  if (!env.STAGING_PASSWORD) return false;
  const [given, expected] = await Promise.all([sha256(password), sha256(env.STAGING_PASSWORD)]);
  return crypto.subtle.timingSafeEqual(given, expected);
}

// Sessions are signed with the password itself, so changing the password logs everyone out.
async function sign(data: string, env: Env): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(`umi-session:${env.STAGING_PASSWORD}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
  return btoa(String.fromCharCode(...mac)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Cookie value: "<name>|<expiry seconds>|<signature>", with the name URI-encoded. */
export async function createSession(name: string, env: Env, now = Date.now()): Promise<string> {
  const data = `${encodeURIComponent(name)}|${Math.floor(now / 1000) + SESSION_MAX_AGE}`;
  return `${data}|${await sign(data, env)}`;
}

function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/** Returns the session's name, or null without a valid, unexpired session. */
export async function stagingLogin(request: Request, env: Env, now = Date.now()): Promise<string | null> {
  if (!env.STAGING_PASSWORD) return null;
  const value = readCookie(request, SESSION_COOKIE);
  const parts = value?.split("|");
  if (!parts || parts.length !== 3) return null;
  const [name, exp, sig] = parts;

  const expected = await sign(`${name}|${exp}`, env);
  const [a, b] = await Promise.all([sha256(sig), sha256(expected)]);
  if (!crypto.subtle.timingSafeEqual(a, b)) return null;
  if (!(Number(exp) > now / 1000)) return null;
  try {
    return decodeURIComponent(name);
  } catch {
    return null;
  }
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

  const staging = await stagingLogin(request, env);
  if (staging) return staging;

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
