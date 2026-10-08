# SIDECAR-TRANSPORT.md — Electron→Tauri: Host/Agent as sidecars, MessagePort→localhost WS

> Design spike (P2 enabler). READ-only investigation; no source edited. Ground rules from
> AGENTS.md ("spec before implementation", "identify owner & event order", diagram async/remote
> flows) and `PORTING.md`/`INVENTORY.md` §3 apply.

## Headline finding (de-risks the whole phase)

The localhost-WebSocket RPC transport **already exists and is production-tested**. The web/phone
remote-control path drives the *same* `ServiceCollection` over WS RPC today:

- Server side: `packages/server/src/http.ts:44-81` wraps a Node `ws` socket into an `ISocket`;
  `:86-125` `setupChannelServer` builds `SocketProtocol` → `ChannelServer` →
  `services.exposeOnChannelServer(...)`. WS endpoints at `:325-346` (`/ws`, `/ws/host`).
- Client side: `packages/client/src/websocket.ts:23-60` wraps a browser `WebSocket` into `ISocket`;
  `:62-105` `connectViaWebSocket` → `SocketProtocol` → `ChannelClient` → `RemoteServiceAccess`.

`ws@^8.20.0` and `@hono/node-ws` are **already dependencies** of `packages/server` and
`packages/desktop`. The Tauri port does not invent a transport; it runs this exact stack on
127.0.0.1 with a shared secret. **No framing/serialization/service-layer change is required.**

## 1. Current vs target topology

```mermaid
flowchart TB
  subgraph Electron["ELECTRON (today)"]
    M[main: index.ts] -->|utilityProcess.fork\nout/host/index.js\n:219| H[Local Host]
    M -.MessageChannelMain port1/port2\n:581-594.-> R[renderer]
    R -.MessagePort (ServicePort).-> H
    H -->|child_process.spawn\napp-server --stdio\n:367-376| A[Agent CLI zcode.cjs]
  end
  subgraph Tauri["TAURI (target)"]
    RC[Rust core] -->|externalBin sidecar| H2[Local Host\nNode bin]
    RC -->|tauri-plugin-shell| A2[Agent CLI\nNode bin]
    R2[renderer WS client\nconnectViaWebSocket] -->|localhost WS\n127.0.0.1 + token| H2
    H2 -->|stdio JSON-RPC (unchanged)| A2
  end
```

Owner of RPC bytes: `IMessagePassingProtocol` (the waist). Above it = `ChannelServer`/`ChannelClient`
(transport-agnostic). Below it = a pluggable byte pipe. Electron picks `MessagePortProtocol`;
Tauri picks `SocketProtocol`-over-WebSocket (already shipped for web).

## 2. The transport seam (drop-in, zero framing change)

`IMessagePassingProtocol` — `packages/rpc/src/protocol.ts:24-28`:
```ts
interface IMessagePassingProtocol { send(buffer: VSBuffer): void; readonly onMessage: Event<VSBuffer>; }
```
`ChannelServer` consumes only this (`packages/rpc/src/channelServer.ts:22-31`); it never sees the
pipe type. Two implementations coexist:
- `MessagePortProtocol` (`protocol.ts:361-397`) — MessagePort is message-delimited, no framing.
- `SocketProtocol` (`protocol.ts:236-307`) — adds a 13-byte frame header
  (`HEADER_SIZE=13`, `protocol.ts:207`; `writeProtocolMessage` `:222-230`) over a byte stream
  (`ISocket`, `protocol.ts:68-75`) and reassembles via `ChunkStream` (sticky/split handling `:85-177`).

Wiring today: `host/index.ts:1945-1951` = `wrapElectronPort(port)` (`electronPort.ts:11-30`)
→ `MessagePortProtocol` → `new ChannelServer(protocol, "host", 1000, deferInit)`
→ `services.exposeOnChannelServer(server, overrides)`.

**The drop-in:** replace lines 1945-1946 with the Node-`ws` server socket from
`packages/server/src/http.ts:44-92` (`wrapWebSocket` → `SocketProtocol`). The `ChannelServer`
construction, `exposeOnChannelServer`, and the whole service layer are untouched. Renderer side:
swap `connectViaMessagePort` (`packages/client/src/messageport.ts:57`) for `connectViaWebSocket`
(`packages/client/src/websocket.ts:62`). Same `RemoteServiceAccess` surface either way.

## 3. Sidecar packaging

- Host and Agent already build to standalone JS: `packages/desktop/out/host/index.js` (see `out/`
  tree: host/main/preload/scheduler). Agent is `apps/zcode-cli/.../zcode.cjs`
  (`zcodeAgentProcessManager.ts:356`).
- Register both in `tauri.conf.json > bundle > externalBin` (currently `bundle.active:false`, no
  `externalBin` — `tauri.conf.json:26-36`). Tauri copies `<triple>`-suffixed binaries and requires
  the target-triple naming; **ASSUMPTION:** exact on-disk naming/validation confirmed at build time.
- Node runtime: package each as a self-contained binary (`node --experimental-sea-config`, `pkg`,
  or esbuild bundle + a Node runtime). Electron's `process.execPath`+`ELECTRON_RUN_AS_NODE:"1"`
  trick (`zcodeAgentProcessManager.ts:367-376`) is Electron-only and **must** be replaced by the
  sidecar being a real Node executable. Host→Agent `child_process.spawn(cmd, [entry,"app-server",
  "--stdio"])` stdio JSON-RPC contract is language-agnostic and stays verbatim.
- Spawn/lifecycle: Rust launches the Host sidecar on window-create via `tauri-plugin-shell`
  (`Command::sidecar`), passing **WS port + auth token via env/argv**; the Host binds 127.0.0.1 and
  prints its ready port so the renderer can connect. On window-close / app-exit, Rust explicitly
  kills the sidecar process tree — Electron `utilityProcess` auto-killed with main, Tauri does not
  (PORTING.md "Process lifecycle" trap; cf. `disposeHostProcess` force-kill at
  `desktopHostProcess.ts:663-671`, which already waits ≥3.5s so Agent grandchildren reap first).

## 4. Security (single-window-scoped localhost WS)

- Bind `127.0.0.1` only (pass `hostname:"127.0.0.1"` to `serve()`/WS server; `http.ts:466`).
- Per-session shared secret generated by the Rust core, passed to the sidecar (env/argv) and to the
  renderer; validated on WS handshake before `setupChannelServer` runs. This mirrors the existing
  one-shot **host capability** token flow: `http.ts:321` `POST /api/rpc-host-capability` issues a
  capability consumed via `ZCODE_RPC_HOST_CAPABILITY_HEADER` at `:339-345`. Reuse that pattern for
  the desktop secret rather than inventing one.
- Reject non-matching `Origin`/missing token at upgrade (`ws.on("upgrade")` gate); one window = one
  secret = one accepted attachment. Do not expose the port beyond loopback; no bearer token in logs
  (AGENTS.md 日志边界).

## 5. Binary / high-frequency streams

Framed RPC is already binary, not JSON-only: `serialization.ts` tags raw `Uint8Array`/`VSBuffer`
(`DataType.Buffer=2`, `VSBuffer=3`, `:109-117`; written length-prefixed `:160-168`). Node `ws`
supports binary frames: server `ws.send(buffer.buffer)` (`http.ts:68`), client `ws.send(...)`
(`websocket.ts:47`), `binaryType="arraybuffer"` (`websocket.ts:28`). Objects carrying nested
`Uint8Array` (e.g. skill-sync archives) are base64-marked and restored
(`serialization.ts:136-137,220-235`). So `saveFile`/`printToPdf`/screenshot-style payloads keep
their binary semantics over WS; no JSON-only limitation.

## 6. Phased implementation checklist

1. Stand up a loopback WS host *inside* `out/host/index.js`: `wrapWebSocket`→`SocketProtocol`→
   `ChannelServer` (copy `http.ts:44-125`), bind 127.0.0.1, gate on token. Keep MessagePort path
   behind a flag for Electron rollback.
2. Package Host + Agent as externalBin sidecars (Node SEA/pkg); confirm they run standalone.
3. Rust: spawn Host on window-create (port+token via env), print ready port; kill tree on exit.
4. Renderer/`tauriPlatform.ts`: `connectViaWebSocket(wsUrl)` in place of `connectViaMessagePort`.
5. **Smallest end-to-end proof:** one command `subagents.list` round-tripping
   renderer→WS→host→`ServiceCollection`→back (ISubagentsService registration intact per guardrail).
6. Then expand to session/agent flows and the low/med `IPlatformService` methods (P2 scope).

Risks: (a) sidecar orphan processes on crash/close — mitigate with process-tree kill + the ≥3.5s
reap window; (b) port collision across windows — allocate an ephemeral free port per window, pass
it to renderer; (c) Node-single-binary size/startup cost vs utilityProcess — measure in the spike.
Rollback: Electron stays fully intact; the WS host path is additive and flag-gated, so reverting to
MessagePort is a config flip, not a rewrite.

## 7. Alternatives considered

- **Tauri `ipc::Channel`**: native & zero extra ports, but it is JSON/`ArrayBuffer`-oriented and
  cannot be consumed by the Node sidecar (Channel terminates at Rust, not at the Node process) —
  would force the byte pipe into Rust and lose the reusable `SocketProtocol`.
- **Unix domain socket / named pipe**: no port-collision and no TCP; but Windows named-pipe paths
  and webview client support are awkward, and there is no `WebSocket` browser object to reuse —
  loses the already-shipped web code path.
- **localhost WebSocket (recommended)**: reuses the *existing, web- and phone-verified*
  `SocketProtocol`/`ChannelServer`/`ChannelClient` stack verbatim; browser-native `WebSocket` in the
  webview; binary frames supported; the only real cost is loopback port + token hygiene. This is the
  lowest-risk parity-preserving move.
