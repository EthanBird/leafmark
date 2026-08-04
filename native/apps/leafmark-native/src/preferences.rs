use atomicwrites::{AllowOverwrite, AtomicFile};
use leafmark_platform::AppDirectories;
use serde::{Deserialize, Serialize};
use std::{fs, io::Write, path::PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ThemePalette {
    Leaf,
    Sakura,
    Qingchuan,
    Amber,
    Wisteria,
    Monochrome,
}

impl ThemePalette {
    pub const ALL: [Self; 6] = [
        Self::Leaf,
        Self::Sakura,
        Self::Qingchuan,
        Self::Amber,
        Self::Wisteria,
        Self::Monochrome,
    ];

    pub const fn label(self) -> &'static str {
        match self {
            Self::Leaf => "一叶绿",
            Self::Sakura => "樱花粉",
            Self::Qingchuan => "清川蓝",
            Self::Amber => "暖杏金",
            Self::Wisteria => "藤萝紫",
            Self::Monochrome => "黑白灰",
        }
    }

    pub const fn class_name(self) -> &'static str {
        match self {
            Self::Leaf => "theme-leaf",
            Self::Sakura => "theme-sakura",
            Self::Qingchuan => "theme-qingchuan",
            Self::Amber => "theme-amber",
            Self::Wisteria => "theme-wisteria",
            Self::Monochrome => "theme-monochrome",
        }
    }

    pub const fn swatch_class(self) -> &'static str {
        match self {
            Self::Leaf => "palette-swatch swatch-leaf",
            Self::Sakura => "palette-swatch swatch-sakura",
            Self::Qingchuan => "palette-swatch swatch-qingchuan",
            Self::Amber => "palette-swatch swatch-amber",
            Self::Wisteria => "palette-swatch swatch-wisteria",
            Self::Monochrome => "palette-swatch swatch-monochrome",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ThemeMode {
    System,
    Light,
    Dark,
}

impl ThemeMode {
    pub const ALL: [Self; 3] = [Self::System, Self::Light, Self::Dark];

    pub const fn label(self) -> &'static str {
        match self {
            Self::System => "系统",
            Self::Light => "浅色",
            Self::Dark => "深色",
        }
    }

    pub const fn icon(self) -> &'static str {
        match self {
            Self::System => "▣",
            Self::Light => "☀",
            Self::Dark => "☾",
        }
    }

    pub const fn class_name(self) -> &'static str {
        match self {
            Self::System => "system",
            Self::Light => "light",
            Self::Dark => "dark",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AgentProvider {
    OpenAi,
    DeepSeek,
    OpenRouter,
    Ollama,
    Custom,
}

impl AgentProvider {
    pub const ALL: [Self; 5] = [
        Self::OpenAi,
        Self::DeepSeek,
        Self::OpenRouter,
        Self::Ollama,
        Self::Custom,
    ];

    pub const fn label(self) -> &'static str {
        match self {
            Self::OpenAi => "OpenAI",
            Self::DeepSeek => "DeepSeek",
            Self::OpenRouter => "OpenRouter",
            Self::Ollama => "Ollama",
            Self::Custom => "自定义",
        }
    }

    pub const fn default_base_url(self) -> &'static str {
        match self {
            Self::OpenAi => "https://api.openai.com/v1",
            Self::DeepSeek => "https://api.deepseek.com/v1",
            Self::OpenRouter => "https://openrouter.ai/api/v1",
            Self::Ollama => "http://127.0.0.1:11434/v1",
            Self::Custom => "",
        }
    }

    pub const fn default_model(self) -> &'static str {
        match self {
            Self::OpenAi => "gpt-5.2",
            Self::DeepSeek => "deepseek-chat",
            Self::OpenRouter => "openai/gpt-5.2",
            Self::Ollama => "qwen3:8b",
            Self::Custom => "",
        }
    }

    pub const fn requires_key(self) -> bool {
        !matches!(self, Self::Ollama)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPreferences {
    pub enabled: bool,
    pub provider: AgentProvider,
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub system_prompt: String,
    pub include_document: bool,
}

impl AgentPreferences {
    pub fn select_provider(&mut self, provider: AgentProvider) {
        self.provider = provider;
        self.base_url = provider.default_base_url().to_owned();
        self.model = provider.default_model().to_owned();
    }
}

impl Default for AgentPreferences {
    fn default() -> Self {
        let provider = AgentProvider::OpenAi;
        Self {
            enabled: true,
            provider,
            base_url: provider.default_base_url().to_owned(),
            api_key: String::new(),
            model: provider.default_model().to_owned(),
            system_prompt: "你是一叶 LeafMark 内置的 Markdown 文档 Agent。回答应准确、结构清晰；当用户要求改写或生成文档时，优先输出可直接写入的 Markdown。".to_owned(),
            include_document: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DesktopPreferences {
    pub theme: ThemePalette,
    pub theme_mode: ThemeMode,
    pub font_size: u8,
    pub line_height: f32,
    pub content_width: u16,
    pub show_outline: bool,
    pub show_status_bar: bool,
    pub reduce_motion: bool,
    pub agent: AgentPreferences,
}

impl Default for DesktopPreferences {
    fn default() -> Self {
        Self {
            theme: ThemePalette::Leaf,
            theme_mode: ThemeMode::Dark,
            font_size: 16,
            line_height: 1.75,
            content_width: 860,
            show_outline: true,
            show_status_bar: true,
            reduce_motion: false,
            agent: AgentPreferences::default(),
        }
    }
}

pub fn load_preferences() -> DesktopPreferences {
    let Ok(path) = preferences_path() else {
        return DesktopPreferences::default();
    };
    let Ok(bytes) = fs::read(path) else {
        return DesktopPreferences::default();
    };
    serde_json::from_slice(&bytes).unwrap_or_default()
}

pub fn save_preferences(preferences: &DesktopPreferences) -> Result<(), String> {
    let path = preferences_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let payload = serde_json::to_vec_pretty(preferences).map_err(|error| error.to_string())?;
    AtomicFile::new(&path, AllowOverwrite)
        .write(|file| file.write_all(&payload))
        .map_err(|error| error.to_string())
}

fn preferences_path() -> Result<PathBuf, String> {
    let directories = AppDirectories::resolve_desktop().map_err(|error| error.to_string())?;
    Ok(directories.config.join("native-preferences.json"))
}
