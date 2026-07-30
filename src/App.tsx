import {
  Bold,
  BookOpen,
  Check,
  ChevronRight,
  CircleAlert,
  Clock3,
  Download,
  Eye,
  FileArchive,
  FileCode2,
  FilePlus2,
  FileWarning,
  FolderPlus,
  Italic,
  LayoutPanelLeft,
  List,
  ListOrdered,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  PencilLine,
  RefreshCw,
  Save,
  Search,
  Settings,
  SplitSquareHorizontal,
  Star,
  Strikethrough,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { listen } from "@tauri-apps/api/event";
import { open, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api } from "./api";
import { FileTree } from "./components/FileTree";
import { SettingsPanel } from "./components/SettingsPanel";
import { enhanceDocument, type OutlineItem } from "./rendering";
import { buildTree, joinPath, parentPath, resolveMarkdownLink } from "./tree";
import type { AppSettings, ArchiveRecord, DocumentEntry, EntryKind, LoadedDocument, TreeNode, ViewMode } from "./types";
import { htmlToMarkdown, runFormat } from "./wysiwyg";

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

type SidebarView = "files" | "history" | "favorites";

const EMPTY_SETTINGS: AppSettings = {
  workspacePath: "",
  theme: "system",
  liveEditing: false,
  autosaveDelayMs: 600,
  contentWidth: 860,
  fontSize: 16,
  lineHeight: 1.75,
  showStatusBar: true,
  reduceMotion: false,
  mermaidEnabled: true,
  mathEnabled: true,
};

export default function App() {
  const [settings, setSettings] = useState<AppSettings>(EMPTY_SETTINGS);
  const [entries, setEntries] = useState<DocumentEntry[]>([]);
  const [records, setRecords] = useState<ArchiveRecord[]>([]);
  const [currentDocument, setCurrentDocument] = useState<LoadedDocument | null>(null);
  const [selectedPath, setSelectedPath] = useState("");
  const [selectedEntryPath, setSelectedEntryPath] = useState("");
  const [content, setContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [renderedHtml, setRenderedHtml] = useState("");
  const [mode, setMode] = useState<ViewMode>("read");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarView, setSidebarView] = useState<SidebarView>("files");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState("正在启动…");
  const [busy, setBusy] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [outline, setOutline] = useState<OutlineItem[]>([]);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [entryDialog, setEntryDialog] = useState<EntryDialogState | null>(null);
  const [deleteEntry, setDeleteEntry] = useState<DocumentEntry | null>(null);
  const [clearHistoryConfirm, setClearHistoryConfirm] = useState(false);
  const [rendering, setRendering] = useState(false);
  const contentRef = useRef(content);
  const savedRef = useRef(savedContent);
  const selectedRef = useRef(selectedPath);
  const documentRef = useRef<LoadedDocument | null>(null);
  const liveEditorRef = useRef<HTMLElement>(null);
  const settingsReady = useRef(false);
  const renderRequest = useRef(0);

  const dirty = Boolean(currentDocument?.writable) && content !== savedContent;
  const files = useMemo(() => entries.filter((entry) => entry.kind === "file"), [entries]);
  const tree = useMemo(() => buildTree(entries), [entries]);
  const entryMap = useMemo(() => new Map(entries.map((entry) => [entry.path, entry])), [entries]);
  const selectedEntry = entryMap.get(selectedEntryPath);
  const currentDirectory = selectedEntry?.kind === "directory" ? selectedEntry.path : parentPath(selectedEntryPath);

  useEffect(() => { contentRef.current = content; }, [content]);
  useEffect(() => { savedRef.current = savedContent; }, [savedContent]);
  useEffect(() => { selectedRef.current = selectedPath; }, [selectedPath]);
  useEffect(() => { documentRef.current = currentDocument; }, [currentDocument]);

  const applyTheme = useCallback((next: AppSettings) => {
    const mediaDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const resolved = next.theme === "system" ? (mediaDark ? "dark" : "light") : next.theme;
    const root = document.documentElement;
    root.dataset.theme = next.theme;
    root.dataset.resolvedTheme = resolved;
    root.dataset.reduceMotion = String(next.reduceMotion);
    root.style.setProperty("--reader-width", `${next.contentWidth}px`);
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

  const persistCurrent = useCallback(async (quiet = false) => {
    const document = documentRef.current;
    const value = contentRef.current;
    if (!document?.writable || value === savedRef.current) return;
    try {
      await api.write(document.origin, document.path, value);
      savedRef.current = value;
      setSavedContent(value);
      if (!quiet) setNotice(`已保存 ${document.name}`);
      setRecords(await api.listRecords());
    } catch (error) {
      setNotice(`保存失败：${String(error)}`);
      throw error;
    }
  }, []);

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

  const acceptDocument = useCallback((loaded: LoadedDocument) => {
    selectedRef.current = loaded.path;
    documentRef.current = loaded;
    contentRef.current = loaded.content;
    savedRef.current = loaded.content;
    setCurrentDocument(loaded);
    setSelectedPath(loaded.path);
    setSelectedEntryPath(loaded.origin === "workspace" ? loaded.path : "");
    setContent(loaded.content);
    setSavedContent(loaded.content);
    setRenderedHtml(loaded.html);
    if (!loaded.writable) setMode((current) => current === "live" ? "read" : current);
    setNotice(loaded.sourceExists
      ? `${loaded.cached ? "瞬时打开（缓存）" : "已打开"} · ${formatBytes(loaded.size)}`
      : `源文件已删除 · 正在读取保留副本 · ${formatBytes(loaded.size)}`);
  }, []);

  const openDocument = useCallback(async (path: string, force = false) => {
    if (!force && documentRef.current?.origin === "workspace" && path === selectedRef.current) return;
    await persistCurrent(true);
    setBusy(true);
    try {
      const loaded = await api.readDocument(path);
      acceptDocument(loaded);
      setRecords(await api.listRecords());
    } catch (error) {
      setNotice(`打开文档失败：${String(error)}`);
    } finally {
      setBusy(false);
    }
  }, [acceptDocument, persistCurrent]);

  const openExternalDocument = useCallback(async (path: string) => {
    await persistCurrent(true);
    setBusy(true);
    try {
      const loaded = await api.readExternalDocument(path);
      acceptDocument(loaded);
      setRecords(await api.listRecords());
    } catch (error) {
      setNotice(`打开外部文档失败：${String(error)}`);
    } finally {
      setBusy(false);
    }
  }, [acceptDocument, persistCurrent]);

  const openArchiveDocument = useCallback(async (recordId: string) => {
    await persistCurrent(true);
    setBusy(true);
    try {
      const loaded = await api.readArchiveDocument(recordId);
      acceptDocument(loaded);
      setRecords(await api.listRecords());
    } catch (error) {
      setNotice(`打开保留文档失败：${String(error)}`);
    } finally {
      setBusy(false);
    }
  }, [acceptDocument, persistCurrent]);

  useEffect(() => {
    if (!api.isTauri()) return;
    let active = true;
    let stop: (() => void) | undefined;
    void listen<string[]>("open-markdown", (event) => {
      if (!active) return;
      void (async () => {
        for (const path of event.payload) await openExternalDocument(path);
      })();
    }).then((unlisten) => {
      if (active) stop = unlisten;
      else unlisten();
    });
    return () => {
      active = false;
      stop?.();
    };
  }, [openExternalDocument]);

  useEffect(() => {
    let active = true;
    void api.bootstrap()
      .then(async (payload) => {
        if (!active) return;
        setSettings(payload.settings);
        setRecords(payload.records);
        settingsReady.current = true;
        setEntries(payload.entries);
        setExpanded(new Set(payload.entries.filter((entry) => entry.kind === "directory" && entry.depth < 2).map((entry) => entry.path)));
        if (payload.pendingOpenPaths.length) {
          for (const path of payload.pendingOpenPaths) await openExternalDocument(path);
        } else {
          const first = payload.entries.find((entry) => entry.kind === "file");
          if (first) await openDocument(first.path);
          else setNotice("文档库为空");
        }
      })
      .catch((error: unknown) => setNotice(`启动失败：${String(error)}`))
      .finally(() => active && setBusy(false));
    return () => { active = false; };
  }, [openDocument, openExternalDocument]);

  useEffect(() => {
    if (!settingsReady.current) return;
    const timer = window.setTimeout(() => {
      void api.saveSettings(settings).catch((error: unknown) => setNotice(`设置保存失败：${String(error)}`));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [settings]);

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
    if (next === "live" && !documentRef.current?.writable) {
      setNotice("保留副本为只读，可先导出为 Markdown 后再编辑");
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
    if (!liveEditorRef.current) return;
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
        if (entryDialog.kind === "file") await openDocument(nextTarget || target, true);
        else {
          setSelectedEntryPath(target);
          setExpanded((current) => new Set(current).add(target));
        }
        setNotice(`已创建 ${name}`);
      } else if (entryDialog.source) {
        await persistCurrent(true);
        await api.rename(entryDialog.source.path, target);
        const selectedWasInside = selectedRef.current === entryDialog.source.path || selectedRef.current.startsWith(`${entryDialog.source.path}/`);
        const nextPath = selectedWasInside ? `${target}${selectedRef.current.slice(entryDialog.source.path.length)}` : selectedRef.current;
        await refresh(nextPath);
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
        selectedRef.current = "";
        documentRef.current = null;
        setCurrentDocument(null);
        setSelectedPath("");
        setSelectedEntryPath("");
        setContent("");
        setSavedContent("");
        setRenderedHtml("");
      }
      const target = await refresh();
      if (selectedRemoved && target) await openDocument(target, true);
      setNotice(`已删除 ${deleteEntry.name}`);
      setDeleteEntry(null);
    } catch (error) {
      setNotice(`删除失败：${String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const importDocuments = async () => {
    if (!api.isTauri()) return;
    const selected = await open({ multiple: true, filters: [{ name: "Markdown", extensions: ["md", "markdown"] }], title: "导入 Markdown 文档" });
    if (!selected) return;
    setBusy(true);
    try {
      const imported = await api.importFiles(Array.isArray(selected) ? selected : [selected], currentDirectory);
      const last = imported.at(-1);
      await refresh(last);
      if (last) await openDocument(last, true);
      setNotice(`已导入 ${imported.length} 篇文档`);
    } catch (error) {
      setNotice(`导入失败：${String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const exportCurrent = async () => {
    const document = documentRef.current;
    if (!api.isTauri() || !document) return;
    await persistCurrent(true);
    const target = await saveDialog({ defaultPath: document.name, filters: [{ name: "Markdown", extensions: ["md", "markdown"] }] });
    if (!target) return;
    try {
      await api.exportFile(document.origin, document.path, target);
      setNotice(`已导出到 ${target}`);
    } catch (error) {
      setNotice(`导出失败：${String(error)}`);
    }
  };

  const changeWorkspace = async (path: string) => {
    await persistCurrent(true);
    const payload = await api.setWorkspace(path);
    selectedRef.current = "";
    documentRef.current = null;
    setSettings(payload.settings);
    setEntries(payload.entries);
    setRecords(payload.records);
    setCurrentDocument(null);
    setSelectedPath("");
    setSelectedEntryPath("");
    setContent("");
    setSavedContent("");
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

  const visibleRecords = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return records.filter((record) => {
      if (sidebarView === "favorites" && !record.favorite) return false;
      return !needle || record.name.toLocaleLowerCase().includes(needle) || record.sourcePath.toLocaleLowerCase().includes(needle);
    });
  }, [query, records, sidebarView]);

  const currentRecord = currentDocument
    ? records.find((record) => record.id === currentDocument.recordId)
    : undefined;

  const toggleFavorite = async () => {
    if (!currentDocument) return;
    try {
      const next = !currentRecord?.favorite;
      setRecords(await api.setFavorite(currentDocument.recordId, next));
      setNotice(next ? `已收藏 ${currentDocument.name}` : `已取消收藏 ${currentDocument.name}`);
    } catch (error) {
      setNotice(`收藏操作失败：${String(error)}`);
    }
  };

  const clearHistory = async () => {
    try {
      setRecords(await api.clearHistory());
      setNotice("历史记录已清空，收藏的文档仍被保留");
    } catch (error) {
      setNotice(`清空历史失败：${String(error)}`);
    }
  };

  const handleTreeMenu = (event: MouseEvent, node: TreeNode) => {
    event.preventDefault();
    event.stopPropagation();
    setSelectedEntryPath(node.entry.path);
    setMenu({ x: event.clientX, y: event.clientY, entry: node.entry });
  };

  const documentDirectory = currentDocument
    ? nativeParentPath(currentDocument.sourcePath)
    : settings.workspacePath;

  return (
    <div className={`app-shell${sidebarOpen ? "" : " sidebar-closed"}`} onClick={() => setMenu(null)}>
      {busy && <div className="top-progress" />}
      <aside className="sidebar">
        <div className="sidebar-toolbar">
          <div className="brand-mark" aria-label="LeafMark"><BookOpen size={17} /></div>
          <div className="sidebar-actions">
            <button className="icon-button" type="button" onClick={() => startCreate("file")} title="新建文档"><FilePlus2 size={16} /></button>
            <button className="icon-button" type="button" onClick={() => startCreate("directory")} title="新建文件夹"><FolderPlus size={16} /></button>
            <button className="icon-button" type="button" onClick={() => void importDocuments()} title="导入"><Upload size={15} /></button>
            <button className="icon-button" type="button" onClick={() => setSidebarOpen(false)} title="收起目录"><PanelLeftClose size={16} /></button>
          </div>
        </div>
        <nav className="sidebar-tabs" aria-label="文档视图">
          <button type="button" className={sidebarView === "files" ? "active" : ""} onClick={() => { setSidebarView("files"); setQuery(""); }}><FileCode2 size={13} /> 文档</button>
          <button type="button" className={sidebarView === "history" ? "active" : ""} onClick={() => { setSidebarView("history"); setQuery(""); }}><Clock3 size={13} /> 历史</button>
          <button type="button" className={sidebarView === "favorites" ? "active" : ""} onClick={() => { setSidebarView("favorites"); setQuery(""); }}><Star size={13} /> 收藏</button>
        </nav>
        <div className="sidebar-search"><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={sidebarView === "files" ? "搜索文档…" : "搜索保留文档…"} /><kbd>⌘P</kbd></div>
        <div className="library-label">
          {sidebarView === "files" ? (
            <>
              <span title={settings.workspacePath}>{lastDirectory(settings.workspacePath) || "文档库"}</span>
              <button className="icon-button compact" type="button" onClick={() => void refresh().then((target) => {
                if (target) return openDocument(target, true);
              })} title="刷新目录"><RefreshCw size={13} /></button>
            </>
          ) : (
            <>
              <span>{sidebarView === "history" ? "最近打开" : "已收藏"}</span>
              {sidebarView === "history" && records.some((record) => !record.favorite) && <button className="text-mini-button" type="button" onClick={() => setClearHistoryConfirm(true)}>清空</button>}
            </>
          )}
        </div>
        <div className="tree" role="tree" aria-label="文档目录" onContextMenu={(event) => {
          if (sidebarView !== "files") return;
          if ((event.target as HTMLElement).closest(".tree-row")) return;
          event.preventDefault();
          setMenu({ x: event.clientX, y: event.clientY, entry: null });
        }}>
          {sidebarView === "files" ? (
            visibleTree.length > 0
              ? <FileTree nodes={visibleTree} selectedPath={selectedEntryPath} expanded={expanded} onOpen={(path) => void openDocument(path)} onToggle={toggleDirectory} onMenu={handleTreeMenu} />
              : <div className="tree-empty"><FileCode2 size={24} /><strong>{query ? "没有匹配文档" : "文档库为空"}</strong><span>{query ? "换一个关键词试试" : "新建或导入 Markdown"}</span></div>
          ) : visibleRecords.length > 0 ? (
            <div className="archive-list">
              {visibleRecords.map((record) => (
                <div className={`archive-row${currentDocument?.recordId === record.id ? " selected" : ""}`} key={record.id}>
                  <button className="archive-main" type="button" onClick={() => void openArchiveDocument(record.id)} title={record.sourcePath}>
                    <span className="archive-icon">{record.sourceExists ? <FileArchive size={14} /> : <FileWarning size={14} />}</span>
                    <span className="archive-copy">
                      <strong>{record.name}</strong>
                      <small>{record.sourceExists ? formatRelativeTime(record.lastOpenedMs) : "源文件已删除 · 副本可用"}</small>
                    </span>
                  </button>
                  <button className={`archive-favorite${record.favorite ? " active" : ""}`} type="button" title={record.favorite ? "取消收藏" : "收藏"} onClick={() => void api.setFavorite(record.id, !record.favorite).then(setRecords).catch((error: unknown) => setNotice(`收藏操作失败：${String(error)}`))}>
                    <Star size={13} fill={record.favorite ? "currentColor" : "none"} />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div className="tree-empty"><FileArchive size={24} /><strong>{query ? "没有匹配记录" : sidebarView === "history" ? "还没有历史记录" : "还没有收藏"}</strong><span>打开文档后会自动保留内容副本</span></div>
          )}
        </div>
        <footer className="sidebar-footer"><span>{sidebarView === "files" ? `${files.length} 篇文档` : `${visibleRecords.length} 篇保留文档`}</span><button type="button" onClick={() => setSettingsOpen(true)}><Settings size={14} /> 设置</button></footer>
      </aside>

      <main className="workspace">
        <header className="document-toolbar">
          <div className="document-leading">
            {!sidebarOpen && <button className="icon-button" type="button" onClick={() => setSidebarOpen(true)} title="展开目录"><PanelLeftOpen size={17} /></button>}
            <div className="breadcrumbs" title={currentDocument?.sourcePath}>
              {currentDocument ? currentDocument.sourcePath.split(/[\\/]/).filter(Boolean).slice(-3).map((part, index) => (
                <span key={`${part}-${index}`}>{index > 0 && <ChevronRight size={11} />}{part}</span>
              )) : <span>未选择文档</span>}
            </div>
            {dirty
              ? <span className="save-state saving"><span /> 保存中</span>
              : currentDocument?.sourceExists
                ? <span className="save-state"><Check size={12} /> 已保存</span>
                : currentDocument
                  ? <span className="save-state snapshot"><FileArchive size={12} /> 保留副本</span>
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
            <button className={`icon-button${outlineOpen ? " active" : ""}`} type="button" onClick={() => setOutlineOpen((open) => !open)} title="文章大纲" disabled={!selectedPath}><LayoutPanelLeft size={16} /></button>
            <button className={`icon-button${currentRecord?.favorite ? " active favorite" : ""}`} type="button" onClick={() => void toggleFavorite()} title={currentRecord?.favorite ? "取消收藏" : "收藏并保留副本"} disabled={!currentDocument}>
              <Star size={16} fill={currentRecord?.favorite ? "currentColor" : "none"} />
            </button>
            <button className="icon-button" type="button" onClick={() => void persistCurrent()} title="保存 (Ctrl+S)" disabled={!dirty}><Save size={16} /></button>
            <button className="icon-button" type="button" onClick={() => void exportCurrent()} title="导出" disabled={!currentDocument || !api.isTauri()}><Download size={15} /></button>
            <button className="icon-button" type="button" onClick={() => setSettingsOpen(true)} title="设置 (Ctrl+,)"><Settings size={16} /></button>
          </div>
        </header>

        <div className={`document-host mode-${mode}${settings.showStatusBar ? " with-status" : ""}`}>
          {!selectedPath ? (
            <EmptyWorkspace onCreate={() => startCreate("file", "")} onImport={() => void importDocuments()} />
          ) : (
            <>
              {(mode === "source" || mode === "split") && (
                <textarea
                  className="source-editor"
                  aria-label="Markdown 源码编辑器"
                  spellCheck={false}
                  readOnly={!currentDocument?.writable}
                  value={content}
                  onChange={(event) => setContent(event.target.value)}
                />
              )}
              {(mode === "read" || mode === "split" || mode === "live") && (
                <DocumentSurface
                  key={`${selectedPath}-${mode}`}
                  html={renderedHtml}
                  live={mode === "live" && Boolean(currentDocument?.writable)}
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
                    if (currentDocument?.origin === "workspace") {
                      const target = resolveMarkdownLink(selectedPath, href);
                      if (entryMap.has(target)) void openDocument(target);
                      else setNotice(`找不到本地文档：${target}`);
                    } else {
                      setNotice("外部文档中的相对链接需要从文档库打开");
                    }
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
            {currentDocument && <div><span>{currentDocument.sourceExists ? "原文" : "保留副本"}</span><span>Markdown</span><span>{countWords(content).toLocaleString()} 字</span><span>{formatBytes(new Blob([content]).size)}</span></div>}
          </footer>
        )}
      </main>

      {outlineOpen && (
        <aside className="outline-popover">
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

      {clearHistoryConfirm && (
        <ConfirmDialog
          title="清空历史记录？"
          description="未收藏文档的历史记录与保留副本会被删除；收藏内容不会受影响。"
          onCancel={() => setClearHistoryConfirm(false)}
          onConfirm={() => {
            setClearHistoryConfirm(false);
            void clearHistory();
          }}
        />
      )}

      {settingsOpen && <SettingsPanel settings={settings} onChange={setSettings} onWorkspaceChange={changeWorkspace} onClose={() => setSettingsOpen(false)} />}
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

function countWords(value: string) {
  const cjk = value.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu)?.length ?? 0;
  const latin = value.replace(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu, " ").match(/\b[\p{Letter}\p{Number}_'-]+\b/gu)?.length ?? 0;
  return cjk + latin;
}

function lastDirectory(path: string) {
  return path.replace(/[\\/]$/, "").split(/[\\/]/).at(-1) ?? path;
}

function nativeParentPath(path: string) {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return index > 0 ? path.slice(0, index) : path;
}

function formatRelativeTime(timestamp: number) {
  const elapsed = Math.max(0, Date.now() - timestamp);
  const minute = 60_000;
  if (elapsed < minute) return "刚刚打开";
  if (elapsed < 60 * minute) return `${Math.floor(elapsed / minute)} 分钟前`;
  if (elapsed < 24 * 60 * minute) return `${Math.floor(elapsed / 60 / minute)} 小时前`;
  if (elapsed < 30 * 24 * 60 * minute) return `${Math.floor(elapsed / 24 / 60 / minute)} 天前`;
  return new Date(timestamp).toLocaleDateString();
}
