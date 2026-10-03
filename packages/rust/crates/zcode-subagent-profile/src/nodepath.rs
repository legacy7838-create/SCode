//! Node-compatible `path.join` / `path.dirname`.
//!
//! `std::path::Path::join` does NOT normalize: `Path::new("/a/b").join("../c")`
//! yields `/a/b/../c`, where Node yields `/a/c`. Every subagent artifact path is
//! built by joining an output root, a session id and an agent id, so using the Rust
//! behaviour would leave literal `..` in the paths handed to the filesystem — and the
//! metadata document would then record a path that does not resolve to the file that
//! was actually written.
//!
//! Behaviour reproduced from Node (POSIX; the Windows separator is not needed here
//! because these paths are built from the same ids on every platform):
//!
//! | Input | Result |
//! |---|---|
//! | `join("/a/b", "c")` | `/a/b/c` |
//! | `join("/a//b", "c")` | `/a/b/c` (duplicate separators collapse) |
//! | `join("/a/b", "/c")` | `/a/b/c` (an absolute later segment does NOT reset) |
//! | `join("/a/b", "../c")` | `/a/c` |
//! | `join("/a", "..", "..", "x")` | `/x` (`..` past the root is dropped) |
//! | `join("..", "x")` | `../x` (a relative path keeps its leading `..`) |
//! | `join("/a/b", "c/")` | `/a/b/c/` (a trailing separator is preserved) |
//! | `join("/a", "", "b")` | `/a/b` (an empty segment contributes nothing) |

/// `path.join(...)`, POSIX flavour.
pub fn node_join(parts: &[&str]) -> String {
    let absolute = parts.first().is_some_and(|first| first.starts_with('/'));
    let mut segments: Vec<&str> = Vec::new();

    for part in parts {
        for segment in part.split('/') {
            match segment {
                "" | "." => {}
                ".." => {
                    // Pop a real segment. At the root there is nothing to pop, so the
                    // `..` is dropped, which is what Node does for absolute paths.
                    match segments.last() {
                        Some(last) if *last != ".." => {
                            segments.pop();
                        }
                        _ if absolute => {}
                        _ => segments.push(".."),
                    }
                }
                other => segments.push(other),
            }
        }
    }

    let joined = segments.join("/");
    let mut out = String::new();
    if absolute {
        out.push('/');
    }
    out.push_str(&joined);

    // Node keeps a trailing separator when the LAST argument ended with one.
    if let Some(last) = parts.last() {
        if last.ends_with('/') && last.len() > 1 && !out.ends_with('/') && !out.is_empty() {
            out.push('/');
        }
    }
    if out.is_empty() {
        // `join()` with nothing, or only separators, is "." in Node — except for a
        // single root separator, which stays "/".
        return if parts.iter().any(|part| part.starts_with('/')) {
            "/".to_string()
        } else {
            ".".to_string()
        };
    }
    out
}

/// `path.dirname(...)`, POSIX flavour.
///
/// Not normalized: `dirname("/a/b/../c")` is `/a/b/..`, because Node takes the parent
/// of the literal path. Normalizing here would change the directory a subagent writes
/// into when an id contains `..`.
pub fn node_dirname(path: &str) -> String {
    if path.is_empty() {
        return ".".to_string();
    }
    let trimmed = path.trim_end_matches('/');
    if trimmed.is_empty() {
        // "/" or a run of separators.
        return "/".to_string();
    }
    match trimmed.rfind('/') {
        None => ".".to_string(),
        Some(0) => "/".to_string(),
        Some(index) => trimmed[..index].to_string(),
    }
}
