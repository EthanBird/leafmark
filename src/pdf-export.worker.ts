/// <reference lib="webworker" />

import { marked } from "marked";
import pdfMake from "pdfmake/build/pdfmake";
import type {
  Content,
  ContentStack,
  StyleDictionary,
  TDocumentDefinitions,
  TFontDictionary,
} from "pdfmake/interfaces";
import { mathjax } from "mathjax-full/js/mathjax.js";
import { TeX } from "mathjax-full/js/input/tex.js";
import { SVG } from "mathjax-full/js/output/svg.js";
import { liteAdaptor } from "mathjax-full/js/adaptors/liteAdaptor.js";
import { RegisterHTMLHandler } from "mathjax-full/js/handlers/html.js";
import { AllPackages } from "mathjax-full/js/input/tex/AllPackages.js";

interface GenerateMessage {
  type: "generate";
  source: string;
  title: string;
  mode: "long" | "pages";
  font: {
    family: string;
    postscriptName: string;
    collection: boolean;
  };
  fontBytes: ArrayBuffer;
  palette: Palette;
}

interface Palette {
  text: string;
  secondary: string;
  accent: string;
  accentSoft: string;
  border: string;
  surface: string;
  codeSurface: string;
}

interface MathSvg {
  svg: string;
  width: number;
}

const workerScope = self as unknown as DedicatedWorkerGlobalScope;
const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);
const texInput = new TeX({ packages: AllPackages });
const svgOutput = new SVG({ fontCache: "none" });
const mathDocument = mathjax.document("", {
  InputJax: texInput,
  OutputJax: svgOutput,
});

workerScope.onmessage = (event: MessageEvent<GenerateMessage>) => {
  if (event.data.type !== "generate") return;
  void generatePdf(event.data).catch((error: unknown) => {
    post({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  });
};

async function generatePdf(message: GenerateMessage) {
  post({ type: "progress", progress: 0.12, message: "正在分析 Markdown 结构…" });
  const tokens = marked.lexer(message.source, { gfm: true });
  const mathTotal = tokens.reduce((count, token) => count + countMath(token), 0);
  let mathDone = 0;
  const content = renderBlocks(tokens as TokenLike[], message.palette, () => {
    mathDone += 1;
    if (mathDone === 1 || mathDone % 12 === 0 || mathDone === mathTotal) {
      post({
        type: "progress",
        progress: 0.15 + 0.45 * mathDone / Math.max(1, mathTotal),
        message: `正在矢量化公式 ${mathDone}/${mathTotal}…`,
      });
    }
  });
  post({ type: "progress", progress: 0.63, message: "正在进行文字分页与表格排版…" });

  const fontFile = message.font.collection ? "LeafMark.ttc" : "LeafMark.ttf";
  const fontValue: string | [string, string] = message.font.collection
    ? [fontFile, message.font.postscriptName]
    : fontFile;
  const fonts = {
    LeafMark: {
      normal: fontValue,
      bold: fontValue,
      italics: fontValue,
      bolditalics: fontValue,
    },
  } as unknown as TFontDictionary;
  const vfs = {
    [fontFile]: bytesToBase64(new Uint8Array(message.fontBytes)),
  };
  const definition = buildDefinition(
    message.title,
    message.mode,
    content,
    message.palette,
  );

  const pdf = pdfMake.createPdf(
    definition,
    undefined,
    fonts,
    vfs,
  );
  const buffer = await new Promise<Uint8Array>((resolve) => {
    pdf.getBuffer((value) => resolve(new Uint8Array(value)));
  });
  post({ type: "progress", progress: 0.96, message: "正在压缩并写入 PDF…" });
  const bytes = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;
  workerScope.postMessage({ type: "complete", bytes }, [bytes]);
}

function buildDefinition(
  title: string,
  mode: "long" | "pages",
  content: Content[],
  palette: Palette,
): TDocumentDefinitions {
  const definition: TDocumentDefinitions = {
    info: {
      title,
      creator: "LeafMark / 一叶",
      producer: "LeafMark semantic PDF engine",
    },
    compress: true,
    pageSize: mode === "long"
      ? { width: 595.28, height: 14_000 }
      : "A4",
    pageMargins: mode === "long"
      ? [54, 58, 54, 58]
      : [54, 66, 54, 62],
    content,
    defaultStyle: {
      font: "LeafMark",
      fontSize: 10.5,
      lineHeight: 1.55,
      color: palette.text,
    },
    styles: buildStyles(palette),
    pageBreakBefore: (currentNode, followingNodesOnPage) => (
      Boolean(currentNode.headlineLevel)
      && followingNodesOnPage.length === 0
    ),
  };
  if (mode === "pages") {
    definition.header = (page) => ({
      columns: [
        { text: title, color: palette.secondary, fontSize: 8.5 },
        { text: "LEAFMARK", color: palette.accent, fontSize: 7.5, alignment: "right", characterSpacing: 1.4 },
      ],
      margin: [54, 28, 54, 0],
    });
    definition.footer = (page, pages) => ({
      text: `${page} / ${pages}`,
      alignment: "center",
      color: palette.secondary,
      fontSize: 8,
      margin: [0, 18, 0, 0],
    });
  }
  return definition;
}

function buildStyles(palette: Palette): StyleDictionary {
  return {
    h1: {
      fontSize: 25,
      lineHeight: 1.18,
      bold: true,
      color: palette.accent,
      margin: [0, 0, 0, 18],
    },
    h2: {
      fontSize: 18,
      lineHeight: 1.25,
      bold: true,
      color: palette.text,
      margin: [0, 17, 0, 10],
    },
    h3: {
      fontSize: 14.5,
      lineHeight: 1.3,
      bold: true,
      color: palette.accent,
      margin: [0, 13, 0, 7],
    },
    h4: {
      fontSize: 12,
      lineHeight: 1.35,
      bold: true,
      color: palette.text,
      margin: [0, 10, 0, 5],
    },
    paragraph: { margin: [0, 0, 0, 8] },
    code: {
      fontSize: 8.7,
      lineHeight: 1.35,
      color: palette.text,
      margin: [0, 7, 0, 10],
    },
    quote: {
      color: palette.secondary,
      margin: [0, 4, 0, 10],
    },
    table: {
      fontSize: 9,
      lineHeight: 1.35,
      margin: [0, 7, 0, 12],
    },
  };
}

type TokenLike = {
  type: string;
  raw?: string;
  text?: string;
  depth?: number;
  lang?: string;
  href?: string;
  title?: string | null;
  tokens?: TokenLike[];
  items?: Array<TokenLike & { task?: boolean; checked?: boolean }>;
  header?: Array<{ text?: string; tokens?: TokenLike[] }>;
  rows?: Array<Array<{ text?: string; tokens?: TokenLike[] }>>;
  ordered?: boolean;
  start?: number | "";
};

function renderBlocks(
  tokens: TokenLike[],
  palette: Palette,
  onMath: () => void,
): Content[] {
  const content: Content[] = [];
  for (const token of tokens) {
    const raw = token.raw?.trim() ?? "";
    const formula = blockFormula(token, raw);
    if (formula !== null) {
      const math = formulaToSvg(formula);
      content.push({
        svg: math.svg,
        width: math.width,
        alignment: "center",
        margin: [0, 7, 0, 11],
        unbreakable: true,
      });
      onMath();
      continue;
    }
    if (token.type === "heading") {
      const depth = Math.min(6, Math.max(1, token.depth ?? 1));
      content.push({
        text: renderInline(token.tokens ?? [{ type: "text", text: token.text ?? "" }], palette),
        style: `h${Math.min(depth, 4)}`,
        headlineLevel: depth,
        ...(depth === 2 ? {
          decoration: "underline",
          decorationColor: palette.border,
          decorationStyle: "solid",
        } : {}),
      } as Content);
      continue;
    }
    if (token.type === "paragraph" || token.type === "text") {
      content.push({
        text: renderInline(token.tokens ?? [{ type: "text", text: token.text ?? raw }], palette),
        style: "paragraph",
      });
      continue;
    }
    if (token.type === "code") {
      const label = token.lang && token.lang !== "text" ? token.lang.toUpperCase() : "";
      const codeStack: Content[] = [
        ...(label ? [{
          text: label,
          color: palette.accent,
          fontSize: 7,
          characterSpacing: 1.1,
          margin: [0, 0, 0, 4] as [number, number, number, number],
        }] : []),
        { text: token.text ?? "", style: "code", preserveLeadingSpaces: true },
      ];
      content.push({
        table: {
          widths: ["*"],
          body: [[{
            stack: codeStack,
            fillColor: palette.codeSurface,
            margin: [9, 8, 9, 8],
            border: [false, false, false, false],
          }]],
        },
        layout: "noBorders",
        margin: [0, 5, 0, 10],
      });
      continue;
    }
    if (token.type === "blockquote") {
      content.push({
        table: {
          widths: [3, "*"],
          body: [[
            { text: "", fillColor: palette.accent, border: [false, false, false, false] },
            {
              stack: renderBlocks(token.tokens ?? [], palette, onMath),
              fillColor: palette.accentSoft,
              margin: [11, 8, 10, 2],
              border: [false, false, false, false],
            },
          ]],
        },
        layout: "noBorders",
        style: "quote",
      });
      continue;
    }
    if (token.type === "list") {
      const items = (token.items ?? []).map((item) => {
        const itemContent = renderBlocks(item.tokens ?? [], palette, onMath);
        if (item.task) {
          itemContent.unshift({
            text: item.checked ? "☑ " : "☐ ",
            color: item.checked ? palette.accent : palette.secondary,
          });
        }
        return itemContent.length === 1 ? itemContent[0] : { stack: itemContent };
      });
      content.push(token.ordered
        ? { ol: items, start: typeof token.start === "number" ? token.start : 1, margin: [9, 2, 0, 9] }
        : { ul: items, markerColor: palette.accent, margin: [9, 2, 0, 9] });
      continue;
    }
    if (token.type === "table") {
      const header = (token.header ?? []).map((cell) => ({
        text: renderInline(cell.tokens ?? [{ type: "text", text: cell.text ?? "" }], palette),
        bold: true,
        color: palette.text,
        fillColor: palette.accentSoft,
        margin: [5, 5, 5, 5] as [number, number, number, number],
      }));
      const rows = (token.rows ?? []).map((row) => row.map((cell) => ({
        text: renderInline(cell.tokens ?? [{ type: "text", text: cell.text ?? "" }], palette),
        margin: [5, 4, 5, 4] as [number, number, number, number],
      })));
      content.push({
        table: {
          headerRows: 1,
          widths: header.map(() => "*"),
          body: [header, ...rows],
          dontBreakRows: true,
        },
        layout: {
          hLineColor: () => palette.border,
          vLineColor: () => palette.border,
          hLineWidth: () => 0.55,
          vLineWidth: () => 0.55,
        },
        style: "table",
      });
      continue;
    }
    if (token.type === "hr") {
      content.push({
        canvas: [{
          type: "line",
          x1: 0,
          y1: 0,
          x2: 487,
          y2: 0,
          lineWidth: 0.7,
          lineColor: palette.border,
        }],
        margin: [0, 10, 0, 14],
      });
      continue;
    }
    if (token.type === "html") {
      const text = stripHtml(token.text ?? raw);
      if (text) content.push({ text, style: "paragraph" });
    }
  }
  return content;
}

function renderInline(tokens: TokenLike[], palette: Palette): Content[] {
  const runs: Content[] = [];
  for (const token of tokens) {
    if (token.type === "strong" || token.type === "em" || token.type === "del") {
      const children = renderInline(
        token.tokens ?? [{ type: "text", text: token.text ?? "" }],
        palette,
      );
      children.forEach((child) => {
        if (typeof child === "object" && child !== null && !Array.isArray(child)) {
          if (token.type === "strong") Object.assign(child, { bold: true });
          if (token.type === "em") Object.assign(child, { italics: true });
          if (token.type === "del") Object.assign(child, { decoration: "lineThrough" });
        }
      });
      runs.push(...children);
      continue;
    }
    if (token.type === "codespan") {
      runs.push({
        text: token.text ?? "",
        color: palette.accent,
        background: palette.codeSurface,
        fontSize: 9.2,
      });
      continue;
    }
    if (token.type === "link") {
      runs.push({
        text: renderInline(token.tokens ?? [{ type: "text", text: token.text ?? token.href ?? "" }], palette),
        link: token.href,
        color: palette.accent,
        decoration: "underline",
      });
      continue;
    }
    if (token.type === "image") {
      runs.push({
        text: token.text || token.title || token.href || "图片",
        link: token.href,
        color: palette.secondary,
        italics: true,
      });
      continue;
    }
    if (token.type === "br") {
      runs.push({ text: "\n" });
      continue;
    }
    if (token.tokens?.length) {
      runs.push(...renderInline(token.tokens, palette));
      continue;
    }
    runs.push(...splitInlineMath(token.text ?? token.raw ?? "", palette));
  }
  return runs.length ? runs : [{ text: "" }];
}

function splitInlineMath(text: string, palette: Palette): Content[] {
  const runs: Content[] = [];
  let cursor = 0;
  const expression = /(?<!\\)\$([^$\n]+?)(?<!\\)\$/g;
  for (const match of text.matchAll(expression)) {
    const index = match.index ?? 0;
    if (index > cursor) runs.push({ text: text.slice(cursor, index) });
    runs.push({
      text: readableFormula(match[1]),
      italics: true,
      color: palette.accent,
      fontSize: 9.8,
    });
    cursor = index + match[0].length;
  }
  if (cursor < text.length) runs.push({ text: text.slice(cursor) });
  return runs.length ? runs : [{ text }];
}

function readableFormula(tex: string) {
  return tex
    .replace(/\\mathbf\s*\{([^{}]+)\}/g, "$1")
    .replace(/\\mathrm\s*\{([^{}]+)\}/g, "$1")
    .replace(/\\text\s*\{([^{}]+)\}/g, "$1")
    .replace(/\\([a-zA-Z]+)/g, (_, name: string) => SYMBOLS[name] ?? name)
    .replace(/[{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const SYMBOLS: Record<string, string> = {
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε",
  theta: "θ", lambda: "λ", mu: "μ", pi: "π", rho: "ρ", sigma: "σ",
  phi: "φ", psi: "ψ", omega: "ω", Gamma: "Γ", Delta: "Δ", Lambda: "Λ",
  Pi: "Π", Sigma: "Σ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",
  infty: "∞", partial: "∂", nabla: "∇", cdot: "·", times: "×",
  le: "≤", ge: "≥", neq: "≠", approx: "≈", equiv: "≡", to: "→",
  leftarrow: "←", rightarrow: "→", sum: "∑", prod: "∏", int: "∫",
};

function blockFormula(token: TokenLike, raw: string) {
  if (token.type === "code" && token.lang?.toLowerCase() === "math") {
    return token.text ?? "";
  }
  if (token.type !== "paragraph" && token.type !== "text") return null;
  const match = raw.match(/^\$\$([\s\S]*?)\$\$$/);
  return match ? match[1].trim() : null;
}

function formulaToSvg(formula: string): MathSvg {
  const node = mathDocument.convert(formula, {
    display: true,
    em: 16,
    ex: 8,
    containerWidth: 487,
  });
  const outer = adaptor.outerHTML(node);
  const start = outer.indexOf("<svg");
  const end = outer.lastIndexOf("</svg>");
  if (start < 0 || end < start) throw new Error("公式矢量化失败");
  let svg = outer.slice(start, end + 6)
    .replace(/\s(?:focusable|role|aria-hidden)="[^"]*"/g, "");
  const viewBox = svg.match(/viewBox="([^"]+)"/)?.[1]
    ?.trim()
    .split(/\s+/)
    .map(Number);
  const ratio = viewBox?.length === 4 && viewBox[2] > 0 && viewBox[3] > 0
    ? viewBox[3] / viewBox[2]
    : 0.16;
  const exWidth = Number.parseFloat(svg.match(/\bwidth="([\d.]+)ex"/)?.[1] ?? "60");
  const width = Math.max(70, Math.min(487, exWidth * 7.2));
  const height = Math.max(16, width * ratio);
  svg = svg
    .replace(/\bwidth="[^"]+"/, `width="${width.toFixed(2)}"`)
    .replace(/\bheight="[^"]+"/, `height="${height.toFixed(2)}"`);
  return { svg, width };
}

function countMath(token: TokenLike): number {
  const own = blockFormula(token, token.raw?.trim() ?? "") !== null ? 1 : 0;
  if (own) return 1;
  const nested = token.tokens?.reduce((count, child) => count + countMath(child), 0) ?? 0;
  const items = token.items?.reduce(
    (count, item) => count + (item.tokens?.reduce((sum, child) => sum + countMath(child), 0) ?? 0),
    0,
  ) ?? 0;
  return own + nested + items;
}

function stripHtml(value: string) {
  return value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim();
}

function bytesToBase64(bytes: Uint8Array) {
  const chunks: string[] = [];
  const size = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += size) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + size)));
  }
  return btoa(chunks.join(""));
}

function post(message: {
  type: "progress" | "error";
  progress?: number;
  message: string;
}) {
  workerScope.postMessage(message);
}

export {};
