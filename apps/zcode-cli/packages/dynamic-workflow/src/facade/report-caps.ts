/**
 * The cap constants of `report`.
 *
 * Split into two modules together with `world-read-caps.ts` because their **enforcement sides differ**: the world-read cap is enforced by
 * the driver (only it can "not produce" — stop ripgrep at 2000 hits), whereas the report cap is enforced by the **engine core** (a report does not go
 * through the driver; it lands in the journal inside the core and is done). One module would make readers think they were enforced by
 * the same side; that the numbers are a contract holds for both.
 *
 * The overflow policy is to **fail the whole run** (`ReportCapExceeded`) rather than to reject a node the way world-read does.
 * This is not a judgement about severity but a **fact about the rejection channel**: `report` returns `void`, and the script has nowhere to `catch`.
 * And precisely because a script author cannot write a recovery path, these two numbers have to be wide enough that a reasonable script never reaches them.
 */

/** The caps on the number of reports per run and on the serialized bytes of a single one. The numbers are the contract (see the top of this module). */
export const REPORT_CAPS = {
  /** The maximum number of `report` calls within one run. */
  maxItemsPerRun: 256,
  /** The maximum number of bytes of a single item after serialization. */
  maxItemSerializedBytes: 32 * 1024,
} as const;
