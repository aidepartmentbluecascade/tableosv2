-- Airtable, Gmail and Slack connections next to HubSpot. Connections are
-- personal to the user who added them and usable in any of their bases.

DO $$
DECLARE c text;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'core.integration_connections'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%provider%'
  LOOP
    EXECUTE format('ALTER TABLE core.integration_connections DROP CONSTRAINT %I', c);
  END LOOP;
END $$;

ALTER TABLE core.integration_connections
  ADD CONSTRAINT integration_connections_provider_chk CHECK (provider IN ('hubspot', 'airtable', 'gmail', 'slack'));

CREATE INDEX IF NOT EXISTS integration_connections_user_idx
  ON core.integration_connections (user_id) WHERE deleted_at IS NULL;

-- OAuth `state` for connecting a Google account (Gmail), bound to the user.
DO $$
DECLARE c text;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'core.auth_challenges'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%kind%'
  LOOP
    EXECUTE format('ALTER TABLE core.auth_challenges DROP CONSTRAINT %I', c);
  END LOOP;
END $$;

ALTER TABLE core.auth_challenges
  ADD CONSTRAINT auth_challenges_kind_chk CHECK (kind IN ('mfa_login', 'mfa_enroll', 'oauth_state', 'connect_oauth_state'));
