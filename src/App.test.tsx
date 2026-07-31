// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import App from "./App";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let cleanup = () => {};

afterEach(() => cleanup());

describe("LeafMark workspace shell", () => {
  it("boots with dock panels, the fourth Agent tab, and document tabs", async () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }),
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    cleanup = () => {
      act(() => root.unmount());
      container.remove();
      cleanup = () => {};
    };

    await act(async () => {
      root.render(<App />);
    });
    for (let attempt = 0; attempt < 10 && !container.querySelector(".document-tab"); attempt += 1) {
      await act(async () => new Promise((resolve) => setTimeout(resolve, 25)));
    }

    const dockLabels = [...container.querySelectorAll(".dock-left .dock-tabs button span")].map((node) => node.textContent);
    expect(dockLabels).toEqual(["文档", "历史", "收藏", "Agent"]);
    expect(container.querySelectorAll(".document-tab")).toHaveLength(1);
    expect(container.querySelector(".breadcrumbs")).toBeNull();

    const agentTab = [...container.querySelectorAll<HTMLButtonElement>(".dock-left .dock-tabs button")]
      .find((button) => button.textContent?.includes("Agent"));
    await act(async () => agentTab?.click());
    expect(container.querySelector(".agent-panel")).not.toBeNull();
    expect(container.textContent).toContain("让文档自己生长");
  });
});
