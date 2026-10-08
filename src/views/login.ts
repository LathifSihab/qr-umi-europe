import css from "./admin/admin.css";
import { PASSWORD_MIN } from "../password";
import { escapeHtml } from "./scanPages";

// Login, forgot password and reset password pages. They reuse the admin styles
// so they look like part of the admin.

const EYE =
  '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF =
  '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M3 3l18 18"/><path d="M10.6 5.1A10.7 10.7 0 0 1 12 5c6.4 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.1M6.6 6.6C3.9 8.4 2 12 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';

function passwordField(id: string, label: string, autocomplete: string, attrs = ""): string {
  return `<div class="field">
      <label for="${id}">${label}</label>
      <div class="password-field">
        <input id="${id}" name="${id}" type="password" autocomplete="${autocomplete}" required ${attrs}>
        <button class="reveal" type="button" data-reveal="${id}" aria-label="Show password" aria-pressed="false">${EYE}</button>
      </div>
    </div>`;
}

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)} – QR manuals – UMI Europe</title>
<link rel="icon" href="/assets/umi-logo.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Figtree:wght@400;500;600&display=swap">
<style>${css}
.auth { max-width: 400px; margin: 48px auto 0; }
.auth h1 { margin-bottom: 6px; }
.auth .lead { color: var(--umi-muted); font-size: 14px; margin: 0 0 20px; }
.auth .field { margin-bottom: 16px; }
.auth input[type="email"], .auth input[type="password"], .auth .password-field input[type="text"] {
  width: 100%; min-height: 42px; padding: 8px 12px;
  border: 1px solid var(--umi-border); border-radius: var(--radius);
  font: 400 16px/1.3 var(--font); color: var(--umi-text); background: #fff;
}
.password-field { position: relative; }
.password-field input { padding-right: 48px !important; }
.reveal {
  position: absolute; top: 1px; right: 1px; bottom: 1px; width: 44px;
  display: flex; align-items: center; justify-content: center;
  border: 0; background: transparent; color: var(--umi-muted); cursor: pointer; border-radius: var(--radius);
}
.reveal:hover { color: var(--umi-blue); }
.auth .btn.primary { width: 100%; }
.auth .links { margin: 16px 0 0; font-size: 14px; text-align: center; }
.notice { background: #E8F5EC; color: var(--umi-success-text); border: 1px solid #b7e1c5; padding: 10px 12px; font-size: 14px; margin: 0 0 16px; }
.notice:empty { display: none; }
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
${body}
</main>
<script>
document.addEventListener("click", function (e) {
  var btn = e.target.closest("[data-reveal]");
  if (!btn) return;
  var input = document.getElementById(btn.dataset.reveal);
  var show = input.type === "password";
  input.type = show ? "text" : "password";
  btn.setAttribute("aria-pressed", String(show));
  btn.setAttribute("aria-label", show ? "Hide password" : "Show password");
  btn.innerHTML = show ? ${JSON.stringify(EYE_OFF)} : ${JSON.stringify(EYE)};
});
</script>
</body>
</html>`;
}

export function loginPage({ email = "", error = "", notice = "" } = {}): string {
  return layout("Log in", `<form class="panel auth" method="post" action="/login">
    <h1>Log in</h1>
    <p class="lead">Manage products and their manuals.</p>
    <p class="notice" role="status">${escapeHtml(notice)}</p>
    <p class="form-error" role="alert">${escapeHtml(error)}</p>
    <div class="field">
      <label for="email">Email</label>
      <input id="email" name="email" type="email" autocomplete="username" required value="${escapeHtml(email)}"${email ? "" : " autofocus"}>
    </div>
    ${passwordField("password", "Password", "current-password", email ? "autofocus" : "")}
    <button class="btn primary" type="submit">Log in</button>
    <p class="links"><a href="/forgot">Forgot password?</a></p>
  </form>`);
}

export function forgotPage({ email = "", sent = false, error = "" } = {}): string {
  if (sent) {
    return layout("Check your email", `<div class="panel auth">
    <h1>Check your email</h1>
    <p class="lead">If <strong>${escapeHtml(email)}</strong> has an account, we've sent it a link to choose a new password. The link expires in 1 hour.</p>
    <p class="lead">No email after a few minutes? Check your spam folder, or try again.</p>
    <p class="links"><a href="/login">Back to log in</a></p>
  </div>`);
  }
  return layout("Forgot password", `<form class="panel auth" method="post" action="/forgot">
    <h1>Forgot password</h1>
    <p class="lead">Enter your account's email and we'll send you a link to choose a new password.</p>
    <p class="form-error" role="alert">${escapeHtml(error)}</p>
    <div class="field">
      <label for="email">Email</label>
      <input id="email" name="email" type="email" autocomplete="username" required autofocus value="${escapeHtml(email)}">
    </div>
    <button class="btn primary" type="submit">Send reset link</button>
    <p class="links"><a href="/login">Back to log in</a></p>
  </form>`);
}

export function resetPage({ token = "", email = "", error = "", invalid = false } = {}): string {
  if (invalid) {
    return layout("Link expired", `<div class="panel auth">
    <h1>This link doesn't work anymore</h1>
    <p class="lead">Reset links work once and expire after 1 hour. Ask for a new one.</p>
    <a class="btn primary" href="/forgot">Send a new link</a>
    <p class="links"><a href="/login">Back to log in</a></p>
  </div>`);
  }
  return layout("Choose a new password", `<form class="panel auth" method="post" action="/reset">
    <h1>Choose a new password</h1>
    <p class="lead">For <strong>${escapeHtml(email)}</strong>. Use at least ${PASSWORD_MIN} characters.</p>
    <p class="form-error" role="alert">${escapeHtml(error)}</p>
    <input type="hidden" name="token" value="${escapeHtml(token)}">
    ${passwordField("password", "New password", "new-password", `minlength="${PASSWORD_MIN}" autofocus`)}
    ${passwordField("confirm", "Repeat new password", "new-password", `minlength="${PASSWORD_MIN}"`)}
    <button class="btn primary" type="submit">Save new password</button>
  </form>`);
}
