use atomicwrites::{AllowOverwrite, AtomicFile};
use ignore::WalkBuilder;
use parking_lot::Mutex;
use pulldown_cmark::{html, CodeBlockKind, CowStr, Event, Options, Parser, Tag, TagEnd};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashSet, VecDeque},
    env, fs,
    hash::{DefaultHasher, Hash, Hasher},
    io::Write,
    path::{Component, Path, PathBuf},
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{Emitter, Manager, State};

const CACHE_DOCUMENTS: usize = 12;
const CACHE_BYTES: usize = 32 * 1024 * 1024;
const MARKDOWN_EXTENSIONS: [&str; 2] = ["md", "markdown"];
const OPEN_MARKDOWN_EVENT: &str = "open-markdown";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppSettings {
    workspace_path: String,
    theme: String,
    live_editing: bool,
    autosave_delay_ms: u64,
    content_width: u32,
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
            workspace_path: workspace.to_string_lossy().into_owned(),
            theme: "system".into(),
            live_editing: false,
            autosave_delay_ms: 600,
            content_width: 860,
            font_size: 16,
            line_height: 1.75,
            show_status_bar: true,
            reduce_motion: false,
            mermaid_enabled: true,
            math_enabled: true,
        }
    }

    fn normalize(mut self) -> Self {
        if !matches!(self.theme.as_str(), "system" | "light" | "dark") {
            self.theme = "system".into();
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LoadedDocument {
    path: String,
    source_path: String,
    name: String,
    content: String,
    html: String,
    size: u64,
    modified_ms: u64,
    cached: bool,
    origin: &'static str,
    record_id: String,
    source_exists: bool,
    writable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArchiveRecord {
    id: String,
    source_path: String,
    name: String,
    snapshot_path: String,
    last_opened_ms: u64,
    modified_ms: u64,
    size: u64,
    #[serde(default)]
    favorite: bool,
    #[serde(skip, default)]
    source_exists: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BootstrapPayload {
    settings: AppSettings,
    entries: Vec<DocumentEntry>,
    records: Vec<ArchiveRecord>,
    pending_open_paths: Vec<String>,
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
    archive_index_path: PathBuf,
    archive_dir: PathBuf,
    records: Vec<ArchiveRecord>,
    pending_open_paths: Vec<String>,
    workspace: PathBuf,
    cache: RenderCache,
}

struct AppState(Mutex<InnerState>);

#[tauri::command]
fn bootstrap(state: State<'_, AppState>) -> Result<BootstrapPayload, String> {
    let mut inner = state.0.lock();
    let records = records_with_source_status(&inner.records);
    let pending_open_paths = std::mem::take(&mut inner.pending_open_paths);
    Ok(BootstrapPayload {
        settings: inner.settings.clone(),
        entries: scan_entries(&inner.workspace)?,
        records,
        pending_open_paths,
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
    let normalized = path_to_slash(&relative);
    load_source_document(&mut inner, &target, normalized, "workspace", true)
}

#[tauri::command]
fn read_external_document(
    path: String,
    state: State<'_, AppState>,
) -> Result<LoadedDocument, String> {
    let requested = validate_external_markdown_path(&path)?;
    let target = requested.canonicalize().map_err(error_string)?;
    let mut inner = state.0.lock();
    load_source_document(
        &mut inner,
        &target,
        target.to_string_lossy().into_owned(),
        "external",
        false,
    )
}

#[tauri::command]
fn read_archive_document(
    record_id: String,
    state: State<'_, AppState>,
) -> Result<LoadedDocument, String> {
    let mut inner = state.0.lock();
    let record = inner
        .records
        .iter()
        .find(|record| record.id == record_id)
        .cloned()
        .ok_or_else(|| "历史记录不存在".to_string())?;
    let source = PathBuf::from(&record.source_path);

    if source.is_file() && is_markdown(&source) {
        return load_source_document(&mut inner, &source, record.source_path, "external", false);
    }

    let snapshot = archive_snapshot_path(&inner.archive_dir, &record.snapshot_path)?;
    let bytes = fs::read(&snapshot).map_err(|_| "源文件与保留副本均不存在".to_string())?;
    let content = decode_text(&bytes);
    let html = render_markdown_impl(&content);
    Ok(LoadedDocument {
        path: record.id.clone(),
        source_path: record.source_path,
        name: record.name,
        size: bytes.len() as u64,
        modified_ms: record.modified_ms,
        content,
        html,
        cached: false,
        origin: "snapshot",
        record_id: record.id,
        source_exists: false,
        writable: false,
    })
}

#[tauri::command]
fn list_archive_records(state: State<'_, AppState>) -> Vec<ArchiveRecord> {
    let inner = state.0.lock();
    records_with_source_status(&inner.records)
}

#[tauri::command]
fn set_favorite(
    record_id: String,
    favorite: bool,
    state: State<'_, AppState>,
) -> Result<Vec<ArchiveRecord>, String> {
    let mut inner = state.0.lock();
    let record = inner
        .records
        .iter_mut()
        .find(|record| record.id == record_id)
        .ok_or_else(|| "历史记录不存在".to_string())?;
    record.favorite = favorite;
    persist_archive_index(&inner.archive_index_path, &inner.records)?;
    Ok(records_with_source_status(&inner.records))
}

#[tauri::command]
fn clear_history(state: State<'_, AppState>) -> Result<Vec<ArchiveRecord>, String> {
    let mut inner = state.0.lock();
    let removed: Vec<String> = inner
        .records
        .iter()
        .filter(|record| !record.favorite)
        .map(|record| record.snapshot_path.clone())
        .collect();
    inner.records.retain(|record| record.favorite);
    persist_archive_index(&inner.archive_index_path, &inner.records)?;
    for snapshot in removed {
        if let Ok(path) = archive_snapshot_path(&inner.archive_dir, &snapshot) {
            let _ = fs::remove_file(path);
        }
    }
    Ok(records_with_source_status(&inner.records))
}

#[tauri::command]
fn render_markdown(source: String) -> String {
    render_markdown_impl(&source)
}

#[tauri::command]
fn write_document(
    origin: String,
    path: String,
    content: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut inner = state.0.lock();
    let (target, cache_key) = match origin.as_str() {
        "workspace" => {
            let relative = validate_markdown_path(&path)?;
            let target = secure_target_path(&inner.workspace, &relative)?;
            (target, Some(path_to_slash(&relative)))
        }
        "external" => {
            let requested = validate_external_markdown_path(&path)?;
            let canonical = requested.canonicalize().map_err(error_string)?;
            (canonical, None)
        }
        "snapshot" => return Err("保留副本为只读，请先导出后再编辑".into()),
        _ => return Err("未知文档来源".into()),
    };
    atomic_write(&target, content.as_bytes())?;
    if let Some(cache_key) = cache_key {
        inner.cache.invalidate(&cache_key);
    }
    let archived_target = target.canonicalize().map_err(error_string)?;
    archive_source(&mut inner, &archived_target, &content, now_ms_u64())?;
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
    fs::rename(&source, &target).map_err(error_string)?;
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
    inner.cache.invalidate(&path_to_slash(&relative));
    Ok(())
}

#[tauri::command]
fn import_files(
    source_paths: Vec<String>,
    target_directory: String,
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
fn export_file(
    origin: String,
    path: String,
    target_path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let inner = state.0.lock();
    let source = match origin.as_str() {
        "workspace" => {
            let relative = validate_markdown_path(&path)?;
            secure_existing_path(&inner.workspace, &relative)?
        }
        "external" => validate_external_markdown_path(&path)?
            .canonicalize()
            .map_err(error_string)?,
        "snapshot" => {
            let record = inner
                .records
                .iter()
                .find(|record| record.id == path)
                .ok_or_else(|| "历史记录不存在".to_string())?;
            archive_snapshot_path(&inner.archive_dir, &record.snapshot_path)?
        }
        _ => return Err("未知文档来源".into()),
    };
    fs::copy(source, PathBuf::from(target_path))
        .map(|_| ())
        .map_err(error_string)
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
    Ok(BootstrapPayload {
        settings: inner.settings.clone(),
        entries: scan_entries(&workspace)?,
        records: records_with_source_status(&inner.records),
        pending_open_paths: Vec::new(),
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

#[tauri::command]
fn open_default_app_settings() -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        Command::new("explorer.exe")
            .arg("ms-settings:defaultapps")
            .spawn()
            .map_err(error_string)?;
        return Ok("系统设置已打开。搜索“.md”，然后选择 LeafMark。".into());
    }

    #[cfg(not(target_os = "windows"))]
    {
        Ok("当前安装包仅在 Windows 注册 Markdown 文件关联。".into())
    }
}

fn load_source_document(
    inner: &mut InnerState,
    target: &Path,
    path: String,
    origin: &'static str,
    use_cache: bool,
) -> Result<LoadedDocument, String> {
    ensure_markdown_extension(target)?;
    let canonical = target.canonicalize().map_err(error_string)?;
    let metadata = fs::metadata(&canonical).map_err(error_string)?;
    if !metadata.is_file() {
        return Err("目标不是文件".into());
    }
    let size = metadata.len();
    let modified_ms = modified_ms(&metadata);
    let cached = if use_cache {
        inner.cache.get(&path, size, modified_ms)
    } else {
        None
    };
    let (content, html, was_cached) = if let Some(cached) = cached {
        (cached.content, cached.html, true)
    } else {
        let bytes = fs::read(&canonical).map_err(error_string)?;
        let content = decode_text(&bytes);
        let html = render_markdown_impl(&content);
        if use_cache {
            inner.cache.insert(CachedDocument {
                relative_path: path.clone(),
                content: content.clone(),
                html: html.clone(),
                size,
                modified_ms,
            });
        }
        (content, html, false)
    };
    let record = archive_source(inner, &canonical, &content, modified_ms)?;
    Ok(LoadedDocument {
        path,
        source_path: canonical.to_string_lossy().into_owned(),
        name: record.name,
        content,
        html,
        size,
        modified_ms,
        cached: was_cached,
        origin,
        record_id: record.id,
        source_exists: true,
        writable: true,
    })
}

fn archive_source(
    inner: &mut InnerState,
    source: &Path,
    content: &str,
    modified_ms: u64,
) -> Result<ArchiveRecord, String> {
    let source_path = source.to_string_lossy().into_owned();
    let position = inner
        .records
        .iter()
        .position(|record| record.source_path == source_path);
    let index = if let Some(position) = position {
        position
    } else {
        let id = unique_record_id(&source_path, &inner.records);
        let name = source
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();
        inner.records.push(ArchiveRecord {
            snapshot_path: format!("{id}.md"),
            id,
            source_path: source_path.clone(),
            name,
            last_opened_ms: 0,
            modified_ms: 0,
            size: 0,
            favorite: false,
            source_exists: true,
        });
        inner.records.len() - 1
    };

    let snapshot_path =
        archive_snapshot_path(&inner.archive_dir, &inner.records[index].snapshot_path)?;
    atomic_write(&snapshot_path, content.as_bytes())?;
    let record = &mut inner.records[index];
    record.name = source
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();
    record.last_opened_ms = now_ms_u64();
    record.modified_ms = modified_ms;
    record.size = content.len() as u64;
    record.source_exists = true;
    let result = record.clone();
    persist_archive_index(&inner.archive_index_path, &inner.records)?;
    Ok(result)
}

fn unique_record_id(source_path: &str, records: &[ArchiveRecord]) -> String {
    let mut hasher = DefaultHasher::new();
    source_path.hash(&mut hasher);
    let base = format!("{:016x}", hasher.finish());
    if records
        .iter()
        .all(|record| record.id != base || record.source_path == source_path)
    {
        return base;
    }
    for suffix in 1..10_000 {
        let candidate = format!("{base}-{suffix}");
        if records.iter().all(|record| record.id != candidate) {
            return candidate;
        }
    }
    format!("{base}-{}", now_ms_u64())
}

fn records_with_source_status(records: &[ArchiveRecord]) -> Vec<ArchiveRecord> {
    let mut records = records.to_vec();
    for record in &mut records {
        record.source_exists = Path::new(&record.source_path).is_file();
    }
    records.sort_by(|left, right| right.last_opened_ms.cmp(&left.last_opened_ms));
    records
}

fn persist_archive_index(path: &Path, records: &[ArchiveRecord]) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(records).map_err(error_string)?;
    atomic_write(path, &bytes)
}

fn validate_external_markdown_path(value: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(value.trim());
    if !path.is_absolute() {
        return Err("外部文档必须使用绝对路径".into());
    }
    ensure_markdown_extension(&path)?;
    Ok(path)
}

fn archive_snapshot_path(root: &Path, name: &str) -> Result<PathBuf, String> {
    let relative = Path::new(name);
    if relative.components().count() != 1
        || !matches!(relative.components().next(), Some(Component::Normal(_)))
        || !is_markdown(relative)
    {
        return Err("保留副本路径无效".into());
    }
    Ok(root.join(relative))
}

fn markdown_args(args: &[String], cwd: &Path) -> Vec<String> {
    let mut seen = HashSet::new();
    args.iter()
        .filter_map(|argument| {
            let requested = PathBuf::from(argument);
            let candidate = if requested.is_absolute() {
                requested
            } else {
                cwd.join(requested)
            };
            if !is_markdown(&candidate) || !candidate.is_file() {
                return None;
            }
            let canonical = candidate.canonicalize().ok()?;
            let value = canonical.to_string_lossy().into_owned();
            seen.insert(value.clone()).then_some(value)
        })
        .collect()
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
        if !entry.file_type().is_some_and(|kind| kind.is_file()) {
            continue;
        }
        let path = entry.path();
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

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    AtomicFile::new(path, AllowOverwrite)
        .write(|file| file.write_all(bytes))
        .map_err(error_string)
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

fn now_ms_u64() -> u64 {
    now_ms().min(u64::MAX as u128) as u64
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

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            let paths = markdown_args(&args, Path::new(&cwd));
            if paths.is_empty() {
                return;
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
            let _ = app.emit(OPEN_MARKDOWN_EVENT, paths);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let config_dir = app.path().app_config_dir().map_err(error_string)?;
            fs::create_dir_all(&config_dir).map_err(error_string)?;
            let settings_path = config_dir.join("settings.json");
            let archive_dir = config_dir.join("archive");
            fs::create_dir_all(&archive_dir).map_err(error_string)?;
            let archive_index_path = config_dir.join("history.json");
            let records = fs::read(&archive_index_path)
                .ok()
                .and_then(|bytes| serde_json::from_slice::<Vec<ArchiveRecord>>(&bytes).ok())
                .unwrap_or_default();
            let current_dir = env::current_dir().unwrap_or_else(|_| config_dir.clone());
            let pending_open_paths = markdown_args(&env::args().collect::<Vec<_>>(), &current_dir);
            let default_workspace = app
                .path()
                .document_dir()
                .unwrap_or_else(|_| config_dir.clone())
                .join("LeafMark");
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
            app.manage(AppState(Mutex::new(InnerState {
                settings,
                settings_path,
                archive_index_path,
                archive_dir,
                records,
                pending_open_paths,
                workspace,
                cache: RenderCache::default(),
            })));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            bootstrap,
            list_entries,
            read_document,
            read_external_document,
            read_archive_document,
            list_archive_records,
            set_favorite,
            clear_history,
            render_markdown,
            write_document,
            create_entry,
            rename_entry,
            delete_entry,
            import_files,
            export_file,
            set_workspace,
            save_settings,
            open_default_app_settings,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run LeafMark");
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
    fn archive_snapshot_paths_stay_inside_archive_directory() {
        let root = Path::new("/tmp/archive");
        assert_eq!(
            archive_snapshot_path(root, "a1b2.md").unwrap(),
            root.join("a1b2.md")
        );
        assert!(archive_snapshot_path(root, "../outside.md").is_err());
        assert!(archive_snapshot_path(root, "nested/file.md").is_err());
        assert!(archive_snapshot_path(root, "snapshot.txt").is_err());
    }

    #[test]
    fn record_ids_are_stable_and_collision_aware() {
        let source = "/documents/guide.md";
        let first = unique_record_id(source, &[]);
        assert_eq!(first, unique_record_id(source, &[]));
        let collision = ArchiveRecord {
            id: first.clone(),
            source_path: "/another/guide.md".into(),
            name: "guide.md".into(),
            snapshot_path: format!("{first}.md"),
            last_opened_ms: 0,
            modified_ms: 0,
            size: 0,
            favorite: false,
            source_exists: true,
        };
        assert_ne!(first, unique_record_id(source, &[collision]));
    }
}
