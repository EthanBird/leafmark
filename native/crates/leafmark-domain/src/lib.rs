use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct DocumentId(pub String);

impl DocumentId {
    pub fn workspace(path: impl Into<String>) -> Self {
        Self(format!("workspace:{}", path.into()))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct TabId(pub String);

impl From<DocumentId> for TabId {
    fn from(value: DocumentId) -> Self {
        Self(value.0)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DocumentOrigin {
    Workspace,
    Archive,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ViewMode {
    Read,
    Source,
    Split,
    Live,
}

impl ViewMode {
    pub const ALL: [Self; 4] = [Self::Read, Self::Source, Self::Split, Self::Live];

    pub const fn label(self) -> &'static str {
        match self {
            Self::Read => "阅读",
            Self::Source => "源码",
            Self::Split => "分栏",
            Self::Live => "实时",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DockPanelId {
    Workspace,
    History,
    Favorites,
    Agent,
    Outline,
}

impl DockPanelId {
    pub const ALL: [Self; 5] = [
        Self::Workspace,
        Self::History,
        Self::Favorites,
        Self::Agent,
        Self::Outline,
    ];

    pub const fn label(self) -> &'static str {
        match self {
            Self::Workspace => "文档库",
            Self::History => "历史",
            Self::Favorites => "收藏",
            Self::Agent => "Agent",
            Self::Outline => "大纲",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DockZone {
    Left,
    Right,
    Top,
    Bottom,
}

impl DockZone {
    pub const ALL: [Self; 4] = [Self::Left, Self::Right, Self::Top, Self::Bottom];
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentSnapshot {
    pub id: DocumentId,
    pub path: String,
    pub origin: DocumentOrigin,
    pub content: String,
    pub revision: u64,
}

impl DocumentSnapshot {
    pub fn workspace(path: impl Into<String>, content: impl Into<String>) -> Self {
        let path = path.into();
        Self {
            id: DocumentId::workspace(path.clone()),
            path,
            origin: DocumentOrigin::Workspace,
            content: content.into(),
            revision: 0,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenDocumentTab {
    pub id: TabId,
    pub document_id: DocumentId,
    pub path: String,
    pub origin: DocumentOrigin,
    pub content: String,
    pub saved_content: String,
    pub revision: u64,
    pub saved_revision: u64,
}

impl OpenDocumentTab {
    pub fn from_snapshot(snapshot: DocumentSnapshot) -> Self {
        Self {
            id: TabId::from(snapshot.id.clone()),
            document_id: snapshot.id,
            path: snapshot.path,
            origin: snapshot.origin,
            saved_content: snapshot.content.clone(),
            content: snapshot.content,
            revision: snapshot.revision,
            saved_revision: snapshot.revision,
        }
    }

    pub fn is_dirty(&self) -> bool {
        self.revision != self.saved_revision || self.content != self.saved_content
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DockZoneState {
    pub panels: Vec<DockPanelId>,
    pub active: Option<DockPanelId>,
}

impl DockZoneState {
    pub fn empty() -> Self {
        Self {
            panels: Vec::new(),
            active: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopDockLayout {
    pub left: DockZoneState,
    pub right: DockZoneState,
    pub top: DockZoneState,
    pub bottom: DockZoneState,
    pub hidden: Vec<DockPanelId>,
    pub left_size: u32,
    pub right_size: u32,
    pub top_size: u32,
    pub bottom_size: u32,
}

impl DesktopDockLayout {
    pub fn zone(&self, zone: DockZone) -> &DockZoneState {
        match zone {
            DockZone::Left => &self.left,
            DockZone::Right => &self.right,
            DockZone::Top => &self.top,
            DockZone::Bottom => &self.bottom,
        }
    }

    pub fn zone_mut(&mut self, zone: DockZone) -> &mut DockZoneState {
        match zone {
            DockZone::Left => &mut self.left,
            DockZone::Right => &mut self.right,
            DockZone::Top => &mut self.top,
            DockZone::Bottom => &mut self.bottom,
        }
    }
}

impl Default for DesktopDockLayout {
    fn default() -> Self {
        Self {
            left: DockZoneState {
                panels: vec![
                    DockPanelId::Workspace,
                    DockPanelId::History,
                    DockPanelId::Favorites,
                    DockPanelId::Agent,
                ],
                active: Some(DockPanelId::Workspace),
            },
            right: DockZoneState {
                panels: vec![DockPanelId::Outline],
                active: Some(DockPanelId::Outline),
            },
            top: DockZoneState::empty(),
            bottom: DockZoneState::empty(),
            hidden: vec![DockPanelId::Outline],
            left_size: 276,
            right_size: 244,
            top_size: 210,
            bottom_size: 240,
        }
    }
}
