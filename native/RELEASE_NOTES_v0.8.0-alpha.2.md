# LeafMark Native v0.8.0-alpha.2

这是 LeafMark 纯原生桌面版的公开预发行版本，使用 Rust、Dioxus Native、Blitz 与 WGPU 构建，不依赖 WebView2。它与 LeafMark 0.7.5 Tauri 正式版并行发布。

## 本次更新

- 修正 Markdown 标题源码范围的换行边界测试；
- 接入兼容旧版数据格式的原生设置存储 crate；
- 统一 Native 工作区格式并通过完整测试、检查和 Clippy；
- 提供 Windows x64 ZIP 与 Linux x86_64 tar.gz，以及对应 SHA-256 校验文件。

## 当前可用

- 打开本地 Markdown 工作区或通过命令行直接打开 Markdown 文件；
- 递归扫描 `.md`、`.markdown`，支持忽略规则与工作区边界保护；
- 多标签、未保存保护、源码/阅读/分栏/实时预览模式；
- UTF-8、UTF-8 BOM、UTF-16 LE/BE 读取与原子保存；
- Markdown 语义模型、标题大纲、表格、任务列表、脚注、代码、数学与 Mermaid 语义识别；
- 浅色和深色主题。

## 说明

这是 Native Alpha，不是 0.7.5 的完全替代版。Mermaid 与数学图形渲染、完整所见即所得、历史收藏、Agent、导出、Android Native 和专用 IME 层仍在迁移中。普通用户应继续使用 0.7.5；本版本主要用于测试纯原生架构和兼容性。
