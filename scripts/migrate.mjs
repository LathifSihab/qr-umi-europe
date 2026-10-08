// Applies migrations/*.sql in order to the database in DATABASE_URL.
// Without DATABASE_URL set, it falls back to the value in .dev.vars (Neon dev branch).
//
//   npm run migrate                                  # dev branch
//   DATABASE_URL="postgres://...prod..." npm run migrate   # production branch
import { neon } from "@neondatabase/serverless";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

function readDevVars() {
  if (!existsSync(".dev.vars")) return {};
  const vars = {};
  for (const line of readFileSync(".dev.vars", "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m) vars[m[1]] = m[2];
  }
  return vars;
}

const url = process.env.DATABASE_URL || readDevVars().DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set and .dev.vars has none.");
  process.exit(1);
}

const sql = neon(url);
const host = new URL(url).host;
console.log(`Migrating ${host}`);

await sql`CREATE TABLE IF NOT EXISTS schema_migrations (
  name TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`;
const applied = new Set((await sql`SELECT name FROM schema_migrations`).map((r) => r.name));

const files = readdirSync("migrations").filter((f) => f.endsWith(".sql")).sort();
for (const file of files) {
  if (applied.has(file)) continue;
  const text = readFileSync(join("migrations", file), "utf8");
  const statements = text
    .split(/;\s*$/m)
    .map((s) => s.trim())
    .filter((s) => s.replace(/--.*$/gm, "").trim());
  await sql.transaction([
    ...statements.map((s) => sql.query(s)),
    sql`INSERT INTO schema_migrations (name) VALUES (${file})`,
  ]);
  console.log(`  applied ${file}`);
}
console.log("Up to date.");
