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
import { openUrl } from "@tauri-apps/plugin-opener";
import type { AgentAuthAccountStatus, AgentAuthChallenge, AppSettings, AssociationStatus, ThemeMode, ThemePalette } from "../types";
import { api } from "../api";
import { AGENT_PROVIDER_PROFILES, PROVIDER_DEFAULTS, REASONING_EFFORT_LABELS, defaultReasoningEffort, isOAuthProvider, providerProfile, reasoningEffortsForProvider } from "../agent-providers";
import { defaultDesktopDockLayout } from "../dock-layout";

interface SettingsPanelProps {
  settings: AppSettings;
  associationStatus: AssociationStatus;
  onChange: (settings: AppSettings) => void;
  onWorkspaceChange: (path: string) => Promise<void>;
  onAssociationChange: (requestDefault: boolean) => Promise<void>;
  onClose: () => void;
}

type Section = "editor" | "agent" | "appearance" | "layout" | "workspace" | "integration" | "performance";

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
  const [agentAuth, setAgentAuth] = useState<AgentAuthAccountStatus | null>(null);
  const [authChallenge, setAuthChallenge] = useState<AgentAuthChallenge | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authWorking, setAuthWorking] = useState(false);
  const fontListId = useId();
  const sections = useMemo(() => [
    { id: "editor" as const, label: "编辑与保存", detail: "编译模式、自动保存" },
    { id: "agent" as const, label: "AI Agent", detail: "模型、工具与记忆" },
    { id: "appearance" as const, label: "外观", detail: "主题、字号与版心" },
    { id: "layout" as const, label: "桌面布局", detail: "停靠面板、尺寸" },
    { id: "workspace" as const, label: "文档库", detail: "本地目录" },
    { id: "integration" as const, label: "系统集成", detail: "打开方式、默认应用" },
    { id: "performance" as const, label: "渲染", detail: "Mermaid 与公式" },
  ], []);

  const patch = (next: Partial<AppSettings>) => onChange({ ...settings, ...next });
  const patchAgent = (next: Partial<AppSettings["agent"]>) => patch({ agent: { ...settings.agent, ...next } });

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

  useEffect(() => {
    if (section !== "agent" || !isOAuthProvider(settings.agent.provider)) {
      setAgentAuth(null);
      return;
    }
    let active = true;
    void api.getAgentAuthStatus(settings.agent.provider)
      .then((status) => { if (active) setAgentAuth(status); })
      .catch((error) => { if (active) setAgentAuth({ provider: settings.agent.provider, connected: false, email: null, expiresAt: null, detail: String(error) }); });
    return () => { active = false; };
  }, [section, settings.agent.provider]);

  const startAgentLogin = async () => {
    setAuthWorking(true);
    setAuthChallenge(null);
    setAuthError(null);
    try {
      const challenge = await api.startAgentOAuth(settings.agent.provider);
      setAuthChallenge(challenge);
      for (let attempt = 0; attempt < 300; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 1000));
        const status = await api.pollAgentOAuth(challenge.flowId);
        setAuthChallenge((current) => current ? { ...current, message: status.message } : current);
        if (status.status === "pending") continue;
        if (status.status === "error") throw new Error(status.message);
        setAgentAuth(await api.getAgentAuthStatus(settings.agent.provider));
        setAuthChallenge(null);
        return;
      }
      throw new Error("登录等待超时，请重新开始");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setAuthError(message);
      setAuthChallenge((current) => current ? { ...current, message } : current);
    } finally {
      setAuthWorking(false);
    }
  };

  const logoutAgent = async () => {
    setAuthWorking(true);
    try {
      await api.logoutAgentOAuth(settings.agent.provider);
      setAgentAuth(await api.getAgentAuthStatus(settings.agent.provider));
      setAuthChallenge(null);
      setAuthError(null);
    } finally {
      setAuthWorking(false);
    }
  };

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

            {section === "agent" && (
              <>
                <SettingsIntro title="AI Agent" description="以 jcode 的 provider/auth 分层为基准：订阅 OAuth、原生模型协议、工具循环、长期记忆、会话恢复、Skills、MCP 与本机终端。未发送消息时不会建立模型连接。" />
                <SettingRow title="启用一叶 Agent" description="启用后，Agent 会出现在桌面 Dock 与 Android 侧栏的第四个页签。模型请求只在你发送消息时发生。">
                  <Switch checked={settings.agent.enabled} onChange={(enabled) => patchAgent({ enabled })} />
                </SettingRow>
                <SettingRow title="Provider" description="订阅 Provider 使用原生 OAuth 和专用协议；其他条目与 jcode 的 OpenAI-compatible provider catalog 保持一致。">
                  <Select
                    value={settings.agent.provider}
                    onChange={(provider) => {
                      const next = provider as AppSettings["agent"]["provider"];
                      patchAgent({ provider: next, ...PROVIDER_DEFAULTS[next], reasoningEffort: defaultReasoningEffort(next) });
                    }}
                    options={AGENT_PROVIDER_PROFILES.map((item): [string, string] => [item.id, item.name])}
                  />
                </SettingRow>
                {isOAuthProvider(settings.agent.provider) && (
                  <div className="agent-auth-card">
                    <div>
                      <small>SUBSCRIPTION OAUTH</small>
                      <strong>{agentAuth?.connected ? agentAuth.email || "订阅账户已连接" : `登录 ${providerProfile(settings.agent.provider).name}`}</strong>
                      <p>{authChallenge?.message || authError || agentAuth?.detail || "凭据由 Rust harness 保存；不会写入设置或 WebView localStorage。"}</p>
                      {authChallenge?.userCode && <button type="button" className="agent-device-code" onClick={() => void navigator.clipboard?.writeText(authChallenge.userCode!)} title="点击复制设备代码">{authChallenge.userCode}</button>}
                      {authChallenge?.authorizeUrl && <>
                        <button type="button" className="agent-device-code agent-login-link" onClick={() => void openUrl(authChallenge.authorizeUrl)} title="再次使用系统默认浏览器打开"><ExternalLink size={13} /> 重新打开登录页</button>
                        <button type="button" className="agent-device-code agent-login-link" onClick={() => void navigator.clipboard?.writeText(authChallenge.authorizeUrl)} title="复制后粘贴到任意浏览器">复制登录链接</button>
                      </>}
                    </div>
                    {agentAuth?.connected
                      ? <button type="button" className="secondary-button" disabled={authWorking} onClick={() => void logoutAgent()}>退出登录</button>
                      : <button type="button" className="primary-button" disabled={authWorking || !api.isTauri()} onClick={() => void startAgentLogin()}>{authWorking ? "等待授权…" : "浏览器登录"}</button>}
                  </div>
                )}
                {!isOAuthProvider(settings.agent.provider) && <AgentTextField title="Base URL" description="兼容地址可填写到 /v1；一叶会根据 Provider 的原生协议补齐请求路径。" value={settings.agent.baseUrl} placeholder="https://api.example.com/v1" onChange={(baseUrl) => patchAgent({ baseUrl })} />}
                {!isOAuthProvider(settings.agent.provider) && providerProfile(settings.agent.provider).auth !== "local" && <AgentTextField title="API Key" description="只用于当前 API Provider；订阅登录不会读取这里的 Key。" value={settings.agent.apiKey} placeholder="sk-…" secret onChange={(apiKey) => patchAgent({ apiKey })} />}
                <AgentTextField title="模型" description="使用服务端显示的精确模型 ID。" value={settings.agent.model} placeholder="deepseek-chat" onChange={(model) => patchAgent({ model })} />
                <SettingSlider title="Temperature" value={settings.agent.temperature} min={0} max={2} step={0.05} unit="" onChange={(temperature) => patchAgent({ temperature })} />
                <SettingSlider title="Top P" value={settings.agent.topP} min={0.05} max={1} step={0.05} unit="" onChange={(topP) => patchAgent({ topP })} />
                <SettingRow title="推理强度" description="兼容支持 reasoning_effort 的模型；普通模型会忽略该参数。">
                  <Select value={settings.agent.reasoningEffort} onChange={(reasoningEffort) => patchAgent({ reasoningEffort: reasoningEffort as AppSettings["agent"]["reasoningEffort"] })} options={[
                    ...reasoningEffortsForProvider(settings.agent.provider).map((effort): [string, string] => [effort, REASONING_EFFORT_LABELS[effort]]),
                  ]} />
                </SettingRow>
                <SettingRow title="最大输出" description="单次模型响应的 token 上限。">
                  <NumberField value={settings.agent.maxTokens} min={512} max={131072} step={512} onChange={(maxTokens) => patchAgent({ maxTokens })} />
                </SettingRow>
                <SettingRow title="文档上下文" description="自动放入提示词的当前文档字符数；超出后由 Agent 使用 read_document 按需读取。">
                  <NumberField value={settings.agent.contextChars} min={4000} max={200000} step={4000} onChange={(contextChars) => patchAgent({ contextChars })} />
                </SettingRow>
                <SettingRow title="最大工具轮数" description="防止模型在工具循环中无限执行。">
                  <NumberField value={settings.agent.maxToolRounds} min={1} max={16} step={1} onChange={(maxToolRounds) => patchAgent({ maxToolRounds })} />
                </SettingRow>
                <SettingRow title="并行子 Agent" description="主 Agent 可把审阅、核查或改写方案并行委派给多个只读子 Agent，再统一汇总；设为 0 可关闭。">
                  <NumberField value={settings.agent.maxParallelAgents} min={0} max={4} step={1} onChange={(maxParallelAgents) => patchAgent({ maxParallelAgents })} />
                </SettingRow>
                <SettingRow title="允许修改文档" description="关闭时 Agent 仍可阅读、检索和给建议，但写入类工具会被运行时拒绝。">
                  <Switch checked={settings.agent.allowDocumentEdits} onChange={(allowDocumentEdits) => patchAgent({ allowDocumentEdits })} />
                </SettingRow>
                <SettingRow title="长期记忆" description="使用本地、无模型依赖的语义特征索引；跨会话检索，不加载嵌入模型。">
                  <Switch checked={settings.agent.memoryEnabled} onChange={(memoryEnabled) => patchAgent({ memoryEnabled })} />
                </SettingRow>
                <SettingRow title="Web 工具" description="允许 Agent 使用原生 HTTP 客户端读取 HTTP/HTTPS 页面文字。">
                  <Switch checked={settings.agent.webToolsEnabled} onChange={(webToolsEnabled) => patchAgent({ webToolsEnabled })} />
                </SettingRow>
                <SettingRow title="本机终端工具" description={isAndroid ? "Android 不提供系统终端 harness。" : "允许 Agent 在当前文档库中执行命令；Windows 固定使用隐藏窗口的 PowerShell，不会弹出黑色命令行。支持前台超时和后台任务。"}>
                  <Switch checked={!isAndroid && settings.agent.terminalToolsEnabled} onChange={(terminalToolsEnabled) => patchAgent({ terminalToolsEnabled: !isAndroid && terminalToolsEnabled })} />
                </SettingRow>
                {settings.agent.terminalToolsEnabled && !isAndroid && <SettingRow title="允许破坏性终端命令" description="关闭时，删除、格式化、git reset --hard 等命令会在 Rust 层被拒绝。建议保持关闭。">
                  <Switch checked={settings.agent.allowDestructiveTerminal} onChange={(allowDestructiveTerminal) => patchAgent({ allowDestructiveTerminal })} />
                </SettingRow>}
                <div className="agent-settings-block">
                  <strong>内置 Skills</strong><p>Skills 只向模型注入所需的方法约束，不引入额外运行库。</p>
                  <div className="skill-options">
                    {[["writing", "写作"], ["proofread", "校对"], ["translate", "翻译"], ["summarize", "总结"], ["structure", "结构化"], ["research", "研究"]].map(([id, label]) => (
                      <label key={id}><input type="checkbox" checked={settings.agent.enabledSkills.includes(id)} onChange={(event) => patchAgent({ enabledSkills: event.target.checked ? [...settings.agent.enabledSkills, id] : settings.agent.enabledSkills.filter((item) => item !== id) })} />{label}</label>
                    ))}
                  </div>
                </div>
                <AgentTextArea title="自定义 Skills" description="写入你希望 Agent 长期遵循的领域方法、格式规范或工作流。" value={settings.agent.customSkills} placeholder="例如：处理数学文档时，所有公式必须保持 LaTeX 原文…" onChange={(customSkills) => patchAgent({ customSkills })} />
                <AgentTextArea title="系统提示词" description="定义 Agent 的基础角色；文档上下文、记忆和已启用 Skills 会在运行时追加。" value={settings.agent.systemPrompt} onChange={(systemPrompt) => patchAgent({ systemPrompt })} />
                <AgentTextArea title="MCP 服务器" description={'Streamable HTTP MCP 配置，JSON 数组格式：[{"name":"docs","url":"https://…/mcp","headers":{"Authorization":"Bearer …"}}]'} value={settings.agent.mcpServersJson} placeholder="[]" mono onChange={(mcpServersJson) => patchAgent({ mcpServersJson })} />
              </>
            )}

            {section === "appearance" && (
              <>
                <SettingsIntro title="外观" description="保持安静的阅读界面，同时让长文档拥有舒适的密度。" />
                <SettingRow title="颜色主题" description="系统模式会跟随操作系统切换。">
                  <ThemePicker value={settings.theme} onChange={(theme) => patch({ theme })} />
                </SettingRow>
                <SettingRow title="主题配色" description="每套配色都为浅色与深色模式分别调校，正文对比度保持一致。">
                  <PalettePicker value={settings.themePalette} onChange={(themePalette) => patch({ themePalette })} />
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

            {section === "layout" && (
              <>
                <SettingsIntro title="桌面柔性布局" description={isAndroid ? "Android 保持抽屉式单栏布局，不启用桌面 Dock。" : "拖动文档、历史、收藏、Agent 或大纲标签到窗口四边。放入已有区域会合并成标签组；拖动分隔条可调整尺寸。"} />
                <SettingSlider title="左侧面板宽度" value={settings.desktopLayout.leftSize} min={190} max={520} step={10} unit="px" onChange={(leftSize) => patch({ desktopLayout: { ...settings.desktopLayout, leftSize } })} />
                <SettingSlider title="右侧面板宽度" value={settings.desktopLayout.rightSize} min={190} max={520} step={10} unit="px" onChange={(rightSize) => patch({ desktopLayout: { ...settings.desktopLayout, rightSize } })} />
                <SettingSlider title="上方面板高度" value={settings.desktopLayout.topSize} min={130} max={420} step={10} unit="px" onChange={(topSize) => patch({ desktopLayout: { ...settings.desktopLayout, topSize } })} />
                <SettingSlider title="下方面板高度" value={settings.desktopLayout.bottomSize} min={130} max={420} step={10} unit="px" onChange={(bottomSize) => patch({ desktopLayout: { ...settings.desktopLayout, bottomSize } })} />
                <div className="layout-reset-card"><div><strong>恢复默认工作区</strong><p>左侧合并文档、历史、收藏与 Agent，大纲恢复到右侧并保持隐藏。</p></div><button className="secondary-button" type="button" disabled={isAndroid} onClick={() => patch({ desktopLayout: defaultDesktopDockLayout() })}><RotateCcw size={13} /> 重置布局</button></div>
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

function AgentTextField({ title, description, value, placeholder, secret = false, onChange }: {
  title: string; description: string; value: string; placeholder?: string; secret?: boolean; onChange: (value: string) => void;
}) {
  return <div className="agent-setting-field"><div><strong>{title}</strong><p>{description}</p></div><input type={secret ? "password" : "text"} value={value} placeholder={placeholder} autoComplete={secret ? "off" : undefined} onChange={(event) => onChange(event.target.value)} /></div>;
}

function AgentTextArea({ title, description, value, placeholder, mono = false, onChange }: {
  title: string; description: string; value: string; placeholder?: string; mono?: boolean; onChange: (value: string) => void;
}) {
  return <div className="agent-setting-area"><strong>{title}</strong><p>{description}</p><textarea className={mono ? "mono" : ""} value={value} placeholder={placeholder} rows={5} onChange={(event) => onChange(event.target.value)} /></div>;
}

function NumberField({ value, min, max, step, onChange }: { value: number; min: number; max: number; step: number; onChange: (value: number) => void }) {
  return <input className="number-field" type="number" value={value} min={min} max={max} step={step} onChange={(event) => onChange(Math.min(max, Math.max(min, Number(event.target.value) || min)))} />;
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

function PalettePicker({ value, onChange }: { value: ThemePalette; onChange: (value: ThemePalette) => void }) {
  const choices: { value: ThemePalette; label: string; colors: [string, string] }[] = [
    { value: "leaf", label: "一叶绿", colors: ["#52745a", "#dce9dd"] },
    { value: "sakura", label: "樱花粉", colors: ["#b9657c", "#f6e2e8"] },
    { value: "qingchuan", label: "清川蓝", colors: ["#39769c", "#dcecf4"] },
    { value: "amber", label: "暖杏金", colors: ["#9a6a2f", "#f3e7d2"] },
    { value: "wisteria", label: "藤萝紫", colors: ["#75659b", "#e8e2f3"] },
  ];
  return (
    <div className="palette-picker">
      {choices.map((choice) => (
        <button
          key={choice.value}
          type="button"
          className={value === choice.value ? "active" : ""}
          onClick={() => onChange(choice.value)}
        >
          <span className="palette-swatch" style={{ "--swatch-main": choice.colors[0], "--swatch-soft": choice.colors[1] } as React.CSSProperties} />
          <span>{choice.label}</span>
          {value === choice.value && <Check size={13} />}
        </button>
      ))}
    </div>
  );
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
  return { ...settings, theme: "system", themePalette: "leaf", contentWidth: 860, fontFamily: "system", fontSize: 16, lineHeight: 1.75, reduceMotion: false };
}

function fontPreviewStack(fontFamily: string) {
  const fallback = '"Iowan Old Style", "Source Han Serif SC", "Noto Serif CJK SC", "Songti SC", Georgia, "Segoe UI", serif';
  const family = fontFamily.trim();
  return !family || family === "system" ? fallback : `${JSON.stringify(family)}, ${fallback}`;
}
