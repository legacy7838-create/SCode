import { z } from "zod";

import {
  conversationArtifactTypeSchema,
  conversationRowSchema,
  type ConversationRow,
} from "./zcode-protocol-v4/rows.js";

const CONVERSATION_SHARE_PATHNAME_RE = /^\/share\/([^/]+)\/?$/u;

/**
 * Parse a share page pathname and return the undecoded `code` segment.
 * Only the `/share/<code>` shape is recognized; the caller is responsible for decoding the code and validating it for safety.
 */
export function parseConversationSharePathname(pathname: string): { rawCode: string } | null {
  const match = CONVERSATION_SHARE_PATHNAME_RE.exec(pathname);
  if (!match) return null;
  return { rawCode: match[2]! };
}
/**
 * Rewrite a share link to the English site.
 *
 * The rewrite only happens when the pathname exactly matches a known share shape, and the code segment
 * is left untouched (to avoid a decode/encode round trip changing the code). Any other shape is returned
 * as is — if the server later switches to a different URL shape or its own domain, this quietly does nothing instead of rewriting it wrong.
 */
export function localizeConversationShareUrl(shareUrl: string): string {
  let url: URL;
  try {
    url = new URL(shareUrl);
  } catch {
    return shareUrl;
  }
  const parsed = parseConversationSharePathname(url.pathname);
  if (!parsed) return shareUrl;
  url.pathname = `/share/${parsed.rawCode}`;
  return url.toString();
}

export const conversationShareAccessModeSchema = z.enum([
  "private",
  "public_readonly",
  "public_importable",
]);
export type ConversationShareAccessMode = z.infer<typeof conversationShareAccessModeSchema>;

/**
 * The share payload version this build produces and understands.
 *
 * Bump it only when the semantics of rows change in a "non-skippable" breaking way (a new row kind / enum value does not count —
 * those are absorbed row by row by decodeConversationShareRows). One bump means every existing client and
 * every deployed landing page mirror stops being able to open new shares at the same time, so check the share of existing versions before bumping.
 */
export const CONVERSATION_SHARE_SCHEMA_VERSION = 1;

/**
 * An inbound schema_version is always accepted as a number first, then judged by isConversationShareSchemaVersionSupported.
 * Using z.literal would collapse "version too new" and "response shape is wrong" into the same invalid_contract,
 * and users would see "invalid share format" instead of "please upgrade ZCode".
 */
const conversationShareSchemaVersionSchema = z.number().int().positive();

/** When the version is newer than this build knows about, do not guess at its meaning: the caller must turn it into "please upgrade" rather than a generic contract error. */
export function isConversationShareSchemaVersionSupported(version: number): boolean {
  return version <= CONVERSATION_SHARE_SCHEMA_VERSION;
}

/**
 * Decode the public projection rows one by one, skipping and counting the ones that are not recognized.
 *
 * The transport layer deliberately does not understand row semantics (rows is unknown[] on the wire): a whole share
 * must not become unopenable just because one of its rows uses a new kind, a new enum value or a new timelineMarker type. One mechanism covers all three cases, so
 * no enum needs a .catch(fallback) — guessing an enum's semantics wrong is far more dangerous than dropping a row.
 *
 * The render chain is already fault tolerant (buildConversationTurnRenderUnits files unrecognized kinds under assistantWork,
 * and the switch in ConversationShareReadonlyTimeline simply does not render what it does not recognize), so here the only requirement is to not throw.
 * The count is handed to the caller to turn into a soft "some content needs a ZCode update to view" hint; it must not be swallowed silently.
 */
export function decodeConversationShareRows(rows: readonly unknown[]): {
  rows: ConversationRow[];
  unsupportedCount: number;
  unsupportedKinds: string[];
} {
  const decoded: ConversationRow[] = [];
  const unsupportedKinds: string[] = [];
  let unsupportedCount = 0;
  for (const row of rows) {
    const parsed = conversationRowSchema.safeParse(row);
    if (parsed.success) {
      decoded.push(parsed.data);
      continue;
    }
    unsupportedCount += 1;
    const kind = (row as { kind?: unknown } | null)?.kind;
    const label = typeof kind === "string" && kind.trim() ? kind.trim() : "unknown";
    if (!unsupportedKinds.includes(label)) unsupportedKinds.push(label);
  }
  return { rows: decoded, unsupportedCount, unsupportedKinds };
}

export const conversationShareSha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);

const conversationShareArtifactDescriptorFields = {
  artifact_id: z.string().trim().min(1),
  logical_artifact_key: z.string().trim().min(1),
  producer_product_turn_id: z.string().trim().min(1),
  artifact_version: z.number().int().positive(),
  state: z.literal("current"),
  ref: z.string().regex(/^zcode-artifact:\/\/share\/[A-Za-z0-9._~-]+$/u),
  artifact_type: conversationArtifactTypeSchema,
  display_name: z.string().trim().min(1),
  original_path: z.string().min(1).optional(),
  extension: z.string().trim().min(1),
  mime_type: z.string().trim().min(1),
  size_bytes: z.number().int().nonnegative(),
  sha256: conversationShareSha256Schema,
} as const;

/**
 * Outbound descriptor (upload / confirm): strict, used to catch our own bugs.
 *
 * Strict outbound and lenient inbound is the general discipline of this contract: an extra field in what we
 * send is our mistake, an extra field in what the server sends back is the server's prerogative.
 */
export const conversationShareArtifactDescriptorSchema = z
  .object(conversationShareArtifactDescriptorFields)
  .strict();
export type ConversationShareArtifactDescriptor = z.infer<
  typeof conversationShareArtifactDescriptorSchema
>;

/** Inbound descriptor (preview / continuation echo): the server is allowed to add fields. */
export const conversationShareInboundArtifactDescriptorSchema = z.object(
  conversationShareArtifactDescriptorFields,
);

const conversationShareAllowedArtifactShapeSchema = z.object({
  // Artifact type enumeration is intentionally not used: capabilities is the server's capability discovery list, and a new one is added to the backend.
  // The result type cannot cause the entire response to fail verification and kill the publication (including the publication that does not contain any results).
  // Unknown types are discarded when narrow - the client cannot generate this type and cannot participate in any allow judgment.
  type: z.string().trim().min(1),
  extensions: z.array(z.string().trim().min(1)),
  mime_types: z.array(z.string().trim().min(1)),
});

const conversationShareCapabilitiesBaseFields = {
  ttl_ms: z.number().int().positive(),
  max_rows: z.number().int().positive(),
  max_payload_bytes: z.number().int().positive(),
  max_artifact_count: z.number().int().nonnegative(),
  max_artifact_bytes: z.number().int().positive(),
  max_total_artifact_bytes: z.number().int().positive(),
};

/**
 * The live response shape: non-strict, and forward compatible on the values of type / access mode.
 *
 * access_modes and allowed_artifacts follow the same rule: when the backend ships a new access mode it must not
 * break older clients' capability discovery (that is, the entire publish entry point). Unknown values are dropped
 * during narrowing — a client simply cannot select a mode it does not know.
 */
export const conversationShareCapabilitiesWireSchema = z.object({
  ...conversationShareCapabilitiesBaseFields,
  schema_version: conversationShareSchemaVersionSchema,
  access_modes: z.array(z.string().trim().min(1)),
  allowed_artifacts: z.array(conversationShareAllowedArtifactShapeSchema),
});
export type ConversationShareCapabilitiesWire = z.infer<
  typeof conversationShareCapabilitiesWireSchema
>;

/** The internal shape after narrowing: the values are already narrowed to the enums this build knows, so strictness can continue here. */
export const conversationShareCapabilitiesDataSchema = z
  .object({
    ...conversationShareCapabilitiesBaseFields,
    schema_version: conversationShareSchemaVersionSchema,
    access_modes: z.array(conversationShareAccessModeSchema),
    allowed_artifacts: z.array(
      z
        .object({
          type: conversationArtifactTypeSchema,
          extensions: z.array(z.string().trim().min(1)),
          mime_types: z.array(z.string().trim().min(1)),
        })
        .strict(),
    ),
  })
  .strict();
export type ConversationShareCapabilities = z.infer<typeof conversationShareCapabilitiesDataSchema>;

/**
 * Drop artifact types and access modes the client does not know about, and report the dropped values back to the caller for logging.
 *
 * Note that dropping is only lossless for values the client genuinely cannot produce or select. As soon as a local
 * build can extract an uploadable extension as a preview candidate (see PREVIEW_FILE_TYPES in conversation-preview-artifacts)
 * without adding the matching type to conversationArtifactTypeSchema, this would strip a type the server clearly
 * allows and then tell the user "this type is not supported" based on the stripped allowlist — which is exactly how md
 * used to be misjudged. video/audio are explicit exceptions used only for internal preview
 * warnings and should not join the uploadable artifact enum.
 */
export function narrowConversationShareCapabilities(wire: ConversationShareCapabilitiesWire): {
  capabilities: ConversationShareCapabilities;
  unsupportedArtifactTypes: string[];
  unsupportedAccessModes: string[];
} {
  const supported: ConversationShareCapabilities["allowed_artifacts"] = [];
  const unsupportedArtifactTypes: string[] = [];
  for (const entry of wire.allowed_artifacts) {
    const type = conversationArtifactTypeSchema.safeParse(entry.type);
    if (type.success) supported.push({ ...entry, type: type.data });
    else if (!unsupportedArtifactTypes.includes(entry.type))
      unsupportedArtifactTypes.push(entry.type);
  }
  const accessModes: ConversationShareAccessMode[] = [];
  const unsupportedAccessModes: string[] = [];
  for (const mode of wire.access_modes) {
    const parsed = conversationShareAccessModeSchema.safeParse(mode);
    if (parsed.success) accessModes.push(parsed.data);
    else if (!unsupportedAccessModes.includes(mode)) unsupportedAccessModes.push(mode);
  }
  return {
    capabilities: { ...wire, access_modes: accessModes, allowed_artifacts: supported },
    unsupportedArtifactTypes,
    unsupportedAccessModes,
  };
}

export const conversationShareConfirmDataSchema = z.object({
  share_code: z.string().trim().min(1),
  share_url: z.string().url(),
  access_mode: conversationShareAccessModeSchema,
  expires_at: z.number().int().nonnegative(),
});
export type ConversationShareRecord = z.infer<typeof conversationShareConfirmDataSchema>;

// Outbound requests remain strict: schema_version is a hard-coded local constant. The extra field is our own bug.
export const conversationSharePreparationRequestSchema = z
  .object({
    client_request_id: z.string().trim().min(1),
    title: z.string().trim().min(1),
    schema_version: z.literal(CONVERSATION_SHARE_SCHEMA_VERSION),
    access_mode: conversationShareAccessModeSchema,
    payload_sha256: conversationShareSha256Schema,
    artifact_count: z.number().int().nonnegative(),
  })
  .strict();
export type ConversationSharePreparationRequest = z.infer<
  typeof conversationSharePreparationRequestSchema
>;

const conversationSharePreparationBaseFields = {
  preparation_id: z.string().trim().min(1),
  access_mode: conversationShareAccessModeSchema,
  expires_at: z.number().int().nonnegative(),
} as const;

export const conversationSharePreparationDataSchema = z.discriminatedUnion("status", [
  z.object({
    ...conversationSharePreparationBaseFields,
    status: z.literal("preparing"),
  }),
  z.object({
    ...conversationSharePreparationBaseFields,
    status: z.literal("confirmed"),
    share: conversationShareConfirmDataSchema,
  }),
]);
export type ConversationSharePreparation = z.infer<typeof conversationSharePreparationDataSchema>;

export const conversationShareArtifactUploadDataSchema = z.object({
  artifact_id: z.string().trim().min(1),
  size_bytes: z.number().int().nonnegative(),
  sha256: conversationShareSha256Schema,
  status: z.literal("uploaded"),
  safety_status: z.string().trim().min(1),
});
export type ConversationShareArtifactUpload = z.infer<
  typeof conversationShareArtifactUploadDataSchema
>;

const conversationShareIntegrityFields = {
  projection_sha256: conversationShareSha256Schema,
  artifact_set_sha256: conversationShareSha256Schema,
} as const;

/** Inbound integrity: non-strict; a future extra digest field from the server must not kill the response. */
export const conversationShareIntegritySchema = z.object(conversationShareIntegrityFields);
export type ConversationShareIntegrity = z.infer<typeof conversationShareIntegritySchema>;

/**
 * Outbound integrity: strict. confirm submits only two digests (no payload_sha256);
 * an extra field is a bug on this side and must blow up on the spot instead of being sent to production.
 */
const conversationShareOutboundIntegritySchema = z
  .object(conversationShareIntegrityFields)
  .strict();

// Outbound requests: rows use formal row schema and are strict throughout - the projection sent out must be something we fully understand.
export const conversationShareConfirmRequestSchema = z
  .object({
    selected_product_turn_ids: z.array(z.string().trim().min(1)).min(1),
    projection: z
      .object({
        rows: z.array(conversationRowSchema).min(1),
      })
      .strict(),
    integrity: conversationShareOutboundIntegritySchema,
    disclosure_confirmation: z
      .object({
        version: z.literal(1),
        accepted_at: z.number().int().nonnegative(),
        acknowledged_no_secret_detection: z.literal(true),
      })
      .strict(),
  })
  .strict();
export type ConversationShareConfirmRequest = z.infer<typeof conversationShareConfirmRequestSchema>;

const conversationSharePublicMetadataSchema = z.object({
  title: z.string(),
  access_mode: conversationShareAccessModeSchema,
  created_at: z.number().int().nonnegative(),
  expires_at: z.number().int().nonnegative(),
});

export const conversationSharePreviewArtifactSchema =
  conversationShareInboundArtifactDescriptorSchema.extend({
    url: z.string().url(),
    url_expires_at: z.number().int().nonnegative(),
  });

/**
 * The inbound wire shape: rows is unknown[], degraded row by row by decodeConversationShareRows.
 *
 * The transport layer deliberately does not understand row semantics — otherwise an old client would find the whole
 * share unopenable as soon as it hit a new row kind. The public type ConversationSharePreview is the "decoded" shape
 * and is not inferred from this schema.
 */
export const conversationSharePreviewDataSchema = z.object({
  schema_version: conversationShareSchemaVersionSchema,
  share: conversationSharePublicMetadataSchema,
  rows: z.array(z.unknown()),
  artifacts: z.array(conversationSharePreviewArtifactSchema),
  integrity: conversationShareIntegritySchema,
});
export type ConversationSharePreviewWire = z.infer<typeof conversationSharePreviewDataSchema>;
export type ConversationSharePreview = Omit<ConversationSharePreviewWire, "rows"> & {
  rows: ConversationRow[];
  /** Number of rows this build did not recognize and skipped; when > 0 the UI must show the soft "some content needs a ZCode update to view" hint. */
  unsupportedRowCount: number;
};

export const conversationShareContinuationRequestSchema = z
  .object({
    schema_version: z.literal(CONVERSATION_SHARE_SCHEMA_VERSION),
    client_request_id: z.string().trim().min(1),
  })
  .strict();
export type ConversationShareContinuationRequest = z.infer<
  typeof conversationShareContinuationRequestSchema
>;

export const conversationShareContinuationArtifactSchema =
  conversationShareInboundArtifactDescriptorSchema.extend({
    download_url: z.string().url(),
    download_url_expires_at: z.number().int().nonnegative(),
  });

export const conversationShareContinuationDataSchema = z.object({
  schema_version: conversationShareSchemaVersionSchema,
  import_grant_id: z.string().trim().min(1),
  import_grant_expires_at: z.number().int().nonnegative(),
  share: conversationSharePublicMetadataSchema.extend({
    share_id: z.string().trim().min(1),
  }),
  rows: z.array(z.unknown()),
  artifacts: z.array(conversationShareContinuationArtifactSchema),
  integrity: conversationShareIntegritySchema,
});
export type ConversationShareContinuationWire = z.infer<
  typeof conversationShareContinuationDataSchema
>;
export type ConversationShareContinuation = Omit<ConversationShareContinuationWire, "rows"> & {
  rows: ConversationRow[];
  /** Raw unparsed rows: stored as is when persisting the read-only copy, so unknown fields are not erased forever by this build. */
  rawRows: readonly unknown[];
  /** Number of rows this build did not recognize and skipped; when > 0 the UI must show the soft "some content needs a ZCode update to view" hint. */
  unsupportedRowCount: number;
};

/** Business error codes this build knows; no enum validation happens on the wire, unknown codes keep the server msg and fall back to unknown. */
export const conversationShareKnownErrorCodeSchema = z.union([
  z.literal(3001),
  z.literal(3002),
  z.literal(3200),
  z.literal(3201),
  z.literal(3203),
  z.literal(3204),
  z.literal(3205),
  z.literal(3206),
  z.literal(3207),
  z.literal(3208),
  z.literal(3209),
  z.literal(3210),
  z.literal(3211),
  z.literal(3212),
  z.literal(3213),
  z.literal(3214),
  z.literal(3215),
]);
export type ConversationShareApiErrorCode = z.infer<typeof conversationShareKnownErrorCodeSchema>;

/**
 * The error envelope puts no enum on code: when the backend ships a new business code, an old client should still
 * be able to read the server msg, rather than have the whole envelope fail to parse and degrade into a
 * contextless "HTTP 4xx".
 */
export const conversationShareErrorEnvelopeSchema = z.object({
  code: z.number().int(),
  msg: z.string(),
});
export type ConversationShareErrorEnvelope = z.infer<typeof conversationShareErrorEnvelopeSchema>;

export function createConversationShareSuccessEnvelopeSchema<TSchema extends z.ZodType>(
  dataSchema: TSchema,
) {
  return z.object({
    code: z.literal(0),
    // msg used to be z.literal(""): when the backend returns "ok", it will judge all successful responses as contract errors.
    msg: z.string(),
    data: dataSchema,
  });
}
