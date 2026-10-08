import { Hono } from "hono";
import { authenticate } from "./auth";
import type { Env } from "./config";
import { apiRoutes } from "./routes/api";
import { publicRoutes } from "./routes/public";
import { adminPage } from "./views/admin";

type AppEnv = { Bindings: Env; Variables: { email: string } };

const app = new Hono<AppEnv>();

// Everything under /admin and /api requires a verified Cloudflare Access login.
const requireLogin = async (c: any, next: () => Promise<void>) => {
  const email = await authenticate(c.req.raw, c.env);
  if (!email) {
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

app.get("/admin", (c) =>
  c.html(adminPage(), 200, {
    "Cache-Control": "no-store",
    "Content-Security-Policy":
      "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'",
    "X-Frame-Options": "DENY",
  }),
);
app.get("/admin/", (c) => c.redirect("/admin", 302));

app.route("/api", apiRoutes);
app.route("/", publicRoutes);

export default app;
