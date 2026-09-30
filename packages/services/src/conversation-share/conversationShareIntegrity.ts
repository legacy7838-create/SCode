import { createHash } from "node:crypto";

import {
  conversationShareConfirmRequestSchema,
  type ConversationShareArtifactDescriptor,
  type ConversationShareConfirmRequest,
} from "@zcode/shared";

type ConversationShareConfirmRequestBase = Omit<ConversationShareConfirmRequest, "integrity"> & {
  artifacts: ConversationShareArtifactDescriptor[];
};

function assertValidUnicode(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new TypeError("Conversation share JSON contains invalid Unicode");
      }
      index += 1;
      continue;
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new TypeError("Conversation share JSON contains invalid Unicode");
    }
  }
}

function canonicalizeValue(value: unknown): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number": {
      if (!Number.isFinite(value)) {
        throw new TypeError("Conversation share JSON numbers must be finite");
      }
      return JSON.stringify(value);
    }
    case "string":
      assertValidUnicode(value);
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map((entry) => canonicalizeValue(entry)).join(",")}]`;
      }

      const record = value as Record<string, unknown>;
      const entries = Object.keys(record)
        .sort()
        .map((key) => {
          assertValidUnicode(key);
          const entry = record[key];
          if (entry === undefined) {
            throw new TypeError("Conversation share JSON cannot contain undefined values");
          }
          return `${JSON.stringify(key)}:${canonicalizeValue(entry)}`;
        });
      return `{${entries.join(",")}}`;
    }
    default:
      throw new TypeError(`Conversation share JSON cannot contain ${typeof value}`);
  }
}

function canonicalizeConversationShareJson(value: unknown): string {
  return canonicalizeValue(value);
}

export function sha256ConversationShareJson(value: unknown): string {
  return createHash("sha256")
    .update(canonicalizeConversationShareJson(value), "utf8")
    .digest("hex");
}

export function buildConversationShareConfirmRequest(
  input: ConversationShareConfirmRequestBase,
): ConversationShareConfirmRequest {
  const artifacts = [...input.artifacts].sort((left, right) =>
    left.artifact_id.localeCompare(right.artifact_id),
  );
  const projectionSha256 = sha256ConversationShareJson(input.projection.rows);
  const artifactSetSha256 = sha256ConversationShareJson(artifacts);
  const { artifacts: _artifacts, ...confirmRequest } = input;

  return conversationShareConfirmRequestSchema.parse({
    ...confirmRequest,
    integrity: {
      projection_sha256: projectionSha256,
      artifact_set_sha256: artifactSetSha256,
    },
  });
}

/**
 * Fields that only exist because the server issues a signed URL; they take no part in the
 * artifact set digest.
 *
 * This is a list of "fields the server attaches on read", not a whitelist of "fields this
 * client knows about" — the two run in opposite directions, and only the former keeps hashes
 * aligned when versions are skewed:
 * - a newer publisher adds a field to a descriptor → it lands in server storage and in the
 *   server-computed digest, and an older importer computing over the raw values includes it
 *   too, so the hashes still match (this is the direction we must preserve);
 * - if we instead projected onto the fields this client knows, that new field would be
 *   stripped and the hashes would immediately disagree.
 *
 * The price: whenever the server later adds a field to its read response (rather than echoing
 * back what was uploaded) it must also be added to this list, or the digests diverge. That is
 * a server-side violation of the revision contract (continuation integrity is defined over the
 * descriptor set), it has an obvious symptom, and the fix is simply to add one key here.
 */
const ARTIFACT_URL_KEYS = ["download_url", "download_url_expires_at", "url", "url_expires_at"];

function artifactIdOf(value: unknown): string {
  const id = (value as { artifact_id?: unknown } | null)?.artifact_id;
  return typeof id === "string" ? id : "";
}

function stripArtifactUrls(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const stripped: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  for (const key of ARTIFACT_URL_KEYS) delete stripped[key];
  return stripped;
}

/**
 * Re-verifies both digests using the rows / artifacts the server sent **verbatim**.
 *
 * The key point is the "raw values": this used to operate on the zod parse output, and zod
 * strips unknown fields by default, so as soon as a publisher added one optional field to a
 * row, the hash recomputed by an older importer was guaranteed to mismatch and reported
 * "share file verification failed" — a warning that looks like tampering, plus a retry button
 * that can never succeed.
 *
 * Once verification targets the raw bytes, integrity is fully decoupled from schema knowledge:
 * the schema can evolve additively, and a hash mismatch goes back to meaning exactly what it
 * is supposed to mean — the content really was altered or corrupted.
 */
export function verifyConversationShareIntegrity(input: {
  rawRows: unknown;
  rawArtifacts: unknown;
  integrity: { projection_sha256: string; artifact_set_sha256: string };
}): boolean {
  const artifacts = Array.isArray(input.rawArtifacts)
    ? [...(input.rawArtifacts as unknown[])]
        .sort((left, right) => artifactIdOf(left).localeCompare(artifactIdOf(right)))
        .map(stripArtifactUrls)
    : input.rawArtifacts;
  return (
    sha256ConversationShareJson(input.rawRows) === input.integrity.projection_sha256 &&
    sha256ConversationShareJson(artifacts) === input.integrity.artifact_set_sha256
  );
}
