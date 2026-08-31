<!-- release-version: 0.8.2 -->

- 以 v0.7.2 的 UI、主题、Agent、文档移动、Mermaid 矢量 PDF 与全平台产品树为唯一基线。
- 0.8 起可在本机编辑 Word、Excel、PowerPoint；OOXML 使用原生模型，未修改部件原样写回。
- 0.8.2：Word / PPT / Excel 可按真实 OOXML 打开后改字、插表、拖选；图片、合并单元格、冻结窗格与浮动图会正常绘制，而不是变成标签源代码。
- 0.8.2：PDF 使用 PDF.js 浅色纸面；代码高亮使用 GitHub 风格配色。PDF 仍只读，旧版 `.doc` / `.ppt` 仍回退系统应用。
- 0.8.1：Markdown / 代码 / Word / Excel / PPT 支持划词问 AI；助手回答可复制或保存为 Markdown。
- 不执行 VBA / 宏，不保证 SmartArt、透视图、动画和完整母版的像素级还原；LeafMark 不是 OnlyOffice / WPS 的完整替代。

Android 请下载 ARM64 APK；Windows 请下载 NSIS 安装程序；Linux 可选择 AppImage 或 `.deb`。

Windows NSIS、Android ARM64 APK、Linux AppImage 和 `.deb` 均由 `main` 上的 `release.yml` 构建；只有在平台校验、资产大小与 GitHub SHA-256 摘要全部通过后，release 才会从 draft 发布为 Latest。
