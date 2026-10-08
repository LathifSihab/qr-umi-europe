import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import { readFileSync, existsSync } from "node:fs";

// Tests talk to the real Neon *dev* branch (DATABASE_URL from .dev.vars or the environment).
// R2 is simulated locally by Miniflare.
function devVar(name: string): string | undefined {
  if (process.env[name]) return process.env[name];
  if (!existsSync(".dev.vars")) return undefined;
  const line = readFileSync(".dev.vars", "utf8")
    .split(/\r?\n/)
    .find((l) => l.startsWith(`${name}=`));
  return line?.slice(name.length + 1).trim();
}

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          ENVIRONMENT: "test",
          DATABASE_URL: devVar("DATABASE_URL") ?? "",
        },
      },
    }),
  ],
  test: {
    testTimeout: 60000,
  },
});
