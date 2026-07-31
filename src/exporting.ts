export type ExportFormat = "markdown" | "html" | "png" | "pdf-long" | "pdf-pages";

const CSS_VARIABLES = [
  "--surface",
  "--surface-muted",
  "--surface-raised",
  "--text",
  "--text-secondary",
  "--text-tertiary",
  "--border",
  "--border-subtle",
  "--accent",
  "--accent-strong",
  "--accent-soft",
  "--reader-font-family",
  "--reader-font-size",
  "--reader-line-height",
  "--mono",
];

export function exportExtension(format: ExportFormat) {
  if (format === "markdown") return "md";
  if (format === "html") return "html";
  if (format === "png") return "png";
  return "pdf";
}

export async function inlineExportImages(root: HTMLElement) {
  const images = Array.from(root.querySelectorAll("img"));
  await Promise.all(images.map(async (image) => {
    const source = image.currentSrc || image.src;
    if (!source || source.startsWith("data:")) return;
    try {
      const response = await fetch(source);
      if (!response.ok) return;
      image.src = await blobToDataUrl(await response.blob());
    } catch {
      // Leave unreachable images unchanged; the rest of the document can still export.
    }
  }));
}

export function buildStandaloneHtml(root: HTMLElement, title: string) {
  const computed = getComputedStyle(document.documentElement);
  const variables = CSS_VARIABLES
    .map((name) => `${name}:${computed.getPropertyValue(name).trim()};`)
    .join("");
  const css = readDocumentStyles();
  const body = root.cloneNode(true) as HTMLElement;
  body.removeAttribute("contenteditable");
  body.classList.remove("live-editor", "export-document");
  body.querySelectorAll("[contenteditable]").forEach((node) => node.removeAttribute("contenteditable"));
  return `<!doctype html>
<html lang="${navigator.language || "zh-CN"}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${css}
:root{${variables}}html,body{margin:0;overflow:visible;background:var(--surface);color:var(--text)}body>.markdown-body{height:auto;min-height:100vh;overflow:visible}</style>
</head>
<body>${body.outerHTML}</body>
</html>`;
}

export interface PdfSlice {
  sourceY: number;
  sourceHeight: number;
}

export function calculatePdfSlices(
  canvasWidth: number,
  canvasHeight: number,
  pageWidth = 595.28,
  pageHeight = 841.89,
  margin = 32,
): PdfSlice[] {
  const printableWidth = pageWidth - margin * 2;
  const printableHeight = pageHeight - margin * 2;
  const sourceHeightPerPage = printableHeight * canvasWidth / printableWidth;
  const slices: PdfSlice[] = [];
  for (let sourceY = 0; sourceY < canvasHeight; sourceY += sourceHeightPerPage) {
    slices.push({ sourceY, sourceHeight: Math.min(sourceHeightPerPage, canvasHeight - sourceY) });
  }
  return slices;
}

function readDocumentStyles() {
  const rules: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      rules.push(...Array.from(sheet.cssRules).map((rule) => rule.cssText));
    } catch {
      // Cross-origin styles cannot be read; LeafMark's bundled styles are same-origin.
    }
  }
  return rules.join("\n");
}

function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}
