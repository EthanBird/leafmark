use dioxus::prelude::*;
use leafmark_core::normalize_layout;
use leafmark_domain::{DesktopDockLayout, DockPanelId, ViewMode};
use leafmark_markdown::parse_markdown;

const SAMPLE: &str = r#"# 欢迎使用 LeafMark Native

这一分支不会破坏现有 Tauri 0.7.x，而是逐步建立完全原生的 Rust 应用边界。

## 原生语义层

行内公式 $E=mc^2$、**粗体**和 [本地链接](迁移计划.md) 已经保留源码范围。

```mermaid
flowchart LR
  Markdown --> AST
  AST --> NativeScene
```

| 层级 | 状态 |
| --- | --- |
| Domain | 已建立 |
| Markdown AST | 已接入 |
| Native Scene | 下一步 |
"#;

const CSS: &str = r#"
:root{font-family:'Noto Sans CJK SC','Microsoft YaHei UI',sans-serif;background:#eef1eb;color:#243027}*{box-sizing:border-box}button{font:inherit}.app{--s:#f7f8f4;--r:#fff;--m:#eef1eb;--t:#243027;--b:#d7ddd4;--a:#315f40;display:flex;flex-direction:column;height:100vh;min-width:780px;background:var(--s);color:var(--t)}.dark{--s:#171a17;--r:#242a25;--m:#1e231f;--t:#e7ece7;--b:#343c35;--a:#8fbc99}.title,.toolbar,.status{display:flex;align-items:center;background:var(--r);border-color:var(--b)}.title{height:52px;justify-content:space-between;padding:0 14px;border-bottom:1px solid var(--b)}.brand{display:flex;gap:9px;align-items:center}.leaf{padding:6px 9px;border-radius:9px 3px;background:var(--a);color:white}.toolbar{height:47px;gap:6px;padding:7px 12px;border-bottom:1px solid var(--b)}button{border:0;border-radius:7px;padding:7px 10px;color:var(--t);background:transparent}.primary,.active{background:var(--a);color:white}.spacer{flex:1}.shell{display:flex;flex:1;min-height:0}.rail{width:72px;padding:7px;background:var(--m);border-right:1px solid var(--b)}.rail button{display:block;width:100%;margin-bottom:4px;font-size:12px}.panel{width:276px;background:var(--r);border-right:1px solid var(--b)}.panel h3{margin:0;padding:13px;border-bottom:1px solid var(--b)}.panel-body{padding:12px;line-height:1.8}.outline-row{display:flex;gap:8px;padding:3px 0}.outline-level{min-width:25px;color:var(--a);font-weight:700}.editor{display:flex;flex:1;min-width:0;flex-direction:column}.tabs{height:38px;background:var(--m);border-bottom:1px solid var(--b)}.tabs button{height:38px;border-radius:0}.doc-host{flex:1;overflow:auto;padding:32px}.doc{max-width:860px;min-height:100%;margin:auto;padding:42px 52px;border:1px solid var(--b);border-radius:13px;background:var(--r);line-height:1.75}.callout{padding:12px;border:1px solid var(--a);border-radius:9px;color:var(--a)}.semantic{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin:20px 0}.metric{padding:12px;border-radius:9px;background:var(--m)}.metric strong{display:block;font-size:22px;color:var(--a)}pre{padding:13px;border-radius:8px;background:var(--m);overflow:auto}.status{height:27px;gap:13px;padding:0 11px;border-top:1px solid var(--b);font-size:11px}
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
    let current_panel_label = current_panel.label();
    let current_mode_label = current_mode.label();
    let layout = normalize_layout(DesktopDockLayout::default());
    let class = if *dark.read() { "app dark" } else { "app" };
    let document = parse_markdown(SAMPLE);
    let block_count = document.blocks.len();
    let token_count = document.tokens.len();
    let outline_count = document.outline.len();

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
                button { class: "primary", "+ 新建文档" }
                button { "打开" }
                button { "保存" }
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
                    h3 { {current_panel_label} }
                    div { class: "panel-body",
                        if current_panel == DockPanelId::Outline {
                            for item in document.outline.iter() {
                                div { class: "outline-row",
                                    span { class: "outline-level", "H{item.level}" }
                                    span { {item.text.as_str()} }
                                }
                            }
                        } else {
                            {panel_text(current_panel)}
                        }
                    }
                }
                section { class: "editor",
                    div { class: "tabs",
                        button { class: "active", "欢迎.md  ×" }
                        button { "迁移计划.md  ×" }
                    }
                    div { class: "doc-host",
                        article { class: "doc",
                            div { class: "callout",
                                strong { "Markdown AST 已接入原生壳" }
                                br {}
                                "下方统计直接来自 leafmark-markdown，不经过 HTML 或 JavaScript。"
                            }
                            div { class: "semantic",
                                div { class: "metric", strong { "{block_count}" } "语义块" }
                                div { class: "metric", strong { "{token_count}" } "源码 Token" }
                                div { class: "metric", strong { "{outline_count}" } "大纲节点" }
                            }
                            h1 { "欢迎使用 LeafMark Native" }
                            p { "Markdown 源码现在可解析为带 UTF-8 字节范围的原生语义模型。" }
                            h2 { "下一层" }
                            ul {
                                li { "Parley 文本排版与命中测试" }
                                li { "Vello/WGPU 文档场景" }
                                li { "Rope 文本缓冲与 EditTransaction" }
                            }
                            pre { "Markdown source → AST → Native Scene → WGPU / PDF / PNG" }
                        }
                    }
                    footer { class: "status",
                        span { "视图：{current_mode_label}" }
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
        DockPanelId::Outline => "",
    }
}
