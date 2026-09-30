import { useEffect, useMemo } from "react";
import { isValidCronExpr, type IClientScenesService } from "@zcode/services";
import {
  isClientScenesBusinessError,
  useClientScenesResource,
} from "@/hooks/useClientScenesResource.js";
import { logger } from "@/logger.js";
import {
  mapClientScenesToAutomationTemplates,
  type AutomationTemplateCatalog,
} from "@/settings/automationTemplateCatalog.js";

type AutomationTemplateCatalogState = AutomationTemplateCatalog & {
  loading: boolean;
};

export function useAutomationTemplates(
  clientScenesService: IClientScenesService,
): AutomationTemplateCatalogState {
  const { scenes, loading, error } = useClientScenesResource(clientScenesService);
  const catalog = useMemo(
    () => mapClientScenesToAutomationTemplates(scenes, isValidCronExpr),
    [scenes],
  );

  useEffect(() => {
    if (!error) return;
    if (isClientScenesBusinessError(error)) {
      logger.warn(
        "[automation-templates] client scenes returned failure, keeping the manual create entry",
        {
          code: error.code,
          message: error.responseMessage,
        },
      );
      return;
    }
    logger.warn(
      "[automation-templates] client scenes request failed, keeping the manual create entry",
      {
        error: error.message,
      },
    );
  }, [error]);

  useEffect(() => {
    if (catalog.rejectedScheduledTemplateIds.length === 0) return;
    logger.warn(
      "[automation-templates] rejected scheduled templates with an empty title or an unsafe-to-edit schedule",
      {
        templateIds: catalog.rejectedScheduledTemplateIds,
      },
    );
  }, [catalog.rejectedScheduledTemplateIds]);

  return {
    ...catalog,
    loading,
  };
}
