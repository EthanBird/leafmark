use std::{
    ffi::OsStr,
    fs,
    io::Write,
    path::{Component, Path, PathBuf},
    sync::Arc,
    time::UNIX_EPOCH,
};

use atomicwrites::{AllowOverwrite, AtomicFile};
use ignore::WalkBuilder;
use serde::{Deserialize, Serialize};

const MAX_DOCUMENT_BYTES: u64 = 32 * 1024 * 1024;
const MARKDOWN_EXTENSIONS: [&str; 2] = ["md", "markdown"];

pub type WorkspaceResult<T> = Result<T, String>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceEntry {
    pub relative_path: String,
    pub name: String,
    pub depth: usize,
    pub size: u64,
    pub modified_ms: u64,
}

#[derive(Debug, Clone)]
pub struct Workspace {
    root: Arc<PathBuf>,
}

impl Workspace {
    pub fn open(path: impl AsRef<Path>) -> WorkspaceResult<Self> {
        let requested = path.as_ref();
        if requested.as_os_str().is_empty() {
            return Err("工作区路径不能为空".to_owned());
        }
        fs::create_dir_all(requested).map_err(error_string)?;
        let root = requested.canonicalize().map_err(error_string)?;
        if !root.is_dir() {
            return Err("工作区路径不是文件夹".to_owned());
        }
        Ok(Self {
            root: Arc::new(root),
        })
    }

    pub fn root(&self) -> &Path {
        self.root.as_path()
    }

    pub fn root_display(&self) -> String {
        self.root.to_string_lossy().into_owned()
    }

    pub fn scan(&self) -> WorkspaceResult<Vec<WorkspaceEntry>> {
        let mut builder = WalkBuilder::new(self.root());
        builder
            .hidden(true)
            .parents(true)
            .ignore(true)
            .git_ignore(true)
            .git_global(true)
            .git_exclude(true)
            .add_custom_ignore_filename(".markignore")
            .filter_entry(|entry| {
                if entry.depth() == 0 {
                    return true;
                }
                let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
                !matches!(
                    name.as_str(),
                    "node_modules" | "target" | "dist" | "build" | ".git" | ".svn" | ".hg"
                )
            });

        let mut entries = Vec::new();
        for result in builder.build() {
            let entry = result.map_err(error_string)?;
            let Some(kind) = entry.file_type() else {
                continue;
            };
            if !kind.is_file() || !is_markdown(entry.path()) {
                continue;
            }
            let relative = entry
                .path()
                .strip_prefix(self.root())
                .map_err(|_| "扫描结果超出工作区".to_owned())?;
            let metadata = entry.metadata().map_err(error_string)?;
            entries.push(WorkspaceEntry {
                relative_path: path_to_slash(relative),
                name: relative
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned(),
                depth: relative.components().count().saturating_sub(1),
                size: metadata.len(),
                modified_ms: modified_ms(&metadata),
            });
        }
        entries.sort_by(|left, right| {
            left.relative_path
                .to_ascii_lowercase()
                .cmp(&right.relative_path.to_ascii_lowercase())
        });
        Ok(entries)
    }

    pub fn read_document(&self, relative_path: &str) -> WorkspaceResult<String> {
        let relative = validate_markdown_path(relative_path)?;
        let target = self.secure_existing_path(&relative)?;
        let metadata = fs::metadata(&target).map_err(error_string)?;
        if !metadata.is_file() {
            return Err("目标不是文件".to_owned());
        }
        if metadata.len() > MAX_DOCUMENT_BYTES {
            return Err("Markdown 文档超过 32 MiB，已拒绝打开".to_owned());
        }
        let bytes = fs::read(target).map_err(error_string)?;
        Ok(decode_text(&bytes))
    }

    pub fn write_document(&self, relative_path: &str, content: &str) -> WorkspaceResult<()> {
        if content.len() as u64 > MAX_DOCUMENT_BYTES {
            return Err("Markdown 文档超过 32 MiB，已拒绝保存".to_owned());
        }
        let relative = validate_markdown_path(relative_path)?;
        let target = self.secure_target_path(&relative)?;
        atomic_write(&target, content.as_bytes())
    }

    fn secure_existing_path(&self, relative: &Path) -> WorkspaceResult<PathBuf> {
        let target = self.root().join(relative).canonicalize().map_err(error_string)?;
        if !target.starts_with(self.root()) {
            return Err("文档路径超出工作区".to_owned());
        }
        Ok(target)
    }

    fn secure_target_path(&self, relative: &Path) -> WorkspaceResult<PathBuf> {
        let lexical = self.root().join(relative);
        if lexical.exists() {
            return self.secure_existing_path(relative);
        }
        let parent = lexical
            .parent()
            .ok_or_else(|| "保存路径缺少父目录".to_owned())?;
        fs::create_dir_all(parent).map_err(error_string)?;
        let parent = parent.canonicalize().map_err(error_string)?;
        if !parent.starts_with(self.root()) {
            return Err("保存路径超出工作区".to_owned());
        }
        let name = lexical
            .file_name()
            .ok_or_else(|| "保存路径缺少文件名".to_owned())?;
        Ok(parent.join(name))
    }
}

fn validate_markdown_path(value: &str) -> WorkspaceResult<PathBuf> {
    let path = Path::new(value);
    if value.trim().is_empty() || path.is_absolute() {
        return Err("文档必须使用工作区内的相对路径".to_owned());
    }
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => normalized.push(part),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err("文档路径包含不安全的目录跳转".to_owned());
            }
        }
    }
    if normalized.as_os_str().is_empty() || !is_markdown(&normalized) {
        return Err("只支持 .md 或 .markdown 文档".to_owned());
    }
    Ok(normalized)
}

fn is_markdown(path: &Path) -> bool {
    path.extension()
        .and_then(OsStr::to_str)
        .is_some_and(|extension| {
            MARKDOWN_EXTENSIONS
                .iter()
                .any(|candidate| extension.eq_ignore_ascii_case(candidate))
        })
}

fn path_to_slash(path: &Path) -> String {
    path.components()
        .filter_map(|component| match component {
            Component::Normal(part) => Some(part.to_string_lossy()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn decode_text(bytes: &[u8]) -> String {
    if let Some(value) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        return String::from_utf8_lossy(value).into_owned();
    }
    if let Some(value) = bytes.strip_prefix(&[0xFF, 0xFE]) {
        let units = value
            .chunks_exact(2)
            .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]));
        return char::decode_utf16(units)
            .map(|result| result.unwrap_or(char::REPLACEMENT_CHARACTER))
            .collect();
    }
    if let Some(value) = bytes.strip_prefix(&[0xFE, 0xFF]) {
        let units = value
            .chunks_exact(2)
            .map(|chunk| u16::from_be_bytes([chunk[0], chunk[1]]));
        return char::decode_utf16(units)
            .map(|result| result.unwrap_or(char::REPLACEMENT_CHARACTER))
            .collect();
    }
    String::from_utf8_lossy(bytes).into_owned()
}

fn atomic_write(path: &Path, bytes: &[u8]) -> WorkspaceResult<()> {
    AtomicFile::new(path, AllowOverwrite)
        .write(|file| file.write_all(bytes))
        .map_err(error_string)
}

fn modified_ms(metadata: &fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |duration| duration.as_millis() as u64)
}

fn error_string(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_root(label: &str) -> PathBuf {
        let nonce = std::time::SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "leafmark-native-{label}-{}-{nonce}",
            std::process::id()
        ))
    }

    #[test]
    fn scans_reads_and_atomically_writes_markdown() {
        let root = test_root("workspace");
        fs::create_dir_all(root.join("notes/sub")).unwrap();
        fs::write(root.join("notes/a.md"), "# A").unwrap();
        fs::write(root.join("notes/sub/b.markdown"), "# B").unwrap();
        fs::write(root.join("notes/ignored.txt"), "ignore").unwrap();

        let workspace = Workspace::open(&root).unwrap();
        let entries = workspace.scan().unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(workspace.read_document("notes/a.md").unwrap(), "# A");
        workspace
            .write_document("notes/a.md", "# Updated")
            .unwrap();
        assert_eq!(fs::read_to_string(root.join("notes/a.md")).unwrap(), "# Updated");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_traversal_and_non_markdown_paths() {
        let root = test_root("security");
        fs::create_dir_all(&root).unwrap();
        let workspace = Workspace::open(&root).unwrap();
        assert!(workspace.read_document("../secret.md").is_err());
        assert!(workspace.write_document("note.txt", "x").is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn decodes_utf16_bom_files() {
        let root = test_root("encoding");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("utf16.md"), [0xFF, 0xFE, b'o', 0, b'k', 0]).unwrap();
        let workspace = Workspace::open(&root).unwrap();
        assert_eq!(workspace.read_document("utf16.md").unwrap(), "ok");
        let _ = fs::remove_dir_all(root);
    }
}
