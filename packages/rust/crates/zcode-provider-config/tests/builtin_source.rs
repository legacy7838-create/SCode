use std::path::PathBuf;

use zcode_provider_config::builtin_source::{ApplyRemoteReleaseResult, FileBuiltinSource};
use zcode_provider_config::config_service::BuiltinSource as _;
use zcode_provider_config::schema::{decode_builtin_release, BuiltinRelease};

fn repo_config_builtin() -> Option<PathBuf> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../config/provider/zcode-builtin.json");
    path.exists().then_some(path)
}

fn temp_dir(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "zcode-builtin-source-{name}-{}",
        std::process::id()
    ))
}

#[test]
fn the_bundled_release_is_served_when_no_active_copy_exists() {
    let Some(bundled) = repo_config_builtin() else {
        return;
    };
    let dir = temp_dir("bundled-only");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let active = dir.join("active.json");
    let source = FileBuiltinSource::new(bundled.clone(), Some(active.clone())).unwrap();
    let snapshot = source.read().unwrap();
    let release: BuiltinRelease =
        decode_builtin_release(&serde_json::from_slice(&std::fs::read(&bundled).unwrap()).unwrap())
            .unwrap();
    assert!(snapshot
        .revision
        .starts_with(&format!("zcode-builtin:{}:", release.revision)));
    // The Active copy is materialised from the bundled baseline on first read.
    let active_bytes = std::fs::read(&active).unwrap();
    let active_value: serde_json::Value = serde_json::from_slice(&active_bytes).unwrap();
    assert_eq!(
        active_value["revision"],
        serde_json::json!(release.revision)
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_remote_release_updates_the_active_copy_and_stale_releases_are_rejected() {
    let Some(bundled) = repo_config_builtin() else {
        return;
    };
    let dir = temp_dir("remote");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let active = dir.join("active.json");
    let source = FileBuiltinSource::new(bundled.clone(), Some(active.clone())).unwrap();
    source.read().unwrap();

    let base: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&bundled).unwrap()).unwrap();
    let mut newer = base.clone();
    newer["revision"] = serde_json::json!(base["revision"].as_u64().unwrap() + 1);
    let newer_release = decode_builtin_release(&newer).unwrap();
    assert_eq!(
        source.apply_remote_release(newer_release.clone()).unwrap(),
        ApplyRemoteReleaseResult::Updated
    );
    let after: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&active).unwrap()).unwrap();
    assert_eq!(after["revision"], serde_json::json!(newer["revision"]));

    // Applying the same revision twice is a no-op, never a rewrite.
    assert_eq!(
        source.apply_remote_release(newer_release.clone()).unwrap(),
        ApplyRemoteReleaseResult::Unchanged
    );
    // An older revision cannot roll the active copy back.
    let older = decode_builtin_release(&base).unwrap();
    assert_eq!(
        source.apply_remote_release(older).unwrap(),
        ApplyRemoteReleaseResult::Stale
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn an_active_copy_that_conflicts_with_bundled_at_the_same_revision_loses() {
    let Some(bundled) = repo_config_builtin() else {
        return;
    };
    let dir = temp_dir("conflict");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let active = dir.join("active.json");
    let source = FileBuiltinSource::new(bundled.clone(), Some(active.clone())).unwrap();

    // Plant an active copy with the same revision but different content.
    let mut tampered: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&bundled).unwrap()).unwrap();
    tampered["config"]["providerConfigRules"]["providerRules"] = serde_json::json!([]);
    std::fs::write(&active, serde_json::to_vec_pretty(&tampered).unwrap()).unwrap();

    let snapshot = source.read().unwrap();
    let release =
        decode_builtin_release(&serde_json::from_slice(&std::fs::read(&bundled).unwrap()).unwrap())
            .unwrap();
    // The trusted bundled release wins, and the tampered active copy is replaced.
    assert!(snapshot
        .revision
        .starts_with(&format!("zcode-builtin:{}:", release.revision)));
    assert!(!snapshot.providers.rules().is_empty());
    let _ = std::fs::remove_dir_all(&dir);
}
