import { SyncError, type MappedField, type SourceField, type SyncSource } from "../sync/source.js";

/**
 * Airtable (personal access token): read bases, tables and records. Synced
 * tables are one-way — Airtable stays the source of truth.
 */

const MAX_RECORDS = 50_000;
export const MAX_AIRTABLE_FIELDS = 200;

export class AirtableError extends SyncError {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function apiBase(): string {
  return (process.env["AIRTABLE_API_BASE"] ?? "https://api.airtable.com").replace(/\/+$/, "");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface AirtableBase {
  id: string;
  name: string;
  permissionLevel?: string;
}

export interface AirtableField {
  id: string;
  name: string;
  type: string;
  options?: Record<string, unknown> | null;
}

export interface AirtableTable {
  id: string;
  name: string;
  primaryFieldId: string;
  fields: AirtableField[];
}

interface AirtableRecord {
  id: string;
  createdTime?: string;
  fields: Record<string, unknown>;
}

export class AirtableClient {
  constructor(private readonly token: string) {}

  async get<T>(path: string, query: Record<string, string | string[] | undefined> = {}): Promise<T> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (Array.isArray(v)) for (const x of v) qs.append(k, x);
      else if (v !== undefined) qs.set(k, v);
    }
    const q = qs.toString();
    const url = `${apiBase()}${path}${q ? `?${q}` : ""}`;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(url, {
          headers: { authorization: `Bearer ${this.token}`, accept: "application/json" },
          signal: AbortSignal.timeout(30_000),
        });
      } catch (err) {
        if (attempt < 2) {
          await sleep(1_000 * (attempt + 1));
          continue;
        }
        throw new AirtableError(`Couldn't reach Airtable: ${err instanceof Error ? err.message : String(err)}`, 0);
      }
      // Airtable allows 5 requests per second per base and asks for a 30 s pause after a 429.
      if ((res.status === 429 || res.status >= 500) && attempt < 4) {
        await sleep(res.status === 429 ? 30_000 : 1_000 * (attempt + 1));
        continue;
      }
      if (!res.ok) throw await airtableError(res);
      return (await res.json()) as T;
    }
  }

  async whoami(): Promise<{ id: string; email: string | null }> {
    const r = await this.get<{ id?: string; email?: string }>("/v0/meta/whoami");
    return { id: String(r.id ?? ""), email: typeof r.email === "string" ? r.email : null };
  }

  async bases(): Promise<AirtableBase[]> {
    const out: AirtableBase[] = [];
    let offset: string | undefined;
    do {
      const r = await this.get<{ bases?: AirtableBase[]; offset?: string }>("/v0/meta/bases", { offset });
      out.push(...(r.bases ?? []));
      offset = r.offset;
    } while (offset && out.length < 5_000);
    return out;
  }

  async tables(baseId: string): Promise<AirtableTable[]> {
    const r = await this.get<{ tables?: AirtableTable[] }>(`/v0/meta/bases/${encodeURIComponent(baseId)}/tables`);
    return r.tables ?? [];
  }

  async *records(baseId: string, tableId: string, fieldIds: string[] | null): AsyncGenerator<AirtableRecord[]> {
    let offset: string | undefined;
    let seen = 0;
    do {
      const r = await this.get<{ records?: AirtableRecord[]; offset?: string }>(`/v0/${encodeURIComponent(baseId)}/${encodeURIComponent(tableId)}`, {
        pageSize: "100",
        returnFieldsByFieldId: "true",
        cellFormat: "json",
        offset,
        ...(fieldIds ? { "fields[]": fieldIds } : {}),
      });
      const recs = r.records ?? [];
      seen += recs.length;
      if (recs.length) yield recs;
      offset = r.offset;
    } while (offset && seen < MAX_RECORDS);
  }
}

async function airtableError(res: Response): Promise<AirtableError> {
  let body: { error?: string | { type?: string; message?: string } } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    // Non-JSON error page.
  }
  const e = typeof body.error === "string" ? { type: body.error, message: body.error } : (body.error ?? {});
  if (res.status === 401) return new AirtableError("Airtable rejected the access token. Reconnect Airtable with a valid personal access token.", 401);
  if (res.status === 403 || e.type === "INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND") {
    return new AirtableError(
      "The Airtable token can't read this. Give it the data.records:read and schema.bases:read scopes and access to the base, then try again.",
      403,
    );
  }
  if (res.status === 404) return new AirtableError("That Airtable base or table no longer exists, or the token has no access to it.", 404);
  const detail = typeof e.message === "string" ? e.message.slice(0, 300) : `HTTP ${res.status}`;
  return new AirtableError(`Airtable request failed: ${detail}`, res.status);
}

// ---------------------------------------------------------------------------
// Field mapping
// ---------------------------------------------------------------------------

interface FieldPlan {
  mapped: MappedField;
  value: (raw: unknown) => unknown;
}

const text = (v: unknown): string => {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map(text).filter(Boolean).join(", ");
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    for (const k of ["name", "text", "label", "filename", "email", "value"]) if (o[k] !== undefined && o[k] !== null) return text(o[k]);
    if (o["state"] === "error") return "";
    return JSON.stringify(o);
  }
  return "";
};
const nonEmpty = (s: string, max = 100_000) => (s === "" ? null : s.slice(0, max));
const num = (v: unknown): number | null => {
  const x = Array.isArray(v) ? v[0] : v;
  const n = typeof x === "number" ? x : typeof x === "string" && x.trim() !== "" ? Number(x) : NaN;
  return Number.isFinite(n) ? n : null;
};
const isoDateTime = (v: unknown): string | null => {
  const s = text(Array.isArray(v) ? v[0] : v);
  return s && !Number.isNaN(Date.parse(s)) ? new Date(s).toISOString() : null;
};
const isoDate = (v: unknown): string | null => {
  const s = text(Array.isArray(v) ? v[0] : v);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return s && !Number.isNaN(Date.parse(s)) ? new Date(s).toISOString().slice(0, 10) : null;
};
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function choiceLabels(options: Record<string, unknown> | null | undefined): string[] {
  const choices = Array.isArray(options?.["choices"]) ? (options!["choices"] as { name?: unknown }[]) : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of choices) {
    const label = String(c?.name ?? "").trim().slice(0, 255);
    if (!label || seen.has(label.toLowerCase())) continue;
    seen.add(label.toLowerCase());
    out.push(label);
  }
  return out;
}

function precisionOf(options: Record<string, unknown> | null | undefined): number {
  const p = Number(options?.["precision"]);
  return Number.isInteger(p) && p >= 0 && p <= 8 ? p : 0;
}

/** Destination field for an Airtable field; null = not synced. `links` resolves record ids to names. */
export function planAirtableField(f: AirtableField, links: (tableId: string, ids: string[]) => string): FieldPlan | null {
  const T = (long: boolean): FieldPlan => ({
    mapped: { type: long ? "long_text" : "text", config: {}, conv: "text", compare: "none" },
    value: (raw) => nonEmpty(text(raw)),
  });
  const numberPlan = (precision: number): FieldPlan => ({
    mapped: { type: "number", config: { precision }, conv: "number", compare: "none" },
    value: num,
  });
  const resultType = (o: Record<string, unknown> | null | undefined) => String((o?.["result"] as { type?: unknown } | undefined)?.type ?? "");
  switch (f.type) {
    case "button":
      return null;
    case "multilineText":
    case "richText":
      return T(true);
    case "email":
      return {
        mapped: { type: "email", config: {}, conv: "text", compare: "none" },
        value: (raw) => {
          const s = text(raw).trim();
          return s && EMAIL_RE.test(s) && s.length <= 320 ? s : null;
        },
      };
    case "url":
      return { mapped: { type: "url", config: {}, conv: "text", compare: "none" }, value: (raw) => nonEmpty(text(raw).trim(), 2_000) };
    case "phoneNumber":
      return { mapped: { type: "phone", config: {}, conv: "text", compare: "none" }, value: (raw) => nonEmpty(text(raw).trim(), 100) };
    case "number":
    case "currency":
      return numberPlan(precisionOf(f.options));
    case "percent":
      // Airtable stores 0.25 for 25%.
      return {
        mapped: { type: "number", config: { precision: Math.min(8, precisionOf(f.options)) }, conv: "number", compare: "none" },
        value: (raw) => {
          const n = num(raw);
          return n === null ? null : Math.round(n * 100 * 10 ** 8) / 10 ** 8;
        },
      };
    case "rating":
    case "count":
    case "autoNumber":
    case "duration":
      return numberPlan(0);
    case "checkbox":
      return { mapped: { type: "checkbox", config: {}, conv: "checkbox", compare: "none" }, value: (raw) => (raw === true ? true : null) };
    case "date":
      return { mapped: { type: "date", config: {}, conv: "text", compare: "none" }, value: isoDate };
    case "dateTime":
    case "createdTime":
    case "lastModifiedTime":
      return { mapped: { type: "datetime", config: {}, conv: "datetime", compare: "none" }, value: isoDateTime };
    case "singleSelect": {
      const labels = choiceLabels(f.options);
      if (!labels.length) return T(false);
      return {
        mapped: { type: "single_select", config: { options: labels.map((label) => ({ label })) }, conv: "same", compare: "options" },
        value: (raw) => {
          const s = text(raw).trim().slice(0, 255);
          return s ? (labels.find((l) => l.toLowerCase() === s.toLowerCase()) ?? null) : null;
        },
      };
    }
    case "multipleSelects": {
      const labels = choiceLabels(f.options);
      if (!labels.length) return T(false);
      return {
        mapped: { type: "multi_select", config: { options: labels.map((label) => ({ label })) }, conv: "same", compare: "options" },
        value: (raw) => {
          const vals = (Array.isArray(raw) ? raw : [raw]).map((x) => text(x).trim().toLowerCase()).filter(Boolean);
          const out = labels.filter((l) => vals.includes(l.toLowerCase()));
          return out.length ? out : null;
        },
      };
    }
    case "multipleAttachments":
      return {
        mapped: { type: "long_text", config: {}, conv: "text", compare: "none" },
        value: (raw) => {
          const files = (Array.isArray(raw) ? raw : []) as { filename?: string; url?: string }[];
          return nonEmpty(files.map((a) => [a.filename, a.url].filter(Boolean).join(" — ")).filter(Boolean).join("\n"));
        },
      };
    case "multipleRecordLinks": {
      const linked = String(f.options?.["linkedTableId"] ?? "");
      return {
        mapped: { type: "text", config: {}, conv: "text", compare: "none" },
        value: (raw) => {
          const ids = (Array.isArray(raw) ? raw : []).map((x) => (typeof x === "string" ? x : text((x as { id?: unknown })?.id))).filter(Boolean);
          return ids.length ? nonEmpty(linked ? links(linked, ids) : ids.join(", ")) : null;
        },
      };
    }
    case "formula":
    case "rollup":
    case "multipleLookupValues": {
      const rt = resultType(f.options);
      if (rt === "number" || rt === "currency" || rt === "percent" || rt === "count" || rt === "rating" || rt === "duration") {
        return numberPlan(precisionOf((f.options?.["result"] as { options?: Record<string, unknown> } | undefined)?.options) || (rt === "count" ? 0 : 2));
      }
      if (rt === "checkbox" && f.type === "formula") return { mapped: { type: "checkbox", config: {}, conv: "checkbox", compare: "none" }, value: (raw) => (raw === true || raw === 1 ? true : null) };
      if ((rt === "date" || rt === "dateTime") && f.type !== "multipleLookupValues") {
        return { mapped: { type: "datetime", config: {}, conv: "datetime", compare: "none" }, value: isoDateTime };
      }
      return T(rt === "multilineText" || rt === "richText");
    }
    default:
      // singleLineText, collaborators, barcode, aiText, externalSyncSource, …
      return T(false);
  }
}

// ---------------------------------------------------------------------------
// Source adapter
// ---------------------------------------------------------------------------

export interface AirtableSourceConfig {
  baseId: string;
  baseName?: string;
  tableId: string;
  tableName?: string;
  /** null = every field (new Airtable fields are picked up automatically). */
  fieldIds: string[] | null;
}

export function parseAirtableConfig(raw: unknown): AirtableSourceConfig {
  const o = (raw ?? {}) as Record<string, unknown>;
  const baseId = typeof o["baseId"] === "string" ? o["baseId"] : "";
  const tableId = typeof o["tableId"] === "string" ? o["tableId"] : "";
  if (!baseId || !tableId) throw new SyncError("This Airtable sync has no table configured");
  return {
    baseId,
    tableId,
    ...(typeof o["baseName"] === "string" ? { baseName: o["baseName"] } : {}),
    ...(typeof o["tableName"] === "string" ? { tableName: o["tableName"] } : {}),
    fieldIds: Array.isArray(o["fieldIds"]) ? o["fieldIds"].filter((x): x is string => typeof x === "string") : null,
  };
}

/** Field the destination table starts with as its primary (before the first sync). */
export function airtablePrimaryField(table: AirtableTable): { id: string; name: string } {
  const p = table.fields.find((f) => f.id === table.primaryFieldId);
  return { id: `f:${table.primaryFieldId}`, name: p?.name ?? "Name" };
}

export async function airtableSource(token: string, cfg: AirtableSourceConfig): Promise<SyncSource> {
  const client = new AirtableClient(token);
  const tables = await client.tables(cfg.baseId);
  const found = tables.find((t) => t.id === cfg.tableId);
  if (!found) throw new AirtableError("The Airtable table for this sync was deleted, or the token lost access to it.", 404);
  const table: AirtableTable = found;

  // Linked records arrive as ids; show the linked record's primary value instead.
  const linkNames = new Map<string, Map<string, string>>();
  const links = (tableId: string, ids: string[]) => {
    const names = linkNames.get(tableId);
    return ids.map((id) => names?.get(id) ?? id).join(", ");
  };

  const wanted = cfg.fieldIds ? new Set(cfg.fieldIds) : null;
  const primaryAt = table.fields.find((f) => f.id === table.primaryFieldId);
  const primary = airtablePrimaryField(table);
  const fields: SourceField[] = [{ id: primary.id, name: primary.name, mapped: { type: "text", config: {}, conv: "text", compare: "none" } }];
  const plans = new Map<string, FieldPlan>();
  for (const f of table.fields) {
    if (f.id === table.primaryFieldId || (wanted && !wanted.has(f.id))) continue;
    if (plans.size >= MAX_AIRTABLE_FIELDS) break;
    const plan = planAirtableField(f, links);
    if (!plan) continue;
    plans.set(f.id, plan);
    fields.push({ id: `f:${f.id}`, name: f.name, mapped: plan.mapped });
  }
  fields.push({ id: "__id", name: "Airtable ID", mapped: { type: "text", config: {}, conv: "text", compare: "none" } });
  fields.push({ id: "__url", name: "Airtable URL", mapped: { type: "url", config: {}, conv: "text", compare: "none" } });

  const primaryPlan = primaryAt ? planAirtableField(primaryAt, links) : null;
  const linkedTables = new Set(
    table.fields
      .filter((f) => f.type === "multipleRecordLinks" && (plans.has(f.id) || f.id === table.primaryFieldId))
      .map((f) => String(f.options?.["linkedTableId"] ?? ""))
      .filter(Boolean),
  );

  async function* rows() {
    for (const tid of linkedTables) {
      const lt = tables.find((t) => t.id === tid);
      if (!lt) continue;
      const names = new Map<string, string>();
      for await (const page of client.records(cfg.baseId, tid, [lt.primaryFieldId])) {
        for (const r of page) names.set(r.id, text(r.fields[lt.primaryFieldId]).trim() || r.id);
      }
      linkNames.set(tid, names);
    }
    const request = wanted ? [table.primaryFieldId, ...plans.keys()] : null;
    for await (const page of client.records(cfg.baseId, cfg.tableId, request)) {
      yield page.map((rec) => {
        const values: Record<string, unknown> = {};
        const rawPrimary = rec.fields[table.primaryFieldId];
        const shown = primaryPlan ? primaryPlan.value(rawPrimary) : rawPrimary;
        values[primary.id] = (text(shown).trim() || rec.id).replace(/[\r\n]+/g, " ").slice(0, 1_000);
        for (const [id, plan] of plans) values[`f:${id}`] = plan.value(rec.fields[id]);
        values["__id"] = rec.id;
        values["__url"] = `https://airtable.com/${cfg.baseId}/${cfg.tableId}/${rec.id}`;
        return { id: rec.id, values };
      });
    }
  }

  return { fields, rows };
}
