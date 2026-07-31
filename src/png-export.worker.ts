/// <reference lib="webworker" />

import { Zlib } from "fflate";

type IncomingMessage =
  | { type: "init"; width: number; height: number }
  | { type: "tile"; pixels: ArrayBuffer; width: number; height: number; index: number }
  | { type: "finish" };

const workerScope = self as unknown as DedicatedWorkerGlobalScope;
let pngWidth = 0;
let pngHeight = 0;
let compressor: Zlib | null = null;
let compressedChunks: Uint8Array[] = [];

workerScope.onmessage = (event: MessageEvent<IncomingMessage>) => {
  try {
    if (event.data.type === "init") {
      pngWidth = event.data.width;
      pngHeight = event.data.height;
      compressedChunks = [];
      compressor = new Zlib({ level: 7 }, (chunk) => {
        if (chunk.length) compressedChunks.push(chunk);
      });
      workerScope.postMessage({ type: "ready" });
      return;
    }
    if (event.data.type === "tile") {
      if (!compressor) throw new Error("PNG 编码器尚未初始化");
      if (event.data.width !== pngWidth) throw new Error("PNG 分片宽度不一致");
      const pixels = new Uint8Array(event.data.pixels);
      const rowBytes = pngWidth * 4;
      const filtered = new Uint8Array((rowBytes + 1) * event.data.height);
      for (let row = 0; row < event.data.height; row += 1) {
        const sourceOffset = row * rowBytes;
        const targetOffset = row * (rowBytes + 1);
        filtered[targetOffset] = 1;
        for (let column = 0; column < rowBytes; column += 1) {
          const left = column >= 4 ? pixels[sourceOffset + column - 4] : 0;
          filtered[targetOffset + 1 + column] =
            (pixels[sourceOffset + column] - left + 256) & 0xff;
        }
      }
      compressor.push(filtered, false);
      workerScope.postMessage({ type: "ack", index: event.data.index });
      return;
    }
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
  } catch (error) {
    workerScope.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
};

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
