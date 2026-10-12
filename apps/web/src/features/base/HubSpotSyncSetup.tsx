import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { HUBSPOT_OBJECTS, integrationsApi, type HubSpotObject } from "../../lib/api-areas/integrations.ts";
import { uiStyles } from "../../app/ui.tsx";
import { errorMessage } from "../../app/toast.tsx";
import { confirmDisconnect, ConnectTokenForm, connectionsOf, useConnections, useDisconnect } from "../connectors/connect.tsx";
import styles from "./base-shell.module.css";

export interface HubSpotSelection {
  connectionId: string;
  object: HubSpotObject;
  properties: string[];
  twoWay: boolean;
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
  const [adding, setAdding] = useState(false);
  const [filter, setFilter] = useState("");
  const conns = useConnections();
  const list = connectionsOf(conns.data?.connections, "hubspot");
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

  const remove = useDisconnect();

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const all = props.data?.properties ?? [];
    return q ? all.filter((p) => p.label.toLowerCase().includes(q) || p.name.toLowerCase().includes(q)) : all;
  }, [props.data, filter]);

  if (conns.isLoading) return <p className={uiStyles.muted}>Loading HubSpot connections…</p>;
  if (conns.isError) return <p className={uiStyles.error}>{errorMessage(conns.error)}</p>;
  if (!list.length || adding) {
    return (
      <ConnectTokenForm
        provider="hubspot"
        onConnected={(c) => {
          setAdding(false);
          onChange({ ...value, connectionId: c.id, properties: [] });
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
              if (c && confirmDisconnect(c)) remove.mutate(c);
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
