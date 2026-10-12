/**
 * Slack with a bot token (xoxb-…): post messages from automations.
 * SLACK_API_BASE points the client somewhere else (tests).
 */

export class SlackError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "SlackError";
  }
}

function apiBase(): string {
  return (process.env["SLACK_API_BASE"] ?? "https://slack.com/api").replace(/\/+$/, "");
}

const MESSAGES: Record<string, string> = {
  invalid_auth: "Slack rejected the bot token. Reconnect Slack with a valid bot token (xoxb-…).",
  not_authed: "Slack rejected the bot token. Reconnect Slack with a valid bot token (xoxb-…).",
  token_revoked: "The Slack bot token was revoked. Reconnect Slack.",
  account_inactive: "The Slack app was uninstalled or deactivated. Reconnect Slack.",
  missing_scope: "The Slack app is missing a permission. Add the chat:write and channels:read bot scopes, reinstall the app, then reconnect.",
  channel_not_found: "Slack channel not found. Pick a channel the bot can see.",
  not_in_channel: "The Slack bot isn't in that channel. In Slack, type /invite @your-app in the channel, then try again.",
  is_archived: "That Slack channel is archived.",
  msg_too_long: "The Slack message is too long.",
  no_text: "The Slack message is empty.",
};

export interface SlackChannel {
  id: string;
  name: string;
  isPrivate: boolean;
  isMember: boolean;
}

export class SlackClient {
  constructor(private readonly token: string) {}

  async call<T extends { ok: boolean; error?: string; needed?: string }>(method: string, body: Record<string, unknown>): Promise<T> {
    // Form encoding works for every Web API method (JSON bodies don't for some read methods).
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(body)) if (v !== undefined) form.set(k, String(v));
    let res: Response;
    try {
      res = await fetch(`${apiBase()}/${method}`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.token}`, "content-type": "application/x-www-form-urlencoded" },
        body: form,
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      throw new SlackError(`Couldn't reach Slack: ${err instanceof Error ? err.message : String(err)}`, "network", true);
    }
    if (res.status === 429) throw new SlackError("Slack is rate limiting requests; try again shortly.", "ratelimited", true);
    if (res.status >= 500) throw new SlackError(`Slack is unavailable (HTTP ${res.status})`, "unavailable", true);
    const json = (await res.json().catch(() => ({ ok: false, error: `http_${res.status}` }))) as T;
    if (!json.ok) {
      const code = json.error ?? "unknown_error";
      const msg = MESSAGES[code] ?? `Slack error: ${code}`;
      throw new SlackError(code === "missing_scope" && json.needed ? `${msg} (needs ${json.needed})` : msg, code);
    }
    return json;
  }

  async authTest(): Promise<{ teamId: string; team: string; botUser: string | null; url: string | null }> {
    const r = await this.call<{ ok: boolean; team_id?: string; team?: string; user?: string; url?: string }>("auth.test", {});
    return { teamId: String(r.team_id ?? ""), team: String(r.team ?? "Slack"), botUser: r.user ?? null, url: r.url ?? null };
  }

  async channels(): Promise<SlackChannel[]> {
    const out: SlackChannel[] = [];
    let cursor: string | undefined;
    do {
      const r = await this.call<{
        ok: boolean;
        channels?: { id: string; name: string; is_private?: boolean; is_member?: boolean }[];
        response_metadata?: { next_cursor?: string };
      }>("conversations.list", {
        types: "public_channel,private_channel",
        exclude_archived: true,
        limit: 200,
        ...(cursor ? { cursor } : {}),
      });
      for (const c of r.channels ?? []) out.push({ id: c.id, name: c.name, isPrivate: Boolean(c.is_private), isMember: Boolean(c.is_member) });
      cursor = r.response_metadata?.next_cursor || undefined;
    } while (cursor && out.length < 5_000);
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async postMessage(channel: string, text: string): Promise<{ channel: string; ts: string }> {
    const r = await this.call<{ ok: boolean; channel?: string; ts?: string }>("chat.postMessage", { channel, text, unfurl_links: false });
    return { channel: String(r.channel ?? channel), ts: String(r.ts ?? "") };
  }
}
