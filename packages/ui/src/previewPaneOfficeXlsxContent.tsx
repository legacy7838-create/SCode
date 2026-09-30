import { useCallback, useEffect, useRef, type KeyboardEvent } from "react";
import { XlsxViewer, setWasmSource, type XlsxViewerController } from "@extend-ai/react-xlsx";
import xlsxWasmUrl from "@extend-ai/react-xlsx/duke_sheets_wasm_bg.wasm?url";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { installDocumentLinkSafety } from "@/lib/officeFilePreview.js";
import { logger } from "@/logger.js";

setWasmSource(xlsxWasmUrl);

function getNextSheetTabIndex({
  currentIndex,
  key,
  tabCount,
}: {
  currentIndex: number;
  key: string;
  tabCount: number;
}): number | null {
  if (tabCount < 1) {
    return null;
  }
  if (key === "Home") {
    return 0;
  }
  if (key === "End") {
    return tabCount - 1;
  }
  if (key === "ArrowLeft") {
    return (currentIndex - 1 + tabCount) % tabCount;
  }
  if (key === "ArrowRight") {
    return (currentIndex + 1) % tabCount;
  }
  return null;
}

function XlsxSheetTabs({ controller, label }: { controller: XlsxViewerController; label: string }) {
  const { activeTabIndex, setActiveTabIndex, tabs } = controller;

  if (tabs.length <= 1) {
    return null;
  }

  const selectTab = (tabIndex: number) => {
    setActiveTabIndex(tabIndex);
    logger.debug("[PreviewPane] excel sheet switched", {
      sheetIndex: tabIndex,
      sheetName: tabs[tabIndex]?.name,
    });
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, tabIndex: number) => {
    const nextTabIndex = getNextSheetTabIndex({
      currentIndex: tabIndex,
      key: event.key,
      tabCount: tabs.length,
    });
    if (nextTabIndex === null) {
      return;
    }

    event.preventDefault();
    selectTab(nextTabIndex);
    const tabButtons =
      event.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="tab"]');
    tabButtons?.item(nextTabIndex).focus();
  };

  return (
    <div
      aria-label={label}
      className="flex min-h-0 shrink-0 gap-1 overflow-x-auto border-b border-border bg-surface px-2 py-1"
      role="tablist"
    >
      {tabs.map((tab, tabIndex) => {
        const isActive = tabIndex === activeTabIndex;
        return (
          <button
            aria-selected={isActive}
            className={cn(
              "h-7 max-w-48 shrink-0 truncate rounded-md px-2 text-ui-sm transition-colors",
              isActive
                ? "bg-selected text-foreground"
                : "text-foreground-subtle hover:bg-hover hover:text-foreground",
            )}
            key={tab.id}
            onClick={() => selectTab(tabIndex)}
            onKeyDown={(event) => handleKeyDown(event, tabIndex)}
            role="tab"
            tabIndex={isActive ? 0 : -1}
            title={tab.name}
            type="button"
          >
            {tab.name}
          </button>
        );
      })}
    </div>
  );
}

function XlsxPreviewError({
  error,
  message,
  sourcePath,
}: {
  error: Error;
  message: string;
  sourcePath: string;
}) {
  useEffect(() => {
    logger.error("[PreviewPane] failed to parse excel file", {
      path: sourcePath,
      error: error.message,
    });
  }, [error, sourcePath]);

  return (
    <div className="p-3 text-sm text-destructive" role="alert">
      {message}
    </div>
  );
}

export function PreviewPaneOfficeXlsxContent({
  buffer,
  errorMessage,
  isDark,
  onOpenBrowserUrl,
  sourcePath,
}: {
  buffer: ArrayBuffer;
  errorMessage: string;
  isDark: boolean;
  onOpenBrowserUrl?: (url: string) => void;
  sourcePath: string;
}) {
  const viewerRef = useRef<HTMLDivElement | null>(null);
  const { intl } = useZCodeIntl();
  const sheetTabsLabel = intl.formatMessage({ id: "codeViewer.excel.sheetTabs" });
  // The default toolbar of react-xlsx hosts both editing actions and sheet tabs.
  // After the preview closes the default toolbar, multi-sheet navigation will be lost, so the read-only sheet tabs are only restored through the toolbar render prop.
  const renderSheetTabs = useCallback(
    (controller: XlsxViewerController) => (
      <XlsxSheetTabs controller={controller} label={sheetTabsLabel} />
    ),
    [sheetTabsLabel],
  );
  useEffect(() => {
    const root = viewerRef.current;
    return root ? installDocumentLinkSafety(root, onOpenBrowserUrl) : undefined;
  }, [onOpenBrowserUrl]);

  return (
    <div
      ref={viewerRef}
      className="h-full min-h-0 w-full min-w-0 overflow-hidden bg-background"
      data-office-preview-kind="excel"
    >
      <XlsxViewer
        file={buffer}
        fileName={sourcePath}
        height="100%"
        isDark={isDark}
        readOnly
        rounded={false}
        showDefaultToolbar={false}
        toolbar={renderSheetTabs}
        loadingState={
          <div
            aria-busy="true"
            className="h-full min-h-0 w-full bg-background"
            data-office-preview-pending
          />
        }
        errorState={(error) => (
          <XlsxPreviewError error={error} message={errorMessage} sourcePath={sourcePath} />
        )}
        fileTooLargeState={() => (
          <div className="p-3 text-sm text-destructive" role="alert">
            {errorMessage}
          </div>
        )}
      />
    </div>
  );
}
