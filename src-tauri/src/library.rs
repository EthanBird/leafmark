use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Component, Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use super::atomic_write;

const INDEX_VERSION: u32 = 2;

fn markdown_kind() -> String {
    "markdown".into()
}

fn markdown_extension() -> String {
    "md".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ArchiveEntry {
    pub id: String,
    pub name: String,
    pub source_path: String,
    pub last_opened_ms: u64,
    pub favorite: bool,
    pub source_exists: bool,
    pub size: u64,
    pub modified_ms: u64,
    #[serde(default = "markdown_kind")]
    pub document_kind: String,
    #[serde(default = "markdown_extension")]
    pub snapshot_extension: String,
}

#[derive(Debug, Clone)]
pub(crate) struct ArchivedContent {
    pub entry: ArchiveEntry,
    pub content: String,
}

#[derive(Debug, Clone)]
pub(crate) struct ArchivedBinary {
    pub entry: ArchiveEntry,
    pub snapshot_path: PathBuf,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct ArchiveIndex {
    #[serde(default = "index_version")]
    version: u32,
    #[serde(default)]
    documents: Vec<ArchiveEntry>,
}

pub(crate) struct DocumentArchive {
    documents_dir: PathBuf,
    index_path: PathBuf,
    index: ArchiveIndex,
}

impl DocumentArchive {
    pub(crate) fn load(root: PathBuf) -> Result<Self, String> {
        let documents_dir = root.join("documents");
        fs::create_dir_all(&documents_dir).map_err(error_string)?;
        let index_path = root.join("index.json");
        let mut index = match fs::read(&index_path) {
            Ok(bytes) => match serde_json::from_slice::<ArchiveIndex>(&bytes) {
                Ok(index) => index,
                Err(_) => {
                    let backup = root.join(format!("index.corrupt-{}.json", now_ms()));
                    let _ = fs::copy(&index_path, backup);
                    ArchiveIndex {
                        version: INDEX_VERSION,
                        documents: Vec::new(),
                    }
                }
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => ArchiveIndex {
                version: INDEX_VERSION,
                documents: Vec::new(),
            },
            Err(error) => return Err(error_string(error)),
        };
        index.version = INDEX_VERSION;
        for entry in &mut index.documents {
            if entry.document_kind.trim().is_empty() {
                entry.document_kind = markdown_kind();
            }
            entry.snapshot_extension = safe_snapshot_extension(&entry.snapshot_extension);
        }
        let archive = Self {
            documents_dir,
            index_path,
            index,
        };
        archive.persist()?;
        Ok(archive)
    }

    pub(crate) fn entries(&mut self) -> Result<Vec<ArchiveEntry>, String> {
        let mut changed = false;
        for entry in &mut self.index.documents {
            let exists = Path::new(&entry.source_path).is_file();
            if entry.source_exists != exists {
                entry.source_exists = exists;
                changed = true;
            }
        }
        if changed {
            self.persist()?;
        }
        let mut entries = self.index.documents.clone();
        entries.sort_by(|left, right| {
            right
                .last_opened_ms
                .cmp(&left.last_opened_ms)
                .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
        });
        Ok(entries)
    }

    pub(crate) fn record(
        &mut self,
        source: &Path,
        content: &str,
        size: u64,
        modified_ms: u64,
        touch: bool,
    ) -> Result<ArchiveEntry, String> {
        let canonical = source.canonicalize().map_err(error_string)?;
        let source_path = canonical.to_string_lossy().into_owned();
        let key = path_key(&canonical);
        let existing = self
            .index
            .documents
            .iter()
            .position(|entry| path_key(Path::new(&entry.source_path)) == key);
        let position = if let Some(position) = existing {
            position
        } else {
            let id = self.unique_id(&key);
            self.index.documents.push(ArchiveEntry {
                id,
                name: canonical
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned(),
                source_path: source_path.clone(),
                last_opened_ms: now_ms(),
                favorite: false,
                source_exists: true,
                size,
                modified_ms,
                document_kind: markdown_kind(),
                snapshot_extension: markdown_extension(),
            });
            self.index.documents.len() - 1
        };

        let entry = &mut self.index.documents[position];
        entry.name = canonical
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();
        entry.source_path = source_path;
        entry.source_exists = true;
        entry.size = size;
        entry.modified_ms = modified_ms;
        entry.document_kind = markdown_kind();
        entry.snapshot_extension = markdown_extension();
        if touch {
            entry.last_opened_ms = now_ms();
        }
        let result = entry.clone();
        atomic_write(&self.snapshot_path_for_entry(&result), content.as_bytes())?;
        self.persist()?;
        Ok(result)
    }

    pub(crate) fn open_source(&mut self, source: &Path) -> Result<ArchivedContent, String> {
        let canonical = source.canonicalize().map_err(error_string)?;
        if !canonical.is_file() {
            return Err("目标不是文件".into());
        }
        let key = path_key(&canonical);
        if let Some(id) = self
            .index
            .documents
            .iter()
            .find(|entry| path_key(Path::new(&entry.source_path)) == key)
            .map(|entry| entry.id.clone())
        {
            // External documents are imported as retained copies. Reopening the
            // same source must never overwrite edits made to that copy.
            return self.open(&id);
        }
        let metadata = fs::metadata(&canonical).map_err(error_string)?;
        let bytes = fs::read(&canonical).map_err(error_string)?;
        let content = super::decode_text(&bytes);
        let duplicate_id = self.index.documents.iter().filter(|entry| entry.document_kind == "markdown").find_map(|entry| {
            let snapshot = fs::read(self.snapshot_path_for_entry(entry)).ok()?;
            (super::decode_text(&snapshot) == content).then(|| entry.id.clone())
        });
        if let Some(id) = duplicate_id {
            if let Some(entry) = self.index.documents.iter_mut().find(|entry| entry.id == id) {
                entry.name = canonical.file_name().unwrap_or_default().to_string_lossy().into_owned();
                entry.source_path = canonical.to_string_lossy().into_owned();
                entry.source_exists = true;
                entry.modified_ms = modified_ms(&metadata);
            }
            // WeChat and other apps often expose the same attachment through a
            // new temporary path. Exact content matching reuses the retained
            // snapshot instead of multiplying copies.
            return self.open(&id);
        }
        let entry = self.record(
            &canonical,
            &content,
            metadata.len(),
            modified_ms(&metadata),
            true,
        )?;
        Ok(ArchivedContent { entry, content })
    }

    pub(crate) fn open(&mut self, id: &str) -> Result<ArchivedContent, String> {
        let position = self
            .index
            .documents
            .iter()
            .position(|entry| entry.id == id)
            .ok_or_else(|| "历史记录不存在".to_string())?;
        let source = PathBuf::from(&self.index.documents[position].source_path);
        if self.index.documents[position].document_kind != "markdown" {
            return Err("此保留副本不是 Markdown 文档".into());
        }
        let snapshot_path = self.snapshot_path_for_entry(&self.index.documents[position]);
        let bytes = fs::read(&snapshot_path)
            .map_err(|error| format!("LeafMark 保留副本无法读取：{error}"))?;
        let content = super::decode_text(&bytes);
        let entry = &mut self.index.documents[position];
        entry.source_exists = source.is_file();
        entry.last_opened_ms = now_ms();
        entry.size = content.len() as u64;
        let result = entry.clone();
        self.persist()?;
        Ok(ArchivedContent {
            entry: result,
            content,
        })
    }

    /// Stores a byte-for-byte retained copy of a read-only document. The copy
    /// is opened on every subsequent history/favorite access, so temporary
    /// attachment paths can disappear without losing the document.
    pub(crate) fn open_binary_source(
        &mut self,
        source: &Path,
        document_kind: &str,
    ) -> Result<ArchivedBinary, String> {
        let canonical = source.canonicalize().map_err(error_string)?;
        if !canonical.is_file() {
            return Err("目标不是文件".into());
        }
        let key = path_key(&canonical);
        if let Some(id) = self
            .index
            .documents
            .iter()
            .find(|entry| path_key(Path::new(&entry.source_path)) == key)
            .map(|entry| entry.id.clone())
        {
            return self.open_binary(&id);
        }

        let metadata = fs::metadata(&canonical).map_err(error_string)?;
        let extension = canonical
            .extension()
            .and_then(|value| value.to_str())
            .map(safe_snapshot_extension)
            .unwrap_or_else(|| "bin".into());
        let id = self.unique_id(&key);
        let entry = ArchiveEntry {
            id,
            name: canonical
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
            source_path: canonical.to_string_lossy().into_owned(),
            last_opened_ms: now_ms(),
            favorite: false,
            source_exists: true,
            size: metadata.len(),
            modified_ms: modified_ms(&metadata),
            document_kind: document_kind.into(),
            snapshot_extension: extension,
        };
        let snapshot_path = self.snapshot_path_for_entry(&entry);
        fs::copy(&canonical, &snapshot_path).map_err(error_string)?;
        self.index.documents.push(entry.clone());
        self.persist()?;
        Ok(ArchivedBinary {
            entry,
            snapshot_path,
        })
    }

    pub(crate) fn open_binary(&mut self, id: &str) -> Result<ArchivedBinary, String> {
        let position = self
            .index
            .documents
            .iter()
            .position(|entry| entry.id == id)
            .ok_or_else(|| "历史记录不存在".to_string())?;
        if self.index.documents[position].document_kind == "markdown" {
            return Err("此保留副本是 Markdown 文档".into());
        }
        let snapshot_path = self.snapshot_path_for_entry(&self.index.documents[position]);
        let snapshot_size = fs::metadata(&snapshot_path)
            .map_err(|error| format!("LeafMark 保留副本无法读取：{error}"))?
            .len();
        let entry = &mut self.index.documents[position];
        entry.source_exists = Path::new(&entry.source_path).is_file();
        entry.last_opened_ms = now_ms();
        entry.size = snapshot_size;
        let result = entry.clone();
        self.persist()?;
        Ok(ArchivedBinary {
            entry: result,
            snapshot_path,
        })
    }

    pub(crate) fn document_kind(&self, id: &str) -> Result<&str, String> {
        self.index
            .documents
            .iter()
            .find(|entry| entry.id == id)
            .map(|entry| entry.document_kind.as_str())
            .ok_or_else(|| "历史记录不存在".to_string())
    }

    pub(crate) fn write(&mut self, id: &str, content: &str) -> Result<ArchiveEntry, String> {
        let position = self
            .index
            .documents
            .iter()
            .position(|entry| entry.id == id)
            .ok_or_else(|| "历史记录不存在".to_string())?;
        let source = PathBuf::from(&self.index.documents[position].source_path);
        let source_exists = source.is_file();
        if self.index.documents[position].document_kind != "markdown" {
            return Err("Office 与 PDF 文档当前为只读模式".into());
        }
        let snapshot_path = self.snapshot_path_for_entry(&self.index.documents[position]);
        atomic_write(&snapshot_path, content.as_bytes())?;
        let entry = &mut self.index.documents[position];
        entry.source_exists = source_exists;
        entry.size = content.len() as u64;
        entry.modified_ms = now_ms();
        entry.last_opened_ms = now_ms();
        let result = entry.clone();
        self.persist()?;
        Ok(result)
    }

    /// Raw access for the Agent-native version store. The bytes belong to the
    /// retained LeafMark copy; the original source (for example a WeChat temp
    /// file) is never read or written by undo/redo.
    pub(crate) fn vcs_snapshot(&self, id: &str) -> Result<(String, Vec<u8>), String> {
        let entry = self
            .index
            .documents
            .iter()
            .find(|entry| entry.id == id)
            .ok_or_else(|| "历史记录不存在".to_string())?;
        let bytes = fs::read(self.snapshot_path_for_entry(entry))
            .map_err(|error| format!("LeafMark 保留副本无法读取：{error}"))?;
        Ok((entry.name.clone(), bytes))
    }

    pub(crate) fn vcs_restore(&mut self, id: &str, bytes: &[u8]) -> Result<(), String> {
        let position = self
            .index
            .documents
            .iter()
            .position(|entry| entry.id == id)
            .ok_or_else(|| "历史记录不存在".to_string())?;
        let snapshot_path = self.snapshot_path_for_entry(&self.index.documents[position]);
        atomic_write(&snapshot_path, bytes)?;
        let entry = &mut self.index.documents[position];
        entry.size = bytes.len() as u64;
        entry.modified_ms = now_ms();
        entry.last_opened_ms = now_ms();
        entry.source_exists = Path::new(&entry.source_path).is_file();
        self.persist()
    }

    pub(crate) fn set_favorite(
        &mut self,
        id: &str,
        favorite: bool,
    ) -> Result<Vec<ArchiveEntry>, String> {
        let entry = self
            .index
            .documents
            .iter_mut()
            .find(|entry| entry.id == id)
            .ok_or_else(|| "历史记录不存在".to_string())?;
        entry.favorite = favorite;
        self.persist()?;
        self.entries()
    }

    pub(crate) fn remove(&mut self, id: &str) -> Result<Vec<ArchiveEntry>, String> {
        let position = self
            .index
            .documents
            .iter()
            .position(|entry| entry.id == id)
            .ok_or_else(|| "历史记录不存在".to_string())?;
        if self.index.documents[position].favorite {
            return Err("请先取消收藏，再移除这条历史记录".into());
        }
        let entry = self.index.documents.remove(position);
        match fs::remove_file(self.snapshot_path_for_entry(&entry)) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error_string(error)),
        }
        self.persist()?;
        self.entries()
    }

    pub(crate) fn clear_history(&mut self) -> Result<Vec<ArchiveEntry>, String> {
        let removed: Vec<ArchiveEntry> = self
            .index
            .documents
            .iter()
            .filter(|entry| !entry.favorite)
            .cloned()
            .collect();
        self.index.documents.retain(|entry| entry.favorite);
        for entry in removed {
            match fs::remove_file(self.snapshot_path_for_entry(&entry)) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error_string(error)),
            }
        }
        self.persist()?;
        self.entries()
    }

    pub(crate) fn reveal_path(&self, id: &str) -> Result<PathBuf, String> {
        let entry = self
            .index
            .documents
            .iter()
            .find(|entry| entry.id == id)
            .ok_or_else(|| "历史记录不存在".to_string())?;
        let source = PathBuf::from(&entry.source_path);
        if source.is_file() {
            return Ok(source);
        }
        let snapshot = self.snapshot_path_for_entry(entry);
        if snapshot.is_file() {
            return Ok(snapshot);
        }
        Err("源文档和 LeafMark 保留副本都不存在".into())
    }

    pub(crate) fn rename_sources(
        &mut self,
        previous_root: &Path,
        next_root: &Path,
    ) -> Result<(), String> {
        let mut changed = false;
        for entry in &mut self.index.documents {
            let source = Path::new(&entry.source_path);
            let Ok(suffix) = source.strip_prefix(previous_root) else {
                continue;
            };
            if !safe_relative_suffix(suffix) {
                continue;
            }
            // PathBuf::join("") appends a trailing separator on Windows. For
            // a file-to-file move that makes is_file() false and forces
            // history to reveal the retained snapshot instead.
            let next = if suffix.as_os_str().is_empty() {
                next_root.to_path_buf()
            } else {
                next_root.join(suffix)
            };
            entry.source_path = next.to_string_lossy().into_owned();
            entry.name = next
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned();
            entry.source_exists = next.is_file();
            changed = true;
        }
        if changed {
            self.persist()?;
        }
        Ok(())
    }

    pub(crate) fn mark_missing_under(&mut self, root: &Path) -> Result<(), String> {
        let mut changed = false;
        for entry in &mut self.index.documents {
            if Path::new(&entry.source_path).starts_with(root) && entry.source_exists {
                entry.source_exists = false;
                changed = true;
            }
        }
        if changed {
            self.persist()?;
        }
        Ok(())
    }

    fn snapshot_path_for_entry(&self, entry: &ArchiveEntry) -> PathBuf {
        self.documents_dir.join(format!(
            "{}.{}",
            entry.id,
            safe_snapshot_extension(&entry.snapshot_extension)
        ))
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

    fn persist(&self) -> Result<(), String> {
        let bytes = serde_json::to_vec_pretty(&self.index).map_err(error_string)?;
        atomic_write(&self.index_path, &bytes)
    }
}

fn index_version() -> u32 {
    INDEX_VERSION
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

fn path_key(path: &Path) -> String {
    let value = path.to_string_lossy().replace('\\', "/");
    if cfg!(windows) {
        value.to_lowercase()
    } else {
        value
    }
}

fn safe_relative_suffix(path: &Path) -> bool {
    path.components()
        .all(|component| matches!(component, Component::Normal(_)))
}

fn safe_snapshot_extension(value: &str) -> String {
    let extension: String = value
        .trim_start_matches('.')
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .take(12)
        .collect();
    if extension.is_empty() {
        "bin".into()
    } else {
        extension.to_ascii_lowercase()
    }
}

fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

fn error_string(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_root(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "leafmark-{name}-{}-{}",
            std::process::id(),
            now_ms()
        ))
    }

    #[test]
    fn retained_snapshot_survives_source_deletion() {
        let root = test_root("archive");
        let source_dir = root.join("source");
        fs::create_dir_all(&source_dir).unwrap();
        let source = source_dir.join("guide.md");
        fs::write(&source, "# retained").unwrap();
        let mut archive = DocumentArchive::load(root.join("archive")).unwrap();

        let opened = archive.open_source(&source).unwrap();
        fs::remove_file(&source).unwrap();
        let retained = archive.open(&opened.entry.id).unwrap();

        assert_eq!(retained.content, "# retained");
        assert!(!retained.entry.source_exists);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn retained_binary_snapshot_survives_source_deletion() {
        let root = test_root("binary-archive");
        let source_dir = root.join("source");
        fs::create_dir_all(&source_dir).unwrap();
        let source = source_dir.join("report.xlsx");
        let payload = b"fake-xlsx-payload\0\x01\x02";
        fs::write(&source, payload).unwrap();
        let mut archive = DocumentArchive::load(root.join("archive")).unwrap();

        let opened = archive.open_binary_source(&source, "spreadsheet").unwrap();
        assert_eq!(opened.entry.document_kind, "spreadsheet");
        assert_eq!(opened.entry.snapshot_extension, "xlsx");
        fs::remove_file(&source).unwrap();
        let retained = archive.open_binary(&opened.entry.id).unwrap();

        assert_eq!(fs::read(retained.snapshot_path).unwrap(), payload);
        assert!(!retained.entry.source_exists);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn editing_retained_copy_never_mutates_external_source() {
        let root = test_root("external-copy");
        let source_dir = root.join("source");
        fs::create_dir_all(&source_dir).unwrap();
        let source = source_dir.join("wechat.md");
        fs::write(&source, "# original from WeChat").unwrap();
        let mut archive = DocumentArchive::load(root.join("archive")).unwrap();

        let opened = archive.open_source(&source).unwrap();
        archive
            .write(&opened.entry.id, "# edited LeafMark copy")
            .unwrap();

        assert_eq!(
            fs::read_to_string(&source).unwrap(),
            "# original from WeChat"
        );
        assert_eq!(
            archive.open(&opened.entry.id).unwrap().content,
            "# edited LeafMark copy"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn history_always_opens_retained_copy_even_when_source_changes() {
        let root = test_root("history-copy");
        let source_dir = root.join("source");
        fs::create_dir_all(&source_dir).unwrap();
        let source = source_dir.join("history.md");
        fs::write(&source, "# imported").unwrap();
        let mut archive = DocumentArchive::load(root.join("archive")).unwrap();

        let opened = archive.open_source(&source).unwrap();
        archive.write(&opened.entry.id, "# retained edit").unwrap();
        fs::write(&source, "# changed by another app").unwrap();
        let reopened = archive.open(&opened.entry.id).unwrap();

        assert_eq!(reopened.content, "# retained edit");
        assert!(reopened.entry.source_exists);
        assert_eq!(
            fs::read_to_string(&source).unwrap(),
            "# changed by another app"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn reopening_external_source_reuses_edited_retained_copy() {
        let root = test_root("external-reopen");
        let source_dir = root.join("source");
        fs::create_dir_all(&source_dir).unwrap();
        let source = source_dir.join("wechat.md");
        fs::write(&source, "# original").unwrap();
        let mut archive = DocumentArchive::load(root.join("archive")).unwrap();

        let first = archive.open_source(&source).unwrap();
        archive.write(&first.entry.id, "# retained edit").unwrap();
        fs::write(&source, "# source changed").unwrap();
        let reopened = archive.open_source(&source).unwrap();

        assert_eq!(reopened.entry.id, first.entry.id);
        assert_eq!(reopened.content, "# retained edit");
        assert_eq!(archive.entries().unwrap().len(), 1);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn identical_external_content_at_new_path_reuses_snapshot() {
        let root = test_root("content-dedup");
        let source_dir = root.join("source");
        fs::create_dir_all(&source_dir).unwrap();
        let first_path = source_dir.join("wechat-a.md");
        let second_path = source_dir.join("wechat-b.md");
        fs::write(&first_path, "# same attachment").unwrap();
        fs::write(&second_path, "# same attachment").unwrap();
        let mut archive = DocumentArchive::load(root.join("archive")).unwrap();

        let first = archive.open_source(&first_path).unwrap();
        let second = archive.open_source(&second_path).unwrap();

        assert_eq!(second.entry.id, first.entry.id);
        assert_eq!(archive.entries().unwrap().len(), 1);
        assert_eq!(second.content, "# same attachment");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn clearing_history_keeps_favorites_and_their_snapshots() {
        let root = test_root("favorites");
        let source_dir = root.join("source");
        fs::create_dir_all(&source_dir).unwrap();
        let favorite = source_dir.join("favorite.md");
        let recent = source_dir.join("recent.md");
        fs::write(&favorite, "favorite").unwrap();
        fs::write(&recent, "recent").unwrap();
        let archive_root = root.join("archive");
        let mut archive = DocumentArchive::load(archive_root.clone()).unwrap();
        let favorite_entry = archive.open_source(&favorite).unwrap().entry;
        archive.open_source(&recent).unwrap();
        archive.set_favorite(&favorite_entry.id, true).unwrap();

        let remaining = archive.clear_history().unwrap();

        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].id, favorite_entry.id);
        assert!(archive_root
            .join("documents")
            .join(format!("{}.md", favorite_entry.id))
            .is_file());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn reveal_path_falls_back_to_the_retained_snapshot() {
        let root = test_root("reveal-retained");
        let source_dir = root.join("source");
        fs::create_dir_all(&source_dir).unwrap();
        let source = source_dir.join("wechat.md");
        fs::write(&source, "# from WeChat").unwrap();
        let mut archive = DocumentArchive::load(root.join("archive")).unwrap();
        let opened = archive.open_source(&source).unwrap();

        assert_eq!(
            archive.reveal_path(&opened.entry.id).unwrap(),
            source.canonicalize().unwrap()
        );
        fs::remove_file(&source).unwrap();
        let retained = archive.reveal_path(&opened.entry.id).unwrap();
        assert!(retained.is_file());
        assert_eq!(
            retained.file_name().unwrap().to_string_lossy(),
            format!("{}.md", opened.entry.id)
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn moved_file_source_keeps_a_file_path_without_a_trailing_separator() {
        let root = test_root("move-source");
        let source_dir = root.join("source");
        let target_dir = root.join("target");
        fs::create_dir_all(&source_dir).unwrap();
        fs::create_dir_all(&target_dir).unwrap();
        let source = source_dir.join("note.md");
        let target = target_dir.join("note.md");
        fs::write(&source, "# moved").unwrap();
        let mut archive = DocumentArchive::load(root.join("archive")).unwrap();
        let opened = archive.open_source(&source).unwrap();
        let source = source.canonicalize().unwrap();
        fs::rename(&source, &target).unwrap();
        let target = target.canonicalize().unwrap();

        archive.rename_sources(&source, &target).unwrap();

        assert_eq!(archive.reveal_path(&opened.entry.id).unwrap(), target);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn relative_suffix_cannot_escape_a_moved_directory() {
        assert!(safe_relative_suffix(Path::new("")));
        assert!(safe_relative_suffix(Path::new("nested/note.md")));
        assert!(!safe_relative_suffix(Path::new("../outside.md")));
        assert!(!safe_relative_suffix(Path::new("/absolute/note.md")));
    }
}
