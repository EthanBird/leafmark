// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { api, type PreparedExport } from "./api";

const originalUserAgent = navigator.userAgent;

function dispatchNativeResult(detail: LeafMarkAndroidExportResult) {
  window.dispatchEvent(new CustomEvent("leafmark-android-export-result", { detail }));
}

beforeEach(() => {
  invokeMock.mockReset();
  Object.defineProperty(navigator, "userAgent", {
    configurable: true,
    value: "Mozilla/5.0 (Linux; Android 15) LeafMarkTest",
  });
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: {},
  });
});

afterEach(() => {
  delete window.LeafMarkAndroid;
  delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  Object.defineProperty(navigator, "userAgent", {
    configurable: true,
    value: originalUserAgent,
  });
});

describe("Android export bridge", () => {
  it("stages raw bytes before writing a content URI through the native bridge", async () => {
    const payload = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    const prepared: PreparedExport = {
      path: "/data/user/0/com.leafmark.desktop/cache/export-staging/1/LeafMark-export.bin",
      fileName: "LeafMark-export.bin",
      mimeType: "application/octet-stream",
      size: payload.byteLength,
      purpose: "save",
    };
    invokeMock.mockResolvedValueOnce(prepared);
    const writePreparedExport = vi.fn((targetUri: string, stagedPath: string, requestId: string) => {
      expect(targetUri).toBe("content://downloads/document/42");
      expect(stagedPath).toBe(prepared.path);
      queueMicrotask(() => dispatchNativeResult({
        requestId,
        operation: "write",
        ok: true,
        bytesWritten: payload.byteLength,
      }));
    });
    window.LeafMarkAndroid = {
      setDarkMode: vi.fn(),
      writePreparedExport,
      sharePreparedExport: vi.fn(),
    };

    await api.writeExport("content://downloads/document/42", payload);

    expect(invokeMock).toHaveBeenCalledOnce();
    expect(invokeMock.mock.calls[0][0]).toBe("prepare_export");
    expect(invokeMock.mock.calls[0][1]).toBe(payload);
    expect(invokeMock.mock.calls[0][2].headers).toEqual({
      "LeafMark-File-Name": "LeafMark-export.bin",
      "LeafMark-Mime-Type": "application%2Foctet-stream",
      "LeafMark-Purpose": "save",
    });
    expect(writePreparedExport).toHaveBeenCalledOnce();
  });

  it("shares a purpose-scoped staged file with its precise MIME type", async () => {
    const payload = new Uint8Array([1, 2, 3]);
    const prepared: PreparedExport = {
      path: "/data/user/0/com.leafmark.desktop/cache/shared-exports/1/报告.pdf",
      fileName: "报告.pdf",
      mimeType: "application/pdf",
      size: payload.byteLength,
      purpose: "share",
    };
    invokeMock.mockResolvedValueOnce(prepared);
    const sharePreparedExport = vi.fn((stagedPath: string, mimeType: string, requestId: string) => {
      expect(stagedPath).toBe(prepared.path);
      expect(mimeType).toBe("application/pdf");
      queueMicrotask(() => dispatchNativeResult({
        requestId,
        operation: "share",
        ok: true,
        bytesWritten: payload.byteLength,
      }));
    });
    window.LeafMarkAndroid = {
      setDarkMode: vi.fn(),
      writePreparedExport: vi.fn(),
      sharePreparedExport,
    };

    await api.shareExport("报告.pdf", "application/pdf", payload);

    expect(invokeMock.mock.calls[0][2].headers).toEqual({
      "LeafMark-File-Name": "%E6%8A%A5%E5%91%8A.pdf",
      "LeafMark-Mime-Type": "application%2Fpdf",
      "LeafMark-Purpose": "share",
    });
    expect(sharePreparedExport).toHaveBeenCalledOnce();
  });

  it("propagates native provider failures instead of reporting a false success", async () => {
    const prepared: PreparedExport = {
      path: "/data/user/0/com.leafmark.desktop/cache/export-staging/1/export.bin",
      fileName: "export.bin",
      mimeType: "application/octet-stream",
      size: 3,
      purpose: "save",
    };
    window.LeafMarkAndroid = {
      setDarkMode: vi.fn(),
      writePreparedExport: (_targetUri, _stagedPath, requestId) => {
        queueMicrotask(() => dispatchNativeResult({
          requestId,
          operation: "write",
          ok: false,
          error: "云端文档提供方拒绝写入",
        }));
      },
      sharePreparedExport: vi.fn(),
    };

    await expect(api.writePreparedExport("content://drive/document/7", prepared))
      .rejects.toThrow("云端文档提供方拒绝写入");
  });
});
