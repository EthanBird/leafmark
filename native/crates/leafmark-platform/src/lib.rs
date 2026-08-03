use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    error::Error,
    fmt,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

pub const APP_IDENTIFIER: &str = "com.leafmark.desktop";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PlatformKind {
    Windows,
    Macos,
    Linux,
    Android,
    Ios,
    Unknown,
}

impl PlatformKind {
    pub const fn current() -> Self {
        if cfg!(target_os = "windows") {
            Self::Windows
        } else if cfg!(target_os = "macos") {
            Self::Macos
        } else if cfg!(target_os = "android") {
            Self::Android
        } else if cfg!(target_os = "ios") {
            Self::Ios
        } else if cfg!(target_os = "linux") {
            Self::Linux
        } else {
            Self::Unknown
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppDirectories {
    pub config: PathBuf,
    pub data: PathBuf,
    pub cache: PathBuf,
    pub documents: PathBuf,
    pub workspace: PathBuf,
}

impl AppDirectories {
    pub fn resolve_desktop() -> Result<Self, PlatformError> {
        Self::resolve_with(PlatformKind::current(), |name| std::env::var_os(name))
    }

    pub fn from_native_bridge(
        config: impl Into<PathBuf>,
        data: impl Into<PathBuf>,
        cache: impl Into<PathBuf>,
        documents: impl Into<PathBuf>,
    ) -> Result<Self, PlatformError> {
        let config = require_absolute(config.into(), "config")?;
        let data = require_absolute(data.into(), "data")?;
        let cache = require_absolute(cache.into(), "cache")?;
        let documents = require_absolute(documents.into(), "documents")?;
        Ok(Self {
            workspace: documents.join("LeafMark"),
            config,
            data,
            cache,
            documents,
        })
    }

    pub fn resolve_with(
        platform: PlatformKind,
        environment: impl Fn(&str) -> Option<std::ffi::OsString>,
    ) -> Result<Self, PlatformError> {
        if matches!(platform, PlatformKind::Android | PlatformKind::Ios) {
            return Err(PlatformError::NativeBridgeRequired(platform));
        }
        let home = environment("HOME")
            .or_else(|| environment("USERPROFILE"))
            .map(PathBuf::from)
            .ok_or_else(|| PlatformError::MissingDirectory("HOME/USERPROFILE".to_owned()))?;
        let documents = environment("LEAFMARK_DOCUMENTS_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("Documents"));
        let identifier = APP_IDENTIFIER;
        let (config, data, cache) = match platform {
            PlatformKind::Windows => {
                let roaming = environment("APPDATA")
                    .map(PathBuf::from)
                    .unwrap_or_else(|| home.join("AppData/Roaming"));
                let local = environment("LOCALAPPDATA")
                    .map(PathBuf::from)
                    .unwrap_or_else(|| home.join("AppData/Local"));
                (
                    roaming.join(identifier),
                    roaming.join(identifier),
                    local.join(identifier),
                )
            }
            PlatformKind::Macos => {
                let support = home.join("Library/Application Support").join(identifier);
                (
                    support.clone(),
                    support,
                    home.join("Library/Caches").join(identifier),
                )
            }
            PlatformKind::Linux | PlatformKind::Unknown => {
                let config = environment("XDG_CONFIG_HOME")
                    .map(PathBuf::from)
                    .unwrap_or_else(|| home.join(".config"))
                    .join(identifier);
                let data = environment("XDG_DATA_HOME")
                    .map(PathBuf::from)
                    .unwrap_or_else(|| home.join(".local/share"))
                    .join(identifier);
                let cache = environment("XDG_CACHE_HOME")
                    .map(PathBuf::from)
                    .unwrap_or_else(|| home.join(".cache"))
                    .join(identifier);
                (config, data, cache)
            }
            PlatformKind::Android | PlatformKind::Ios => unreachable!(),
        };
        Ok(Self {
            workspace: documents.join("LeafMark"),
            config,
            data,
            cache,
            documents,
        })
    }

    pub fn document_library(&self) -> PathBuf {
        self.data.join("document-library")
    }

    pub fn agent_state(&self) -> PathBuf {
        self.data.join("agent-state-v2")
    }

    pub fn agent_vcs(&self) -> PathBuf {
        self.data.join("agent-vcs")
    }
}

fn require_absolute(path: PathBuf, label: &str) -> Result<PathBuf, PlatformError> {
    if path.is_absolute() {
        Ok(path)
    } else {
        Err(PlatformError::InvalidDirectory(format!(
            "{label} 目录必须是绝对路径：{}",
            path.display()
        )))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum PlatformEvent {
    OpenFiles { paths: Vec<PathBuf> },
    BackRequested,
    ThemeChanged { dark: bool },
    AgentCancellationRequested { turn_id: String, reason: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlatformError {
    MissingDirectory(String),
    InvalidDirectory(String),
    NativeBridgeRequired(PlatformKind),
    Clipboard(String),
    Unsupported(String),
    Poisoned,
}

impl fmt::Display for PlatformError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingDirectory(name) => write!(formatter, "缺少系统目录环境：{name}"),
            Self::InvalidDirectory(message) => formatter.write_str(message),
            Self::NativeBridgeRequired(platform) => {
                write!(formatter, "{platform:?} 需要原生平台桥提供应用目录")
            }
            Self::Clipboard(message) => write!(formatter, "剪贴板操作失败：{message}"),
            Self::Unsupported(message) => formatter.write_str(message),
            Self::Poisoned => formatter.write_str("平台服务内部状态已损坏"),
        }
    }
}

impl Error for PlatformError {}

pub trait PlatformServices: Send + Sync {
    fn kind(&self) -> PlatformKind;
    fn directories(&self) -> Result<AppDirectories, PlatformError>;
    fn clipboard_text(&self) -> Result<Option<String>, PlatformError>;
    fn set_clipboard_text(&self, value: &str) -> Result<(), PlatformError>;
    fn reveal(&self, path: &Path) -> Result<(), PlatformError>;
    fn open_external(&self, target: &str) -> Result<(), PlatformError>;
    fn drain_events(&self) -> Result<Vec<PlatformEvent>, PlatformError>;
}

#[derive(Clone)]
pub struct MemoryPlatform {
    kind: PlatformKind,
    directories: AppDirectories,
    state: Arc<Mutex<MemoryPlatformState>>,
}

#[derive(Default)]
struct MemoryPlatformState {
    clipboard: Option<String>,
    events: Vec<PlatformEvent>,
    revealed: Vec<PathBuf>,
    opened: Vec<String>,
}

impl MemoryPlatform {
    pub fn new(kind: PlatformKind, directories: AppDirectories) -> Self {
        Self {
            kind,
            directories,
            state: Arc::new(Mutex::new(MemoryPlatformState::default())),
        }
    }

    pub fn push_event(&self, event: PlatformEvent) -> Result<(), PlatformError> {
        self.state
            .lock()
            .map_err(|_| PlatformError::Poisoned)?
            .events
            .push(event);
        Ok(())
    }

    pub fn revealed(&self) -> Result<Vec<PathBuf>, PlatformError> {
        Ok(self
            .state
            .lock()
            .map_err(|_| PlatformError::Poisoned)?
            .revealed
            .clone())
    }

    pub fn opened(&self) -> Result<Vec<String>, PlatformError> {
        Ok(self
            .state
            .lock()
            .map_err(|_| PlatformError::Poisoned)?
            .opened
            .clone())
    }
}

impl PlatformServices for MemoryPlatform {
    fn kind(&self) -> PlatformKind {
        self.kind
    }

    fn directories(&self) -> Result<AppDirectories, PlatformError> {
        Ok(self.directories.clone())
    }

    fn clipboard_text(&self) -> Result<Option<String>, PlatformError> {
        Ok(self
            .state
            .lock()
            .map_err(|_| PlatformError::Poisoned)?
            .clipboard
            .clone())
    }

    fn set_clipboard_text(&self, value: &str) -> Result<(), PlatformError> {
        self.state
            .lock()
            .map_err(|_| PlatformError::Poisoned)?
            .clipboard = Some(value.to_owned());
        Ok(())
    }

    fn reveal(&self, path: &Path) -> Result<(), PlatformError> {
        self.state
            .lock()
            .map_err(|_| PlatformError::Poisoned)?
            .revealed
            .push(path.to_path_buf());
        Ok(())
    }

    fn open_external(&self, target: &str) -> Result<(), PlatformError> {
        self.state
            .lock()
            .map_err(|_| PlatformError::Poisoned)?
            .opened
            .push(target.to_owned());
        Ok(())
    }

    fn drain_events(&self) -> Result<Vec<PlatformEvent>, PlatformError> {
        let mut state = self.state.lock().map_err(|_| PlatformError::Poisoned)?;
        Ok(std::mem::take(&mut state.events))
    }
}

pub fn environment_map(values: &[(&str, &str)]) -> impl Fn(&str) -> Option<std::ffi::OsString> {
    let values = values
        .iter()
        .map(|(key, value)| ((*key).to_owned(), std::ffi::OsString::from(value)))
        .collect::<HashMap<_, _>>();
    move |name| values.get(name).cloned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_linux_tauri_identifier_directories() {
        let directories = AppDirectories::resolve_with(
            PlatformKind::Linux,
            environment_map(&[
                ("HOME", "/home/leaf"),
                ("XDG_CONFIG_HOME", "/cfg"),
                ("XDG_DATA_HOME", "/data"),
                ("XDG_CACHE_HOME", "/cache"),
            ]),
        )
        .unwrap();
        assert_eq!(
            directories.config,
            PathBuf::from("/cfg/com.leafmark.desktop")
        );
        assert_eq!(
            directories.document_library(),
            PathBuf::from("/data/com.leafmark.desktop/document-library")
        );
        assert_eq!(
            directories.workspace,
            PathBuf::from("/home/leaf/Documents/LeafMark")
        );
    }

    #[test]
    fn resolves_windows_roaming_data_and_local_cache() {
        let directories = AppDirectories::resolve_with(
            PlatformKind::Windows,
            environment_map(&[
                ("USERPROFILE", "C:/Users/Leaf"),
                ("APPDATA", "C:/Users/Leaf/AppData/Roaming"),
                ("LOCALAPPDATA", "C:/Users/Leaf/AppData/Local"),
            ]),
        )
        .unwrap();
        assert_eq!(
            directories.data,
            PathBuf::from("C:/Users/Leaf/AppData/Roaming/com.leafmark.desktop")
        );
        assert_eq!(
            directories.cache,
            PathBuf::from("C:/Users/Leaf/AppData/Local/com.leafmark.desktop")
        );
    }

    #[test]
    fn mobile_requires_native_directory_bridge_even_without_home() {
        let result = AppDirectories::resolve_with(PlatformKind::Android, |_| None);
        assert_eq!(
            result,
            Err(PlatformError::NativeBridgeRequired(PlatformKind::Android))
        );
    }

    #[test]
    fn native_bridge_rejects_relative_directories() {
        let result = AppDirectories::from_native_bridge(
            "config",
            "/data/user/0/com.leafmark.desktop/files",
            "/data/user/0/com.leafmark.desktop/cache",
            "/storage/emulated/0/Documents",
        );
        assert!(matches!(result, Err(PlatformError::InvalidDirectory(_))));
    }

    #[test]
    fn memory_platform_preserves_clipboard_events_and_actions() {
        let directories = AppDirectories {
            config: PathBuf::from("config"),
            data: PathBuf::from("data"),
            cache: PathBuf::from("cache"),
            documents: PathBuf::from("documents"),
            workspace: PathBuf::from("documents/LeafMark"),
        };
        let platform = MemoryPlatform::new(PlatformKind::Linux, directories);
        platform.set_clipboard_text("一叶").unwrap();
        platform.push_event(PlatformEvent::BackRequested).unwrap();
        platform.reveal(Path::new("note.md")).unwrap();
        platform.open_external("https://example.test").unwrap();
        assert_eq!(platform.clipboard_text().unwrap().as_deref(), Some("一叶"));
        assert_eq!(
            platform.drain_events().unwrap(),
            vec![PlatformEvent::BackRequested]
        );
        assert_eq!(platform.revealed().unwrap(), vec![PathBuf::from("note.md")]);
        assert_eq!(platform.opened().unwrap(), vec!["https://example.test"]);
    }
}
