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
import { mfaKey } from "../auth/mfa-pending.js";
import { bootstrapDefaultTable } from "../base/bootstrap-default-table.js";
import { loadSync, runTableSync, SyncBusyError } from "../sync/engine.js";
import { connectionDto, loadConnection, openCredentials, sealCredentials, type ConnectionRow } from "./connections.js";
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

const connectBody = z.object({
  provider: z.literal("hubspot"),
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
});

type BaseParams = { baseId: string };
type ConnParams = { baseId: string; connectionId: string };

export async function registerIntegrationRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const key = mfaKey(ctx.env);
  const deps = { db: ctx.db, redis: ctx.redis, storage: ctx.storage, secretKey: key };

  function wrap<R extends RouteGenericInterface>(fn: (request: FastifyRequest<R>, reply: FastifyReply) => Promise<void>) {
    return async (request: FastifyRequest<R>, reply: FastifyReply) => {
      try {
        await fn(request, reply);
      } catch (err) {
        if (err instanceof HubSpotError) {
          handleRouteError(request, reply, new ApiError(422, "VALIDATION_FAILED", err.message));
          return;
        }
        handleRouteError(request, reply, err);
      }
    };
  }

  async function base(request: FastifyRequest<{ Params: BaseParams }>, action: "base.read" | "base.manage_schema") {
    const user = request.user;
    if (!user) throw new ApiError(401, "UNAUTHENTICATED", "Sign in first");
    const baseId = parsePid(request.params.baseId, "bas");
    const b = await resolveBaseContext(ctx.db, user.id, baseId);
    if (!b.ok) throw new ApiError(404, "NOT_FOUND", "Base not found");
    assertCan(await compileForUser(ctx.db, user.id, baseId), action);
    return { user, baseId, orgId: b.orgId, workspaceId: b.workspaceId };
  }

  /** Connections are personal: only the person who added one can use it. */
  async function ownConnection(s: { user: { id: string }; orgId: string }, id: string): Promise<ConnectionRow> {
    const conn = z.string().uuid().safeParse(id).success ? await loadConnection(ctx.db, id) : null;
    if (!conn || conn.user_id !== s.user.id || conn.org_id !== s.orgId) throw new ApiError(404, "NOT_FOUND", "Connection not found");
    return conn;
  }

  function client(conn: ConnectionRow): HubSpotClient {
    return new HubSpotClient(openCredentials(conn, key).accessToken);
  }

  app.get<{ Params: BaseParams }>(
    "/v1/bases/:baseId/connections",
    wrap<{ Params: BaseParams }>(async (request, reply) => {
      const s = await base(request, "base.read");
      const r = await sql<ConnectionRow>`
        SELECT * FROM core.integration_connections
        WHERE org_id = ${s.orgId} AND user_id = ${s.user.id} AND deleted_at IS NULL
        ORDER BY created_at
      `.execute(ctx.db);
      void reply.send({ connections: r.rows.map(connectionDto) });
    }),
  );

  app.post<{ Params: BaseParams }>(
    "/v1/bases/:baseId/connections",
    wrap<{ Params: BaseParams }>(async (request, reply) => {
      const s = await base(request, "base.manage_schema");
      const body = connectBody.parse(request.body ?? {});
      const hs = new HubSpotClient(body.accessToken);
      let account: HubSpotAccount = { portalId: null, uiDomain: "app.hubspot.com" };
      try {
        account = await hs.account();
      } catch (err) {
        // Account details are optional; only a rejected token or no answer at all is fatal.
        if (!(err instanceof HubSpotError) || err.status === 401 || err.status === 0) throw err;
      }
      const label = body.name ?? (account.portalId ? `Account ${account.portalId}` : "HubSpot");
      const r = await sql<ConnectionRow>`
        INSERT INTO core.integration_connections (org_id, user_id, provider, name, account_id, account_label, credentials)
        VALUES (${s.orgId}, ${s.user.id}, 'hubspot', ${label}, ${account.portalId}, ${label},
                ${sealCredentials({ accessToken: body.accessToken }, key)})
        RETURNING *
      `.execute(ctx.db);
      const conn = r.rows[0]!;
      await writeAuditEvent(ctx.db, {
        orgId: s.orgId,
        workspaceId: s.workspaceId,
        actorUserId: s.user.id,
        action: "integration.connected",
        targetType: "integration_connection",
        targetId: conn.id,
        metadata: { provider: "hubspot", portalId: account.portalId },
        ip: request.ip,
      });
      void reply.code(201).send({ connection: connectionDto(conn) });
    }),
  );

  app.delete<{ Params: ConnParams }>(
    "/v1/bases/:baseId/connections/:connectionId",
    wrap<{ Params: ConnParams }>(async (request, reply) => {
      const s = await base(request, "base.read");
      const conn = await ownConnection(s, request.params.connectionId);
      await sql`UPDATE core.integration_connections SET deleted_at = now(), credentials = '', updated_at = now() WHERE id = ${conn.id}`.execute(ctx.db);
      await writeAuditEvent(ctx.db, {
        orgId: s.orgId,
        workspaceId: s.workspaceId,
        actorUserId: s.user.id,
        action: "integration.disconnected",
        targetType: "integration_connection",
        targetId: conn.id,
        metadata: { provider: conn.provider },
        ip: request.ip,
      });
      void reply.code(204).send();
    }),
  );

  /** Properties of a HubSpot object, with the suggested ones first. */
  app.get<{ Params: ConnParams; Querystring: { object?: string } }>(
    "/v1/bases/:baseId/connections/:connectionId/hubspot/properties",
    wrap<{ Params: ConnParams; Querystring: { object?: string } }>(async (request, reply) => {
      const s = await base(request, "base.read");
      const conn = await ownConnection(s, request.params.connectionId);
      const object = objectSchema.parse(request.query.object);
      const def = HUBSPOT_OBJECTS[object];
      const props = (await client(conn).properties(object)).filter((p) => !p.hidden);
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

  /** Create a table that mirrors a HubSpot object; the first sync runs in the background. */
  app.post<{ Params: BaseParams }>(
    "/v1/bases/:baseId/hubspot-syncs",
    wrap<{ Params: BaseParams }>(async (request, reply) => {
      const s = await base(request, "base.manage_schema");
      const body = hubspotSyncBody.parse(request.body ?? {});
      const conn = await ownConnection(s, body.connectionId);
      const hs = client(conn);
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
      const primary = hubspotPrimaryField(sourceConfig, props);

      const taken = await sql<{ name: string }>`SELECT name FROM data.tables WHERE base_id = ${s.baseId} AND deleted_at IS NULL`.execute(ctx.db);
      const takenSet = new Set(taken.rows.map((r) => r.name.toLowerCase()));
      const wanted = body.name ?? `HubSpot ${def.label}`;
      let name = wanted;
      for (let i = 2; takenSet.has(name.toLowerCase()); i++) name = `${wanted} ${i}`;

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
            fields: [{ name: primary.name, type: "text", config: {} }],
          });
          tableId = boot.tableId;
          await sql`
            INSERT INTO data.table_syncs (workspace_id, base_id, table_id, provider, connection_id, source_config, owner_user_id, field_map, interval_minutes)
            VALUES (${s.workspaceId}, ${s.baseId}, ${tableId}, 'hubspot', ${conn.id}, ${JSON.stringify(sourceConfig)}::jsonb, ${s.user.id},
                    ${JSON.stringify({ [primary.id]: boot.fieldId })}::jsonb, ${body.intervalMinutes ?? 15})
          `.execute(trx);
          return {
            kind: "schema" as const,
            ops: [{ op: "table.created", tableId, name }],
            tableIds: [tableId],
            eventType: "table.created",
            aggregateType: "table",
            aggregateId: tableId,
            payload: { tableId, name, syncedFrom: `hubspot:${body.object}` },
          };
        },
      );
      const sync = (await loadSync(ctx.db, { tableId }))!;
      void runTableSync(deps, sync.id).catch((err: unknown) => {
        if (err instanceof SyncBusyError) return;
        request.log.warn({ syncId: sync.id, err: err instanceof Error ? err.message : err }, "Initial HubSpot sync failed");
      });
      await writeAuditEvent(ctx.db, {
        orgId: s.orgId,
        workspaceId: s.workspaceId,
        actorUserId: s.user.id,
        action: "table.sync_created",
        targetType: "table",
        targetId: tableId,
        metadata: { provider: "hubspot", object: body.object, properties: properties.length },
        ip: request.ip,
      });
      void reply.code(201).send({ tableId: pid("tbl", tableId), syncId: sync.id });
    }),
  );
}
