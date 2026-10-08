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

async function sha256(text: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
}

/**
 * Staging login used until Cloudflare Access is set up: HTTP Basic auth against
 * the STAGING_PASSWORD secret. Any username is accepted and recorded as the
 * uploader. Returns null when the secret is unset, so production is unaffected.
 */
export async function stagingLogin(request: Request, env: Env): Promise<string | null> {
  if (!env.STAGING_PASSWORD) return null;
  const header = request.headers.get("Authorization");
  if (!header?.startsWith("Basic ")) return null;

  let decoded: string;
  try {
    decoded = atob(header.slice(6));
  } catch {
    return null;
  }
  const sep = decoded.indexOf(":");
  if (sep < 0) return null;
  const user = decoded.slice(0, sep).trim();
  const password = decoded.slice(sep + 1);

  // Compare digests so the comparison is constant-time regardless of length.
  const [given, expected] = await Promise.all([sha256(password), sha256(env.STAGING_PASSWORD)]);
  if (!crypto.subtle.timingSafeEqual(given, expected)) return null;
  return user || "staging";
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
