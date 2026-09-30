/**
 * The package's own deterministic hash: FNV-1a (32 bit) applied to canonical JSON.
 * Not node:crypto — src/ stays pure and portable, and the hash serves only as a defensive consistency check during replay
 * (not a cryptographic use; collision resistance matters little, determinism and portability are what count).
 */

/**
 * Canonical JSON serialization: object keys are sorted by code point, so semantically equal values get a stable byte order.
 * It only covers the JSON values a host call can produce (string/number/boolean/null/array/plain object).
 * Non-JSON values such as undefined / functions should not appear on this path; when they do they are serialized as "null" to keep the function total.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    // Basic types: handed to JSON.stringify (number/boolean/string), undefined/function falls back to null.
    const s = JSON.stringify(value);
    return s === undefined ? "null" : s;
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts: string[] = [];
  for (const key of keys) {
    const v = obj[key];
    // Skip undefined members, consistent with JSON.stringify object semantics.
    if (v === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${canonicalJson(v)}`);
  }
  return `{${parts.join(",")}}`;
}

/** The FNV-1a 32-bit hash, emitted as an 8-digit hexadecimal string. */
export function fnv1a(input: string): string {
  // FNV offset basis/prime (32 bit). Guaranteed 32-bit multiplication wrapping with Math.imul.
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i) & 0xff;
    // The high-order bytes are also included to avoid losing the distinction of multi-byte characters by hashing only the low-order bytes.
    hash ^= (input.charCodeAt(i) >> 8) & 0xff;
    hash = Math.imul(hash, 0x01000193);
  }
  // Convert to unsigned and zero-padd to 8-digit hexadecimal.
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Computes the defensive hash of a host call's input: FNV-1a over the canonical JSON. */
export function inputHash(value: unknown): string {
  return fnv1a(canonicalJson(value));
}
