import type { MessagePortMain } from "electron";
import type { MessagePortLike, MessagePortPayload } from "@zcode/rpc";

/**
 * Adapts Electron's `MessagePortMain` to the RPC layer's `MessagePortLike` interface.
 *
 * Electron's `MessagePortMain` uses the Node EventEmitter style (`.on`/`.off`), while
 * `MessagePortLike` uses the Web standard style (`addEventListener`/`removeEventListener`).
 * This adapter bridges the two so `MessagePortProtocol` can be used directly inside a
 * `utilityProcess`.
 */
export function wrapElectronPort(port: MessagePortMain): MessagePortLike {
  return {
    addEventListener(_type: "message", listener: (e: { data: MessagePortPayload }) => void) {
      // The message event of MessagePortMain is already a {data} structure and can be forwarded directly
      port.on("message", listener);
    },
    removeEventListener(_type: "message", listener: (e: { data: MessagePortPayload }) => void) {
      port.off("message", listener);
    },
    postMessage(data: MessagePortPayload) {
      port.postMessage(data);
    },
    start() {
      port.start();
    },
    close() {
      port.close();
    },
  };
}
