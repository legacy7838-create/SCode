import { BrowserWindow, dialog, nativeImage, webContents } from "electron";
import type { WebContents } from "electron";

const DEFAULT_AUTOMATION_GRACE_MS = 3_000;
const USER_BROWSER_TAB_PREFIX = "browser:";

interface EmbeddedBrowserDialogRequest {
  type: "alert" | "confirm";
  message: string;
}

interface EmbeddedBrowserDialogResponse {
  handled: boolean;
  value?: boolean;
}

interface RegisteredGuest {
  guest: WebContents;
  tabId: string;
  windowId: number;
}

interface AutomationWindowState {
  activeCount: number;
  passthroughUntil: number;
  cleanupTimer?: ReturnType<typeof setTimeout>;
}

function parseEmbeddedBrowserDialogRequest(value: unknown): EmbeddedBrowserDialogRequest | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<EmbeddedBrowserDialogRequest>;
  if (
    (candidate.type !== "alert" && candidate.type !== "confirm") ||
    typeof candidate.message !== "string"
  ) {
    return null;
  }
  return { type: candidate.type, message: candidate.message };
}

function resolveEmbeddedBrowserDialogSource(frameUrl: string, guestUrl?: string): string {
  for (const candidate of [frameUrl, guestUrl]) {
    if (!candidate) continue;
    try {
      const parsed = new URL(candidate);
      if ((parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.host) {
        return `${parsed.host} says`;
      }
      if (parsed.protocol === "blob:" && parsed.origin) {
        const origin = new URL(parsed.origin);
        if ((origin.protocol === "http:" || origin.protocol === "https:") && origin.host) {
          return `${origin.host} says`;
        }
      }
    } catch {
      // Continue trying the next level of trusted URLs maintained by Chromium.
    }
  }
  // Illegal or non-host URLs should always use a neutral source tag that cannot be forged.
  return "This page says";
}

function resolveEmbeddedBrowserDialogButtons(type: EmbeddedBrowserDialogRequest["type"]): string[] {
  if (type === "alert") return ["OK"];
  return ["Cancel", "OK"];
}

/**
 * The user Browser's preload enters here synchronously before a page calls the native
 * alert/confirm, so the user path never creates a Chromium dialog first. During automation it
 * returns handled=false and the preload calls the native API back, leaving handling to
 * BrowserGuestManager's getDialog/handleDialog.
 */
export class EmbeddedBrowserJavaScriptDialogController {
  private readonly guests = new Map<number, RegisteredGuest>();
  private readonly openDialogGuestIds = new Set<number>();
  private readonly automationByWindow = new Map<number, AutomationWindowState>();

  constructor(
    private readonly options: {
      iconPath: string;
      logger: { warn: (...args: unknown[]) => void };
      automationGraceMs?: number;
    },
  ) {}

  dispose(): void {
    for (const webContentsId of this.guests.keys()) this.unbindGuest(webContentsId);
    for (const state of this.automationByWindow.values()) {
      if (state.cleanupTimer) clearTimeout(state.cleanupTimer);
    }
    this.automationByWindow.clear();
    this.openDialogGuestIds.clear();
  }

  bindGuest(tabId: string, webContentsId: number, windowId: number): void {
    this.unbindGuest(webContentsId);
    if (!tabId.startsWith(USER_BROWSER_TAB_PREFIX)) return;

    const guest = webContents.fromId(webContentsId);
    if (!guest || guest.isDestroyed() || guest.getType() !== "webview") return;

    const registration: RegisteredGuest = { guest, tabId, windowId };
    this.guests.set(webContentsId, registration);
    guest.once("destroyed", () => {
      if (this.guests.get(webContentsId) === registration) this.unbindGuest(webContentsId);
    });
  }

  handleDialogRequest(
    webContentsId: number,
    frameUrl: string,
    payload: unknown,
  ): EmbeddedBrowserDialogResponse {
    const request = parseEmbeddedBrowserDialogRequest(payload);
    const registration = this.guests.get(webContentsId);
    if (
      !request ||
      !registration ||
      this.openDialogGuestIds.has(webContentsId) ||
      this.shouldUseNativeDialog(registration.windowId)
    ) {
      return { handled: false };
    }

    const parent = BrowserWindow.fromId(registration.windowId);
    if (!parent || parent.isDestroyed()) return { handled: false };

    this.openDialogGuestIds.add(webContentsId);
    try {
      const icon = nativeImage.createFromPath(this.options.iconPath);
      const selected = dialog.showMessageBoxSync(parent, {
        buttons: resolveEmbeddedBrowserDialogButtons(request.type),
        defaultId: request.type === "alert" ? 0 : 1,
        cancelId: 0,
        // A trusted frame URL for a same-origin iframe might be about:blank; this URL does not
        // Displayable hosts must continue to use the guest master document URL maintained by Chromium.
        message: resolveEmbeddedBrowserDialogSource(frameUrl, registration.guest.getURL()),
        detail: request.message,
        noLink: true,
        normalizeAccessKeys: true,
        ...(!icon.isEmpty() ? { icon } : {}),
      });
      return {
        handled: true,
        ...(request.type === "confirm" ? { value: selected === 1 } : {}),
      };
    } catch (error) {
      // User selection cannot be forged when the system box creation fails; preload is notified to call back to the web page's native API.
      this.options.logger.warn("[browser-pane] failed to handle JavaScript dialog with source", {
        error: error instanceof Error ? error.message : String(error),
        tabId: registration.tabId,
      });
      return { handled: false };
    } finally {
      this.openDialogGuestIds.delete(webContentsId);
    }
  }

  beginAutomation(windowId: number): () => void {
    const state = this.automationByWindow.get(windowId) ?? {
      activeCount: 0,
      passthroughUntil: 0,
    };
    if (state.cleanupTimer) {
      clearTimeout(state.cleanupTimer);
      state.cleanupTimer = undefined;
    }
    state.activeCount += 1;
    state.passthroughUntil = Number.POSITIVE_INFINITY;
    this.automationByWindow.set(windowId, state);

    let released = false;
    return () => {
      if (released) return;
      released = true;
      state.activeCount = Math.max(0, state.activeCount - 1);
      if (state.activeCount > 0) return;

      const graceMs = this.options.automationGraceMs ?? DEFAULT_AUTOMATION_GRACE_MS;
      state.passthroughUntil = Date.now() + graceMs;
      state.cleanupTimer = setTimeout(() => {
        const current = this.automationByWindow.get(windowId);
        if (current === state && current.activeCount === 0) {
          this.automationByWindow.delete(windowId);
        }
      }, graceMs);
      state.cleanupTimer.unref?.();
    };
  }

  private shouldUseNativeDialog(windowId: number): boolean {
    const state = this.automationByWindow.get(windowId);
    return Boolean(state && (state.activeCount > 0 || Date.now() < state.passthroughUntil));
  }

  private unbindGuest(webContentsId: number): void {
    this.guests.delete(webContentsId);
    this.openDialogGuestIds.delete(webContentsId);
  }
}
