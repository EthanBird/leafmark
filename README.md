# LeafMark（一叶）

LeafMark，中文名“一叶”，是从 DRPA 知识文档体验中独立出来的本地 Markdown 应用，支持 Windows、Linux 与 Android。界面只保留文档目录、主阅读区和必要操作；Markdown 首次编译、文件扫描、缓存与原子写入由 Rust 完成。

## 已实现

- 本地目录直接作为文档库，不使用数据库或专有格式
- 默认进入所见即所得的实时渲染编辑；标题、引用、列表及粗体、斜体、删除线、行内代码和链接标记会立即原位成形
- GFM：表格、任务列表、删除线、脚注与智能标点
- KaTeX：`$…$`、`$$…$$`、`\(...\)`、`\[...\]`、`math` / `tex` / `latex` 围栏
- Mermaid：完整 Mermaid 运行时，进入可视区域时才按需加载和绘制
- 文档目录搜索、新建、重命名、删除、导入和本地链接跳转；空文件夹也会完整显示
- 支持一次导入多篇 Markdown，或递归导入整个文件夹并保留原目录层级与空子目录
- 导出 Markdown、带主题 HTML、无损高清 PNG、连续长页 PDF 或 A4 标准分页 PDF
- PDF 使用可复制文字、系统中文字体子集与块级/行内矢量公式排版，不再把正文转换成图片
- 外部文档打开后只编辑 LeafMark 私有副本，绝不回写微信等来源路径；文档库文件仍可正常保存
- 自动保存串行化并对瞬时文件占用进行重试；UTF-8/UTF-16 读取、路径越界防护与安全 HTML 转义
- 一叶绿、樱花粉、清川蓝、暖杏金和藤萝紫主题；每套均支持系统/浅色/深色模式
- 本机字体、版心、字号、行高、动效和渲染能力设置
- 不遮挡正文的停靠式文章大纲
- Windows / Linux 自绘主题标题栏与本地化应用名称
- Windows 资源管理器“打开方式”、右键打开与双击 `.md` / `.markdown`
- Windows 启动、文件关联检测与默认应用设置全程不创建命令行窗口
- Android 文件管理器、聊天、网盘等应用通过 `ACTION_VIEW`、`ACTION_EDIT` 或分享 Intent 打开 Markdown
- Android 手机抽屉导航、触控热区、系统安全区与系统字体扫描
- Android Agent 支持在系统默认浏览器登录 ChatGPT/Codex 等订阅；授权回调只监听本机 IPv4/IPv6 loopback，并提供重新打开与复制链接兜底
- 最近打开历史与收藏；打开时自动保存独立文档副本，并可一键保存到我的文档库
- 文档库、历史和收藏均提供右键菜单，可直接在系统文件管理器中定位源文档或保留副本
- 源文件被移动或删除后，仍可从历史/收藏读取、编辑和导出保留副本
- 类 VS Code 多文档标签栏；可在已打开文档间即时切换、查看未保存状态并单独关闭
- 桌面端柔性 Dock 布局；文档库、历史、收藏、Agent 与大纲使用应用内指针拖放，可停靠上下左右、合并为页签并调整尺寸，不依赖 Windows WebView 的原生 HTML 拖放
- 内置按需启动的流式文档 Agent；原生支持 ChatGPT/Codex、Claude、Gemini Code Assist 与 GitHub Copilot 订阅 OAuth，并完整提供 jcode 的 OpenAI-compatible provider catalog
- 订阅模式分别使用 Codex Responses、Anthropic Messages、Gemini Code Assist 与 Copilot 协议，不会把订阅账户错误回退到按量 API Key
- Agent 支持自动刷新登录、文档读写、并行只读子 Agent、会话检索、长期记忆、Skills、网页读取、Streamable HTTP MCP 和本机终端
- Agent 每轮对话都建立不依赖 Git 的本地文件版本；消息、文档工具和 PowerShell 修改可一起回退或重做，重做不会再次执行命令
- Windows 终端工具固定使用隐藏窗口 PowerShell；版本化回合采用可完整捕获的前台命令，支持超时和破坏性命令 Rust 级拦截，不会弹出黑色命令行

## 系统打开与文档保留

安装包会把 LeafMark 注册为 Markdown 打开方式。Windows 也可以进入“设置 → 系统集成”，注册 LeafMark 并打开默认应用确认页；Android 首次打开 Markdown 时，在系统“打开方式”选择器中选择 LeafMark，并可按需选择“始终”。

文档每次打开或保存时，LeafMark 都会原子更新一份应用数据目录中的独立快照。历史记录不是易失的路径列表：即使源文件已经不存在，保留副本仍然可以继续阅读、编辑和导出。清除历史只清理未收藏文档；收藏及其副本不会被批量清除。

Android 从其他应用收到的是临时 `content://` URI。LeafMark 会先把内容复制到应用私有文档库，再建立历史/收藏快照，因此原应用撤销授权或删除源文档后仍可打开保留副本。

## 性能设计

- `pulldown-cmark` 在 Rust 侧完成 Markdown → HTML，前端不维护 Markdown AST
- 文件读取与渲染结果使用按修改时间失效的 LRU 缓存（12 篇 / 32MB）
- 从资源管理器或微信冷启动时，首篇外部文档会随启动数据一次载入，避免先显示空白新建页再跳转
- 目录扫描遵守 `.gitignore`、`.ignore` 与 `.markignore`，跳过隐藏目录和常见构建产物
- Mermaid 和 KaTeX JavaScript 都是独立动态分块；普通文档不会下载或执行它们
- Mermaid 使用 `IntersectionObserver` 提前 500px 懒渲染
- Agent 不捆绑模型、jcode GUI、向量数据库或云端控制服务；只有用户发送消息时才连接所选 Provider，轻量记忆索引与 OAuth 账户状态保存在本机
- 保存使用串行队列与同目录临时文件替换；遇到 Windows 索引器或杀毒软件瞬时占用会短退避重试
- PDF 与 PNG 在独立 Worker 中排版/绘制/压缩，导出面板显示阶段进度并支持取消
- PNG 只序列化一次页面，随后在后台分片绘制并流式压缩，避免重复排版或申请整页超大画布
- Tauri 直接使用系统 WebView，不捆绑 Chromium；Rust release 使用 LTO、`opt-level="z"` 与 strip

## 开发

需要 Node.js 20+、Rust 1.77+ 和 Tauri 2 的平台依赖。Android 还需要 Android SDK 36、NDK 27 与对应 Rust Android target。

```powershell
npm install
npm run tauri:dev
```

检查与构建：

```powershell
npm run typecheck
npm test
cd src-tauri
cargo test
cd ..
npm run tauri:build
```

Android APK：

```powershell
npm run tauri -- android init
$env:ANDROID_KEYSTORE_PATH = "C:\secure\leafmark-release.jks"
$env:ANDROID_KEYSTORE_PASSWORD = "<store password>"
$env:ANDROID_KEY_ALIAS = "leafmark"
$env:ANDROID_KEY_PASSWORD = "<key password>"
npm run tauri -- android build --apk --target aarch64 --split-per-abi
```

GitHub Release 只发布适用于现代 Android 手机的 `arm64-v8a` 优化 APK。发布构建会启用
Rust LTO/strip、R8、资源裁剪和原生库压缩，并在上传后自动验证 APK 只包含 ARM64
动态库且不超过 16 MiB。正式 APK 必须使用永久固定的 release keystore；密钥准备、Secrets
配置与证书迁移规则见 [Android 发布签名](docs/android-signing.md)。

## 下载

可以从 [GitHub Releases](https://github.com/EthanBird/leafmark/releases/latest)
下载 Android APK、Windows NSIS 安装包、Linux AppImage 或 Debian 安装包。Android APK 是使用
固定 release 证书签名的优化构建；Windows 安装后可在 LeafMark 的“设置 → 系统集成”中完成
Markdown 默认应用确认。

旧 Android 包使用了无法恢复的临时 debug 证书，因此第一次迁移到固定签名版需要先备份文档、
卸载旧 APK，再安装一次；固定签名版之后的更新可直接覆盖安装。

发布工作流支持可选 Authenticode 代码签名。未配置证书时仍可生成安装包，但 Windows
SmartScreen 可能显示未知发布者提示。证书配置见 [Windows 发布签名](docs/windows-code-signing.md)。

## 实时编辑说明

在“设置 → 编辑与保存”开启实时编辑后，工具栏会出现铅笔按钮。此模式直接编辑渲染后的内容，并持续转换回 Markdown。数学公式和 Mermaid 作为不可破坏的渲染块保留原始源码；编辑复杂公式、图表、脚注或表格结构时，建议临时切到源码或分栏模式。

## 项目结构

```text
src/
  App.tsx                 应用状态、文件操作、Dock 与多文档标签
  agent-runtime.ts        流式 Agent 循环、文档工具与 MCP 客户端
  agent-providers.ts      jcode 对齐的 Provider catalog 与原生协议路由
  agent-storage.ts        本机会话检索与轻量语义记忆
  dock-layout.ts          桌面柔性 Dock 布局状态
  document-tabs.ts        多文档标签状态
  rendering.ts            KaTeX / Mermaid 按需增强
  wysiwyg.ts              实时编辑 HTML → Markdown
  components/             文件树、历史收藏、Agent、Dock 与设置页
src-tauri/src/
  lib.rs                  扫描、渲染、缓存、文件系统与设置
  library.rs              历史/收藏索引与独立文档快照
  system_integration.rs   文件启动参数与系统文件关联状态
  agent_auth.rs           桌面/Android 订阅 OAuth、设备登录、令牌续期与账户状态
  agent_terminal.rs       无窗口 PowerShell / shell 前后台执行 harness
  agent_vcs.rs            Agent 原生 CAS、清单差分、事务回退与重做
src-tauri/gen/android/    Android Studio 工程、Manifest 与 Gradle 配置
```

Agent 本地版本格式、冲突行为和安全边界见 [Agent 本地版本控制](docs/AGENT_LOCAL_VERSION_CONTROL.md)。
