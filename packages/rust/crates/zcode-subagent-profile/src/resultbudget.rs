//! The tool-result byte budget.
//!
//! Spec: `docs/specs/subagent-rust-port.md` (Phase 4), ported from
//! `tool/executor/result-content-projection.ts`.
//!
//! ## Why the Unicode corpus is the test
//!
//! `fitStringToBytes` clips a string to a UTF-8 **byte** budget at **code-point**
//! boundaries. JavaScript iterates code points (`Array.from`), Java strings are UTF-16, and
//! Rust `str` is already UTF-8 — so the natural Rust translation (`&value[..n]`) either panics
//! on a code-point boundary or, worse, silently splits one. Every emoji, combining mark and ZWJ
//! sequence in the golden exists to catch exactly that.
//!
//! The budget governs how much of a tool result reaches the model, so a byte off here changes
//! what the model can see.

/// Fit `value` to at most `max_bytes` UTF-8 bytes, taking the head or the tail, never splitting
/// a code point.
///
/// Port of `fitStringToBytes`. The original binary-searches over the code-point array; the walk
/// here is equivalent and simpler, because UTF-8 length is monotonic in code points.
pub fn fit_string_to_bytes(value: &str, max_bytes: usize, direction: Direction) -> String {
    if max_bytes == 0 {
        return String::new();
    }
    if value.len() <= max_bytes {
        return value.to_string();
    }

    match direction {
        Direction::Head => {
            let mut end = max_bytes;
            while end > 0 && !value.is_char_boundary(end) {
                end -= 1;
            }
            value[..end].to_string()
        }
        Direction::Tail => {
            let mut start = value.len() - max_bytes;
            while start < value.len() && !value.is_char_boundary(start) {
                start += 1;
            }
            value[start..].to_string()
        }
    }
}

/// Which end to keep when the content does not fit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    Head,
    Tail,
}

/// Port of `fitContentWithSuffix`.
///
/// The suffix is reserved FIRST and always taken from the head, then the content gets whatever
/// bytes remain — so the notice that output was truncated can never itself be cut off.
pub fn fit_content_with_suffix(
    content: &str,
    max_bytes: usize,
    suffix: &str,
    direction: Direction,
) -> String {
    if max_bytes == 0 {
        return String::new();
    }
    let suffix_content = fit_string_to_bytes(suffix, max_bytes, Direction::Head);
    let remaining = max_bytes.saturating_sub(suffix_content.len());
    if remaining == 0 {
        return suffix_content;
    }
    format!(
        "{}{}",
        fit_string_to_bytes(content, remaining, direction),
        suffix_content
    )
}
