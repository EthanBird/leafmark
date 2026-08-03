# LeafMark Windows 便携版

这是免安装版本。解压 ZIP 后直接运行 `LeafMark.exe`：

- 不运行安装程序，也不请求管理员权限。
- LeafMark 不查询或写入自己的 Windows 文件关联注册表。
- 不创建开始菜单项、桌面快捷方式或卸载项。
- 仍可从应用内打开文件，或把 `.md` / `.markdown` 文件拖到 `LeafMark.exe` 上。

为了遵守“不走注册表”的约束，便携版不会提供“设为 Markdown 默认应用”和资源管理器右键注册；需要这些功能时请使用 NSIS 安装版。

设置、历史保留副本、Agent 登录与版本记录仍存放在当前 Windows 用户的应用数据目录中，文档库默认位于“文档\LeafMark”。这些位置不需要管理员权限，并可避免把隐私数据写进程序目录。便携版和安装版会沿用同一份用户数据。

LeafMark 使用 Microsoft Edge WebView2。便携版不会修改系统或替用户安装依赖；如果精简版系统移除了 WebView2，请改用同一 Release 中名称含 `WebView2_Offline_Setup` 的安装版。该安装包携带完整 WebView2 Evergreen 离线安装组件，即使断网也能在缺失时补齐 Runtime；已经安装合适 Runtime 的电脑不会重复安装。

未签名构建可能被 SmartScreen 标记为“未知发布者”。这和管理员权限、安装行为无关；请只从 LeafMark 官方 GitHub Releases 下载，并核对 Release 页面显示的 SHA-256。
