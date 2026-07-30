# LeafMark（一叶）

LeafMark，中文名“一叶”，是从 DRPA 知识文档体验中独立出来的本地 Markdown 桌面应用。界面只保留文档目录、主阅读区和必要操作；Markdown 首次编译、文件扫描、缓存与原子写入由 Rust 完成。

## 已实现

- 本地目录直接作为文档库，不使用数据库或专有格式
- 默认进入所见即所得的实时渲染编辑，并可切换阅读、源码和分栏视图
- GFM：表格、任务列表、删除线、脚注与智能标点
- KaTeX：`$…$`、`$$…$$`、`\(...\)`、`\[...\]`、`math` / `tex` / `latex` 围栏
- Mermaid：完整 Mermaid 运行时，进入可视区域时才按需加载和绘制
- 文档目录搜索、新建、重命名、删除、导入、导出和本地链接跳转
- 自动保存、UTF-8/UTF-16 读取、路径越界防护与安全 HTML 转义
- 系统/浅色/深色主题、本机字体、版心、字号、行高、动效和渲染能力设置
- Windows 资源管理器“打开方式”、右键打开与双击 `.md` / `.markdown`
- 最近打开历史与收藏；打开时自动保存独立文档副本
- 源文件被移动或删除后，仍可从历史/收藏读取、编辑和导出保留副本

## 系统打开与文档保留

安装包会把 LeafMark 注册为 Markdown 打开方式。也可以进入“设置 → 系统集成”，注册 LeafMark 并打开 Windows 默认应用确认页。Windows 不允许应用静默修改用户的默认程序，因此最后一次确认由系统界面完成。

文档每次打开或保存时，LeafMark 都会原子更新一份应用数据目录中的独立快照。历史记录不是易失的路径列表：即使源文件已经不存在，保留副本仍然可以继续阅读、编辑和导出。清除历史只清理未收藏文档；收藏及其副本不会被批量清除。

## 性能设计

- `pulldown-cmark` 在 Rust 侧完成 Markdown → HTML，前端不维护 Markdown AST
- 文件读取与渲染结果使用按修改时间失效的 LRU 缓存（12 篇 / 32MB）
- 目录扫描遵守 `.gitignore`、`.ignore` 与 `.markignore`，跳过隐藏目录和常见构建产物
- Mermaid 和 KaTeX JavaScript 都是独立动态分块；普通文档不会下载或执行它们
- Mermaid 使用 `IntersectionObserver` 提前 500px 懒渲染
- 保存使用同目录临时文件替换，避免半写入文档
- Tauri 直接使用系统 WebView，不捆绑 Chromium；Rust release 使用 LTO、`opt-level="z"` 与 strip

## 开发

需要 Node.js 20+、Rust 1.77+ 和 Tauri 2 的平台依赖。

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

## 下载

Windows 用户可以从 [GitHub Releases](https://github.com/EthanBird/leafmark/releases/latest)
下载 NSIS 安装包。安装后可在 LeafMark 的“设置 → 系统集成”中完成 Markdown 默认应用确认。

公开发布强制使用 Authenticode 代码签名；未配置受信任证书时，发布工作流会在创建公开
Release 前停止。证书配置见 [Windows 发布签名](docs/windows-code-signing.md)。

## 实时编辑说明

在“设置 → 编辑与保存”开启实时编辑后，工具栏会出现铅笔按钮。此模式直接编辑渲染后的内容，并持续转换回 Markdown。数学公式和 Mermaid 作为不可破坏的渲染块保留原始源码；编辑复杂公式、图表、脚注或表格结构时，建议临时切到源码或分栏模式。

## 项目结构

```text
src/
  App.tsx                 应用状态、文件操作和四种模式
  rendering.ts            KaTeX / Mermaid 按需增强
  wysiwyg.ts              实时编辑 HTML → Markdown
  components/             文件树、历史收藏与设置页
src-tauri/src/
  lib.rs                  扫描、渲染、缓存、文件系统与设置
  library.rs              历史/收藏索引与独立文档快照
  system_integration.rs   文件启动参数与 Windows 文件关联
```
