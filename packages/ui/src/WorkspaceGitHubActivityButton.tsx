import React, { useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { GithubIcon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button.js";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover.js";
import { cn } from "@/components/lib/utils.js";
import { useGitHubActivityStore } from "@/store/githubActivityStore.js";
import { WINDOWS_CAPTION_CONTROL_CLASS } from "@/windowCaptionControls.js";
import { WorkspaceGitHubActivityContent } from "@/WorkspaceGitHubActivityContent.js";

/**
 * GitHub 活跃度弹窗触发按钮：
 * 改为受控 Popover 点击常驻显示，解决原 HoverCard 鼠标移开即消失的问题。
 * 仅在用户再次点击触发按钮或内部 Close（X）按钮时关闭。
 */
export function WorkspaceGitHubActivityButton({
  className,
  useWindowsCaptionSpacing = false,
}: {
  className?: string;
  isDesktop?: boolean;
  useWindowsCaptionSpacing?: boolean;
}) {
  const isConnected = useGitHubActivityStore((s) => s.isConnected);
  const [isOpen, setIsOpen] = useState(false);

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-md"
          className={cn(
            "relative text-foreground hover:bg-hover hover:text-foreground [app-region:no-drag]",
            isOpen && "bg-hover",
            useWindowsCaptionSpacing && WINDOWS_CAPTION_CONTROL_CLASS,
            className,
          )}
          aria-label="GitHub Activity"
        >
          <HugeiconsIcon icon={GithubIcon} size={16} strokeWidth={1.5} className="size-4" />
          {isConnected && (
            <span className="absolute bottom-1 right-1 size-1.5 rounded-full bg-emerald-500 ring-1 ring-background" />
          )}
        </Button>
      </PopoverTrigger>

      <PopoverContent
        align="end"
        side="bottom"
        sideOffset={6}
        className="w-[320px] max-w-[95vw] rounded-xl border border-popover-border bg-popover p-3 shadow-2xl text-popover-foreground pointer-events-auto [app-region:no-drag]"
      >
        <WorkspaceGitHubActivityContent onClose={() => setIsOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}
