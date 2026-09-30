use napi_derive::napi;

/// Check if a name matches the onXxx event naming convention.
/// (from proxy-channel.ts isEvent)
#[napi]
pub fn is_event_name(name: String) -> bool {
    let bytes = name.as_bytes();
    bytes.len() >= 3
        && bytes[0] == b'o'
        && bytes[1] == b'n'
        && bytes[2] >= b'A'
        && bytes[2] <= b'Z'
}

/// Check if a name matches the onDynamicXxx dynamic event convention.
/// (from proxy-channel.ts isDynamicEvent)
#[napi]
pub fn is_dynamic_event_name(name: String) -> bool {
    let bytes = name.as_bytes();
    bytes.len() >= 10
        && bytes[0..9] == *b"onDynamic"
        && bytes[9] >= b'A'
        && bytes[9] <= b'Z'
}

/// Transform a URI from client to server direction.
/// (from remote.ts createURITransformer)
#[napi]
pub fn transform_uri_incoming(
    scheme: String,
    authority: String,
    path: String,
    remote_authority: String,
) -> (String, String, String) {
    if scheme == "vscode-remote" && authority == remote_authority {
        return ("file".to_string(), "".to_string(), path);
    }
    if scheme == "file" {
        return ("vscode-local".to_string(), "".to_string(), path);
    }
    (scheme, authority, path)
}

/// Transform a URI from server to client direction.
/// (from remote.ts createURITransformer)
#[napi]
pub fn transform_uri_outgoing(
    scheme: String,
    authority: String,
    path: String,
    remote_authority: String,
) -> (String, String, String) {
    if scheme == "file" {
        return ("vscode-remote".to_string(), remote_authority, path);
    }
    if scheme == "vscode-local" {
        return ("file".to_string(), "".to_string(), path);
    }
    (scheme, authority, path)
}

/// Classify an error message into a kind category.
/// (from network-telemetry-middleware.ts classifyErrorKind)
#[napi]
pub fn classify_error_kind(message: String) -> String {
    let lower = message.to_lowercase();
    if lower.contains("timeout") || lower.contains("timed out") {
        return "timeout".to_string();
    }
    if lower.contains("dns") || lower.contains("getaddrinfo") || lower.contains("enotfound") {
        return "dns_failure".to_string();
    }
    if lower.contains("econnreset")
        || lower.contains("connection reset")
        || lower.contains("econnrefused")
    {
        return "connection_reset".to_string();
    }
    "other".to_string()
}

/// Extract the remote type from an authority string.
/// e.g. "ssh+myserver" → "ssh"
/// (from remote.ts RemoteAuthorityResolverService)
#[napi]
pub fn extract_remote_type(authority: String) -> String {
    match authority.find('+') {
        Some(idx) => authority[..idx].to_string(),
        None => authority,
    }
}

/// Parse a URI string into (scheme, authority, path).
#[napi]
pub fn parse_uri(uri: String) -> (String, String, String) {
    if let Some(scheme_end) = uri.find("://") {
        let scheme = uri[..scheme_end].to_string();
        let rest = &uri[scheme_end + 3..];
        if let Some(auth_end) = rest.find('/') {
            let authority = rest[..auth_end].to_string();
            let path = rest[auth_end..].to_string();
            return (scheme, authority, path);
        }
        return (scheme, rest.to_string(), String::new());
    }
    (String::new(), String::new(), uri)
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_name_true() {
        assert!(super::is_event_name("onChange".to_string()));
        assert!(super::is_event_name("onDidCreate".to_string()));
    }

    #[test]
    fn event_name_false() {
        assert!(!super::is_event_name("change".to_string()));
        assert!(!super::is_event_name("on".to_string()));
        assert!(!super::is_event_name("ona".to_string()));
    }

    #[test]
    fn dynamic_event_name_true() {
        assert!(super::is_dynamic_event_name("onDynamicXxx".to_string()));
    }

    #[test]
    fn dynamic_event_name_false() {
        assert!(!super::is_dynamic_event_name("onChange".to_string()));
        assert!(!super::is_dynamic_event_name("ondynamicxxx".to_string()));
    }

    #[test]
    fn uri_incoming_remote() {
        let (s, a, p) = super::transform_uri_incoming(
            "vscode-remote".to_string(),
            "ssh+myserver".to_string(),
            "/home/user/file.txt".to_string(),
            "ssh+myserver".to_string(),
        );
        assert_eq!(s, "file");
        assert_eq!(a, "");
        assert_eq!(p, "/home/user/file.txt");
    }

    #[test]
    fn uri_outgoing_file() {
        let (s, a, p) = super::transform_uri_outgoing(
            "file".to_string(),
            "".to_string(),
            "/home/user/file.txt".to_string(),
            "ssh+myserver".to_string(),
        );
        assert_eq!(s, "vscode-remote");
        assert_eq!(a, "ssh+myserver");
        assert_eq!(p, "/home/user/file.txt");
    }

    #[test]
    fn error_timeout() {
        assert_eq!(super::classify_error_kind("Connection timed out".to_string()), "timeout");
    }

    #[test]
    fn error_dns() {
        assert_eq!(super::classify_error_kind("getaddrinfo ENOTFOUND".to_string()), "dns_failure");
    }

    #[test]
    fn error_reset() {
        assert_eq!(super::classify_error_kind("ECONNRESET".to_string()), "connection_reset");
    }

    #[test]
    fn error_other() {
        assert_eq!(super::classify_error_kind("unknown error".to_string()), "other");
    }

    #[test]
    fn remote_type_extract() {
        assert_eq!(super::extract_remote_type("ssh+myserver".to_string()), "ssh");
        assert_eq!(super::extract_remote_type("wsl+Ubuntu".to_string()), "wsl");
        assert_eq!(super::extract_remote_type("standalone".to_string()), "standalone");
    }

    #[test]
    fn uri_parse_full() {
        let (s, a, p) = super::parse_uri("vscode-remote://ssh+myserver/home/user".to_string());
        assert_eq!(s, "vscode-remote");
        assert_eq!(a, "ssh+myserver");
        assert_eq!(p, "/home/user");
    }

    #[test]
    fn uri_parse_no_path() {
        let (s, a, p) = super::parse_uri("file://localhost".to_string());
        assert_eq!(s, "file");
        assert_eq!(a, "localhost");
        assert_eq!(p, "");
    }
}
