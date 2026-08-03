use leafmark_archive::{ArchiveEntry, ArchivedContent, DocumentArchive};
use leafmark_core::TabManager;
use leafmark_domain::{DocumentId, DocumentOrigin, DocumentSnapshot, TabId};
use leafmark_editor::{EditResult, EditSemantic, EditorDocument};
use leafmark_markdown::{parse_markdown, ParsedDocument};
use leafmark_native_compat::apply_full_value;
use leafmark_scene::{build_scene, DocumentScene, LayoutConfig, SceneTheme};
use leafmark_storage::{DocumentEntry, WorkspaceService};
use std::{collections::HashMap, error::Error, fmt, path::Path};

#[derive(Debug, Clone, PartialEq)]
pub struct RuntimeDocumentView {
    pub id: DocumentId,
    pub path: String,
    pub origin: DocumentOrigin,
    pub archive_id: String,
    pub source_path: String,
    pub source_exists: bool,
    pub source: String,
    pub revision: u64,
    pub dirty: bool,
    pub parsed: ParsedDocument,
    pub scene: DocumentScene,
}

struct RuntimeDocumentSeed {
    id: DocumentId,
    path: String,
    origin: DocumentOrigin,
    archive_id: String,
    source_path: String,
    source_exists: bool,
    source: String,
}

struct RuntimeDocument {
    id: DocumentId,
    path: String,
    origin: DocumentOrigin,
    archive_id: String,
    source_path: String,
    source_exists: bool,
    editor: EditorDocument,
    parsed: ParsedDocument,
    scene: DocumentScene,
}

impl RuntimeDocument {
    fn new(seed: RuntimeDocumentSeed, layout: LayoutConfig, theme: SceneTheme) -> Self {
        let parsed = parse_markdown(&seed.source);
        let scene = build_scene(&parsed, &seed.source, layout, theme);
        Self {
            id: seed.id,
            path: seed.path,
            origin: seed.origin,
            archive_id: seed.archive_id,
            source_path: seed.source_path,
            source_exists: seed.source_exists,
            editor: EditorDocument::new(&seed.source),
            parsed,
            scene,
        }
    }

    fn refresh(&mut self, layout: LayoutConfig, theme: SceneTheme) {
        let source = self.editor.source();
        self.parsed = parse_markdown(&source);
        self.scene = build_scene(&self.parsed, &source, layout, theme);
    }

    fn view(&self) -> RuntimeDocumentView {
        RuntimeDocumentView {
            id: self.id.clone(),
            path: self.path.clone(),
            origin: self.origin,
            archive_id: self.archive_id.clone(),
            source_path: self.source_path.clone(),
            source_exists: self.source_exists,
            source: self.editor.source(),
            revision: self.editor.revision(),
            dirty: self.editor.is_dirty(),
            parsed: self.parsed.clone(),
            scene: self.scene.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RuntimeError {
    Storage(String),
    Archive(String),
    Edit(String),
    MissingDocument,
}

impl fmt::Display for RuntimeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Storage(message) => write!(formatter, "文件服务错误：{message}"),
            Self::Archive(message) => write!(formatter, "保留副本错误：{message}"),
            Self::Edit(message) => write!(formatter, "编辑器错误：{message}"),
            Self::MissingDocument => formatter.write_str("文档尚未打开"),
        }
    }
}

impl Error for RuntimeError {}

type Result<T> = std::result::Result<T, RuntimeError>;

pub struct LeafmarkRuntime {
    workspace: WorkspaceService,
    archive: DocumentArchive,
    tabs: TabManager,
    documents: HashMap<DocumentId, RuntimeDocument>,
    active: Option<DocumentId>,
    layout: LayoutConfig,
    theme: SceneTheme,
}

impl LeafmarkRuntime {
    pub fn open(
        workspace_root: impl AsRef<Path>,
        archive_root: impl AsRef<Path>,
    ) -> Result<Self> {
        Ok(Self {
            workspace: WorkspaceService::open(workspace_root)
                .map_err(|error| RuntimeError::Storage(error.to_string()))?,
            archive: DocumentArchive::load(archive_root)
                .map_err(|error| RuntimeError::Archive(error.to_string()))?,
            tabs: TabManager::default(),
            documents: HashMap::new(),
            active: None,
            layout: LayoutConfig::default(),
            theme: SceneTheme::default(),
        })
    }

    pub fn workspace_entries(&self) -> Result<Vec<DocumentEntry>> {
        self.workspace
            .scan()
            .map_err(|error| RuntimeError::Storage(error.to_string()))
    }

    pub fn archive_entries(&mut self) -> Result<Vec<ArchiveEntry>> {
        self.archive
            .entries()
            .map_err(|error| RuntimeError::Archive(error.to_string()))
    }

    pub fn active(&self) -> Option<RuntimeDocumentView> {
        let id = self.active.as_ref()?;
        self.documents.get(id).map(RuntimeDocument::view)
    }

    pub fn document(&self, id: &DocumentId) -> Option<RuntimeDocumentView> {
        self.documents.get(id).map(RuntimeDocument::view)
    }

    pub fn open_workspace(&mut self, path: &str) -> Result<DocumentId> {
        let loaded = self
            .workspace
            .read(path)
            .map_err(|error| RuntimeError::Storage(error.to_string()))?;
        let source_path = self.workspace.root().join(&loaded.path);
        let archived = self
            .archive
            .record(
                &source_path,
                &loaded.content,
                loaded.size,
                loaded.modified_ms,
                true,
            )
            .map_err(|error| RuntimeError::Archive(error.to_string()))?;
        let id = DocumentId::workspace(loaded.path.clone());
        let document = RuntimeDocument::new(
            RuntimeDocumentSeed {
                id: id.clone(),
                path: loaded.path.clone(),
                origin: DocumentOrigin::Workspace,
                archive_id: archived.id,
                source_path: archived.source_path,
                source_exists: true,
                source: loaded.content.clone(),
            },
            self.layout,
            self.theme,
        );
        self.tabs
            .open(DocumentSnapshot::workspace(loaded.path, loaded.content));
        self.documents.insert(id.clone(), document);
        self.active = Some(id.clone());
        Ok(id)
    }

    pub fn open_external(&mut self, path: impl AsRef<Path>) -> Result<DocumentId> {
        let archived = self
            .archive
            .open_source(path.as_ref())
            .map_err(|error| RuntimeError::Archive(error.to_string()))?;
        self.insert_archive_document(archived)
    }

    pub fn open_archive(&mut self, archive_id: &str) -> Result<DocumentId> {
        let archived = self
            .archive
            .open(archive_id)
            .map_err(|error| RuntimeError::Archive(error.to_string()))?;
        self.insert_archive_document(archived)
    }

    fn insert_archive_document(&mut self, archived: ArchivedContent) -> Result<DocumentId> {
        let id = DocumentId(format!("archive:{}", archived.entry.id));
        let path = archived.entry.source_path.clone();
        let snapshot = DocumentSnapshot {
            id: id.clone(),
            path: path.clone(),
            origin: DocumentOrigin::Archive,
            content: archived.content.clone(),
            revision: 0,
        };
        let document = RuntimeDocument::new(
            RuntimeDocumentSeed {
                id: id.clone(),
                path,
                origin: DocumentOrigin::Archive,
                archive_id: archived.entry.id,
                source_path: archived.entry.source_path,
                source_exists: archived.entry.source_exists,
                source: archived.content,
            },
            self.layout,
            self.theme,
        );
        self.tabs.open(snapshot);
        self.documents.insert(id.clone(), document);
        self.active = Some(id.clone());
        Ok(id)
    }

    pub fn activate(&mut self, id: &DocumentId) -> Result<()> {
        if !self.documents.contains_key(id) {
            return Err(RuntimeError::MissingDocument);
        }
        self.active = Some(id.clone());
        Ok(())
    }

    pub fn close(&mut self, id: &DocumentId) -> Result<()> {
        if self.documents.remove(id).is_none() {
            return Err(RuntimeError::MissingDocument);
        }
        self.tabs.close(&TabId(id.0.clone()));
        if self.active.as_ref() == Some(id) {
            self.active = self.tabs.active().map(|tab| tab.document_id.clone());
        }
        Ok(())
    }

    pub fn edit_full_value(
        &mut self,
        id: &DocumentId,
        next: &str,
        semantic: EditSemantic,
    ) -> Result<Option<EditResult>> {
        let document = self
            .documents
            .get_mut(id)
            .ok_or(RuntimeError::MissingDocument)?;
        let result = apply_full_value(&mut document.editor, next, semantic)
            .map_err(|error| RuntimeError::Edit(error.to_string()))?;
        if result.is_some() {
            document.refresh(self.layout, self.theme);
            self.tabs
                .replace_content(&TabId(id.0.clone()), document.editor.source());
        }
        Ok(result)
    }

    pub fn undo(&mut self, id: &DocumentId) -> Result<Option<EditResult>> {
        let document = self
            .documents
            .get_mut(id)
            .ok_or(RuntimeError::MissingDocument)?;
        let result = document.editor.undo();
        if result.is_some() {
            document.refresh(self.layout, self.theme);
            self.tabs
                .replace_content(&TabId(id.0.clone()), document.editor.source());
        }
        Ok(result)
    }

    pub fn redo(&mut self, id: &DocumentId) -> Result<Option<EditResult>> {
        let document = self
            .documents
            .get_mut(id)
            .ok_or(RuntimeError::MissingDocument)?;
        let result = document.editor.redo();
        if result.is_some() {
            document.refresh(self.layout, self.theme);
            self.tabs
                .replace_content(&TabId(id.0.clone()), document.editor.source());
        }
        Ok(result)
    }

    pub fn save(&mut self, id: &DocumentId) -> Result<RuntimeDocumentView> {
        let (origin, path, archive_id, source) = {
            let document = self
                .documents
                .get(id)
                .ok_or(RuntimeError::MissingDocument)?;
            (
                document.origin,
                document.path.clone(),
                document.archive_id.clone(),
                document.editor.source(),
            )
        };
        match origin {
            DocumentOrigin::Workspace => {
                let loaded = self
                    .workspace
                    .write(&path, &source)
                    .map_err(|error| RuntimeError::Storage(error.to_string()))?;
                let source_path = self.workspace.root().join(&loaded.path);
                let entry = self
                    .archive
                    .record(
                        &source_path,
                        &loaded.content,
                        loaded.size,
                        loaded.modified_ms,
                        false,
                    )
                    .map_err(|error| RuntimeError::Archive(error.to_string()))?;
                let document = self
                    .documents
                    .get_mut(id)
                    .ok_or(RuntimeError::MissingDocument)?;
                document.archive_id = entry.id;
                document.source_path = entry.source_path;
                document.source_exists = true;
                document.editor.mark_saved();
            }
            DocumentOrigin::Archive => {
                let entry = self
                    .archive
                    .write(&archive_id, &source)
                    .map_err(|error| RuntimeError::Archive(error.to_string()))?;
                let document = self
                    .documents
                    .get_mut(id)
                    .ok_or(RuntimeError::MissingDocument)?;
                document.source_exists = entry.source_exists;
                document.editor.mark_saved();
            }
        }
        self.tabs.mark_saved(&TabId(id.0.clone()));
        self.document(id).ok_or(RuntimeError::MissingDocument)
    }

    pub fn set_layout(&mut self, layout: LayoutConfig) {
        self.layout = layout;
        self.refresh_all();
    }

    pub fn set_theme(&mut self, theme: SceneTheme) {
        self.theme = theme;
        self.refresh_all();
    }

    fn refresh_all(&mut self) {
        for document in self.documents.values_mut() {
            document.refresh(self.layout, self.theme);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        path::PathBuf,
        time::{SystemTime, UNIX_EPOCH},
    };

    fn temp_root(label: &str) -> PathBuf {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "leafmark-runtime-{label}-{}-{now}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn workspace_edit_save_and_archive_survive_source_deletion() {
        let root = temp_root("workspace");
        let workspace = root.join("workspace");
        let archive = root.join("data/document-library");
        fs::create_dir_all(&workspace).unwrap();
        fs::write(workspace.join("note.md"), "# One").unwrap();
        let mut runtime = LeafmarkRuntime::open(&workspace, &archive).unwrap();
        let id = runtime.open_workspace("note.md").unwrap();
        runtime
            .edit_full_value(&id, "# Two\n\n正文", EditSemantic::Typing)
            .unwrap();
        let view = runtime.save(&id).unwrap();
        assert!(!view.dirty);
        assert_eq!(
            fs::read_to_string(workspace.join("note.md")).unwrap(),
            "# Two\n\n正文"
        );
        fs::remove_file(workspace.join("note.md")).unwrap();
        let archived = runtime.open_archive(&view.archive_id).unwrap();
        let archived = runtime.document(&archived).unwrap();
        assert!(!archived.source_exists);
        assert_eq!(archived.source, "# Two\n\n正文");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn external_edit_never_writes_back_to_original() {
        let root = temp_root("external");
        let workspace = root.join("workspace");
        let archive = root.join("data/document-library");
        let external = root.join("incoming.md");
        fs::create_dir_all(&workspace).unwrap();
        fs::write(&external, "original").unwrap();
        let mut runtime = LeafmarkRuntime::open(&workspace, &archive).unwrap();
        let id = runtime.open_external(&external).unwrap();
        runtime
            .edit_full_value(&id, "retained edit", EditSemantic::Typing)
            .unwrap();
        runtime.save(&id).unwrap();
        assert_eq!(fs::read_to_string(&external).unwrap(), "original");
        assert_eq!(runtime.document(&id).unwrap().source, "retained edit");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn undo_rebuilds_outline_and_scene() {
        let root = temp_root("undo");
        let workspace = root.join("workspace");
        let archive = root.join("data/document-library");
        fs::create_dir_all(&workspace).unwrap();
        fs::write(workspace.join("note.md"), "# Before").unwrap();
        let mut runtime = LeafmarkRuntime::open(&workspace, &archive).unwrap();
        let id = runtime.open_workspace("note.md").unwrap();
        runtime
            .edit_full_value(&id, "# After\n\n## Child", EditSemantic::Typing)
            .unwrap();
        assert_eq!(runtime.document(&id).unwrap().parsed.outline.len(), 2);
        runtime.undo(&id).unwrap();
        let view = runtime.document(&id).unwrap();
        assert_eq!(view.parsed.outline.len(), 1);
        assert_eq!(view.parsed.outline[0].text, "Before");
        assert!(!view.scene.commands.is_empty());
        fs::remove_dir_all(root).unwrap();
    }
}
