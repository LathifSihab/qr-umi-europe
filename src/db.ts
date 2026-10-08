import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import type { Env, Lang } from "./config";

export interface Manual {
  lang: Lang;
  r2_key: string;
  original_name: string;
  size_bytes: number;
  uploaded_at: string;
  uploaded_by: string | null;
}

export interface Product {
  code: string;
  name: string;
  created_at: string;
  updated_at: string;
  manuals: Manual[];
}

export interface NewManual {
  r2_key: string;
  original_name: string;
  size_bytes: number;
  uploaded_by: string | null;
}

export interface User {
  email: string;
  password_hash: string;
}

type Sql = NeonQueryFunction<false, false>;

// Products with their manuals as a JSON array, so a list is a single round trip.
const PRODUCT_COLUMNS = `
  p.code, p.name, p.created_at, p.updated_at,
  COALESCE(
    (SELECT json_agg(json_build_object(
        'lang', m.lang, 'r2_key', m.r2_key, 'original_name', m.original_name,
        'size_bytes', m.size_bytes, 'uploaded_at', m.uploaded_at, 'uploaded_by', m.uploaded_by
      ) ORDER BY m.lang)
     FROM manuals m WHERE m.product_code = p.code),
    '[]'::json
  ) AS manuals`;

function toProduct(row: Record<string, any>): Product {
  return {
    code: row.code,
    name: row.name,
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
    manuals: (row.manuals as any[]).map((m) => ({
      ...m,
      uploaded_at: new Date(m.uploaded_at).toISOString(),
    })),
  };
}

export class Db {
  private sql: Sql;

  constructor(databaseUrl: string) {
    this.sql = neon(databaseUrl);
  }

  static from(env: Env): Db {
    return new Db(env.DATABASE_URL);
  }

  async listProducts(q?: string): Promise<Product[]> {
    const search = q?.trim();
    const rows = search
      ? await this.sql.query(
          `SELECT ${PRODUCT_COLUMNS} FROM products p
           WHERE p.code ILIKE $1 OR p.name ILIKE $1
           ORDER BY p.code`,
          [`%${search.replace(/[\\%_]/g, "\\$&")}%`],
        )
      : await this.sql.query(`SELECT ${PRODUCT_COLUMNS} FROM products p ORDER BY p.code`);
    return rows.map(toProduct);
  }

  async getProduct(code: string): Promise<Product | null> {
    const rows = await this.sql.query(
      `SELECT ${PRODUCT_COLUMNS} FROM products p WHERE p.code = $1`,
      [code],
    );
    return rows[0] ? toProduct(rows[0]) : null;
  }

  /** Returns false if the code already exists. */
  async createProduct(code: string, name: string): Promise<boolean> {
    const rows = await this.sql`
      INSERT INTO products (code, name) VALUES (${code}, ${name})
      ON CONFLICT (code) DO NOTHING
      RETURNING code`;
    return rows.length === 1;
  }

  /** Returns false if the product doesn't exist. */
  async updateProductName(code: string, name: string): Promise<boolean> {
    const rows = await this.sql`
      UPDATE products SET name = ${name}, updated_at = now()
      WHERE code = ${code}
      RETURNING code`;
    return rows.length === 1;
  }

  /**
   * Deletes the product and its manual rows in one statement.
   * Returns the R2 keys to clean up, or null if the product didn't exist.
   */
  async deleteProduct(code: string): Promise<string[] | null> {
    const rows = await this.sql`
      WITH m AS (DELETE FROM manuals WHERE product_code = ${code} RETURNING r2_key),
           p AS (DELETE FROM products WHERE code = ${code} RETURNING code)
      SELECT (SELECT count(*) FROM p)::int AS deleted,
             COALESCE((SELECT array_agg(r2_key) FROM m), '{}') AS keys`;
    return rows[0].deleted === 1 ? (rows[0].keys as string[]) : null;
  }

  async getManual(code: string, lang: Lang): Promise<Manual | null> {
    const rows = await this.sql`
      SELECT lang, r2_key, original_name, size_bytes, uploaded_at, uploaded_by
      FROM manuals WHERE product_code = ${code} AND lang = ${lang}`;
    if (!rows[0]) return null;
    return { ...(rows[0] as Manual), uploaded_at: new Date(rows[0].uploaded_at).toISOString() };
  }

  /**
   * Inserts or replaces the manual row in a single round trip, which matters
   * because the database is far from most Worker locations. Returns the
   * updated product and the previous R2 key (to delete), or null if the
   * product doesn't exist.
   */
  async upsertManual(
    code: string,
    lang: Lang,
    m: NewManual,
  ): Promise<{ product: Product; oldKey: string | null } | null> {
    const rows = await this.sql.query(
      `WITH old AS (
         SELECT r2_key FROM manuals WHERE product_code = $1 AND lang = $2 FOR UPDATE
       ), up AS (
         INSERT INTO manuals (product_code, lang, r2_key, original_name, size_bytes, uploaded_by)
         SELECT $1, $2, $3, $4, $5, $6 WHERE EXISTS (SELECT 1 FROM products WHERE code = $1)
         ON CONFLICT (product_code, lang) DO UPDATE SET
           r2_key = EXCLUDED.r2_key,
           original_name = EXCLUDED.original_name,
           size_bytes = EXCLUDED.size_bytes,
           uploaded_by = EXCLUDED.uploaded_by,
           uploaded_at = now()
         RETURNING uploaded_at
       ), touch AS (
         UPDATE products SET updated_at = now() WHERE code = $1 RETURNING updated_at
       )
       SELECT (SELECT r2_key FROM old) AS old_key,
              (SELECT uploaded_at FROM up) AS new_uploaded_at,
              (SELECT updated_at FROM touch) AS new_updated_at,
              ${PRODUCT_COLUMNS}
       FROM products p WHERE p.code = $1`,
      [code, lang, m.r2_key, m.original_name, m.size_bytes, m.uploaded_by],
    );
    const row = rows[0];
    if (!row) return null;

    // The product columns are read from the snapshot before the write, so
    // apply the change here rather than spending another round trip.
    const product = toProduct({ ...row, updated_at: row.new_updated_at });
    const manual: Manual = {
      lang,
      r2_key: m.r2_key,
      original_name: m.original_name,
      size_bytes: m.size_bytes,
      uploaded_at: new Date(row.new_uploaded_at).toISOString(),
      uploaded_by: m.uploaded_by,
    };
    product.manuals = [...product.manuals.filter((x) => x.lang !== lang), manual]
      .sort((a, b) => (a.lang < b.lang ? -1 : 1));
    return { product, oldKey: (row.old_key as string | null) ?? null };
  }

  // ---------- users ----------

  async getUser(email: string): Promise<User | null> {
    const rows = await this.sql`SELECT email, password_hash FROM users WHERE email = ${email}`;
    return rows[0] ? { email: rows[0].email, password_hash: rows[0].password_hash } : null;
  }

  /** Creates the account, or sets a new password if it exists (logging out its sessions). */
  async upsertUser(email: string, passwordHash: string): Promise<void> {
    await this.sql`
      INSERT INTO users (email, password_hash) VALUES (${email}, ${passwordHash})
      ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, password_changed_at = now()`;
  }

  async deleteUser(email: string): Promise<void> {
    await this.sql`DELETE FROM users WHERE email = ${email}`;
  }

  /**
   * Stores a reset token hash for the account. Returns false when there's no
   * such account, or one was requested in the last minute (to limit email spam).
   */
  async createPasswordReset(email: string, tokenHash: string, ttlMinutes: number): Promise<boolean> {
    const rows = await this.sql`
      WITH cleanup AS (DELETE FROM password_resets WHERE expires_at < now())
      INSERT INTO password_resets (token_hash, email, expires_at)
      SELECT ${tokenHash}, u.email, now() + make_interval(mins => ${ttlMinutes})
      FROM users u
      WHERE u.email = ${email}
        AND NOT EXISTS (
          SELECT 1 FROM password_resets r
          WHERE r.email = u.email AND r.created_at > now() - interval '1 minute'
        )
      RETURNING email`;
    return rows.length === 1;
  }

  /** The email a valid, unexpired reset token belongs to. */
  async findPasswordReset(tokenHash: string): Promise<string | null> {
    const rows = await this.sql`
      SELECT email FROM password_resets WHERE token_hash = ${tokenHash} AND expires_at > now()`;
    return (rows[0]?.email as string | undefined) ?? null;
  }

  /**
   * Uses up the token and sets the new password in one statement; also voids
   * the account's other reset links. Returns the email, or null if the token
   * is invalid, expired or already used.
   */
  async resetPassword(tokenHash: string, passwordHash: string): Promise<string | null> {
    const rows = await this.sql`
      WITH used AS (
        DELETE FROM password_resets WHERE token_hash = ${tokenHash} AND expires_at > now() RETURNING email
      ), others AS (
        DELETE FROM password_resets WHERE email IN (SELECT email FROM used)
      )
      UPDATE users SET password_hash = ${passwordHash}, password_changed_at = now()
      FROM used WHERE users.email = used.email
      RETURNING users.email`;
    return (rows[0]?.email as string | undefined) ?? null;
  }

  /** Removes one manual row. Returns its R2 key, or null if there was none. */
  async deleteManual(code: string, lang: Lang): Promise<string | null> {
    const rows = await this.sql`
      DELETE FROM manuals WHERE product_code = ${code} AND lang = ${lang}
      RETURNING r2_key`;
    return (rows[0]?.r2_key as string | undefined) ?? null;
  }
}
