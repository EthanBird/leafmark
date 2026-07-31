/// <reference lib="webworker" />

import { Zlib } from "fflate";
import { cropSvg, decodeSvgDataUrl } from "./png-export-utils";

type IncomingMessage =
  | { type: "init"; width: number; height: number }
  | { type: "tile"; pixels: ArrayBuffer; width: number; height: number; index: number }
  | { type: "finish" }
  | {
    type: "renderSvg";
    svgDataUrl: string;
    width: number;
    height: number;
    pixelRatio: number;
    tileCssHeight: number;
  };

const workerScope = self as unknown as DedicatedWorkerGlobalScope;
let pngWidth = 0;
let pngHeight = 0;
let compressor: Zlib | null = null;
let compressedChunks: Uint8Array[] = [];

workerScope.onmessage = (event: MessageEvent<IncomingMessage>) => {
  try {
    if (event.data.type === "renderSvg") {
      void renderSvg(event.data).catch(reportError);
      return;
    }
    if (event.data.type === "init") {
      initializeEncoder(event.data.width, event.data.height);
      workerScope.postMessage({ type: "ready" });
      return;
    }
    if (event.data.type === "tile") {
      pushTilePixels(
        new Uint8Array(event.data.pixels),
        event.data.width,
        event.data.height,
      );
      workerScope.postMessage({ type: "ack", index: event.data.index });
      return;
    }
    finishEncoder();
  } catch (error) {
    reportError(error);
  }
};

async function renderSvg(message: Extract<IncomingMessage, { type: "renderSvg" }>) {
  if (
    typeof OffscreenCanvas === "undefined"
    || typeof createImageBitmap === "undefined"
  ) {
    throw new Error("当前 WebView2 不支持后台画布，请更新 Microsoft Edge WebView2 Runtime");
  }
  const svg = decodeSvgDataUrl(message.svgDataUrl);
  const pixelWidth = Math.ceil(message.width * message.pixelRatio);
  const pixelHeight = Math.ceil(message.height * message.pixelRatio);
  const tiles = Math.ceil(message.height / message.tileCssHeight);
  initializeEncoder(pixelWidth, pixelHeight);

  for (let index = 0; index < tiles; index += 1) {
    const sourceY = index * message.tileCssHeight;
    const sliceHeight = Math.min(message.tileCssHeight, message.height - sourceY);
    const tilePixelHeight = index === tiles - 1
      ? pixelHeight - Math.round(sourceY * message.pixelRatio)
      : Math.round(sliceHeight * message.pixelRatio);
    workerScope.postMessage({
      type: "progress",
      progress: 0.54 + 0.35 * index / Math.max(1, tiles),
      message: `正在后台绘制高清分片 ${index + 1}/${tiles}…`,
    });
    const tileSvg = cropSvg(
      svg,
      message.width,
      message.height,
      sourceY,
      sliceHeight,
      pixelWidth,
      tilePixelHeight,
    );
    const bitmap = await createImageBitmap(
      new Blob([tileSvg], { type: "image/svg+xml;charset=utf-8" }),
    );
    try {
      const canvas = new OffscreenCanvas(pixelWidth, tilePixelHeight);
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) throw new Error("后台画布初始化失败");
      context.drawImage(bitmap, 0, 0, pixelWidth, tilePixelHeight);
      const image = context.getImageData(0, 0, pixelWidth, tilePixelHeight);
      pushTilePixels(image.data, pixelWidth, tilePixelHeight);
    } finally {
      bitmap.close();
    }
  }
  workerScope.postMessage({
    type: "progress",
    progress: 0.91,
    message: "正在后台压缩无损 PNG…",
  });
  finishEncoder();
}

function initializeEncoder(width: number, height: number) {
  pngWidth = width;
  pngHeight = height;
  compressedChunks = [];
  compressor = new Zlib({ level: 5 }, (chunk) => {
    if (chunk.length) compressedChunks.push(chunk);
  });
}

function pushTilePixels(
  pixels: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
) {
  if (!compressor) throw new Error("PNG 编码器尚未初始化");
  if (width !== pngWidth) throw new Error("PNG 分片宽度不一致");
  const rowBytes = pngWidth * 4;
  const filtered = new Uint8Array((rowBytes + 1) * height);
  const useSubFilter = pngWidth * pngHeight <= 50_000_000;
  for (let row = 0; row < height; row += 1) {
    const sourceOffset = row * rowBytes;
    const targetOffset = row * (rowBytes + 1);
    filtered[targetOffset] = useSubFilter ? 1 : 0;
    filtered.set(
      pixels.subarray(sourceOffset, sourceOffset + rowBytes),
      targetOffset + 1,
    );
    if (!useSubFilter) continue;
    for (let column = rowBytes - 1; column >= 4; column -= 1) {
      filtered[targetOffset + 1 + column] =
        (pixels[sourceOffset + column] - pixels[sourceOffset + column - 4] + 256)
        & 0xff;
    }
  }
  compressor.push(filtered, false);
}

function finishEncoder() {
  if (!compressor) throw new Error("PNG 编码器尚未初始化");
  compressor.push(new Uint8Array(), true);
  const parts = [
    PNG_SIGNATURE,
    pngChunk("IHDR", imageHeader(pngWidth, pngHeight)),
    ...compressedChunks.map((chunk) => pngChunk("IDAT", chunk)),
    pngChunk("IEND", new Uint8Array()),
  ];
  const bytes = concatenate(parts);
  const payload = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  workerScope.postMessage({ type: "complete", bytes: payload }, [payload]);
  compressor = null;
  compressedChunks = [];
}

function reportError(error: unknown) {
  compressor = null;
  compressedChunks = [];
  workerScope.postMessage({
    type: "error",
    message: error instanceof Error ? error.message : String(error),
  });
}

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

function imageHeader(width: number, height: number) {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8;
  header[9] = 6;
  return header;
}

function pngChunk(type: string, data: Uint8Array) {
  const typeBytes = new TextEncoder().encode(type);
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  chunk.set(typeBytes, 4);
  chunk.set(data, 8);
  view.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));
  return chunk;
}

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function concatenate(parts: Uint8Array[]) {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

export {};
