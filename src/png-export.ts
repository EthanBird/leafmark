import { toSvg } from "html-to-image";
import type { ExportProgress } from "./pdf-export";

export interface PngExportJob {
  promise: Promise<Uint8Array>;
  cancel: () => void;
}

interface EncoderMessage {
  type: "ready" | "ack" | "progress" | "complete" | "error";
  index?: number;
  bytes?: ArrayBuffer;
  message?: string;
  progress?: number;
}

export function startPngExport(
  root: HTMLElement,
  onProgress: (progress: ExportProgress) => void,
): PngExportJob {
  const worker = new Worker(new URL("./png-export.worker.ts", import.meta.url), {
    type: "module",
    name: "leafmark-png-export",
  });
  let cancelled = false;
  let rejectCancel: (reason: Error) => void = () => undefined;
  const cancelPromise = new Promise<never>((_, reject) => {
    rejectCancel = reject;
  });
  const work = renderPng(root, worker, onProgress, () => cancelled)
    .finally(() => worker.terminate());

  return {
    promise: Promise.race([work, cancelPromise]),
    cancel: () => {
      if (cancelled) return;
      cancelled = true;
      worker.terminate();
      rejectCancel(new Error("导出已取消"));
    },
  };
}

async function renderPng(
  root: HTMLElement,
  worker: Worker,
  onProgress: (progress: ExportProgress) => void,
  isCancelled: () => boolean,
) {
  const cssWidth = Math.ceil(root.scrollWidth);
  const cssHeight = Math.ceil(root.scrollHeight);
  const pixelRatio = cssHeight > 20_000 ? 2 : 2.5;
  const pixelWidth = Math.ceil(cssWidth * pixelRatio);
  const pixelHeight = Math.ceil(cssHeight * pixelRatio);
  if (pixelWidth > 12_000 || pixelHeight > 1_000_000) {
    throw new Error("文档尺寸超过 PNG 安全上限，请改用矢量 PDF");
  }
  if (isCancelled()) throw new Error("导出已取消");
  onProgress({ progress: 0.48, message: "正在一次性序列化导出页面…" });
  await nextFrame();
  const svgDataUrl = await toSvg(root, {
    cacheBust: true,
    width: cssWidth,
    height: cssHeight,
    backgroundColor: getComputedStyle(document.documentElement)
      .getPropertyValue("--surface")
      .trim() || "#ffffff",
  });
  if (isCancelled()) throw new Error("导出已取消");

  const waitFor = createWorkerWaiter(worker, onProgress);
  const completePromise = waitFor("complete");
  worker.postMessage({
    type: "renderSvg",
    svgDataUrl,
    width: cssWidth,
    height: cssHeight,
    pixelRatio,
    tileCssHeight: Math.max(320, Math.floor(2_400 / pixelRatio)),
  });
  const complete = await completePromise;
  if (!complete.bytes) throw new Error("PNG 编码器没有返回文件");
  return new Uint8Array(complete.bytes);
}

function createWorkerWaiter(
  worker: Worker,
  onProgress: (progress: ExportProgress) => void,
) {
  const waiting: Array<{
    type: EncoderMessage["type"];
    index?: number;
    resolve: (message: EncoderMessage) => void;
    reject: (error: Error) => void;
  }> = [];
  worker.onmessage = (event: MessageEvent<EncoderMessage>) => {
    if (event.data.type === "progress") {
      onProgress({
        progress: event.data.progress ?? 0.5,
        message: event.data.message || "正在后台生成 PNG…",
      });
      return;
    }
    if (event.data.type === "error") {
      const error = new Error(event.data.message || "PNG 后台编码失败");
      waiting.splice(0).forEach((item) => item.reject(error));
      return;
    }
    const position = waiting.findIndex((item) => (
      item.type === event.data.type
      && (item.index === undefined || item.index === event.data.index)
    ));
    if (position >= 0) waiting.splice(position, 1)[0].resolve(event.data);
  };
  worker.onerror = (event) => {
    const error = new Error(event.message || "PNG 后台任务异常终止");
    waiting.splice(0).forEach((item) => item.reject(error));
  };
  return (type: EncoderMessage["type"], index?: number) => (
    new Promise<EncoderMessage>((resolve, reject) => {
      waiting.push({ type, index, resolve, reject });
    })
  );
}

function nextFrame() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}
