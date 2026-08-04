use atomicwrites::{AllowOverwrite, AtomicFile};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    error::Error,
    fmt, fs,
    io::Write,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

pub const SETTINGS_SCHEMA_VERSION: u32 = 5;

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ThemeMode {
    #[default]
    System,
    Light,
    Dark,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ThemePalette {
    #[default]
    Leaf,
    Sakura,
    Qingchuan,
    Amber,
    Wisteria,
    Monochrome,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    #[serde(default)]
    pub settings_schema_version: u32,
    #[serde(default)]
    pub workspace_path: String,
    #[serde(default)]
    pub theme: ThemeMode,
    #[serde(default)]
    pub theme_palette: ThemePalette,
    #[serde(default)]
    pub live_editing: bool,
    #[serde(default = "default_autosave_delay")]
    pub autosave_delay_ms: u64,
    #[serde(default = "default_content_width")]
    pub content_width: u32,
    #[serde(default = "default_font_family")]
    pub font_family: String,
    #[serde(default = "default_font_size")]
    pub font_size: u32,
    #[serde(default = "default_line_height")]
    pub line_height: f32,
    #[serde(default = "default_true")]
    pub show_status_bar: bool,
    #[serde(default)]
    pub reduce_motion: bool,
    #[serde(default = "default_true")]
    pub mermaid_enabled: bool,
    #[serde(default = "default_true")]
    pub math_enabled: bool,
    #[serde(default = "default_desktop_layout")]
    pub desktop_layout: Value,
    #[serde(default = "default_agent_settings")]
    pub agent: Value,
}

impl AppSettings {
    pub fn defaults(workspace: &Path) -> Self {
        Self {
            settings_schema_version: SETTINGS_SCHEMA_VERSION,
            workspace_path: workspace.to_string_lossy().into_owned(),
            theme: ThemeMode::System,
            theme_palette: ThemePalette::Leaf,
            live_editing: true,
            autosave_delay_ms: default_autosave_delay(),
            content_width: default_content_width(),
            font_family: default_font_family(),
            font_size: default_font_size(),
            line_height: default_line_height(),
            show_status_bar: true,
            reduce_motion: false,
            mermaid_enabled: true,
            math_enabled: true,
            desktop_layout: default_desktop_layout(),
            agent: default_agent_settings(),
        }
    }

    pub fn normalize(mut self, default_workspace: &Path) -> Self {
        if self.settings_schema_version < 2 {
            self.live_editing = true;
        }
        if self.settings_schema_version < 3 {
            self.theme_palette = ThemePalette::Leaf;
        }
        if self.settings_schema_version < 5
            && self.agent.get("provider").and_then(Value::as_str) == Some("openai-oauth")
            && self.agent.get("reasoningEffort").and_then(Value::as_str) == Some("none")
        {
            self.agent["reasoningEffort"] = Value::String("low".to_owned());
        }
        self.settings_schema_version = SETTINGS_SCHEMA_VERSION;
        let workspace = PathBuf::from(self.workspace_path.trim());
        if !workspace.is_absolute() {
            self.workspace_path = default_workspace.to_string_lossy().into_owned();
        }
        self.font_family = self.font_family.trim().to_owned();
        if self.font_family.is_empty()
            || self.font_family.len() > 120
            || self.font_family.chars().any(char::is_control)
        {
            self.font_family = default_font_family();
        }
        self.autosave_delay_ms = self.autosave_delay_ms.clamp(150, 5_000);
        self.content_width = self.content_width.clamp(560, 1_400);
        self.font_size = self.font_size.clamp(12, 28);
        self.line_height = self.line_height.clamp(1.2, 2.4);
        if !self.desktop_layout.is_object() {
            self.desktop_layout = default_desktop_layout();
        }
        if !self.agent.is_object() {
            self.agent = default_agent_settings();
        }
        self
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SettingsError {
    Io(String),
    Json(String),
}

impl fmt::Display for SettingsError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(message) => formatter.write_str(message),
            Self::Json(message) => write!(formatter, "设置 JSON 无效：{message}"),
        }
    }
}

impl Error for SettingsError {}

impl From<std::io::Error> for SettingsError {
    fn from(value: std::io::Error) -> Self {
        Self::Io(value.to_string())
    }
}

type Result<T> = std::result::Result<T, SettingsError>;

pub struct SettingsStore {
    path: PathBuf,
    default_workspace: PathBuf,
    settings: AppSettings,
}

impl SettingsStore {
    pub fn load(path: impl AsRef<Path>, default_workspace: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref().to_path_buf();
        let default_workspace = default_workspace.as_ref().to_path_buf();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let settings = match fs::read(&path) {
            Ok(bytes) => match serde_json::from_slice::<AppSettings>(&bytes) {
                Ok(settings) => settings.normalize(&default_workspace),
                Err(_) => {
                    backup_corrupt(&path)?;
                    AppSettings::defaults(&default_workspace)
                }
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                AppSettings::defaults(&default_workspace)
            }
            Err(error) => return Err(error.into()),
        };
        let store = Self {
            path,
            default_workspace,
            settings,
        };
        store.persist()?;
        Ok(store)
    }

    pub fn settings(&self) -> &AppSettings {
        &self.settings
    }

    pub fn replace(&mut self, settings: AppSettings) -> Result<&AppSettings> {
        self.settings = settings.normalize(&self.default_workspace);
        self.persist()?;
        Ok(&self.settings)
    }

    pub fn set_workspace(&mut self, workspace: &Path) -> Result<&AppSettings> {
        if workspace.is_absolute() {
            self.settings.workspace_path = workspace.to_string_lossy().into_owned();
        } else {
            self.settings.workspace_path = self.default_workspace.to_string_lossy().into_owned();
        }
        self.persist()?;
        Ok(&self.settings)
    }

    fn persist(&self) -> Result<()> {
        let bytes = serde_json::to_vec_pretty(&self.settings)
            .map_err(|error| SettingsError::Json(error.to_string()))?;
        AtomicFile::new(&self.path, AllowOverwrite)
            .write(|file| file.write_all(&bytes))
            .map_err(|error| SettingsError::Io(error.to_string()))
    }
}

fn default_true() -> bool {
    true
}

fn default_autosave_delay() -> u64 {
    600
}

fn default_content_width() -> u32 {
    860
}

fn default_font_family() -> String {
    "system".to_owned()
}

fn default_font_size() -> u32 {
    16
}

fn default_line_height() -> f32 {
    1.75
}

pub fn default_desktop_layout() -> Value {
    json!({
        "zones": {
            "left": { "panels": ["workspace", "history", "favorites", "agent"], "active": "workspace" },
            "right": { "panels": ["outline"], "active": "outline" },
            "top": { "panels": [], "active": null },
            "bottom": { "panels": [], "active": null }
        },
        "hidden": ["outline"],
        "leftSize": 276,
        "rightSize": 244,
        "topSize": 210,
        "bottomSize": 240
    })
}

pub fn default_agent_settings() -> Value {
    json!({
        "enabled": false,
        "provider": "deepseek",
        "baseUrl": "https://api.deepseek.com",
        "apiKey": "",
        "model": "deepseek-v4-flash",
        "temperature": 0.3,
        "topP": 0.95,
        "maxTokens": 8192,
        "contextChars": 32000,
        "maxToolRounds": 8,
        "maxParallelAgents": 3,
        "reasoningEffort": "none",
        "systemPrompt": "你是一叶 LeafMark 内置的文档 Agent。先理解目标，再使用工具；保持 Markdown、公式、链接和代码完整。",
        "allowDocumentEdits": false,
        "memoryEnabled": true,
        "webToolsEnabled": true,
        "terminalToolsEnabled": false,
        "allowDestructiveTerminal": false,
        "enabledSkills": ["writing", "proofread", "summarize", "structure"],
        "customSkills": "",
        "mcpServersJson": ""
    })
}

fn backup_corrupt(path: &Path) -> Result<()> {
    if path.exists() {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |duration| duration.as_millis());
        let backup = path.with_file_name(format!("settings.corrupt-{timestamp}.json"));
        fs::copy(path, backup)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(label: &str) -> PathBuf {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "leafmark-settings-{label}-{}-{timestamp}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn migrates_legacy_settings_without_losing_agent_fields() {
        let root = temp_root("legacy");
        let workspace = root.join("workspace");
        fs::create_dir_all(&workspace).unwrap();
        let path = root.join("settings.json");
        fs::write(
            &path,
            serde_json::to_vec(&json!({
                "workspacePath": workspace,
                "theme": "dark",
                "liveEditing": false,
                "autosaveDelayMs": 10,
                "contentWidth": 9999,
                "fontSize": 5,
                "lineHeight": 8.0,
                "showStatusBar": true,
                "reduceMotion": false,
                "mermaidEnabled": true,
                "mathEnabled": true,
                "agent": {
                    "provider": "openai-oauth",
                    "reasoningEffort": "none",
                    "customFutureField": 42
                }
            }))
            .unwrap(),
        )
        .unwrap();
        let store = SettingsStore::load(&path, &workspace).unwrap();
        let settings = store.settings();
        assert_eq!(settings.settings_schema_version, SETTINGS_SCHEMA_VERSION);
        assert!(settings.live_editing);
        assert_eq!(settings.autosave_delay_ms, 150);
        assert_eq!(settings.content_width, 1_400);
        assert_eq!(settings.font_size, 12);
        assert_eq!(settings.line_height, 2.4);
        assert_eq!(settings.agent["reasoningEffort"], "low");
        assert_eq!(settings.agent["customFutureField"], 42);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn corrupt_settings_are_backed_up_and_replaced() {
        let root = temp_root("corrupt");
        let workspace = root.join("workspace");
        fs::create_dir_all(&workspace).unwrap();
        let path = root.join("settings.json");
        fs::write(&path, "not-json").unwrap();
        let store = SettingsStore::load(&path, &workspace).unwrap();
        assert_eq!(store.settings().workspace_path, workspace.to_string_lossy());
        assert!(fs::read_dir(&root).unwrap().flatten().any(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with("settings.corrupt-")
        }));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn relative_workspace_falls_back_to_default() {
        let root = temp_root("workspace");
        let workspace = root.join("workspace");
        fs::create_dir_all(&workspace).unwrap();
        let path = root.join("settings.json");
        fs::write(
            &path,
            serde_json::to_vec(&json!({
                "settingsSchemaVersion": 5,
                "workspacePath": "relative/path"
            }))
            .unwrap(),
        )
        .unwrap();
        let store = SettingsStore::load(&path, &workspace).unwrap();
        assert_eq!(store.settings().workspace_path, workspace.to_string_lossy());
        fs::remove_dir_all(root).unwrap();
    }
}
