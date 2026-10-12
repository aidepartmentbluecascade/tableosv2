import type { Database } from "@tabula/db";
import { sql, type Transaction } from "kysely";
import { pushHubSpotEdits, type PushDeps, type PushableSync } from "../integrations/hubspot-push.js";

type Trigger = (syncId: string, recordIds: string[]) => void;
let trigger: Trigger | null = null;

/**
 * Queue edits to a two-way synced table for writing back to the source.
 * Called inside the edit's transaction; sync runs ("system") are never queued.
 */
export async function noteSyncEdits(
  trx: Transaction<Database>,
  tableId: string,
  edits: Map<string, string[]>,
  afterCommit?: (fn: () => Promise<void> | void) => void,
): Promise<void> {
  if (edits.size === 0) return;
  const r = await sql<{ id: string; field_map: Record<string, string>; writable_keys: string[] }>`
    SELECT id, field_map, writable_keys FROM data.table_syncs WHERE table_id = ${tableId} AND two_way AND provider <> 'tableos'
  `.execute(trx);
  const s = r.rows[0];
  if (!s) return;
  const writable = new Set((s.writable_keys ?? []).map((k) => s.field_map?.[k]).filter((x): x is string => Boolean(x)));
  const queued: string[] = [];
  for (const [recordId, fieldIds] of edits) {
    const fields = [...new Set(fieldIds.filter((f) => writable.has(f)))];
    if (!fields.length) continue;
    queued.push(recordId);
    await sql`
      INSERT INTO data.table_sync_pushes AS p (sync_id, dest_record_id, field_ids, edited_at)
      VALUES (${s.id}, ${recordId}, ${JSON.stringify(fields)}::jsonb, clock_timestamp())
      ON CONFLICT (sync_id, dest_record_id) DO UPDATE SET
        field_ids = (
          SELECT coalesce(jsonb_agg(DISTINCT x), '[]'::jsonb)
          FROM jsonb_array_elements_text(
            CASE WHEN p.pushed_at IS NULL OR p.pushed_at < p.edited_at THEN p.field_ids ELSE '[]'::jsonb END || EXCLUDED.field_ids
          ) AS x
        ),
        edited_at = clock_timestamp(), attempts = 0, last_error = NULL
    `.execute(trx);
  }
  if (queued.length) {
    // The local values no longer match the last pull, so the next pull compares them afresh.
    await sql`
      UPDATE data.table_sync_records SET content_hash = ''
      WHERE sync_id = ${s.id} AND dest_record_id = ANY(${queued}::uuid[])
    `.execute(trx);
  }
  if (queued.length && trigger && afterCommit) afterCommit(() => trigger?.(s.id, queued));
}

interface Logger {
  warn: (obj: unknown, msg?: string) => void;
}

/** Pushes queued edits shortly after they're committed (API process). */
export function startTwoWayPusher(deps: PushDeps, log: Logger): void {
  const timers = new Map<string, NodeJS.Timeout>();
  const running = new Set<string>();
  const again = new Set<string>();

  async function run(syncId: string): Promise<void> {
    if (running.has(syncId)) {
      again.add(syncId);
      return;
    }
    running.add(syncId);
    try {
      const r = await sql<PushableSync>`SELECT * FROM data.table_syncs WHERE id = ${syncId}`.execute(deps.db);
      const sync = r.rows[0];
      if (!sync) return;
      const res = await pushHubSpotEdits(deps, sync);
      if (res.error) {
        await sql`UPDATE data.table_syncs SET last_error = ${res.error.slice(0, 500)}, updated_at = now() WHERE id = ${syncId}`.execute(deps.db);
      } else if (res.pushed) {
        await sql`
          UPDATE data.table_syncs SET last_error = NULL, updated_at = now()
          WHERE id = ${syncId} AND status <> 'error' AND last_error LIKE 'Couldn''t update%'
        `.execute(deps.db);
      }
    } catch (err) {
      log.warn({ syncId, err: err instanceof Error ? err.message : err }, "Two-way sync push failed");
    } finally {
      running.delete(syncId);
      if (again.delete(syncId)) schedule(syncId);
    }
  }

  function schedule(syncId: string): void {
    clearTimeout(timers.get(syncId));
    timers.set(
      syncId,
      setTimeout(() => {
        timers.delete(syncId);
        void run(syncId);
      }, 1_000),
    );
  }

  trigger = (syncId, recordIds) => {
    // Stamp after commit so a push that read the record before this commit still counts it as pending.
    void sql`
      UPDATE data.table_sync_pushes SET edited_at = clock_timestamp()
      WHERE sync_id = ${syncId} AND dest_record_id = ANY(${recordIds}::uuid[])
    `
      .execute(deps.db)
      .catch(() => undefined)
      .finally(() => schedule(syncId));
  };
}