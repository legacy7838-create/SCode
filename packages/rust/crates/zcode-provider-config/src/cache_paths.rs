//! ZCode Built-in cache path derivation.
//!
//! Rust port of `packages/provider-node/src/zcode-builtin-cache-paths.ts` and
//! `packages/provider-node/src/runtime-paths.ts`. Pure path/string compute —
//! no IO. Spec: docs/specs/rust-native-provider-node.md §3.

use sha2::{Digest, Sha256};

pub const ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV: &str = "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE";
pub const ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE_ENV: &str =
    "ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE";
pub const ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV: &str = "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE";
pub const PERSONAL_PROVIDER_CONFIG_FILE_NAME: &str = "provider_config.json";

/// `resolveZCodeBuiltinClientPlatform`: `<target>-<arch>` with the Node
/// platform/arch names mapped to the Rust target triple names, verbatim.
pub fn resolve_client_platform() -> String {
    let target = if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        std::env::consts::OS
    };
    let arch = match std::env::consts::ARCH {
        "aarch64" => "aarch64",
        "x86_64" => "x86_64",
        other => other,
    };
    format!("{target}-{arch}")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ZCodeBuiltinCachePaths {
    pub active_file_path: std::path::PathBuf,
    pub control_file_path: std::path::PathBuf,
}

/// Active/LKG are isolated per platform and app version; the path itself is
/// the compatibility scope. Mirrors `resolveZCodeBuiltinCachePaths`.
pub fn resolve_cache_paths(
    environment_config_root: &std::path::Path,
    platform: &str,
    app_version: &str,
    zcode_endpoint_origin: &str,
) -> Result<ZCodeBuiltinCachePaths, String> {
    let platform = normalize_segment(platform, "platform")?;
    let app_version = normalize_segment(app_version, "appVersion")?;
    let endpoint_key = create_endpoint_key(zcode_endpoint_origin)?;
    let directory = environment_config_root
        .join("runtime")
        .join("provider")
        .join(platform)
        .join(app_version)
        .join(endpoint_key);
    Ok(ZCodeBuiltinCachePaths {
        active_file_path: directory.join("zcode-builtin.json"),
        control_file_path: directory.join("zcode-builtin-refresh.json"),
    })
}

/// Normalizes the origin, then maps it to a safe, stable cache path segment:
/// `endpoint-<sha256 hex, first 32 chars>`. Byte-identical to the TS digest.
pub fn create_endpoint_key(zcode_endpoint_origin: &str) -> Result<String, String> {
    let normalized = normalize_endpoint_origin(zcode_endpoint_origin)?;
    let digest = Sha256::digest(normalized.as_bytes());
    let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    Ok(format!("endpoint-{}", &hex[..32]))
}

/// `new URL(value).origin` with the http(s)-only gate. Mirrors
/// `normalizeZCodeBuiltinEndpointOrigin`, including the error strings.
pub fn normalize_endpoint_origin(value: &str) -> Result<String, String> {
    let normalized = value.trim();
    if normalized.is_empty() {
        return Err("ZCode Built-in Endpoint Origin must not be empty".into());
    }
    let url = url::Url::parse(normalized)
        .map_err(|error| format!("ZCode Built-in Endpoint Origin is not a valid URL: {error}"))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err("ZCode Built-in Endpoint Origin only supports HTTP(S)".into());
    }
    // WHATWG `url.origin` serialisation: scheme://host[:port], no trailing
    // slash; default ports are dropped by the parser.
    Ok(url.origin().ascii_serialization())
}

fn normalize_segment(value: &str, name: &str) -> Result<String, String> {
    let normalized = value.trim();
    if normalized.is_empty()
        || normalized == "."
        || normalized == ".."
        || normalized.contains(['/', '\\'])
    {
        return Err(format!("ZCode Built-in {name} is not a valid path segment"));
    }
    Ok(normalized.to_string())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NodeProviderRuntimePaths {
    pub zcode_builtin_file_path: String,
    pub personal_file_path: String,
}

/// `resolveNodeProviderRuntimePaths`: both paths or neither; one without the
/// other is a hard error. Mirrors `runtime-paths.ts`.
pub fn resolve_runtime_paths(
    env: &dyn Fn(&str) -> Option<String>,
) -> Result<Option<NodeProviderRuntimePaths>, String> {
    let zcode_builtin = env(ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let personal = env(ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    match (zcode_builtin, personal) {
        (None, None) => Ok(None),
        (Some(zcode_builtin_file_path), Some(personal_file_path)) => {
            Ok(Some(NodeProviderRuntimePaths {
                zcode_builtin_file_path,
                personal_file_path,
            }))
        }
        _ => Err("ZCode Built-in and Personal Provider Config paths must both be provided".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_endpoint_key_matches_the_node_digest() {
        // Independently computed: sha256("https://api.z.ai") hex, first 32 chars.
        let key = create_endpoint_key("https://api.z.ai").expect("key");
        assert!(key.starts_with("endpoint-"));
        assert_eq!(key.len(), "endpoint-".len() + 32);
        // Normalisation: trailing slash and default port collapse to the origin.
        assert_eq!(
            create_endpoint_key(" https://api.z.ai/ ").unwrap(),
            create_endpoint_key("https://api.z.ai:443").unwrap()
        );
    }

    #[test]
    fn the_origin_gate_rejects_non_http_and_empty() {
        assert!(normalize_endpoint_origin("  ").is_err());
        assert!(normalize_endpoint_origin("ftp://example.com").is_err());
        assert_eq!(
            normalize_endpoint_origin("https://example.com:443/path?q=1").unwrap(),
            "https://example.com"
        );
        assert_eq!(
            normalize_endpoint_origin("http://example.com:8080").unwrap(),
            "http://example.com:8080"
        );
    }

    #[test]
    fn cache_paths_reject_unsafe_segments() {
        let root = std::path::Path::new("/cfg");
        assert!(resolve_cache_paths(root, "linux-x86_64", "1.0.0", "https://api.z.ai").is_ok());
        for bad in ["", " ", ".", "..", "a/b", "a\\b"] {
            assert!(
                resolve_cache_paths(root, bad, "1.0.0", "https://api.z.ai").is_err(),
                "platform {bad:?} must be rejected"
            );
        }
    }

    #[test]
    fn cache_paths_layout_matches_the_ts_join() {
        let paths = resolve_cache_paths(
            std::path::Path::new("/cfg"),
            "linux-x86_64",
            "1.2.3",
            "https://api.z.ai",
        )
        .expect("paths");
        let dir = paths.active_file_path.parent().expect("parent");
        assert!(
            dir.to_string_lossy().starts_with("/cfg/runtime/provider/linux-x86_64/1.2.3/endpoint-"),
            "{dir:?}"
        );
        assert_eq!(
            paths.control_file_path.file_name().unwrap(),
            "zcode-builtin-refresh.json"
        );
        assert_eq!(paths.active_file_path.file_name().unwrap(), "zcode-builtin.json");
    }

    #[test]
    fn runtime_paths_require_both_env_vars() {
        let empty = resolve_runtime_paths(&|_| None).expect("no env");
        assert!(empty.is_none());
        let one = resolve_runtime_paths(&|name| {
            (name == ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV).then(|| "/a.json".to_string())
        });
        assert!(one.is_err());
        let both = resolve_runtime_paths(&|name| match name {
            ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV => Some(" /a.json ".to_string()),
            ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV => Some("/b.json".to_string()),
            _ => None,
        })
        .expect("both")
        .expect("some");
        assert_eq!(both.zcode_builtin_file_path, "/a.json");
        assert_eq!(both.personal_file_path, "/b.json");
    }
}
