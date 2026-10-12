import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { TableDto } from "../../lib/api.ts";
import { integrationsApi } from "../../lib/api-areas/integrations.ts";
import { Dialog, uiStyles } from "../../app/ui.tsx";
import { errorMessage, toast } from "../../app/toast.tsx";
import { ConnectHubSpot } from "./HubSpotSyncSetup.tsx";
import styles from "./base-shell.module.css";

/** Tools → Connectors: external accounts linked to this base and the tables synced from them. */
export function ConnectorsDialog({
  baseId,
  tables,
  onOpenTable,
  onSyncTable,
  onClose,
}: {
  baseId: string;
  tables: TableDto[];
  onOpenTable: (tableId: string) => void;
  onSyncTable: () => void;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [connecting, setConnecting] = useState(false);
  const conns = useQuery({ queryKey: ["integration-connections", baseId], queryFn: () => integrationsApi.connections(baseId) });
  const remove = useMutation({
    mutationFn: (id: string) => integrationsApi.disconnect(baseId, id),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["integration-connections", baseId] });
      await qc.invalidateQueries({ queryKey: ["bases", baseId] });
      toast.success("HubSpot account disconnected");
    },
    onError: (err) => toast.error(err, "Could not disconnect"),
  });
  const list = conns.data?.connections ?? [];
  const synced = tables.filter((t) => t.sync?.provider === "hubspot");

  return (
    <Dialog
      title="Connectors"
      onClose={onClose}
      wide
      footer={
        <div className={styles.hsRow}>
          {!connecting ? (
            <button type="button" className={uiStyles.btn} onClick={() => setConnecting(true)}>
              + Connect HubSpot account
            </button>
          ) : null}
          <button type="button" className={uiStyles.btnPrimary} disabled={!list.length} onClick={onSyncTable}>
            Sync a table from HubSpot
          </button>
        </div>
      }
    >
      <p className={uiStyles.muted}>
        Bring records from other apps into this base as synced tables. HubSpot contacts, companies, deals and tickets are supported; turn on
        two-way sync on a table to write edits back to HubSpot.
      </p>
      {conns.isLoading ? <p className={uiStyles.muted}>Loading…</p> : null}
      {conns.isError ? <p className={uiStyles.error}>{errorMessage(conns.error)}</p> : null}
      {conns.data && !list.length && !connecting ? <p className={styles.connEmpty}>No accounts connected yet.</p> : null}
      <ul className={styles.connList}>
        {list.map((c) => {
          const used = synced.filter((t) => t.sync?.connectionId === c.id);
          return (
            <li key={c.id} className={styles.connItem}>
              <div className={styles.connHead}>
                <span className={styles.connLogo} aria-hidden>
                  H
                </span>
                <div className={styles.connInfo}>
                  <strong>{c.name}</strong>
                  <span className={uiStyles.muted}>
                    HubSpot{c.accountId ? ` · portal ${c.accountId}` : ""} · connected {new Date(c.createdAt).toLocaleDateString()}
                  </span>
                </div>
                <button
                  type="button"
                  className={uiStyles.btnGhost}
                  disabled={remove.isPending}
                  onClick={() => {
                    if (window.confirm(`Disconnect “${c.name}”? Tables synced with it stop updating (their data stays).`)) remove.mutate(c.id);
                  }}
                >
                  Disconnect
                </button>
              </div>
              {used.length ? (
                <ul className={styles.connTables}>
                  {used.map((t) => (
                    <li key={t.id}>
                      <button type="button" className={styles.connTable} onClick={() => onOpenTable(t.id)}>
                        <span>{t.name}</span>
                        <span className={uiStyles.muted}>
                          {t.sync?.sourceTableName} · {t.sync?.twoWay ? "two-way" : "one-way"}
                          {t.sync?.status === "paused" ? " · paused" : t.sync?.status === "error" ? " · failing" : ""}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className={styles.connNone}>No tables in this base use this account yet.</p>
              )}
            </li>
          );
        })}
      </ul>
      {connecting ? (
        <ConnectHubSpot
          baseId={baseId}
          onConnected={() => {
            setConnecting(false);
            toast.success("HubSpot connected");
          }}
          onCancel={() => setConnecting(false)}
        />
      ) : null}
    </Dialog>
  );
}
