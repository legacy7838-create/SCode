import React, { useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { GithubIcon, Loading03Icon, Cancel01Icon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { useGitHubActivityStore } from "@/store/githubActivityStore.js";

export function WorkspaceGitHubConnectForm({ onClose }: { onClose?: () => void } = {}) {
  const { isLoading, connect } = useGitHubActivityStore();
  const [inputUsername, setInputUsername] = useState("");

  const handleConnectSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (inputUsername.trim()) {
      void connect(inputUsername.trim());
    }
  };

  return (
    <div className="flex flex-col gap-3 py-1">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <div className="flex size-10 items-center justify-center rounded-lg bg-surface border border-border shrink-0">
            <HugeiconsIcon icon={GithubIcon} size={22} strokeWidth={1.5} className="text-foreground" />
          </div>
          <div className="min-w-0 flex-1">
            <h4 className="text-ui-base font-semibold text-foreground">
              GitHub Contribution Activity
            </h4>
            <p className="text-ui-xs text-foreground-subtle mt-0.5">
              Connect your GitHub profile to see your 3-month activity heatmap
            </p>
          </div>
        </div>
        {onClose && (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={onClose}
            title="Close"
            className="size-5.5 text-foreground-subtle hover:text-foreground shrink-0"
          >
            <HugeiconsIcon icon={Cancel01Icon} size={11} />
          </Button>
        )}
      </div>

      <form onSubmit={handleConnectSubmit} className="flex flex-col gap-2 mt-1">
        <div className="flex items-center gap-2">
          <Input
            type="text"
            placeholder="Enter GitHub username (e.g. deepboyearn)"
            value={inputUsername}
            onChange={(e) => setInputUsername(e.target.value)}
            className="h-8.5 text-ui-xs"
          />
          <Button
            type="submit"
            size="sm"
            disabled={isLoading || !inputUsername.trim()}
            className="h-8.5 px-4 text-ui-xs shrink-0"
          >
            {isLoading ? (
              <HugeiconsIcon icon={Loading03Icon} size={14} className="animate-spin" />
            ) : (
              "Connect"
            )}
          </Button>
        </div>

        <div className="flex items-center justify-between text-ui-xs text-foreground-subtlest pt-1 border-t border-border/50">
          <span>Quick connect:</span>
          <button
            type="button"
            onClick={() => void connect("deepboyearn")}
            className="text-primary hover:underline font-medium"
          >
            Connect as @deepboyearn
          </button>
        </div>
      </form>
    </div>
  );
}
