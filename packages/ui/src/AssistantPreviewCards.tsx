import { FileTextIcon, GlobeIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { MessageFileLinkTarget } from "@/components/ai-elements/message.js";
import { useWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  type AssistantPreviewCard,
  type AssistantPreviewCardFileStatService,
  type AssistantPreviewCardsAutoOpenRequest,
  getAssistantPreviewCardFilePath,
  shouldOpenAssistantHtmlInBrowser,
} from "@/lib/assistantPreviewCards.js";
import {
  getAssistantPreviewCardsValidationSignature,
  resolveAssistantPreviewCardsWithoutFileStat,
  resolveValidatedAssistantPreviewCards,
} from "@/lib/assistantPreviewCardValidation.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import { FileDisplayIcon, resolveFileDisplayDescriptor } from "@/lib/fileDisplay.js";
import { OpenSplitButton } from "@/OpenSplitButton.js";

interface AssistantPreviewCardValidationResult {
  visibleCards: AssistantPreviewCard[];
  settled: boolean;
}

function buildAssistantPreviewCardFileSource(
  card: Extract<AssistantPreviewCard, { type: "markdown" | "file" }>,
  scope: {
    workspacePath?: string;
    workspaceIdentity?: string;
    workspaceRemoteSessionId?: string;
  },
): CodeViewerSource {
  return {
    type: "file",
    title: card.title,
    path: card.path,
    ...(scope.workspacePath ? { workspacePath: scope.workspacePath } : {}),
    ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
    ...(scope.workspaceRemoteSessionId
      ? { workspaceRemoteSessionId: scope.workspaceRemoteSessionId }
      : {}),
  };
}

function buildAssistantPreviewPptxAutoOpenRequest(
  visibleCards: readonly AssistantPreviewCard[],
  baseKey: string,
  scope: {
    workspacePath?: string;
    workspaceIdentity?: string;
    workspaceRemoteSessionId?: string;
  },
): AssistantPreviewCardsAutoOpenRequest | null {
  const pptxCards = visibleCards.filter(
    (card): card is Extract<AssistantPreviewCard, { type: "file" }> =>
      card.type === "file" && card.kind === "pptx",
  );
  if (pptxCards.length === 0) return null;

  return {
    // The final card signature corresponding to the stat result must enter the one-time key; if the candidate for the same turn arrives late,
    // The old verification projection will not be mistaken for the new result that has been consumed.
    key: JSON.stringify([baseKey, getAssistantPreviewCardsValidationSignature(pptxCards)]),
    sources: pptxCards.map((card) => buildAssistantPreviewCardFileSource(card, scope)),
  };
}

interface AssistantPreviewCardsProps {
  cards: AssistantPreviewCard[];
  workspacePath?: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  onOpenBrowserUrl?: (url: string) => void;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  /** Desktop completion state generates products: open the PPTX that have passed the verification in this round in batches. */
  autoOpenPptxKey?: string;
  onAutoOpenPptx?: (request: AssistantPreviewCardsAutoOpenRequest) => void;
}

function shouldRenderAssistantPreviewCardAsFile(
  card: AssistantPreviewCard,
  scope: {
    workspaceIdentity?: string;
    workspaceRemoteSessionId?: string;
  },
): boolean {
  const filePath = getAssistantPreviewCardFilePath(card);
  return (
    card.type !== "website" ||
    (card.url.startsWith("file://") &&
      filePath !== null &&
      !shouldOpenAssistantHtmlInBrowser({ path: filePath, ...scope }))
  );
}

function useAssistantPreviewCardValidation(
  cards: AssistantPreviewCard[],
  scope: {
    workspacePath?: string;
    workspaceIdentity?: string;
    workspaceRemoteSessionId?: string;
  } = {},
): AssistantPreviewCardValidationResult {
  const { fileService } = useWorkspaceServices(
    scope.workspacePath,
    scope.workspaceRemoteSessionId,
    scope.workspaceIdentity,
  );
  const cardsSignature = useMemo(() => getAssistantPreviewCardsValidationSignature(cards), [cards]);
  const validationCardsRef = useRef({ cards, signature: cardsSignature });
  // When the timeline is rebuilt, a cards array with the same content but different references will be passed in. If the effect relies on array references, RPC will be initiated repeatedly.
  // The verification snapshot is only replaced when the semantic signature changes; workspace fileService changes will still use the same snapshot for re-verification.
  if (validationCardsRef.current.signature !== cardsSignature) {
    validationCardsRef.current = { cards, signature: cardsSignature };
  }
  const validationCards = validationCardsRef.current.cards;
  const statFreeVisibleCards = useMemo(
    () => resolveAssistantPreviewCardsWithoutFileStat(validationCards),
    [validationCards],
  );
  const [validationResult, setValidationResult] = useState<{
    fileService: AssistantPreviewCardFileStatService | null;
    signature: string;
    visibleCards: AssistantPreviewCard[];
  }>(() => ({
    fileService: null,
    signature: "",
    visibleCards: [],
  }));

  useEffect(() => {
    if (statFreeVisibleCards) {
      return;
    }

    let disposed = false;

    // When switching historical messages, the passed stat result of the previous message will be reused briefly before effect cleaning.
    // Here, the current candidate signatures are verified twice in batches, and are released once after all calculations are completed, to avoid that the file cards are flashed in a batch and then replaced.
    void resolveValidatedAssistantPreviewCards(validationCards, fileService).then(
      (visibleCards) => {
        if (disposed) return;
        setValidationResult({
          fileService,
          signature: cardsSignature,
          visibleCards,
        });
      },
      () => {
        if (disposed) return;
        setValidationResult({
          fileService,
          signature: cardsSignature,
          visibleCards: [],
        });
      },
    );

    return () => {
      disposed = true;
    };
  }, [cardsSignature, fileService, statFreeVisibleCards, validationCards]);

  if (statFreeVisibleCards) {
    return {
      visibleCards: statFreeVisibleCards,
      settled: true,
    };
  }

  const hasCurrentValidation =
    validationResult.fileService === fileService && validationResult.signature === cardsSignature;

  return {
    visibleCards: hasCurrentValidation ? validationResult.visibleCards : [],
    settled: hasCurrentValidation,
  };
}

export function AssistantPreviewCards({
  cards,
  workspacePath,
  workspaceIdentity,
  workspaceRemoteSessionId,
  onOpenBrowserUrl,
  onOpenFileLink,
  onOpenCodeViewer,
  autoOpenPptxKey,
  onAutoOpenPptx,
}: AssistantPreviewCardsProps) {
  const { intl } = useZCodeIntl();
  const { visibleCards, settled } = useAssistantPreviewCardValidation(cards, {
    workspacePath,
    workspaceIdentity,
    workspaceRemoteSessionId,
  });

  useEffect(() => {
    if (!settled || !autoOpenPptxKey || !onAutoOpenPptx) return;

    const request = buildAssistantPreviewPptxAutoOpenRequest(visibleCards, autoOpenPptxKey, {
      workspacePath,
      workspaceIdentity,
      workspaceRemoteSessionId,
    });
    if (!request) return;

    // Auto-opening only consumes the last visible card; this is consistent with 15 candidates, 10 card limit, and Host stat
    // Completely homologous, files that do not exist in the card will not be opened.
    onAutoOpenPptx(request);
  }, [
    autoOpenPptxKey,
    onAutoOpenPptx,
    settled,
    visibleCards,
    workspaceIdentity,
    workspacePath,
    workspaceRemoteSessionId,
  ]);

  if (!settled || visibleCards.length === 0) {
    return null;
  }

  return (
    <div className="flex w-full flex-col gap-3">
      {visibleCards.map((card, index) => (
        <AssistantPreviewCardRow
          key={card.id}
          card={card}
          animationDelayMs={Math.min(index * 36, 240)}
          subtitle={intl.formatMessage({ id: card.subtitleId })}
          workspacePath={workspacePath}
          workspaceIdentity={workspaceIdentity}
          workspaceRemoteSessionId={workspaceRemoteSessionId}
          onOpenBrowserUrl={onOpenBrowserUrl}
          onOpenFileLink={onOpenFileLink}
          onOpenCodeViewer={onOpenCodeViewer}
        />
      ))}
    </div>
  );
}

function AssistantPreviewCardRow({
  card,
  animationDelayMs,
  subtitle,
  workspacePath,
  workspaceIdentity,
  workspaceRemoteSessionId,
  onOpenBrowserUrl,
  onOpenFileLink,
  onOpenCodeViewer,
}: {
  card: AssistantPreviewCard;
  animationDelayMs: number;
  subtitle: string;
  workspacePath?: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  onOpenBrowserUrl?: (url: string) => void;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
}) {
  const filePath = getAssistantPreviewCardFilePath(card);
  const renderAsFile = shouldRenderAssistantPreviewCardAsFile(card, {
    workspaceIdentity,
    workspaceRemoteSessionId,
  });
  const descriptor = filePath ? resolveFileDisplayDescriptor(filePath) : null;
  const fileSource =
    renderAsFile && filePath
      ? {
          type: "file" as const,
          title: card.title,
          path: filePath,
          ...(workspacePath ? { workspacePath } : {}),
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
          ...(workspaceRemoteSessionId ? { workspaceRemoteSessionId } : {}),
        }
      : null;
  return (
    <div
      className="flex w-full items-center gap-3 rounded-xl border border-card-border bg-card p-3 pr-4 text-foreground"
      data-zcode-stream-animate="true"
      style={
        {
          "--zcode-stream-animation-delay": `${animationDelayMs}ms`,
        } as CSSProperties
      }
    >
      <div className="flex size-11 shrink-0 items-center justify-center rounded-md bg-background text-foreground-subtle">
        {!renderAsFile && card.type === "website" ? (
          <GlobeIcon className="size-6" />
        ) : descriptor ? (
          <FileDisplayIcon src={descriptor.fileIconSrc} size={24} />
        ) : (
          <FileTextIcon className="size-6" />
        )}
      </div>
      <div className="min-w-0 flex flex-1 flex-col gap-1">
        <div className="truncate text-ui-base font-medium leading-5">{card.title}</div>
        <div className="truncate text-ui-base leading-5 text-foreground-subtlest">{subtitle}</div>
      </div>
      <OpenSplitButton
        target={
          !renderAsFile && card.type === "website"
            ? {
                type: "website",
                url: card.url,
                // The website card has two sources - html reference card (file://) and localhost
                // Preview card (http(s) live service). localPath direct opening only takes effect on the former; localhost card
                // The URL must continue to be handed over to the browser, otherwise routing/dynamic content will be lost.
                localPath: card.url.startsWith("file:") ? card.filePath : undefined,
              }
            : {
                type: "file",
                path: filePath!,
                title: card.title,
                label: card.title,
                // Preview Card previously did not have CodeViewer scope, remote Linux path
                // It will be passed to the host editor as a local path by OpenSplitButton.
                previewSource:
                  card.type === "website"
                    ? fileSource!
                    : buildAssistantPreviewCardFileSource(card, {
                        workspacePath,
                        workspaceIdentity,
                        workspaceRemoteSessionId,
                      }),
              }
        }
        onOpenBrowserUrl={onOpenBrowserUrl}
        onOpenFileLink={onOpenFileLink}
        onOpenCodeViewer={onOpenCodeViewer}
      />
    </div>
  );
}
