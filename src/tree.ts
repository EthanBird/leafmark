import type { DocumentEntry, TreeNode } from "./types";

export function buildTree(entries: DocumentEntry[]): TreeNode[] {
  const roots: TreeNode[] = [];
  const nodes = new Map<string, TreeNode>();

  for (const entry of entries) nodes.set(entry.path, { entry, children: [] });
  for (const entry of entries) {
    const node = nodes.get(entry.path)!;
    const parent = parentPath(entry.path);
    const parentNode = nodes.get(parent);
    if (parentNode) parentNode.children.push(node);
    else roots.push(node);
  }
  return roots;
}

export function parentPath(path: string) {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
}

export function joinPath(parent: string, name: string) {
  return parent ? `${parent}/${name}` : name;
}

export function fileName(path: string) {
  return path.split("/").at(-1) ?? path;
}

export function resolveMarkdownLink(current: string, href: string) {
  const clean = decodeURIComponent(href.split("#")[0].split("?")[0]).replaceAll("\\", "/");
  const parts = [...parentPath(current).split("/").filter(Boolean), ...clean.split("/")];
  const resolved: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") resolved.pop();
    else resolved.push(part);
  }
  const value = resolved.join("/");
  return /\.(md|markdown)$/i.test(value) ? value : `${value}.md`;
}
