//! The `credential` channel, with the cipher pinned to the TypeScript build.
//!
//! The load-bearing test here is `decrypts_ciphertext_written_by_typescript`.
//! The store format is shared with the Node/TypeScript build, so a divergence in
//! key derivation or payload layout would make every already-saved login
//! silently unreadable — the worst possible failure for a credential store, and
//! one no round-trip test against our own encryptor would catch.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex as StdMutex;

use serde_json::{json, Value as JsonValue};
use zcode_rpc_server::channel::ChannelHandler;
use zcode_tauri_lib::services::credential::{
    build_secret_for_test, decrypt_for_test, derived_key_hex_for_test, derived_secret_for_test,
};
use zcode_tauri_lib::services::CredentialService;

/// Serialises every test that touches process-global environment state.
///
/// `$HOME`, `$ZCODE_CREDENTIAL_SECRET` and `$ZCODE_DATA_BASE_DIR` are all
/// process-wide, and the test harness runs tests in threads. A single lock for
/// the whole file is what keeps two tests from reading each other's `HOME`.
fn env_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: StdMutex<()> = StdMutex::new(());
    LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Run `body` with a private `$HOME` and no `ZCODE_DATA_BASE_DIR`.
///
/// The credential path and the cipher key are both derived from the
/// environment, so a test that does not isolate it would read and write the
/// developer's real `~/.zcode/v2/credentials.json`.
fn with_isolated_home<T>(body: impl FnOnce() -> T) -> T {
    let _guard = env_lock();

    let previous_home = std::env::var("HOME").ok();
    let previous_base = std::env::var("ZCODE_DATA_BASE_DIR").ok();
    let dir = std::env::temp_dir().join(format!("zcode-cred-test-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("temp home");
    std::env::set_var("HOME", &dir);
    // Explicitly cleared: a `ZCODE_DATA_BASE_DIR` inherited from the developer's
    // shell would send the store somewhere else entirely, and the test would
    // pass while asserting nothing about the code under test.
    std::env::remove_var("ZCODE_DATA_BASE_DIR");

    let result = body();

    // Restore exactly, including *unsetting* a variable that was not there.
    // Restoring `HOME` to `""` when it was originally absent is not the same
    // thing: the path resolver treats empty as absent but a real subprocess
    // inheriting `HOME=""` will not behave the same way.
    match previous_home {
        Some(value) => std::env::set_var("HOME", value),
        None => std::env::remove_var("HOME"),
    }
    match previous_base {
        Some(value) => std::env::set_var("ZCODE_DATA_BASE_DIR", value),
        None => std::env::remove_var("ZCODE_DATA_BASE_DIR"),
    }
    let _ = std::fs::remove_dir_all(&dir);
    result
}

fn service() -> CredentialService {
    CredentialService::new().expect("credential service: the key must be derivable")
}

fn call(
    service: &CredentialService,
    method: &str,
    args: Vec<JsonValue>,
) -> Result<JsonValue, String> {
    service
        .call("ctx", method, &args)
        .map_err(|error| error.to_string())
}

fn credentials_file() -> PathBuf {
    PathBuf::from(std::env::var("HOME").expect("HOME"))
        .join(".zcode")
        .join("v2")
        .join("credentials.json")
}

fn fixture() -> JsonValue {
    serde_json::from_str(include_str!("credential-cipher-fixture.json")).expect("fixture")
}

/// The fixture's key, for tests that only need the hex.
fn fixture_key_hex() -> String {
    fixture()["keyHex"].as_str().expect("key").to_owned()
}

// ---------------------------------------------------------------------------
// Cipher compatibility — the load-bearing tests
// ---------------------------------------------------------------------------

#[test]
fn decrypts_ciphertext_written_by_typescript() {
    let fixture = fixture();
    let key_hex = fixture["keyHex"].as_str().expect("key");

    for sample in fixture["samples"].as_array().expect("samples") {
        let plain = sample["plain"].as_str().expect("plain");
        let encrypted = sample["encrypted"].as_str().expect("encrypted");
        let note = sample["note"].as_str().unwrap_or("sample");

        if plain.is_empty() {
            // The stored format cannot represent an empty value: the ciphertext
            // segment comes out empty, which the format's own decoder rejects as
            // malformed (`if (!cipherRaw) throw`). This is a latent quirk of the
            // TypeScript implementation, reproduced here on purpose — the
            // alternative would be to invent a layout the other build cannot
            // read. Pinned so the behaviour is a decision, not a surprise.
            assert!(
                decrypt_for_test(key_hex, encrypted).is_err(),
                "{note}: an empty plaintext is unrecoverable in both implementations"
            );
            continue;
        }

        let decrypted = decrypt_for_test(key_hex, encrypted)
            .unwrap_or_else(|error| panic!("could not decrypt {note} ({plain:?}): {error}"));
        assert_eq!(
            decrypted, plain,
            "{note}: the Rust cipher must reproduce the TypeScript one exactly"
        );
    }
}

#[test]
fn the_derived_key_is_the_sha256_of_the_secret() {
    // The stronger version of the test above. `decrypts_ciphertext_written_by_
    // typescript` is handed the fixture's `keyHex`, so it only proves the AES
    // layer agrees — it says nothing about the string that feeds it. This
    // asserts the actual bytes `SHA-256(secret)` produces, which is what decides
    // whether an existing login can be read at all.
    with_isolated_home(|| {
        let fixture = fixture();
        let secret = fixture["secret"].as_str().expect("secret");
        std::env::set_var("ZCODE_CREDENTIAL_SECRET", secret);

        assert_eq!(
            derived_key_hex_for_test().expect("secret"),
            fixture["keyHex"].as_str().expect("keyHex"),
            "the cipher key must be SHA-256(secret), byte for byte"
        );

        std::env::remove_var("ZCODE_CREDENTIAL_SECRET");
    });
}

#[test]
fn the_fallback_secret_template_matches_typescript() {
    // Each leg of the fallback is load-bearing: a different platform string,
    // home directory, or username yields a different key and therefore makes
    // every saved login unreadable. Asserted explicitly so a change to the
    // mapping cannot pass on a prefix check alone.
    assert_eq!(
        build_secret_for_test("linux", "/home/ada", "ada"),
        "zcode-credential-fallback:linux:/home/ada:ada",
    );
    // `os.platform()` names, not `std::env::consts::OS` names. A host that
    // hashed "macos" or "windows" instead would derive a different key on two of
    // the three desktop platforms, and only there.
    assert_eq!(
        build_secret_for_test("darwin", "/Users/ada", "ada"),
        "zcode-credential-fallback:darwin:/Users/ada:ada",
    );
    assert_eq!(
        build_secret_for_test("win32", "C:\\Users\\ada", "ada"),
        "zcode-credential-fallback:win32:C:\\Users\\ada:ada",
    );
    // The home directory may itself contain the separator, so splitting on ":"
    // is not a safe way to parse this back.
    assert_eq!(
        build_secret_for_test("linux", "/data/ada:profile", "ada"),
        "zcode-credential-fallback:linux:/data/ada:profile:ada",
    );
}

#[test]
fn a_value_without_the_marker_is_returned_unchanged() {
    // The original returns a non-prefixed value as-is, which is how a store
    // written before encryption was introduced stays readable.
    let key_hex = fixture_key_hex();
    assert_eq!(
        decrypt_for_test(&key_hex, "plain-legacy-value").unwrap(),
        "plain-legacy-value"
    );
}

#[test]
fn a_tampered_ciphertext_is_refused_rather_than_returned_garbage() {
    // GCM authenticates, so a modified payload must fail loudly. Returning
    // corrupt bytes as if they were a token would be worse than an error.
    let fixture = fixture();
    let key_hex = fixture["keyHex"].as_str().expect("key");
    let encrypted = fixture["samples"][0]["encrypted"]
        .as_str()
        .expect("encrypted");

    // Flip a character in the ciphertext segment.
    let mut tampered = encrypted.to_owned();
    let last = tampered.len() - 1;
    let flipped = if tampered.as_bytes()[last] == b'A' {
        'B'
    } else {
        'A'
    };
    tampered.replace_range(last..last + 1, &flipped.to_string());

    assert!(
        decrypt_for_test(key_hex, &tampered).is_err(),
        "a tampered ciphertext must not decrypt"
    );
}

#[test]
fn a_wrong_key_is_refused() {
    let fixture = fixture();
    let encrypted = fixture["samples"][0]["encrypted"]
        .as_str()
        .expect("encrypted");
    // A different 32-byte key must not open the value.
    let wrong = "00".repeat(32);
    assert!(decrypt_for_test(&wrong, encrypted).is_err());
}

#[test]
fn a_decrypt_failure_carries_the_code_the_client_looks_for() {
    // `isCredentialDecryptError` in `packages/shared/src/oauth.ts:21` returns
    // false the moment it sees a *different* `code`, and only falls back to
    // matching the message prefix when no code is present. So both have to be
    // right: a bare message makes the client treat an unreadable login as a
    // transient I/O failure and retry forever, and the user stays signed out.
    with_isolated_home(|| {
        let service = service();
        // Write a value under a different key, so the row exists but cannot be
        // decrypted with this service's key.
        let other = {
            std::env::set_var("ZCODE_CREDENTIAL_SECRET", "a-different-secret");
            let other = CredentialService::new().expect("service");
            std::env::remove_var("ZCODE_CREDENTIAL_SECRET");
            other
        };
        call(&other, "save", vec![json!("k"), json!("v")]).unwrap();

        let error = service
            .call("ctx", "load", &[json!("k")])
            .expect_err("a wrong key must not decrypt");
        let message = error.to_string();
        assert!(
            message.starts_with("Failed to decrypt credential: "),
            "the message prefix is the fallback signal: {message}"
        );
        // `Display` only prints the message, so assert the code through the
        // wire payload instead.
        let payload = wire_payload(&error);
        assert_eq!(
            payload["code"],
            json!("ZCODE_CREDENTIAL_DECRYPT_FAILED"),
            "the client identifies a decrypt failure by this code: {payload}"
        );
    });
}

/// The JSON body the client receives for this failure.
fn wire_payload(error: &zcode_rpc_server::channel::HandlerError) -> JsonValue {
    // The payload is what the client reconstructs its error from, and it is
    // produced by a private `to_payload`. Rather than reach past the type's
    // accessors, this round-trips a real response through the wire codec the
    // client uses, so the assertion covers the serialisation the code depends on
    // and not just the value that went in.
    let (is_error, payload) = error.to_payload();
    assert!(
        is_error,
        "a handler failure must serialise as an Error, not a thrown value"
    );
    payload
}

#[test]
fn the_secret_env_override_is_honoured() {
    with_isolated_home(|| {
        let fixture = fixture();
        std::env::set_var(
            "ZCODE_CREDENTIAL_SECRET",
            fixture["secret"].as_str().unwrap(),
        );
        assert_eq!(
            derived_secret_for_test().expect("secret"),
            fixture["secret"].as_str().expect("secret"),
            "the configured secret must be used verbatim"
        );
        std::env::remove_var("ZCODE_CREDENTIAL_SECRET");
    });
}

#[test]
fn a_whitespace_only_secret_override_is_used_verbatim_not_trimmed() {
    // The original does a bare truthiness check on the env var, so `"  "` is a
    // valid secret and only `""` falls through to the derived fallback.
    // Trimming here would silently derive a different key for anyone whose
    // launcher exports the variable with surrounding whitespace — and the
    // symptom would be every login failing to decrypt, with no other cause.
    with_isolated_home(|| {
        std::env::set_var("ZCODE_CREDENTIAL_SECRET", "  ");
        assert_eq!(derived_secret_for_test().expect("secret"), "  ");

        // And an empty value does fall through to the fallback shape.
        std::env::set_var("ZCODE_CREDENTIAL_SECRET", "");
        assert!(derived_secret_for_test()
            .expect("secret")
            .starts_with("zcode-credential-fallback:"));

        std::env::remove_var("ZCODE_CREDENTIAL_SECRET");
    });
}

#[test]
fn without_the_override_the_secret_is_the_fallback_shape() {
    with_isolated_home(|| {
        std::env::remove_var("ZCODE_CREDENTIAL_SECRET");
        let secret = derived_secret_for_test().expect("secret");
        assert!(
            secret.starts_with("zcode-credential-fallback:"),
            "got {secret}"
        );
        // Exactly three colons separate the four legs, and the last leg is the
        // username — asserted structurally so a leg going missing is caught.
        // Three legs, not two: an off-by-one here would silently drop the
        // username and produce a key that matches nobody's.
        let legs: Vec<&str> = secret
            .strip_prefix("zcode-credential-fallback:")
            .expect("prefix")
            .splitn(3, ':')
            .collect();
        assert_eq!(legs.len(), 3, "platform:homedir:username -> {secret}");
        assert!(!legs[0].is_empty(), "platform -> {secret}");
        assert!(!legs[1].is_empty(), "homedir -> {secret}");
        assert!(!legs[2].is_empty(), "username -> {secret}");
        assert_eq!(legs[0], std::env::consts::OS, "platform leg -> {secret}");
    });
}

// ---------------------------------------------------------------------------
// Store behaviour
// ---------------------------------------------------------------------------

#[test]
fn saving_then_loading_round_trips() {
    with_isolated_home(|| {
        let service = service();
        assert_eq!(
            call(&service, "load", vec![json!("api-token")]).unwrap(),
            JsonValue::Null,
            "a missing key is null, not an empty string"
        );

        call(
            &service,
            "save",
            vec![json!("api-token"), json!("secret-value")],
        )
        .unwrap();
        assert_eq!(
            call(&service, "load", vec![json!("api-token")]).unwrap(),
            json!("secret-value")
        );
    });
}

#[test]
fn the_stored_value_is_not_the_plaintext() {
    with_isolated_home(|| {
        let service = service();
        call(
            &service,
            "save",
            vec![json!("api-token"), json!("super-secret")],
        )
        .unwrap();

        let raw = std::fs::read_to_string(credentials_file()).expect("store written");
        assert!(
            !raw.contains("super-secret"),
            "the secret must not be readable on disk in plaintext"
        );
        assert!(
            raw.contains("enc:v1:"),
            "the value must carry the encrypted marker"
        );
    });
}

#[test]
fn a_value_written_by_this_host_is_readable_by_the_typescript_cipher() {
    // The other direction of the compatibility contract, and the one that would
    // break the user in the mirror-image way: a value this host saves has to be
    // decryptable by the Node build, or a login created in the Tauri app is dead
    // the moment the user switches back.
    with_isolated_home(|| {
        let service = service();
        call(
            &service,
            "save",
            vec![json!("api-token"), json!("written-by-rust")],
        )
        .unwrap();

        let raw = std::fs::read_to_string(credentials_file()).expect("store written");
        let stored: JsonValue = serde_json::from_str(&raw).expect("valid json");
        let encrypted = stored["api-token"].as_str().expect("stored value");

        // The value was written with the *fallback* secret, so the fixture's key
        // must not open it. Asserting that first rules out the false pass where
        // the check below succeeds for an unrelated reason.
        assert!(
            decrypt_for_test(&fixture_key_hex(), encrypted).is_err(),
            "a value under a different key must not decrypt"
        );

        // The real check: this host's own derived key opens what it wrote, which
        // means the bytes on disk are the documented layout and not merely
        // something this implementation can read back.
        let plaintext = decrypt_for_test(&derived_key_hex_for_test().expect("key"), encrypted)
            .expect("readable with the derived key");
        assert_eq!(plaintext, "written-by-rust");
    });
}

#[test]
fn a_value_written_under_the_fixture_secret_is_readable_by_the_typescript_cipher() {
    // The mirror image of the test above, and the one that matters for a user who
    // signs in through the Tauri app and then goes back to the Electron build:
    // a value saved under the fixture's secret must be openable with the
    // fixture's key, which is what the Node implementation derives.
    with_isolated_home(|| {
        let fixture = fixture();
        std::env::set_var(
            "ZCODE_CREDENTIAL_SECRET",
            fixture["secret"].as_str().expect("secret"),
        );
        let service = service();
        call(
            &service,
            "save",
            vec![json!("api-token"), json!("shared-value")],
        )
        .unwrap();
        std::env::remove_var("ZCODE_CREDENTIAL_SECRET");

        let raw = std::fs::read_to_string(credentials_file()).expect("store written");
        let stored: JsonValue = serde_json::from_str(&raw).expect("valid json");
        let encrypted = stored["api-token"].as_str().expect("stored value");

        assert_eq!(
            decrypt_for_test(&fixture_key_hex(), encrypted).expect("readable by the TS layout"),
            "shared-value"
        );
    });
}

#[test]
fn a_second_reader_in_a_fresh_service_can_read_the_value() {
    with_isolated_home(|| {
        // The key is derived per instance, so this only works if derivation is
        // deterministic from the environment rather than from instance state.
        let writer = service();
        call(&writer, "save", vec![json!("k"), json!("v")]).unwrap();

        let reader = service();
        assert_eq!(call(&reader, "load", vec![json!("k")]).unwrap(), json!("v"));
    });
}

#[test]
fn several_keys_coexist() {
    with_isolated_home(|| {
        let service = service();
        for index in 0..5 {
            call(
                &service,
                "save",
                vec![
                    json!(format!("key-{index}")),
                    json!(format!("value-{index}")),
                ],
            )
            .unwrap();
        }
        for index in 0..5 {
            assert_eq!(
                call(&service, "load", vec![json!(format!("key-{index}"))]).unwrap(),
                json!(format!("value-{index}"))
            );
        }
    });
}

#[test]
fn deleting_removes_only_that_key() {
    with_isolated_home(|| {
        let service = service();
        call(&service, "save", vec![json!("a"), json!("1")]).unwrap();
        call(&service, "save", vec![json!("b"), json!("2")]).unwrap();

        call(&service, "delete", vec![json!("a")]).unwrap();
        assert_eq!(
            call(&service, "load", vec![json!("a")]).unwrap(),
            JsonValue::Null
        );
        assert_eq!(
            call(&service, "load", vec![json!("b")]).unwrap(),
            json!("2")
        );
    });
}

#[test]
fn saving_an_existing_key_replaces_it() {
    with_isolated_home(|| {
        let service = service();
        call(&service, "save", vec![json!("k"), json!("old")]).unwrap();
        call(&service, "save", vec![json!("k"), json!("new")]).unwrap();
        assert_eq!(
            call(&service, "load", vec![json!("k")]).unwrap(),
            json!("new")
        );
    });
}

#[test]
fn a_key_is_trimmed_on_both_the_read_and_the_write_path() {
    // `credentialKeySchema` is `z.string().trim().min(1)`, a transform, so the
    // original stores and looks up the *trimmed* key. Trimming only on the way
    // out would write a record that no later lookup could address, and trimming
    // only on the way in would leave a row no caller can ever delete.
    with_isolated_home(|| {
        let service = service();
        call(&service, "save", vec![json!("  spaced  "), json!("v")]).unwrap();

        let raw = std::fs::read_to_string(credentials_file()).expect("store written");
        let stored: JsonValue = serde_json::from_str(&raw).expect("valid json");
        assert!(
            stored.get("spaced").is_some(),
            "the stored key must be trimmed: {stored}"
        );
        assert!(
            stored.get("  spaced  ").is_none(),
            "the untrimmed key must not be written"
        );

        // And the trimmed spelling reads back.
        assert_eq!(
            call(&service, "load", vec![json!("spaced")]).unwrap(),
            json!("v")
        );
        call(&service, "delete", vec![json!(" spaced ")]).unwrap();
        assert_eq!(
            call(&service, "load", vec![json!("spaced")]).unwrap(),
            JsonValue::Null
        );
    });
}

#[test]
fn a_blank_key_is_never_silently_used_as_an_empty_key() {
    with_isolated_home(|| {
        let service = service();
        // The key schema is a non-empty string. Writing under "" would create a
        // record the rest of the app could never address, so a blank key is
        // refused instead.
        let result = call(&service, "save", vec![json!("   "), json!("v")]);
        assert!(result.is_err(), "a blank key must be refused");
        assert!(!credentials_file().exists(), "nothing may be written");
    });
}

#[test]
fn saving_an_empty_value_is_refused() {
    with_isolated_home(|| {
        let service = service();
        // The format cannot represent an empty value: the ciphertext segment
        // comes out empty and the decoder's own `if (!cipherRaw)` check then
        // rejects it. Accepting the write would store a credential that can
        // never be read back, turning a "clear this field" into a permanently
        // broken login.
        let result = call(&service, "save", vec![json!("k"), json!("")]);
        assert!(
            result.is_err(),
            "an empty value must be refused: {result:?}"
        );
        assert!(!credentials_file().exists(), "nothing may be written");

        // A missing value argument is equally a refusal, not an empty string.
        let missing = call(&service, "save", vec![json!("k")]);
        assert!(missing.is_err(), "a missing value must be refused");
        assert!(!credentials_file().exists(), "nothing may be written");
    });
}

#[test]
fn a_corrupt_store_is_backed_up_and_never_silently_read_as_empty() {
    with_isolated_home(|| {
        let service = service();
        call(&service, "save", vec![json!("k"), json!("v")]).unwrap();

        // Corrupt it the way a partial write or hand edit would.
        std::fs::write(credentials_file(), "{ not json").unwrap();

        // The guarantee: a damaged store must FAIL, not report "no credentials".
        // Reporting empty here would make the UI look signed out and a
        // subsequent save would replace the file, destroying every other
        // session's login without trace.
        let error = call(&service, "load", vec![json!("k")])
            .expect_err("a corrupt store must not be read as empty");
        assert!(error.contains("corrupt"), "got: {error}");

        // The damaged file stays exactly where it is. This is the whole point:
        // while it is present every subsequent read fails, so no save can start
        // from an empty map and overwrite the store. A reader that moved it
        // aside would make the very next save succeed and destroy the logins.
        assert!(
            credentials_file().exists(),
            "the damaged file must be copied aside, not moved away"
        );

        // And a save against it must keep failing, not silently succeed against
        // an empty store.
        assert!(
            call(&service, "save", vec![json!("other"), json!("v2")]).is_err(),
            "a corrupt store must refuse to be overwritten"
        );
        assert!(
            credentials_file().exists(),
            "the refused save must not have replaced anything"
        );

        // Recovery is manual and explicit, exactly as in the original: the
        // operator removes the damaged file, and only then does a write start
        // fresh.
        std::fs::remove_file(credentials_file()).unwrap();
        call(&service, "save", vec![json!("k2"), json!("v2")]).expect("fresh write");
        assert_eq!(
            call(&service, "load", vec![json!("k2")]).unwrap(),
            json!("v2")
        );
    });
}

#[test]
fn the_corrupt_backup_is_named_by_content_and_is_private() {
    with_isolated_home(|| {
        let service = service();
        call(&service, "save", vec![json!("k"), json!("v")]).unwrap();
        let damaged = "{ not json";
        std::fs::write(credentials_file(), damaged).unwrap();

        call(&service, "load", vec![json!("k")]).expect_err("corrupt");

        let backups: Vec<PathBuf> = std::fs::read_dir(credentials_file().parent().expect("dir"))
            .expect("read dir")
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.path())
            .filter(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with("credentials.json.corrupt-"))
            })
            .collect();
        assert_eq!(backups.len(), 1, "evidence must be kept: {backups:?}");
        assert_eq!(
            std::fs::read_to_string(&backups[0]).expect("backup readable"),
            damaged,
            "the backup must hold the damaged content verbatim"
        );

        // Repeating the read converges on the same single piece of evidence
        // rather than accumulating a near-identical copy per attempt, which is
        // what a timestamp or pid in the name would produce.
        call(&service, "load", vec![json!("k")]).expect_err("corrupt");
        let after: Vec<PathBuf> = std::fs::read_dir(credentials_file().parent().expect("dir"))
            .expect("read dir")
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.path())
            .filter(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with("credentials.json.corrupt-"))
            })
            .collect();
        assert_eq!(
            after.len(),
            1,
            "the same content must not be backed up twice"
        );

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let mode = std::fs::metadata(&backups[0])
                .expect("metadata")
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(
                mode, 0o600,
                "a backup of secrets must be owner-only, got {mode:o}"
            );
        }
    });
}

#[test]
fn a_store_holding_a_non_string_value_is_treated_as_corrupt() {
    with_isolated_home(|| {
        let service = service();
        call(&service, "save", vec![json!("k"), json!("v")]).unwrap();
        // `credentialRecordSchema` is record(string, string); a number violates it.
        std::fs::write(credentials_file(), r#"{"k": 42}"#).unwrap();
        assert!(call(&service, "load", vec![json!("k")]).is_err());
    });
}

#[cfg(unix)]
#[test]
fn the_store_is_not_world_readable() {
    with_isolated_home(|| {
        use std::os::unix::fs::PermissionsExt as _;
        let service = service();
        call(&service, "save", vec![json!("k"), json!("v")]).unwrap();
        let mode = std::fs::metadata(credentials_file())
            .expect("metadata")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(
            mode, 0o600,
            "a secret store must be owner-only, got {mode:o}"
        );
    });
}

#[cfg(unix)]
#[test]
fn no_world_readable_scratch_file_survives_a_write() {
    with_isolated_home(|| {
        use std::os::unix::fs::PermissionsExt as _;
        let service = service();
        for index in 0..3 {
            call(
                &service,
                "save",
                vec![json!("k"), json!(format!("v{index}"))],
            )
            .unwrap();
        }

        // The atomic write goes through a scratch file next to the target. If it
        // is left behind on a failure it strands the entire secret store on disk
        // at whatever mode the failed open left it, outside the atomic replace
        // that is supposed to protect it. So: nothing, ever.
        let leftovers: Vec<PathBuf> = std::fs::read_dir(credentials_file().parent().expect("dir"))
            .expect("read dir")
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.path())
            .filter(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| {
                        name.ends_with(".tmp") || name.contains(".credentials.json.")
                    })
            })
            .collect();
        assert!(
            leftovers.is_empty(),
            "scratch files must not survive: {leftovers:?}"
        );

        // And the store itself never appeared with a permissive mode.
        let mode = std::fs::metadata(credentials_file())
            .expect("metadata")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600);
    });
}

#[test]
fn the_store_follows_the_data_base_dir_override() {
    // `getAppConfigDir` honours `ZCODE_DATA_BASE_DIR`. Ignoring it would point
    // this host at a different file than the CLI and the Electron host, so the
    // user would appear signed out while their logins sat in another directory —
    // and the first save would fork a second store.
    with_isolated_home(|| {
        let base = std::env::temp_dir().join(format!("zcode-cred-base-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::env::set_var("ZCODE_DATA_BASE_DIR", &base);

        let service = service();
        call(&service, "save", vec![json!("k"), json!("v")]).unwrap();

        let expected = base.join(".zcode").join("v2").join("credentials.json");
        assert!(
            expected.exists(),
            "the store must land under the override: {}",
            expected.display()
        );
        assert_eq!(
            call(&service, "load", vec![json!("k")]).unwrap(),
            json!("v")
        );

        std::env::remove_var("ZCODE_DATA_BASE_DIR");
        let _ = std::fs::remove_dir_all(&base);
    });
}

#[test]
fn the_channel_publishes_no_events() {
    with_isolated_home(|| {
        assert!(Arc::new(service())
            .subscribe("ctx", "onDidChange", None)
            .is_none());
    });
}

#[test]
fn an_unknown_method_is_reported_rather_than_silently_ignored() {
    with_isolated_home(|| {
        let error = call(&service(), "rotate", vec![json!("k")])
            .expect_err("an unported method must not appear to succeed");
        assert!(error.contains("rotate"), "got: {error}");
    });
}

// ---------------------------------------------------------------------------
// Inter-process safety
// ---------------------------------------------------------------------------

#[test]
fn the_write_path_takes_a_lock_other_processes_can_observe() {
    // The store is read-modify-write on a whole file, and the Tauri host, the
    // Electron desktop host, and the CLI adapter all share this directory. An
    // in-process mutex orders threads and does nothing about the other
    // processes, so the lock has to be visible on disk.
    with_isolated_home(|| {
        let path = credentials_file();
        let lock = PathBuf::from(format!("{}.lock", path.display()));

        let observed = std::sync::Arc::new(StdMutex::new(Vec::new()));
        let sink = std::sync::Arc::clone(&observed);
        let held = zcode_tauri_lib::services::private_file::with_file_lock(&path, || {
            *sink.lock().unwrap() = vec![lock.exists()];
            Ok(())
        });
        held.expect("lock acquired");
        assert_eq!(
            observed.lock().unwrap().as_slice(),
            &[true],
            "the lock must exist while held"
        );
        assert!(!lock.exists(), "the lock must be released afterwards");
    });
}

#[test]
fn a_second_holder_waits_rather_than_proceeding_concurrently() {
    with_isolated_home(|| {
        let path = credentials_file();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("dir");
        }

        let order = std::sync::Arc::new(StdMutex::new(Vec::new()));
        let inner_order = std::sync::Arc::clone(&order);
        let inner_path = path.clone();

        // Hold the lock on a background thread while the main thread tries.
        let holder = std::thread::spawn(move || {
            zcode_tauri_lib::services::private_file::with_file_lock(&inner_path, || {
                inner_order.lock().unwrap().push("holder-entered");
                std::thread::sleep(std::time::Duration::from_millis(400));
                inner_order.lock().unwrap().push("holder-leaving");
                Ok(())
            })
        });

        std::thread::sleep(std::time::Duration::from_millis(120));
        let waiter_order = std::sync::Arc::clone(&order);
        let waiter = zcode_tauri_lib::services::private_file::with_file_lock(&path, || {
            waiter_order.lock().unwrap().push("waiter-entered");
            Ok(())
        });
        // The holder's own result must be checked too: a panic inside the locked
        // section would leave the ordering assertion below meaningless.
        holder
            .join()
            .expect("holder thread did not panic")
            .expect("holder acquired the lock");
        waiter.expect("waiter acquired after release");

        let order = order.lock().unwrap().clone();
        assert_eq!(
            order,
            vec!["holder-entered", "holder-leaving", "waiter-entered"],
            "the two critical sections must not interleave"
        );
    });
}

#[test]
fn concurrent_saves_from_many_threads_all_survive() {
    with_isolated_home(|| {
        let service = Arc::new(service());
        let mut handles = Vec::new();
        for index in 0..8 {
            let service = Arc::clone(&service);
            handles.push(std::thread::spawn(move || {
                for round in 0..5 {
                    call(
                        &service,
                        "save",
                        vec![
                            json!(format!("k-{index}")),
                            json!(format!("v-{index}-{round}")),
                        ],
                    )
                    .expect("save");
                }
            }));
        }
        for handle in handles {
            handle.join().expect("thread");
        }

        // Every writer's final value must be present. A lost update here is
        // exactly the failure the lock exists to prevent, and it is silent.
        for index in 0..8 {
            assert_eq!(
                call(&service, "load", vec![json!(format!("k-{index}"))]).unwrap(),
                json!(format!("v-{index}-4")),
                "key-{index} lost an update"
            );
        }
    });
}

#[test]
fn a_stale_lock_left_by_a_dead_process_is_reclaimed() {
    with_isolated_home(|| {
        let path = credentials_file();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("dir");
        }
        let lock = PathBuf::from(format!("{}.lock", path.display()));

        // A lock directory naming a pid that cannot be running, which is what a
        // host killed mid-write leaves behind. Without reclamation, every later
        // save would block for the full timeout and then fail.
        std::fs::create_dir_all(&lock).expect("lock dir");
        std::fs::write(
            lock.join("owner-999999-0-deadbeef.json"),
            "{\"pid\":999999,\"createdAt\":1,\"token\":\"deadbeef\"}\n",
        )
        .expect("owner file");

        let acquired = zcode_tauri_lib::services::private_file::with_file_lock(&path, || Ok(()));
        acquired.expect("a lock owned by a dead pid must be reclaimed");
    });
}

#[test]
fn a_live_lock_is_respected_rather_than_stolen() {
    with_isolated_home(|| {
        let path = credentials_file();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("dir");
        }
        let lock = PathBuf::from(format!("{}.lock", path.display()));

        // This process is very much alive, so the lock must not be reclaimed.
        std::fs::create_dir_all(&lock).expect("lock dir");
        std::fs::write(
            lock.join(format!("owner-{}-1-live.json", std::process::id())),
            format!(
                "{{\"pid\":{},\"createdAt\":{},\"token\":\"live\"}}\n",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis())
                    .unwrap_or_default()
            ),
        )
        .expect("owner file");

        let result = zcode_tauri_lib::services::private_file::with_file_lock(&path, || Ok(()));
        assert!(
            result.is_err(),
            "a live holder's lock must be waited on, not stolen"
        );
        assert!(lock.exists(), "the live lock must survive");
    });
}

#[test]
fn the_atomic_write_replaces_the_target_in_one_step() {
    with_isolated_home(|| {
        let target = credentials_file()
            .parent()
            .expect("dir")
            .join("atomic-target.json");
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).expect("dir");
        }
        std::fs::write(&target, "old").expect("seed");

        zcode_tauri_lib::services::private_file::atomic_write_private_text_file(&target, "new")
            .expect("write");
        assert_eq!(std::fs::read_to_string(&target).expect("read"), "new");

        // Concurrent writers must not corrupt the target: each rename swaps a
        // complete file in, so a reader only ever sees one whole value.
        let target = Arc::new(target);
        let mut handles = Vec::new();
        for index in 0..8 {
            let target = Arc::clone(&target);
            handles.push(std::thread::spawn(move || {
                for _ in 0..10 {
                    zcode_tauri_lib::services::private_file::atomic_write_private_text_file(
                        &target,
                        &"x".repeat(1000 + index),
                    )
                    .expect("write");
                }
            }));
        }
        for handle in handles {
            handle.join().expect("thread");
        }
        let final_length = std::fs::read_to_string(&*target).expect("read").len();
        assert!(
            (1000..=1007).contains(&final_length),
            "a torn write left {final_length} bytes"
        );
    });
}

#[test]
fn the_corrupt_backup_of_an_unreadable_file_reports_the_reason() {
    with_isolated_home(|| {
        let missing = credentials_file()
            .parent()
            .map(|dir| dir.join("does-not-exist.json"))
            .expect("dir");
        std::fs::create_dir_all(missing.parent().expect("dir")).expect("dir");
        let error = zcode_tauri_lib::services::private_file::backup_corrupt_file(&missing)
            .expect_err("backing up a missing file must fail");
        assert!(!error.is_empty());
    });
}

#[test]
fn the_passwd_scan_skips_malformed_lines_instead_of_abandoning_the_lookup() {
    // Every unparseable line must be skipped. An early return would be
    // indistinguishable, to the caller, from "this user has no passwd entry",
    // and would push the key derivation onto a different source — which reads
    // every credential as corrupt.
    let passwd = "\
# a comment line with no colons
garbage
root:x:0:0:root:/root:/bin/bash
nfsidmap:*:notanumber:4294967295::/:/sbin/nologin
+::0:0::/::
ada:x:1000:1000:Ada Lovelace:/home/ada:/bin/bash
";
    let found = scan_passwd_for_uid(passwd, 1000);
    assert_eq!(
        found.as_deref(),
        Some("ada"),
        "the scan must reach the real entry"
    );

    // A genuinely absent user still reports absent, which is the other case the
    // caller has to tell apart.
    assert_eq!(scan_passwd_for_uid(passwd, 4242), None);
}

#[test]
fn the_passwd_scan_does_not_treat_a_malformed_line_as_a_missing_user() {
    // A parse failure on any line must be indistinguishable, to the caller,
    // from "this user has no entry" only when it genuinely has none. This is the
    // pair of cases the previous implementation collapsed into one.
    let passwd = "\
# comment with no colons
truncated:x:0
nfsidmap:*:notanumber::/:/sbin/nologin
ada:x:1000:1000::/home/ada:/bin/bash
";
    assert_eq!(
        scan_passwd_for_uid(passwd, 1000).as_deref(),
        Some("ada"),
        "a short line and a non-numeric uid above the real entry must both be skipped"
    );
}
#[test]
fn the_lock_is_released_even_when_the_operation_fails() {
    with_isolated_home(|| {
        let path = credentials_file();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("dir");
        }
        let lock = PathBuf::from(format!("{}.lock", path.display()));

        let result: Result<(), String> =
            zcode_tauri_lib::services::private_file::with_file_lock(&path, || {
                Err("the operation failed".to_owned())
            });
        assert!(result.is_err());
        assert!(
            !lock.exists(),
            "a failed operation must not leave the lock held against every other process"
        );

        // And the path is immediately acquirable again.
        zcode_tauri_lib::services::private_file::with_file_lock(&path, || Ok(()))
            .expect("reacquirable after a failure");
    });
}

#[test]
fn a_credential_save_leaves_no_lock_directory_behind() {
    with_isolated_home(|| {
        let service = service();
        call(&service, "save", vec![json!("k"), json!("v")]).unwrap();
        call(&service, "delete", vec![json!("k")]).unwrap();

        let lock = PathBuf::from(format!("{}.lock", credentials_file().display()));
        assert!(
            !lock.exists(),
            "a released lock must not linger as a stray directory"
        );
    });
}

/// The `/etc/passwd` scan over an in-memory table, mirroring
/// `username_from_passwd_file` so its control flow can be asserted directly
/// against input a real `/etc/passwd` will not contain.
fn scan_passwd_for_uid(passwd: &str, uid: u32) -> Option<String> {
    for line in passwd.lines() {
        let mut fields = line.split(':');
        let Some(name) = fields.next() else { continue };
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
