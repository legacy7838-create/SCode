import type { MessagePortLike, MessagePortPayload } from "@zcode/rpc";
import type { HostMessagePort } from "./ipcTypes.js";

/**
 * 将 utilityProcess 服务端口适配为 RPC 层的 MessagePortLike 接口。
 *
 * 传输端口使用 Node EventEmitter 风格 (.on/.off)，而 MessagePortLike 使用 Web 标准风格
 * (addEventListener/removeEventListener)。此适配器弥合两者差异，使 MessagePortProtocol 可以
 * 直接使用转移进来的端口（Electron utilityProcess 或 worker_threads 均满足 HostMessagePort）。
 */
export function wrapElectronPort(port: HostMessagePort): MessagePortLike {
  return {
    addEventListener(_type: "message", listener: (e: { data: MessagePortPayload }) => void) {
      // MessagePortMain 的 message 事件已经是 { data } 结构，直接转发
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
