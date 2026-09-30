import { useEffect, useState } from "react";
import { Info, Workflow } from "lucide-react";
import {
  TID_WORKFLOW_LAUNCH_ARG,
  TID_WORKFLOW_LAUNCH_DIALOG,
  TID_WORKFLOW_LAUNCH_ERROR,
  TID_WORKFLOW_LAUNCH_SUBMIT,
  TID_WORKFLOW_LAUNCH_TARGET,
  testId,
  type ZCodeSavedWorkflowEntry,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Input } from "@/components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { Spinner } from "@/components/ui/spinner.js";
import { Switch } from "@/components/ui/switch.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { AutomationRunNowIcon } from "@/settings/AutomationDesignPrimitives.js";
import { SettingsFormTextarea } from "@/settings/SettingsFormTextarea.js";
import {
  findAutomationWorkspaceOptionByKey,
  reconcileAutomationWorkspaceSelectionKey,
  resolveAutomationWorkspaceSelectionKey,
  type AutomationWorkspaceOption,
} from "@/settings/automationWorkspaceOptions.js";
import {
  buildSavedWorkflowArgFields,
  collectSavedWorkflowArgs,
  type SavedWorkflowArgField,
  type SavedWorkflowArgFieldError,
} from "@/settings/saved-workflows/savedWorkflowArgsForm.js";
import type { SavedWorkflowLaunchError } from "@/settings/saved-workflows/useSavedWorkflowLauncher.js";

interface SavedWorkflowLaunchDialogProps {
  entry: ZCodeSavedWorkflowEntry | null;
  /**
   * Both the scope badge and the "Will run immediately in a new session in X" copy need it; it also
   * determines the scope of the launch command.
   */
  scope: "project" | "global";
  /**
   * The project name inside "Will run immediately in a new session in {project}": a project entry
   * uses its owning project name; a global entry uses the fallback name when no "Run in" has been
   * selected (once one is selected, the chosen project's label is used).
   */
  projectLabel: string;
  onOpenChange: (open: boolean) => void;
  onSubmit: (
    entry: ZCodeSavedWorkflowEntry,
    args: Record<string, unknown>,
    target?: AutomationWorkspaceOption,
  ) => void;
  /**
   * The project candidates for "Run in" (only passed in for global workflows). Passing them renders
   * the selector; an empty array means there is no local project to run against — a hint is
   * rendered and submission is disabled. When undefined, the window is verbatim identical to the
   * project-entry one.
   */
  targets?: readonly AutomationWorkspaceOption[];
  /**
   * The project key selected by default (the active project); falls back to the first candidate
   * when it is not among them.
   */
  defaultTargetKey?: string | null;
  /**
   * Launching: the primary button shows loading and is disabled to prevent double clicks
   * (launcher.pending).
   */
  pending?: boolean;
  /**
   * Launch failed: shown in the inline error area (title from reason + the server message); on
   * success the group closes the window and clears it.
   */
  error?: SavedWorkflowLaunchError | null;
}

/**
 * The argument window: header = Workflow icon + name (mono)
 * + scope badge + description; "Run in" (global entries); the argument table; one line of "Will run
 *   immediately in a new session in X"; and the primary button "Run". Clicking "Run" = the GUI
 *   launches it directly (no model turn, no confirmation window): it is disabled while loading, a
 *   failure is shown in the inline error area with the window kept open, and on success the group
 *   closes the window and switches to the new session. Project entries without arguments do not pop
 *   this window (the group launches directly).
 */
export function SavedWorkflowLaunchDialog({
  entry,
  scope,
  projectLabel,
  onOpenChange,
  onSubmit,
  targets,
  defaultTargetKey,
  pending = false,
  error = null,
}: SavedWorkflowLaunchDialogProps) {
  const { intl } = useZCodeIntl();
  const [fields, setFields] = useState<SavedWorkflowArgField[]>([]);
  const [errors, setErrors] = useState<Record<string, SavedWorkflowArgFieldError>>({});
  const [targetKey, setTargetKey] = useState<string | null>(null);

  useEffect(() => {
    setFields(buildSavedWorkflowArgFields(entry?.args));
    setErrors({});
  }, [entry]);

  // Keep still valid selections when candidates change, otherwise fall back to default item, first candidate, or null (reconcile the same set of rules).
  useEffect(() => {
    if (!targets) {
      setTargetKey(null);
      return;
    }
    const defaultOption = defaultTargetKey
      ? findAutomationWorkspaceOptionByKey(targets, defaultTargetKey)
      : undefined;
    setTargetKey((current) =>
      reconcileAutomationWorkspaceSelectionKey(targets, current, defaultOption),
    );
  }, [targets, defaultTargetKey]);

  const hasTargets = targets !== undefined;
  const noLocalProject = hasTargets && targets.length === 0;
  const selectedTarget = targets
    ? findAutomationWorkspaceOptionByKey(targets, targetKey)
    : undefined;
  // "Will run immediately in a new session of {project}": The global file uses the selected "Run in" project name, and the project file uses the name of the project it belongs to.
  const noteProject = selectedTarget?.label ?? projectLabel;

  const scopeBadge = intl.formatMessage({
    id:
      scope === "global"
        ? "workflows.hub.launch.scope.global"
        : "workflows.hub.launch.scope.project",
  });

  const updateField = (name: string, value: string) => {
    setFields((current) =>
      current.map((field) => (field.name === name ? { ...field, value } : field)),
    );
    setErrors((current) => {
      if (!(name in current)) return current;
      const next = { ...current };
      delete next[name];
      return next;
    });
  };

  const handleSubmit = () => {
    if (!entry) return;
    if (noLocalProject || pending) return;
    const collected = collectSavedWorkflowArgs(fields);
    if (!collected.ok) {
      setErrors(collected.errors);
      return;
    }
    onSubmit(entry, collected.args, selectedTarget);
  };

  return (
    <Dialog open={entry !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]" data-testid={TID_WORKFLOW_LAUNCH_DIALOG}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Workflow className="size-4 shrink-0 text-foreground-subtle" aria-hidden="true" />
            <span className="min-w-0 truncate font-mono">{entry?.name}</span>
            <span className="shrink-0 rounded-sm border border-border px-1.5 py-0.5 text-ui-xs font-normal leading-none text-foreground-subtlest">
              {scopeBadge}
            </span>
          </DialogTitle>
          {entry?.description ? (
            <p className="text-ui-sm text-foreground-subtle">{entry.description}</p>
          ) : null}
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            handleSubmit();
          }}
        >
          {hasTargets ? (
            <div className="flex flex-col gap-1.5">
              <span className="text-ui-base font-medium text-foreground">
                {intl.formatMessage({ id: "workflows.hub.launch.target" })}
              </span>
              {noLocalProject ? (
                <p className="text-ui-sm text-foreground-subtle">
                  {intl.formatMessage({ id: "workflows.hub.launch.noLocalProject" })}
                </p>
              ) : (
                <Select value={targetKey ?? undefined} onValueChange={setTargetKey}>
                  <SelectTrigger data-testid={TID_WORKFLOW_LAUNCH_TARGET}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {targets.map((option) => {
                      const key = resolveAutomationWorkspaceSelectionKey(option);
                      return (
                        <SelectItem key={key} value={key}>
                          {option.label}
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
              )}
            </div>
          ) : null}
          {fields.map((field) => {
            const fieldError = errors[field.name];
            const inputId = `workflow-arg-${field.name}`;
            const errorText = fieldError
              ? intl.formatMessage({ id: `workflows.hub.launch.error.${fieldError}` })
              : null;
            return (
              <div key={field.name} className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <div className="flex items-center gap-2">
                      <label
                        htmlFor={inputId}
                        className="font-mono text-ui-base font-medium text-foreground"
                      >
                        {field.name}
                      </label>
                      {field.required ? (
                        <span className="rounded-sm border border-border px-1.5 py-0.5 text-ui-xs leading-none text-foreground-subtlest">
                          {intl.formatMessage({ id: "workflows.hub.launch.required" })}
                        </span>
                      ) : null}
                    </div>
                    {field.description ? (
                      <p className="text-ui-sm text-foreground-subtle">{field.description}</p>
                    ) : null}
                  </div>
                  {field.type === "boolean" ? (
                    <Switch
                      id={inputId}
                      data-testid={testId(TID_WORKFLOW_LAUNCH_ARG, field.name)}
                      checked={field.value === "true"}
                      onCheckedChange={(checked) =>
                        updateField(field.name, checked ? "true" : "false")
                      }
                    />
                  ) : null}
                </div>
                {field.type === "json" ? (
                  <SettingsFormTextarea
                    id={inputId}
                    data-testid={testId(TID_WORKFLOW_LAUNCH_ARG, field.name)}
                    className={cn("min-h-20 font-mono", fieldError && "border-destructive")}
                    value={field.value}
                    aria-invalid={Boolean(fieldError)}
                    onChange={(event) => updateField(field.name, event.target.value)}
                  />
                ) : field.type === "boolean" ? null : (
                  <Input
                    id={inputId}
                    data-testid={testId(TID_WORKFLOW_LAUNCH_ARG, field.name)}
                    type={field.type === "number" ? "number" : "text"}
                    inputMode={field.type === "number" ? "decimal" : undefined}
                    className={cn("font-mono", fieldError && "border-destructive")}
                    value={field.value}
                    aria-invalid={Boolean(fieldError)}
                    onChange={(event) => updateField(field.name, event.target.value)}
                  />
                )}
                {errorText ? <p className="text-ui-sm text-destructive">{errorText}</p> : null}
              </div>
            );
          })}
          <div className="flex items-start gap-2 rounded-lg bg-surface px-3 py-2.5 text-ui-base text-foreground-subtle">
            <span className="flex size-5 shrink-0 items-center justify-center">
              <Info className="size-4" aria-hidden="true" />
            </span>
            <p className="min-w-0 leading-5">
              {intl.formatMessage({ id: "workflows.hub.launch.note" }, { project: noteProject })}
            </p>
          </div>
          {error ? (
            <div
              data-testid={TID_WORKFLOW_LAUNCH_ERROR}
              className="flex flex-col gap-1.5 rounded-lg border border-destructive/40 px-3 py-2.5"
            >
              <p className="text-ui-sm font-medium text-destructive">
                {intl.formatMessage({ id: `workflows.hub.launch.error.${error.reason}` })}
              </p>
              {error.message ? (
                <pre className="min-w-0 overflow-x-auto whitespace-pre-wrap break-words font-mono text-ui-sm text-foreground-subtle">
                  {error.message}
                </pre>
              ) : null}
            </div>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              size="lg"
              disabled={pending}
              onClick={() => onOpenChange(false)}
            >
              {intl.formatMessage({ id: "workflows.hub.launch.cancel" })}
            </Button>
            <Button
              type="submit"
              size="lg"
              data-icon="inline-start"
              data-testid={TID_WORKFLOW_LAUNCH_SUBMIT}
              disabled={noLocalProject || pending}
            >
              {pending ? (
                <Spinner className="size-4" />
              ) : (
                <AutomationRunNowIcon className="size-4" aria-hidden="true" />
              )}
              {intl.formatMessage({ id: "workflows.hub.launch.submit" })}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
