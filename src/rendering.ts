import { convertFileSrc } from "@tauri-apps/api/core";
import type { AppSettings } from "./types";

let diagramSequence = 0;
let mermaidModule: Promise<typeof import("mermaid")> | null = null;
let katexModule: Promise<typeof import("katex")> | null = null;
let katexStyles: Promise<unknown> | null = null;

export interface OutlineItem {
  id: string;
  level: number;
  text: string;
}

function slugify(value: string, fallback: string) {
  const slug = value
    .trim()
    .toLocaleLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s_-]/gu, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
  return slug || fallback;
}

export async function enhanceDocument(
  root: HTMLElement,
  settings: AppSettings,
  documentDirectory: string,
): Promise<{ outline: OutlineItem[]; cleanup: () => void }> {
  const outline: OutlineItem[] = [];
  const usedIds = new Set<string>();
  root.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6").forEach((heading, index) => {
    const base = slugify(heading.textContent ?? "", `section-${index + 1}`);
    let id = base;
    let suffix = 2;
    while (usedIds.has(id)) id = `${base}-${suffix++}`;
    usedIds.add(id);
    heading.id = id;
    outline.push({ id, level: Number(heading.tagName.slice(1)), text: heading.textContent?.trim() || `章节 ${index + 1}` });
  });

  if ("__TAURI_INTERNALS__" in window) {
    root.querySelectorAll<HTMLImageElement>("img").forEach((image) => {
      const source = image.getAttribute("src") ?? "";
      if (!source || /^(data:|asset:|https?:|blob:)/i.test(source)) return;
      const normalized = source.replaceAll("\\", "/");
      const absolute = /^[a-z]:\//i.test(normalized)
        ? normalized
        : `${documentDirectory.replaceAll("\\", "/").replace(/\/$/, "")}/${normalized}`;
      image.src = convertFileSrc(absolute);
      image.loading = "lazy";
      image.decoding = "async";
    });
  }

  const observers: IntersectionObserver[] = [];
  if (settings.mathEnabled) await renderMath(root);
  if (settings.mermaidEnabled) {
    const observer = lazyRenderDiagrams(root);
    if (observer) observers.push(observer);
  }

  return {
    outline,
    cleanup: () => observers.forEach((observer) => observer.disconnect()),
  };
}

async function renderMath(root: HTMLElement) {
  materializeSlashDelimitedMath(root);
  const nodes = Array.from(root.querySelectorAll<HTMLElement>("[data-math-source]"));
  if (!nodes.length) return;
  katexModule ??= import("katex");
  katexStyles ??= import("./generated/katex-woff2.css");
  const [katex] = await Promise.all([katexModule, katexStyles]);
  for (const node of nodes) {
    if (node.dataset.mathRendered === "true") continue;
    const source = node.dataset.mathSource ?? "";
    const displayMode = node.classList.contains("math-display");
    try {
      katex.render(source, node, {
        displayMode,
        throwOnError: false,
        strict: "ignore",
        trust: false,
        output: "htmlAndMathml",
      });
      node.dataset.mathRendered = "true";
      node.setAttribute("contenteditable", "false");
      node.setAttribute("aria-label", source);
      node.title = source;
    } catch {
      node.textContent = displayMode ? `$$\n${source}\n$$` : `$${source}$`;
      node.classList.add("render-error");
    }
  }
}

function materializeSlashDelimitedMath(root: HTMLElement) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  let current = walker.nextNode();
  while (current) {
    const parent = current.parentElement;
    if (
      current.textContent?.includes("\\") &&
      parent &&
      !parent.closest("code,pre,script,style,[data-math-source],[data-mermaid-source]")
    ) {
      textNodes.push(current as Text);
    }
    current = walker.nextNode();
  }

  const pattern = /\\\((.+?)\\\)|\\\[([\s\S]+?)\\\]/g;
  for (const textNode of textNodes) {
    const text = textNode.textContent ?? "";
    pattern.lastIndex = 0;
    if (!pattern.test(text)) continue;
    pattern.lastIndex = 0;
    const fragment = document.createDocumentFragment();
    let offset = 0;
    for (const match of text.matchAll(pattern)) {
      const index = match.index ?? 0;
      if (index > offset) fragment.append(text.slice(offset, index));
      const span = document.createElement(match[2] !== undefined ? "div" : "span");
      span.className = match[2] !== undefined ? "math-source math-display" : "math-source";
      span.dataset.mathSource = match[1] ?? match[2] ?? "";
      fragment.append(span);
      offset = index + match[0].length;
    }
    if (offset < text.length) fragment.append(text.slice(offset));
    textNode.replaceWith(fragment);
  }
}

function lazyRenderDiagrams(root: HTMLElement) {
  const nodes = Array.from(root.querySelectorAll<HTMLElement>("[data-mermaid-source]"));
  if (!nodes.length) return null;

  if (!("IntersectionObserver" in window)) {
    void Promise.all(nodes.map((node) => renderDiagram(node)));
    return null;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        void renderDiagram(entry.target as HTMLElement);
      }
    },
    { rootMargin: "500px 0px" },
  );
  nodes.forEach((node) => observer.observe(node));
  return observer;
}

async function renderDiagram(node: HTMLElement) {
  if (node.dataset.mermaidRendered === "true") return;
  const source = node.dataset.mermaidSource ?? node.textContent ?? "";
  if (!source.trim()) return;
  node.dataset.mermaidRendered = "pending";

  try {
    mermaidModule ??= import("mermaid");
    const { default: mermaid } = await mermaidModule;
    const dark = document.documentElement.dataset.resolvedTheme === "dark";
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: dark ? "dark" : "neutral",
      fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
      flowchart: { htmlLabels: true, curve: "basis" },
    });
    const id = `leafmark-diagram-${++diagramSequence}`;
    const { svg, bindFunctions } = await mermaid.render(id, source);
    const figure = document.createElement("figure");
    figure.className = "mermaid-block";
    figure.dataset.mermaidSource = source;
    figure.dataset.mermaidRendered = "true";
    figure.setAttribute("contenteditable", "false");
    figure.innerHTML = svg;
    node.replaceWith(figure);
    bindFunctions?.(figure);
  } catch (error) {
    node.dataset.mermaidRendered = "error";
    node.classList.add("render-error");
    node.innerHTML = `<div class="render-error-title">Mermaid 图表无法渲染</div><code></code>`;
    const code = node.querySelector("code");
    if (code) code.textContent = source;
    node.title = String(error);
  }
}
