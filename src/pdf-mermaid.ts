import { marked } from "marked";

const DEFAULT_MAX_WIDTH = 452;
const DEFAULT_MAX_HEIGHT = 620;
const CSS_PIXEL_TO_POINT = 0.75;
const SVG_PRESENTATION_PROPERTIES = [
  "color",
  "fill",
  "fill-opacity",
  "font-family",
  "font-size",
  "font-style",
  "font-weight",
  "opacity",
  "paint-order",
  "stop-color",
  "stop-opacity",
  "stroke",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "stroke-opacity",
  "stroke-width",
  "text-anchor",
  "vector-effect",
] as const;

let diagramSequence = 0;
let mermaidRenderQueue: Promise<void> = Promise.resolve();

interface MarkedTokenLike {
  type: string;
  text?: string;
  lang?: string;
  tokens?: MarkedTokenLike[];
  items?: Array<{ tokens?: MarkedTokenLike[] }>;
}

export interface PdfMermaidDiagram {
  source: string;
  svg: string;
  width: number;
  height: number;
}

export interface MermaidSvgBounds {
  maxWidth?: number;
  maxHeight?: number;
}

export interface QueuedMermaidRenderOptions {
  theme?: "default" | "base" | "dark" | "forest" | "neutral" | "null";
  themeVariables?: Record<string, string>;
  fontFamily?: string;
  htmlLabels?: boolean;
  idPrefix?: string;
  signal?: AbortSignal;
}

export interface MermaidSvgRenderResult {
  svg: string;
  bindFunctions?: (element: Element) => void;
}

export interface PdfMermaidContentNode {
  svg: string;
  width: number;
  height: number;
  alignment: "center";
  margin: [number, number, number, number];
  unbreakable: true;
}

export type PdfMermaidRenderer = (
  source: string,
  index: number,
) => Promise<string>;

export interface PreparePdfMermaidOptions extends MermaidSvgBounds {
  theme?: QueuedMermaidRenderOptions["theme"];
  themeVariables?: QueuedMermaidRenderOptions["themeVariables"];
  layoutFontFamily?: string;
  signal?: AbortSignal;
  renderer?: PdfMermaidRenderer;
  onProgress?: (completed: number, total: number) => void;
  onError?: (source: string, error: unknown) => void;
}

export function normalizeMermaidSource(source: string) {
  return source.replace(/\r\n?/g, "\n").trim();
}

export function isMermaidLanguage(language: string | undefined) {
  return (language ?? "").trim().split(/\s+/, 1)[0]?.toLowerCase() === "mermaid";
}

export function extractMermaidSources(markdown: string) {
  const found = new Map<string, string>();
  const visit = (tokens: MarkedTokenLike[]) => {
    for (const token of tokens) {
      if (token.type === "code" && isMermaidLanguage(token.lang)) {
        const source = normalizeMermaidSource(token.text ?? "");
        if (source && !found.has(source)) found.set(source, source);
      }
      if (token.tokens?.length) visit(token.tokens);
      for (const item of token.items ?? []) {
        if (item.tokens?.length) visit(item.tokens);
      }
    }
  };

  visit(marked.lexer(markdown, { gfm: true }) as MarkedTokenLike[]);
  return [...found.values()];
}

export function normalizeMermaidSvg(
  source: string,
  svg: string,
  bounds: MermaidSvgBounds = {},
): PdfMermaidDiagram | null {
  if (/<foreignObject\b/i.test(svg)) return null;
  const root = svg.match(/<svg\b[^>]*>/i)?.[0];
  if (!root) return null;
  const viewBoxValue = attributeValue(root, "viewBox");
  const viewBox = viewBoxValue
    ?.trim()
    .split(/[\s,]+/)
    .map((value) => Number.parseFloat(value));
  if (
    !viewBox
    || viewBox.length !== 4
    || !viewBox.every(Number.isFinite)
    || viewBox[2] <= 0
    || viewBox[3] <= 0
  ) {
    return null;
  }

  const maxWidth = positiveBound(bounds.maxWidth, DEFAULT_MAX_WIDTH);
  const maxHeight = positiveBound(bounds.maxHeight, DEFAULT_MAX_HEIGHT);
  const naturalWidth = viewBox[2] * CSS_PIXEL_TO_POINT;
  const naturalHeight = viewBox[3] * CSS_PIXEL_TO_POINT;
  const scale = Math.min(1, maxWidth / naturalWidth, maxHeight / naturalHeight);
  const width = roundDimension(naturalWidth * scale);
  const height = roundDimension(naturalHeight * scale);
  const normalizedRoot = setRootDimensions(root, width, height);

  return {
    source: normalizeMermaidSource(source),
    svg: svg.replace(root, normalizedRoot),
    width,
    height,
  };
}

export function inlineMermaidSvgStyles(svg: string, outputFontFamily?: string) {
  if (typeof document === "undefined") return svg;
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;left:-100000px;top:0;pointer-events:none;z-index:-2147483648";
  host.innerHTML = svg;
  const root = host.querySelector<SVGSVGElement>("svg");
  if (!root) return svg;
  (document.body ?? document.documentElement).append(host);
  try {
    replaceForeignObjectsWithSvgText(root);
    unwrapSvgSwitchElements(root);
    const winners = new Map<SVGElement, Map<string, SvgStyleCandidate>>();
    let order = 0;
    for (const styleElement of root.querySelectorAll<SVGStyleElement>("style")) {
      const proxyStyle = document.createElement("style");
      proxyStyle.textContent = styleElement.textContent;
      host.prepend(proxyStyle);
      const rules = Array.from(styleElement.sheet?.cssRules ?? proxyStyle.sheet?.cssRules ?? []);
      for (const rule of rules) {
        if (!("selectorText" in rule) || !("style" in rule)) continue;
        const styleRule = rule as CSSStyleRule;
        for (const selector of splitCssSelectors(styleRule.selectorText)) {
          let nodes: SVGElement[];
          try {
            nodes = [
              ...(root.matches(selector) ? [root] : []),
              ...Array.from(root.querySelectorAll<SVGElement>(selector)),
            ];
          } catch {
            continue;
          }
          const specificity = cssSpecificity(selector);
          for (const node of nodes) {
            for (const property of SVG_PRESENTATION_PROPERTIES) {
              const value = styleRule.style.getPropertyValue(property).trim();
              if (!value) continue;
              setSvgStyleCandidate(winners, node, property, {
                value,
                important: styleRule.style.getPropertyPriority(property) === "important",
                specificity,
                order: order++,
              });
            }
          }
        }
      }
      proxyStyle.remove();
    }

    for (const node of [root, ...Array.from(root.querySelectorAll<SVGElement>("*"))]) {
      for (const property of SVG_PRESENTATION_PROPERTIES) {
        const value = node.style.getPropertyValue(property).trim();
        if (!value) continue;
        setSvgStyleCandidate(winners, node, property, {
          value,
          important: node.style.getPropertyPriority(property) === "important",
          specificity: [1_000_000, 0, 0],
          order: order++,
        });
      }
    }

    for (const [node, declarations] of winners) {
      for (const [property, candidate] of declarations) {
        node.setAttribute(property, candidate.value);
      }
    }
    if (outputFontFamily) {
      root.setAttribute("font-family", outputFontFamily);
      root.querySelectorAll<SVGElement>("[font-family],text,tspan").forEach((node) => {
        node.setAttribute("font-family", outputFontFamily);
        if (node.style.getPropertyValue("font-family")) {
          node.style.setProperty("font-family", outputFontFamily);
        }
      });
    }
    sanitizeSvgDashArrays(root);
    root.querySelectorAll("style").forEach((style) => style.remove());
    return root.outerHTML;
  } finally {
    host.remove();
  }
}

function sanitizeSvgDashArrays(root: SVGSVGElement) {
  for (const node of [root, ...Array.from(root.querySelectorAll<SVGElement>("*"))]) {
    const values = [
      node.getAttribute("stroke-dasharray") ?? "",
      node.style.getPropertyValue("stroke-dasharray"),
    ].filter(Boolean);
    if (!values.some((value) => !pdfSafeDashArray(value))) continue;
    node.removeAttribute("stroke-dasharray");
    node.style.removeProperty("stroke-dasharray");
  }
}

function pdfSafeDashArray(value: string) {
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === "none") return true;
  const lengths = normalized.split(/[\s,]+/).filter(Boolean).map(Number.parseFloat);
  return lengths.length > 0 && lengths.every((length) => Number.isFinite(length) && length > 0);
}

function unwrapSvgSwitchElements(root: SVGSVGElement) {
  for (const switchElement of root.querySelectorAll<SVGSwitchElement>("switch")) {
    const selected = switchElement.firstElementChild;
    if (selected) switchElement.replaceWith(selected);
    else switchElement.remove();
  }
}

function replaceForeignObjectsWithSvgText(root: SVGSVGElement) {
  for (const foreignObject of root.querySelectorAll<SVGForeignObjectElement>("foreignObject")) {
    const x = numericSvgAttribute(foreignObject, "x");
    const y = numericSvgAttribute(foreignObject, "y");
    const width = numericSvgAttribute(foreignObject, "width");
    const height = numericSvgAttribute(foreignObject, "height");
    const lines = foreignObjectTextLines(foreignObject);
    const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
    const classes = new Set(["label", "foreign-object-label"]);
    foreignObject.querySelectorAll<HTMLElement>("[class]").forEach((element) => {
      element.classList.forEach((className) => classes.add(className));
    });
    group.setAttribute("class", [...classes].join(" "));
    const transform = foreignObject.getAttribute("transform");
    if (transform) group.setAttribute("transform", transform);

    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    const centerX = x + width / 2;
    const lineHeight = 18;
    const firstLineY = y + height / 2 - (Math.max(1, lines.length) - 1) * lineHeight / 2;
    text.setAttribute("x", String(centerX));
    text.setAttribute("y", String(firstLineY));
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("dominant-baseline", "middle");
    text.setAttribute("font-family", "LeafMark");
    for (const [index, line] of (lines.length ? lines : [""]).entries()) {
      const span = document.createElementNS("http://www.w3.org/2000/svg", "tspan");
      span.setAttribute("x", String(centerX));
      if (index > 0) span.setAttribute("dy", String(lineHeight));
      span.textContent = line;
      text.append(span);
    }
    group.append(text);
    foreignObject.replaceWith(group);
  }
}

function numericSvgAttribute(element: SVGElement, name: string) {
  const attribute = Number.parseFloat(element.getAttribute(name) ?? "");
  if (Number.isFinite(attribute)) return attribute;
  const style = Number.parseFloat(element.style.getPropertyValue(name));
  return Number.isFinite(style) ? style : 0;
}

function foreignObjectTextLines(root: Element) {
  const lines: string[] = [];
  let current = "";
  const flush = () => {
    const normalized = current.replace(/\s+/g, " ").trim();
    if (normalized) lines.push(normalized);
    current = "";
  };
  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      current += node.textContent ?? "";
      return;
    }
    if (!(node instanceof Element)) return;
    const tag = node.tagName.toLowerCase();
    if (tag === "br") {
      flush();
      return;
    }
    const block = /^(div|p|li|tr|section|article|h[1-6])$/.test(tag);
    if (block && current.trim()) flush();
    node.childNodes.forEach(visit);
    if (block) flush();
  };
  root.childNodes.forEach(visit);
  flush();
  return lines;
}

interface SvgStyleCandidate {
  value: string;
  important: boolean;
  specificity: [number, number, number];
  order: number;
}

function setSvgStyleCandidate(
  winners: Map<SVGElement, Map<string, SvgStyleCandidate>>,
  node: SVGElement,
  property: string,
  candidate: SvgStyleCandidate,
) {
  let declarations = winners.get(node);
  if (!declarations) {
    declarations = new Map();
    winners.set(node, declarations);
  }
  const previous = declarations.get(property);
  if (!previous || compareSvgStyleCandidates(candidate, previous) >= 0) {
    declarations.set(property, candidate);
  }
}

function compareSvgStyleCandidates(left: SvgStyleCandidate, right: SvgStyleCandidate) {
  if (left.important !== right.important) return left.important ? 1 : -1;
  for (let index = 0; index < left.specificity.length; index += 1) {
    if (left.specificity[index] !== right.specificity[index]) {
      return left.specificity[index] - right.specificity[index];
    }
  }
  return left.order - right.order;
}

function splitCssSelectors(value: string) {
  const selectors: string[] = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "(" || character === "[") depth += 1;
    else if (character === ")" || character === "]") depth = Math.max(0, depth - 1);
    else if (character === "," && depth === 0) {
      selectors.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  selectors.push(value.slice(start).trim());
  return selectors.filter(Boolean);
}

function cssSpecificity(selector: string): [number, number, number] {
  const ids = selector.match(/#[\w-]+/g)?.length ?? 0;
  const classes = selector.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+(?:\([^)]*\))?/g)?.length ?? 0;
  const withoutQualifiedNames = selector
    .replace(/#[\w-]+|\.[\w-]+|\[[^\]]+\]|::?[\w-]+(?:\([^)]*\))?/g, " ")
    .replace(/[*>+~]/g, " ");
  const elements = withoutQualifiedNames.match(/(?:^|\s)[a-zA-Z][\w-]*/g)?.length ?? 0;
  return [ids, classes, elements];
}

export function resolvePdfMermaidDiagram(
  diagrams: readonly PdfMermaidDiagram[],
  source: string,
) {
  const key = normalizeMermaidSource(source);
  return diagrams.find((diagram) => normalizeMermaidSource(diagram.source) === key);
}

export function createPdfMermaidContent(
  language: string | undefined,
  source: string,
  diagrams: readonly PdfMermaidDiagram[],
): PdfMermaidContentNode | null {
  if (!isMermaidLanguage(language)) return null;
  const diagram = resolvePdfMermaidDiagram(diagrams, source);
  if (!diagram) return null;
  return {
    svg: diagram.svg,
    width: diagram.width,
    height: diagram.height,
    alignment: "center",
    margin: [0, 7, 0, 12],
    unbreakable: true,
  };
}

export function withMermaidRenderLock<T>(operation: () => Promise<T>): Promise<T> {
  const result = mermaidRenderQueue.then(operation, operation);
  mermaidRenderQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export function renderMermaidSvgQueued(
  source: string,
  options: QueuedMermaidRenderOptions = {},
): Promise<MermaidSvgRenderResult> {
  return withMermaidRenderLock(async () => {
    throwIfAborted(options.signal);
    const { default: mermaid } = await import("mermaid");
    throwIfAborted(options.signal);
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: options.theme ?? "neutral",
      themeVariables: options.themeVariables,
      fontFamily: options.fontFamily ?? "LeafMark",
      htmlLabels: options.htmlLabels ?? false,
      flowchart: {
        htmlLabels: options.htmlLabels ?? false,
        curve: "basis",
      },
    });
    const idPrefix = (options.idPrefix ?? "leafmark-pdf-diagram")
      .replace(/[^a-zA-Z0-9_-]/g, "-");
    const result = await mermaid.render(`${idPrefix}-${++diagramSequence}`, source);
    throwIfAborted(options.signal);
    return {
      svg: result.svg,
      bindFunctions: result.bindFunctions,
    };
  });
}

export async function preparePdfMermaidDiagrams(
  markdown: string,
  options: PreparePdfMermaidOptions = {},
) {
  const sources = extractMermaidSources(markdown);
  const diagrams: PdfMermaidDiagram[] = [];
  options.onProgress?.(0, sources.length);
  const renderer = options.renderer ?? (async (source: string) => {
    const result = await renderMermaidSvgQueued(source, {
      theme: options.theme ?? "neutral",
      themeVariables: options.themeVariables,
      fontFamily: options.layoutFontFamily ?? "LeafMark",
      htmlLabels: false,
      idPrefix: "leafmark-pdf-diagram",
      signal: options.signal,
    });
    return inlineMermaidSvgStyles(result.svg, "LeafMark");
  });

  for (let index = 0; index < sources.length; index += 1) {
    if (options.signal?.aborted) break;
    const source = sources[index];
    try {
      const svg = await renderer(source, index);
      if (options.signal?.aborted) break;
      const diagram = normalizeMermaidSvg(source, svg, options);
      if (diagram) diagrams.push(diagram);
    } catch (error) {
      if (options.signal?.aborted || isAbortError(error)) break;
      options.onError?.(source, error);
    }
    options.onProgress?.(index + 1, sources.length);
    if (index + 1 < sources.length) await yieldToBrowser(options.signal);
  }

  return diagrams;
}

function yieldToBrowser(signal: AbortSignal | undefined) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const finish = () => {
      globalThis.clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = globalThis.setTimeout(finish, 0);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

function attributeValue(root: string, name: string) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return root.match(new RegExp(`\\b${escaped}\\s*=\\s*["']([^"']+)["']`, "i"))?.[1];
}

function positiveBound(value: number | undefined, fallback: number) {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function roundDimension(value: number) {
  return Math.max(0.01, Math.round(value * 100) / 100);
}

function setRootDimensions(root: string, width: number, height: number) {
  const withoutDimensions = root
    .replace(/\swidth\s*=\s*(?:"[^"]*"|'[^']*')/i, "")
    .replace(/\sheight\s*=\s*(?:"[^"]*"|'[^']*')/i, "");
  return withoutDimensions.replace(/>$/, ` width="${width}" height="${height}">`);
}

function throwIfAborted(signal: AbortSignal | undefined) {
  if (!signal?.aborted) return;
  const error = new Error("Mermaid rendering was cancelled");
  error.name = "AbortError";
  throw error;
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}
