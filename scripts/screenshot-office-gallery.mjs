#!/usr/bin/env node
/** Headless Chrome: open real OOXML and exercise the editing UI. */
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

function looksLikeSource(text) {
  return /<\s*(span|font|div|p)\b|font-weight:|contenteditable|&lt;w:/.test(text);
}

const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: "new",
  args: ["--no-sandbox", "--disable-gpu", `--user-data-dir=/tmp/leafmark-chrome-${Date.now()}`],
});

const page = await browser.newPage();
page.setDefaultTimeout(60_000);
await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
const failures = [];
const pageErrors = [];
page.on("pageerror", (error) => pageErrors.push(String(error)));
page.on("console", (msg) => {
  if (msg.type() === "error") pageErrors.push(msg.text());
});

async function shot(name) {
  await mkdir(outDir, { recursive: true });
  const dest = resolve(outDir, name);
  await page.screenshot({ path: dest, type: "png" });
  console.log("wrote", dest);
}

async function assert(condition, message) {
  if (!condition) {
    failures.push(message);
    console.error("FAIL", message);
  } else {
    console.log("ok", message);
  }
}

try {
  await page.goto(`${base}/office-gallery.html#word`, { waitUntil: "networkidle0" });
  await page.waitForSelector("[data-gallery-ready='1'] [data-office='word']");
  await page.waitForSelector("h1[data-word-block]");
  await assert(!(await page.$("[data-office-error]")), "Word 打开后没有引擎错误条");
  await shot("leafmark-word-edit-idle.png");

  const heading = await page.$("h1[data-word-block]");
  await heading.click();
  await page.keyboard.press("End");
  await page.keyboard.type("【编辑】");
  await page.click(".office-ribbon");
  await page.waitForFunction(() => document.querySelector("h1[data-word-block]")?.innerText.includes("【编辑】"));
  const afterType = await page.$eval("h1[data-word-block]", (el) => ({ text: el.innerText, html: el.innerHTML }));
  await assert(afterType.text.includes("【编辑】"), "改标题后仍能看见【编辑】");
  await assert(!looksLikeSource(afterType.text), `改标题后正文不是源代码（实际：${afterType.text.slice(0, 80)}）`);
  await assert(!(await page.$("[data-office-error]")), "改标题后没有引擎错误条");
  await assert(await page.$eval("[data-dirty]", (el) => el.getAttribute("data-dirty") === "1"), "改标题后标记已修改");
  await shot("leafmark-word-after-type.png");

  const paragraph = await page.$("[data-word-index='1']");
  await paragraph.click();
  await page.click('button[title="粗体"]');
  await page.waitForFunction(() => {
    const node = document.querySelector("[data-word-index='1']");
    const html = node?.innerHTML ?? "";
    return Boolean(node?.querySelector("b,strong,[style*='font-weight']") || /font-weight:\s*700/.test(html));
  }, { timeout: 15_000 });
  await shot("leafmark-word-bold.png");

  await page.click("[data-word-index='1']");
  await page.click('button[title="标题 2"]');
  await page.waitForFunction(() => {
    const node = document.querySelector("[data-word-index='1']");
    return node?.tagName === "H2" && (node.innerText || "").includes("这是一份");
  }, { timeout: 15_000 });
  await shot("leafmark-word-heading.png");

  const insertTab = await page.$(".office-ribbon-tabs button:nth-child(2)");
  await insertTab.click();
  await page.click('button[title="插入表格"]');
  await page.waitForFunction(() => document.querySelectorAll(".word-table-wrap").length >= 2, { timeout: 15_000 });
  await shot("leafmark-word-insert-table.png");

  await page.goto(`${base}/office-gallery.html#ppt`, { waitUntil: "networkidle0" });
  await page.waitForSelector("[data-gallery-ready='1'] [data-office='ppt']");
  await page.waitForSelector(".slide-canvas [data-shape-kind='text']");
  await assert(!(await page.$("[data-office-error]")), "PPT 打开后没有引擎错误条");
  await shot("leafmark-ppt-edit-idle.png");

  const title = await page.$(".slide-canvas [data-shape-kind='text']");
  await title.click({ clickCount: 3 });
  await page.keyboard.type("编辑后的封面标题");
  await page.click(".slide-notes textarea");
  await page.waitForFunction(() => document.querySelector(".slide-canvas [data-shape-kind='text']")?.innerText.includes("编辑后的封面标题"), { timeout: 15_000 });
  const pptText = await page.$eval(".slide-canvas [data-shape-kind='text']", (el) => el.innerText);
  await assert(pptText.includes("编辑后的封面标题"), "改 PPT 标题后仍能看见新文字");
  await assert(!looksLikeSource(pptText), `改 PPT 标题后不是源代码（实际：${pptText.slice(0, 80)}）`);
  await shot("leafmark-ppt-after-type.png");

  await page.click(".slide-canvas [data-shape-kind='text']");
  await page.click('button[title="加粗"]');
  await page.waitForFunction(() => {
    const node = document.querySelector(".slide-canvas [data-shape-kind='text']");
    return node && (node.style.fontWeight === "700" || Number(node.style.fontWeight) >= 700);
  }, { timeout: 15_000 });
  await shot("leafmark-ppt-bold.png");

  const slideButtons = await page.$$(".slide-list button");
  await slideButtons[1].click();
  await page.waitForSelector(".slide-canvas [data-shape-kind='table']");
  await shot("leafmark-ppt-edit-slide2.png");

  await page.click('button[title="文本框"]');
  await page.waitForFunction(() => [...document.querySelectorAll(".slide-canvas [data-shape-kind='text']")].some((el) => el.innerText.includes("文本框")), { timeout: 15_000 });
  await shot("leafmark-ppt-add-textbox.png");

  const engineError = await page.$eval("[data-office-error]", (el) => el.textContent).catch(() => "");
  await assert(!engineError, `编辑过程中没有引擎错误条（实际：${engineError}）`);
  const leaked = pageErrors.filter((item) => /文档缓存已释放|Office 引擎|Worker/.test(item));
  await assert(leaked.length === 0, `控制台没有 Office 引擎错误（实际：${leaked.join(" | ")}）`);
} catch (reason) {
  failures.push(reason instanceof Error ? reason.message : String(reason));
  try { await shot("leafmark-edit-failed.png"); } catch { /* ignore */ }
  console.error(reason);
} finally {
  await browser.close();
}

if (failures.length) {
  console.error(`\n${failures.length} visual edit checks failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log("visual edit checks passed");
