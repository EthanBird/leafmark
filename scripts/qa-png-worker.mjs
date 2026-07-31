import { readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const outputPath = process.argv[2] || "/tmp/leafmark-png-worker.png";
const assetsDirectory = resolve("dist/assets");
const workerName = (await readdir(assetsDirectory))
  .find((name) => /^png-export\.worker-.*\.js$/.test(name));
if (!workerName) throw new Error("请先运行 npm run build");

globalThis.self = globalThis;
let resolveMessage;
let nextMessage = new Promise((resolve) => { resolveMessage = resolve; });
globalThis.postMessage = (message) => resolveMessage(message);
await import(pathToFileURL(resolve(assetsDirectory, workerName)).href);

const receive = async () => {
  const message = await nextMessage;
  nextMessage = new Promise((resolve) => { resolveMessage = resolve; });
  if (message.type === "error") throw new Error(message.message);
  return message;
};

const width = 360;
const tileHeight = 240;
const tiles = 3;
globalThis.onmessage({ data: { type: "init", width, height: tileHeight * tiles } });
await receive();
for (let tile = 0; tile < tiles; tile += 1) {
  const pixels = new Uint8Array(width * tileHeight * 4);
  for (let index = 0; index < pixels.length; index += 4) {
    const x = index / 4 % width;
    const y = Math.floor(index / 4 / width) + tile * tileHeight;
    pixels[index] = Math.round(255 * x / width);
    pixels[index + 1] = Math.round(255 * y / (tileHeight * tiles));
    pixels[index + 2] = 120;
    pixels[index + 3] = 255;
  }
  globalThis.onmessage({
    data: {
      type: "tile",
      pixels: pixels.buffer,
      width,
      height: tileHeight,
      index: tile,
    },
  });
  await receive();
}
globalThis.onmessage({ data: { type: "finish" } });
const complete = await receive();
await writeFile(outputPath, new Uint8Array(complete.bytes));
