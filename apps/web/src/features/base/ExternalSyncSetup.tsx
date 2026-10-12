import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { integrationsApi } from "../../lib/api-areas/integrations.ts";
import { uiStyles } from "../../app/ui.tsx";
import { errorMessage } from "../../app/toast.tsx";
import { ConnectGmailButton, ConnectTokenForm, connectionsOf, useConnections } from "../connectors/connect.tsx";
import styles from "./base-shell.module.css";

export interface AirtableSelection {
  connectionId: string;
  airtableBaseId: string;
  airtableTableId: string;
  /** null = every field, including ones added in Airtable later. */
  fieldIds: string[] | null;
  /** For the default table name. */
  tableName: string;
}

export const emptyAirtableSelection: AirtableSelection = { connectionId: "", airtableBaseId: "", airtableTableId: "", fieldIds: null, tableName: "" };

/** Pick (or add) an Airtable connection, then a base, a table and its fields. */
export function AirtableSyncSetup({ value, onChange }: { value: AirtableSelection; onChange: (next: AirtableSelection) => void }) {
  const [adding, setAdding] = useState(false);
  const [filter, setFilter] = useState("");
  const conns = useConnections();
  const list = connectionsOf(conns.data?.connections, "airtable");
  const connId = value.connectionId;

  useEffect(() => {
    if (!list.length) {
      if (connId) onChange(emptyAirtableSelection);
      return;
    }
    if (!list.some((c) => c.id === connId)) onChange({ ...emptyAirtableSelection, connectionId: list[0]!.id });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conns.data]);

  const bases = useQuery({
    queryKey: ["airtable-bases", connId],
    queryFn: () => integrationsApi.airtableBases(connId),
    enabled: Boolean(connId),
    retry: false,
  });
  useEffect(() => {
    const first = bases.data?.bases[0];
    if (first && !bases.data!.bases.some((b) => b.id === value.airtableBaseId)) {
      onChange({ ...value, airtableBaseId: first.id, airtableTableId: "", fieldIds: null, tableName: "" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bases.data]);

  const tables = useQuery({
    queryKey: ["airtable-tables", connId, value.airtableBaseId],
    queryFn: () => integrationsApi.airtableTables(connId, value.airtableBaseId),
    enabled: Boolean(connId && value.airtableBaseId),
    retry: false,
  });
  useEffect(() => {
    const first = tables.data?.tables[0];
    if (first && !tables.data!.tables.some((t) => t.id === value.airtableTableId)) {
      onChange({ ...value, airtableTableId: first.id, fieldIds: null, tableName: first.name });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tables.data]);

  const table = tables.data?.tables.find((t) => t.id === value.airtableTableId) ?? null;
  const fields = useMemo(() => (table ? table.fields.filter((f) => f.synced) : []), [table]);
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? fields.filter((f) => f.name.toLowerCase().includes(q)) : fields;
  }, [fields, filter]);

  if (conns.isLoading) return <p className={uiStyles.muted}>Loading Airtable connections…</p>;
  if (conns.isError) return <p className={uiStyles.error}>{errorMessage(conns.error)}</p>;
  if (!list.length || adding) {
    return (
      <ConnectTokenForm
        provider="airtable"
        onConnected={(c) => {
          setAdding(false);
          onChange({ ...emptyAirtableSelection, connectionId: c.id });
        }}
        {...(list.length ? { onCancel: () => setAdding(false) } : {})}
      />
    );
  }

  const all = value.fieldIds === null;
  const selected = new Set(all ? fields.map((f) => f.id) : value.fieldIds);
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange({ ...value, fieldIds: [...next] });
  };

  return (
    <div className={styles.hsSetup}>
      <div className={uiStyles.field}>
        <label className={uiStyles.label} htmlFor="at-conn">
          Airtable account
        </label>
        <select
          id="at-conn"
          className={uiStyles.input}
          value={connId}
          onChange={(e) => {
            if (e.target.value === "__add") setAdding(true);
            else onChange({ ...emptyAirtableSelection, connectionId: e.target.value });
          }}
        >
          {list.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
          <option value="__add">+ Connect another account…</option>
        </select>
      </div>
      <div className={styles.hsRow}>
        <div className={uiStyles.field} style={{ flex: 1, minWidth: 0 }}>
          <label className={uiStyles.label} htmlFor="at-base">
            Base
          </label>
          <select
            id="at-base"
            className={uiStyles.input}
            value={value.airtableBaseId}
            disabled={!bases.data?.bases.length}
            onChange={(e) => onChange({ ...value, airtableBaseId: e.target.value, airtableTableId: "", fieldIds: null, tableName: "" })}
          >
            {bases.isLoading ? <option value="">Loading…</option> : null}
            {bases.data?.bases.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </div>
        <div className={uiStyles.field} style={{ flex: 1, minWidth: 0 }}>
          <label className={uiStyles.label} htmlFor="at-table">
            Table
          </label>
          <select
            id="at-table"
            className={uiStyles.input}
            value={value.airtableTableId}
            disabled={!tables.data?.tables.length}
            onChange={(e) => {
              const t = tables.data?.tables.find((x) => x.id === e.target.value);
              onChange({ ...value, airtableTableId: e.target.value, fieldIds: null, tableName: t?.name ?? "" });
            }}
          >
            {tables.isLoading ? <option value="">Loading…</option> : null}
            {tables.data?.tables.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      {bases.isError ? <p className={uiStyles.error}>{errorMessage(bases.error)}</p> : null}
      {bases.data && !bases.data.bases.length ? (
        <p className={uiStyles.error}>This token can't see any bases. In Airtable, edit the token and add bases under Access.</p>
      ) : null}
      {tables.isError ? <p className={uiStyles.error}>{errorMessage(tables.error)}</p> : null}
      {table ? (
        <div className={uiStyles.field}>
          <label className={styles.hsProp}>
            <input type="checkbox" checked={all} onChange={(e) => onChange({ ...value, fieldIds: e.target.checked ? null : fields.map((f) => f.id) })} />
            <span>
              <strong>All fields</strong> — fields added in Airtable later are synced too
            </span>
          </label>
          {!all ? (
            <>
              <div className={styles.hsRow}>
                <span className={uiStyles.label}>
                  Fields ({selected.size} of {fields.length})
                </span>
                <input className={uiStyles.input} placeholder="Find a field" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Find a field" />
              </div>
              <div className={styles.hsProps} role="group" aria-label="Fields to sync">
                {shown.map((f) => {
                  const isPrimary = f.id === table.primaryFieldId;
                  return (
                    <label key={f.id} className={styles.hsProp} title={f.type}>
                      <input type="checkbox" checked={isPrimary || selected.has(f.id)} disabled={isPrimary} onChange={() => toggle(f.id)} />
                      <span>{f.name}</span>
                      {isPrimary ? <span className={uiStyles.muted}>primary</span> : null}
                    </label>
                  );
                })}
                {shown.length === 0 ? <p className={uiStyles.muted}>No fields match.</p> : null}
              </div>
            </>
          ) : null}
          <span className={uiStyles.muted}>
            One-way: Airtable stays the source and synced fields are read-only here. Also adds Airtable ID and a link back to each record; refreshes every
            15 minutes or with Sync now.
          </span>
        </div>
      ) : null}
    </div>
  );
}

export interface GmailSelection {
  connectionId: string;
  query: string;
  maxMessages: number;
  includeBody: boolean;
}

export const emptyGmailSelection: GmailSelection = { connectionId: "", query: "in:inbox", maxMessages: 200, includeBody: true };

const GMAIL_PRESETS: { label: string; query: string }[] = [
  { label: "Inbox", query: "in:inbox" },
  { label: "Unread in inbox", query: "in:inbox is:unread" },
  { label: "Starred", query: "is:starred" },
  { label: "Sent", query: "in:sent" },
  { label: "Last 30 days", query: "newer_than:30d" },
];

/** Pick (or connect) a Gmail account and which messages to sync. */
export function GmailSyncSetup({ value, onChange }: { value: GmailSelection; onChange: (next: GmailSelection) => void }) {
  const conns = useConnections();
  const list = connectionsOf(conns.data?.connections, "gmail");
  useEffect(() => {
    if (list.length && !list.some((c) => c.id === value.connectionId)) onChange({ ...value, connectionId: list[0]!.id });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conns.data]);

  if (conns.isLoading) return <p className={uiStyles.muted}>Loading Gmail connections…</p>;
  if (conns.isError) return <p className={uiStyles.error}>{errorMessage(conns.error)}</p>;
  if (!list.length) {
    return (
      <div className={styles.hsConnect}>
        <strong>Connect Gmail</strong>
        <p className={uiStyles.muted}>Sign in with Google and allow TableOS to read and send email. You come back here afterwards.</p>
        <ConnectGmailButton available={conns.data?.providers.gmail.available ?? false} />
      </div>
    );
  }
  const preset = GMAIL_PRESETS.find((p) => p.query === value.query);
  return (
    <div className={styles.hsSetup}>
      <div className={uiStyles.field}>
        <label className={uiStyles.label} htmlFor="gm-conn">
          Gmail account
        </label>
        <select id="gm-conn" className={uiStyles.input} value={value.connectionId} onChange={(e) => onChange({ ...value, connectionId: e.target.value })}>
          {list.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>
      <div className={uiStyles.field}>
        <label className={uiStyles.label} htmlFor="gm-preset">
          Messages
        </label>
        <select
          id="gm-preset"
          className={uiStyles.input}
          value={preset ? preset.query : "__custom"}
          onChange={(e) => onChange({ ...value, query: e.target.value === "__custom" ? `${value.query} ` : e.target.value })}
        >
          {GMAIL_PRESETS.map((p) => (
            <option key={p.query} value={p.query}>
              {p.label}
            </option>
          ))}
          <option value="__custom">Custom search…</option>
        </select>
        {!preset ? (
          <input
            className={uiStyles.input}
            value={value.query}
            placeholder="from:billing@example.com newer_than:90d"
            aria-label="Gmail search"
            onChange={(e) => onChange({ ...value, query: e.target.value })}
          />
        ) : null}
        <span className={uiStyles.muted}>Uses Gmail search syntax, the same as the search box in Gmail.</span>
      </div>
      <div className={styles.hsRow}>
        <label className={uiStyles.label} htmlFor="gm-max">
          Keep the newest
        </label>
        <select
          id="gm-max"
          className={uiStyles.input}
          value={value.maxMessages}
          onChange={(e) => onChange({ ...value, maxMessages: Number(e.target.value) })}
          style={{ maxWidth: 140 }}
        >
          {[50, 100, 200, 500, 1000, 2000].map((n) => (
            <option key={n} value={n}>
              {n} messages
            </option>
          ))}
        </select>
      </div>
      <label className={styles.hsProp}>
        <input type="checkbox" checked={value.includeBody} onChange={(e) => onChange({ ...value, includeBody: e.target.checked })} />
        <span>Include the message body and attachment names</span>
      </label>
      <span className={uiStyles.muted}>
        Adds Subject, From, To, Date, Snippet, Labels, Unread and a Gmail link per message. Read-only; refreshes every 15 minutes or with Sync now.
      </span>
    </div>
  );
}
