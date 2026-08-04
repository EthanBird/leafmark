#[cfg(target_os = "android")]
use std::path::PathBuf;

use dioxus::prelude::*;
use leafmark_app::{AppController, AppError};
use leafmark_archive::ArchiveEntry;
use leafmark_domain::{DocumentId, ViewMode};
use leafmark_editor::EditSemantic;
use leafmark_markdown::{Block, BlockKind, SourceRange};
use leafmark_platform::AppDirectories;
use leafmark_runtime::RuntimeDocumentView;
use leafmark_storage::{DocumentEntry, EntryKind};

const CSS: &str = r#"
:root{font-family:'Noto Sans CJK SC','Noto Sans',system-ui,sans-serif;background:#eef1eb;color:#243027}*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}button,textarea{font:inherit}.app{--surface:#f7f8f4;--raised:#fff;--muted:#eef1eb;--text:#243027;--secondary:#69766c;--border:#d7ddd4;--accent:#315f40;display:flex;flex-direction:column;height:100vh;width:100vw;overflow:hidden;background:var(--surface);color:var(--text)}.dark{--surface:#171a17;--raised:#242a25;--muted:#1e231f;--text:#e7ece7;--secondary:#a2afa4;--border:#343c35;--accent:#8fbc99}.top{display:flex;align-items:center;gap:8px;min-height:54px;padding:7px 10px;background:var(--raised);border-bottom:1px solid var(--border)}.brand{display:flex;align-items:center;gap:8px;font-weight:700}.leaf{display:grid;place-items:center;width:32px;height:32px;border-radius:10px 4px;background:var(--accent);color:#fff}.top-actions{display:flex;gap:3px;margin-left:auto;overflow-x:auto}.top button,.bottom button,.tab button,.entry{border:0;background:transparent;color:var(--text);border-radius:9px;min-height:40px;padding:8px 11px}.top button:active,.bottom button:active,.entry:active{background:var(--muted)}button:disabled{opacity:.38}.primary,.active{background:var(--accent)!important;color:#fff!important}.tabs{display:flex;flex:0 0 42px;overflow-x:auto;background:var(--muted);border-bottom:1px solid var(--border)}.tab{display:flex;flex:0 0 auto;border-right:1px solid var(--border)}.tab button{border-radius:0;white-space:nowrap}.tab .close{padding:5px 9px}.body{position:relative;display:flex;flex:1;min-height:0;overflow:hidden}.drawer{position:absolute;z-index:5;inset:0 0 auto 0;max-height:46%;overflow:auto;padding:8px;background:var(--raised);border-bottom:1px solid var(--border);box-shadow:0 10px 30px #0002}.drawer-title{display:flex;align-items:center;gap:8px;padding:5px 7px 10px;font-weight:700}.drawer-title small{margin-left:auto;color:var(--secondary);font-weight:400}.entry{display:flex;width:100%;align-items:center;gap:9px;text-align:left}.entry .name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.entry small{margin-left:auto;color:var(--secondary)}.folder{padding:8px 11px;color:var(--secondary)}.content{flex:1;min-width:0;overflow:auto;padding:10px}.doc{width:100%;min-height:100%;padding:23px 18px;border:1px solid var(--border);border-radius:10px;background:var(--raised);line-height:1.7;overflow-wrap:anywhere}.doc h1{font-size:1.75rem}.doc h2{font-size:1.35rem}.source{display:block;width:100%;min-height:100%;height:100%;resize:none;padding:17px;border:1px solid var(--border);border-radius:10px;background:var(--raised);color:var(--text);line-height:1.58;outline:none}.source:focus{border-color:var(--accent)}.split{display:flex;flex-direction:column;gap:10px;min-height:100%}.split .source{min-height:48vh}.split .doc{min-height:48vh}.callout,.math,.diagram{padding:12px;border:1px solid var(--border);border-radius:9px;background:var(--muted)}pre{padding:12px;border-radius:8px;background:var(--muted);white-space:pre-wrap;overflow:auto}blockquote{margin-left:0;padding-left:14px;border-left:4px solid var(--accent)}hr{border:0;border-top:1px solid var(--border)}.outline{display:flex;width:100%;gap:8px;text-align:left}.outline b{min-width:28px;color:var(--accent)}.empty{padding:28px 16px;text-align:center;color:var(--secondary)}.error{color:#bd2c1f}.status{display:flex;gap:9px;min-height:27px;padding:5px 10px;overflow-x:auto;white-space:nowrap;background:var(--raised);border-top:1px solid var(--border);font-size:11px;color:var(--secondary)}.status .spacer{flex:1}.bottom{display:grid;grid-template-columns:repeat(4,1fr);gap:3px;flex:0 0 58px;padding:5px 7px calc(5px + env(safe-area-inset-bottom));background:var(--raised);border-top:1px solid var(--border)}.bottom button{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px;padding:4px;font-size:11px}.bottom strong{font-size:15px}@media(min-width:800px){.content{padding:24px}.doc{max-width:860px;margin:auto;padding:42px 52px}.drawer{inset:0 auto 0 0;width:320px;max-height:none;border-right:1px solid var(--border);border-bottom:0}.split{display:grid;grid-template-columns:1fr 1fr}.split .source,.split .doc{min-height:100%}}
"#;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Drawer {
    Files,
    History,
    Outline,
}

impl Drawer {
    fn title(self) -> &'static str {
        match self {
            Self::Files => "文档库",
            Self::History => "历史副本",
            Self::Outline => "大纲",
        }
    }
}

struct MobileState {
    controller: Option<AppController>,
    error: Option<String>,
}

impl MobileState {
    fn bootstrap() -> Self {
        match resolve_directories().and_then(|directories| {
            AppController::bootstrap(directories).map_err(|error| error.to_string())
        }) {
            Ok(controller) => Self {
                controller: Some(controller),
                error: None,
            },
            Err(error) => Self {
                controller: None,
                error: Some(error),
            },
        }
    }
}

#[derive(Clone)]
struct Snapshot {
    workspace: Vec<DocumentEntry>,
    archive: Vec<ArchiveEntry>,
    tabs: Vec<RuntimeDocumentView>,
    active: Option<RuntimeDocumentView>,
    notice: String,
    error: Option<String>,
}

fn main() {
    dioxus::launch(app);
}

fn app() -> Element {
    let mut state = use_signal(MobileState::bootstrap);
    let mut drawer = use_signal(|| None::<Drawer>);
    let mut mode = use_signal(|| ViewMode::Live);
    let mut dark = use_signal(|| false);
    let snapshot = {
        let state = state.read();
        take_snapshot(&state)
    };
    let current_mode = *mode.read();
    let current_drawer = *drawer.read();
    let class = if *dark.read() { "app dark" } else { "app" };
    let can_edit = snapshot.active.is_some();
    let dirty = snapshot.active.as_ref().is_some_and(|view| view.dirty);

    rsx! {
        style { {CSS} }
        main { class: "{class}",
            header { class: "top",
                div { class: "brand",
                    span { class: "leaf", "叶" }
                    span { "LeafMark Native" }
                }
                div { class: "top-actions",
                    button {
                        onclick: move |_| mutate(&mut state, |controller| {
                            controller.create_untitled().map(|_| ())
                        }),
                        "新建"
                    }
                    button {
                        disabled: !can_edit,
                        onclick: move |_| mutate(&mut state, |controller| {
                            controller.save_active().map(|_| ())
                        }),
                        "保存"
                    }
                    button {
                        onclick: move |_| {
                            let value = !*dark.read();
                            dark.set(value);
                        },
                        if *dark.read() { "浅色" } else { "深色" }
                    }
                }
            }
            div { class: "tabs",
                for tab in snapshot.tabs.iter() {
                    {render_tab(tab, snapshot.active.as_ref().map(|view| &view.id), state)}
                }
            }
            section { class: "body",
                if let Some(open) = current_drawer {
                    aside { class: "drawer",
                        div { class: "drawer-title",
                            span { {open.title()} }
                            small { "轻触底栏关闭" }
                        }
                        {render_drawer(open, &snapshot, state, drawer)}
                    }
                }
                div { class: "content",
                    if let Some(view) = snapshot.active.as_ref() {
                        {render_document(view, current_mode, state)}
                    } else if let Some(error) = snapshot.error.as_ref() {
                        div { class: "empty error", {error.as_str()} }
                    } else {
                        div { class: "empty", "没有打开的文档" }
                    }
                }
            }
            footer { class: "status",
                span { {snapshot.notice.as_str()} }
                if dirty { span { "未保存" } }
                if let Some(error) = snapshot.error.as_ref() {
                    span { class: "error", {error.as_str()} }
                }
                span { class: "spacer" }
                if let Some(view) = snapshot.active.as_ref() {
                    span { "r{view.revision}" }
                    span { "{view.parsed.blocks.len()} 块" }
                }
            }
            nav { class: "bottom",
                button {
                    class: if current_drawer == Some(Drawer::Files) { "active" } else { "" },
                    onclick: move |_| toggle_drawer(&mut drawer, Drawer::Files),
                    strong { "文" }
                    span { "文档" }
                }
                button {
                    class: if current_drawer == Some(Drawer::History) { "active" } else { "" },
                    onclick: move |_| toggle_drawer(&mut drawer, Drawer::History),
                    strong { "史" }
                    span { "历史" }
                }
                button {
                    class: if current_drawer == Some(Drawer::Outline) { "active" } else { "" },
                    onclick: move |_| toggle_drawer(&mut drawer, Drawer::Outline),
                    strong { "纲" }
                    span { "大纲" }
                }
                button {
                    onclick: move |_| mode.set(next_mode(current_mode)),
                    strong { {mode_short(current_mode)} }
                    span { {current_mode.label()} }
                }
            }
        }
    }
}

fn take_snapshot(state: &MobileState) -> Snapshot {
    match &state.controller {
        Some(controller) => Snapshot {
            workspace: controller.workspace_entries().to_vec(),
            archive: controller.archive_entries().to_vec(),
            tabs: controller.tabs(),
            active: controller.active_view(),
            notice: controller.notice().to_owned(),
            error: state.error.clone(),
        },
        None => Snapshot {
            workspace: Vec::new(),
            archive: Vec::new(),
            tabs: Vec::new(),
            active: None,
            notice: "启动失败".to_owned(),
            error: state.error.clone(),
        },
    }
}

fn mutate(
    state: &mut Signal<MobileState>,
    action: impl FnOnce(&mut AppController) -> Result<(), AppError>,
) {
    let mut state = state.write();
    let Some(controller) = state.controller.as_mut() else {
        return;
    };
    match action(controller) {
        Ok(()) => state.error = None,
        Err(error) => state.error = Some(error.to_string()),
    }
}

fn toggle_drawer(drawer: &mut Signal<Option<Drawer>>, target: Drawer) {
    let next = if *drawer.read() == Some(target) {
        None
    } else {
        Some(target)
    };
    drawer.set(next);
}

fn next_mode(mode: ViewMode) -> ViewMode {
    match mode {
        ViewMode::Read => ViewMode::Source,
        ViewMode::Source => ViewMode::Split,
        ViewMode::Split => ViewMode::Live,
        ViewMode::Live => ViewMode::Read,
    }
}

fn mode_short(mode: ViewMode) -> &'static str {
    match mode {
        ViewMode::Read => "阅",
        ViewMode::Source => "源",
        ViewMode::Split => "分",
        ViewMode::Live => "实",
    }
}

fn render_drawer(
    drawer_kind: Drawer,
    snapshot: &Snapshot,
    state: Signal<MobileState>,
    drawer: Signal<Option<Drawer>>,
) -> Element {
    match drawer_kind {
        Drawer::Files => rsx! {
            for entry in snapshot.workspace.iter() {
                {workspace_entry(entry, state, drawer)}
            }
            if snapshot.workspace.is_empty() {
                div { class: "empty", "文档库为空" }
            }
        },
        Drawer::History => rsx! {
            for entry in snapshot.archive.iter() {
                {history_entry(entry, state, drawer)}
            }
            if snapshot.archive.is_empty() {
                div { class: "empty", "尚无历史副本" }
            }
        },
        Drawer::Outline => rsx! {
            if let Some(view) = snapshot.active.as_ref() {
                for item in view.parsed.outline.iter() {
                    button { class: "entry outline",
                        b { "H{item.level}" }
                        span { class: "name", {item.text.as_str()} }
                    }
                }
                if view.parsed.outline.is_empty() {
                    div { class: "empty", "本文档没有标题" }
                }
            }
        },
    }
}

fn workspace_entry(
    entry: &DocumentEntry,
    mut state: Signal<MobileState>,
    mut drawer: Signal<Option<Drawer>>,
) -> Element {
    let name = entry.name.clone();
    let path = entry.path.clone();
    let size = entry.size;
    let padding = format!("padding-left:{}px", 10 + entry.depth * 14);
    if entry.kind == EntryKind::Directory {
        return rsx! {
            div { class: "folder", style: "{padding}", "▾ {name}" }
        };
    }
    rsx! {
        button {
            class: "entry",
            style: "{padding}",
            onclick: move |_| {
                let path = path.clone();
                mutate(&mut state, |controller| controller.open_workspace(&path).map(|_| ()));
                drawer.set(None);
            },
            span { "□" }
            span { class: "name", {name.as_str()} }
            small { "{size}" }
        }
    }
}

fn history_entry(
    entry: &ArchiveEntry,
    mut state: Signal<MobileState>,
    mut drawer: Signal<Option<Drawer>>,
) -> Element {
    let id = entry.id.clone();
    let name = entry.name.clone();
    let marker = if entry.favorite { "★" } else { "◷" };
    rsx! {
        button {
            class: "entry",
            onclick: move |_| {
                let id = id.clone();
                mutate(&mut state, |controller| controller.open_archive(&id).map(|_| ()));
                drawer.set(None);
            },
            span { {marker} }
            span { class: "name", {name.as_str()} }
        }
    }
}

fn render_tab(
    tab: &RuntimeDocumentView,
    active: Option<&DocumentId>,
    state: Signal<MobileState>,
) -> Element {
    let mut activate_state = state;
    let mut close_state = state;
    let activate_id = tab.id.clone();
    let close_id = tab.id.clone();
    let active_class = if active == Some(&tab.id) {
        "active"
    } else {
        ""
    };
    let label = format!(
        "{}{}",
        display_name(&tab.path),
        if tab.dirty { " ●" } else { "" },
    );
    rsx! {
        div { class: "tab",
            button {
                class: "{active_class}",
                onclick: move |_| {
                    let id = activate_id.clone();
                    mutate(&mut activate_state, |controller| controller.activate(&id));
                },
                {label.as_str()}
            }
            button {
                class: "close",
                disabled: tab.dirty,
                onclick: move |_| {
                    let id = close_id.clone();
                    mutate(&mut close_state, |controller| controller.close(&id));
                },
                "×"
            }
        }
    }
}

fn render_document(
    view: &RuntimeDocumentView,
    mode: ViewMode,
    state: Signal<MobileState>,
) -> Element {
    let source = view.source.clone();
    match mode {
        ViewMode::Source => source_editor(source, state),
        ViewMode::Split => rsx! {
            div { class: "split",
                {source_editor(source, state)}
                article { class: "doc", {render_blocks(view)} }
            }
        },
        ViewMode::Read | ViewMode::Live => rsx! {
            article { class: "doc",
                if mode == ViewMode::Live {
                    div { class: "callout", "实时模式：源码修改会立即刷新原生 AST 预览。" }
                }
                {render_blocks(view)}
            }
        },
    }
}

fn source_editor(source: String, mut state: Signal<MobileState>) -> Element {
    rsx! {
        textarea {
            class: "source",
            value: source,
            oninput: move |event| {
                let value = event.value();
                mutate(&mut state, |controller| {
                    controller.edit_active(&value, EditSemantic::Typing).map(|_| ())
                });
            }
        }
    }
}

fn render_blocks(view: &RuntimeDocumentView) -> Element {
    rsx! {
        for block in view.parsed.blocks.iter().filter(|block| block.depth == 0) {
            {render_block(block, &view.source)}
        }
    }
}

fn render_block(block: &Block, source: &str) -> Element {
    let text = block.plain_text.clone();
    let raw = source_fragment(source, block.range);
    match &block.kind {
        BlockKind::Heading { level: 1 } => rsx!(h1 { {text.as_str()} }),
        BlockKind::Heading { level: 2 } => rsx!(h2 { {text.as_str()} }),
        BlockKind::Heading { level: 3 } => rsx!(h3 { {text.as_str()} }),
        BlockKind::Heading { .. } => rsx!(h4 { {text.as_str()} }),
        BlockKind::BlockQuote { .. } => rsx!(blockquote { {text.as_str()} }),
        BlockKind::CodeBlock { .. } => rsx!(pre { code { {raw.as_str()} } }),
        BlockKind::Mermaid => {
            rsx!(div { class: "diagram", b { "Mermaid" } pre { {raw.as_str()} } })
        }
        BlockKind::MathBlock => rsx!(div { class: "math", b { "Math" } pre { {raw.as_str()} } }),
        BlockKind::Table => rsx!(pre { {raw.as_str()} }),
        BlockKind::Rule => rsx!(hr {}),
        _ => rsx!(p { {text.as_str()} }),
    }
}

fn source_fragment(source: &str, range: SourceRange) -> String {
    range.slice(source).unwrap_or_default().to_owned()
}

fn display_name(path: &str) -> &str {
    path.rsplit(['/', '\\']).next().unwrap_or(path)
}

fn resolve_directories() -> Result<AppDirectories, String> {
    #[cfg(target_os = "android")]
    {
        resolve_android_directories()
    }
    #[cfg(not(target_os = "android"))]
    {
        AppDirectories::resolve_desktop().map_err(|error| error.to_string())
    }
}

#[cfg(target_os = "android")]
fn resolve_android_directories() -> Result<AppDirectories, String> {
    use jni::objects::{JObject, JValue};
    use jni::JavaVM;

    let context = ndk_context::android_context();
    let vm = unsafe { JavaVM::from_raw(context.vm().cast()) }.map_err(|error| error.to_string())?;
    let mut env = vm
        .attach_current_thread()
        .map_err(|error| error.to_string())?;
    let context_object = unsafe { JObject::from_raw(context.context().cast()) };
    let files_object = env
        .call_method(&context_object, "getFilesDir", "()Ljava/io/File;", &[])
        .and_then(|value| value.l())
        .map_err(|error| error.to_string())?;
    let cache_object = env
        .call_method(&context_object, "getCacheDir", "()Ljava/io/File;", &[])
        .and_then(|value| value.l())
        .map_err(|error| error.to_string())?;
    let null = JObject::null();
    let external_object = env
        .call_method(
            &context_object,
            "getExternalFilesDir",
            "(Ljava/lang/String;)Ljava/io/File;",
            &[JValue::Object(&null)],
        )
        .and_then(|value| value.l())
        .ok();
    let files = android_file_path(&mut env, files_object)?;
    let cache = android_file_path(&mut env, cache_object)?;
    let documents = external_object
        .filter(|value| !value.is_null())
        .map(|value| android_file_path(&mut env, value))
        .transpose()?
        .unwrap_or_else(|| files.join("documents"));
    Ok(AppDirectories {
        config: files.join("config"),
        data: files.join("data"),
        cache,
        workspace: documents.join("LeafMark"),
        documents,
    })
}

#[cfg(target_os = "android")]
fn android_file_path<'local>(
    env: &mut jni::JNIEnv<'local>,
    file: jni::objects::JObject<'local>,
) -> Result<PathBuf, String> {
    use jni::objects::JString;

    if file.is_null() {
        return Err("Android 没有返回可用的应用目录".to_owned());
    }
    let path = env
        .call_method(file, "getAbsolutePath", "()Ljava/lang/String;", &[])
        .and_then(|value| value.l())
        .map_err(|error| error.to_string())?;
    let path = JString::from(path);
    let path: String = env
        .get_string(&path)
        .map_err(|error| error.to_string())?
        .into();
    let path = PathBuf::from(path);
    if path.is_absolute() {
        Ok(path)
    } else {
        Err("Android 返回了相对应用目录".to_owned())
    }
}
