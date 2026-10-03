//! `credential` channel — encrypted secret storage.
//!
//! Transcribed from `packages/services/src/credential/credentialService.ts` and
//! `providers/credentialCipherProvider.ts`.
//!
//! # The cipher is a compatibility contract
//!
//! Existing credential files were written by the Node/TypeScript build and must
//! stay readable, so the cipher is reproduced exactly rather than improved:
//!
//! * key = `SHA-256(secret)`
//! * `secret` = `$ZCODE_CREDENTIAL_SECRET`, or the fallback
//!   `zcode-credential-fallback:{platform}:{homedir}:{username}`
//! * AES-256-GCM, 12-byte IV, 16-byte auth tag
//! * stored as `enc:v1:{iv}.{tag}.{ciphertext}`, all base64url
//!
//! Changing any of that would make every saved login unreadable, so the
//! derivation lives in one function, is driven by explicit inputs so it can be
//! asserted directly, and is pinned by a test that checks a ciphertext produced
//! by the TypeScript implementation decrypts here.
//!
//! # A corrupt store is never overwritten
//!
//! The original copies the damaged file aside and then *throws*, leaving it in
//! place, and writing is refused in the same situation. A damaged store must
//! keep failing loudly: if a reader moved the file away instead, the next
//! `save` would find no file, start from an empty map, and replace the store,
//! destroying every other session's login without trace. See
//! [`crate::services::private_file::backup_corrupt_file`].
//!
//! # The write path is inter-process safe
//!
//! The store is read-modify-write on a whole file, and the Tauri host, the
//! Electron desktop host, and the CLI adapter all share `~/.zcode/v2`. Every
//! mutation therefore runs under the shared directory lock, exactly as the
//! original's comment at `credentialService.ts:109` requires.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Mutex;

use aes_gcm::aead::{Aead, AeadCore, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use serde_json::Value as JsonValue;
use sha2::{Digest, Sha256};
use zcode_rpc_server::channel::{ChannelHandler, HandlerError};

use super::paths;
use super::private_file::{atomic_write_private_text_file, backup_corrupt_file, with_file_lock};

/// Marks a stored value as produced by this cipher. A value without it is
/// plaintext, which the original still returns as-is.
const ENCRYPTED_VALUE_PREFIX: &str = "enc:v1:";
const CREDENTIAL_CIPHER_IV_BYTES: usize = 12;
const CREDENTIAL_CIPHER_AUTH_TAG_BYTES: usize = 16;
const CREDENTIAL_SECRET_ENV_KEY: &str = "ZCODE_CREDENTIAL_SECRET";

/// `CREDENTIAL_DECRYPT_ERROR_CODE` from `packages/shared/src/oauth.ts:18`.
///
/// Without it the client cannot tell "this login is unreadable, sign in again"
/// apart from any other failure, because `isCredentialDecryptError` returns
/// `false` as soon as a *different* `code` is present and never falls back to
/// matching the message prefix.
const CREDENTIAL_DECRYPT_ERROR_CODE: &str = "ZCODE_CREDENTIAL_DECRYPT_FAILED";
/// `CREDENTIAL_DECRYPT_ERROR_PREFIX` from `packages/shared/src/oauth.ts:15`.
const CREDENTIAL_DECRYPT_ERROR_PREFIX: &str = "Failed to decrypt credential: ";

const CREDENTIAL_FILE: &str = "credentials.json";

fn credentials_file() -> PathBuf {
    paths::app_config_dir().join(CREDENTIAL_FILE)
}

/// Node's `process.platform`, so the derived secret matches the original's.
///
/// `os.platform()` returns Node's own names, not Rust's: `darwin` and `win32`,
/// where `std::env::consts::OS` says `macos` and `windows`. This is the one
/// place that mapping has to be exactly right, because it feeds the key.
fn node_platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    }
}

fn homedir() -> String {
    std::env::var("HOME")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            std::env::var("USERPROFILE")
                .ok()
                .filter(|v| !v.trim().is_empty())
        })
        .unwrap_or_default()
}

/// This process's real uid, without FFI.
///
/// `getuid` is a single scalar call with no buffer, so unlike `getpwuid_r` it
/// carries no memory-safety risk. It is declared here rather than pulled in as a
/// dependency for one function.
#[cfg(unix)]
fn current_uid() -> u32 {
    extern "C" {
        fn getuid() -> u32;
    }
    // SAFETY: `getuid` takes no arguments, touches no memory owned by the caller,
    // and cannot fail, so there is nothing to uphold across the call.
    unsafe { getuid() }
}

/// Look this uid up in `/etc/passwd`.
///
/// Every failure to parse a line must *skip* that line, not abandon the scan.
/// Using `?` on the field iterator would return from the whole function on the
/// first short or non-numeric line anywhere in the file, and the caller cannot
/// tell that apart from "this user genuinely has no passwd entry" — the two
/// look identical from out here, and only one of them is correct.
// 中文：`/etc/passwd` 扫描是 unix 专属逻辑（依赖 `#[cfg(unix)]` 的
// `current_uid`）。此函数之前缺少 cfg 门控，Windows 上与下方
// `#[cfg(not(unix))]` 的桩函数重复定义（E0428），且调用了不存在的
// `current_uid`（E0425）—— issue #2 errors 3/4，现已门控。
#[cfg(unix)]
fn username_from_passwd_file() -> Option<String> {
    let uid = current_uid();
    let passwd = std::fs::read_to_string("/etc/passwd").ok()?;
    for line in passwd.lines() {
        let mut fields = line.split(':');
        // `?` on `next()` here would be an early return; these are `continue`.
        let Some(name) = fields.next() else {
            continue;
        };
        let Some(_password) = fields.next() else {
            continue;
        };
        let Some(uid_field) = fields.next() else {
            continue;
        };
        if uid_field.parse::<u32>().ok() != Some(uid) {
            continue;
        }
        if name.trim().is_empty() {
            return None;
        }
        return Some(name.to_owned());
    }
    None
}

#[cfg(not(unix))]
fn username_from_passwd_file() -> Option<String> {
    None
}

fn username_from_env() -> Option<String> {
    std::env::var("USER")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            std::env::var("USERNAME")
                .ok()
                .filter(|v| !v.trim().is_empty())
        })
}

/// The OS username, matching `os.userInfo().username`.
///
/// # Why this is not a one-line helper
///
/// The cipher key is derived from this value, so a mismatch with what Node
/// derived makes every stored credential unreadable — the worst outcome this
/// channel has. Two things make it easy to get wrong:
///
/// * **The passwd file is not the user database everywhere.** On Linux the
///   `files` NSS module does read `/etc/passwd`, so scanning it by uid matches
///   `getpwuid_r`. On macOS and the BSDs the user database is OpenDirectory /
///   the BSD auth files; `/etc/passwd` holds only the handful of system
///   accounts and never the logged-in user. A typical uid-501 desktop user is
///   simply absent, so the file cannot be the primary source there — it has to
///   be a fallback, and the environment has to come first.
/// * **A user may have no passwd entry at all.** Corporate Linux with SSSD or
///   AD resolves the name through NSS and never writes `/etc/passwd`.
///
/// So each platform uses the source that is actually authoritative for it, and
/// when none of them can answer, this returns an error instead of guessing.
/// Guessing is the failure to avoid: the original's `"unknown"` placeholder
/// would produce a perfectly consistent, perfectly wrong key, and every login
/// would fail to decrypt with no indication that the username was the cause.
fn resolve_username() -> Result<String, String> {
    let candidate = if cfg!(target_os = "linux") {
        username_from_passwd_file().or_else(username_from_env)
    } else {
        // macOS/BSD/Windows: the environment carries the OpenDirectory short
        // name, which is what `userInfo().username` returns. The passwd file,
        // where it exists at all, is only a last resort.
        username_from_env().or_else(username_from_passwd_file)
    };
    candidate.ok_or_else(|| {
        format!(
            "cannot determine the OS username that the ZCode credential key is derived from; \
             set {CREDENTIAL_SECRET_ENV_KEY} to pin it"
        )
    })
}

/// The secret the cipher key is derived from, as a free function of its inputs.
///
/// Split out from the environment read so the exact bytes fed to `SHA-256` can
/// be asserted against the TypeScript implementation. Every leg of this string
/// is load-bearing: change the platform name, the home directory, or the
/// username and every previously saved login stops decrypting.
fn build_credential_secret(platform: &str, homedir: &str, username: &str) -> String {
    format!("zcode-credential-fallback:{platform}:{homedir}:{username}")
}

fn credential_secret() -> Result<String, String> {
    if let Ok(configured) = std::env::var(CREDENTIAL_SECRET_ENV_KEY) {
        // Truthiness, not trimmed truthiness: the original uses a bare `if
        // (configuredSecret)`, so a value of `"  "` is used verbatim and only
        // `""` falls through. Trimming here would derive a different key
        // whenever the variable is set with surrounding whitespace.
        if !configured.is_empty() {
            return Ok(configured);
        }
    }
    Ok(build_credential_secret(
        node_platform(),
        &homedir(),
        &resolve_username()?,
    ))
}

fn derive_cipher_key(secret: &str) -> [u8; 32] {
    let digest = Sha256::digest(secret.as_bytes());
    let mut key = [0u8; 32];
    key.copy_from_slice(&digest);
    key
}

/// A decryption failure, shaped so the client's `isCredentialDecryptError`
/// recognises it: the code is the primary signal, the message prefix the
/// fallback for payloads that lose the code in transit.
fn decrypt_error(reason: &str) -> HandlerError {
    HandlerError::with_code(
        format!("{CREDENTIAL_DECRYPT_ERROR_PREFIX}{reason}"),
        JsonValue::String(CREDENTIAL_DECRYPT_ERROR_CODE.to_owned()),
    )
}

/// Encrypt a value into the stored representation.
fn encrypt(key: &[u8; 32], value: &str) -> Result<String, String> {
    let cipher = Aes256Gcm::new(key.into());
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let ciphertext = cipher
        .encrypt(&nonce, value.as_bytes())
        .map_err(|error| format!("encrypt failed: {error}"))?;
    // The `aes-gcm` crate appends the tag to the ciphertext; the stored format
    // puts it *between* the IV and the body, so the combined form is split here
    // rather than reassembled by hand. Order is the TypeScript layout:
    // iv, auth tag, ciphertext.
    let body_len = ciphertext.len() - CREDENTIAL_CIPHER_AUTH_TAG_BYTES;
    Ok(format!(
        "{ENCRYPTED_VALUE_PREFIX}{}.{}.{}",
        URL_SAFE_NO_PAD.encode(nonce.as_slice()),
        URL_SAFE_NO_PAD.encode(&ciphertext[body_len..]),
        URL_SAFE_NO_PAD.encode(&ciphertext[..body_len]),
    ))
}

/// Decrypt a stored value; a value without the marker is returned unchanged.
fn decrypt(key: &[u8; 32], value: &str) -> Result<String, String> {
    let Some(payload) = value.strip_prefix(ENCRYPTED_VALUE_PREFIX) else {
        return Ok(value.to_owned());
    };
    let parts: Vec<&str> = payload.split('.').collect();
    if parts.len() != 3 || parts.iter().any(|part| part.is_empty()) {
        return Err("malformed ciphertext".to_owned());
    }
    let iv = URL_SAFE_NO_PAD
        .decode(parts[0])
        .map_err(|_| "malformed IV".to_owned())?;
    let tag = URL_SAFE_NO_PAD
        .decode(parts[1])
        .map_err(|_| "malformed AuthTag".to_owned())?;
    let body = URL_SAFE_NO_PAD
        .decode(parts[2])
        .map_err(|_| "malformed ciphertext".to_owned())?;

    if iv.len() != CREDENTIAL_CIPHER_IV_BYTES {
        return Err("malformed IV length".to_owned());
    }
    if tag.len() != CREDENTIAL_CIPHER_AUTH_TAG_BYTES {
        return Err("malformed AuthTag length".to_owned());
    }

    // `aes-gcm` carries the tag appended to the ciphertext, which is how the
    // combined form is laid out here.
    let mut combined = body;
    combined.extend_from_slice(&tag);

    let cipher = Aes256Gcm::new(key.into());
    let plain = cipher
        .decrypt(Nonce::from_slice(&iv), combined.as_slice())
        .map_err(|_| "key mismatch or corrupted ciphertext".to_owned())?;
    String::from_utf8(plain).map_err(|_| "decrypted value is not valid UTF-8".to_owned())
}

/// The credential store as `key -> stored value`, where the stored value is
/// ciphertext unless the row predates encryption.
type Record = BTreeMap<String, String>;

/// Read the whole store. A missing file is an empty store; a damaged one is
/// backed up and refused so it cannot be overwritten.
fn read_all() -> Result<Record, String> {
    let path = credentials_file();
    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Record::new()),
        Err(error) => {
            return Err(format!(
                "Unable to read ZCode credentials: {} ({error})",
                path.display()
            ))
        }
    };

    match serde_json::from_str::<JsonValue>(&raw) {
        Ok(JsonValue::Object(map)) => {
            let mut record = Record::new();
            for (key, value) in map {
                // `credentialRecordSchema` is `record(string, string)`; anything
                // else is a schema violation and handled like corruption.
                let JsonValue::String(text) = value else {
                    return Err(corrupt(&path));
                };
                record.insert(key, text);
            }
            Ok(record)
        }
        _ => Err(corrupt(&path)),
    }
}

/// Back the damaged file up and produce the refusal error.
fn corrupt(path: &std::path::Path) -> String {
    // A *copy*, deliberately: the original stays in place so the next read — and
    // the next save — fails the same way. Moving it would let the following
    // write start from an empty store and erase every other login.
    match backup_corrupt_file(path) {
        Ok(backup) => tracing::error!(
            path = %backup.display(),
            "credential store is corrupt; leaving it in place and refusing to overwrite so other logins survive"
        ),
        Err(error) => {
            tracing::error!(%error, "could not back up the corrupt credential store")
        }
    }
    format!("ZCode credentials are corrupt: {}", path.display())
}

fn write_all(data: &Record) -> Result<(), String> {
    // `BTreeMap` serialises in sorted key order. The original serialises in
    // insertion order, so the two builds can produce different byte layouts for
    // the same logical content. The decoded values are identical, and every
    // reader parses JSON, so this only matters for diffing the file by hand.
    let body = serde_json::to_string_pretty(data).map_err(|error| error.to_string())?;
    atomic_write_private_text_file(&credentials_file(), &format!("{body}\n"))
}

/// The `credential` channel.
pub struct CredentialService {
    key: [u8; 32],
    /// Serialises this process's own mutations. The directory lock in
    /// [`with_file_lock`] is what covers the other processes; this only avoids
    /// two threads in this one queueing on the lock directory.
    lock: Mutex<()>,
}

impl CredentialService {
    /// Build the service, deriving the cipher key from the environment.
    ///
    /// Fails if no username can be determined, because the alternative is a
    /// silently wrong key. See [`resolve_username`].
    pub fn new() -> Result<Self, String> {
        Ok(Self {
            key: derive_cipher_key(&credential_secret()?),
            lock: Mutex::new(()),
        })
    }

    fn load(&self, key: &str) -> Result<JsonValue, String> {
        let record = read_all()?;
        match record.get(key) {
            Some(stored) => decrypt(&self.key, stored).map(JsonValue::String),
            // The interface is `Promise<string | null>`, so a miss is null, not
            // an empty string.
            None => Ok(JsonValue::Null),
        }
    }

    /// Read one stored value as text for a *reader* outside this channel.
    ///
    /// `None` is a miss (the interface's `null`). A decryption failure is an
    /// `Err`, not `None`: "not signed in" and "this login cannot be trusted"
    /// are different facts, and only the caller can decide what each means —
    /// `onboarding-record` logs and treats both as signed-out, while a
    /// write path must not.
    pub(crate) fn load_string(&self, key: &str) -> Result<Option<String>, String> {
        match self.load(key)? {
            JsonValue::String(text) => Ok(Some(text)),
            JsonValue::Null => Ok(None),
            other => Err(format!("credential `{key}` is not a string: {other}")),
        }
    }

    /// Read, modify, and replace the store under the shared lock.
    ///
    /// The whole read-modify-write has to be inside the lock, not just the
    /// write: a lock taken after the read would serialise the writes while
    /// letting two readers both base their change on the same stale map.
    fn mutate(&self, change: impl FnOnce(&mut Record) -> Result<(), String>) -> Result<(), String> {
        let _guard = self
            .lock
            .lock()
            .map_err(|_| "credential lock poisoned".to_string())?;
        let path = credentials_file();
        with_file_lock(&path, || {
            let mut record = read_all()?;
            change(&mut record)?;
            write_all(&record)
        })
    }

    fn save(&self, key: &str, value: &str) -> Result<(), String> {
        self.mutate(|record| {
            record.insert(key.to_owned(), encrypt(&self.key, value)?);
            Ok(())
        })
    }

    fn delete(&self, key: &str) -> Result<(), String> {
        self.mutate(|record| {
            record.remove(key);
            Ok(())
        })
    }
}

impl ChannelHandler for CredentialService {
    fn call(
        &self,
        _ctx: &str,
        method: &str,
        args: &[JsonValue],
    ) -> Result<JsonValue, HandlerError> {
        // Positional arguments, per `ChannelHandler::call`.
        let first = args.first();
        match method {
            "load" => {
                let key = required_key_arg(first)?;
                self.load(&key).map_err(|error| handler_error(&error, &key))
            }
            "save" => {
                let key = required_key_arg(first)?;
                // The value is the SECOND positional argument; the first is the
                // key. Reading the value from `first` would encrypt the key
                // instead and make every load return the key.
                //
                // A missing value is an error rather than an empty string: the
                // stored format cannot represent an empty ciphertext body, so
                // writing one would produce a value that never decrypts again.
                let value = args.get(1).and_then(JsonValue::as_str).ok_or_else(|| {
                    HandlerError::message(
                        "credential.save requires a string value as its second argument",
                    )
                })?;
                if value.is_empty() {
                    return Err(HandlerError::message(
                        "credential.save cannot store an empty value: the encrypted format has no \
                         representation for it, and the original implementation cannot read it back",
                    ));
                }
                self.save(&key, value).map_err(HandlerError::message)?;
                // `Promise<void>` in the original; the client discards the value.
                Ok(JsonValue::Null)
            }
            "delete" => {
                let key = required_key_arg(first)?;
                self.delete(&key).map_err(HandlerError::message)?;
                Ok(JsonValue::Null)
            }
            other => Err(HandlerError::message(format!(
                "credential.{other} is not implemented by the Rust host"
            ))),
        }
    }

    fn subscribe(
        &self,
        _ctx: &str,
        _event: &str,
        _arg: Option<&JsonValue>,
    ) -> Option<crossbeam_channel::Receiver<JsonValue>> {
        None
    }
}

/// Distinguish a decryption failure from every other store failure.
///
/// The decrypt step is the only one whose failure means "this saved login is
/// gone" rather than "this file is temporarily unreadable", and the client acts
/// on that difference: it prompts for a fresh sign-in instead of retrying.
fn handler_error(error: &str, key: &str) -> HandlerError {
    const DECRYPT_REASONS: [&str; 6] = [
        "malformed ciphertext",
        "malformed IV",
        "malformed AuthTag",
        "malformed IV length",
        "malformed AuthTag length",
        "key mismatch or corrupted ciphertext",
    ];
    if DECRYPT_REASONS.contains(&error) {
        tracing::error!(key, "stored credential could not be decrypted");
        return decrypt_error(error);
    }
    HandlerError::message(error.to_owned())
}

/// `credentialKeySchema` is `z.string().trim().min(1)`, so the key is trimmed
/// on the way in and a blank one is refused.
///
/// The trim has to be applied on both the read and the write path, exactly as
/// the zod transform does: storing the untrimmed key would write a record that
/// a later trimmed lookup can never address.
// `HandlerError` inlines its `message` and `name` strings, so every `Result`
// that carries one is large enough for clippy to flag. Boxing it here would only
// move the allocation; the lint is about a hot path that this is not.
#[allow(clippy::result_large_err)]
fn required_key_arg(value: Option<&JsonValue>) -> Result<String, HandlerError> {
    let key = value
        .and_then(JsonValue::as_str)
        .unwrap_or_default()
        .trim()
        .to_owned();
    if key.is_empty() {
        return Err(HandlerError::message(
            "credential key must be a non-empty string",
        ));
    }
    Ok(key)
}

// ---------------------------------------------------------------------------
// Test surface
// ---------------------------------------------------------------------------
//
// Integration tests in `tests/` link the library normally and so cannot see
// `#[cfg(test)]` items. These stay `pub` but are named and documented as test
// seams rather than as API.

/// Decrypt a value with an explicitly supplied key, so a fixture generated by
/// the TypeScript implementation can be checked without going through key
/// derivation.
#[doc(hidden)]
pub fn decrypt_for_test(key_hex: &str, value: &str) -> Result<String, String> {
    // The fixture carries the key as hex, which is how Node emitted it.
    if key_hex.len() != 64 {
        return Err("key must be 32 bytes of hex".to_owned());
    }
    let mut key = [0u8; 32];
    for (index, byte) in key_hex.as_bytes().chunks(2).enumerate() {
        key[index] = u8::from_str_radix(std::str::from_utf8(byte).map_err(|e| e.to_string())?, 16)
            .map_err(|error| error.to_string())?;
    }
    decrypt(&key, value).map_err(|error| error.to_owned())
}

/// The secret this host derives, for the compatibility test.
#[doc(hidden)]
pub fn derived_secret_for_test() -> Result<String, String> {
    credential_secret()
}

/// The exact bytes hashed into the cipher key, so a test can compare them with
/// the TypeScript implementation's `createHash("sha256").update(secret)`.
///
/// This is the assertion that actually pins compatibility: comparing the
/// derived *key* against a fixture that carries its own `keyHex` only proves the
/// AES layer agrees, and says nothing about the string that feeds it.
#[doc(hidden)]
pub fn derived_key_hex_for_test() -> Result<String, String> {
    Ok(to_hex(&derive_cipher_key(&credential_secret()?)))
}

/// The fallback secret for explicit inputs, so each leg of it can be asserted
/// against the TypeScript template.
#[doc(hidden)]
pub fn build_secret_for_test(platform: &str, homedir: &str, username: &str) -> String {
    build_credential_secret(platform, homedir, username)
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
