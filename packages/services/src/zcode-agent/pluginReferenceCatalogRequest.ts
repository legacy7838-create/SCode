import {
  zcodeProtocolMethods,
  zcodePluginsReferenceCatalogResultSchema,
  type ZCodePluginsReferenceCatalogParams,
} from "@zcode/shared";
import type { ZCodeProtocolClient } from "#src/zcode-agent/zcodeProtocolClient.js";

/** The old protocol strictly validates the response; new display fields go through a dedicated entry point, and only -32601 proves that an old Agent does not support it. */
export async function requestPluginReferenceCatalog(
  client: Pick<ZCodeProtocolClient, "request">,
  params: ZCodePluginsReferenceCatalogParams,
) {
  try {
    return await client.request(
      zcodeProtocolMethods.pluginsReferenceCatalogWithCategory,
      params,
      zcodePluginsReferenceCatalogResultSchema,
    );
  } catch (error) {
    if (!(typeof error === "object" && error !== null && "code" in error && error.code === -32601))
      throw error;
    return client.request(
      zcodeProtocolMethods.pluginsReferenceCatalog,
      params,
      zcodePluginsReferenceCatalogResultSchema,
    );
  }
}
