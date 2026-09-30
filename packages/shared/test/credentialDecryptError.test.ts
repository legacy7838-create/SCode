import assert from "node:assert/strict";
import test from "node:test";
import {
  CREDENTIAL_DECRYPT_ERROR_CODE,
  CREDENTIAL_DECRYPT_ERROR_PREFIX,
  isCredentialDecryptError,
} from "../src/oauth.js";

test("error carrying the stable credential decrypt code is detected", () => {
  assert.equal(isCredentialDecryptError({ code: CREDENTIAL_DECRYPT_ERROR_CODE }), true);
});

test("Error instance carrying the stable code is detected even without the prefix", () => {
  const error = new Error("boom") as Error & { code?: unknown };
  error.code = CREDENTIAL_DECRYPT_ERROR_CODE;
  assert.equal(isCredentialDecryptError(error), true);
});

test("error carrying both the stable code and the message prefix is detected", () => {
  // This is the shape the Rust host produces via HandlerError::with_code.
  const error = new Error(`${CREDENTIAL_DECRYPT_ERROR_PREFIX}bad key`) as Error & {
    code?: unknown;
  };
  error.code = CREDENTIAL_DECRYPT_ERROR_CODE;
  assert.equal(isCredentialDecryptError(error), true);
});

test("legacy payload with only the message prefix falls back to message matching", () => {
  assert.equal(
    isCredentialDecryptError({ message: `${CREDENTIAL_DECRYPT_ERROR_PREFIX}bad key` }),
    true,
  );
  assert.equal(
    isCredentialDecryptError(new Error(`${CREDENTIAL_DECRYPT_ERROR_PREFIX}bad key`)),
    true,
  );
});

test("empty code is treated as absent and falls back to the message prefix", () => {
  // readCredentialErrorCode returns "" for an empty code, so the prefix path runs.
  assert.equal(
    isCredentialDecryptError({
      code: "",
      message: `${CREDENTIAL_DECRYPT_ERROR_PREFIX}bad key`,
    }),
    true,
  );
  assert.equal(
    isCredentialDecryptError({ code: null, message: `${CREDENTIAL_DECRYPT_ERROR_PREFIX}bad key` }),
    true,
  );
});

test("a different code short-circuits before the message prefix is considered", () => {
  // Documented behavior of the current source: a present-but-different code returns
  // false WITHOUT falling back to the message prefix.
  assert.equal(
    isCredentialDecryptError({
      code: "ZCODE_OTHER_ERROR",
      message: `${CREDENTIAL_DECRYPT_ERROR_PREFIX}bad key`,
    }),
    false,
  );
});

test("a different code without the prefix is not a decrypt error", () => {
  assert.equal(isCredentialDecryptError({ code: "ZCODE_OTHER_ERROR" }), false);
  assert.equal(
    isCredentialDecryptError({ code: "ZCODE_OTHER_ERROR", message: "unrelated failure" }),
    false,
  );
});

test("plain Error without code or prefix is not a decrypt error", () => {
  assert.equal(isCredentialDecryptError(new Error("network unreachable")), false);
  assert.equal(isCredentialDecryptError(new TypeError("bad type")), false);
});

test("prefix must be at the start of the message", () => {
  assert.equal(
    isCredentialDecryptError({ message: `wrapped: ${CREDENTIAL_DECRYPT_ERROR_PREFIX}bad key` }),
    false,
  );
  assert.equal(
    isCredentialDecryptError({ message: CREDENTIAL_DECRYPT_ERROR_PREFIX.trim() }),
    false,
  );
});

test("non-object inputs are not decrypt errors", () => {
  assert.equal(isCredentialDecryptError(null), false);
  assert.equal(isCredentialDecryptError(undefined), false);
  assert.equal(isCredentialDecryptError("Failed to decrypt credential: bad key"), false);
  assert.equal(isCredentialDecryptError(0), false);
  assert.equal(isCredentialDecryptError(false), false);
  assert.equal(isCredentialDecryptError({}), false);
});
