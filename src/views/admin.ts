import html from "./admin/admin.html";
import css from "./admin/admin.css";
import js from "./admin/admin.client.js";

/** The admin is a single self-contained page: CSS and JS are inlined at serve time. */
export function adminPage(): string {
  return html.replace("/*__CSS__*/", () => css).replace("/*__JS__*/", () => js);
}
