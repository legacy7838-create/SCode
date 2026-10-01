/**
 * Renderer→host session handshake.
 *
 * Split out of `tauriPlatform.ts` so this is one module with one owner: the
 * renderer *attachment* to the host's surviving service session. `tauriPlatform.ts`
 * is the `IPlatformService` surface; this is the identity and lifetime half that
 * the surface does not express.
 *
 * Why the renderer drives it at all: Electron transferred a `MessagePortMain`
 * pair from `main`, so the Host owned the attachment and the renderer never had
 * to know. Tauri has no transferable port (CUTOVER_SPEC R2), so the surviving
 * session is Rust-side state the renderer has to *ask* for. The commands are
 * `commands/session.rs`; the wire shapes below mirror its serde attributes
 * (`rename_all = "camelCase"`, variants kebab-cased).
 */
import { invoke } from "@tauri-apps/api/core";

/**
 * `commands/session.rs::RendererSessionWire`.
 *
 * `sessionId` is stable across a renderer reload; `attachmentId` and
 * `rendererEpoch` are not — that split is the whole point, because the session
 * identity must survive a reload while the attachment must not.
 */
export interface RendererSession {
  sessionId: string;
  attachmentId: string | null;
  rendererEpoch: number;
  phase: "starting" | "ready";
  hostId: string | null;
  clientMode: string;
}

/**
 * `commands/session.rs::RendererSessionHandshake` — a tagged value rather than a
 * `Result` for the gate specifically: "the host is not ready yet" is an ordinary
 * state the UI has to render, not a fault to report.
 */
export type RendererSessionHandshake =
  | { status: "ready"; session: RendererSession; serviceEndpoint: unknown }
  | { status: "host-not-ready"; phase: "starting" };

/**
 * `commands/session.rs::ConnectRemoteOutcome`.
 *
 * `connected` is reserved: no code path can produce it yet, because
 * `connect_remote` refuses before attempting a connection. It is declared so the
 * wire shape is total and a real backend is an additive change rather than a
 * wire break.
 */
export type ConnectRemoteOutcome =
  | { status: "connected"; sessionId: string }
  | {
      status: "no-native-equiv";
      code: string;
      kind: string;
      reason: string;
      requestId?: string | null;
      connectTrigger: string;
    }
  | { status: "invalid-payload"; error: string };

/**
 * The single writer of the renderer attachment. Module-scoped rather than passed
 * in because there must be exactly one attachment per renderer document — two
 * live attachments would both be able to claim the same `sessionId`, and the
 * `rendererEpoch` bump would stop being a reliable liveness signal.
 */
let currentSession: RendererSession | null = null;

/** The session this renderer is attached to, or `null` before the handshake. */
export function rendererSession(): RendererSession | null {
  return currentSession;
}

/**
 * Attach this renderer to the window's surviving service session.
 *
 * Electron did the equivalent from `main` on every `dom-ready`
 * (`desktopWindowLifecycle.ts:125-166`): the *host* survived a renderer reload
 * and only a fresh port was attached to it, because rebuilding the host "is the
 * root cause of 'session identity is volatile'".
 *
 * Rejects nothing and falls back to nothing: a `host-not-ready` outcome is
 * returned as-is so the caller decides whether to retry. Electron parked the
 * early `AttachServicePort` in `pendingStartupAttachments`
 * (`host/index.ts:2739-2746`) and attached it once the database reached `ready`;
 * the retry loop below is the same behaviour, driven from the renderer because
 * Tauri has no port to park.
 */
export async function beginRendererSession(
  attempts = 30,
  intervalMs = 250,
): Promise<RendererSession | null> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const handshake = await invoke<RendererSessionHandshake>("begin_renderer_session");
      if (handshake.status === "ready") {
        currentSession = handshake.session;
        return currentSession;
      }
    } catch (cause) {
      // A refusal here is a real fault and is logged rather than swallowed, but
      // it must not abort the retry loop: the host may still be starting.
      console.warn("[tauri-session] begin_renderer_session failed", cause);
    }
    if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return null;
}

/**
 * Release this renderer's attachment, keeping the session identity.
 *
 * Best-effort and idempotent: the authoritative reload path is the epoch bump in
 * the next {@link beginRendererSession}, so a `pagehide` that never reaches the
 * host costs nothing. It exists so the shell can drop a dead attachment without
 * waiting for the next mount.
 */
export async function detachRendererSession(): Promise<void> {
  try {
    const session = await invoke<RendererSession | null>("detach_renderer_session");
    if (session) currentSession = session;
  } catch (cause) {
    console.warn("[tauri-session] detach_renderer_session failed", cause);
  }
}

/**
 * Report the renderer teardown to the shell when the page goes away.
 *
 * The Electron original did not need this: the transferred `MessagePort` closed
 * with the renderer context and the Host's `port.once("close")` handler disposed
 * the attachment. Tauri has no transferable port, so the renderer is the only
 * thing that knows it is going.
 *
 * Called once per document from `installRendererSession`. It used to be defined
 * in `tauriPlatform.ts` and never invoked, which meant `detach_renderer_session`
 * had no caller and the teardown leg of the handshake was dead.
 */
export function watchRendererTeardown(): void {
  if (typeof window === "undefined") return;
  window.addEventListener("pagehide", () => {
    void detachRendererSession();
  });
}