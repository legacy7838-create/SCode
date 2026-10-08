import { useIsOfficeMode } from "@/hooks/useInterfaceMode.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useOnboardingRecordService } from "@/hooks/useOnboardingRecordService.js";
import {
  advanceRecommendedPromptPane,
  getRecommendedPromptsForPane,
  getRecommendedPromptsRevision,
  registerRecommendedPromptPane,
  subscribeRecommendedPrompts,
  unregisterRecommendedPromptPane,
} from "@/v4/featureSuggestedPromptRotation.js";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { cn } from "@/components/lib/utils.js";
import { toast } from "@/components/ui/toast.js";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import type { AutomationsNavigationTab } from "@/lib/taskNavigationHistory.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import {
  ConversationDraftSuggestedPrompts,
  type DraftSuggestedPromptItem,
} from "@/v4/ConversationDraftSuggestedPrompts.js";
import { resolveDraftSuggestedPromptText } from "@/v4/draftSuggestedPromptItems.js";
import {
  DRAFT_SUGGESTED_PROMPT_NAVIGATE_AUTOMATIONS,
  DRAFT_SUGGESTED_PROMPT_NAVIGATE_AUTOMATIONS_OFFPEAK,
} from "@/v4/draftSuggestedPromptItems.js";
import { useDraftSuggestedPromptItems } from "@/v4/useDraftSuggestedPromptItems.js";

export type ConversationDraftSuggestedPromptsContainerProps = {
  className?: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  isDesktop?: boolean;
};

type Props = ConversationDraftSuggestedPromptsContainerProps & {
  proactive?: boolean;
  onOpenAutomations?: (automationTab?: AutomationsNavigationTab) => void;
};

export function ConversationDraftSuggestedPromptsContainer({
  className,
  proactive = false,
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  onOpenAutomations,
}: Props) {
  const { intl, locale } = useZCodeIntl();
  const isOfficeMode = useIsOfficeMode();
  const { update } = useSettings();
  const onboardingRecordService = useOnboardingRecordService();
  const recommendationPaneId = useId();
  const recommendationMode = isOfficeMode ? "office" : "coding";
  const recommendationRevision = useSyncExternalStore(
    subscribeRecommendedPrompts,
    getRecommendedPromptsRevision,
  );
  useEffect(() => {
    if (!proactive) return;
    registerRecommendedPromptPane(recommendationPaneId, recommendationMode);
    return () => unregisterRecommendedPromptPane(recommendationPaneId);
  }, [proactive, recommendationMode, recommendationPaneId]);
  const recommendedItems = useMemo(
    () => getRecommendedPromptsForPane(recommendationPaneId, recommendationMode),
    [recommendationMode, recommendationPaneId, recommendationRevision],
  );
  const [closing, setClosing] = useState(false);
  const closeRecommendations = async () => {
    setClosing(true);
    try {
      await update({ proactiveSuggestionsEnabled: false });
      await onboardingRecordService
        ?.updateRecordPreferences({ proactiveSuggestionsEnabled: false })
        .catch((cause: unknown) => {
          logger.warn("[v4-suggested-prompts] 回写引导记录失败", { error: String(cause) });
        });
    } catch (error) {
      logger.warn("[v4-suggested-prompts] 关闭推荐失败", { error: String(error) });
      toast(intl.formatMessage({ id: "chat.officeSuggestions.closeError" }));
    } finally {
      setClosing(false);
    }
  };
  const resolution = useWorkspaceServicesResolution(
    workspacePath,
    remoteSessionId,
    workspaceIdentity,
  );
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  const allItems = useDraftSuggestedPromptItems({
    clientScenesService: resolution.services.clientScenesService,
    rpcReady: resolution.rpcReady,
    workspaceKey,
  });
  const items = useMemo(
    () =>
      (proactive ? recommendedItems : allItems).filter(
        (item) =>
          !item.actions?.some(
            (action) =>
              action === DRAFT_SUGGESTED_PROMPT_NAVIGATE_AUTOMATIONS ||
              action === DRAFT_SUGGESTED_PROMPT_NAVIGATE_AUTOMATIONS_OFFPEAK,
          ) || Boolean(onOpenAutomations),
      ),
    [allItems, onOpenAutomations, proactive, recommendedItems],
  );

  const replacePlainPrompt = useCallback(
    (prompt: string) => {
      return useZCodeSessionStore
        .getState()
        .requestComposerTextInsert(workspacePath, prompt, workspaceIdentity);
    },
    [workspaceIdentity, workspacePath],
  );

  const handleSelect = useCallback(
    async (item: DraftSuggestedPromptItem) => {
      const prompt = resolveDraftSuggestedPromptText(item.prompt, locale);
      // ARMS 模板点击遥测（reportPromptTemplateClick）随监控链路整体下线，
      // 这里只保留真实的模板插入 / 自动化导航行为。
      if (
        onOpenAutomations &&
        item.actions?.includes(DRAFT_SUGGESTED_PROMPT_NAVIGATE_AUTOMATIONS_OFFPEAK)
      ) {
        onOpenAutomations("idle");
        return;
      }
      if (
        onOpenAutomations &&
        item.actions?.includes(DRAFT_SUGGESTED_PROMPT_NAVIGATE_AUTOMATIONS)
      ) {
        onOpenAutomations();
        return;
      }
      replacePlainPrompt(prompt);
    },
    [locale, onOpenAutomations, replacePlainPrompt],
  );

  return (
    <div data-v4-draft-suggested-prompts-slot="true" className={cn(!proactive && "h-8", className)}>
      <ConversationDraftSuggestedPrompts
        items={items}
        layout={proactive ? "list" : "chips"}
        onSelect={handleSelect}
        onRefresh={proactive ? () => advanceRecommendedPromptPane(recommendationPaneId) : undefined}
        onClose={proactive ? closeRecommendations : undefined}
        disabled={closing}
      />
    </div>
  );
}
