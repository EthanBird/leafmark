use dioxus::prelude::*;
use leafmark_app::{AppController, AppError};
use leafmark_archive::ArchiveEntry;
use leafmark_domain::{DockPanelId, DocumentId, ViewMode};
use leafmark_editor::EditSemantic;
use leafmark_markdown::{Block, BlockKind, SourceRange};
use leafmark_runtime::RuntimeDocumentView;
use leafmark_storage::{DocumentEntry, EntryKind};

const APP_TITLE: &str = "LeafMark";

const CSS: &str = r#"
:root {
    font-family: "Noto Sans CJK SC", "Microsoft YaHei UI", "PingFang SC", system-ui, sans-serif;
    font-size: 14px;
    background: #f1f4f0;
    color: #26322a;
}
* { box-sizing: border-box; }
button, textarea { font: inherit; }
button {
    border: 0;
    color: inherit;
    background: transparent;
    cursor: pointer;
}
button:disabled { opacity: .38; cursor: default; }
.app {
    --bg: #f1f4f0;
    --surface: #ffffff;
    --surface-soft: #f7f9f6;
    --surface-muted: #e9eee9;
    --text: #26322a;
    --text-soft: #66736a;
    --text-faint: #89948c;
    --border: #d9e0da;
    --border-strong: #c9d3cb;
    --accent: #2f6844;
    --accent-hover: #285b3b;
    --accent-soft: #e2efe6;
    --danger: #b42318;
    --shadow: 0 14px 42px rgba(36, 57, 43, .09);
    display: flex;
    flex-direction: column;
    width: 100vw;
    height: 100vh;
    min-width: 860px;
    overflow: hidden;
    color: var(--text);
    background: var(--bg);
}
.app.dark {
    --bg: #151915;
    --surface: #202620;
    --surface-soft: #1b211c;
    --surface-muted: #29312a;
    --text: #e8eee9;
    --text-soft: #abb7ad;
    --text-faint: #7f8c82;
    --border: #343d35;
    --border-strong: #455047;
    --accent: #80b98f;
    --accent-hover: #91c59e;
    --accent-soft: #263b2c;
    --danger: #ff8a80;
    --shadow: 0 18px 48px rgba(0, 0, 0, .28);
}
.topbar {
    display: flex;
    align-items: center;
    flex: 0 0 58px;
    min-width: 0;
    padding: 0 12px;
    gap: 12px;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
}
.brand-zone {
    display: flex;
    align-items: center;
    flex: 0 0 284px;
    min-width: 0;
    gap: 10px;
}
.brand {
    display: flex;
    align-items: center;
    min-width: 0;
    gap: 10px;
}
.leaf {
    display: grid;
    place-items: center;
    width: 34px;
    height: 34px;
    flex: 0 0 34px;
    border-radius: 11px 4px 11px 4px;
    color: #fff;
    background: var(--accent);
    font-size: 16px;
    font-weight: 800;
}
.brand-copy { min-width: 0; line-height: 1.15; }
.brand-title { display: block; font-size: 15px; font-weight: 750; letter-spacing: .01em; }
.brand-subtitle { display: block; margin-top: 3px; color: var(--text-faint); font-size: 10px; letter-spacing: .08em; }
.document-heading {
    min-width: 0;
    flex: 1;
    line-height: 1.25;
}
.document-title {
    display: block;
    overflow: hidden;
    color: var(--text);
    font-size: 14px;
    font-weight: 650;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.document-path {
    display: block;
    margin-top: 3px;
    overflow: hidden;
    color: var(--text-faint);
    font-size: 11px;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.top-actions {
    display: flex;
    align-items: center;
    flex: 0 0 auto;
    min-width: 0;
    gap: 7px;
}
.action-group, .mode-switch {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 3px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--surface-soft);
}
.command, .mode-button, .icon-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 32px;
    padding: 6px 10px;
    border-radius: 7px;
    white-space: nowrap;
}
.command:hover, .mode-button:hover, .icon-button:hover { background: var(--surface-muted); }
.command.primary, .mode-button.active {
    color: #fff;
    background: var(--accent);
}
.command.primary:hover, .mode-button.active:hover { background: var(--accent-hover); }
.icon-button { width: 34px; padding: 6px; font-size: 16px; }
.icon-button.small { width: 30px; min-height: 30px; font-size: 14px; }
.shell {
    display: flex;
    flex: 1;
    min-height: 0;
    overflow: hidden;
}
.rail {
    display: flex;
    flex: 0 0 64px;
    flex-direction: column;
    align-items: stretch;
    gap: 5px;
    padding: 9px 7px;
    background: var(--surface-soft);
    border-right: 1px solid var(--border);
}
.rail-button {
    display: flex;
    min-height: 52px;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 3px;
    border-radius: 10px;
    color: var(--text-soft);
}
.rail-button:hover { color: var(--text); background: var(--surface-muted); }
.rail-button.active { color: var(--accent); background: var(--accent-soft); }
.rail-icon { height: 20px; font-size: 18px; font-weight: 750; line-height: 20px; }
.rail-label { font-size: 10px; white-space: nowrap; }
.panel {
    display: flex;
    flex: 0 0 244px;
    min-width: 0;
    flex-direction: column;
    background: var(--surface);
    border-right: 1px solid var(--border);
}
.sidebar-collapsed .panel { display: none; }
.panel-header {
    display: flex;
    align-items: center;
    flex: 0 0 58px;
    padding: 0 12px 0 15px;
    gap: 8px;
    border-bottom: 1px solid var(--border);
}
.panel-heading { min-width: 0; flex: 1; }
.panel-heading h2 { margin: 0; font-size: 15px; font-weight: 700; }
.panel-heading p { margin: 3px 0 0; color: var(--text-faint); font-size: 10px; }
.count-badge {
    min-width: 25px;
    padding: 3px 7px;
    border-radius: 999px;
    color: var(--text-soft);
    background: var(--surface-muted);
    font-size: 10px;
    text-align: center;
}
.panel-body {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 8px;
}
.entry, .folder {
    display: flex;
    width: 100%;
    min-height: 36px;
    align-items: center;
    gap: 8px;
    padding: 7px 9px;
    border-radius: 8px;
    text-align: left;
}
.entry:hover { background: var(--surface-muted); }
.entry-icon { width: 18px; flex: 0 0 18px; color: var(--accent); text-align: center; }
.entry-name {
    min-width: 0;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.entry small { flex: 0 0 auto; color: var(--text-faint); font-size: 10px; }
.folder { color: var(--text-soft); font-weight: 600; }
.folder .entry-icon { color: var(--text-faint); }
.panel-empty, .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    color: var(--text-soft);
    text-align: center;
}
.panel-empty { min-height: 150px; padding: 20px 14px; }
.panel-empty strong { color: var(--text); font-size: 13px; }
.panel-empty p { margin: 7px 0 0; font-size: 11px; line-height: 1.6; }
.feature-card {
    padding: 15px;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--surface-soft);
}
.feature-card strong { display: block; margin-bottom: 8px; }
.feature-card p { margin: 0; color: var(--text-soft); font-size: 12px; line-height: 1.7; }
.outline-row {
    display: flex;
    width: 100%;
    min-height: 34px;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    border-radius: 7px;
    text-align: left;
}
.outline-row:hover { background: var(--surface-muted); }
.outline-level { min-width: 25px; color: var(--accent); font-size: 10px; font-weight: 800; }
.editor {
    display: flex;
    min-width: 0;
    flex: 1;
    flex-direction: column;
    background: var(--bg);
}
.tabs {
    display: flex;
    flex: 0 0 42px;
    min-width: 0;
    overflow-x: auto;
    overflow-y: hidden;
    padding: 5px 8px 0;
    gap: 3px;
    background: var(--surface-soft);
    border-bottom: 1px solid var(--border);
}
.tabs-placeholder { display: flex; align-items: center; padding: 0 8px 5px; color: var(--text-faint); font-size: 11px; }
.tab {
    display: flex;
    flex: 0 0 auto;
    height: 36px;
    align-items: center;
    overflow: hidden;
    border: 1px solid transparent;
    border-radius: 8px 8px 0 0;
}
.tab.active-tab { background: var(--surface); border-color: var(--border); border-bottom-color: var(--surface); }
.tab-select {
    display: flex;
    height: 34px;
    max-width: 230px;
    align-items: center;
    gap: 7px;
    padding: 0 8px 0 11px;
    color: var(--text-soft);
}
.active-tab .tab-select { color: var(--text); }
.tab-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dirty-dot { width: 7px; height: 7px; flex: 0 0 7px; border-radius: 50%; background: var(--accent); }
.tab-close { width: 29px; height: 29px; margin-right: 3px; border-radius: 7px; color: var(--text-faint); font-size: 16px; }
.tab-close:hover { color: var(--text); background: var(--surface-muted); }
.doc-host {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 24px 28px 34px;
    background: var(--bg);
}
.doc {
    width: 100%;
    max-width: 920px;
    min-height: calc(100% - 4px);
    margin: 0 auto;
    padding: 52px 66px 76px;
    border: 1px solid var(--border);
    border-radius: 14px;
    color: var(--text);
    background: var(--surface);
    box-shadow: var(--shadow);
    font-size: 15px;
    line-height: 1.8;
    overflow-wrap: anywhere;
}
.doc h1, .doc h2, .doc h3, .doc h4 { color: var(--text); line-height: 1.3; }
.doc h1 { margin: 0 0 1.15em; font-size: 2rem; letter-spacing: -.025em; }
.doc h2 { margin: 1.9em 0 .75em; padding-bottom: .35em; border-bottom: 1px solid var(--border); font-size: 1.5rem; }
.doc h3 { margin: 1.6em 0 .65em; font-size: 1.22rem; }
.doc h4 { margin: 1.4em 0 .55em; font-size: 1.05rem; }
.doc p { margin: 0 0 1.05em; }
.doc ul, .doc ol { margin: .35em 0 1.15em; padding-left: 1.55em; }
.doc li { margin: .38em 0; padding-left: .2em; }
.doc blockquote {
    margin: 1.3em 0;
    padding: 10px 16px;
    border-left: 4px solid var(--accent);
    border-radius: 0 8px 8px 0;
    color: var(--text-soft);
    background: var(--surface-soft);
}
.doc pre {
    margin: 1.15em 0;
    padding: 16px 18px;
    overflow: auto;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--surface-soft);
    font-family: "JetBrains Mono", "Cascadia Code", "Noto Sans Mono", monospace;
    font-size: 12.5px;
    line-height: 1.65;
    white-space: pre-wrap;
}
.doc hr { margin: 2em 0; border: 0; border-top: 1px solid var(--border-strong); }
.math, .diagram {
    margin: 1.25em 0;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: 11px;
    background: var(--surface-soft);
}
.block-label {
    display: flex;
    align-items: center;
    height: 34px;
    padding: 0 13px;
    gap: 7px;
    color: var(--text-soft);
    border-bottom: 1px solid var(--border);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: .04em;
}
.math pre, .diagram pre { margin: 0; border: 0; border-radius: 0; background: transparent; }
.table-scroll { margin: 1.2em 0; overflow-x: auto; border: 1px solid var(--border); border-radius: 10px; }
table { width: 100%; border-collapse: collapse; background: var(--surface); }
th, td { padding: 10px 12px; border-right: 1px solid var(--border); border-bottom: 1px solid var(--border); text-align: left; }
th { background: var(--surface-soft); font-size: 12px; }
tr:last-child td { border-bottom: 0; }
th:last-child, td:last-child { border-right: 0; }
.source-only, .split-pane {
    display: flex;
    min-height: 100%;
    flex-direction: column;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--surface);
}
.pane-heading {
    display: flex;
    flex: 0 0 38px;
    align-items: center;
    padding: 0 13px;
    color: var(--text-soft);
    background: var(--surface-soft);
    border-bottom: 1px solid var(--border);
    font-size: 11px;
    font-weight: 700;
}
.source-editor {
    display: block;
    width: 100%;
    min-height: 100%;
    flex: 1;
    resize: none;
    padding: 22px 24px 42px;
    border: 0;
    outline: 0;
    color: var(--text);
    background: var(--surface);
    font-family: "JetBrains Mono", "Cascadia Code", "Noto Sans Mono", monospace;
    font-size: 13px;
    line-height: 1.72;
    tab-size: 4;
}
.source-editor:focus { box-shadow: inset 0 0 0 1px var(--accent); }
.split { display: grid; min-height: 100%; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 14px; }
.split-pane .doc { min-height: 100%; padding: 34px 38px 52px; border: 0; border-radius: 0; box-shadow: none; }
.empty-state { min-height: 100%; padding: 42px; }
.empty-mark {
    display: grid;
    place-items: center;
    width: 54px;
    height: 54px;
    margin-bottom: 15px;
    border-radius: 18px 7px 18px 7px;
    color: #fff;
    background: var(--accent);
    font-size: 23px;
    font-weight: 800;
}
.empty-state h2 { margin: 0; color: var(--text); font-size: 20px; }
.empty-state p { max-width: 360px; margin: 9px 0 18px; line-height: 1.65; }
.status {
    display: flex;
    flex: 0 0 30px;
    min-width: 0;
    align-items: center;
    gap: 12px;
    padding: 0 11px;
    overflow: hidden;
    color: var(--text-soft);
    background: var(--surface);
    border-top: 1px solid var(--border);
    font-size: 10px;
}
.status-message { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.status-spacer { flex: 1; }
.status-pill { padding: 2px 7px; border-radius: 999px; color: var(--accent); background: var(--accent-soft); font-weight: 700; }
.error { color: var(--danger); }
@media (max-width: 1120px) {
    .brand-zone { flex-basis: 246px; }
    .panel { flex-basis: 218px; }
    .document-path { display: none; }
    .command .command-label { display: none; }
    .command { min-width: 32px; padding: 6px 8px; }
    .doc { padding: 44px 48px 64px; }
}
@media (max-width: 940px) {
    .document-heading { display: none; }
    .mode-button { padding: 6px 8px; }
    .doc-host { padding: 15px; }
    .doc { padding: 36px 38px 54px; }
}
"#;

fn main() {
    // Dioxus 0.7.9 deprecates `new` when only the native renderer is enabled,
    // although it is also the selector used internally by `dioxus::launch`.
    #[allow(deprecated)]
    dioxus::LaunchBuilder::new()
        .with_cfg(native!({
            use dioxus::native::{Config, LogicalSize, WindowAttributes};
            Config::new().with_window_attributes(
                WindowAttributes::default()
                    .with_title(APP_TITLE)
                    .with_inner_size(LogicalSize::new(1280.0, 800.0))
                    .with_min_inner_size(LogicalSize::new(900.0, 620.0)),
            )
        }))
        .launch(app);
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
    let mut sidebar_open = use_signal(|| true);
    let snapshot = {
        let state = state.read();
        snapshot(&state)
    };
    let current_panel = *panel.read();
    let current_mode = *mode.read();
    let is_dark = *dark.read();
    let is_sidebar_open = *sidebar_open.read();
    let mut class = String::from("app");
    if is_dark {
        class.push_str(" dark");
    }
    if !is_sidebar_open {
        class.push_str(" sidebar-collapsed");
    }
    let can_edit = snapshot.active.is_some();
    let active_dirty = snapshot.active.as_ref().is_some_and(|view| view.dirty);
    let active_name = snapshot
        .active
        .as_ref()
        .map(|view| display_name(&view.path).to_owned())
        .unwrap_or_else(|| "未打开文档".to_owned());
    let active_path = snapshot
        .active
        .as_ref()
        .map(|view| view.path.clone())
        .unwrap_or_else(|| "从文档库打开 Markdown，或创建一个新文档".to_owned());
    let revision_label = snapshot
        .active
        .as_ref()
        .map(|view| format!("版本 {}", view.revision))
        .unwrap_or_default();
    let block_label = snapshot
        .active
        .as_ref()
        .map(|view| format!("{} 个块", view.parsed.blocks.len()))
        .unwrap_or_default();
    let command_label = snapshot
        .active
        .as_ref()
        .map(|view| format!("{} 条绘制命令", view.scene.commands.len()))
        .unwrap_or_default();
    let panel_count = panel_count(current_panel, &snapshot);

    rsx! {
        style { {CSS} }
        main { class: "{class}",
            header { class: "topbar",
                div { class: "brand-zone",
                    button {
                        class: "icon-button",
                        title: if is_sidebar_open { "收起侧栏" } else { "展开侧栏" },
                        onclick: move |_| sidebar_open.set(!is_sidebar_open),
                        if is_sidebar_open { "‹" } else { "›" }
                    }
                    div { class: "brand",
                        span { class: "leaf", "叶" }
                        span { class: "brand-copy",
                            span { class: "brand-title", "LeafMark" }
                            span { class: "brand-subtitle", "NATIVE MARKDOWN" }
                        }
                    }
                }
                div { class: "document-heading",
                    span { class: "document-title", "{active_name}" }
                    span { class: "document-path", "{active_path}" }
                }
                div { class: "top-actions",
                    div { class: "action-group",
                        button {
                            class: "command primary",
                            title: "新建文档",
                            onclick: move |_| mutate_controller(&mut state, |controller| {
                                controller.create_untitled().map(|_| ())
                            }),
                            span { "+" }
                            span { class: "command-label", "新建" }
                        }
                        button {
                            class: if active_dirty { "command primary" } else { "command" },
                            title: "保存当前文档",
                            disabled: !can_edit,
                            onclick: move |_| mutate_controller(&mut state, |controller| {
                                controller.save_active().map(|_| ())
                            }),
                            span { "✓" }
                            span { class: "command-label", "保存" }
                        }
                        button {
                            class: "command",
                            title: "撤销",
                            disabled: !can_edit,
                            onclick: move |_| mutate_controller(&mut state, |controller| {
                                controller.undo_active().map(|_| ())
                            }),
                            "↶"
                        }
                        button {
                            class: "command",
                            title: "重做",
                            disabled: !can_edit,
                            onclick: move |_| mutate_controller(&mut state, |controller| {
                                controller.redo_active().map(|_| ())
                            }),
                            "↷"
                        }
                    }
                    div { class: "mode-switch",
                        for item in ViewMode::ALL {
                            button {
                                class: if item == current_mode { "mode-button active" } else { "mode-button" },
                                title: "切换到{item.label()}模式",
                                onclick: move |_| mode.set(item),
                                {item.label()}
                            }
                        }
                    }
                    button {
                        class: "icon-button",
                        title: if is_dark { "切换到浅色主题" } else { "切换到深色主题" },
                        onclick: move |_| dark.set(!is_dark),
                        if is_dark { "☀" } else { "☾" }
                    }
                }
            }
            section { class: "shell",
                aside { class: "rail",
                    for item in DockPanelId::ALL {
                        button {
                            class: if item == current_panel { "rail-button active" } else { "rail-button" },
                            title: item.label(),
                            onclick: move |_| panel.set(item),
                            span { class: "rail-icon", {panel_icon(item)} }
                            span { class: "rail-label", {item.label()} }
                        }
                    }
                }
                aside { class: "panel",
                    div { class: "panel-header",
                        div { class: "panel-heading",
                            h2 { {current_panel.label()} }
                            p { {panel_description(current_panel)} }
                        }
                        span { class: "count-badge", "{panel_count}" }
                        button {
                            class: "icon-button small",
                            title: "刷新",
                            onclick: move |_| mutate_controller(&mut state, AppController::refresh),
                            "↻"
                        }
                    }
                    div { class: "panel-body",
                        {render_panel(current_panel, &snapshot, state)}
                    }
                }
                section { class: "editor",
                    div { class: "tabs",
                        if snapshot.tabs.is_empty() {
                            div { class: "tabs-placeholder", "工作区" }
                        } else {
                            for tab in snapshot.tabs.iter() {
                                {render_tab(tab, snapshot.active.as_ref().map(|view| &view.id), state)}
                            }
                        }
                    }
                    div { class: "doc-host",
                        if let Some(view) = snapshot.active.as_ref() {
                            {render_document(view, current_mode, state)}
                        } else if let Some(error) = snapshot.error.as_ref() {
                            div { class: "empty-state error",
                                div { class: "empty-mark", "!" }
                                h2 { "无法打开工作区" }
                                p { {error.as_str()} }
                            }
                        } else {
                            div { class: "empty-state",
                                div { class: "empty-mark", "叶" }
                                h2 { "开始一篇 Markdown" }
                                p { "从左侧文档库打开已有文件，或创建新文档。内容会由原生 Rust 编辑器与 AST 管线处理。" }
                                button {
                                    class: "command primary",
                                    onclick: move |_| mutate_controller(&mut state, |controller| {
                                        controller.create_untitled().map(|_| ())
                                    }),
                                    "+ 新建文档"
                                }
                            }
                        }
                    }
                    footer { class: "status",
                        span { class: "status-message", {snapshot.notice.as_str()} }
                        if active_dirty { span { class: "status-pill", "未保存" } }
                        if let Some(error) = snapshot.error.as_ref() {
                            span { class: "error status-message", {error.as_str()} }
                        }
                        span { class: "status-spacer" }
                        span { class: "status-pill", "Native" }
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

fn panel_icon(panel: DockPanelId) -> &'static str {
    match panel {
        DockPanelId::Workspace => "▤",
        DockPanelId::History => "◷",
        DockPanelId::Favorites => "☆",
        DockPanelId::Agent => "AI",
        DockPanelId::Outline => "☷",
    }
}

fn panel_description(panel: DockPanelId) -> &'static str {
    match panel {
        DockPanelId::Workspace => "本地 Markdown 文档",
        DockPanelId::History => "保留的安全副本",
        DockPanelId::Favorites => "固定的重要文档",
        DockPanelId::Agent => "本地 Agent 工作区",
        DockPanelId::Outline => "当前文档结构",
    }
}

fn panel_count(panel: DockPanelId, snapshot: &UiSnapshot) -> usize {
    match panel {
        DockPanelId::Workspace => snapshot
            .workspace
            .iter()
            .filter(|entry| entry.kind == EntryKind::File)
            .count(),
        DockPanelId::History => snapshot.archive.len(),
        DockPanelId::Favorites => snapshot
            .archive
            .iter()
            .filter(|entry| entry.favorite)
            .count(),
        DockPanelId::Agent => 1,
        DockPanelId::Outline => snapshot
            .active
            .as_ref()
            .map_or(0, |view| view.parsed.outline.len()),
    }
}

fn render_panel(panel: DockPanelId, snapshot: &UiSnapshot, state: Signal<UiState>) -> Element {
    match panel {
        DockPanelId::Workspace => rsx! {
            if snapshot.workspace.is_empty() {
                div { class: "panel-empty",
                    strong { "文档库为空" }
                    p { "创建新文档后，它会出现在这里。" }
                }
            } else {
                for entry in snapshot.workspace.iter() {
                    {workspace_entry(entry, state)}
                }
            }
        },
        DockPanelId::History => rsx! {
            if snapshot.archive.is_empty() {
                div { class: "panel-empty",
                    strong { "暂无历史副本" }
                    p { "打开和保存文档后，LeafMark 会保留安全副本。" }
                }
            } else {
                for entry in snapshot.archive.iter() {
                    {archive_entry(entry, state)}
                }
            }
        },
        DockPanelId::Favorites => rsx! {
            for entry in snapshot.archive.iter().filter(|entry| entry.favorite) {
                {archive_entry(entry, state)}
            }
            if !snapshot.archive.iter().any(|entry| entry.favorite) {
                div { class: "panel-empty",
                    strong { "尚无收藏" }
                    p { "收藏的历史副本会固定显示在这里。" }
                }
            }
        },
        DockPanelId::Agent => rsx! {
            div { class: "feature-card",
                strong { "LeafMark Agent" }
                p { "Provider 无关的 Rust Agent 状态机已经接入。账户、工具和可回退文件操作界面仍在迁移。" }
            }
        },
        DockPanelId::Outline => rsx! {
            if let Some(view) = snapshot.active.as_ref() {
                if view.parsed.outline.is_empty() {
                    div { class: "panel-empty",
                        strong { "没有标题" }
                        p { "使用 Markdown 标题后会自动生成大纲。" }
                    }
                } else {
                    for item in view.parsed.outline.iter() {
                        button { class: "outline-row",
                            span { class: "outline-level", "H{item.level}" }
                            span { class: "entry-name", {item.text.as_str()} }
                        }
                    }
                }
            } else {
                div { class: "panel-empty",
                    strong { "未打开文档" }
                    p { "打开文档后可查看结构大纲。" }
                }
            }
        },
    }
}

fn workspace_entry(entry: &DocumentEntry, mut state: Signal<UiState>) -> Element {
    let path = entry.path.clone();
    let name = entry.name.clone();
    let size = format_size(entry.size);
    let padding = format!("padding-left:{}px", 8 + entry.depth * 14);
    if entry.kind == EntryKind::Directory {
        return rsx! {
            div { class: "folder", style: "{padding}",
                span { class: "entry-icon", "▾" }
                span { class: "entry-name", {name.as_str()} }
            }
        };
    }
    rsx! {
        button {
            class: "entry",
            style: "{padding}",
            title: "打开{name}",
            onclick: move |_| {
                let path = path.clone();
                mutate_controller(&mut state, |controller| {
                    controller.open_workspace(&path).map(|_| ())
                });
            },
            span { class: "entry-icon", "M" }
            span { class: "entry-name", {name.as_str()} }
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
        "◇"
    };
    rsx! {
        button {
            class: "entry",
            title: "打开{name}",
            onclick: move |_| {
                let id = id.clone();
                mutate_controller(&mut state, |controller| {
                    controller.open_archive(&id).map(|_| ())
                });
            },
            span { class: "entry-icon", {marker} }
            span { class: "entry-name", {name.as_str()} }
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
    let label = display_name(&tab.path).to_owned();
    let is_active = active == Some(&tab.id);
    let tab_class = if is_active { "tab active-tab" } else { "tab" };
    rsx! {
        div { class: "{tab_class}",
            button {
                class: "tab-select",
                title: "{tab.path}",
                onclick: move |_| {
                    let id = activate_id.clone();
                    mutate_controller(&mut activate_state, |controller| {
                        controller.activate(&id)
                    });
                },
                span { class: "tab-name", {label.as_str()} }
                if tab.dirty { span { class: "dirty-dot" } }
            }
            button {
                class: "tab-close",
                title: "关闭",
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

fn render_document(view: &RuntimeDocumentView, mode: ViewMode, state: Signal<UiState>) -> Element {
    let source = view.source.clone();
    match mode {
        ViewMode::Source => rsx! {
            div { class: "source-only",
                div { class: "pane-heading", "MARKDOWN 源码" }
                {source_editor(source, state)}
            }
        },
        ViewMode::Split => rsx! {
            div { class: "split",
                section { class: "split-pane",
                    div { class: "pane-heading", "MARKDOWN" }
                    {source_editor(source, state)}
                }
                section { class: "split-pane",
                    div { class: "pane-heading", "实时预览" }
                    article { class: "doc", {render_blocks(view)} }
                }
            }
        },
        ViewMode::Read | ViewMode::Live => rsx! {
            article { class: "doc", {render_blocks(view)} }
        },
    }
}

fn source_editor(source: String, mut state: Signal<UiState>) -> Element {
    rsx! {
        textarea {
            class: "source-editor",
            value: source,
            spellcheck: "false",
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
        BlockKind::CodeBlock { .. } => {
            let body = fenced_body(&raw);
            rsx!(pre { code { {body.as_str()} } })
        }
        BlockKind::Mermaid => {
            let body = fenced_body(&raw);
            rsx!(div { class: "diagram",
                div { class: "block-label", "◇ Mermaid 图表源码" }
                pre { {body.as_str()} }
            })
        }
        BlockKind::MathBlock => {
            let body = fenced_body(&raw);
            rsx!(div { class: "math",
                div { class: "block-label", "∑ 数学公式" }
                pre { {body.as_str()} }
            })
        }
        BlockKind::Table => render_table(&raw),
        BlockKind::List { start } => render_list(&raw, start.is_some()),
        BlockKind::Rule => rsx!(hr {}),
        _ => rsx!(p { {text.as_str()} }),
    }
}

fn render_list(raw: &str, ordered: bool) -> Element {
    let items = list_items(raw);
    if ordered {
        rsx! {
            ol {
                for item in items.iter() {
                    li { {item.as_str()} }
                }
            }
        }
    } else {
        rsx! {
            ul {
                for item in items.iter() {
                    li { {item.as_str()} }
                }
            }
        }
    }
}

fn list_items(raw: &str) -> Vec<String> {
    raw.lines()
        .filter_map(|line| {
            let line = line.trim();
            let item = ["- ", "* ", "+ "]
                .iter()
                .find_map(|prefix| line.strip_prefix(prefix))
                .or_else(|| {
                    let (number, value) = line.split_once(". ")?;
                    number
                        .chars()
                        .all(|character| character.is_ascii_digit())
                        .then_some(value)
                })?;
            let item = item.trim();
            (!item.is_empty()).then(|| item.to_owned())
        })
        .collect()
}

fn render_table(raw: &str) -> Element {
    let rows = table_rows(raw);
    let Some((head, body)) = rows.split_first() else {
        return rsx!(pre { {raw} });
    };
    rsx! {
        div { class: "table-scroll",
            table {
                thead {
                    tr {
                        for cell in head.iter() {
                            th { {cell.as_str()} }
                        }
                    }
                }
                tbody {
                    for row in body.iter() {
                        tr {
                            for cell in row.iter() {
                                td { {cell.as_str()} }
                            }
                        }
                    }
                }
            }
        }
    }
}

fn table_rows(raw: &str) -> Vec<Vec<String>> {
    raw.lines()
        .filter_map(|line| {
            let line = line.trim().trim_matches('|');
            if line.is_empty() {
                return None;
            }
            let cells: Vec<String> = line.split('|').map(|cell| cell.trim().to_owned()).collect();
            let separator = cells.iter().all(|cell| {
                let cell = cell.trim_matches(':');
                !cell.is_empty() && cell.chars().all(|character| character == '-')
            });
            (!separator).then_some(cells)
        })
        .collect()
}

fn fenced_body(raw: &str) -> String {
    let mut lines: Vec<&str> = raw.lines().collect();
    if lines
        .first()
        .is_some_and(|line| line.trim_start().starts_with("```"))
    {
        lines.remove(0);
    }
    if lines
        .last()
        .is_some_and(|line| line.trim_start().starts_with("```"))
    {
        lines.pop();
    }
    lines.join("\n")
}

fn source_fragment(source: &str, range: SourceRange) -> String {
    range.slice(source).unwrap_or_default().to_owned()
}

fn display_name(path: &str) -> &str {
    path.rsplit(['/', '\\']).next().unwrap_or(path)
}

fn format_size(size: u64) -> String {
    if size < 1024 {
        format!("{size} B")
    } else if size < 1024 * 1024 {
        format!("{:.1} KiB", size as f64 / 1024.0)
    } else {
        format!("{:.1} MiB", size as f64 / (1024.0 * 1024.0))
    }
}
