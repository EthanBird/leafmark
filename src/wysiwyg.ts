function cleanText(value: string) {
  return value.replace(/\u00a0/g, " ");
}

export type LiveBlockShortcut =
  | { kind: "heading"; level: number; text: string }
  | { kind: "quote"; text: string }
  | { kind: "unordered-list"; text: string }
  | { kind: "ordered-list"; text: string };

export function matchLiveBlockShortcut(value: string): LiveBlockShortcut | null {
  const text = cleanText(value);
  const heading = text.match(/^(#{1,6}) (.*)$/s);
  if (heading) return { kind: "heading", level: heading[1].length, text: heading[2] };
  const quote = text.match(/^> (.*)$/s);
  if (quote) return { kind: "quote", text: quote[1] };
  const unordered = text.match(/^[-*+] (.*)$/s);
  if (unordered) return { kind: "unordered-list", text: unordered[1] };
  const ordered = text.match(/^\d+[.)] (.*)$/s);
  if (ordered) return { kind: "ordered-list", text: ordered[1] };
  return null;
}

export type LiveInlineShortcut = {
  kind: "bold" | "italic" | "strike" | "code" | "link";
  text: string;
  href?: string;
  start: number;
  end: number;
  contentStart: number;
  contentEnd: number;
};

function isEscaped(value: string, index: number) {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function inlineCandidate(
  kind: LiveInlineShortcut["kind"],
  match: RegExpExecArray,
  markerStart: number,
  markerEnd: number,
  contentStart: number,
  contentEnd: number,
  text: string,
  href?: string,
): LiveInlineShortcut | null {
  if (!text.trim() || isEscaped(match.input, markerStart)) return null;
  return {
    kind,
    text,
    href,
    start: markerStart,
    end: markerEnd,
    contentStart,
    contentEnd,
  };
}

export function matchLiveInlineShortcut(value: string, caret: number): LiveInlineShortcut | null {
  const text = cleanText(value);
  const candidates: LiveInlineShortcut[] = [];
  const patterns: Array<{
    kind: LiveInlineShortcut["kind"];
    regex: RegExp;
    opening: number;
    closing: number;
    textGroup: number;
    hrefGroup?: number;
    prefixGroup?: number;
  }> = [
    { kind: "link", regex: /(^|[^!])\[([^\]\n]+)\]\(([^)\n]+)\)/g, opening: 1, closing: 1, textGroup: 2, hrefGroup: 3, prefixGroup: 1 },
    { kind: "code", regex: /`([^`\n]+)`/g, opening: 1, closing: 1, textGroup: 1 },
    { kind: "bold", regex: /\*\*(?=\S)(.+?\S)\*\*/g, opening: 2, closing: 2, textGroup: 1 },
    { kind: "bold", regex: /__(?=\S)(.+?\S)__/g, opening: 2, closing: 2, textGroup: 1 },
    { kind: "strike", regex: /~~(?=\S)(.+?\S)~~/g, opening: 2, closing: 2, textGroup: 1 },
    { kind: "italic", regex: /(^|[^*])\*(?!\*)(?=\S)([^*\n]*?\S)\*(?!\*)/g, opening: 1, closing: 1, textGroup: 2, prefixGroup: 1 },
    { kind: "italic", regex: /(^|[^\w])_(?=\S)([^_\n]*?\S)_(?!\w)/g, opening: 1, closing: 1, textGroup: 2, prefixGroup: 1 },
  ];

  for (const pattern of patterns) {
    pattern.regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.regex.exec(text))) {
      const prefixLength = pattern.prefixGroup ? match[pattern.prefixGroup].length : 0;
      const start = match.index + prefixLength;
      const end = match.index + match[0].length;
      if (caret < start || caret > end) continue;
      const contentStart = start + pattern.opening;
      const contentEnd = pattern.kind === "link"
        ? contentStart + match[pattern.textGroup].length
        : end - pattern.closing;
      const candidate = inlineCandidate(
        pattern.kind,
        match,
        start,
        end,
        contentStart,
        contentEnd,
        match[pattern.textGroup],
        pattern.hrefGroup ? match[pattern.hrefGroup].trim() : undefined,
      );
      if (candidate) candidates.push(candidate);
    }
  }

  return candidates.sort((left, right) => {
    const span = (left.end - left.start) - (right.end - right.start);
    return span || right.start - left.start;
  })[0] ?? null;
}

function placeCaret(element: HTMLElement) {
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  if (element.lastChild?.nodeType === Node.TEXT_NODE) {
    range.setStart(element.lastChild, element.lastChild.textContent?.length ?? 0);
  } else {
    range.setStart(element, element.childNodes.length);
  }
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

export function applyLiveMarkdownShortcut(root: HTMLElement) {
  const selection = window.getSelection();
  const anchor = selection?.anchorNode;
  if (!anchor || !root.contains(anchor)) return false;
  let block = anchor.nodeType === Node.ELEMENT_NODE ? anchor as HTMLElement : anchor.parentElement;
  while (block?.parentElement && block.parentElement !== root) block = block.parentElement;
  if (!block || block.parentElement !== root || block.closest('[contenteditable="false"]')) return false;

  const shortcut = matchLiveBlockShortcut(block.textContent ?? "");
  if (!shortcut) return false;
  let replacement: HTMLElement;
  let caretTarget: HTMLElement;

  if (shortcut.kind === "heading") {
    replacement = document.createElement(`h${shortcut.level}`);
    replacement.textContent = shortcut.text;
    caretTarget = replacement;
  } else if (shortcut.kind === "quote") {
    replacement = document.createElement("blockquote");
    const paragraph = document.createElement("p");
    paragraph.textContent = shortcut.text;
    replacement.append(paragraph);
    caretTarget = paragraph;
  } else {
    replacement = document.createElement(shortcut.kind === "ordered-list" ? "ol" : "ul");
    const item = document.createElement("li");
    item.textContent = shortcut.text;
    replacement.append(item);
    caretTarget = item;
  }

  if (!caretTarget.textContent) caretTarget.append(document.createElement("br"));
  block.replaceWith(replacement);
  placeCaret(caretTarget);
  return true;
}

function activeTextPosition(root: HTMLElement) {
  const selection = window.getSelection();
  if (!selection?.isCollapsed || !selection.anchorNode || !root.contains(selection.anchorNode)) return null;
  const anchor = selection.anchorNode;
  if (anchor.nodeType === Node.TEXT_NODE) {
    return { node: anchor as Text, offset: selection.anchorOffset };
  }
  if (!(anchor instanceof Element)) return null;
  const before = anchor.childNodes[selection.anchorOffset - 1];
  if (before?.nodeType === Node.TEXT_NODE) {
    return { node: before as Text, offset: before.textContent?.length ?? 0 };
  }
  const after = anchor.childNodes[selection.anchorOffset];
  if (after?.nodeType === Node.TEXT_NODE) return { node: after as Text, offset: 0 };
  return null;
}

export function applyLiveInlineMarkdownShortcut(root: HTMLElement) {
  const position = activeTextPosition(root);
  if (!position) return false;
  const parent = position.node.parentElement;
  if (!parent || parent.closest('strong, b, em, i, del, s, code, a, [contenteditable="false"], .math-source')) {
    return false;
  }
  const value = position.node.textContent ?? "";
  const shortcut = matchLiveInlineShortcut(value, position.offset);
  if (!shortcut) return false;

  const element = document.createElement(
    shortcut.kind === "bold"
      ? "strong"
      : shortcut.kind === "italic"
        ? "em"
        : shortcut.kind === "strike"
          ? "del"
          : shortcut.kind === "code"
            ? "code"
            : "a",
  );
  if (shortcut.kind === "link") element.setAttribute("href", shortcut.href ?? "");
  const contentNode = document.createTextNode(shortcut.text);
  element.append(contentNode);

  const before = value.slice(0, shortcut.start);
  const after = value.slice(shortcut.end);
  const fragment = document.createDocumentFragment();
  if (before) fragment.append(document.createTextNode(before));
  fragment.append(element);
  if (after) fragment.append(document.createTextNode(after));
  position.node.replaceWith(fragment);

  const selection = window.getSelection();
  if (!selection) return true;
  const range = document.createRange();
  if (position.offset <= shortcut.contentStart) {
    range.setStart(contentNode, 0);
  } else if (position.offset < shortcut.contentEnd) {
    range.setStart(contentNode, Math.min(shortcut.text.length, position.offset - shortcut.contentStart));
  } else {
    range.setStartAfter(element);
  }
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

function inlineChildren(element: Element): string {
  return Array.from(element.childNodes).map(serializeNode).join("");
}

function serializeList(element: Element, ordered: boolean, depth = 0): string {
  let index = 1;
  return Array.from(element.children)
    .filter((child) => child.tagName === "LI")
    .map((item) => {
      const nested = Array.from(item.children).filter((child) => child.tagName === "UL" || child.tagName === "OL");
      const clone = item.cloneNode(true) as HTMLElement;
      clone.querySelectorAll(":scope > ul, :scope > ol").forEach((node) => node.remove());
      const checkbox = clone.querySelector<HTMLInputElement>('input[type="checkbox"]');
      const task = checkbox ? `[${checkbox.checked ? "x" : " "}] ` : "";
      checkbox?.remove();
      const marker = ordered ? `${index++}. ` : "- ";
      const body = inlineChildren(clone).trim();
      const nestedText = nested
        .map((child) => serializeList(child, child.tagName === "OL", depth + 1))
        .join("")
        .split("\n")
        .filter(Boolean)
        .map((line) => `  ${line}`)
        .join("\n");
      return `${marker}${task}${body}${nestedText ? `\n${nestedText}` : ""}`;
    })
    .join("\n") + (depth === 0 ? "\n\n" : "\n");
}

function serializeTable(table: Element) {
  const rows = Array.from(table.querySelectorAll("tr")).map((row) =>
    Array.from(row.children).map((cell) => inlineChildren(cell).trim().replace(/\|/g, "\\|")),
  );
  if (!rows.length) return "";
  const width = Math.max(...rows.map((row) => row.length));
  const normalized = rows.map((row) => [...row, ...Array(Math.max(0, width - row.length)).fill("")]);
  const header = normalized[0];
  const separator = header.map(() => "---");
  return [header, separator, ...normalized.slice(1)].map((row) => `| ${row.join(" | ")} |`).join("\n") + "\n\n";
}

function serializeNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return cleanText(node.textContent ?? "");
  if (!(node instanceof Element)) return "";
  const tag = node.tagName.toLowerCase();
  const math = (node as HTMLElement).dataset.mathSource;
  if (math !== undefined) return node.classList.contains("math-display") ? `\n\n$$\n${math}\n$$\n\n` : `$${math}$`;
  const diagram = (node as HTMLElement).dataset.mermaidSource;
  if (diagram !== undefined) return `\n\n\`\`\`mermaid\n${diagram}\n\`\`\`\n\n`;

  switch (tag) {
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6":
      return `${"#".repeat(Number(tag[1]))} ${inlineChildren(node).trim()}\n\n`;
    case "p":
      return `${inlineChildren(node).trim()}\n\n`;
    case "strong":
    case "b":
      return `**${inlineChildren(node)}**`;
    case "em":
    case "i":
      return `*${inlineChildren(node)}*`;
    case "del":
    case "s":
      return `~~${inlineChildren(node)}~~`;
    case "code":
      if (node.parentElement?.tagName === "PRE") return node.textContent ?? "";
      return `\`${node.textContent ?? ""}\``;
    case "pre": {
      const language = node.querySelector("code")?.className.match(/language-([\w-]+)/)?.[1] ?? "";
      return `\n\n\`\`\`${language}\n${node.textContent?.replace(/\n$/, "") ?? ""}\n\`\`\`\n\n`;
    }
    case "blockquote":
      return inlineChildren(node)
        .trim()
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n") + "\n\n";
    case "ul":
      return serializeList(node, false);
    case "ol":
      return serializeList(node, true);
    case "a": {
      const href = node.getAttribute("href") ?? "";
      return `[${inlineChildren(node)}](${href})`;
    }
    case "img":
      return `![${node.getAttribute("alt") ?? ""}](${node.getAttribute("src") ?? ""})`;
    case "table":
      return serializeTable(node);
    case "br":
      return "  \n";
    case "hr":
      return "\n\n---\n\n";
    case "div":
    case "section":
    case "article":
    case "thead":
    case "tbody":
    case "tr":
    case "th":
    case "td":
    case "span":
      return inlineChildren(node);
    default:
      return inlineChildren(node);
  }
}

export function htmlToMarkdown(root: HTMLElement) {
  return Array.from(root.childNodes)
    .map(serializeNode)
    .join("")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd() + "\n";
}

export function runFormat(command: "bold" | "italic" | "strikeThrough" | "insertUnorderedList" | "insertOrderedList") {
  document.execCommand(command, false);
}
