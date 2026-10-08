import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { afterEach, describe, expect, it } from "vitest";
import { authenticate, DEV_EMAIL } from "../src/auth";
import { MAX_UPLOAD_BYTES, type Env } from "../src/config";
import { call, cleanup, createWithManuals, db, devEnv, pdf, prodEnv, r2Keys, testCode } from "./helpers";

afterEach(cleanup);

const json = (body: unknown, method = "POST"): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

function upload(code: string, lang: string, body: BodyInit, filename = "manual.pdf") {
  return call(`/api/products/${code}/manuals/${lang}`, {
    method: "PUT",
    headers: { "Content-Type": "application/pdf", "X-Filename": encodeURIComponent(filename) },
    body,
  });
}

describe("authentication", () => {
  it("rejects /api and /admin without an Access JWT in production", async () => {
    const api = await call("/api/products", {}, prodEnv);
    expect(api.status).toBe(403);
    expect((await api.json()) as object).toHaveProperty("error");
    expect((await call("/api/me", {}, prodEnv)).status).toBe(403);
    expect((await call("/admin", {}, prodEnv)).status).toBe(403);
  });

  it("rejects a forged JWT in production", async () => {
    const res = await call("/api/products", { headers: { "Cf-Access-Jwt-Assertion": "a.b.c" } }, prodEnv);
    expect(res.status).toBe(403);
  });

  it("allows the dev bypass only when ENVIRONMENT is exactly 'development'", async () => {
    const req = () => new Request("http://localhost/api/me");
    expect(await authenticate(req(), devEnv)).toBe(DEV_EMAIL);
    for (const ENVIRONMENT of ["production", "Development", "dev", "", "test"]) {
      expect(await authenticate(req(), { ...prodEnv, ENVIRONMENT })).toBeNull();
    }
  });

  it("rejects everything when Access isn't configured in production", async () => {
    const e = { ...prodEnv, ACCESS_AUD: "" };
    const res = await call("/api/products", { headers: { "Cf-Access-Jwt-Assertion": "a.b.c" } }, e);
    expect(res.status).toBe(403);
  });

  it("accepts a valid Access JWT and checks issuer and audience", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" }] });
    const sign = (aud: string, iss = "https://team.example.com") =>
      new SignJWT({ email: "client@umi-europe.com" })
        .setProtectedHeader({ alg: "RS256", kid: "k1" })
        .setIssuer(iss)
        .setAudience(aud)
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(privateKey);
    const req = (token: string) =>
      new Request("http://localhost/api/me", { headers: { "Cf-Access-Jwt-Assertion": token } });

    expect(await authenticate(req(await sign("test-aud")), prodEnv, jwks)).toBe("client@umi-europe.com");
    expect(await authenticate(req(await sign("other-aud")), prodEnv, jwks)).toBeNull();
    expect(await authenticate(req(await sign("test-aud", "https://evil.example.com")), prodEnv, jwks)).toBeNull();
  });

  describe("staging login page", () => {
    const stagingEnv: Env = { ...prodEnv, STAGING_PASSWORD: "s3cret-demo" };
    const login = (name: string, password: string, e = stagingEnv) =>
      call("/login", { method: "POST", body: new URLSearchParams({ name, password }) }, e);
    const withCookie = (cookie: string) => ({ headers: { Cookie: cookie.split(";")[0] } });

    it("sends /admin to the login page and /api to a 401 pointing there", async () => {
      const admin = await call("/admin", {}, stagingEnv);
      expect(admin.status).toBe(302);
      expect(admin.headers.get("Location")).toBe("/login");
      const api = await call("/api/me", {}, stagingEnv);
      expect(api.status).toBe(401);
      expect(((await api.json()) as any).login).toBe("/login");
      expect((await call("/login", {}, stagingEnv)).status).toBe(200);
    });

    it("logs in with the right password and records the name", async () => {
      const res = await login("Lathif", "s3cret-demo");
      expect(res.status).toBe(303);
      expect(res.headers.get("Location")).toBe("/admin");
      const cookie = res.headers.get("Set-Cookie")!;
      expect(cookie).toMatch(/^__Host-umi_session=.*HttpOnly; Secure; SameSite=Lax$/);

      const me = await call("/api/me", withCookie(cookie), stagingEnv);
      expect(me.status).toBe(200);
      expect(((await me.json()) as any)).toMatchObject({ email: "Lathif", can_log_out: true });
      expect((await call("/admin", withCookie(cookie), stagingEnv)).status).toBe(200);
    });

    it("rejects a wrong password or a missing name, keeping the HTML safe", async () => {
      for (const password of ["wrong", "s3cret-dem", "s3cret-demo2", ""]) {
        const res = await login("x", password);
        expect(res.status).toBe(401);
        expect(res.headers.get("Set-Cookie")).toBeNull();
      }
      expect((await login("  ", "s3cret-demo")).status).toBe(400);
      expect(await (await login('"><script>', "wrong")).text()).not.toContain('"><script>');
    });

    it("rejects tampered, expired and old-password sessions", async () => {
      const cookie = (await login("Lathif", "s3cret-demo")).headers.get("Set-Cookie")!.split(";")[0];
      const forged = cookie.replace("Lathif", "Admin");
      expect((await call("/api/me", withCookie(forged), stagingEnv)).status).toBe(401);
      expect((await call("/api/me", withCookie(cookie), { ...stagingEnv, STAGING_PASSWORD: "new-pw" })).status).toBe(401);

      const { createSession } = await import("../src/auth");
      const old = await createSession("Lathif", stagingEnv, Date.now() - 8 * 24 * 3600 * 1000);
      expect((await call("/api/me", withCookie(`__Host-umi_session=${old}`), stagingEnv)).status).toBe(401);
    });

    it("logs out by clearing the cookie", async () => {
      const res = await call("/logout", { method: "POST" }, stagingEnv);
      expect(res.status).toBe(303);
      expect(res.headers.get("Set-Cookie")).toContain("Max-Age=0");
    });

    it("is switched off when no staging password is set", async () => {
      expect((await call("/login", {}, prodEnv)).status).toBe(302);
      expect((await login("x", "", prodEnv)).headers.get("Set-Cookie")).toBeNull();
      expect((await call("/admin", {}, prodEnv)).status).toBe(403);
      expect((await call("/api/me", {}, prodEnv)).status).toBe(403);
    });
  });
});

describe("products API", () => {
  it("returns the logged-in email", async () => {
    const res = await call("/api/me");
    expect(((await res.json()) as any).email).toBe(DEV_EMAIL);
  });

  it("creates a product, normalizing the code to uppercase", async () => {
    const code = testCode();
    const res = await call("/api/products", json({ code: code.toLowerCase(), name: "  Widget  " }));
    expect(res.status).toBe(201);
    const { product } = (await res.json()) as any;
    expect(product).toMatchObject({ code, name: "Widget", short_url: `https://qr.example.com/m/${code}`, manuals: [] });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("validates the code and name", async () => {
    for (const code of ["", "A", "-AB", "AB CD", "AB_CD", "X".repeat(33)]) {
      const res = await call("/api/products", json({ code, name: "Widget" }));
      expect(res.status, code).toBe(400);
    }
    const res = await call("/api/products", json({ code: testCode(), name: "   " }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toBe("Enter a product name.");
  });

  it("returns 409 for a duplicate code", async () => {
    const code = testCode();
    expect((await call("/api/products", json({ code, name: "A" }))).status).toBe(201);
    const res = await call("/api/products", json({ code, name: "B" }));
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).error).toContain(code);
  });

  it("renames a product and searches", async () => {
    const code = testCode();
    await db.createProduct(code, "Old name");
    const res = await call(`/api/products/${code}`, json({ name: "New name" }, "PATCH"));
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).product.name).toBe("New name");

    const list = (await (await call(`/api/products?q=${code}`)).json()) as any;
    expect(list.products.map((p: any) => p.code)).toEqual([code]);
    expect(list.products[0]).not.toHaveProperty("manuals.0.r2_key");

    expect((await call("/api/products/TEST-NOPE", json({ name: "X" }, "PATCH"))).status).toBe(404);
  });
});

describe("manual uploads", () => {
  it("rejects a file that isn't a PDF, even with a PDF content type", async () => {
    const code = testCode();
    await db.createProduct(code, "P");
    const res = await upload(code, "en", new TextEncoder().encode("<html>not a pdf</html>"));
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toBe("This file isn't a PDF. Upload a .pdf file.");
    expect(await r2Keys(`manuals/${code}/`)).toEqual([]);
  });

  it("rejects an oversized upload by Content-Length", async () => {
    const code = testCode();
    await db.createProduct(code, "P");
    const body = new Uint8Array(MAX_UPLOAD_BYTES + 1);
    body.set(pdf());
    const res = await upload(code, "en", body);
    expect(res.status).toBe(413);
  });

  it("rejects an oversized streamed upload without Content-Length", async () => {
    const code = testCode();
    await db.createProduct(code, "P");
    const chunk = new Uint8Array(1024 * 1024);
    chunk.set(pdf());
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent > MAX_UPLOAD_BYTES) return controller.close();
        sent += chunk.byteLength;
        controller.enqueue(chunk.slice());
      },
    });
    const res = await upload(code, "en", stream);
    expect(res.status).toBe(413);
    expect(await r2Keys(`manuals/${code}/`)).toEqual([]);
  });

  it("rejects an unknown language or product", async () => {
    const code = testCode();
    await db.createProduct(code, "P");
    expect((await upload(code, "es", pdf())).status).toBe(400);
    expect((await upload("TEST-NOPE", "en", pdf())).status).toBe(404);
    // The PDF stored before discovering the product is missing is removed again.
    expect(await r2Keys("manuals/TEST-NOPE/")).toEqual([]);
  });

  it("returns the same product it stored, in one round trip", async () => {
    const code = await createWithManuals(["fr", "nl"]);
    const res = await upload(code.toLowerCase(), "de", pdf("de"), "de.pdf");
    expect(res.status).toBe(200);
    const { product } = (await res.json()) as any;
    const stored = (await (await call(`/api/products/${code}`)).json()) as any;
    expect(product).toEqual(stored.product);
    expect(product.manuals.map((m: any) => m.lang)).toEqual(["de", "fr", "nl"]);

    // Replacing keeps one row per language and updates it in place.
    const again = (await (await upload(code, "fr", pdf("fr2"), "fr-v2.pdf")).json()) as any;
    expect(again.product.manuals.map((m: any) => m.lang)).toEqual(["de", "fr", "nl"]);
    expect(again.product.manuals[1].original_name).toBe("fr-v2.pdf");
    expect(again.product).toEqual(((await (await call(`/api/products/${code}`)).json()) as any).product);
  });

  it("stores the original filename and size", async () => {
    const code = testCode();
    await db.createProduct(code, "P");
    const res = await upload(code, "nl", pdf(), "Handleiding X200 (v2).pdf");
    expect(res.status).toBe(200);
    const { product } = (await res.json()) as any;
    expect(product.manuals).toHaveLength(1);
    expect(product.manuals[0]).toMatchObject({
      lang: "nl",
      original_name: "Handleiding X200 (v2).pdf",
      size_bytes: pdf().byteLength,
      uploaded_by: DEV_EMAIL,
    });
  });

  it("accepts uploads for several languages at the same time", async () => {
    const code = testCode();
    await db.createProduct(code, "Parallel");
    const langs = ["en", "nl", "fr", "de"];
    const results = await Promise.all(langs.map((lang) => upload(code, lang, pdf(lang), `${lang}.pdf`)));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200]);

    const stored = ((await (await call(`/api/products/${code}`)).json()) as any).product;
    expect(stored.manuals.map((m: any) => m.lang)).toEqual(["de", "en", "fr", "nl"]);
    for (const lang of langs) {
      expect(new TextDecoder().decode(await (await call(`/f/${code}/${lang}`)).arrayBuffer())).toContain(lang);
      expect(await r2Keys(`manuals/${code}/${lang}/`)).toHaveLength(1);
    }
  });

  it("replacing a manual deletes the old R2 object", async () => {
    const code = await createWithManuals(["en"]);
    const [oldKey] = await r2Keys(`manuals/${code}/en/`);
    expect((await upload(code, "en", pdf("v2"))).status).toBe(200);
    const keys = await r2Keys(`manuals/${code}/en/`);
    expect(keys).toHaveLength(1);
    expect(keys[0]).not.toBe(oldKey);
    expect(new TextDecoder().decode(await (await call(`/f/${code}/en`)).arrayBuffer())).toContain("v2");
  });

  it("removing a manual deletes its R2 object", async () => {
    const code = await createWithManuals(["en", "nl"]);
    const res = await call(`/api/products/${code}/manuals/nl`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).product.manuals.map((m: any) => m.lang)).toEqual(["en"]);
    expect(await r2Keys(`manuals/${code}/nl/`)).toEqual([]);
    expect((await call(`/api/products/${code}/manuals/nl`, { method: "DELETE" })).status).toBe(404);
  });

  it("deleting a product cleans up its R2 objects", async () => {
    const code = await createWithManuals(["en", "fr"]);
    expect(await r2Keys(`manuals/${code}/`)).toHaveLength(2);
    expect((await call(`/api/products/${code}`, { method: "DELETE" })).status).toBe(200);
    expect(await r2Keys(`manuals/${code}/`)).toEqual([]);
    expect(await db.getProduct(code)).toBeNull();
    expect((await call(`/m/${code}`)).status).toBe(404);
    expect((await call(`/api/products/${code}`, { method: "DELETE" })).status).toBe(404);
  });
});

describe("QR code and admin page", () => {
  it("returns an SVG QR code, optionally as a download", async () => {
    const code = testCode();
    await db.createProduct(code, "P");
    const res = await call(`/api/products/${code}/qr.svg`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/svg+xml");
    const svg = await res.text();
    expect(svg).toMatch(/^<svg [^>]*viewBox="0 0 \d+ \d+"/);
    expect(svg).toContain('fill="#000"');

    const dl = await call(`/api/products/${code}/qr.svg?download`);
    expect(dl.headers.get("Content-Disposition")).toBe(`attachment; filename="UMI-QR-${code}.svg"`);
    await dl.text();
  });

  it("serves the admin page with CSS and JS inlined", async () => {
    const res = await call("/admin");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("QR manuals");
    expect(html).toContain("--umi-blue");
    expect(html).toContain("function renderList");
    expect(html).not.toContain("/*__CSS__*/");
    expect(html).not.toContain("/*__JS__*/");
  });
});
