# LeafMark Native v0.8.0-alpha.1

这是 LeafMark 移除 WebView 依赖后的第一个公开预发行版本。它使用 Rust、Dioxus Native、Blitz 与 WGPU 构建，和现有 LeafMark 0.7.5 Tauri 正式版并行发布。

## 可以使用的功能

- 打开本地 Markdown 工作区；
- 扫描和刷新 `.md`、`.markdown` 文件；
- 多标签打开文档；
- 编辑 Markdown 源码并原子保存；
- 阅读、源码、分栏和同步预览模式；
- 标题大纲；
- GFM、代码、数学和 Mermaid 的原生语义识别；
- UTF-8 / UTF-16 文档读取；
- 浅色和深色主题；
- Windows x64 与 Linux x86_64 压缩包。

## 安全与数据

- 只允许访问所选工作区内的 Markdown 文件；
- 拒绝 `..` 路径穿越和符号链接逃逸；
- 单篇文档限制为 32 MiB；
- 保存使用同目录原子替换；
- 原始 HTML 不执行；
- 不会修改 0.7.x 的设置、历史、收藏或 Agent 数据。

## 尚未包含

这不是 0.7.5 的完全替代版。Mermaid/数学图形渲染、完整所见即所得、历史收藏、Agent、导出、Android Native 和专用 IME 层仍在迁移中。

建议普通用户继续使用 0.7.5；该版本主要面向希望提前测试纯原生架构、性能和兼容性的用户。
