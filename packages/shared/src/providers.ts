import { z } from "zod";

/**
 * The single source of truth for ZCode agent providers.
 *
 * The type ZCodeProvider and the runtime schema zcodeProviderSchema are all derived from here,
 * Avoid inline z.enum([...]) copies everywhere from drifting as providers are added/deleted.
 * This module only relies on zod (leaf) and can be referenced by validation / zcode-protocol without loops.
 */
const ZCODE_PROVIDERS = ["glm"] as const;

export const zcodeProviderSchema = z.enum(ZCODE_PROVIDERS);

export type ZCodeProvider = (typeof ZCODE_PROVIDERS)[number];
