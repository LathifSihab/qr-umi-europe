import { Hono } from "hono";
import {
  DOCUMENT_TITLE_MAX,
  LANGUAGES,
  MAX_UPLOAD_BYTES,
  PRODUCT_CODE_RE,
  PRODUCT_NAME_MAX,
  isLang,
  normalizeCode,
  type Env,
} from "../config";
import { afterResponse } from "../background";
import { Db, type Document, type NameTranslations, type Product } from "../db";
import { qrSvg, shortUrl } from "../qr";
import { deleteObjects, putDocument } from "../storage";

type AppEnv = { Bindings: Env; Variables: { email: string } };

export const apiRoutes = new Hono<AppEnv>();

class ApiError extends Error {
  constructor(
    public status: 400 | 404 | 409 | 413 | 500,
    message: string,
  ) {
    super(message);
  }
}

apiRoutes.onError((err, c) => {
  if (err instanceof ApiError) return c.json({ error: err.message }, err.status);
  console.error(err);
  return c.json({ error: "Something went wrong on the server. Try again in a minute." }, 500);
});

apiRoutes.notFound((c) => c.json({ error: "Not found." }, 404));

// Admin responses must never be cached.
apiRoutes.use("*", async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
});

/** Public shape of a document: R2 keys stay internal. */
function presentDocument({ r2_key: _key, ...d }: Document) {
  return d;
}

function present(p: Product, env: Env) {
  return {
    code: p.code,
    name: p.name,
    name_translations: p.name_translations,
    short_url: shortUrl(env.PUBLIC_BASE_URL, p.code),
    created_at: p.created_at,
    updated_at: p.updated_at,
    documents: p.documents.map(presentDocument),
  };
}

function cleanName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name) throw new ApiError(400, "Enter a product name.");
  if (name.length > PRODUCT_NAME_MAX) throw new ApiError(400, `Keep the product name under ${PRODUCT_NAME_MAX} characters.`);
  return name;
}

/** { lang: name } for the scan page. Blank names are dropped, so that language uses the product name. */
function cleanTranslations(value: unknown): NameTranslations {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "name_translations must be an object of language code to name.");
  }
  const out: NameTranslations = {};
  for (const [lang, raw] of Object.entries(value)) {
    const l = langParam(lang);
    if (raw !== null && typeof raw !== "string") throw new ApiError(400, `The ${l} name must be text.`);
    const name = (raw ?? "").trim();
    if (name.length > PRODUCT_NAME_MAX) {
      throw new ApiError(400, `Keep the ${LANGUAGES.find((x) => x.code === l)!.english} name under ${PRODUCT_NAME_MAX} characters.`);
    }
    if (name) out[l] = name;
  }
  return out;
}

function cleanTitle(value: unknown): string {
  const title = typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim() : "";
  if (!title) throw new ApiError(400, "Enter a title for the document.");
  if (title.length > DOCUMENT_TITLE_MAX) throw new ApiError(400, `Keep the title under ${DOCUMENT_TITLE_MAX} characters.`);
  return title;
}

/** Decodes a URI-encoded request header (non-ASCII text can't go in a header as is). */
function decodedHeader(value: string | undefined): string {
  try {
    return decodeURIComponent(value ?? "");
  } catch {
    return value ?? "";
  }
}

function documentId(value: string): number {
  if (!/^\d{1,9}$/.test(value)) throw documentGone();
  return Number(value);
}

function documentGone() {
  return new ApiError(404, "This document doesn't exist. It may have been removed.");
}

function productGone() {
  return new ApiError(404, "This product doesn't exist. It may have been deleted.");
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json();
    if (body && typeof body === "object") return body as Record<string, unknown>;
  } catch {}
  throw new ApiError(400, "The request body must be JSON.");
}

function langParam(value: string) {
  const lang = value.toLowerCase();
  if (!isLang(lang)) {
    throw new ApiError(400, `Unknown language. Use one of: ${LANGUAGES.map((l) => l.code).join(", ")}.`);
  }
  return lang;
}

async function requireProduct(db: Db, code: string): Promise<Product> {
  const product = await db.getProduct(normalizeCode(code));
  if (!product) throw productGone();
  return product;
}

/** Reads a request body into memory, failing fast once it exceeds `max` bytes. */
async function readLimited(body: ReadableStream<Uint8Array>, max: number): Promise<Uint8Array[]> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return chunks;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
}

function tooLarge() {
  return new ApiError(413, `This file is larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB. Upload a smaller PDF.`);
}

function startsWithPdfMagic(chunks: Uint8Array[]): boolean {
  const magic = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"
  const head: number[] = [];
  for (const chunk of chunks) {
    for (const byte of chunk) {
      head.push(byte);
      if (head.length === magic.length) return head.every((b, i) => b === magic[i]);
    }
  }
  return false;
}

function cleanFilename(header: string | undefined, code: string): string {
  const name = decodedHeader(header).replace(/[\u0000-\u001f\u007f]/g, "").replace(/^.*[\\/]/, "").trim().slice(0, 255);
  return name || `${code}.pdf`;
}

/** Reads and checks the uploaded PDF, then stores it in R2 under a fresh key. */
async function storeUpload(c: { req: { raw: Request; header(name: string): string | undefined }; env: Env }, code: string) {
  const declared = Number(c.req.header("Content-Length") ?? "0");
  if (declared > MAX_UPLOAD_BYTES) throw tooLarge();
  if (!c.req.raw.body) throw new ApiError(400, "No file received. Choose a PDF and try again.");

  const chunks = await readLimited(c.req.raw.body, MAX_UPLOAD_BYTES);
  if (!startsWithPdfMagic(chunks)) throw new ApiError(400, "This file isn't a PDF. Upload a .pdf file.");
  return putDocument(c.env.MANUALS, code, new Blob(chunks));
}

apiRoutes.get("/me", (c) => c.json({
  email: c.get("email"),
  public_base_url: c.env.PUBLIC_BASE_URL,
  environment: c.env.ENVIRONMENT,
  languages: LANGUAGES,
  max_upload_bytes: MAX_UPLOAD_BYTES,
  can_log_out: Boolean(c.env.SESSION_SECRET),
}));

apiRoutes.get("/products", async (c) => {
  const products = await Db.from(c.env).listProducts(c.req.query("q"));
  return c.json({ products: products.map((p) => present(p, c.env)) });
});

apiRoutes.post("/products", async (c) => {
  const body = await readJson(c.req.raw);
  const code = normalizeCode(typeof body.code === "string" ? body.code : "");
  if (!code) throw new ApiError(400, "Enter a product code.");
  if (!PRODUCT_CODE_RE.test(code)) {
    throw new ApiError(400, "Use 2 to 32 characters: letters, numbers and dashes, starting with a letter or number.");
  }
  const name = cleanName(body.name);
  const db = Db.from(c.env);
  if (!(await db.createProduct(code, name))) throw new ApiError(409, `A product with code ${code} already exists.`);
  return c.json({ product: present((await db.getProduct(code))!, c.env) }, 201);
});

apiRoutes.get("/products/:code", async (c) => {
  return c.json({ product: present(await requireProduct(Db.from(c.env), c.req.param("code")), c.env) });
});

apiRoutes.patch("/products/:code", async (c) => {
  const db = Db.from(c.env);
  const code = normalizeCode(c.req.param("code"));
  const body = await readJson(c.req.raw);
  if (body.name === undefined && body.name_translations === undefined) throw new ApiError(400, "Enter a product name.");
  const name = body.name === undefined ? undefined : cleanName(body.name);
  const translations = body.name_translations === undefined ? undefined : cleanTranslations(body.name_translations);
  if (!(await db.updateProductName(code, { name, translations }))) throw productGone();
  return c.json({ product: present((await db.getProduct(code))!, c.env) });
});

apiRoutes.delete("/products/:code", async (c) => {
  const keys = await Db.from(c.env).deleteProduct(normalizeCode(c.req.param("code")));
  if (keys === null) throw productGone();
  await afterResponse(c, deleteObjects(c.env.MANUALS, keys));
  return c.json({ deleted: true });
});

// ---------- documents ----------
// Uploads store the new R2 object first, then point the database at it, then
// remove any old object. A missing product or document is reported by the
// same round trip that saves, so there's no separate existence check.

apiRoutes.post("/products/:code/documents", async (c) => {
  const db = Db.from(c.env);
  const code = normalizeCode(c.req.param("code"));
  const lang = langParam(c.req.query("lang") ?? "");
  const title = cleanTitle(decodedHeader(c.req.header("X-Title")));

  const { key, size } = await storeUpload(c, code);
  let document: Document | null;
  try {
    document = await db.createDocument(code, lang, title, {
      r2_key: key,
      original_name: cleanFilename(c.req.header("X-Filename"), code),
      size_bytes: size,
      uploaded_by: c.get("email"),
    });
  } catch (err) {
    await afterResponse(c, deleteObjects(c.env.MANUALS, [key]));
    throw err;
  }
  if (!document) {
    await afterResponse(c, deleteObjects(c.env.MANUALS, [key]));
    throw productGone();
  }
  return c.json({ document: presentDocument(document) }, 201);
});

// Registered before "/:id" routes so "order" isn't read as an id.
apiRoutes.put("/products/:code/documents/order", async (c) => {
  const code = normalizeCode(c.req.param("code"));
  const body = await readJson(c.req.raw);
  const lang = langParam(typeof body.lang === "string" ? body.lang : "");
  const ids = Array.isArray(body.ids) ? body.ids : null;
  if (!ids || !ids.every((id) => Number.isInteger(id) && id > 0 && id < 1e9)) {
    throw new ApiError(400, "Send the document ids in their new order.");
  }
  const documents = await Db.from(c.env).reorderDocuments(code, lang, ids as number[]);
  return c.json({ documents: documents.map(presentDocument) });
});

apiRoutes.patch("/products/:code/documents/:id", async (c) => {
  const code = normalizeCode(c.req.param("code"));
  const id = documentId(c.req.param("id"));
  const title = cleanTitle((await readJson(c.req.raw)).title);
  const document = await Db.from(c.env).updateDocumentTitle(code, id, title);
  if (!document) throw documentGone();
  return c.json({ document: presentDocument(document) });
});

apiRoutes.put("/products/:code/documents/:id/file", async (c) => {
  const db = Db.from(c.env);
  const code = normalizeCode(c.req.param("code"));
  const id = documentId(c.req.param("id"));

  const { key, size } = await storeUpload(c, code);
  let saved: Awaited<ReturnType<Db["replaceDocumentFile"]>>;
  try {
    saved = await db.replaceDocumentFile(code, id, {
      r2_key: key,
      original_name: cleanFilename(c.req.header("X-Filename"), code),
      size_bytes: size,
      uploaded_by: c.get("email"),
    });
  } catch (err) {
    await afterResponse(c, deleteObjects(c.env.MANUALS, [key]));
    throw err;
  }
  if (!saved) {
    await afterResponse(c, deleteObjects(c.env.MANUALS, [key]));
    throw documentGone();
  }
  await afterResponse(c, deleteObjects(c.env.MANUALS, [saved.oldKey]));
  return c.json({ document: presentDocument(saved.document) });
});

apiRoutes.delete("/products/:code/documents/:id", async (c) => {
  const code = normalizeCode(c.req.param("code"));
  const key = await Db.from(c.env).deleteDocument(code, documentId(c.req.param("id")));
  if (!key) throw documentGone();
  await afterResponse(c, deleteObjects(c.env.MANUALS, [key]));
  return c.json({ deleted: true });
});


apiRoutes.get("/products/:code/qr.svg", async (c) => {
  const { code } = await requireProduct(Db.from(c.env), c.req.param("code"));
  const headers: Record<string, string> = { "Content-Type": "image/svg+xml" };
  if (c.req.query("download") !== undefined) {
    headers["Content-Disposition"] = `attachment; filename="UMI-QR-${code}.svg"`;
  }
  return c.body(qrSvg(shortUrl(c.env.PUBLIC_BASE_URL, code)), 200, headers);
});
