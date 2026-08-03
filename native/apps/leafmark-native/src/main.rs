use dioxus::prelude::*;
use leafmark_core::normalize_layout;
use leafmark_domain::{DesktopDockLayout, DockPanelId, ViewMode};

const CSS: &str = r#"
:root{font-family:'Noto Sans CJK SC','Microsoft YaHei UI',sans-serif;background:#eef1eb;color:#243027}*{box-sizing:border-box}button{font:inherit}.app{--s:#f7f8f4;--r:#fff;--m:#eef1eb;--t:#243027;--b:#d7ddd4;--a:#315f40;display:flex;flex-direction:column;height:100vh;min-width:780px;background:var(--s);color:var(--t)}.dark{--s:#171a17;--r:#242a25;--m:#1e231f;--t:#e7ece7;--b:#343c35;--a:#8fbc99}.title,.toolbar,.status{display:flex;align-items:center;background:var(--r);border-color:var(--b)}.title{height:52px;justify-content:space-between;padding:0 14px;border-bottom:1px solid var(--b)}.brand{display:flex;gap:9px;align-items:center}.leaf{padding:6px 9px;border-radius:9px 3px;background:var(--a);color:white}.toolbar{height:47px;gap:6px;padding:7px 12px;border-bottom:1px solid var(--b)}button{border:0;border-radius:7px;padding:7px 10px;color:var(--t);background:transparent}.primary,.active{background:var(--a);color:white}.spacer{flex:1}.shell{display:flex;flex:1;min-height:0}.rail{width:72px;padding:7px;background:var(--m);border-right:1px solid var(--b)}.rail button{display:block;width:100%;margin-bottom:4px;font-size:12px}.panel{width:276px;background:var(--r);border-right:1px solid var(--b)}.panel h3{margin:0;padding:13px;border-bottom:1px solid var(--b)}.panel-body{padding:12px;line-height:1.8}.editor{display:flex;flex:1;min-width:0;flex-direction:column}.tabs{height:38px;background:var(--m);border-bottom:1px solid var(--b)}.tabs button{height:38px;border-radius:0}.doc-host{flex:1;overflow:auto;padding:32px}.doc{max-width:860px;min-height:100%;margin:auto;padding:42px 52px;border:1px solid var(--b);border-radius:13px;background:var(--r);line-height:1.75}.callout{padding:12px;border:1px solid var(--a);border-radius:9px;color:var(--a)}pre{padding:13px;border-radius:8px;background:var(--m);overflow:auto}.status{height:27px;gap:13px;padding:0 11px;border-top:1px solid var(--b);font-size:11px}
"#;

fn main() {
    dioxus::launch(app);
}

fn app() -> Element {
    let mut panel = use_signal(|| DockPanelId::Workspace);
    let mut mode = use_signal(|| ViewMode::Live);
    let mut dark = use_signal(|| false);
    let current_panel = *panel.read();
    let current_mode = *mode.read();
    let layout = normalize_layout(DesktopDockLayout::default());
    let class = if *dark.read() { "app dark" } else { "app" };

    rsx! {
        style { {CSS} }
        main { class: "{class}",
            header { class: "title",
                div { class: "brand", span { class: "leaf", "叶" } strong { "LeafMark Native" } }
                button { onclick: move |_| { let next = !*dark.read(); dark.set(next); }, "切换主题" }
            }
            nav { class: "toolbar",
                button { class: "primary", "+ 新建文档" }
                button { "打开" }
                button { "保存" }
                for item in ViewMode::ALL {
                    button {
                        class: if item == current_mode { "active" } else { "" },
                        onclick: move |_| mode.set(item),
                        "{item.label()}"
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
                            "{item.label()}"
                        }
                    }
                }
                aside { class: "panel",
                    h3 { "{current_panel.label()}" }
                    div { class: "panel-body", {panel_text(current_panel)} }
                }
                section { class: "editor",
                    div { class: "tabs", button { class: "active", "欢迎.md  ×" } button { "迁移计划.md  ×" } }
                    div { class: "doc-host",
                        article { class: "doc",
                            div { class: "callout", strong { "原生文档画布插槽" } br {} "当前先验证 Dioxus Native 壳层，后续接入 Parley/Vello。" }
                            h1 { "欢迎使用 LeafMark Native" }
                            p { "这一分支不会破坏现有 Tauri 0.7.x，而是逐步建立完全原生的 Rust 应用边界。" }
                            h2 { "N0 已接通" }
                            ul { li { "纯 Rust 多标签状态机" } li { "纯 Rust Dock 布局状态机" } li { "独立 Native CI" } }
                            pre { "Markdown source → AST → Native Scene → WGPU / PDF / PNG" }
                        }
                    }
                    footer { class: "status",
                        span { "视图：{current_mode.label()}" }
                        span { class: "spacer" }
                        span { "左 Dock：{layout.left_size}px" }
                        span { "Dioxus Native 0.7.9" }
                    }
                }
            }
        }
    }
}

fn panel_text(panel: DockPanelId) -> &'static str {
    match panel {
        DockPanelId::Workspace => "LeafMark / 欢迎.md / 迁移计划.md",
        DockPanelId::History => "历史快照将复用现有数据格式。",
        DockPanelId::Favorites => "收藏与私有副本不会丢失。",
        DockPanelId::Agent => "Agent Provider、SSE 与工具循环将迁入 Rust。",
        DockPanelId::Outline => "欢迎使用 LeafMark Native / N0 已接通",
    }
}
