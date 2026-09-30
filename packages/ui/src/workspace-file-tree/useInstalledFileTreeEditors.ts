import { useEffect, useState } from "react";
import type { EditorInfo } from "@zcode/shared";
import { usePlatform } from "@/hooks/usePlatform.js";
import { sortInstalledEditorsForOpenWith } from "@/lib/openWithEditors.js";
import { logger } from "@/logger.js";

export function useInstalledFileTreeEditors() {
  const platform = usePlatform();
  const [installedEditors, setInstalledEditors] = useState<EditorInfo[]>([]);

  useEffect(() => {
    let disposed = false;

    platform
      .getInstalledEditors()
      .then((editors) => {
        if (!disposed) {
          setInstalledEditors(sortInstalledEditorsForOpenWith(editors));
        }
      })
      .catch((error) => {
        logger.warn("[WorkspaceFileTree] failed to read installed IDE list", {
          error: error instanceof Error ? error.message : String(error),
        });
      });

    return () => {
      disposed = true;
    };
  }, [platform]);

  return { installedEditors };
}
