import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import type { Env } from "../src/config";
import { Db } from "../src/db";
import { deleteObjects, putManual } from "../src/storage";

const e = env as unknown as Env;
const db = Db.from(e);

// Tests share the Neon dev branch, so every product gets a unique code and is cleaned up.
const created: string[] = [];
function testCode(): string {
  const code = `TEST-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  created.push(code);
  return code;
}

afterEach(async () => {
  for (const code of created.splice(0)) await db.deleteProduct(code);
});

const PDF = new TextEncoder().encode("%PDF-1.4\n%test\n");

describe("db: products", () => {
  it("creates, reads, renames and deletes a product", async () => {
    const code = testCode();
    expect(await db.createProduct(code, "Test product")).toBe(true);

    const p = await db.getProduct(code);
    expect(p).toMatchObject({ code, name: "Test product", manuals: [] });

    expect(await db.updateProductName(code, "Renamed")).toBe(true);
    expect((await db.getProduct(code))?.name).toBe("Renamed");

    expect(await db.deleteProduct(code)).toEqual([]);
    expect(await db.getProduct(code)).toBeNull();
  });

  it("refuses a duplicate code", async () => {
    const code = testCode();
    expect(await db.createProduct(code, "A")).toBe(true);
    expect(await db.createProduct(code, "B")).toBe(false);
    expect((await db.getProduct(code))?.name).toBe("A");
  });

  it("rejects an invalid code at the database level", async () => {
    await expect(db.createProduct("lower-case", "X")).rejects.toThrow();
  });

  it("reports missing products", async () => {
    expect(await db.updateProductName("TEST-NOPE", "X")).toBe(false);
    expect(await db.deleteProduct("TEST-NOPE")).toBeNull();
  });

  it("searches by code or name, case-insensitively", async () => {
    const code = testCode();
    await db.createProduct(code, "Searchable widget");
    expect((await db.listProducts(code.toLowerCase())).map((p) => p.code)).toContain(code);
    expect((await db.listProducts("SEARCHABLE WID")).map((p) => p.code)).toContain(code);
    expect((await db.listProducts("100%_no_match")).map((p) => p.code)).not.toContain(code);
  });
});

describe("db: manuals", () => {
  it("adds, replaces and removes a manual, returning the keys to clean up", async () => {
    const code = testCode();
    await db.createProduct(code, "Manual test");

    const first = { r2_key: "k1", original_name: "a.pdf", size_bytes: 10, uploaded_by: "a@x.com" };
    expect(await db.upsertManual(code, "nl", first)).toBeNull();

    const second = { r2_key: "k2", original_name: "b.pdf", size_bytes: 20, uploaded_by: "b@x.com" };
    expect(await db.upsertManual(code, "nl", second)).toBe("k1");

    const m = await db.getManual(code, "nl");
    expect(m).toMatchObject({ lang: "nl", r2_key: "k2", original_name: "b.pdf", size_bytes: 20 });

    const p = await db.getProduct(code);
    expect(p?.manuals.map((x) => x.lang)).toEqual(["nl"]);

    expect(await db.deleteManual(code, "nl")).toBe("k2");
    expect(await db.deleteManual(code, "nl")).toBeNull();
  });

  it("returns all manual keys when a product is deleted", async () => {
    const code = testCode();
    await db.createProduct(code, "Cascade");
    await db.upsertManual(code, "en", { r2_key: "ke", original_name: "e.pdf", size_bytes: 1, uploaded_by: null });
    await db.upsertManual(code, "de", { r2_key: "kd", original_name: "d.pdf", size_bytes: 1, uploaded_by: null });
    expect((await db.deleteProduct(code))?.sort()).toEqual(["kd", "ke"]);
    expect(await db.getManual(code, "en")).toBeNull();
  });

  it("refuses a manual for a product that doesn't exist", async () => {
    await expect(
      db.upsertManual("TEST-NOPE", "en", { r2_key: "k", original_name: "x.pdf", size_bytes: 1, uploaded_by: null }),
    ).rejects.toThrow();
  });
});

describe("storage", () => {
  it("stores each upload under a new key and deletes objects", async () => {
    const a = await putManual(e.MANUALS, "X200", "en", PDF);
    const b = await putManual(e.MANUALS, "X200", "en", PDF);
    expect(a.key).toMatch(/^manuals\/X200\/en\/[0-9a-f-]{36}\.pdf$/);
    expect(a.key).not.toBe(b.key);
    expect(a.size).toBe(PDF.byteLength);

    const obj = await e.MANUALS.get(a.key);
    expect(obj?.httpMetadata?.contentType).toBe("application/pdf");
    await obj?.arrayBuffer();

    await deleteObjects(e.MANUALS, [a.key, b.key]);
    expect(await e.MANUALS.head(a.key)).toBeNull();
    expect(await e.MANUALS.head(b.key)).toBeNull();
  });
});
