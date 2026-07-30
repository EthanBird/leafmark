function cleanText(value: string) {
  return value.replace(/\u00a0/g, " ");
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
