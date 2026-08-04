# LeafMark Native

LeafMark Native 是 LeafMark 从 Tauri/WebView 迁移到 Dioxus Native 的并行开发主线。现有 0.7.x Tauri 正式版仍保留在仓库根目录；原生版达到功能对等之前不会删除旧实现，也不会修改旧版用户数据。

## v0.8.0-alpha.1

第一版 Native Alpha 已形成可运行闭环：

- Dioxus Native 0.7.9 + WGPU/Blitz，不依赖 WebView2；
- 输入工作区目录，递归扫描 `.md` / `.markdown`；
- 遵守 `.gitignore`、`.ignore`、`.markignore`，跳过常见构建目录；
- 支持通过命令行参数直接打开目录或 Markdown 文件；
- 多文档标签、激活、关闭和未保存保护；
- 源码、阅读、分栏和 Alpha 实时预览模式；
- UTF-8、UTF-8 BOM、UTF-16 LE/BE 文档读取；
- 路径穿越与工作区逃逸防护；
- 32 MiB 文档安全上限；
- 原子保存；
- 原生 Markdown 语义模型与 UTF-8 源码范围；
- 标题大纲、段落、引用、列表、表格、任务列表、脚注、代码、数学与 Mermaid 语义识别；
- 原始 HTML 仅以文本显示，不执行；
- 浅色和深色主题。

### 当前限制

这是架构验证和早期可用版，不是对 0.7.5 的完全替代：

- Mermaid 目前显示源码，尚未接入 Merman 图形渲染；
- 数学公式目前显示源码，尚未接入 RaTeX；
- 实时模式当前是源码与原生预览同步，不是完整所见即所得编辑器；
- 尚未接入历史、收藏、Agent、OAuth、MCP、终端和 Agent VCS；
- 尚未接入 HTML、PNG、PDF 导出；
- 尚未发布 Android Native 版本；
- 中文输入法仍依赖 Blitz 当前的文本输入能力，专用 IME 层将在后续版本实现。

## 运行

Windows：解压 ZIP 后运行 `LeafMark-Native.exe`。可以把工作区目录或 Markdown 文件作为第一个命令行参数传入。

Linux：解压 tar.gz 后执行：

```bash
chmod +x LeafMark-Native
./LeafMark-Native /path/to/markdown-workspace
```

Linux 版使用系统 WGPU、X11/Wayland 与字体库，需要现代桌面发行版提供相应运行库。

## 开发

```bash
cd native
cargo test -p leafmark-domain -p leafmark-core -p leafmark-markdown -p leafmark-workspace
cargo run -p leafmark-native -- /path/to/workspace
```

## 架构约束

1. Markdown 源码始终是唯一真实数据；
2. UI 只派发动作，不直接承担文件系统安全策略；
3. Tauri command 中的业务逻辑逐步下沉到可复用 Rust crate；
4. 文档编辑区最终使用自定义原生绘制面，而不是把 Blitz DOM 当作完整 `contenteditable`；
5. 屏幕、HTML、PNG 和 PDF 将共享同一语义文档及布局结果；
6. 迁移期间保持现有数据目录、历史快照和 Agent VCS 格式兼容。
