import { describe, expect, it } from "vitest";
import { buildTree, parentPath, resolveMarkdownLink } from "./tree";
import type { DocumentEntry } from "./types";

describe("document tree", () => {
  it("builds nested directories independently of source order", () => {
    const entries: DocumentEntry[] = [
      { path: "guide/start.md", name: "start.md", kind: "file", depth: 1, size: 1, modifiedMs: 0 },
      { path: "guide", name: "guide", kind: "directory", depth: 0, size: 0, modifiedMs: 0 },
    ];
    const tree = buildTree(entries);
    expect(tree).toHaveLength(1);
    expect(tree[0].children[0].entry.path).toBe("guide/start.md");
  });

  it("resolves local markdown links without allowing them above root", () => {
    expect(resolveMarkdownLink("guide/start.md", "../reference/api")).toBe("reference/api.md");
    expect(resolveMarkdownLink("guide/start.md", "../../home.md")).toBe("home.md");
    expect(parentPath("guide/start.md")).toBe("guide");
  });
});
