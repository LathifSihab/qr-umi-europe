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
