import { afterEach, describe, expect, it } from "vitest";
import { orderLangs, preferredLangs } from "../src/views/scanPages";
import { call, cleanup, createWithManuals, db, pdf, testCode } from "./helpers";

afterEach(cleanup);

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

  it("shows the not-available page when the product has no manuals", async () => {
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

  it("redirects (302, no-store) when there is exactly one manual, case-insensitively", async () => {
    const code = await createWithManuals(["nl"]);
    const res = await call(`/m/${code.toLowerCase()}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/f/${code}/nl`);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("shows a language picker with the visitor's language first", async () => {
    const code = await createWithManuals(["en", "fr", "de"]);
    const res = await call(`/m/${code}`, { headers: { "Accept-Language": "de-DE,de;q=0.9,en;q=0.8" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const html = await res.text();
    expect(html).toContain("Test Product");
    const order = ["Deutsch", "English", "Français"].map((l) => html.indexOf(`>${l}</a>`));
    expect(order.every((i) => i > 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(html).toMatch(/class="btn primary" href="\/f\/[^"]+\/de"/);
    expect(html).not.toContain("Nederlands");
    expect(html).not.toMatch(/<script/i);
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
});

describe("GET /f/:code/:lang", () => {
  it("streams the PDF inline with a short cache", async () => {
    const code = await createWithManuals(["en"]);
    const res = await call(`/f/${code}/en`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(res.headers.get("Content-Disposition")).toBe(`inline; filename="UMI-${code}-EN.pdf"`);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300");
    expect(res.headers.get("Accept-Ranges")).toBe("bytes");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(pdf("en"));
  });

  it("supports Range requests", async () => {
    const code = await createWithManuals(["en"]);
    const size = pdf("en").byteLength;

    const res = await call(`/f/${code}/EN`, { headers: { Range: "bytes=0-3" } });
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe(`bytes 0-3/${size}`);
    expect(new TextDecoder().decode(await res.arrayBuffer())).toBe("%PDF");

    const suffix = await call(`/f/${code}/en`, { headers: { Range: "bytes=-3" } });
    expect(suffix.status).toBe(206);
    expect(suffix.headers.get("Content-Range")).toBe(`bytes ${size - 3}-${size - 1}/${size}`);
    await suffix.arrayBuffer();

    const bad = await call(`/f/${code}/en`, { headers: { Range: `bytes=${size + 10}-` } });
    expect(bad.status).toBe(416);
  });

  it("supports HEAD", async () => {
    const code = await createWithManuals(["en"]);
    const res = await call(`/f/${code}/en`, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Length")).toBe(String(pdf("en").byteLength));
    expect(await res.text()).toBe("");
  });

  it("shows the not-available page for a missing manual or unknown language", async () => {
    const code = await createWithManuals(["en"]);
    expect((await call(`/f/${code}/nl`)).status).toBe(404);
    expect((await call(`/f/${code}/es`)).status).toBe(404);
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
