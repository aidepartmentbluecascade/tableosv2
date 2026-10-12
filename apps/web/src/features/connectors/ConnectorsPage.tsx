import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { connectionsQueryKey } from "../../lib/api-areas/integrations.ts";
import { uiStyles } from "../../app/ui.tsx";
import { errorMessage } from "../../app/toast.tsx";
import accountStyles from "../account/account.module.css";
import { confirmDisconnect, CONNECTOR_PROVIDERS, ConnectProvider, connectionsOf, ProviderLogo, useConnections, useDisconnect } from "./connect.tsx";
import styles from "./connectors.module.css";

export interface ConnectorsNotice {
  connected?: string | undefined;
  reconnected?: string | undefined;
  connectError?: string | undefined;
}

/** Settings → Connectors: every external account the user has connected, usable in all of their bases. */
export function ConnectorsPage({ notice, onBack, onNoticeShown }: { notice: ConnectorsNotice; onBack?: () => void; onNoticeShown: () => void }) {
  const qc = useQueryClient();
  const conns = useConnections();
  const disconnect = useDisconnect();
  const [shown] = useState(notice);
  useEffect(() => {
    if (!notice.connected && !notice.connectError) return;
    if (notice.connected) void qc.invalidateQueries({ queryKey: connectionsQueryKey });
    onNoticeShown();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const gmailAvailable = conns.data?.providers.gmail.available ?? false;

  return (
    <div className={accountStyles.page}>
      <header className={accountStyles.header}>
        {onBack ? (
          <button type="button" className={accountStyles.back} onClick={onBack}>
            ← Back
          </button>
        ) : (
          <a className={accountStyles.back} href="/">
            ← Home
          </a>
        )}
        <h1 className={accountStyles.title}>Connectors</h1>
      </header>
      <main className={accountStyles.main}>
        <p className={accountStyles.muted}>
          Connect your accounts once and use them in every base: add synced tables from <em>+ Add or import → Sync from…</em>. Connections are
          personal — only you can use the accounts you connect. Gmail and Slack are connected from the automation steps that use them.
        </p>
        {shown.connected ? (
          <div role="status" className={accountStyles.ok}>
            {shown.connected === "gmail" ? "Gmail" : shown.connected} {shown.reconnected ? "reconnected" : "connected"}.
          </div>
        ) : null}
        {shown.connectError ? (
          <div role="alert" className={accountStyles.error}>
            {shown.connectError}
          </div>
        ) : null}
        {conns.isError ? (
          <div role="alert" className={accountStyles.error}>
            {errorMessage(conns.error)}
          </div>
        ) : null}
        <div className={styles.providers}>
          {CONNECTOR_PROVIDERS.map((p) => {
            const list = connectionsOf(conns.data?.connections, p.key);
            return (
              <section key={p.key} className={styles.card} aria-labelledby={`prov-${p.key}`}>
                <div className={styles.cardHead}>
                  <ProviderLogo provider={p.key} />
                  <div className={styles.cardText}>
                    <h2 id={`prov-${p.key}`} className={styles.cardTitle}>
                      {p.label}
                    </h2>
                    <p className={accountStyles.muted}>{p.description}</p>
                    <div className={styles.uses}>
                      {p.uses.map((u) => (
                        <span key={u} className={styles.use}>
                          {u}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
                {conns.isLoading ? <p className={accountStyles.muted}>Loading…</p> : null}
                {list.length ? (
                  <ul className={styles.accounts}>
                    {list.map((c) => (
                      <li key={c.id} className={styles.account}>
                        <div className={styles.accountText}>
                          <span className={styles.accountName}>{c.name}</span>
                          <span className={accountStyles.muted}>
                            {c.accountLabel && c.accountLabel !== c.name ? `${c.accountLabel} · ` : ""}
                            connected {new Date(c.createdAt).toLocaleDateString()}
                            {c.syncedTables ? ` · ${c.syncedTables} synced table${c.syncedTables === 1 ? "" : "s"}` : ""}
                          </span>
                        </div>
                        <button
                          type="button"
                          className={uiStyles.btnGhost}
                          disabled={disconnect.isPending}
                          onClick={() => {
                            if (confirmDisconnect(c)) disconnect.mutate(c);
                          }}
                        >
                          Disconnect
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {conns.data ? (
                  <ConnectProvider
                    provider={p.key}
                    gmailAvailable={gmailAvailable}
                    returnTo="/connectors"
                    {...(list.length ? { buttonLabel: `+ Connect another ${p.label} account` } : {})}
                  />
                ) : null}
              </section>
            );
          })}
        </div>
      </main>
    </div>
  );
}
