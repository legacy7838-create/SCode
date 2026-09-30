import { mcpProcessResourceSampleSource } from "./processResourceMcpTelemetrySource.js";
/**
 * Resource sample source registry.
 *
 * When adding a source, create a source file and append a line to the array below,
 * Let merge conflicts of parallel development be pushed down to the level of adjacent rows.
 * Array order does not express dependencies: the same tick fact used by device-level sources is provided by the second-stage `sampleDevice` context.
 */

import { chromiumProcessResourceSampleSource } from "./processResourceChromiumSource.js";
import { cliProcessResourceSampleSource } from "./processResourceCliSource.js";
import { rendererHeapProcessResourceSampleSource } from "./processResourceRendererHeapSource.js";
import type { ProcessResourceSampleSource } from "./processResourceSampleSources.js";
import { selfHeapProcessResourceSampleSource } from "./processResourceSelfHeapSource.js";
import { systemProcessResourceSampleSource } from "./processResourceSystemSource.js";

export const PROCESS_RESOURCE_SAMPLE_SOURCES: readonly ProcessResourceSampleSource[] = [
  chromiumProcessResourceSampleSource,
  systemProcessResourceSampleSource,
  selfHeapProcessResourceSampleSource,
  rendererHeapProcessResourceSampleSource,
  cliProcessResourceSampleSource,
  mcpProcessResourceSampleSource,
];
