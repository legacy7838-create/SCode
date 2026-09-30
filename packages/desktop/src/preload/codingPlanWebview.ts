import { contextBridge, ipcRenderer } from "electron";
import {
  CodingPlanWebviewChannels,
  isTrustedCodingPlanWebviewOrigin,
  PlatformChannels,
} from "@zcode/shared";

// Coding Plan official website preload:
// - Hang window.zcodeBridge in the main world of the official website, exposing three capabilities:
//   1) notifyPurchaseComplete: Notify the host renderer through sendToHost after the purchase is completed;
//   2) getLang / onLangChange: Read the current locale of the App and subscribe to the runtime switch;
//   3) getReportContext: Read the purchase source context injected by the App;
//   4) openExternal: Use the system default browser to open external links. <a target="_blank"> within webview
//      By default, it will be routed to the internal Browser tab by setWindowOpenHandler, but the official website hopes
//      External links such as terms and management directly launch the system browser, and are intercepted by the official website script and forwarded by this method.
// - getLang reads main world's window.__zcodeLang__ (injected by App executeJavaScript);
//   onLangChange listens to zcode-coding-plan-lang-change CustomEvent in main world
//   (Also dispatched by App executeJavaScript when locale changes).
//   Because the entire bridge is hung in the main world through contextBridge.executeInMainWorld,
//   Share the same window with the page script, and the events can be passed through.
// - The Node/ipcRenderer primitives are not available in the main world of the official website, and only business functions are exposed.
// Refer to the contextBridge.executeInMainWorld mode of embeddedBrowserJavaScriptDialog.ts
// (Available under sandbox=true + contextIsolation=true, there is a precedent).
//
// Injection timing: When Electron webview presses params.src in the will-attach-webview hook to determine that it is the official website purchase page,
// Cut webPreferences.preload to this file (see desktopWindowChrome.ts).

const PUBLIC_BRIDGE_KEY = "zcodeBridge";
const NATIVE_BRIDGE_KEY = "__zcodeCodingPlanWebviewNativeBridge__";
const LANG_VAR = "__zcodeLang__";
const LANG_CHANGE_EVENT = "zcode-coding-plan-lang-change";
const REPORT_CONTEXT_VAR = "__zcodeReportContext__";

function isTrustedCodingPlanBridgeLocation(): boolean {
  try {
    const url = new URL(window.location.href);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (
      !isTrustedCodingPlanWebviewOrigin(url.origin, {
        e2eStoreBridgeEnabled: process.env.VITE_ZCODE_E2E_STORE_BRIDGE === "1",
      })
    ) {
      return false;
    }
    if (!url.pathname.includes("coding-plan")) return false;
    if (url.searchParams.get("embedded") === "app") return true;
    // The PayPal return page itself does not have embedded=app, but returnTo refers back to the embedded purchase page;
    // After successful payment on this page, zcodeBridge.notifyPurchaseComplete is still required to notify the App to refresh the model settings.
    if (!url.pathname.endsWith("/coding-plan/payment/callback")) return false;
    const returnTo = url.searchParams.get("returnTo");
    if (!returnTo) return false;
    const target = new URL(returnTo, url.origin);
    return (
      target.origin === url.origin &&
      target.pathname.includes("coding-plan") &&
      target.searchParams.get("embedded") === "app" &&
      !target.pathname.endsWith("/coding-plan/payment/callback")
    );
  } catch {
    return false;
  }
}

interface NotifyPurchaseCompletePayload {
  provider: "zai" | "bigmodel";
}

type CodingPlanReportContext = Record<string, string>;

interface CodingPlanNativeBridge {
  notifyPurchaseComplete(payload: NotifyPurchaseCompletePayload): void;
  openExternal(url: string): void;
}

// Coding Plan guest still reuses the same preload configuration when navigating to PayPal.
// The bridge is only allowed to be exposed to trusted official website purchase pages to prevent third-party authorization pages from inheriting App communication capabilities.
if (isTrustedCodingPlanBridgeLocation()) {
  contextBridge.exposeInMainWorld(NATIVE_BRIDGE_KEY, {
    notifyPurchaseComplete(payload: NotifyPurchaseCompletePayload) {
      try {
        ipcRenderer.sendToHost(CodingPlanWebviewChannels.PurchaseComplete, {
          provider: payload.provider,
          timestamp: Date.now(),
        } satisfies import("@zcode/shared").CodingPlanPurchaseCompletePayload);
      } catch {
        // sendToHost will throw when the host renderer has not been attached or the webview is destroyed;
        // The official web page itself does not rely on the success of this call, it can be silent.
      }
    },
    openExternal(url: string) {
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
        ipcRenderer.send(PlatformChannels.OpenExternal, {
          sourceUrl: window.location.href,
          url: parsed.toString(),
        });
      } catch {
        // Illegal URLs are ignored to prevent official web pages from sending arbitrary IPC payloads through the bridge.
      }
    },
  } satisfies CodingPlanNativeBridge);

  contextBridge.executeInMainWorld({
    func: (
      publicBridgeKey: string,
      nativeBridgeKey: string,
      langVar: string,
      langChangeEvent: string,
      reportContextVar: string,
    ) => {
      const nativeBridge = (
        window as unknown as Record<string, CodingPlanNativeBridge | undefined>
      )[nativeBridgeKey];
      if (!nativeBridge) return;
      const bridge = {
        notifyPurchaseComplete(payload: NotifyPurchaseCompletePayload) {
          if (payload?.provider !== "zai" && payload?.provider !== "bigmodel") {
            return;
          }
          nativeBridge.notifyPurchaseComplete(payload);
        },
        // Returns the current locale of the App; it is null when the App has not been injected (the website determines whether to embed the environment based on this).
        getLang() {
          // Note: The func body of executeInMainWorld is not compiled by TS, and TS syntax such as as assertion cannot be used.
          const value = (window as unknown as Record<string, unknown>)[langVar];
          return value === "en-US" ? value : null;
        },
        getReportContext() {
          const value = (window as unknown as Record<string, unknown>)[reportContextVar];
          if (!value || typeof value !== "object" || Array.isArray(value)) {
            return null;
          }
          return value as CodingPlanReportContext;
        },
        // Subscribe to App locale runtime changes and return the unsubscribe function.
        // Use executeJavaScript to dispatch the zcode-coding-plan-lang-change event when the App locale changes.
        onLangChange(callback: (locale: "en-US") => void) {
          const handler = (event: Event) => {
            const detail = (event as CustomEvent<{ locale?: unknown }>).detail;
            if (detail && detail.locale === "en-US") {
              callback(detail.locale);
            }
          };
          window.addEventListener(langChangeEvent, handler);
          return () => window.removeEventListener(langChangeEvent, handler);
        },
        openExternal(url: string) {
          nativeBridge.openExternal(url);
        },
      };
      Object.defineProperty(window, publicBridgeKey, {
        value: bridge,
        writable: false,
        configurable: false,
        enumerable: false,
      });
    },
    args: [PUBLIC_BRIDGE_KEY, NATIVE_BRIDGE_KEY, LANG_VAR, LANG_CHANGE_EVENT, REPORT_CONTEXT_VAR],
  });
}
