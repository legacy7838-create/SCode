import { z } from "zod";

/**
 * The single authoritative schema of the Workspace Hook Trust store file format (`workspace-hook-trust-v1.json`).
 *
 * The full schema cannot live in contracts alone (the CLI side, zod3):
 * the services layer cannot depend on packages under apps, so it had to hand-write partial field
 * validation (only looking at the shape of workspaceIdentity and digest). The result is that the
 * same "valid JSON but structurally invalid" store file is judged corrupt by runtime/adapters
 * (fail-closed, blocking everything), while services displays its digests as already trusted —
 * the UI shows "trusted" and the execution layer refuses forever, with no way to diagnose it
 * through a unified path. The trust store is a permission boundary, and every consumer must reach
 * the same conclusion about the same file, so the schema is pushed down into shared as the single
 * source; contracts re-exports this module to keep existing import paths working.
 *
 * Note: contracts and this module belong to two separate instances, zod3 / zod4, so this schema must
 * not be referenced inside a zod3 schema composition in contracts (currently only re-exported).
 */

export const WORKSPACE_HOOK_TRUST_STORE_SCHEMA_VERSION = 1 as const;

/** Kept in sync with workspaceHookEventNameSchema in contracts (the 7 existing events). */
const workspaceHookEventNameSchema = z.enum([
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
]);

const nonEmptyStringSchema = z.string().trim().min(1);
const sha256DigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const nonnegativeIntegerSchema = z.number().int().nonnegative();

export const workspaceHookTrustRecordSchema = z
  .object({
    workspaceIdentity: nonEmptyStringSchema,
    hookDeclarationDigest: sha256DigestSchema,
    digestAlgorithm: z.literal("sha256"),
    decision: z.literal("trusted"),
    grantedAt: z.string().datetime(),
    lastUsedAt: z.string().datetime().optional(),
    bundleDigestAtGrant: sha256DigestSchema.optional(),
    eventAtGrant: workspaceHookEventNameSchema,
    displayCommandAtGrant: nonEmptyStringSchema,
    sourcePathAtGrant: nonEmptyStringSchema,
    sourceDiscoveryOrderAtGrant: nonnegativeIntegerSchema.optional(),
    matcherAtGrant: z.string().nullable().optional(),
    matcherIndexAtGrant: nonnegativeIntegerSchema.optional(),
    hookIndexAtGrant: nonnegativeIntegerSchema.optional(),
    appVersionAtGrant: nonEmptyStringSchema.optional(),
  })
  .strict();
export type WorkspaceHookTrustRecord = z.infer<typeof workspaceHookTrustRecordSchema>;

export const workspaceHookTrustStoreFileSchema = z
  .object({
    schemaVersion: z.literal(WORKSPACE_HOOK_TRUST_STORE_SCHEMA_VERSION),
    records: z.array(workspaceHookTrustRecordSchema),
  })
  .strict()
  .superRefine((store, context) => {
    const keys = store.records.map(
      (record) => `${record.workspaceIdentity}\u0000${record.hookDeclarationDigest}`,
    );
    if (new Set(keys).size !== keys.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["records"],
        message: "workspace identity and declaration digest keys must be unique",
      });
    }
  });
export type WorkspaceHookTrustStoreFile = z.infer<typeof workspaceHookTrustStoreFileSchema>;

export type WorkspaceHookTrustStoreParseResult =
  | { status: "ok"; file: WorkspaceHookTrustStoreFile }
  | { status: "invalid" };

/**
 * Parses the trust store file content. A JSON syntax error and a schema validation failure are both
 * classified as `invalid` — the two are equivalent in consumption semantics: the file is
 * untrustworthy, so it must fail closed, and no partial result may be returned.
 */
export function parseWorkspaceHookTrustStoreContent(
  content: string,
): WorkspaceHookTrustStoreParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    return { status: "invalid" };
  }
  const result = workspaceHookTrustStoreFileSchema.safeParse(parsed);
  if (!result.success) return { status: "invalid" };
  return { status: "ok", file: result.data };
}
