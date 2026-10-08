import { Hono } from "hono";
import {
  LANGUAGES,
  MAX_UPLOAD_BYTES,
  PRODUCT_CODE_RE,
  PRODUCT_NAME_MAX,
  isLang,
  normalizeCode,
  type Env,
} from "../config";
import { Db, type Product } from "../db";
import { qrSvg, shortUrl } from "../qr";
import { deleteObjects, putManual } from "../storage";

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

/** Public shape of a product: R2 keys stay internal. */
function present(p: Product, env: Env) {
  return {
    code: p.code,
    name: p.name,
    short_url: shortUrl(env.PUBLIC_BASE_URL, p.code),
    created_at: p.created_at,
    updated_at: p.updated_at,
    manuals: p.manuals.map(({ r2_key: _key, ...m }) => m),
  };
}

function cleanName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name) throw new ApiError(400, "Enter a product name.");
  if (name.length > PRODUCT_NAME_MAX) throw new ApiError(400, `Keep the product name under ${PRODUCT_NAME_MAX} characters.`);
  return name;
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json();
    if (body && typeof body === "object") return body as Record<string, unknown>;
  } catch {}
  throw new ApiError(400, "The request body must be JSON.");
}

/**
 * Runs cleanup after the response is sent, so the admin doesn't wait for it.
 * Falls back to awaiting when there's no execution context (tests).
 */
type WaitUntil = { waitUntil(promise: Promise<unknown>): void };

async function afterResponse(c: { executionCtx: WaitUntil }, task: Promise<unknown>): Promise<void> {
  let ctx: WaitUntil | undefined;
  try {
    ctx = c.executionCtx;
  } catch {}
  if (ctx) ctx.waitUntil(task.catch((err) => console.error("background cleanup failed", err)));
  else await task;
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
  if (!product) throw new ApiError(404, "This product doesn't exist. It may have been deleted.");
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

function cleanFilename(header: string | undefined, code: string, lang: string): string {
  let name = "";
  try {
    name = decodeURIComponent(header ?? "");
  } catch {
    name = header ?? "";
  }
  name = name.replace(/[\u0000-\u001f\u007f]/g, "").replace(/^.*[\\/]/, "").trim().slice(0, 255);
  return name || `${code}-${lang}.pdf`;
}

apiRoutes.get("/me", (c) => c.json({
  email: c.get("email"),
  public_base_url: c.env.PUBLIC_BASE_URL,
  environment: c.env.ENVIRONMENT,
  languages: LANGUAGES,
  max_upload_bytes: MAX_UPLOAD_BYTES,
  can_log_out: Boolean(c.env.STAGING_PASSWORD),
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
  const name = cleanName((await readJson(c.req.raw)).name);
  if (!(await db.updateProductName(code, name))) throw new ApiError(404, "This product doesn't exist. It may have been deleted.");
  return c.json({ product: present((await db.getProduct(code))!, c.env) });
});

apiRoutes.delete("/products/:code", async (c) => {
  const keys = await Db.from(c.env).deleteProduct(normalizeCode(c.req.param("code")));
  if (keys === null) throw new ApiError(404, "This product doesn't exist. It may have been deleted.");
  await afterResponse(c, deleteObjects(c.env.MANUALS, keys));
  return c.json({ deleted: true });
});

apiRoutes.put("/products/:code/manuals/:lang", async (c) => {
  // No separate existence check up front: upsertManual reports a missing
  // product in the same round trip that saves the manual.
  const db = Db.from(c.env);
  const code = normalizeCode(c.req.param("code"));
  const lang = langParam(c.req.param("lang"));

  const declared = Number(c.req.header("Content-Length") ?? "0");
  if (declared > MAX_UPLOAD_BYTES) throw tooLarge();
  if (!c.req.raw.body) throw new ApiError(400, "No file received. Choose a PDF and try again.");

  const chunks = await readLimited(c.req.raw.body, MAX_UPLOAD_BYTES);
  if (!startsWithPdfMagic(chunks)) throw new ApiError(400, "This file isn't a PDF. Upload a .pdf file.");

  // New object first, then point the database at it, then remove the old object.
  const { key, size } = await putManual(c.env.MANUALS, code, lang, new Blob(chunks));
  let saved: Awaited<ReturnType<Db["upsertManual"]>>;
  try {
    saved = await db.upsertManual(code, lang, {
      r2_key: key,
      original_name: cleanFilename(c.req.header("X-Filename"), code, lang),
      size_bytes: size,
      uploaded_by: c.get("email"),
    });
  } catch (err) {
    await afterResponse(c, deleteObjects(c.env.MANUALS, [key]));
    throw err;
  }
  if (!saved) {
    await afterResponse(c, deleteObjects(c.env.MANUALS, [key]));
    throw new ApiError(404, "This product doesn't exist. It may have been deleted.");
  }
  if (saved.oldKey) await afterResponse(c, deleteObjects(c.env.MANUALS, [saved.oldKey]));

  return c.json({ product: present(saved.product, c.env) });
});

apiRoutes.delete("/products/:code/manuals/:lang", async (c) => {
  const db = Db.from(c.env);
  const code = normalizeCode(c.req.param("code"));
  const lang = langParam(c.req.param("lang"));
  const key = await db.deleteManual(code, lang);
  if (!key) throw new ApiError(404, "There's no manual in this language to remove.");
  await afterResponse(c, deleteObjects(c.env.MANUALS, [key]));
  return c.json({ product: present((await requireProduct(db, code)), c.env) });
});

apiRoutes.get("/products/:code/qr.svg", async (c) => {
  const { code } = await requireProduct(Db.from(c.env), c.req.param("code"));
  const headers: Record<string, string> = { "Content-Type": "image/svg+xml" };
  if (c.req.query("download") !== undefined) {
    headers["Content-Disposition"] = `attachment; filename="UMI-QR-${code}.svg"`;
  }
  return c.body(qrSvg(shortUrl(c.env.PUBLIC_BASE_URL, code)), 200, headers);
});
