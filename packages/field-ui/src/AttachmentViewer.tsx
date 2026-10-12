import { useEffect, useState, useSyncExternalStore, type ReactElement } from "react";
import { ensureFieldUiStyles } from "./styles.js";
import type { AttachmentValue } from "./types.js";

export interface AttachmentViewerRequest {
  items: AttachmentValue[];
  index: number;
  /** When set, the viewer shows a delete button for the current file. */
  onRemove?: ((id: string) => void) | undefined;
}

let current: AttachmentViewerRequest | null = null;
const listeners = new Set<() => void>();

function emit(next: AttachmentViewerRequest | null): void {
  current = next;
  for (const l of listeners) l();
}

/** Open the in-app attachment viewer (rendered by `<AttachmentViewerHost />`). */
export function openAttachmentViewer(req: AttachmentViewerRequest): void {
  if (req.items.length === 0) return;
  emit({ ...req, index: Math.max(0, Math.min(req.index, req.items.length - 1)) });
}

export function closeAttachmentViewer(): void {
  emit(null);
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

type Kind = "image" | "pdf" | "video" | "audio" | "text" | "other";

function kindOf(a: AttachmentValue): Kind {
  const mime = a.mime ?? "";
  const ext = /\.([a-z0-9]{1,5})$/i.exec(a.filename)?.[1]?.toLowerCase() ?? "";
  if (mime.startsWith("image/") || /^(png|jpe?g|gif|webp|svg|bmp|avif)$/.test(ext)) return "image";
  if (mime === "application/pdf" || ext === "pdf") return "pdf";
  if (mime.startsWith("video/") || /^(mp4|webm|mov|ogv)$/.test(ext)) return "video";
  if (mime.startsWith("audio/") || /^(mp3|wav|ogg|m4a)$/.test(ext)) return "audio";
  if (mime.startsWith("text/") || /^(txt|csv|md|json|log)$/.test(ext)) return "text";
  return "other";
}

function extLabel(a: AttachmentValue): string {
  return (/\.([a-z0-9]{1,5})$/i.exec(a.filename)?.[1] ?? a.mime?.split("/")[1] ?? "file").slice(0, 4).toUpperCase();
}

function formatSize(bytes: number | null | undefined): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** API-served URLs accept `?download=1` to force a download instead of inline display. */
function downloadHref(url: string): string {
  if (!url.startsWith("/")) return url;
  return `${url}${url.includes("?") ? "&" : "?"}download=1`;
}

function Preview({ a }: { a: AttachmentValue }): ReactElement {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [a.id]);
  const kind = kindOf(a);
  if (!a.url || failed) {
    return (
      <div className="tfu-av-nopreview">
        <span className="tfu-av-bigext">{extLabel(a)}</span>
        <span>{a.url ? "This file couldn't be loaded. It may need to be uploaded again." : "This file has no download link."}</span>
      </div>
    );
  }
  switch (kind) {
    case "image":
      return <img className="tfu-av-img" src={a.url} alt={a.filename} onError={() => setFailed(true)} />;
    case "pdf":
    case "text":
      return <iframe className="tfu-av-frame" src={a.url} title={a.filename} />;
    case "video":
      return <video className="tfu-av-img" src={a.url} controls onError={() => setFailed(true)} />;
    case "audio":
      return <audio src={a.url} controls onError={() => setFailed(true)} />;
    default:
      return (
        <div className="tfu-av-nopreview">
          <span className="tfu-av-bigext">{extLabel(a)}</span>
          <span>No preview available for this file type.</span>
          <a className="tfu-btn tfu-btn-primary" href={downloadHref(a.url)} download={a.filename}>
            Download
          </a>
        </div>
      );
  }
}

function Thumb({ a }: { a: AttachmentValue }): ReactElement {
  const src = a.thumbnailUrl ?? (kindOf(a) === "image" ? a.url : null);
  return src ? <img src={src} alt="" loading="lazy" /> : <span className="tfu-av-ext">{extLabel(a)}</span>;
}

/** Mount once near the app root; renders the viewer opened via `openAttachmentViewer`. */
export function AttachmentViewerHost(): ReactElement | null {
  ensureFieldUiStyles();
  const req = useSyncExternalStore(subscribe, () => current, () => null);
  const [items, setItems] = useState<AttachmentValue[]>([]);
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (!req) return;
    setItems(req.items);
    setIndex(req.index);
  }, [req]);

  useEffect(() => {
    if (!req) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeAttachmentViewer();
      } else if (e.key === "ArrowRight") {
        e.stopPropagation();
        setIndex((i) => Math.min(i + 1, items.length - 1));
      } else if (e.key === "ArrowLeft") {
        e.stopPropagation();
        setIndex((i) => Math.max(i - 1, 0));
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [req, items.length]);

  if (!req || items.length === 0) return null;
  const a = items[Math.min(index, items.length - 1)]!;

  const remove = () => {
    if (!req.onRemove) return;
    if (!window.confirm(`Delete "${a.filename}" from this record?`)) return;
    req.onRemove(a.id);
    const next = items.filter((x) => x.id !== a.id);
    if (next.length === 0) {
      closeAttachmentViewer();
      return;
    }
    setItems(next);
    setIndex((i) => Math.min(i, next.length - 1));
  };

  return (
    <div
      className="tfu-av"
      role="dialog"
      aria-modal="true"
      aria-label={a.filename}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="tfu-av-bar">
        <div className="tfu-av-title">
          <span className="tfu-av-name" title={a.filename}>{a.filename}</span>
          <span className="tfu-av-meta">
            {items.length > 1 ? `${index + 1} of ${items.length}` : ""}
            {items.length > 1 && a.size ? " · " : ""}
            {formatSize(a.size)}
          </span>
        </div>
        <div className="tfu-av-actions">
          {req.onRemove ? (
            <button type="button" className="tfu-av-btn" onClick={remove} title="Delete attachment">
              Delete
            </button>
          ) : null}
          {a.url ? (
            <>
              <a className="tfu-av-btn" href={a.url} target="_blank" rel="noreferrer" title="Open in a new tab">
                Open
              </a>
              <a className="tfu-av-btn tfu-av-primary" href={downloadHref(a.url)} download={a.filename}>
                Download
              </a>
            </>
          ) : null}
          <button type="button" className="tfu-av-btn tfu-av-close" onClick={closeAttachmentViewer} aria-label="Close">
            ×
          </button>
        </div>
      </div>
      <div className="tfu-av-stage" onClick={(e) => e.target === e.currentTarget && closeAttachmentViewer()}>
        {items.length > 1 ? (
          <button type="button" className="tfu-av-nav tfu-av-prev" disabled={index === 0} onClick={() => setIndex(index - 1)} aria-label="Previous">
            ‹
          </button>
        ) : null}
        <Preview key={a.id} a={a} />
        {items.length > 1 ? (
          <button
            type="button"
            className="tfu-av-nav tfu-av-next"
            disabled={index >= items.length - 1}
            onClick={() => setIndex(index + 1)}
            aria-label="Next"
          >
            ›
          </button>
        ) : null}
      </div>
      {items.length > 1 ? (
        <div className="tfu-av-strip">
          {items.map((x, i) => (
            <button
              key={x.id}
              type="button"
              className={`tfu-av-thumb ${i === index ? "on" : ""}`}
              title={x.filename}
              onClick={() => setIndex(i)}
            >
              <Thumb a={x} />
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
