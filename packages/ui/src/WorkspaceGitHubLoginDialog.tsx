import React, { useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  GithubIcon,
  Loading03Icon,
  ExternalLinkIcon,
  Key01Icon,
  Shield01Icon,
  CommandLineIcon,
  Copy01Icon,
  Tick01Icon,
  ClipboardIcon,
} from "@hugeicons/core-free-icons";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { cn } from "@/components/lib/utils.js";
import { useGitHubActivityStore } from "@/store/githubActivityStore.js";
import { toast } from "@/components/ui/toast.js";

/**
 * GitHub 登录对话框：
 * 支持两种认证途径：
 * 1. GitHub CLI (`gh auth token`)：开发者无需手动去网页生成 Token，直接从本地 gh cli 导入。
 * 2. 网页 Personal Access Token (PAT)：通过预配置权限链接在 GitHub 生成 Token 后粘贴。
 */
export function WorkspaceGitHubLoginDialog({
  isOpen,
  onClose,
}: {
  isOpen: boolean;
  onClose: () => void;
}) {
  const { login, profile, token: existingToken } = useGitHubActivityStore();
  const [loginMethod, setLoginMethod] = useState<"gh-cli" | "pat">("gh-cli");
  const [tokenInput, setTokenInput] = useState(existingToken || "");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isReadingClipboard, setIsReadingClipboard] = useState(false);
  const [hasCopiedCommand, setHasCopiedCommand] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // 每次打开登录对话框时，同步最新已保存的 token 并清空之前的错误提示
  React.useEffect(() => {
    if (isOpen) {
      setTokenInput(existingToken || "");
      setErrorMsg(null);
      setHasCopiedCommand(false);
    }
  }, [isOpen, existingToken]);

  const handleSubmit = async (e?: React.FormEvent, customToken?: string) => {
    if (e) e.preventDefault();
    const tokenToUse = (customToken ?? tokenInput).trim();
    if (!tokenToUse) {
      setErrorMsg(
        loginMethod === "gh-cli"
          ? "Please paste your GitHub CLI token (starts with gho_ or ghp_)."
          : "Please enter a GitHub Personal Access Token.",
      );
      return;
    }

    setIsSubmitting(true);
    setErrorMsg(null);

    try {
      await login(tokenToUse);
      const currentProfile = useGitHubActivityStore.getState().profile;
      const username = currentProfile?.username || profile?.username || "user";
      toast(
        `GitHub account @${username} logged in successfully! Private repos & contributions enabled.`,
      );
      onClose();
    } catch (err) {
      setErrorMsg(
        err instanceof Error
          ? err.message
          : "Invalid GitHub token. Please verify permissions and try again.",
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const copyGhCommand = async (cmd: string) => {
    try {
      await navigator.clipboard.writeText(cmd);
      setHasCopiedCommand(true);
      toast("Command copied to clipboard!");
      setTimeout(() => setHasCopiedCommand(false), 2000);
    } catch {
      toast("Failed to copy command to clipboard.");
    }
  };

  const handlePasteFromClipboard = async () => {
    try {
      setIsReadingClipboard(true);
      setErrorMsg(null);
      if (!navigator.clipboard?.readText) {
        throw new Error("Clipboard read access is not supported. Please paste manually.");
      }
      const text = await navigator.clipboard.readText();
      const trimmed = text.trim();
      if (!trimmed) {
        throw new Error("Clipboard is empty. Run 'gh auth token' first in your terminal.");
      }
      setTokenInput(trimmed);
      await handleSubmit(undefined, trimmed);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Failed to read token from clipboard.");
    } finally {
      setIsReadingClipboard(false);
    }
  };

  const handleQuickPublicLogin = async () => {
    setIsSubmitting(true);
    setErrorMsg(null);
    try {
      await login();
      toast("Logged in as public GitHub user.");
      onClose();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Failed to log in.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const createTokenUrl =
    "https://github.com/settings/tokens/new?scopes=repo,read:user,user:email&description=ZCode+GitHub+Access";

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      {/*
        用户明确要求：
        1. 严禁 auto closure：在外部点击、生成 Token 切换窗口或悬停离开时不自动关闭对话框。
        2. 提升层级至 z-[101]，遮罩设为 z-[100]，使登录对话框稳居最上层，将底层的 Popover 压入暗色遮罩之下。
      */}
      <DialogContent
        overlayClassName="z-[100]"
        className="z-[101] max-w-md p-5 bg-background border border-border/80 shadow-2xl"
        onPointerDownOutside={(e) => {
          e.preventDefault();
        }}
        onInteractOutside={(e) => {
          e.preventDefault();
        }}
        onEscapeKeyDown={(e) => {
          e.preventDefault();
        }}
      >
        <DialogHeader className="gap-1.5">
          <div className="flex items-center gap-2.5">
            <div className="flex size-9 items-center justify-center rounded-lg bg-surface border border-border shrink-0">
              <HugeiconsIcon icon={GithubIcon} size={20} className="text-foreground" />
            </div>
            <div>
              <DialogTitle className="text-ui-base font-semibold text-foreground">
                Login with GitHub
              </DialogTitle>
              <DialogDescription className="text-ui-xs text-foreground-subtle">
                Access private repositories and include private contributions in your heatmap.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex flex-col gap-3 mt-1">
          {/* 双模式切换：GitHub CLI (gh) 与 Personal Access Token */}
          <div className="grid grid-cols-2 gap-1 rounded-lg bg-surface/70 p-1 border border-border/60">
            <button
              type="button"
              onClick={() => {
                setLoginMethod("gh-cli");
                setErrorMsg(null);
              }}
              className={cn(
                "flex items-center justify-center gap-1.5 rounded-md py-1.5 text-ui-2xs font-medium transition-colors",
                loginMethod === "gh-cli"
                  ? "bg-background text-foreground shadow-xs font-semibold"
                  : "text-foreground-subtle hover:text-foreground",
              )}
            >
              <HugeiconsIcon icon={CommandLineIcon} size={13} />
              <span>GitHub CLI (gh)</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setLoginMethod("pat");
                setErrorMsg(null);
              }}
              className={cn(
                "flex items-center justify-center gap-1.5 rounded-md py-1.5 text-ui-2xs font-medium transition-colors",
                loginMethod === "pat"
                  ? "bg-background text-foreground shadow-xs font-semibold"
                  : "text-foreground-subtle hover:text-foreground",
              )}
            >
              <HugeiconsIcon icon={Key01Icon} size={13} />
              <span>Access Token</span>
            </button>
          </div>

          {loginMethod === "gh-cli" ? (
            /* GitHub CLI 模式 */
            <div className="flex flex-col gap-2.5">
              <div className="flex flex-col gap-1.5 rounded-lg bg-surface/40 border border-border/60 p-2.5 text-ui-2xs">
                <div className="flex items-center justify-between font-medium text-foreground">
                  <span>1. Run in terminal to get active token:</span>
                  <button
                    type="button"
                    onClick={() => void copyGhCommand("gh auth token")}
                    className="inline-flex items-center gap-1 text-primary hover:underline font-semibold"
                  >
                    <HugeiconsIcon icon={hasCopiedCommand ? Tick01Icon : Copy01Icon} size={11} />
                    <span>{hasCopiedCommand ? "Copied!" : "Copy Command"}</span>
                  </button>
                </div>
                <div className="flex items-center justify-between rounded bg-background px-2.5 py-1 border border-border font-mono text-ui-xs text-foreground">
                  <code>gh auth token</code>
                </div>
                <p className="text-[10px] text-foreground-subtlest mt-0.5">
                  Not logged in to gh CLI yet? Run{" "}
                  <button
                    type="button"
                    onClick={() => void copyGhCommand("gh auth login -s repo,read:user")}
                    className="font-mono text-foreground hover:text-primary hover:underline"
                    title="Click to copy login command"
                  >
                    gh auth login -s repo,read:user
                  </button>
                </p>
              </div>

              <div className="space-y-1">
                <div className="flex items-center justify-between text-ui-2xs">
                  <span className="font-medium text-foreground">2. Token input or 1-click import:</span>
                  <button
                    type="button"
                    onClick={() => void handlePasteFromClipboard()}
                    disabled={isSubmitting || isReadingClipboard}
                    className="inline-flex items-center gap-1 text-primary hover:underline font-semibold disabled:opacity-50"
                  >
                    <HugeiconsIcon icon={ClipboardIcon} size={11} />
                    <span>{isReadingClipboard ? "Reading..." : "Paste & Login"}</span>
                  </button>
                </div>
                <Input
                  type="password"
                  placeholder="gho_... (or paste here)"
                  value={tokenInput}
                  onChange={(e) => {
                    setTokenInput(e.target.value);
                    if (errorMsg) setErrorMsg(null);
                  }}
                  className="h-8.5 text-ui-xs font-mono"
                  autoFocus
                />
              </div>
            </div>
          ) : (
            /* PAT 模式 */
            <div className="flex flex-col gap-2.5">
              {/* 权限说明 */}
              <div className="rounded-lg bg-surface/50 border border-border/60 p-2 text-ui-xs space-y-1">
                <div className="flex items-center gap-1.5 font-medium text-foreground text-ui-2xs">
                  <HugeiconsIcon icon={Shield01Icon} size={13} className="text-primary" />
                  <span>Required Permissions:</span>
                  <span className="text-foreground-subtle font-normal">repo, read:user</span>
                </div>
              </div>

              <div className="space-y-1">
                <div className="flex items-center justify-between text-ui-2xs">
                  <label htmlFor="github-pat-input" className="font-medium text-foreground flex items-center gap-1">
                    <HugeiconsIcon icon={Key01Icon} size={12} />
                    <span>Personal Access Token</span>
                  </label>
                  <a
                    href={createTokenUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary hover:underline inline-flex items-center gap-0.5 font-semibold"
                    title="Create a new token with pre-selected scopes"
                  >
                    <span>Generate Token</span>
                    <HugeiconsIcon icon={ExternalLinkIcon} size={11} />
                  </a>
                </div>

                <Input
                  id="github-pat-input"
                  type="password"
                  placeholder="ghp_... or github_pat_..."
                  value={tokenInput}
                  onChange={(e) => {
                    setTokenInput(e.target.value);
                    if (errorMsg) setErrorMsg(null);
                  }}
                  className="h-8.5 text-ui-xs font-mono"
                  autoFocus
                />
              </div>
            </div>
          )}

          {errorMsg && (
            <p className="text-ui-2xs text-destructive font-medium -mt-1">{errorMsg}</p>
          )}

          {/* 操作按钮栏 */}
          <div className="flex items-center justify-between gap-2 pt-1 border-t border-border/50">
            <button
              type="button"
              onClick={handleQuickPublicLogin}
              disabled={isSubmitting}
              className="text-ui-2xs text-foreground-subtlest hover:text-foreground hover:underline"
            >
              Public Only (No Token)
            </button>

            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={onClose}
                disabled={isSubmitting}
                className="h-8 px-3 text-ui-xs"
              >
                Cancel
              </Button>
              <Button
                type="submit"
                size="sm"
                disabled={isSubmitting || !tokenInput.trim()}
                className="h-8 px-4 text-ui-xs"
              >
                {isSubmitting ? (
                  <HugeiconsIcon icon={Loading03Icon} size={14} className="animate-spin" />
                ) : (
                  "Login"
                )}
              </Button>
            </div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
