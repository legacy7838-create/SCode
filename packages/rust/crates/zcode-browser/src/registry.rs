//! The single owner of tab state.
//!
//! `browserGuestManager.ts` kept this in the Electron main process as four maps that had to be
//! kept in step. Here there is one owner and one mutation path: [`TabRegistry::open`] is the
//! only way a tab id is ever produced, and every other operation takes that id. That is what
//! removes the class of bug where a closed tab is still routable because a second map was not
//! updated — the reason the TypeScript version needed the `browserTabRecoveryStore` on top.

use crate::{Error, Result};
use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum TabState {
    /// Loaded and attached; the agent may act on it.
    Active,
    /// The renderer attached to it is gone, but the page is still alive and can be re-attached.
    /// This is what tab recovery restores from.
    Detached,
    /// Closing or closed. Retained as a tombstone so a late event for a closed tab is rejected
    /// with `UnknownTab` instead of being applied to whatever tab took its slot.
    Closed,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Tab {
    pub id: u64,
    pub url: String,
    pub state: TabState,
    /// Monotonic per-registry counter. Ids are never reused, so a stale handle from a closed
    /// tab can never address the tab that later takes its number.
    pub target_id: String,
}

#[derive(Debug, Default)]
pub struct TabRegistry {
    tabs: HashMap<u64, Tab>,
    order: Vec<u64>,
    focused: Option<u64>,
    next_id: u64,
}

impl TabRegistry {
    pub fn new() -> Self {
        Self {
            // Ids start at 1 so that 0 stays available as "no tab": `Option<u64>` is already
            // that, but a debugged zero id in a log should not look like a real tab.
            next_id: 1,
            ..Default::default()
        }
    }

    pub fn open(&mut self, url: impl Into<String>, target_id: impl Into<String>) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        self.order.push(id);
        self.tabs.insert(
            id,
            Tab {
                id,
                url: url.into(),
                state: TabState::Active,
                target_id: target_id.into(),
            },
        );
        self.focused = Some(id);
        id
    }

    pub fn get(&self, id: u64) -> Result<&Tab> {
        match self.tabs.get(&id) {
            None => Err(Error::UnknownTab(id)),
            // A tombstone answers with UnknownTab rather than the tab: to a caller the tab is
            // gone, and surfacing `Closed` would invite it to treat closing as a retryable state.
            Some(tab) if tab.state == TabState::Closed => Err(Error::UnknownTab(id)),
            Some(tab) => Ok(tab),
        }
    }

    pub fn focus(&mut self, id: u64) -> Result<()> {
        let tab = self.get(id)?;
        if tab.state != TabState::Active {
            // Focusing a detached tab is the exact question recovery asks, so it is an error
            // with an actionable name rather than a silent focus of a dead page.
            return Err(Error::Invalid(format!("tab {id} is detached")));
        }
        self.focused = Some(id);
        Ok(())
    }

    pub fn focused(&self) -> Result<u64> {
        self.focused.ok_or(Error::NoFocusedTab)
    }

    pub fn detach(&mut self, id: u64) -> Result<()> {
        let tab = self.tabs.get_mut(&id).ok_or(Error::UnknownTab(id))?;
        if tab.state == TabState::Closed {
            return Err(Error::UnknownTab(id));
        }
        tab.state = TabState::Detached;
        // Focus must not stay on a tab the user can no longer see, or the next agent command
        // with no explicit tab would target a page that is not on screen.
        if self.focused == Some(id) {
            self.focused = self.order.iter().rev().copied().find(|c| {
                self.tabs.get(c).is_some_and(|t| t.state == TabState::Active)
            });
        }
        Ok(())
    }

    pub fn close(&mut self, id: u64) -> Result<()> {
        let tab = self.tabs.get_mut(&id).ok_or(Error::UnknownTab(id))?;
        if tab.state == TabState::Closed {
            return Err(Error::UnknownTab(id));
        }
        tab.state = TabState::Closed;
        if self.focused == Some(id) {
            self.focused = None;
        }
        Ok(())
    }

    pub fn ids(&self) -> &[u64] {
        &self.order
    }

    pub fn len(&self) -> usize {
        self.order.len()
    }

    pub fn is_empty(&self) -> bool {
        self.order.is_empty()
    }

    /// Live tabs in creation order. Closed tombstones are filtered here rather than at each
    /// call site, so no consumer can accidentally list a tab it cannot address.
    pub fn active(&self) -> Vec<&Tab> {
        self.order
            .iter()
            .filter_map(|id| self.tabs.get(id))
            .filter(|t| t.state == TabState::Active)
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_never_reused() {
        // The property that removes the stale-handle class of bug: a late event naming tab 1
        // must not reach whatever tab later becomes tab 1.
        let mut reg = TabRegistry::new();
        let first = reg.open("https://a.test", "T1");
        reg.close(first).unwrap();
        let second = reg.open("https://b.test", "T2");
        assert_ne!(first, second);
        assert_eq!(reg.get(first), Err(Error::UnknownTab(first)));
        assert_eq!(reg.get(second).unwrap().url, "https://b.test");
    }

    #[test]
    fn opening_focuses_the_new_tab() {
        let mut reg = TabRegistry::new();
        let a = reg.open("https://a.test", "T1");
        let b = reg.open("https://b.test", "T2");
        assert_eq!(reg.focused().unwrap(), b);
        reg.focus(a).unwrap();
        assert_eq!(reg.focused().unwrap(), a);
    }

    #[test]
    fn closed_tab_answers_unknown_not_closed() {
        let mut reg = TabRegistry::new();
        let id = reg.open("https://a.test", "T1");
        reg.close(id).unwrap();
        assert_eq!(reg.get(id).unwrap_err(), Error::UnknownTab(id));
    }

    #[test]
    fn closing_twice_is_unknown_the_second_time() {
        let mut reg = TabRegistry::new();
        let id = reg.open("https://a.test", "T1");
        assert!(reg.close(id).is_ok());
        assert_eq!(reg.close(id).unwrap_err(), Error::UnknownTab(id));
    }

    #[test]
    fn detaching_moves_focus_off_the_hidden_tab() {
        // Focus left on a detached tab would make the next implicit agent command act on a
        // page the user cannot see.
        let mut reg = TabRegistry::new();
        let a = reg.open("https://a.test", "T1");
        let _b = reg.open("https://b.test", "T2");
        reg.focus(a).unwrap();
        reg.detach(a).unwrap();
        assert_eq!(reg.focused().unwrap(), _b);
    }

    #[test]
    fn closing_the_focused_tab_clears_focus() {
        let mut reg = TabRegistry::new();
        let id = reg.open("https://a.test", "T1");
        reg.close(id).unwrap();
        assert_eq!(reg.focused().unwrap_err(), Error::NoFocusedTab);
    }

    #[test]
    fn active_excludes_closed_and_detached() {
        let mut reg = TabRegistry::new();
        let a = reg.open("https://a.test", "T1");
        let b = reg.open("https://b.test", "T2");
        let c = reg.open("https://c.test", "T3");
        reg.close(b).unwrap();
        reg.detach(c).unwrap();
        let live: Vec<u64> = reg.active().into_iter().map(|t| t.id).collect();
        assert_eq!(live, vec![a]);
    }

    #[test]
    fn focusing_a_detached_tab_is_refused() {
        let mut reg = TabRegistry::new();
        let id = reg.open("https://a.test", "T1");
        reg.detach(id).unwrap();
        assert!(reg.focus(id).is_err());
    }

    #[test]
    fn unknown_tab_is_reported_not_created() {
        let reg = TabRegistry::new();
        assert_eq!(reg.get(42).unwrap_err(), Error::UnknownTab(42));
    }

    #[test]
    fn empty_registry_has_no_focus() {
        assert_eq!(TabRegistry::new().focused().unwrap_err(), Error::NoFocusedTab);
    }
}
