use atomicwrites::{AllowOverwrite, AtomicFile};
use leafmark_storage::decode_text;
use serde::{Deserialize, Serialize};
use std::{
    error::Error,
    fmt, fs,
    io::Write,
    path::{Component, Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

const INDEX_VERSION: u32 = 1;

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
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArchivedContent {
    pub entry: ArchiveEntry,
    pub content: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct ArchiveIndex {
    #[serde(default = "index_version")]
    version: u32,
    #[serde(default)]
    documents: Vec<ArchiveEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ArchiveError {
    Io(String),
    InvalidIndex(String),
    MissingEntry,
    FavoriteEntry,
    MissingSnapshot,
    InvalidSource,
}

impl fmt::Display for ArchiveError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(message) => f.write_str(message),
            Self::InvalidIndex(message) => write!(f, "历史索引损坏：{message}"),
            Self::MissingEntry => f.write_str("历史记录不存在"),
            Self::FavoriteEntry => f.write_str("请先取消收藏，再移除这条历史记录"),
            Self::MissingSnapshot => f.write_str("LeafMark 保留副本无法读取"),
            Self::InvalidSource => f.write_str("源文档不存在或不是文件"),
        }
    }
}
impl Error for ArchiveError {}
impl From<std::io::Error> for ArchiveError {
    fn from(value: std::io::Error) -> Self {
        Self::Io(value.to_string())
    }
}

type Result<T> = std::result::Result<T, ArchiveError>;

pub struct DocumentArchive {
    root: PathBuf,
    documents_dir: PathBuf,
    index_path: PathBuf,
    index: ArchiveIndex,
}

impl DocumentArchive {
    pub fn load(root: impl AsRef<Path>) -> Result<Self> {
        let root = root.as_ref().to_path_buf();
        let documents_dir = root.join("documents");
        fs::create_dir_all(&documents_dir)?;
        let index_path = root.join("index.json");
        let index = match fs::read(&index_path) {
            Ok(bytes) => match serde_json::from_slice::<ArchiveIndex>(&bytes) {
                Ok(index) if index.version == INDEX_VERSION => index,
                Ok(index) => {
                    backup_corrupt_index(&root, &index_path)?;
                    ArchiveIndex {
                        version: INDEX_VERSION,
                        documents: index.documents,
                    }
                }
                Err(error) => {
                    backup_corrupt_index(&root, &index_path)?;
                    let _ = error;
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
            Err(error) => return Err(error.into()),
        };
        let archive = Self {
            root,
            documents_dir,
            index_path,
            index,
        };
        archive.persist()?;
        Ok(archive)
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn entries(&mut self) -> Result<Vec<ArchiveEntry>> {
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

    pub fn record(
        &mut self,
        source: &Path,
        content: &str,
        size: u64,
        modified_ms: u64,
        touch: bool,
    ) -> Result<ArchiveEntry> {
        let canonical = source
            .canonicalize()
            .map_err(|_| ArchiveError::InvalidSource)?;
        if !canonical.is_file() {
            return Err(ArchiveError::InvalidSource);
        }
        let source_path = canonical.to_string_lossy().into_owned();
        let key = path_key(&canonical);
        let position = if let Some(position) = self
            .index
            .documents
            .iter()
            .position(|entry| path_key(Path::new(&entry.source_path)) == key)
        {
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
        if touch {
            entry.last_opened_ms = now_ms();
        }
        let result = entry.clone();
        atomic_write(&self.snapshot_path(&result.id), content.as_bytes())?;
        self.persist()?;
        Ok(result)
    }

    pub fn open_source(&mut self, source: &Path) -> Result<ArchivedContent> {
        let canonical = source
            .canonicalize()
            .map_err(|_| ArchiveError::InvalidSource)?;
        if !canonical.is_file() {
            return Err(ArchiveError::InvalidSource);
        }
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
        let metadata = fs::metadata(&canonical)?;
        let content = decode_text(&fs::read(&canonical)?);
        let duplicate_id = self.index.documents.iter().find_map(|entry| {
            let snapshot = fs::read(self.snapshot_path(&entry.id)).ok()?;
            (decode_text(&snapshot) == content).then(|| entry.id.clone())
        });
        if let Some(id) = duplicate_id {
            if let Some(entry) = self.index.documents.iter_mut().find(|entry| entry.id == id) {
                entry.name = canonical
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned();
                entry.source_path = canonical.to_string_lossy().into_owned();
                entry.source_exists = true;
                entry.modified_ms = metadata_modified_ms(&metadata);
            }
            return self.open(&id);
        }
        let entry = self.record(
            &canonical,
            &content,
            metadata.len(),
            metadata_modified_ms(&metadata),
            true,
        )?;
        Ok(ArchivedContent { entry, content })
    }

    pub fn open(&mut self, id: &str) -> Result<ArchivedContent> {
        let position = self
            .index
            .documents
            .iter()
            .position(|entry| entry.id == id)
            .ok_or(ArchiveError::MissingEntry)?;
        let bytes = fs::read(self.snapshot_path(id)).map_err(|_| ArchiveError::MissingSnapshot)?;
        let content = decode_text(&bytes);
        let source = PathBuf::from(&self.index.documents[position].source_path);
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

    pub fn write(&mut self, id: &str, content: &str) -> Result<ArchiveEntry> {
        let position = self
            .index
            .documents
            .iter()
            .position(|entry| entry.id == id)
            .ok_or(ArchiveError::MissingEntry)?;
        atomic_write(&self.snapshot_path(id), content.as_bytes())?;
        let source_exists = Path::new(&self.index.documents[position].source_path).is_file();
        let entry = &mut self.index.documents[position];
        entry.source_exists = source_exists;
        entry.size = content.len() as u64;
        entry.modified_ms = now_ms();
        entry.last_opened_ms = now_ms();
        let result = entry.clone();
        self.persist()?;
        Ok(result)
    }

    pub fn vcs_snapshot(&self, id: &str) -> Result<(String, Vec<u8>)> {
        let entry = self
            .index
            .documents
            .iter()
            .find(|entry| entry.id == id)
            .ok_or(ArchiveError::MissingEntry)?;
        let bytes = fs::read(self.snapshot_path(id)).map_err(|_| ArchiveError::MissingSnapshot)?;
        Ok((entry.name.clone(), bytes))
    }

    pub fn vcs_restore(&mut self, id: &str, bytes: &[u8]) -> Result<()> {
        let position = self
            .index
            .documents
            .iter()
            .position(|entry| entry.id == id)
            .ok_or(ArchiveError::MissingEntry)?;
        atomic_write(&self.snapshot_path(id), bytes)?;
        let entry = &mut self.index.documents[position];
        entry.size = bytes.len() as u64;
        entry.modified_ms = now_ms();
        entry.last_opened_ms = now_ms();
        entry.source_exists = Path::new(&entry.source_path).is_file();
        self.persist()
    }

    pub fn set_favorite(&mut self, id: &str, favorite: bool) -> Result<Vec<ArchiveEntry>> {
        let entry = self
            .index
            .documents
            .iter_mut()
            .find(|entry| entry.id == id)
            .ok_or(ArchiveError::MissingEntry)?;
        entry.favorite = favorite;
        self.persist()?;
        self.entries()
    }

    pub fn remove(&mut self, id: &str) -> Result<Vec<ArchiveEntry>> {
        let position = self
            .index
            .documents
            .iter()
            .position(|entry| entry.id == id)
            .ok_or(ArchiveError::MissingEntry)?;
        if self.index.documents[position].favorite {
            return Err(ArchiveError::FavoriteEntry);
        }
        let entry = self.index.documents.remove(position);
        remove_if_exists(&self.snapshot_path(&entry.id))?;
        self.persist()?;
        self.entries()
    }

    pub fn clear_history(&mut self) -> Result<Vec<ArchiveEntry>> {
        let removed = self
            .index
            .documents
            .iter()
            .filter(|entry| !entry.favorite)
            .map(|entry| entry.id.clone())
            .collect::<Vec<_>>();
        self.index.documents.retain(|entry| entry.favorite);
        for id in removed {
            remove_if_exists(&self.snapshot_path(&id))?;
        }
        self.persist()?;
        self.entries()
    }

    pub fn reveal_path(&self, id: &str) -> Result<PathBuf> {
        let entry = self
            .index
            .documents
            .iter()
            .find(|entry| entry.id == id)
            .ok_or(ArchiveError::MissingEntry)?;
        let source = PathBuf::from(&entry.source_path);
        if source.is_file() {
            return Ok(source);
        }
        let snapshot = self.snapshot_path(id);
        if snapshot.is_file() {
            return Ok(snapshot);
        }
        Err(ArchiveError::MissingSnapshot)
    }

    pub fn rename_sources(&mut self, previous_root: &Path, next_root: &Path) -> Result<()> {
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

    pub fn mark_missing_under(&mut self, root: &Path) -> Result<()> {
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

    pub fn snapshot_path(&self, id: &str) -> PathBuf {
        self.documents_dir.join(format!("{id}.md"))
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

    fn persist(&self) -> Result<()> {
        let bytes = serde_json::to_vec_pretty(&self.index)
            .map_err(|error| ArchiveError::InvalidIndex(error.to_string()))?;
        atomic_write(&self.index_path, &bytes)
    }
}

fn index_version() -> u32 {
    INDEX_VERSION
}
fn metadata_modified_ms(metadata: &fs::Metadata) -> u64 {
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
fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}
fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    AtomicFile::new(path, AllowOverwrite)
        .write(|file| file.write_all(bytes))
        .map_err(|error| ArchiveError::Io(error.to_string()))
}
fn remove_if_exists(path: &Path) -> Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}
fn backup_corrupt_index(root: &Path, index_path: &Path) -> Result<()> {
    if index_path.exists() {
        fs::copy(
            index_path,
            root.join(format!("index.corrupt-{}.json", now_ms())),
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "leafmark-archive-{label}-{}-{}",
            std::process::id(),
            now_ms()
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn writes_exact_v1_index_and_reopens_existing_snapshot() {
        let root = temp_root("compat");
        let source = root.join("source.md");
        fs::write(&source, "# 原文").unwrap();
        let archive_root = root.join("document-library");
        let mut archive = DocumentArchive::load(&archive_root).unwrap();
        let entry = archive
            .record(&source, "# 保留副本", 14, 123, true)
            .unwrap();
        let value: serde_json::Value =
            serde_json::from_slice(&fs::read(archive_root.join("index.json")).unwrap()).unwrap();
        assert_eq!(value["version"], 1);
        assert_eq!(value["documents"][0]["id"], entry.id);
        drop(archive);
        let mut reopened = DocumentArchive::load(&archive_root).unwrap();
        assert_eq!(reopened.open(&entry.id).unwrap().content, "# 保留副本");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn retained_copy_survives_source_deletion_and_favorite_survives_clear() {
        let root = temp_root("retained");
        let source = root.join("external.md");
        fs::write(&source, "external").unwrap();
        let mut archive = DocumentArchive::load(root.join("document-library")).unwrap();
        let entry = archive.open_source(&source).unwrap().entry;
        archive.write(&entry.id, "edited retained copy").unwrap();
        archive.set_favorite(&entry.id, true).unwrap();
        fs::remove_file(&source).unwrap();
        let entries = archive.clear_history().unwrap();
        assert_eq!(entries.len(), 1);
        let opened = archive.open(&entry.id).unwrap();
        assert!(!opened.entry.source_exists);
        assert_eq!(opened.content, "edited retained copy");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn equivalent_temporary_sources_reuse_content_snapshot() {
        let root = temp_root("dedup");
        let first = root.join("wechat-a.md");
        let second = root.join("wechat-b.md");
        fs::write(&first, "same attachment").unwrap();
        fs::write(&second, "same attachment").unwrap();
        let mut archive = DocumentArchive::load(root.join("document-library")).unwrap();
        let first_id = archive.open_source(&first).unwrap().entry.id;
        let second_id = archive.open_source(&second).unwrap().entry.id;
        assert_eq!(first_id, second_id);
        assert_eq!(archive.entries().unwrap().len(), 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn renames_source_paths_without_touching_snapshots() {
        let root = temp_root("rename");
        let old = root.join("old.md");
        let new = root.join("new.md");
        fs::write(&old, "content").unwrap();
        let mut archive = DocumentArchive::load(root.join("document-library")).unwrap();
        let entry = archive.open_source(&old).unwrap().entry;
        fs::rename(&old, &new).unwrap();
        archive.rename_sources(&old, &new).unwrap();
        let opened = archive.open(&entry.id).unwrap();
        assert_eq!(opened.entry.source_path, new.to_string_lossy());
        assert_eq!(opened.content, "content");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn corrupt_index_is_backed_up_and_recovered() {
        let root = temp_root("corrupt");
        let archive_root = root.join("document-library");
        fs::create_dir_all(&archive_root).unwrap();
        fs::write(archive_root.join("index.json"), "not-json").unwrap();
        let mut archive = DocumentArchive::load(&archive_root).unwrap();
        assert!(archive.entries().unwrap().is_empty());
        assert!(fs::read_dir(&archive_root)
            .unwrap()
            .flatten()
            .any(|entry| entry
                .file_name()
                .to_string_lossy()
                .starts_with("index.corrupt-")));
        fs::remove_dir_all(root).unwrap();
    }
}
