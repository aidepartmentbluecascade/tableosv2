import type { FastifyInstance, FastifyReply, FastifyRequest, RouteGenericInterface } from "fastify";
import { sql } from "kysely";
import { z } from "zod";
import type { AppContext } from "../../lib/app-context.js";
import { parsePid, pid } from "../../lib/public-ids.js";
import { ApiError, handleRouteError } from "../../http/errors.js";
import { withBaseTx } from "../../kernel/mutation.js";
import { assertCan } from "../access/assert.js";
import { compileForUser } from "../access/compile.js";
import { resolveBaseContext } from "../access/helpers.js";
import { writeAuditEvent } from "../audit/write.js";
import { consumeChallenge, createChallenge, findChallenge } from "../auth/challenges.js";
import { googleOAuthEnabled } from "../auth/google-oauth.js";
import { mfaKey } from "../auth/mfa-pending.js";
import { bootstrapDefaultTable } from "../base/bootstrap-default-table.js";
import { loadSync, runTableSync, SyncBusyError, type SyncProvider } from "../sync/engine.js";
import { startTwoWayPusher } from "../sync/two-way.js";
import { AirtableClient, AirtableError, airtablePrimaryField, MAX_AIRTABLE_FIELDS, planAirtableField } from "./airtable.js";
import {
  connectionDto,
  loadConnection,
  openCredentials,
  PROVIDER_LABELS,
  sealCredentials,
  userConnections,
  type ConnectionCredentials,
  type ConnectionProvider,
  type ConnectionRow,
} from "./connections.js";
import { exchangeGmailCode, GMAIL_SCOPES, gmailAuthorizeUrl, GmailError, googleAccountEmail, MAX_GMAIL_MESSAGES } from "./gmail.js";
import {
  HUBSPOT_OBJECT_KEYS,
  HUBSPOT_OBJECTS,
  HubSpotClient,
  HubSpotError,
  hubspotPrimaryField,
  MAX_HUBSPOT_PROPERTIES,
  type HubSpotAccount,
  type HubSpotObject,
} from "./hubspot.js";
import { SlackClient, SlackError } from "./slack.js";

const tokenConnectBody = z.object({
  provider: z.enum(["hubspot", "airtable", "slack"]),
  accessToken: z.string().trim().min(10).max(500),
  name: z.string().trim().min(1).max(100).optional(),
});
const objectSchema = z.enum(HUBSPOT_OBJECT_KEYS as [HubSpotObject, ...HubSpotObject[]]);
const hubspotSyncBody = z.object({
  connectionId: z.string().uuid(),
  object: objectSchema,
  properties: z.array(z.string().min(1).max(200)).min(1).max(MAX_HUBSPOT_PROPERTIES),
  name: z.string().trim().min(1).max(255).optional(),
  intervalMinutes: z.number().int().min(5).max(1440).optional(),
  twoWay: z.boolean().optional(),
});
const airtableSyncBody = z.object({
  connectionId: z.string().uuid(),
  airtableBaseId: z.string().regex(/^app[A-Za-z0-9]+$/),
  airtableTableId: z.string().regex(/^tbl[A-Za-z0-9]+$/),
  /** Omit to sync every field, including ones added in Airtable later. */
  fieldIds: z.array(z.string().regex(/^fld[A-Za-z0-9]+$/)).max(MAX_AIRTABLE_FIELDS).optional(),
  name: z.string().trim().min(1).max(255).optional(),
  intervalMinutes: z.number().int().min(5).max(1440).optional(),
});
const gmailSyncBody = z.object({
  connectionId: z.string().uuid(),
  query: z.string().trim().max(500).default("in:inbox"),
  maxMessages: z.number().int().min(1).max(MAX_GMAIL_MESSAGES).default(200),
  includeBody: z.boolean().default(true),
  name: z.string().trim().min(1).max(255).optional(),
  intervalMinutes: z.number().int().min(5).max(1440).optional(),
});
const gmailStartBody = z.object({
  /** App path to come back to, e.g. "/connectors". */
  returnTo: z
    .string()
    .max(500)
    .regex(/^\/(?!\/)[^\\]*$/)
    .optional(),
});

type BaseParams = { baseId: string };
type ConnParams = { connectionId: string };
type BaseConnParams = { baseId: string; connectionId: string };

const GMAIL_STATE_TTL_MS = 10 * 60_000;

export async function registerIntegrationRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const key = mfaKey(ctx.env);
  const deps = { db: ctx.db, redis: ctx.redis, storage: ctx.storage, secretKey: key, google: ctx.env };
  startTwoWayPusher(deps, app.log);

  function wrap<R extends RouteGenericInterface>(fn: (request: FastifyRequest<R>, reply: FastifyReply) => Promise<void>) {
    return async (request: FastifyRequest<R>, reply: FastifyReply) => {
      try {
        await fn(request, reply);
      } catch (err) {
        if (err instanceof HubSpotError || err instanceof AirtableError || err instanceof GmailError || err instanceof SlackError) {
          handleRouteError(request, reply, new ApiError(422, "VALIDATION_FAILED", err.message));
          return;
        }
        handleRouteError(request, reply, err);
      }
    };
  }

  function signedIn(request: FastifyRequest) {
    const user = request.user;
    if (!user) throw new ApiError(401, "UNAUTHENTICATED", "Sign in first");
    return user;
  }

  async function base(request: FastifyRequest<{ Params: BaseParams }>, action: "base.read" | "base.manage_schema") {
    const user = signedIn(request);
    const baseId = parsePid(request.params.baseId, "bas");
    const b = await resolveBaseContext(ctx.db, user.id, baseId);
    if (!b.ok) throw new ApiError(404, "NOT_FOUND", "Base not found");
    assertCan(await compileForUser(ctx.db, user.id, baseId), action);
    return { user, baseId, orgId: b.orgId, workspaceId: b.workspaceId };
  }

  /** Connections are personal: only the person who added one can use it (in any of their bases). */
  async function ownConnection(userId: string, id: string, provider?: ConnectionProvider): Promise<ConnectionRow> {
    const conn = z.string().uuid().safeParse(id).success ? await loadConnection(ctx.db, id) : null;
    if (!conn || conn.user_id !== userId) throw new ApiError(404, "NOT_FOUND", "Connection not found");
    if (provider && conn.provider !== provider) throw new ApiError(422, "VALIDATION_FAILED", `That isn't a ${PROVIDER_LABELS[provider]} connection`);
    return conn;
  }

  async function homeOrg(userId: string): Promise<string> {
    const r = await sql<{ org_id: string }>`
      SELECT org_id FROM core.organization_members WHERE user_id = ${userId} AND status = 'active' ORDER BY joined_at LIMIT 1
    `.execute(ctx.db);
    const org = r.rows[0]?.org_id;
    if (!org) throw new ApiError(403, "FORBIDDEN", "Join an organization before connecting other apps");
    return org;
  }

  /** Save a connection; connecting the same account again refreshes its credentials instead of adding a copy. */
  async function saveConnection(opts: {
    userId: string;
    orgId: string;
    provider: ConnectionProvider;
    name: string;
    accountId: string | null;
    accountLabel: string;
    creds: ConnectionCredentials;
    ip: string;
    workspaceId?: string;
  }): Promise<{ conn: ConnectionRow; reconnected: boolean }> {
    const sealed = sealCredentials(opts.creds, key);
    if (opts.accountId) {
      const r = await sql<ConnectionRow>`
        UPDATE core.integration_connections
        SET credentials = ${sealed}, account_label = ${opts.accountLabel}, updated_at = now()
        WHERE id = (
          SELECT id FROM core.integration_connections
          WHERE user_id = ${opts.userId} AND provider = ${opts.provider} AND account_id = ${opts.accountId} AND deleted_at IS NULL
          ORDER BY created_at LIMIT 1
        )
        RETURNING *
      `.execute(ctx.db);
      if (r.rows[0]) return { conn: r.rows[0], reconnected: true };
    }
    const r = await sql<ConnectionRow>`
      INSERT INTO core.integration_connections (org_id, user_id, provider, name, account_id, account_label, credentials)
      VALUES (${opts.orgId}, ${opts.userId}, ${opts.provider}, ${opts.name}, ${opts.accountId}, ${opts.accountLabel}, ${sealed})
      RETURNING *
    `.execute(ctx.db);
    const conn = r.rows[0]!;
    await writeAuditEvent(ctx.db, {
      orgId: opts.orgId,
      ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {}),
      actorUserId: opts.userId,
      action: "integration.connected",
      targetType: "integration_connection",
      targetId: conn.id,
      metadata: { provider: opts.provider, accountId: opts.accountId },
      ip: opts.ip,
    });
    return { conn, reconnected: false };
  }

  /** Check a pasted token with the provider and describe the account it belongs to. */
  async function checkToken(provider: "hubspot" | "airtable" | "slack", token: string, name?: string) {
    switch (provider) {
      case "hubspot": {
        let account: HubSpotAccount = { portalId: null, uiDomain: "app.hubspot.com" };
        try {
          account = await new HubSpotClient(token).account();
        } catch (err) {
          // Account details are optional; only a rejected token or no answer at all is fatal.
          if (!(err instanceof HubSpotError) || err.status === 401 || err.status === 0) throw err;
        }
        const label = name ?? (account.portalId ? `Account ${account.portalId}` : "HubSpot");
        return { name: label, accountId: account.portalId, accountLabel: label };
      }
      case "airtable": {
        const who = await new AirtableClient(token).whoami();
        const label = who.email ?? "Airtable";
        return { name: name ?? label, accountId: who.id || null, accountLabel: label };
      }
      case "slack": {
        const t = await new SlackClient(token).authTest();
        return { name: name ?? t.team, accountId: t.teamId || null, accountLabel: t.team };
      }
    }
  }

  async function disconnect(conn: ConnectionRow, userId: string, ip: string, workspaceId?: string) {
    await sql`UPDATE core.integration_connections SET deleted_at = now(), credentials = '', updated_at = now() WHERE id = ${conn.id}`.execute(ctx.db);
    await writeAuditEvent(ctx.db, {
      orgId: conn.org_id,
      ...(workspaceId ? { workspaceId } : {}),
      actorUserId: userId,
      action: "integration.disconnected",
      targetType: "integration_connection",
      targetId: conn.id,
      metadata: { provider: conn.provider },
      ip,
    });
  }

  function token(conn: ConnectionRow): string {
    return openCredentials(conn, key).accessToken;
  }

  // -------------------------------------------------------------------------
  // Account-level connectors (Settings → Connectors)
  // -------------------------------------------------------------------------

  app.get(
    "/v1/connections",
    wrap(async (request, reply) => {
      const user = signedIn(request);
      const conns = await userConnections(ctx.db, user.id);
      const usage = await sql<{ connection_id: string; n: number }>`
        SELECT s.connection_id, count(*)::int AS n
        FROM data.table_syncs s INNER JOIN data.tables t ON t.id = s.table_id AND t.deleted_at IS NULL
        WHERE s.connection_id = ANY(${conns.map((c) => c.id)}::uuid[])
        GROUP BY s.connection_id
      `.execute(ctx.db);
      const used = new Map(usage.rows.map((r) => [r.connection_id, r.n]));
      void reply.send({
        connections: conns.map((c) => ({ ...connectionDto(c), syncedTables: used.get(c.id) ?? 0 })),
        providers: { gmail: { available: googleOAuthEnabled(ctx.env) } },
      });
    }),
  );

  app.post(
    "/v1/connections",
    wrap(async (request, reply) => {
      const user = signedIn(request);
      const body = tokenConnectBody.parse(request.body ?? {});
      const info = await checkToken(body.provider, body.accessToken, body.name);
      const { conn, reconnected } = await saveConnection({
        userId: user.id,
        orgId: await homeOrg(user.id),
        provider: body.provider,
        ...info,
        creds: { accessToken: body.accessToken },
        ip: request.ip,
      });
      void reply.code(reconnected ? 200 : 201).send({ connection: connectionDto(conn), reconnected });
    }),
  );

  app.delete<{ Params: ConnParams }>(
    "/v1/connections/:connectionId",
    wrap<{ Params: ConnParams }>(async (request, reply) => {
      const user = signedIn(request);
      const conn = await ownConnection(user.id, request.params.connectionId);
      await disconnect(conn, user.id, request.ip);
      void reply.code(204).send();
    }),
  );

  /** Start "Sign in with Google" for Gmail; the browser goes to the returned URL. */
  app.post(
    "/v1/connections/gmail/start",
    wrap(async (request, reply) => {
      const user = signedIn(request);
      if (!googleOAuthEnabled(ctx.env)) {
        throw new ApiError(422, "VALIDATION_FAILED", "Gmail isn't set up on this server yet: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are missing.");
      }
      const body = gmailStartBody.parse(request.body ?? {});
      await homeOrg(user.id);
      const state = await createChallenge(ctx.db, "connect_oauth_state", {
        userId: user.id,
        data: { provider: "gmail", returnTo: body.returnTo ?? "/connectors" },
        ttlMs: GMAIL_STATE_TTL_MS,
      });
      void reply.send({ url: gmailAuthorizeUrl(ctx.env, state, user.email) });
    }),
  );

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>("/v1/connections/gmail/callback", async (request, reply) => {
    const back = (returnTo: string, params: Record<string, string>) => {
      const appUrl = new URL(ctx.env.APP_URL);
      let url = new URL(returnTo, appUrl);
      if (url.origin !== appUrl.origin) url = new URL("/connectors", appUrl);
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
      void reply.redirect(url.toString());
    };
    const q = request.query;
    const challenge = q.state ? await findChallenge(ctx.db, "connect_oauth_state", q.state) : null;
    if (!challenge || !challenge.user_id || !(await consumeChallenge(ctx.db, challenge.id))) {
      back("/connectors", { connectError: "The Google sign-in link expired. Try connecting Gmail again." });
      return;
    }
    const returnTo = typeof challenge.data["returnTo"] === "string" ? challenge.data["returnTo"] : "/connectors";
    if (q.error || !q.code) {
      back(returnTo, { connectError: q.error === "access_denied" ? "Gmail wasn't connected: access was declined." : "Google sign-in failed." });
      return;
    }
    try {
      const tokens = await exchangeGmailCode(ctx.env, q.code);
      const missing = GMAIL_SCOPES.filter((s) => s.startsWith("https://") && !tokens.scopes.includes(s));
      if (tokens.scopes.length && missing.length) {
        back(returnTo, { connectError: "Gmail wasn't connected: allow TableOS to read and send email on the Google consent screen." });
        return;
      }
      const profile = await googleAccountEmail(tokens.accessToken);
      const { reconnected } = await saveConnection({
        userId: challenge.user_id,
        orgId: await homeOrg(challenge.user_id),
        provider: "gmail",
        name: profile.email,
        accountId: profile.email,
        accountLabel: profile.email,
        creds: { accessToken: tokens.accessToken, ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}), expiresAt: tokens.expiresAt },
        ip: request.ip,
      });
      back(returnTo, { connected: "gmail", ...(reconnected ? { reconnected: "1" } : {}) });
    } catch (err) {
      request.log.warn({ err: err instanceof Error ? err.message : err }, "Gmail connect failed");
      back(returnTo, { connectError: err instanceof GmailError ? err.message : "Google sign-in failed." });
    }
  });

  app.get<{ Params: ConnParams }>(
    "/v1/connections/:connectionId/airtable/bases",
    wrap<{ Params: ConnParams }>(async (request, reply) => {
      const user = signedIn(request);
      const conn = await ownConnection(user.id, request.params.connectionId, "airtable");
      const bases = await new AirtableClient(token(conn)).bases();
      void reply.send({ bases: bases.map((b) => ({ id: b.id, name: b.name })) });
    }),
  );

  app.get<{ Params: ConnParams & { airtableBaseId: string } }>(
    "/v1/connections/:connectionId/airtable/bases/:airtableBaseId/tables",
    wrap<{ Params: ConnParams & { airtableBaseId: string } }>(async (request, reply) => {
      const user = signedIn(request);
      const conn = await ownConnection(user.id, request.params.connectionId, "airtable");
      const tables = await new AirtableClient(token(conn)).tables(request.params.airtableBaseId);
      void reply.send({
        tables: tables.map((t) => ({
          id: t.id,
          name: t.name,
          primaryFieldId: t.primaryFieldId,
          fields: t.fields.map((f) => ({ id: f.id, name: f.name, type: f.type, synced: planAirtableField(f, () => "") !== null })),
        })),
      });
    }),
  );

  app.get<{ Params: ConnParams }>(
    "/v1/connections/:connectionId/slack/channels",
    wrap<{ Params: ConnParams }>(async (request, reply) => {
      const user = signedIn(request);
      const conn = await ownConnection(user.id, request.params.connectionId, "slack");
      void reply.send({ channels: await new SlackClient(token(conn)).channels() });
    }),
  );

  // -------------------------------------------------------------------------
  // Base-scoped (kept for the base's Connectors dialog and older clients)
  // -------------------------------------------------------------------------

  app.get<{ Params: BaseParams }>(
    "/v1/bases/:baseId/connections",
    wrap<{ Params: BaseParams }>(async (request, reply) => {
      const s = await base(request, "base.read");
      void reply.send({ connections: (await userConnections(ctx.db, s.user.id)).map(connectionDto) });
    }),
  );

  app.post<{ Params: BaseParams }>(
    "/v1/bases/:baseId/connections",
    wrap<{ Params: BaseParams }>(async (request, reply) => {
      const s = await base(request, "base.manage_schema");
      const body = tokenConnectBody.parse(request.body ?? {});
      const info = await checkToken(body.provider, body.accessToken, body.name);
      const { conn, reconnected } = await saveConnection({
        userId: s.user.id,
        orgId: s.orgId,
        workspaceId: s.workspaceId,
        provider: body.provider,
        ...info,
        creds: { accessToken: body.accessToken },
        ip: request.ip,
      });
      void reply.code(reconnected ? 200 : 201).send({ connection: connectionDto(conn), reconnected });
    }),
  );

  app.delete<{ Params: BaseConnParams }>(
    "/v1/bases/:baseId/connections/:connectionId",
    wrap<{ Params: BaseConnParams }>(async (request, reply) => {
      const s = await base(request, "base.read");
      const conn = await ownConnection(s.user.id, request.params.connectionId);
      await disconnect(conn, s.user.id, request.ip, s.workspaceId);
      void reply.code(204).send();
    }),
  );

  /** Properties of a HubSpot object, with the suggested ones first. */
  app.get<{ Params: BaseConnParams; Querystring: { object?: string } }>(
    "/v1/bases/:baseId/connections/:connectionId/hubspot/properties",
    wrap<{ Params: BaseConnParams; Querystring: { object?: string } }>(async (request, reply) => {
      const s = await base(request, "base.read");
      const conn = await ownConnection(s.user.id, request.params.connectionId, "hubspot");
      const object = objectSchema.parse(request.query.object);
      const def = HUBSPOT_OBJECTS[object];
      const props = (await new HubSpotClient(token(conn)).properties(object)).filter((p) => !p.hidden);
      const defaults: readonly string[] = def.defaults;
      const rank = (n: string) => (defaults.includes(n) ? defaults.indexOf(n) : Number.MAX_SAFE_INTEGER);
      props.sort((a, b) => rank(a.name) - rank(b.name) || (a.label || a.name).localeCompare(b.label || b.name));
      void reply.send({
        object,
        primaryProperty: def.primary,
        properties: props.map((p) => ({
          name: p.name,
          label: p.label || p.name,
          type: p.type,
          group: p.groupName ?? null,
          suggested: defaults.includes(p.name),
        })),
      });
    }),
  );

  type BaseScope = Awaited<ReturnType<typeof base>>;

  /** Create a table that mirrors an external source; the first sync runs in the background. */
  async function createSyncedTable(
    request: FastifyRequest,
    s: BaseScope,
    opts: {
      provider: Exclude<SyncProvider, "tableos">;
      conn: ConnectionRow;
      sourceConfig: Record<string, unknown>;
      primary: { id: string; name: string };
      name: string;
      intervalMinutes: number;
      twoWay?: boolean;
      audit: Record<string, unknown>;
      syncedFrom: string;
    },
  ): Promise<{ tableId: string; syncId: string }> {
    const taken = await sql<{ name: string }>`SELECT name FROM data.tables WHERE base_id = ${s.baseId} AND deleted_at IS NULL`.execute(ctx.db);
    const takenSet = new Set(taken.rows.map((r) => r.name.toLowerCase()));
    let name = opts.name;
    for (let i = 2; takenSet.has(name.toLowerCase()); i++) name = `${opts.name} ${i}`;

    let tableId = "";
    await withBaseTx(
      ctx.db,
      { orgId: s.orgId, workspaceId: s.workspaceId, baseId: s.baseId, actor: { actorType: "user", actorId: s.user.id, via: "api" }, redis: ctx.redis },
      async (_m, trx) => {
        const boot = await bootstrapDefaultTable(trx, {
          workspaceId: s.workspaceId,
          baseId: s.baseId,
          userId: s.user.id,
          tableName: name,
          emptyRecords: 0,
          fields: [{ name: opts.primary.name, type: "text", config: {} }],
        });
        tableId = boot.tableId;
        await sql`
          INSERT INTO data.table_syncs (workspace_id, base_id, table_id, provider, connection_id, source_config, owner_user_id, field_map, interval_minutes, two_way)
          VALUES (${s.workspaceId}, ${s.baseId}, ${tableId}, ${opts.provider}, ${opts.conn.id}, ${JSON.stringify(opts.sourceConfig)}::jsonb, ${s.user.id},
                  ${JSON.stringify({ [opts.primary.id]: boot.fieldId })}::jsonb, ${opts.intervalMinutes}, ${opts.twoWay ?? false})
        `.execute(trx);
        return {
          kind: "schema" as const,
          ops: [{ op: "table.created", tableId, name }],
          tableIds: [tableId],
          eventType: "table.created",
          aggregateType: "table",
          aggregateId: tableId,
          payload: { tableId, name, syncedFrom: opts.syncedFrom },
        };
      },
    );
    const sync = (await loadSync(ctx.db, { tableId }))!;
    void runTableSync(deps, sync.id).catch((err: unknown) => {
      if (err instanceof SyncBusyError) return;
      request.log.warn({ syncId: sync.id, err: err instanceof Error ? err.message : err }, `Initial ${opts.provider} sync failed`);
    });
    await writeAuditEvent(ctx.db, {
      orgId: s.orgId,
      workspaceId: s.workspaceId,
      actorUserId: s.user.id,
      action: "table.sync_created",
      targetType: "table",
      targetId: tableId,
      metadata: { provider: opts.provider, ...opts.audit },
      ip: request.ip,
    });
    return { tableId: pid("tbl", tableId), syncId: sync.id };
  }

  app.post<{ Params: BaseParams }>(
    "/v1/bases/:baseId/hubspot-syncs",
    wrap<{ Params: BaseParams }>(async (request, reply) => {
      const s = await base(request, "base.manage_schema");
      const body = hubspotSyncBody.parse(request.body ?? {});
      const conn = await ownConnection(s.user.id, body.connectionId, "hubspot");
      const hs = new HubSpotClient(token(conn));
      const props = await hs.properties(body.object);
      const known = new Set(props.map((p) => p.name));
      const def = HUBSPOT_OBJECTS[body.object];
      const properties = [...new Set([...(def.primary ? [def.primary] : []), ...body.properties.filter((p) => known.has(p))])];
      let account: HubSpotAccount = { portalId: conn.account_id, uiDomain: "app.hubspot.com" };
      try {
        account = await hs.account();
      } catch {
        // Keep what was stored at connect time.
      }
      const sourceConfig = { object: body.object, properties, portalId: account.portalId, uiDomain: account.uiDomain };
      const res = await createSyncedTable(request, s, {
        provider: "hubspot",
        conn,
        sourceConfig,
        primary: hubspotPrimaryField(sourceConfig, props),
        name: body.name ?? `HubSpot ${def.label}`,
        intervalMinutes: body.intervalMinutes ?? 15,
        twoWay: body.twoWay ?? false,
        audit: { object: body.object, properties: properties.length },
        syncedFrom: `hubspot:${body.object}`,
      });
      void reply.code(201).send(res);
    }),
  );

  app.post<{ Params: BaseParams }>(
    "/v1/bases/:baseId/airtable-syncs",
    wrap<{ Params: BaseParams }>(async (request, reply) => {
      const s = await base(request, "base.manage_schema");
      const body = airtableSyncBody.parse(request.body ?? {});
      const conn = await ownConnection(s.user.id, body.connectionId, "airtable");
      const client = new AirtableClient(token(conn));
      const [tables, bases] = await Promise.all([client.tables(body.airtableBaseId), client.bases().catch(() => [])]);
      const table = tables.find((t) => t.id === body.airtableTableId);
      if (!table) throw new ApiError(422, "VALIDATION_FAILED", "That Airtable table wasn't found in the base");
      const known = new Set(table.fields.map((f) => f.id));
      const fieldIds = body.fieldIds ? [...new Set(body.fieldIds.filter((f) => known.has(f)))] : null;
      const baseName = bases.find((b) => b.id === body.airtableBaseId)?.name ?? null;
      const sourceConfig = { baseId: body.airtableBaseId, baseName, tableId: table.id, tableName: table.name, fieldIds };
      const res = await createSyncedTable(request, s, {
        provider: "airtable",
        conn,
        sourceConfig,
        primary: airtablePrimaryField(table),
        name: body.name ?? table.name,
        intervalMinutes: body.intervalMinutes ?? 15,
        audit: { airtableBaseId: body.airtableBaseId, airtableTableId: table.id, fields: fieldIds?.length ?? "all" },
        syncedFrom: `airtable:${table.id}`,
      });
      void reply.code(201).send(res);
    }),
  );

  app.post<{ Params: BaseParams }>(
    "/v1/bases/:baseId/gmail-syncs",
    wrap<{ Params: BaseParams }>(async (request, reply) => {
      const s = await base(request, "base.manage_schema");
      const body = gmailSyncBody.parse(request.body ?? {});
      const conn = await ownConnection(s.user.id, body.connectionId, "gmail");
      const res = await createSyncedTable(request, s, {
        provider: "gmail",
        conn,
        sourceConfig: { query: body.query, maxMessages: body.maxMessages, includeBody: body.includeBody },
        primary: { id: "subject", name: "Subject" },
        name: body.name ?? "Gmail inbox",
        intervalMinutes: body.intervalMinutes ?? 15,
        audit: { query: body.query, maxMessages: body.maxMessages },
        syncedFrom: "gmail",
      });
      void reply.code(201).send(res);
    }),
  );
}
