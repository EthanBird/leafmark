# LeafMark Native

这是 LeafMark 从 Tauri/WebView 迁移到 Dioxus Native 的并行开发工作区。当前正式版仍保留在仓库根目录；`native/` 不参与现有 Tauri 发布流程，也不会改变 0.7.x 用户数据。

## 当前进度

### N0：原生骨架

- 独立 Cargo Workspace，不干扰现有 Node/Tauri 构建；
- `leafmark-domain`：稳定的跨 UI 数据模型；
- `leafmark-core`：多文档标签和 Dock 布局纯 Rust 状态机；
- `leafmark-native`：Dioxus Native/WGPU 原型外壳；
- Native CI：单元测试、Clippy 和 Dioxus Native 编译检查。

### N1：Markdown 语义模型（进行中）

- `leafmark-markdown` 使用 `pulldown-cmark` 直接生成原生语义模型，不以 HTML 为中间状态；
- 为块、行内样式和文本 Token 保留 UTF-8 源码字节范围；
- 已识别标题、大纲、引用、GFM 表格与任务列表、脚注、代码块、数学和 Mermaid；
- 原始 HTML 只作为不可执行数据保留；
- 大纲 ID 支持中文并对重复标题稳定去重。

当前原型验证应用壳层、状态边界和原生文档模型。原生排版画布、IME、公式、Mermaid 图形、导出和 Agent 将继续逐步接入，现有 Tauri 版本在功能对等之前不会删除。

## 开发

```bash
cd native
cargo test -p leafmark-domain -p leafmark-core -p leafmark-markdown
cargo run -p leafmark-native
```

Dioxus Native 当前使用 WGPU/Blitz，不依赖 WebView2。Linux 构建需要 X11/Wayland、字体和输入相关开发库，CI 工作流包含 Ubuntu 依赖示例。

## 架构约束

1. Markdown 源码始终是唯一真实数据；
2. UI 只派发动作，不直接操作文件系统；
3. Tauri command 中的业务逻辑逐步下沉到 `leafmark-core`；
4. 文档编辑区最终使用自定义原生绘制面，而不是把 Blitz DOM 当作 `contenteditable`；
5. 屏幕、HTML、PNG 和 PDF 共享同一语义文档及布局结果；
6. 迁移期间保持现有数据目录、历史快照和 Agent VCS 格式兼容。
