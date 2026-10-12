import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { HUBSPOT_OBJECTS, integrationsApi, type HubSpotObject } from "../../lib/api-areas/integrations.ts";
import { uiStyles } from "../../app/ui.tsx";
import { errorMessage, toast } from "../../app/toast.tsx";
import styles from "./base-shell.module.css";

export interface HubSpotSelection {
  connectionId: string;
  object: HubSpotObject;
  properties: string[];
  twoWay: boolean;
}

export function ConnectHubSpot({ baseId, onConnected, onCancel }: { baseId: string; onConnected: (id: string) => void; onCancel?: () => void }) {
  const qc = useQueryClient();
  const [token, setToken] = useState("");
  const [name, setName] = useState("");
  const connect = useMutation({
    mutationFn: () => integrationsApi.connectHubSpot(baseId, { accessToken: token.trim(), ...(name.trim() ? { name: name.trim() } : {}) }),
    onSuccess: async (res) => {
      await qc.invalidateQueries({ queryKey: ["integration-connections", baseId] });
      onConnected(res.connection.id);
    },
  });
  return (
    <div className={styles.hsConnect}>
      <strong>Connect a HubSpot account</strong>
      <ol className={styles.hsSteps}>
        <li>
          In HubSpot, open <em>Settings → Integrations → Private apps</em> and create a private app (or use{" "}
          <em>Development → Legacy apps</em> on newer accounts).
        </li>
        <li>
          Under <em>Scopes</em>, add read access for what you want to sync: <code>crm.objects.contacts.read</code>,{" "}
          <code>crm.objects.companies.read</code>, <code>crm.objects.deals.read</code>, <code>tickets</code>. Add{" "}
          <code>crm.objects.owners.read</code> to see owner names. For two-way sync also add the matching write scopes (
          <code>crm.objects.contacts.write</code>, <code>crm.objects.companies.write</code>, <code>crm.objects.deals.write</code>).
        </li>
        <li>Create the app and paste its access token here.</li>
      </ol>
      <div className={uiStyles.field}>
        <label className={uiStyles.label} htmlFor="hs-name">
          Account name (optional)
        </label>
        <input id="hs-name" className={uiStyles.input} value={name} placeholder="e.g. Sales portal" onChange={(e) => setName(e.target.value)} />
      </div>
      <div className={uiStyles.field}>
        <label className={uiStyles.label} htmlFor="hs-token">
          Private app access token
        </label>
        <input
          id="hs-token"
          className={uiStyles.input}
          type="password"
          autoComplete="off"
          value={token}
          placeholder="pat-…"
          onChange={(e) => setToken(e.target.value)}
        />
        <span className={uiStyles.muted}>Stored encrypted. Only you can use this connection.</span>
      </div>
      {connect.isError ? <p className={uiStyles.error}>{errorMessage(connect.error)}</p> : null}
      <div className={styles.hsRow}>
        <button type="button" className={uiStyles.btnPrimary} disabled={token.trim().length < 10 || connect.isPending} onClick={() => connect.mutate()}>
          {connect.isPending ? "Checking…" : "Connect"}
        </button>
        {onCancel ? (
          <button type="button" className={uiStyles.btn} onClick={onCancel}>
            Cancel
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** Pick (or add) a HubSpot connection, an object, and the properties to sync. */
export function HubSpotSyncSetup({
  baseId,
  value,
  onChange,
}: {
  baseId: string;
  value: HubSpotSelection;
  onChange: (next: HubSpotSelection) => void;
}) {
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [filter, setFilter] = useState("");
  const conns = useQuery({ queryKey: ["integration-connections", baseId], queryFn: () => integrationsApi.connections(baseId) });
  const list = conns.data?.connections.filter((c) => c.provider === "hubspot") ?? [];
  const connId = value.connectionId;

  useEffect(() => {
    if (!list.length) {
      if (connId) onChange({ ...value, connectionId: "", properties: [] });
      return;
    }
    if (!list.some((c) => c.id === connId)) onChange({ ...value, connectionId: list[0]!.id, properties: [] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conns.data]);

  const props = useQuery({
    queryKey: ["hubspot-properties", baseId, connId, value.object],
    queryFn: () => integrationsApi.hubspotProperties(baseId, connId, value.object),
    enabled: Boolean(connId),
    retry: false,
  });

  useEffect(() => {
    if (!props.data || props.data.object !== value.object) return;
    const suggested = props.data.properties.filter((p) => p.suggested).map((p) => p.name);
    onChange({ ...value, properties: suggested.length ? suggested : props.data.properties.slice(0, 10).map((p) => p.name) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.data, connId, value.object]);

  const remove = useMutation({
    mutationFn: (id: string) => integrationsApi.disconnect(baseId, id),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["integration-connections", baseId] });
      toast.success("HubSpot account disconnected");
    },
    onError: (err) => toast.error(err, "Could not disconnect"),
  });

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const all = props.data?.properties ?? [];
    return q ? all.filter((p) => p.label.toLowerCase().includes(q) || p.name.toLowerCase().includes(q)) : all;
  }, [props.data, filter]);

  if (conns.isLoading) return <p className={uiStyles.muted}>Loading HubSpot connections…</p>;
  if (conns.isError) return <p className={uiStyles.error}>{errorMessage(conns.error)}</p>;
  if (!list.length || adding) {
    return (
      <ConnectHubSpot
        baseId={baseId}
        onConnected={(id) => {
          setAdding(false);
          onChange({ ...value, connectionId: id, properties: [] });
        }}
        {...(list.length ? { onCancel: () => setAdding(false) } : {})}
      />
    );
  }

  const primary = props.data?.primaryProperty ?? null;
  const selected = new Set(value.properties);
  const toggle = (name: string) => {
    const next = new Set(selected);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    onChange({ ...value, properties: [...next] });
  };

  return (
    <div className={styles.hsSetup}>
      <div className={uiStyles.field}>
        <label className={uiStyles.label} htmlFor="hs-conn">
          HubSpot account
        </label>
        <div className={styles.hsRow}>
          <select
            id="hs-conn"
            className={uiStyles.input}
            value={connId}
            onChange={(e) => {
              if (e.target.value === "__add") setAdding(true);
              else onChange({ ...value, connectionId: e.target.value, properties: [] });
            }}
          >
            {list.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.accountId && c.name !== `Account ${c.accountId}` ? ` (portal ${c.accountId})` : ""}
              </option>
            ))}
            <option value="__add">+ Connect another account…</option>
          </select>
          <button
            type="button"
            className={uiStyles.btnGhost}
            disabled={remove.isPending}
            onClick={() => {
              const c = list.find((x) => x.id === connId);
              if (c && window.confirm(`Disconnect “${c.name}”? Tables synced with it stop updating (their data stays).`)) remove.mutate(c.id);
            }}
          >
            Disconnect
          </button>
        </div>
      </div>
      <div className={uiStyles.field}>
        <label className={uiStyles.label} htmlFor="hs-object">
          What to sync
        </label>
        <select
          id="hs-object"
          className={uiStyles.input}
          value={value.object}
          onChange={(e) => onChange({ ...value, object: e.target.value as HubSpotObject, properties: [] })}
        >
          {HUBSPOT_OBJECTS.map((o) => (
            <option key={o.key} value={o.key}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      <div className={uiStyles.field}>
        <div className={styles.hsRow}>
          <span className={uiStyles.label}>
            Properties ({value.properties.length} selected{props.data ? ` of ${props.data.properties.length}` : ""})
          </span>
          <input className={uiStyles.input} placeholder="Find a property" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Find a property" />
        </div>
        {props.isLoading ? <p className={uiStyles.muted}>Loading properties from HubSpot…</p> : null}
        {props.isError ? <p className={uiStyles.error}>{errorMessage(props.error)}</p> : null}
        {props.data ? (
          <div className={styles.hsProps} role="group" aria-label="Properties to sync">
            {shown.map((p) => (
              <label key={p.name} className={styles.hsProp} title={p.name}>
                <input
                  type="checkbox"
                  checked={p.name === primary || selected.has(p.name)}
                  disabled={p.name === primary || (!selected.has(p.name) && selected.size >= 100)}
                  onChange={() => toggle(p.name)}
                />
                <span>{p.label}</span>
                {p.name === primary ? <span className={uiStyles.muted}>primary</span> : null}
              </label>
            ))}
            {shown.length === 0 ? <p className={uiStyles.muted}>No properties match.</p> : null}
          </div>
        ) : null}
        <span className={uiStyles.muted}>
          Also adds Name, HubSpot ID and a link back to each record. Changes made in HubSpot show up within a couple of minutes; columns you add stay editable.
        </span>
      </div>
      <label className={styles.hsProp}>
        <input type="checkbox" checked={value.twoWay} onChange={(e) => onChange({ ...value, twoWay: e.target.checked })} />
        <span>
          <strong>Two-way sync</strong> — edits to synced fields here are written back to HubSpot. Needs write scopes; records are still added and
          deleted in HubSpot.
        </span>
      </label>
    </div>
  );
}
