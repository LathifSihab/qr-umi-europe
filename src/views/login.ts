import css from "./admin/admin.css";
import { escapeHtml } from "./scanPages";

/** Staging login page. Reuses the admin styles so it looks like part of the admin. */
export function loginPage({ name = "", error = "" } = {}): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Log in – QR manuals – UMI Europe</title>
<link rel="icon" href="/assets/umi-logo.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Figtree:wght@400;500;600&display=swap">
<style>${css}
.login { max-width: 400px; margin: 48px auto 0; }
.login h1 { margin-bottom: 6px; }
.login .hint { margin: 0 0 20px; }
.login .field { margin-bottom: 16px; }
.login input[type="password"] {
  width: 100%; min-height: 42px; padding: 8px 12px;
  border: 1px solid var(--umi-border); border-radius: var(--radius);
  font: 400 16px/1.3 var(--font); color: var(--umi-text); background: #fff;
}
.login .btn { width: 100%; }
</style>
</head>
<body>
<header class="topbar">
  <span class="brand">
    <img src="/assets/umi-logo.svg" alt="UMI Europe" width="65" height="34">
    <span>QR manuals</span>
  </span>
</header>
<main id="main">
  <form class="panel login" method="post" action="/login">
    <h1>Log in</h1>
    <p class="hint">Manage products and their manuals.</p>
    <p class="form-error" role="alert">${escapeHtml(error)}</p>
    <div class="field">
      <label for="name">Your name</label>
      <input id="name" name="name" type="text" maxlength="100" autocomplete="name" required value="${escapeHtml(name)}"${name ? "" : " autofocus"}>
      <p class="hint">Shown next to the manuals you upload.</p>
    </div>
    <div class="field">
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required${name ? " autofocus" : ""}>
    </div>
    <button class="btn primary" type="submit">Log in</button>
  </form>
</main>
</body>
</html>`;
}
