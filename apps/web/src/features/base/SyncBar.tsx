import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { TableDto } from "../../lib/api.ts";
import { syncApi } from "../../lib/api-areas/sync.ts";
import { toast } from "../../app/toast.tsx";
import styles from "./base-shell.module.css";

function ago(iso: string | null, now: number): string {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(iso).toLocaleDateString();
}

/** Shown above a synced table: where the data comes from and how fresh it is. */
export function SyncBar({ baseId, table }: { baseId: string; table: TableDto }) {
  const qc = useQueryClient();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const run = useMutation({
    mutationFn: () => syncApi.runNow(baseId, table.id),
    onSuccess: async (res) => {
      await qc.invalidateQueries({ queryKey: ["bases", baseId] });
      void qc.invalidateQueries({ queryKey: ["records", baseId, table.id] });
      if (res.sync.lastError) toast.error(new Error(res.sync.lastError), "Sync failed");
    },
    onError: (err) => toast.error(err, "Could not sync"),
  });
  const toggleTwoWay = useMutation({
    mutationFn: (twoWay: boolean) => syncApi.update(baseId, table.id, { twoWay }),
    onSuccess: async (res) => {
      await qc.invalidateQueries({ queryKey: ["bases", baseId] });
      toast.success(res.sync.twoWay ? "Two-way sync on: edits here update HubSpot" : "Two-way sync off");
    },
    onError: (err) => toast.error(err, "Could not change two-way sync"),
  });
  const s = table.sync;
  const firstRun = Boolean(s && !s.lastSyncedAt);
  useEffect(() => {
    if (!firstRun) return;
    const t = setInterval(() => void qc.invalidateQueries({ queryKey: ["bases", baseId] }, { cancelRefetch: false }), 4_000);
    return () => clearInterval(t);
  }, [firstRun, qc, baseId]);
  const lastSyncedAt = s?.lastSyncedAt ?? null;
  useEffect(() => {
    if (lastSyncedAt) void qc.invalidateQueries({ queryKey: ["records", baseId, table.id] });
  }, [lastSyncedAt, qc, baseId, table.id]);
  if (!s) return null;
  return (
    <div className={styles.syncBar} data-state={s.status} role="status">
      <span aria-hidden>{s.twoWay ? "⇄" : "→"}</span>
      <span>
        {s.twoWay ? "Two-way sync with" : "Synced from"} <strong>{s.sourceBaseName ?? "another base"}</strong> ›{" "}
        <strong>{s.sourceTableName ?? "a table"}</strong>
        {" · "}
        {s.status === "paused"
          ? "paused"
          : s.status === "error"
            ? <span className={styles.syncErr}>failed: {s.lastError}</span>
            : firstRun
              ? "first sync in progress…"
              : `updated ${ago(s.lastSyncedAt, now)}`}
        {s.status !== "error" && s.lastError ? (
          <>
            {" · "}
            <span className={styles.syncErr}>{s.lastError}</span>
          </>
        ) : null}
        {" · "}
        {s.twoWay
          ? `edits to ${s.editableFieldIds.length} synced field${s.editableFieldIds.length === 1 ? "" : "s"} are written back to the source.`
          : "synced fields are read-only here; fields you add stay editable."}
      </span>
      {s.provider === "hubspot" ? (
        <label className={styles.syncToggle} title="Write edits to synced fields back to HubSpot">
          <input
            type="checkbox"
            checked={s.twoWay}
            disabled={toggleTwoWay.isPending}
            onChange={(e) => toggleTwoWay.mutate(e.target.checked)}
          />
          Two-way
        </label>
      ) : null}
      <button type="button" className={styles.syncBtn} onClick={() => run.mutate()} disabled={run.isPending}>
        {run.isPending ? "Syncing…" : "Sync now"}
      </button>
    </div>
  );
}
