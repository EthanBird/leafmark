import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { PresentationEditor } from "./components/office/PresentationEditor";
import { WordEditor } from "./components/office/WordEditor";
import { openOfficeFromBuffer } from "./office/office-client";
import type { PresentationOpenResult, WordOpenResult } from "./office/types";
import "./styles.css";

type GalleryTab = "word" | "ppt";

function tabFromHash(): GalleryTab {
  return window.location.hash.toLowerCase().includes("ppt") ? "ppt" : "word";
}

function OfficeGallery() {
  const [tab, setTab] = useState<GalleryTab>(tabFromHash);
  const [word, setWord] = useState<WordOpenResult | null>(null);
  const [ppt, setPpt] = useState<PresentationOpenResult | null>(null);
  const [error, setError] = useState("");
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    const onHash = () => setTab(tabFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const [wordRes, pptRes] = await Promise.all([
          fetch("/office-fixtures/leafmark-sample.docx"),
          fetch("/office-fixtures/leafmark-sample.pptx"),
        ]);
        if (!wordRes.ok || !pptRes.ok) throw new Error("无法读取视觉样张");
        const wordSnap = await openOfficeFromBuffer({ key: "gallery-word", kind: "word", format: "docx" }, await wordRes.arrayBuffer());
        const pptSnap = await openOfficeFromBuffer({ key: "gallery-ppt", kind: "presentation", format: "pptx" }, await pptRes.arrayBuffer());
        if (!active) return;
        if (wordSnap.type !== "word") throw new Error("Word 样张未能打开为可编辑文档");
        if (pptSnap.type !== "presentation") throw new Error("PPT 样张未能打开为可编辑文档");
        setWord(wordSnap);
        setPpt(pptSnap);
      } catch (reason) {
        if (active) setError(reason instanceof Error ? reason.message : String(reason));
      }
    })();
    return () => { active = false; };
  }, []);

  const wordNote = useMemo(() => {
    if (!word) return "";
    const images = word.blocks.flatMap((block) => block.kind === "table" ? [] : block.runs.filter((run) => run.image));
    const link = word.blocks.flatMap((block) => block.kind === "table" ? [] : block.runs.map((run) => run.hyperlink).filter(Boolean))[0];
    const table = word.blocks.find((block) => block.kind === "table");
    const merges = table && table.kind === "table"
      ? table.rows.flat().filter((cell) => cell.colSpan || cell.rowSpan || cell.hidden).length
      : 0;
    return `图片 ${images.length} · 超链接 ${link || "无"} · 表格合并 ${merges} · 页眉 ${word.header || "无"}`;
  }, [word]);

  const select = (next: GalleryTab) => {
    window.location.hash = next;
    setTab(next);
  };

  const markDirty = () => setDirty(true);

  return (
    <div className="office-gallery" data-gallery-ready={word && ppt ? "1" : "0"} data-dirty={dirty ? "1" : "0"}>
      <header className="office-gallery-bar">
        <strong>LeafMark 视觉预览</strong>
        <button type="button" className={tab === "word" ? "active" : ""} onClick={() => select("word")}>Word</button>
        <button type="button" className={tab === "ppt" ? "active" : ""} onClick={() => select("ppt")}>PowerPoint</button>
        <small>
          {dirty ? "已修改 · " : ""}
          {tab === "word" ? wordNote : ppt ? `${ppt.slides.length} 页 · ${ppt.slides.map((slide) => slide.title).join(" / ")}` : ""}
        </small>
      </header>
      {error && <p className="office-gallery-error" data-gallery-error>{error}</p>}
      {tab === "word" && word && (
        <div className="office-gallery-pane" data-gallery="word">
          <WordEditor documentKey="gallery-word" initial={word} editable onDirty={markDirty} />
        </div>
      )}
      {tab === "ppt" && ppt && (
        <div className="office-gallery-pane" data-gallery="ppt">
          <PresentationEditor documentKey="gallery-ppt" initial={ppt} onDirty={markDirty} />
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <OfficeGallery />
  </StrictMode>,
);
