# UMI Europe – QR manuals

Printed QR codes on UMI products open `https://qr.umi-europe.com/m/{CODE}`, which shows the product's manual (one PDF per language). The client manages products and manuals in `/admin`.

Stack: Cloudflare Workers (Hono), Neon Postgres, Cloudflare R2. Admin login: email + password accounts (or Cloudflare Access).

## Local development

Requirements: Node 20+. No Cloudflare account is needed locally: R2 is simulated on disk (`.wrangler/state`), and the database is the Neon **dev** branch.

```sh
npm install
cp .dev.vars.example .dev.vars   # then paste the Neon dev-branch connection string
npm run migrate                  # apply migrations to the dev branch
npm run dev                      # http://localhost:8787
```

| URL | What |
|---|---|
| http://localhost:8787/admin | Admin. Login is skipped locally (`ENVIRONMENT=development`). |
| http://localhost:8787/m/{CODE} | Scan page (what the QR code opens) |
| http://localhost:8787/f/{CODE}/{lang} | The PDF itself |

Locally, `PUBLIC_BASE_URL` is `http://localhost:8787`, so QR codes made locally point to localhost. Don't print them.

## Scripts

| Command | What |
|---|---|
| `npm run dev` | Local server |
| `npm test` | Tests (talk to the Neon dev branch, so they need internet) |
| `npm run typecheck` | TypeScript check |
| `npm run migrate` | Apply `migrations/*.sql` to `DATABASE_URL` (defaults to `.dev.vars`) |
| `npm run user:add -- <email>` | Create an admin account or set a new password (asks for it). Add `--sql` to print SQL for the Neon SQL Editor instead. |

## Layout

- `src/index.ts`: router and auth guard for `/admin` and `/api`
- `src/routes/public.ts`: `/`, `/m/:code`, `/f/:code/:lang`, logo
- `src/routes/api.ts`: admin JSON API
- `src/db.ts`: Neon queries · `src/storage.ts`: R2 · `src/qr.ts`: SVG QR codes · `src/auth.ts`: sessions and Access JWT · `src/password.ts`: password hashing · `src/mail.ts`: reset emails (Resend)
- `src/views/scanPages.ts`: public pages (EN/NL/FR/DE) · `src/views/admin/`: admin page (plain HTML/CSS/JS)
- `assets/umi-logo.svg`: logo served at `/assets/umi-logo.svg`. UMI has no official SVG, so this is traced from the PNG on umi-europe.com (`assets/umi-logo.png`, kept as the source). Replace it if they ever supply a real vector file.

## Admin accounts

With the `SESSION_SECRET` secret set, `/admin` uses email + password accounts:

- `/login`: email and password (with a show/hide button). Sessions last 7 days.
- `/forgot`: sends a single-use reset link (valid 1 hour) through Resend. The page never says whether an email has an account.
- `/reset?token=…`: choose a new password. Changing a password logs out that account's other sessions.

Secrets: `SESSION_SECRET` (random; rotating it logs everyone out), `RESEND_API_KEY` (without it, reset links are written to the Worker logs instead of emailed). The sender is the `MAIL_FROM` var in `wrangler.jsonc`.

There's no sign-up page. Create accounts with `npm run user:add -- <email>` (dev) or `--sql` and the Neon SQL Editor (production).

Deployment steps are added in Phase 5.
