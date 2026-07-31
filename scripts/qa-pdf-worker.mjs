import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [, , sourcePath, fontPath, outputPath, mode = "pages"] = process.argv;
if (!sourcePath || !fontPath || !outputPath) {
  throw new Error("用法：node scripts/qa-pdf-worker.mjs <markdown> <font> <output.pdf> [pages|long]");
}

const assetsDirectory = resolve("dist/assets");
const workerName = (await readdir(assetsDirectory))
  .find((name) => /^pdf-export\.worker-.*\.js$/.test(name));
if (!workerName) throw new Error("请先运行 npm run build");

globalThis.self = globalThis;
globalThis.btoa ??= (value) => Buffer.from(value, "binary").toString("base64");

const complete = new Promise((resolveJob, rejectJob) => {
  globalThis.postMessage = (message) => {
    if (message.type === "progress") {
      process.stderr.write(`${Math.round(message.progress * 100)}% ${message.message}\n`);
    } else if (message.type === "complete") {
      void writeFile(outputPath, new Uint8Array(message.bytes))
        .then(resolveJob, rejectJob);
    } else if (message.type === "error") {
      rejectJob(new Error(message.message));
    }
  };
});

await import(pathToFileURL(resolve(assetsDirectory, workerName)).href);
const source = await readFile(sourcePath, "utf8");
const font = await readFile(fontPath);
const fontBytes = font.buffer.slice(font.byteOffset, font.byteOffset + font.byteLength);
globalThis.onmessage({
  data: {
    type: "generate",
    source,
    title: sourcePath.split(/[\\/]/).at(-1).replace(/\.(md|markdown)$/i, ""),
    mode,
    font: {
      family: "Noto Sans CJK SC",
      postscriptName: "NotoSansCJKsc-Regular",
      collection: false,
    },
    fontBytes,
    palette: {
      text: "#1d2922",
      secondary: "#627068",
      accent: "#297a4a",
      accentSoft: "#e8f3ec",
      border: "#d8e2dc",
      surface: "#ffffff",
      codeSurface: "#f3f7f4",
    },
  },
});
await complete;
