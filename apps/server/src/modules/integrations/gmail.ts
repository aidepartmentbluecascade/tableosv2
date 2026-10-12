import type { Env } from "@tabula/config";
import type { TabulaDb } from "@tabula/db";
import { sql } from "kysely";
import { SyncError, type MappedField, type SourceField, type SyncSource } from "../sync/source.js";
import { openCredentials, sealCredentials, type ConnectionRow } from "./connections.js";

/**
 * Gmail through Google OAuth (the server's GOOGLE_CLIENT_ID / _SECRET): send
 * mail from automations and sync messages matching a search into a table.
 * GOOGLE_API_BASE points every Google API call at one host (tests).
 */

export const GMAIL_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.readonly",
];
export const MAX_GMAIL_MESSAGES = 2_000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class GmailError extends SyncError {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function override(): string | null {
  const v = process.env["GOOGLE_API_BASE"];
  return v ? v.replace(/\/+$/, "") : null;
}
const tokenUrl = () => `${override() ?? "https://oauth2.googleapis.com"}/token`;
const userinfoUrl = () => `${override() ?? "https://www.googleapis.com"}/oauth2/v3/userinfo`;
const gmailBase = () => `${override() ?? "https://gmail.googleapis.com"}/gmail/v1/users/me`;

export function gmailRedirectUri(env: Env): string {
  return `${env.API_URL.replace(/\/+$/, "")}/v1/connections/gmail/callback`;
}

export function gmailAuthorizeUrl(env: Env, state: string, loginHint?: string): string {
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID!,
    redirect_uri: gmailRedirectUri(env),
    response_type: "code",
    scope: GMAIL_SCOPES.join(" "),
    state,
    // A refresh token is only issued with offline access + a fresh consent screen.
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    ...(loginHint ? { login_hint: loginHint } : {}),
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

async function tokenRequest(body: URLSearchParams): Promise<TokenResponse & { ok: boolean; status: number }> {
  let res: Response;
  try {
    res = await fetch(tokenUrl(), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body,
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new GmailError(`Couldn't reach Google: ${err instanceof Error ? err.message : String(err)}`, 0);
  }
  let json: TokenResponse = {};
  try {
    json = (await res.json()) as TokenResponse;
  } catch {
    // Non-JSON error page.
  }
  return { ...json, ok: res.ok, status: res.status };
}

export async function exchangeGmailCode(env: Env, code: string): Promise<{ accessToken: string; refreshToken: string | null; expiresAt: number; scopes: string[] }> {
  const r = await tokenRequest(
    new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID!,
      client_secret: env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: gmailRedirectUri(env),
      grant_type: "authorization_code",
    }),
  );
  if (!r.ok || !r.access_token) throw new GmailError(`Google sign-in failed: ${r.error_description ?? r.error ?? `HTTP ${r.status}`}`, r.status);
  return {
    accessToken: r.access_token,
    refreshToken: r.refresh_token ?? null,
    expiresAt: Date.now() + (r.expires_in ?? 3600) * 1000,
    scopes: (r.scope ?? "").split(/\s+/).filter(Boolean),
  };
}

export async function googleAccountEmail(accessToken: string): Promise<{ sub: string; email: string }> {
  const res = await fetch(userinfoUrl(), { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(20_000) });
  const json = (await res.json().catch(() => ({}))) as { sub?: string; email?: string };
  if (!res.ok || !json.email) throw new GmailError("Couldn't read the Google account's email address", res.status);
  return { sub: String(json.sub ?? json.email), email: json.email };
}

/** A working access token for a Gmail connection, refreshed (and saved) when it has expired. */
export function gmailTokenProvider(db: TabulaDb, env: Pick<Env, "GOOGLE_CLIENT_ID" | "GOOGLE_CLIENT_SECRET">, conn: ConnectionRow, key: Buffer) {
  let creds = openCredentials(conn, key);
  return async (force = false): Promise<string> => {
    if (!force && creds.accessToken && (creds.expiresAt ?? 0) > Date.now() + 60_000) return creds.accessToken;
    if (!creds.refreshToken) throw new GmailError("Google access for this Gmail account expired. Reconnect Gmail in Connectors.", 401);
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) throw new GmailError("Google sign-in isn't configured on this server", 0);
    const r = await tokenRequest(
      new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        refresh_token: creds.refreshToken,
        grant_type: "refresh_token",
      }),
    );
    if (!r.ok || !r.access_token) {
      if (r.error === "invalid_grant") throw new GmailError("Google access for this Gmail account was revoked. Reconnect Gmail in Connectors.", 401);
      throw new GmailError(`Couldn't refresh Google access: ${r.error_description ?? r.error ?? `HTTP ${r.status}`}`, r.status >= 500 ? 503 : r.status);
    }
    creds = { accessToken: r.access_token, refreshToken: r.refresh_token ?? creds.refreshToken, expiresAt: Date.now() + (r.expires_in ?? 3600) * 1000 };
    await sql`
      UPDATE core.integration_connections SET credentials = ${sealCredentials(creds, key)}, updated_at = now()
      WHERE id = ${conn.id} AND deleted_at IS NULL
    `.execute(db);
    return creds.accessToken;
  };
}

export type TokenProvider = (force?: boolean) => Promise<string>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class GmailClient {
  constructor(private readonly token: TokenProvider) {}

  async request<T>(method: "GET" | "POST", path: string, query: Record<string, string | string[] | undefined> = {}, body?: unknown): Promise<T> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (Array.isArray(v)) for (const x of v) qs.append(k, x);
      else if (v !== undefined) qs.set(k, v);
    }
    const q = qs.toString();
    const url = `${gmailBase()}${path}${q ? `?${q}` : ""}`;
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(url, {
          method,
          headers: {
            authorization: `Bearer ${await this.token(refreshed)}`,
            accept: "application/json",
            ...(body !== undefined ? { "content-type": "application/json" } : {}),
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(30_000),
        });
      } catch (err) {
        if (attempt < 2) {
          await sleep(1_000 * (attempt + 1));
          continue;
        }
        throw new GmailError(`Couldn't reach Gmail: ${err instanceof Error ? err.message : String(err)}`, 0);
      }
      if (res.status === 401 && !refreshed) {
        refreshed = true;
        continue;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 4) {
        await sleep(1_000 * 2 ** attempt);
        continue;
      }
      if (!res.ok) throw await gmailError(res);
      return (await res.json()) as T;
    }
  }

  async labels(): Promise<{ id: string; name: string; type?: string }[]> {
    const r = await this.request<{ labels?: { id: string; name: string; type?: string }[] }>("GET", "/labels");
    return r.labels ?? [];
  }

  async messageIds(query: string, max: number): Promise<string[]> {
    const ids: string[] = [];
    let pageToken: string | undefined;
    do {
      const r = await this.request<{ messages?: { id: string }[]; nextPageToken?: string }>("GET", "/messages", {
        q: query || undefined,
        maxResults: String(Math.min(500, max - ids.length)),
        pageToken,
      });
      for (const m of r.messages ?? []) ids.push(m.id);
      pageToken = r.nextPageToken;
    } while (pageToken && ids.length < max);
    return ids.slice(0, max);
  }

  message(id: string, full: boolean): Promise<GmailMessage> {
    return this.request<GmailMessage>("GET", `/messages/${encodeURIComponent(id)}`, {
      format: full ? "full" : "metadata",
      ...(full ? {} : { metadataHeaders: ["From", "To", "Cc", "Subject", "Date"] }),
    });
  }

  send(raw: string): Promise<{ id: string; threadId: string }> {
    return this.request("POST", "/messages/send", {}, { raw });
  }
}

async function gmailError(res: Response): Promise<GmailError> {
  let body: { error?: { message?: string; status?: string } } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    // Non-JSON error page.
  }
  if (res.status === 401) return new GmailError("Google rejected the Gmail credentials. Reconnect Gmail in Connectors.", 401);
  if (res.status === 403) {
    return new GmailError(
      `Gmail refused the request${body.error?.message ? `: ${body.error.message.slice(0, 200)}` : ""}. Reconnect Gmail and allow reading and sending mail.`,
      403,
    );
  }
  return new GmailError(`Gmail request failed: ${body.error?.message?.slice(0, 300) ?? `HTTP ${res.status}`}`, res.status);
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

export function parseAddresses(raw: string): string[] {
  return raw
    .replace(/[\r\n]+/g, " ")
    .split(/[,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The bare address in "Name <a@b.c>" or "a@b.c". */
function bareAddress(a: string): string {
  const m = /<([^>]+)>/.exec(a);
  return (m ? m[1]! : a).trim();
}

export function invalidAddresses(list: string[]): string[] {
  return list.filter((a) => !EMAIL_RE.test(bareAddress(a)));
}

function encodeHeader(s: string): string {
  const clean = s.replace(/[\r\n]+/g, " ");
  return /^[\x20-\x7e]*$/.test(clean) ? clean : `=?UTF-8?B?${Buffer.from(clean, "utf8").toString("base64")}?=`;
}

/** RFC 2822 message, base64url-encoded for messages.send. */
export function buildRawEmail(m: { from: string; to: string[]; cc: string[]; bcc: string[]; subject: string; text: string }): string {
  const headers = [
    `From: ${m.from}`,
    `To: ${m.to.join(", ")}`,
    ...(m.cc.length ? [`Cc: ${m.cc.join(", ")}`] : []),
    ...(m.bcc.length ? [`Bcc: ${m.bcc.join(", ")}`] : []),
    `Subject: ${encodeHeader(m.subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
  ];
  const body = (Buffer.from(m.text.replace(/\r?\n/g, "\r\n"), "utf8").toString("base64").match(/.{1,76}/g) ?? []).join("\r\n");
  return Buffer.from(`${headers.join("\r\n")}\r\n\r\n${body}`, "utf8").toString("base64url");
}

// ---------------------------------------------------------------------------
// Inbox sync
// ---------------------------------------------------------------------------

interface GmailPart {
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: GmailPart[];
}

interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: GmailPart;
}

export interface GmailSourceConfig {
  /** Gmail search, e.g. "in:inbox" or "from:billing@x.com newer_than:30d". */
  query: string;
  maxMessages: number;
  includeBody: boolean;
}

export function parseGmailConfig(raw: unknown): GmailSourceConfig {
  const o = (raw ?? {}) as Record<string, unknown>;
  const max = Number(o["maxMessages"]);
  return {
    query: typeof o["query"] === "string" ? o["query"] : "in:inbox",
    maxMessages: Number.isInteger(max) && max > 0 ? Math.min(max, MAX_GMAIL_MESSAGES) : 200,
    includeBody: o["includeBody"] !== false,
  };
}

const SYSTEM_LABELS: Record<string, string> = {
  INBOX: "Inbox",
  SENT: "Sent",
  DRAFT: "Draft",
  SPAM: "Spam",
  TRASH: "Trash",
  UNREAD: "Unread",
  STARRED: "Starred",
  IMPORTANT: "Important",
  CHAT: "Chat",
  CATEGORY_PERSONAL: "Personal",
  CATEGORY_SOCIAL: "Social",
  CATEGORY_PROMOTIONS: "Promotions",
  CATEGORY_UPDATES: "Updates",
  CATEGORY_FORUMS: "Forums",
};

function header(p: GmailPart | undefined, name: string): string {
  const h = p?.headers?.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return (h?.value ?? "").trim();
}

function decode(data: string | undefined): string {
  return data ? Buffer.from(data, "base64url").toString("utf8") : "";
}

function findPart(p: GmailPart | undefined, mime: string): GmailPart | null {
  if (!p) return null;
  if (p.mimeType === mime && p.body?.data && !p.filename) return p;
  for (const c of p.parts ?? []) {
    const hit = findPart(c, mime);
    if (hit) return hit;
  }
  return null;
}

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function bodyText(p: GmailPart | undefined): string {
  const plain = findPart(p, "text/plain");
  if (plain) return decode(plain.body?.data).trim();
  const html = findPart(p, "text/html");
  return html ? htmlToText(decode(html.body?.data)) : "";
}

function attachmentNames(p: GmailPart | undefined, out: string[] = []): string[] {
  if (!p) return out;
  if (p.filename) out.push(p.filename);
  for (const c of p.parts ?? []) attachmentNames(c, out);
  return out;
}

const T = (long = false): MappedField => ({ type: long ? "long_text" : "text", config: {}, conv: "text", compare: "none" });
const s = (v: string, max = 100_000) => (v ? v.slice(0, max) : null);

export async function gmailSource(token: TokenProvider, cfg: GmailSourceConfig, accountEmail: string | null): Promise<SyncSource> {
  const client = new GmailClient(token);
  const labelList = await client.labels();
  const labelName = new Map<string, string>();
  const seen = new Set<string>();
  for (const l of labelList) {
    if (l.id.startsWith("CATEGORY_") || SYSTEM_LABELS[l.id] || l.type === "user") {
      let name = (SYSTEM_LABELS[l.id] ?? l.name).trim().slice(0, 240);
      for (let i = 2; seen.has(name.toLowerCase()); i++) name = `${(SYSTEM_LABELS[l.id] ?? l.name).trim().slice(0, 240)} (${i})`;
      seen.add(name.toLowerCase());
      labelName.set(l.id, name);
    }
  }
  const options = [...labelName.values()].slice(0, 500).map((label) => ({ label }));

  const fields: SourceField[] = [
    { id: "subject", name: "Subject", mapped: T() },
    { id: "from", name: "From", mapped: T() },
    { id: "fromEmail", name: "From email", mapped: { type: "email", config: {}, conv: "text", compare: "none" } },
    { id: "to", name: "To", mapped: T(true) },
    { id: "cc", name: "Cc", mapped: T(true) },
    { id: "date", name: "Date", mapped: { type: "datetime", config: {}, conv: "datetime", compare: "none" } },
    { id: "snippet", name: "Snippet", mapped: T(true) },
    // Bodies and attachment names need the full message; metadata-only reads skip both.
    ...(cfg.includeBody
      ? [
          { id: "body", name: "Body", mapped: T(true) },
          { id: "attachments", name: "Attachments", mapped: T(true) },
        ]
      : []),
    ...(options.length ? [{ id: "labels", name: "Labels", mapped: { type: "multi_select", config: { options }, conv: "same", compare: "options" } as MappedField }] : []),
    { id: "unread", name: "Unread", mapped: { type: "checkbox", config: {}, conv: "checkbox", compare: "none" } },
    { id: "starred", name: "Starred", mapped: { type: "checkbox", config: {}, conv: "checkbox", compare: "none" } },
    { id: "thread", name: "Thread ID", mapped: T() },
    { id: "__id", name: "Message ID", mapped: T() },
    { id: "__url", name: "Gmail link", mapped: { type: "url", config: {}, conv: "text", compare: "none" } },
  ];

  const toRow = (m: GmailMessage) => {
    const p = m.payload;
    const from = header(p, "From");
    const fromEmail = bareAddress(from);
    const labels = (m.labelIds ?? []).map((id) => labelName.get(id)).filter((x): x is string => Boolean(x));
    const files = attachmentNames(p);
    const date = m.internalDate ? new Date(Number(m.internalDate)).toISOString() : null;
    const values: Record<string, unknown> = {
      subject: (header(p, "Subject") || "(no subject)").replace(/[\r\n]+/g, " ").slice(0, 1_000),
      from: s(from, 1_000),
      fromEmail: EMAIL_RE.test(fromEmail) && fromEmail.length <= 320 ? fromEmail : null,
      to: s(header(p, "To")),
      cc: s(header(p, "Cc")),
      date,
      snippet: s((m.snippet ?? "").trim()),
      unread: m.labelIds?.includes("UNREAD") ? true : null,
      starred: m.labelIds?.includes("STARRED") ? true : null,
      thread: m.threadId,
      __id: m.id,
      __url: `https://mail.google.com/mail/${accountEmail ? `?authuser=${encodeURIComponent(accountEmail)}` : "u/0/"}#all/${m.id}`,
    };
    if (cfg.includeBody) {
      values["body"] = s(bodyText(p), 50_000);
      values["attachments"] = files.length ? files.join("\n") : null;
    }
    if (options.length) values["labels"] = labels.length ? labels : null;
    return { id: m.id, values };
  };

  async function* rows() {
    const ids = await client.messageIds(cfg.query, cfg.maxMessages);
    const PAGE = 50;
    const PARALLEL = 8;
    for (let i = 0; i < ids.length; i += PAGE) {
      const chunk = ids.slice(i, i + PAGE);
      const out: GmailMessage[] = [];
      for (let j = 0; j < chunk.length; j += PARALLEL) {
        const got = await Promise.all(
          chunk.slice(j, j + PARALLEL).map((id) =>
            client.message(id, cfg.includeBody).catch((err: unknown) => {
              // A message deleted between listing and reading is skipped.
              if (err instanceof GmailError && err.status === 404) return null;
              throw err;
            }),
          ),
        );
        for (const m of got) if (m) out.push(m);
      }
      yield out.map(toRow);
    }
  }

  return { fields, rows };
}
