import { decryptMfaSecret, encryptMfaSecret } from "@tabula/auth";
import type { TabulaDb } from "@tabula/db";
import { sql } from "kysely";
import { SyncError } from "../sync/source.js";

export const CONNECTION_PROVIDERS = ["hubspot", "airtable", "gmail", "slack"] as const;
export type ConnectionProvider = (typeof CONNECTION_PROVIDERS)[number];

export const PROVIDER_LABELS: Record<ConnectionProvider, string> = {
  hubspot: "HubSpot",
  airtable: "Airtable",
  gmail: "Gmail",
  slack: "Slack",
};

export interface ConnectionRow {
  id: string;
  org_id: string;
  user_id: string;
  provider: ConnectionProvider;
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
  /** OAuth connections (Gmail): exchanged for a new access token when it expires. */
  refreshToken?: string;
  /** Epoch ms when `accessToken` stops working. */
  expiresAt?: number;
}

export function sealCredentials(creds: ConnectionCredentials, key: Buffer): string {
  return encryptMfaSecret(JSON.stringify(creds), key);
}

export function openCredentials(row: Pick<ConnectionRow, "credentials">, key: Buffer): ConnectionCredentials {
  try {
    const parsed = JSON.parse(decryptMfaSecret(row.credentials, key)) as Partial<ConnectionCredentials>;
    if (typeof parsed.accessToken !== "string") throw new Error("missing token");
    return {
      accessToken: parsed.accessToken,
      ...(typeof parsed.refreshToken === "string" ? { refreshToken: parsed.refreshToken } : {}),
      ...(typeof parsed.expiresAt === "number" ? { expiresAt: parsed.expiresAt } : {}),
    };
  } catch {
    throw new SyncError("The saved credentials for this connection can't be read. Reconnect the account.");
  }
}

export async function loadConnection(db: TabulaDb, id: string): Promise<ConnectionRow | null> {
  const r = await sql<ConnectionRow>`SELECT * FROM core.integration_connections WHERE id = ${id} AND deleted_at IS NULL`.execute(db);
  return r.rows[0] ?? null;
}

/** Connections are personal: everything the user connected, in any organization. */
export async function userConnections(db: TabulaDb, userId: string): Promise<ConnectionRow[]> {
  const r = await sql<ConnectionRow>`
    SELECT * FROM core.integration_connections
    WHERE user_id = ${userId} AND deleted_at IS NULL
    ORDER BY created_at
  `.execute(db);
  return r.rows;
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
