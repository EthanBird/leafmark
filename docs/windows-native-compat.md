# Windows 原生兼容版

Windows 原生兼容版面向没有 WebView2 Runtime、不能或不希望安装 WebView2 的电脑。它是一个独立的 Rust 原生程序，不是把网页放进另一种浏览器壳。

## 运行边界

- 不包含、下载或安装 WebView2。
- 不依赖 Tauri、Wry、CEF、Chromium、Electron 或外部浏览器作为应用界面。
- 使用 Iced 与 `tiny-skia/softbuffer` 在 CPU 上直接绘制控件，不要求可用的 OpenGL、Vulkan 或 DirectX 12 显卡驱动。
- 免安装、无需管理员权限，不创建文件关联、右键菜单、卸载项或任何 LeafMark 注册表项。
- 不启动本地 HTTP 服务，不用浏览器页面承载编辑器，也不会弹出命令行窗口。

Windows 和显卡驱动等系统组件内部仍可能读取系统配置；上面的保证指 LeafMark 自身不包含注册表集成代码，也不修改 LeafMark 文件关联。

## 使用方式

从 Release 下载文件名含 `Windows_x64_Native-Compat` 的 ZIP，解压后直接运行 `LeafMark.exe`。压缩包只有可执行文件、使用说明与第三方许可说明，不带 DLL、HTML、JavaScript、WebView2 或浏览器资源。

可以把 `.md` / `.markdown` 文件拖到窗口，或使用“打开文档”。也可以在 Windows“打开方式”中手动选择这个 `LeafMark.exe`；兼容版本身不会修改注册表。

兼容版会优先读取标准版的工作区设置，并共用：

- `%APPDATA%\com.leafmark.desktop\document-library`：历史、收藏与保留副本；
- 设置中已有的 `workspacePath`，默认是 `%USERPROFILE%\Documents\LeafMark`：可编辑文档库。

从微信、邮件或下载目录打开的文件仍先保存为 LeafMark 保留副本。编辑时只写副本，不会回写或占用来源文件；保存到文档库后才成为普通可编辑文档。
兼容版会为首次导入的源内容保存独立 SHA-256 指纹；微信更换临时路径后再次打开同一附件，仍会激活原保留副本，即使该副本后来已经编辑过，也不会重复复制或覆盖编辑。

原生版和标准版读取同一份历史索引。切换版本前请先关闭另一个版本，不要让两个版本同时修改历史或收藏，避免两个独立进程同时提交索引。

## 原生版功能

- 多文档标签页与关闭按钮；
- Markdown 源码编辑与分栏实时预览；
- 文档库、历史和收藏；
- 自动保存、手动保存与保留副本；
- 一叶绿、樱花粉、清川蓝、黑白灰的浅色/深色主题；
- 系统中文字体回退、原生窗口标题栏和原生文件选择框。

兼容版优先解决基础阅读、编辑与数据安全。标准版中依赖完整网页排版环境的 Typora 式原位编辑、全量 Mermaid/KaTeX、PDF/PNG 排版导出以及 Agent 工作区暂不在这个小体积原生版本内。它不会用浏览器偷偷补齐这些功能。

## 发布门禁

GitHub Actions 会对原生兼容包做以下检查：

- Rust 依赖树不得出现 Tauri、Wry、WebView2、CEF、Chromium、V8 或 Electron；
- PE 导入和二进制字符串不得出现 WebView2/CEF 初始化符号或浏览器资源；
- 必须是 x64 GUI 子系统、`asInvoker`，且能启动出真实主窗口；
- 不得产生浏览器/命令行子进程或本地 TCP 监听；
- 压缩包严格只允许三个文件，并设置体积上限。
