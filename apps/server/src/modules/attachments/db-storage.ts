import { Readable } from "node:stream";
import type { TabulaDb } from "@tabula/db";
import type { TabulaStorage } from "@tabula/storage";
import { sql } from "kysely";

/** Attachment bodies in `data.attachment_blobs`; served (and uploaded) through the API like the local driver. */
export function createDbStorage(db: TabulaDb): TabulaStorage {
  return {
    driver: "db",

    async ensureBucket(): Promise<void> {},

    async presignUpload() {
      throw new Error("Database storage does not support presigned uploads");
    },

    async presignDownload() {
      throw new Error("Database storage does not support presigned downloads");
    },

    async putObject(key, body, contentType): Promise<void> {
      await sql`
        INSERT INTO data.attachment_blobs (object_key, content_type, size_bytes, body)
        VALUES (${key}, ${contentType}, ${body.length}, ${body})
        ON CONFLICT (object_key) DO UPDATE
        SET content_type = EXCLUDED.content_type, size_bytes = EXCLUDED.size_bytes, body = EXCLUDED.body
      `.execute(db);
    },

    async headObject(key) {
      const r = await sql<{ size_bytes: string; content_type: string | null }>`
        SELECT size_bytes, content_type FROM data.attachment_blobs WHERE object_key = ${key}
      `.execute(db);
      const row = r.rows[0];
      return row ? { size: Number(row.size_bytes), contentType: row.content_type } : null;
    },

    async readPrefix(key, bytes): Promise<Buffer> {
      const r = await sql<{ head: Buffer }>`
        SELECT substring(body FROM 1 FOR ${bytes}) AS head FROM data.attachment_blobs WHERE object_key = ${key}
      `.execute(db);
      return r.rows[0]?.head ?? Buffer.alloc(0);
    },

    async openReadStream(key): Promise<Readable> {
      const r = await sql<{ body: Buffer }>`
        SELECT body FROM data.attachment_blobs WHERE object_key = ${key}
      `.execute(db);
      const body = r.rows[0]?.body;
      if (!body) throw Object.assign(new Error("Object not found"), { code: "ENOENT" });
      return Readable.from([body]);
    },

    async deleteObject(key): Promise<void> {
      await sql`DELETE FROM data.attachment_blobs WHERE object_key = ${key}`.execute(db);
    },
  };
}
