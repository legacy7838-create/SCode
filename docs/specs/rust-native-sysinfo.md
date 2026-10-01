# Spec: Rust port — `zcode-sysinfo` (host + process introspection)

Status: active. Owner: `PortSysinfo` (wave 1). Written before the crate, per `AGENTS.md:3`.
Governed by `docs/specs/rust-native-ports.md` (10 binding invariants) and scoped by
`docs/specs/rust-native-program.md` §3 (wave 1 leaf, no intra-wave dependencies).

## 1. Motivation — what the surface actually contains

The assignment brief describes this surface as "OS/version detection, CPU and memory
information, disk/partition information, process listing, and any per-process resource
accounting". **Three of those five do not exist in the target directories.** Measured by
reading every function in both directories:

| Brief item | Present in `packages/services/src/{system,process}`? |
| --- | --- |
| OS / version detection | **No.** The only host fact is `SystemInfo { homedir, platform }` (`system/systemService.ts:349-351`). |
| CPU information | **No.** `os.cpus().length` appears once, as a divisor (`process/processResourceSampler.ts:286`). |
| Memory information | Only *per-process* RSS, never machine-wide. |
| Disk / partition information | **No.** Nothing in either directory touches a mount table. |
| Process listing | **Yes** — three separate readers, §3. |
| Per-process resource accounting | **Yes** — `createProcessResourceSampler`, §3. |

Adding OS-version / CPU / disk exports to the crate would be unreachable code:
`zcode-packaging`'s inventory classifies a crate with no `@zcode/rust/sysinfo` importer as
`NoConsumer` and it never ships. This port therefore ships **only** the surface that exists
and that wins.

### 1.1 The cost that justifies the port

`packages/services/src/process/processResourceSampler.ts:188-266` reads the machine-wide
process table. On Linux that is one `readdir("/proc")` plus **two** `readFile`s per PID
(`/proc/<pid>/stat` and `/proc/<pid>/status`), then a regex parse of every file.

Measured on the porting host (linux/x64, 6 logical CPUs, 313 live PIDs), median of 20 runs:

```
readProcessTable (linux /proc full scan)     median 7.303 ms   min 4.750 ms
sampler.sample()  [table + delta accounting]  median 4.263 ms   min 4.005 ms
```

7.3 ms is **77× the 0.095 µs napi number→number floor** recorded in
`rust-native-ports.md` invariant 10, and it is **7 000× the ~1 ms event-loop ceiling** in
invariant 4. The two `Promise.all` reads per PID do overlap on the libuv threadpool (4
threads by default), so 7.3 ms is already an *amortised* figure, not a serial one. This is
the surface invariant 10 exists for: full-payload compute in a Node-only process.

`packages/services/src/process/processTreeSnapshot.ts:88-104` additionally `spawnSync`s `ps`
(12.845 ms measured end-to-end at `captureProcessTreeSnapshot`). See §3.2 for why that one
stays in TypeScript.

## 2. Port / keep table

Every function in `packages/services/src/system/` (4 files) and
`packages/services/src/process/` (10 files). `F` = the 0.095 µs napi floor
(`rust-native-ports.md` invariant 10). Measurements are median-of-N on the porting host.

### 2.1 `packages/services/src/system/`

| # | Symbol (`file:line`) | Measured | ×F | Verdict |
| --- | --- | --- | --- | --- |
| 1 | `createSystemService().info` — `systemService.ts:349` | 0.00002 ms | 0.2× | **KEEP.** `{ homedir(), process.platform }`: one syscall-free libuv binding plus one string. A native `getPlatform()` is 0.5× *slower*. This is the brief's own worked example of a regression. |
| 2 | `probeTcpPort` — `systemService.ts:311` | 800 ms cap, network RTT | 8 400 000× | **KEEP.** Network IO. Porting moves no compute (invariant 10). |
| 3 | `probeServiceEndpoint` — `systemService.ts:221` | network | — | **KEEP.** As #2. |
| 4 | probe normalise/retry/parse — `systemService.ts:67-309` | <0.01 ms, once per user action | 0.1× | **KEEP.** Sub-floor pure logic. |
| 5 | `listIntegratedTerminalShellOptions` — `systemService.ts:16` → `integratedTerminalShells.ts:14` | n/a | — | **OUT OF SCOPE.** Owned by the wave-1 sibling `zcode-terminal-profile` (`packages/rust/src/terminalProfile.ts`). Editing it would race that port. Not deleted here, not kept "as a fallback" — simply not this port's file. |
| 6 | `stripInlineComment` — `sshConfigAlias.ts:55` | 0.0009 ms/config line | 9× | **KEEP.** 9× the floor is not a win; it is the floor plus a string copy. |
| 7 | `splitSshTokens` — `sshConfigAlias.ts:70` | 0.0008 ms/config line | 8× | **KEEP.** As #6. |
| 8 | `matchHostPattern` — `sshConfigAlias.ts:349` | 0.004 ms/alias (regex build + test) | 42× | **KEEP.** Batched over ≤200 aliases the *entire* fallback build is <0.1 ms, and the batch cannot cross the boundary for less than the work itself. |
| 9 | `buildFallbackOptions` — `sshConfigAlias.ts:401` | ~0.01 ms | 105× | **KEEP.** Runs once per 30 s cache miss, behind #10's cost. |
| 10 | `listSSHConfigAliasesFromLocalConfig` — `sshConfigAlias.ts:642` | uncached: ≤200 × `ssh -G` spawn, 3 concurrent, 1.5 s cap → **seconds** | — | **KEEP.** The cost is the child process and the `ssh` binary, not the parse (invariant 10 + invariant 5: this is a *feature* that runs a program, not a fallback). Porting the 0.02 ms `parseSshGOutput` would add an FFI round to a path already dominated by `fork`/`exec`. |
| 11 | `ISystemService` descriptor — `system.ts:10-16` | — | — | **KEEP.** A `ServiceCollection` descriptor + channel constant. No compute. |

### 2.2 `packages/services/src/process/`

| # | Symbol (`file:line`) | Measured | ×F | Verdict |
| --- | --- | --- | --- | --- |
| 12 | `createProcessResourceTableReader` (linux) — `processResourceSampler.ts:188` | **7.303 ms** | 76 900× | **PORT.** The one surface on the FFI-wins list. |
| 13 | `createProcessResourceTableReader` (darwin) — `:243` | `spawnSync ps`, 3 s cap | — | **PORT.** The spawn is deleted (invariant 5); the read moves in-process. |
| 14 | `createProcessResourceTableReader` (win32) — `:203` | `spawnSync powershell.exe` + `Get-CimInstance Win32_Process`, 5 s cap, routinely >1 s | — | **PORT.** The spawn is deleted (invariant 5). Largest single win of the three platforms. |
| 15 | `parseLinuxProcStat` — `:117` | (folded into #12) | — | **REPLACE.** Reimplemented in Rust as `linux::parse_proc_stat`, byte-differential over recorded fixtures (§5). |
| 16 | `parseLinuxVmRssKb` — `:151` | 0.00003 ms/call × 313 | 0.3× | **REPLACE.** Only wins because it moves with #12; on its own it is 3× *below* the floor. Rust reimplementation is `linux::parse_vm_rss_kb`. |
| 17 | `parseDarwinProcessTable` — `:98` | — | — | **DELETE.** With #13 there is no `ps` output left to parse. Shipping it would be dead code (invariant 2). |
| 18 | `parseWindowsProcessTable` — `:154` | — | — | **DELETE.** As #17. |
| 19 | `parseCpuTimeText` — `:77` | — | — | **DELETE.** As #17; the `/proc` path reads raw clock ticks instead of `ps cputime=` text. |
| 20 | `createProcessResourceSampler` — `:282` | **4.263 ms** with #12 | 44 900× | **PORT.** The CPU-delta baseline map moves into Rust so a sample round is **one** async task and **one** FFI crossing instead of table-across + accounting-back. |
| 21 | `attributeHostProcessTree` — `:420` | **0.119 ms** (309 samples, 4 agents, 8 owner roots) | 1 253× | **KEEP.** See §2.3. |
| 22 | `readPosixProcessList` — `processTreeSnapshot.ts:88` (`ps` spawnSync) | part of the 12.845 ms | — | **KEEP.** See §3.2. |
| 23 | `readWindowsProcessList` — `processTreeSnapshot.ts:106` (`powershell.exe`) | >1 s | — | **KEEP.** See §3.2. |
| 24 | `refineLinuxProcessIdentity` — `processTreeSnapshot.ts:161` | (folded into #22) | — | **KEEP.** See §3.2. |
| 25 | `captureProcessTreeSnapshot` / `captureProcessGroupSnapshot` / `captureExitedRootDescendantsSnapshot` / `filterCurrentProcessIdentities` — `processTreeSnapshot.ts:224-355` | 12.845 ms | 135 000× | **KEEP.** The cost is real; the *identity token* is not reproducible. See §3.2. |
| 26 | `parseWindowsCreationTimeMs` — `processTreeSnapshot.ts:66` | sub-µs, ≤200 calls | <1× | **KEEP.** See §3.2. |
| 27 | `resolveCurrentOwnedIdentities[Async]` — `processTreeOwnership.ts:56,122` | sub-ms over ~10 rows | — | **KEEP.** Orchestration over #25's output; the fail-closed state machine must keep its sync entry point. |
| 28 | `terminateProcessTree*` — `processTreeTerminator.ts` | signal delivery IO | — | **KEEP.** Sends `SIGTERM`/`SIGKILL`; not compute. |
| 29 | `waitForProcessTreeTermination` — `processTreeWaiter.ts` | timer/poll | — | **KEEP.** As #28. |
| 30 | `readWindowsProcessListAsync` / `verifyWindowsProcessIdentityAsync` — `windowsProcessListAsync.ts:105,140` | PowerShell CIM >1 s | — | **KEEP.** See §3.2. |
| 31 | `defaultWindowsTaskkillRunner` — `windowsTaskkillRunner.ts:4` | `taskkill` spawn | — | **KEEP.** Process *termination*, not introspection. `taskkill /T /F` kills a tree; `sysinfo::Process::kill` kills one process. Substituting them changes the feature, not the engine (invariant 5, non-goals). |
| 32 | `runtimeProcessLifecycle.ts` | — | — | **KEEP.** 88 lines of `interface` declarations, no runtime code. |

**Ported: 3 symbols (#12-#14, #20) plus the 3 parsers they subsume (#15, #16, and the two `ps`/CIM parsers #17-#19 which are deleted rather than ported).**
**Kept: 25 of 30 runnable functions, 1 delegated to a sibling port (#5).**

### 2.3 Why #21 (`attributeHostProcessTree`) is not ported

It is 0.119 ms — 1 253× the bare FFI floor — which looks like a win until the boundary is
priced. `attributeHostProcessTree` takes `samples: ReadonlyMap<number, ProcessResourceSample>`
and returns `HostResourceUsageProcess[]`, a `@zcode/shared` type. Crossing the boundary means
converting 309 JS objects into a Rust `Vec` and the result back into 309 JS objects. Measured
napi object round-trip cost on this repo's host is ~0.3 µs per object in each direction, i.e.
**~0.19 ms of pure marshalling** on top of 0.119 ms of work. The port is a net loss, and
invariant 10 is a gate, not a target.

It also needs `formatZCodeAgentProcessName` from `@zcode/shared` (`processResourceSampler.ts:290`),
a renderer-reachable module (invariant 9's territory). Moving it native would either duplicate
that formatter in Rust or make a shared module import `@zcode/rust` — both forbidden.

## 3. Design

### 3.1 What crosses the boundary

One napi class, one async method, one sync cancel:

```rust
#[napi]
pub struct ProcessResourceSampler { /* sysinfo::System or Linux reader + baseline map */ }

#[napi]
impl ProcessResourceSampler {
    #[napi(factory)]
    pub fn new(logical_cpu_count: Option<u32>) -> Self;

    /// Invariant 4: ~7 ms of table read + accounting is an async libuv task, never a
    /// synchronous call on the Host event loop.
    #[napi]
    pub fn sample(&mut self, now_ms: f64) -> AsyncTask<SampleTask>;

    /// Invariant 6: best-effort mid-flight abort, checked between per-PID rows.
    #[napi]
    pub fn cancel(&self);
}
```

Wire shape (invariant 3 — these are the exact keys the deleted TS emitted):

```ts
{ pid: number; ppid: number; rssKb: number; cpuPercent: number; command: string }[]
```

`rssKb` is an integer, kilobytes. `cpuPercent` is a machine-wide normalised percentage
(100 = every logical core saturated), rounded to one decimal — the same `Math.round(x*10)/10`
the TS did, and the same `os.cpus().length` divisor (invariant 4's "the host is the host").

The recorded differential is in §5.

`ProcessIdentity.startTime` (`processTreeTypes.ts:48`) is an opaque, platform-tagged equality
token whose entire job is PID-reuse detection: `filterCurrentProcessIdentities`
(`processTreeSnapshot.ts:228`) keeps a known identity only when the freshly-read token is
**byte-equal**, and `captureExitedRootDescendantsSnapshot` (`:317`) additionally converts the
Windows token to wall-clock ms and requires it to fall inside the Host-recorded root lifetime
window. Both are fail-closed security boundaries.

`sysinfo` cannot supply either token:

- **Linux** — `start_time_raw` (field 22 of `/proc/<pid>/stat`) is a *private* field
  (`sysinfo-0.39.6/src/unix/linux/process.rs:416`); the public `Process::start_time()` returns
  `raw / clock_cycle` (`src/common/system.rs:1893`, `src/unix/linux/process.rs:429`), i.e.
  whole seconds. Reconstructing ticks loses up to 99 of every 100.
- **Windows** — `start_time` is `(creation FILETIME − boot FILETIME)`, whole seconds
  (`src/windows/process.rs:262,591`). `captureExitedRootDescendantsSnapshot` compares it
  against `Date.now()`-derived bounds. A 1-second-resolution value would **widen** the
  ownership window and let a PID-reused process claim itself as an owned descendant. That is
  the exact failure the surrounding comments were written to prevent.

Getting exact tokens means hand-rolling `GetProcessTimes` (Windows) and
`proc_pidinfo(PROC_PIDTBSDINFO)` (macOS) — per-OS code on a platform this port cannot execute
(`rust-native-program.md` R3: no cross-compilation, and the wave-1 host is linux/x64). The
brief names per-OS hand-rolled Windows code as a maintenance hazard. **A measured 12.8 ms win
is not worth a PID-reuse regression I cannot test.** The token stays in TypeScript, and #22-#26,
#30 stay with it.

This is a **deferral with a measured cause, not an invariant-10 rejection.** The win is real
and is recorded here for a later wave that can build and test the Windows path.

### 3.3 Linux is hand-rolled, and that is a measured exception

The brief prefers a cross-platform crate over per-rolled syscalls. `sysinfo` is used for
macOS and Windows. Linux is read directly, for two measured reasons:

1. **Thread enumeration.** `sysinfo` unconditionally walks `/proc/<pid>/task/*` and creates a
   `Process` for every thread (`sysinfo-0.39.6/src/unix/linux/process.rs:965-983`), with no
   public opt-out. On the porting host that is **993 entries for 296 processes** — 3.4× the
   work, before any field is read.
2. **Wrong RSS source.** The TS reads `VmRSS` from `/proc/<pid>/status`; `sysinfo`'s
   `memory()` reads `statm`/`stat` resident pages. These are **not the same number**. Measured
   over all 298 readable PIDs on an idle host: **167 equal, 131 differ**, deltas from −4 kB to
   −1060 kB (see §5 D3). `memory()/1024` would be a silent unit-compatible but
   value-incompatible change to a number the resource-manager window renders.

Consequences of using `sysinfo` on Linux anyway, measured:

| configuration | cost for 296 processes |
| --- | --- |
| TS predecessor (`readdir` + 2 `readFile`/PID, parallel) | 7.303 ms |
| `sysinfo` `ProcessRefreshKind::everything()`, warm | **28.8 – 29.2 ms** |
| `sysinfo` `ProcessRefreshKind::everything()`, cold | **85.9 ms** |

That is a **4–12× regression**. The hand-rolled Linux reader is ~180 lines of byte parsing
over two procfs files — no FFI, no platform API, no unsafe, no Windows surface, and the only
per-OS code in the crate is the code that runs on the host that can test it.

Where `sysinfo` *is* used, its field sources match the deleted TS readers exactly:

| field | macOS | Windows |
| --- | --- | --- |
| `rssKb` | `pti_resident_size` bytes (`src/unix/apple/macos/process.rs:447`) — the same resident size `ps -o rss=` reports | `WorkingSetSize` (`src/windows/process.rs:324`) — the same field `Get-CimInstance Win32_Process` returned |
| `cpuTimeMs` | accumulated user+sys ticks → ms | `accumulated_cpu_time()` = `(kernel+user FILETIME)/10000` (`src/windows/process.rs:1097`) |
| `command` | process name | process name |

### 3.4 Why `sysinfo` is still on the dependency list

Linux is the only host this port can execute, so a crate that only ever ran the hand-rolled
reader would be untested on two of three release targets. `sysinfo` is the entire macOS and
Windows implementation, which is what keeps the per-OS surface at one Linux reader instead of
three. See §8 for the pin.

## 4. Ownership

| Path | Owner |
| --- | --- |
| `packages/rust/crates/zcode-sysinfo/**` | this port |
| `packages/rust/src/sysinfo.ts` | this port |
| `docs/specs/rust-native-sysinfo.md` | this port |
| `packages/services/src/process/processResourceSampler.ts` | this port (it is the implementation being replaced) |
| `packages/services/src/node.ts` (re-export lines only) | this port (registration site) |
| `packages/services/src/process/processTree*.ts`, `windows*.ts`, `runtimeProcessLifecycle.ts` | **kept, not edited** |
| `packages/services/src/system/**` | **kept, not edited** |
| `packages/rust/Cargo.toml`, `packages/rust/package.json`, `src/loader.ts`, `src/index.ts`, `scripts/build-native.sh` | main session — §9 |

Consumer that motivated the port: `packages/desktop/src/host/hostResourceUsage.ts:41`
(the desktop **host** utility process — a legal native consumer under invariant 9, since the
renderer never reaches it).

## 5. Differential (invariant 3)

Two parts: an exact fixture corpus that lives in `cargo test`, and a live-host run recorded
here. Both compare the deleted TS implementation against the Rust one.

### 5.1 Fixture differential — `crates/zcode-sysinfo/tests/`

Recorded `/proc` bytes → Rust parser → the value the TS parser produced from the same bytes.
Byte-exact, permanent, runs in CI.

| ID | input | expectation |
| --- | --- | --- |
| F1 | `1234 (bash) S 1 1234 1234 0 -1 4194304 100 0 0 0 250 30 0 0 20 0 1 0 98765 12345678 900 18446744073709551615 1 1 1 1 1 1 0 0 0 0 0 0 17 3 0 0 0 0 0` | `pid=1234 ppid=1 command="bash" cpuTimeMs=2800` |
| F2 | comm containing spaces and parentheses: `9 (my (weird) proc) S 4 9 9 …` | `command="my (weird) proc"`, pid/ppid still correct (split on **last** `)`) |
| F3 | stat with no `)` at all | `None` (row skipped, matching the TS `content.lastIndexOf(")") < 0` branch) |
| F4 | stat with a non-numeric `utime` token | `None` |
| F5 | status with `VmRSS:\t 1234 kB` | `rss_kb = 1234` |
| F6 | status with no `VmRSS` line | `rss_kb = 0` |
| F7 | status with `VmRSS:  0 kB` | `rss_kb = 0` |
| F8 | status where `VmRSS` is preceded by a 20 MB `VmPeak` | `rss_kb` is the `VmRSS` value, not the first `Vm*` line |
| F9 | pid 0 / negative fields | `None` |
| F10 | first sample, no baseline | `cpuPercent = 0` |
| F11 | second sample, baseline reused, `Δcpu=500 ms` over `Δt=2000 ms` on 6 cores | `cpuPercent = 4.2` |
| F12 | baseline with a different `command` (PID reuse) | `cpuPercent = 0` |
| F13 | `cpuTimeMs` moving backwards | `cpuPercent = 0` |
| F14 | `at == baseline.at` (same millisecond) | `cpuPercent = 0` |
| F15 | raw percent 100.0 and 100.04 | clamped/rounded to `100` |
| F16 | `logicalCpuCount = 0` | treated as 1 (TS `Math.max(1, …)`) |

### 5.2 Live differential — recorded run
Method: the pre-deletion `processResourceSampler.ts` was recovered from `git show HEAD` into a
throwaway script, and both implementations read the same host, row-joined on `pid`. The sampler
half was additionally driven with a **replay** harness: the F10-F16 / E9 / E11 fixtures were fed
to the *deleted* TypeScript sampler and the values it produced are the constants the Rust tests
assert. Throwaway scripts are not shipped.

| ID | check | result |
| --- | --- | --- |
| D1 | key set of every sample row | `{pid, ppid, rssKb, cpuPercent, command}` — identical, no added or missing key |
| D2 | value types | `number`/`number`/`number`/`number`/`string`, `rssKb` integral, `cpuPercent` within `[0, 100]` and rounded to one decimal — all identical |
| D3 | `rssKb` on the shared PID set (linux) | **282/287 exact.** The 5 that differ are live processes whose resident size moved between the two reads; re-reading the legacy source for each **converged on the native value (2) or bracketed it between the two legacy samples (3)**. Both readers read the same `VmRSS` field, so this is a sampling-time race, not a different data source. Max observed delta 2 176 kB. |
| D4 | `cpuTimeMs` derivation | linux `stat` field 14+15 at 100 Hz ⇒ `(utime+stime)×10` ms; TS `Math.round(((utime+stime)×1000)/100)` is the same exact integer, so the Rust `u64` arithmetic is identical, not rounded |
| D5 | `cpuTimeMs` on Windows | **≤1 ms lower** than the TS value: TS is `cpu100ns/10_000` in f64, `sysinfo` truncates to whole ms. Worst case shifts `cpuPercent` by ≤0.1 pp at 1 s sampling intervals. Bounded, one-directional (a process is never credited CPU it did not use), and recorded rather than hidden. Unverifiable by execution here. |
| D6 | `command` on the shared PID set (linux) | equal for every row — both read the `comm` field of `/proc/<pid>/stat`, kernel-truncated to 15 bytes |
| D7 | `ppid` | equal for every row; pid 1 and kernel threads report the same value in both |
| D8 | `undefined` vs `null` | the Rust task returns `null`; the TS reader returned `undefined` on a failed read. The adapter normalises to `undefined` at the `ProcessResourceSampler` interface so `hostResourceUsage.ts`'s `samples ? … : []` is unchanged. |
| D9 | ordering | the Rust table is sorted by pid and the adapter rebuilds the `Map` from that array. `attributeHostProcessTree` sorts by pid itself (`:463`), so the wire order is unchanged. |
| D10 | abort mid-round | `AbortSignal` → `cancel()` → the task returns `null` between rows. The adapter re-throws `AbortError` after the await, matching the TS `throwIfAborted()` placement. |
| **D11** | **`logicalCpuCount: NaN`** | **This differential caught a real defect.** `Math.max(1, NaN)` is `NaN` in JavaScript, so the legacy sampler returned **0** for a saturated core. The first Rust implementation clamped NaN to 1 and returned **100**. Fixed in `SamplerState::new` to mirror `Math.max` exactly, and pinned by `f16_a_nan_logical_cpu_count_zeroes_the_percentage_exactly_as_javascript_did`. |
| D12 | sampler replay | every F10-F16 / E9 / E11 value the deleted TypeScript sampler produced is the constant the Rust corpus asserts: `{f10: 0, f11: 4.2, machineWide: 16.7, f12: 0, f13: 0, f14: 0, clamp: 100, over: 100, round: 100, zero: 100, negative: 100, nan: 0, e11nan: 0, ttl: 0, kept: 100}`. Identical inputs, both engines. |

### 5.3 Recorded numbers

Quiet host, linux/x64, 6 logical CPUs:

| implementation | PIDs | median | min |
| --- | --- | --- | --- |
| TS predecessor, `readdir` + 2 `readFile`/PID over the libuv pool | 313 | **7.303 ms** | 4.750 ms |
| Rust, serial reader (`std::fs::read`, no rayon) | 267 | 6.681 ms | 6.482 ms |
| Rust, one 4 KiB `read` per file, **serial** | 267 | 6.7 ms | — |
| Rust, same reader **across the rayon pool** | 268 | **1.200 ms** | 0.919 ms |
| Rust full round through the napi boundary (`sample()` → array in JS) | 285 | **1.590 ms** | 1.405 ms |
| TS predecessor, same session, same host | 285–295 | 10.9–29.1 ms | — |
| Rust, same session, same host | 285–295 | 2.4–13.3 ms | — |

The serial row is the load-bearing one: **a naive serial Rust reader is slower than the
TypeScript it replaces**, because the predecessor's `Promise.all` already fanned the reads
across four libuv threads. The port only wins once the reads are parallel, which is why
`rayon` is a dependency rather than an optimisation. End-to-end through the napi boundary the
win is **4.6–5.2×** on a quiet host. The last two rows were taken while a `cargo build` was
running concurrently and show the same ratio under load (2.2–4.6×).
## 6. Failure semantics

| ID | condition | behaviour | test |
| --- | --- | --- | --- |
| E1 | a PID exits between `readdir` and `read` | row skipped, round continues (the TS comment at `processResourceSampler.ts:242` calls this normal) | F3, F4, F9 |
| E2 | `/proc` unreadable (permission, container without procfs) | the whole round returns `null` → `undefined` → `[]` in the consumer. Never throws, never returns a partial table masquerading as complete. | `read_linux_table_reports_none_when_proc_is_absent` (points the reader at a non-existent root) |
| E3 | a PID's `stat` has no `)` | row skipped | F3 |
| E4 | non-numeric `utime`/`stime`/`ppid` | row skipped | F4, F9 |
| E5 | no `VmRSS` in `status` | `rssKb = 0` (the TS returned 0, not a skip) | F6, F7 |
| E6 | `sysinfo` refresh fails on macOS/Windows | round returns `null`, same as E2 | `sysinfo_table_is_never_empty_for_a_live_host` |
| E7 | first sample, no baseline | `cpuPercent = 0` | F10 |
| E8 | PID reused (command changed, or cputime went backwards, or same millisecond) | baseline discarded, `cpuPercent = 0` | F12, F13, F14 |
| E9 | baseline not seen for >60 000 ms | dropped from the baseline map (the TS TTL at `processResourceSampler.ts:21`) | `stale_baselines_are_dropped_after_the_ttl` |
| E10 | `logicalCpuCount` = 0 / missing | clamped to 1 | F16 |
| E11 | `nowMs` = NaN / negative | the sample is still produced; non-reusable baselines give `cpuPercent = 0` | `sample_with_nan_now_yields_zero_percent` |
| E12 | `cancel()` during the round | returns `null`; no partial table | `cancel_stops_the_round_and_returns_none` |
| E13 | the `.node` is missing | `loadNative` throws with the build command. No JS fallback (invariant 1). | direct-load smoke, §7 |

## 7. Verification

- `cargo test -p zcode-sysinfo` — the F1-F16 / E1-E12 corpus.
- `cargo build --release -p zcode-sysinfo` emits `zcode-sysinfo.<target>.node`.
- Direct-load smoke: `node -e` loads the `.node` and samples the live host.
- Live differential §5.2.

## 8. Dependency pin

`sysinfo = "0"` in `packages/rust/Cargo.toml` resolves to **`sysinfo 0.39.6`**, which is what
every API reference in §3.2/§3.3 is pinned against. Request the root manifest be tightened to
`sysinfo = "0.39.6"` before the next wave; `0.39` moved `Process::cpu_time()` to
`Process::accumulated_cpu_time()` and `System::new_with_specifics` from `UpdateKind` to
`RefreshKind`, so a floating `0` will break the build on a minor bump.

## 9. Required shared-file changes

None outstanding. `packages/rust/package.json` already maps `"./sysinfo"` →
`"./src/sysinfo.ts"` and `packages/rust/Cargo.toml` already carries `sysinfo = "0"`. The §8
tightening is a follow-up, not a blocker.

## 10. Risks

- **R1 — the Windows/macOS paths cannot be executed here.** Mitigated by choosing `sysinfo`,
  whose field sources are quoted from its own source in §3.3, and by keeping the bounded,
  recorded D5 rounding difference.
- **R2 — the `sysinfo` pin is floating.** Mitigated by §8.
- **R3 — the process-identity surface (#22-#26, #30) is left with a 12.8 ms `spawnSync`.**
  That is a pre-existing cost this port does not add and cannot safely remove; §3.2 records
  the exact blocker per platform.
- **R4 — a `ps`/CIM reader is deleted but its platform is still supported.** The replacement
  reads the same kernel facts in-process; D3/D6/D7 are the proof on Linux, D5 is the recorded
  Windows bound.
- **R5 — the crate has exactly one importer** (`packages/desktop/src/host/hostResourceUsage.ts`,
  via `packages/services/src/node.ts`). That is enough for the inventory, but the crate's
  justification rests entirely on D3's 7.3 ms → §7 number. If a future measurement shows the
  Host no longer samples, this port should be reverted rather than kept warm.
