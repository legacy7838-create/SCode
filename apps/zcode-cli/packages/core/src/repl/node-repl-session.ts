import { createContext, runInContext, type Context } from "node:vm";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { IifeContextExecutor, type ReplExecutor } from "./executors.js";
import {
  PROCESS_MODULE_IDS,
  createReplRequire,
  createRestrictedProcessFacade,
  normalizeReplError,
  stringifyReplResult,
} from "./node-repl-runtime-helpers.js";

/** Images collected by the REPL (nodeRepl.emitImage). */
export interface NodeReplImage {
  base64: string;
  mimeType: string;
}

/** The SDK/bridge result block; it keeps MCP's structured fields without making core depend on the MCP SDK types. */
export interface NodeReplStructuredResult {
  content: Array<{ type: string; [key: string]: unknown }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

/**
 * The identity of the target application of this cell operation (Computer Use).
 *
 * It is recorded only by the host's CUA bridge when a broker response arrives -- it is not on the sandbox globals, so the model cannot change it.
 * `nodeRepl.setResponseMeta` / `nodeRepl.emitStructuredResult` are both model-writable channels, and producer application metadata arriving through them
 * is untrustworthy and must be dropped in toMcpRunResult.
 */
export interface NodeReplCuaAppIdentity {
  appKey: string;
  displayName?: string;
}

/** The output sink: nodeRepl.write / console inside the REPL converge here; emitImage collects images. */
export interface NodeReplWriteSink {
  write(text: string): void;
  images: NodeReplImage[];
  browserScreenshots: NodeReplImage[];
  structuredResults: NodeReplStructuredResult[];
  responseMeta: Record<string, unknown>;
  cuaApps: NodeReplCuaAppIdentity[];
}

export interface NodeReplRunResult {
  /** The stringified last value / return value (possibly undefined). */
  result?: string;
  /** The output collected by nodeRepl.write + console during this run. */
  logs: string;
  /** The structured error on a throw (without crashing the process). */
  error?: { name: string; message: string; stack?: string };
  /** The images collected by nodeRepl.emitImage during this run (screenshots, for example). */
  images?: NodeReplImage[];
  /** The indices in images confirmed to come from an explicit tab.screenshot() in this run. */
  browserScreenshotImageIndices?: number[];
  /** The structured result the SDK writes through a dedicated channel; it takes priority over the console/REPL echoes. */
  structuredResults?: NodeReplStructuredResult[];
  /** The metadata set by nodeRepl.setResponseMeta during this run. */
  responseMeta?: Record<string, unknown>;
  /** The application acted on by the last identity-establishing CUA call of this cell; recorded by the host bridge and not writable by the model. */
  cuaApp?: NodeReplCuaAppIdentity;
}

export type NodeReplRequestMeta = Record<string, unknown>;

export interface NodeReplSessionOptions {
  /** Extra globals injected into the sandbox (such as the browser execute bridge, an agent object). */
  injectedGlobals?: Record<PropertyKey, unknown> | (() => Record<PropertyKey, unknown>);
  /** The MCP stdio runtime uses a restricted process facade, so a cell cannot close the process or corrupt the protocol stdout. */
  restrictProcess?: boolean;
}

function browserScreenshotIndexResult(
  images: readonly NodeReplImage[],
  browserScreenshots: readonly NodeReplImage[],
): Pick<NodeReplRunResult, "browserScreenshotImageIndices"> {
  if (images.length === 0 || browserScreenshots.length === 0) return {};

  const remainingByPayload = new Map<string, number>();
  for (const screenshot of browserScreenshots) {
    const key = `${screenshot.mimeType}\u0000${screenshot.base64}`;
    remainingByPayload.set(key, (remainingByPayload.get(key) ?? 0) + 1);
  }

  const browserScreenshotImageIndices: number[] = [];
  images.forEach((image, index) => {
    const key = `${image.mimeType}\u0000${image.base64}`;
    const remaining = remainingByPayload.get(key) ?? 0;
    if (remaining <= 0) return;
    browserScreenshotImageIndices.push(index);
    remainingByPayload.set(key, remaining - 1);
  });
  return browserScreenshotImageIndices.length > 0 ? { browserScreenshotImageIndices } : {};
}

/**
 * When one cell makes several CUA calls, it takes the last identity-establishing one, consistent with the last-write-wins `_meta` already has.
 * Calls that produce no primary (the items mode of list_apps, the none of request_access / stop) never
 * enter this array at all, so they cannot overwrite the identity of the earlier action.
 */
function latestCuaAppResult(
  cuaApps: readonly NodeReplCuaAppIdentity[],
): Pick<NodeReplRunResult, "cuaApp"> {
  const cuaApp = cuaApps.at(-1);
  return cuaApp ? { cuaApp } : {};
}

/**
 * NodeReplSession: a persistent JavaScript execution engine inside the caller's process.
 *
 * One instance per session; the sandbox is the globalThis the model sees, and it keeps state across multiple run() calls.
 * Top-level await runs in an async IIFE, dynamic loading goes through the injected importModule(), and results come back uniformly structured.
 *
 * Security note: vm is not a security sandbox, isolation still rests on the upper-layer permissions and approval gate. The restricted process facade only limits
 * a cell's direct influence over process control and MCP stdio; third-party modules still execute in the host Node realm.
 */
export class NodeReplSession {
  private context: Context;
  private readonly createInjectedGlobals: () => Record<PropertyKey, unknown>;
  private readonly restrictedProcess: Readonly<Record<string, unknown>> | undefined;
  private currentSink: NodeReplWriteSink | null = null;
  private nodeReplApi: {
    requestMeta: NodeReplRequestMeta;
    emitStructuredResult: (result: unknown) => void;
  } | null = null;
  private disposed = false;
  private cleanupContextResources: () => void = () => undefined;
  /** The execution + persistence policy (route B by default); switching the executor switches the route, the body of run stays the same. */
  private readonly executor: ReplExecutor;

  constructor(options: NodeReplSessionOptions = {}) {
    const injectedGlobals = options.injectedGlobals;
    this.createInjectedGlobals =
      typeof injectedGlobals === "function" ? injectedGlobals : () => injectedGlobals ?? {};
    this.restrictedProcess = options.restrictProcess ? createRestrictedProcessFacade() : undefined;
    this.executor = new IifeContextExecutor();
    this.context = this.buildContext();
  }

  private buildContext(): Context {
    const timeouts = new Set<ReturnType<typeof setTimeout>>();
    const intervals = new Set<ReturnType<typeof setInterval>>();
    const scopedSetTimeout = (
      callback: (...args: unknown[]) => void,
      delay?: number,
      ...args: unknown[]
    ) => {
      const handle = setTimeout(() => {
        timeouts.delete(handle);
        callback(...args);
      }, delay);
      timeouts.add(handle);
      return handle;
    };
    const scopedClearTimeout = (handle: ReturnType<typeof setTimeout>) => {
      timeouts.delete(handle);
      clearTimeout(handle);
    };
    const scopedSetInterval = (
      callback: (...args: unknown[]) => void,
      delay?: number,
      ...args: unknown[]
    ) => {
      const handle = setInterval(callback, delay, ...args);
      intervals.add(handle);
      return handle;
    };
    const scopedClearInterval = (handle: ReturnType<typeof setInterval>) => {
      intervals.delete(handle);
      clearInterval(handle);
    };
    this.cleanupContextResources = () => {
      for (const handle of timeouts) clearTimeout(handle);
      for (const handle of intervals) clearInterval(handle);
      timeouts.clear();
      intervals.clear();
    };
    // console tee to the current sink (set before each run), while retaining the original console for debugging.
    const teeConsole = {
      log: (...args: unknown[]) => this.emit(args),
      info: (...args: unknown[]) => this.emit(args),
      warn: (...args: unknown[]) => this.emit(args),
      error: (...args: unknown[]) => this.emit(args),
      debug: (...args: unknown[]) => this.emit(args),
    };
    // Use the current working directory as the require base.
    const req = createReplRequire(createRequire(`${process.cwd()}/`), this.restrictedProcess);
    const nodeReplApi = {
      cwd: process.cwd(),
      homeDir: homedir(),
      tmpDir: tmpdir(),
      requestMeta: {} as NodeReplRequestMeta,
      write: (text: string) => this.emit([text]),
      // Return the image (such as the tab.screenshot result) to the model as an image content block; accepts bytes/base64/dataUrl.
      emitImage: (image: unknown) => this.emitImage(image),
      // SDK results must go through the structured channel; otherwise the model's console.log will split image/image_ref into ordinary text.
      // The official CUA's accurate frame check cannot confirm that the two blocks are still adjacent and have not been overwritten.
      emitStructuredResult: (result: unknown) => this.emitStructuredResult(result),
      setResponseMeta: (meta: unknown) => this.setResponseMeta(meta),
    };
    this.nodeReplApi = nodeReplApi;
    const sandbox: Record<PropertyKey, unknown> = {
      console: teeConsole,
      process: this.restrictedProcess ?? process,
      Buffer,
      URL,
      URLSearchParams,
      TextEncoder,
      TextDecoder,
      setTimeout: scopedSetTimeout,
      clearTimeout: scopedClearTimeout,
      setInterval: scopedSetInterval,
      clearInterval: scopedClearInterval,
      queueMicrotask,
      structuredClone,
      require: req,
      // Dynamically load modules. Use injected functions instead of bare import(): import() in vm requires --experimental-vm-modules
      // Start the flag (the agent is a packaged binary, so it is inconvenient to add a flag); the importModule goes directly to the host import(), no flag is required.
      // Models and browser skills use standard await import("..."); the executor will be safely rewritten to the loader according to the AST.
      importModule: (specifier: string) => this.importModule(specifier),
      nodeRepl: nodeReplApi,
      // Rebuild the browser-client facade every kernel reset; browser/tab binding in the old context
      // Cannot drift to a new generation across resets, keeping new session bootstrap boundaries consistent.
      ...this.createInjectedGlobals(),
    };
    const context = createContext(sandbox);
    // globalThis is self-referential, making the model available for explicit persistence with globalThis.x = ... .
    runInContext("globalThis.globalThis = globalThis;", context);
    return context;
  }

  private emit(args: unknown[]): void {
    if (!this.currentSink) {
      return;
    }
    const text = args
      .map((a) => (typeof a === "string" ? a : (stringifyReplResult(a) ?? "undefined")))
      .join(" ");
    this.currentSink.write(text);
  }

  /**
   * Collects one image into this run's output (for formatModelContent to turn into an image content block for the model).
   * Accepts Uint8Array/Buffer/number[], a data URL, or { base64 | bytes, mimeType }.
   * Throws a TypeError on invalid arguments, so the model sees the usage error directly.
   */
  private emitImage(image: unknown): void {
    if (!this.currentSink) {
      return;
    }
    const directBytes =
      (ArrayBuffer.isView(image) && !(image instanceof DataView)) || Array.isArray(image)
        ? (image as Uint8Array | number[])
        : null;
    const rec =
      directBytes !== null
        ? { bytes: directBytes }
        : ((image ?? {}) as {
            base64?: unknown;
            bytes?: unknown;
            dataUrl?: unknown;
            mimeType?: unknown;
          });
    let base64: string | null = null;
    let dataUrlMimeType: string | undefined;
    if (typeof rec.dataUrl === "string") {
      const match = /^data:([^;,]+);base64,(.+)$/u.exec(rec.dataUrl);
      if (match) {
        dataUrlMimeType = match[1];
        base64 = match[2];
      }
    } else if (typeof rec.base64 === "string" && rec.base64.length > 0) {
      base64 = rec.base64;
    } else if (rec.bytes != null) {
      try {
        base64 = Buffer.from(rec.bytes as Uint8Array | readonly number[]).toString("base64");
      } catch {
        base64 = null;
      }
    }
    if (!base64) {
      throw new TypeError(
        "nodeRepl.emitImage requires bytes, dataUrl, { base64 }, or { bytes }; e.g. emitImage(await tab.screenshot())",
      );
    }
    const mimeType =
      typeof rec.mimeType === "string" && rec.mimeType
        ? rec.mimeType
        : (dataUrlMimeType ?? "image/png");
    this.currentSink.images.push({ base64, mimeType });
  }

  private setResponseMeta(meta: unknown): void {
    if (!this.currentSink) return;
    if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
      throw new TypeError("nodeRepl.setResponseMeta requires a plain object");
    }
    Object.assign(this.currentSink.responseMeta, meta as Record<string, unknown>);
  }

  private emitStructuredResult(result: unknown): void {
    if (!this.currentSink) return;
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      throw new TypeError("nodeRepl.emitStructuredResult requires a result object");
    }
    const candidate = result as { content?: unknown };
    if (!Array.isArray(candidate.content)) {
      throw new TypeError("nodeRepl.emitStructuredResult requires a content array");
    }
    for (const block of candidate.content) {
      if (!block || typeof block !== "object" || typeof (block as { type?: unknown }).type !== "string") {
        throw new TypeError("nodeRepl.emitStructuredResult content blocks require a type");
      }
    }
    this.currentSink.structuredResults.push(result as NodeReplStructuredResult);
  }

  /** The browser-client transport merges the backend meta into the tool result within the same js run. */
  mergeResponseMeta(meta: Record<string, unknown>): void {
    if (!this.currentSink) return;
    const currentSurface = this.currentSink.responseMeta["zcode/toolSurface"];
    const nextSurface = meta["zcode/toolSurface"];

    // At the end of the cell, openTabIds/sessionEnded of the last successful side effect is appended; automatic preview and follow-up
    // Reading title/url/domSnapshot cannot overwrite the previous action meta.
    if (
      currentSurface &&
      typeof currentSurface === "object" &&
      !Array.isArray(currentSurface) &&
      nextSurface &&
      typeof nextSurface === "object" &&
      !Array.isArray(nextSurface)
    ) {
      this.setResponseMeta({
        ...meta,
        "zcode/toolSurface": {
          ...(currentSurface as Record<string, unknown>),
          ...(nextSurface as Record<string, unknown>),
        },
      });
      return;
    }
    this.setResponseMeta(meta);
  }

  /** The browser transport records the raw image of the model's explicit screenshot, so emitImage results can be matched back to their source. */
  recordBrowserScreenshot(image: NodeReplImage): void {
    if (!this.currentSink) return;
    this.currentSink.browserScreenshots.push(image);
  }

  /**
   * The CUA bridge records the target application identity of this call from the broker response.
   *
   * Deliberately not placed on the sandbox globals (unlike write/emitImage/emitStructuredResult/setResponseMeta):
   * the tool card shows the App icon from it, and if the model could write it, it could claim it had operated some other app.
   */
  recordCuaAppIdentity(app: NodeReplCuaAppIdentity): void {
    if (!this.currentSink) return;
    this.currentSink.cuaApps.push(app);
  }

  /** Executes a piece of code; signal supports cancellation (timeout/stop). */
  async run(
    code: string,
    options: {
      signal?: AbortSignal;
      requestMeta?: NodeReplRequestMeta;
      syncTimeoutMs?: number;
    } = {},
  ): Promise<NodeReplRunResult> {
    if (this.disposed) {
      return {
        logs: "",
        error: { name: "DisposedError", message: "REPL session has been disposed" },
      };
    }
    let buffer = "";
    const images: NodeReplImage[] = [];
    const browserScreenshots: NodeReplImage[] = [];
    const structuredResults: NodeReplStructuredResult[] = [];
    const responseMeta: Record<string, unknown> = {};
    const cuaApps: NodeReplCuaAppIdentity[] = [];
    if (this.nodeReplApi) {
      this.nodeReplApi.requestMeta = { ...options.requestMeta };
    }
    this.currentSink = {
      write: (text: string) => {
        buffer += (buffer ? "\n" : "") + text;
      },
      images,
      browserScreenshots,
      structuredResults,
      responseMeta,
      cuaApps,
    };
    try {
      // Execution is delegated to the executor (default route B: instrument top-level declaration → async-IIFE → runInContext),
      // Make top-level const/let/var/function/class persistent across js calls (copied to globalThis).
      const value = await this.executor.run(
        code,
        this.context,
        options.signal,
        options.syncTimeoutMs,
      );
      return {
        result: stringifyReplResult(value),
        logs: buffer,
        ...(images.length > 0 ? { images } : {}),
        ...browserScreenshotIndexResult(images, browserScreenshots),
        ...(structuredResults.length > 0 ? { structuredResults } : {}),
        ...(Object.keys(responseMeta).length > 0 ? { responseMeta } : {}),
        ...latestCuaAppResult(cuaApps),
      };
    } catch (error) {
      // Note: Errors thrown in the vm context belong to different realms, and the `instanceof Error` on the host side is false.
      // Therefore, it is extracted according to the error-like structure (with name/message/stack fields) instead of packaging into a new Error
      // (The wrapper will turn the message into "Error: boom" and lose the original message).
      const normalized = normalizeReplError(error);
      const mustResetKernel =
        normalized.name === "AbortError" ||
        normalized.name === "TimeoutError" ||
        normalized.message.includes("Script execution timed out");
      if (mustResetKernel && !this.disposed) {
        // Promise.race can only stop waiting, old async continuation/timer may still be on the same global
        // Keep writing status. After cancellation or VM timeout, the entire context is discarded and the timers of the generation are cleared;
        // Subsequent calls can only see the fresh kernel and cannot observe late mutations.
        this.cleanupContextResources();
        this.context = this.buildContext();
        // Silently rebuilding the context will cause the model to continue calling cleared browser/tab variables.
        // Expand a timeout into consecutive ReferenceErrors. The error itself must expose reset semantics and recovery actions.
        normalized.message = `${normalized.message}; kernel reset, all previous bindings were cleared; reinitialize browser/tab bindings before rerunning`;
      }
      return {
        logs: buffer,
        error: normalized,
        ...(images.length > 0 ? { images } : {}),
        ...browserScreenshotIndexResult(images, browserScreenshots),
        ...(structuredResults.length > 0 ? { structuredResults } : {}),
        ...(Object.keys(responseMeta).length > 0 ? { responseMeta } : {}),
        ...latestCuaAppResult(cuaApps),
      };
    } finally {
      this.currentSink = null;
      if (this.nodeReplApi) {
        this.nodeReplApi.requestMeta = {};
      }
    }
  }

  private async importModule(specifier: string): Promise<unknown> {
    if (this.restrictedProcess && PROCESS_MODULE_IDS.has(specifier)) {
      return { ...this.restrictedProcess, default: this.restrictedProcess };
    }
    return await import(specifier);
  }

  /** Releases resources. */
  dispose(): void {
    this.disposed = true;
    this.cleanupContextResources();
    this.currentSink = null;
  }
}
