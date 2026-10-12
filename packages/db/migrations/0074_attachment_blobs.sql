-- Attachment bodies stored in Postgres (storage_driver = 'db'): survives redeploys on hosts
-- whose local disk is wiped, without needing an object store.
CREATE TABLE IF NOT EXISTS data.attachment_blobs (
  object_key   text PRIMARY KEY,
  content_type text,
  size_bytes   bigint NOT NULL,
  body         bytea NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
