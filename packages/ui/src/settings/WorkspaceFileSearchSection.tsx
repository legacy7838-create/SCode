import { useCallback, useEffect, useRef, useState } from "react";
import { FolderOpen, RotateCcw, Save, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Textarea } from "@/components/ui/textarea.js";
import { toast } from "@/components/ui/toast.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsGroupCard } from "@/settings/SettingsPageParts.js";
import { logger } from "@/logger.js";

interface WorkspaceFileSearchSectionProps {
  workspacePath?: string | null;
  workspaceIdentity?: string;
}

type IgnoreFileState = {
  content: string;
  source: "file" | "template";
};

/**
 * Edit page for the workspace file search ignore rules (.zcodeignore). The rules file is the single
 * source of truth for directory exclusions: an edit takes effect as soon as it is saved (the next
 * scan reads the new content); "Sync from .gitignore" and "Restore default rules" are partitioned
 * operations: each rewrites only its own marked section (the gitignore sync section / the default
 * exclusion block), leaving the user's custom rules section untouched; the result is filled into
 * the editor, and still has to be saved before it reaches disk.
 */
export function WorkspaceFileSearchSection({
  workspacePath,
  workspaceIdentity,
}: WorkspaceFileSearchSectionProps) {
  // Prompt directly when there is no workspace, and do not hang the workspace service parsing hook chain (same as SessionPluginReferenceIconBoundary
  // (layered precedent) to avoid unnecessary dependencies on services/tabStore context.
  if (!workspacePath) {
    return <NoWorkspaceFileSearchHint />;
  }
  return (
    <ActiveWorkspaceFileSearchEditor
      workspacePath={workspacePath}
      workspaceIdentity={workspaceIdentity}
    />
  );
}

function NoWorkspaceFileSearchHint() {
  const { intl } = useZCodeIntl();
  return (
    <p className="text-ui-base leading-6 text-foreground-subtle">
      {intl.formatMessage({ id: "settings.workspaceFileSearch.noWorkspace" })}
    </p>
  );
}

function ActiveWorkspaceFileSearchEditor({
  workspacePath,
  workspaceIdentity,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
}) {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const resolution = useWorkspaceServicesResolution(workspacePath, undefined, workspaceIdentity);
  const services = resolution.services;
  const rpcReady = resolution.rpcReady;

  const [loaded, setLoaded] = useState<IgnoreFileState | null>(null);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const loadVersionRef = useRef(0);

  const load = useCallback(async () => {
    if (!workspacePath || !rpcReady) {
      return;
    }
    const version = loadVersionRef.current + 1;
    loadVersionRef.current = version;
    setLoading(true);
    try {
      const result = await services.fileService.readWorkspaceFileSearchIgnore({
        rootPath: workspacePath,
      });
      if (loadVersionRef.current !== version) {
        return;
      }
      setLoaded({ content: result.content, source: result.source });
      setDraft(result.content);
    } catch (error) {
      if (loadVersionRef.current !== version) {
        return;
      }
      logger.warn("[WorkspaceFileSearchSection] read .zcodeignore failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      toast(intl.formatMessage({ id: "settings.workspaceFileSearch.loadFailed" }));
    } finally {
      if (loadVersionRef.current === version) {
        setLoading(false);
      }
    }
  }, [intl, rpcReady, services, workspacePath]);

  // Partition operation: only rewrite the corresponding mark area (sync-gitignore rewrites the gitignore synchronization area; reset-defaults
  // Reset the default excluded segment), the user-defined rule area will not be affected; fill in the edit box with the results, and save them before placing them on the disk.
  const applyTransform = useCallback(
    async (transform: "sync-gitignore" | "reset-defaults") => {
      if (!workspacePath || !rpcReady) {
        return;
      }
      const version = loadVersionRef.current + 1;
      loadVersionRef.current = version;
      try {
        const result = await services.fileService.applyWorkspaceFileSearchIgnoreTransform({
          rootPath: workspacePath,
          transform,
        });
        if (loadVersionRef.current !== version) {
          return;
        }
        // Only the edit box content is updated; loaded remains unchanged, and dirty semantics arise naturally from content differences.
        setDraft(result.content);
      } catch (error) {
        if (loadVersionRef.current !== version) {
          return;
        }
        logger.warn("[WorkspaceFileSearchSection] apply .zcodeignore section transform failed", {
          transform,
          error: error instanceof Error ? error.message : String(error),
        });
        toast(intl.formatMessage({ id: "settings.workspaceFileSearch.transformFailed" }));
      }
    },
    [intl, rpcReady, services, workspacePath],
  );

  useEffect(() => {
    if (!workspacePath || !rpcReady) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoaded(null);
    setDraft("");
    void load();
    // load is a callback that relies on workspace/services; when the workspace is switched, it is reset first and then pulled.
  }, [load, rpcReady, workspacePath]);

  const handleSave = useCallback(async () => {
    if (!workspacePath) {
      return;
    }
    setSaving(true);
    try {
      await services.fileService.writeWorkspaceFileSearchIgnore({
        rootPath: workspacePath,
        content: draft,
      });
      setLoaded({ content: draft, source: "file" });
      toast(intl.formatMessage({ id: "settings.workspaceFileSearch.saved" }));
    } catch (error) {
      logger.warn("[WorkspaceFileSearchSection] save .zcodeignore failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      toast(intl.formatMessage({ id: "settings.workspaceFileSearch.saveFailed" }));
    } finally {
      setSaving(false);
    }
  }, [draft, intl, services, workspacePath]);

  // The saving semantics is "push the contents of the edit box to disk": template state (.zcodeignore has not been created yet) allows saving even if it is not edited.
  // Otherwise, if the user enters the page for the first time without changing anything, he will never be able to create the file; he will click the "Save only if modifications are required" gate after the file has been saved.
  const canSave = loaded === null || loaded.source === "template" || draft !== loaded.content;
  // The "There are unsaved changes" prompt only expresses the real differences (it is not displayed when the template state is not edited).
  const dirty = loaded !== null && loaded.source === "file" && draft !== loaded.content;

  // "Open file location": .zcodeignore is located at the workspace root, and the root directory is where it is.
  // (Pass the directory consistent with the WindowsCaptionMenuButton/ModelTrajectoryPane example).
  // The rule file of the remote workspace is on the remote machine. The local file manager cannot open it and the button is not displayed.
  const isLocalWorkspace = !workspaceIdentity?.trim();
  const revealTargetReady = loaded?.source === "file";
  const handleReveal = useCallback(async () => {
    const result = await platform.openInFileManager(workspacePath);
    if (!result.success) {
      toast(intl.formatMessage({ id: "appHeader.openInFileManagerFailed" }));
    }
  }, [intl, platform, workspacePath]);

  return (
    // Unified standard for layout alignment settings page: Introduction + SettingsGroupCard card,
    // Text unified text-ui-base; textarea retains fixed-width fonts because the content is regular text.
    <div className="space-y-3">
      <div className="text-ui-base font-medium text-foreground-subtle">
        {intl.formatMessage({ id: "settings.workspaceFileSearch.description" })}
      </div>
      <SettingsGroupCard>
        <div className="space-y-3 px-4 py-3">
          {loaded?.source === "template" ? (
            <div className="text-ui-base leading-6 text-foreground-subtle">
              {intl.formatMessage({ id: "settings.workspaceFileSearch.templateHint" })}
            </div>
          ) : null}
          <Textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              // Save shortcut key: Ctrl/Cmd+S in the editor is equivalent to clicking the save button (preventDefault
              // Prevent browser default behavior); the gate is consistent with the button (canSave).
              if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
                event.preventDefault();
                if (canSave && !saving && !loading) {
                  void handleSave();
                }
              }
            }}
            spellCheck={false}
            disabled={loading || saving}
            className="min-h-64 w-full font-mono text-ui-base"
            aria-label={intl.formatMessage({ id: "settings.workspaceFileSearch.editorLabel" })}
            data-testid="workspace-file-search-ignore-editor"
          />
          <div className="flex items-center gap-2">
            <Button
              variant="default"
              size="sm"
              disabled={!canSave || saving || loading}
              onClick={() => void handleSave()}
              data-testid="workspace-file-search-ignore-save"
            >
              <Save className="size-4" />
              {intl.formatMessage({ id: "settings.workspaceFileSearch.save" })}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={loading || saving}
              onClick={() => void applyTransform("sync-gitignore")}
              data-testid="workspace-file-search-ignore-resync"
            >
              <RotateCcw className="size-4" />
              {intl.formatMessage({ id: "settings.workspaceFileSearch.resync" })}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={loading || saving}
              onClick={() => void applyTransform("reset-defaults")}
              data-testid="workspace-file-search-ignore-restore-defaults"
            >
              <Undo2 className="size-4" />
              {intl.formatMessage({ id: "settings.workspaceFileSearch.restoreDefaults" })}
            </Button>
            {isLocalWorkspace ? (
              <Button
                variant="outline"
                size="sm"
                disabled={!revealTargetReady || loading || saving}
                title={
                  revealTargetReady
                    ? undefined
                    : intl.formatMessage({ id: "settings.workspaceFileSearch.revealHint" })
                }
                onClick={() => void handleReveal()}
                data-testid="workspace-file-search-ignore-reveal"
              >
                <FolderOpen className="size-4" />
                {intl.formatMessage({ id: "settings.workspaceFileSearch.reveal" })}
              </Button>
            ) : null}
            {dirty ? (
              <span className="text-ui-base text-foreground-subtle">
                {intl.formatMessage({ id: "settings.workspaceFileSearch.unsaved" })}
              </span>
            ) : null}
          </div>
        </div>
      </SettingsGroupCard>
    </div>
  );
}
