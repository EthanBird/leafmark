# LeafMark Native

LeafMark Native 是 LeafMark 从 Tauri/WebView 迁移到 Dioxus Native 的并行开发主线。现有 0.7.x Tauri 正式版仍保留在仓库根目录；原生版达到功能对等之前不会删除旧实现，也不会修改旧版用户数据。

## v0.8.0-alpha.2

本版本将原生实现收口到 Windows、Linux 和 Android 三端，并完成第一轮桌面界面重构：

- Dioxus Native 0.7.9 + Blitz/WGPU，不依赖 WebView2；
- Windows x64 使用 GUI subsystem，启动时不显示终端窗口；
- Linux x86_64 使用原生 X11/Wayland 窗口；
- Android arm64 使用 Dioxus Native 实验性渲染器，不使用 Android WebView；
- Android 文档库写入应用专属目录，不申请广泛存储权限；
- 统一 Rust 文档运行时、Rope 编辑器、Markdown AST、历史副本和安全存储层；
- 多文档标签、未保存标记、关闭保护、撤销和重做；
- 源码、阅读、分栏和实时预览模式；
- 文档库、历史、收藏、Agent 占位页和大纲导航；
- UTF-8、UTF-8 BOM、UTF-16 LE/BE 文档读取；
- `.gitignore`、`.ignore`、`.markignore` 与常见构建目录过滤；
- 路径穿越和工作区逃逸防护、32 MiB 文档安全上限、原子保存；
- 标题、段落、引用、列表、表格、任务列表、脚注、代码、数学和 Mermaid 语义识别；
- 浅色与深色主题，以及适配窄窗口的可收起侧栏。

### Linux UI 重构

桌面界面不再沿用早期调试式布局。本版本调整了：

- 正式应用标题、1280 × 800 默认窗口和最小窗口尺寸；
- 单层顶部操作栏与清晰的文档标题、路径和视图模式分组；
- 图标加文字的主导航、结构化文档库和可收起侧栏；
- 标签页、空白页、源码编辑器、分栏阅读和底部状态信息；
- 正文宽度、留白、层级、代码块、引用、列表和表格排版；
- Mermaid 与数学块的源码提示样式，避免被误认为已经完成图形渲染。

### 当前限制

这是 Alpha 版本，仍不是对 0.7.5 的完全替代：

- Mermaid 目前显示结构化源码卡片，尚未接入 Merman 图形渲染；
- 数学公式目前显示源码，尚未接入 RaTeX；
- 实时模式是源码与原生预览同步，不是完整所见即所得编辑器；
- Agent 页面尚未接入 OAuth、MCP、终端和 Agent VCS；
- 尚未接入 HTML、PNG、PDF 导出；
- Android 文件夹选择仍需接入 Storage Access Framework；
- Android Native 渲染器仍属于 Dioxus 0.7.9 的实验性路径；
- 中文输入法依赖 Blitz 当前的文本输入能力，专用 IME 层将在后续版本实现。

## 运行

Windows：解压 ZIP 后运行 `LeafMark-Native.exe`。可以把工作区目录或 Markdown 文件作为第一个命令行参数传入。

Linux：解压 tar.gz 后执行：

```bash
chmod +x leafmark-native
./leafmark-native /path/to/markdown-workspace
```

Linux 版使用系统 WGPU、X11/Wayland 与字体库，需要现代桌面发行版提供相应运行库。

Android：安装 arm64 APK。文档与历史副本默认保存在应用专属外部目录的 `LeafMark` 文件夹中。

## 开发

```bash
cd native
cargo test --workspace --all-targets --locked
cargo run -p leafmark-native -- /path/to/workspace
```

Android Native APK：

```bash
cd native/apps/leafmark-android
dx bundle --android --renderer native --target aarch64-linux-android \
  --package-types apk --release
```

## 架构约束

1. Markdown 源码始终是唯一真实数据；
2. UI 只派发动作，不直接承担文件系统安全策略；
3. Tauri command 中的业务逻辑逐步下沉到可复用 Rust crate；
4. 文档编辑区最终使用自定义原生绘制面，而不是把 Blitz DOM 当作完整 `contenteditable`；
5. 屏幕、HTML、PNG 和 PDF 将共享同一语义文档及布局结果；
6. 迁移期间保持现有数据目录、历史快照和 Agent VCS 格式兼容。
