import type { FieldDto, TableDto } from "../../lib/api.ts";

/** The record last selected in a table's grid (per browser tab), offered by the automation test panel. */
const KEY = (tableId: string) => `tableos.lastRecord.${tableId}`;

export function rememberRecord(tableId: string, recordId: string): void {
  try {
    sessionStorage.setItem(KEY(tableId), recordId);
  } catch {
    // storage unavailable (private mode); the shortcut just won't appear
  }
}

export function lastRecord(tableId: string): string | null {
  try {
    return sessionStorage.getItem(KEY(tableId));
  } catch {
    return null;
  }
}

/** `rec_…` from a pasted record ID or record link (`…?record=rec_…`). */
export function parseRecordRef(text: string): string | null {
  return /\brec_[A-Za-z0-9]{10,}\b/.exec(text)?.[0] ?? null;
}

/** Types that read well as a one-line label. */
const LABEL_TYPES = new Set(["text", "long_text", "email", "url", "phone", "number", "currency", "percent", "autonumber", "barcode", "single_select", "date", "datetime", "formula"]);

export function labelableFields(table: TableDto): FieldDto[] {
  return table.fields.filter((f) => LABEL_TYPES.has(f.type));
}

export function cellText(field: FieldDto, v: unknown): string {
  if (v === null || v === undefined || v === "") return "";
  if (field.type === "single_select" && typeof v === "string") {
    const opts = (field.config as { options?: { id?: string; label?: string }[] }).options ?? [];
    return opts.find((o) => o.id === v)?.label ?? v;
  }
  if (typeof v === "string") return v.replace(/\s+/g, " ").trim();
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * Label for a record in the test picker. With `labelBy` set, that field's value; otherwise the primary
 * value plus the next two filled-in fields that differ from it, so rows with the same primary value
 * (e.g. an imported "Project" column) can still be told apart.
 */
export function recordLabel(table: TableDto, fields: Record<string, unknown>, labelBy: string | null): string {
  if (labelBy) {
    const f = table.fields.find((x) => x.id === labelBy);
    if (f) return clip(cellText(f, fields[f.id]) || "(empty)", 90);
  }
  const primary = table.fields.find((f) => f.id === table.primaryFieldId) ?? table.fields[0];
  const parts: string[] = [];
  const first = primary ? cellText(primary, fields[primary.id]) : "";
  if (first) parts.push(clip(first, 40));
  for (const f of labelableFields(table)) {
    if (parts.length >= 3) break;
    if (f.id === primary?.id || f.type === "long_text") continue;
    const t = cellText(f, fields[f.id]);
    if (t && !parts.includes(clip(t, 40))) parts.push(clip(t, 40));
  }
  return parts.length ? parts.join(" · ") : "Unnamed record";
}
