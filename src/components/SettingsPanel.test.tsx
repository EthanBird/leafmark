// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { defaultAppSettings } from "../settings-defaults";
import { SettingsPanel } from "./SettingsPanel";

const tauriMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  openUrl: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: tauriMocks.invoke }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: tauriMocks.openUrl }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const originalUserAgent = navigator.userAgent;
let cleanup = () => {};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  delete (window as typeof window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  Object.defineProperty(navigator, "userAgent", { configurable: true, value: originalUserAgent });
});

describe("SettingsPanel Android OAuth", () => {
  it("shows ChatGPT subscription browser login on Android", async () => {
    Object.defineProperty(navigator, "userAgent", { configurable: true, value: "LeafMark Android 15" });
    (window as typeof window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    tauriMocks.openUrl.mockResolvedValue(undefined);
    tauriMocks.invoke.mockImplementation(async (command: string) => {
      if (command === "agent_auth_status") {
        return { provider: "openai-oauth", connected: false, email: null, expiresAt: null, detail: "尚未登录" };
      }
      if (command === "agent_oauth_start") {
        return {
          flowId: "flow-android",
          provider: "openai-oauth",
          authorizeUrl: "https://auth.openai.com/oauth/authorize?test=1",
          userCode: null,
          message: "已打开系统默认浏览器",
        };
      }
      if (command === "agent_oauth_poll") {
        return { status: "pending", message: "等待浏览器授权…" };
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    cleanup = () => {
      act(() => root.unmount());
      container.remove();
      cleanup = () => {};
    };
    const settings = defaultAppSettings("/documents");
    settings.agent = { ...settings.agent, provider: "openai-oauth" };

    await act(async () => {
      root.render(<SettingsPanel
        settings={settings}
        associationStatus={{ supported: true, registered: true, isDefault: true, portable: false, message: "ok" }}
        onChange={() => {}}
        onWorkspaceChange={async () => {}}
        onAssociationChange={async () => {}}
        onClose={() => {}}
      />);
    });

    expect(api.isAndroid()).toBe(true);
    const agentSection = [...container.querySelectorAll<HTMLButtonElement>(".settings-nav button")]
      .find((button) => button.textContent?.includes("AI Agent"));
    await act(async () => agentSection?.click());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

    expect(container.querySelector(".agent-auth-card")?.textContent).toContain("OpenAI · ChatGPT/Codex 订阅");
    const loginButton = container.querySelector<HTMLButtonElement>(".agent-auth-card .primary-button");
    expect(loginButton?.textContent).toBe("浏览器登录");
    expect(loginButton?.disabled).toBe(false);

    vi.spyOn(window, "setTimeout").mockImplementation(
      () => 0 as unknown as ReturnType<typeof window.setTimeout>,
    );
    await act(async () => {
      loginButton?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(tauriMocks.invoke).toHaveBeenCalledWith("agent_oauth_start", { provider: "openai-oauth" });

    const reopenButton = [...container.querySelectorAll<HTMLButtonElement>(".agent-login-link")]
      .find((button) => button.textContent?.includes("重新打开登录页"));
    expect(reopenButton).toBeDefined();
    await act(async () => reopenButton?.click());
    expect(tauriMocks.openUrl).toHaveBeenCalledWith("https://auth.openai.com/oauth/authorize?test=1");
  });
});

describe("SettingsPanel appearance palettes", () => {
  it("offers the monochrome palette and emits a compatible settings value", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    cleanup = () => {
      act(() => root.unmount());
      container.remove();
      cleanup = () => {};
    };
    const settings = defaultAppSettings("/documents");
    const onChange = vi.fn();

    await act(async () => {
      root.render(<SettingsPanel
        settings={settings}
        associationStatus={{ supported: true, registered: true, isDefault: true, portable: false, message: "ok" }}
        onChange={onChange}
        onWorkspaceChange={async () => {}}
        onAssociationChange={async () => {}}
        onClose={() => {}}
      />);
    });

    const appearanceSection = [...container.querySelectorAll<HTMLButtonElement>(".settings-nav button")]
      .find((button) => button.textContent?.includes("外观"));
    await act(async () => appearanceSection?.click());

    const monochrome = [...container.querySelectorAll<HTMLButtonElement>(".palette-picker button")]
      .find((button) => button.textContent?.includes("黑白灰"));
    expect(monochrome).toBeDefined();
    await act(async () => monochrome?.click());

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ themePalette: "monochrome" }));
  });

  it("explains portable mode without exposing registry actions", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    cleanup = () => {
      act(() => root.unmount());
      container.remove();
      cleanup = () => {};
    };

    await act(async () => {
      root.render(<SettingsPanel
        settings={defaultAppSettings("/documents")}
        associationStatus={{
          supported: false,
          registered: false,
          isDefault: false,
          portable: true,
          message: "便携版不会读取或写入 LeafMark 文件关联注册表，也不需要管理员权限",
        }}
        onChange={() => {}}
        onWorkspaceChange={async () => {}}
        onAssociationChange={async () => {}}
        onClose={() => {}}
      />);
    });

    const integrationSection = [...container.querySelectorAll<HTMLButtonElement>(".settings-nav button")]
      .find((button) => button.textContent?.includes("系统集成"));
    await act(async () => integrationSection?.click());

    expect(container.querySelector(".association-card")?.textContent).toContain("Windows 便携模式");
    expect(container.querySelector(".settings-content")?.textContent).toContain("不请求管理员权限");
    expect(container.querySelector(".association-buttons")).toBeNull();
  });
});
