import { contextBridge, ipcRenderer } from "electron";
import { PlatformChannels } from "@zcode/shared";
import { installEmbeddedBrowserWheelForwarding } from "./embeddedBrowserWheel.js";

const BRIDGE_KEY = "__zcodeEmbeddedBrowserJavaScriptDialog__";

if (typeof window !== "undefined") {
  installEmbeddedBrowserWheelForwarding(window, (channel, payload) => {
    ipcRenderer.sendToHost(channel, payload);
  });
}

interface DialogBridgeResult {
  handled: boolean;
  value?: boolean;
}

contextBridge.exposeInMainWorld(BRIDGE_KEY, {
  show(type: "alert" | "confirm", message: string): DialogBridgeResult {
    try {
      const result = ipcRenderer.sendSync(PlatformChannels.EmbeddedBrowserJavaScriptDialog, {
        type,
        message,
      }) as unknown;
      if (typeof result !== "object" || result === null) return { handled: false };
      const candidate = result as Partial<DialogBridgeResult>;
      if (candidate.handled !== true) return { handled: false };
      return {
        handled: true,
        ...(typeof candidate.value === "boolean" ? { value: candidate.value } : {}),
      };
    } catch {
      // When Main is unavailable, it returns to the Chromium native API and cannot swallow the web page Dialog.
      return { handled: false };
    }
  },
});

contextBridge.executeInMainWorld({
  func: (bridgeKey: string) => {
    type Bridge = {
      show: (type: "alert" | "confirm", message: string) => DialogBridgeResult;
    };
    const bridge = (window as unknown as Record<string, Bridge | undefined>)[bridgeKey];
    if (!bridge) return;

    const installedConfirmByWindow = new WeakMap<Window, Window["confirm"]>();
    const observedFrames = new WeakSet<HTMLIFrameElement>();

    const installInWindow = (target: Window): void => {
      try {
        if (installedConfirmByWindow.get(target) === target.confirm) return;
        const nativeAlert = target.alert.bind(target);
        const nativeConfirm = target.confirm.bind(target);
        target.alert = (message?: unknown): void => {
          const text = message === undefined ? "" : String(message);
          const result = bridge.show("alert", text);
          if (!result.handled) nativeAlert(text);
        };
        const wrappedConfirm = (message?: string): boolean => {
          const text = message === undefined ? "" : String(message);
          const result = bridge.show("confirm", text);
          return result.handled ? result.value === true : nativeConfirm(text);
        };
        target.confirm = wrappedConfirm;
        installedConfirmByWindow.set(target, wrappedConfirm);
      } catch {
        // A cross-origin frame does not allow the host to read the Window; it will load the same preload itself during actual navigation.
      }
    };

    const installFrameTree = (target: Window): void => {
      installInWindow(target);
      try {
        for (const frame of target.document.querySelectorAll("iframe")) {
          if (!observedFrames.has(frame)) {
            observedFrames.add(frame);
            frame.addEventListener(
              "load",
              () => {
                if (frame.contentWindow) installFrameTree(frame.contentWindow);
              },
              true,
            );
          }
          if (frame.contentWindow) installFrameTree(frame.contentWindow);
        }
      } catch {
        // The frame tree of cross-source documents is processed by the corresponding frame's own preload.
      }
    };

    installFrameTree(window);
    const observeFrames = (): void => {
      installFrameTree(window);
      const root = window.document?.documentElement;
      if (!root) return;
      // Inherited about:blank iframe without src does not produce document-level navigation, and Electron does not.
      // Execute preload separately for it; after the listening page is inserted, install the same package from the same source parent frame.
      new window.MutationObserver(() => installFrameTree(window)).observe(root, {
        childList: true,
        subtree: true,
      });
    };
    if (window.document?.documentElement) observeFrames();
    else window.addEventListener?.("DOMContentLoaded", observeFrames, { once: true });
  },
  args: [BRIDGE_KEY],
});
