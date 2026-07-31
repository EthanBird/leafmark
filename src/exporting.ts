import { toCanvas } from "html-to-image";

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

export async function renderExportCanvas(root: HTMLElement) {
  const width = Math.ceil(root.scrollWidth);
  const height = Math.ceil(root.scrollHeight);
  return toCanvas(root, {
    backgroundColor: getComputedStyle(document.documentElement).getPropertyValue("--surface").trim() || "#ffffff",
    cacheBust: true,
    pixelRatio: 2,
    width,
    height,
    canvasWidth: width * 2,
    canvasHeight: height * 2,
    style: {
      height: `${height}px`,
      position: "static",
      left: "auto",
      top: "auto",
      zIndex: "auto",
      maxHeight: "none",
      overflow: "visible",
    },
  });
}

export function canvasToPngBytes(canvas: HTMLCanvasElement) {
  return dataUrlToBytes(canvas.toDataURL("image/png"));
}

export async function canvasToLongPdfBytes(canvas: HTMLCanvasElement) {
  const { jsPDF } = await import("jspdf");
  const pageWidth = 595.28;
  const unclampedHeight = canvas.height * pageWidth / canvas.width;
  const pageHeight = Math.min(14_400, Math.max(72, unclampedHeight));
  const pdf = new jsPDF({
    orientation: pageHeight >= pageWidth ? "portrait" : "landscape",
    unit: "pt",
    format: [pageWidth, pageHeight],
    compress: true,
  });
  pdf.addImage(canvas, "PNG", 0, 0, pageWidth, pageHeight, undefined, "FAST");
  return new Uint8Array(pdf.output("arraybuffer"));
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

export async function canvasToPagedPdfBytes(canvas: HTMLCanvasElement) {
  const { jsPDF } = await import("jspdf");
  const pageWidth = 595.28;
  const pageHeight = 841.89;
  const margin = 32;
  const printableWidth = pageWidth - margin * 2;
  const slices = calculatePdfSlices(canvas.width, canvas.height, pageWidth, pageHeight, margin);
  const pdf = new jsPDF({ orientation: "portrait", unit: "pt", format: "a4", compress: true });

  slices.forEach((slice, index) => {
    if (index > 0) pdf.addPage("a4", "portrait");
    const piece = document.createElement("canvas");
    piece.width = canvas.width;
    piece.height = Math.ceil(slice.sourceHeight);
    const context = piece.getContext("2d");
    if (!context) throw new Error("浏览器无法创建 PDF 画布");
    context.drawImage(
      canvas,
      0,
      slice.sourceY,
      canvas.width,
      slice.sourceHeight,
      0,
      0,
      piece.width,
      piece.height,
    );
    const renderedHeight = piece.height * printableWidth / piece.width;
    pdf.addImage(piece, "PNG", margin, margin, printableWidth, renderedHeight, undefined, "FAST");
  });
  return new Uint8Array(pdf.output("arraybuffer"));
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

function dataUrlToBytes(value: string) {
  const base64 = value.slice(value.indexOf(",") + 1);
  const binary = atob(base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
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
