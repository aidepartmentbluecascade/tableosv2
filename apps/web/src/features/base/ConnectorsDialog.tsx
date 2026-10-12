import { Link } from "@tanstack/react-router";
import type { TableDto } from "../../lib/api.ts";
import type { ConnectorProvider } from "../../lib/api-areas/integrations.ts";
import { Dialog, uiStyles } from "../../app/ui.tsx";
import { errorMessage } from "../../app/toast.tsx";
import { confirmDisconnect, CONNECTOR_PROVIDERS, ConnectProvider, connectionsOf, ProviderLogo, useConnections, useDisconnect } from "../connectors/connect.tsx";
import type { AddMode } from "./TableTabs.tsx";
import styles from "./base-shell.module.css";

const SYNCABLE: Partial<Record<ConnectorProvider, AddMode>> = { hubspot: "hubspot", airtable: "airtable" };

/** Tools → Connectors: your connected accounts and the tables in this base synced from them. */
export function ConnectorsDialog({
  tables,
  onOpenTable,
  onSyncTable,
  onClose,
}: {
  tables: TableDto[];
  onOpenTable: (tableId: string) => void;
  onSyncTable: (mode: AddMode) => void;
  onClose: () => void;
}) {
  const conns = useConnections();
  const remove = useDisconnect();
  const gmailAvailable = conns.data?.providers.gmail.available ?? false;

  return (
    <Dialog
      title="Connectors"
      onClose={onClose}
      wide
      footer={
        <div className={styles.hsRow}>
          <Link to="/connectors" className={uiStyles.btn} style={{ textDecoration: "none" }}>
            Manage all connectors
          </Link>
          <button type="button" className={uiStyles.btnPrimary} onClick={onClose}>
            Done
          </button>
        </div>
      }
    >
      <p className={uiStyles.muted}>
        Accounts you connect work in all of your bases. Sync tables from Airtable or HubSpot into this base. Gmail and Slack are connected from the
        automation steps that use them.
      </p>
      {conns.isLoading ? <p className={uiStyles.muted}>Loading…</p> : null}
      {conns.isError ? <p className={uiStyles.error}>{errorMessage(conns.error)}</p> : null}
      <ul className={styles.connList}>
        {CONNECTOR_PROVIDERS.map((p) => {
          const list = connectionsOf(conns.data?.connections, p.key);
          const addMode = SYNCABLE[p.key];
          return (
            <li key={p.key} className={styles.connItem}>
              <div className={styles.connHead}>
                <ProviderLogo provider={p.key} size="sm" />
                <div className={styles.connInfo}>
                  <strong>{p.label}</strong>
                  <span className={uiStyles.muted}>{p.uses.join(" · ")}</span>
                </div>
                {addMode && list.length ? (
                  <button type="button" className={uiStyles.btn} onClick={() => onSyncTable(addMode)}>
                    Sync a table
                  </button>
                ) : null}
              </div>
              {list.map((c) => {
                const used = tables.filter((t) => t.sync?.connectionId === c.id);
                return (
                  <div key={c.id} className={styles.connAccount}>
                    <div className={styles.connHead}>
                      <div className={styles.connInfo}>
                        <span>{c.name}</span>
                        <span className={uiStyles.muted}>connected {new Date(c.createdAt).toLocaleDateString()}</span>
                      </div>
                      <button
                        type="button"
                        className={uiStyles.btnGhost}
                        disabled={remove.isPending}
                        onClick={() => {
                          if (confirmDisconnect(c)) remove.mutate(c);
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
                    ) : addMode ? (
                      <p className={styles.connNone}>No tables in this base use this account yet.</p>
                    ) : null}
                  </div>
                );
              })}
              {conns.data ? (
                <div className={styles.connAdd}>
                  <ConnectProvider
                    provider={p.key}
                    gmailAvailable={gmailAvailable}
                    {...(list.length ? { buttonLabel: "+ Connect another account" } : {})}
                  />
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </Dialog>
  );
}
