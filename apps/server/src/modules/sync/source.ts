export class SyncError extends Error {}

/** Another run of the same sync holds the lock. */
export class SyncBusyError extends SyncError {
  constructor() {
    super("This table is already syncing");
  }
}

export type Conv = "same" | "number" | "datetime" | "checkbox" | "text" | "files";

export interface MappedField {
  type: string;
  config: Record<string, unknown>;
  conv: Conv;
  /**
   * How an existing destination field's config is checked against `config`:
   * "config" = exact, "options" = every select label present, "none" = type only.
   * Defaults to "config" for conv "same", otherwise "none".
   */
  compare?: "config" | "options" | "none";
}

export interface SourceField {
  /** Stable key for the field_map (a field uuid, or e.g. "p:email"). */
  id: string;
  name: string;
  mapped: MappedField;
}

export interface SourceRow {
  id: string;
  /** Destination-ready values keyed by SourceField.id. */
  values: Record<string, unknown>;
}

/** What a sync copies from: fields (first = primary) and rows in batches. */
export interface SyncSource {
  fields: SourceField[];
  rows(): AsyncIterable<SourceRow[]>;
  /** SourceField ids whose edits can be written back (two-way syncs). */
  writable?: string[];
  /** Rows are only the changed ones: missing rows aren't deletions. */
  partial?: boolean;
}
