import type { ZCodeProvider } from "@zcode/shared";

export function resolveWorkspaceHeaderProvider(
  activeTaskProvider: ZCodeProvider | null,
  selectedProvider: ZCodeProvider,
): ZCodeProvider {
  // When the current task is opened, the Header should display the task's own provider;
  // Otherwise, after "Only switch new task provider", it will be mistakenly displayed as a workspace-level selection, which is inconsistent with the current session context.
  return activeTaskProvider ?? selectedProvider;
}
