/**
 * The cap constants for world-reads.
 *
 * **Execution lives in the driver, the constants in the pure package**, and keeping the two apart is deliberate: only the driver side can "not produce" —
 * having ripgrep stop at 2000 hits beats materializing a million and measuring afterwards. But the constants belong to the contract rather than to
 * driver internals: engine and compile-side cases assert against them, and a number written only inside the driver can merely be copied by tests,
 * so one day the two copies stop being equal.
 *
 * The overflow policy is to **reject the node** (`WorldReadCapExceeded`, which the script can `catch`), never to truncate and add a flag bit.
 * Truncation hands the script a quietly incomplete view of the world, and the script will then fan out from it — and the fan-out is the expensive part.
 */

/** The caps for grep / git.diff / git.log. The numbers are the contract (see the top of this module). */
export const WORLD_READ_CAPS = {
  /**
   * The maximum number of matching files for `files.glob`. glob had no cap of its own before, so the filesystem
   * port's UI-tool-facing default (100, mtime descending) took effect silently — exactly the "silently clipped to the cap" that this registry exists to forbid.
   * Every world-read cap must have a name here.
   */
  globMaxFiles: 2000,
  /** The maximum number of hits for `files.grep`. */
  grepMaxMatches: 2000,
  /** The maximum number of bytes after the `files.grep` results are serialized (**whichever cap is reached first rejects**). */
  grepMaxSerializedBytes: 256 * 1024,
  /** The maximum number of bytes of `git.diff` output. */
  gitDiffMaxBytes: 512 * 1024,
  /** The maximum number of `git.log` entries that may be requested; beyond that it is a structured rejection rather than a silent clip to the cap. */
  gitLogMaxCount: 100,
  /** The number of entries used when `git.log` has no count specified. */
  gitLogDefaultCount: 20,
  /** The maximum number of bytes of `world.run` stdout (reject rather than truncate; detected with a cap+1 probe). */
  runStdoutMaxBytes: 256 * 1024,
  /** The maximum number of bytes of `world.run` stderr (same as above). */
  runStderrMaxBytes: 256 * 1024,
  /** The wall clock (ms) for `world.run` when no timeoutMs is specified. **No cap is applied**: it is designed for tests that genuinely run long. */
  runDefaultTimeoutMs: 300_000,
} as const;
