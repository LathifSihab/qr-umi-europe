import { Hono } from "hono";
import {
  accountsEnabled, authenticate, CLEAR_SESSION_COOKIE, createSession, passwordVersion, sessionCookie, sha256Hex,
} from "./auth";
import { afterResponse } from "./background";
import type { Env } from "./config";
import { Db } from "./db";
import { sendPasswordResetEmail } from "./mail";
import { b64url, DUMMY_HASH, EMAIL_RE, hashPassword, normalizeEmail, passwordProblem, verifyPassword } from "./password";
import { apiRoutes } from "./routes/api";
import { publicRoutes } from "./routes/public";
import { adminPage } from "./views/admin";
import { forgotPage, loginPage, resetPage } from "./views/login";

const RESET_TTL_MINUTES = 60;

type AppEnv = { Bindings: Env; Variables: { email: string } };

const app = new Hono<AppEnv>();

const PAGE_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Security-Policy":
    "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'",
  "X-Frame-Options": "DENY",
};

// Everything under /admin and /api requires a login: an account (while
// SESSION_SECRET is set) or Cloudflare Access.
const requireLogin = async (c: any, next: () => Promise<void>) => {
  const email = await authenticate(c.req.raw, c.env);
  if (!email) {
    if (accountsEnabled(c.env)) {
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

// ---------- Account pages (only while SESSION_SECRET is set) ----------

const loggedIn = async (c: any, email: string, passwordHash: string) =>
  c.body(null, 303, { Location: "/admin", "Set-Cookie": sessionCookie(await createSession(email, await passwordVersion(passwordHash), c.env)), "Cache-Control": "no-store" });

const formText = (value: unknown) => (typeof value === "string" ? value : "");

app.get("/login", async (c) => {
  if (!accountsEnabled(c.env) || (await authenticate(c.req.raw, c.env))) return c.redirect("/admin", 302);
  const notice = c.req.query("reset") !== undefined ? "Your password was changed. Log in with the new one." : "";
  return c.html(loginPage({ notice }), 200, PAGE_HEADERS);
});

app.post("/login", async (c) => {
  if (!accountsEnabled(c.env)) return c.redirect("/admin", 303);
  const form = await c.req.parseBody();
  const email = normalizeEmail(form.email);
  const password = formText(form.password);
  const user = email ? await Db.from(c.env).getUser(email) : null;
  // Always run the hash, so unknown emails take as long as wrong passwords.
  const ok = await verifyPassword(password, user?.password_hash ?? DUMMY_HASH);
  if (!user || !ok) {
    return c.html(loginPage({ email, error: "That email and password don't match. Try again." }), 401, PAGE_HEADERS);
  }
  return loggedIn(c, user.email, user.password_hash);
});

app.post("/logout", (c) =>
  c.body(null, 303, { Location: "/login", "Set-Cookie": CLEAR_SESSION_COOKIE, "Cache-Control": "no-store" }),
);

app.get("/forgot", (c) => {
  if (!accountsEnabled(c.env)) return c.redirect("/admin", 302);
  return c.html(forgotPage(), 200, PAGE_HEADERS);
});

app.post("/forgot", async (c) => {
  if (!accountsEnabled(c.env)) return c.redirect("/admin", 303);
  const email = normalizeEmail((await c.req.parseBody()).email);
  if (!EMAIL_RE.test(email)) return c.html(forgotPage({ email, error: "Enter a valid email address." }), 400, PAGE_HEADERS);

  const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
  if (await Db.from(c.env).createPasswordReset(email, await sha256Hex(token), RESET_TTL_MINUTES)) {
    const link = `${c.env.PUBLIC_BASE_URL}/reset?token=${token}`;
    // Sent after the response, so the timing doesn't reveal whether the account exists.
    await afterResponse(c, sendPasswordResetEmail(c.env, email, link));
  }
  // Same answer whether or not the account exists, so this can't be used to find accounts.
  return c.html(forgotPage({ email, sent: true }), 200, PAGE_HEADERS);
});

app.get("/reset", async (c) => {
  if (!accountsEnabled(c.env)) return c.redirect("/admin", 302);
  const token = c.req.query("token") ?? "";
  const email = token ? await Db.from(c.env).findPasswordReset(await sha256Hex(token)) : null;
  if (!email) return c.html(resetPage({ invalid: true }), 404, PAGE_HEADERS);
  return c.html(resetPage({ token, email }), 200, PAGE_HEADERS);
});

app.post("/reset", async (c) => {
  if (!accountsEnabled(c.env)) return c.redirect("/admin", 303);
  const form = await c.req.parseBody();
  const token = formText(form.token);
  const password = formText(form.password);
  const db = Db.from(c.env);
  const tokenHash = await sha256Hex(token);

  const problem = password !== formText(form.confirm) ? "The two passwords don't match." : passwordProblem(password);
  if (problem) {
    const email = token ? await db.findPasswordReset(tokenHash) : null;
    if (!email) return c.html(resetPage({ invalid: true }), 404, PAGE_HEADERS);
    return c.html(resetPage({ token, email, error: problem }), 400, PAGE_HEADERS);
  }
  const newHash = await hashPassword(password);
  const email = token ? await db.resetPassword(tokenHash, newHash) : null;
  if (!email) return c.html(resetPage({ invalid: true }), 404, PAGE_HEADERS);
  return loggedIn(c, email, newHash);
});

app.route("/api", apiRoutes);
app.route("/", publicRoutes);

export default app;
