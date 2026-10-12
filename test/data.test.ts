import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import type { Env } from "../src/config";
import { Db } from "../src/db";
import { deleteObjects, putDocument } from "../src/storage";

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
    expect(p).toMatchObject({ code, name: "Test product", documents: [] });

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

describe("db: documents", () => {
  const file = (key: string) => ({ r2_key: key, original_name: `${key}.pdf`, size_bytes: 10, uploaded_by: "a@x.com" });

  it("adds documents per language in order, renames, replaces and removes them", async () => {
    const code = testCode();
    await db.createProduct(code, "Document test");

    const a = (await db.createDocument(code, "nl", "Handleiding", file("k1")))!;
    const b = (await db.createDocument(code, "nl", "Veiligheid", file("k2")))!;
    const c = (await db.createDocument(code, "en", "Manual", file("k3")))!;
    expect([a.position, b.position, c.position]).toEqual([1, 2, 1]);
    expect(a).toMatchObject({ lang: "nl", title: "Handleiding", r2_key: "k1", original_name: "k1.pdf", size_bytes: 10 });

    const p = (await db.getProduct(code))!;
    expect(p.documents.map((d) => d.title)).toEqual(["Manual", "Handleiding", "Veiligheid"]);
    expect(p.documents[1]).toEqual(a);

    expect((await db.updateDocumentTitle(code, a.id, "Gebruiksaanwijzing"))?.title).toBe("Gebruiksaanwijzing");

    const replaced = (await db.replaceDocumentFile(code, a.id, { ...file("k4"), original_name: "new.pdf" }))!;
    expect(replaced.oldKey).toBe("k1");
    expect(replaced.document).toMatchObject({ id: a.id, title: "Gebruiksaanwijzing", r2_key: "k4", original_name: "new.pdf", position: 1 });
    expect(await db.getDocument(code, a.id)).toEqual(replaced.document);

    expect(await db.deleteDocument(code, a.id)).toBe("k4");
    expect(await db.deleteDocument(code, a.id)).toBeNull();
    expect(await db.getDocument(code, a.id)).toBeNull();
  });

  it("reorders one language without touching the others", async () => {
    const code = testCode();
    await db.createProduct(code, "Order");
    const ids: number[] = [];
    for (const k of ["a", "b", "c"]) ids.push((await db.createDocument(code, "de", k, file(k)))!.id);
    const en = (await db.createDocument(code, "en", "e", file("e")))!;

    const order = await db.reorderDocuments(code, "de", [ids[2], ids[0]]);
    // Listed ids first, then the rest in their old order.
    expect(order.map((d) => d.title)).toEqual(["c", "a", "b"]);
    expect(order.map((d) => d.position)).toEqual([1, 2, 3]);
    expect((await db.getDocument(code, en.id))?.position).toBe(1);
    // Ids of another product or language are ignored.
    expect((await db.reorderDocuments(code, "de", [en.id, ids[1]])).map((d) => d.title)).toEqual(["b", "c", "a"]);
  });

  it("only finds a document through its own product", async () => {
    const code = testCode();
    const other = testCode();
    await db.createProduct(code, "One");
    await db.createProduct(other, "Two");
    const d = (await db.createDocument(code, "en", "Manual", file("k")))!;
    expect(await db.getDocument(other, d.id)).toBeNull();
    expect(await db.updateDocumentTitle(other, d.id, "X")).toBeNull();
    expect(await db.replaceDocumentFile(other, d.id, file("k2"))).toBeNull();
    expect(await db.deleteDocument(other, d.id)).toBeNull();
    expect((await db.getDocument(code, d.id))?.title).toBe("Manual");
  });

  it("returns all document keys when a product is deleted", async () => {
    const code = testCode();
    await db.createProduct(code, "Cascade");
    await db.createDocument(code, "en", "One", file("ke"));
    await db.createDocument(code, "en", "Two", file("kd"));
    expect((await db.deleteProduct(code))?.sort()).toEqual(["kd", "ke"]);
  });

  it("refuses a document for a product that doesn't exist", async () => {
    expect(await db.createDocument("TEST-NOPE", "en", "X", file("k"))).toBeNull();
  });
});

describe("storage", () => {
  it("stores each upload under a new key and deletes objects", async () => {
    const a = await putDocument(e.MANUALS, "X200", PDF);
    const b = await putDocument(e.MANUALS, "X200", PDF);
    expect(a.key).toMatch(/^manuals\/X200\/[0-9a-f-]{36}\.pdf$/);
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
