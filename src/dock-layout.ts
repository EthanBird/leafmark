import type { DesktopDockLayout, DockPanelId, DockZone, DockZoneState } from "./types";

export const DOCK_ZONES: DockZone[] = ["left", "right", "top", "bottom"];
export const DOCK_PANELS: DockPanelId[] = ["workspace", "history", "favorites", "agent", "outline"];

const emptyZone = (): DockZoneState => ({ panels: [], active: null });

export function defaultDesktopDockLayout(): DesktopDockLayout {
  return {
    zones: {
      left: { panels: ["workspace", "history", "favorites", "agent"], active: "workspace" },
      right: { panels: ["outline"], active: "outline" },
      top: emptyZone(),
      bottom: emptyZone(),
    },
    hidden: ["outline"],
    leftSize: 276,
    rightSize: 244,
    topSize: 210,
    bottomSize: 240,
  };
}

export function normalizeDesktopDockLayout(value: unknown): DesktopDockLayout {
  const fallback = defaultDesktopDockLayout();
  if (!value || typeof value !== "object") return fallback;
  const input = value as Partial<DesktopDockLayout>;
  const seen = new Set<DockPanelId>();
  const zones = {} as Record<DockZone, DockZoneState>;
  for (const zone of DOCK_ZONES) {
    const source = input.zones?.[zone];
    const panels = Array.isArray(source?.panels)
      ? source.panels.filter((panel): panel is DockPanelId => DOCK_PANELS.includes(panel as DockPanelId) && !seen.has(panel as DockPanelId))
      : [];
    panels.forEach((panel) => seen.add(panel));
    zones[zone] = {
      panels,
      active: panels.includes(source?.active as DockPanelId) ? source?.active as DockPanelId : panels[0] ?? null,
    };
  }
  for (const panel of DOCK_PANELS) {
    if (!seen.has(panel)) zones[panel === "outline" ? "right" : "left"].panels.push(panel);
  }
  for (const zone of DOCK_ZONES) {
    if (!zones[zone].active || !zones[zone].panels.includes(zones[zone].active)) {
      zones[zone].active = zones[zone].panels[0] ?? null;
    }
  }
  const hidden = Array.isArray(input.hidden)
    ? [...new Set(input.hidden.filter((panel): panel is DockPanelId => DOCK_PANELS.includes(panel as DockPanelId)))]
    : fallback.hidden;
  return {
    zones,
    hidden,
    leftSize: clampSize(input.leftSize, 190, 520, fallback.leftSize),
    rightSize: clampSize(input.rightSize, 190, 520, fallback.rightSize),
    topSize: clampSize(input.topSize, 130, 420, fallback.topSize),
    bottomSize: clampSize(input.bottomSize, 130, 420, fallback.bottomSize),
  };
}

export function moveDockPanel(layout: DesktopDockLayout, panel: DockPanelId, target: DockZone): DesktopDockLayout {
  const next = normalizeDesktopDockLayout(layout);
  for (const zone of DOCK_ZONES) {
    next.zones[zone].panels = next.zones[zone].panels.filter((item) => item !== panel);
    if (next.zones[zone].active === panel) next.zones[zone].active = next.zones[zone].panels[0] ?? null;
  }
  next.zones[target].panels.push(panel);
  next.zones[target].active = panel;
  next.hidden = next.hidden.filter((item) => item !== panel);
  return next;
}

export function activateDockPanel(layout: DesktopDockLayout, panel: DockPanelId): DesktopDockLayout {
  const next = normalizeDesktopDockLayout(layout);
  for (const zone of DOCK_ZONES) {
    if (next.zones[zone].panels.includes(panel)) next.zones[zone].active = panel;
  }
  next.hidden = next.hidden.filter((item) => item !== panel);
  return next;
}

export function hideDockPanel(layout: DesktopDockLayout, panel: DockPanelId): DesktopDockLayout {
  const next = normalizeDesktopDockLayout(layout);
  if (!next.hidden.includes(panel)) next.hidden.push(panel);
  const location = dockPanelZone(next, panel);
  if (location && next.zones[location].active === panel) {
    next.zones[location].active = next.zones[location].panels.find((item) => !next.hidden.includes(item)) ?? panel;
  }
  return next;
}

export function dockPanelZone(layout: DesktopDockLayout, panel: DockPanelId): DockZone | null {
  return DOCK_ZONES.find((zone) => layout.zones[zone].panels.includes(panel)) ?? null;
}

export function visibleDockPanels(layout: DesktopDockLayout, zone: DockZone): DockPanelId[] {
  return layout.zones[zone].panels.filter((panel) => !layout.hidden.includes(panel));
}

export function resizeDockZone(layout: DesktopDockLayout, zone: DockZone, size: number): DesktopDockLayout {
  const next = normalizeDesktopDockLayout(layout);
  if (zone === "left") next.leftSize = clampSize(size, 190, 520, next.leftSize);
  if (zone === "right") next.rightSize = clampSize(size, 190, 520, next.rightSize);
  if (zone === "top") next.topSize = clampSize(size, 130, 420, next.topSize);
  if (zone === "bottom") next.bottomSize = clampSize(size, 130, 420, next.bottomSize);
  return next;
}

function clampSize(value: unknown, min: number, max: number, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
}
