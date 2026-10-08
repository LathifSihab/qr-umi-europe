import { Hono } from "hono";
import logo from "../../assets/umi-logo.svg";
import { PRODUCT_CODE_RE, isLang, normalizeCode, type Env } from "../config";
import { Db } from "../db";
import { languagePickerPage, notAvailablePage, orderLangs } from "../views/scanPages";

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
// changes to the manuals take effect immediately for already-printed codes.
publicRoutes.get("/m/:code", async (c) => {
  const code = normalizeCode(c.req.param("code"));
  const product = PRODUCT_CODE_RE.test(code) ? await Db.from(c.env).getProduct(code) : null;
  if (!product || product.manuals.length === 0) return notAvailable(c.req.raw, "no-store");

  if (product.manuals.length === 1) {
    return new Response(null, {
      status: 302,
      headers: { Location: `/f/${code}/${product.manuals[0].lang}`, "Cache-Control": "no-store" },
    });
  }

  const acceptLanguage = c.req.header("Accept-Language");
  const langs = orderLangs(product.manuals.map((m) => m.lang), acceptLanguage);
  return new Response(languagePickerPage(product, langs, acceptLanguage), {
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

// Streams the current PDF. Short cache so replaced manuals show up within minutes.
publicRoutes.on(["GET", "HEAD"], "/f/:code/:lang", async (c) => {
  const code = normalizeCode(c.req.param("code"));
  const lang = c.req.param("lang").toLowerCase();
  if (!PRODUCT_CODE_RE.test(code) || !isLang(lang)) return notAvailable(c.req.raw, "no-store");

  const manual = await Db.from(c.env).getManual(code, lang);
  const head = manual && (await c.env.MANUALS.head(manual.r2_key));
  if (!manual || !head) return notAvailable(c.req.raw, "no-store");

  const headers = new Headers({
    "Content-Type": "application/pdf",
    "Content-Disposition": `inline; filename="UMI-${code}-${lang.toUpperCase()}.pdf"`,
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

  const obj = await c.env.MANUALS.get(manual.r2_key, range ? { range } : undefined);
  if (!obj) return notAvailable(c.req.raw, "no-store");
  return new Response(obj.body, { status, headers });
});
