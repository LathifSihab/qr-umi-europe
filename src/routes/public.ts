import { Hono } from "hono";
import logo from "../../assets/umi-logo.svg";
import { PRODUCT_CODE_RE, isLang, normalizeCode, type Env } from "../config";
import { Db } from "../db";
import { documentsPage, notAvailablePage, pickLang } from "../views/scanPages";

export const publicRoutes = new Hono<{ Bindings: Env }>();

function notAvailable(request: Request, cacheControl: string): Response {
  return new Response(notAvailablePage(request.headers.get("Accept-Language")), {
    status: 404,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": cacheControl },
  });
}

publicRoutes.get("/", (c) => c.redirect("https://umi-europe.com", 302));

// Vector logo traced from the PNG on umi-europe.com (assets/umi-logo.png is the source).
publicRoutes.get("/assets/umi-logo.svg", () =>
  new Response(logo, {
    headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" },
  }),
);

// The URL inside every printed QR code. Always 302 + no-store, never 301, so
// changes to the documents take effect immediately for already-printed codes.
publicRoutes.get("/m/:code", async (c) => {
  const code = normalizeCode(c.req.param("code"));
  const product = PRODUCT_CODE_RE.test(code) ? await Db.from(c.env).getProduct(code) : null;
  if (!product || product.documents.length === 0) return notAvailable(c.req.raw, "no-store");

  // A single document needs no page: open the PDF straight away.
  if (product.documents.length === 1) {
    return new Response(null, {
      status: 302,
      headers: { Location: `/f/${code}/${product.documents[0].id}`, "Cache-Control": "no-store" },
    });
  }

  const available = [...new Set(product.documents.map((d) => d.lang))];
  const lang = pickLang(available, c.req.query("lang"), c.req.header("Accept-Language"));
  const documents = product.documents.filter((d) => d.lang === lang);
  return new Response(documentsPage(product, available, lang, documents), {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", Vary: "Accept-Language" },
  });
});

type ByteRange = { offset: number; length: number };

/** Parses a single-range "bytes=" header. Returns undefined for no/unsupported range, null if unsatisfiable. */
function parseRange(header: string | null, size: number): ByteRange | null | undefined {
  if (!header) return undefined;
  const m = header.match(/^bytes=(\d*)-(\d*)$/);
  if (!m || (m[1] === "" && m[2] === "")) return undefined;
  if (m[1] === "") {
    const suffix = Math.min(Number(m[2]), size);
    return suffix > 0 ? { offset: size - suffix, length: suffix } : null;
  }
  const start = Number(m[1]);
  const end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (start >= size || end < start) return null;
  return { offset: start, length: end - start + 1 };
}

/** Content-Disposition with the document title as the filename (RFC 6266/5987). */
function inlineFilename(code: string, lang: string, title: string): string {
  const fallback = `UMI-${code}-${lang.toUpperCase()}.pdf`;
  const utf8 = encodeURIComponent(`UMI ${code} - ${title}.pdf`).replace(/['()*!]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
  return `inline; filename="${fallback}"; filename*=UTF-8''${utf8}`;
}

// Streams the current PDF. Short cache so replaced documents show up within minutes.
publicRoutes.on(["GET", "HEAD"], "/f/:code/:id", async (c) => {
  const code = normalizeCode(c.req.param("code"));
  const ref = c.req.param("id").toLowerCase();
  if (!PRODUCT_CODE_RE.test(code)) return notAvailable(c.req.raw, "no-store");
  const db = Db.from(c.env);

  // Older links were /f/{CODE}/{lang}: send them to that language's first document.
  if (isLang(ref)) {
    const first = (await db.getProduct(code))?.documents.find((d) => d.lang === ref);
    if (!first) return notAvailable(c.req.raw, "no-store");
    return new Response(null, { status: 302, headers: { Location: `/f/${code}/${first.id}`, "Cache-Control": "no-store" } });
  }
  if (!/^\d{1,9}$/.test(ref)) return notAvailable(c.req.raw, "no-store");

  const doc = await db.getDocument(code, Number(ref));
  const head = doc && (await c.env.MANUALS.head(doc.r2_key));
  if (!doc || !head) return notAvailable(c.req.raw, "no-store");

  const headers = new Headers({
    "Content-Type": "application/pdf",
    "Content-Disposition": inlineFilename(code, doc.lang, doc.title),
    "Cache-Control": "public, max-age=300",
    "Accept-Ranges": "bytes",
    ETag: head.httpEtag,
  });

  const size = head.size;
  const range = parseRange(c.req.header("Range") ?? null, size);
  if (range === null) {
    headers.set("Content-Range", `bytes */${size}`);
    return new Response(null, { status: 416, headers });
  }

  const status = range ? 206 : 200;
  if (range) headers.set("Content-Range", `bytes ${range.offset}-${range.offset + range.length - 1}/${size}`);
  headers.set("Content-Length", String(range ? range.length : size));

  if (c.req.method === "HEAD") return new Response(null, { status, headers });

  const obj = await c.env.MANUALS.get(doc.r2_key, range ? { range } : undefined);
  if (!obj) return notAvailable(c.req.raw, "no-store");
  return new Response(obj.body, { status, headers });
});
