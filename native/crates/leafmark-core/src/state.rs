use std::collections::HashSet;

use leafmark_domain::{
    DesktopDockLayout, DockPanelId, DockZone, DocumentId, DocumentOrigin, DocumentSnapshot,
    OpenDocumentTab, TabId,
};

pub fn normalize_layout(mut layout: DesktopDockLayout) -> DesktopDockLayout {
    let mut seen = HashSet::new();
    for zone in DockZone::ALL {
        let state = layout.zone_mut(zone);
        state
            .panels
            .retain(|panel| DockPanelId::ALL.contains(panel) && seen.insert(*panel));
        if !state
            .active
            .is_some_and(|active| state.panels.contains(&active))
        {
            state.active = state.panels.first().copied();
        }
    }
    for panel in DockPanelId::ALL {
        if seen.insert(panel) {
            let zone = if panel == DockPanelId::Outline {
                DockZone::Right
            } else {
                DockZone::Left
            };
            layout.zone_mut(zone).panels.push(panel);
        }
    }
    let mut hidden = HashSet::new();
    layout.hidden.retain(|panel| hidden.insert(*panel));
    layout.left_size = layout.left_size.clamp(190, 520);
    layout.right_size = layout.right_size.clamp(190, 520);
    layout.top_size = layout.top_size.clamp(130, 420);
    layout.bottom_size = layout.bottom_size.clamp(130, 420);
    layout
}

pub fn move_panel(
    layout: DesktopDockLayout,
    panel: DockPanelId,
    target: DockZone,
) -> DesktopDockLayout {
    let mut layout = normalize_layout(layout);
    for zone in DockZone::ALL {
        let state = layout.zone_mut(zone);
        state.panels.retain(|candidate| *candidate != panel);
        if state.active == Some(panel) {
            state.active = state.panels.first().copied();
        }
    }
    let target_state = layout.zone_mut(target);
    target_state.panels.push(panel);
    target_state.active = Some(panel);
    layout.hidden.retain(|candidate| *candidate != panel);
    normalize_layout(layout)
}

#[derive(Debug, Clone, Default)]
pub struct TabManager {
    tabs: Vec<OpenDocumentTab>,
    active: Option<TabId>,
}

impl TabManager {
    pub fn tabs(&self) -> &[OpenDocumentTab] {
        &self.tabs
    }

    pub fn active_id(&self) -> Option<&TabId> {
        self.active.as_ref()
    }

    pub fn active(&self) -> Option<&OpenDocumentTab> {
        let active = self.active.as_ref()?;
        self.tabs.iter().find(|tab| &tab.id == active)
    }

    pub fn get(&self, id: &TabId) -> Option<&OpenDocumentTab> {
        self.tabs.iter().find(|tab| &tab.id == id)
    }

    pub fn contains_document(&self, document_id: &DocumentId) -> Option<TabId> {
        self.tabs
            .iter()
            .find(|tab| &tab.document_id == document_id)
            .map(|tab| tab.id.clone())
    }

    pub fn open(&mut self, snapshot: DocumentSnapshot) -> TabId {
        let tab = OpenDocumentTab::from_snapshot(snapshot);
        let id = tab.id.clone();
        if let Some(index) = self.tabs.iter().position(|candidate| candidate.id == id) {
            self.tabs[index] = tab;
        } else {
            self.tabs.push(tab);
        }
        self.active = Some(id.clone());
        id
    }

    pub fn activate(&mut self, id: &TabId) -> bool {
        if self.tabs.iter().any(|tab| &tab.id == id) {
            self.active = Some(id.clone());
            true
        } else {
            false
        }
    }

    pub fn close(&mut self, id: &TabId) -> Option<OpenDocumentTab> {
        let index = self.tabs.iter().position(|tab| &tab.id == id)?;
        let removed = self.tabs.remove(index);
        if self.active.as_ref() == Some(id) {
            self.active = self
                .tabs
                .get(index)
                .or_else(|| index.checked_sub(1).and_then(|i| self.tabs.get(i)))
                .map(|tab| tab.id.clone());
        }
        Some(removed)
    }

    pub fn replace_content(&mut self, id: &TabId, content: String) -> bool {
        let Some(tab) = self.tabs.iter_mut().find(|tab| &tab.id == id) else {
            return false;
        };
        if tab.content != content {
            tab.content = content;
            tab.revision = tab.revision.saturating_add(1);
        }
        true
    }

    pub fn mark_saved(&mut self, id: &TabId) -> bool {
        let Some(tab) = self.tabs.iter_mut().find(|tab| &tab.id == id) else {
            return false;
        };
        tab.saved_content.clone_from(&tab.content);
        tab.saved_revision = tab.revision;
        true
    }

    pub fn remap_workspace_path(&mut self, source: &str, target: &str) {
        for tab in &mut self.tabs {
            if tab.origin != DocumentOrigin::Workspace {
                continue;
            }
            let suffix = if tab.path == source {
                Some("")
            } else {
                tab.path
                    .strip_prefix(source)
                    .filter(|value| value.starts_with('/'))
            };
            let Some(suffix) = suffix else { continue };
            let old_id = tab.id.clone();
            tab.path = format!("{target}{suffix}");
            tab.document_id = DocumentId::workspace(tab.path.clone());
            tab.id = TabId::from(tab.document_id.clone());
            if self.active.as_ref() == Some(&old_id) {
                self.active = Some(tab.id.clone());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layout_deduplicates_and_restores_outline() {
        let mut layout = DesktopDockLayout::default();
        layout.left.panels.push(DockPanelId::Workspace);
        layout.right.panels.clear();
        let layout = normalize_layout(layout);
        let count = DockZone::ALL
            .into_iter()
            .map(|zone| layout.zone(zone).panels.len())
            .sum::<usize>();
        assert_eq!(count, DockPanelId::ALL.len());
        assert!(layout.right.panels.contains(&DockPanelId::Outline));
    }

    #[test]
    fn tab_edit_save_activate_and_directory_remap_are_stable() {
        let mut tabs = TabManager::default();
        let first = tabs.open(DocumentSnapshot::workspace("old/a.md", "one"));
        let second = tabs.open(DocumentSnapshot::workspace("old/b.md", "two"));
        assert!(tabs.activate(&first));
        tabs.replace_content(&first, "updated".to_owned());
        assert!(tabs.active().is_some_and(OpenDocumentTab::is_dirty));
        tabs.mark_saved(&first);
        assert!(tabs.close(&second).is_some());
        tabs.remap_workspace_path("old", "new");
        assert_eq!(tabs.active().map(|tab| tab.path.as_str()), Some("new/a.md"));
        assert!(!tabs.active().is_some_and(OpenDocumentTab::is_dirty));
    }

    #[test]
    fn finds_an_existing_document_without_reopening_it() {
        let mut tabs = TabManager::default();
        let id = tabs.open(DocumentSnapshot::workspace("note.md", "body"));
        let document_id = DocumentId::workspace("note.md");
        assert_eq!(tabs.contains_document(&document_id), Some(id));
    }
}
