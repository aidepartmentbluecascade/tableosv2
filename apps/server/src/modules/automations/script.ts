import {
  newQuickJSWASMModule,
  RELEASE_SYNC,
  type QuickJSContext,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
  type QuickJSWASMModule,
} from "quickjs-emscripten";

/**
 * Sandbox for the "Run a script" automation action.
 *
 * User code runs inside QuickJS compiled to WebAssembly: it has no access to
 * Node (process, require, fs, env, network). The only ways out are the host
 * calls passed in `ScriptHost.call` (record API + guarded fetch), which run
 * with the automation owner's permissions.
 *
 * QuickJS executes on the caller's thread, so each synchronous stretch of
 * guest code is capped (`sliceMs`) to keep the API/worker event loop healthy;
 * `timeoutMs` bounds the whole run including awaited host calls.
 */

export interface ScriptLimits {
  timeoutMs: number;
  sliceMs: number;
  memoryBytes: number;
  maxHostCalls: number;
  maxLogLines: number;
  maxOutputBytes: number;
}

export const DEFAULT_SCRIPT_LIMITS: ScriptLimits = {
  timeoutMs: 30_000,
  sliceMs: 2_000,
  memoryBytes: 64 * 1024 * 1024,
  maxHostCalls: 100,
  maxLogLines: 200,
  maxOutputBytes: 256 * 1024,
};

export interface ScriptHost {
  /** JSON-safe data exposed as `input.config()`. */
  input: unknown;
  /** Host operations callable from the script (`base.*`, `fetch`). */
  call(name: string, args: unknown[], remainingMs: number): Promise<unknown>;
}

export interface ScriptResult {
  output: Record<string, unknown>;
  logs: string[];
}

export class ScriptError extends Error {
  constructor(
    message: string,
    readonly logs: string[],
  ) {
    super(message);
    this.name = "ScriptError";
  }
}

const PRELUDE = `
"use strict";
const __fmt = (v) => {
  if (typeof v === "string") return v;
  if (v instanceof Error) return v.name + ": " + v.message;
  try { const s = JSON.stringify(v); return s === undefined ? String(v) : s; } catch { return String(v); }
};
const __call = async (name, ...args) => JSON.parse(await __host(name, JSON.stringify(args === undefined ? [] : args)));
globalThis.console = {
  log: (...a) => __log("log", a.map(__fmt).join(" ")),
  info: (...a) => __log("info", a.map(__fmt).join(" ")),
  warn: (...a) => __log("warn", a.map(__fmt).join(" ")),
  error: (...a) => __log("error", a.map(__fmt).join(" ")),
};
const __input = JSON.parse(__inputJson);
globalThis.input = Object.freeze({ config: () => JSON.parse(__inputJson), ...__input });
const __out = {};
globalThis.output = Object.freeze({
  set(key, value) { __out[String(key)] = value === undefined ? null : value; },
});
globalThis.base = Object.freeze({
  id: __input.base ? __input.base.id : null,
  name: __input.base ? __input.base.name : null,
  tables: __input.base ? __input.base.tables : [],
  findRecords: (table, options) => __call("findRecords", table, options || {}),
  getRecord: (table, recordId) => __call("getRecord", table, recordId),
  createRecord: (table, fields) => __call("createRecord", table, fields || {}),
  updateRecord: (table, recordId, fields) => __call("updateRecord", table, recordId, fields || {}),
  deleteRecord: (table, recordId) => __call("deleteRecord", table, recordId),
});
globalThis.fetch = async (url, init) => {
  const r = await __call("fetch", String(url), init || {});
  return {
    status: r.status,
    ok: r.status >= 200 && r.status < 300,
    headers: r.headers,
    text: async () => r.body,
    json: async () => JSON.parse(r.body),
  };
};
`;

let modulePromise: Promise<QuickJSWASMModule> | null = null;
function quickjs(): Promise<QuickJSWASMModule> {
  modulePromise ??= newQuickJSWASMModule(RELEASE_SYNC).catch((err: unknown) => {
    modulePromise = null;
    throw err;
  });
  return modulePromise;
}

function describeError(ctx: QuickJSContext, handle: QuickJSHandle): string {
  const e = ctx.dump(handle) as unknown;
  if (e && typeof e === "object") {
    const o = e as { name?: unknown; message?: unknown; stack?: unknown };
    const head = `${typeof o.name === "string" ? o.name : "Error"}: ${typeof o.message === "string" ? o.message : JSON.stringify(e)}`;
    const where = typeof o.stack === "string" ? o.stack.match(/script\.js:(\d+)/) : null;
    return where ? `${head} (line ${where[1]})` : head;
  }
  return String(e);
}

function friendly(message: string): string {
  if (/interrupted/i.test(message)) return "Script ran too long without pausing and was stopped";
  if (/out of memory/i.test(message)) return "Script used too much memory";
  return message;
}

export async function runScript(
  code: string,
  host: ScriptHost,
  limits: ScriptLimits = DEFAULT_SCRIPT_LIMITS,
): Promise<ScriptResult> {
  const QuickJS = await quickjs();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(limits.memoryBytes);
  runtime.setMaxStackSize(1024 * 1024);
  const deadline = Date.now() + limits.timeoutMs;
  let sliceStart = Date.now();
  runtime.setInterruptHandler(() => Date.now() - sliceStart > limits.sliceMs || Date.now() > deadline);
  const ctx = runtime.newContext();

  const logs: string[] = [];
  const deferreds = new Set<QuickJSDeferredPromise>();
  let closed = false;
  let hostCalls = 0;
  let clean = true;

  const pump = () => {
    if (closed) return;
    sliceStart = Date.now();
    runtime.executePendingJobs().dispose();
  };

  try {
    const logFn = ctx.newFunction("__log", (levelH, msgH) => {
      if (logs.length >= limits.maxLogLines) return;
      const level = ctx.getString(levelH);
      const msg = ctx.getString(msgH).slice(0, 2000);
      logs.push(level === "log" ? msg : `[${level}] ${msg}`);
      if (logs.length === limits.maxLogLines) logs.push("… more log lines were dropped");
    });
    ctx.setProp(ctx.global, "__log", logFn);
    logFn.dispose();

    const hostFn = ctx.newFunction("__host", (nameH, argsH) => {
      const name = ctx.getString(nameH);
      const argsJson = ctx.getString(argsH);
      const deferred = ctx.newPromise();
      deferreds.add(deferred);
      void (async () => {
        let value: unknown;
        let failure: string | null = null;
        try {
          if (++hostCalls > limits.maxHostCalls) {
            throw new Error(`A script can make at most ${limits.maxHostCalls} base/fetch calls`);
          }
          value = await host.call(name, JSON.parse(argsJson) as unknown[], Math.max(0, deadline - Date.now()));
        } catch (err) {
          failure = err instanceof Error ? err.message : String(err);
        }
        if (closed) return;
        if (failure !== null) {
          const e = ctx.newError(failure);
          deferred.reject(e);
          e.dispose();
        } else {
          const s = ctx.newString(JSON.stringify(value ?? null));
          deferred.resolve(s);
          s.dispose();
        }
        deferreds.delete(deferred);
        pump();
      })();
      return deferred.handle;
    });
    ctx.setProp(ctx.global, "__host", hostFn);
    hostFn.dispose();

    const inputJson = ctx.newString(JSON.stringify(host.input ?? {}));
    ctx.setProp(ctx.global, "__inputJson", inputJson);
    inputJson.dispose();

    sliceStart = Date.now();
    ctx.unwrapResult(ctx.evalCode(PRELUDE, "prelude.js")).dispose();

    sliceStart = Date.now();
    const evaluated = ctx.evalCode(`(async () => {${code}\n})().then(() => JSON.stringify(__out))`, "script.js");
    if (evaluated.error) {
      const msg = describeError(ctx, evaluated.error);
      evaluated.error.dispose();
      throw new ScriptError(friendly(msg), logs);
    }
    const promise = evaluated.value;
    const settledP = ctx.resolvePromise(promise);
    pump();

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), Math.max(0, deadline - Date.now()));
    });
    const settled = await Promise.race([settledP, timeout]);
    clearTimeout(timer);
    if (settled === "timeout") {
      clean = false;
      throw new ScriptError(`Script did not finish within ${Math.round(limits.timeoutMs / 1000)} seconds`, logs);
    }
    promise.dispose();
    if (settled.error) {
      const msg = describeError(ctx, settled.error);
      settled.error.dispose();
      throw new ScriptError(friendly(msg), logs);
    }
    const json = ctx.getString(settled.value);
    settled.value.dispose();
    if (json.length > limits.maxOutputBytes) {
      throw new ScriptError(`Script output is larger than ${Math.round(limits.maxOutputBytes / 1024)} KB`, logs);
    }
    return { output: JSON.parse(json) as Record<string, unknown>, logs };
  } catch (err) {
    if (err instanceof ScriptError) throw err;
    throw new ScriptError(friendly(err instanceof Error ? err.message : String(err)), logs);
  } finally {
    closed = true;
    for (const d of deferreds) {
      try {
        d.dispose();
      } catch {
        clean = false;
      }
    }
    if (clean) {
      try {
        ctx.dispose();
        runtime.dispose();
      } catch {
        clean = false;
      }
    }
    // A run that was cut off can leave live objects behind; drop the whole
    // WebAssembly instance instead of risking a corrupted one for later runs.
    if (!clean) modulePromise = null;
  }
}
