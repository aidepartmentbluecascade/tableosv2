import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { request, type FieldDto, type FilterAst, type TableDto } from "../../lib/api.ts";
import { integrationsApi } from "../../lib/api-areas/integrations.ts";
import { errorMessage } from "../../app/toast.tsx";
import { confirmDisconnect, ConnectGmailButton, ConnectTokenForm, connectionsOf, useConnections, useDisconnect } from "../connectors/connect.tsx";
import type {
  ActionConfig,
  AutomationAction,
  BranchCondition,
  ScheduleConfig,
  Trigger,
  TriggerConfig,
} from "../../lib/api-areas/automations.ts";
import { FilterGroupEditor } from "../views/FilterBuilder.tsx";
import type { FilterGroup } from "../views/view-utils.ts";
import { TokenInput, TokenMenu, tokenToScript } from "./TokenInput.tsx";
import {
  ACTIONS,
  WEEKDAYS,
  actionInfo,
  availableTokens,
  defaultAction,
  triggerInfo,
  writableFields,
  type TokenOption,
} from "./catalog.ts";
import styles from "./automations.module.css";

function asGroup(f: FilterAst | null | undefined): FilterGroup {
  if (!f) return { kind: "and", children: [] } as FilterGroup;
  if (f.kind === "condition") return { kind: "and", children: [f] } as FilterGroup;
  return f as FilterGroup;
}

/** Values that hold a record ID (`….id` tokens, or fields such as "Record ID"). */
function isRecordIdToken(t: TokenOption): boolean {
  return /\.id\}\}$/.test(t.token) || /\bID\b/.test(t.label);
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className={styles.field}>
      <span className={styles.fieldLabel}>{label}</span>
      {children}
      {hint ? <span className={styles.hint}>{hint}</span> : null}
    </label>
  );
}

function TableSelect({
  tables,
  value,
  onChange,
}: {
  tables: TableDto[];
  value: string | undefined;
  onChange: (id: string) => void;
}) {
  return (
    <select className={styles.select} value={value ?? ""} onChange={(e) => onChange(e.target.value)}>
      <option value="" disabled>
        Choose a table
      </option>
      {tables.map((t) => (
        <option key={t.id} value={t.id}>
          {t.name}
        </option>
      ))}
    </select>
  );
}

// ---------------------------------------------------------------------------
// Trigger
// ---------------------------------------------------------------------------

export function TriggerEditor({
  baseId,
  trigger,
  tables,
  webhookUrl,
  onChange,
  onRotateWebhook,
}: {
  baseId: string;
  trigger: Trigger;
  tables: TableDto[];
  webhookUrl: string | null | undefined;
  onChange: (t: Trigger) => void;
  onRotateWebhook: () => void;
}) {
  const info = triggerInfo(trigger.type);
  const cfg: TriggerConfig = trigger.config ?? {};
  const table = tables.find((t) => t.id === cfg.tableId);
  const set = (patch: Partial<TriggerConfig>) => onChange({ ...trigger, config: { ...cfg, ...patch } });
  const schedule: ScheduleConfig = cfg.schedule ?? { interval: "daily", time: "09:00" };
  const setSchedule = (patch: Partial<ScheduleConfig>) => set({ schedule: { ...schedule, ...patch } });
  const [copied, setCopied] = useState(false);

  return (
    <div className={styles.editor}>
      <p className={styles.editorIntro}>{info?.description}</p>
      {info?.needsTable ? (
        <Field label="Table">
          <TableSelect
            tables={tables}
            value={cfg.tableId}
            onChange={(id) => onChange({ ...trigger, config: { tableId: id } })}
          />
        </Field>
      ) : null}

      {trigger.type === "record.updated" && table ? (
        <Field label="Fields to watch" hint="Leave empty to run when any field changes.">
          <div className={styles.checkList}>
            {table.fields.map((f) => {
              const on = (cfg.fieldIds ?? []).includes(f.id);
              return (
                <label key={f.id} className={styles.checkItem}>
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() =>
                      set({
                        fieldIds: on
                          ? (cfg.fieldIds ?? []).filter((x) => x !== f.id)
                          : [...(cfg.fieldIds ?? []), f.id],
                      })
                    }
                  />
                  {f.name}
                </label>
              );
            })}
          </div>
        </Field>
      ) : null}

      {trigger.type === "record.matches_conditions" && table ? (
        <Field label="Conditions" hint="Runs once each time a record changes from not matching to matching.">
          <div className={styles.filterBox}>
            <FilterGroupEditor
              baseId={baseId}
              fields={table.fields}
              group={asGroup(cfg.filter)}
              onChange={(g) => set({ filter: g as FilterAst })}
            />
          </div>
        </Field>
      ) : null}

      {(trigger.type === "record.enters_view" || trigger.type === "form.submitted") && table ? (
        <Field label={trigger.type === "form.submitted" ? "Form" : "View"}>
          <select className={styles.select} value={cfg.viewId ?? ""} onChange={(e) => set({ viewId: e.target.value })}>
            <option value="">{trigger.type === "form.submitted" ? "Any form" : "Choose a view"}</option>
            {table.views
              .filter((v) => (trigger.type === "form.submitted" ? v.type === "form" : v.type !== "form"))
              .map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
          </select>
        </Field>
      ) : null}

      {trigger.type === "button.clicked" && table ? (
        <Field label="Button field" hint="Set the button field's action to “Run automation” and pick this automation.">
          <select className={styles.select} value={cfg.fieldId ?? ""} onChange={(e) => set({ fieldId: e.target.value })}>
            <option value="">Any button field</option>
            {table.fields
              .filter((f) => f.type === "button")
              .map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
          </select>
        </Field>
      ) : null}

      {trigger.type === "scheduled" ? (
        <>
          <Field label="Repeat">
            <select
              className={styles.select}
              value={schedule.interval}
              onChange={(e) => setSchedule({ interval: e.target.value as ScheduleConfig["interval"] })}
            >
              <option value="minutes">Every few minutes</option>
              <option value="hourly">Every hour</option>
              <option value="daily">Every day</option>
              <option value="weekly">Every week</option>
            </select>
          </Field>
          {schedule.interval === "minutes" ? (
            <Field label="Every (minutes)">
              <input
                className={styles.input}
                type="number"
                min={1}
                max={1440}
                value={schedule.every ?? 15}
                onChange={(e) => setSchedule({ every: Math.max(1, Number(e.target.value) || 1) })}
              />
            </Field>
          ) : null}
          {schedule.interval === "hourly" ? (
            <Field label="At minute">
              <input
                className={styles.input}
                type="number"
                min={0}
                max={59}
                value={schedule.minute ?? 0}
                onChange={(e) => setSchedule({ minute: Math.min(59, Math.max(0, Number(e.target.value) || 0)) })}
              />
            </Field>
          ) : null}
          {schedule.interval === "weekly" ? (
            <Field label="Day">
              <select
                className={styles.select}
                value={schedule.weekday ?? 1}
                onChange={(e) => setSchedule({ weekday: Number(e.target.value) })}
              >
                {WEEKDAYS.map((d, i) => (
                  <option key={d} value={i}>
                    {d}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}
          {schedule.interval === "daily" || schedule.interval === "weekly" ? (
            <div className={styles.row2}>
              <Field label="Time">
                <input
                  className={styles.input}
                  type="time"
                  value={schedule.time ?? "09:00"}
                  onChange={(e) => setSchedule({ time: e.target.value || "09:00" })}
                />
              </Field>
              <Field label="Time zone">
                <input
                  className={styles.input}
                  value={schedule.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone}
                  onChange={(e) => setSchedule({ timeZone: e.target.value })}
                />
              </Field>
            </div>
          ) : null}
        </>
      ) : null}

      {trigger.type === "webhook.received" ? (
        <Field label="Webhook URL" hint="Send an HTTP POST with a JSON body. Use {{trigger.body.<key>}} in actions.">
          {webhookUrl ? (
            <div className={styles.copyRow}>
              <code className={styles.code}>{webhookUrl}</code>
              <button
                type="button"
                className={styles.btnSecondary}
                onClick={() => {
                  void navigator.clipboard?.writeText(webhookUrl).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  });
                }}
              >
                {copied ? "Copied" : "Copy"}
              </button>
              <button type="button" className={styles.btnSecondary} onClick={onRotateWebhook}>
                Regenerate
              </button>
            </div>
          ) : (
            <span className={styles.muted}>Saving… the URL appears in a moment.</span>
          )}
        </Field>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function FieldMappingEditor({
  table,
  fields,
  tokens,
  onChange,
}: {
  table: TableDto;
  fields: Record<string, unknown>;
  tokens: TokenOption[];
  onChange: (f: Record<string, unknown>) => void;
}) {
  const writable = writableFields(table.fields);
  const used = Object.keys(fields);
  const remaining = writable.filter((f) => !used.includes(f.id));
  const fieldById = new Map<string, FieldDto>(table.fields.map((f) => [f.id, f]));
  return (
    <div className={styles.mapping}>
      {used.length === 0 ? <p className={styles.muted}>No fields yet. Add the fields to set.</p> : null}
      {used.map((fid) => {
        const f = fieldById.get(fid);
        const val = fields[fid];
        return (
          <div key={fid} className={styles.mappingRow}>
            <div className={styles.mappingHead}>
              <span className={styles.fieldLabel}>{f?.name ?? "Deleted field"}</span>
              <button
                type="button"
                className={styles.linkBtn}
                onClick={() => {
                  const next = { ...fields };
                  delete next[fid];
                  onChange(next);
                }}
              >
                Remove
              </button>
            </div>
            {f?.type === "checkbox" ? (
              <select
                className={styles.select}
                value={val === true || val === "true" ? "true" : "false"}
                onChange={(e) => onChange({ ...fields, [fid]: e.target.value === "true" })}
              >
                <option value="true">Checked</option>
                <option value="false">Unchecked</option>
              </select>
            ) : f?.type === "single_select" && Array.isArray((f.config as { options?: unknown[] })?.options) ? (
              <SelectOrToken field={f} value={val} tokens={tokens} onChange={(v) => onChange({ ...fields, [fid]: v })} />
            ) : (
              <TokenInput
                value={typeof val === "string" ? val : val === null || val === undefined ? "" : JSON.stringify(val)}
                onChange={(v) => onChange({ ...fields, [fid]: v })}
                tokens={tokens}
                multiline={f?.type === "long_text"}
                placeholder={f?.type === "link" || f?.type === "collaborator" ? "Comma-separated ids or a token" : "Value or token"}
                ariaLabel={f?.name ?? "value"}
              />
            )}
          </div>
        );
      })}
      {remaining.length > 0 ? (
        <select
          className={styles.select}
          value=""
          onChange={(e) => e.target.value && onChange({ ...fields, [e.target.value]: "" })}
          aria-label="Add field"
        >
          <option value="">+ Choose field</option>
          {remaining.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
      ) : null}
    </div>
  );
}

function SelectOrToken({
  field,
  value,
  tokens,
  onChange,
}: {
  field: FieldDto;
  value: unknown;
  tokens: TokenOption[];
  onChange: (v: string) => void;
}) {
  const options = ((field.config as { options?: { id?: string; label?: string }[] }).options ?? []).map((o) => ({
    value: o.id ?? o.label ?? "",
    label: o.label ?? o.id ?? "",
  }));
  const str = typeof value === "string" ? value : "";
  const isToken = str.includes("{{") || (str !== "" && !options.some((o) => o.value === str));
  const [tokenMode, setTokenMode] = useState(isToken);
  if (tokenMode) {
    return (
      <div className={styles.inlineRow}>
        <TokenInput value={str} onChange={onChange} tokens={tokens} ariaLabel={field.name} />
        <button type="button" className={styles.linkBtn} onClick={() => setTokenMode(false)}>
          Pick option
        </button>
      </div>
    );
  }
  return (
    <div className={styles.inlineRow}>
      <select className={styles.select} value={str} onChange={(e) => onChange(e.target.value)}>
        <option value="">(empty)</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <button type="button" className={styles.linkBtn} onClick={() => setTokenMode(true)}>
        Use dynamic value
      </button>
    </div>
  );
}

interface Collaborator {
  id: string;
  name: string;
  email: string;
}

function RecipientPicker({
  baseId,
  value,
  onChange,
}: {
  baseId: string;
  value: string[];
  onChange: (ids: string[]) => void;
}) {
  const q = useQuery({
    queryKey: ["collaborators", baseId],
    queryFn: () => request<{ collaborators: Collaborator[] }>(`/v1/bases/${baseId}/collaborators`),
    retry: false,
  });
  const people = q.data?.collaborators ?? [];
  return (
    <div className={styles.checkList}>
      {q.isLoading ? <span className={styles.muted}>Loading collaborators…</span> : null}
      {q.isError ? <span className={styles.muted}>Collaborators are unavailable.</span> : null}
      {people.map((p) => {
        const on = value.includes(p.id);
        return (
          <label key={p.id} className={styles.checkItem}>
            <input
              type="checkbox"
              checked={on}
              onChange={() => onChange(on ? value.filter((x) => x !== p.id) : [...value, p.id])}
            />
            <span className={styles.checkText}>
              <span>{p.name}</span>
              <span className={styles.muted}>{p.email}</span>
            </span>
          </label>
        );
      })}
    </div>
  );
}

/** One of the editor's own Gmail / Slack connections (automations run with the accounts of whoever last edited them). */
function ConnectionPicker({
  provider,
  value,
  returnTo,
  onChange,
}: {
  provider: "gmail" | "slack";
  value: string;
  /** Where Google sends the user back to after "Sign in with Google". */
  returnTo: string;
  onChange: (id: string) => void;
}) {
  const conns = useConnections();
  const disconnect = useDisconnect();
  const [adding, setAdding] = useState(false);
  const list = connectionsOf(conns.data?.connections, provider);
  const name = provider === "gmail" ? "Gmail" : "Slack";
  const label = provider === "gmail" ? "Gmail account" : "Slack account";
  useEffect(() => {
    if (!value && list[0]) onChange(list[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conns.data, value]);
  if (conns.isLoading) return <p className={styles.muted}>Loading your {name} accounts…</p>;
  const missing = Boolean(value) && !list.some((c) => c.id === value);
  const current = list.find((c) => c.id === value);
  const connectForm =
    provider === "gmail" ? (
      <div className={styles.connectInline}>
        <ConnectGmailButton available={conns.data?.providers.gmail.available ?? false} returnTo={returnTo} />
        {adding ? (
          <button type="button" className={styles.linkBtn} onClick={() => setAdding(false)}>
            Cancel
          </button>
        ) : null}
      </div>
    ) : (
      <ConnectTokenForm
        provider="slack"
        onConnected={(c) => {
          setAdding(false);
          onChange(c.id);
        }}
        {...(adding ? { onCancel: () => setAdding(false) } : {})}
      />
    );
  return (
    <div className={styles.field}>
      <span className={styles.fieldLabel}>{label}</span>
      {list.length ? (
        <div className={styles.connectInline}>
          <select
            className={styles.select}
            value={missing ? "__other" : value}
            onChange={(e) => {
              if (e.target.value === "__new") setAdding(true);
              else onChange(e.target.value);
            }}
            aria-label={label}
          >
            {missing ? <option value="__other">Someone else's account (pick one of yours)</option> : null}
            {list.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.accountLabel && c.accountLabel !== c.name ? ` (${c.accountLabel})` : ""}
              </option>
            ))}
            <option value="__new">+ Connect another {name} account…</option>
          </select>
          {current ? (
            <button
              type="button"
              className={styles.linkBtn}
              disabled={disconnect.isPending}
              onClick={() => {
                if (confirmDisconnect(current)) disconnect.mutate(current, { onSuccess: () => onChange("") });
              }}
            >
              Disconnect
            </button>
          ) : null}
        </div>
      ) : null}
      {!list.length || adding ? connectForm : null}
      {missing ? (
        <span className={styles.hint}>Automations run with the accounts of the person who last edited them, so this step needs one of your accounts.</span>
      ) : null}
    </div>
  );
}

function SlackChannelPicker({ connectionId, value, onChange }: { connectionId: string; value: string; onChange: (id: string, name: string) => void }) {
  const channels = useQuery({
    queryKey: ["slack-channels", connectionId],
    queryFn: () => integrationsApi.slackChannels(connectionId),
    retry: false,
    staleTime: 60_000,
  });
  const list = channels.data?.channels ?? [];
  const custom = Boolean(value) && channels.isSuccess && !list.some((c) => c.id === value);
  return (
    <div className={styles.field}>
      <span className={styles.fieldLabel}>Channel</span>
      {channels.isLoading ? <span className={styles.hint}>Loading channels…</span> : null}
      {channels.isError ? <span className={styles.hint}>{errorMessage(channels.error)}</span> : null}
      {channels.isSuccess ? (
        <select
          className={styles.select}
          value={custom ? "__custom" : value}
          aria-label="Slack channel"
          onChange={(e) => {
            if (e.target.value === "__custom") onChange("#", "");
            else onChange(e.target.value, list.find((c) => c.id === e.target.value)?.name ?? "");
          }}
        >
          <option value="">Choose a channel…</option>
          {list.map((c) => (
            <option key={c.id} value={c.id}>
              {c.isPrivate ? "🔒 " : "#"}
              {c.name}
              {c.isMember ? "" : " (bot not in channel)"}
            </option>
          ))}
          <option value="__custom">Other (channel name or ID)…</option>
        </select>
      ) : null}
      {custom || channels.isError ? (
        <input
          className={styles.input}
          value={value}
          placeholder="#general or C0123456789"
          aria-label="Channel name or ID"
          onChange={(e) => onChange(e.target.value, e.target.value.replace(/^#/, ""))}
        />
      ) : null}
      {value && !custom && list.find((c) => c.id === value && !c.isMember && c.isPrivate) ? (
        <span className={styles.hint}>Invite the bot to this private channel in Slack (/invite @your-app) or posting fails.</span>
      ) : null}
    </div>
  );
}

export function ActionEditor({
  baseId,
  returnTo,
  action,
  index,
  allActions,
  trigger,
  tables,
  onChange,
}: {
  baseId: string;
  /** App URL that reopens this step (used after "Sign in with Google"). */
  returnTo: string;
  action: AutomationAction;
  /** Index among top-level actions (for token availability). */
  index: number;
  allActions: AutomationAction[];
  trigger: Trigger;
  tables: TableDto[];
  onChange: (a: AutomationAction) => void;
}) {
  const cfg = action.config;
  const set = (patch: Partial<ActionConfig>) => onChange({ ...action, config: { ...cfg, ...patch } });
  const tokens = availableTokens(trigger, allActions, index, tables);
  const table = tables.find((t) => t.id === cfg.tableId);
  const triggerTable = tables.find((t) => t.id === trigger.config?.tableId);

  return (
    <div className={styles.editor}>
      <Field label="Step name">
        <input
          className={styles.input}
          value={action.name ?? ""}
          placeholder={actionInfo(action.type)?.label}
          onChange={(e) => onChange({ ...action, name: e.target.value })}
        />
      </Field>

      {["update_record", "create_record", "find_records", "delete_record"].includes(action.type) ? (
        <Field label="Table">
          <TableSelect
            tables={tables}
            value={cfg.tableId}
            onChange={(id) => set({ tableId: id, fields: {}, ...(action.type === "find_records" ? { filter: { kind: "and", children: [] } } : {}) })}
          />
        </Field>
      ) : null}

      {action.type === "update_record" || action.type === "delete_record" ? (
        <Field label="Record ID" hint="Usually the trigger record's ID, or the first record ID from a Find records step.">
          <TokenInput value={cfg.recordId ?? ""} onChange={(v) => set({ recordId: v })} tokens={tokens} pickerFilter={isRecordIdToken} ariaLabel="Record ID" />
        </Field>
      ) : null}

      {(action.type === "update_record" || action.type === "create_record") && table ? (
        <Field label="Fields">
          <FieldMappingEditor table={table} fields={cfg.fields ?? {}} tokens={tokens} onChange={(fields) => set({ fields })} />
        </Field>
      ) : null}

      {action.type === "find_records" && table ? (
        <>
          <Field label="Conditions" hint="Values can include dynamic tokens.">
            <div className={styles.filterBox}>
              <FilterGroupEditor
                baseId={baseId}
                fields={table.fields}
                group={asGroup(cfg.filter)}
                onChange={(g) => set({ filter: g as FilterAst })}
              />
            </div>
          </Field>
          <Field label="Limit">
            <input
              className={styles.input}
              type="number"
              min={1}
              max={100}
              value={cfg.limit ?? 25}
              onChange={(e) => set({ limit: Math.min(100, Math.max(1, Number(e.target.value) || 1)) })}
            />
          </Field>
        </>
      ) : null}

      {action.type === "notify" ? (
        <>
          <Field label="Recipients">
            <RecipientPicker baseId={baseId} value={cfg.userIds ?? []} onChange={(userIds) => set({ userIds })} />
          </Field>
          {triggerTable ? (
            <Field label="…or people in a collaborator field">
              <select
                className={styles.select}
                value={cfg.collaboratorFieldId ?? ""}
                onChange={(e) => set({ collaboratorFieldId: e.target.value || undefined })}
              >
                <option value="">None</option>
                {triggerTable.fields
                  .filter((f) => f.type === "collaborator")
                  .map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
              </select>
            </Field>
          ) : null}
          <Field label="Title">
            <TokenInput value={cfg.title ?? ""} onChange={(v) => set({ title: v })} tokens={tokens} ariaLabel="Title" />
          </Field>
          <Field label="Message">
            <TokenInput value={cfg.message ?? ""} onChange={(v) => set({ message: v })} tokens={tokens} multiline ariaLabel="Message" />
          </Field>
        </>
      ) : null}

      {action.type === "send_email" ? (
        <>
          <Field label="To" hint="Separate addresses with commas.">
            <TokenInput value={cfg.to ?? ""} onChange={(v) => set({ to: v })} tokens={tokens} ariaLabel="To" />
          </Field>
          <Field label="Cc">
            <TokenInput value={cfg.cc ?? ""} onChange={(v) => set({ cc: v })} tokens={tokens} ariaLabel="Cc" />
          </Field>
          <Field label="Subject">
            <TokenInput value={cfg.subject ?? ""} onChange={(v) => set({ subject: v })} tokens={tokens} ariaLabel="Subject" />
          </Field>
          <Field label="Message">
            <TokenInput value={cfg.body ?? ""} onChange={(v) => set({ body: v })} tokens={tokens} multiline ariaLabel="Message" />
          </Field>
        </>
      ) : null}

      {action.type === "gmail_send" ? (
        <>
          <ConnectionPicker provider="gmail" value={cfg.connectionId ?? ""} returnTo={returnTo} onChange={(connectionId) => set({ connectionId })} />
          <Field label="To" hint="Separate addresses with commas.">
            <TokenInput value={cfg.to ?? ""} onChange={(v) => set({ to: v })} tokens={tokens} ariaLabel="To" />
          </Field>
          <div className={styles.row2}>
            <Field label="Cc">
              <TokenInput value={cfg.cc ?? ""} onChange={(v) => set({ cc: v })} tokens={tokens} ariaLabel="Cc" />
            </Field>
            <Field label="Bcc">
              <TokenInput value={cfg.bcc ?? ""} onChange={(v) => set({ bcc: v })} tokens={tokens} ariaLabel="Bcc" />
            </Field>
          </div>
          <Field label="Subject">
            <TokenInput value={cfg.subject ?? ""} onChange={(v) => set({ subject: v })} tokens={tokens} ariaLabel="Subject" />
          </Field>
          <Field label="Message" hint="Sent as plain text from your Gmail address; it appears in your Sent folder.">
            <TokenInput value={cfg.body ?? ""} onChange={(v) => set({ body: v })} tokens={tokens} multiline ariaLabel="Message" />
          </Field>
        </>
      ) : null}

      {action.type === "slack_message" ? (
        <>
          <ConnectionPicker
            provider="slack"
            value={cfg.connectionId ?? ""}
            returnTo={returnTo}
            onChange={(connectionId) => set({ connectionId, channel: "", channelName: "" })}
          />
          {cfg.connectionId ? (
            <SlackChannelPicker
              connectionId={cfg.connectionId}
              value={cfg.channel ?? ""}
              onChange={(channel, channelName) => set({ channel, channelName })}
            />
          ) : null}
          <Field label="Message" hint="Slack formatting works: *bold*, _italic_, <https://example.com|links>.">
            <TokenInput value={cfg.text ?? ""} onChange={(v) => set({ text: v })} tokens={tokens} multiline ariaLabel="Slack message" />
          </Field>
        </>
      ) : null}

      {action.type === "webhook" ? (
        <>
          <div className={styles.row2}>
            <Field label="Method">
              <select className={styles.select} value={cfg.method ?? "POST"} onChange={(e) => set({ method: e.target.value as ActionConfig["method"] })}>
                {["POST", "PUT", "PATCH", "GET"].map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
            </Field>
            <Field label="Timeout (ms)">
              <input
                className={styles.input}
                type="number"
                min={500}
                max={30000}
                value={cfg.timeoutMs ?? 10000}
                onChange={(e) => set({ timeoutMs: Math.min(30000, Math.max(500, Number(e.target.value) || 10000)) })}
              />
            </Field>
          </div>
          <Field label="URL" hint="Private and internal network addresses are blocked.">
            <TokenInput value={cfg.url ?? ""} onChange={(v) => set({ url: v })} tokens={tokens} placeholder="https://example.com/hook" ariaLabel="URL" />
          </Field>
          <Field label="JSON body" hint="Leave empty to send the trigger and step data as JSON.">
            <TokenInput value={cfg.body ?? ""} onChange={(v) => set({ body: v })} tokens={tokens} multiline ariaLabel="Body" />
          </Field>
        </>
      ) : null}

      {action.type === "script" ? (
        <ScriptEditor value={cfg.script ?? ""} onChange={(script) => set({ script })} tables={tables} tokens={tokens} />
      ) : null}

      {action.type === "condition" ? (
        <ConditionEditor
          baseId={baseId}
          returnTo={returnTo}
          action={action}
          index={index}
          allActions={allActions}
          trigger={trigger}
          tables={tables}
          tokens={tokens}
          onChange={onChange}
        />
      ) : null}
    </div>
  );
}

function ScriptEditor({
  value,
  onChange,
  tables,
  tokens,
}: {
  value: string;
  onChange: (v: string) => void;
  tables: TableDto[];
  tokens: TokenOption[];
}) {
  const [picking, setPicking] = useState(false);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const insertValue = (token: string) => {
    setPicking(false);
    const el = areaRef.current;
    const s = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    const js = tokenToScript(token);
    onChange(`${value.slice(0, s)}${js}${value.slice(end)}`);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(s + js.length, s + js.length);
    });
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Tab" || e.shiftKey) return;
    e.preventDefault();
    const el = e.currentTarget;
    const { selectionStart: s, selectionEnd: end } = el;
    onChange(`${value.slice(0, s)}  ${value.slice(end)}`);
    requestAnimationFrame(() => el.setSelectionRange(s + 2, s + 2));
  };
  return (
    <>
      <div className={`${styles.tokenWrap} ${styles.scriptBar}`}>
        <span className={styles.muted}>Use values from the trigger or earlier steps:</span>
        <button type="button" className={styles.linkBtn} onClick={() => setPicking((p) => !p)}>
          + Insert value
        </button>
        {picking ? <TokenMenu tokens={tokens} onPick={insertValue} onClose={() => setPicking(false)} /> : null}
      </div>
      <Field label="Script (JavaScript)" hint="Runs in a secure sandbox as the automation's owner. Use Test to see console output in the run history.">
        <textarea
          ref={areaRef}
          className={`${styles.textarea} ${styles.scriptInput}`}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          spellCheck={false}
          rows={18}
          aria-label="Script"
        />
      </Field>
      <details className={styles.scriptRef}>
        <summary>Script reference</summary>
        <ul>
          <li><code>input.config()</code>: <code>trigger</code> (with <code>trigger.record.fields</code> as text and <code>trigger.record.raw</code> as values), <code>steps</code>, <code>base</code>, <code>now</code>.</li>
          <li>
            <code>{"{{…}}"}</code> tokens aren't replaced inside code. Use <b>+ Insert value</b>: <code>{"{{trigger.record.fields.Email}}"}</code> becomes{" "}
            <code>{'input.config().trigger.record.fields["Email"]'}</code>.
          </li>
          <li><code>output.set(key, value)</code>: later steps can use <code>{"{{steps.<this step>.<key>}}"}</code>.</li>
          <li><code>await base.findRecords(table, {"{ view, limit, filter }"})</code> returns up to 500 records.</li>
          <li><code>await base.getRecord(table, id)</code>, <code>createRecord(table, fields)</code>, <code>updateRecord(table, id, fields)</code>, <code>deleteRecord(table, id)</code>.</li>
          <li><code>await fetch(url, {"{ method, headers, body }"})</code> to public addresses; <code>res.json()</code> / <code>res.text()</code>.</li>
          <li>Limits: 30 s per run, 2 s of computing without an <code>await</code>, 100 base/fetch calls, 20 fetches.</li>
        </ul>
        {tables.length ? (
          <>
            <p className={styles.muted}>Tables and fields in this base:</p>
            <ul>
              {tables.map((t) => (
                <li key={t.id}>
                  <code>{t.name}</code>: {t.fields.map((f) => f.name).join(", ")}
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </details>
    </>
  );
}

const COND_OPS: { op: BranchCondition["op"]; label: string; unary?: boolean }[] = [
  { op: "eq", label: "is" },
  { op: "neq", label: "is not" },
  { op: "contains", label: "contains" },
  { op: "notContains", label: "does not contain" },
  { op: "empty", label: "is empty", unary: true },
  { op: "notEmpty", label: "is not empty", unary: true },
  { op: "gt", label: ">" },
  { op: "gte", label: "≥" },
  { op: "lt", label: "<" },
  { op: "lte", label: "≤" },
];

function ConditionEditor({
  baseId,
  returnTo,
  action,
  index,
  allActions,
  trigger,
  tables,
  tokens,
  onChange,
}: {
  baseId: string;
  returnTo: string;
  action: AutomationAction;
  index: number;
  allActions: AutomationAction[];
  trigger: Trigger;
  tables: TableDto[];
  tokens: TokenOption[];
  onChange: (a: AutomationAction) => void;
}) {
  const cfg = action.config;
  const conds = cfg.conditions ?? [];
  const set = (patch: Partial<ActionConfig>) => onChange({ ...action, config: { ...cfg, ...patch } });
  const setCond = (i: number, c: BranchCondition | null) => {
    const next = [...conds];
    if (c === null) next.splice(i, 1);
    else next[i] = c;
    set({ conditions: next });
  };
  return (
    <>
      <Field label="Only continue if">
        <div className={styles.condList}>
          <select className={styles.selectCompact} value={cfg.match ?? "all"} onChange={(e) => set({ match: e.target.value as "all" | "any" })}>
            <option value="all">all conditions are true</option>
            <option value="any">any condition is true</option>
          </select>
          {conds.map((c, i) => {
            const unary = COND_OPS.find((o) => o.op === c.op)?.unary;
            return (
              <div key={i} className={styles.condRow}>
                <div className={styles.condRowHead}>
                  <span className={styles.muted}>{i === 0 ? "Where" : cfg.match === "any" ? "Or" : "And"}</span>
                  <button type="button" className={styles.iconBtn} aria-label="Remove condition" onClick={() => setCond(i, null)}>
                    ×
                  </button>
                </div>
                <TokenInput value={c.left} onChange={(v) => setCond(i, { ...c, left: v })} tokens={tokens} placeholder="Value — use + to pick a field" ariaLabel="Left value" />
                <div className={styles.condRowOp}>
                  <select className={styles.selectCompact} value={c.op} onChange={(e) => setCond(i, { ...c, op: e.target.value as BranchCondition["op"] })}>
                    {COND_OPS.map((o) => (
                      <option key={o.op} value={o.op}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  {unary ? null : <TokenInput value={c.right ?? ""} onChange={(v) => setCond(i, { ...c, right: v })} tokens={tokens} placeholder="Compare to" ariaLabel="Right value" />}
                </div>
              </div>
            );
          })}
          <button type="button" className={styles.linkBtn} onClick={() => set({ conditions: [...conds, { left: "", op: "eq", right: "" }] })}>
            + Add condition
          </button>
        </div>
      </Field>
      {(["then", "else"] as const).map((branch) => (
        <BranchActions
          key={branch}
          label={branch === "then" ? "If true, run" : "Otherwise, run"}
          baseId={baseId}
          returnTo={returnTo}
          actions={cfg[branch] ?? []}
          index={index}
          allActions={allActions}
          trigger={trigger}
          tables={tables}
          onChange={(list) => set({ [branch]: list })}
        />
      ))}
    </>
  );
}

function BranchActions({
  label,
  baseId,
  returnTo,
  actions,
  index,
  allActions,
  trigger,
  tables,
  onChange,
}: {
  label: string;
  baseId: string;
  returnTo: string;
  actions: AutomationAction[];
  index: number;
  allActions: AutomationAction[];
  trigger: Trigger;
  tables: TableDto[];
  onChange: (list: AutomationAction[]) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className={styles.branch}>
      <div className={styles.branchLabel}>{label}</div>
      {actions.length === 0 ? <p className={styles.muted}>No actions.</p> : null}
      {actions.map((a, i) => (
        <div key={a.id} className={styles.branchItem}>
          <div className={styles.branchHead}>
            <button type="button" className={styles.branchTitle} onClick={() => setOpen(open === a.id ? null : a.id)}>
              <span aria-hidden>{actionInfo(a.type)?.icon}</span> {a.name || actionInfo(a.type)?.label}
            </button>
            <button
              type="button"
              className={styles.iconBtn}
              aria-label="Remove action"
              onClick={() => onChange(actions.filter((_, j) => j !== i))}
            >
              ×
            </button>
          </div>
          {open === a.id ? (
            <ActionEditor
              baseId={baseId}
              returnTo={returnTo}
              action={a}
              index={index}
              allActions={allActions}
              trigger={trigger}
              tables={tables}
              onChange={(next) => onChange(actions.map((x, j) => (j === i ? next : x)))}
            />
          ) : null}
        </div>
      ))}
      <select
        className={styles.selectCompact}
        value=""
        aria-label="Add action to branch"
        onChange={(e) => {
          const type = e.target.value as AutomationAction["type"];
          if (!type) return;
          const next = defaultAction(type, trigger.config?.tableId);
          onChange([...actions, next]);
          setOpen(next.id);
        }}
      >
        <option value="">+ Add action</option>
        {ACTIONS.filter((x) => x.type !== "condition").map((x) => (
          <option key={x.type} value={x.type}>
            {x.label}
          </option>
        ))}
      </select>
    </div>
  );
}
