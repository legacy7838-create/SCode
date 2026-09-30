import { z } from "zod";

/** `auto` is reserved as an internal permission; `plan` is only accepted at the legacy-format read boundary. */
export const executionPermissionModeSchema = z.enum(["build", "edit", "yolo", "auto"]);
export const executionStateSchema = z.object({
  mode: executionPermissionModeSchema,
  planEnabled: z.boolean(),
});
export type ExecutionState = z.infer<typeof executionStateSchema>;

/** Pins the legacy request semantics at the admission boundary; it must not be re-interpreted against the current config when the queue is consumed. */
export function resolveExecutionState(
  input: { mode?: string; planEnabled?: boolean },
  current: ExecutionState = { mode: "build", planEnabled: false },
): ExecutionState {
  const mode = executionPermissionModeSchema.safeParse(input.mode);
  return {
    mode: mode.success ? mode.data : current.mode,
    planEnabled:
      input.planEnabled ??
      (input.mode === "plan" ? true : mode.success ? false : current.planEnabled),
  };
}
