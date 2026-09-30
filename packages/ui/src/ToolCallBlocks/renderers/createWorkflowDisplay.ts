import {
  toolCallCreateWorkflowDisplaySchema,
  type ToolCallCreateWorkflowDisplay,
} from "@zcode/shared/zcode-protocol-v4";
import { isPlainRecord } from "@/ToolCallBlocks/renderers/createWorkflowInput.js";

/**
 * Read rules for the output side of the CreateWorkflow tool (display payload and plain-text
 * fallback). Split out of `create-workflow.tsx` (oxlint max-lines 400 limit, same precedent as
 * `createWorkflowInput.ts`): pure functions, no JSX.
 */
// Structured diagnosis only uses the display channel; use packages/shared schema to safely parse raw.display.
// When it is missing or does not match the shape, it will be returned to plain text, never JSON dump, and never crash.
export function readWorkflowDisplay(raw: unknown): ToolCallCreateWorkflowDisplay | null {
  if (!isPlainRecord(raw)) {
    return null;
  }

  const parsed = toolCallCreateWorkflowDisplaySchema.safeParse(raw.display);
  return parsed.success ? parsed.data : null;
}

export function readFallbackOutputText(output: unknown): string | null {
  if (typeof output === "string") {
    const trimmed = output.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (isPlainRecord(output)) {
    for (const key of ["response", "output", "text", "content"] as const) {
      const candidate = output[key];
      if (typeof candidate === "string") {
        const trimmed = candidate.trim();
        if (trimmed.length > 0) {
          return trimmed;
        }
      }
    }
  }

  return null;
}

interface WorkflowDiagnosticPosition {
  line: number;
  column: number;
  message: string;
}

/**
 * Hover text for a compiler feedback row: first the one-liner (what did not happen, who moves
 * next), then one `L{line}:C{col} message` per entry — the same shape as the lines the model
 * received, so a copy can be compared against them directly.
 */
export function formatWorkflowFeedbackTooltip(
  lede: string,
  diagnostics: readonly WorkflowDiagnosticPosition[],
): string {
  return [
    lede,
    ...diagnostics.map(
      (diagnostic) => `L${diagnostic.line}:C${diagnostic.column} ${diagnostic.message}`,
    ),
  ].join("\n");
}

/**
 * Script lines named by diagnostics (first-occurrence order, deduplicated, positive line numbers
 * only): the expanded script tints those line numbers with the warning color.
 */
export function workflowDiagnosticLines(
  diagnostics: readonly WorkflowDiagnosticPosition[],
): number[] {
  const lines = diagnostics.map((diagnostic) => diagnostic.line).filter((line) => line > 0);
  return [...new Set(lines)];
}
