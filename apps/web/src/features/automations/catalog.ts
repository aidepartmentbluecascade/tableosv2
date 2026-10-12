import type { ActionType, AutomationAction, Trigger, TriggerType } from "../../lib/api-areas/automations.ts";
import type { FieldDto, TableDto } from "../../lib/api.ts";

export interface TriggerInfo {
  type: TriggerType;
  label: string;
  description: string;
  icon: string;
  needsTable: boolean;
}

export const TRIGGERS: TriggerInfo[] = [
  { type: "record.created", label: "When a record is created", description: "Runs for every new record in a table.", icon: "＋", needsTable: true },
  { type: "record.updated", label: "When a record is updated", description: "Runs when a record changes, optionally only for specific fields.", icon: "✎", needsTable: true },
  { type: "record.matches_conditions", label: "When a record matches conditions", description: "Runs once each time a record starts matching your conditions.", icon: "◇", needsTable: true },
  { type: "record.enters_view", label: "When a record enters a view", description: "Runs when a record starts appearing in a view.", icon: "◎", needsTable: true },
  { type: "form.submitted", label: "When a form is submitted", description: "Runs when someone submits a form view.", icon: "☑", needsTable: true },
  { type: "scheduled", label: "At a scheduled time", description: "Runs on a repeating schedule.", icon: "◷", needsTable: false },
  { type: "button.clicked", label: "When a button is clicked", description: "Runs when someone clicks a button field.", icon: "▣", needsTable: true },
  { type: "webhook.received", label: "When a webhook is received", description: "Runs when an HTTP POST hits a unique URL.", icon: "⇥", needsTable: false },
];

export interface ActionInfo {
  type: ActionType;
  label: string;
  description: string;
  icon: string;
}

export const ACTIONS: ActionInfo[] = [
  { type: "update_record", label: "Update record", description: "Change field values on a record.", icon: "✎" },
  { type: "create_record", label: "Create record", description: "Add a new record to a table.", icon: "＋" },
  { type: "find_records", label: "Find records", description: "Look up records that match conditions.", icon: "⌕" },
  { type: "delete_record", label: "Delete record", description: "Delete a record.", icon: "⌫" },
  { type: "notify", label: "Send in-app notification", description: "Notify collaborators in TableOS.", icon: "◉" },
  { type: "send_email", label: "Send email", description: "Send an email to anyone.", icon: "✉" },
  { type: "gmail_send", label: "Send email via Gmail", description: "Send from your own Gmail address.", icon: "G" },
  { type: "slack_message", label: "Send Slack message", description: "Post a message to a Slack channel.", icon: "#" },
  { type: "webhook", label: "Send webhook", description: "POST JSON to an external URL.", icon: "⇢" },
  { type: "script", label: "Run a script", description: "Run custom JavaScript in a secure sandbox.", icon: "{}" },
  { type: "condition", label: "Conditional group", description: "Run actions only if conditions are met.", icon: "⑂" },
];

export function triggerInfo(type: string | undefined): TriggerInfo | undefined {
  return TRIGGERS.find((t) => t.type === type);
}

export function actionInfo(type: string | undefined): ActionInfo | undefined {
  return ACTIONS.find((a) => a.type === type);
}

export function newActionId(): string {
  return `a${Math.random().toString(36).slice(2, 10)}`;
}

export function defaultAction(type: ActionType, tableId: string | undefined): AutomationAction {
  const id = newActionId();
  switch (type) {
    case "update_record":
      return { id, type, config: { ...(tableId ? { tableId } : {}), recordId: "{{trigger.record.id}}", fields: {} } };
    case "create_record":
      return { id, type, config: { ...(tableId ? { tableId } : {}), fields: {} } };
    case "find_records":
      return { id, type, config: { ...(tableId ? { tableId } : {}), filter: { kind: "and", children: [] }, limit: 25 } };
    case "delete_record":
      return { id, type, config: { ...(tableId ? { tableId } : {}), recordId: "{{trigger.record.id}}" } };
    case "notify":
      return { id, type, config: { userIds: [], title: "", message: "" } };
    case "send_email":
      return { id, type, config: { to: "", subject: "", body: "" } };
    case "gmail_send":
      return { id, type, config: { connectionId: "", to: "", subject: "", body: "" } };
    case "slack_message":
      return { id, type, config: { connectionId: "", channel: "", text: "" } };
    case "webhook":
      return { id, type, config: { url: "", method: "POST", timeoutMs: 10000 } };
    case "script":
      return { id, type, config: { script: DEFAULT_SCRIPT } };
    case "condition":
      return { id, type, config: { match: "all", conditions: [{ left: "", op: "eq", right: "" }], then: [], else: [] } };
  }
}

export const DEFAULT_SCRIPT = `// The trigger record and the results of earlier steps
const { trigger, steps } = input.config();
console.log("Triggered by record", trigger.record?.id);

// Read and change records (tables and fields can be named)
// const tasks = await base.findRecords("Tasks", { limit: 50 });
// await base.updateRecord("Tasks", trigger.record.id, { Status: "Done" });

// Call an external API
// const res = await fetch("https://api.example.com/data");
// const data = await res.json();

// Make values available to later steps
output.set("result", "ok");
`;

/** Keys a script passes on with literal `output.set("key", …)` calls. */
export function scriptOutputKeys(script: string | undefined): string[] {
  const keys = new Set<string>();
  for (const line of (script ?? "").split("\n")) {
    if (line.trim().startsWith("//")) continue;
    for (const m of line.matchAll(/output\.set\(\s*(["'`])([^"'`]+)\1/g)) keys.add(m[2]!);
  }
  return [...keys];
}

/** Short human summary of an action for its card. */
/** `{{steps.x.first.fields.Name}}` → `[Name]` for one-line summaries. */
export function readableTokens(text: string): string {
  return text.replace(/\{\{([^{}]+)\}\}/g, (_m, path: string) => {
    const p = path.trim();
    const field = /\.fields\.(.+)$/.exec(p)?.[1];
    return `[${field ?? p.split(".").pop() ?? p}]`;
  });
}

export function summarizeAction(a: AutomationAction, tables: TableDto[]): string {
  return readableTokens(summarize(a, tables));
}

function summarize(a: AutomationAction, tables: TableDto[]): string {
  const t = tables.find((x) => x.id === a.config.tableId);
  switch (a.type) {
    case "update_record":
      return `Update ${Object.keys(a.config.fields ?? {}).length} field(s)${t ? ` in ${t.name}` : ""}`;
    case "create_record":
      return t ? `Create a record in ${t.name}` : "Choose a table";
    case "find_records":
      return t ? `Find records in ${t.name}` : "Choose a table";
    case "delete_record":
      return t ? `Delete a record in ${t.name}` : "Choose a table";
    case "notify":
      return a.config.title ? `Notify: ${a.config.title}` : "Choose recipients";
    case "send_email":
      return a.config.to ? `Email ${a.config.to}` : "Choose recipients";
    case "gmail_send":
      return !a.config.connectionId ? "Choose a Gmail account" : a.config.to ? `Gmail to ${a.config.to}` : "Choose recipients";
    case "slack_message":
      return !a.config.connectionId ? "Choose a Slack workspace" : a.config.channel ? `Post in #${(a.config.channelName ?? a.config.channel).replace(/^#/, "")}` : "Choose a channel";
    case "webhook":
      return a.config.url ? `${a.config.method ?? "POST"} ${a.config.url}` : "Enter a URL";
    case "script": {
      const lines = (a.config.script ?? "").split("\n").filter((l) => l.trim() && !l.trim().startsWith("//")).length;
      return lines ? `JavaScript, ${lines} line${lines === 1 ? "" : "s"}` : "Write a script";
    }
    case "condition":
      return `If ${a.config.conditions?.length ?? 0} condition(s) — ${a.config.then?.length ?? 0} action(s), else ${a.config.else?.length ?? 0}`;
  }
}

export function summarizeTrigger(trigger: Trigger | undefined, tables: TableDto[]): string {
  const info = triggerInfo(trigger?.type);
  if (!info) return "Choose a trigger";
  const t = tables.find((x) => x.id === trigger?.config?.tableId);
  if (trigger?.type === "scheduled") {
    const s = trigger.config?.schedule;
    if (!s) return info.label;
    if (s.interval === "minutes") return `Every ${s.every ?? 15} minutes`;
    if (s.interval === "hourly") return `Every hour at :${String(s.minute ?? 0).padStart(2, "0")}`;
    if (s.interval === "daily") return `Every day at ${s.time ?? "09:00"}`;
    return `Every ${WEEKDAYS[s.weekday ?? 1]} at ${s.time ?? "09:00"}`;
  }
  return t ? `${info.label} in ${t.name}` : info.label;
}

export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Fields an automation may write (no computed/read-only types). */
const READONLY = new Set([
  "formula",
  "lookup",
  "rollup",
  "count",
  "autonumber",
  "created_time",
  "modified_time",
  "created_by",
  "modified_by",
  "button",
]);
export function writableFields(fields: FieldDto[]): FieldDto[] {
  return fields.filter((f) => !READONLY.has(f.type));
}

export interface TokenOption {
  label: string;
  group: string;
  token: string;
}

/** Tokens available to an action at `index` (trigger + previous steps). */
export function availableTokens(
  trigger: Trigger | undefined,
  actions: AutomationAction[],
  index: number,
  tables: TableDto[],
): TokenOption[] {
  const out: TokenOption[] = [];
  const t = tables.find((x) => x.id === trigger?.config?.tableId);
  const info = triggerInfo(trigger?.type);
  if (info?.needsTable && t) {
    out.push({ group: "Trigger record", label: "Record ID", token: "{{trigger.record.id}}" });
    out.push({ group: "Trigger record", label: "Record URL", token: "{{trigger.record.url}}" });
    for (const f of t.fields) {
      out.push({ group: "Trigger record", label: f.name, token: `{{trigger.record.fields.${f.name}}}` });
    }
  }
  if (trigger?.type === "webhook.received") {
    out.push({ group: "Webhook", label: "Whole body (JSON)", token: "{{trigger.body}}" });
    out.push({ group: "Webhook", label: "body.<key>", token: "{{trigger.body.}}" });
  }
  if (trigger?.type === "scheduled") {
    out.push({ group: "Schedule", label: "Scheduled time", token: "{{trigger.scheduledAt}}" });
  }
  if (trigger?.type === "button.clicked") {
    out.push({ group: "Button", label: "Clicked by (name)", token: "{{trigger.user.name}}" });
    out.push({ group: "Button", label: "Clicked by (email)", token: "{{trigger.user.email}}" });
  }
  actions.slice(0, index).forEach((a, i) => {
    const group = `Step ${i + 1}: ${actionInfo(a.type)?.label ?? a.type}`;
    const at = tables.find((x) => x.id === a.config.tableId) ?? t;
    if (a.type === "create_record" || a.type === "update_record") {
      out.push({ group, label: "Record ID", token: `{{steps.${a.id}.record.id}}` });
      for (const f of at?.fields ?? []) out.push({ group, label: f.name, token: `{{steps.${a.id}.record.fields.${f.name}}}` });
    } else if (a.type === "find_records") {
      out.push({ group, label: "Number of records found", token: `{{steps.${a.id}.count}}` });
      out.push({ group, label: "Record IDs (list)", token: `{{steps.${a.id}.ids}}` });
      out.push({ group, label: "First record ID", token: `{{steps.${a.id}.first.id}}` });
      for (const f of at?.fields ?? []) out.push({ group, label: `First record: ${f.name}`, token: `{{steps.${a.id}.first.fields.${f.name}}}` });
    } else if (a.type === "gmail_send") {
      out.push({ group, label: "Gmail message ID", token: `{{steps.${a.id}.messageId}}` });
      out.push({ group, label: "Gmail thread ID", token: `{{steps.${a.id}.threadId}}` });
    } else if (a.type === "slack_message") {
      out.push({ group, label: "Slack message timestamp", token: `{{steps.${a.id}.ts}}` });
      out.push({ group, label: "Slack channel ID", token: `{{steps.${a.id}.channel}}` });
    } else if (a.type === "webhook") {
      out.push({ group, label: "Response status", token: `{{steps.${a.id}.status}}` });
      out.push({ group, label: "Response body", token: `{{steps.${a.id}.body}}` });
    } else if (a.type === "script") {
      for (const key of scriptOutputKeys(a.config.script)) out.push({ group, label: key, token: `{{steps.${a.id}.${key}}}` });
    }
  });
  out.push({ group: "Other", label: "Now (ISO time)", token: "{{now}}" });
  out.push({ group: "Other", label: "Today (date)", token: "{{today}}" });
  out.push({ group: "Other", label: "Automation name", token: "{{automation.name}}" });
  return out;
}
