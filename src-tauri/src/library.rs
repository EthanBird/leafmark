use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Component, Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use super::atomic_write;

const INDEX_VERSION: u32 = 1;

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
}

#[derive(Debug, Clone)]
pub(crate) struct ArchivedContent {
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
        let index = match fs::read(&index_path) {
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
        let duplicate_id = self.index.documents.iter().find_map(|entry| {
            let snapshot = fs::read(self.snapshot_path(&entry.id)).ok()?;
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
        let snapshot_path = self.snapshot_path(id);
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

    pub(crate) fn write(&mut self, id: &str, content: &str) -> Result<ArchiveEntry, String> {
        let position = self
            .index
            .documents
            .iter()
            .position(|entry| entry.id == id)
            .ok_or_else(|| "历史记录不存在".to_string())?;
        let source = PathBuf::from(&self.index.documents[position].source_path);
        let source_exists = source.is_file();
        atomic_write(&self.snapshot_path(id), content.as_bytes())?;
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
        let bytes = fs::read(self.snapshot_path(id))
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
        atomic_write(&self.snapshot_path(id), bytes)?;
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
        match fs::remove_file(self.snapshot_path(&entry.id)) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error_string(error)),
        }
        self.persist()?;
        self.entries()
    }

    pub(crate) fn clear_history(&mut self) -> Result<Vec<ArchiveEntry>, String> {
        let removed: Vec<String> = self
            .index
            .documents
            .iter()
            .filter(|entry| !entry.favorite)
            .map(|entry| entry.id.clone())
            .collect();
        self.index.documents.retain(|entry| entry.favorite);
        for id in removed {
            match fs::remove_file(self.snapshot_path(&id)) {
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
        let snapshot = self.snapshot_path(id);
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
        // The source has already moved when this runs, so canonicalizing the
        // complete previous path is no longer possible. Resolve the nearest
        // existing ancestor instead. This is especially important on Windows,
        // where the same temp directory may be represented as RUNNER~1,
        // runneradmin, or with a verbatim `\\?\` prefix.
        let next_root = canonicalize_with_missing_tail(next_root);
        let mut changed = false;
        for entry in &mut self.index.documents {
            let source = Path::new(&entry.source_path);
            let suffix = equivalent_path_suffix(source, previous_root);
            #[cfg(all(test, windows))]
            eprintln!(
                "rename_sources source={source:?} previous={previous_root:?} suffix={suffix:?}"
            );
            let Some(suffix) = suffix else {
                continue;
            };
            let next = next_root.join(&suffix);
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

    fn snapshot_path(&self, id: &str) -> PathBuf {
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

fn canonicalize_with_missing_tail(path: &Path) -> PathBuf {
    let mut cursor = path;
    let mut missing = Vec::new();
    loop {
        if let Ok(mut resolved) = cursor.canonicalize() {
            for component in missing.iter().rev() {
                resolved.push(component);
            }
            return resolved;
        }
        let Some(name) = cursor.file_name() else {
            return path.to_path_buf();
        };
        missing.push(name.to_os_string());
        let Some(parent) = cursor.parent() else {
            return path.to_path_buf();
        };
        cursor = parent;
    }
}

fn equivalent_path_suffix(path: &Path, root: &Path) -> Option<PathBuf> {
    if let Ok(suffix) = path.strip_prefix(root) {
        if safe_relative_suffix(suffix) {
            return Some(suffix.to_path_buf());
        }
    }

    #[cfg(windows)]
    if let Some(suffix) = windows_identity_suffix(path, root) {
        return Some(suffix);
    }

    let resolved_path = canonicalize_with_missing_tail(path);
    let resolved_root = canonicalize_with_missing_tail(root);
    if let Ok(suffix) = resolved_path.strip_prefix(&resolved_root) {
        if safe_relative_suffix(suffix) {
            return Some(suffix.to_path_buf());
        }
    }

    if cfg!(windows) {
        let path_components: Vec<_> = resolved_path.components().collect();
        let root_components: Vec<_> = resolved_root.components().collect();
        if root_components.len() <= path_components.len()
            && root_components.iter().zip(&path_components).all(|(left, right)| {
                left.as_os_str()
                    .to_string_lossy()
                    .to_lowercase()
                    == right.as_os_str().to_string_lossy().to_lowercase()
            })
        {
            let mut suffix = PathBuf::new();
            for component in &path_components[root_components.len()..] {
                suffix.push(component.as_os_str());
            }
            if safe_relative_suffix(&suffix) {
                return Some(suffix);
            }
        }
    }
    None
}

fn safe_relative_suffix(path: &Path) -> bool {
    path.components()
        .all(|component| matches!(component, Component::Normal(_)))
}

#[cfg(windows)]
fn windows_identity_suffix(path: &Path, root: &Path) -> Option<PathBuf> {
    let path_parts = existing_ancestor_and_tail(path);
    let root_parts = existing_ancestor_and_tail(root);
    #[cfg(test)]
    eprintln!("windows_identity_suffix path_parts={path_parts:?} root_parts={root_parts:?}");
    let (path_ancestor, path_tail) = path_parts?;
    let (root_ancestor, root_tail) = root_parts?;
    let path_identity = windows_file_identity(&path_ancestor);
    let root_identity = windows_file_identity(&root_ancestor);
    #[cfg(test)]
    eprintln!(
        "windows_identity_suffix path_identity={path_identity:?} root_identity={root_identity:?}"
    );
    if path_identity? != root_identity?
        || root_tail.len() > path_tail.len()
        || !root_tail.iter().zip(&path_tail).all(|(left, right)| {
            left.to_string_lossy().to_lowercase() == right.to_string_lossy().to_lowercase()
        })
    {
        return None;
    }
    let mut suffix = PathBuf::new();
    for component in &path_tail[root_tail.len()..] {
        suffix.push(component);
    }
    safe_relative_suffix(&suffix).then_some(suffix)
}

#[cfg(windows)]
fn existing_ancestor_and_tail(
    path: &Path,
) -> Option<(PathBuf, Vec<std::ffi::OsString>)> {
    let mut cursor = path;
    let mut tail = Vec::new();
    loop {
        if fs::metadata(cursor).is_ok() {
            tail.reverse();
            return Some((cursor.to_path_buf(), tail));
        }
        let name = cursor.file_name()?;
        tail.push(name.to_os_string());
        cursor = cursor.parent()?;
    }
}

#[cfg(windows)]
fn windows_file_identity(path: &Path) -> Option<(u32, u64)> {
    use std::{iter, mem::MaybeUninit, os::windows::ffi::OsStrExt, ptr};

    const FILE_SHARE_ALL: u32 = 0x0000_0001 | 0x0000_0002 | 0x0000_0004;
    const OPEN_EXISTING: u32 = 3;
    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
    let input: Vec<u16> = path.as_os_str().encode_wide().chain(iter::once(0)).collect();
    let handle = unsafe {
        create_file_w(
            input.as_ptr(),
            0,
            FILE_SHARE_ALL,
            ptr::null_mut(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS,
            ptr::null_mut(),
        )
    };
    if handle == (-1_isize as *mut std::ffi::c_void) {
        #[cfg(test)]
        eprintln!(
            "windows_file_identity CreateFileW failed for {path:?}: {}",
            std::io::Error::last_os_error()
        );
        return None;
    }
    let mut information = MaybeUninit::<WindowsFileInformation>::uninit();
    let succeeded = unsafe { get_file_information_by_handle(handle, information.as_mut_ptr()) };
    #[cfg(test)]
    let information_error = (succeeded == 0).then(std::io::Error::last_os_error);
    unsafe {
        close_handle(handle);
    }
    if succeeded == 0 {
        #[cfg(test)]
        eprintln!(
            "windows_file_identity GetFileInformationByHandle failed for {path:?}: {}",
            information_error.unwrap()
        );
        return None;
    }
    let information = unsafe { information.assume_init() };
    Some((
        information.volume_serial_number,
        (u64::from(information.file_index_high) << 32)
            | u64::from(information.file_index_low),
    ))
}

#[cfg(windows)]
#[repr(C)]
struct WindowsFileTime {
    low_date_time: u32,
    high_date_time: u32,
}

#[cfg(windows)]
#[repr(C)]
struct WindowsFileInformation {
    file_attributes: u32,
    creation_time: WindowsFileTime,
    last_access_time: WindowsFileTime,
    last_write_time: WindowsFileTime,
    volume_serial_number: u32,
    file_size_high: u32,
    file_size_low: u32,
    number_of_links: u32,
    file_index_high: u32,
    file_index_low: u32,
}

#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    #[link_name = "CreateFileW"]
    fn create_file_w(
        file_name: *const u16,
        desired_access: u32,
        share_mode: u32,
        security_attributes: *mut std::ffi::c_void,
        creation_disposition: u32,
        flags_and_attributes: u32,
        template_file: *mut std::ffi::c_void,
    ) -> *mut std::ffi::c_void;

    #[link_name = "GetFileInformationByHandle"]
    fn get_file_information_by_handle(
        file: *mut std::ffi::c_void,
        information: *mut WindowsFileInformation,
    ) -> i32;

    #[link_name = "CloseHandle"]
    fn close_handle(object: *mut std::ffi::c_void) -> i32;
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
    fn equivalent_suffix_is_component_bounded_and_cannot_escape() {
        let root = Path::new("workspace/folder");
        assert!(safe_relative_suffix(Path::new("nested/note.md")));
        assert!(!safe_relative_suffix(Path::new("../outside.md")));
        assert_eq!(
            equivalent_path_suffix(Path::new("workspace/folder/note.md"), root),
            Some(PathBuf::from("note.md"))
        );
        assert_eq!(
            equivalent_path_suffix(Path::new("workspace/folder-old/note.md"), root),
            None
        );
        assert_eq!(
            equivalent_path_suffix(Path::new("workspace/folder/../outside.md"), root),
            None
        );
    }
}
