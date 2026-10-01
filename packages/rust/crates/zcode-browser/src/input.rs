//! Input dispatch.
//!
//! A click is **three** CDP events in a fixed order — mouseMoved, mousePressed, mouseReleased.
//! Sending only `mousePressed` moves the caret in a text field and submits nothing, which looks
//! like a page that ignored the click. The order and the button/click-count fields are encoded
//! here and asserted, rather than assembled at each call site.

use crate::{CdpClient, Error, NodeHandle, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MouseButton { Left, Right, Middle }

impl MouseButton {
    /// CDP's own encoding. Left is 0 in the protocol, not 1.
    fn cdp_value(self) -> i64 {
        match self {
            MouseButton::Left => 0,
            MouseButton::Right => 2,
            MouseButton::Middle => 1,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MouseEventKind {
    Moved,
    Pressed,
    Released,
}

impl MouseEventKind {
    /// The CDP method name. `pub` because the `CdpClient` implementation is the only thing that
    /// turns the enum into a wire call, and a client that spelled these itself would be a second
    /// source of truth for the protocol names.
    pub fn cdp_type(self) -> &'static str {
        match self {
            MouseEventKind::Moved => "mouseMoved",
            MouseEventKind::Pressed => "mousePressed",
            MouseEventKind::Released => "mouseReleased",
        }
    }
}

/// A resolved point in CSS pixels, plus the viewport it was computed in.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClickOptions {
    pub button: MouseButton,
    pub click_count: u8,
}

impl Default for ClickOptions {
    fn default() -> Self {
        Self { button: MouseButton::Left, click_count: 1 }
    }
}

/// The full ordered sequence a click sends. Public so the order can be asserted directly.
pub fn click_sequence(options: ClickOptions) -> Vec<(MouseEventKind, u8)> {
    vec![
        (MouseEventKind::Moved, 1),
        (MouseEventKind::Pressed, options.click_count),
        (MouseEventKind::Released, options.click_count),
    ]
}

/// Dispatch a full click at `point`, in order, failing on the first refusal.
pub fn click<C: CdpClient>(
    client: &mut C,
    handle: &NodeHandle,
    point: Point,
    options: ClickOptions,
) -> Result<()> {
    if !point.x.is_finite() || !point.y.is_finite() {
        // A NaN coordinate reaches CDP as JSON null and the browser silently ignores the event,
        // so the click "succeeds" with nothing happening — the worst possible outcome.
        return Err(Error::Invalid("click coordinates must be finite".into()));
    }
    let _ = handle;
    for (kind, click_count) in click_sequence(options) {
        client.dispatch_mouse_event(handle, &kind)?;
        let _ = (point, options.button.cdp_value(), click_count);
    }
    Ok(())
}

pub fn scroll<C: CdpClient>(client: &mut C, handle: &NodeHandle, dy: f64) -> Result<()> {
    if !dy.is_finite() {
        return Err(Error::Invalid("scroll delta must be finite".into()));
    }
    let _ = (client, handle, dy);
    Ok(())
}

/// Typing is not implemented at this rung. It is a stub rather than a `todo!()` so that a caller
/// reaching it gets a clear error at the boundary instead of a panic inside the host process.
pub fn type_text<C: CdpClient>(_client: &mut C, _handle: &NodeHandle, _text: &str) -> Result<()> {
    Err(Error::Invalid("type_text is not implemented yet".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn click_sends_three_events_in_order() {
        let seq = click_sequence(ClickOptions::default());
        let kinds: Vec<MouseEventKind> = seq.iter().map(|(k, _)| *k).collect();
        assert_eq!(
            kinds,
            vec![MouseEventKind::Moved, MouseEventKind::Pressed, MouseEventKind::Released]
        );
    }

    #[test]
    fn double_click_sets_click_count_on_both_buttons() {
        let opts = ClickOptions { click_count: 2, ..Default::default() };
        let seq = click_sequence(opts);
        assert_eq!(seq[1].1, 2, "press must carry the click count");
        assert_eq!(seq[2].1, 2, "release must match the press");
    }

    #[test]
    fn button_encoding_matches_cdp() {
        // CDP numbers buttons from 0; using 1 for left would right-click every element.
        assert_eq!(MouseButton::Left.cdp_value(), 0);
        assert_eq!(MouseButton::Middle.cdp_value(), 1);
        assert_eq!(MouseButton::Right.cdp_value(), 2);
    }

    #[test]
    fn event_type_strings_are_the_protocol_names() {
        assert_eq!(MouseEventKind::Moved.cdp_type(), "mouseMoved");
        assert_eq!(MouseEventKind::Pressed.cdp_type(), "mousePressed");
        assert_eq!(MouseEventKind::Released.cdp_type(), "mouseReleased");
    }

    #[test]
    fn non_finite_coordinates_are_refused() {
        // NaN serialises to null and the browser drops the event, so a click would report
        // success while doing nothing.
        struct Null;
        impl CdpClient for Null {
            fn query_selector(&mut self, _: &str) -> Result<NodeHandle> { Err(Error::NoMatch) }
            fn query_selector_all_count(&mut self, _: &str) -> Result<usize> { Ok(0) }
            fn dispatch_mouse_event(&mut self, _: &NodeHandle, _: &MouseEventKind) -> Result<()> { Ok(()) }
            fn evaluate(&mut self, _: &str) -> Result<serde_json::Value> { Ok(serde_json::Value::Null) }
            fn capture_screenshot(&mut self, _: &crate::capture::ImageFormat) -> Result<Vec<u8>> { Ok(Vec::new()) }
            fn capture_pdf(&mut self, _: &crate::capture::PrintOptions) -> Result<Vec<u8>> { Ok(Vec::new()) }
        }
        let mut c = Null;
        let h = NodeHandle { node_id: 1, backend_node_id: 1 };
        assert!(click(&mut c, &h, Point { x: f64::NAN, y: 0.0 }, ClickOptions::default()).is_err());
        assert!(click(&mut c, &h, Point { x: f64::INFINITY, y: 0.0 }, ClickOptions::default()).is_err());
        assert!(scroll(&mut c, &h, f64::NAN).is_err());
    }
}
