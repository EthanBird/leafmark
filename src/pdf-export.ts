import { api } from "./api";

export type PdfExportMode = "long" | "pages";

export interface ExportProgress {
  progress: number;
  message: string;
}

export interface PdfExportOptions {
  source: string;
  title: string;
  mode: PdfExportMode;
  fontFamily: string;
  palette: {
    text: string;
    secondary: string;
    accent: string;
    accentSoft: string;
    border: string;
    surface: string;
    codeSurface: string;
  };
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

  const promise = new Promise<Uint8Array>((resolve, reject) => {
    rejectJob = reject;
    options.onProgress({ progress: 0.03, message: "正在读取系统字体…" });
    void api.loadExportFont(options.fontFamily, containsCjk(options.source))
      .then((payload) => {
        if (settled) return;
        const { metadata, bytes } = unpackFont(payload);
        options.onProgress({
          progress: 0.08,
          message: `正在使用 ${metadata.family} 排版…`,
        });
        worker.postMessage({
          type: "generate",
          source: options.source,
          title: options.title,
          mode: options.mode,
          font: metadata,
          fontBytes: bytes.buffer,
          palette: options.palette,
        }, [bytes.buffer]);
      })
      .catch((error: unknown) => {
        if (settled) return;
        settled = true;
        worker.terminate();
        reject(error instanceof Error ? error : new Error(String(error)));
      });

    worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      if (event.data.type === "progress") {
        options.onProgress({
          progress: event.data.progress,
          message: event.data.message,
        });
        return;
      }
      settled = true;
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
      worker.terminate();
      reject(new Error(event.message || "PDF 后台任务异常终止"));
    };
  });

  return {
    promise,
    cancel: () => {
      if (settled) return;
      settled = true;
      worker.terminate();
      rejectJob(new Error("导出已取消"));
    },
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
