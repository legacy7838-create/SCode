//! Selector resolution — the part Playwright's locator resolver used to own.
//!
//! Two behaviours are inherited from that resolver **on purpose**, because they are what the
//! agent was implicitly relying on:
//!
//! * **Exactly one match is required.** `DOM.querySelector` returns the first match and says
//!   nothing about the rest, so a selector that used to resolve would silently start clicking
//!   the wrong element after a page change. [`CdpClient::query_selector_all_count`] is
//!   consulted first and an ambiguous selector is refused with the count, so the agent can
//!   narrow it instead of hitting the wrong control.
//! * **No auto-waiting.** CDP has nothing to wait *for*: there is no "element is actionable"
//!   concept. A page that has not finished rendering yields [`Error::NoMatch`]. The agent
//!   retries; pretending otherwise is how this crate could reintroduce Playwright's behaviour
//!   by accident, one `sleep` at a time.

use crate::{CdpClient, Error, NodeHandle, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Visibility {
    /// Reported visible by the page. Not an actionability check — see the module note.
    Visible,
    Hidden,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct ElementInfo {
    pub handle: NodeHandle,
    pub tag: String,
    pub text: Option<String>,
    pub visible: bool,
}

/// Resolve `selector` to a handle, refusing anything ambiguous.
pub fn find<C: CdpClient>(client: &mut C, selector: &str) -> Result<NodeHandle> {
    let selector = selector.trim();
    if selector.is_empty() {
        return Err(Error::Invalid("selector is empty".into()));
    }
    // Count first. `querySelector` alone cannot distinguish "the only match" from "the first
    // of many", and the two need very different reactions from the caller.
    let count = client.query_selector_all_count(selector)?;
    match count {
        0 => return Err(Error::NoMatch),
        1 => {}
        n => return Err(Error::AmbiguousSelector { count: n }),
    }
    client.query_selector(selector)
}

/// Resolve and describe, for a snapshot.
pub fn inspect<C: CdpClient>(client: &mut C, selector: &str) -> Result<ElementInfo> {
    let handle = find(client, selector)?;
    // The descriptor is best-effort on purpose: the handle is what the caller needs to act, and
    // failing the whole call because a page is mid-render would make `find` useless during
    // exactly the navigation it exists to survive. A failure here yields empty text, never a
    // failed resolve.
    let probe = format!(
        r#"(() => {{ const e = document.querySelector({sel});
             if (!e) return null;
             return {{ tag: e.tagName.toLowerCase(),
                       text: (e.innerText || '').slice(0, 200),
                       visible: !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length) }};
           }})()"#,
        sel = json_string(selector)
    );
    let value = client.evaluate(&probe).unwrap_or(serde_json::Value::Null);
    Ok(ElementInfo {
        handle,
        tag: value.get("tag").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        text: value
            .get("text")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        visible: value
            .get("visible")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
    })
}

/// Whether a resolved element is visible, using the same descriptor probe as [`inspect`].
pub fn is_visible<C: CdpClient>(client: &mut C, handle: NodeHandle) -> Result<Visibility> {
    let probe = format!(
        r#"(() => {{ const e = document.querySelector('[data-zcode-node="{}"]');
             return !!e && !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
           }})()"#,
        handle.backend_node_id
    );
    Ok(match client.evaluate(&probe) {
        Ok(v) if v.as_bool() == Some(true) => Visibility::Visible,
        _ => Visibility::Hidden,
    })
}

/// JSON-encode a Rust string as a JavaScript string literal, quotes and backslashes included.
///
/// The selector arrives from the agent, so interpolating it raw into an `evaluate` expression
/// would be an injection into a page that also holds the user's session. This is the only place
/// a selector becomes script, which is why it is one function rather than a `format!` at each
/// call site.
pub fn json_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[derive(Default)]
    struct MockClient {
        counts: RefCell<Vec<String>>,
        matches: usize,
        evaluated: RefCell<Vec<String>>,
        evaluate_result: serde_json::Value,
    }

    impl CdpClient for MockClient {
        fn query_selector(&mut self, selector: &str) -> Result<NodeHandle> {
            self.counts.borrow_mut().push(selector.to_string());
            Ok(NodeHandle { node_id: 1, backend_node_id: 2 })
        }
        fn query_selector_all_count(&mut self, selector: &str) -> Result<usize> {
            self.counts.borrow_mut().push(selector.to_string());
            Ok(self.matches)
        }
        fn dispatch_mouse_event(&mut self, _: &NodeHandle, _: &crate::input::MouseEventKind) -> Result<()> {
            Ok(())
        }
        fn evaluate(&mut self, expression: &str) -> Result<serde_json::Value> {
            self.evaluated.borrow_mut().push(expression.to_string());
            Ok(self.evaluate_result.clone())
        }
        fn capture_screenshot(&mut self, _: &crate::capture::ImageFormat) -> Result<Vec<u8>> {
            Ok(Vec::new())
        }
        fn capture_pdf(&mut self, _: &crate::capture::PrintOptions) -> Result<Vec<u8>> {
            Ok(Vec::new())
        }
    }

    #[test]
    fn single_match_resolves() {
        let mut c = MockClient { matches: 1, ..Default::default() };
        let handle = find(&mut c, "#go").unwrap();
        assert_eq!(handle, NodeHandle { node_id: 1, backend_node_id: 2 });
    }

    #[test]
    fn multiple_matches_are_refused_with_the_count() {
        // This is the behaviour that has no CDP equivalent and that a naive port would drop:
        // `querySelector` would have returned the first of three and clicked it.
        let mut c = MockClient { matches: 3, ..Default::default() };
        assert_eq!(
            find(&mut c, ".row").unwrap_err(),
            Error::AmbiguousSelector { count: 3 }
        );
        assert!(
            c.counts.borrow().len() >= 1,
            "count must be consulted so ambiguity is detectable"
        );
    }

    #[test]
    fn no_match_is_its_own_error_not_a_handle() {
        let mut c = MockClient { matches: 0, ..Default::default() };
        assert_eq!(find(&mut c, "#gone").unwrap_err(), Error::NoMatch);
    }

    #[test]
    fn empty_selector_is_rejected_before_touching_the_browser() {
        let mut c = MockClient { matches: 1, ..Default::default() };
        assert!(find(&mut c, "   ").is_err());
        assert!(c.counts.borrow().is_empty(), "must not round-trip a blank selector");
    }

    #[test]
    fn selector_is_json_encoded_into_the_probe() {
        // The selector comes from the agent. Interpolated raw it would be script injection into
        // a page holding the user's session, so the encoding is asserted, not assumed.
        let hostile = r#"a"]);alert(1);("#;
        let encoded = json_string(hostile);
        // Assert the property, not a hand-written literal: the point is that the quote and the
        // backslash are escaped and that decoding returns exactly the input. A literal would
        // only prove the author could count escapes.
        assert!(encoded.starts_with('"') && encoded.ends_with('"'));
        // Every interior quote must be backslash-escaped; an unescaped one would terminate the
        // JS string literal and let the rest of the selector execute as script.
        let interior = &encoded.as_bytes()[1..encoded.len() - 1];
        let mut escaped = false;
        for &b in interior {
            match b {
                b'\\' if !escaped => escaped = true,
                b'"' if !escaped => panic!("unescaped quote would end the literal: {encoded}"),
                _ => escaped = false,
            }
        }
        let reparsed: String = serde_json::from_str(&encoded).unwrap();
        assert_eq!(reparsed, hostile, "must survive a JSON round-trip intact");
    }

    #[test]
    fn inspect_reports_the_descriptor_when_present() {
        let mut c = MockClient {
            matches: 1,
            evaluate_result: serde_json::json!({"tag":"button","text":"Go","visible":true}),
            ..Default::default()
        };
        let info = inspect(&mut c, "#go").unwrap();
        assert_eq!(info.tag, "button");
        assert_eq!(info.text.as_deref(), Some("Go"));
        assert!(info.visible);
    }

    #[test]
    fn inspect_survives_a_failed_probe() {
        // The handle is what the caller needs; a page mid-render must not fail `find`.
        struct Failing(MockClient);
        impl CdpClient for Failing {
            fn query_selector(&mut self, s: &str) -> Result<NodeHandle> {
                self.0.query_selector(s)
            }
            fn query_selector_all_count(&mut self, s: &str) -> Result<usize> {
                self.0.query_selector_all_count(s)
            }
            fn dispatch_mouse_event(&mut self, _: &NodeHandle, _: &crate::input::MouseEventKind) -> Result<()> { Ok(()) }
            fn evaluate(&mut self, _: &str) -> Result<serde_json::Value> {
                Err(Error::Cdp("detached".into()))
            }
            fn capture_screenshot(&mut self, _: &crate::capture::ImageFormat) -> Result<Vec<u8>> { Ok(Vec::new()) }
            fn capture_pdf(&mut self, _: &crate::capture::PrintOptions) -> Result<Vec<u8>> { Ok(Vec::new()) }
        }
        let mut c = Failing(MockClient { matches: 1, ..Default::default() });
        let info = inspect(&mut c, "#go").unwrap();
        assert!(!info.visible);
        assert_eq!(info.text, None);
    }
}
