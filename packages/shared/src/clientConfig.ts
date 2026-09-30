import { z } from "zod";
import { parsePluginStoreOrder, type PluginStoreOrder } from "./pluginStoreOrder.js";

/** Only explicitly opted-in public fields may enter the service snapshot; account and Provider config are never passed through. */
export interface ClientConfigSnapshot {
  pluginStoreOrder: PluginStoreOrder | null;
}

export const clientConfigReadOptionsSchema = z.object({
  forceRefresh: z.boolean().optional(),
});
export type ClientConfigReadOptions = z.infer<typeof clientConfigReadOptionsSchema>;

const envelopeSchema = z.object({
  code: z.literal(0),
  data: z
    .object({
      configs: z.object({ pluginStoreOrder: z.unknown().optional() }).nullish(),
    })
    .nullish(),
});

export function parseClientConfigSnapshot(payload: unknown): ClientConfigSnapshot {
  const parsed = envelopeSchema.safeParse(payload);
  if (!parsed.success) throw new Error("Invalid public client config response");
  return { pluginStoreOrder: parsePluginStoreOrder(parsed.data.data?.configs?.pluginStoreOrder) };
}
