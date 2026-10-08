# ws-rpc-roundtrip PoC

Headless proof that the transport-agnostic RPC (`@zcode/rpc`) runs over a plain
localhost WebSocket — validating the key claim in
[`../SIDECAR-TRANSPORT.md`](../SIDECAR-TRANSPORT.md): a future Tauri Local-Host
sidecar can reuse `SocketProtocol` + `ChannelServer` + `connectViaWebSocket`
verbatim, with no Electron MessagePort and no GUI.

- Server wiring mirrors `packages/server/src/http.ts`
  (`wrapWebSocket` → `SocketProtocol` → `ChannelServer` → `registerChannel`).
- Client uses the real `connectViaWebSocket` factory from `packages/client`.
- Service: the real `ISubagentsService` descriptor channelName, backed by a
  minimal stub `list()` so it stays self-contained.

## Run

```
cd /media/hdd1/ZCode && npx tsx packages/desktop/tauri-port/poc/ws-rpc-roundtrip.ts
```

Expected on success: `POC PASS: <n>ms round-trip`. On failure: exact error +
diagnosis, then `POC BLOCKED`. Binds `127.0.0.1` only (ephemeral port).
