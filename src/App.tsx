import {
  Bold,
  BookOpen,
  Check,
  ChevronRight,
  CircleAlert,
  Clock3,
  Download,
  Eye,
  FileCode2,
  FilePlus2,
  Files,
  FolderPlus,
  Italic,
  LayoutPanelLeft,
  List,
  ListOrdered,
  Menu,
  Minus,
  PanelLeftClose,
  PanelLeftOpen,
  PencilLine,
  RefreshCw,
  Save,
  Search,
  Settings,
  Square,
  SplitSquareHorizontal,
  Star,
  Strikethrough,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { open, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api } from "./api";
import { DocumentLibrary } from "./components/DocumentLibrary";
import { FileTree } from "./components/FileTree";
import { SettingsPanel } from "./components/SettingsPanel";
import {
  buildStandaloneHtml,
  exportExtension,
  inlineExportImages,
  type ExportFormat,
} from "./exporting";
import { startPdfExport, type ExportProgress } from "./pdf-export";
import { startPngExport } from "./png-export";
import { collectOutline, enhanceDocument, type OutlineItem } from "./rendering";
import { buildTree, joinPath, parentPath, resolveMarkdownLink } from "./tree";
import type {
  AppSettings,
  ArchiveEntry,
  AssociationStatus,
  DocumentEntry,
  DocumentOrigin,
  EntryKind,
  LoadedDocument,
  TreeNode,
  ViewMode,
} from "./types";
import { applyLiveMarkdownShortcut, htmlToMarkdown, runFormat } from "./wysiwyg";

interface EntryDialogState {
  action: "create" | "rename";
  kind: EntryKind;
  source?: DocumentEntry;
  parent: string;
  value: string;
}

interface MenuState {
  x: number;
  y: number;
  entry: DocumentEntry | null;
}

type SidebarView = "workspace" | "history" | "favorites";
type SaveStatus = "idle" | "saving" | "saved" | "error";

const isCompactLayout = () => window.matchMedia("(max-width: 620px)").matches;

const EMPTY_SETTINGS: AppSettings = {
  settingsSchemaVersion: 3,
  workspacePath: "",
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

const EMPTY_ASSOCIATION_STATUS: AssociationStatus = {
  supported: false,
  registered: false,
  isDefault: false,
  message: "正在检查系统文件关联…",
};

export default function App() {
  const [settings, setSettings] = useState<AppSettings>(EMPTY_SETTINGS);
  const [entries, setEntries] = useState<DocumentEntry[]>([]);
  const [archiveEntries, setArchiveEntries] = useState<ArchiveEntry[]>([]);
  const [associationStatus, setAssociationStatus] = useState<AssociationStatus>(EMPTY_ASSOCIATION_STATUS);
  const [selectedPath, setSelectedPath] = useState("");
  const [selectedEntryPath, setSelectedEntryPath] = useState("");
  const [documentOrigin, setDocumentOrigin] = useState<DocumentOrigin>("workspace");
  const [archiveId, setArchiveId] = useState("");
  const [sourcePath, setSourcePath] = useState("");
  const [sourceExists, setSourceExists] = useState(true);
  const [content, setContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [renderedHtml, setRenderedHtml] = useState("");
  const [mode, setMode] = useState<ViewMode>("live");
  const [sidebarView, setSidebarView] = useState<SidebarView>("workspace");
  const [sidebarOpen, setSidebarOpen] = useState(() => !isCompactLayout());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState("正在启动…");
  const [busy, setBusy] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState<ExportProgress | null>(null);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [outline, setOutline] = useState<OutlineItem[]>([]);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [entryDialog, setEntryDialog] = useState<EntryDialogState | null>(null);
  const [deleteEntry, setDeleteEntry] = useState<DocumentEntry | null>(null);
  const [rendering, setRendering] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const contentRef = useRef(content);
  const savedRef = useRef(savedContent);
  const selectedRef = useRef(selectedPath);
  const originRef = useRef<DocumentOrigin>(documentOrigin);
  const archiveIdRef = useRef(archiveId);
  const liveEditorRef = useRef<HTMLElement>(null);
  const settingsReady = useRef(false);
  const renderRequest = useRef(0);
  const documentVersionRef = useRef(0);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const queuedSaveRef = useRef<{
    key: string;
    value: string;
    promise: Promise<boolean>;
  } | null>(null);
  const cancelExportRef = useRef<(() => void) | null>(null);

  const dirty = Boolean(selectedPath) && content !== savedContent;
  const files = useMemo(() => entries.filter((entry) => entry.kind === "file"), [entries]);
  const tree = useMemo(() => buildTree(entries), [entries]);
  const entryMap = useMemo(() => new Map(entries.map((entry) => [entry.path, entry])), [entries]);
  const selectedEntry = entryMap.get(selectedEntryPath);
  const currentDirectory = selectedEntry?.kind === "directory" ? selectedEntry.path : parentPath(selectedEntryPath);
  const currentArchiveEntry = archiveEntries.find((entry) => entry.id === archiveId);

  useEffect(() => { contentRef.current = content; }, [content]);
  useEffect(() => { savedRef.current = savedContent; }, [savedContent]);
  useEffect(() => { selectedRef.current = selectedPath; }, [selectedPath]);
  useEffect(() => { originRef.current = documentOrigin; }, [documentOrigin]);
  useEffect(() => { archiveIdRef.current = archiveId; }, [archiveId]);

  const applyTheme = useCallback((next: AppSettings) => {
    const mediaDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const resolved = next.theme === "system" ? (mediaDark ? "dark" : "light") : next.theme;
    const root = document.documentElement;
    root.dataset.theme = next.theme;
    root.dataset.resolvedTheme = resolved;
    root.dataset.palette = next.themePalette;
    root.dataset.reduceMotion = String(next.reduceMotion);
    root.style.setProperty("--reader-width", `${next.contentWidth}px`);
    root.style.setProperty("--reader-font-family", readerFontStack(next.fontFamily));
    root.style.setProperty("--reader-font-size", `${next.fontSize}px`);
    root.style.setProperty("--reader-line-height", String(next.lineHeight));
  }, []);

  useEffect(() => {
    applyTheme(settings);
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => applyTheme(settings);
    media.addEventListener("change", handler);
    return () => media.removeEventListener("change", handler);
  }, [applyTheme, settings]);

  const refreshLibrary = useCallback(async () => {
    const next = await api.listArchiveEntries();
    setArchiveEntries(next);
    return next;
  }, []);

  const persistCurrent = useCallback((quiet = false): Promise<boolean> => {
    const path = selectedRef.current;
    const value = contentRef.current;
    if (!path || value === savedRef.current) {
      if (path) setSaveStatus("saved");
      return Promise.resolve(true);
    }
    const origin = originRef.current;
    const archive = archiveIdRef.current;
    const version = documentVersionRef.current;
    const key = `${version}:${origin}:${origin === "archive" ? archive : path}`;
    const queued = queuedSaveRef.current;
    if (queued?.key === key && queued.value === value) return queued.promise;

    setSaveStatus("saving");
    const writeTask = saveQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        if (origin === "archive") {
          const updated = await api.writeArchivedDocument(archive, value);
          if (
            updated
            && documentVersionRef.current === version
            && archiveIdRef.current === archive
          ) {
            setSourceExists(updated.sourceExists);
          }
        } else {
          await api.write(path, value);
        }
      });
    saveQueueRef.current = writeTask;

    const result = writeTask.then(() => {
      if (
        documentVersionRef.current === version
        && selectedRef.current === path
        && originRef.current === origin
        && (origin !== "archive" || archiveIdRef.current === archive)
      ) {
        savedRef.current = value;
        setSavedContent(value);
        setSaveStatus(contentRef.current === value ? "saved" : "saving");
        if (!quiet) setNotice(`已保存 ${nativeFileName(path)}`);
      }
      void refreshLibrary().catch(() => undefined);
      return true;
    }).catch((error: unknown) => {
      if (
        documentVersionRef.current === version
        && selectedRef.current === path
        && queuedSaveRef.current?.key === key
        && queuedSaveRef.current.value === value
      ) {
        queuedSaveRef.current = null;
        setSaveStatus("error");
        setNotice(`保存失败：${String(error)}。内容仍保留在编辑器中，可点击保存重试`);
      }
      return false;
    });
    queuedSaveRef.current = { key, value, promise: result };
    return result;
  }, [refreshLibrary]);

  const refresh = useCallback(async (preferredPath?: string) => {
    const next = await api.listEntries();
    setEntries(next);
    setExpanded((current) => {
      if (current.size) return current;
      return new Set(next.filter((entry) => entry.kind === "directory" && entry.depth < 2).map((entry) => entry.path));
    });
    const target = preferredPath && next.some((entry) => entry.path === preferredPath && entry.kind === "file")
      ? preferredPath
      : selectedRef.current && next.some((entry) => entry.path === selectedRef.current)
        ? selectedRef.current
        : next.find((entry) => entry.kind === "file")?.path ?? "";
    setNotice(`${next.filter((entry) => entry.kind === "file").length} 篇 Markdown`);
    return target;
  }, []);

  const applyLoadedDocument = useCallback((loaded: LoadedDocument) => {
    documentVersionRef.current += 1;
    queuedSaveRef.current = null;
    selectedRef.current = loaded.path;
    originRef.current = loaded.origin;
    archiveIdRef.current = loaded.archiveId;
    contentRef.current = loaded.content;
    savedRef.current = loaded.content;
    setSelectedPath(loaded.path);
    setSelectedEntryPath(loaded.origin === "workspace" ? loaded.path : "");
    setDocumentOrigin(loaded.origin);
    setArchiveId(loaded.archiveId);
    setSourcePath(loaded.sourcePath);
    setSourceExists(loaded.sourceExists);
    setContent(loaded.content);
    setSavedContent(loaded.content);
    setSaveStatus("saved");
    setRenderedHtml(loaded.html);
    if (isCompactLayout()) setSidebarOpen(false);
  }, []);

  const openDocument = useCallback(async (path: string, force = false) => {
    if (!force && path === selectedRef.current) return;
    if (!await persistCurrent(true)) return;
    setBusy(true);
    try {
      const loaded = await api.readDocument(path);
      applyLoadedDocument(loaded);
      void refreshLibrary();
      setNotice(`${loaded.cached ? "瞬时打开（缓存）" : "已打开"} · ${formatBytes(loaded.size)}`);
    } catch (error) {
      setNotice(`打开文档失败：${String(error)}`);
    } finally {
      setBusy(false);
    }
  }, [applyLoadedDocument, persistCurrent, refreshLibrary]);

  const openExternalDocument = useCallback(async (path: string) => {
    if (!await persistCurrent(true)) return;
    setBusy(true);
    try {
      const loaded = await api.openExternalDocument(path);
      applyLoadedDocument(loaded);
      setSidebarView("history");
      await refreshLibrary();
      setNotice(`已从系统打开 · 已保留副本 · ${formatBytes(loaded.size)}`);
    } catch (error) {
      setNotice(`无法打开外部文档：${String(error)}`);
    } finally {
      setBusy(false);
    }
  }, [applyLoadedDocument, persistCurrent, refreshLibrary]);

  const openArchivedDocument = useCallback(async (entry: ArchiveEntry) => {
    if (!await persistCurrent(true)) return;
    setBusy(true);
    try {
      const loaded = await api.openArchivedDocument(entry.id);
      applyLoadedDocument(loaded);
      await refreshLibrary();
      setNotice(loaded.sourceExists
        ? `已从${entry.favorite ? "收藏" : "历史"}打开 · ${formatBytes(loaded.size)}`
        : `源文件已删除 · 正在读取 LeafMark 保留副本`);
    } catch (error) {
      setNotice(`打开保留文档失败：${String(error)}`);
    } finally {
      setBusy(false);
    }
  }, [applyLoadedDocument, persistCurrent, refreshLibrary]);

  useEffect(() => {
    let active = true;
    void api.bootstrap()
      .then(async (payload) => {
        if (!active) return;
        setSettings(payload.settings);
        setMode(payload.settings.liveEditing ? "live" : "read");
        setAssociationStatus(payload.associationStatus);
        setArchiveEntries(payload.library);
        settingsReady.current = true;
        setEntries(payload.entries);
        setExpanded(new Set(payload.entries.filter((entry) => entry.kind === "directory" && entry.depth < 2).map((entry) => entry.path)));
        const external = payload.pendingOpenPaths.at(-1);
        if (external) {
          await openExternalDocument(external);
          return;
        }
        const first = payload.entries.find((entry) => entry.kind === "file");
        if (first) await openDocument(first.path);
        else setNotice("文档库为空");
      })
      .catch((error: unknown) => setNotice(`启动失败：${String(error)}`))
      .finally(() => active && setBusy(false));
    return () => { active = false; };
  }, [openDocument, openExternalDocument]);

  useEffect(() => {
    if (!api.isTauri()) return;
    const cleanups: Array<() => void> = [];
    void Promise.all([
      listen<string>("open-markdown", (event) => {
        void openExternalDocument(event.payload);
      }),
      listen<string>("open-markdown-error", (event) => {
        setNotice(`无法接收 Android 文档：${event.payload}`);
      }),
    ]).then((next) => cleanups.push(...next));
    return () => cleanups.forEach((cleanup) => cleanup());
  }, [openExternalDocument]);

  useEffect(() => {
    if (!settingsReady.current) return;
    const timer = window.setTimeout(() => {
      void api.saveSettings(settings).catch((error: unknown) => setNotice(`设置保存失败：${String(error)}`));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [settings]);

  useEffect(() => {
    if (!settings.liveEditing && mode === "live") setMode("read");
  }, [mode, settings.liveEditing]);

  useEffect(() => {
    if (!settingsOpen || !associationStatus.supported || !api.isTauri()) return;
    const refreshAssociation = () => {
      void api.getAssociationStatus().then(setAssociationStatus);
    };
    window.addEventListener("focus", refreshAssociation);
    return () => window.removeEventListener("focus", refreshAssociation);
  }, [associationStatus.supported, settingsOpen]);

  useEffect(() => {
    if (!dirty || busy) return;
    const timer = window.setTimeout(() => void persistCurrent(true), settings.autosaveDelayMs);
    return () => window.clearTimeout(timer);
  }, [busy, content, dirty, persistCurrent, settings.autosaveDelayMs]);

  useEffect(() => {
    if (!selectedPath || mode !== "split" || content === savedContent && renderedHtml) return;
    const request = ++renderRequest.current;
    const timer = window.setTimeout(() => {
      setRendering(true);
      void api.render(content)
        .then((html) => {
          if (request === renderRequest.current) setRenderedHtml(html);
        })
        .catch((error: unknown) => setNotice(`渲染失败：${String(error)}`))
        .finally(() => request === renderRequest.current && setRendering(false));
    }, 120);
    return () => window.clearTimeout(timer);
  }, [content, mode, renderedHtml, savedContent, selectedPath]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      const command = event.ctrlKey || event.metaKey;
      if (command && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void persistCurrent();
      }
      if (command && event.key === ",") {
        event.preventDefault();
        setSettingsOpen(true);
      }
      if (command && event.key.toLowerCase() === "p") {
        event.preventDefault();
        setSidebarOpen(true);
        window.setTimeout(() => document.querySelector<HTMLInputElement>(".sidebar-search input")?.focus(), 0);
      }
      if (event.key === "Escape") {
        setMenu(null);
        setOutlineOpen(false);
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [persistCurrent]);

  const switchMode = async (next: ViewMode) => {
    if (next === "live" && !settings.liveEditing) {
      setSettingsOpen(true);
      return;
    }
    if ((next === "read" || next === "live" || next === "split") && contentRef.current !== savedRef.current) {
      const request = ++renderRequest.current;
      setRendering(true);
      try {
        const html = await api.render(contentRef.current);
        if (request === renderRequest.current) setRenderedHtml(html);
      } finally {
        if (request === renderRequest.current) setRendering(false);
      }
    }
    setMode(next);
  };

  const onLiveInput = () => {
    if (!liveEditorRef.current) return;
    applyLiveMarkdownShortcut(liveEditorRef.current);
    setOutline(collectOutline(liveEditorRef.current));
    setContent(htmlToMarkdown(liveEditorRef.current));
  };

  const toggleDirectory = (path: string) => {
    setSelectedEntryPath(path);
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  };

  const revealEntry = (path: string, directory: boolean) => {
    setSelectedEntryPath(path);
    setExpanded((current) => {
      const next = new Set(current);
      let parent = directory ? path : parentPath(path);
      while (parent) {
        next.add(parent);
        parent = parentPath(parent);
      }
      return next;
    });
  };

  const startCreate = (kind: EntryKind, parent = currentDirectory) => {
    setMenu(null);
    setEntryDialog({ action: "create", kind, parent, value: kind === "file" ? "新文档.md" : "新文件夹" });
  };

  const startRename = (entry: DocumentEntry) => {
    setMenu(null);
    setEntryDialog({ action: "rename", kind: entry.kind, source: entry, parent: parentPath(entry.path), value: entry.name });
  };

  const commitEntryDialog = async () => {
    if (!entryDialog) return;
    let name = entryDialog.value.trim();
    if (!name || name === "." || name === ".." || /[\\/:*?"<>|]/.test(name)) {
      setNotice("名称不能为空，也不能包含系统保留字符");
      return;
    }
    if (entryDialog.kind === "file" && !/\.(md|markdown)$/i.test(name)) name += ".md";
    const target = joinPath(entryDialog.parent, name);
    setBusy(true);
    try {
      if (entryDialog.action === "create") {
        await api.create(target, entryDialog.kind);
        const nextTarget = await refresh(entryDialog.kind === "file" ? target : undefined);
        if (entryDialog.kind === "file") {
          revealEntry(target, false);
          await openDocument(nextTarget || target, true);
        }
        else {
          revealEntry(target, true);
        }
        setNotice(`已创建 ${name}`);
      } else if (entryDialog.source) {
        if (!await persistCurrent(true)) return;
        await api.rename(entryDialog.source.path, target);
        const selectedWasInside = selectedRef.current === entryDialog.source.path || selectedRef.current.startsWith(`${entryDialog.source.path}/`);
        const nextPath = selectedWasInside ? `${target}${selectedRef.current.slice(entryDialog.source.path.length)}` : selectedRef.current;
        await refresh(nextPath);
        await refreshLibrary();
        if (selectedWasInside && entryDialog.kind === "file") await openDocument(target, true);
        else setSelectedEntryPath(target);
        setNotice(`已重命名为 ${name}`);
      }
      setEntryDialog(null);
    } catch (error) {
      setNotice(`文件操作失败：${String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteEntry) return;
    setBusy(true);
    try {
      await api.remove(deleteEntry.path);
      const selectedRemoved = selectedRef.current === deleteEntry.path || selectedRef.current.startsWith(`${deleteEntry.path}/`);
      if (selectedRemoved) {
        documentVersionRef.current += 1;
        queuedSaveRef.current = null;
        selectedRef.current = "";
        archiveIdRef.current = "";
        setSelectedPath("");
        setSelectedEntryPath("");
        setArchiveId("");
        setSourcePath("");
        setContent("");
        setSavedContent("");
        setSaveStatus("idle");
        setRenderedHtml("");
      }
      const target = await refresh();
      await refreshLibrary();
      if (selectedRemoved && target) await openDocument(target, true);
      setNotice(`已删除 ${deleteEntry.name}`);
      setDeleteEntry(null);
    } catch (error) {
      setNotice(`删除失败：${String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const importDocuments = async (mode: "files" | "directory") => {
    if (!api.isTauri()) return;
    setImportOpen(false);
    const selected = mode === "directory"
      ? await open({
        directory: true,
        multiple: false,
        recursive: true,
        title: "导入整个 Markdown 文件夹",
      })
      : await open({
        multiple: true,
        filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
        title: "导入 Markdown 文档",
      });
    if (!selected) return;
    setBusy(true);
    try {
      if (mode === "directory") {
        const path = Array.isArray(selected) ? selected[0] : selected;
        if (!path) return;
        const imported = await api.importDirectory(path, currentDirectory);
        await refresh();
        revealEntry(imported.rootPath, true);
        const first = imported.files.at(0);
        if (first) await openDocument(first, true);
        setNotice(
          imported.files.length
            ? `已导入文件夹 · ${imported.files.length} 篇文档 · ${imported.directories} 个文件夹`
            : `已导入空文件夹结构 · ${imported.directories} 个文件夹`,
        );
      } else {
        const imported = await api.importFiles(
          Array.isArray(selected) ? selected : [selected],
          currentDirectory,
        );
        const last = imported.at(-1);
        await refresh(last);
        if (last) {
          revealEntry(last, false);
          await openDocument(last, true);
        }
        setNotice(`已导入 ${imported.length} 篇文档`);
      }
    } catch (error) {
      setNotice(`导入失败：${String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const exportCurrent = async (format: ExportFormat) => {
    if (!api.isTauri() || !selectedPath) return;
    if (!await persistCurrent(true)) return;
    const extension = exportExtension(format);
    const name = nativeFileName(selectedPath).replace(/\.(md|markdown)$/i, "");
    const suffix = format === "pdf-long" ? "-长页" : format === "pdf-pages" ? "-标准分页" : "";
    const target = await saveDialog({
      defaultPath: `${name}${suffix}.${extension}`,
      filters: [{ name: exportLabel(format), extensions: [extension] }],
      title: `导出${exportLabel(format)}`,
    });
    if (!target) return;
    setExporting(true);
    setExportProgress({ progress: 0.02, message: "正在准备导出…" });
    try {
      if (format === "markdown") {
        if (documentOrigin === "archive") {
          await api.exportArchivedDocument(archiveId, target);
        } else {
          await api.exportFile(selectedPath, target);
        }
      } else if (format === "pdf-long" || format === "pdf-pages") {
        const styles = getComputedStyle(document.documentElement);
        const color = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback;
        const job = startPdfExport({
          source: contentRef.current,
          title: name,
          mode: format === "pdf-long" ? "long" : "pages",
          fontFamily: settings.fontFamily,
          palette: {
            text: color("--text", "#1d2922"),
            secondary: color("--text-secondary", "#627068"),
            accent: color("--accent-strong", "#297a4a"),
            accentSoft: color("--accent-soft", "#e8f3ec"),
            border: color("--border", "#d8e2dc"),
            surface: color("--surface", "#ffffff"),
            codeSurface: color("--surface-muted", "#f3f7f4"),
          },
          onProgress: setExportProgress,
        });
        cancelExportRef.current = job.cancel;
        const bytes = await job.promise;
        cancelExportRef.current = null;
        setExportProgress({ progress: 0.98, message: "正在安全写入目标文件…" });
        await api.writeExport(target, bytes);
      } else {
        const html = await api.render(contentRef.current);
        setExportProgress({ progress: 0.16, message: "正在构建导出页面…" });
        await nextFrame();
        const surface = document.createElement("article");
        surface.className = "markdown-body export-document";
        surface.innerHTML = html;
        surface.style.width = `${Math.max(680, settings.contentWidth + 112)}px`;
        surface.style.height = "auto";
        surface.style.minHeight = "0";
        surface.style.padding = "56px";
        surface.style.overflow = "visible";
        document.body.append(surface);
        let cleanup = () => {};
        try {
          const result = await enhanceDocument(surface, settings, documentDirectory, { eager: true });
          cleanup = result.cleanup;
          setExportProgress({ progress: 0.42, message: "正在载入图片、公式和图表…" });
          await inlineExportImages(surface);
          await document.fonts?.ready;
          await nextFrame();
          let bytes: Uint8Array;
          if (format === "html") {
            bytes = new TextEncoder().encode(buildStandaloneHtml(surface, name));
          } else {
            setExportProgress({ progress: 0.46, message: "正在启动高清 PNG 后台编码…" });
            const job = startPngExport(surface, setExportProgress);
            cancelExportRef.current = job.cancel;
            bytes = await job.promise;
            cancelExportRef.current = null;
          }
          setExportProgress({ progress: 0.95, message: "正在安全写入目标文件…" });
          await api.writeExport(target, bytes);
        } finally {
          cleanup();
          surface.remove();
        }
      }
      setExportProgress({ progress: 1, message: "导出完成" });
      setExportOpen(false);
      setNotice(`已导出到 ${target}`);
    } catch (error) {
      setNotice(String(error).includes("导出已取消")
        ? "已取消导出，未写入不完整文件"
        : `导出失败：${String(error)}`);
    } finally {
      cancelExportRef.current = null;
      setExporting(false);
      setExportProgress(null);
    }
  };

  const cancelExport = () => {
    if (!exporting) {
      setExportOpen(false);
      return;
    }
    cancelExportRef.current?.();
  };

  const changeWorkspace = async (path: string) => {
    if (!await persistCurrent(true)) return;
    const payload = await api.setWorkspace(path);
    documentVersionRef.current += 1;
    queuedSaveRef.current = null;
    selectedRef.current = "";
    archiveIdRef.current = "";
    originRef.current = "workspace";
    setSettings(payload.settings);
    setEntries(payload.entries);
    setArchiveEntries(payload.library);
    setAssociationStatus(payload.associationStatus);
    setSelectedPath("");
    setSelectedEntryPath("");
    setDocumentOrigin("workspace");
    setArchiveId("");
    setSourcePath("");
    setSourceExists(true);
    setContent("");
    setSavedContent("");
    setSaveStatus("idle");
    setRenderedHtml("");
    setExpanded(new Set(payload.entries.filter((entry) => entry.kind === "directory" && entry.depth < 2).map((entry) => entry.path)));
    const first = payload.entries.find((entry) => entry.kind === "file");
    if (first) await openDocument(first.path, true);
    else setNotice("新文档库为空，可以创建或导入文档");
  };

  const visibleTree = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return tree;
    return files
      .filter((entry) => entry.path.toLocaleLowerCase().includes(needle))
      .map((entry) => ({ entry: { ...entry, depth: 0 }, children: [] }));
  }, [files, query, tree]);

  const visibleArchiveEntries = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return archiveEntries.filter((entry) => {
      if (sidebarView === "favorites" && !entry.favorite) return false;
      return !needle
        || entry.name.toLocaleLowerCase().includes(needle)
        || entry.sourcePath.toLocaleLowerCase().includes(needle);
    });
  }, [archiveEntries, query, sidebarView]);

  const toggleFavorite = async (entry: ArchiveEntry, favorite: boolean) => {
    try {
      const next = await api.setFavorite(entry.id, favorite);
      setArchiveEntries(next);
      setNotice(favorite ? `已收藏并保留 ${entry.name}` : `已取消收藏 ${entry.name}`);
    } catch (error) {
      setNotice(`收藏操作失败：${String(error)}`);
    }
  };

  const removeHistoryEntry = async (entry: ArchiveEntry) => {
    try {
      const next = await api.removeArchiveEntry(entry.id);
      setArchiveEntries(next);
      setNotice(`已移除 ${entry.name} 的历史记录和保留副本`);
    } catch (error) {
      setNotice(`移除历史失败：${String(error)}`);
    }
  };

  const saveHistoryToWorkspace = async (entry: ArchiveEntry) => {
    if (!await persistCurrent(true)) return;
    setBusy(true);
    try {
      const path = await api.saveArchivedToWorkspace(entry.id);
      await refresh(path);
      setSidebarView("workspace");
      await openDocument(path, true);
      setNotice(`已保存到我的文档库 · ${path}`);
    } catch (error) {
      setNotice(`保存到文档库失败：${String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const clearHistory = async () => {
    try {
      const next = await api.clearHistory();
      setArchiveEntries(next);
      setNotice("已清除未收藏的历史记录，收藏文档及副本均已保留");
    } catch (error) {
      setNotice(`清除历史失败：${String(error)}`);
    }
  };

  const changeAssociation = async (requestDefault: boolean) => {
    try {
      const status = requestDefault
        ? await api.requestDefaultAssociation()
        : await api.getAssociationStatus();
      setAssociationStatus(status);
      setNotice(status.message);
    } catch (error) {
      setNotice(`文件关联设置失败：${String(error)}`);
    }
  };

  const handleTreeMenu = (event: MouseEvent, node: TreeNode) => {
    event.preventDefault();
    event.stopPropagation();
    setSelectedEntryPath(node.entry.path);
    setMenu({ x: event.clientX, y: event.clientY, entry: node.entry });
  };

  const documentDirectory = selectedPath
    ? documentOrigin === "archive"
      ? nativeParentPath(sourcePath)
      : joinNativePath(settings.workspacePath, parentPath(selectedPath))
    : settings.workspacePath;

  return (
    <div className={`app-shell${sidebarOpen ? "" : " sidebar-closed"}${outlineOpen ? " outline-visible" : ""}${api.isAndroid() ? " platform-android" : ""}`} onClick={() => setMenu(null)}>
      {!api.isAndroid() && <TitleBar />}
      {busy && <div className="top-progress" />}
      <aside className="sidebar">
        <div className="sidebar-toolbar">
          <div className="brand-mark" aria-label="LeafMark"><BookOpen size={17} /></div>
          <div className="sidebar-actions">
            <button className="icon-button" type="button" onClick={() => startCreate("file")} title="新建文档"><FilePlus2 size={16} /></button>
            <button className="icon-button" type="button" onClick={() => startCreate("directory")} title="新建文件夹"><FolderPlus size={16} /></button>
            <button className="icon-button" type="button" onClick={() => setImportOpen(true)} title="导入文件或文件夹"><Upload size={15} /></button>
            <button className="icon-button" type="button" onClick={() => setSidebarOpen(false)} title="收起目录"><PanelLeftClose size={16} /></button>
          </div>
        </div>
        <div className="sidebar-views" aria-label="文档来源">
          <button className={sidebarView === "workspace" ? "active" : ""} type="button" onClick={() => setSidebarView("workspace")} title="文档库"><Files size={14} /> 文档</button>
          <button className={sidebarView === "history" ? "active" : ""} type="button" onClick={() => setSidebarView("history")} title="打开历史"><Clock3 size={14} /> 历史</button>
          <button className={sidebarView === "favorites" ? "active" : ""} type="button" onClick={() => setSidebarView("favorites")} title="收藏"><Star size={14} /> 收藏</button>
        </div>
        <div className="sidebar-search">
          <Search size={14} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={sidebarView === "workspace" ? "搜索文档…" : sidebarView === "history" ? "搜索历史…" : "搜索收藏…"}
          />
          <kbd>⌘P</kbd>
        </div>
        <div className="library-label">
          {sidebarView === "workspace" ? (
            <>
              <span title={settings.workspacePath}>{lastDirectory(settings.workspacePath) || "文档库"}</span>
              <button className="icon-button compact" type="button" onClick={() => void refresh().then((target) => {
                if (target) return openDocument(target, true);
              })} title="刷新目录"><RefreshCw size={13} /></button>
            </>
          ) : (
            <>
              <span>{sidebarView === "history" ? "最近打开 · 自动保留副本" : "收藏文档 · 永久保留"}</span>
              {sidebarView === "history" && archiveEntries.some((entry) => !entry.favorite) && (
                <button className="text-icon-button" type="button" onClick={() => void clearHistory()} title="清除未收藏历史">
                  <Trash2 size={12} /> 清除
                </button>
              )}
            </>
          )}
        </div>
        <div className="tree">
          {sidebarView === "workspace" ? (
            <div role="tree" aria-label="文档目录" onContextMenu={(event) => {
              if ((event.target as HTMLElement).closest(".tree-row")) return;
              event.preventDefault();
              setMenu({ x: event.clientX, y: event.clientY, entry: null });
            }}>
              {visibleTree.length > 0
                ? <FileTree nodes={visibleTree} selectedPath={selectedEntryPath} expanded={expanded} onOpen={(path) => void openDocument(path)} onToggle={toggleDirectory} onMenu={handleTreeMenu} />
                : <div className="tree-empty"><FileCode2 size={24} /><strong>{query ? "没有匹配文档" : "文档库为空"}</strong><span>{query ? "换一个关键词试试" : "新建或导入 Markdown"}</span></div>}
            </div>
          ) : (
            <DocumentLibrary
              entries={visibleArchiveEntries}
              selectedId={archiveId}
              emptyTitle={query ? "没有匹配文档" : sidebarView === "favorites" ? "还没有收藏" : "还没有打开历史"}
              emptyDetail={query ? "换一个关键词试试" : sidebarView === "favorites" ? "打开文档后点击星标收藏" : "从资源管理器或文档库打开 Markdown"}
              onOpen={(entry) => void openArchivedDocument(entry)}
              onFavorite={(entry, favorite) => void toggleFavorite(entry, favorite)}
              onSaveToWorkspace={(entry) => void saveHistoryToWorkspace(entry)}
              onRemove={(entry) => void removeHistoryEntry(entry)}
            />
          )}
        </div>
        <footer className="sidebar-footer">
          <span>{sidebarView === "workspace" ? `${files.length} 篇文档` : sidebarView === "history" ? `${archiveEntries.length} 条历史` : `${archiveEntries.filter((entry) => entry.favorite).length} 个收藏`}</span>
          <button type="button" onClick={() => setSettingsOpen(true)}><Settings size={14} /> 设置</button>
        </footer>
      </aside>
      {sidebarOpen && <button className="sidebar-scrim" type="button" onClick={() => setSidebarOpen(false)} aria-label="关闭文档抽屉" />}

      <main className="workspace">
        <header className="document-toolbar">
          <div className="document-leading">
            {!sidebarOpen && <button className="icon-button" type="button" onClick={() => setSidebarOpen(true)} title="展开目录"><PanelLeftOpen size={17} /></button>}
            <div className="breadcrumbs" title={sourcePath || selectedPath}>
              {selectedPath ? displayPathParts(documentOrigin === "archive" ? sourcePath : selectedPath).map((part, index) => (
                <span key={`${part}-${index}`}>{index > 0 && <ChevronRight size={11} />}{part}</span>
              )) : <span>未选择文档</span>}
            </div>
            {selectedPath && !sourceExists && <span className="retained-badge">保留副本</span>}
            {saveStatus === "error"
              ? <span className="save-state error"><CircleAlert size={12} /> 保存失败</span>
              : dirty
                ? <span className="save-state saving"><span /> 保存中</span>
                : selectedPath
                  ? <span className="save-state"><Check size={12} /> 已保存</span>
                  : null}
          </div>

          <div className="document-actions">
            {mode === "live" && (
              <div className="format-toolbar" aria-label="格式工具">
                <button type="button" onMouseDown={(event) => { event.preventDefault(); runFormat("bold"); }} title="粗体"><Bold size={14} /></button>
                <button type="button" onMouseDown={(event) => { event.preventDefault(); runFormat("italic"); }} title="斜体"><Italic size={14} /></button>
                <button type="button" onMouseDown={(event) => { event.preventDefault(); runFormat("strikeThrough"); }} title="删除线"><Strikethrough size={14} /></button>
                <button type="button" onMouseDown={(event) => { event.preventDefault(); runFormat("insertUnorderedList"); }} title="无序列表"><List size={14} /></button>
                <button type="button" onMouseDown={(event) => { event.preventDefault(); runFormat("insertOrderedList"); }} title="有序列表"><ListOrdered size={14} /></button>
              </div>
            )}
            <div className="mode-switch" aria-label="文档模式">
              <ModeButton active={mode === "read"} title="阅读" onClick={() => void switchMode("read")}><Eye size={15} /></ModeButton>
              <ModeButton active={mode === "source"} title="源码" onClick={() => void switchMode("source")}><FileCode2 size={15} /></ModeButton>
              <ModeButton active={mode === "split"} title="分栏" onClick={() => void switchMode("split")}><SplitSquareHorizontal size={15} /></ModeButton>
              {settings.liveEditing && <ModeButton active={mode === "live"} title="实时编译" onClick={() => void switchMode("live")}><PencilLine size={15} /></ModeButton>}
            </div>
            <button
              className={`icon-button${currentArchiveEntry?.favorite ? " active favorite" : ""}`}
              type="button"
              onClick={() => currentArchiveEntry && void toggleFavorite(currentArchiveEntry, !currentArchiveEntry.favorite)}
              title={currentArchiveEntry?.favorite ? "取消收藏" : "收藏并保留副本"}
              disabled={!archiveId}
            >
              <Star size={16} fill={currentArchiveEntry?.favorite ? "currentColor" : "none"} />
            </button>
            <button className={`icon-button${outlineOpen ? " active" : ""}`} type="button" onClick={() => setOutlineOpen((open) => !open)} title="文章大纲" disabled={!selectedPath}><LayoutPanelLeft size={16} /></button>
            <button className="icon-button" type="button" onClick={() => void persistCurrent()} title="保存 (Ctrl+S)" disabled={!dirty}><Save size={16} /></button>
            <button className="icon-button" type="button" onClick={() => setExportOpen(true)} title="导出" disabled={!selectedPath || !api.isTauri()}><Download size={15} /></button>
            <button className="icon-button" type="button" onClick={() => setSettingsOpen(true)} title="设置 (Ctrl+,)"><Settings size={16} /></button>
          </div>
        </header>

        <div className={`document-host mode-${mode}${settings.showStatusBar ? " with-status" : ""}`}>
          {!selectedPath ? (
            <EmptyWorkspace onCreate={() => startCreate("file", "")} onImport={() => setImportOpen(true)} />
          ) : (
            <>
              {(mode === "source" || mode === "split") && (
                <textarea
                  className="source-editor"
                  aria-label="Markdown 源码编辑器"
                  spellCheck={false}
                  value={content}
                  onChange={(event) => setContent(event.target.value)}
                />
              )}
              {(mode === "read" || mode === "split" || mode === "live") && (
                <DocumentSurface
                  key={`${selectedPath}-${mode}`}
                  html={renderedHtml}
                  live={mode === "live"}
                  settings={settings}
                  documentDirectory={documentDirectory}
                  editorRef={liveEditorRef}
                  onInput={onLiveInput}
                  onOutline={setOutline}
                  onNavigate={(href) => {
                    if (href.startsWith("#")) {
                      document.getElementById(href.slice(1))?.scrollIntoView({ behavior: settings.reduceMotion ? "auto" : "smooth" });
                      return;
                    }
                    if (/^(https?:|mailto:)/i.test(href)) {
                      if (api.isTauri()) void openUrl(href);
                      else window.open(href, "_blank", "noopener");
                      return;
                    }
                    if (documentOrigin === "archive") {
                      const externalTarget = resolveExternalMarkdownPath(documentDirectory, href);
                      if (externalTarget) void openExternalDocument(externalTarget);
                      else setNotice(`找不到本地文档：${href}`);
                      return;
                    }
                    const target = resolveMarkdownLink(selectedPath, href);
                    if (entryMap.has(target)) void openDocument(target);
                    else setNotice(`找不到本地文档：${target}`);
                  }}
                />
              )}
              {rendering && <div className="rendering-indicator">编译中</div>}
            </>
          )}
        </div>

        {settings.showStatusBar && (
          <footer className="statusbar">
            <span className={notice.includes("失败") ? "error" : ""}>{notice}</span>
            {selectedPath && <div>{!sourceExists && <span>LeafMark 副本</span>}<span>UTF-8</span><span>Markdown</span><span>{countWords(content).toLocaleString()} 字</span><span>{formatBytes(new Blob([content]).size)}</span></div>}
          </footer>
        )}
      </main>

      {outlineOpen && (
        <aside className="outline-panel">
          <header><strong>文章大纲</strong><button className="icon-button compact" type="button" onClick={() => setOutlineOpen(false)}><X size={14} /></button></header>
          <nav>
            {outline.length ? outline.map((item) => <button key={item.id} type="button" style={{ "--outline-depth": Math.max(0, item.level - 1) } as React.CSSProperties} onClick={() => document.getElementById(item.id)?.scrollIntoView({ behavior: settings.reduceMotion ? "auto" : "smooth" })}>{item.text}</button>) : <span>这篇文档没有标题</span>}
          </nav>
        </aside>
      )}

      {menu && (
        <div className="context-menu" style={{ left: Math.min(menu.x, window.innerWidth - 190), top: Math.min(menu.y, window.innerHeight - 180) }} onClick={(event) => event.stopPropagation()}>
          {menu.entry?.kind === "file" && <button type="button" onClick={() => { void openDocument(menu.entry!.path); setMenu(null); }}><Eye size={14} /> 打开</button>}
          <button type="button" onClick={() => startCreate("file", menu.entry?.kind === "directory" ? menu.entry.path : parentPath(menu.entry?.path ?? ""))}><FilePlus2 size={14} /> 新建文档</button>
          <button type="button" onClick={() => startCreate("directory", menu.entry?.kind === "directory" ? menu.entry.path : parentPath(menu.entry?.path ?? ""))}><FolderPlus size={14} /> 新建文件夹</button>
          {menu.entry && <><hr /><button type="button" onClick={() => startRename(menu.entry!)}><PencilLine size={14} /> 重命名</button><button className="danger" type="button" onClick={() => { setDeleteEntry(menu.entry); setMenu(null); }}><Trash2 size={14} /> 删除</button></>}
        </div>
      )}

      {entryDialog && (
        <PromptDialog
          title={entryDialog.action === "create" ? (entryDialog.kind === "file" ? "新建文档" : "新建文件夹") : "重命名"}
          description={entryDialog.parent ? `位置：${entryDialog.parent}` : "位置：文档库根目录"}
          value={entryDialog.value}
          confirmLabel={entryDialog.action === "create" ? "创建" : "保存"}
          onChange={(value) => setEntryDialog({ ...entryDialog, value })}
          onCancel={() => setEntryDialog(null)}
          onConfirm={() => void commitEntryDialog()}
        />
      )}

      {deleteEntry && (
        <ConfirmDialog
          title={`删除“${deleteEntry.name}”？`}
          description={deleteEntry.kind === "directory" ? "文件夹及其中所有文档都会被删除，此操作无法撤销。" : "文档将从本地磁盘删除，此操作无法撤销。"}
          onCancel={() => setDeleteEntry(null)}
          onConfirm={() => void confirmDelete()}
        />
      )}

      {exportOpen && (
        <ExportDialog
          busy={exporting}
          progress={exportProgress}
          onCancel={cancelExport}
          onExport={(format) => void exportCurrent(format)}
        />
      )}

      {importOpen && (
        <ImportDialog
          android={api.isAndroid()}
          onCancel={() => setImportOpen(false)}
          onImport={(mode) => void importDocuments(mode)}
        />
      )}

      {settingsOpen && (
        <SettingsPanel
          settings={settings}
          associationStatus={associationStatus}
          onChange={setSettings}
          onWorkspaceChange={changeWorkspace}
          onAssociationChange={changeAssociation}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  );
}

function TitleBar() {
  const localizedTitle = navigator.language.toLowerCase().startsWith("zh") ? "一叶" : "LeafMark";
  const perform = (action: "minimize" | "maximize" | "close") => {
    if (!api.isTauri()) return;
    const window = getCurrentWindow();
    if (action === "minimize") void window.minimize();
    if (action === "maximize") void window.toggleMaximize();
    if (action === "close") void window.close();
  };
  return (
    <header className="app-titlebar" data-tauri-drag-region onDoubleClick={() => perform("maximize")}>
      <div className="app-titlebar-brand" data-tauri-drag-region>
        <BookOpen size={13} />
        <span data-tauri-drag-region>{localizedTitle}</span>
      </div>
      <div className="window-controls" onDoubleClick={(event) => event.stopPropagation()}>
        <button type="button" onClick={() => perform("minimize")} aria-label="最小化"><Minus size={14} /></button>
        <button type="button" onClick={() => perform("maximize")} aria-label="最大化或还原"><Square size={11} /></button>
        <button className="window-close" type="button" onClick={() => perform("close")} aria-label="关闭"><X size={14} /></button>
      </div>
    </header>
  );
}

function ExportDialog({ busy, progress, onCancel, onExport }: {
  busy: boolean;
  progress: ExportProgress | null;
  onCancel: () => void;
  onExport: (format: ExportFormat) => void;
}) {
  const [format, setFormat] = useState<ExportFormat>("html");
  const options: { value: ExportFormat; title: string; detail: string }[] = [
    { value: "markdown", title: "Markdown 原文", detail: "保留可继续编辑的 .md 文件" },
    { value: "html", title: "HTML 网页", detail: "带当前主题、公式与图表的独立页面" },
    { value: "png", title: "PNG 长图", detail: "单次排版，后台生成 2–2.5× 高清长图" },
    { value: "pdf-long", title: "PDF · 连续长页", detail: "保持字号与矢量清晰度，超长内容自动分段" },
    { value: "pdf-pages", title: "PDF · A4 标准分页", detail: "适合打印与文档归档" },
  ];
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onCancel()}>
      <section className="export-dialog" role="dialog" aria-modal="true" aria-label="导出文档">
        <header><div><small>EXPORT</small><h2>导出文档</h2></div><button className="icon-button" type="button" onClick={onCancel}><X size={17} /></button></header>
        <div className="export-options">
          {options.map((option) => (
            <button key={option.value} type="button" className={format === option.value ? "active" : ""} onClick={() => setFormat(option.value)} disabled={busy}>
              <span className="export-radio">{format === option.value && <span />}</span>
              <span><strong>{option.title}</strong><small>{option.detail}</small></span>
            </button>
          ))}
        </div>
        {busy && progress && (
          <div className="export-progress" role="status" aria-live="polite">
            <div><span>{progress.message}</span><strong>{Math.round(progress.progress * 100)}%</strong></div>
            <progress max={1} value={progress.progress} />
            <small>导出在后台进行，可以继续查看当前进度或随时取消。</small>
          </div>
        )}
        <footer>
          <button className="secondary-button" type="button" onClick={onCancel}>{busy ? "取消导出" : "取消"}</button>
          <button className="primary-button" type="button" onClick={() => onExport(format)} disabled={busy}>{busy ? "后台生成中…" : `导出 ${exportLabel(format)}`}</button>
        </footer>
      </section>
    </div>
  );
}

function ImportDialog({ android, onCancel, onImport }: {
  android: boolean;
  onCancel: () => void;
  onImport: (mode: "files" | "directory") => void;
}) {
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onCancel()}>
      <section className="export-dialog import-dialog" role="dialog" aria-modal="true" aria-label="导入文档">
        <header><div><small>IMPORT</small><h2>导入到文档库</h2></div><button className="icon-button" type="button" onClick={onCancel}><X size={17} /></button></header>
        <div className="export-options import-options">
          <button type="button" onClick={() => onImport("files")}>
            <span className="import-option-icon"><Upload size={17} /></span>
            <span><strong>导入 Markdown 文件</strong><small>可一次选择多篇 .md 或 .markdown 文档</small></span>
          </button>
          {!android && (
            <button type="button" onClick={() => onImport("directory")}>
              <span className="import-option-icon"><FolderPlus size={17} /></span>
              <span><strong>导入整个文件夹</strong><small>递归保留目录结构与空文件夹，自动忽略非 Markdown 文件</small></span>
            </button>
          )}
        </div>
        <footer><button className="secondary-button" type="button" onClick={onCancel}>取消</button></footer>
      </section>
    </div>
  );
}

function DocumentSurface({ html, live, settings, documentDirectory, editorRef, onInput, onOutline, onNavigate }: {
  html: string;
  live: boolean;
  settings: AppSettings;
  documentDirectory: string;
  editorRef: React.RefObject<HTMLElement | null>;
  onInput: () => void;
  onOutline: (outline: OutlineItem[]) => void;
  onNavigate: (href: string) => void;
}) {
  const localRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const root = localRef.current;
    if (!root) return;
    root.innerHTML = html;
    let cleanup = () => {};
    let active = true;
    void enhanceDocument(root, settings, documentDirectory).then((result) => {
      if (!active) return result.cleanup();
      cleanup = result.cleanup;
      onOutline(result.outline);
    });
    return () => { active = false; cleanup(); };
  }, [documentDirectory, html, onOutline, settings.mathEnabled, settings.mermaidEnabled, settings.theme]);

  return (
    <article
      ref={(node) => {
        localRef.current = node;
        (editorRef as React.MutableRefObject<HTMLElement | null>).current = node;
      }}
      className={`markdown-body${live ? " live-editor" : ""}`}
      contentEditable={live}
      suppressContentEditableWarning
      spellCheck={live}
      onInput={live ? onInput : undefined}
      onClick={(event) => {
        const anchor = (event.target as HTMLElement).closest<HTMLAnchorElement>("a");
        if (!anchor) return;
        event.preventDefault();
        onNavigate(anchor.getAttribute("href") ?? "");
      }}
    />
  );
}

function ModeButton({ active, title, onClick, children }: { active: boolean; title: string; onClick: () => void; children: React.ReactNode }) {
  return <button type="button" className={active ? "active" : ""} onClick={onClick} title={title}>{children}</button>;
}

function EmptyWorkspace({ onCreate, onImport }: { onCreate: () => void; onImport: () => void }) {
  return (
    <div className="empty-workspace">
      <div className="empty-symbol"><BookOpen size={30} /></div>
      <h1>从一篇 Markdown 开始</h1>
      <p>内容直接保存在本地目录。没有数据库、没有专有格式，也没有等待。</p>
      <div><button className="primary-button" type="button" onClick={onCreate}><FilePlus2 size={15} /> 新建文档</button><button className="secondary-button" type="button" onClick={onImport}><Upload size={15} /> 导入文档</button></div>
    </div>
  );
}

function PromptDialog({ title, description, value, confirmLabel, onChange, onCancel, onConfirm }: {
  title: string; description: string; value: string; confirmLabel: string; onChange: (value: string) => void; onCancel: () => void; onConfirm: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); input.current?.select(); }, []);
  return (
    <div className="dialog-backdrop" role="presentation">
      <form className="small-dialog" onSubmit={(event) => { event.preventDefault(); onConfirm(); }}>
        <h2>{title}</h2><p>{description}</p>
        <input ref={input} value={value} onChange={(event) => onChange(event.target.value)} onKeyDown={(event) => event.key === "Escape" && onCancel()} />
        <footer><button className="secondary-button" type="button" onClick={onCancel}>取消</button><button className="primary-button" type="submit">{confirmLabel}</button></footer>
      </form>
    </div>
  );
}

function ConfirmDialog({ title, description, onCancel, onConfirm }: { title: string; description: string; onCancel: () => void; onConfirm: () => void }) {
  return (
    <div className="dialog-backdrop" role="presentation">
      <section className="small-dialog confirm-dialog">
        <div className="warning-icon"><CircleAlert size={20} /></div><h2>{title}</h2><p>{description}</p>
        <footer><button className="secondary-button" type="button" onClick={onCancel}>取消</button><button className="danger-button" type="button" onClick={onConfirm}>确认删除</button></footer>
      </section>
    </div>
  );
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function readerFontStack(fontFamily: string) {
  const fallback = '"Iowan Old Style", "Source Han Serif SC", "Noto Serif CJK SC", "Songti SC", Georgia, "Segoe UI", serif';
  const family = fontFamily.trim();
  return !family || family === "system" ? fallback : `${JSON.stringify(family)}, ${fallback}`;
}

function countWords(value: string) {
  const cjk = value.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu)?.length ?? 0;
  const latin = value.replace(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu, " ").match(/\b[\p{Letter}\p{Number}_'-]+\b/gu)?.length ?? 0;
  return cjk + latin;
}

function lastDirectory(path: string) {
  return path.replace(/[\\/]$/, "").split(/[\\/]/).at(-1) ?? path;
}

function nativeFileName(path: string) {
  return path.replace(/[\\/]$/, "").split(/[\\/]/).at(-1) ?? path;
}

function exportLabel(format: ExportFormat) {
  if (format === "markdown") return "Markdown";
  if (format === "html") return "HTML";
  if (format === "png") return "PNG";
  if (format === "pdf-long") return "长页 PDF";
  return "标准 PDF";
}

function nativeParentPath(path: string) {
  const normalized = path.replace(/[\\/]$/, "");
  const separator = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  return separator >= 0 ? normalized.slice(0, separator) : "";
}

function displayPathParts(path: string) {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length > 4 ? ["…", ...parts.slice(-3)] : parts;
}

function nextFrame() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

function joinNativePath(root: string, relative: string) {
  if (!relative) return root;
  const separator = root.includes("\\") ? "\\" : "/";
  return `${root.replace(/[\\/]$/, "")}${separator}${relative.replaceAll("/", separator)}`;
}

function resolveExternalMarkdownPath(directory: string, href: string) {
  let decoded = href.split(/[?#]/, 1)[0];
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    return "";
  }
  if (!/\.(md|markdown)$/i.test(decoded)) return "";
  if (/^[a-z]:[\\/]/i.test(decoded) || decoded.startsWith("/") || decoded.startsWith("\\\\")) {
    return decoded;
  }
  return joinNativePath(directory, decoded);
}
