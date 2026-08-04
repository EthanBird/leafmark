use leafmark_archive::ArchiveEntry;
use leafmark_domain::DocumentId;
use leafmark_editor::{EditResult, EditSemantic};
use leafmark_platform::AppDirectories;
use leafmark_runtime::{LeafmarkRuntime, RuntimeDocumentView};
use leafmark_storage::{DocumentEntry, EntryKind, WorkspaceService};
use std::{error::Error, fmt, fs, path::Path};

const WELCOME_DOCUMENT: &str = r#"# 欢迎使用 LeafMark Native

LeafMark 正在迁移为完全原生的 Rust Markdown 工作区。

- Dioxus Native / Blitz 应用外壳
- Rope 事务编辑器
- 原生 Markdown AST
- 历史与收藏保留副本
- 统一屏幕、HTML、SVG、PNG 与 PDF 场景

```mermaid
flowchart LR
  Markdown --> AST
  AST --> Scene
  Scene --> Screen
  Scene --> Export
```
"#;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AppError {
    Platform(String),
    Runtime(String),
    Storage(String),
    MissingDocument,
    ExhaustedNames,
}

impl fmt::Display for AppError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Platform(message) => write!(formatter, "平台初始化失败：{message}"),
            Self::Runtime(message) => write!(formatter, "应用运行时失败：{message}"),
            Self::Storage(message) => write!(formatter, "文档库失败：{message}"),
            Self::MissingDocument => formatter.write_str("当前没有打开的文档"),
            Self::ExhaustedNames => formatter.write_str("无法生成唯一的新文档名称"),
        }
    }
}

impl Error for AppError {}

type Result<T> = std::result::Result<T, AppError>;

pub struct AppController {
    directories: AppDirectories,
    workspace: WorkspaceService,
    runtime: LeafmarkRuntime,
    workspace_entries: Vec<DocumentEntry>,
    archive_entries: Vec<ArchiveEntry>,
    tabs: Vec<DocumentId>,
    active: Option<DocumentId>,
    notice: String,
}

impl AppController {
    pub fn bootstrap_current() -> Result<Self> {
        let directories = AppDirectories::resolve_desktop()
            .map_err(|error| AppError::Platform(error.to_string()))?;
        Self::bootstrap(directories)
    }

    pub fn bootstrap(directories: AppDirectories) -> Result<Self> {
        for directory in [
            &directories.config,
            &directories.data,
            &directories.cache,
            &directories.documents,
            &directories.workspace,
        ] {
            fs::create_dir_all(directory).map_err(|error| AppError::Storage(error.to_string()))?;
        }
        let workspace = WorkspaceService::open(&directories.workspace)
            .map_err(|error| AppError::Storage(error.to_string()))?;
        let mut workspace_entries = workspace
            .scan()
            .map_err(|error| AppError::Storage(error.to_string()))?;
        if !workspace_entries
            .iter()
            .any(|entry| entry.kind == EntryKind::File)
        {
            workspace
                .write("欢迎.md", WELCOME_DOCUMENT)
                .map_err(|error| AppError::Storage(error.to_string()))?;
            workspace_entries = workspace
                .scan()
                .map_err(|error| AppError::Storage(error.to_string()))?;
        }
        let mut runtime =
            LeafmarkRuntime::open(&directories.workspace, directories.document_library())
                .map_err(|error| AppError::Runtime(error.to_string()))?;
        let first_path = workspace_entries
            .iter()
            .find(|entry| entry.kind == EntryKind::File)
            .map(|entry| entry.path.clone())
            .ok_or(AppError::MissingDocument)?;
        let active = runtime
            .open_workspace(&first_path)
            .map_err(|error| AppError::Runtime(error.to_string()))?;
        let archive_entries = runtime
            .archive_entries()
            .map_err(|error| AppError::Runtime(error.to_string()))?;
        Ok(Self {
            directories,
            workspace,
            runtime,
            workspace_entries,
            archive_entries,
            tabs: vec![active.clone()],
            active: Some(active),
            notice: "原生文档库已就绪".to_owned(),
        })
    }

    pub fn directories(&self) -> &AppDirectories {
        &self.directories
    }

    pub fn workspace_entries(&self) -> &[DocumentEntry] {
        &self.workspace_entries
    }

    pub fn archive_entries(&self) -> &[ArchiveEntry] {
        &self.archive_entries
    }

    pub fn tabs(&self) -> Vec<RuntimeDocumentView> {
        self.tabs
            .iter()
            .filter_map(|id| self.runtime.document(id))
            .collect()
    }

    pub fn active_id(&self) -> Option<&DocumentId> {
        self.active.as_ref()
    }

    pub fn active_view(&self) -> Option<RuntimeDocumentView> {
        self.active
            .as_ref()
            .and_then(|id| self.runtime.document(id))
    }

    pub fn notice(&self) -> &str {
        &self.notice
    }

    pub fn open_workspace(&mut self, path: &str) -> Result<DocumentId> {
        let id = self
            .runtime
            .open_workspace(path)
            .map_err(|error| AppError::Runtime(error.to_string()))?;
        self.activate_or_insert(id.clone())?;
        self.refresh_archive()?;
        self.notice = format!("已打开 {path}");
        Ok(id)
    }

    pub fn open_archive(&mut self, archive_id: &str) -> Result<DocumentId> {
        let id = self
            .runtime
            .open_archive(archive_id)
            .map_err(|error| AppError::Runtime(error.to_string()))?;
        self.activate_or_insert(id.clone())?;
        self.refresh_archive()?;
        self.notice = "已从保留副本打开文档".to_owned();
        Ok(id)
    }

    pub fn open_external(&mut self, path: impl AsRef<Path>) -> Result<DocumentId> {
        let path = path.as_ref();
        let id = self
            .runtime
            .open_external(path)
            .map_err(|error| AppError::Runtime(error.to_string()))?;
        self.activate_or_insert(id.clone())?;
        self.refresh_archive()?;
        self.notice = format!("已保留外部文档副本：{}", path.display());
        Ok(id)
    }

    pub fn create_document(&mut self, path: &str) -> Result<DocumentId> {
        self.workspace
            .create(path, EntryKind::File)
            .map_err(|error| AppError::Storage(error.to_string()))?;
        self.refresh_workspace()?;
        self.open_workspace(path)
    }

    pub fn create_untitled(&mut self) -> Result<DocumentId> {
        for index in 1..10_000 {
            let path = if index == 1 {
                "未命名.md".to_owned()
            } else {
                format!("未命名-{index}.md")
            };
            if !self
                .workspace_entries
                .iter()
                .any(|entry| entry.path == path)
            {
                return self.create_document(&path);
            }
        }
        Err(AppError::ExhaustedNames)
    }

    pub fn activate(&mut self, id: &DocumentId) -> Result<()> {
        self.runtime
            .activate(id)
            .map_err(|error| AppError::Runtime(error.to_string()))?;
        self.active = Some(id.clone());
        Ok(())
    }

    pub fn close(&mut self, id: &DocumentId) -> Result<()> {
        let position = self
            .tabs
            .iter()
            .position(|candidate| candidate == id)
            .ok_or(AppError::MissingDocument)?;
        self.runtime
            .close(id)
            .map_err(|error| AppError::Runtime(error.to_string()))?;
        self.tabs.remove(position);
        if self.active.as_ref() == Some(id) {
            let next = self
                .tabs
                .get(position)
                .or_else(|| {
                    position
                        .checked_sub(1)
                        .and_then(|index| self.tabs.get(index))
                })
                .cloned();
            if let Some(next) = next {
                self.runtime
                    .activate(&next)
                    .map_err(|error| AppError::Runtime(error.to_string()))?;
                self.active = Some(next);
            } else {
                self.active = None;
            }
        }
        Ok(())
    }

    pub fn edit_active(
        &mut self,
        value: &str,
        semantic: EditSemantic,
    ) -> Result<Option<EditResult>> {
        let id = self.active.clone().ok_or(AppError::MissingDocument)?;
        let result = self
            .runtime
            .edit_full_value(&id, value, semantic)
            .map_err(|error| AppError::Runtime(error.to_string()))?;
        if result.is_some() {
            self.notice = "正在编辑，尚未保存".to_owned();
        }
        Ok(result)
    }

    pub fn save_active(&mut self) -> Result<RuntimeDocumentView> {
        let id = self.active.clone().ok_or(AppError::MissingDocument)?;
        let view = self
            .runtime
            .save(&id)
            .map_err(|error| AppError::Runtime(error.to_string()))?;
        self.refresh_workspace()?;
        self.refresh_archive()?;
        self.notice = format!("已保存 {}", display_name(&view.path));
        Ok(view)
    }

    pub fn undo_active(&mut self) -> Result<Option<EditResult>> {
        let id = self.active.clone().ok_or(AppError::MissingDocument)?;
        let result = self
            .runtime
            .undo(&id)
            .map_err(|error| AppError::Runtime(error.to_string()))?;
        if result.is_some() {
            self.notice = "已撤销".to_owned();
        }
        Ok(result)
    }

    pub fn redo_active(&mut self) -> Result<Option<EditResult>> {
        let id = self.active.clone().ok_or(AppError::MissingDocument)?;
        let result = self
            .runtime
            .redo(&id)
            .map_err(|error| AppError::Runtime(error.to_string()))?;
        if result.is_some() {
            self.notice = "已重做".to_owned();
        }
        Ok(result)
    }

    pub fn refresh(&mut self) -> Result<()> {
        self.refresh_workspace()?;
        self.refresh_archive()
    }

    fn activate_or_insert(&mut self, id: DocumentId) -> Result<()> {
        if !self.tabs.contains(&id) {
            self.tabs.push(id.clone());
        }
        self.runtime
            .activate(&id)
            .map_err(|error| AppError::Runtime(error.to_string()))?;
        self.active = Some(id);
        Ok(())
    }

    fn refresh_workspace(&mut self) -> Result<()> {
        self.workspace_entries = self
            .workspace
            .scan()
            .map_err(|error| AppError::Storage(error.to_string()))?;
        Ok(())
    }

    fn refresh_archive(&mut self) -> Result<()> {
        self.archive_entries = self
            .runtime
            .archive_entries()
            .map_err(|error| AppError::Runtime(error.to_string()))?;
        Ok(())
    }
}

fn display_name(path: &str) -> &str {
    path.rsplit(['/', '\\']).next().unwrap_or(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_directories(label: &str) -> AppDirectories {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("leafmark-app-{label}-{}-{now}", std::process::id()));
        AppDirectories {
            config: root.join("config"),
            data: root.join("data"),
            cache: root.join("cache"),
            documents: root.join("documents"),
            workspace: root.join("documents/LeafMark"),
        }
    }

    fn cleanup(directories: &AppDirectories) {
        if let Some(root) = directories.config.parent() {
            let _ = fs::remove_dir_all(root);
        }
    }

    #[test]
    fn bootstrap_creates_and_opens_welcome_document() {
        let directories = temp_directories("bootstrap");
        let controller = AppController::bootstrap(directories.clone()).unwrap();
        assert!(controller
            .workspace_entries()
            .iter()
            .any(|entry| entry.path == "欢迎.md"));
        assert_eq!(controller.tabs().len(), 1);
        assert!(controller
            .active_view()
            .unwrap()
            .source
            .contains("LeafMark Native"));
        cleanup(&directories);
    }

    #[test]
    fn real_document_edit_save_and_reopen_use_runtime() {
        let directories = temp_directories("edit");
        let mut controller = AppController::bootstrap(directories.clone()).unwrap();
        let id = controller.create_document("笔记.md").unwrap();
        controller
            .edit_active("# 原生笔记\n\n正文", EditSemantic::Typing)
            .unwrap();
        let saved = controller.save_active().unwrap();
        assert!(!saved.dirty);
        controller.close(&id).unwrap();
        controller.open_workspace("笔记.md").unwrap();
        assert_eq!(
            controller.active_view().unwrap().source,
            "# 原生笔记\n\n正文"
        );
        cleanup(&directories);
    }

    #[test]
    fn external_documents_are_history_only_and_never_written_back() {
        let directories = temp_directories("external");
        fs::create_dir_all(&directories.documents).unwrap();
        let incoming = directories.documents.join("incoming.md");
        fs::write(&incoming, "original").unwrap();
        let mut controller = AppController::bootstrap(directories.clone()).unwrap();
        controller.open_external(&incoming).unwrap();
        controller
            .edit_active("retained", EditSemantic::Typing)
            .unwrap();
        controller.save_active().unwrap();
        assert_eq!(fs::read_to_string(&incoming).unwrap(), "original");
        assert!(controller
            .archive_entries()
            .iter()
            .any(|entry| entry.source_path == incoming.to_string_lossy()));
        cleanup(&directories);
    }

    #[test]
    fn tabs_activate_close_and_preserve_neighbor_order() {
        let directories = temp_directories("tabs");
        let mut controller = AppController::bootstrap(directories.clone()).unwrap();
        let first = controller.active_id().unwrap().clone();
        let second = controller.create_document("second.md").unwrap();
        let third = controller.create_document("third.md").unwrap();
        assert_eq!(controller.tabs().len(), 3);
        controller.activate(&second).unwrap();
        controller.close(&second).unwrap();
        assert_eq!(controller.active_id(), Some(&third));
        controller.close(&third).unwrap();
        assert_eq!(controller.active_id(), Some(&first));
        cleanup(&directories);
    }
}
