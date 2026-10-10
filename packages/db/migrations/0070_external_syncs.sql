-- Connections to external services (HubSpot first) and synced tables whose
-- source is one of those services instead of another TableOS base.

CREATE TABLE IF NOT EXISTS core.integration_connections (
  id            uuid PRIMARY KEY DEFAULT public.uuidv7(),
  org_id        uuid NOT NULL,
  -- Connections belong to the person who added them; only they can use them.
  user_id       uuid NOT NULL,
  provider      text NOT NULL CHECK (provider IN ('hubspot')),
  name          text NOT NULL,
  account_id    text,
  account_label text,
  -- AES-256-GCM encrypted JSON (see modules/integrations/connections.ts).
  credentials   text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);

CREATE INDEX IF NOT EXISTS integration_connections_owner_idx
  ON core.integration_connections (org_id, user_id) WHERE deleted_at IS NULL;

ALTER TABLE data.table_syncs
  ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'tableos',
  ADD COLUMN IF NOT EXISTS connection_id uuid,
  ADD COLUMN IF NOT EXISTS source_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Claimed while a run is in progress so two runs never write the same table.
  ADD COLUMN IF NOT EXISTS locked_until timestamptz;

ALTER TABLE data.table_syncs ALTER COLUMN source_base_id DROP NOT NULL;
ALTER TABLE data.table_syncs ALTER COLUMN source_table_id DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'table_syncs_source_chk') THEN
    ALTER TABLE data.table_syncs ADD CONSTRAINT table_syncs_source_chk CHECK (
      (provider = 'tableos' AND source_base_id IS NOT NULL AND source_table_id IS NOT NULL)
      OR (provider <> 'tableos' AND connection_id IS NOT NULL)
    );
  END IF;
END $$;
