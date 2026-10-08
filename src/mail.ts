import type { Env } from "./config";

/**
 * Sends the password reset email through Resend. Without RESEND_API_KEY (local
 * development, or before Resend is set up) the link is written to the Worker
 * logs instead, which only Cloudflare account members can read.
 */
export async function sendPasswordResetEmail(env: Env, to: string, link: string): Promise<void> {
  if (!env.RESEND_API_KEY) {
    console.log(`[password reset] RESEND_API_KEY is not set. Link for ${to}: ${link}`);
    return;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: env.MAIL_FROM,
      to: [to],
      subject: "Reset your password – UMI QR manuals",
      text:
        `Someone asked to reset the password for ${to} on UMI QR manuals.\n\n` +
        `Choose a new password here (the link works once and expires in 1 hour):\n${link}\n\n` +
        "If you didn't ask for this, ignore this email. Your password won't change.",
    }),
  });
  if (!res.ok) console.error(`Resend failed (${res.status}): ${await res.text()}`);
}
