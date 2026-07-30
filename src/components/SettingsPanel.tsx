import { Check, ChevronRight, FileKey2, FolderOpen, Monitor, Moon, RotateCcw, Sun, X } from "lucide-react";
import { useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import type { AppSettings, ThemeMode } from "../types";
import { api } from "../api";

interface SettingsPanelProps {
  settings: AppSettings;
  onChange: (settings: AppSettings) => void;
  onWorkspaceChange: (path: string) => Promise<void>;
  onClose: () => void;
}

type Section = "editor" | "appearance" | "workspace" | "performance";

export function SettingsPanel({ settings, onChange, onWorkspaceChange, onClose }: SettingsPanelProps) {
  const [section, setSection] = useState<Section>("editor");
  const [working, setWorking] = useState(false);
  const [associationNotice, setAssociationNotice] = useState("");
  const sections = useMemo(() => [
    { id: "editor" as const, label: "编辑与保存", detail: "编译模式、自动保存" },
    { id: "appearance" as const, label: "外观", detail: "主题、字号与版心" },
    { id: "workspace" as const, label: "文档库", detail: "本地目录" },
    { id: "performance" as const, label: "渲染", detail: "Mermaid 与公式" },
  ], []);

  const patch = (next: Partial<AppSettings>) => onChange({ ...settings, ...next });

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

  const chooseDefaultApplication = async () => {
    setWorking(true);
    try {
      setAssociationNotice(await api.openDefaultApps());
    } catch (error) {
      setAssociationNotice(`无法打开系统设置：${String(error)}`);
    } finally {
      setWorking(false);
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
                <SettingRow title="启用实时编辑（编译模式）" description="允许直接编辑渲染后的内容。公式与 Mermaid 会作为不可破坏的渲染块显示，复杂语法仍可随时切回源码。">
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
                <SettingsIntro title="文档库" description="LeafMark 直接读取本地目录，不导入数据库，也不锁定你的内容。" />
                <div className="workspace-card">
                  <div className="workspace-icon"><FolderOpen size={20} /></div>
                  <div><small>当前目录</small><strong title={settings.workspacePath}>{settings.workspacePath}</strong></div>
                  <button className="secondary-button" type="button" onClick={() => void chooseWorkspace()} disabled={working || !api.isTauri()}>
                    {working ? "切换中…" : "更换目录"}
                  </button>
                </div>
                <div className="settings-note">
                  目录扫描遵守 <code>.gitignore</code>、<code>.ignore</code> 和 <code>.markignore</code>，并自动跳过隐藏目录与常见构建产物。
                </div>
                <SettingRow title="默认打开 Markdown" description="安装版 LeafMark 已注册 .md 与 .markdown。点击后在 Windows 默认应用设置中将 LeafMark 选为默认应用。">
                  <button className="secondary-button" type="button" onClick={() => void chooseDefaultApplication()} disabled={working || !api.isTauri()}>
                    <FileKey2 size={14} /> 设置为默认
                  </button>
                </SettingRow>
                {associationNotice && <div className="settings-note">{associationNotice}</div>}
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

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <div className="metric"><small>{label}</small><strong>{value}</strong><span>{detail}</span></div>;
}

function defaultVisualSettings(settings: AppSettings): AppSettings {
  return { ...settings, theme: "system", contentWidth: 860, fontSize: 16, lineHeight: 1.75, reduceMotion: false };
}
