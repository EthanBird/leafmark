import { api } from "./api";
import { preparePdfMermaidDiagrams } from "./pdf-mermaid";

export type PdfExportMode = "long" | "pages";

export interface ExportProgress {
  progress: number;
  message: string;
}

export interface PdfExportPalette {
  text: string;
  secondary: string;
  accent: string;
  accentSoft: string;
  border: string;
  surface: string;
  codeSurface: string;
}

export interface PdfExportOptions {
  source: string;
  title: string;
  mode: PdfExportMode;
  fontFamily: string;
  palette: PdfExportPalette;
  onProgress: (progress: ExportProgress) => void;
}

interface ExportFontMetadata {
  family: string;
  postscriptName: string;
  collection: boolean;
}

interface WorkerProgressMessage {
  type: "progress";
  progress: number;
  message: string;
}

interface WorkerCompleteMessage {
  type: "complete";
  bytes: ArrayBuffer;
}

interface WorkerErrorMessage {
  type: "error";
  message: string;
}

type WorkerMessage = WorkerProgressMessage | WorkerCompleteMessage | WorkerErrorMessage;

export interface PdfExportJob {
  promise: Promise<Uint8Array>;
  cancel: () => void;
}

export function startPdfExport(options: PdfExportOptions): PdfExportJob {
  const worker = new Worker(new URL("./pdf-export.worker.ts", import.meta.url), {
    type: "module",
    name: "leafmark-pdf-export",
  });
  let settled = false;
  let rejectJob: (reason: Error) => void = () => undefined;
  let reportedProgress = 0;
  const abortController = new AbortController();
  const report = (progress: ExportProgress) => {
    reportedProgress = Math.max(reportedProgress, progress.progress);
    options.onProgress({ ...progress, progress: reportedProgress });
  };

  const promise = new Promise<Uint8Array>((resolve, reject) => {
    rejectJob = reject;
    report({ progress: 0.03, message: "正在读取系统字体…" });
    void api.loadExportFont(options.fontFamily, containsCjk(options.source))
      .then(async (payload) => {
        if (settled) return;
        const { metadata, bytes } = unpackFont(payload);
        report({ progress: 0.05, message: `正在使用 ${metadata.family} 计算图表布局…` });
        const diagrams = await preparePdfMermaidDiagrams(options.source, {
          theme: "base",
          themeVariables: mermaidThemeVariables(options.palette),
          layoutFontFamily: metadata.family,
          signal: abortController.signal,
          onProgress: (completed, total) => {
            if (!total || settled) return;
            report({
              progress: 0.05 + 0.06 * completed / total,
              message: `正在矢量化 Mermaid 图表 ${completed}/${total}…`,
            });
          },
        });
        if (settled) return;
        report({
          progress: 0.11,
          message: diagrams.length
            ? `已载入 ${diagrams.length} 个矢量图表，正在使用 ${metadata.family} 排版…`
            : `正在使用 ${metadata.family} 排版…`,
        });
        worker.postMessage({
          type: "generate",
          source: options.source,
          title: options.title,
          mode: options.mode,
          font: metadata,
          fontBytes: bytes.buffer,
          palette: options.palette,
          diagrams,
        }, [bytes.buffer]);
      })
      .catch((error: unknown) => {
        if (settled) return;
        settled = true;
        abortController.abort();
        worker.terminate();
        reject(error instanceof Error ? error : new Error(String(error)));
      });

    worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      if (event.data.type === "progress") {
        report({
          progress: event.data.progress,
          message: event.data.message,
        });
        return;
      }
      settled = true;
      abortController.abort();
      worker.terminate();
      if (event.data.type === "complete") {
        resolve(new Uint8Array(event.data.bytes));
      } else {
        reject(new Error(event.data.message));
      }
    };
    worker.onerror = (event) => {
      if (settled) return;
      settled = true;
      abortController.abort();
      worker.terminate();
      reject(new Error(event.message || "PDF 后台任务异常终止"));
    };
  });

  return {
    promise,
    cancel: () => {
      if (settled) return;
      settled = true;
      abortController.abort();
      worker.terminate();
      rejectJob(new Error("导出已取消"));
    },
  };
}

function mermaidThemeVariables(palette: PdfExportPalette): Record<string, string> {
  return {
    background: palette.surface,
    primaryColor: palette.accentSoft,
    primaryTextColor: palette.text,
    primaryBorderColor: palette.accent,
    secondaryColor: palette.codeSurface,
    secondaryTextColor: palette.text,
    secondaryBorderColor: palette.border,
    tertiaryColor: palette.surface,
    tertiaryTextColor: palette.text,
    tertiaryBorderColor: palette.border,
    lineColor: palette.secondary,
    textColor: palette.text,
    mainBkg: palette.accentSoft,
    nodeBorder: palette.accent,
    clusterBkg: palette.codeSurface,
    clusterBorder: palette.border,
    edgeLabelBackground: palette.surface,
    titleColor: palette.text,
  };
}

function unpackFont(payload: Uint8Array) {
  if (payload.byteLength < 5) throw new Error("系统字体数据不完整");
  const metadataLength = new DataView(
    payload.buffer,
    payload.byteOffset,
    4,
  ).getUint32(0, true);
  const dataOffset = 4 + metadataLength;
  if (metadataLength < 2 || dataOffset >= payload.byteLength) {
    throw new Error("系统字体元数据损坏");
  }
  const metadata = JSON.parse(
    new TextDecoder().decode(payload.subarray(4, dataOffset)),
  ) as ExportFontMetadata;
  const bytes = payload.slice(dataOffset);
  return { metadata, bytes };
}

function containsCjk(value: string) {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(value);
}
