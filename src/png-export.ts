import { toCanvas } from "html-to-image";
import type { ExportProgress } from "./pdf-export";

export interface PngExportJob {
  promise: Promise<Uint8Array>;
  cancel: () => void;
}

interface EncoderMessage {
  type: "ready" | "ack" | "complete" | "error";
  index?: number;
  bytes?: ArrayBuffer;
  message?: string;
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
  const pixelRatio = 2.5;
  const pixelWidth = Math.ceil(cssWidth * pixelRatio);
  const pixelHeight = Math.ceil(cssHeight * pixelRatio);
  if (pixelWidth > 12_000 || pixelHeight > 1_000_000) {
    throw new Error("文档尺寸超过 PNG 安全上限，请改用矢量 PDF");
  }
  const tileCssHeight = Math.max(320, Math.floor(2_400 / pixelRatio));
  const tiles = Math.ceil(cssHeight / tileCssHeight);
  const waitFor = createWorkerWaiter(worker);
  worker.postMessage({ type: "init", width: pixelWidth, height: pixelHeight });
  await waitFor("ready");

  for (let index = 0; index < tiles; index += 1) {
    if (isCancelled()) throw new Error("导出已取消");
    const sourceY = index * tileCssHeight;
    const sliceHeight = Math.min(tileCssHeight, cssHeight - sourceY);
    onProgress({
      progress: 0.48 + 0.4 * index / Math.max(1, tiles),
      message: `正在绘制高清分片 ${index + 1}/${tiles}…`,
    });
    const canvas = await renderTile(root, cssWidth, sourceY, sliceHeight, pixelRatio);
    if (isCancelled()) throw new Error("导出已取消");
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("浏览器无法读取 PNG 画布");
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    worker.postMessage({
      type: "tile",
      pixels: image.data.buffer,
      width: canvas.width,
      height: canvas.height,
      index,
    }, [image.data.buffer]);
    await waitFor("ack", index);
    canvas.width = 1;
    canvas.height = 1;
    await nextFrame();
  }

  onProgress({ progress: 0.9, message: "正在后台压缩无损 PNG…" });
  worker.postMessage({ type: "finish" });
  const complete = await waitFor("complete");
  if (!complete.bytes) throw new Error("PNG 编码器没有返回文件");
  return new Uint8Array(complete.bytes);
}

async function renderTile(
  root: HTMLElement,
  width: number,
  sourceY: number,
  height: number,
  pixelRatio: number,
) {
  const frame = document.createElement("div");
  const clone = root.cloneNode(true) as HTMLElement;
  frame.className = "export-tile-frame";
  frame.style.width = `${width}px`;
  frame.style.height = `${height}px`;
  frame.style.overflow = "hidden";
  frame.style.background = getComputedStyle(document.documentElement)
    .getPropertyValue("--surface")
    .trim() || "#ffffff";
  clone.classList.remove("export-document", "live-editor");
  clone.removeAttribute("contenteditable");
  clone.style.setProperty("position", "relative", "important");
  clone.style.setProperty("left", "0", "important");
  clone.style.setProperty("top", "0", "important");
  clone.style.setProperty("z-index", "auto", "important");
  clone.style.setProperty("transform", `translateY(-${sourceY}px)`, "important");
  clone.style.setProperty("max-height", "none", "important");
  clone.style.setProperty("overflow", "visible", "important");
  frame.append(clone);
  document.body.append(frame);
  try {
    return await toCanvas(frame, {
      cacheBust: true,
      pixelRatio,
      width,
      height,
      canvasWidth: Math.ceil(width * pixelRatio),
      canvasHeight: Math.ceil(height * pixelRatio),
      backgroundColor: frame.style.background,
    });
  } finally {
    frame.remove();
  }
}

function createWorkerWaiter(worker: Worker) {
  const waiting: Array<{
    type: EncoderMessage["type"];
    index?: number;
    resolve: (message: EncoderMessage) => void;
    reject: (error: Error) => void;
  }> = [];
  worker.onmessage = (event: MessageEvent<EncoderMessage>) => {
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
