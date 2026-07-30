import {
  AppWindow,
  Check,
  ChevronRight,
  ExternalLink,
  FolderOpen,
  Monitor,
  Moon,
  RefreshCw,
  RotateCcw,
  Sun,
  X,
} from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import type { AppSettings, AssociationStatus, ThemeMode } from "../types";
import { api } from "../api";

interface SettingsPanelProps {
  settings: AppSettings;
  associationStatus: AssociationStatus;
  onChange: (settings: AppSettings) => void;
  onWorkspaceChange: (path: string) => Promise<void>;
  onAssociationChange: (requestDefault: boolean) => Promise<void>;
  onClose: () => void;
}

type Section = "editor" | "appearance" | "workspace" | "integration" | "performance";

export function SettingsPanel({
  settings,
  associationStatus,
  onChange,
  onWorkspaceChange,
  onAssociationChange,
  onClose,
}: SettingsPanelProps) {
  const isAndroid = api.isAndroid();
  const [section, setSection] = useState<Section>("editor");
  const [working, setWorking] = useState(false);
  const [associationWorking, setAssociationWorking] = useState(false);
  const [fontFamilies, setFontFamilies] = useState<string[] | null>(null);
  const fontListId = useId();
  const sections = useMemo(() => [
    { id: "editor" as const, label: "编辑与保存", detail: "编译模式、自动保存" },
    { id: "appearance" as const, label: "外观", detail: "主题、字号与版心" },
    { id: "workspace" as const, label: "文档库", detail: "本地目录" },
    { id: "integration" as const, label: "系统集成", detail: "打开方式、默认应用" },
    { id: "performance" as const, label: "渲染", detail: "Mermaid 与公式" },
  ], []);

  const patch = (next: Partial<AppSettings>) => onChange({ ...settings, ...next });

  useEffect(() => {
    if (section !== "appearance" || fontFamilies !== null) return;
    let active = true;
    void api.listSystemFonts()
      .then((families) => {
        if (active) setFontFamilies(families);
      })
      .catch(() => {
        if (active) setFontFamilies([]);
      });
    return () => {
      active = false;
    };
  }, [fontFamilies, section]);

  const chooseWorkspace = async () => {
    if (!api.isTauri()) return;
    const selected = await open({ directory: true, multiple: false, title: "选择 Markdown 文档库" });
    if (!selected || Array.isArray(selected)) return;
    setWorking(true);
    try {
      await onWorkspaceChange(selected);
    } finally {
      setWorking(false);
    }
  };

  const changeAssociation = async (requestDefault: boolean) => {
    setAssociationWorking(true);
    try {
      await onAssociationChange(requestDefault);
    } finally {
      setAssociationWorking(false);
    }
  };

  return (
    <div className="settings-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="settings-panel" role="dialog" aria-modal="true" aria-label="设置">
        <header className="settings-header">
          <div>
            <span className="settings-kicker">PREFERENCES</span>
            <h2>设置</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="关闭设置"><X size={18} /></button>
        </header>
        <div className="settings-body">
          <nav className="settings-nav" aria-label="设置分类">
            {sections.map((item) => (
              <button key={item.id} type="button" className={section === item.id ? "active" : ""} onClick={() => setSection(item.id)}>
                <span><strong>{item.label}</strong><small>{item.detail}</small></span>
                <ChevronRight size={14} />
              </button>
            ))}
          </nav>

          <div className="settings-content">
            {section === "editor" && (
              <>
                <SettingsIntro title="编辑与保存" description="在纯源码与接近 Typora 的实时编译体验之间自由切换。" />
                <SettingRow title="默认使用实时渲染编辑" description="启动后直接进入接近 Typora 的所见即所得编辑。公式与 Mermaid 作为不可破坏的渲染块显示，复杂语法仍可随时切回源码。">
                  <Switch checked={settings.liveEditing} onChange={(checked) => patch({ liveEditing: checked })} />
                </SettingRow>
                <SettingRow title="自动保存延迟" description="停止输入后再写入磁盘，降低频繁 I/O。">
                  <Select value={String(settings.autosaveDelayMs)} onChange={(value) => patch({ autosaveDelayMs: Number(value) })} options={[
                    ["250", "250 毫秒"], ["600", "600 毫秒"], ["1000", "1 秒"], ["2000", "2 秒"],
                  ]} />
                </SettingRow>
                <SettingRow title="显示底部状态栏" description="展示编码、字数、文件大小与保存状态。">
                  <Switch checked={settings.showStatusBar} onChange={(checked) => patch({ showStatusBar: checked })} />
                </SettingRow>
              </>
            )}

            {section === "appearance" && (
              <>
                <SettingsIntro title="外观" description="保持安静的阅读界面，同时让长文档拥有舒适的密度。" />
                <SettingRow title="颜色主题" description="系统模式会跟随操作系统切换。">
                  <ThemePicker value={settings.theme} onChange={(theme) => patch({ theme })} />
                </SettingRow>
                <SettingRow title="文档字体" description={isAndroid ? "读取 Android 系统字体；选择名称后即时预览，清空则恢复系统推荐字体。" : "读取本机已安装字体；输入名称时会即时预览，清空则恢复系统推荐字体。"}>
                  <FontPicker
                    value={settings.fontFamily}
                    families={fontFamilies ?? []}
                    loading={fontFamilies === null}
                    listId={fontListId}
                    onChange={(fontFamily) => patch({ fontFamily })}
                  />
                </SettingRow>
                <SettingSlider title="正文字号" value={settings.fontSize} min={13} max={22} unit="px" onChange={(fontSize) => patch({ fontSize })} />
                <SettingSlider title="正文行高" value={settings.lineHeight} min={1.4} max={2.1} step={0.05} unit="" onChange={(lineHeight) => patch({ lineHeight })} />
                <SettingSlider title="内容最大宽度" value={settings.contentWidth} min={640} max={1120} step={20} unit="px" onChange={(contentWidth) => patch({ contentWidth })} />
                <SettingRow title="减少动态效果" description="关闭面板和模式切换动画。">
                  <Switch checked={settings.reduceMotion} onChange={(checked) => patch({ reduceMotion: checked })} />
                </SettingRow>
              </>
            )}

            {section === "workspace" && (
              <>
                <SettingsIntro title="文档库" description={isAndroid ? "Android 版使用应用私有文档库；从其他应用打开或手动导入的 Markdown 会复制并长期保留。" : "LeafMark 直接读取本地目录，不导入数据库，也不锁定你的内容。"} />
                <div className="workspace-card">
                  <div className="workspace-icon"><FolderOpen size={20} /></div>
                  <div><small>当前目录</small><strong title={settings.workspacePath}>{settings.workspacePath}</strong></div>
                  <button className="secondary-button" type="button" onClick={() => void chooseWorkspace()} disabled={isAndroid || working || !api.isTauri()}>
                    {isAndroid ? "应用私有目录" : working ? "切换中…" : "更换目录"}
                  </button>
                </div>
                <div className="settings-note">
                  {isAndroid
                    ? "通过 Android“打开方式”或分享菜单送入 LeafMark 的文档会立即复制到应用资料库；原文件之后即使被删除，历史与收藏中的保留副本仍可打开。"
                    : <>目录扫描遵守 <code>.gitignore</code>、<code>.ignore</code> 和 <code>.markignore</code>，并自动跳过隐藏目录与常见构建产物。</>}
                </div>
              </>
            )}

            {section === "integration" && (
              <>
                <SettingsIntro title="系统集成" description={isAndroid ? "从文件管理器、聊天、网盘或其他应用把 Markdown 直接交给 LeafMark。" : "从资源管理器右键菜单、打开方式或双击直接进入 LeafMark。"} />
                <div className="association-card">
                  <div className={`association-icon${associationStatus.isDefault || associationStatus.registered ? " ready" : ""}`}>
                    {associationStatus.isDefault || associationStatus.registered ? <Check size={20} /> : <AppWindow size={20} />}
                  </div>
                  <div>
                    <small>.MD / .MARKDOWN</small>
                    <strong>{isAndroid ? "已响应 Android Markdown Intent" : associationStatus.isDefault ? "LeafMark 是默认应用" : "Markdown 文件关联"}</strong>
                    <p>{associationStatus.message}</p>
                  </div>
                </div>
                {!isAndroid && <div className="association-buttons">
                  <button
                    className="primary-button"
                    type="button"
                    disabled={!associationStatus.supported || associationWorking || !api.isTauri()}
                    onClick={() => void changeAssociation(true)}
                  >
                    <ExternalLink size={14} />
                    {associationWorking ? "正在打开…" : associationStatus.registered ? "打开 Windows 默认应用设置" : "注册并打开默认应用设置"}
                  </button>
                  <button
                    className="secondary-button"
                    type="button"
                    disabled={!associationStatus.supported || associationWorking || !api.isTauri()}
                    onClick={() => void changeAssociation(false)}
                  >
                    <RefreshCw size={13} /> 刷新状态
                  </button>
                </div>}
                <div className="settings-note">
                  {isAndroid
                    ? "首次从其他应用打开 .md / .markdown 时选择 LeafMark；若系统提供“始终”选项，可将它设为默认打开方式。ACTION_VIEW、ACTION_SEND 与多文件分享均已注册。"
                    : "Windows 会阻止应用静默篡改默认程序。LeafMark 会先注册为 Markdown 打开方式，再带你进入系统确认页；确认后，右键“打开方式”和双击都会交给 LeafMark。"}
                </div>
              </>
            )}

            {section === "performance" && (
              <>
                <SettingsIntro title="渲染" description="Rust 负责 Markdown 首次编译，体积较大的增强能力只在文档实际需要时加载。" />
                <SettingRow title="Mermaid 图表" description="图表进入可视区域前才加载与绘制，长文档滚动更轻。">
                  <Switch checked={settings.mermaidEnabled} onChange={(checked) => patch({ mermaidEnabled: checked })} />
                </SettingRow>
                <SettingRow title="数学公式" description="支持 $…$、$$…$$、\\(…\\)、\\[…\\] 以及 math / tex / latex 代码围栏。">
                  <Switch checked={settings.mathEnabled} onChange={(checked) => patch({ mathEnabled: checked })} />
                </SettingRow>
                <div className="performance-grid">
                  <Metric label="Markdown" value="Rust" detail="pulldown-cmark" />
                  <Metric label="写入" value="原子" detail="临时文件替换" />
                  <Metric label="缓存" value="LRU" detail="按修改时间失效" />
                  <Metric label="图表" value="懒加载" detail="动态代码分块" />
                </div>
              </>
            )}
          </div>
        </div>
        <footer className="settings-footer">
          <button type="button" className="text-button" onClick={() => onChange(defaultVisualSettings(settings))}><RotateCcw size={14} /> 重置外观</button>
          <button type="button" className="primary-button" onClick={onClose}><Check size={15} /> 完成</button>
        </footer>
      </section>
    </div>
  );
}

function SettingsIntro({ title, description }: { title: string; description: string }) {
  return <div className="settings-intro"><h3>{title}</h3><p>{description}</p></div>;
}

function SettingRow({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return <div className="setting-row"><div><strong>{title}</strong><p>{description}</p></div><div className="setting-control">{children}</div></div>;
}

function SettingSlider({ title, value, min, max, step = 1, unit, onChange }: {
  title: string; value: number; min: number; max: number; step?: number; unit: string; onChange: (value: number) => void;
}) {
  return <div className="setting-slider"><div><strong>{title}</strong><output>{value}{unit}</output></div><input type="range" value={value} min={min} max={max} step={step} onChange={(event) => onChange(Number(event.target.value))} /></div>;
}

function Switch({ checked, onChange }: { checked: boolean; onChange: (value: boolean) => void }) {
  return <button type="button" role="switch" aria-checked={checked} className={`switch${checked ? " checked" : ""}`} onClick={() => onChange(!checked)}><span /></button>;
}

function Select({ value, onChange, options }: { value: string; onChange: (value: string) => void; options: [string, string][] }) {
  return <select value={value} onChange={(event) => onChange(event.target.value)}>{options.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>;
}

function ThemePicker({ value, onChange }: { value: ThemeMode; onChange: (value: ThemeMode) => void }) {
  const choices: { value: ThemeMode; label: string; icon: React.ReactNode }[] = [
    { value: "system", label: "系统", icon: <Monitor size={14} /> },
    { value: "light", label: "浅色", icon: <Sun size={14} /> },
    { value: "dark", label: "深色", icon: <Moon size={14} /> },
  ];
  return <div className="theme-picker">{choices.map((choice) => <button key={choice.value} type="button" className={value === choice.value ? "active" : ""} onClick={() => onChange(choice.value)}>{choice.icon}{choice.label}</button>)}</div>;
}

function FontPicker({ value, families, loading, listId, onChange }: {
  value: string;
  families: string[];
  loading: boolean;
  listId: string;
  onChange: (value: string) => void;
}) {
  const selected = value === "system" ? "" : value;
  return (
    <div className="font-picker">
      <input
        type="text"
        list={listId}
        value={selected}
        placeholder={loading ? "正在读取本机字体…" : "系统推荐字体"}
        onChange={(event) => onChange(event.target.value || "system")}
        aria-label="文档字体"
      />
      <datalist id={listId}>
        {families.map((family) => <option key={family} value={family} />)}
      </datalist>
      <span style={{ fontFamily: fontPreviewStack(value) }}>一叶 · Markdown Aa 0123</span>
      <small>{loading ? "扫描中" : `${families.length} 个本机字体族`}</small>
    </div>
  );
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <div className="metric"><small>{label}</small><strong>{value}</strong><span>{detail}</span></div>;
}

function defaultVisualSettings(settings: AppSettings): AppSettings {
  return { ...settings, theme: "system", contentWidth: 860, fontFamily: "system", fontSize: 16, lineHeight: 1.75, reduceMotion: false };
}

function fontPreviewStack(fontFamily: string) {
  const fallback = '"Iowan Old Style", "Source Han Serif SC", "Noto Serif CJK SC", "Songti SC", Georgia, "Segoe UI", serif';
  const family = fontFamily.trim();
  return !family || family === "system" ? fallback : `${JSON.stringify(family)}, ${fallback}`;
}
