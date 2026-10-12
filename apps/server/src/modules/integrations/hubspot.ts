import { SyncError, type MappedField, type SourceField, type SyncSource } from "../sync/source.js";

/**
 * HubSpot CRM as a sync source. Uses a private-app access token
 * (Settings → Integrations → Private apps) against the CRM v3 API.
 */

export const HUBSPOT_OBJECTS = {
  contacts: {
    label: "Contacts",
    singular: "Contact",
    typeId: "0-1",
    scope: "crm.objects.contacts.read",
    primary: null,
    defaults: ["email", "firstname", "lastname", "phone", "company", "jobtitle", "lifecyclestage", "hs_lead_status", "hubspot_owner_id", "createdate", "lastmodifieddate"],
  },
  companies: {
    label: "Companies",
    singular: "Company",
    typeId: "0-2",
    scope: "crm.objects.companies.read",
    primary: "name",
    defaults: ["name", "domain", "industry", "phone", "city", "country", "numberofemployees", "annualrevenue", "lifecyclestage", "hubspot_owner_id", "createdate"],
  },
  deals: {
    label: "Deals",
    singular: "Deal",
    typeId: "0-3",
    scope: "crm.objects.deals.read",
    primary: "dealname",
    defaults: ["dealname", "amount", "dealstage", "pipeline", "closedate", "hubspot_owner_id", "createdate"],
  },
  tickets: {
    label: "Tickets",
    singular: "Ticket",
    typeId: "0-5",
    scope: "tickets",
    primary: "subject",
    defaults: ["subject", "content", "hs_pipeline_stage", "hs_ticket_priority", "hubspot_owner_id", "createdate"],
  },
} as const;

export type HubSpotObject = keyof typeof HUBSPOT_OBJECTS;
export const HUBSPOT_OBJECT_KEYS = Object.keys(HUBSPOT_OBJECTS) as HubSpotObject[];
export const MAX_HUBSPOT_PROPERTIES = 100;
const MAX_RECORDS = 50_000;

export interface HubSpotProperty {
  name: string;
  label: string;
  type: string;
  fieldType: string;
  groupName?: string;
  hidden?: boolean;
  calculated?: boolean;
  options?: Array<{ label: string; value: string; hidden?: boolean; displayOrder?: number }>;
  modificationMetadata?: { readOnlyValue?: boolean };
}

export interface HubSpotAccount {
  portalId: string | null;
  uiDomain: string;
}

const SEARCH_CAP = 9_900;

/** An incremental pull would exceed HubSpot's search limit; a full pull is needed instead. */
export class SearchTooLarge extends SyncError {
  constructor() {
    super("Too many HubSpot changes for an incremental sync");
  }
}

export class HubSpotError extends SyncError {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function apiBase(): string {
  return (process.env["HUBSPOT_API_BASE"] ?? "https://api.hubapi.com").replace(/\/+$/, "");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class HubSpotClient {
  constructor(private readonly token: string) {}

  get<T>(path: string, query: Record<string, string | undefined> = {}): Promise<T> {
    return this.request<T>("GET", path, query);
  }

  async request<T>(method: "GET" | "POST" | "PATCH", path: string, query: Record<string, string | undefined> = {}, body?: unknown): Promise<T> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined) qs.set(k, v);
    const q = qs.toString();
    const url = `${apiBase()}${path}${q ? `?${q}` : ""}`;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(url, {
          method,
          headers: {
            authorization: `Bearer ${this.token}`,
            accept: "application/json",
            ...(body !== undefined ? { "content-type": "application/json" } : {}),
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(30_000),
        });
      } catch (err) {
        if (attempt < 2) {
          await sleep(1_000 * (attempt + 1));
          continue;
        }
        throw new HubSpotError(`Couldn't reach HubSpot: ${err instanceof Error ? err.message : String(err)}`, 0);
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 4) {
        const wait = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(wait) && wait > 0 ? Math.min(wait, 30) * 1_000 : 2_000 * (attempt + 1));
        continue;
      }
      if (!res.ok) throw await hubspotError(res);
      const text = await res.text();
      return (text ? JSON.parse(text) : {}) as T;
    }
  }

  /** Records changed at or after `since` (HubSpot search; capped at 10,000 results). */
  async *changedSince(
    object: HubSpotObject,
    properties: string[],
    since: Date,
  ): AsyncGenerator<Array<{ id: string; properties: Record<string, string | null> }>> {
    const modified = object === "contacts" ? "lastmodifieddate" : "hs_lastmodifieddate";
    let after: string | undefined;
    do {
      const r = await this.request<{
        total?: number;
        results: Array<{ id: string; properties: Record<string, string | null> }>;
        paging?: { next?: { after?: string } };
      }>("POST", `/crm/v3/objects/${object}/search`, {}, {
        filterGroups: [{ filters: [{ propertyName: modified, operator: "GTE", value: String(since.getTime()) }] }],
        sorts: [{ propertyName: modified, direction: "ASCENDING" }],
        properties,
        limit: 100,
        ...(after ? { after } : {}),
      });
      if ((r.total ?? 0) > SEARCH_CAP) throw new SearchTooLarge();
      const page = r.results ?? [];
      if (page.length) yield page;
      after = r.paging?.next?.after;
    } while (after);
  }

  /** Update records; maps each id to null (saved) or the error HubSpot gave for it. */
  async updateMany(object: HubSpotObject, inputs: Array<{ id: string; properties: Record<string, string> }>): Promise<Map<string, HubSpotError | null>> {
    const out = new Map<string, HubSpotError | null>();
    for (let i = 0; i < inputs.length; i += 100) {
      const chunk = inputs.slice(i, i + 100);
      try {
        const r = await this.request<{ results?: Array<{ id: string }> }>("POST", `/crm/v3/objects/${object}/batch/update`, {}, { inputs: chunk });
        const ok = new Set((r.results ?? []).map((x) => String(x.id)));
        for (const c of chunk) if (ok.has(c.id)) out.set(c.id, null);
      } catch (err) {
        if (!(err instanceof HubSpotError) || err.status === 401 || err.status === 403 || err.status === 0 || err.status === 429 || err.status >= 500) throw err;
      }
      // Whatever the batch didn't confirm is retried one by one so one bad value doesn't block the rest.
      for (const c of chunk) {
        if (out.has(c.id)) continue;
        try {
          await this.request("PATCH", `/crm/v3/objects/${object}/${encodeURIComponent(c.id)}`, {}, { properties: c.properties });
          out.set(c.id, null);
        } catch (err) {
          if (!(err instanceof HubSpotError) || err.status === 401 || err.status === 403 || err.status === 0) throw err;
          out.set(c.id, err);
        }
      }
    }
    return out;
  }

  async account(): Promise<HubSpotAccount> {
    const r = await this.get<{ portalId?: number | string; uiDomain?: string }>("/account-info/v3/details");
    return { portalId: r.portalId !== undefined ? String(r.portalId) : null, uiDomain: r.uiDomain || "app.hubspot.com" };
  }

  async properties(object: HubSpotObject): Promise<HubSpotProperty[]> {
    const r = await this.get<{ results: HubSpotProperty[] }>(`/crm/v3/properties/${object}`, { archived: "false" });
    return r.results ?? [];
  }

  /** Owner id → display name; empty when the token lacks the owners scope. */
  async ownerNames(): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    let after: string | undefined;
    try {
      do {
        const r = await this.get<{
          results: Array<{ id: string; email?: string; firstName?: string; lastName?: string }>;
          paging?: { next?: { after?: string } };
        }>("/crm/v3/owners", { limit: "500", after });
        for (const o of r.results ?? []) {
          const name = [o.firstName, o.lastName].filter(Boolean).join(" ").trim() || o.email || o.id;
          out.set(String(o.id), name);
        }
        after = r.paging?.next?.after;
      } while (after);
    } catch {
      // Optional; ids are shown instead.
    }
    return out;
  }

  async *objects(object: HubSpotObject, properties: string[]): AsyncGenerator<Array<{ id: string; properties: Record<string, string | null> }>> {
    let after: string | undefined;
    let seen = 0;
    do {
      const r = await this.get<{
        results: Array<{ id: string; properties: Record<string, string | null> }>;
        paging?: { next?: { after?: string } };
      }>(`/crm/v3/objects/${object}`, { limit: "100", archived: "false", properties: properties.join(","), after });
      const page = r.results ?? [];
      seen += page.length;
      if (seen > MAX_RECORDS) throw new SyncError(`HubSpot has more than ${MAX_RECORDS.toLocaleString("en-US")} ${object}; that's more than one synced table can hold`);
      if (page.length) yield page;
      after = r.paging?.next?.after;
    } while (after);
  }
}

async function hubspotError(res: Response): Promise<HubSpotError> {
  let body: { message?: string; category?: string; errors?: Array<{ context?: { requiredGranularScopes?: string[] } }> } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    // Non-JSON error page.
  }
  if (res.status === 401) return new HubSpotError("HubSpot rejected the access token. Reconnect the HubSpot account with a valid private app token.", 401);
  if (res.status === 403) {
    const scopes = [...new Set((body.errors ?? []).flatMap((e) => e.context?.requiredGranularScopes ?? []))];
    const need = scopes.length ? scopes.join(", ") : "the read scope for this object";
    return new HubSpotError(`The HubSpot private app is missing a permission: ${need}. Add it under the app's Scopes, then sync again.`, 403);
  }
  const detail = typeof body.message === "string" ? body.message.slice(0, 300) : `HTTP ${res.status}`;
  return new HubSpotError(`HubSpot request failed: ${detail}`, res.status);
}

// ---------------------------------------------------------------------------
// Property → field mapping
// ---------------------------------------------------------------------------

const AMOUNTISH = /amount|revenue|price|value|cost|probability/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface PropertyPlan {
  mapped: MappedField;
  value: (raw: string | null | undefined) => unknown;
}

function optionLabels(p: HubSpotProperty, owners: Map<string, string>): Map<string, string> {
  const out = new Map<string, string>();
  const seen = new Set<string>();
  const opts = [...(p.options ?? [])].sort((a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0));
  for (const o of opts) {
    let label = String(o.label || o.value).trim().slice(0, 255);
    if (!label) continue;
    // Select labels must be unique (case-insensitively); HubSpot pipelines can repeat stage names.
    for (let i = 2; seen.has(label.toLowerCase()); i++) label = `${String(o.label).trim().slice(0, 240)} (${i})`;
    seen.add(label.toLowerCase());
    out.set(String(o.value), label);
  }
  if (p.name === "hubspot_owner_id" && out.size === 0) for (const [id, name] of owners) if (!seen.has(name.toLowerCase())) {
    seen.add(name.toLowerCase());
    out.set(id, name);
  }
  return out;
}

function datePart(raw: string): string | null {
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  const n = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
  return Number.isFinite(n) ? new Date(n).toISOString().slice(0, 10) : null;
}

function dateTime(raw: string): string | null {
  const n = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
  return Number.isFinite(n) ? new Date(n).toISOString() : null;
}

export function planProperty(p: HubSpotProperty, owners: Map<string, string> = new Map()): PropertyPlan {
  const empty = (raw: string | null | undefined): raw is null | undefined => raw === null || raw === undefined || raw === "";
  const text = (long: boolean): PropertyPlan => ({
    mapped: { type: long ? "long_text" : "text", config: {}, conv: "text", compare: "none" },
    value: (raw) => (empty(raw) ? null : String(raw).slice(0, 100_000)),
  });
  switch (p.type) {
    case "number":
      return {
        mapped: { type: "number", config: { precision: AMOUNTISH.test(p.name) ? 2 : 0 }, conv: "number", compare: "none" },
        value: (raw) => {
          if (empty(raw)) return null;
          const n = Number(raw);
          return Number.isFinite(n) ? n : null;
        },
      };
    case "bool":
      return { mapped: { type: "checkbox", config: {}, conv: "checkbox", compare: "none" }, value: (raw) => (raw === "true" ? true : null) };
    case "date":
      return { mapped: { type: "date", config: {}, conv: "text", compare: "none" }, value: (raw) => (empty(raw) ? null : datePart(raw)) };
    case "datetime":
      return { mapped: { type: "datetime", config: {}, conv: "datetime", compare: "none" }, value: (raw) => (empty(raw) ? null : dateTime(raw)) };
    case "enumeration": {
      if (p.fieldType === "booleancheckbox") {
        return { mapped: { type: "checkbox", config: {}, conv: "checkbox", compare: "none" }, value: (raw) => (raw === "true" ? true : null) };
      }
      const labels = optionLabels(p, owners);
      if (labels.size === 0) return text(false);
      const options = [...labels.values()].map((label) => ({ label }));
      const label = (v: string) => labels.get(v) ?? v.slice(0, 255);
      if (p.fieldType === "checkbox") {
        return {
          mapped: { type: "multi_select", config: { options }, conv: "same", compare: "options" },
          value: (raw) => {
            if (empty(raw)) return null;
            const out = String(raw).split(";").map((v) => v.trim()).filter(Boolean).map(label);
            return out.length ? out : null;
          },
        };
      }
      return {
        mapped: { type: "single_select", config: { options }, conv: "same", compare: "options" },
        value: (raw) => (empty(raw) ? null : label(String(raw))),
      };
    }
    default:
      if (p.fieldType === "textarea" || p.fieldType === "html") return text(true);
      if (p.name === "email" || p.name.endsWith("_email")) {
        return {
          mapped: { type: "email", config: {}, conv: "text", compare: "none" },
          value: (raw) => (!empty(raw) && EMAIL_RE.test(String(raw).trim()) && String(raw).length <= 320 ? String(raw).trim() : null),
        };
      }
      return text(false);
  }
}

const READ_ONLY_PROPS = new Set(["hs_object_id", "createdate", "hs_createdate", "lastmodifieddate", "hs_lastmodifieddate"]);

/** Whether TableOS may write this property back to HubSpot. */
export function isWritableProperty(p: HubSpotProperty): boolean {
  return !p.calculated && !p.modificationMetadata?.readOnlyValue && !READ_ONLY_PROPS.has(p.name);
}

/** A cell value HubSpot can't accept; the edit is dropped and HubSpot's value comes back. */
export class PushValueError extends SyncError {}

function selectLabelsById(config: Record<string, unknown> | null | undefined): Map<string, string> {
  const opts = Array.isArray(config?.["options"]) ? (config!["options"] as Array<{ id?: string; label?: string }>) : [];
  return new Map(opts.filter((o) => o.id && o.label).map((o) => [o.id!, o.label!]));
}

/** TableOS cell value (wire format) → HubSpot property value ("" clears it). */
export function toHubSpotValue(p: HubSpotProperty, fieldConfig: Record<string, unknown> | null | undefined, wire: unknown, owners: Map<string, string> = new Map()): string {
  const isBool = p.type === "bool" || (p.type === "enumeration" && p.fieldType === "booleancheckbox");
  if (isBool) return wire === true ? "true" : "false";
  if (wire === null || wire === undefined || wire === "" || (Array.isArray(wire) && wire.length === 0)) return "";
  switch (p.type) {
    case "number": {
      const n = typeof wire === "number" ? wire : Number(wire);
      if (!Number.isFinite(n)) throw new PushValueError(`${p.label} needs a number`);
      return String(n);
    }
    case "date": {
      const d = datePart(String(wire));
      if (!d) throw new PushValueError(`${p.label} needs a date`);
      return d;
    }
    case "datetime": {
      const d = dateTime(String(wire));
      if (!d) throw new PushValueError(`${p.label} needs a date and time`);
      return d;
    }
    case "enumeration": {
      const labels = optionLabels(p, owners);
      if (labels.size === 0) return String(wire);
      const valueByLabel = new Map([...labels].map(([value, label]) => [label.toLowerCase(), value]));
      const localLabels = selectLabelsById(fieldConfig);
      const toValue = (x: unknown) => {
        const label = localLabels.get(String(x)) ?? String(x);
        const value = valueByLabel.get(label.toLowerCase());
        if (value === undefined) throw new PushValueError(`“${label}” isn't an option for ${p.label} in HubSpot`);
        return value;
      };
      return (Array.isArray(wire) ? wire : [wire]).map(toValue).join(";");
    }
    default:
      return Array.isArray(wire) ? wire.map(String).join(", ") : String(wire);
  }
}

// ---------------------------------------------------------------------------
// Source adapter
// ---------------------------------------------------------------------------

export interface HubSpotSourceConfig {
  object: HubSpotObject;
  properties: string[];
  portalId?: string | null;
  uiDomain?: string;
}

export function parseHubSpotConfig(raw: unknown): HubSpotSourceConfig {
  const o = (raw ?? {}) as Record<string, unknown>;
  const object = o["object"];
  if (typeof object !== "string" || !(object in HUBSPOT_OBJECTS)) throw new SyncError("This HubSpot sync has no object configured");
  const properties = Array.isArray(o["properties"]) ? o["properties"].filter((p): p is string => typeof p === "string") : [];
  return {
    object: object as HubSpotObject,
    properties,
    portalId: typeof o["portalId"] === "string" ? o["portalId"] : null,
    uiDomain: typeof o["uiDomain"] === "string" ? o["uiDomain"] : "app.hubspot.com",
  };
}

/** Field the destination table starts with as its primary (before the first sync). */
export function hubspotPrimaryField(cfg: HubSpotSourceConfig, props: HubSpotProperty[]): { id: string; name: string } {
  const def = HUBSPOT_OBJECTS[cfg.object];
  if (!def.primary) return { id: "__name", name: "Name" };
  return { id: `p:${def.primary}`, name: props.find((p) => p.name === def.primary)?.label ?? "Name" };
}

/** `since` = only records changed since then (an incremental pull; deletions aren't seen). */
export async function hubspotSource(token: string, cfg: HubSpotSourceConfig, opts: { since?: Date | null } = {}): Promise<SyncSource> {
  const client = new HubSpotClient(token);
  const def = HUBSPOT_OBJECTS[cfg.object];
  const all = await client.properties(cfg.object);
  const byName = new Map(all.map((p) => [p.name, p]));
  const chosen = [...new Set(cfg.properties)].filter((n) => byName.has(n)).slice(0, MAX_HUBSPOT_PROPERTIES);
  const owners = chosen.some((n) => n === "hubspot_owner_id" && !(byName.get(n)!.options ?? []).length) ? await client.ownerNames() : new Map<string, string>();

  const fields: SourceField[] = [];
  const plans = new Map<string, PropertyPlan>();
  const primary = hubspotPrimaryField(cfg, all);
  const textPrimary: MappedField = { type: "text", config: {}, conv: "text", compare: "none" };
  fields.push({ id: primary.id, name: primary.name, mapped: textPrimary });
  for (const n of chosen) {
    if (`p:${n}` === primary.id) continue;
    const p = byName.get(n)!;
    const plan = planProperty(p, owners);
    plans.set(n, plan);
    fields.push({ id: `p:${n}`, name: p.label || n, mapped: plan.mapped });
  }
  fields.push({ id: "__id", name: "HubSpot ID", mapped: { type: "text", config: {}, conv: "text", compare: "none" } });
  if (cfg.portalId) fields.push({ id: "__url", name: "HubSpot URL", mapped: { type: "url", config: {}, conv: "text", compare: "none" } });

  const writable: string[] = [];
  const primaryProp = def.primary ? byName.get(def.primary) : undefined;
  if (primaryProp && isWritableProperty(primaryProp)) writable.push(primary.id);
  for (const n of plans.keys()) if (isWritableProperty(byName.get(n)!)) writable.push(`p:${n}`);

  const nameProps = def.primary ? [def.primary] : ["firstname", "lastname", "email"];
  const request = [...new Set([...chosen, ...nameProps])];
  const since = opts.since ?? null;

  async function* rows() {
    const pages = since ? client.changedSince(cfg.object, request, since) : client.objects(cfg.object, request);
    for await (const page of pages) {
      yield page.map((obj) => {
        const props = obj.properties ?? {};
        const values: Record<string, unknown> = {};
        const name = def.primary
          ? String(props[def.primary] ?? "").trim()
          : [props["firstname"], props["lastname"]].filter(Boolean).join(" ").trim() || String(props["email"] ?? "").trim();
        values[primary.id] = (name || `${def.singular} ${obj.id}`).replace(/[\r\n]+/g, " ").slice(0, 1_000);
        for (const [n, plan] of plans) values[`p:${n}`] = plan.value(props[n]);
        values["__id"] = String(obj.id);
        if (cfg.portalId) values["__url"] = `https://${cfg.uiDomain || "app.hubspot.com"}/contacts/${cfg.portalId}/record/${def.typeId}/${obj.id}`;
        return { id: String(obj.id), values };
      });
    }
  }

  return { fields, rows, writable, partial: Boolean(since) };
}
