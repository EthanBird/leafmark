/// <reference types="vite/client" />

type LeafMarkAndroidExportOperation = "write" | "share";

interface LeafMarkAndroidExportResult {
  requestId: string;
  operation: LeafMarkAndroidExportOperation;
  ok: boolean;
  bytesWritten?: number;
  error?: string;
}

interface LeafMarkAndroidBridge {
  setDarkMode(dark: boolean): void;
  startAgentKeepAlive?(turnId: string, phase: string): string;
  updateAgentKeepAlive?(turnId: string, phase: string): string;
  completeAgentKeepAlive?(turnId: string): string;
  consumeAgentCancellation?(turnId: string): boolean;
  writePreparedExport(targetUri: string, stagedPath: string, requestId: string): void;
  sharePreparedExport(stagedPath: string, mimeType: string, requestId: string): void;
}

interface Window {
  LeafMarkAndroid?: LeafMarkAndroidBridge;
}
