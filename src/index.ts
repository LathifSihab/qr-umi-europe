import { Hono } from "hono";
import {
  authenticate, checkStagingPassword, createSession, NAME_MAX, SESSION_COOKIE, SESSION_MAX_AGE,
} from "./auth";
import type { Env } from "./config";
import { apiRoutes } from "./routes/api";
import { publicRoutes } from "./routes/public";
import { adminPage } from "./views/admin";
import { loginPage } from "./views/login";

type AppEnv = { Bindings: Env; Variables: { email: string } };

const app = new Hono<AppEnv>();

const PAGE_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Security-Policy":
    "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'",
  "X-Frame-Options": "DENY",
};

// Everything under /admin and /api requires a login: Cloudflare Access, or the
// staging login page while STAGING_PASSWORD is set.
const requireLogin = async (c: any, next: () => Promise<void>) => {
  const email = await authenticate(c.req.raw, c.env);
  if (!email) {
    if (c.env.STAGING_PASSWORD) {
      return c.req.path.startsWith("/api")
        ? c.json({ error: "You're not logged in. Reload the page to log in again.", login: "/login" }, 401, { "Cache-Control": "no-store" })
        : c.redirect("/login", 302);
    }
    return c.req.path.startsWith("/api")
      ? c.json({ error: "You're not logged in. Reload the page to log in again." }, 403, { "Cache-Control": "no-store" })
      : c.text("Access denied. Log in through Cloudflare Access to use the admin.", 403, { "Cache-Control": "no-store" });
  }
  c.set("email", email);
  await next();
};
app.use("/admin", requireLogin);
app.use("/admin/*", requireLogin);
app.use("/api/*", requireLogin);

app.get("/admin", (c) => c.html(adminPage(), 200, PAGE_HEADERS));
app.get("/admin/", (c) => c.redirect("/admin", 302));

// ---------- Staging login page (only while STAGING_PASSWORD is set) ----------

app.get("/login", async (c) => {
  if (!c.env.STAGING_PASSWORD || (await authenticate(c.req.raw, c.env))) return c.redirect("/admin", 302);
  return c.html(loginPage(), 200, PAGE_HEADERS);
});

app.post("/login", async (c) => {
  if (!c.env.STAGING_PASSWORD) return c.redirect("/admin", 303);
  const form = await c.req.parseBody();
  const name = String(form.name ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, NAME_MAX);
  const password = String(form.password ?? "");
  if (!name) return c.html(loginPage({ error: "Enter your name." }), 400, PAGE_HEADERS);
  if (!(await checkStagingPassword(password, c.env))) {
    return c.html(loginPage({ name, error: "That password isn't right. Try again." }), 401, PAGE_HEADERS);
  }
  const cookie = `${SESSION_COOKIE}=${await createSession(name, c.env)}; Path=/; Max-Age=${SESSION_MAX_AGE}; HttpOnly; Secure; SameSite=Lax`;
  return c.body(null, 303, { Location: "/admin", "Set-Cookie": cookie, "Cache-Control": "no-store" });
});

app.post("/logout", (c) =>
  c.body(null, 303, {
    Location: "/login",
    "Set-Cookie": `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
    "Cache-Control": "no-store",
  }),
);

app.route("/api", apiRoutes);
app.route("/", publicRoutes);

export default app;
