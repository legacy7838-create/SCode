/**
 * The trust store file schema has been pushed down to `@zcode/shared/workspace-hook-trust-store-file`
 * as the single authoritative implementation (the services layer cannot depend on contracts under apps,
 * so it hand-wrote a local validation, and the UI and the runtime ended up with divergent conclusions about the same corrupt file).
 *
 * This re-export keeps the existing contracts import paths (adapters/bootstrap/core etc.) unchanged; shared and
 * contracts belong to separate zod4 / zod3 instances, so this re-export must not be referenced from zod3 schemas
 * inside contracts.
 */
export {
  WORKSPACE_HOOK_TRUST_STORE_SCHEMA_VERSION,
  workspaceHookTrustRecordSchema,
  workspaceHookTrustStoreFileSchema,
} from "@zcode/shared/workspace-hook-trust-store-file";
export type {
  WorkspaceHookTrustRecord,
  WorkspaceHookTrustStoreFile,
} from "@zcode/shared/workspace-hook-trust-store-file";

import { z } from "zod";

const nonEmptyStringSchema = z.string().trim().min(1);

export const workspaceHookPolicySchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("deny"),
      reason: nonEmptyStringSchema,
      policyRevision: nonEmptyStringSchema,
    })
    .strict(),
  z
    .object({
      mode: z.literal("user_decides"),
      policyRevision: nonEmptyStringSchema,
    })
    .strict(),
  z
    .object({
      mode: z.literal("allow_trusted_only"),
      reason: nonEmptyStringSchema.optional(),
      policyRevision: nonEmptyStringSchema,
    })
    .strict(),
]);
export type WorkspaceHookPolicy = z.infer<typeof workspaceHookPolicySchema>;
