/*
 * Layer A3 — Agent stdio JSON-RPC round-trip.
 *
 * INTENTIONALLY SKIPPED. The built agent bundle exists
 * (`apps/zcode-cli/packages/cli/dist/zcode.cjs`) and runs, but a headless stdio
 * round-trip needs the full Agent runtime bootstrap (auth/config/workspace) to
 * enter the protocol loop; spawning `zcode.cjs --stdio` in a bare Node process
 * falls through to the interactive TUI ("TUI requires an interactive terminal")
 * rather than speaking protocol on stdout. This seam is exercised by Layer B /
 * later phases once the sidecar host owns that bootstrap — see TEST-HARNESS.md §3.
 * Skipping with a reason (never faking a pass) keeps the parity gate honest.
 */
import test from "node:test";

test("A3: agent stdio JSON-RPC initialize round-trip", {
  skip:
    "requires a bootstrapped Agent stdio host; bare `zcode.cjs --stdio` needs auth/config/workspace " +
    "runtime and drops into the interactive TUI instead of speaking protocol headlessly",
}, async () => {
  // Body intentionally unreachable while skipped.
});
