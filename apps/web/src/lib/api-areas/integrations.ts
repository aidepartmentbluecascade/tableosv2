import { request } from "../api.ts";

/** Connections to external services (HubSpot) and tables synced from them. */

export interface IntegrationConnection {
  id: string;
  provider: "hubspot";
  name: string;
  accountId: string | null;
  accountLabel: string | null;
  createdAt: string;
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

const b = (id: string) => `/v1/bases/${encodeURIComponent(id)}`;

export const integrationsApi = {
  connections(baseId: string) {
    return request<{ connections: IntegrationConnection[] }>(`${b(baseId)}/connections`);
  },
  connectHubSpot(baseId: string, body: { accessToken: string; name?: string }) {
    return request<{ connection: IntegrationConnection }>(`${b(baseId)}/connections`, { method: "POST", json: { provider: "hubspot", ...body } });
  },
  disconnect(baseId: string, connectionId: string) {
    return request<void>(`${b(baseId)}/connections/${encodeURIComponent(connectionId)}`, { method: "DELETE" });
  },
  hubspotProperties(baseId: string, connectionId: string, object: HubSpotObject) {
    return request<{ object: HubSpotObject; primaryProperty: string | null; properties: HubSpotProperty[] }>(
      `${b(baseId)}/connections/${encodeURIComponent(connectionId)}/hubspot/properties?object=${object}`,
    );
  },
  createHubSpotSync(baseId: string, body: { connectionId: string; object: HubSpotObject; properties: string[]; name?: string }) {
    return request<{ tableId: string; syncId: string }>(`${b(baseId)}/hubspot-syncs`, { method: "POST", json: body });
  },
};
