/**
 * Emits `tests/credential-cipher-fixture.json` from the REAL TypeScript
 * credential cipher, so the Rust port can be asserted byte-for-byte against it.
 *
 * Read from `credentialCipherProvider.ts` at runtime rather than transcribed by
 * hand, so the Rust `encrypt`/`decrypt` and the Node implementation cannot
 * drift: re-run this after any change to the cipher, the key derivation, or the
 * stored layout.
 *
 *   pnpm exec tsx scripts/gen-credential-cipher-fixture.ts > apps/zcode-tauri/src-tauri/tests/credential-cipher-fixture.json
 *
 * `keyHex` is `createHash("sha256").update(secret).digest("hex")` — the exact
 * bytes the Rust host must derive — rather than a key handed to it by the test.
 * That is the difference between checking the AES layer and checking key
 * derivation: a fixture carrying its own key proves nothing about the platform,
 * home-directory, and username legs that actually decide whether an existing
 * login can be read at all.
 */
import { createHash } from "node:crypto";
import { createCredentialCipherProvider } from "../packages/services/src/credential/providers/credentialCipherProvider.js";

/** Pinned so the fixture regenerates deterministically apart from the IVs. */
const SECRET = "zcode-test-fixture-secret";

/**
 * Covers the cases that actually differ: an ASCII token, a multi-byte payload
 * where the byte length differs from the character count, a value long enough
 * to span AES-GCM blocks, and the empty string.
 *
 * The empty sample is a known defect in the stored format, reproduced here
 * rather than fixed: encrypting "" yields an empty ciphertext segment, and the
 * decoder's own `if (!cipherRaw)` check then rejects its own output. Pinning it
 * makes the incompatibility a decision instead of a surprise, and the Rust side
 * refuses to write an empty value for the same reason.
 */
const SAMPLES: { note: string; plain: string }[] = [
  { note: "ascii oauth token", plain: "oauth-token-abc123" },
  { note: "empty plaintext: unrepresentable in the stored format", plain: "" },
  { note: "multi-byte utf8, byte length != char length", plain: "unicode-世界-🔐" },
  { note: "multi-block plaintext", plain: "a".repeat(200) },
  { note: "whitespace-only value", plain: "   " },
  { note: "value that looks like the marker prefix", plain: "enc:v1:not-really" },
];

const cipher = createCredentialCipherProvider({
  env: { ZCODE_CREDENTIAL_SECRET: SECRET } as NodeJS.ProcessEnv,
});

const fixture = {
  // Provenance, so a stale fixture is obvious in review.
  generatedBy: "scripts/gen-credential-cipher-fixture.ts",
  secret: SECRET,
  keyHex: createHash("sha256").update(SECRET).digest("hex"),
  samples: SAMPLES.map(({ note, plain }) => {
    const encrypted = cipher.encrypt(plain);
    // Prove the sample really is readable before committing it. The empty one
    // is expected to fail; anything else failing means the generator is broken.
    let roundTrips = true;
    try {
      roundTrips = cipher.decrypt(encrypted) === plain;
    } catch {
      roundTrips = false;
    }
    if (!roundTrips && plain !== "") {
      throw new Error(`generated ciphertext for ${note} does not round-trip`);
    }
    return { note, plain, encrypted, decodableByFormat: roundTrips };
  }),
};

process.stdout.write(JSON.stringify(fixture, null, 2) + "\n");
