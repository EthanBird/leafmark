use atomicwrites::{AllowOverwrite, AtomicFile};
use ignore::WalkBuilder;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    error::Error,
    fmt, fs,
    io::Write,
    path::{Component, Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

pub const MAX_DOCUMENT_BYTES: u64 = 32 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum EntryKind { File, Directory }

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentEntry {
    pub path: String,
    pub name: String,
    pub kind: EntryKind,
    pub depth: usize,
    pub size: u64,
    pub modified_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedDocument {
    pub path: String,
    pub content: String,
    pub size: u64,
    pub modified_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportDirectoryResult {
    pub root_path: String,
    pub files: Vec<String>,
    pub directories: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StorageError {
    Io(String),
    InvalidPath(String),
    OutsideWorkspace,
    NotMarkdown,
    NotFound,
    Conflict(String),
    TooLarge(u64),
}

impl fmt::Display for StorageError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(message) => f.write_str(message),
            Self::InvalidPath(path) => write!(f, "无效的相对路径：{path}"),
            Self::OutsideWorkspace => f.write_str("路径超出 LeafMark 文档库"),
            Self::NotMarkdown => f.write_str("只允许 .md 或 .markdown 文档"),
            Self::NotFound => f.write_str("目标不存在"),
            Self::Conflict(message) => f.write_str(message),
            Self::TooLarge(size) => write!(f, "Markdown 文档超过 32 MiB：{size} 字节"),
        }
    }
}
impl Error for StorageError {}
impl From<std::io::Error> for StorageError {
    fn from(value: std::io::Error) -> Self { Self::Io(value.to_string()) }
}

type Result<T> = std::result::Result<T, StorageError>;

#[derive(Debug, Clone)]
pub struct WorkspaceService { root: PathBuf }

impl WorkspaceService {
    pub fn open(root: impl AsRef<Path>) -> Result<Self> {
        let root = root.as_ref();
        if !root.is_absolute() { return Err(StorageError::InvalidPath(root.to_string_lossy().into_owned())); }
        fs::create_dir_all(root)?;
        let root = root.canonicalize()?;
        if !root.is_dir() { return Err(StorageError::InvalidPath(root.to_string_lossy().into_owned())); }
        Ok(Self { root })
    }

    pub fn root(&self) -> &Path { &self.root }

    pub fn scan(&self) -> Result<Vec<DocumentEntry>> {
        let mut builder = WalkBuilder::new(&self.root);
        builder.hidden(true).parents(true).ignore(true).git_ignore(true).git_global(true).git_exclude(true)
            .add_custom_ignore_filename(".markignore")
            .filter_entry(|entry| {
                if entry.depth() == 0 { return true; }
                let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
                !matches!(name.as_str(), "node_modules" | "target" | "dist" | "build" | ".git" | ".svn" | ".hg")
            });

        let mut files = Vec::new();
        let mut directories = HashSet::new();
        for item in builder.build() {
            let entry = item.map_err(|error| StorageError::Io(error.to_string()))?;
            let Some(kind) = entry.file_type() else { continue };
            let path = entry.path();
            if kind.is_dir() {
                if entry.depth() > 0 {
                    let relative = path.strip_prefix(&self.root).map_err(|_| StorageError::OutsideWorkspace)?;
                    directories.insert(relative.to_path_buf());
                }
                continue;
            }
            if !kind.is_file() || !is_markdown(path) { continue; }
            let relative = path.strip_prefix(&self.root).map_err(|_| StorageError::OutsideWorkspace)?;
            let mut parent = relative.parent();
            while let Some(directory) = parent {
                if directory.as_os_str().is_empty() { break; }
                directories.insert(directory.to_path_buf());
                parent = directory.parent();
            }
            let metadata = entry.metadata().map_err(|error| StorageError::Io(error.to_string()))?;
            files.push(DocumentEntry {
                path: path_to_slash(relative),
                name: relative.file_name().unwrap_or_default().to_string_lossy().into_owned(),
                kind: EntryKind::File,
                depth: relative.components().count().saturating_sub(1),
                size: metadata.len(),
                modified_ms: modified_ms(&metadata),
            });
        }

        let mut entries = directories.into_iter().map(|relative| {
            let metadata = fs::metadata(self.root.join(&relative)).ok();
            DocumentEntry {
                path: path_to_slash(&relative),
                name: relative.file_name().unwrap_or_default().to_string_lossy().into_owned(),
                kind: EntryKind::Directory,
                depth: relative.components().count().saturating_sub(1),
                size: 0,
                modified_ms: metadata.as_ref().map_or(0, modified_ms),
            }
        }).collect::<Vec<_>>();
        entries.extend(files);
        entries.sort_by(|left, right| {
            parent_slash(&left.path).to_ascii_lowercase().cmp(&parent_slash(&right.path).to_ascii_lowercase())
                .then_with(|| kind_rank(left.kind).cmp(&kind_rank(right.kind)))
                .then_with(|| left.name.to_ascii_lowercase().cmp(&right.name.to_ascii_lowercase()))
        });
        Ok(entries)
    }

    pub fn read(&self, relative_path: &str) -> Result<LoadedDocument> {
        let relative = validate_relative(relative_path, false)?;
        ensure_markdown(&relative)?;
        let target = self.secure_existing(&relative)?;
        let metadata = fs::metadata(&target)?;
        if !metadata.is_file() { return Err(StorageError::NotFound); }
        if metadata.len() > MAX_DOCUMENT_BYTES { return Err(StorageError::TooLarge(metadata.len())); }
        let bytes = fs::read(&target)?;
        Ok(LoadedDocument { path: path_to_slash(&relative), content: decode_text(&bytes), size: metadata.len(), modified_ms: modified_ms(&metadata) })
    }

    pub fn write(&self, relative_path: &str, content: &str) -> Result<LoadedDocument> {
        let relative = validate_relative(relative_path, false)?;
        ensure_markdown(&relative)?;
        if content.len() as u64 > MAX_DOCUMENT_BYTES { return Err(StorageError::TooLarge(content.len() as u64)); }
        let target = self.secure_target(&relative)?;
        if let Some(parent) = target.parent() { fs::create_dir_all(parent)?; }
        atomic_write(&target, content.as_bytes())?;
        self.read(relative_path)
    }

    pub fn create(&self, relative_path: &str, kind: EntryKind) -> Result<()> {
        let relative = validate_relative(relative_path, false)?;
        if kind == EntryKind::File { ensure_markdown(&relative)?; }
        let target = self.secure_target(&relative)?;
        if target.exists() { return Err(StorageError::Conflict("同名文件或文件夹已存在".to_owned())); }
        match kind {
            EntryKind::Directory => fs::create_dir_all(target)?,
            EntryKind::File => {
                if let Some(parent) = target.parent() { fs::create_dir_all(parent)?; }
                atomic_write(&target, b"")?;
            }
        }
        Ok(())
    }

    pub fn rename(&self, source: &str, target: &str) -> Result<()> {
        let source_relative = validate_relative(source, false)?;
        let target_relative = validate_relative(target, false)?;
        let source_path = self.secure_existing(&source_relative)?;
        if fs::metadata(&source_path)?.is_file() {
            ensure_markdown(&source_relative)?;
            ensure_markdown(&target_relative)?;
        }
        let target_path = self.secure_target(&target_relative)?;
        if target_path.exists() { return Err(StorageError::Conflict("目标名称已存在".to_owned())); }
        if let Some(parent) = target_path.parent() { fs::create_dir_all(parent)?; }
        fs::rename(source_path, target_path)?;
        Ok(())
    }

    pub fn delete(&self, relative_path: &str) -> Result<()> {
        let relative = validate_relative(relative_path, false)?;
        let target = self.secure_existing(&relative)?;
        let metadata = fs::metadata(&target)?;
        if metadata.is_dir() { fs::remove_dir_all(target)?; } else { fs::remove_file(target)?; }
        Ok(())
    }

    pub fn import_file(&self, source: impl AsRef<Path>, target_directory: &str) -> Result<String> {
        let source = source.as_ref().canonicalize()?;
        if !source.is_file() { return Err(StorageError::NotFound); }
        ensure_markdown(&source)?;
        let size = fs::metadata(&source)?.len();
        if size > MAX_DOCUMENT_BYTES { return Err(StorageError::TooLarge(size)); }
        let target_relative = validate_relative(target_directory, true)?;
        let target_root = self.secure_target(&target_relative)?;
        fs::create_dir_all(&target_root)?;
        let name = source.file_name().ok_or_else(|| StorageError::InvalidPath(source.to_string_lossy().into_owned()))?;
        let destination = unique_destination(&target_root, name);
        fs::copy(source, &destination)?;
        let relative = destination.strip_prefix(&self.root).map_err(|_| StorageError::OutsideWorkspace)?;
        Ok(path_to_slash(relative))
    }

    pub fn import_directory(&self, source: impl AsRef<Path>, target_directory: &str) -> Result<ImportDirectoryResult> {
        let source = source.as_ref().canonicalize()?;
        if !source.is_dir() { return Err(StorageError::NotFound); }
        let target_relative = validate_relative(target_directory, true)?;
        let target_parent = self.secure_target(&target_relative)?;
        fs::create_dir_all(&target_parent)?;
        let target_parent = target_parent.canonicalize()?;
        if target_parent.starts_with(&source) { return Err(StorageError::InvalidPath("不能把文件夹导入到自身内部".to_owned())); }
        let source_name = source.file_name().unwrap_or_else(|| std::ffi::OsStr::new("导入文档"));
        let destination_root = unique_destination(&target_parent, source_name);
        fs::create_dir_all(&destination_root)?;
        let mut files = Vec::new();
        let mut directories = 1;
        copy_markdown_tree(&source, &destination_root, &self.root, &mut files, &mut directories)?;
        files.sort();
        let root_relative = destination_root.strip_prefix(&self.root).map_err(|_| StorageError::OutsideWorkspace)?;
        Ok(ImportDirectoryResult { root_path: path_to_slash(root_relative), files, directories })
    }

    fn secure_existing(&self, relative: &Path) -> Result<PathBuf> {
        let target = self.root.join(relative);
        if !target.exists() { return Err(StorageError::NotFound); }
        let canonical = target.canonicalize()?;
        if !canonical.starts_with(&self.root) { return Err(StorageError::OutsideWorkspace); }
        Ok(canonical)
    }

    fn secure_target(&self, relative: &Path) -> Result<PathBuf> {
        let target = self.root.join(relative);
        if target.exists() {
            let canonical = target.canonicalize()?;
            if !canonical.starts_with(&self.root) { return Err(StorageError::OutsideWorkspace); }
            return Ok(canonical);
        }
        let mut ancestor = target.parent();
        while let Some(path) = ancestor {
            if path.exists() {
                let canonical = path.canonicalize()?;
                if !canonical.starts_with(&self.root) { return Err(StorageError::OutsideWorkspace); }
                return Ok(target);
            }
            ancestor = path.parent();
        }
        Err(StorageError::OutsideWorkspace)
    }
}

fn copy_markdown_tree(source: &Path, destination: &Path, workspace: &Path, files: &mut Vec<String>, directories: &mut usize) -> Result<()> {
    for item in fs::read_dir(source)? {
        let item = item?;
        let file_type = item.file_type()?;
        if file_type.is_symlink() { continue; }
        let source_path = item.path();
        let target_path = destination.join(item.file_name());
        if file_type.is_dir() {
            fs::create_dir_all(&target_path)?;
            *directories += 1;
            copy_markdown_tree(&source_path, &target_path, workspace, files, directories)?;
        } else if file_type.is_file() && is_markdown(&source_path) {
            let size = item.metadata()?.len();
            if size > MAX_DOCUMENT_BYTES { return Err(StorageError::TooLarge(size)); }
            fs::copy(&source_path, &target_path)?;
            let relative = target_path.strip_prefix(workspace).map_err(|_| StorageError::OutsideWorkspace)?;
            files.push(path_to_slash(relative));
        }
    }
    Ok(())
}

fn validate_relative(value: &str, allow_empty: bool) -> Result<PathBuf> {
    let source = Path::new(value.trim());
    if source.is_absolute() { return Err(StorageError::InvalidPath(value.to_owned())); }
    let mut result = PathBuf::new();
    for component in source.components() {
        match component {
            Component::Normal(part) => {
                if part.to_string_lossy().chars().any(char::is_control) { return Err(StorageError::InvalidPath(value.to_owned())); }
                result.push(part);
            }
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => return Err(StorageError::InvalidPath(value.to_owned())),
        }
    }
    if result.as_os_str().is_empty() && !allow_empty { return Err(StorageError::InvalidPath(value.to_owned())); }
    Ok(result)
}

fn ensure_markdown(path: &Path) -> Result<()> { if is_markdown(path) { Ok(()) } else { Err(StorageError::NotMarkdown) } }
fn is_markdown(path: &Path) -> bool {
    path.extension().and_then(|value| value.to_str()).is_some_and(|extension| extension.eq_ignore_ascii_case("md") || extension.eq_ignore_ascii_case("markdown"))
}
fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    AtomicFile::new(path, AllowOverwrite).write(|file| file.write_all(bytes)).map_err(|error| StorageError::Io(error.to_string()))
}
fn modified_ms(metadata: &fs::Metadata) -> u64 {
    metadata.modified().ok().and_then(|value| value.duration_since(UNIX_EPOCH).ok()).map_or(0, |value| value.as_millis() as u64)
}
fn path_to_slash(path: &Path) -> String {
    path.components().filter_map(|component| match component { Component::Normal(value) => Some(value.to_string_lossy().into_owned()), _ => None }).collect::<Vec<_>>().join("/")
}
fn parent_slash(path: &str) -> &str { path.rsplit_once('/').map_or("", |(parent, _)| parent) }
fn kind_rank(kind: EntryKind) -> u8 { if kind == EntryKind::Directory { 0 } else { 1 } }

fn unique_destination(parent: &Path, requested: &std::ffi::OsStr) -> PathBuf {
    let requested_path = Path::new(requested);
    let stem = requested_path.file_stem().unwrap_or(requested).to_string_lossy();
    let extension = requested_path.extension().map(|value| value.to_string_lossy().into_owned());
    let first = parent.join(requested);
    if !first.exists() { return first; }
    for index in 1..10_000 {
        let name = match &extension { Some(extension) => format!("{stem} ({index}).{extension}"), None => format!("{stem} ({index})") };
        let candidate = parent.join(name);
        if !candidate.exists() { return candidate; }
    }
    parent.join(format!("{stem}-{}", now_ms()))
}
fn now_ms() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |value| value.as_millis() as u64) }

pub fn decode_text(bytes: &[u8]) -> String {
    if let Some(payload) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) { return String::from_utf8_lossy(payload).into_owned(); }
    if let Some(payload) = bytes.strip_prefix(&[0xFF, 0xFE]) {
        let units = payload.chunks_exact(2).map(|pair| u16::from_le_bytes([pair[0], pair[1]])).collect::<Vec<_>>();
        return String::from_utf16_lossy(&units);
    }
    if let Some(payload) = bytes.strip_prefix(&[0xFE, 0xFF]) {
        let units = payload.chunks_exact(2).map(|pair| u16::from_be_bytes([pair[0], pair[1]])).collect::<Vec<_>>();
        return String::from_utf16_lossy(&units);
    }
    String::from_utf8_lossy(bytes).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("leafmark-storage-{label}-{}-{}", std::process::id(), now_ms()));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn rejects_traversal_and_non_markdown_files() {
        let root = temp_root("paths");
        let workspace = WorkspaceService::open(&root).unwrap();
        assert!(workspace.write("../secret.md", "no").is_err());
        assert_eq!(workspace.write("guide.txt", "no"), Err(StorageError::NotMarkdown));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn scans_empty_directories_and_reads_utf16() {
        let root = temp_root("scan");
        fs::create_dir_all(root.join("空文件夹/子目录")).unwrap();
        fs::write(root.join("忽略.txt"), "no").unwrap();
        fs::write(root.join("文档.md"), [0xFF, 0xFE, 0xF6, 0x53]).unwrap();
        let workspace = WorkspaceService::open(&root).unwrap();
        let entries = workspace.scan().unwrap();
        assert!(entries.iter().any(|entry| entry.path == "空文件夹/子目录" && entry.kind == EntryKind::Directory));
        assert!(!entries.iter().any(|entry| entry.name == "忽略.txt"));
        assert_eq!(workspace.read("文档.md").unwrap().content, "叶");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn writes_renames_and_deletes_atomically() {
        let root = temp_root("mutations");
        let workspace = WorkspaceService::open(&root).unwrap();
        workspace.write("课程/第一章.md", "# 第一章").unwrap();
        workspace.rename("课程/第一章.md", "课程/基础.md").unwrap();
        assert_eq!(workspace.read("课程/基础.md").unwrap().content, "# 第一章");
        workspace.delete("课程").unwrap();
        assert!(!root.join("课程").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn imports_directory_and_preserves_empty_structure() {
        let root = temp_root("import");
        let source = root.join("source/课程笔记");
        let workspace_root = root.join("workspace");
        fs::create_dir_all(source.join("第一章/空目录")).unwrap();
        fs::write(source.join("README.md"), "# 课程").unwrap();
        fs::write(source.join("第一章/推导.markdown"), "$x^2$").unwrap();
        fs::write(source.join("第一章/忽略.txt"), "no").unwrap();
        let workspace = WorkspaceService::open(&workspace_root).unwrap();
        let result = workspace.import_directory(&source, "").unwrap();
        assert_eq!(result.files.len(), 2);
        assert!(workspace_root.join("课程笔记/第一章/空目录").is_dir());
        assert!(!workspace_root.join("课程笔记/第一章/忽略.txt").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_escape() {
        use std::os::unix::fs::symlink;
        let root = temp_root("symlink");
        let outside = temp_root("outside");
        symlink(&outside, root.join("escape")).unwrap();
        let workspace = WorkspaceService::open(&root).unwrap();
        assert_eq!(workspace.write("escape/pwn.md", "no"), Err(StorageError::OutsideWorkspace));
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }
}
