/**
 * The resource manager "Storage" tab. The data comes from useStorageUsage (a projection of the
 * main-process StorageService through the preload bridge); this component only holds UI selection
 * state: the selected disk, the expanded category details, and the cleanup targets awaiting
 * confirmation.
 */
import { Loader2, RefreshCw } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import {
  groupStorageRootsByVolume,
  type StorageCategoryId,
  type StorageCleanResult,
  type StorageManagementBridge,
  type StorageRootId,
  TID_RESOURCE_MANAGER_STORAGE_RESCAN,
  TID_RESOURCE_MANAGER_STORAGE_SECTION,
  TID_RESOURCE_MANAGER_STORAGE_STATUS,
  TID_RESOURCE_MANAGER_STORAGE_TOTAL,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { useStorageUsage } from "./useStorageUsage.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { formatBytes } from "@/resource-manager/resourceUsageView.js";
import { formatDateTime } from "@/settings/automationFormat.js";
import { StorageCategoryDetail } from "./StorageCategoryDetail.js";
import { StorageCategoryList } from "./StorageCategoryList.js";
import {
  StorageCleanConfirmDialog,
  type StorageCleanConfirmTarget,
} from "./StorageCleanConfirmDialog.js";
import { StorageDiskCard } from "./StorageDiskCard.js";
import { buildStorageLegend, sumCategoriesAcrossRoots } from "./storageCategoryPresentation.js";

export function StorageSection({
  bridge,
  active,
}: {
  /** window.resourceManager.storage exposed by preload; absent means the bridge is unavailable */
  bridge: StorageManagementBridge | undefined;
  /** Whether the tab is active: scanning only happens while active, and switching away cancels it */
  active: boolean;
}) {
  const { intl } = useZCodeIntl();
  const { snapshot, scanning, rescan, clean } = useStorageUsage({ bridge, enabled: active });
  const [selectedGroupKey, setSelectedGroupKey] = useState<string | null>(null);
  const [detailCategory, setDetailCategory] = useState<StorageCategoryId | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<StorageCleanConfirmTarget | null>(null);
  const [cleaningCategory, setCleaningCategory] = useState<StorageCategoryId | null>(null);

  const groups = useMemo(() => groupStorageRootsByVolume(snapshot?.roots ?? []), [snapshot]);
  // The selected volume is derived during the rendering period: when the key clicked by the user becomes invalid (the volume changes after rescanning), it will automatically fall back to the first card without using an effect to write back the state.
  const selectedGroup = groups.find((group) => group.key === selectedGroupKey) ?? groups[0] ?? null;
  const categories = useMemo(
    () => (selectedGroup ? sumCategoriesAcrossRoots(selectedGroup.roots) : []),
    [selectedGroup],
  );
  const totalBytes = (snapshot?.roots ?? []).reduce((sum, root) => sum + root.bytes, 0);
  const status = scanning ? "scanning" : (snapshot?.status ?? "idle");

  const runClean = useCallback(
    async (categoryId: StorageCategoryId) => {
      if (!selectedGroup) return;
      setCleaningCategory(categoryId);
      try {
        // There may be two roots (home and custom data path) on the same volume: clean the same category root by root.
        const rootIds: StorageRootId[] = selectedGroup.roots.map((root) => root.id);
        let merged: StorageCleanResult = {
          freedBytes: 0,
          deletedCount: 0,
          skippedCount: 0,
          failures: [],
        };
        for (const rootId of rootIds) {
          const result = await clean({ rootId, categoryId });
          merged = {
            freedBytes: merged.freedBytes + result.freedBytes,
            deletedCount: merged.deletedCount + result.deletedCount,
            skippedCount: merged.skippedCount + result.skippedCount,
            failures: [...merged.failures, ...result.failures],
          };
        }
        if (merged.deletedCount === 0 && merged.failures.length === 0) {
          toast(intl.formatMessage({ id: "resourceManager.storage.cleanNothing" }));
        } else if (merged.failures.length > 0) {
          toast(
            intl.formatMessage(
              { id: "resourceManager.storage.cleanPartial" },
              { size: formatBytes(merged.freedBytes), count: merged.failures.length },
            ),
          );
        } else {
          toast(
            intl.formatMessage(
              { id: "resourceManager.storage.cleanSuccess" },
              { size: formatBytes(merged.freedBytes) },
            ),
          );
        }
      } catch (error) {
        logger.error("[storage] clean failed", { categoryId, error });
        toast(intl.formatMessage({ id: "resourceManager.storage.cleanFailed" }));
      } finally {
        setCleaningCategory(null);
        setConfirmTarget(null);
      }
    },
    [clean, intl, selectedGroup],
  );

  const requestClean = useCallback(
    (categoryId: StorageCategoryId) => {
      const category = categories.find((item) => item.id === categoryId);
      if (!category || category.cleanability === "none") return;
      if (category.cleanability === "confirm") {
        setConfirmTarget({ categoryId, bytes: category.bytes });
        return;
      }
      void runClean(categoryId);
    },
    [categories, runClean],
  );

  const busy = cleaningCategory !== null;

  if (!bridge) {
    return (
      <div
        data-testid={TID_RESOURCE_MANAGER_STORAGE_SECTION}
        className="rounded-xl border border-destructive/30 bg-card px-4 py-3 text-ui-sm text-destructive"
      >
        {intl.formatMessage({ id: "resourceManager.unavailable" })}
      </div>
    );
  }

  return (
    <div data-testid={TID_RESOURCE_MANAGER_STORAGE_SECTION} className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="min-w-0">
          <div className="text-ui-caption text-foreground-subtle">
            {intl.formatMessage({ id: "resourceManager.storage.summaryTotal" })}
          </div>
          <div
            data-testid={TID_RESOURCE_MANAGER_STORAGE_TOTAL}
            className="text-ui-xl font-semibold tabular-nums text-foreground"
          >
            {formatBytes(totalBytes)}
          </div>
        </div>
        <div
          data-testid={TID_RESOURCE_MANAGER_STORAGE_STATUS}
          data-state={status}
          className="flex items-center gap-1.5 text-ui-caption text-foreground-subtle"
        >
          {scanning ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : null}
          {scanning
            ? intl.formatMessage({ id: "resourceManager.storage.scanning" })
            : snapshot?.finishedAt
              ? intl.formatMessage(
                  { id: "resourceManager.storage.lastScanned" },
                  {
                    time: formatDateTime(snapshot.finishedAt),
                  },
                )
              : snapshot?.status === "failed"
                ? intl.formatMessage({ id: "resourceManager.storage.failed" })
                : intl.formatMessage({ id: "resourceManager.storage.idle" })}
        </div>
        <div className="ml-auto">
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid={TID_RESOURCE_MANAGER_STORAGE_RESCAN}
            disabled={scanning || busy}
            onClick={() => void rescan()}
          >
            <RefreshCw className="size-4" aria-hidden="true" />
            {intl.formatMessage({ id: "resourceManager.storage.rescan" })}
          </Button>
        </div>
      </div>

      {snapshot && snapshot.errors.length > 0 ? (
        <div className="text-ui-caption text-warning">
          {intl.formatMessage(
            { id: "resourceManager.storage.errors" },
            { count: snapshot.errors.length },
          )}
        </div>
      ) : null}

      <div className="grid gap-3 lg:grid-cols-[320px_minmax(0,1fr)]">
        <div className="space-y-3">
          {groups.map((group, index) => (
            <StorageDiskCard
              key={group.key}
              group={group}
              index={index}
              legend={buildStorageLegend(sumCategoriesAcrossRoots(group.roots))}
              selected={group.key === selectedGroup?.key}
              selectable={groups.length > 1}
              onSelect={() => {
                setSelectedGroupKey(group.key);
                setDetailCategory(null);
              }}
            />
          ))}
          {/* The estimation note sits right next to the disk card, together with the numbers it explains, instead of sinking to the bottom of the page */}
          <div className="px-1 text-ui-caption text-foreground-subtlest">
            {intl.formatMessage({ id: "resourceManager.storage.estimate" })}
          </div>
        </div>
        <div className="min-w-0">
          {selectedGroup && detailCategory ? (
            <StorageCategoryDetail
              categoryId={detailCategory}
              roots={selectedGroup.roots}
              cleaning={cleaningCategory === detailCategory}
              disabled={busy || scanning}
              onBack={() => setDetailCategory(null)}
              onClean={() => requestClean(detailCategory)}
              onReveal={(absolutePath) => bridge?.revealPath(absolutePath) ?? Promise.resolve()}
            />
          ) : (
            <StorageCategoryList
              categories={categories}
              cleaningCategory={cleaningCategory}
              disabled={busy || scanning}
              onOpen={setDetailCategory}
              onClean={requestClean}
            />
          )}
        </div>
      </div>

      <StorageCleanConfirmDialog
        target={confirmTarget}
        pending={busy}
        onCancel={() => setConfirmTarget(null)}
        onConfirm={() => {
          if (confirmTarget) void runClean(confirmTarget.categoryId);
        }}
      />
    </div>
  );
}
