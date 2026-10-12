import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { TokenOption } from "./catalog.ts";
import styles from "./automations.module.css";

const TOKEN_RE = /\{\{[^{}]+\}\}/g;
const HAS_TOKEN = /\{\{[^{}]+\}\}/;

interface Chip {
  label: string;
  title: string;
}

/** Friendly chip text for a `{{…}}` token, from the picker list when known. */
function chipFor(token: string, byToken: Map<string, TokenOption>): Chip {
  const known = byToken.get(token);
  if (known) return { label: known.label, title: `${known.group} › ${known.label}` };
  const path = token.slice(2, -2).trim();
  const field = /\.fields\.(.+)$/.exec(path)?.[1];
  return { label: field ?? path, title: path };
}

function chipNode(token: string, chip: Chip): HTMLSpanElement {
  const el = document.createElement("span");
  el.className = styles.tokenChip ?? "";
  el.contentEditable = "false";
  el.dataset.token = token;
  el.title = chip.title;
  el.textContent = chip.label;
  return el;
}

/** Editor DOM → stored string (chips back to their `{{…}}` text). */
function serialize(root: Node): string {
  let out = "";
  root.childNodes.forEach((n) => {
    if (n.nodeType === Node.TEXT_NODE) out += (n.textContent ?? "").replace(/\u200b/g, "");
    else if (n instanceof HTMLElement) {
      if (n.dataset.token) out += n.dataset.token;
      else if (n.tagName === "BR") out += "\n";
      else {
        // Browsers wrap new lines in <div> when pasting/typing in some cases.
        if (n.tagName === "DIV" && out && !out.endsWith("\n")) out += "\n";
        out += serialize(n);
      }
    }
  });
  return out;
}

function render(root: HTMLElement, value: string, byToken: Map<string, TokenOption>) {
  root.replaceChildren();
  let last = 0;
  for (const m of value.matchAll(TOKEN_RE)) {
    if (m.index > last) root.append(document.createTextNode(value.slice(last, m.index)));
    root.append(chipNode(m[0], chipFor(m[0], byToken)));
    last = m.index + m[0].length;
  }
  if (last < value.length) root.append(document.createTextNode(value.slice(last)));
}

/**
 * Text field with a "+" picker that inserts `{{trigger.record.fields.Name}}`-style tokens at the caret.
 * Tokens show as chips with readable names; the stored value is plain text with the `{{…}}` tokens.
 */
export function TokenInput({
  value,
  onChange,
  tokens,
  placeholder,
  multiline = false,
  ariaLabel,
  pickerFilter,
}: {
  value: string;
  onChange: (v: string) => void;
  tokens: TokenOption[];
  /** Limits what the "+" picker offers; chips still use every token's label. */
  pickerFilter?: (t: TokenOption) => boolean;
  placeholder?: string;
  multiline?: boolean;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const editorRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const range = useRef<Range | null>(null);
  const emitted = useRef<string | null>(null);
  const byToken = useMemo(() => new Map(tokens.map((t) => [t.token, t])), [tokens]);
  const labelsKey = useMemo(() => tokens.map((t) => t.token + t.label).join("|"), [tokens]);

  // Rebuild the editor only when the value changes from outside (not on our own typing), so the caret stays put.
  useLayoutEffect(() => {
    const el = editorRef.current;
    if (!el || value === emitted.current) return;
    render(el, value, byToken);
    emitted.current = value;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  // Chip labels follow renamed fields / steps.
  useLayoutEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    el.querySelectorAll<HTMLElement>("[data-token]").forEach((c) => {
      const chip = chipFor(c.dataset.token!, byToken);
      c.textContent = chip.label;
      c.title = chip.title;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [labelsKey]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const m = new Map<string, TokenOption[]>();
    for (const t of tokens) {
      if (pickerFilter && !pickerFilter(t)) continue;
      if (q && !`${t.group} ${t.label}`.toLowerCase().includes(q)) continue;
      const list = m.get(t.group) ?? [];
      list.push(t);
      m.set(t.group, list);
    }
    return [...m.entries()];
  }, [tokens, query, pickerFilter]);

  const emit = () => {
    const el = editorRef.current;
    if (!el) return;
    const next = serialize(el);
    emitted.current = next;
    if (next !== value) onChange(next);
  };

  const saveRange = () => {
    const el = editorRef.current;
    const sel = window.getSelection();
    if (el && sel && sel.rangeCount && el.contains(sel.getRangeAt(0).commonAncestorContainer)) range.current = sel.getRangeAt(0).cloneRange();
  };

  const insertText = (text: string) => {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    const r = sel.getRangeAt(0);
    r.deleteContents();
    const node = document.createTextNode(text);
    r.insertNode(node);
    r.setStartAfter(node);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
    emit();
  };

  const insertToken = (token: string) => {
    const el = editorRef.current;
    if (!el) return;
    el.focus();
    const sel = window.getSelection();
    let r = range.current;
    if (!r || !el.contains(r.commonAncestorContainer)) {
      r = document.createRange();
      r.selectNodeContents(el);
      r.collapse(false);
    }
    r.deleteContents();
    const chip = chipNode(token, chipFor(token, byToken));
    r.insertNode(chip);
    // A text node after the chip gives the caret somewhere to land.
    const after = document.createTextNode("\u200b");
    chip.after(after);
    r.setStart(after, 1);
    r.collapse(true);
    sel?.removeAllRanges();
    sel?.addRange(r);
    range.current = r.cloneRange();
    emit();
    setOpen(false);
    setQuery("");
  };

  const chipify = (el: HTMLElement) => {
    const v = serialize(el);
    render(el, v, byToken);
    emitted.current = v;
    if (v !== value) onChange(v);
  };

  const empty = value === "";

  return (
    <div className={styles.tokenWrap} ref={wrapRef}>
      <div
        ref={editorRef}
        role="textbox"
        aria-label={ariaLabel}
        aria-multiline={multiline}
        contentEditable
        suppressContentEditableWarning
        spellCheck={false}
        className={`${multiline ? styles.textarea : styles.input} ${styles.tokenEditor} ${multiline ? "" : styles.tokenEditorSingle}`}
        data-placeholder={placeholder ?? ""}
        data-empty={empty || undefined}
        onInput={emit}
        // Fields wrap this in a <label>; without this a click would be forwarded to the "+" button.
        onClick={(e) => e.preventDefault()}
        onKeyUp={saveRange}
        onMouseUp={saveRange}
        onBlur={() => {
          saveRange();
          // `{{…}}` typed by hand becomes a chip once the field loses focus.
          const el = editorRef.current;
          if (el && [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && HAS_TOKEN.test(n.textContent ?? ""))) {
            chipify(el);
            range.current = null;
          }
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (multiline) insertText("\n");
          }
        }}
        onPaste={(e) => {
          e.preventDefault();
          const text = e.clipboardData.getData("text/plain");
          insertText(multiline ? text : text.replace(/\r?\n/g, " "));
          if (HAS_TOKEN.test(text)) {
            const el = editorRef.current;
            if (el) {
              chipify(el);
              const r = document.createRange();
              r.selectNodeContents(el);
              r.collapse(false);
              window.getSelection()?.removeAllRanges();
              window.getSelection()?.addRange(r);
            }
          }
        }}
      />
      <button
        type="button"
        className={styles.tokenBtn}
        title="Insert a value from an earlier step"
        aria-label="Insert dynamic value"
        onMouseDown={saveRange}
        onClick={() => setOpen((o) => !o)}
      >
        +
      </button>
      {open ? (
        <div className={styles.tokenMenu} role="listbox">
          <input autoFocus className={styles.input} placeholder="Find a value" value={query} onChange={(e) => setQuery(e.target.value)} />
          {groups.length === 0 ? <p className={styles.muted}>No matching values</p> : null}
          {groups.map(([group, items]) => (
            <div key={group} className={styles.tokenGroup}>
              <div className={styles.tokenGroupLabel}>{group}</div>
              {items.map((t) => (
                <button key={t.token + t.label} type="button" role="option" onClick={() => insertToken(t.token)}>
                  {t.label}
                </button>
              ))}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
