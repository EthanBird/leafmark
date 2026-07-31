import { invoke } from "@tauri-apps/api/core";
import type {
  AppSettings,
  ArchiveEntry,
  AssociationStatus,
  BootstrapPayload,
  DocumentEntry,
  EntryKind,
  LoadedDocument,
} from "./types";

const browserSettings: AppSettings = {
  settingsSchemaVersion: 3,
  workspacePath: "浏览器预览",
  theme: "system",
  themePalette: "leaf",
  liveEditing: true,
  autosaveDelayMs: 600,
  contentWidth: 860,
  fontFamily: "system",
  fontSize: 16,
  lineHeight: 1.75,
  showStatusBar: true,
  reduceMotion: false,
  mermaidEnabled: true,
  mathEnabled: true,
};

const sample = `# 欢迎使用 LeafMark

这是一个专注于速度、阅读与写作的本地 Markdown 工作区。

## 数学公式

行内公式 $E = mc^2$ 与块级公式：

$$
\\int_{-\\infty}^{\\infty} e^{-x^2}\\,dx = \\sqrt{\\pi}
$$

也支持 LaTeX 围栏：

\`\`\`math
\\mathbf{F} = \\frac{d\\mathbf{p}}{dt}
\`\`\`

## Mermaid

\`\`\`mermaid
flowchart LR
  A[Markdown] --> B[Rust 解析]
  B --> C{按需增强}
  C -->|公式| D[KaTeX]
  C -->|图表| E[Mermaid]
\`\`\`

## GFM

- [x] 表格、任务列表与脚注
- [x] 本地文件树与原子保存
- [x] 阅读、源码、分栏与实时编译模式
- [ ] 写下你的下一篇文档

| 能力 | 策略 |
| --- | --- |
| 首屏 | Rust 解析 + HTML 直出 |
| 大型依赖 | Mermaid 按需加载 |
| 编辑 | 自动保存，复杂语法可随时切回源码 |
`;

function isTauri() {
  return "__TAURI_INTERNALS__" in window;
}

function isAndroid() {
  return /Android/i.test(navigator.userAgent);
}

export const api = {
  isTauri,
  isAndroid,
  async bootstrap(): Promise<BootstrapPayload> {
    if (isTauri()) return invoke("bootstrap");
    return {
      settings: browserSettings,
      entries: [{ path: "欢迎.md", name: "欢迎.md", kind: "file", depth: 0, size: sample.length, modifiedMs: Date.now() }],
      library: [],
      pendingOpenPaths: [],
      associationStatus: {
        supported: false,
        registered: false,
        isDefault: false,
        message: "浏览器预览不支持系统文件关联",
      },
    };
  },
  async listEntries(): Promise<DocumentEntry[]> {
    if (isTauri()) return invoke("list_entries");
    return [{ path: "欢迎.md", name: "欢迎.md", kind: "file", depth: 0, size: sample.length, modifiedMs: Date.now() }];
  },
  async readDocument(path: string): Promise<LoadedDocument> {
    if (isTauri()) return invoke("read_document", { relativePath: path });
    const { renderMarkdown } = await import("./markdown");
    return {
      path,
      origin: "workspace",
      archiveId: "browser-sample",
      sourcePath: path,
      sourceExists: true,
      content: sample,
      html: await renderMarkdown(sample),
      size: sample.length,
      modifiedMs: Date.now(),
      cached: false,
    };
  },
  async openExternalDocument(path: string): Promise<LoadedDocument> {
    if (isTauri()) return invoke("open_external_document", { path });
    return this.readDocument(path);
  },
  async openArchivedDocument(id: string): Promise<LoadedDocument> {
    if (isTauri()) return invoke("open_archived_document", { id });
    return this.readDocument("欢迎.md");
  },
  async listArchiveEntries(): Promise<ArchiveEntry[]> {
    if (isTauri()) return invoke("list_archive_entries");
    return [];
  },
  async writeArchivedDocument(id: string, content: string): Promise<ArchiveEntry | null> {
    if (isTauri()) return invoke("write_archived_document", { id, content });
    return null;
  },
  async saveArchivedToWorkspace(id: string): Promise<string> {
    if (isTauri()) return invoke("save_archived_to_workspace", { id });
    return "欢迎.md";
  },
  async setFavorite(id: string, favorite: boolean): Promise<ArchiveEntry[]> {
    if (isTauri()) return invoke("set_document_favorite", { id, favorite });
    return [];
  },
  async removeArchiveEntry(id: string): Promise<ArchiveEntry[]> {
    if (isTauri()) return invoke("remove_archive_entry", { id });
    return [];
  },
  async clearHistory(): Promise<ArchiveEntry[]> {
    if (isTauri()) return invoke("clear_document_history");
    return [];
  },
  async exportArchivedDocument(id: string, target: string): Promise<void> {
    if (isTauri()) await invoke("export_archived_document", { id, targetPath: target });
  },
  async getAssociationStatus(): Promise<AssociationStatus> {
    if (isTauri()) return invoke("get_markdown_association_status");
    return {
      supported: false,
      registered: false,
      isDefault: false,
      message: "浏览器预览不支持系统文件关联",
    };
  },
  async requestDefaultAssociation(): Promise<AssociationStatus> {
    if (isTauri()) return invoke("request_default_markdown_association");
    return this.getAssociationStatus();
  },
  async listSystemFonts(): Promise<string[]> {
    if (isTauri()) return invoke("list_system_fonts");
    return [
      "Arial",
      "Georgia",
      "Microsoft YaHei UI",
      "Noto Sans CJK SC",
      "Noto Serif CJK SC",
      "Segoe UI",
      "SimSun",
    ];
  },
  async loadExportFont(preferredFamily: string, containsCjk: boolean): Promise<Uint8Array> {
    if (!isTauri()) throw new Error("浏览器预览无法读取系统字体");
    const payload = await invoke<ArrayBuffer | Uint8Array>("load_export_font", {
      preferredFamily,
      containsCjk,
    });
    return payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  },
  async render(source: string): Promise<string> {
    if (isTauri()) return invoke("render_markdown", { source });
    const { renderMarkdown } = await import("./markdown");
    return renderMarkdown(source);
  },
  async write(path: string, content: string): Promise<void> {
    if (isTauri()) await invoke("write_document", { relativePath: path, content });
  },
  async create(path: string, kind: EntryKind): Promise<void> {
    if (isTauri()) await invoke("create_entry", { relativePath: path, kind });
  },
  async rename(path: string, target: string): Promise<void> {
    if (isTauri()) await invoke("rename_entry", { relativePath: path, targetPath: target });
  },
  async remove(path: string): Promise<void> {
    if (isTauri()) await invoke("delete_entry", { relativePath: path });
  },
  async importFiles(paths: string[], targetDirectory: string): Promise<string[]> {
    if (isTauri()) return invoke("import_files", { sourcePaths: paths, targetDirectory });
    return [];
  },
  async exportFile(path: string, target: string): Promise<void> {
    if (isTauri()) await invoke("export_file", { relativePath: path, targetPath: target });
  },
  async writeExport(target: string, bytes: Uint8Array): Promise<void> {
    if (isTauri()) {
      await invoke("write_export", bytes, {
        headers: { "LeafMark-Target": encodeURIComponent(target) },
      });
    }
  },
  async setWorkspace(path: string): Promise<BootstrapPayload> {
    if (isTauri()) return invoke("set_workspace", { path });
    return {
      settings: { ...browserSettings, workspacePath: path },
      entries: [],
      library: [],
      pendingOpenPaths: [],
      associationStatus: await this.getAssociationStatus(),
    };
  },
  async saveSettings(settings: AppSettings): Promise<AppSettings> {
    if (isTauri()) return invoke("save_settings", { settings });
    return settings;
  },
};
