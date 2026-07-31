import { describe, expect, it } from "vitest";
import { activateDockPanel, defaultDesktopDockLayout, hideDockPanel, moveDockPanel, normalizeDesktopDockLayout, visibleDockPanels } from "./dock-layout";

describe("desktop dock layout", () => {
  it("keeps the requested default fourth Agent tab", () => {
    expect(defaultDesktopDockLayout().zones.left.panels).toEqual(["workspace", "history", "favorites", "agent"]);
  });

  it("moves a panel exactly once and merges it into its target", () => {
    const moved = moveDockPanel(defaultDesktopDockLayout(), "favorites", "right");
    expect(moved.zones.left.panels).not.toContain("favorites");
    expect(moved.zones.right.panels).toEqual(["outline", "favorites"]);
    expect(moved.zones.right.active).toBe("favorites");
  });

  it("hides and restores panels without losing their dock", () => {
    const hidden = hideDockPanel(defaultDesktopDockLayout(), "workspace");
    expect(visibleDockPanels(hidden, "left")).toEqual(["history", "favorites", "agent"]);
    const restored = activateDockPanel(hidden, "workspace");
    expect(visibleDockPanels(restored, "left")[0]).toBe("workspace");
  });

  it("repairs malformed persisted layouts and preserves every panel", () => {
    const normalized = normalizeDesktopDockLayout({
      zones: { left: { panels: ["agent", "agent", "invalid"], active: "invalid" } },
      hidden: ["invalid", "outline"],
      leftSize: 9999,
    });
    const panels = Object.values(normalized.zones).flatMap((zone) => zone.panels);
    expect(new Set(panels).size).toBe(5);
    expect(normalized.leftSize).toBe(520);
    expect(normalized.hidden).toEqual(["outline"]);
  });
});
