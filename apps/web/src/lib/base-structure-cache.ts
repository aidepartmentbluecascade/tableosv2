import type { BaseDetail } from "./api.ts";

/**
 * A base's structure (tables, fields, views — never records) from the last
 * visit, so reopening it shows the real layout at once while fresh data loads.
 * Kept per user, capped, and cleared on log out.
 */

const PREFIX = "tableos.base.";
const INDEX = "tableos.base-index";
const MAX_ENTRIES = 20;
const MAX_BYTES = 400_000;

const keyOf = (userId: string, baseId: string) => `${PREFIX}${userId}.${baseId}`;

function readIndex(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(INDEX) ?? "[]") as unknown;
    return Array.isArray(raw) ? raw.filter((k): k is string => typeof k === "string") : [];
  } catch {
    return [];
  }
}

export function loadBaseStructure(userId: string | undefined, baseId: string): BaseDetail | undefined {
  if (!userId) return undefined;
  try {
    const raw = localStorage.getItem(keyOf(userId, baseId));
    return raw ? (JSON.parse(raw) as BaseDetail) : undefined;
  } catch {
    return undefined;
  }
}

export function saveBaseStructure(userId: string | undefined, baseId: string, base: BaseDetail): void {
  if (!userId) return;
  const key = keyOf(userId, baseId);
  try {
    const json = JSON.stringify(base);
    if (json.length > MAX_BYTES) return;
    localStorage.setItem(key, json);
    const index = [key, ...readIndex().filter((k) => k !== key)];
    for (const old of index.splice(MAX_ENTRIES)) localStorage.removeItem(old);
    localStorage.setItem(INDEX, JSON.stringify(index));
  } catch {
    // Storage full or unavailable; the cache is optional.
  }
}

export function forgetBaseStructure(userId: string | undefined, baseId: string): void {
  if (!userId) return;
  try {
    localStorage.removeItem(keyOf(userId, baseId));
  } catch {
    // ignore
  }
}

export function clearBaseStructures(): void {
  try {
    for (const k of readIndex()) localStorage.removeItem(k);
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k?.startsWith(PREFIX)) localStorage.removeItem(k);
    }
    localStorage.removeItem(INDEX);
  } catch {
    // ignore
  }
}
