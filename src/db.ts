import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import type { Env, Lang } from "./config";

export interface Document {
  id: number;
  lang: Lang;
  title: string;
  position: number;
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
  /** Ordered by language, then position. */
  documents: Document[];
}

export interface NewFile {
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

const DOCUMENT_FIELDS = `d.id, d.lang, d.title, d.position, d.r2_key, d.original_name, d.size_bytes, d.uploaded_at, d.uploaded_by`;

// Products with their documents as a JSON array, so a list is a single round trip.
const PRODUCT_COLUMNS = `
  p.code, p.name, p.created_at, p.updated_at,
  COALESCE(
    (SELECT json_agg(json_build_object(
        'id', d.id, 'lang', d.lang, 'title', d.title, 'position', d.position,
        'r2_key', d.r2_key, 'original_name', d.original_name, 'size_bytes', d.size_bytes,
        'uploaded_at', d.uploaded_at, 'uploaded_by', d.uploaded_by
      ) ORDER BY d.lang, d.position, d.id)
     FROM documents d WHERE d.product_code = p.code),
    '[]'::json
  ) AS documents`;

function toDocument(row: Record<string, any>): Document {
  return {
    id: Number(row.id),
    lang: row.lang,
    title: row.title,
    position: Number(row.position),
    r2_key: row.r2_key,
    original_name: row.original_name,
    size_bytes: Number(row.size_bytes),
    uploaded_at: new Date(row.uploaded_at).toISOString(),
    uploaded_by: row.uploaded_by ?? null,
  };
}

function toProduct(row: Record<string, any>): Product {
  return {
    code: row.code,
    name: row.name,
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
    documents: (row.documents as any[]).map(toDocument),
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
   * Deletes the product and its documents in one statement.
   * Returns the R2 keys to clean up, or null if the product didn't exist.
   */
  async deleteProduct(code: string): Promise<string[] | null> {
    const rows = await this.sql`
      WITH d AS (DELETE FROM documents WHERE product_code = ${code} RETURNING r2_key),
           p AS (DELETE FROM products WHERE code = ${code} RETURNING code)
      SELECT (SELECT count(*) FROM p)::int AS deleted,
             COALESCE((SELECT array_agg(r2_key) FROM d), '{}') AS keys`;
    return rows[0].deleted === 1 ? (rows[0].keys as string[]) : null;
  }

  // ---------- documents ----------
  // Each write is a single round trip, which matters because the database is
  // far from most Worker locations.

  async getDocument(code: string, id: number): Promise<Document | null> {
    const rows = await this.sql.query(
      `SELECT ${DOCUMENT_FIELDS} FROM documents d WHERE d.product_code = $1 AND d.id = $2`,
      [code, id],
    );
    return rows[0] ? toDocument(rows[0]) : null;
  }

  /** Adds a document at the end of its language's list. Returns null if the product doesn't exist. */
  async createDocument(code: string, lang: Lang, title: string, f: NewFile): Promise<Document | null> {
    const rows = await this.sql.query(
      `WITH ins AS (
         INSERT INTO documents (product_code, lang, title, position, r2_key, original_name, size_bytes, uploaded_by)
         SELECT $1, $2, $3,
                COALESCE((SELECT max(position) FROM documents WHERE product_code = $1 AND lang = $2), 0) + 1,
                $4, $5, $6, $7
         WHERE EXISTS (SELECT 1 FROM products WHERE code = $1)
         RETURNING *
       ), touch AS (
         UPDATE products SET updated_at = now() WHERE code = $1 AND EXISTS (SELECT 1 FROM ins)
       )
       SELECT ${DOCUMENT_FIELDS} FROM ins d`,
      [code, lang, title, f.r2_key, f.original_name, f.size_bytes, f.uploaded_by],
    );
    return rows[0] ? toDocument(rows[0]) : null;
  }

  /** Returns null if the document doesn't exist. */
  async updateDocumentTitle(code: string, id: number, title: string): Promise<Document | null> {
    const rows = await this.sql.query(
      `WITH up AS (
         UPDATE documents SET title = $3 WHERE product_code = $1 AND id = $2 RETURNING *
       ), touch AS (
         UPDATE products SET updated_at = now() WHERE code = $1 AND EXISTS (SELECT 1 FROM up)
       )
       SELECT ${DOCUMENT_FIELDS} FROM up d`,
      [code, id, title],
    );
    return rows[0] ? toDocument(rows[0]) : null;
  }

  /**
   * Points the document at a new PDF. Returns the updated document and the
   * previous R2 key (to delete), or null if the document doesn't exist.
   */
  async replaceDocumentFile(
    code: string,
    id: number,
    f: NewFile,
  ): Promise<{ document: Document; oldKey: string } | null> {
    const rows = await this.sql.query(
      // The FROM row is read before the update, so it still holds the old key.
      `WITH up AS (
         UPDATE documents d
         SET r2_key = $3, original_name = $4, size_bytes = $5, uploaded_by = $6, uploaded_at = now()
         FROM documents old
         WHERE d.product_code = $1 AND d.id = $2 AND old.id = d.id
         RETURNING d.*, old.r2_key AS old_key
       ), touch AS (
         UPDATE products SET updated_at = now() WHERE code = $1 AND EXISTS (SELECT 1 FROM up)
       )
       SELECT ${DOCUMENT_FIELDS}, d.old_key FROM up d`,
      [code, id, f.r2_key, f.original_name, f.size_bytes, f.uploaded_by],
    );
    return rows[0] ? { document: toDocument(rows[0]), oldKey: rows[0].old_key as string } : null;
  }

  /** Removes one document. Returns its R2 key, or null if there was none. */
  async deleteDocument(code: string, id: number): Promise<string | null> {
    const rows = await this.sql`
      WITH del AS (
        DELETE FROM documents WHERE product_code = ${code} AND id = ${id} RETURNING r2_key
      ), touch AS (
        UPDATE products SET updated_at = now() WHERE code = ${code} AND EXISTS (SELECT 1 FROM del)
      )
      SELECT r2_key FROM del`;
    return (rows[0]?.r2_key as string | undefined) ?? null;
  }

  /**
   * Orders a language's documents as listed in `ids`. Documents not listed
   * keep their place after the listed ones. Returns that language's
   * documents in their new order (empty if the product has none).
   */
  async reorderDocuments(code: string, lang: Lang, ids: number[]): Promise<Document[]> {
    const rows = await this.sql.query(
      `WITH ranked AS (
         SELECT id, row_number() OVER (
                  ORDER BY array_position($3::int[], id) NULLS LAST, position, id
                ) AS pos
         FROM documents WHERE product_code = $1 AND lang = $2
       ), up AS (
         UPDATE documents d SET position = ranked.pos FROM ranked
         WHERE d.id = ranked.id
         RETURNING d.*
       )
       SELECT ${DOCUMENT_FIELDS} FROM up d ORDER BY d.position`,
      [code, lang, ids],
    );
    return rows.map(toDocument);
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
}
