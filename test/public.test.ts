import { afterEach, describe, expect, it } from "vitest";
import { documentPath } from "../src/config";
import { orderLangs, pickLang, preferredLangs } from "../src/views/scanPages";
import { call, cleanup, createWithDocuments, db, pdf, testCode } from "./helpers";

afterEach(cleanup);

/** The versioned link the public pages give out for a document right now. */
async function link(code: string, id: number): Promise<string> {
  return documentPath(code, (await db.getDocument(code, id))!);
}

function replaceFile(code: string, id: number, body: BodyInit) {
  return call(`/api/products/${code}/documents/${id}/file`, {
    method: "PUT",
    headers: { "Content-Type": "application/pdf", "X-Filename": "new.pdf" },
    body,
  });
}

describe("GET /", () => {
  it("redirects to the main website", async () => {
    const res = await call("/");
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("https://umi-europe.com");
  });
});

describe("GET /m/:code", () => {
  it("shows the not-available page for an unknown code", async () => {
    const res = await call("/m/TEST-UNKNOWN0");
    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.text()).toContain("Manual not available");
  });

  it("shows the not-available page for a malformed code without hitting the database", async () => {
    const res = await call("/m/%3Cscript%3E");
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("<script>");
  });

  it("shows the not-available page when the product has no documents", async () => {
    const code = testCode();
    await db.createProduct(code, "Empty");
    const res = await call(`/m/${code}`);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("Manual not available");
  });

  it("localizes the not-available page", async () => {
    const res = await call("/m/TEST-UNKNOWN0", { headers: { "Accept-Language": "nl-NL,nl;q=0.9" } });
    expect(await res.text()).toContain("Handleiding niet beschikbaar");
  });

  it("redirects (302, no-store) when there is exactly one document, case-insensitively", async () => {
    const { code, ids } = await createWithDocuments(["nl"]);
    const res = await call(`/m/${code.toLowerCase()}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(await link(code, ids[0]));
    expect(res.headers.get("Location")).toMatch(/\?v=[0-9a-z]+$/);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("shows the documents in the visitor's language, with a language selector at the top", async () => {
    const { code, ids } = await createWithDocuments([
      ["en", "Manual"],
      ["de", "Bedienungsanleitung"],
      ["de", "Sicherheitshinweise <b>"],
      ["fr", "Mode d’emploi"],
    ]);
    const res = await call(`/m/${code}`, { headers: { "Accept-Language": "de-DE,de;q=0.9,en;q=0.8" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const html = await res.text();
    expect(html).toContain('<html lang="de">');
    expect(html).toContain("Test Product");
    expect(html).toContain("Produktdokumente");

    // The selector lists the languages that have documents, in the default order, before the title.
    const nav = html.match(/<nav class="langs"[^]*?<\/nav>/)?.[0] ?? "";
    expect(html.indexOf(nav)).toBeLessThan(html.indexOf("<h1>"));
    expect([...nav.matchAll(/>([A-Z]{2})<\/a>/g)].map((m) => m[1])).toEqual(["EN", "FR", "DE"]);
    expect(nav).toMatch(/href="\/m\/[^"]+\?lang=de"[^>]*aria-current="page"/);
    expect(nav).not.toContain("lang=nl");

    // Only the German documents, in order, escaped.
    expect(html).toContain(`href="${await link(code, ids[1])}">Bedienungsanleitung</a>`);
    expect(html).toContain(`href="${await link(code, ids[2])}">Sicherheitshinweise &#60;b&#62;</a>`);
    expect(html.indexOf("Bedienungsanleitung</a>")).toBeLessThan(html.indexOf("Sicherheitshinweise"));
    expect(html).not.toContain(">Manual</a>");
    expect(html).not.toMatch(/<script/i);
  });

  it("switches language with ?lang=, falling back for unavailable languages", async () => {
    const { code, ids } = await createWithDocuments([["en", "Manual"], ["fr", "Mode d’emploi"]]);
    const fr = await (await call(`/m/${code}?lang=FR`, { headers: { "Accept-Language": "en" } })).text();
    expect(fr).toContain('<html lang="fr">');
    expect(fr).toContain(`href="${await link(code, ids[1])}"`);
    expect(fr).not.toContain(`/f/${code}/${ids[0]}?`);

    const fallback = await (await call(`/m/${code}?lang=nl`, { headers: { "Accept-Language": "nl" } })).text();
    expect(fallback).toContain('<html lang="en">');
    expect(fallback).toContain(`href="${await link(code, ids[0])}"`);
  });

  it("shows the product name in the chosen language, else the default name", async () => {
    const { code } = await createWithDocuments(["en", "nl", "de"]);
    await db.updateProductName(code, { translations: { nl: "Testproduct <i>" } });
    const nl = await (await call(`/m/${code}?lang=nl`)).text();
    expect(nl).toContain("<h1>Testproduct &#60;i&#62;</h1>");
    expect(nl).toContain("<title>Testproduct &#60;i&#62; – UMI Europe</title>");
    const de = await (await call(`/m/${code}?lang=de`)).text();
    expect(de).toContain("<h1>Test Product</h1>");
  });

  it("leaves out the selector when there's only one language", async () => {
    const { code } = await createWithDocuments([["nl", "Handleiding"], ["nl", "Onderhoud"]]);
    const html = await (await call(`/m/${code}`)).text();
    expect(html).not.toContain('class="langs"');
    expect(html).toContain(">Handleiding</a>");
    expect(html).toContain(">Onderhoud</a>");
  });
});

describe("language negotiation", () => {
  it("ranks by q value and ignores unsupported languages", () => {
    expect(preferredLangs("es-ES,fr;q=0.5,nl;q=0.8")).toEqual(["nl", "fr"]);
    expect(preferredLangs("")).toEqual([]);
    expect(preferredLangs("de;q=0,en")).toEqual(["en"]);
  });
  it("falls back to the default order", () => {
    expect(orderLangs(["de", "en"], "es")).toEqual(["en", "de"]);
    expect(orderLangs(["de", "en", "nl"], "nl-BE")).toEqual(["nl", "en", "de"]);
  });
  it("prefers the visitor's pick, then the browser, then the default order", () => {
    expect(pickLang(["en", "de"], "de", "en")).toBe("de");
    expect(pickLang(["en", "de"], "nl", "de")).toBe("de");
    expect(pickLang(["fr", "de"], undefined, "es")).toBe("fr");
  });
});

describe("GET /f/:code/:id", () => {
  it("streams the PDF inline, named after the title", async () => {
    const { code, ids } = await createWithDocuments([["en", "Quick start (v2)"]]);
    const res = await call(await link(code, ids[0]));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(res.headers.get("Content-Disposition")).toBe(
      `inline; filename="UMI-${code}-EN.pdf"; filename*=UTF-8''UMI%20${code}%20-%20Quick%20start%20%28v2%29.pdf`,
    );
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=86400");
    expect(res.headers.get("Accept-Ranges")).toBe("bytes");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(pdf("en Quick start (v2)"));
  });

  it("makes browsers check back for links without the current version", async () => {
    const { code, ids } = await createWithDocuments(["en"]);
    for (const path of [`/f/${code}/${ids[0]}`, `/f/${code}/${ids[0]}?v=old`]) {
      const res = await call(path);
      expect(res.status).toBe(200);
      expect(res.headers.get("Cache-Control")).toBe("no-cache");
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(pdf("en Manual en"));
    }
  });

  it("gives a replaced PDF a new link, and never serves the old file", async () => {
    const { code, ids } = await createWithDocuments(["en"]);
    const before = await link(code, ids[0]);
    const etag = (await call(before, { method: "HEAD" })).headers.get("ETag")!;
    await new Promise((r) => setTimeout(r, 5));
    expect((await replaceFile(code, ids[0], pdf("version 2"))).status).toBe(200);

    // The QR code now redirects to a different URL, so cached copies of the old one are never used.
    const after = (await call(`/m/${code}`)).headers.get("Location")!;
    expect(after).toBe(await link(code, ids[0]));
    expect(after).not.toBe(before);
    expect(new Uint8Array(await (await call(after)).arrayBuffer())).toEqual(pdf("version 2"));

    // A browser revalidating the old link with the old ETag gets the new file, uncacheable.
    const old = await call(before, { headers: { "If-None-Match": etag } });
    expect(old.status).toBe(200);
    expect(old.headers.get("Cache-Control")).toBe("no-cache");
    expect(new Uint8Array(await old.arrayBuffer())).toEqual(pdf("version 2"));

    // Resuming a download of the old file (If-Range with the old ETag) restarts with the whole new file.
    const resumed = await call(after, { headers: { Range: "bytes=4-", "If-Range": etag } });
    expect(resumed.status).toBe(200);
    expect(new Uint8Array(await resumed.arrayBuffer())).toEqual(pdf("version 2"));
  });

  it("answers 304 when the browser already has the current file", async () => {
    const { code, ids } = await createWithDocuments(["en"]);
    const etag = (await call(`/f/${code}/${ids[0]}`, { method: "HEAD" })).headers.get("ETag")!;
    const res = await call(`/f/${code}/${ids[0]}`, { headers: { "If-None-Match": etag } });
    expect(res.status).toBe(304);
    expect(res.headers.get("ETag")).toBe(etag);
    expect(await res.text()).toBe("");
  });

  it("supports Range requests", async () => {
    const { code, ids } = await createWithDocuments(["en"]);
    const size = pdf("en Manual en").byteLength;

    const res = await call(`/f/${code}/${ids[0]}`, { headers: { Range: "bytes=0-3" } });
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe(`bytes 0-3/${size}`);
    expect(new TextDecoder().decode(await res.arrayBuffer())).toBe("%PDF");

    const suffix = await call(`/f/${code}/${ids[0]}`, { headers: { Range: "bytes=-3" } });
    expect(suffix.status).toBe(206);
    expect(suffix.headers.get("Content-Range")).toBe(`bytes ${size - 3}-${size - 1}/${size}`);
    await suffix.arrayBuffer();

    const bad = await call(`/f/${code}/${ids[0]}`, { headers: { Range: `bytes=${size + 10}-` } });
    expect(bad.status).toBe(416);
  });

  it("supports HEAD", async () => {
    const { code, ids } = await createWithDocuments(["en"]);
    const res = await call(`/f/${code}/${ids[0]}`, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Length")).toBe(String(pdf("en Manual en").byteLength));
    expect(await res.text()).toBe("");
  });

  it("sends old /f/{CODE}/{lang} links to that language's first document", async () => {
    const { code, ids } = await createWithDocuments([["nl", "Eerste"], ["nl", "Tweede"]]);
    const res = await call(`/f/${code}/NL`);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/f/${code}/${ids[0]}`);
    expect((await call(`/f/${code}/en`)).status).toBe(404);
  });

  it("shows the not-available page for a missing document or another product's document", async () => {
    const { code, ids } = await createWithDocuments(["en"]);
    const other = await createWithDocuments(["en"]);
    expect((await call(`/f/${code}/999999999`)).status).toBe(404);
    expect((await call(`/f/${code}/es`)).status).toBe(404);
    expect((await call(`/f/${code}/abc`)).status).toBe(404);
    expect((await call(`/f/${other.code}/${ids[0]}`)).status).toBe(404);
  });
});

describe("GET /assets/umi-logo.svg", () => {
  it("serves the vector logo from the Worker", async () => {
    const res = await call("/assets/umi-logo.svg");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/svg+xml");
    expect(await res.text()).toMatch(/^<svg [^>]*viewBox=/);
  });
});
