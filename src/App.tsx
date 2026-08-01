import {
  Bold,
  Bot,
  BookOpen,
  Check,
  CircleAlert,
  Clock3,
  Download,
  Eye,
  FileCode2,
  FilePlus2,
  Files,
  FolderOpen,
  FolderPlus,
  Italic,
  LayoutPanelLeft,
  List,
  ListOrdered,
  Menu,
  Minus,
  PanelLeftClose,
  PanelLeftOpen,
  PanelsTopLeft,
  PencilLine,
  RefreshCw,
  Save,
  Search,
  Settings,
  Share2,
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
  AgentPanel,
  type AgentDocumentHost,
  type AgentDocumentStreamHandle,
  type AgentDocumentStreamMode,
  type AgentDocumentStreamResult,
} from "./components/AgentPanel";
import { DockDropTargets, DockRegion } from "./components/DockRegion";
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
  AgentReasoningEffort,
  AgentVersionOperation,
  AgentVersionStatus,
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
import {
  applyLiveInlineMarkdownShortcut,
  applyLiveMarkdownShortcut,
  htmlToMarkdown,
  runFormat,
} from "./wysiwyg";
import { defaultAppSettings } from "./settings-defaults";
import {
  activateDockPanel,
  dockZoneAtPoint,
  hideDockPanel,
  moveDockPanel,
  normalizeDesktopDockLayout,
  resizeDockZone,
  visibleDockPanels,
} from "./dock-layout";
import {
  nextTabAfterClose,
  tabFromLoadedDocument,
  upsertDocumentTab,
  type OpenDocumentTab,
} from "./document-tabs";
import type { DockPanelId, DockZone } from "./types";

interface EntryDialogState {
  action: "create" | "rename";
  kind: EntryKind;
  source?: DocumentEntry;
  parent: string;
  value: string;
}

interface WorkspaceMenuState {
  kind: "workspace";
  x: number;
  y: number;
  entry: DocumentEntry | null;
}

interface ArchiveMenuState {
  kind: "archive";
  x: number;
  y: number;
  entry: ArchiveEntry;
}

type MenuState = WorkspaceMenuState | ArchiveMenuState;
type SidebarView = "workspace" | "history" | "favorites" | "agent";
type SaveStatus = "idle" | "saving" | "saved" | "error";
type ExportDelivery = "save" | "share";

interface AgentDocumentStreamTransaction extends AgentDocumentStreamHandle {
  tabKey: string;
  origin: DocumentOrigin;
  archiveId: string;
  initialContent: string;
  buffer: string;
  lastSaved: string;
  started: boolean;
  created: boolean;
  previousMode: ViewMode;
  uiTimer: number | null;
  saveTimer: number | null;
  writeQueue: Promise<void>;
  writeError: unknown | null;
}

type AndroidBackWindow = Window & {
  __LEAFMARK_ANDROID_BACK__?: () => boolean;
  LeafMarkAndroid?: { setDarkMode: (dark: boolean) => void };
};

const isCompactLayout = () => window.matchMedia("(max-width: 620px)").matches;

const EMPTY_SETTINGS: AppSettings = defaultAppSettings();

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
  const [openTabs, setOpenTabs] = useState<OpenDocumentTab[]>([]);
  const [activeTabKey, setActiveTabKey] = useState("");
  const [sidebarView, setSidebarView] = useState<SidebarView>("workspace");
  const [sidebarOpen, setSidebarOpen] = useState(() => !isCompactLayout());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState("正在启动…");
  const [busy, setBusy] = useState(true);
  const [bootstrapped, setBootstrapped] = useState(false);
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
  const [agentTurnActive, setAgentTurnActive] = useState(false);
  const [streamingDocument, setStreamingDocument] = useState<{ id: string; tabKey: string; path: string } | null>(null);
  const [draggedPanel, setDraggedPanel] = useState<DockPanelId | null>(null);
  const [dockDragZone, setDockDragZone] = useState<DockZone | null>(null);
  const [layoutMenuOpen, setLayoutMenuOpen] = useState(false);
  const contentRef = useRef(content);
  const savedRef = useRef(savedContent);
  const selectedRef = useRef(selectedPath);
  const originRef = useRef<DocumentOrigin>(documentOrigin);
  const archiveIdRef = useRef(archiveId);
  const modeRef = useRef<ViewMode>(mode);
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
  const openIntentQueueRef = useRef<Promise<void>>(Promise.resolve());
  const tabsRef = useRef<OpenDocumentTab[]>(openTabs);
  const activeTabKeyRef = useRef(activeTabKey);
  const agentDocumentStreamRef = useRef<AgentDocumentStreamTransaction | null>(null);
  const agentTurnActiveRef = useRef(false);
  const android = api.isAndroid();

  const dirty = Boolean(selectedPath) && content !== savedContent;
  const files = useMemo(() => entries.filter((entry) => entry.kind === "file"), [entries]);
  const tree = useMemo(() => buildTree(entries), [entries]);
  const entryMap = useMemo(() => new Map(entries.map((entry) => [entry.path, entry])), [entries]);
  const selectedEntry = entryMap.get(selectedEntryPath);
  const currentDirectory = selectedEntry?.kind === "directory" ? selectedEntry.path : parentPath(selectedEntryPath);
  const currentArchiveEntry = archiveEntries.find((entry) => entry.id === archiveId);
  const activeDocumentStreaming = streamingDocument?.tabKey === activeTabKey;

  const rejectDuringAgentTurn = (action: string) => {
    const stream = agentDocumentStreamRef.current;
    if (!agentTurnActiveRef.current && !stream) return false;
    const target = stream ? `向 ${nativeFileName(stream.path)} 写入` : "执行任务";
    setNotice(`Agent 正在${target}，请停止或等待本轮完成后再${action}`);
    return true;
  };

  const handleAgentActivityChange = useCallback((active: boolean) => {
    agentTurnActiveRef.current = active;
    setAgentTurnActive(active);
  }, []);

  useEffect(() => { contentRef.current = content; }, [content]);
  useEffect(() => { savedRef.current = savedContent; }, [savedContent]);
  useEffect(() => { selectedRef.current = selectedPath; }, [selectedPath]);
  useEffect(() => { originRef.current = documentOrigin; }, [documentOrigin]);
  useEffect(() => { archiveIdRef.current = archiveId; }, [archiveId]);
  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => { tabsRef.current = openTabs; }, [openTabs]);
  useEffect(() => { activeTabKeyRef.current = activeTabKey; }, [activeTabKey]);

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
    root.style.colorScheme = resolved;
    (window as AndroidBackWindow).LeafMarkAndroid?.setDarkMode(resolved === "dark");
    const themeColor = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (themeColor) {
      themeColor.content = resolved === "dark" ? "#171b18" : "#f5f6f2";
    }
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
    const stream = agentDocumentStreamRef.current;
    if (stream?.tabKey === activeTabKeyRef.current) {
      if (!stream.started || stream.buffer === stream.lastSaved) return Promise.resolve(true);
      if (stream.saveTimer !== null) {
        window.clearTimeout(stream.saveTimer);
        stream.saveTimer = null;
      }
      return writeAgentStreamSnapshot(stream, stream.buffer)
        .then(() => true)
        .catch(() => false);
    }
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
        const tabKey = origin === "archive" ? `archive:${archive}` : `workspace:${path}`;
        setOpenTabs((tabs) => tabs.map((tab) => tab.key === tabKey ? { ...tab, content: value, savedContent: value } : tab));
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

  const applyTabSnapshot = useCallback((tab: OpenDocumentTab) => {
    documentVersionRef.current += 1;
    queuedSaveRef.current = null;
    selectedRef.current = tab.path;
    originRef.current = tab.origin;
    archiveIdRef.current = tab.archiveId;
    contentRef.current = tab.content;
    savedRef.current = tab.savedContent;
    activeTabKeyRef.current = tab.key;
    setActiveTabKey(tab.key);
    setSelectedPath(tab.path);
    setSelectedEntryPath(tab.origin === "workspace" ? tab.path : "");
    setDocumentOrigin(tab.origin);
    setArchiveId(tab.archiveId);
    setSourcePath(tab.sourcePath);
    setSourceExists(tab.sourceExists);
    setContent(tab.content);
    setSavedContent(tab.savedContent);
    setSaveStatus(tab.content === tab.savedContent ? "saved" : "saving");
    setRenderedHtml(tab.renderedHtml);
  }, []);

  const applyLoadedDocument = useCallback((loaded: LoadedDocument) => {
    const tab = tabFromLoadedDocument(loaded);
    setOpenTabs((current) => upsertDocumentTab(current, loaded));
    applyTabSnapshot(tab);
    if (isCompactLayout()) setSidebarOpen(false);
  }, [applyTabSnapshot]);

  useEffect(() => {
    if (!activeTabKey) return;
    setOpenTabs((current) => current.map((tab) => tab.key === activeTabKey ? {
      ...tab,
      path: selectedPath,
      origin: documentOrigin,
      archiveId,
      sourcePath,
      sourceExists,
      content,
      savedContent,
      renderedHtml,
      size: new Blob([content]).size,
    } : tab));
  }, [activeTabKey, archiveId, content, documentOrigin, renderedHtml, savedContent, selectedPath, sourceExists, sourcePath]);

  const activateDocumentTab = useCallback(async (tab: OpenDocumentTab, agentAuthorized = false): Promise<boolean> => {
    if (agentTurnActiveRef.current && !agentAuthorized) {
      setNotice("Agent 工作期间已锁定当前文档，停止或等待完成后即可切换");
      return false;
    }
    if (tab.key === activeTabKeyRef.current) return true;
    if (!await persistCurrent(true)) return false;
    applyTabSnapshot(tab);
    if (agentDocumentStreamRef.current?.tabKey === tab.key) {
      modeRef.current = "source";
      setMode("source");
    }
    if (isCompactLayout()) setSidebarOpen(false);
    return true;
  }, [applyTabSnapshot, persistCurrent]);

  const openDocument = useCallback(async (path: string, force = false, agentAuthorized = false): Promise<boolean> => {
    if (agentTurnActiveRef.current && !agentAuthorized) {
      setNotice("Agent 工作期间已锁定当前文档，停止或等待完成后即可打开其他文档");
      return false;
    }
    if (!force && path === selectedRef.current) return true;
    const existing = !force ? tabsRef.current.find((tab) => tab.origin === "workspace" && tab.path === path) : null;
    if (existing) {
      return activateDocumentTab(existing, agentAuthorized);
    }
    if (!await persistCurrent(true)) return false;
    setBusy(true);
    try {
      const loaded = await api.readDocument(path);
      applyLoadedDocument(loaded);
      void refreshLibrary();
      setNotice(`${loaded.cached ? "瞬时打开（缓存）" : "已打开"} · ${formatBytes(loaded.size)}`);
      return true;
    } catch (error) {
      setNotice(`打开文档失败：${String(error)}`);
      return false;
    } finally {
      setBusy(false);
    }
  }, [activateDocumentTab, applyLoadedDocument, persistCurrent, refreshLibrary]);

  const openExternalDocument = useCallback(async (path: string) => {
    if (agentTurnActiveRef.current) {
      setNotice("Agent 工作期间暂缓打开外部文档，请在本轮结束后重试");
      return;
    }
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
    if (agentTurnActiveRef.current) {
      setNotice("Agent 工作期间已锁定当前文档，停止或等待完成后即可打开历史副本");
      return;
    }
    const existing = tabsRef.current.find((tab) => tab.key === `archive:${entry.id}`);
    if (existing) {
      await activateDocumentTab(existing);
      return;
    }
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
  }, [activateDocumentTab, applyLoadedDocument, persistCurrent, refreshLibrary]);

  const clearCurrentDocument = useCallback(() => {
    documentVersionRef.current += 1;
    queuedSaveRef.current = null;
    selectedRef.current = "";
    archiveIdRef.current = "";
    originRef.current = "workspace";
    contentRef.current = "";
    savedRef.current = "";
    activeTabKeyRef.current = "";
    setActiveTabKey("");
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
    setOutline([]);
  }, []);

  const closeDocumentTab = useCallback(async (key: string) => {
    if (agentTurnActiveRef.current) {
      setNotice("Agent 工作期间不能关闭文档标签页");
      return;
    }
    if (agentDocumentStreamRef.current?.tabKey === key) {
      setNotice("Agent 正在向该文档流式写入，请先停止本轮任务");
      return;
    }
    const tabs = tabsRef.current;
    const closing = tabs.find((tab) => tab.key === key);
    if (!closing) return;
    const isActive = key === activeTabKeyRef.current;
    if (isActive && !await persistCurrent(true)) return;
    const nextActive = isActive ? nextTabAfterClose(tabs, key) : null;
    const nextTabs = tabs.filter((tab) => tab.key !== key);
    tabsRef.current = nextTabs;
    setOpenTabs(nextTabs);
    if (isActive) {
      if (nextActive) applyTabSnapshot(nextActive);
      else clearCurrentDocument();
    }
  }, [applyTabSnapshot, clearCurrentDocument, persistCurrent]);

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
        if (payload.initialDocument) {
          applyLoadedDocument(payload.initialDocument);
          setSidebarView("history");
          setNotice(`已从系统打开 · 已保留副本 · ${formatBytes(payload.initialDocument.size)}`);
          return;
        }
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
      .finally(() => {
        if (!active) return;
        setBootstrapped(true);
        setBusy(false);
      });
    return () => { active = false; };
  }, [applyLoadedDocument, openDocument, openExternalDocument]);

  useEffect(() => {
    if (!api.isTauri()) return;
    const cleanups: Array<() => void> = [];
    void Promise.all([
      listen<string>("open-markdown", (event) => {
        openIntentQueueRef.current = openIntentQueueRef.current
          .catch(() => undefined)
          .then(() => openExternalDocument(event.payload));
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
    if (android || !settingsReady.current) return;
    setSettings((current) => ({
      ...current,
      desktopLayout: activateDockPanel(normalizeDesktopDockLayout(current.desktopLayout), sidebarView),
    }));
  }, [android, sidebarView]);

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
    // Agent streams use a target-bound, throttled write queue. The normal
    // current-tab autosave would otherwise enqueue a disk write for every UI
    // batch and can also save the wrong tab after the user switches tabs.
    if (agentDocumentStreamRef.current?.tabKey === activeTabKeyRef.current) return;
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
        if (android) setSidebarOpen(true);
        setSidebarView("workspace");
        window.setTimeout(() => document.querySelector<HTMLInputElement>(".sidebar-search input")?.focus(), 0);
      }
      if (command && event.key.toLowerCase() === "w" && activeTabKey) {
        event.preventDefault();
        void closeDocumentTab(activeTabKey);
      }
      if (command && event.key === "Tab" && openTabs.length > 1) {
        event.preventDefault();
        const index = openTabs.findIndex((tab) => tab.key === activeTabKey);
        const direction = event.shiftKey ? -1 : 1;
        const target = openTabs[(index + direction + openTabs.length) % openTabs.length];
        if (target) void activateDocumentTab(target);
      }
      if (event.key === "Escape") {
        setMenu(null);
        setLayoutMenuOpen(false);
        setOutlineOpen(false);
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [activateDocumentTab, activeTabKey, android, closeDocumentTab, openTabs, persistCurrent]);

  useEffect(() => {
    if (!android) return;
    const androidWindow = window as AndroidBackWindow;
    const previous = androidWindow.__LEAFMARK_ANDROID_BACK__;
    const closeAndroidLayer = () => {
      if (menu) setMenu(null);
      else if (deleteEntry) setDeleteEntry(null);
      else if (entryDialog) setEntryDialog(null);
      else if (exportOpen) {
        if (exporting) cancelExportRef.current?.();
        else setExportOpen(false);
      } else if (importOpen) setImportOpen(false);
      else if (settingsOpen) setSettingsOpen(false);
      else if (outlineOpen) setOutlineOpen(false);
      else if (sidebarOpen) setSidebarOpen(false);
      else if (dirty) {
        setNotice("正在保存当前文档，保存完成后可再次返回退出");
        void persistCurrent(true);
      } else return false;
      return true;
    };
    androidWindow.__LEAFMARK_ANDROID_BACK__ = closeAndroidLayer;
    return () => {
      if (androidWindow.__LEAFMARK_ANDROID_BACK__ === closeAndroidLayer) {
        androidWindow.__LEAFMARK_ANDROID_BACK__ = previous;
      }
    };
  }, [android, deleteEntry, dirty, entryDialog, exportOpen, exporting, importOpen, menu, outlineOpen, persistCurrent, settingsOpen, sidebarOpen]);

  const switchMode = async (next: ViewMode) => {
    if (agentTurnActiveRef.current || agentDocumentStreamRef.current?.tabKey === activeTabKeyRef.current) {
      setNotice("Agent 工作期间文档保持只读；流式写入完成后会恢复原模式");
      return;
    }
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
    if (agentTurnActiveRef.current) return;
    if (!liveEditorRef.current) return;
    if (!applyLiveMarkdownShortcut(liveEditorRef.current)) {
      applyLiveInlineMarkdownShortcut(liveEditorRef.current);
    }
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
    if (rejectDuringAgentTurn("新建文档")) return;
    setMenu(null);
    setEntryDialog({ action: "create", kind, parent, value: kind === "file" ? "新文档.md" : "新文件夹" });
  };

  const startRename = (entry: DocumentEntry) => {
    if (rejectDuringAgentTurn("重命名")) return;
    setMenu(null);
    setEntryDialog({ action: "rename", kind: entry.kind, source: entry, parent: parentPath(entry.path), value: entry.name });
  };

  const commitEntryDialog = async () => {
    if (!entryDialog) return;
    if (rejectDuringAgentTurn("执行文件操作")) return;
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
        setOpenTabs((current) => current.map((tab) => {
          if (tab.origin !== "workspace" || !(tab.path === entryDialog.source!.path || tab.path.startsWith(`${entryDialog.source!.path}/`))) return tab;
          const path = `${target}${tab.path.slice(entryDialog.source!.path.length)}`;
          return { ...tab, key: `workspace:${path}`, path, sourcePath: path };
        }));
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
    if (rejectDuringAgentTurn("删除文档")) return;
    setBusy(true);
    try {
      await api.remove(deleteEntry.path);
      const selectedRemoved = selectedRef.current === deleteEntry.path || selectedRef.current.startsWith(`${deleteEntry.path}/`);
      const nextTabs = tabsRef.current.filter((tab) => tab.origin !== "workspace" || !(tab.path === deleteEntry.path || tab.path.startsWith(`${deleteEntry.path}/`)));
      tabsRef.current = nextTabs;
      setOpenTabs(nextTabs);
      if (selectedRemoved) {
        const nextActive = nextTabs.at(-1);
        if (nextActive) applyTabSnapshot(nextActive); else clearCurrentDocument();
      }
      const target = await refresh();
      await refreshLibrary();
      if (selectedRemoved && !nextTabs.length && target) await openDocument(target, true);
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
    if (rejectDuringAgentTurn("导入文档")) return;
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

  const exportCurrent = async (format: ExportFormat, delivery: ExportDelivery = "save") => {
    if (!api.isTauri() || !selectedPath) return;
    if (rejectDuringAgentTurn("导出文档")) return;
    if (delivery === "share" && !android) return;
    if (!await persistCurrent(true)) return;
    const exportSource = contentRef.current;
    const exportPath = selectedRef.current;
    const exportDirectory = documentDirectory;
    const extension = exportExtension(format);
    const name = nativeFileName(exportPath).replace(/\.(md|markdown)$/i, "");
    const suffix = format === "pdf-long" ? "-长页" : format === "pdf-pages" ? "-标准分页" : "";
    const fileName = `${name}${suffix}.${extension}`;
    const target = delivery === "save" ? await saveDialog({
      defaultPath: fileName,
      filters: [{ name: exportLabel(format), extensions: [extension] }],
      title: `导出${exportLabel(format)}`,
    }) : null;
    if (delivery === "save" && !target) return;
    setExporting(true);
    setExportProgress({ progress: 0.02, message: delivery === "share" ? "正在准备分享文件…" : "正在准备导出…" });
    const deliver = async (bytes: Uint8Array) => {
      setExportProgress({
        progress: 0.98,
        message: delivery === "share" ? "正在打开系统分享面板…" : "正在安全写入目标文件…",
      });
      if (delivery === "share") await api.shareExport(fileName, exportMimeType(format), bytes);
      else await api.writeExport(target!, bytes);
    };
    try {
      if (format === "markdown") {
        await deliver(new TextEncoder().encode(exportSource));
      } else if (format === "pdf-long" || format === "pdf-pages") {
        const styles = getComputedStyle(document.documentElement);
        const color = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback;
        const job = startPdfExport({
          source: exportSource,
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
        await deliver(bytes);
      } else {
        const html = await api.render(exportSource);
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
          const result = await enhanceDocument(surface, settings, exportDirectory, { eager: true });
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
          await deliver(bytes);
        } finally {
          cleanup();
          surface.remove();
        }
      }
      setExportProgress({ progress: 1, message: delivery === "share" ? "分享文件已就绪" : "导出完成" });
      setExportOpen(false);
      setNotice(delivery === "share" ? `已打开系统分享面板 · ${fileName}` : `已导出到 ${target}`);
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
    if (rejectDuringAgentTurn("切换文档库")) return;
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
    setOpenTabs([]);
    tabsRef.current = [];
    setActiveTabKey("");
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
    if (rejectDuringAgentTurn("移除历史副本")) return;
    try {
      const next = await api.removeArchiveEntry(entry.id);
      setArchiveEntries(next);
      const key = `archive:${entry.id}`;
      const neighbor = nextTabAfterClose(tabsRef.current, key);
      const remaining = tabsRef.current.filter((tab) => tab.key !== key);
      tabsRef.current = remaining;
      setOpenTabs(remaining);
      if (activeTabKey === key) {
        const target = neighbor ?? remaining.at(-1) ?? null;
        if (target) applyTabSnapshot(target); else clearCurrentDocument();
      }
      setNotice(`已移除 ${entry.name} 的历史记录和保留副本`);
    } catch (error) {
      setNotice(`移除历史失败：${String(error)}`);
    }
  };

  const saveHistoryToWorkspace = async (entry: ArchiveEntry) => {
    if (rejectDuringAgentTurn("保存历史副本")) return;
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
    if (rejectDuringAgentTurn("清除历史")) return;
    try {
      const next = await api.clearHistory();
      setArchiveEntries(next);
      const retainedArchiveIds = new Set(next.map((entry) => entry.id));
      const activeBefore = activeTabKeyRef.current;
      const activeIndex = tabsRef.current.findIndex((tab) => tab.key === activeBefore);
      const remaining = tabsRef.current.filter((tab) => tab.origin !== "archive" || retainedArchiveIds.has(tab.archiveId));
      tabsRef.current = remaining;
      setOpenTabs(remaining);
      if (activeBefore && !remaining.some((tab) => tab.key === activeBefore)) {
        const target = remaining[Math.min(activeIndex, remaining.length - 1)] ?? remaining.at(-1) ?? null;
        if (target) applyTabSnapshot(target); else clearCurrentDocument();
      }
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
    setMenu({ kind: "workspace", x: event.clientX, y: event.clientY, entry: node.entry });
  };

  const handleArchiveMenu = (event: MouseEvent, entry: ArchiveEntry) => {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ kind: "archive", x: event.clientX, y: event.clientY, entry });
  };

  const revealWorkspaceLocation = async (entry: DocumentEntry | null) => {
    setMenu(null);
    try {
      await api.revealWorkspaceEntry(entry?.path ?? "");
      setNotice(entry?.kind === "file" ? `已打开 ${entry.name} 所在目录` : "已在文件管理器中显示目录");
    } catch (error) {
      setNotice(`无法打开所在目录：${String(error)}`);
    }
  };

  const revealArchiveLocation = async (entry: ArchiveEntry) => {
    setMenu(null);
    try {
      await api.revealArchivedDocument(entry.id);
      setNotice(entry.sourceExists ? `已打开 ${entry.name} 所在目录` : "源文档已删除，已打开 LeafMark 保留副本所在目录");
    } catch (error) {
      setNotice(`无法打开所在目录：${String(error)}`);
    }
  };

  const documentDirectory = selectedPath
    ? documentOrigin === "archive"
      ? nativeParentPath(sourcePath)
      : joinNativePath(settings.workspacePath, parentPath(selectedPath))
    : settings.workspacePath;

  const dockLayout = normalizeDesktopDockLayout(settings.desktopLayout);
  const updateDockLayout = (layout: AppSettings["desktopLayout"]) => {
    if (agentTurnActiveRef.current) {
      setNotice("Agent 工作期间已锁定面板布局，避免移动或卸载正在运行的 Agent");
      return;
    }
    setSettings((current) => ({ ...current, desktopLayout: normalizeDesktopDockLayout(layout) }));
  };
  const updateAppSettings = (next: AppSettings) => {
    const normalizedNextLayout = normalizeDesktopDockLayout(next.desktopLayout);
    if (agentTurnActiveRef.current && JSON.stringify(normalizedNextLayout) !== JSON.stringify(dockLayout)) {
      setNotice("Agent 工作期间不能重置或移动面板；其他设置已保存");
      setSettings({ ...next, desktopLayout: dockLayout });
      return;
    }
    setSettings(next);
  };
  const updateAgentReasoningEffort = (reasoningEffort: AgentReasoningEffort) => setSettings((current) => ({
    ...current,
    agent: { ...current.agent, reasoningEffort },
  }));
  const activatePanel = (panel: DockPanelId) => {
    if (agentTurnActiveRef.current && panel !== "agent") {
      setNotice("Agent 工作期间保持 Agent 面板挂载；任务完成后即可切换功能面板");
      return;
    }
    updateDockLayout(activateDockPanel(dockLayout, panel));
    if (panel === "workspace" || panel === "history" || panel === "favorites" || panel === "agent") setSidebarView(panel);
    if (panel === "outline") setOutlineOpen(true);
  };
  const hidePanel = (panel: DockPanelId) => {
    if (panel === "agent" && agentTurnActiveRef.current) {
      setNotice("Agent 工作期间不能隐藏 Agent 面板，请先停止或等待任务完成");
      return;
    }
    updateDockLayout(hideDockPanel(dockLayout, panel));
    if (panel === "outline") setOutlineOpen(false);
  };
  const finishPanelDrag = (panel: DockPanelId, x: number, y: number) => {
    if (panel === "agent" && agentTurnActiveRef.current) {
      setNotice("Agent 工作期间不能移动 Agent 面板");
      setDraggedPanel(null);
      setDockDragZone(null);
      return;
    }
    const zone = dockZoneAtPoint(x, y, window.innerWidth, window.innerHeight);
    if (zone) updateDockLayout(moveDockPanel(dockLayout, panel, zone));
    setDraggedPanel(null);
    setDockDragZone(null);
  };
  const toggleOutlinePanel = () => {
    if (android) {
      setOutlineOpen((open) => !open);
      return;
    }
    if (dockLayout.hidden.includes("outline")) activatePanel("outline");
    else hidePanel("outline");
  };

  const updateAgentStreamUi = (transaction: AgentDocumentStreamTransaction) => {
    const nextTabs = tabsRef.current.map((tab) => tab.key === transaction.tabKey ? {
      ...tab,
      content: transaction.buffer,
      size: new Blob([transaction.buffer]).size,
    } : tab);
    tabsRef.current = nextTabs;
    setOpenTabs(nextTabs);
    if (activeTabKeyRef.current === transaction.tabKey) {
      contentRef.current = transaction.buffer;
      setContent(transaction.buffer);
      setSaveStatus(transaction.buffer === transaction.lastSaved ? "saved" : "saving");
    }
  };

  const markAgentStreamSaved = (transaction: AgentDocumentStreamTransaction, value: string) => {
    transaction.lastSaved = value;
    queuedSaveRef.current = null;
    const nextTabs = tabsRef.current.map((tab) => tab.key === transaction.tabKey ? {
      ...tab,
      savedContent: value,
      modifiedMs: Date.now(),
    } : tab);
    tabsRef.current = nextTabs;
    setOpenTabs(nextTabs);
    if (activeTabKeyRef.current === transaction.tabKey) {
      savedRef.current = value;
      setSavedContent(value);
      setSaveStatus(contentRef.current === value ? "saved" : "saving");
    }
  };

  const flushAgentStreamUi = (transaction: AgentDocumentStreamTransaction) => {
    if (transaction.uiTimer !== null) {
      window.clearTimeout(transaction.uiTimer);
      transaction.uiTimer = null;
    }
    updateAgentStreamUi(transaction);
  };

  const writeAgentStreamSnapshot = (transaction: AgentDocumentStreamTransaction, value: string) => {
    const task = Promise.all([
      transaction.writeQueue.catch(() => undefined),
      saveQueueRef.current.catch(() => undefined),
    ])
      .then(async () => {
        if (transaction.origin === "archive") {
          const updated = await api.writeArchivedDocument(transaction.archiveId, value);
          if (updated && activeTabKeyRef.current === transaction.tabKey) setSourceExists(updated.sourceExists);
        } else {
          await api.write(transaction.path, value);
        }
      })
      .then(() => {
        transaction.writeError = null;
        markAgentStreamSaved(transaction, value);
      })
      .catch((error: unknown) => {
        transaction.writeError = error;
        if (activeTabKeyRef.current === transaction.tabKey) {
          setSaveStatus("error");
          setNotice(`Agent 流式保存失败：${String(error)}。内容仍保留在编辑器中`);
        }
        throw error;
      });
    transaction.writeQueue = task;
    // All ordinary saves and Agent checkpoints share one ordering barrier, so
    // an older autosave can never complete after the stream's final snapshot.
    saveQueueRef.current = task;
    return task;
  };

  const scheduleAgentStreamSave = (transaction: AgentDocumentStreamTransaction) => {
    if (transaction.saveTimer !== null) return;
    transaction.saveTimer = window.setTimeout(() => {
      transaction.saveTimer = null;
      const value = transaction.buffer;
      if (value === transaction.lastSaved) return;
      void writeAgentStreamSnapshot(transaction, value).catch(() => undefined);
    }, 800);
  };

  const appendAgentDocumentStream = (id: string, delta: string) => {
    const transaction = agentDocumentStreamRef.current;
    if (!transaction || transaction.id !== id || !delta) return;
    if (!transaction.started) {
      transaction.started = true;
      transaction.buffer = transaction.mode === "append" ? transaction.initialContent : "";
    }
    transaction.buffer += delta;
    if (transaction.uiTimer === null) {
      transaction.uiTimer = window.setTimeout(() => {
        transaction.uiTimer = null;
        updateAgentStreamUi(transaction);
      }, 40);
    }
    scheduleAgentStreamSave(transaction);
  };

  const restoreModeAfterAgentStream = async (transaction: AgentDocumentStreamTransaction) => {
    try {
      const html = await api.render(transaction.buffer);
      const nextTabs = tabsRef.current.map((tab) => tab.key === transaction.tabKey ? { ...tab, renderedHtml: html } : tab);
      tabsRef.current = nextTabs;
      setOpenTabs(nextTabs);
      if (activeTabKeyRef.current === transaction.tabKey) setRenderedHtml(html);
    } catch (error) {
      setNotice(`文档内容已保留，但最终渲染失败：${String(error)}`);
    }
    if (activeTabKeyRef.current === transaction.tabKey) {
      modeRef.current = transaction.previousMode;
      setMode(transaction.previousMode);
    }
  };

  const rollbackUnstartedAgentStream = async (transaction: AgentDocumentStreamTransaction) => {
    if (transaction.uiTimer !== null) window.clearTimeout(transaction.uiTimer);
    if (transaction.saveTimer !== null) window.clearTimeout(transaction.saveTimer);
    transaction.uiTimer = null;
    transaction.saveTimer = null;
    agentDocumentStreamRef.current = null;
    setStreamingDocument(null);

    if (transaction.created) {
      const tabs = tabsRef.current;
      const wasActive = activeTabKeyRef.current === transaction.tabKey;
      const nextActive = wasActive ? nextTabAfterClose(tabs, transaction.tabKey) : null;
      const nextTabs = tabs.filter((tab) => tab.key !== transaction.tabKey);
      tabsRef.current = nextTabs;
      setOpenTabs(nextTabs);
      if (wasActive) {
        if (nextActive) applyTabSnapshot(nextActive);
        else clearCurrentDocument();
      }
      await api.remove(transaction.path);
      await refresh();
    } else {
      transaction.buffer = transaction.initialContent;
      updateAgentStreamUi(transaction);
    }
    await restoreModeAfterAgentStream(transaction);
  };

  const finishAgentDocumentStream = async (id: string): Promise<AgentDocumentStreamResult> => {
    const transaction = agentDocumentStreamRef.current;
    if (!transaction || transaction.id !== id) throw new Error("文档流式写入事务已经结束");
    if (!transaction.started) {
      await rollbackUnstartedAgentStream(transaction);
      throw new Error("模型没有输出可写入的 Markdown 内容");
    }
    if (transaction.saveTimer !== null) {
      window.clearTimeout(transaction.saveTimer);
      transaction.saveTimer = null;
    }
    flushAgentStreamUi(transaction);
    await writeAgentStreamSnapshot(transaction, transaction.buffer);
    agentDocumentStreamRef.current = null;
    setStreamingDocument(null);
    await restoreModeAfterAgentStream(transaction);
    await refresh(transaction.origin === "workspace" ? transaction.path : undefined);
    await refreshLibrary();
    return {
      id: transaction.id,
      path: transaction.path,
      mode: transaction.mode,
      characters: [...transaction.buffer].length,
      bytes: new Blob([transaction.buffer]).size,
    };
  };

  const abortAgentDocumentStream = async (id: string) => {
    const transaction = agentDocumentStreamRef.current;
    if (!transaction || transaction.id !== id) return;
    if (!transaction.started) {
      await rollbackUnstartedAgentStream(transaction);
      return;
    }
    if (transaction.saveTimer !== null) {
      window.clearTimeout(transaction.saveTimer);
      transaction.saveTimer = null;
    }
    flushAgentStreamUi(transaction);
    let saveError: unknown = null;
    try { await writeAgentStreamSnapshot(transaction, transaction.buffer); }
    catch (error) { saveError = error; }
    agentDocumentStreamRef.current = null;
    queuedSaveRef.current = null;
    setStreamingDocument(null);
    await restoreModeAfterAgentStream(transaction);
    if (!saveError) {
      await refresh(transaction.origin === "workspace" ? transaction.path : undefined);
      await refreshLibrary();
    } else {
      setNotice(`Agent 已停止，未保存内容仍保留在编辑器中：${String(saveError)}。请点击保存重试`);
      throw saveError;
    }
  };

  const beginAgentDocumentStream = async (requestedPath: string | undefined, streamMode: AgentDocumentStreamMode): Promise<AgentDocumentStreamHandle> => {
    if (agentDocumentStreamRef.current) throw new Error("已有文档正在接收 Agent 流式输出");
    let path = requestedPath?.trim().replace(/\\/g, "/").replace(/^\/+/, "") ?? "";
    if (path && path.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("文档路径无效");
    if (path && !/\.(md|markdown)$/i.test(path)) path += ".md";
    if (streamMode === "create" && !path) throw new Error("create 模式必须提供新文档路径");

    let created = false;
    if (path) {
      const currentEntries = await api.listEntries();
      const target = currentEntries.find((entry) => entry.path === path);
      if (streamMode === "create") {
        if (target) throw new Error(`文档已存在，create 不会覆盖：${path}`);
        await api.create(path, "file");
        created = true;
        await refresh(path);
        const opened = await openDocument(path, true, true);
        if (!opened || activeTabKeyRef.current !== `workspace:${path}`) {
          await api.remove(path).catch(() => undefined);
          await refresh();
          throw new Error(`新文档已创建但无法安全激活：${path}`);
        }
      } else {
        if (!target || target.kind !== "file") throw new Error(`找不到文档：${path}`);
        const opened = await openDocument(path, false, true);
        if (!opened || activeTabKeyRef.current !== `workspace:${path}`) {
          throw new Error(`无法安全打开流式写入目标：${path}`);
        }
      }
    } else {
      if (!selectedRef.current) throw new Error("当前没有打开文档");
      path = originRef.current === "archive"
        ? nativeFileName(sourcePath || selectedRef.current)
        : selectedRef.current;
    }

    const id = crypto.randomUUID();
    const transaction: AgentDocumentStreamTransaction = {
      id,
      path,
      mode: streamMode,
      tabKey: activeTabKeyRef.current,
      origin: originRef.current,
      archiveId: archiveIdRef.current,
      initialContent: contentRef.current,
      buffer: contentRef.current,
      lastSaved: savedRef.current,
      started: false,
      created,
      previousMode: modeRef.current,
      uiTimer: null,
      saveTimer: null,
      writeQueue: Promise.resolve(),
      writeError: null,
    };
    agentDocumentStreamRef.current = transaction;
    queuedSaveRef.current = null;
    setStreamingDocument({ id, tabKey: transaction.tabKey, path });
    modeRef.current = "source";
    setMode("source");
    setNotice(`Agent 已打开 ${path}，正在等待 Markdown 流…`);
    return { id, path, mode: streamMode };
  };

  const flushAgentChanges = async () => {
    const stream = agentDocumentStreamRef.current;
    if (stream?.started && stream.buffer !== stream.lastSaved) {
      flushAgentStreamUi(stream);
      await writeAgentStreamSnapshot(stream, stream.buffer);
    }
    if (!await persistCurrent(true)) throw new Error("当前文档保存失败，未建立 Agent 版本");
    await saveQueueRef.current;
  };

  const reconcileAgentFiles = async () => {
    // A restored/terminal-written disk state must become authoritative before
    // any old React/autosave state has a chance to write again.
    documentVersionRef.current += 1;
    queuedSaveRef.current = null;
    const nextEntries = await api.listEntries();
    const workspaceFiles = new Set(nextEntries.filter((entry) => entry.kind === "file").map((entry) => entry.path));
    const previousTabs = tabsRef.current;
    const restoredTabs: OpenDocumentTab[] = [];
    for (const tab of previousTabs) {
      try {
        if (tab.origin === "workspace") {
          if (!workspaceFiles.has(tab.path)) continue;
          restoredTabs.push(tabFromLoadedDocument(await api.readDocument(tab.path)));
        } else {
          restoredTabs.push(tabFromLoadedDocument(await api.openArchivedDocument(tab.archiveId)));
        }
      } catch {
        // A deleted or inaccessible target is removed from the tab strip; the
        // filesystem transaction itself remains committed and recoverable.
      }
    }
    const active = restoredTabs.find((tab) => tab.key === activeTabKeyRef.current)
      ?? restoredTabs.at(-1)
      ?? null;
    tabsRef.current = restoredTabs;
    setOpenTabs(restoredTabs);
    setEntries(nextEntries);
    await refreshLibrary();
    if (active) applyTabSnapshot(active);
    else clearCurrentDocument();
  };

  const agentHost: AgentDocumentHost = {
    current: selectedPath ? {
      path: documentOrigin === "archive" ? nativeFileName(sourcePath || selectedPath) : selectedPath,
      content,
      origin: documentOrigin,
      archiveId,
    } : null,
    documents: entries,
    readDocument: async (path) => {
      if (!path || path === selectedRef.current) return contentRef.current;
      return (await api.readDocument(path)).content;
    },
    replaceCurrentDocument: async (next) => {
      if (!selectedRef.current) throw new Error("当前没有打开文档");
      setContent(next);
      contentRef.current = next;
      setRenderedHtml(await api.render(next));
      if (!await persistCurrent(true)) throw new Error("Agent 修改未能安全保存");
    },
    replaceText: async (path, searchText, replacement, all) => {
      if (!searchText) throw new Error("search 不能为空");
      const target = path || selectedRef.current;
      if (!target) throw new Error("当前没有打开文档");
      const current = target === selectedRef.current ? contentRef.current : (await api.readDocument(target)).content;
      const matches = current.split(searchText).length - 1;
      if (!matches) throw new Error(`没有找到要替换的文字：${searchText.slice(0, 80)}`);
      const next = all ? current.split(searchText).join(replacement) : current.replace(searchText, replacement);
      if (target === selectedRef.current) {
        contentRef.current = next;
        setContent(next);
        setRenderedHtml(await api.render(next));
        if (!await persistCurrent(true)) throw new Error("Agent 替换未能安全保存");
      } else {
        await api.write(target, next);
        setOpenTabs((tabs) => tabs.map((tab) => tab.origin === "workspace" && tab.path === target ? { ...tab, content: next, savedContent: next, renderedHtml: "" } : tab));
      }
      return `已在 ${target} 替换 ${all ? matches : 1} 处`;
    },
    createDocument: async (requestedPath, nextContent) => {
      let path = requestedPath.trim().replace(/\\/g, "/").replace(/^\/+/, "");
      if (!path || path.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("文档路径无效");
      if (!/\.(md|markdown)$/i.test(path)) path += ".md";
      await api.create(path, "file");
      await api.write(path, nextContent);
      await refresh(path);
      await openDocument(path, true, true);
      return `已创建并打开 ${path}`;
    },
    beginDocumentStream: beginAgentDocumentStream,
    appendDocumentStream: appendAgentDocumentStream,
    finishDocumentStream: finishAgentDocumentStream,
    abortDocumentStream: abortAgentDocumentStream,
    openDocument: async (path) => {
      if (!await openDocument(path, false, true)) throw new Error(`无法打开文档：${path}`);
    },
    searchDocuments: async (searchText, limit) => {
      const needle = searchText.trim().toLocaleLowerCase();
      if (!needle) return [];
      const results: Array<{ path: string; excerpt: string }> = [];
      for (const entry of files.slice(0, 120)) {
        if (results.length >= limit) break;
        try {
          const value = entry.path === selectedRef.current ? contentRef.current : (await api.readDocument(entry.path)).content;
          const index = value.toLocaleLowerCase().indexOf(needle);
          if (index >= 0 || entry.path.toLocaleLowerCase().includes(needle)) {
            results.push({ path: entry.path, excerpt: index >= 0 ? value.slice(Math.max(0, index - 120), index + needle.length + 240) : "文件名匹配" });
          }
        } catch { /* one inaccessible document must not abort the search */ }
      }
      return results;
    },
    flushDocumentChanges: flushAgentChanges,
    reconcileExternalChanges: reconcileAgentFiles,
    beginVersionTurn: async (sessionId, turnId, label) => {
      await flushAgentChanges();
      await api.beginAgentTurn(
        sessionId,
        turnId,
        label,
        originRef.current === "archive" ? archiveIdRef.current : undefined,
      );
    },
    finishVersionTurn: async (turnId, outcome) => {
      const unfinishedStream = agentDocumentStreamRef.current;
      if (unfinishedStream) await abortAgentDocumentStream(unfinishedStream.id);
      await flushAgentChanges();
      const version = await api.finishAgentTurn(turnId, outcome);
      await reconcileAgentFiles();
      return version;
    },
    findVersionForTurn: (turnId) => api.findAgentVersionForTurn(turnId),
    versionStatus: (): Promise<AgentVersionStatus> => api.getAgentVersionStatus(),
    undoVersion: async (): Promise<AgentVersionOperation> => {
      await flushAgentChanges();
      const operation = await api.undoAgentVersion();
      await reconcileAgentFiles();
      return operation;
    },
    redoVersion: async (): Promise<AgentVersionOperation> => {
      await flushAgentChanges();
      const operation = await api.redoAgentVersion();
      await reconcileAgentFiles();
      return operation;
    },
  };

  const renderSidebarToolbar = () => <div className="sidebar-toolbar">
    <div className="brand-mark" aria-label="LeafMark"><BookOpen size={17} /></div>
    <div className="sidebar-actions">
      <button className="icon-button" type="button" onClick={() => startCreate("file")} title="新建文档"><FilePlus2 size={16} /></button>
      <button className="icon-button" type="button" onClick={() => startCreate("directory")} title="新建文件夹"><FolderPlus size={16} /></button>
      <button className="icon-button" type="button" onClick={() => setImportOpen(true)} title={android ? "导入 Markdown 文件" : "导入文件或文件夹"}><Upload size={15} /></button>
      {android && <button className="icon-button" type="button" onClick={() => setSidebarOpen(false)} title="收起目录"><PanelLeftClose size={16} /></button>}
    </div>
  </div>;

  const renderLibraryContent = (view: Exclude<SidebarView, "agent">) => {
    const needle = query.trim().toLocaleLowerCase();
    const panelEntries = archiveEntries.filter((entry) => {
      if (view === "favorites" && !entry.favorite) return false;
      return !needle || entry.name.toLocaleLowerCase().includes(needle) || entry.sourcePath.toLocaleLowerCase().includes(needle);
    });
    return <div className="dock-library-pane">
      <div className="sidebar-search">
        <Search size={14} />
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={view === "workspace" ? "搜索文档…" : view === "history" ? "搜索历史…" : "搜索收藏…"} />
        <kbd>⌘P</kbd>
      </div>
      <div className="library-label">
        {view === "workspace" ? <>
          <span title={settings.workspacePath}>{lastDirectory(settings.workspacePath) || "文档库"}</span>
          <button className="icon-button compact" type="button" onClick={() => void refresh().then((target) => target ? openDocument(target, true) : undefined)} title="刷新目录"><RefreshCw size={13} /></button>
        </> : <>
          <span>{view === "history" ? "最近打开 · 自动保留副本" : "收藏文档 · 永久保留"}</span>
          {view === "history" && archiveEntries.some((entry) => !entry.favorite) && <button className="text-icon-button" type="button" onClick={() => void clearHistory()} title="清除未收藏历史"><Trash2 size={12} /> 清除</button>}
        </>}
      </div>
      <div className="tree">
        {view === "workspace" ? <div role="tree" aria-label="文档目录" onContextMenu={(event) => {
          if ((event.target as HTMLElement).closest(".tree-row")) return;
          event.preventDefault();
          setMenu({ kind: "workspace", x: event.clientX, y: event.clientY, entry: null });
        }}>
          {visibleTree.length > 0
            ? <FileTree nodes={visibleTree} selectedPath={selectedEntryPath} expanded={expanded} onOpen={(path) => void openDocument(path)} onToggle={toggleDirectory} onMenu={handleTreeMenu} />
            : <div className="tree-empty"><FileCode2 size={24} /><strong>{query ? "没有匹配文档" : "文档库为空"}</strong><span>{query ? "换一个关键词试试" : "新建或导入 Markdown"}</span></div>}
        </div> : <DocumentLibrary
          entries={panelEntries}
          selectedId={archiveId}
          emptyTitle={query ? "没有匹配文档" : view === "favorites" ? "还没有收藏" : "还没有打开历史"}
          emptyDetail={query ? "换一个关键词试试" : view === "favorites" ? "打开文档后点击星标收藏" : "从资源管理器或文档库打开 Markdown"}
          onOpen={(entry) => void openArchivedDocument(entry)}
          onFavorite={(entry, favorite) => void toggleFavorite(entry, favorite)}
          onSaveToWorkspace={(entry) => void saveHistoryToWorkspace(entry)}
          onRemove={(entry) => void removeHistoryEntry(entry)}
          onMenu={handleArchiveMenu}
        />}
      </div>
      <footer className="sidebar-footer">
        <span>{view === "workspace" ? `${files.length} 篇文档` : view === "history" ? `${archiveEntries.length} 条历史` : `${archiveEntries.filter((entry) => entry.favorite).length} 个收藏`}</span>
        <button type="button" onClick={() => setSettingsOpen(true)}><Settings size={14} /> 设置</button>
      </footer>
    </div>;
  };

  const renderOutlinePanel = () => <div className="dock-outline-pane">
    <nav>{outline.length ? outline.map((item) => <button key={item.id} type="button" style={{ "--outline-depth": Math.max(0, item.level - 1) } as React.CSSProperties} onClick={() => document.getElementById(item.id)?.scrollIntoView({ behavior: settings.reduceMotion ? "auto" : "smooth" })}>{item.text}</button>) : <span>这篇文档没有标题</span>}</nav>
  </div>;

  const renderDockPanel = (panel: DockPanelId) => {
    if (panel === "agent") return <AgentPanel settings={settings.agent} host={agentHost} onOpenSettings={() => setSettingsOpen(true)} onReasoningEffortChange={updateAgentReasoningEffort} onActivityChange={handleAgentActivityChange} />;
    if (panel === "outline") return renderOutlinePanel();
    return <div className="dock-library-shell">{renderSidebarToolbar()}{renderLibraryContent(panel)}</div>;
  };

  return (
    <div className={`app-shell${android ? `${sidebarOpen ? "" : " sidebar-closed"}${outlineOpen ? " outline-visible" : ""} platform-android` : " desktop-dock"}`} onClick={() => { setMenu(null); setLayoutMenuOpen(false); }}>
      {!android && <TitleBar />}
      {busy && <div className="top-progress" />}
      {android && <aside className={`sidebar${sidebarView === "agent" ? " agent-sidebar" : ""}`}>
        {renderSidebarToolbar()}
        <div className="sidebar-views" aria-label="功能页">
          <button className={sidebarView === "workspace" ? "active" : ""} type="button" onClick={() => setSidebarView("workspace")} title="文档库"><Files size={14} /> 文档</button>
          <button className={sidebarView === "history" ? "active" : ""} type="button" onClick={() => setSidebarView("history")} title="打开历史"><Clock3 size={14} /> 历史</button>
          <button className={sidebarView === "favorites" ? "active" : ""} type="button" onClick={() => setSidebarView("favorites")} title="收藏"><Star size={14} /> 收藏</button>
          <button className={sidebarView === "agent" ? "active" : ""} type="button" onClick={() => setSidebarView("agent")} title="AI Agent"><Bot size={14} /> Agent</button>
        </div>
        <div className="android-agent-panel-slot" style={{ display: sidebarView === "agent" ? "contents" : "none" }}>
          <AgentPanel settings={settings.agent} host={agentHost} onOpenSettings={() => setSettingsOpen(true)} onReasoningEffortChange={updateAgentReasoningEffort} onActivityChange={handleAgentActivityChange} />
        </div>
        {sidebarView !== "agent" && renderLibraryContent(sidebarView)}
      </aside>}
      {android && sidebarOpen && <button className="sidebar-scrim" type="button" onClick={() => setSidebarOpen(false)} aria-label="关闭文档抽屉" />}

      {!android && (["left", "right", "top", "bottom"] as DockZone[]).map((zone) => {
        const panels = visibleDockPanels(dockLayout, zone);
        const active = panels.includes(dockLayout.zones[zone].active as DockPanelId) ? dockLayout.zones[zone].active as DockPanelId : panels[0];
        if (!active) return null;
        const size = zone === "left" ? dockLayout.leftSize : zone === "right" ? dockLayout.rightSize : zone === "top" ? dockLayout.topSize : dockLayout.bottomSize;
        return <DockRegion
          key={zone}
          zone={zone}
          panels={panels}
          active={active}
          size={size}
          renderPanel={renderDockPanel}
          onActivate={activatePanel}
          onHide={hidePanel}
          onDragStart={setDraggedPanel}
          onDragMove={(x, y) => setDockDragZone(dockZoneAtPoint(x, y, window.innerWidth, window.innerHeight))}
          onDragEnd={finishPanelDrag}
          onResize={(nextSize) => updateDockLayout(resizeDockZone(dockLayout, zone, nextSize))}
        />;
      })}

      <main className="workspace">
        <div className="document-tabs" role="tablist" aria-label="打开的文档">
          {!android && dockLayout.hidden.includes("workspace") && <button className="open-panel-button" type="button" onClick={() => activatePanel("workspace")} title="显示文档面板"><PanelLeftOpen size={14} /></button>}
          <div>
            {openTabs.map((tab) => {
              const active = tab.key === activeTabKey;
              const tabDirty = tab.content !== tab.savedContent;
              const tabStreaming = streamingDocument?.tabKey === tab.key;
              return <div key={tab.key} className={`document-tab${active ? " active" : ""}${tabStreaming ? " streaming" : ""}`}>
                <button type="button" role="tab" aria-selected={active} onClick={() => void activateDocumentTab(tab)} title={tab.sourcePath || tab.path}>
                  <FileCode2 size={12} /><span>{nativeFileName(tab.sourcePath || tab.path)}</span>{tabStreaming ? <i title="Agent 正在流式写入" /> : tabDirty && <i title="未保存" />}
                </button>
                <button type="button" className="tab-close" aria-label={`关闭 ${nativeFileName(tab.sourcePath || tab.path)}`} onClick={() => void closeDocumentTab(tab.key)}><X size={12} /></button>
              </div>;
            })}
          </div>
          {!openTabs.length && <span className="no-tabs">未打开文档</span>}
        </div>
        <header className="document-toolbar">
          <div className="document-leading">
            {android && !sidebarOpen && <button className="icon-button" type="button" onClick={() => setSidebarOpen(true)} title="展开目录"><PanelLeftOpen size={17} /></button>}
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
            {mode === "live" && !agentTurnActive && !activeDocumentStreaming && (
              <div className="format-toolbar" aria-label="格式工具">
                <button type="button" onMouseDown={(event) => { event.preventDefault(); runFormat("bold"); }} title="粗体"><Bold size={14} /></button>
                <button type="button" onMouseDown={(event) => { event.preventDefault(); runFormat("italic"); }} title="斜体"><Italic size={14} /></button>
                <button type="button" onMouseDown={(event) => { event.preventDefault(); runFormat("strikeThrough"); }} title="删除线"><Strikethrough size={14} /></button>
                <button type="button" onMouseDown={(event) => { event.preventDefault(); runFormat("insertUnorderedList"); }} title="无序列表"><List size={14} /></button>
                <button type="button" onMouseDown={(event) => { event.preventDefault(); runFormat("insertOrderedList"); }} title="有序列表"><ListOrdered size={14} /></button>
              </div>
            )}
            <div className="mode-switch" aria-label="文档模式">
              <ModeButton active={mode === "read"} title="阅读" disabled={agentTurnActive || activeDocumentStreaming} onClick={() => void switchMode("read")}><Eye size={15} /></ModeButton>
              <ModeButton active={mode === "source"} title="源码" disabled={agentTurnActive || activeDocumentStreaming} onClick={() => void switchMode("source")}><FileCode2 size={15} /></ModeButton>
              <ModeButton active={mode === "split"} title="分栏" disabled={agentTurnActive || activeDocumentStreaming} onClick={() => void switchMode("split")}><SplitSquareHorizontal size={15} /></ModeButton>
              {settings.liveEditing && <ModeButton active={mode === "live"} title="实时编译" disabled={agentTurnActive || activeDocumentStreaming} onClick={() => void switchMode("live")}><PencilLine size={15} /></ModeButton>}
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
            <button className={`icon-button${android ? outlineOpen : !dockLayout.hidden.includes("outline") ? " active" : ""}`} type="button" onClick={toggleOutlinePanel} title="文章大纲" disabled={!selectedPath}><LayoutPanelLeft size={16} /></button>
            {!android && <button className={`icon-button${layoutMenuOpen ? " active" : ""}`} type="button" onClick={(event) => { event.stopPropagation(); setLayoutMenuOpen((open) => !open); }} title="管理停靠面板"><PanelsTopLeft size={16} /></button>}
            <button className="icon-button" type="button" onClick={() => void persistCurrent()} title="保存 (Ctrl+S)" disabled={!dirty || agentTurnActive || activeDocumentStreaming}><Save size={16} /></button>
            <button className="icon-button" type="button" onClick={() => setExportOpen(true)} title="导出" disabled={!selectedPath || !api.isTauri() || agentTurnActive || Boolean(streamingDocument)}><Download size={15} /></button>
            <button className="icon-button" type="button" onClick={() => setSettingsOpen(true)} title="设置 (Ctrl+,)"><Settings size={16} /></button>
          </div>
        </header>

        <div className={`document-host mode-${mode}${settings.showStatusBar ? " with-status" : ""}`}>
          {!bootstrapped ? (
            <StartupWorkspace />
          ) : !selectedPath ? (
            <EmptyWorkspace onCreate={() => startCreate("file", "")} onImport={() => setImportOpen(true)} />
          ) : (
            <>
              {(mode === "source" || mode === "split") && (
                <textarea
                  className="source-editor"
                  aria-label="Markdown 源码编辑器"
                  spellCheck={false}
                  value={content}
                  readOnly={agentTurnActive || streamingDocument?.tabKey === activeTabKey}
                  onChange={(event) => {
                    if (!agentTurnActiveRef.current) setContent(event.target.value);
                  }}
                />
              )}
              {(mode === "read" || mode === "split" || mode === "live") && (
                <DocumentSurface
                  key={`${selectedPath}-${mode}`}
                  html={renderedHtml}
                  live={mode === "live" && !agentTurnActive && !activeDocumentStreaming}
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
        {layoutMenuOpen && <div className="dock-panel-menu" onClick={(event) => event.stopPropagation()}>
          <strong>功能面板</strong>
          {([[
            "workspace", "文档"
          ], ["history", "历史"], ["favorites", "收藏"], ["agent", "Agent"], ["outline", "大纲"]] as Array<[DockPanelId, string]>).map(([panel, label]) => {
            const visible = !dockLayout.hidden.includes(panel);
            return <button key={panel} type="button" className={visible ? "active" : ""} onClick={() => visible ? hidePanel(panel) : activatePanel(panel)}><Check size={12} opacity={visible ? 1 : 0} />{label}</button>;
          })}
          <hr />
          <button type="button" onClick={() => updateDockLayout(defaultAppSettings().desktopLayout)}><RefreshCw size={12} />恢复默认布局</button>
        </div>}
      </main>

      {android && outlineOpen && (
        <aside className="outline-panel">
          <header><strong>文章大纲</strong><button className="icon-button compact" type="button" onClick={() => setOutlineOpen(false)}><X size={14} /></button></header>
          <nav>
            {outline.length ? outline.map((item) => <button key={item.id} type="button" style={{ "--outline-depth": Math.max(0, item.level - 1) } as React.CSSProperties} onClick={() => document.getElementById(item.id)?.scrollIntoView({ behavior: settings.reduceMotion ? "auto" : "smooth" })}>{item.text}</button>) : <span>这篇文档没有标题</span>}
          </nav>
        </aside>
      )}

      <DockDropTargets active={!android && Boolean(draggedPanel)} hover={dockDragZone} />

      {menu && (
        <div className="context-menu" style={contextMenuPosition(menu.x, menu.y, android)} onClick={(event) => event.stopPropagation()}>
          {menu.kind === "workspace" ? (
            <>
              {menu.entry?.kind === "file" && <button type="button" onClick={() => { void openDocument(menu.entry!.path); setMenu(null); }}><Eye size={14} /> 打开</button>}
              {!android && <button type="button" onClick={() => void revealWorkspaceLocation(menu.entry)}><FolderOpen size={14} /> {menu.entry?.kind === "file" ? "打开文档所在目录" : menu.entry ? "打开文件夹所在位置" : "打开文档库目录"}</button>}
              <button type="button" onClick={() => startCreate("file", menu.entry?.kind === "directory" ? menu.entry.path : parentPath(menu.entry?.path ?? ""))}><FilePlus2 size={14} /> 新建文档</button>
              <button type="button" onClick={() => startCreate("directory", menu.entry?.kind === "directory" ? menu.entry.path : parentPath(menu.entry?.path ?? ""))}><FolderPlus size={14} /> 新建文件夹</button>
              {menu.entry && <><hr /><button type="button" onClick={() => startRename(menu.entry!)}><PencilLine size={14} /> 重命名</button><button className="danger" type="button" onClick={() => { setDeleteEntry(menu.entry); setMenu(null); }}><Trash2 size={14} /> 删除</button></>}
            </>
          ) : (
            <>
              <button type="button" onClick={() => { void openArchivedDocument(menu.entry); setMenu(null); }}><Eye size={14} /> 打开</button>
              {!android && <button type="button" onClick={() => void revealArchiveLocation(menu.entry)}><FolderOpen size={14} /> {menu.entry.sourceExists ? "打开文档所在目录" : "打开保留副本所在目录"}</button>}
              <button type="button" onClick={() => { void saveHistoryToWorkspace(menu.entry); setMenu(null); }}><FilePlus2 size={14} /> 保存到我的文档库</button>
              <button type="button" onClick={() => { void toggleFavorite(menu.entry, !menu.entry.favorite); setMenu(null); }}><Star size={14} fill={menu.entry.favorite ? "currentColor" : "none"} /> {menu.entry.favorite ? "取消收藏" : "收藏并保留"}</button>
              {!menu.entry.favorite && <><hr /><button className="danger" type="button" onClick={() => { void removeHistoryEntry(menu.entry); setMenu(null); }}><Trash2 size={14} /> 移除历史和保留副本</button></>}
            </>
          )}
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
          android={android}
          busy={exporting}
          progress={exportProgress}
          onCancel={cancelExport}
          onExport={(format, delivery) => void exportCurrent(format, delivery)}
        />
      )}

      {importOpen && (
        <ImportDialog
          android={android}
          onCancel={() => setImportOpen(false)}
          onImport={(mode) => void importDocuments(mode)}
        />
      )}

      {settingsOpen && (
        <SettingsPanel
          settings={settings}
          associationStatus={associationStatus}
          onChange={updateAppSettings}
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

function ExportDialog({ android, busy, progress, onCancel, onExport }: {
  android: boolean;
  busy: boolean;
  progress: ExportProgress | null;
  onCancel: () => void;
  onExport: (format: ExportFormat, delivery: ExportDelivery) => void;
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
          {busy ? <button className="primary-button" type="button" disabled>后台生成中…</button> : android ? <>
            <button className="secondary-button" type="button" onClick={() => onExport(format, "save")}><Download size={13} /> 保存到文件</button>
            <button className="primary-button" type="button" onClick={() => onExport(format, "share")}><Share2 size={13} /> 分享文件</button>
          </> : <button className="primary-button" type="button" onClick={() => onExport(format, "save")}>{`导出 ${exportLabel(format)}`}</button>}
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
      onInput={live ? (event) => {
        if (!(event.nativeEvent as InputEvent).isComposing) onInput();
      } : undefined}
      onCompositionEnd={live ? onInput : undefined}
      onClick={(event) => {
        const anchor = (event.target as HTMLElement).closest<HTMLAnchorElement>("a");
        if (!anchor) return;
        event.preventDefault();
        onNavigate(anchor.getAttribute("href") ?? "");
      }}
    />
  );
}

function ModeButton({ active, disabled = false, title, onClick, children }: { active: boolean; disabled?: boolean; title: string; onClick: () => void; children: React.ReactNode }) {
  return <button type="button" className={active ? "active" : ""} onClick={onClick} title={title} disabled={disabled}>{children}</button>;
}

function contextMenuPosition(x: number, y: number, android: boolean): React.CSSProperties {
  const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
  const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
  const width = android ? Math.min(260, viewportWidth - 24) : 200;
  const estimatedHeight = android ? 286 : 220;
  return {
    left: Math.max(12, Math.min(x, viewportWidth - width - 12)),
    top: Math.max(12, Math.min(y, viewportHeight - estimatedHeight - 12)),
  };
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

function StartupWorkspace() {
  return (
    <div className="startup-workspace" role="status" aria-live="polite">
      <div className="startup-symbol"><BookOpen size={25} /></div>
      <span>正在载入文档…</span>
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

function exportMimeType(format: ExportFormat) {
  if (format === "markdown") return "text/markdown";
  if (format === "html") return "text/html";
  if (format === "png") return "image/png";
  return "application/pdf";
}

function nativeParentPath(path: string) {
  const normalized = path.replace(/[\\/]$/, "");
  const separator = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  return separator >= 0 ? normalized.slice(0, separator) : "";
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
