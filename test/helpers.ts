import { env } from "cloudflare:workers";
import type { Env } from "../src/config";
import { Db } from "../src/db";
import app from "../src/index";

export const baseEnv = env as unknown as Env;
export const devEnv: Env = { ...baseEnv, ENVIRONMENT: "development", PUBLIC_BASE_URL: "https://qr.example.com" };
export const prodEnv: Env = {
  ...baseEnv,
  ENVIRONMENT: "production",
  PUBLIC_BASE_URL: "https://qr.example.com",
  ACCESS_TEAM_DOMAIN: "team.example.com",
  ACCESS_AUD: "test-aud",
};
export const db = Db.from(baseEnv);

/** Calls the Worker directly with a chosen environment. */
export function call(path: string, init: RequestInit = {}, e: Env = devEnv): Promise<Response> {
  return app.fetch(new Request(`http://localhost${path}`, init), e) as Promise<Response>;
}

// Tests share the Neon dev branch, so every product gets a unique code and is cleaned up.
const created: string[] = [];
export function testCode(): string {
  const code = `TEST-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  created.push(code);
  return code;
}
export async function cleanup(): Promise<void> {
  for (const code of created.splice(0)) {
    const keys = await db.deleteProduct(code);
    if (keys?.length) await baseEnv.MANUALS.delete(keys);
  }
}

export function pdf(text = "hello"): Uint8Array {
  return new TextEncoder().encode(`%PDF-1.4\n% ${text}\n`);
}

export async function createWithManuals(langs: string[]): Promise<string> {
  const code = testCode();
  await db.createProduct(code, "Test Product");
  for (const lang of langs) {
    const res = await call(`/api/products/${code}/manuals/${lang}`, {
      method: "PUT",
      headers: { "Content-Type": "application/pdf", "X-Filename": `${lang}.pdf` },
      body: pdf(lang),
    });
    if (res.status !== 200) throw new Error(`upload failed: ${res.status} ${await res.text()}`);
  }
  return code;
}

export async function r2Keys(prefix: string): Promise<string[]> {
  return (await baseEnv.MANUALS.list({ prefix })).objects.map((o) => o.key);
}
