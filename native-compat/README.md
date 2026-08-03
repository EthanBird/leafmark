# LeafMark Windows 原生兼容版

这是为没有 Microsoft Edge WebView2 Runtime 的 Windows 电脑准备的独立兼容版。

- 使用 Rust/Iced 原生窗口与 CPU `tiny-skia/softbuffer` 绘制，不使用 Tauri、WebView2、Chromium、CEF、浏览器页面或本地网页服务器。
- 解压后直接运行 `LeafMark.exe`；不安装运行时，不需要管理员权限。
- 不注册默认应用、资源管理器右键菜单、开始菜单、卸载项，也不读写 LeafMark 文件关联注册表。
- 与标准版共用文档库、历史记录、收藏和保留副本。
- 微信等应用更换临时路径后，会用不可变 SHA-256 源指纹复用已有副本，不覆盖副本中的编辑。
- 支持标签页、文档库、历史、收藏、保留副本、自动保存、源码编辑与分栏实时预览，以及八套主题组合。
- 兼容版侧重可靠的 Markdown 阅读与编辑；完整网页排版、全量 Mermaid/KaTeX、PDF/PNG 导出、Typora 式所见即所得和 Agent 编排仍请使用标准版。兼容版不会通过浏览器偷偷补齐这些功能。

Windows 系统组件和显卡驱动自身可能读取系统配置；这里保证的是 LeafMark 兼容版没有注册表集成代码，也不会修改 LeafMark 文件关联。

原生版和标准版会读取同一份历史索引。请不要同时运行两个版本并修改历史/收藏；切换版本前先关闭另一个窗口，避免两个进程同时提交索引。
