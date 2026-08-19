#!/usr/bin/env node
/** Headless Chrome screenshots of the real OOXML gallery. */
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = process.env.OFFICE_SCREENSHOT_DIR || "/opt/cursor/artifacts/screenshots";
const base = process.env.OFFICE_GALLERY_URL || "http://127.0.0.1:1420";
const chrome = process.env.CHROME_PATH || "/usr/local/bin/google-chrome";

const require = createRequire(import.meta.url);
let puppeteer;
try {
  puppeteer = require(resolve(root, "node_modules/puppeteer-core"));
} catch {
  try {
    puppeteer = require("puppeteer-core");
  } catch {
    console.error("需要 puppeteer-core：npm install --no-save puppeteer-core");
    process.exit(1);
  }
}

const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: "new",
  args: ["--no-sandbox", "--disable-gpu", `--user-data-dir=/tmp/leafmark-chrome-${Date.now()}`],
});

async function shot(hash, name, selector = "[data-gallery]") {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 1600, deviceScaleFactor: 1 });
  await page.goto(`${base}/office-gallery.html${hash}`, { waitUntil: "networkidle0", timeout: 60_000 });
  await page.waitForSelector("[data-gallery-ready='1']", { timeout: 60_000 });
  await page.waitForSelector(selector, { timeout: 60_000 });
  const target = await page.$(selector);
  const clip = target
    ? await target.screenshot({ type: "png" })
    : await page.screenshot({ type: "png", fullPage: true });
  await mkdir(outDir, { recursive: true });
  const dest = resolve(outDir, name);
  await writeFile(dest, clip);
  console.log("wrote", dest, clip.length, "bytes");
  await page.close();
}

try {
  await shot("#word", "leafmark-word.png");
  await shot("#ppt", "leafmark-ppt.png");
  await shot("#ppt", "leafmark-ppt-cover.png", "[data-slide='0'] .slide-canvas");
  await shot("#ppt", "leafmark-ppt-table.png", "[data-slide='1'] .slide-canvas");
  await shot("#ppt", "leafmark-ppt-layout.png", "[data-slide='2'] .slide-canvas");
} finally {
  await browser.close();
}
