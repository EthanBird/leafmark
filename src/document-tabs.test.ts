import { describe, expect, it } from "vitest";
import { documentTabKey, nextTabAfterClose, upsertDocumentTab } from "./document-tabs";
import type { LoadedDocument } from "./types";

const loaded = (path: string, archiveId = ""): LoadedDocument => ({
  path,
  origin: archiveId ? "archive" : "workspace",
  archiveId,
  sourcePath: path,
  sourceExists: true,
  content: path,
  html: `<p>${path}</p>`,
  size: path.length,
  modifiedMs: 1,
  cached: false,
});

describe("document tabs", () => {
  it("distinguishes workspace and retained copies", () => {
    expect(documentTabKey(loaded("a.md"))).toBe("workspace:a.md");
    expect(documentTabKey(loaded("a.md", "copy-1"))).toBe("archive:copy-1");
  });

  it("updates an existing tab without changing tab order", () => {
    const first = upsertDocumentTab([], loaded("a.md"));
    const two = upsertDocumentTab(first, loaded("b.md"));
    const updated = upsertDocumentTab(two, { ...loaded("a.md"), content: "new" });
    expect(updated.map((tab) => tab.path)).toEqual(["a.md", "b.md"]);
    expect(updated[0].content).toBe("new");
  });

  it("selects the neighbor after closing the active tab", () => {
    const tabs = upsertDocumentTab(upsertDocumentTab(upsertDocumentTab([], loaded("a.md")), loaded("b.md")), loaded("c.md"));
    expect(nextTabAfterClose(tabs, tabs[1].key)?.path).toBe("c.md");
    expect(nextTabAfterClose(tabs, tabs[2].key)?.path).toBe("b.md");
  });
});
