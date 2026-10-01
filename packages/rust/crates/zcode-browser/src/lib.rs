//! Chromium automation over CDP — the replacement for the Playwright browser subsystem.
//!
//! Spec: `docs/specs/browser-port.md`. Read §1 before changing anything here, because two
//! decisions in it are not reversible by editing code:
//!
//! 1. **Playwright is deleted, not wrapped.** Its locator API cannot be reproduced, because
//!    the resolver is Playwright's own page-side script and CDP has no equivalent. So a
//!    resolved element is a [`NodeHandle`] — an opaque id that the caller holds — and an id
//!    the page invalidates is an [`Error::StaleHandle`], never a silent re-resolve.
//! 2. **There is no TypeScript twin.** The browser commands still travel over CHANNEL 1, but
//!    exactly one implementation serves them. A fallback path here would be the invariant-1
//!    violation this crate exists to end, and it is why `CdpClient` is a trait: so the logic
//!    is testable without Chromium, not so a second implementation can be swapped in.
//!
//! Module layout: [`launch`] decides how Chromium is started, [`registry`] owns tab state,
//! [`element`] owns resolution, [`input`] owns dispatched events, [`capture`] owns
//! screenshots and recording. Every one of them is pure logic over a [`CdpClient`], so the
//! test suite runs without a browser binary.

pub mod capture;
pub mod element;
pub mod input;
pub mod launch;
pub mod registry;

use thiserror::Error;

/// A page element resolved from a selector.
///
/// This is deliberately *not* a locator. A locator re-resolves on every action and hides the
/// case where the page changed underneath the caller; a handle does not, so that case surfaces
/// as [`Error::StaleHandle`]. Agents cope with an explicit error far better than with a click
/// that silently lands somewhere else.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct NodeHandle {
    pub node_id: u64,
    /// The backend id survives `DOM.getDocument` returning a different `nodeId` for the same
    /// document. Both are needed: the node id is what `Input.*` accepts, the backend id is
    /// what survives a navigation-shaped refresh.
    pub backend_node_id: u64,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum Error {
    #[error("no browser process is running")]
    NotLaunched,

    #[error("tab {0} is not open")]
    UnknownTab(u64),

    #[error("no tab is focused")]
    NoFocusedTab,

    #[error("element handle is stale: the page no longer contains node {node_id}")]
    StaleHandle { node_id: u64 },

    #[error("selector matched {count} elements; a single match is required")]
    AmbiguousSelector { count: usize },

    #[error("selector matched nothing")]
    NoMatch,

    #[error("chromium exited before the connection was established")]
    LaunchFailed,

    #[error("cdp returned an error: {0}")]
    Cdp(String),

    #[error("{0}")]
    Invalid(String),
}

pub type Result<T> = std::result::Result<T, Error>;

/// The CDP operations this crate needs, narrowed to what it actually calls.
///
/// `chromiumoxide` is deliberately absent from this signature. Every function that touches a
/// browser takes a `&mut impl CdpClient`, which is what lets the whole crate be tested against
/// a recording mock — and it is the seam that would expose a second implementation, so adding
/// one here would defeat the crate's purpose.
pub trait CdpClient {
    /// `DOM.querySelector` against the tab's current document.
    fn query_selector(&mut self, selector: &str) -> Result<NodeHandle>;
    /// `DOM.querySelectorAll` reduced to a count, for the ambiguity check.
    fn query_selector_all_count(&mut self, selector: &str) -> Result<usize>;
    /// `Input.dispatchMouseEvent`.
    fn dispatch_mouse_event(&mut self, target: &NodeHandle, kind: &input::MouseEventKind) -> Result<()>;
    /// `Runtime.evaluate`, returning the JSON-encoded result.
    fn evaluate(&mut self, expression: &str) -> Result<serde_json::Value>;
    /// `Page.captureScreenshot`, returning encoded image bytes.
    fn capture_screenshot(&mut self, format: &capture::ImageFormat) -> Result<Vec<u8>>;
    /// `Page.printToPDF`-style PDF capture.
    fn capture_pdf(&mut self, print_options: &capture::PrintOptions) -> Result<Vec<u8>>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn node_handle_serialises_with_both_ids() {
        // The TS side receives this over CHANNEL 1, so the wire shape is a contract, not a
        // debug convenience: a consumer keyed on `backendNodeId` would silently see 0 if the
        // field were dropped here.
        let handle = NodeHandle {
            node_id: 7,
            backend_node_id: 99,
        };
        let json = serde_json::to_string(&handle).expect("handle serialises");
        assert_eq!(json, r#"{"node_id":7,"backend_node_id":99}"#);
    }

    #[test]
    fn node_handle_round_trips() {
        let handle = NodeHandle {
            node_id: 1,
            backend_node_id: 2,
        };
        let back: NodeHandle = serde_json::from_str(&serde_json::to_string(&handle).unwrap()).unwrap();
        assert_eq!(handle, back);
    }

    #[test]
    fn stale_handle_names_the_node_so_the_agent_can_act() {
        // The agent-facing message has to be actionable: it reports the id that died rather
        // than a generic failure, because the agent's only recovery is to re-run `find`.
        let rendered = Error::StaleHandle { node_id: 42 }.to_string();
        assert!(rendered.contains("42"), "message must name the handle: {rendered}");
    }

    #[test]
    fn ambiguity_error_reports_the_count() {
        let rendered = Error::AmbiguousSelector { count: 3 }.to_string();
        assert!(rendered.contains('3'), "message must report how many matched: {rendered}");
    }
}
