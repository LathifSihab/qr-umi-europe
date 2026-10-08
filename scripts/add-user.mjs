// Creates an admin account, or sets a new password for an existing one.
//
//   npm run user:add -- someone@example.com          # writes to DATABASE_URL (default: .dev.vars)
//   npm run user:add -- someone@example.com --sql    # prints SQL to run in the Neon SQL Editor
//
// The password is asked for without echoing, or read from USER_PASSWORD.
// The hash format matches src/password.ts.
import { neon } from "@neondatabase/serverless";
import { existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const ITERATIONS = 100_000;
const args = process.argv.slice(2);
const sqlOnly = args.includes("--sql");
const email = (args.find((a) => !a.startsWith("--")) ?? "").trim().toLowerCase();
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error("Usage: npm run user:add -- <email> [--sql]");
  process.exit(1);
}

function askHidden(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => rl.output.write(s.startsWith(question) ? s : "");
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
  });
}

const password = process.env.USER_PASSWORD ?? (await askHidden("Password: "));
if (password.length < 8) {
  console.error("Use at least 8 characters.");
  process.exit(1);
}

const b64url = (bytes) => Buffer.from(bytes).toString("base64url");
const salt = crypto.getRandomValues(new Uint8Array(16));
const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: ITERATIONS }, key, 256);
const hash = `pbkdf2-sha256$${ITERATIONS}$${b64url(salt)}$${b64url(new Uint8Array(bits))}`;

if (sqlOnly) {
  console.log(
    `INSERT INTO users (email, password_hash) VALUES ('${email.replace(/'/g, "''")}', '${hash}')\n` +
      "ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, password_changed_at = now();",
  );
  process.exit(0);
}

function devDatabaseUrl() {
  if (!existsSync(".dev.vars")) return undefined;
  return readFileSync(".dev.vars", "utf8").match(/^\s*DATABASE_URL\s*=\s*(.*)\s*$/m)?.[1];
}
const url = process.env.DATABASE_URL || devDatabaseUrl();
if (!url) {
  console.error("DATABASE_URL is not set and .dev.vars has none.");
  process.exit(1);
}
const sql = neon(url);
await sql`
  INSERT INTO users (email, password_hash) VALUES (${email}, ${hash})
  ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, password_changed_at = now()`;
console.log(`Saved account ${email} on ${new URL(url).host}`);
