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
import {
  createPdfMermaidContent,
  type PdfMermaidDiagram,
} from "./pdf-mermaid";

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
  diagrams: PdfMermaidDiagram[];
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
  height: number;
}

type InlineStyle = {
  bold?: boolean;
  italics?: boolean;
  decoration?: "lineThrough" | "underline";
  color?: string;
  background?: string;
  fontSize?: number;
  link?: string;
};

type InlineAtom =
  | { kind: "text"; text: string; style: InlineStyle }
  | { kind: "math"; formula: string };

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
  const content = renderBlocks(tokens as TokenLike[], message.palette, message.diagrams ?? [], () => {
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
  diagrams: readonly PdfMermaidDiagram[],
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
      const inlineTokens = token.tokens ?? [{ type: "text", text: token.text ?? raw }];
      content.push(
        renderInlineFormulaParagraph(inlineTokens, palette, onMath)
        ?? {
          text: renderInline(inlineTokens, palette),
          style: "paragraph",
        },
      );
      continue;
    }
    if (token.type === "code") {
      const diagram = createPdfMermaidContent(token.lang, token.text ?? "", diagrams);
      if (diagram) {
        content.push(diagram as Content);
        continue;
      }
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
              stack: renderBlocks(token.tokens ?? [], palette, diagrams, onMath),
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
        const itemContent = renderBlocks(item.tokens ?? [], palette, diagrams, onMath);
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
  const expression = inlineMathExpression();
  for (const match of text.matchAll(expression)) {
    const index = match.index ?? 0;
    if (index > cursor) runs.push({ text: text.slice(cursor, index) });
    runs.push({
      text: readableFormula(match[1] ?? match[2]),
      bold: /\\(?:mathbf|boldsymbol|bm)\b/.test(match[1] ?? match[2]),
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
  let result = tex;
  for (let pass = 0; pass < 4; pass += 1) {
    result = result.replace(
      /\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g,
      "($1)/($2)",
    );
  }
  return result
    .replace(/\\(?:mathbf|boldsymbol|bm|mathrm|mathit|text)\s*\{([^{}]+)\}/g, "$1")
    .replace(/\\(?:mathbf|boldsymbol|bm)\s+([A-Za-z0-9])/g, "$1")
    .replace(/\\[,;:!]/g, " ")
    .replace(/\\(?:left|right)\b/g, "")
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

function inlineMathExpression() {
  return /(?<!\\)(?:\$([^$\n]+?)(?<!\\)\$|\\\((.+?)\\\))/g;
}

function renderInlineFormulaParagraph(
  tokens: TokenLike[],
  palette: Palette,
  onMath: () => void,
): Content | null {
  const atoms = collectInlineAtoms(tokens, palette);
  if (!atoms.some((atom) => atom.kind === "math")) return null;
  const lines = layoutInlineAtoms(atoms, onMath);
  return {
    stack: lines,
    margin: [0, 0, 0, 8],
  } as Content;
}

function collectInlineAtoms(
  tokens: TokenLike[],
  palette: Palette,
  inherited: InlineStyle = {},
): InlineAtom[] {
  const atoms: InlineAtom[] = [];
  let plainBuffer = "";
  const flushPlainBuffer = () => {
    if (!plainBuffer) return;
    atoms.push(...splitInlineAtoms(plainBuffer, inherited));
    plainBuffer = "";
  };
  for (const token of tokens) {
    if (token.type === "strong" || token.type === "em" || token.type === "del") {
      flushPlainBuffer();
      atoms.push(...collectInlineAtoms(
        token.tokens ?? [{ type: "text", text: token.text ?? "" }],
        palette,
        {
          ...inherited,
          ...(token.type === "strong" ? { bold: true } : {}),
          ...(token.type === "em" ? { italics: true } : {}),
          ...(token.type === "del" ? { decoration: "lineThrough" as const } : {}),
        },
      ));
      continue;
    }
    if (token.type === "codespan") {
      flushPlainBuffer();
      atoms.push({
        kind: "text",
        text: token.text ?? "",
        style: {
          ...inherited,
          color: palette.accent,
          background: palette.codeSurface,
          fontSize: 9.2,
        },
      });
      continue;
    }
    if (token.type === "link") {
      flushPlainBuffer();
      atoms.push(...collectInlineAtoms(
        token.tokens ?? [{ type: "text", text: token.text ?? token.href ?? "" }],
        palette,
        {
          ...inherited,
          link: token.href,
          color: palette.accent,
          decoration: "underline",
        },
      ));
      continue;
    }
    if (token.type === "image") {
      flushPlainBuffer();
      atoms.push({
        kind: "text",
        text: token.text || token.title || token.href || "图片",
        style: { ...inherited, color: palette.secondary, italics: true },
      });
      continue;
    }
    if (token.type === "br") {
      flushPlainBuffer();
      atoms.push({ kind: "text", text: "\n", style: inherited });
      continue;
    }
    if (token.tokens?.length) {
      flushPlainBuffer();
      atoms.push(...collectInlineAtoms(token.tokens, palette, inherited));
      continue;
    }
    plainBuffer += token.type === "escape"
      ? token.raw ?? token.text ?? ""
      : token.text ?? token.raw ?? "";
  }
  flushPlainBuffer();
  return atoms;
}

function splitInlineAtoms(text: string, style: InlineStyle): InlineAtom[] {
  const atoms: InlineAtom[] = [];
  let cursor = 0;
  for (const match of text.matchAll(inlineMathExpression())) {
    const index = match.index ?? 0;
    if (index > cursor) {
      atoms.push({ kind: "text", text: text.slice(cursor, index), style });
    }
    atoms.push({ kind: "math", formula: match[1] ?? match[2] });
    cursor = index + match[0].length;
  }
  if (cursor < text.length) {
    atoms.push({ kind: "text", text: text.slice(cursor), style });
  }
  return atoms.length ? atoms : [{ kind: "text", text, style }];
}

type LinePart =
  | { kind: "text"; text: string; style: InlineStyle; width: number }
  | { kind: "math"; math: MathSvg; width: number };

function layoutInlineAtoms(
  atoms: InlineAtom[],
  onMath: () => void,
): Content[] {
  const maximumWidth = 476;
  const lines: LinePart[][] = [];
  let current: LinePart[] = [];
  let currentWidth = 0;
  const flush = () => {
    if (current.length || !lines.length) lines.push(current);
    current = [];
    currentWidth = 0;
  };
  const append = (part: LinePart) => {
    if (current.length && currentWidth + part.width > maximumWidth) flush();
    current.push(part);
    currentWidth += part.width;
  };

  for (const atom of atoms) {
    if (atom.kind === "math") {
      const math = formulaToSvg(atom.formula, false);
      append({ kind: "math", math, width: math.width });
      onMath();
      continue;
    }
    const pieces = atom.text.split(/(\n|\s+|[\p{Script=Han}\p{P}\p{S}])/gu);
    for (const piece of pieces) {
      if (!piece) continue;
      if (piece === "\n") {
        flush();
        continue;
      }
      const width = estimateTextWidth(piece, atom.style.fontSize ?? 10.5);
      if (width > maximumWidth) {
        for (const character of piece) {
          append({
            kind: "text",
            text: character,
            style: atom.style,
            width: estimateTextWidth(character, atom.style.fontSize ?? 10.5),
          });
        }
      } else {
        append({ kind: "text", text: piece, style: atom.style, width });
      }
    }
  }
  if (current.length) flush();

  return lines.map((line) => {
    const merged = mergeTextParts(line);
    const columns: Content[] = merged.map((part) => {
      if (part.kind === "math") {
        return {
          svg: part.math.svg,
          width: part.math.width,
          height: part.math.height,
          margin: [0, Math.max(0, (16.2 - part.math.height) / 2), 0, 0],
        } as Content;
      }
      return {
        text: part.text,
        width: part.width,
        noWrap: true,
        ...part.style,
      } as Content;
    });
    columns.push({ text: "", width: "*" } as Content);
    return {
      columns,
      columnGap: 0,
    } as Content;
  });
}

function mergeTextParts(parts: LinePart[]) {
  const merged: LinePart[] = [];
  for (const part of parts) {
    const previous = merged.at(-1);
    if (
      part.kind === "text"
      && previous?.kind === "text"
      && JSON.stringify(previous.style) === JSON.stringify(part.style)
    ) {
      previous.text += part.text;
      previous.width += part.width;
    } else {
      merged.push(part);
    }
  }
  return merged;
}

function estimateTextWidth(text: string, fontSize: number) {
  let units = 0;
  for (const character of text) {
    if (/\s/u.test(character)) units += 0.34;
    else if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(character)) units += 1;
    else if (/[\p{P}\p{S}]/u.test(character)) units += 0.58;
    else if (/[A-Z0-9]/.test(character)) units += 0.64;
    else units += 0.56;
  }
  return Math.max(0.1, units * fontSize);
}

function blockFormula(token: TokenLike, raw: string) {
  if (token.type === "code" && token.lang?.toLowerCase() === "math") {
    return token.text ?? "";
  }
  if (token.type !== "paragraph" && token.type !== "text") return null;
  const dollars = raw.match(/^\$\$([\s\S]*?)\$\$$/);
  if (dollars) return dollars[1].trim();
  const brackets = raw.match(/^\\\[([\s\S]*?)\\\]$/);
  return brackets ? brackets[1].trim() : null;
}

function formulaToSvg(formula: string, display = true): MathSvg {
  const node = mathDocument.convert(formula, {
    display,
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
  let width = display
    ? Math.max(70, Math.min(487, exWidth * 7.2))
    : Math.max(4, Math.min(440, exWidth * 5.25));
  let height = display
    ? Math.max(16, width * ratio)
    : Math.max(7, width * ratio);
  if (!display && height > 18) {
    width *= 18 / height;
    height = 18;
  }
  svg = svg
    .replace(/\bwidth="[^"]+"/, `width="${width.toFixed(2)}"`)
    .replace(/\bheight="[^"]+"/, `height="${height.toFixed(2)}"`);
  return { svg, width, height };
}

function countMath(token: TokenLike): number {
  const own = blockFormula(token, token.raw?.trim() ?? "") !== null ? 1 : 0;
  if (own) return 1;
  if (
    token.raw
    && (token.type === "paragraph" || token.type === "heading")
  ) {
    return Array.from(token.raw.matchAll(inlineMathExpression())).length;
  }
  if (!token.tokens?.length) {
    return Array.from(
      (token.text ?? token.raw ?? "").matchAll(inlineMathExpression()),
    ).length;
  }
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
