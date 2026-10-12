import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { connectionsQueryKey, integrationsApi, type ConnectorProvider, type IntegrationConnection } from "../../lib/api-areas/integrations.ts";
import { uiStyles } from "../../app/ui.tsx";
import { errorMessage, toast } from "../../app/toast.tsx";
import styles from "./connectors.module.css";

export interface ProviderInfo {
  key: ConnectorProvider;
  label: string;
  letter: string;
  description: string;
  /** What the connection is used for in TableOS. */
  uses: string[];
}

export const PROVIDERS: ProviderInfo[] = [
  {
    key: "airtable",
    label: "Airtable",
    letter: "A",
    description: "Bring tables from your Airtable bases into TableOS. Records refresh automatically; Airtable stays the source.",
    uses: ["Synced tables"],
  },
  {
    key: "hubspot",
    label: "HubSpot",
    letter: "H",
    description: "Sync contacts, companies, deals and tickets from your CRM, optionally writing edits back to HubSpot.",
    uses: ["Synced tables", "Two-way sync"],
  },
  {
    key: "gmail",
    label: "Gmail",
    letter: "G",
    description: "Send email from your own Gmail address in automations, and sync inbox messages into a table.",
    uses: ["Automation: Send email via Gmail", "Synced tables"],
  },
  {
    key: "slack",
    label: "Slack",
    letter: "S",
    description: "Post messages to Slack channels from automations, e.g. when a record is created or a deal closes.",
    uses: ["Automation: Send Slack message"],
  },
];

/** Listed under Connectors; Gmail and Slack accounts are connected from the automation steps that use them. */
export const CONNECTOR_PROVIDERS = PROVIDERS.filter((p) => p.key === "airtable" || p.key === "hubspot");

export function providerInfo(key: ConnectorProvider): ProviderInfo {
  return PROVIDERS.find((p) => p.key === key)!;
}

export function ProviderLogo({ provider, size }: { provider: ConnectorProvider; size?: "sm" }) {
  return (
    <span className={styles.logo} data-provider={provider} data-size={size} aria-hidden>
      {providerInfo(provider).letter}
    </span>
  );
}

/** The signed-in user's connections (shared by every base and the settings page). */
export function useConnections() {
  return useQuery({ queryKey: connectionsQueryKey, queryFn: () => integrationsApi.connections(), staleTime: 30_000 });
}

export function connectionsOf(list: IntegrationConnection[] | undefined, provider: ConnectorProvider): IntegrationConnection[] {
  return (list ?? []).filter((c) => c.provider === provider);
}

export function useDisconnect() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (c: IntegrationConnection) => integrationsApi.disconnect(c.id),
    onSuccess: async (_res, c) => {
      await qc.invalidateQueries({ queryKey: connectionsQueryKey });
      await qc.invalidateQueries({ queryKey: ["bases"] });
      toast.success(`${providerInfo(c.provider).label} account disconnected`);
    },
    onError: (err) => toast.error(err, "Could not disconnect"),
  });
}

export function confirmDisconnect(c: IntegrationConnection): boolean {
  const effect =
    c.provider === "slack"
      ? "Automations that post with it will fail until you pick another account."
      : c.provider === "gmail"
        ? "Tables synced with it stop updating (their data stays) and automations that send with it fail."
        : "Tables synced with it stop updating (their data stays).";
  return window.confirm(`Disconnect “${c.name}”? ${effect}`);
}

const TOKEN_HELP: Record<"hubspot" | "airtable" | "slack", { title: string; tokenLabel: string; placeholder: string; steps: ReactNode }> = {
  hubspot: {
    title: "Connect a HubSpot account",
    tokenLabel: "Private app access token",
    placeholder: "pat-…",
    steps: (
      <>
        <li>
          In HubSpot, open <em>Settings → Integrations → Private apps</em> and create a private app (or use <em>Development → Legacy apps</em> on newer
          accounts).
        </li>
        <li>
          Under <em>Scopes</em>, add read access for what you want to sync: <code>crm.objects.contacts.read</code>, <code>crm.objects.companies.read</code>,{" "}
          <code>crm.objects.deals.read</code>, <code>tickets</code>. Add <code>crm.objects.owners.read</code> to see owner names. For two-way sync also add
          the matching write scopes (<code>crm.objects.contacts.write</code>, <code>crm.objects.companies.write</code>, <code>crm.objects.deals.write</code>
          ).
        </li>
        <li>Create the app and paste its access token here.</li>
      </>
    ),
  },
  airtable: {
    title: "Connect Airtable",
    tokenLabel: "Personal access token",
    placeholder: "pat…",
    steps: (
      <>
        <li>
          In Airtable, open <em>Builder hub → Personal access tokens</em> (airtable.com/create/tokens) and create a token.
        </li>
        <li>
          Add the scopes <code>data.records:read</code> and <code>schema.bases:read</code>, and under <em>Access</em> add the bases (or workspaces) you
          want to sync.
        </li>
        <li>Create the token and paste it here.</li>
      </>
    ),
  },
  slack: {
    title: "Connect Slack",
    tokenLabel: "Bot User OAuth Token",
    placeholder: "xoxb-…",
    steps: (
      <>
        <li>
          At api.slack.com/apps, create an app for your workspace (<em>From scratch</em>).
        </li>
        <li>
          Under <em>OAuth &amp; Permissions → Bot Token Scopes</em>, add <code>chat:write</code>, <code>channels:read</code> and (for private channels){" "}
          <code>groups:read</code>. Add <code>chat:write.public</code> to post in public channels without inviting the bot.
        </li>
        <li>
          Install the app to the workspace and paste the <em>Bot User OAuth Token</em> here. Invite the bot to private channels with{" "}
          <code>/invite @your-app</code>.
        </li>
      </>
    ),
  },
};

/** Paste-a-token connect form (HubSpot, Airtable, Slack). */
export function ConnectTokenForm({
  provider,
  onConnected,
  onCancel,
}: {
  provider: "hubspot" | "airtable" | "slack";
  onConnected?: (c: IntegrationConnection) => void;
  onCancel?: () => void;
}) {
  const qc = useQueryClient();
  const help = TOKEN_HELP[provider];
  const [token, setToken] = useState("");
  const [name, setName] = useState("");
  const connect = useMutation({
    mutationFn: () => integrationsApi.connect({ provider, accessToken: token.trim(), ...(name.trim() ? { name: name.trim() } : {}) }),
    onSuccess: async (res) => {
      await qc.invalidateQueries({ queryKey: connectionsQueryKey });
      toast.success(res.reconnected ? `${providerInfo(provider).label} reconnected` : `${providerInfo(provider).label} connected`);
      onConnected?.(res.connection);
    },
  });
  const id = `conn-${provider}`;
  return (
    <form
      className={styles.connect}
      onSubmit={(e) => {
        e.preventDefault();
        if (token.trim().length >= 10 && !connect.isPending) connect.mutate();
      }}
    >
      <strong>{help.title}</strong>
      <ol className={styles.steps}>{help.steps}</ol>
      <div className={uiStyles.field}>
        <label className={uiStyles.label} htmlFor={`${id}-name`}>
          Name (optional)
        </label>
        <input id={`${id}-name`} className={uiStyles.input} value={name} placeholder="Shown in TableOS" onChange={(e) => setName(e.target.value)} />
      </div>
      <div className={uiStyles.field}>
        <label className={uiStyles.label} htmlFor={`${id}-token`}>
          {help.tokenLabel}
        </label>
        <input
          id={`${id}-token`}
          className={uiStyles.input}
          type="password"
          autoComplete="off"
          value={token}
          placeholder={help.placeholder}
          onChange={(e) => setToken(e.target.value)}
        />
        <span className={uiStyles.muted}>Stored encrypted. Only you can use this connection, in any of your bases.</span>
      </div>
      {connect.isError ? <p className={uiStyles.error}>{errorMessage(connect.error)}</p> : null}
      <div className={styles.row}>
        <button type="submit" className={uiStyles.btnPrimary} disabled={token.trim().length < 10 || connect.isPending}>
          {connect.isPending ? "Checking…" : "Connect"}
        </button>
        {onCancel ? (
          <button type="button" className={uiStyles.btn} onClick={onCancel}>
            Cancel
          </button>
        ) : null}
      </div>
    </form>
  );
}

/** "Sign in with Google": leaves the app for Google's consent screen and comes back to `returnTo`. */
export function ConnectGmailButton({ available, returnTo, label = "Sign in with Google" }: { available: boolean; returnTo?: string; label?: string }) {
  const start = useMutation({
    mutationFn: () => integrationsApi.startGmail(returnTo ?? `${window.location.pathname}${window.location.search}`),
    onSuccess: (res) => {
      window.location.assign(res.url);
    },
    onError: (err) => toast.error(err, "Could not start Google sign-in"),
  });
  if (!available) {
    return (
      <p className={uiStyles.muted}>
        Gmail needs a Google OAuth client on the server. An administrator sets <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code> and adds
        the redirect URI <code>…/v1/connections/gmail/callback</code> in Google Cloud.
      </p>
    );
  }
  return (
    <button type="button" className={uiStyles.btnPrimary} disabled={start.isPending} onClick={() => start.mutate()}>
      {start.isPending ? "Opening Google…" : label}
    </button>
  );
}

/** Connect button + inline form for a provider; Gmail goes through Google. */
export function ConnectProvider({
  provider,
  gmailAvailable,
  returnTo,
  onConnected,
  buttonLabel,
}: {
  provider: ConnectorProvider;
  gmailAvailable: boolean;
  returnTo?: string;
  onConnected?: (c: IntegrationConnection) => void;
  buttonLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  if (provider === "gmail") {
    return (
      <div className={styles.row}>
        <ConnectGmailButton available={gmailAvailable} label={buttonLabel ?? "Sign in with Google"} {...(returnTo ? { returnTo } : {})} />
      </div>
    );
  }
  if (!open) {
    return (
      <div className={styles.row}>
        <button type="button" className={uiStyles.btn} onClick={() => setOpen(true)}>
          {buttonLabel ?? `+ Connect ${providerInfo(provider).label}`}
        </button>
      </div>
    );
  }
  return (
    <ConnectTokenForm
      provider={provider}
      onConnected={(c) => {
        setOpen(false);
        onConnected?.(c);
      }}
      onCancel={() => setOpen(false)}
    />
  );
}
