import { invoke } from "@tauri-apps/api/core";
import type {
  AgentAuthAccountStatus,
  AgentAuthChallenge,
  AgentAuthFlowStatus,
  AgentCredential,
  AgentTerminalResult,
  AgentVersionOperation,
  AgentVersionStatus,
  AgentVersionSummary,
  AgentProvider,
  AppSettings,
  ArchiveEntry,
  AssociationStatus,
  BootstrapPayload,
  DocumentEntry,
  EntryKind,
  ImportDirectoryResult,
  LoadedDocument,
} from "./types";
import { defaultAppSettings, normalizeAgentSettings } from "./settings-defaults";

const browserSettings: AppSettings = defaultAppSettings("浏览器预览");
const browserAgentTurns = new Map<string, { sessionId: string; label: string; createdMs: number }>();

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

export type ExportDeliveryPurpose = "save" | "share";

export interface PreparedExport {
  path: string;
  fileName: string;
  mimeType: string;
  size: number;
  purpose: ExportDeliveryPurpose;
}

const ANDROID_EXPORT_RESULT_EVENT = "leafmark-android-export-result";
const ANDROID_EXPORT_TIMEOUT_MS = 10 * 60 * 1000;
// Tauri's Android IPC transport cannot carry InvokeBody::Raw. Base64 is the
// compact byte-safe representation recommended by Tauri for its JSON-only
// Android bridge. Keep the limit in sync with MAX_EXPORT_PAYLOAD_BYTES in Rust.
const MAX_ANDROID_EXPORT_BYTES = 64 * 1024 * 1024;
const ANDROID_BASE64_CHUNK_BYTES = 48 * 1024;
let androidExportRequestSequence = 0;

interface AndroidBase64ExportPayload {
  [key: string]: unknown;
  encoding: "base64";
  byteLength: number;
  data: string;
}

async function encodeAndroidExportPayload(bytes: Uint8Array): Promise<AndroidBase64ExportPayload> {
  if (bytes.byteLength > MAX_ANDROID_EXPORT_BYTES) {
    throw new Error("Android 单次导出不能超过 64 MiB");
  }

  const encodedChunks: string[] = [];
  for (let offset = 0, chunkIndex = 0; offset < bytes.byteLength; offset += ANDROID_BASE64_CHUNK_BYTES, chunkIndex += 1) {
    const chunk = bytes.subarray(offset, Math.min(offset + ANDROID_BASE64_CHUNK_BYTES, bytes.byteLength));
    let binary = "";
    // Avoid spreading the entire export into one function call. Some Android
    // WebViews have a much smaller argument limit than desktop browsers.
    for (let characterOffset = 0; characterOffset < chunk.byteLength; characterOffset += 8 * 1024) {
      binary += String.fromCharCode(...chunk.subarray(characterOffset, characterOffset + 8 * 1024));
    }
    encodedChunks.push(window.btoa(binary));

    // Yield periodically so encoding a large PDF/PNG does not monopolize the
    // WebView UI thread. Every non-final chunk is divisible by three, so the
    // independently encoded chunks can be joined without padding in-between.
    if (chunkIndex % 32 === 31) {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    }
  }

  return {
    encoding: "base64",
    byteLength: bytes.byteLength,
    data: encodedChunks.join(""),
  };
}

async function prepareExportPayload(
  fileName: string,
  mimeType: string,
  bytes: Uint8Array,
  purpose: ExportDeliveryPurpose,
): Promise<PreparedExport> {
  if (!isTauri()) throw new Error("浏览器预览无法暂存导出文件");
  // Android always delivers an InvokeBody::Json to Rust, even when invoke()
  // receives a Uint8Array. Desktop custom-protocol IPC supports raw bytes and
  // keeps the zero-copy-friendly path.
  const payload = isAndroid() ? await encodeAndroidExportPayload(bytes) : bytes;
  return invoke<PreparedExport>("prepare_export", payload, {
    headers: {
      "LeafMark-File-Name": encodeURIComponent(fileName),
      "LeafMark-Mime-Type": encodeURIComponent(mimeType),
      "LeafMark-Purpose": encodeURIComponent(purpose),
    },
  });
}

function callAndroidExportBridge(
  operation: LeafMarkAndroidExportOperation,
  start: (bridge: LeafMarkAndroidBridge, requestId: string) => void,
): Promise<number> {
  if (!isAndroid()) return Promise.reject(new Error("此操作仅支持 Android"));
  const bridge = window.LeafMarkAndroid;
  if (!bridge) return Promise.reject(new Error("Android 原生文件桥尚未初始化"));
  androidExportRequestSequence += 1;
  const requestId = `${Date.now().toString(36)}-${androidExportRequestSequence.toString(36)}`;

  return new Promise<number>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      window.clearTimeout(timeout);
      window.removeEventListener(ANDROID_EXPORT_RESULT_EVENT, handleResult as EventListener);
    };
    const handleResult = (event: Event) => {
      const detail = (event as CustomEvent<LeafMarkAndroidExportResult>).detail;
      if (!detail || detail.requestId !== requestId || detail.operation !== operation) return;
      if (settled) return;
      settled = true;
      cleanup();
      if (detail.ok) resolve(detail.bytesWritten ?? 0);
      else reject(new Error(detail.error || (operation === "write" ? "Android 文件写入失败" : "无法打开系统分享面板")));
    };
    const timeout = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(operation === "write" ? "Android 文件写入超时" : "Android 分享操作超时"));
    }, ANDROID_EXPORT_TIMEOUT_MS);
    window.addEventListener(ANDROID_EXPORT_RESULT_EVENT, handleResult as EventListener);
    try {
      start(bridge, requestId);
    } catch (error) {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

async function writePreparedAndroidExport(target: string, prepared: PreparedExport) {
  if (prepared.purpose !== "save") throw new Error("暂存文件不是保存用途");
  return callAndroidExportBridge("write", (bridge, requestId) => {
    bridge.writePreparedExport(target, prepared.path, requestId);
  });
}

async function sharePreparedAndroidExport(prepared: PreparedExport) {
  if (prepared.purpose !== "share") throw new Error("暂存文件不是分享用途");
  await callAndroidExportBridge("share", (bridge, requestId) => {
    bridge.sharePreparedExport(prepared.path, prepared.mimeType, requestId);
  });
}

export const api = {
  isTauri,
  isAndroid,
  async bootstrap(): Promise<BootstrapPayload> {
    if (isTauri()) {
      const payload = await invoke<BootstrapPayload>("bootstrap");
      return { ...payload, settings: { ...payload.settings, agent: normalizeAgentSettings(payload.settings.agent) } };
    }
    return {
      settings: browserSettings,
      entries: [{ path: "欢迎.md", name: "欢迎.md", kind: "file", depth: 0, size: sample.length, modifiedMs: Date.now() }],
      library: [],
      initialDocument: null,
      pendingOpenPaths: [],
      associationStatus: {
        supported: false,
        registered: false,
        isDefault: false,
        portable: false,
        message: "浏览器预览不支持系统文件关联",
      },
    };
  },
  async startAgentOAuth(provider: AgentProvider): Promise<AgentAuthChallenge> {
    if (!isTauri()) throw new Error("浏览器预览无法启动本机 OAuth");
    return invoke<AgentAuthChallenge>("agent_oauth_start", { provider });
  },
  async pollAgentOAuth(flowId: string): Promise<AgentAuthFlowStatus> {
    if (!isTauri()) return { status: "error", message: "浏览器预览不支持 OAuth" };
    return invoke("agent_oauth_poll", { flowId });
  },
  async getAgentAuthStatus(provider: AgentProvider): Promise<AgentAuthAccountStatus> {
    if (!isTauri()) return { provider, connected: false, email: null, expiresAt: null, detail: "浏览器预览未登录" };
    return invoke("agent_auth_status", { provider });
  },
  async logoutAgentOAuth(provider: AgentProvider): Promise<void> {
    if (isTauri()) await invoke("agent_oauth_logout", { provider });
  },
  async getAgentCredential(provider: AgentProvider): Promise<AgentCredential> {
    if (!isTauri()) throw new Error("浏览器预览无法读取订阅凭据");
    return invoke("agent_auth_credential", { provider });
  },
  async executeAgentTerminal(command: string, options: { cwd?: string; timeoutMs?: number; background?: boolean; allowDestructive?: boolean } = {}): Promise<AgentTerminalResult> {
    if (!isTauri()) throw new Error("浏览器预览无法执行系统终端");
    return invoke("agent_terminal_execute", {
      command,
      cwd: options.cwd || null,
      timeoutMs: options.timeoutMs ?? 120_000,
      background: options.background ?? false,
      allowDestructive: options.allowDestructive ?? false,
    });
  },
  async getAgentTerminalStatus(jobId: string): Promise<AgentTerminalResult> {
    if (!isTauri()) throw new Error("浏览器预览无法读取终端任务");
    return invoke("agent_terminal_status", { jobId });
  },
  async killAgentTerminal(jobId: string): Promise<AgentTerminalResult> {
    if (!isTauri()) throw new Error("浏览器预览无法停止终端任务");
    return invoke("agent_terminal_kill", { jobId });
  },
  async beginAgentTurn(sessionId: string, turnId: string, label: string, archiveId?: string): Promise<void> {
    if (isTauri()) {
      await invoke("agent_vcs_begin_turn", { sessionId, turnId, label, archiveId: archiveId || null });
      return;
    }
    browserAgentTurns.set(turnId, { sessionId, label, createdMs: Date.now() });
  },
  async finishAgentTurn(turnId: string, outcome: AgentVersionSummary["outcome"]): Promise<AgentVersionSummary> {
    if (isTauri()) return invoke("agent_vcs_finish_turn", { turnId, outcome });
    const pending = browserAgentTurns.get(turnId) ?? { sessionId: "browser", label: "Agent 回合", createdMs: Date.now() };
    browserAgentTurns.delete(turnId);
    return { id: `browser-${turnId}`, sessionId: pending.sessionId, turnId, label: pending.label, createdMs: pending.createdMs, outcome, changes: [] };
  },
  async findAgentVersionForTurn(turnId: string): Promise<AgentVersionSummary | null> {
    if (isTauri()) return invoke("agent_vcs_version_for_turn", { turnId });
    return null;
  },
  async getAgentVersionStatus(): Promise<AgentVersionStatus> {
    if (isTauri()) return invoke("agent_vcs_status");
    return { undo: null, redo: null, pending: browserAgentTurns.size > 0 };
  },
  async undoAgentVersion(): Promise<AgentVersionOperation> {
    if (isTauri()) return invoke("agent_vcs_undo");
    throw new Error("浏览器预览没有可回退的本地文件版本");
  },
  async redoAgentVersion(): Promise<AgentVersionOperation> {
    if (isTauri()) return invoke("agent_vcs_redo");
    throw new Error("浏览器预览没有可重做的本地文件版本");
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
  async revealWorkspaceEntry(path: string): Promise<void> {
    if (isTauri()) await invoke("reveal_workspace_entry", { relativePath: path });
  },
  async revealArchivedDocument(id: string): Promise<void> {
    if (isTauri()) await invoke("reveal_archived_document", { id });
  },
  async getAssociationStatus(): Promise<AssociationStatus> {
    if (isTauri()) return invoke("get_markdown_association_status");
    return {
      supported: false,
      registered: false,
      isDefault: false,
      portable: false,
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
  async importDirectory(path: string, targetDirectory: string): Promise<ImportDirectoryResult> {
    if (isTauri()) {
      return invoke("import_directory", { sourcePath: path, targetDirectory });
    }
    return { rootPath: "", files: [], directories: 0 };
  },
  async exportFile(path: string, target: string): Promise<void> {
    if (isTauri()) await invoke("export_file", { relativePath: path, targetPath: target });
  },
  prepareExport: prepareExportPayload,
  writePreparedExport: writePreparedAndroidExport,
  sharePreparedExport: sharePreparedAndroidExport,
  async shareExport(fileName: string, mimeType: string, bytes: Uint8Array): Promise<void> {
    const prepared = await prepareExportPayload(fileName, mimeType, bytes, "share");
    await sharePreparedAndroidExport(prepared);
  },
  async writeExport(target: string, bytes: Uint8Array): Promise<void> {
    if (isTauri()) {
      if (isAndroid()) {
        const prepared = await prepareExportPayload(
          "LeafMark-export.bin",
          "application/octet-stream",
          bytes,
          "save",
        );
        await writePreparedAndroidExport(target, prepared);
        return;
      }
      await invoke("write_export", bytes, {
        headers: { "LeafMark-Target": encodeURIComponent(target) },
      });
    }
  },
  async setWorkspace(path: string): Promise<BootstrapPayload> {
    if (isTauri()) {
      const payload = await invoke<BootstrapPayload>("set_workspace", { path });
      return { ...payload, settings: { ...payload.settings, agent: normalizeAgentSettings(payload.settings.agent) } };
    }
    return {
      settings: { ...browserSettings, workspacePath: path },
      entries: [],
      library: [],
      initialDocument: null,
      pendingOpenPaths: [],
      associationStatus: await this.getAssociationStatus(),
    };
  },
  async saveSettings(settings: AppSettings): Promise<AppSettings> {
    if (isTauri()) return invoke("save_settings", { settings });
    return settings;
  },
};
