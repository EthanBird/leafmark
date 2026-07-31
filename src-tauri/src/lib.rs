mod library;
mod system_fonts;
mod system_integration;

use atomicwrites::{AllowOverwrite, AtomicFile};
use ignore::WalkBuilder;
use library::{ArchiveEntry, ArchivedContent, DocumentArchive};
use parking_lot::Mutex;
use pulldown_cmark::{html, CodeBlockKind, CowStr, Event, Options, Parser, Tag, TagEnd};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashSet, VecDeque},
    fs,
    io::Write,
    path::{Component, Path, PathBuf},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use system_integration::{
    association_status, configure_markdown_association, markdown_paths_from_args, AssociationStatus,
};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt;
#[cfg(target_os = "android")]
use tauri_plugin_fs::FsExt;

const CACHE_DOCUMENTS: usize = 12;
const CACHE_BYTES: usize = 32 * 1024 * 1024;
const MAX_IMPORTED_DOCUMENT_BYTES: usize = 32 * 1024 * 1024;
#[cfg(target_os = "android")]
const MAX_OPENED_DOCUMENT_BYTES: usize = 32 * 1024 * 1024;
const MARKDOWN_EXTENSIONS: [&str; 2] = ["md", "markdown"];
const SETTINGS_SCHEMA_VERSION: u32 = 3;

fn default_font_family() -> String {
    "system".into()
}

fn default_theme_palette() -> String {
    "leaf".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppSettings {
    #[serde(default)]
    settings_schema_version: u32,
    workspace_path: String,
    theme: String,
    #[serde(default = "default_theme_palette")]
    theme_palette: String,
    live_editing: bool,
    autosave_delay_ms: u64,
    content_width: u32,
    #[serde(default = "default_font_family")]
    font_family: String,
    font_size: u32,
    line_height: f32,
    show_status_bar: bool,
    reduce_motion: bool,
    mermaid_enabled: bool,
    math_enabled: bool,
}

impl AppSettings {
    fn defaults(workspace: &Path) -> Self {
        Self {
            settings_schema_version: SETTINGS_SCHEMA_VERSION,
            workspace_path: workspace.to_string_lossy().into_owned(),
            theme: "system".into(),
            theme_palette: default_theme_palette(),
            live_editing: true,
            autosave_delay_ms: 600,
            content_width: 860,
            font_family: default_font_family(),
            font_size: 16,
            line_height: 1.75,
            show_status_bar: true,
            reduce_motion: false,
            mermaid_enabled: true,
            math_enabled: true,
        }
    }

    fn normalize(mut self) -> Self {
        if self.settings_schema_version < 2 {
            self.live_editing = true;
        }
        if self.settings_schema_version < 3 {
            self.theme_palette = default_theme_palette();
        }
        if self.settings_schema_version < SETTINGS_SCHEMA_VERSION {
            self.settings_schema_version = SETTINGS_SCHEMA_VERSION;
        }
        if !matches!(self.theme.as_str(), "system" | "light" | "dark") {
            self.theme = "system".into();
        }
        if !matches!(
            self.theme_palette.as_str(),
            "leaf" | "sakura" | "qingchuan" | "amber" | "wisteria"
        ) {
            self.theme_palette = default_theme_palette();
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
        self
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DocumentEntry {
    path: String,
    name: String,
    kind: &'static str,
    depth: usize,
    size: u64,
    modified_ms: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportDirectoryResult {
    root_path: String,
    files: Vec<String>,
    directories: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LoadedDocument {
    path: String,
    origin: &'static str,
    archive_id: String,
    source_path: String,
    source_exists: bool,
    content: String,
    html: String,
    size: u64,
    modified_ms: u64,
    cached: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BootstrapPayload {
    settings: AppSettings,
    entries: Vec<DocumentEntry>,
    library: Vec<ArchiveEntry>,
    initial_document: Option<LoadedDocument>,
    pending_open_paths: Vec<String>,
    association_status: AssociationStatus,
}

#[derive(Clone)]
struct CachedDocument {
    relative_path: String,
    content: String,
    html: String,
    size: u64,
    modified_ms: u64,
}

#[derive(Default)]
struct RenderCache {
    documents: VecDeque<CachedDocument>,
    total_bytes: usize,
}

impl RenderCache {
    fn get(&mut self, path: &str, size: u64, modified_ms: u64) -> Option<CachedDocument> {
        let position = self.documents.iter().position(|item| {
            item.relative_path == path && item.size == size && item.modified_ms == modified_ms
        })?;
        let item = self.documents.remove(position)?;
        let result = item.clone();
        self.documents.push_front(item);
        Some(result)
    }

    fn insert(&mut self, document: CachedDocument) {
        self.invalidate(&document.relative_path);
        self.total_bytes += document.content.len() + document.html.len();
        self.documents.push_front(document);
        while self.documents.len() > CACHE_DOCUMENTS || self.total_bytes > CACHE_BYTES {
            if let Some(removed) = self.documents.pop_back() {
                self.total_bytes = self
                    .total_bytes
                    .saturating_sub(removed.content.len() + removed.html.len());
            } else {
                break;
            }
        }
    }

    fn invalidate(&mut self, path: &str) {
        let mut retained = VecDeque::new();
        while let Some(item) = self.documents.pop_front() {
            if item.relative_path == path || item.relative_path.starts_with(&format!("{path}/")) {
                self.total_bytes = self
                    .total_bytes
                    .saturating_sub(item.content.len() + item.html.len());
            } else {
                retained.push_back(item);
            }
        }
        self.documents = retained;
    }

    fn clear(&mut self) {
        self.documents.clear();
        self.total_bytes = 0;
    }
}

struct InnerState {
    settings: AppSettings,
    settings_path: PathBuf,
    workspace: PathBuf,
    cache: RenderCache,
    library: DocumentArchive,
    pending_open_paths: Vec<String>,
}

struct AppState(Mutex<InnerState>);

#[tauri::command]
fn bootstrap(state: State<'_, AppState>) -> Result<BootstrapPayload, String> {
    let mut inner = state.0.lock();
    let workspace = inner.workspace.clone();
    let mut pending_open_paths = std::mem::take(&mut inner.pending_open_paths);
    let initial_path = pending_open_paths.last().cloned();
    let initial_document = initial_path
        .as_deref()
        .and_then(|path| load_external_document(path, &mut inner).ok());
    if initial_document.is_some() {
        pending_open_paths.clear();
    }
    let library = inner.library.entries()?;
    Ok(BootstrapPayload {
        settings: inner.settings.clone(),
        entries: scan_entries(&workspace)?,
        library,
        initial_document,
        pending_open_paths,
        association_status: association_status(),
    })
}

#[tauri::command]
fn list_entries(state: State<'_, AppState>) -> Result<Vec<DocumentEntry>, String> {
    let workspace = state.0.lock().workspace.clone();
    scan_entries(&workspace)
}

#[tauri::command]
fn read_document(
    relative_path: String,
    state: State<'_, AppState>,
) -> Result<LoadedDocument, String> {
    let relative = validate_markdown_path(&relative_path)?;
    let mut inner = state.0.lock();
    let target = secure_existing_path(&inner.workspace, &relative)?;
    let metadata = fs::metadata(&target).map_err(error_string)?;
    if !metadata.is_file() {
        return Err("目标不是文件".into());
    }
    let size = metadata.len();
    let modified_ms = modified_ms(&metadata);
    let normalized = path_to_slash(&relative);

    if let Some(cached) = inner.cache.get(&normalized, size, modified_ms) {
        let archive = inner
            .library
            .record(&target, &cached.content, size, modified_ms, true)?;
        return Ok(LoadedDocument {
            path: normalized,
            origin: "workspace",
            archive_id: archive.id,
            source_path: archive.source_path,
            source_exists: true,
            content: cached.content,
            html: cached.html,
            size,
            modified_ms,
            cached: true,
        });
    }

    let bytes = fs::read(&target).map_err(error_string)?;
    let content = decode_text(&bytes);
    let rendered = render_markdown_impl(&content);
    let archive = inner
        .library
        .record(&target, &content, size, modified_ms, true)?;
    inner.cache.insert(CachedDocument {
        relative_path: normalized.clone(),
        content: content.clone(),
        html: rendered.clone(),
        size,
        modified_ms,
    });
    Ok(LoadedDocument {
        path: normalized,
        origin: "workspace",
        archive_id: archive.id,
        source_path: archive.source_path,
        source_exists: true,
        content,
        html: rendered,
        size,
        modified_ms,
        cached: false,
    })
}

#[tauri::command]
fn open_external_document(
    path: String,
    state: State<'_, AppState>,
) -> Result<LoadedDocument, String> {
    let mut inner = state.0.lock();
    load_external_document(&path, &mut inner)
}

fn load_external_document(path: &str, inner: &mut InnerState) -> Result<LoadedDocument, String> {
    let requested = PathBuf::from(path);
    if !requested.is_absolute() {
        return Err("外部文档必须使用绝对路径".into());
    }
    ensure_markdown_extension(&requested)?;
    let archived = inner.library.open_source(&requested)?;
    Ok(loaded_from_archive(archived))
}

#[tauri::command]
fn open_archived_document(
    id: String,
    state: State<'_, AppState>,
) -> Result<LoadedDocument, String> {
    let mut inner = state.0.lock();
    let archived = inner.library.open(&id)?;
    Ok(loaded_from_archive(archived))
}

#[tauri::command]
fn list_archive_entries(state: State<'_, AppState>) -> Result<Vec<ArchiveEntry>, String> {
    state.0.lock().library.entries()
}

#[tauri::command]
fn write_archived_document(
    id: String,
    content: String,
    state: State<'_, AppState>,
) -> Result<ArchiveEntry, String> {
    let mut inner = state.0.lock();
    inner.library.write(&id, &content)
}

#[tauri::command]
fn save_archived_to_workspace(
    id: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let mut inner = state.0.lock();
    let archived = inner.library.open(&id)?;
    let source = PathBuf::from(&archived.entry.source_path);
    if let Ok(relative) = source.strip_prefix(&inner.workspace) {
        if let Some(parent) = source.parent() {
            fs::create_dir_all(parent).map_err(error_string)?;
        }
        atomic_write(&source, archived.content.as_bytes())?;
        let metadata = fs::metadata(&source).map_err(error_string)?;
        inner.library.record(
            &source,
            &archived.content,
            metadata.len(),
            modified_ms(&metadata),
            true,
        )?;
        let normalized = path_to_slash(relative);
        inner.cache.invalidate(&normalized);
        return Ok(normalized);
    }

    let destination = unique_destination(
        &inner.workspace,
        Path::new(&archived.entry.name)
            .file_name()
            .unwrap_or_else(|| std::ffi::OsStr::new("保留文档.md")),
    );
    atomic_write(&destination, archived.content.as_bytes())?;
    let metadata = fs::metadata(&destination).map_err(error_string)?;
    inner.library.record(
        &destination,
        &archived.content,
        metadata.len(),
        modified_ms(&metadata),
        true,
    )?;
    let relative = destination
        .strip_prefix(&inner.workspace)
        .map_err(|_| "保存路径超出文档库".to_string())?;
    let normalized = path_to_slash(relative);
    inner.cache.invalidate(&normalized);
    Ok(normalized)
}

#[tauri::command]
fn set_document_favorite(
    id: String,
    favorite: bool,
    state: State<'_, AppState>,
) -> Result<Vec<ArchiveEntry>, String> {
    state.0.lock().library.set_favorite(&id, favorite)
}

#[tauri::command]
fn remove_archive_entry(
    id: String,
    state: State<'_, AppState>,
) -> Result<Vec<ArchiveEntry>, String> {
    state.0.lock().library.remove(&id)
}

#[tauri::command]
fn clear_document_history(state: State<'_, AppState>) -> Result<Vec<ArchiveEntry>, String> {
    state.0.lock().library.clear_history()
}

#[tauri::command]
fn export_archived_document(
    id: String,
    target_path: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let archived = state.0.lock().library.open(&id)?;
    write_export_target(&app, &target_path, archived.content.as_bytes())
}

#[tauri::command]
fn reveal_workspace_entry(
    relative_path: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let inner = state.0.lock();
    let target = if relative_path.trim().is_empty() {
        inner.workspace.clone()
    } else {
        let relative = validate_relative(&relative_path)?;
        secure_existing_path(&inner.workspace, &relative)?
    };
    drop(inner);
    app.opener()
        .reveal_item_in_dir(target)
        .map_err(error_string)
}

#[tauri::command]
fn reveal_archived_document(
    id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let target = state.0.lock().library.reveal_path(&id)?;
    app.opener()
        .reveal_item_in_dir(target)
        .map_err(error_string)
}

#[tauri::command]
fn get_markdown_association_status() -> AssociationStatus {
    association_status()
}

#[tauri::command]
fn request_default_markdown_association() -> Result<AssociationStatus, String> {
    configure_markdown_association()
}

#[tauri::command]
async fn list_system_fonts() -> Vec<String> {
    tauri::async_runtime::spawn_blocking(system_fonts::system_font_families)
        .await
        .unwrap_or_default()
}

#[tauri::command]
async fn load_export_font(
    preferred_family: String,
    contains_cjk: bool,
) -> Result<tauri::ipc::Response, String> {
    let payload = tauri::async_runtime::spawn_blocking(move || {
        system_fonts::export_font_payload(&preferred_family, contains_cjk)
    })
    .await
    .map_err(error_string)??;
    Ok(tauri::ipc::Response::new(payload))
}

#[tauri::command]
fn render_markdown(source: String) -> String {
    render_markdown_impl(&source)
}

#[tauri::command]
fn write_document(
    relative_path: String,
    content: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let relative = validate_markdown_path(&relative_path)?;
    let mut inner = state.0.lock();
    let target = secure_target_path(&inner.workspace, &relative)?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(error_string)?;
    }
    atomic_write(&target, content.as_bytes())?;
    inner.cache.invalidate(&path_to_slash(&relative));
    let metadata = fs::metadata(&target).map_err(error_string)?;
    let size = metadata.len();
    let modified = modified_ms(&metadata);
    inner
        .library
        .record(&target, &content, size, modified, false)?;
    Ok(())
}

#[tauri::command]
fn create_entry(
    relative_path: String,
    kind: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let relative = validate_relative(&relative_path)?;
    if kind == "file" {
        ensure_markdown_extension(&relative)?;
    } else if kind != "directory" {
        return Err("不支持的条目类型".into());
    }
    let workspace = state.0.lock().workspace.clone();
    let target = secure_target_path(&workspace, &relative)?;
    if target.exists() {
        return Err("同名文件或文件夹已存在".into());
    }
    if kind == "directory" {
        fs::create_dir_all(&target).map_err(error_string)?;
    } else {
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(error_string)?;
        }
        atomic_write(&target, b"")?;
    }
    Ok(())
}

#[tauri::command]
fn rename_entry(
    relative_path: String,
    target_path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let source_relative = validate_relative(&relative_path)?;
    let target_relative = validate_relative(&target_path)?;
    let mut inner = state.0.lock();
    let source = secure_existing_path(&inner.workspace, &source_relative)?;
    let metadata = fs::metadata(&source).map_err(error_string)?;
    if metadata.is_file() {
        ensure_markdown_extension(&source_relative)?;
        ensure_markdown_extension(&target_relative)?;
    }
    let target = secure_target_path(&inner.workspace, &target_relative)?;
    if target.exists() {
        return Err("目标名称已存在".into());
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(error_string)?;
    }
    let previous_root = source.clone();
    fs::rename(&source, &target).map_err(error_string)?;
    inner.library.rename_sources(&previous_root, &target)?;
    inner.cache.invalidate(&path_to_slash(&source_relative));
    Ok(())
}

#[tauri::command]
fn delete_entry(relative_path: String, state: State<'_, AppState>) -> Result<(), String> {
    let relative = validate_relative(&relative_path)?;
    let mut inner = state.0.lock();
    let target = secure_existing_path(&inner.workspace, &relative)?;
    let metadata = fs::metadata(&target).map_err(error_string)?;
    if metadata.is_dir() {
        fs::remove_dir_all(&target).map_err(error_string)?;
    } else {
        fs::remove_file(&target).map_err(error_string)?;
    }
    inner.library.mark_missing_under(&target)?;
    inner.cache.invalidate(&path_to_slash(&relative));
    Ok(())
}

#[tauri::command]
fn import_files(
    source_paths: Vec<String>,
    target_directory: String,
    _app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    let directory = if target_directory.trim().is_empty() {
        PathBuf::new()
    } else {
        validate_relative(&target_directory)?
    };
    let mut inner = state.0.lock();
    let destination_root = secure_target_path(&inner.workspace, &directory)?;
    fs::create_dir_all(&destination_root).map_err(error_string)?;
    let mut imported = Vec::new();

    for source_value in source_paths {
        #[cfg(target_os = "android")]
        if let Ok(url) = tauri::Url::parse(&source_value) {
            if url.scheme() == "content" {
                let bytes = _app
                    .fs()
                    .read(tauri_plugin_fs::FilePath::Url(url.clone()))
                    .map_err(|error| format!("无法读取 Android 文档：{error}"))?;
                if bytes.len() > MAX_OPENED_DOCUMENT_BYTES {
                    return Err("Markdown 文档超过 32 MB，已拒绝导入".into());
                }
                let name = opened_url_filename(&url);
                let destination =
                    unique_destination(&destination_root, std::ffi::OsStr::new(&name));
                atomic_write(&destination, &bytes)?;
                let relative = destination
                    .strip_prefix(&inner.workspace)
                    .map_err(|_| "导入路径超出文档库".to_string())?;
                let normalized = path_to_slash(relative);
                inner.cache.invalidate(&normalized);
                imported.push(normalized);
                continue;
            }
        }

        let source = PathBuf::from(&source_value);
        ensure_markdown_extension(&source)?;
        if !source.is_file() {
            continue;
        }
        let name = source
            .file_name()
            .ok_or_else(|| "导入文件缺少名称".to_string())?;
        let destination = unique_destination(&destination_root, name);
        fs::copy(&source, &destination).map_err(error_string)?;
        let relative = destination
            .strip_prefix(&inner.workspace)
            .map_err(|_| "导入路径超出文档库".to_string())?;
        let normalized = path_to_slash(relative);
        inner.cache.invalidate(&normalized);
        imported.push(normalized);
    }
    Ok(imported)
}

#[tauri::command]
fn import_directory(
    source_path: String,
    target_directory: String,
    state: State<'_, AppState>,
) -> Result<ImportDirectoryResult, String> {
    let directory = if target_directory.trim().is_empty() {
        PathBuf::new()
    } else {
        validate_relative(&target_directory)?
    };
    let mut inner = state.0.lock();
    let destination_root = secure_target_path(&inner.workspace, &directory)?;
    fs::create_dir_all(&destination_root).map_err(error_string)?;
    let result = copy_markdown_directory(
        Path::new(&source_path),
        &destination_root,
        &inner.workspace,
    )?;
    for path in &result.files {
        inner.cache.invalidate(path);
    }
    Ok(result)
}

#[tauri::command]
fn export_file(
    relative_path: String,
    target_path: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let relative = validate_markdown_path(&relative_path)?;
    let workspace = state.0.lock().workspace.clone();
    let source = secure_existing_path(&workspace, &relative)?;
    let bytes = fs::read(source).map_err(error_string)?;
    write_export_target(&app, &target_path, &bytes)
}

#[tauri::command]
fn write_export(request: tauri::ipc::Request, app: AppHandle) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("导出数据必须使用二进制传输".into());
    };
    let encoded_target = request
        .headers()
        .get("LeafMark-Target")
        .ok_or_else(|| "导出目标路径缺失".to_string())?
        .to_str()
        .map_err(error_string)?;
    let target_path = percent_encoding::percent_decode_str(encoded_target)
        .decode_utf8()
        .map_err(error_string)?;
    write_export_target(&app, &target_path, bytes)
}

#[tauri::command]
fn set_workspace(path: String, state: State<'_, AppState>) -> Result<BootstrapPayload, String> {
    let requested = PathBuf::from(path);
    if !requested.is_absolute() {
        return Err("文档库必须使用绝对路径".into());
    }
    fs::create_dir_all(&requested).map_err(error_string)?;
    let workspace = requested.canonicalize().map_err(error_string)?;
    if !workspace.is_dir() {
        return Err("文档库路径不是文件夹".into());
    }
    let mut inner = state.0.lock();
    inner.workspace = workspace.clone();
    inner.settings.workspace_path = workspace.to_string_lossy().into_owned();
    inner.cache.clear();
    persist_settings(&inner.settings_path, &inner.settings)?;
    let library = inner.library.entries()?;
    Ok(BootstrapPayload {
        settings: inner.settings.clone(),
        entries: scan_entries(&workspace)?,
        library,
        initial_document: None,
        pending_open_paths: Vec::new(),
        association_status: association_status(),
    })
}

#[tauri::command]
fn save_settings(settings: AppSettings, state: State<'_, AppState>) -> Result<AppSettings, String> {
    let mut inner = state.0.lock();
    let workspace_path = inner.settings.workspace_path.clone();
    let mut normalized = settings.normalize();
    normalized.workspace_path = workspace_path;
    persist_settings(&inner.settings_path, &normalized)?;
    inner.settings = normalized.clone();
    Ok(normalized)
}

fn loaded_from_archive(archived: ArchivedContent) -> LoadedDocument {
    let html = render_markdown_impl(&archived.content);
    LoadedDocument {
        path: archived.entry.source_path.clone(),
        origin: "archive",
        archive_id: archived.entry.id,
        source_path: archived.entry.source_path,
        source_exists: archived.entry.source_exists,
        size: archived.entry.size,
        modified_ms: archived.entry.modified_ms,
        content: archived.content,
        html,
        cached: false,
    }
}

fn render_markdown_impl(source: &str) -> String {
    let options = Options::ENABLE_TABLES
        | Options::ENABLE_FOOTNOTES
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_TASKLISTS
        | Options::ENABLE_SMART_PUNCTUATION
        | Options::ENABLE_HEADING_ATTRIBUTES
        | Options::ENABLE_MATH
        | Options::ENABLE_GFM;
    let parser = Parser::new_ext(source, options);
    let mut events = Vec::new();
    let mut special: Option<(SpecialBlock, String)> = None;

    for event in parser {
        if let Some((_, body)) = special.as_mut() {
            match event {
                Event::End(TagEnd::CodeBlock) => {
                    let (kind, body) = special.take().expect("special block exists");
                    events.push(Event::Html(CowStr::Boxed(
                        render_special_block(kind, &body).into_boxed_str(),
                    )));
                }
                Event::Text(value) | Event::Code(value) => body.push_str(&value),
                Event::SoftBreak | Event::HardBreak => body.push('\n'),
                _ => {}
            }
            continue;
        }

        match event {
            Event::Start(Tag::CodeBlock(CodeBlockKind::Fenced(language))) => {
                let language = language.trim().to_ascii_lowercase();
                let kind = match language.as_str() {
                    "mermaid" => Some(SpecialBlock::Mermaid),
                    "math" | "tex" | "latex" => Some(SpecialBlock::Math),
                    _ => None,
                };
                if let Some(kind) = kind {
                    special = Some((kind, String::new()));
                } else {
                    events.push(Event::Start(Tag::CodeBlock(CodeBlockKind::Fenced(
                        CowStr::Boxed(language.into_boxed_str()),
                    ))));
                }
            }
            Event::InlineMath(value) => events.push(Event::Html(CowStr::Boxed(
                render_math(&value, false).into_boxed_str(),
            ))),
            Event::DisplayMath(value) => events.push(Event::Html(CowStr::Boxed(
                render_math(&value, true).into_boxed_str(),
            ))),
            Event::Html(value) | Event::InlineHtml(value) => events.push(Event::Text(value)),
            other => events.push(other),
        }
    }
    if let Some((kind, body)) = special.take() {
        events.push(Event::Html(CowStr::Boxed(
            render_special_block(kind, &body).into_boxed_str(),
        )));
    }
    let mut output = String::with_capacity(source.len().saturating_mul(2));
    html::push_html(&mut output, events.into_iter());
    output
}

enum SpecialBlock {
    Mermaid,
    Math,
}

fn render_special_block(kind: SpecialBlock, source: &str) -> String {
    match kind {
        SpecialBlock::Mermaid => format!(
            "<pre class=\"diagram-source\" data-mermaid-source=\"{}\"><code>{}</code></pre>\n",
            escape_attribute(source),
            escape_html(source)
        ),
        SpecialBlock::Math => render_math(source, true),
    }
}

fn render_math(source: &str, display: bool) -> String {
    if display {
        format!(
            "<div class=\"math-source math-display\" data-math-source=\"{}\"></div>",
            escape_attribute(source.trim())
        )
    } else {
        format!(
            "<span class=\"math-source\" data-math-source=\"{}\"></span>",
            escape_attribute(source.trim())
        )
    }
}

fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn escape_attribute(value: &str) -> String {
    escape_html(value)
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
        .replace('\r', "&#13;")
        .replace('\n', "&#10;")
}

fn scan_entries(root: &Path) -> Result<Vec<DocumentEntry>, String> {
    let mut builder = WalkBuilder::new(root);
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

    let mut files = Vec::new();
    let mut directories = HashSet::new();
    for result in builder.build() {
        let entry = result.map_err(error_string)?;
        let Some(kind) = entry.file_type() else {
            continue;
        };
        let path = entry.path();
        if kind.is_dir() {
            if entry.depth() > 0 {
                let relative = path
                    .strip_prefix(root)
                    .map_err(|_| "扫描结果超出文档库".to_string())?;
                directories.insert(relative.to_path_buf());
            }
            continue;
        }
        if !kind.is_file() {
            continue;
        }
        if !is_markdown(path) {
            continue;
        }
        let relative = path
            .strip_prefix(root)
            .map_err(|_| "扫描结果超出文档库".to_string())?;
        let mut parent = relative.parent();
        while let Some(directory) = parent {
            if directory.as_os_str().is_empty() {
                break;
            }
            directories.insert(directory.to_path_buf());
            parent = directory.parent();
        }
        let metadata = entry.metadata().map_err(error_string)?;
        files.push(DocumentEntry {
            path: path_to_slash(relative),
            name: relative
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
            kind: "file",
            depth: relative.components().count().saturating_sub(1),
            size: metadata.len(),
            modified_ms: modified_ms(&metadata),
        });
    }

    let mut entries: Vec<DocumentEntry> = directories
        .into_iter()
        .map(|relative| {
            let metadata = fs::metadata(root.join(&relative)).ok();
            DocumentEntry {
                path: path_to_slash(&relative),
                name: relative
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned(),
                kind: "directory",
                depth: relative.components().count().saturating_sub(1),
                size: 0,
                modified_ms: metadata.as_ref().map_or(0, modified_ms),
            }
        })
        .collect();
    entries.extend(files);
    entries.sort_by(|left, right| {
        let left_parent = parent_slash(&left.path);
        let right_parent = parent_slash(&right.path);
        left_parent
            .to_ascii_lowercase()
            .cmp(&right_parent.to_ascii_lowercase())
            .then_with(|| left.kind.cmp(right.kind))
            .then_with(|| {
                left.name
                    .to_ascii_lowercase()
                    .cmp(&right.name.to_ascii_lowercase())
            })
    });
    Ok(entries)
}

fn copy_markdown_directory(
    source: &Path,
    destination_parent: &Path,
    workspace: &Path,
) -> Result<ImportDirectoryResult, String> {
    let source = source.canonicalize().map_err(error_string)?;
    if !source.is_dir() {
        return Err("请选择一个有效文件夹".into());
    }
    let workspace = workspace.canonicalize().map_err(error_string)?;
    let destination_parent = destination_parent.canonicalize().map_err(error_string)?;
    if !destination_parent.starts_with(&workspace) {
        return Err("导入目标超出文档库".into());
    }
    let original_name = source
        .file_name()
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| std::ffi::OsStr::new("导入文件夹"));
    let destination = unique_directory_destination(&destination_parent, original_name);
    if destination.starts_with(&source) {
        return Err("不能把文件夹导入到它自身或其子目录".into());
    }
    let staging = destination_parent.join(format!(
        ".leafmark-import-{}-{}",
        std::process::id(),
        now_ms()
    ));
    fs::create_dir(&staging).map_err(error_string)?;

    let copied = (|| -> Result<(Vec<PathBuf>, usize), String> {
        let mut builder = WalkBuilder::new(&source);
        builder
            .hidden(false)
            .parents(false)
            .ignore(false)
            .git_ignore(false)
            .git_global(false)
            .git_exclude(false)
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
        let mut files = Vec::new();
        let mut directories = 1;
        for result in builder.build() {
            let entry = result.map_err(error_string)?;
            if entry.depth() == 0 {
                continue;
            }
            let relative = entry
                .path()
                .strip_prefix(&source)
                .map_err(|_| "导入路径超出源文件夹".to_string())?;
            let Some(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() {
                fs::create_dir_all(staging.join(relative)).map_err(error_string)?;
                directories += 1;
                continue;
            }
            if !kind.is_file() || !is_markdown(entry.path()) {
                continue;
            }
            let metadata = entry.metadata().map_err(error_string)?;
            if metadata.len() > MAX_IMPORTED_DOCUMENT_BYTES as u64 {
                return Err(format!(
                    "Markdown 文档超过 32 MB：{}",
                    entry.path().display()
                ));
            }
            let bytes = fs::read(entry.path()).map_err(error_string)?;
            let target = staging.join(relative);
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(error_string)?;
            }
            atomic_write(&target, &bytes)?;
            files.push(relative.to_path_buf());
        }
        Ok((files, directories))
    })();

    let (relative_files, directories) = match copied {
        Ok(result) => result,
        Err(error) => {
            let _ = fs::remove_dir_all(&staging);
            return Err(error);
        }
    };
    if let Err(error) = fs::rename(&staging, &destination) {
        let _ = fs::remove_dir_all(&staging);
        return Err(error_string(error));
    }

    let root_relative = destination
        .strip_prefix(&workspace)
        .map_err(|_| "导入目标超出文档库".to_string())?;
    let files = relative_files
        .into_iter()
        .map(|relative| path_to_slash(&root_relative.join(relative)))
        .collect();
    Ok(ImportDirectoryResult {
        root_path: path_to_slash(root_relative),
        files,
        directories,
    })
}

fn validate_relative(value: &str) -> Result<PathBuf, String> {
    let normalized = value.trim().replace('\\', "/");
    if normalized.is_empty() {
        return Err("路径不能为空".into());
    }
    let path = Path::new(&normalized);
    if path.is_absolute() {
        return Err("只允许文档库内的相对路径".into());
    }
    let mut clean = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => clean.push(part),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err("路径不能离开文档库".into())
            }
        }
    }
    if clean.as_os_str().is_empty() {
        return Err("路径不能为空".into());
    }
    Ok(clean)
}

fn validate_markdown_path(value: &str) -> Result<PathBuf, String> {
    let path = validate_relative(value)?;
    ensure_markdown_extension(&path)?;
    Ok(path)
}

fn ensure_markdown_extension(path: &Path) -> Result<(), String> {
    if is_markdown(path) {
        Ok(())
    } else {
        Err("仅支持 .md 与 .markdown 文档".into())
    }
}

fn is_markdown(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .is_some_and(|extension| {
            MARKDOWN_EXTENSIONS.contains(&extension.to_ascii_lowercase().as_str())
        })
}

fn secure_existing_path(root: &Path, relative: &Path) -> Result<PathBuf, String> {
    let root = root.canonicalize().map_err(error_string)?;
    let target = root.join(relative).canonicalize().map_err(error_string)?;
    if !target.starts_with(&root) {
        return Err("路径超出文档库".into());
    }
    Ok(target)
}

fn secure_target_path(root: &Path, relative: &Path) -> Result<PathBuf, String> {
    let root = root.canonicalize().map_err(error_string)?;
    let target = root.join(relative);
    let mut existing = target.as_path();
    while !existing.exists() {
        existing = existing
            .parent()
            .ok_or_else(|| "无效目标路径".to_string())?;
    }
    let existing = existing.canonicalize().map_err(error_string)?;
    if !existing.starts_with(&root) {
        return Err("路径超出文档库".into());
    }
    Ok(target)
}

pub(crate) fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    const RETRY_DELAYS_MS: [u64; 5] = [0, 25, 75, 160, 320];
    let mut last_error = String::new();
    for delay in RETRY_DELAYS_MS {
        if delay > 0 {
            thread::sleep(Duration::from_millis(delay));
        }
        match AtomicFile::new(path, AllowOverwrite).write(|file| file.write_all(bytes)) {
            Ok(()) => return Ok(()),
            Err(error) => last_error = error_string(error),
        }
    }
    Err(format!(
        "安全写入多次重试后仍失败：{last_error}。请检查文件是否被其他程序占用"
    ))
}

fn persist_settings(path: &Path, settings: &AppSettings) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(settings).map_err(error_string)?;
    atomic_write(path, &bytes)
}

fn decode_text(bytes: &[u8]) -> String {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return String::from_utf8_lossy(&bytes[3..]).into_owned();
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

fn unique_destination(directory: &Path, original: &std::ffi::OsStr) -> PathBuf {
    let original_path = Path::new(original);
    let stem = original_path
        .file_stem()
        .unwrap_or(original)
        .to_string_lossy();
    let extension = original_path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("md");
    let direct = directory.join(original);
    if !direct.exists() {
        return direct;
    }
    for index in 1..10_000 {
        let candidate = directory.join(format!("{stem} ({index}).{extension}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    directory.join(format!("{stem}-{}.{}", now_ms(), extension))
}

fn unique_directory_destination(directory: &Path, original: &std::ffi::OsStr) -> PathBuf {
    let direct = directory.join(original);
    if !direct.exists() {
        return direct;
    }
    let name = original.to_string_lossy();
    for index in 1..10_000 {
        let candidate = directory.join(format!("{name} ({index})"));
        if !candidate.exists() {
            return candidate;
        }
    }
    directory.join(format!("{name}-{}", now_ms()))
}

fn modified_ms(metadata: &fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |value| value.as_millis() as u64)
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |value| value.as_millis())
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

fn error_string(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(any(target_os = "android", test))]
fn opened_url_filename(url: &tauri::Url) -> String {
    let encoded = url
        .path_segments()
        .and_then(|segments| segments.last())
        .unwrap_or_default();
    let decoded = percent_encoding::percent_decode_str(encoded)
        .decode_utf8_lossy()
        .into_owned();
    let source_name = decoded
        .rsplit(['/', '\\', ':'])
        .find(|part| !part.trim().is_empty())
        .unwrap_or_default()
        .trim();
    let mut safe_name: String = source_name
        .chars()
        .filter(|character| {
            !character.is_control()
                && !matches!(
                    character,
                    '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'
                )
        })
        .take(120)
        .collect();
    if safe_name.is_empty() || !is_markdown(Path::new(&safe_name)) {
        safe_name = format!("打开的文档-{}.md", now_ms());
    }
    safe_name
}

#[cfg(any(target_os = "macos", target_os = "ios", target_os = "android"))]
fn local_path_from_opened_url(_app: &AppHandle, url: &tauri::Url) -> Result<PathBuf, String> {
    if url.scheme() == "file" {
        let path = url
            .to_file_path()
            .map_err(|_| "无法解析系统传入的文件路径".to_string())?;
        ensure_markdown_extension(&path)?;
        if !path.is_file() {
            return Err("系统传入的 Markdown 文档不存在".into());
        }
        return path.canonicalize().map_err(error_string);
    }

    #[cfg(target_os = "android")]
    if url.scheme() == "content" {
        let bytes = _app
            .fs()
            .read(tauri_plugin_fs::FilePath::Url(url.clone()))
            .map_err(|error| format!("无法读取 Android 文档：{error}"))?;
        if bytes.len() > MAX_OPENED_DOCUMENT_BYTES {
            return Err("Markdown 文档超过 32 MB，已拒绝导入".into());
        }
        let incoming_dir = _app
            .path()
            .app_data_dir()
            .map_err(error_string)?
            .join("opened-documents");
        fs::create_dir_all(&incoming_dir).map_err(error_string)?;
        let name = opened_url_filename(url);
        let destination = unique_destination(&incoming_dir, std::ffi::OsStr::new(&name));
        atomic_write(&destination, &bytes)?;
        return destination.canonicalize().map_err(error_string);
    }

    Err(format!("不支持的文档地址：{}", url.scheme()))
}

fn write_export_target(app: &AppHandle, target: &str, bytes: &[u8]) -> Result<(), String> {
    #[cfg(target_os = "android")]
    if let Ok(url) = tauri::Url::parse(target) {
        if url.scheme() == "content" {
            let mut options = tauri_plugin_fs::OpenOptions::new();
            options.write(true).truncate(true);
            let mut file = app
                .fs()
                .open(tauri_plugin_fs::FilePath::Url(url), options)
                .map_err(|error| format!("无法写入 Android 文档：{error}"))?;
            return file.write_all(bytes).map_err(error_string);
        }
    }
    let _ = app;
    atomic_write(Path::new(target), bytes)
}

#[cfg(any(target_os = "macos", target_os = "ios", target_os = "android"))]
fn queue_opened_url(app: &AppHandle, url: &tauri::Url) {
    match local_path_from_opened_url(app, url) {
        Ok(path) => {
            let path = path.to_string_lossy().into_owned();
            if let Some(state) = app.try_state::<AppState>() {
                let mut inner = state.0.lock();
                if !inner.pending_open_paths.contains(&path) {
                    inner.pending_open_paths.push(path.clone());
                }
            }
            let _ = app.emit("open-markdown", path);
        }
        Err(error) => {
            let _ = app.emit("open-markdown-error", error);
        }
    }
}

#[cfg(target_os = "android")]
fn default_workspace(app: &AppHandle, _config_dir: &Path) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(error_string)?
        .join("workspace"))
}

#[cfg(not(target_os = "android"))]
fn default_workspace(app: &AppHandle, config_dir: &Path) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .document_dir()
        .unwrap_or_else(|_| config_dir.to_path_buf())
        .join("LeafMark"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
        let paths = markdown_paths_from_args(args, Path::new(&cwd));
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
        for path in paths {
            let _ = app.emit("open-markdown", path);
        }
    }));
    let app = builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let config_dir = app.path().app_config_dir().map_err(error_string)?;
            fs::create_dir_all(&config_dir).map_err(error_string)?;
            let settings_path = config_dir.join("settings.json");
            let default_workspace = default_workspace(app.handle(), &config_dir)?;
            fs::create_dir_all(&default_workspace).map_err(error_string)?;

            let mut settings = fs::read(&settings_path)
                .ok()
                .and_then(|bytes| serde_json::from_slice::<AppSettings>(&bytes).ok())
                .unwrap_or_else(|| AppSettings::defaults(&default_workspace))
                .normalize();
            let configured_workspace = PathBuf::from(&settings.workspace_path);
            let workspace = if configured_workspace.is_absolute()
                && fs::create_dir_all(&configured_workspace).is_ok()
            {
                configured_workspace
                    .canonicalize()
                    .unwrap_or(default_workspace.clone())
            } else {
                default_workspace.canonicalize().map_err(error_string)?
            };
            settings.workspace_path = workspace.to_string_lossy().into_owned();
            persist_settings(&settings_path, &settings)?;
            let archive_root = app
                .path()
                .app_data_dir()
                .map_err(error_string)?
                .join("document-library");
            let library = DocumentArchive::load(archive_root)?;
            let cwd = std::env::current_dir().unwrap_or_else(|_| workspace.clone());
            let pending_open_paths = markdown_paths_from_args(std::env::args_os(), &cwd);
            app.manage(AppState(Mutex::new(InnerState {
                settings,
                settings_path,
                workspace,
                cache: RenderCache::default(),
                library,
                pending_open_paths,
            })));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            bootstrap,
            list_entries,
            read_document,
            open_external_document,
            open_archived_document,
            list_archive_entries,
            write_archived_document,
            save_archived_to_workspace,
            set_document_favorite,
            remove_archive_entry,
            clear_document_history,
            export_archived_document,
            reveal_workspace_entry,
            reveal_archived_document,
            get_markdown_association_status,
            request_default_markdown_association,
            list_system_fonts,
            load_export_font,
            render_markdown,
            write_document,
            create_entry,
            rename_entry,
            delete_entry,
            import_files,
            import_directory,
            export_file,
            write_export,
            set_workspace,
            save_settings,
        ])
        .build(tauri::generate_context!())
        .expect("failed to build LeafMark");

    app.run(|_app, _event| {
        #[cfg(any(target_os = "macos", target_os = "ios", target_os = "android"))]
        if let tauri::RunEvent::Opened { urls } = _event {
            for url in urls {
                queue_opened_url(_app, &url);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_traversal_and_non_markdown_files() {
        assert!(validate_markdown_path("../secret.md").is_err());
        assert!(validate_markdown_path("guide.txt").is_err());
        assert_eq!(
            validate_markdown_path("docs/guide.md").unwrap(),
            PathBuf::from("docs/guide.md")
        );
    }

    #[test]
    fn renders_gfm_math_and_mermaid_markers() {
        let html = render_markdown_impl(
            "# Demo\n\n$E=mc^2$\n\n```mermaid\nflowchart LR\nA-->B\n```\n\n```math\nx^2\n```",
        );
        assert!(html.contains("<h1>Demo</h1>"));
        assert!(html.contains("data-math-source=\"E=mc^2\""));
        assert!(html.contains("data-mermaid-source="));
        assert!(html.contains("flowchart LR"));
        assert!(html.contains("data-math-source=\"x^2\""));
    }

    #[test]
    fn escapes_raw_html_from_documents() {
        let html = render_markdown_impl("<script>alert('no')</script>");
        assert!(!html.contains("<script>"));
        assert!(html.contains("&lt;script&gt;"));
    }

    #[test]
    fn decodes_utf_boms() {
        assert_eq!(decode_text(&[0xEF, 0xBB, 0xBF, b'o', b'k']), "ok");
        assert_eq!(decode_text(&[0xFF, 0xFE, b'o', 0, b'k', 0]), "ok");
        assert_eq!(decode_text(&[0xFE, 0xFF, 0, b'o', 0, b'k']), "ok");
    }

    #[test]
    fn creates_safe_markdown_names_for_opened_urls() {
        let url = tauri::Url::parse(
            "content://com.android.providers.downloads/document/primary%3ADownload%2Fnotes.md",
        )
        .unwrap();
        assert_eq!(opened_url_filename(&url), "notes.md");

        let opaque = tauri::Url::parse("content://provider/document/42").unwrap();
        assert!(opened_url_filename(&opaque).ends_with(".md"));
    }

    #[test]
    fn migrates_existing_settings_to_live_editing_and_system_font() {
        let legacy = serde_json::json!({
            "workspacePath": "C:\\Documents\\LeafMark",
            "theme": "system",
            "liveEditing": false,
            "autosaveDelayMs": 600,
            "contentWidth": 860,
            "fontSize": 16,
            "lineHeight": 1.75,
            "showStatusBar": true,
            "reduceMotion": false,
            "mermaidEnabled": true,
            "mathEnabled": true
        });
        let settings: AppSettings = serde_json::from_value(legacy).unwrap();
        let migrated = settings.normalize();

        assert_eq!(migrated.settings_schema_version, SETTINGS_SCHEMA_VERSION);
        assert!(migrated.live_editing);
        assert_eq!(migrated.font_family, "system");
        assert_eq!(migrated.theme_palette, "leaf");
    }

    #[test]
    fn preserves_an_explicit_v2_live_editing_choice_while_adding_the_palette() {
        let settings = AppSettings {
            settings_schema_version: 2,
            live_editing: false,
            ..AppSettings::defaults(Path::new("/tmp/leafmark"))
        };
        let migrated = settings.normalize();

        assert!(!migrated.live_editing);
        assert_eq!(migrated.theme_palette, "leaf");
        assert_eq!(migrated.settings_schema_version, SETTINGS_SCHEMA_VERSION);
    }

    #[test]
    fn scan_entries_includes_empty_directories() {
        let root = std::env::temp_dir().join(format!(
            "leafmark-empty-directory-{}-{}",
            std::process::id(),
            now_ms()
        ));
        fs::create_dir_all(root.join("空文件夹/子目录")).unwrap();
        fs::write(root.join("文档.md"), "# 文档").unwrap();

        let entries = scan_entries(&root).unwrap();

        assert!(entries
            .iter()
            .any(|entry| entry.kind == "directory" && entry.path == "空文件夹"));
        assert!(entries
            .iter()
            .any(|entry| entry.kind == "directory" && entry.path == "空文件夹/子目录"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn directory_import_preserves_structure_and_ignores_other_files() {
        let root = std::env::temp_dir().join(format!(
            "leafmark-directory-import-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let source = root.join("source/课程笔记");
        let workspace = root.join("workspace");
        fs::create_dir_all(source.join("第一章/空目录")).unwrap();
        fs::create_dir_all(&workspace).unwrap();
        fs::write(source.join("README.md"), "# 课程").unwrap();
        fs::write(source.join("第一章/推导.markdown"), "$x^2$").unwrap();
        fs::write(source.join("第一章/忽略.txt"), "not markdown").unwrap();

        let result = copy_markdown_directory(&source, &workspace, &workspace).unwrap();

        assert_eq!(result.root_path, "课程笔记");
        assert_eq!(result.files.len(), 2);
        assert!(workspace.join("课程笔记/README.md").is_file());
        assert!(workspace.join("课程笔记/第一章/推导.markdown").is_file());
        assert!(workspace.join("课程笔记/第一章/空目录").is_dir());
        assert!(!workspace.join("课程笔记/第一章/忽略.txt").exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn directory_import_uses_a_conflict_safe_root_name() {
        let root = std::env::temp_dir().join(format!(
            "leafmark-directory-conflict-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let source = root.join("source/notes");
        let workspace = root.join("workspace");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(workspace.join("notes")).unwrap();
        fs::write(source.join("one.md"), "one").unwrap();

        let result = copy_markdown_directory(&source, &workspace, &workspace).unwrap();

        assert_eq!(result.root_path, "notes (1)");
        assert!(workspace.join("notes (1)/one.md").is_file());
        let _ = fs::remove_dir_all(root);
    }
}
