import { Bot, Clock3, Files, ListTree, Star, X } from "lucide-react";
import { useRef, type ReactNode } from "react";
import type { DockPanelId, DockZone } from "../types";

const PANEL_META: Record<DockPanelId, { label: string; icon: ReactNode }> = {
  workspace: { label: "文档", icon: <Files size={13} /> },
  history: { label: "历史", icon: <Clock3 size={13} /> },
  favorites: { label: "收藏", icon: <Star size={13} /> },
  agent: { label: "Agent", icon: <Bot size={13} /> },
  outline: { label: "大纲", icon: <ListTree size={13} /> },
};

interface DockRegionProps {
  zone: DockZone;
  panels: DockPanelId[];
  active: DockPanelId;
  size: number;
  renderPanel: (panel: DockPanelId) => ReactNode;
  onActivate: (panel: DockPanelId) => void;
  onHide: (panel: DockPanelId) => void;
  onDragStart: (panel: DockPanelId) => void;
  onDragMove: (x: number, y: number) => void;
  onDragEnd: (panel: DockPanelId, x: number, y: number) => void;
  onResize: (size: number) => void;
}

export function DockRegion({ zone, panels, active, size, renderPanel, onActivate, onHide, onDragStart, onDragMove, onDragEnd, onResize }: DockRegionProps) {
  const suppressClick = useRef<DockPanelId | null>(null);
  if (!panels.length) return null;
  const resize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const initial = size;
    const move = (next: PointerEvent) => {
      const delta = zone === "left" ? next.clientX - startX
        : zone === "right" ? startX - next.clientX
          : zone === "top" ? next.clientY - startY
            : startY - next.clientY;
      onResize(initial + delta);
    };
    const finish = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish, { once: true });
  };

  return (
    <aside className={`dock-region dock-${zone}`} style={{ "--dock-size": `${size}px` } as React.CSSProperties}>
      <header className="dock-tabs">
        <div>
          {panels.map((panel) => (
            <button
              key={panel}
              type="button"
              className={active === panel ? "active" : ""}
              onClick={() => {
                if (suppressClick.current === panel) { suppressClick.current = null; return; }
                onActivate(panel);
              }}
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                const startX = event.clientX;
                const startY = event.clientY;
                let dragging = false;
                const previousUserSelect = document.body.style.userSelect;
                const move = (next: PointerEvent) => {
                  if (!dragging && Math.hypot(next.clientX - startX, next.clientY - startY) >= 5) {
                    dragging = true;
                    document.body.style.userSelect = "none";
                    onDragStart(panel);
                  }
                  if (dragging) onDragMove(next.clientX, next.clientY);
                };
                const finish = (next: PointerEvent) => {
                  window.removeEventListener("pointermove", move);
                  window.removeEventListener("pointerup", finish);
                  window.removeEventListener("pointercancel", cancel);
                  document.body.style.userSelect = previousUserSelect;
                  if (dragging) {
                    suppressClick.current = panel;
                    window.setTimeout(() => { if (suppressClick.current === panel) suppressClick.current = null; }, 250);
                    onDragEnd(panel, next.clientX, next.clientY);
                  }
                };
                const cancel = () => {
                  window.removeEventListener("pointermove", move);
                  window.removeEventListener("pointerup", finish);
                  window.removeEventListener("pointercancel", cancel);
                  document.body.style.userSelect = previousUserSelect;
                };
                window.addEventListener("pointermove", move);
                window.addEventListener("pointerup", finish, { once: true });
                window.addEventListener("pointercancel", cancel, { once: true });
              }}
              title={`拖动“${PANEL_META[panel].label}”到窗口边缘以重新停靠`}
            >
              {PANEL_META[panel].icon}<span>{PANEL_META[panel].label}</span>
            </button>
          ))}
        </div>
        <button className="dock-close" type="button" onClick={() => onHide(active)} title="隐藏当前面板"><X size={13} /></button>
      </header>
      <div className="dock-panel-content">{panels.filter((panel) => panel === active || panel === "agent").map((panel) => (
        <div key={panel} className="dock-panel-slot" hidden={panel !== active}>{renderPanel(panel)}</div>
      ))}</div>
      <div className="dock-resizer" onPointerDown={resize} role="separator" aria-orientation={zone === "left" || zone === "right" ? "vertical" : "horizontal"} />
    </aside>
  );
}

export function DockDropTargets({ active, hover }: { active: boolean; hover: DockZone | null }) {
  if (!active) return null;
  const targets: Array<{ zone: DockZone; label: string }> = [
    { zone: "left", label: "停靠左侧" },
    { zone: "right", label: "停靠右侧" },
    { zone: "top", label: "停靠上方" },
    { zone: "bottom", label: "停靠下方" },
  ];
  return <div className="dock-drop-overlay">{targets.map((target) => (
    <div
      key={target.zone}
      className={`dock-drop-target target-${target.zone}${hover === target.zone ? " hover" : ""}`}
    ><span>{target.label}</span></div>
  ))}</div>;
}
