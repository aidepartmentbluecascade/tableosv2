import { useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { automationsApi, type AutomationRun, type StepResult } from "../../lib/api-areas/automations.ts";
import { actionInfo, triggerInfo } from "./catalog.ts";
import styles from "./automations.module.css";

function statusClass(s: string): string {
  if (s === "succeeded") return styles.statusOk ?? "";
  if (s === "failed") return styles.statusFail ?? "";
  return styles.statusPending ?? "";
}

function statusLabel(s: string): string {
  return (
    { succeeded: "Succeeded", failed: "Failed", pending: "Pending", running: "Running", skipped: "Skipped" }[s] ?? s
  );
}

function fmtTime(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString();
}

function duration(run: AutomationRun): string {
  if (!run.startedAt || !run.finishedAt) return "";
  const ms = new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime();
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

type RecordCtx = { id: string; url?: string; tableName?: string; fields: Record<string, string> };

function isRecordCtx(v: unknown): v is RecordCtx {
  return !!v && typeof v === "object" && typeof (v as RecordCtx).id === "string" && !!(v as RecordCtx).fields && typeof (v as RecordCtx).fields === "object";
}

function scalar(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

function RecordCard({ rec }: { rec: RecordCtx }) {
  const [showEmpty, setShowEmpty] = useState(false);
  const entries = Object.entries(rec.fields);
  const filled = entries.filter(([, v]) => v !== "" && v !== null && v !== undefined);
  const shown = showEmpty ? entries : filled;
  return (
    <div className={styles.recordCard}>
      <div className={styles.recordHead}>
        <span>
          {rec.tableName ? <strong>{rec.tableName}</strong> : null} <code className={styles.recordId}>{rec.id}</code>
        </span>
        {rec.url ? (
          <a href={rec.url} target="_blank" rel="noreferrer">
            Open record
          </a>
        ) : null}
      </div>
      <dl className={styles.kv}>
        {shown.map(([k, v]) => (
          <div key={k} className={styles.kvRow}>
            <dt className={styles.kvKey}>{k}</dt>
            <dd className={styles.kvVal}>{scalar(v)}</dd>
          </div>
        ))}
      </dl>
      {entries.length > filled.length ? (
        <button type="button" className={styles.linkBtn} onClick={() => setShowEmpty((s) => !s)}>
          {showEmpty ? "Hide empty fields" : `Show ${entries.length - filled.length} empty field${entries.length - filled.length === 1 ? "" : "s"}`}
        </button>
      ) : null}
    </div>
  );
}

const MAX_RECORDS_SHOWN = 10;

/** A step's (or trigger's) output, readable: records as field lists, other values as key/value rows. */
function OutputView({ value }: { value: unknown }) {
  const obj = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  let body: ReactNode;
  if (obj && Array.isArray(obj.records)) {
    const recs = obj.records.filter(isRecordCtx);
    body = (
      <>
        <p className={styles.muted}>
          Found {recs.length} record{recs.length === 1 ? "" : "s"}
        </p>
        {recs.slice(0, MAX_RECORDS_SHOWN).map((r) => (
          <RecordCard key={r.id} rec={r} />
        ))}
        {recs.length > MAX_RECORDS_SHOWN ? <p className={styles.muted}>…and {recs.length - MAX_RECORDS_SHOWN} more</p> : null}
      </>
    );
  } else if (obj) {
    const rest = Object.entries(obj).filter(([, v]) => !isRecordCtx(v));
    body = (
      <>
        {Object.entries(obj)
          .filter(([, v]) => isRecordCtx(v))
          .map(([k, v]) => (
            <RecordCard key={k} rec={v as RecordCtx} />
          ))}
        {rest.length ? (
          <dl className={styles.kv}>
            {rest.map(([k, v]) => (
              <div key={k} className={styles.kvRow}>
                <dt className={styles.kvKey}>{k}</dt>
                <dd className={styles.kvVal}>{scalar(v)}</dd>
              </div>
            ))}
          </dl>
        ) : null}
      </>
    );
  } else {
    body = <p className={styles.kvVal}>{scalar(value)}</p>;
  }
  return (
    <div className={styles.outputView}>
      {body}
      <details className={styles.details}>
        <summary>Raw data (JSON)</summary>
        <pre className={styles.pre}>{JSON.stringify(value, null, 2)}</pre>
      </details>
    </div>
  );
}

function StepList({ steps, depth = 0 }: { steps: StepResult[]; depth?: number }) {
  return (
    <ol className={styles.stepList} style={{ marginLeft: depth * 16 }}>
      {steps.map((s) => (
        <li key={s.actionId + s.startedAt} className={styles.stepItem}>
          <div className={styles.stepHead}>
            <span className={`${styles.statusDot} ${statusClass(s.status)}`} aria-hidden />
            <strong>{s.name || actionInfo(s.type)?.label || s.type}</strong>
            <span className={styles.muted}>{statusLabel(s.status)}</span>
            {s.branch && s.branch !== "none" ? (
              <span className={styles.badge}>{s.branch === "then" ? "Conditions met" : "Conditions not met"}</span>
            ) : null}
          </div>
          {s.error ? <div className={styles.errorText}>{s.error}</div> : null}
          {s.output !== undefined && s.type !== "condition" ? (
            <details className={styles.details}>
              <summary>Output</summary>
              <OutputView value={s.output} />
            </details>
          ) : null}
          {s.steps && s.steps.length > 0 ? <StepList steps={s.steps} depth={depth + 1} /> : null}
        </li>
      ))}
    </ol>
  );
}

export function RunDetail({ run }: { run: AutomationRun }) {
  return (
    <div className={styles.runDetail}>
      <div className={styles.runDetailHead}>
        <span className={`${styles.statusPill} ${statusClass(run.status)}`}>{statusLabel(run.status)}</span>
        <span className={styles.muted}>
          {fmtTime(run.createdAt)} {duration(run) ? `· ${duration(run)}` : ""} {run.isTest ? "· Test" : ""}
          {run.attempts > 1 ? ` · ${run.attempts} attempts` : ""}
        </span>
      </div>
      {run.error ? <div className={styles.errorBox}>{run.error}</div> : null}
      <details className={styles.details} open={false}>
        <summary>Trigger: {triggerInfo(run.triggerType)?.label ?? run.triggerType}</summary>
        <OutputView value={run.trigger} />
      </details>
      {run.steps.length > 0 ? <StepList steps={run.steps} /> : <p className={styles.muted}>No actions ran.</p>}
    </div>
  );
}

export function RunHistory({ baseId, automationId }: { baseId: string; automationId: string }) {
  const [selected, setSelected] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ["automations", baseId, automationId, "runs"],
    queryFn: () => automationsApi.runs(baseId, automationId, 100),
    refetchInterval: 5000,
  });
  if (q.isLoading) return <p className={styles.muted}>Loading run history…</p>;
  if (q.isError) return <div className={styles.errorBox}>Couldn’t load run history. {(q.error as Error).message}</div>;
  const runs = q.data?.runs ?? [];
  if (runs.length === 0) {
    return (
      <div className={styles.emptyState}>
        <strong>No runs yet</strong>
        <p className={styles.muted}>Runs appear here when the trigger fires or when you test the automation.</p>
      </div>
    );
  }
  const current = runs.find((r) => r.id === selected) ?? null;
  return (
    <div className={styles.runs}>
      <ul className={styles.runList}>
        {runs.map((r) => (
          <li key={r.id}>
            <button
              type="button"
              className={r.id === current?.id ? `${styles.runItem} ${styles.runItemActive}` : styles.runItem}
              onClick={() => setSelected(r.id === selected ? null : r.id)}
            >
              <span className={`${styles.statusDot} ${statusClass(r.status)}`} aria-hidden />
              <span className={styles.runWhen}>{fmtTime(r.createdAt)}</span>
              <span className={styles.muted}>
                {statusLabel(r.status)}
                {r.isTest ? " · Test" : ""}
              </span>
            </button>
            {r.id === current?.id ? <RunDetail run={r} /> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
