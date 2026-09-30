import type { IpcRenderer } from "electron";

/** Consistent with @arms/rum-electron built-in preload */
const ARMS_RUM_BRIDGE_CHANNEL = "arms:rum-bridge";

type PatchedIpcRenderer = IpcRenderer & { __zcodeArmsIpcPatched?: boolean };

/**
 * SDK browser-reporter sends JSON.stringify(events[]), main process IPC rejects Array.
 * Interception of ipcRenderer.send at the top level of preload does not depend on the creation timing of ArmsEventBridge (autoInject may be later than scheduleArmsBridgePatch).
 */
function expandArmsRumBridgePayloads(payload: string): string[] {
  try {
    const parsed: unknown = JSON.parse(payload);
    if (Array.isArray(parsed)) {
      const expanded: string[] = [];
      for (const item of parsed) {
        if (item && typeof item === "object" && !Array.isArray(item)) {
          expanded.push(JSON.stringify(item));
        }
      }
      return expanded;
    }
  } catch {
    // Non-JSON as is
  }
  return [payload];
}

type ArmsEventBridgeLike = {
  send: (payload: string) => void;
  __zcodeArmsBridgeForwardPatched?: boolean;
};

/**
 * When ARMS frame preload is executed before this preload, the Bridge.send closure is bound to the unpatched ipc.send;
 * Bridge.send itself must be wrapped, unpacking events[] before calling the inner send.
 */
function patchArmsEventBridgeSend(bridge: ArmsEventBridgeLike): void {
  if (bridge.__zcodeArmsBridgeForwardPatched) {
    return;
  }
  const innerSend = bridge.send.bind(bridge);
  bridge.send = (payload: string) => {
    const payloads = expandArmsRumBridgePayloads(payload);
    for (const item of payloads) {
      innerSend(item);
    }
  };
  bridge.__zcodeArmsBridgeForwardPatched = true;
}

function patchArmsEventBridgeIfPresent(): boolean {
  const bridge =
    (globalThis as { ArmsEventBridge?: ArmsEventBridgeLike }).ArmsEventBridge ??
    (typeof window !== "undefined"
      ? (window as { ArmsEventBridge?: ArmsEventBridgeLike }).ArmsEventBridge
      : undefined);
  if (!bridge || typeof bridge.send !== "function") {
    return false;
  }
  patchArmsEventBridgeSend(bridge);
  return true;
}

export function scheduleArmsEventBridgePatch(maxAttempts = 100): void {
  if (patchArmsEventBridgeIfPresent()) {
    return;
  }
  let attempts = 0;
  const tick = (): void => {
    if (patchArmsEventBridgeIfPresent()) {
      return;
    }
    attempts += 1;
    if (attempts < maxAttempts) {
      setTimeout(tick, 10);
    }
  };
  tick();
}

export function installArmsRumBridgeIpcForward(ipc: IpcRenderer): void {
  const patched = ipc as PatchedIpcRenderer;
  if (patched.__zcodeArmsIpcPatched) {
    return;
  }
  const originalSend = ipc.send.bind(ipc);
  patched.send = ((channel: string, ...args: unknown[]) => {
    if (channel === ARMS_RUM_BRIDGE_CHANNEL && args.length > 0 && typeof args[0] === "string") {
      const raw = args[0];
      const payloads = expandArmsRumBridgePayloads(raw);
      if (payloads.length === 0) {
        return;
      }
      if (payloads.length === 1 && payloads[0] === raw) {
        return originalSend(channel, raw);
      }
      for (const item of payloads) {
        originalSend(channel, item);
      }
      return;
    }
    return originalSend(channel, ...args);
  }) as IpcRenderer["send"];
  patched.__zcodeArmsIpcPatched = true;
}
