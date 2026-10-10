import { decryptMfaSecret, encryptMfaSecret } from "@tabula/auth";
import type { TabulaDb } from "@tabula/db";
import { sql } from "kysely";
import { SyncError } from "../sync/source.js";

export interface ConnectionRow {
  id: string;
  org_id: string;
  user_id: string;
  provider: "hubspot";
  name: string;
  account_id: string | null;
  account_label: string | null;
  credentials: string;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

export interface ConnectionCredentials {
  accessToken: string;
}

export function sealCredentials(creds: ConnectionCredentials, key: Buffer): string {
  return encryptMfaSecret(JSON.stringify(creds), key);
}

export function openCredentials(row: Pick<ConnectionRow, "credentials">, key: Buffer): ConnectionCredentials {
  try {
    const parsed = JSON.parse(decryptMfaSecret(row.credentials, key)) as Partial<ConnectionCredentials>;
    if (typeof parsed.accessToken !== "string") throw new Error("missing token");
    return { accessToken: parsed.accessToken };
  } catch {
    throw new SyncError("The saved credentials for this connection can't be read. Reconnect the account.");
  }
}

export async function loadConnection(db: TabulaDb, id: string): Promise<ConnectionRow | null> {
  const r = await sql<ConnectionRow>`SELECT * FROM core.integration_connections WHERE id = ${id} AND deleted_at IS NULL`.execute(db);
  return r.rows[0] ?? null;
}

export function connectionDto(c: ConnectionRow) {
  return {
    id: c.id,
    provider: c.provider,
    name: c.name,
    accountId: c.account_id,
    accountLabel: c.account_label,
    createdAt: new Date(c.created_at).toISOString(),
  };
}
