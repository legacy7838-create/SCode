/**
 * Structural typing for the utility-process IPC surface the Host consumes, declared locally so the
 * Host no longer depends on the `electron` ambient types.
 *
 * Under the Tauri port the Host is launched as a plain Node sidecar; the transient Electron
 * `utilityProcess` port objects (a transferred service port and `process.parentPort`) are being
 * replaced by a loopback WebSocket `ChannelServer`. Until that runtime boot lands (Phase 1), the
 * existing `parentPort`/port code paths must keep compiling without the `electron` package. These
 * interfaces capture exactly the members the Host uses; the Electron runtime objects (and a Node
 * `worker_threads` port) satisfy them.
 */
import type { MessagePortPayload } from "@zcode/rpc";

/** A transferred service port (was `Electron.MessagePortMain`). */
export interface HostMessagePort {
  on(event: "message", listener: (e: { data: MessagePortPayload }) => void): void;
  off(event: "message", listener: (e: { data: MessagePortPayload }) => void): void;
  once(event: "close", listener: () => void): void;
  postMessage(message: unknown, ports?: readonly unknown[]): void;
  start(): void;
  close(): void;
}

/** An inbound message on `process.parentPort` (was `Electron.MessageEvent`), carrying transferred ports. */
export interface HostParentMessageEvent {
  data: unknown;
  ports: HostMessagePort[];
}

/** The parent IPC port (was typed via Electron's `process.parentPort` augmentation). */
export interface HostParentPort {
  postMessage(message: unknown, ports?: readonly unknown[]): void;
  on(event: "message", listener: (e: HostParentMessageEvent) => void): void;
  off(event: "message", listener: (e: HostParentMessageEvent) => void): void;
}

declare global {
  namespace NodeJS {
    interface Process {
      /**
       * Utility-process IPC port. Typed as required to mirror Electron's `process.parentPort`
       * declaration so existing call sites keep compiling; at runtime it is absent when the Host runs
       * as a plain Node sidecar, which the surrounding `parentPort?.` / `if (!parentPort)` guards handle.
       */
      parentPort: HostParentPort;
    }
  }
}
