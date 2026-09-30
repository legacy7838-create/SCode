/**
 * Tauri renderer entry.
 *
 * Mounts the real `@zcode/ui` `<Root>` — the same component the Electron and Web
 * clients mount. The business-service channel (`IServiceAccessor`) is delivered
 * over a WebSocket to `@zcode/server`, exactly as `packages/web/src/main.tsx`
 * does; the host surface (`IPlatformService`) is supplied by `createTauriPlatform`
 * and backed by the Rust command layer where a native operation is involved.
 *
 * This replaces the earlier diagnostic panel: nothing here is a mock. The UI, the
 * services, and the native operations are all real.
 */
import { createRoot } from "react-dom/client";
import {
  AppErrorBoundary,
  Root,
  ZCodeIntlProvider,
  setStreamClientId,
} from "@zcode/ui";
import "@zcode/ui/styles.css";
import { connectViaWebSocket } from "@zcode/client";

import { createTauriPlatform } from "./platform/tauriPlatform.js";

// --- Theme seed (mirrors the Electron/Web first-paint theme resolution) ------
{
  const saved = localStorage.getItem("zcode-theme") || "zai-dark";
  const resolved =
    saved === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : saved === "dark" || saved === "zai-dark"
        ? "dark"
        : "light";
  const appliedTheme =
    saved === "system"
      ? resolved === "dark"
        ? "zai-dark"
        : "zai-light"
      : saved === "dark"
        ? "zai-dark"
        : saved === "light"
          ? "zai-light"
          : saved;
  if (resolved === "dark") document.documentElement.classList.add("dark");
  document.documentElement.classList.toggle("theme-zai-light", appliedTheme === "zai-light");
  document.documentElement.classList.toggle("theme-zai-dark", appliedTheme === "zai-dark");
}

// Linux desktop chrome marker: titlebars are renderer-drawn, so overlays must
// avoid the titlebar hit area (same rationale as the Electron renderer).
const isMacDesktop = navigator.userAgent.includes("Mac");
const isWindowsDesktop = navigator.userAgent.includes("Windows");
const isLinuxDesktop = !isMacDesktop && !isWindowsDesktop;
document.documentElement.classList.toggle("platform-mac-desktop", isMacDesktop);
document.documentElement.classList.toggle("platform-windows-desktop", isWindowsDesktop);
document.documentElement.classList.toggle("platform-linux-desktop", isLinuxDesktop);

const isLocalDevelopmentRuntime = import.meta.env.DEV;
const platform = createTauriPlatform({ isLocalDevelopmentRuntime });

// Stable streaming client id before first render, matching the Electron/Web order.
setStreamClientId(platform.getDeviceId());

const root = createRoot(document.getElementById("root")!);

/**
 * Where the business-service WebSocket lives. Under `tauri dev` the webview is
 * served from Vite (:5199), which proxies `/ws` → `@zcode/server` (:3030). A
 * packaged build serves from a Tauri asset protocol with no proxy, so fall back
 * to the server's default localhost port directly.
 */
function resolveServiceWsUrl(): string {
  const { protocol, host } = window.location;
  if (protocol === "http:" || protocol === "https:") {
    const wsProtocol = protocol === "https:" ? "wss:" : "ws:";
    return `${wsProtocol}//${host}/ws`;
  }
  return "ws://localhost:3030/ws";
}

function ErrorScreen({ message }: { message: string }) {
  return (
    <div style={{ padding: 24, color: "#e2e8f0", fontFamily: "system-ui, sans-serif" }}>
      <h1 style={{ fontSize: 16, margin: "0 0 8px" }}>ZCode could not reach its services</h1>
      <p style={{ opacity: 0.8, margin: "0 0 16px", maxWidth: 520 }}>
        The desktop UI connects to a local ZCode server over WebSocket. It is not
        answering yet.
      </p>
      <pre
        style={{
          background: "#111",
          padding: 12,
          borderRadius: 8,
          overflow: "auto",
          fontSize: 12,
        }}
      >
        {message}
      </pre>
      <button
        type="button"
        onClick={() => window.location.reload()}
        style={{
          marginTop: 16,
          font: "inherit",
          padding: "6px 12px",
          borderRadius: 8,
          border: "1px solid #333",
          background: "#1b2130",
          color: "#e2e8f0",
          cursor: "pointer",
        }}
      >
        Retry
      </button>
    </div>
  );
}

async function bootstrap(): Promise<void> {
  platform.notifyRendererReady();
  try {
    const services = await connectViaWebSocket(resolveServiceWsUrl(), { onClose: () => {} });
    document.title = "ZCode";
    root.render(
      <AppErrorBoundary
        isDesktop
        isMacDesktop={isMacDesktop}
        isWindowsDesktop={isWindowsDesktop}
      >
        <ZCodeIntlProvider>
          <Root
            services={services}
            platform={platform}
            isDesktop
            isMacDesktop={isMacDesktop}
            isWindowsDesktop={isWindowsDesktop}
            assistantCodeCommentCardsEnabled
            supportsSettings
            restoreSession
            supportsEmbeddedBrowser={false}
            allowRemoteWorkspace={false}
          />
        </ZCodeIntlProvider>
      </AppErrorBoundary>,
    );
  } catch (error) {
    root.render(<ErrorScreen message={error instanceof Error ? error.message : String(error)} />);
  }
}

void bootstrap();
