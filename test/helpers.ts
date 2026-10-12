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
const users: string[] = [];
export function testEmail(): string {
  const email = `test-${crypto.randomUUID().slice(0, 8)}@example.com`;
  users.push(email);
  return email;
}

export async function cleanup(): Promise<void> {
  for (const code of created.splice(0)) {
    const keys = await db.deleteProduct(code);
    if (keys?.length) await baseEnv.MANUALS.delete(keys);
  }
  for (const email of users.splice(0)) await db.deleteUser(email);
}

export function pdf(text = "hello"): Uint8Array {
  return new TextEncoder().encode(`%PDF-1.4\n% ${text}\n`);
}

/** Uploads a document through the API. Returns the response. */
export function addDocument(code: string, lang: string, title: string, body: BodyInit = pdf(`${lang} ${title}`), filename = "doc.pdf") {
  return call(`/api/products/${code}/documents?lang=${lang}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/pdf",
      "X-Title": encodeURIComponent(title),
      "X-Filename": encodeURIComponent(filename),
    },
    body,
  });
}

/**
 * A product with one document per entry, added in order: "nl" or ["nl", "Title"].
 * Each PDF contains its language and title. Returns the code and document ids.
 */
export async function createWithDocuments(docs: (string | [string, string])[]): Promise<{ code: string; ids: number[] }> {
  const code = testCode();
  await db.createProduct(code, "Test Product");
  const ids: number[] = [];
  for (const d of docs) {
    const [lang, title] = typeof d === "string" ? [d, `Manual ${d}`] : d;
    const res = await addDocument(code, lang, title);
    if (res.status !== 201) throw new Error(`upload failed: ${res.status} ${await res.text()}`);
    ids.push(((await res.json()) as any).document.id);
  }
  return { code, ids };
}

export async function r2Keys(prefix: string): Promise<string[]> {
  return (await baseEnv.MANUALS.list({ prefix })).objects.map((o) => o.key);
}
