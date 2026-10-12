import { createHmac, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { createLocalStorage, type TabulaStorage } from "@tabula/storage";
import type { AppContext } from "../../lib/app-context.js";
import { createDbStorage } from "./db-storage.js";

/**
 * Attachment storage selection for new uploads.
 *
 * `TABULA_STORAGE_DRIVER`:
 *  - `db`     → bodies in Postgres (`data.attachment_blobs`), served by the API. Default.
 *  - `local`  → files under `<repo>/.data/uploads` (or `TABULA_UPLOAD_DIR`), served by the API.
 *               Not for hosts that wipe the disk on deploy (Render, Heroku…).
 *  - `gcs`    → the GCS bucket configured via GCS_* env (ctx.storage).
 *  - `none`   → uploads disabled (503).
 */
let cached: { key: string; storage: TabulaStorage | null } | null = null;
let local: TabulaStorage | null = null;
let dbStorage: TabulaStorage | null = null;

/** Drivers whose files are uploaded and downloaded through the API (no presigned URLs). */
export function isProxiedDriver(driver: string): boolean {
  return driver === "local" || driver === "db";
}

/** Storage holding an existing attachment (by its row's `storage_driver`). */
export function storageForDriver(ctx: AppContext, driver: string): TabulaStorage | null {
  if (driver === "local") {
    local ??= createLocalStorage(localUploadDir());
    return local;
  }
  if (driver === "db") {
    dbStorage ??= createDbStorage(ctx.db);
    return dbStorage;
  }
  return ctx.storage;
}

function findRepoRoot(start: string): string {
  let dir = path.resolve(start);
  for (let i = 0; i < 8; i++) {
    if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(start);
}

export function localUploadDir(): string {
  const configured = process.env["TABULA_UPLOAD_DIR"];
  if (configured) return path.resolve(configured);
  return path.join(findRepoRoot(process.cwd()), ".data", "uploads");
}

export function resolveAttachmentStorage(ctx: AppContext): TabulaStorage | null {
  const requested = (process.env["TABULA_STORAGE_DRIVER"] ?? "").trim().toLowerCase();
  const key = `${requested}|${ctx.storage ? "gcs" : "none"}|${ctx.env.NODE_ENV}`;
  if (cached && cached.key === key) return cached.storage;

  let storage: TabulaStorage | null;
  if (requested === "none") {
    storage = null;
  } else if (requested === "gcs") {
    storage = ctx.storage;
  } else if (requested === "local") {
    storage = storageForDriver(ctx, "local");
    void storage?.ensureBucket().catch(() => undefined);
  } else {
    storage = storageForDriver(ctx, "db");
  }
  cached = { key, storage };
  return storage;
}

export const MAX_UPLOAD_BYTES = Number(
  process.env["TABULA_MAX_UPLOAD_BYTES"] ?? 100 * 1024 * 1024,
);
/** Public (anonymous form) uploads are capped lower. */
export const MAX_PUBLIC_UPLOAD_BYTES = Math.min(MAX_UPLOAD_BYTES, 20 * 1024 * 1024);

// ── Signed tokens (HMAC, stateless) ─────────────────────────────────────────

function secret(ctx: AppContext): string {
  return `${ctx.env.SESSION_SECRET}:attachments`;
}

export function signPayload(ctx: AppContext, payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = createHmac("sha256", secret(ctx)).update(body).digest("base64url");
  return `${body}.${mac}`;
}

export function verifyPayload<T extends Record<string, unknown>>(
  ctx: AppContext,
  token: string,
): (T & { exp?: number }) | null {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = createHmac("sha256", secret(ctx)).update(body).digest("base64url");
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T & {
      exp?: number;
    };
    if (typeof parsed.exp === "number" && parsed.exp < Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Compact signed download token (route params are limited to 100 chars):
 * `<uuid hex>.<exp base36>.<mac 22>`.
 */
export function signDownloadToken(ctx: AppContext, attachmentId: string, exp: number): string {
  const hex = attachmentId.replace(/-/g, "").toLowerCase();
  const e = exp.toString(36);
  const mac = createHmac("sha256", secret(ctx)).update(`dl:${hex}.${e}`).digest("base64url").slice(0, 22);
  return `${hex}.${e}.${mac}`;
}

export function verifyDownloadToken(ctx: AppContext, token: string): string | null {
  const m = /^([0-9a-f]{32})\.([0-9a-z]+)\.([A-Za-z0-9_-]{22})$/.exec(token);
  if (!m) return null;
  const [, hex, e, mac] = m as unknown as [string, string, string, string];
  const expected = createHmac("sha256", secret(ctx)).update(`dl:${hex}.${e}`).digest("base64url").slice(0, 22);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (parseInt(e, 36) < Date.now()) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
