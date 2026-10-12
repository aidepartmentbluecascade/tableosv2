import { request } from "../api.ts";

/** Connections to external services (personal to the user) and tables synced from them. */

export type ConnectorProvider = "hubspot" | "airtable" | "gmail" | "slack";

export interface IntegrationConnection {
  id: string;
  provider: ConnectorProvider;
  name: string;
  accountId: string | null;
  accountLabel: string | null;
  createdAt: string;
  /** Tables (in any base) synced with this connection; only on the account-level list. */
  syncedTables?: number;
}

export interface ConnectionsResponse {
  connections: IntegrationConnection[];
  providers: { gmail: { available: boolean } };
}

export type HubSpotObject = "contacts" | "companies" | "deals" | "tickets";

export const HUBSPOT_OBJECTS: { key: HubSpotObject; label: string; scope: string }[] = [
  { key: "contacts", label: "Contacts", scope: "crm.objects.contacts.read" },
  { key: "companies", label: "Companies", scope: "crm.objects.companies.read" },
  { key: "deals", label: "Deals", scope: "crm.objects.deals.read" },
  { key: "tickets", label: "Tickets", scope: "tickets" },
];

export interface HubSpotProperty {
  name: string;
  label: string;
  type: string;
  group: string | null;
  suggested: boolean;
}

export interface AirtableTableInfo {
  id: string;
  name: string;
  primaryFieldId: string;
  fields: { id: string; name: string; type: string; synced: boolean }[];
}

export interface SlackChannel {
  id: string;
  name: string;
  isPrivate: boolean;
  isMember: boolean;
}

/** Shared query key for the signed-in user's connections. */
export const connectionsQueryKey = ["integration-connections"] as const;

const b = (id: string) => `/v1/bases/${encodeURIComponent(id)}`;
const c = (id: string) => `/v1/connections/${encodeURIComponent(id)}`;

export const integrationsApi = {
  connections() {
    return request<ConnectionsResponse>("/v1/connections");
  },
  connect(body: { provider: "hubspot" | "airtable" | "slack"; accessToken: string; name?: string }) {
    return request<{ connection: IntegrationConnection; reconnected: boolean }>("/v1/connections", { method: "POST", json: body });
  },
  disconnect(connectionId: string) {
    return request<void>(c(connectionId), { method: "DELETE" });
  },
  startGmail(returnTo: string) {
    return request<{ url: string }>("/v1/connections/gmail/start", { method: "POST", json: { returnTo } });
  },
  airtableBases(connectionId: string) {
    return request<{ bases: { id: string; name: string }[] }>(`${c(connectionId)}/airtable/bases`);
  },
  airtableTables(connectionId: string, airtableBaseId: string) {
    return request<{ tables: AirtableTableInfo[] }>(`${c(connectionId)}/airtable/bases/${encodeURIComponent(airtableBaseId)}/tables`);
  },
  slackChannels(connectionId: string) {
    return request<{ channels: SlackChannel[] }>(`${c(connectionId)}/slack/channels`);
  },
  hubspotProperties(baseId: string, connectionId: string, object: HubSpotObject) {
    return request<{ object: HubSpotObject; primaryProperty: string | null; properties: HubSpotProperty[] }>(
      `${b(baseId)}/connections/${encodeURIComponent(connectionId)}/hubspot/properties?object=${object}`,
    );
  },
  createHubSpotSync(baseId: string, body: { connectionId: string; object: HubSpotObject; properties: string[]; name?: string; twoWay?: boolean }) {
    return request<{ tableId: string; syncId: string }>(`${b(baseId)}/hubspot-syncs`, { method: "POST", json: body });
  },
  createAirtableSync(baseId: string, body: { connectionId: string; airtableBaseId: string; airtableTableId: string; fieldIds?: string[]; name?: string }) {
    return request<{ tableId: string; syncId: string }>(`${b(baseId)}/airtable-syncs`, { method: "POST", json: body });
  },
  createGmailSync(baseId: string, body: { connectionId: string; query: string; maxMessages: number; includeBody: boolean; name?: string }) {
    return request<{ tableId: string; syncId: string }>(`${b(baseId)}/gmail-syncs`, { method: "POST", json: body });
  },
};
