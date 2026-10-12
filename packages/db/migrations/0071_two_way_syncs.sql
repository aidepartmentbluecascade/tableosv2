-- Two-way syncs: edits to a synced table's editable fields are written back
-- to the source (HubSpot), and HubSpot is polled incrementally between full runs.

ALTER TABLE data.table_syncs
  ADD COLUMN IF NOT EXISTS two_way boolean NOT NULL DEFAULT false,
  -- Source field keys (see field_map) that can be written back.
  ADD COLUMN IF NOT EXISTS writable_keys jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS last_full_synced_at timestamptz,
  -- Start of the last successful pull; incremental pulls fetch changes since then.
  ADD COLUMN IF NOT EXISTS pulled_through timestamptz;

-- Local edits waiting to be (or recently) written back to the source.
CREATE TABLE IF NOT EXISTS data.table_sync_pushes (
  sync_id        uuid NOT NULL REFERENCES data.table_syncs(id) ON DELETE CASCADE,
  dest_record_id uuid NOT NULL,
  field_ids      jsonb NOT NULL DEFAULT '[]'::jsonb,
  edited_at      timestamptz NOT NULL DEFAULT now(),
  -- Pending while NULL or older than edited_at.
  pushed_at      timestamptz,
  attempts       int NOT NULL DEFAULT 0,
  last_error     text,
  PRIMARY KEY (sync_id, dest_record_id)
);
