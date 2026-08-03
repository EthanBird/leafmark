use dioxus::prelude::*;
use leafmark_app::{AppController, AppError};
use leafmark_archive::ArchiveEntry;
use leafmark_domain::{DocumentId, DockPanelId, ViewMode};
use leafmark_editor::EditSemantic;
use leafmark_markdown::{Block, BlockKind, SourceRange};
use leafmark_runtime::RuntimeDocumentView;
use leafmark_storage::{DocumentEntry, EntryKind};

const CSS: &str = r#"
:root{font-family:'Noto Sans CJK SC','Microsoft YaHei UI',system-ui,sans-serif;background:#eef1eb;color:#243027}*{box-sizing:border-box}button,textarea{font:inherit}.app{--s:#f7f8f4;--r:#fff;--m:#eef1eb;--t:#243027;--b:#d7ddd4;--a:#315f40;display:flex;flex-direction:column;height:100vh;min-width:780px;background:var(--s);color:var(--t)}.dark{--s:#171a17;--r:#242a25;--m:#1e231f;--t:#e7ece7;--b:#343c35;--a:#8fbc99}.title,.toolbar,.status{display:flex;align-items:center;background:var(--r);border-color:var(--b)}.title{height:52px;justify-content:space-between;padding:0 14px;border-bottom:1px solid var(--b)}.brand{display:flex;gap:9px;align-items:center}.leaf{padding:6px 9px;border-radius:9px 3px;background:var(--a);color:#fff}.toolbar{height:47px;gap:5px;padding:7px 12px;border-bottom:1px solid var(--b)}button{border:0;border-radius:7px;padding:7px 10px;color:var(--t);background:transparent;cursor:pointer}button:hover{background:var(--m)}button:disabled{opacity:.42;cursor:default}.primary,.active{background:var(--a)!important;color:#fff}.spacer{flex:1}.shell{display:flex;flex:1;min-height:0}.rail{width:76px;padding:7px;background:var(--m);border-right:1px solid var(--b)}.rail button{display:block;width:100%;margin-bottom:4px;font-size:12px}.panel{width:286px;background:var(--r);border-right:1px solid var(--b);overflow:auto}.panel h3{position:sticky;top:0;margin:0;padding:13px;background:var(--r);border-bottom:1px solid var(--b)}.panel-body{padding:8px}.entry{display:flex;width:100%;gap:8px;text-align:left;align-items:center}.entry small{margin-left:auto;color:#7a887d}.folder{opacity:.7}.empty{padding:16px;color:#7a887d}.editor{display:flex;flex:1;min-width:0;flex-direction:column}.tabs{display:flex;height:39px;overflow-x:auto;background:var(--m);border-bottom:1px solid var(--b)}.tab{display:flex;align-items:center;border-right:1px solid var(--b)}.tab button{height:38px;border-radius:0;padding:0 10px}.tab .close{padding:0 8px}.doc-host{flex:1;overflow:auto;padding:26px}.doc{max-width:860px;min-height:100%;margin:auto;padding:42px 52px;border:1px solid var(--b);border-radius:13px;background:var(--r);line-height:1.75}.source-editor{display:block;width:100%;min-height:calc(100vh - 230px);resize:none;padding:24px;border:1px solid var(--b);border-radius:10px;background:var(--r);color:var(--t);line-height:1.65;outline:none}.source-editor:focus{border-color:var(--a)}.split{display:grid;grid-template-columns:1fr 1fr;gap:16px;min-height:100%}.split .doc{width:100%;padding:28px}.split .source-editor{min-height:100%}.callout{padding:12px;border:1px solid var(--a);border-radius:9px;color:var(--a)}pre{padding:13px;border-radius:8px;background:var(--m);overflow:auto;white-space:pre-wrap}.math,.diagram{padding:16px;border:1px solid var(--b);border-radius:9px;background:var(--m)}blockquote{margin-left:0;padding-left:16px;border-left:4px solid var(--a)}hr{border:0;border-top:1px solid var(--b)}.outline-row{display:flex;gap:8px;width:100%;text-align:left}.outline-level{min-width:27px;color:var(--a);font-weight:700}.status{height:28px;gap:13px;padding:0 11px;border-top:1px solid var(--b);font-size:11px}.error{color:#b42318}@media(max-width:850px){.panel{width:230px}.doc-host{padding:12px}.doc{padding:28px}.split{grid-template-columns:1fr}}
"#;

fn main() {
    dioxus::launch(app);
}

struct UiState {
    controller: Option<AppController>,
    error: Option<String>,
}

impl UiState {
    fn bootstrap() -> Self {
        match AppController::bootstrap_current() {
            Ok(controller) => Self {
                controller: Some(controller),
                error: None,
            },
            Err(error) => Self {
                controller: None,
                error: Some(error.to_string()),
            },
        }
    }
}

#[derive(Clone)]
struct UiSnapshot {
    workspace: Vec<DocumentEntry>,
    archive: Vec<ArchiveEntry>,
    tabs: Vec<RuntimeDocumentView>,
    active: Option<RuntimeDocumentView>,
    notice: String,
    error: Option<String>,
}

fn app() -> Element {
    let mut state = use_signal(UiState::bootstrap);
    let mut panel = use_signal(|| DockPanelId::Workspace);
    let mut mode = use_signal(|| ViewMode::Live);
    let mut dark = use_signal(|| false);
    let snapshot = {
        let state = state.read();
        snapshot(&state)
    };
    let current_panel = *panel.read();
    let current_mode = *mode.read();
    let class = if *dark.read() { "app dark" } else { "app" };
    let can_edit = snapshot.active.is_some();
    let active_dirty = snapshot.active.as_ref().is_some_and(|view| view.dirty);
    let revision_label = snapshot
        .active
        .as_ref()
        .map(|view| format!("revision {}", view.revision))
        .unwrap_or_default();
    let block_label = snapshot
        .active
        .as_ref()
        .map(|view| format!("{} 块", view.parsed.blocks.len()))
        .unwrap_or_default();
    let command_label = snapshot
        .active
        .as_ref()
        .map(|view| format!("{} 绘制命令", view.scene.commands.len()))
        .unwrap_or_default();

    rsx! {
        style { {CSS} }
        main { class: "{class}",
            header { class: "title",
                div { class: "brand",
                    span { class: "leaf", "叶" }
                    strong { "LeafMark Native" }
                }
                button {
                    onclick: move |_| {
                        let next = !*dark.read();
                        dark.set(next);
                    },
                    "切换主题"
                }
            }
            nav { class: "toolbar",
                button {
                    class: "primary",
                    onclick: move |_| mutate_controller(&mut state, |controller| {
                        controller.create_untitled().map(|_| ())
                    }),
                    "+ 新建"
                }
                button {
                    onclick: move |_| mutate_controller(&mut state, AppController::refresh),
                    "刷新"
                }
                button {
                    disabled: !can_edit,
                    onclick: move |_| mutate_controller(&mut state, |controller| {
                        controller.save_active().map(|_| ())
                    }),
                    "保存"
                }
                button {
                    disabled: !can_edit,
                    onclick: move |_| mutate_controller(&mut state, |controller| {
                        controller.undo_active().map(|_| ())
                    }),
                    "撤销"
                }
                button {
                    disabled: !can_edit,
                    onclick: move |_| mutate_controller(&mut state, |controller| {
                        controller.redo_active().map(|_| ())
                    }),
                    "重做"
                }
                for item in ViewMode::ALL {
                    button {
                        class: if item == current_mode { "active" } else { "" },
                        onclick: move |_| mode.set(item),
                        {item.label()}
                    }
                }
                span { class: "spacer" }
                strong { "NO WEBVIEW" }
            }
            section { class: "shell",
                aside { class: "rail",
                    for item in DockPanelId::ALL {
                        button {
                            class: if item == current_panel { "active" } else { "" },
                            onclick: move |_| panel.set(item),
                            {item.label()}
                        }
                    }
                }
                aside { class: "panel",
                    h3 { {current_panel.label()} }
                    div { class: "panel-body",
                        {render_panel(current_panel, &snapshot, state)}
                    }
                }
                section { class: "editor",
                    div { class: "tabs",
                        for tab in snapshot.tabs.iter() {
                            {render_tab(tab, snapshot.active.as_ref().map(|view| &view.id), state)}
                        }
                    }
                    div { class: "doc-host",
                        if let Some(view) = snapshot.active.as_ref() {
                            {render_document(view, current_mode, state)}
                        } else if let Some(error) = snapshot.error.as_ref() {
                            div { class: "empty error", {error.as_str()} }
                        } else {
                            div { class: "empty", "没有打开的文档" }
                        }
                    }
                    footer { class: "status",
                        span { {snapshot.notice.as_str()} }
                        if active_dirty { span { "未保存" } }
                        if let Some(error) = snapshot.error.as_ref() {
                            span { class: "error", {error.as_str()} }
                        }
                        span { class: "spacer" }
                        span { {revision_label.as_str()} }
                        span { {block_label.as_str()} }
                        span { {command_label.as_str()} }
                    }
                }
            }
        }
    }
}

fn snapshot(state: &UiState) -> UiSnapshot {
    match &state.controller {
        Some(controller) => UiSnapshot {
            workspace: controller.workspace_entries().to_vec(),
            archive: controller.archive_entries().to_vec(),
            tabs: controller.tabs(),
            active: controller.active_view(),
            notice: controller.notice().to_owned(),
            error: state.error.clone(),
        },
        None => UiSnapshot {
            workspace: Vec::new(),
            archive: Vec::new(),
            tabs: Vec::new(),
            active: None,
            notice: "启动失败".to_owned(),
            error: state.error.clone(),
        },
    }
}

fn mutate_controller(
    state: &mut Signal<UiState>,
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

fn render_panel(
    panel: DockPanelId,
    snapshot: &UiSnapshot,
    state: Signal<UiState>,
) -> Element {
    match panel {
        DockPanelId::Workspace => rsx! {
            for entry in snapshot.workspace.iter() {
                {workspace_entry(entry, state)}
            }
        },
        DockPanelId::History => rsx! {
            for entry in snapshot.archive.iter() {
                {archive_entry(entry, state)}
            }
        },
        DockPanelId::Favorites => rsx! {
            for entry in snapshot.archive.iter().filter(|entry| entry.favorite) {
                {archive_entry(entry, state)}
            }
            if !snapshot.archive.iter().any(|entry| entry.favorite) {
                div { class: "empty", "尚无收藏" }
            }
        },
        DockPanelId::Agent => rsx! {
            div { class: "callout",
                "Provider 无关的 Rust Agent 状态机已经接入，账户与工具面板正在迁移。"
            }
        },
        DockPanelId::Outline => rsx! {
            if let Some(view) = snapshot.active.as_ref() {
                for item in view.parsed.outline.iter() {
                    button { class: "outline-row",
                        span { class: "outline-level", "H{item.level}" }
                        span { {item.text.as_str()} }
                    }
                }
            }
        },
    }
}

fn workspace_entry(entry: &DocumentEntry, mut state: Signal<UiState>) -> Element {
    let path = entry.path.clone();
    let name = entry.name.clone();
    let size = entry.size;
    let padding = format!("padding-left:{}px", 8 + entry.depth * 14);
    if entry.kind == EntryKind::Directory {
        return rsx! {
            div { class: "entry folder", style: "{padding}",
                span { "▾" }
                span { {name.as_str()} }
            }
        };
    }
    rsx! {
        button {
            class: "entry",
            style: "{padding}",
            onclick: move |_| {
                let path = path.clone();
                mutate_controller(&mut state, |controller| {
                    controller.open_workspace(&path).map(|_| ())
                });
            },
            span { "📄" }
            span { {name.as_str()} }
            small { "{size}" }
        }
    }
}

fn archive_entry(entry: &ArchiveEntry, mut state: Signal<UiState>) -> Element {
    let id = entry.id.clone();
    let name = entry.name.clone();
    let marker = if entry.favorite {
        "★"
    } else if entry.source_exists {
        "◷"
    } else {
        "副本"
    };
    rsx! {
        button {
            class: "entry",
            onclick: move |_| {
                let id = id.clone();
                mutate_controller(&mut state, |controller| {
                    controller.open_archive(&id).map(|_| ())
                });
            },
            span { {marker} }
            span { {name.as_str()} }
        }
    }
}

fn render_tab(
    tab: &RuntimeDocumentView,
    active: Option<&DocumentId>,
    state: Signal<UiState>,
) -> Element {
    let mut activate_state = state;
    let mut close_state = state;
    let activate_id = tab.id.clone();
    let close_id = tab.id.clone();
    let label = format!(
        "{}{}",
        display_name(&tab.path),
        if tab.dirty { " ●" } else { "" }
    );
    let active_class = if active == Some(&tab.id) { "active" } else { "" };
    rsx! {
        div { class: "tab",
            button {
                class: "{active_class}",
                onclick: move |_| {
                    let id = activate_id.clone();
                    mutate_controller(&mut activate_state, |controller| {
                        controller.activate(&id)
                    });
                },
                {label.as_str()}
            }
            button {
                class: "close",
                onclick: move |_| {
                    let id = close_id.clone();
                    mutate_controller(&mut close_state, |controller| {
                        controller.close(&id)
                    });
                },
                "×"
            }
        }
    }
}

fn render_document(
    view: &RuntimeDocumentView,
    mode: ViewMode,
    state: Signal<UiState>,
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
                div { class: "callout", "真实文档：Rope → AST → DocumentScene" }
                {render_blocks(view)}
            }
        },
    }
}

fn source_editor(source: String, mut state: Signal<UiState>) -> Element {
    rsx! {
        textarea {
            class: "source-editor",
            value: source,
            oninput: move |event| {
                let value = event.value();
                mutate_controller(&mut state, |controller| {
                    controller
                        .edit_active(&value, EditSemantic::Typing)
                        .map(|_| ())
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
        BlockKind::Mermaid => rsx!(div { class: "diagram", strong { "Mermaid" } pre { {raw.as_str()} } }),
        BlockKind::MathBlock => rsx!(div { class: "math", strong { "Math" } pre { {raw.as_str()} } }),
        BlockKind::Table => rsx!(pre { {raw.as_str()} }),
        BlockKind::List { .. } => rsx!(p { {text.as_str()} }),
        BlockKind::Rule => rsx!(hr {}),
        _ => rsx!(p { {text.as_str()} }),
    }
}

fn source_fragment(source: &str, range: SourceRange) -> String {
    if range.end <= source.len()
        && source.is_char_boundary(range.start)
        && source.is_char_boundary(range.end)
    {
        source[range.start..range.end].to_owned()
    } else {
        String::new()
    }
}

fn display_name(path: &str) -> &str {
    path.rsplit(['/', '\\']).next().unwrap_or(path)
}
