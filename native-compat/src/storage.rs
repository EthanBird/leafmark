//! Native LeafMark storage for the WebView-free Windows compatibility build.
//!
//! This module deliberately avoids GUI and web-runtime dependencies. It does
//! not call Tauri, WebView2, a browser, or the registry. On Windows it uses OS
//! APIs for atomic file replacement and Known Folder lookup. Its archive
//! layout and JSON field names
//! are compatible with `src-tauri/src/library.rs`, so the regular and native
//! editions can share history, favorites, and retained document copies.

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    env,
    ffi::{OsStr, OsString},
    fmt,
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::{Component, Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const APPLICATION_ID: &str = "com.leafmark.desktop";
const ARCHIVE_DIRECTORY: &str = "document-library";
const ARCHIVE_DOCUMENTS_DIRECTORY: &str = "documents";
const ARCHIVE_INDEX_FILE: &str = "index.json";
const SOURCE_FINGERPRINT_SUFFIX: &str = ".source.sha256";
const SETTINGS_FILE: &str = "settings.json";
const INDEX_VERSION: u32 = 1;
const MARKDOWN_EXTENSIONS: [&str; 2] = ["md", "markdown"];
const ATOMIC_RETRY_DELAYS_MS: [u64; 7] = [0, 20, 50, 100, 180, 320, 500];
const MAX_SCAN_DEPTH: usize = 256;
const MAX_DOCUMENT_BYTES: u64 = 32 * 1024 * 1024;
const SHA256_FINGERPRINT_BYTES: usize = 32;

static TEMPORARY_FILE_SEQUENCE: AtomicU64 = AtomicU64::new(1);

/// Result returned by the WebView-free storage layer.
pub type StorageResult<T> = Result<T, StorageError>;

/// A display-ready error. Keeping the owned message makes it easy to surface
/// failures in an egui toast/status bar or move them across a worker channel.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StorageError {
    message: String,
}

impl StorageError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

impl fmt::Display for StorageError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for StorageError {}

impl From<io::Error> for StorageError {
    fn from(error: io::Error) -> Self {
        Self::new(error.to_string())
    }
}

impl From<serde_json::Error> for StorageError {
    fn from(error: serde_json::Error) -> Self {
        Self::new(error.to_string())
    }
}

/// All persistent locations used by the native build.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoragePaths {
    pub config_dir: PathBuf,
    pub settings_path: PathBuf,
    pub archive_dir: PathBuf,
    pub workspace_dir: PathBuf,
}

impl StoragePaths {
    /// Resolves the compatibility paths without consulting the registry:
    ///
    /// - `%APPDATA%/com.leafmark.desktop`
    /// - `%USERPROFILE%/Documents/LeafMark`
    pub fn windows_defaults() -> StorageResult<Self> {
        let roaming = non_empty_environment_path("APPDATA").or_else(|| {
            non_empty_environment_path("USERPROFILE")
                .map(|profile| profile.join("AppData").join("Roaming"))
        });
        let roaming = roaming.ok_or_else(|| {
            StorageError::new("无法确定 Windows 配置目录：APPDATA 与 USERPROFILE 均不可用")
        })?;
        let config_dir = roaming.join(APPLICATION_ID);
        let documents = windows_documents_directory()
            .or_else(|| windows_user_profile().map(|profile| profile.join("Documents")))
            .ok_or_else(|| StorageError::new("无法确定 Windows 文档目录"))?;
        let workspace_dir = documents.join("LeafMark");
        Ok(Self::from_roots(config_dir, workspace_dir))
    }

    /// Constructs explicit paths. This is useful for tests and for a workspace
    /// selected by the user in the native settings panel.
    pub fn from_roots(config_dir: impl Into<PathBuf>, workspace_dir: impl Into<PathBuf>) -> Self {
        let config_dir = config_dir.into();
        Self {
            settings_path: config_dir.join(SETTINGS_FILE),
            archive_dir: config_dir.join(ARCHIVE_DIRECTORY),
            config_dir,
            workspace_dir: workspace_dir.into(),
        }
    }
}

/// Entry kind used by the native workspace tree.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DocumentEntryKind {
    File,
    Directory,
}

/// A filesystem item ready for an egui tree/list model.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentEntry {
    /// Slash-separated path relative to the workspace.
    pub path: String,
    pub name: String,
    pub kind: DocumentEntryKind,
    pub depth: usize,
    pub size: u64,
    pub modified_ms: u64,
}

impl DocumentEntry {
    pub fn is_directory(&self) -> bool {
        self.kind == DocumentEntryKind::Directory
    }
}

/// Exact history/favorite schema used by `src-tauri/src/library.rs`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveEntry {
    pub id: String,
    pub name: String,
    pub source_path: String,
    pub last_opened_ms: u64,
    pub favorite: bool,
    pub source_exists: bool,
    pub size: u64,
    pub modified_ms: u64,
    /// Fields written by newer LeafMark versions are retained verbatim when
    /// this compatibility build updates the index.
    #[serde(default, flatten)]
    #[doc(hidden)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

/// Identifies whether the editor should save into the workspace or into a
/// retained archive snapshot.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DocumentOrigin {
    Workspace,
    Archive,
}

/// Content returned to the native editor. Rendering is intentionally absent:
/// Iced consumes Markdown directly and never needs an HTML/WebView bridge.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenedDocument {
    pub path: String,
    pub origin: DocumentOrigin,
    pub archive_id: String,
    pub source_path: String,
    pub source_exists: bool,
    pub content: String,
    pub size: u64,
    pub modified_ms: u64,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
struct ArchiveIndex {
    #[serde(default = "index_version")]
    version: u32,
    #[serde(default)]
    documents: Vec<ArchiveEntry>,
    #[serde(default, flatten)]
    extra: serde_json::Map<String, serde_json::Value>,
}

/// Persistent retained-copy archive. It can also be used independently by a
/// background worker as long as only one owner writes the index at a time.
#[derive(Debug)]
pub struct DocumentArchive {
    root: PathBuf,
    documents_dir: PathBuf,
    index_path: PathBuf,
    index: ArchiveIndex,
}

impl DocumentArchive {
    pub fn load(root: impl Into<PathBuf>) -> StorageResult<Self> {
        let root = root.into();
        fs::create_dir_all(&root).map_err(|error| io_at("创建文档历史目录", &root, error))?;
        let root = root
            .canonicalize()
            .map_err(|error| io_at("解析文档历史目录", &root, error))?;
        let documents_dir = root.join(ARCHIVE_DOCUMENTS_DIRECTORY);
        fs::create_dir_all(&documents_dir)
            .map_err(|error| io_at("创建文档副本目录", &documents_dir, error))?;
        let index_path = root.join(ARCHIVE_INDEX_FILE);

        let (mut index, mut needs_persist) = match fs::read(&index_path) {
            Ok(bytes) => match serde_json::from_slice::<ArchiveIndex>(&bytes) {
                Ok(index) => (index, false),
                Err(_) => {
                    backup_corrupt_index(&index_path, &root);
                    (empty_archive_index(), true)
                }
            },
            Err(error) if error.kind() == io::ErrorKind::NotFound => (empty_archive_index(), true),
            Err(error) => return Err(io_at("读取文档历史索引", &index_path, error)),
        };

        // A hand-edited/corrupt index must never be able to escape `documents`
        // through an id such as `../../file`. Duplicate ids are also discarded
        // deterministically while valid history remains intact.
        let mut seen = HashSet::new();
        let previous_len = index.documents.len();
        index
            .documents
            .retain(|entry| valid_archive_id(&entry.id) && seen.insert(entry.id.clone()));
        needs_persist |= index.documents.len() != previous_len;
        if index.version == 0 {
            index.version = INDEX_VERSION;
            needs_persist = true;
        }

        let archive = Self {
            root,
            documents_dir,
            index_path,
            index,
        };
        if needs_persist {
            archive.persist()?;
        }
        Ok(archive)
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Returns newest-first history and refreshes `sourceExists`.
    pub fn entries(&mut self) -> StorageResult<Vec<ArchiveEntry>> {
        let previous = self.index.clone();
        let mut changed = false;
        for entry in &mut self.index.documents {
            let exists = Path::new(&entry.source_path).is_file();
            if entry.source_exists != exists {
                entry.source_exists = exists;
                changed = true;
            }
        }
        if changed {
            // Availability refresh is advisory. A read-only directory or a
            // short antivirus lock must not make the retained documents
            // themselves unreadable.
            if self.persist().is_err() {
                self.index = previous;
            }
        }
        let mut entries = self.index.documents.clone();
        entries.sort_by(|left, right| {
            right
                .last_opened_ms
                .cmp(&left.last_opened_ms)
                .then_with(|| fold_name(&left.name).cmp(&fold_name(&right.name)))
        });
        Ok(entries)
    }

    /// Opens an external `.md`/`.markdown` file as a retained copy. Reopening
    /// by canonical path returns the existing copy even if that copy was
    /// edited. If an app such as WeChat presents the same attachment at a new
    /// temporary path, its immutable source fingerprint reuses the snapshot
    /// even after the retained copy has been edited.
    /// The source document is never written by this method or by [`Self::write`].
    pub fn import_external(&mut self, source: impl AsRef<Path>) -> StorageResult<OpenedDocument> {
        let requested = source.as_ref();
        if !requested.is_absolute() {
            return Err(StorageError::new("外部文档必须使用绝对路径"));
        }
        ensure_markdown_extension(requested)?;
        let canonical = requested
            .canonicalize()
            .map_err(|error| io_at("打开外部文档", requested, error))?;
        ensure_regular_file(&canonical)?;
        let metadata = fs::metadata(&canonical)
            .map_err(|error| io_at("读取外部文档信息", &canonical, error))?;
        ensure_document_size(metadata.len(), &canonical)?;
        let key = path_key(&canonical);

        if let Some(id) = self
            .index
            .documents
            .iter()
            .find(|entry| path_key(Path::new(&entry.source_path)) == key)
            .map(|entry| entry.id.clone())
        {
            return self.open(&id);
        }

        let bytes =
            fs::read(&canonical).map_err(|error| io_at("读取外部文档", &canonical, error))?;
        ensure_document_size(bytes.len() as u64, &canonical)?;
        let content = decode_text(&bytes);
        let fingerprint = source_fingerprint(&content);

        // Keep the canonical-path lookup above as the first and cheapest
        // identity rule. The sidecar is independent of `index.json` because
        // the standard LeafMark build may rewrite that schema and discard
        // fields it does not know about.
        let duplicate_id = self.index.documents.iter().find_map(|entry| {
            self.fingerprint_for_entry(entry)
                .ok()
                .filter(|candidate| candidate == &fingerprint)
                .map(|_| entry.id.clone())
        });

        if let Some(id) = duplicate_id {
            let previous = self.index.clone();
            if let Some(entry) = self.index.documents.iter_mut().find(|entry| entry.id == id) {
                entry.name = file_name_string(&canonical);
                entry.source_path = canonical.to_string_lossy().into_owned();
                entry.source_exists = true;
                entry.modified_ms = modified_ms(&metadata);
            }
            return match self.open(&id) {
                Ok(document) => Ok(document),
                Err(error) => {
                    self.index = previous;
                    Err(error)
                }
            };
        }

        let entry = self.record_source(
            &canonical,
            &content,
            metadata.len(),
            modified_ms(&metadata),
            true,
        )?;
        let mut opened = opened_archive_document(entry, content);
        opened.size = metadata.len();
        Ok(opened)
    }

    /// Records a workspace document and updates its retained safety copy.
    pub fn record_source(
        &mut self,
        source: &Path,
        content: &str,
        size: u64,
        modified_ms: u64,
        touch: bool,
    ) -> StorageResult<ArchiveEntry> {
        let previous = self.index.clone();
        let canonical = source
            .canonicalize()
            .map_err(|error| io_at("解析文档路径", source, error))?;
        ensure_regular_file(&canonical)?;
        ensure_markdown_extension(&canonical)?;
        let source_path = canonical.to_string_lossy().into_owned();
        let key = path_key(&canonical);
        let existing = self
            .index
            .documents
            .iter()
            .position(|entry| path_key(Path::new(&entry.source_path)) == key);
        let (position, created) = if let Some(position) = existing {
            (position, false)
        } else {
            let id = self.unique_id(&key);
            self.index.documents.push(ArchiveEntry {
                id,
                name: file_name_string(&canonical),
                source_path: source_path.clone(),
                last_opened_ms: now_ms(),
                favorite: false,
                source_exists: true,
                size,
                modified_ms,
                extra: serde_json::Map::new(),
            });
            (self.index.documents.len() - 1, true)
        };

        let entry = &mut self.index.documents[position];
        entry.name = file_name_string(&canonical);
        entry.source_path = source_path;
        entry.source_exists = true;
        entry.size = size;
        entry.modified_ms = modified_ms;
        if touch {
            entry.last_opened_ms = now_ms();
        }
        let result = entry.clone();
        // A new entry must always overwrite a same-id orphan sidecar. This
        // makes removal robust even when antivirus/file locking prevented the
        // previous best-effort cleanup. For an existing entry the fingerprint
        // is immutable; only old archives that have no sidecar are migrated.
        let needs_fingerprint = if created {
            true
        } else {
            match self.read_source_fingerprint(&result.id) {
                Ok(fingerprint) => fingerprint.is_none(),
                Err(error) => {
                    self.index = previous;
                    return Err(error);
                }
            }
        };
        let snapshot_path = self.snapshot_path(&result.id)?;
        if let Err(error) = atomic_write(&snapshot_path, content.as_bytes()) {
            self.index = previous;
            return Err(error);
        }
        if needs_fingerprint {
            if let Err(error) =
                self.write_source_fingerprint(&result.id, &source_fingerprint(content))
            {
                self.index = previous;
                return Err(error);
            }
        }
        self.persist_or_restore(previous)?;
        Ok(result)
    }

    pub fn open(&mut self, id: &str) -> StorageResult<OpenedDocument> {
        let previous = self.index.clone();
        let position = self
            .index
            .documents
            .iter()
            .position(|entry| entry.id == id)
            .ok_or_else(|| StorageError::new("历史记录不存在"))?;
        let bytes = self
            .read_snapshot(id)
            .map_err(|error| StorageError::new(format!("LeafMark 保留副本无法读取：{error}")))?;
        let content = decode_text(&bytes);
        let source_exists = Path::new(&self.index.documents[position].source_path).is_file();
        let entry = &mut self.index.documents[position];
        entry.source_exists = source_exists;
        entry.last_opened_ms = now_ms();
        entry.size = content.len() as u64;
        let result = entry.clone();
        // Opening a retained copy is a read operation. Failure to persist the
        // access timestamp must not hide content that was read successfully.
        if self.persist().is_err() {
            self.index = previous;
        }
        Ok(opened_archive_document(result, content))
    }

    /// Saves only the retained LeafMark copy, never the external source.
    pub fn write(&mut self, id: &str, content: &str) -> StorageResult<ArchiveEntry> {
        let previous = self.index.clone();
        let position = self
            .index
            .documents
            .iter()
            .position(|entry| entry.id == id)
            .ok_or_else(|| StorageError::new("历史记录不存在"))?;
        atomic_write(&self.snapshot_path(id)?, content.as_bytes())?;
        let source_exists = Path::new(&self.index.documents[position].source_path).is_file();
        let entry = &mut self.index.documents[position];
        entry.source_exists = source_exists;
        entry.size = content.len() as u64;
        entry.modified_ms = now_ms();
        entry.last_opened_ms = now_ms();
        let result = entry.clone();
        self.persist_or_restore(previous)?;
        Ok(result)
    }

    pub fn set_favorite(&mut self, id: &str, favorite: bool) -> StorageResult<Vec<ArchiveEntry>> {
        let previous = self.index.clone();
        let entry = self
            .index
            .documents
            .iter_mut()
            .find(|entry| entry.id == id)
            .ok_or_else(|| StorageError::new("历史记录不存在"))?;
        entry.favorite = favorite;
        self.persist_or_restore(previous)?;
        self.entries()
    }

    pub fn remove(&mut self, id: &str) -> StorageResult<Vec<ArchiveEntry>> {
        let previous = self.index.clone();
        let position = self
            .index
            .documents
            .iter()
            .position(|entry| entry.id == id)
            .ok_or_else(|| StorageError::new("历史记录不存在"))?;
        if self.index.documents[position].favorite {
            return Err(StorageError::new("请先取消收藏，再移除这条历史记录"));
        }
        let entry = self.index.documents.remove(position);
        self.persist_or_restore(previous)?;
        // The durable index is authoritative. A failed cleanup only leaves an
        // unreachable safety copy and must not resurrect a removed history row.
        if let Ok(path) = self.snapshot_path(&entry.id) {
            let _ = remove_if_present(&path);
        }
        if let Ok(path) = self.source_fingerprint_path(&entry.id) {
            let _ = remove_if_present(&path);
        }
        self.entries()
    }

    pub fn clear_history(&mut self) -> StorageResult<Vec<ArchiveEntry>> {
        let previous = self.index.clone();
        let removed: Vec<String> = self
            .index
            .documents
            .iter()
            .filter(|entry| !entry.favorite)
            .map(|entry| entry.id.clone())
            .collect();
        self.index.documents.retain(|entry| entry.favorite);
        self.persist_or_restore(previous)?;
        for id in removed {
            if let Ok(path) = self.snapshot_path(&id) {
                let _ = remove_if_present(&path);
            }
            if let Ok(path) = self.source_fingerprint_path(&id) {
                let _ = remove_if_present(&path);
            }
        }
        self.entries()
    }

    /// Returns the original source while it exists, otherwise the retained
    /// snapshot. The UI can pass this path to its platform-specific reveal API.
    pub fn reveal_path(&self, id: &str) -> StorageResult<PathBuf> {
        let entry = self
            .index
            .documents
            .iter()
            .find(|entry| entry.id == id)
            .ok_or_else(|| StorageError::new("历史记录不存在"))?;
        let source = PathBuf::from(&entry.source_path);
        if source.is_file() {
            return Ok(source);
        }
        let snapshot = self.snapshot_path(id)?;
        if snapshot.is_file() {
            return Ok(snapshot);
        }
        Err(StorageError::new("源文档和 LeafMark 保留副本都不存在"))
    }

    pub fn retained_path(&self, id: &str) -> StorageResult<PathBuf> {
        let exists = self.index.documents.iter().any(|entry| entry.id == id);
        if !exists {
            return Err(StorageError::new("历史记录不存在"));
        }
        self.snapshot_path(id)
    }

    /// Keeps source paths correct when a workspace file or directory is moved.
    pub fn rename_sources(&mut self, previous_root: &Path, next_root: &Path) -> StorageResult<()> {
        let previous = self.index.clone();
        let mut changed = false;
        for entry in &mut self.index.documents {
            let source = Path::new(&entry.source_path);
            let Ok(suffix) = source.strip_prefix(previous_root) else {
                continue;
            };
            if !safe_relative_suffix(suffix) {
                continue;
            }
            let next = if suffix.as_os_str().is_empty() {
                next_root.to_path_buf()
            } else {
                next_root.join(suffix)
            };
            entry.source_path = next.to_string_lossy().into_owned();
            entry.name = file_name_string(&next);
            entry.source_exists = next.is_file();
            changed = true;
        }
        if changed {
            self.persist_or_restore(previous)?;
        }
        Ok(())
    }

    pub fn mark_missing_under(&mut self, root: &Path) -> StorageResult<()> {
        let previous = self.index.clone();
        let mut changed = false;
        for entry in &mut self.index.documents {
            if Path::new(&entry.source_path).starts_with(root) && entry.source_exists {
                entry.source_exists = false;
                changed = true;
            }
        }
        if changed {
            self.persist_or_restore(previous)?;
        }
        Ok(())
    }

    fn read_snapshot(&self, id: &str) -> StorageResult<Vec<u8>> {
        let path = self.snapshot_path(id)?;
        ensure_regular_file(&path)?;
        let metadata =
            fs::metadata(&path).map_err(|error| io_at("读取文档保留副本信息", &path, error))?;
        ensure_document_size(metadata.len(), &path)?;
        let bytes = fs::read(&path).map_err(|error| io_at("读取文档保留副本", &path, error))?;
        ensure_document_size(bytes.len() as u64, &path)?;
        Ok(bytes)
    }

    fn snapshot_path(&self, id: &str) -> StorageResult<PathBuf> {
        if !valid_archive_id(id) {
            return Err(StorageError::new("无效的文档历史标识"));
        }
        Ok(self.documents_dir.join(format!("{id}.md")))
    }

    fn source_fingerprint_path(&self, id: &str) -> StorageResult<PathBuf> {
        if !valid_archive_id(id) {
            return Err(StorageError::new("无效的文档历史标识"));
        }
        Ok(self
            .documents_dir
            .join(format!("{id}{SOURCE_FINGERPRINT_SUFFIX}")))
    }

    fn read_source_fingerprint(&self, id: &str) -> StorageResult<Option<[u8; 32]>> {
        let path = self.source_fingerprint_path(id)?;
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(io_at("读取文档源指纹", &path, error)),
        };
        if bytes.len() != SHA256_FINGERPRINT_BYTES {
            // A truncated/corrupt sidecar is equivalent to a missing legacy
            // sidecar and will be replaced atomically from the preferred
            // source below.
            return Ok(None);
        }
        let mut fingerprint = [0_u8; SHA256_FINGERPRINT_BYTES];
        fingerprint.copy_from_slice(&bytes);
        Ok(Some(fingerprint))
    }

    fn write_source_fingerprint(&self, id: &str, fingerprint: &[u8; 32]) -> StorageResult<()> {
        atomic_write(&self.source_fingerprint_path(id)?, fingerprint)
    }

    fn fingerprint_for_entry(&self, entry: &ArchiveEntry) -> StorageResult<[u8; 32]> {
        if let Some(fingerprint) = self.read_source_fingerprint(&entry.id)? {
            return Ok(fingerprint);
        }

        let source = Path::new(&entry.source_path);
        let fingerprint = if source.is_file() {
            fingerprint_document_file(source)?
        } else {
            let snapshot = self.read_snapshot(&entry.id)?;
            source_fingerprint(&decode_text(&snapshot))
        };
        self.write_source_fingerprint(&entry.id, &fingerprint)?;
        Ok(fingerprint)
    }

    fn unique_id(&self, key: &str) -> String {
        let base = format!("{:016x}", fnv1a64(key.as_bytes()));
        if !self.index.documents.iter().any(|entry| entry.id == base) {
            return base;
        }
        for index in 2..10_000 {
            let candidate = format!("{base}-{index}");
            if !self
                .index
                .documents
                .iter()
                .any(|entry| entry.id == candidate)
            {
                return candidate;
            }
        }
        format!("{base}-{}", now_ms())
    }

    fn persist(&self) -> StorageResult<()> {
        let bytes = serde_json::to_vec_pretty(&self.index)
            .map_err(|error| StorageError::new(format!("序列化文档历史失败：{error}")))?;
        atomic_write(&self.index_path, &bytes)
    }

    fn persist_or_restore(&mut self, previous: ArchiveIndex) -> StorageResult<()> {
        if let Err(error) = self.persist() {
            self.index = previous;
            return Err(error);
        }
        Ok(())
    }
}

/// Top-level state owned by the native Iced application.
#[derive(Debug)]
pub struct NativeStorage {
    paths: StoragePaths,
    workspace: PathBuf,
    archive: DocumentArchive,
}

impl NativeStorage {
    /// Opens LeafMark's existing Windows data. If `settings.json` contains an
    /// absolute `workspacePath`, it is honored; otherwise the Documents default
    /// is used. No registry lookup is performed.
    pub fn open_default() -> StorageResult<Self> {
        let mut paths = StoragePaths::windows_defaults()?;
        if let Some(configured) = configured_workspace(&paths.settings_path) {
            // Match the standard edition: a stale removable/network workspace
            // must not prevent LeafMark from opening. Fall back to Documents.
            if fs::create_dir_all(&configured).is_ok() && configured.is_dir() {
                paths.workspace_dir = configured;
            }
        }
        Self::open_with_paths(paths)
    }

    pub fn open_with_paths(mut paths: StoragePaths) -> StorageResult<Self> {
        fs::create_dir_all(&paths.config_dir)
            .map_err(|error| io_at("创建 LeafMark 配置目录", &paths.config_dir, error))?;
        fs::create_dir_all(&paths.workspace_dir)
            .map_err(|error| io_at("创建 LeafMark 文档库", &paths.workspace_dir, error))?;
        let workspace = paths
            .workspace_dir
            .canonicalize()
            .map_err(|error| io_at("解析 LeafMark 文档库", &paths.workspace_dir, error))?;
        if !workspace.is_dir() {
            return Err(StorageError::new("文档库路径不是文件夹"));
        }
        paths.workspace_dir = workspace.clone();
        let archive = DocumentArchive::load(&paths.archive_dir)?;
        Ok(Self {
            paths,
            workspace,
            archive,
        })
    }

    pub fn paths(&self) -> &StoragePaths {
        &self.paths
    }

    pub fn workspace(&self) -> &Path {
        &self.workspace
    }

    pub fn archive(&self) -> &DocumentArchive {
        &self.archive
    }

    pub fn archive_mut(&mut self) -> &mut DocumentArchive {
        &mut self.archive
    }

    pub fn set_workspace(&mut self, path: impl AsRef<Path>) -> StorageResult<()> {
        let requested = path.as_ref();
        if !requested.is_absolute() {
            return Err(StorageError::new("文档库必须使用绝对路径"));
        }
        fs::create_dir_all(requested).map_err(|error| io_at("创建文档库", requested, error))?;
        let workspace = requested
            .canonicalize()
            .map_err(|error| io_at("解析文档库", requested, error))?;
        if !workspace.is_dir() {
            return Err(StorageError::new("文档库路径不是文件夹"));
        }
        let mut settings = self
            .load_settings_value()?
            .unwrap_or_else(|| serde_json::Value::Object(serde_json::Map::new()));
        let object = settings
            .as_object_mut()
            .ok_or_else(|| StorageError::new("设置文件的根节点必须是 JSON 对象，未覆盖现有设置"))?;
        object.insert(
            "workspacePath".to_owned(),
            serde_json::Value::String(workspace.to_string_lossy().into_owned()),
        );
        // Persist first so an I/O failure cannot leave the running UI pointing
        // at a workspace that will be forgotten on the next launch.
        self.save_settings_value(&settings)?;
        self.workspace = workspace.clone();
        self.paths.workspace_dir = workspace;
        Ok(())
    }

    pub fn scan_workspace(&self) -> StorageResult<Vec<DocumentEntry>> {
        scan_markdown_documents(&self.workspace)
    }

    pub fn open_workspace_document(
        &mut self,
        relative_path: &str,
    ) -> StorageResult<OpenedDocument> {
        let relative = validate_markdown_relative_path(relative_path)?;
        let target = secure_existing_path(&self.workspace, &relative)?;
        ensure_regular_file(&target)?;
        let metadata =
            fs::metadata(&target).map_err(|error| io_at("读取文档信息", &target, error))?;
        ensure_document_size(metadata.len(), &target)?;
        let bytes = fs::read(&target).map_err(|error| io_at("读取文档", &target, error))?;
        ensure_document_size(bytes.len() as u64, &target)?;
        let content = decode_text(&bytes);
        let size = metadata.len();
        let modified = modified_ms(&metadata);
        let archived = self
            .archive
            .record_source(&target, &content, size, modified, true)?;
        Ok(OpenedDocument {
            path: path_to_slash(&relative),
            origin: DocumentOrigin::Workspace,
            archive_id: archived.id,
            source_path: archived.source_path,
            source_exists: true,
            content,
            size,
            modified_ms: modified,
        })
    }

    /// Atomically writes an editable workspace document and refreshes its
    /// retained safety copy.
    pub fn save_workspace_document(
        &mut self,
        relative_path: &str,
        content: &str,
    ) -> StorageResult<ArchiveEntry> {
        let relative = validate_markdown_relative_path(relative_path)?;
        let target = secure_target_path(&self.workspace, &relative)?;
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|error| io_at("创建文档目录", parent, error))?;
        }
        // A directory junction/reparse point may have appeared while parents
        // were created. Resolve the nearest existing ancestor again directly
        // before the write.
        let target = secure_target_path(&self.workspace, &relative)?;
        atomic_write(&target, content.as_bytes())?;
        let metadata =
            fs::metadata(&target).map_err(|error| io_at("读取保存后的文档信息", &target, error))?;
        self.archive.record_source(
            &target,
            content,
            content.len() as u64,
            modified_ms(&metadata),
            false,
        )
    }

    pub fn create_workspace_directory(&self, relative_path: &str) -> StorageResult<PathBuf> {
        let relative = validate_relative_path(relative_path)?;
        let target = secure_target_path(&self.workspace, &relative)?;
        fs::create_dir_all(&target).map_err(|error| io_at("创建文档库文件夹", &target, error))?;
        Ok(target)
    }

    pub fn import_external(&mut self, source: impl AsRef<Path>) -> StorageResult<OpenedDocument> {
        self.archive.import_external(source)
    }

    pub fn open_archived(&mut self, id: &str) -> StorageResult<OpenedDocument> {
        self.archive.open(id)
    }

    pub fn save_archived(&mut self, id: &str, content: &str) -> StorageResult<ArchiveEntry> {
        self.archive.write(id, content)
    }

    pub fn archive_entries(&mut self) -> StorageResult<Vec<ArchiveEntry>> {
        self.archive.entries()
    }

    pub fn set_favorite(&mut self, id: &str, favorite: bool) -> StorageResult<Vec<ArchiveEntry>> {
        self.archive.set_favorite(id, favorite)
    }

    pub fn remove_history_entry(&mut self, id: &str) -> StorageResult<Vec<ArchiveEntry>> {
        self.archive.remove(id)
    }

    pub fn clear_history(&mut self) -> StorageResult<Vec<ArchiveEntry>> {
        self.archive.clear_history()
    }

    /// Copies a retained external document into the editable workspace. If its
    /// source already belongs to this workspace, the same path is updated.
    pub fn save_archived_to_workspace(&mut self, id: &str) -> StorageResult<String> {
        let archived = self.archive.open(id)?;
        let source = PathBuf::from(&archived.source_path);
        let destination = match source.strip_prefix(&self.workspace) {
            Ok(relative) if safe_relative_suffix(relative) && is_markdown(&source) => source,
            _ => unique_destination(
                &self.workspace,
                Path::new(&archived.path)
                    .file_name()
                    .unwrap_or_else(|| OsStr::new("保留文档.md")),
            ),
        };
        let destination = secure_absolute_workspace_target(&self.workspace, &destination)?;
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(|error| io_at("创建文档目录", parent, error))?;
        }
        let destination = secure_absolute_workspace_target(&self.workspace, &destination)?;
        atomic_write(&destination, archived.content.as_bytes())?;
        let metadata = fs::metadata(&destination)
            .map_err(|error| io_at("读取保存后的文档信息", &destination, error))?;
        self.archive.record_source(
            &destination,
            &archived.content,
            archived.content.len() as u64,
            modified_ms(&metadata),
            true,
        )?;
        let relative = destination
            .strip_prefix(&self.workspace)
            .map_err(|_| StorageError::new("保存路径超出文档库"))?;
        Ok(path_to_slash(relative))
    }

    /// Reads existing settings without imposing the WebView edition's UI
    /// schema on egui. Unknown fields remain preserved in `serde_json::Value`.
    pub fn load_settings_value(&self) -> StorageResult<Option<serde_json::Value>> {
        read_optional_json(&self.paths.settings_path)
    }

    pub fn save_settings_value(&self, settings: &serde_json::Value) -> StorageResult<()> {
        write_json(&self.paths.settings_path, settings)
    }
}

/// Securely scans `.md` and `.markdown` documents without following symbolic
/// links/reparse-style links. Returned paths are always relative to `root`.
pub fn scan_markdown_documents(root: &Path) -> StorageResult<Vec<DocumentEntry>> {
    let root = root
        .canonicalize()
        .map_err(|error| io_at("解析文档库", root, error))?;
    if !root.is_dir() {
        return Err(StorageError::new("文档库路径不是文件夹"));
    }
    let mut entries = Vec::new();
    let mut pending = vec![(root.clone(), PathBuf::new(), 0usize)];
    let mut visited_directories = HashSet::from([root.clone()]);

    while let Some((directory, relative_directory, depth)) = pending.pop() {
        if depth > MAX_SCAN_DEPTH {
            continue;
        }
        let children = match fs::read_dir(&directory) {
            Ok(children) => children,
            Err(error) if skippable_scan_error(&error) => continue,
            Err(error) => return Err(io_at("扫描文档库", &directory, error)),
        };
        for child in children {
            let child = match child {
                Ok(child) => child,
                Err(error) if skippable_scan_error(&error) => continue,
                Err(error) => return Err(io_at("读取文档库条目", &directory, error)),
            };
            let name = child.file_name();
            if ignored_name(&name) {
                continue;
            }
            let metadata = match fs::symlink_metadata(child.path()) {
                Ok(metadata) => metadata,
                Err(error) if skippable_scan_error(&error) => continue,
                Err(error) => {
                    return Err(io_at("读取文档库条目信息", &child.path(), error));
                }
            };
            if metadata.file_type().is_symlink() {
                continue;
            }
            let relative = relative_directory.join(&name);
            if metadata.is_dir() {
                let canonical = match child.path().canonicalize() {
                    Ok(canonical) => canonical,
                    Err(error) if skippable_scan_error(&error) => continue,
                    Err(error) => {
                        return Err(io_at("解析文档库文件夹", &child.path(), error));
                    }
                };
                if !canonical.starts_with(&root) || !visited_directories.insert(canonical.clone()) {
                    continue;
                }
                entries.push(DocumentEntry {
                    path: path_to_slash(&relative),
                    name: name.to_string_lossy().into_owned(),
                    kind: DocumentEntryKind::Directory,
                    depth: relative.components().count().saturating_sub(1),
                    size: 0,
                    modified_ms: modified_ms(&metadata),
                });
                pending.push((canonical, relative, depth + 1));
            } else if metadata.is_file() && is_markdown(&child.path()) {
                entries.push(DocumentEntry {
                    path: path_to_slash(&relative),
                    name: name.to_string_lossy().into_owned(),
                    kind: DocumentEntryKind::File,
                    depth: relative.components().count().saturating_sub(1),
                    size: metadata.len(),
                    modified_ms: modified_ms(&metadata),
                });
            }
        }
    }

    entries.sort_by(|left, right| {
        let left_parent = parent_slash(&left.path);
        let right_parent = parent_slash(&right.path);
        fold_name(left_parent)
            .cmp(&fold_name(right_parent))
            .then_with(|| entry_kind_order(left.kind).cmp(&entry_kind_order(right.kind)))
            .then_with(|| fold_name(&left.name).cmp(&fold_name(&right.name)))
    });
    Ok(entries)
}

/// Reads a supported text document and decodes UTF-8/UTF-16 BOMs. Invalid
/// UTF-8 is lossily decoded, matching the existing LeafMark behavior.
pub fn read_markdown_file(path: &Path) -> StorageResult<String> {
    ensure_markdown_extension(path)?;
    ensure_regular_file(path)?;
    let metadata =
        fs::metadata(path).map_err(|error| io_at("读取 Markdown 文档信息", path, error))?;
    ensure_document_size(metadata.len(), path)?;
    let bytes = fs::read(path).map_err(|error| io_at("读取 Markdown 文档", path, error))?;
    ensure_document_size(bytes.len() as u64, path)?;
    Ok(decode_text(&bytes))
}

pub fn decode_text(bytes: &[u8]) -> String {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return String::from_utf8_lossy(&bytes[3..]).into_owned();
    }
    if bytes.starts_with(&[0xFF, 0xFE, 0x00, 0x00]) {
        let characters = bytes[4..]
            .chunks_exact(4)
            .filter_map(|word| {
                char::from_u32(u32::from_le_bytes([word[0], word[1], word[2], word[3]]))
            })
            .collect();
        return characters;
    }
    if bytes.starts_with(&[0x00, 0x00, 0xFE, 0xFF]) {
        let characters = bytes[4..]
            .chunks_exact(4)
            .filter_map(|word| {
                char::from_u32(u32::from_be_bytes([word[0], word[1], word[2], word[3]]))
            })
            .collect();
        return characters;
    }
    if bytes.starts_with(&[0xFF, 0xFE]) {
        let words: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        return String::from_utf16_lossy(&words);
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        let words: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|pair| u16::from_be_bytes([pair[0], pair[1]]))
            .collect();
        return String::from_utf16_lossy(&words);
    }
    String::from_utf8_lossy(bytes).into_owned()
}

/// Same-directory temp-file + flush + atomic replace. Retrying the final
/// rename handles short-lived antivirus/indexer locks without ever editing the
/// source file in place.
pub fn atomic_write(path: &Path, bytes: &[u8]) -> StorageResult<()> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent).map_err(|error| io_at("创建目标目录", parent, error))?;
    let (temporary_path, mut temporary_file) = create_temporary_file(parent, path.file_name())?;
    if let Err(error) = temporary_file
        .write_all(bytes)
        .and_then(|_| temporary_file.flush())
        .and_then(|_| temporary_file.sync_all())
    {
        drop(temporary_file);
        let _ = fs::remove_file(&temporary_path);
        return Err(io_at("写入临时文件", &temporary_path, error));
    }
    drop(temporary_file);

    let mut last_error = None;
    for delay in ATOMIC_RETRY_DELAYS_MS {
        if delay > 0 {
            thread::sleep(Duration::from_millis(delay));
        }
        match replace_file_atomically(&temporary_path, path) {
            Ok(()) => return Ok(()),
            Err(error) => last_error = Some(error),
        }
    }
    let _ = fs::remove_file(&temporary_path);
    let reason = last_error
        .map(|error| error.to_string())
        .unwrap_or_else(|| "未知错误".into());
    Err(StorageError::new(format!(
        "安全写入多次重试后仍失败：{reason}。内容仍保留在编辑器中，可点击保存重试"
    )))
}

#[cfg(target_os = "windows")]
fn replace_file_atomically(source: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    // SAFETY: Both paths are owned, NUL-terminated UTF-16 buffers and remain
    // alive for the entire call. The temp file is in the destination directory,
    // so this is a same-volume atomic replace. WRITE_THROUGH asks Windows not to
    // report success until the move has reached durable storage.
    let succeeded = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if succeeded == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(target_os = "windows"))]
fn replace_file_atomically(source: &Path, destination: &Path) -> io::Result<()> {
    fs::rename(source, destination)
}

pub fn read_optional_json<T: DeserializeOwned>(path: &Path) -> StorageResult<Option<T>> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|error| StorageError::new(format!("解析 {} 失败：{error}", path.display()))),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(io_at("读取 JSON 文件", path, error)),
    }
}

pub fn write_json<T: Serialize + ?Sized>(path: &Path, value: &T) -> StorageResult<()> {
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|error| StorageError::new(format!("序列化 {} 失败：{error}", path.display())))?;
    atomic_write(path, &bytes)
}

fn configured_workspace(settings_path: &Path) -> Option<PathBuf> {
    let value: serde_json::Value = read_optional_json(settings_path).ok().flatten()?;
    let path = PathBuf::from(value.get("workspacePath")?.as_str()?.trim());
    path.is_absolute().then_some(path)
}

fn validate_relative_path(value: &str) -> StorageResult<PathBuf> {
    let normalized = value.replace('\\', "/");
    if normalized.is_empty() {
        return Err(StorageError::new("路径不能为空"));
    }
    let path = Path::new(&normalized);
    if path.is_absolute() {
        return Err(StorageError::new("只允许文档库内的相对路径"));
    }
    let mut clean = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => {
                validate_windows_path_component(part)?;
                clean.push(part);
            }
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(StorageError::new("路径不能离开文档库"));
            }
        }
    }
    if clean.as_os_str().is_empty() {
        return Err(StorageError::new("路径不能为空"));
    }
    Ok(clean)
}

fn validate_markdown_relative_path(value: &str) -> StorageResult<PathBuf> {
    let path = validate_relative_path(value)?;
    ensure_markdown_extension(&path)?;
    Ok(path)
}

fn ensure_markdown_extension(path: &Path) -> StorageResult<()> {
    if is_markdown(path) {
        Ok(())
    } else {
        Err(StorageError::new("仅支持 .md 与 .markdown 文档"))
    }
}

fn is_markdown(path: &Path) -> bool {
    path.extension()
        .and_then(OsStr::to_str)
        .is_some_and(|extension| {
            MARKDOWN_EXTENSIONS.contains(&extension.to_ascii_lowercase().as_str())
        })
}

fn secure_existing_path(root: &Path, relative: &Path) -> StorageResult<PathBuf> {
    let root = root
        .canonicalize()
        .map_err(|error| io_at("解析文档库", root, error))?;
    let requested = root.join(relative);
    let target = requested
        .canonicalize()
        .map_err(|error| io_at("解析文档路径", &requested, error))?;
    if !target.starts_with(&root) {
        return Err(StorageError::new("路径超出文档库"));
    }
    Ok(target)
}

fn secure_target_path(root: &Path, relative: &Path) -> StorageResult<PathBuf> {
    let root = root
        .canonicalize()
        .map_err(|error| io_at("解析文档库", root, error))?;
    let target = root.join(relative);
    secure_absolute_workspace_target(&root, &target)
}

fn secure_absolute_workspace_target(root: &Path, target: &Path) -> StorageResult<PathBuf> {
    let root = root
        .canonicalize()
        .map_err(|error| io_at("解析文档库", root, error))?;
    let relative = target
        .strip_prefix(&root)
        .map_err(|_| StorageError::new("路径超出文档库"))?;
    for component in relative.components() {
        match component {
            Component::Normal(value) => validate_windows_path_component(value)?,
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(StorageError::new("路径不能离开文档库"));
            }
        }
    }
    let mut existing = target;
    while !existing.exists() {
        existing = existing
            .parent()
            .ok_or_else(|| StorageError::new("无效目标路径"))?;
    }
    let existing = existing
        .canonicalize()
        .map_err(|error| io_at("解析目标目录", existing, error))?;
    if !existing.starts_with(&root) || !target.starts_with(&root) {
        return Err(StorageError::new("路径超出文档库"));
    }
    Ok(target.to_path_buf())
}

fn ensure_regular_file(path: &Path) -> StorageResult<()> {
    let metadata =
        fs::symlink_metadata(path).map_err(|error| io_at("读取文件信息", path, error))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(StorageError::new(format!(
            "目标不是普通文件：{}",
            path.display()
        )));
    }
    Ok(())
}

fn create_temporary_file(
    parent: &Path,
    target_name: Option<&OsStr>,
) -> StorageResult<(PathBuf, File)> {
    let target_name = target_name
        .unwrap_or_else(|| OsStr::new("leafmark"))
        .to_string_lossy();
    for _ in 0..128 {
        let sequence = TEMPORARY_FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let path = parent.join(format!(
            ".{target_name}.leafmark-{}-{sequence}.tmp",
            std::process::id()
        ));
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => return Ok((path, file)),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(io_at("创建安全写入临时文件", &path, error)),
        }
    }
    Err(StorageError::new("无法创建安全写入临时文件"))
}

fn unique_destination(directory: &Path, original: &OsStr) -> PathBuf {
    let original_path = Path::new(original);
    let stem = original_path
        .file_stem()
        .unwrap_or(original)
        .to_string_lossy();
    let extension = original_path
        .extension()
        .and_then(OsStr::to_str)
        .filter(|extension| MARKDOWN_EXTENSIONS.contains(&extension.to_ascii_lowercase().as_str()))
        .unwrap_or("md");
    let direct = directory.join(format!("{stem}.{extension}"));
    if !direct.exists() {
        return direct;
    }
    for index in 1..10_000 {
        let candidate = directory.join(format!("{stem} ({index}).{extension}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    directory.join(format!("{stem}-{}.{extension}", now_ms()))
}

fn opened_archive_document(entry: ArchiveEntry, content: String) -> OpenedDocument {
    OpenedDocument {
        path: entry.source_path.clone(),
        origin: DocumentOrigin::Archive,
        archive_id: entry.id,
        source_path: entry.source_path,
        source_exists: entry.source_exists,
        size: content.len() as u64,
        modified_ms: entry.modified_ms,
        content,
    }
}

fn empty_archive_index() -> ArchiveIndex {
    ArchiveIndex {
        version: INDEX_VERSION,
        documents: Vec::new(),
        extra: serde_json::Map::new(),
    }
}

fn index_version() -> u32 {
    INDEX_VERSION
}

fn backup_corrupt_index(index_path: &Path, root: &Path) {
    let backup = root.join(format!("index.corrupt-{}.json", now_ms()));
    let _ = fs::copy(index_path, backup);
}

fn valid_archive_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 96
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn remove_if_present(path: &Path) -> StorageResult<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(io_at("删除文档保留副本", path, error)),
    }
}

fn non_empty_environment_path(name: &str) -> Option<PathBuf> {
    env::var_os(name)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

fn windows_user_profile() -> Option<PathBuf> {
    non_empty_environment_path("USERPROFILE").or_else(|| {
        let drive = env::var_os("HOMEDRIVE")?;
        let home_path = env::var_os("HOMEPATH")?;
        let mut combined = OsString::from(drive);
        combined.push(home_path);
        (!combined.is_empty()).then(|| PathBuf::from(combined))
    })
}

#[cfg(target_os = "windows")]
fn windows_documents_directory() -> Option<PathBuf> {
    use std::os::windows::ffi::OsStringExt;

    #[link(name = "shell32")]
    unsafe extern "system" {
        fn SHGetFolderPathW(
            hwnd_owner: *mut core::ffi::c_void,
            folder: i32,
            token: *mut core::ffi::c_void,
            flags: u32,
            path: *mut u16,
        ) -> i32;
    }
    const CSIDL_PERSONAL: i32 = 0x0005;
    const SHGFP_TYPE_CURRENT: u32 = 0;

    let mut buffer = [0_u16; 260];
    // SAFETY: SHGetFolderPathW receives a valid writable MAX_PATH-sized UTF-16
    // buffer. Null HWND/token request the current user's Known Folder.
    let result = unsafe {
        SHGetFolderPathW(
            std::ptr::null_mut(),
            CSIDL_PERSONAL,
            std::ptr::null_mut(),
            SHGFP_TYPE_CURRENT,
            buffer.as_mut_ptr(),
        )
    };
    if result < 0 {
        return None;
    }
    let length = buffer.iter().position(|unit| *unit == 0)?;
    (length > 0).then(|| PathBuf::from(OsString::from_wide(&buffer[..length])))
}

#[cfg(not(target_os = "windows"))]
fn windows_documents_directory() -> Option<PathBuf> {
    None
}

fn validate_windows_path_component(component: &OsStr) -> StorageResult<()> {
    let value = component
        .to_str()
        .ok_or_else(|| StorageError::new("路径包含无法在 Windows 使用的字符"))?;
    if value.is_empty()
        || value.ends_with(' ')
        || value.ends_with('.')
        || value.chars().any(|character| {
            character.is_control()
                || matches!(
                    character,
                    '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
                )
        })
    {
        return Err(StorageError::new(format!(
            "路径组件包含 Windows 不允许的字符：{value}"
        )));
    }

    // Windows reserves device names even when a normal-looking extension is
    // appended (for example `CON.md`). A colon is already rejected above, so
    // alternate data stream syntax cannot pass this validation either.
    let base = value
        .split('.')
        .next()
        .unwrap_or(value)
        .trim_end_matches(|character| character == ' ' || character == '.')
        .to_ascii_uppercase();
    let numbered_device = (base.starts_with("COM") || base.starts_with("LPT"))
        && base.len() == 4
        && matches!(base.as_bytes()[3], b'1'..=b'9');
    if matches!(base.as_str(), "CON" | "PRN" | "AUX" | "NUL") || numbered_device {
        return Err(StorageError::new(format!(
            "路径组件使用了 Windows 保留名称：{value}"
        )));
    }
    Ok(())
}

fn ensure_document_size(size: u64, path: &Path) -> StorageResult<()> {
    if size > MAX_DOCUMENT_BYTES {
        return Err(StorageError::new(format!(
            "文档超过 32 MiB 打开限制（{}）：{}",
            path.display(),
            size
        )));
    }
    Ok(())
}

fn skippable_scan_error(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::PermissionDenied | io::ErrorKind::NotFound
    )
}

fn ignored_name(name: &OsStr) -> bool {
    let value = name.to_string_lossy();
    if value.starts_with('.') {
        return true;
    }
    matches!(
        value.to_ascii_lowercase().as_str(),
        "node_modules" | "target" | "dist" | "build" | ".git" | ".svn" | ".hg"
    )
}

fn fingerprint_document_file(path: &Path) -> StorageResult<[u8; 32]> {
    ensure_regular_file(path)?;
    let metadata = fs::metadata(path).map_err(|error| io_at("读取文档源信息", path, error))?;
    ensure_document_size(metadata.len(), path)?;
    let bytes = fs::read(path).map_err(|error| io_at("读取文档源", path, error))?;
    ensure_document_size(bytes.len() as u64, path)?;
    Ok(source_fingerprint(&decode_text(&bytes)))
}

fn source_fingerprint(content: &str) -> [u8; 32] {
    Sha256::digest(content.as_bytes()).into()
}

fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

fn path_key(path: &Path) -> String {
    let mut value = path.to_string_lossy().replace('\\', "/");
    if let Some(unc) = value.strip_prefix("//?/UNC/") {
        value = format!("//{unc}");
    } else if let Some(normal) = value.strip_prefix("//?/") {
        value = normal.to_owned();
    }
    if cfg!(windows) {
        value = value.to_lowercase();
    }
    value.trim_end_matches('/').to_owned()
}

fn file_name_string(path: &Path) -> String {
    path.file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned()
}

fn safe_relative_suffix(path: &Path) -> bool {
    path.components()
        .all(|component| matches!(component, Component::Normal(_)))
}

fn path_to_slash(path: &Path) -> String {
    path.components()
        .filter_map(|component| match component {
            Component::Normal(value) => Some(value.to_string_lossy()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn parent_slash(path: &str) -> &str {
    path.rsplit_once('/').map_or("", |(parent, _)| parent)
}

fn entry_kind_order(kind: DocumentEntryKind) -> u8 {
    match kind {
        DocumentEntryKind::Directory => 0,
        DocumentEntryKind::File => 1,
    }
}

fn fold_name(value: &str) -> String {
    value.to_lowercase()
}

fn modified_ms(metadata: &fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |value| value.as_millis() as u64)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |value| value.as_millis() as u64)
}

fn io_at(operation: &str, path: &Path, error: io::Error) -> StorageError {
    StorageError::new(format!("{operation}失败（{}）：{error}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_root(name: &str) -> PathBuf {
        env::temp_dir().join(format!(
            "leafmark-native-storage-{name}-{}-{}",
            std::process::id(),
            TEMPORARY_FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ))
    }

    fn storage(name: &str) -> (PathBuf, NativeStorage) {
        let root = test_root(name);
        let storage = NativeStorage::open_with_paths(StoragePaths::from_roots(
            root.join("config"),
            root.join("workspace"),
        ))
        .unwrap();
        (root, storage)
    }

    #[test]
    fn archive_json_matches_existing_camel_case_schema() {
        let (root, mut storage) = storage("schema");
        let source = root.join("source.md");
        fs::write(&source, "# schema").unwrap();
        storage.import_external(&source).unwrap();
        let index = fs::read_to_string(
            root.join("config")
                .join(ARCHIVE_DIRECTORY)
                .join(ARCHIVE_INDEX_FILE),
        )
        .unwrap();
        assert!(index.contains("\"sourcePath\""));
        assert!(index.contains("\"lastOpenedMs\""));
        assert!(index.contains("\"sourceExists\""));
        assert!(index.contains("\"modifiedMs\""));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn external_edits_only_touch_retained_copy() {
        let (root, mut storage) = storage("external-copy");
        let source = root.join("wechat.md");
        fs::write(&source, "# from WeChat").unwrap();
        let opened = storage.import_external(&source).unwrap();
        storage
            .save_archived(&opened.archive_id, "# local edit")
            .unwrap();
        assert_eq!(fs::read_to_string(&source).unwrap(), "# from WeChat");
        assert_eq!(
            storage.open_archived(&opened.archive_id).unwrap().content,
            "# local edit"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn identical_attachment_at_new_path_reuses_content_hash() {
        let (root, mut storage) = storage("hash-reuse");
        let first = root.join("wechat-a.md");
        let second = root.join("wechat-b.markdown");
        fs::write(&first, "# same attachment").unwrap();
        fs::write(&second, "# same attachment").unwrap();
        let first = storage.import_external(&first).unwrap();
        let second = storage.import_external(&second).unwrap();
        assert_eq!(first.archive_id, second.archive_id);
        assert_eq!(storage.archive_entries().unwrap().len(), 1);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn edited_snapshot_still_reuses_original_attachment_at_new_path() {
        let (root, mut storage) = storage("immutable-source-fingerprint");
        let first_path = root.join("wechat-first.md");
        let second_path = root.join("wechat-second.md");
        fs::write(&first_path, "# original attachment").unwrap();
        let first = storage.import_external(&first_path).unwrap();
        storage
            .save_archived(&first.archive_id, "# edited retained copy")
            .unwrap();

        fs::write(&second_path, "# original attachment").unwrap();
        let second = storage.import_external(&second_path).unwrap();

        assert_eq!(second.archive_id, first.archive_id);
        assert_eq!(second.content, "# edited retained copy");
        assert_eq!(storage.archive_entries().unwrap().len(), 1);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn recreated_archive_id_overwrites_stale_source_fingerprint() {
        let (root, mut storage) = storage("stale-source-fingerprint");
        let source = root.join("reused-path.md");
        fs::write(&source, "# old attachment").unwrap();
        let old = storage.import_external(&source).unwrap();
        let sidecar = storage
            .archive
            .source_fingerprint_path(&old.archive_id)
            .unwrap();
        let stale_fingerprint = fs::read(&sidecar).unwrap();

        storage.remove_history_entry(&old.archive_id).unwrap();
        assert!(!sidecar.exists());
        // Model an earlier best-effort cleanup that could not delete a locked
        // sidecar. Recreating the same path produces the same archive id.
        fs::write(&sidecar, &stale_fingerprint).unwrap();
        fs::write(&source, "# new attachment").unwrap();
        let recreated = storage.import_external(&source).unwrap();
        assert_eq!(recreated.archive_id, old.archive_id);
        assert_eq!(
            fs::read(&sidecar).unwrap(),
            source_fingerprint("# new attachment")
        );

        storage
            .save_archived(&recreated.archive_id, "# locally edited new copy")
            .unwrap();
        let another_path = root.join("new-temp-path.md");
        fs::write(&another_path, "# new attachment").unwrap();
        let reopened = storage.import_external(&another_path).unwrap();
        assert_eq!(reopened.archive_id, recreated.archive_id);
        assert_eq!(reopened.content, "# locally edited new copy");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn legacy_entry_without_sidecar_prefers_existing_source_for_backfill() {
        let (root, mut storage) = storage("legacy-source-backfill");
        let first_path = root.join("legacy-source.md");
        fs::write(&first_path, "# legacy original").unwrap();
        let first = storage.import_external(&first_path).unwrap();
        let sidecar = storage
            .archive
            .source_fingerprint_path(&first.archive_id)
            .unwrap();
        fs::remove_file(&sidecar).unwrap();
        storage
            .save_archived(&first.archive_id, "# edited before migration")
            .unwrap();

        let second_path = root.join("legacy-new-temp.md");
        fs::write(&second_path, "# legacy original").unwrap();
        let reopened = storage.import_external(&second_path).unwrap();

        assert_eq!(reopened.archive_id, first.archive_id);
        assert_eq!(reopened.content, "# edited before migration");
        assert_eq!(
            fs::read(sidecar).unwrap(),
            source_fingerprint("# legacy original")
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn legacy_entry_without_source_or_sidecar_backfills_from_snapshot() {
        let (root, mut storage) = storage("legacy-snapshot-backfill");
        let first_path = root.join("legacy-deleted.md");
        fs::write(&first_path, "# retained legacy").unwrap();
        let first = storage.import_external(&first_path).unwrap();
        let sidecar = storage
            .archive
            .source_fingerprint_path(&first.archive_id)
            .unwrap();
        fs::remove_file(&sidecar).unwrap();
        fs::remove_file(&first_path).unwrap();

        let second_path = root.join("legacy-restored.md");
        fs::write(&second_path, "# retained legacy").unwrap();
        let reopened = storage.import_external(&second_path).unwrap();

        assert_eq!(reopened.archive_id, first.archive_id);
        assert_eq!(
            fs::read(sidecar).unwrap(),
            source_fingerprint("# retained legacy")
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn scanner_includes_only_markdown_and_does_not_follow_links() {
        let (root, storage) = storage("scan");
        fs::create_dir_all(storage.workspace().join("notes")).unwrap();
        fs::write(storage.workspace().join("notes/a.md"), "a").unwrap();
        fs::write(storage.workspace().join("notes/b.markdown"), "b").unwrap();
        fs::write(storage.workspace().join("notes/c.txt"), "c").unwrap();
        let entries = storage.scan_workspace().unwrap();
        assert!(entries.iter().any(|entry| entry.path == "notes/a.md"));
        assert!(entries.iter().any(|entry| entry.path == "notes/b.markdown"));
        assert!(!entries.iter().any(|entry| entry.path.ends_with("c.txt")));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn traversal_is_rejected_and_atomic_save_succeeds() {
        let (root, mut storage) = storage("secure-save");
        assert!(storage
            .save_workspace_document("../outside.md", "unsafe")
            .is_err());
        storage
            .save_workspace_document("folder/safe.md", "# safe")
            .unwrap();
        assert_eq!(
            fs::read_to_string(storage.workspace().join("folder/safe.md")).unwrap(),
            "# safe"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn favorite_survives_clear_history_and_source_deletion() {
        let (root, mut storage) = storage("favorite");
        let favorite = root.join("favorite.md");
        let recent = root.join("recent.md");
        fs::write(&favorite, "favorite").unwrap();
        fs::write(&recent, "recent").unwrap();
        let favorite = storage.import_external(&favorite).unwrap();
        storage.import_external(&recent).unwrap();
        storage.set_favorite(&favorite.archive_id, true).unwrap();
        fs::remove_file(root.join("favorite.md")).unwrap();
        let remaining = storage.clear_history().unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].id, favorite.archive_id);
        assert_eq!(
            storage.open_archived(&favorite.archive_id).unwrap().content,
            "favorite"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn valid_index_is_not_rewritten_and_unknown_fields_survive_updates() {
        let root = test_root("forward-index");
        let archive_root = root.join("archive");
        let documents = archive_root.join(ARCHIVE_DOCUMENTS_DIRECTORY);
        fs::create_dir_all(&documents).unwrap();
        fs::write(documents.join("future-id.md"), "future").unwrap();
        let original = r#"{"version":1,"futureIndex":{"enabled":true},"documents":[{"id":"future-id","name":"future.md","sourcePath":"C:\\future.md","lastOpenedMs":1,"favorite":false,"sourceExists":false,"size":6,"modifiedMs":2,"futureEntry":"kept"}]}"#;
        let index_path = archive_root.join(ARCHIVE_INDEX_FILE);
        fs::write(&index_path, original).unwrap();

        let mut archive = DocumentArchive::load(&archive_root).unwrap();
        assert_eq!(fs::read_to_string(&index_path).unwrap(), original);
        archive.set_favorite("future-id", true).unwrap();
        let updated: serde_json::Value =
            serde_json::from_slice(&fs::read(&index_path).unwrap()).unwrap();
        assert_eq!(updated["futureIndex"]["enabled"], true);
        assert_eq!(updated["documents"][0]["futureEntry"], "kept");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn failed_index_persist_rolls_back_mutations_and_keeps_snapshots() {
        let (root, mut storage) = storage("rollback-index");
        let first = root.join("first.md");
        let second = root.join("second.md");
        fs::write(&first, "first").unwrap();
        fs::write(&second, "second").unwrap();
        let first = storage.import_external(&first).unwrap();
        let second = storage.import_external(&second).unwrap();
        let first_snapshot = storage.archive.retained_path(&first.archive_id).unwrap();
        let second_snapshot = storage.archive.retained_path(&second.archive_id).unwrap();

        let blocker = root.join("not-a-directory");
        fs::write(&blocker, "block").unwrap();
        storage.archive.index_path = blocker.join("index.json");

        assert!(storage.set_favorite(&first.archive_id, true).is_err());
        assert!(
            !storage
                .archive
                .index
                .documents
                .iter()
                .find(|entry| entry.id == first.archive_id)
                .unwrap()
                .favorite
        );
        assert!(storage.remove_history_entry(&first.archive_id).is_err());
        assert!(storage
            .archive
            .index
            .documents
            .iter()
            .any(|entry| entry.id == first.archive_id));
        assert!(first_snapshot.is_file());
        assert!(storage.clear_history().is_err());
        assert_eq!(storage.archive.index.documents.len(), 2);
        assert!(first_snapshot.is_file());
        assert!(second_snapshot.is_file());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn oversized_documents_are_rejected_before_reading() {
        let (root, mut storage) = storage("size-limit");
        let source = root.join("oversized.md");
        File::create(&source)
            .unwrap()
            .set_len(MAX_DOCUMENT_BYTES + 1)
            .unwrap();
        let error = storage.import_external(&source).unwrap_err();
        assert!(error.message().contains("32 MiB"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn external_size_reports_source_bytes_instead_of_decoded_utf8_length() {
        let (root, mut storage) = storage("external-byte-size");
        let source = root.join("utf16.md");
        let bytes = [0xff, 0xfe, b'#', 0, b' ', 0, b'a', 0];
        fs::write(&source, bytes).unwrap();
        let opened = storage.import_external(&source).unwrap();
        assert_eq!(opened.content, "# a");
        assert_eq!(opened.size, bytes.len() as u64);
        let entry = storage
            .archive
            .index
            .documents
            .iter()
            .find(|entry| entry.id == opened.archive_id)
            .unwrap();
        assert_eq!(entry.size, bytes.len() as u64);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn windows_unsafe_relative_components_are_rejected_on_every_platform() {
        for path in [
            "CON.md",
            "folder/PRN.txt/file.md",
            "AUX.note.md",
            "NUL.md",
            "COM1.md",
            "lpt9.markdown",
            "has:stream.md",
            "trailing./file.md",
            "trailing /file.md",
            "file.md ",
            "question?.md",
            "control\u{7f}.md",
        ] {
            assert!(validate_relative_path(path).is_err(), "accepted {path}");
        }
        assert!(validate_relative_path("正常目录/笔记.md").is_ok());
    }

    #[test]
    fn changing_workspace_preserves_unknown_settings_fields() {
        let (root, mut storage) = storage("workspace-setting");
        storage
            .save_settings_value(&serde_json::json!({
                "theme": "leaf-dark",
                "future": { "kept": 42 }
            }))
            .unwrap();
        let next = root.join("next-workspace");
        storage.set_workspace(&next).unwrap();
        let settings = storage.load_settings_value().unwrap().unwrap();
        assert_eq!(settings["theme"], "leaf-dark");
        assert_eq!(settings["future"]["kept"], 42);
        let workspace = storage.workspace().to_string_lossy().into_owned();
        assert_eq!(settings["workspacePath"], workspace);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn utf_boms_decode_without_web_runtime() {
        assert_eq!(decode_text(b"\xef\xbb\xbf# utf8"), "# utf8");
        assert_eq!(
            decode_text(&[0xff, 0xfe, b'#', 0, b' ', 0, b'o', 0, b'k', 0]),
            "# ok"
        );
    }
}
