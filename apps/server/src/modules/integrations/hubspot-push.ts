import type { TabulaDb } from "@tabula/db";
import type { TabulaStorage } from "@tabula/storage";
import { sql } from "kysely";
import { pid } from "../../lib/public-ids.js";
import { serializeRecordsByIds } from "../records/serialize.js";
import { loadTableFieldRows } from "../schema/table-schema.js";
import { loadConnection, openCredentials } from "./connections.js";
import { HubSpotClient, HubSpotError, parseHubSpotConfig, PushValueError, toHubSpotValue } from "./hubspot.js";

/**
 * Two-way HubSpot syncs: local edits are queued in data.table_sync_pushes (in
 * the same transaction as the edit) and written to HubSpot here. A value
 * HubSpot rejects is dropped, so the next pull brings HubSpot's value back.
 */

const MAX_ATTEMPTS = 20;

export interface PushDeps {
  db: TabulaDb;
  storage?: TabulaStorage | null;
  secretKey?: Buffer | null;
}

export interface PushableSync {
  id: string;
  table_id: string;
  provider: string;
  two_way: boolean;
  connection_id: string | null;
  source_config: Record<string, unknown>;
  field_map: Record<string, string>;
  writable_keys: string[];
}

export interface PushResult {
  pushed: number;
  failed: number;
  /** Summary for the sync bar, or null when everything went through. */
  error: string | null;
}

const NOTHING: PushResult = { pushed: 0, failed: 0, error: null };

async function markDone(db: TabulaDb, syncId: string, ids: string[], start: Date): Promise<void> {
  if (!ids.length) return;
  // Edits made after `start` weren't part of this push and stay pending.
  await sql`
    UPDATE data.table_sync_pushes SET pushed_at = ${start}, attempts = 0, last_error = NULL
    WHERE sync_id = ${syncId} AND dest_record_id = ANY(${ids}::uuid[]) AND edited_at <= ${start}
  `.execute(db);
}

async function markRejected(db: TabulaDb, syncId: string, rejected: Map<string, string>, start: Date): Promise<void> {
  for (const [id, message] of rejected) {
    await sql`
      UPDATE data.table_sync_pushes SET pushed_at = ${start}, attempts = attempts + 1, last_error = ${message.slice(0, 500)}
      WHERE sync_id = ${syncId} AND dest_record_id = ${id} AND edited_at <= ${start}
    `.execute(db);
  }
}

async function markRetry(db: TabulaDb, syncId: string, ids: string[], message: string): Promise<void> {
  if (!ids.length) return;
  await sql`
    UPDATE data.table_sync_pushes SET attempts = attempts + 1, last_error = ${message.slice(0, 500)}
    WHERE sync_id = ${syncId} AND dest_record_id = ANY(${ids}::uuid[])
  `.execute(db);
}

function summary(failed: number, first: string): string {
  return `Couldn't update ${failed} record${failed === 1 ? "" : "s"} in HubSpot: ${first}`;
}

/** Write queued local edits of one sync to HubSpot. Never throws for HubSpot errors. */
export async function pushHubSpotEdits(deps: PushDeps, sync: PushableSync): Promise<PushResult> {
  if (sync.provider !== "hubspot" || !sync.two_way) return NOTHING;
  const { db } = deps;
  const start = (await sql<{ now: Date }>`SELECT clock_timestamp() AS now`.execute(db)).rows[0]!.now;
  const pending = await sql<{ dest_record_id: string; field_ids: string[] }>`
    SELECT dest_record_id, field_ids FROM data.table_sync_pushes
    WHERE sync_id = ${sync.id} AND (pushed_at IS NULL OR pushed_at < edited_at) AND attempts < ${MAX_ATTEMPTS}
    ORDER BY edited_at LIMIT 500
  `.execute(db);
  if (!pending.rows.length) return NOTHING;
  const ids = pending.rows.map((r) => r.dest_record_id);

  const conn = sync.connection_id ? await loadConnection(db, sync.connection_id) : null;
  if (!conn || !deps.secretKey) {
    const message = "The HubSpot connection for this sync was removed, so edits can't be sent to HubSpot.";
    await markRetry(db, sync.id, ids, message);
    return { pushed: 0, failed: ids.length, error: message };
  }

  try {
    const cfg = parseHubSpotConfig(sync.source_config);
    const client = new HubSpotClient(openCredentials(conn, deps.secretKey).accessToken);
    const props = new Map((await client.properties(cfg.object)).map((p) => [p.name, p]));
    const writable = new Set(sync.writable_keys ?? []);
    const keyByDest = new Map<string, string>();
    for (const [key, dest] of Object.entries(sync.field_map ?? {})) if (writable.has(key)) keyByDest.set(dest, key);
    const owner = props.get("hubspot_owner_id");
    const needsOwners = [...keyByDest.values()].includes("p:hubspot_owner_id") && owner && !(owner.options ?? []).length;
    const owners = needsOwners ? await client.ownerNames() : new Map<string, string>();
    const configById = new Map((await loadTableFieldRows(db, sync.table_id)).map((f) => [f.id, (f.config ?? {}) as Record<string, unknown>]));
    const wire = await serializeRecordsByIds(db, sync.table_id, ids, { storage: deps.storage ?? null });
    const byRec = new Map(wire.map((w) => [w.id, w]));
    const idField = sync.field_map["__id"];

    const done: string[] = [];
    const rejected = new Map<string, string>();
    const inputs: Array<{ dest: string; id: string; properties: Record<string, string> }> = [];
    for (const row of pending.rows) {
      const rec = byRec.get(pid("rec", row.dest_record_id));
      if (!rec) {
        done.push(row.dest_record_id);
        continue;
      }
      const hsId = idField ? rec.fields[pid("fld", idField)] : null;
      if (typeof hsId !== "string" || !hsId) {
        rejected.set(row.dest_record_id, "the record has no HubSpot ID");
        continue;
      }
      const properties: Record<string, string> = {};
      try {
        for (const fid of row.field_ids ?? []) {
          const key = keyByDest.get(fid);
          const p = key?.startsWith("p:") ? props.get(key.slice(2)) : undefined;
          if (!p) continue;
          properties[p.name] = toHubSpotValue(p, configById.get(fid), rec.fields[pid("fld", fid)], owners);
        }
      } catch (err) {
        if (!(err instanceof PushValueError)) throw err;
        rejected.set(row.dest_record_id, err.message);
        continue;
      }
      if (Object.keys(properties).length === 0) done.push(row.dest_record_id);
      else inputs.push({ dest: row.dest_record_id, id: hsId, properties });
    }

    if (inputs.length) {
      const results = await client.updateMany(
        cfg.object,
        inputs.map((i) => ({ id: i.id, properties: i.properties })),
      );
      for (const i of inputs) {
        const err = results.get(i.id);
        if (err) rejected.set(i.dest, err.message.replace(/^HubSpot request failed: /, ""));
        else done.push(i.dest);
      }
    }
    await markDone(db, sync.id, done, start);
    await markRejected(db, sync.id, rejected, start);
    const pushed = done.length;
    const failed = rejected.size;
    return { pushed, failed, error: failed ? summary(failed, [...rejected.values()][0]!) : null };
  } catch (err) {
    // Auth, scope, rate-limit or network trouble: keep everything queued and retry later.
    const message = err instanceof HubSpotError || err instanceof Error ? err.message : String(err);
    await markRetry(db, sync.id, ids, message);
    return { pushed: 0, failed: ids.length, error: summary(ids.length, message) };
  }
}

/**
 * Local records still waiting to be pushed, or pushed moments ago (HubSpot's
 * search can lag behind); a pull must not overwrite them. Rejected edits
 * aren't held, so HubSpot's value comes back on the next pull.
 */
export async function heldRecordIds(db: TabulaDb, syncId: string): Promise<Set<string>> {
  const r = await sql<{ dest_record_id: string }>`
    SELECT dest_record_id FROM data.table_sync_pushes
    WHERE sync_id = ${syncId}
      AND ((pushed_at IS NULL OR pushed_at < edited_at) AND attempts < ${MAX_ATTEMPTS}
           OR edited_at > now() - interval '3 minutes' AND last_error IS NULL)
  `.execute(db);
  return new Set(r.rows.map((x) => x.dest_record_id));
}

/** Whether the source refused any edit since `since`. */
export async function hasRejectedPushes(db: TabulaDb, syncId: string, since: Date | string | null): Promise<boolean> {
  const r = await sql<{ one: number }>`
    SELECT 1 AS one FROM data.table_sync_pushes
    WHERE sync_id = ${syncId} AND last_error IS NOT NULL AND pushed_at >= edited_at
      AND (${since}::timestamptz IS NULL OR pushed_at > ${since}::timestamptz)
    LIMIT 1
  `.execute(db);
  return r.rows.length > 0;
}

export async function prunePushes(db: TabulaDb, syncId: string): Promise<void> {
  await sql`
    DELETE FROM data.table_sync_pushes
    WHERE sync_id = ${syncId} AND edited_at < now() - interval '1 hour'
      AND (pushed_at >= edited_at OR attempts >= ${MAX_ATTEMPTS})
  `.execute(db);
}
