import { useCallback, useEffect, useRef, useState } from "react";
import type {
  GitBranchMutationResult,
  GitLocalBranchListResult,
  GitRepositorySummary,
} from "@zcode/shared";
import { toast } from "@/components/ui/toast.js";
import {
  buildGitBranchAutoCommitMessage,
  getPrimaryGitBranchIssue,
  resolveGitBranchIssueMessageId,
  resolveGitBranchSuccessMessageId,
  summarizeGitBranchIssuePaths,
} from "@/git-branch-switcher/display.js";
import {
  buildGitBranchSwitchAssistState,
  formatGitBranchIssuePathList,
  hasGitCommitIdentity,
  type GitBranchSwitchAssistDialogStep,
  type GitBranchSwitchAssistState,
} from "@/git-branch-switcher/switchAssist.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getErrorMessage } from "@/lib/errorMessage.js";
import { logger } from "@/logger.js";

interface UseGitBranchSwitcherOptions {
  workspacePath: string;
  // gitSummary is the source of truth for HEAD (fed in real time by the file watcher). Its current branch/HEAD ref type is passed in
  // so a possibly stale local branch snapshot can be discarded when the underlying HEAD changes.
  currentBranchName: string | null;
  headRefType: GitRepositorySummary["headRefType"];
  onRefreshGit: () => void;
}

export function useGitBranchSwitcher({
  workspacePath,
  currentBranchName,
  headRefType,
  onRefreshGit,
}: UseGitBranchSwitcherOptions) {
  const { gitService } = useServices();
  const { intl, locale } = useZCodeIntl();
  const numberFormatter = new Intl.NumberFormat(locale);
  const [open, setOpen] = useState(false);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [createBranchName, setCreateBranchName] = useState("");
  const [commitMessage, setCommitMessage] = useState("");
  const [commitError, setCommitError] = useState<string | null>(null);
  const [switchAssistStep, setSwitchAssistStep] = useState<GitBranchSwitchAssistDialogStep | null>(
    null,
  );
  const [switchAssistState, setSwitchAssistState] = useState<GitBranchSwitchAssistState | null>(
    null,
  );
  const [branchesResult, setBranchesResult] = useState<GitLocalBranchListResult | null>(null);
  const [loadingBranches, setLoadingBranches] = useState(false);
  const [mutationPending, setMutationPending] = useState(false);

  const resetSwitchAssistState = useCallback(() => {
    setSwitchAssistStep(null);
    setSwitchAssistState(null);
    setCommitMessage("");
    setCommitError(null);
  }, []);

  const loadBranches = useCallback(async () => {
    setLoadingBranches(true);

    try {
      const nextResult = await gitService.getLocalBranches({ workspacePath });
      setBranchesResult(nextResult);
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      logger.warn("[GitBranchSwitcher] failed to read local branches", {
        workspacePath,
        error: message,
      });
      toast(
        intl.formatMessage({ id: "git.branchSwitcher.error.requestFailed" }, { error: message }),
      );
    } finally {
      setLoadingBranches(false);
    }
  }, [gitService, intl, workspacePath]);

  useEffect(() => {
    setOpen(false);
    setCreateDialogOpen(false);
    setCreateBranchName("");
    setBranchesResult(null);
    resetSwitchAssistState();
  }, [resetSwitchAssistState, workspacePath]);

  const openRef = useRef(open);
  openRef.current = open;
  useEffect(() => {
    // Key business logic: as soon as gitSummary's HEAD changes (e.g. an external command switched branches, or the watcher fed it back in),
    // discard the local branch snapshot cached from the last dropdown open so the bottom branch label falls back to gitSummary.branchName.
    // Otherwise branchesResult.currentBranchName's stale value would shadow the real branch name indefinitely, showing "switched but unchanged".
    // Note: this only resets local UI state — no refresh / RPC is triggered, avoiding reintroducing the refresh<->watcher self-triggering feedback loop.
    if (openRef.current) {
      // The dropdown is open and showing the live list; don't clear it or the list would flicker. Once closed, the next open refetches via loadBranches.
      return;
    }
    setBranchesResult(null);
  }, [currentBranchName, headRefType]);

  useEffect(() => {
    if (!open) {
      return;
    }

    // Key business logic: re-read the branch list every time the dropdown opens, so a successful switch never reuses the stale snapshot from the previous open.
    void loadBranches();
  }, [loadBranches, open]);

  const notifyMutationFailure = useCallback(
    (result: GitBranchMutationResult) => {
      const issue = getPrimaryGitBranchIssue(result.issues);
      const messageId = resolveGitBranchIssueMessageId(issue);
      if (!issue) {
        toast(intl.formatMessage({ id: "git.branchSwitcher.error.unknown" }));
        return;
      }

      if (messageId) {
        const { visiblePaths, remainingCount } = summarizeGitBranchIssuePaths(issue.paths);
        const extraPaths =
          remainingCount > 0
            ? intl.formatMessage(
                { id: "git.branchSwitcher.error.moreFiles" },
                { count: numberFormatter.format(remainingCount) },
              )
            : "";
        toast(
          intl.formatMessage(
            { id: messageId },
            {
              branchName: issue.detail ?? result.branchName ?? "",
              paths: formatGitBranchIssuePathList(locale, visiblePaths),
              extraPaths,
            },
          ),
        );
        return;
      }

      const fallbackMessage = issue.detail?.trim() || issue.message.trim();
      toast(
        fallbackMessage.length > 0
          ? fallbackMessage
          : intl.formatMessage({ id: "git.branchSwitcher.error.unknown" }),
      );
    },
    [intl, locale, numberFormatter],
  );

  const prepareSwitchAssistState = useCallback(
    async (result: GitBranchMutationResult): Promise<boolean> => {
      const nextSwitchAssistState = await buildGitBranchSwitchAssistState({
        gitService,
        workspacePath,
        result,
      });
      if (!nextSwitchAssistState) {
        return false;
      }

      // Key business logic: overwrite-type blocks no longer toast directly; they become a "failure card -> commit -> automatic switch retry" flow.
      // This way the user first sees the actually affected files, then decides whether to commit the current changes and continue.
      setOpen(false);
      setCreateDialogOpen(false);
      setCommitError(null);
      setCommitMessage("");
      setSwitchAssistState(nextSwitchAssistState);
      setSwitchAssistStep("blocked");
      return true;
    },
    [gitService, workspacePath],
  );

  const handleMutationResult = useCallback(
    async (result: GitBranchMutationResult, actionLabel: string) => {
      if (!result.ok) {
        logger.warn("[GitBranchSwitcher] branch change blocked", {
          workspacePath,
          action: result.action,
          branchName: result.branchName,
          issues: result.issues.map((issue) => issue.code),
        });
        if (await prepareSwitchAssistState(result)) {
          return;
        }
        notifyMutationFailure(result);
        return;
      }

      const successMessageId = resolveGitBranchSuccessMessageId(result);
      if (successMessageId && result.branchName) {
        toast(intl.formatMessage({ id: successMessageId }, { branchName: result.branchName }));
      }

      logger.info(`[GitBranchSwitcher] ${actionLabel} succeeded`, {
        workspacePath,
        branchName: result.branchName,
        action: result.action,
        didChange: result.didChange,
        created: result.created,
      });

      setOpen(false);
      setCreateDialogOpen(false);
      setCreateBranchName("");
      resetSwitchAssistState();
      setBranchesResult((current) =>
        current
          ? {
              ...current,
              currentBranchName: result.summary.branchName,
              headRefType: result.summary.headRefType,
              branches: current.branches.map((branch) => ({
                ...branch,
                isCurrent:
                  result.summary.branchName !== null && branch.name === result.summary.branchName,
              })),
            }
          : current,
      );
      // Key business logic: only refresh global Git state when a branch change actually happened.
      // A no-op like switching to the current branch is already a successful result, but there's no need to trigger another full refetch.
      if (result.didChange || result.created) {
        onRefreshGit();
      }
    },
    [
      intl,
      notifyMutationFailure,
      onRefreshGit,
      prepareSwitchAssistState,
      resetSwitchAssistState,
      workspacePath,
    ],
  );

  const switchBranch = useCallback(
    async (targetBranchName: string) => {
      setOpen(false);
      setMutationPending(true);

      try {
        const result = await gitService.switchBranch({
          workspacePath,
          targetBranchName,
        });
        await handleMutationResult(result, "switch branch");
      } catch (error: unknown) {
        const message = getErrorMessage(error);
        logger.warn("[GitBranchSwitcher] switch branch request failed", {
          workspacePath,
          targetBranchName,
          error: message,
        });
        toast(
          intl.formatMessage({ id: "git.branchSwitcher.error.requestFailed" }, { error: message }),
        );
      } finally {
        setMutationPending(false);
      }
    },
    [gitService, handleMutationResult, intl, workspacePath],
  );

  const createBranchAndSwitch = useCallback(async () => {
    const branchName = createBranchName.trim();
    if (branchName.length === 0) {
      toast(intl.formatMessage({ id: "git.branchSwitcher.error.invalidBranchName" }));
      return;
    }

    setMutationPending(true);

    try {
      const result = await gitService.createBranchAndSwitch({
        workspacePath,
        branchName,
      });
      await handleMutationResult(result, "create and switch branch");
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      logger.warn("[GitBranchSwitcher] create and switch branch request failed", {
        workspacePath,
        branchName,
        error: message,
      });
      toast(
        intl.formatMessage({ id: "git.branchSwitcher.error.requestFailed" }, { error: message }),
      );
    } finally {
      setMutationPending(false);
    }
  }, [createBranchName, gitService, handleMutationResult, intl, workspacePath]);

  const openSwitchCommitDialog = useCallback(() => {
    setCommitError(null);
    setSwitchAssistStep("commit");
  }, []);

  const closeSwitchAssistDialog = useCallback(() => {
    resetSwitchAssistState();
  }, [resetSwitchAssistState]);

  const commitAndSwitchBranch = useCallback(async () => {
    if (!switchAssistState) {
      return;
    }

    if (!hasGitCommitIdentity(switchAssistState.identity)) {
      setCommitError(
        intl.formatMessage({
          id: "git.branchSwitcher.commitDialog.identityMissing",
        }),
      );
      return;
    }

    const nextCommitMessage =
      commitMessage.trim() || buildGitBranchAutoCommitMessage(switchAssistState.targetBranchName);

    setCommitError(null);
    setMutationPending(true);

    try {
      logger.info("[GitBranchSwitcher] committing then retrying branch switch", {
        workspacePath,
        targetBranchName: switchAssistState.targetBranchName,
        stagedPathCount: switchAssistState.stagePaths.length,
      });

      if (switchAssistState.stagePaths.length > 0) {
        await gitService.stagePaths({
          workspacePath,
          paths: switchAssistState.stagePaths,
        });
      }
      await gitService.commit({
        workspacePath,
        message: nextCommitMessage,
      });
      onRefreshGit();

      const result = await gitService.switchBranch({
        workspacePath,
        targetBranchName: switchAssistState.targetBranchName,
      });
      await handleMutationResult(result, "commit and switch branch");
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      logger.warn("[GitBranchSwitcher] failed to commit and switch branch", {
        workspacePath,
        targetBranchName: switchAssistState.targetBranchName,
        error: message,
      });
      setCommitError(
        intl.formatMessage(
          { id: "git.branchSwitcher.commitDialog.error.requestFailed" },
          { error: message },
        ),
      );
    } finally {
      setMutationPending(false);
    }
  }, [
    commitMessage,
    gitService,
    handleMutationResult,
    intl,
    onRefreshGit,
    switchAssistState,
    workspacePath,
  ]);

  return {
    open,
    setOpen,
    createDialogOpen,
    setCreateDialogOpen,
    createBranchName,
    setCreateBranchName,
    commitMessage,
    setCommitMessage,
    commitError,
    switchAssistStep,
    switchAssistState,
    branchesResult,
    loadingBranches,
    mutationPending,
    switchBranch,
    createBranchAndSwitch,
    openSwitchCommitDialog,
    closeSwitchAssistDialog,
    commitAndSwitchBranch,
  };
}
