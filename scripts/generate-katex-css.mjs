import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = resolve(root, "node_modules/katex/dist/katex.min.css");
const targetPath = resolve(root, "src/generated/katex-woff2.css");
const source = await readFile(sourcePath, "utf8");
const optimized = source.replace(
  /(src:url\([^)]*\.woff2\) format\("woff2"\)),url\([^)]*\.woff\) format\("woff"\),url\([^)]*\.ttf\) format\("truetype"\)/g,
  "$1",
).replaceAll("url(fonts/", "url(../../node_modules/katex/dist/fonts/");
await mkdir(dirname(targetPath), { recursive: true });
await writeFile(targetPath, optimized, "utf8");
