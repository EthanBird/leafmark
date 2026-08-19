import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { SlideStage } from "./components/office/PresentationEditor";
import { WordEditor } from "./components/office/WordEditor";
import { openPptx, type PresentationDocument } from "./office/slide";
import type { WordOpenResult } from "./office/types";
import { openDocx } from "./office/word";
import "./styles.css";

type GalleryTab = "word" | "ppt";

function tabFromHash(): GalleryTab {
  return window.location.hash.toLowerCase().includes("ppt") ? "ppt" : "word";
}

function OfficeGallery() {
  const [tab, setTab] = useState<GalleryTab>(tabFromHash);
  const [word, setWord] = useState<WordOpenResult | null>(null);
  const [ppt, setPpt] = useState<PresentationDocument | null>(null);
  const [error, setError] = useState("");

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
        const wordDoc = openDocx(await wordRes.arrayBuffer());
        const pptDoc = openPptx(await pptRes.arrayBuffer());
        if (!active) return;
        setWord({
          type: "word",
          editable: true,
          blocks: wordDoc.blocks.slice(0, 160),
          totalBlocks: wordDoc.blocks.length,
          firstPaintMs: 0,
          header: wordDoc.header,
          footer: wordDoc.footer,
        });
        setPpt(pptDoc);
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

  return (
    <div className="office-gallery">
      <header className="office-gallery-bar">
        <strong>LeafMark 视觉预览</strong>
        <button type="button" className={tab === "word" ? "active" : ""} onClick={() => select("word")}>Word</button>
        <button type="button" className={tab === "ppt" ? "active" : ""} onClick={() => select("ppt")}>PowerPoint</button>
        <small>{tab === "word" ? wordNote : ppt ? `${ppt.slides.length} 页 · ${ppt.slides.map((slide) => slide.title).join(" / ")}` : ""}</small>
      </header>
      {error && <p className="office-gallery-error">{error}</p>}
      {tab === "word" && word && (
        <div className="office-gallery-pane" data-gallery="word">
          <WordEditor documentKey="gallery-word" initial={word} editable onDirty={() => undefined} />
        </div>
      )}
      {tab === "ppt" && ppt && (
        <div className="office-gallery-pane office-gallery-ppt" data-gallery="ppt">
          {ppt.slides.map((slide) => (
            <section key={slide.index} className="office-gallery-slide" data-slide={slide.index}>
              <h2>第 {slide.index + 1} 页 · {slide.title}</h2>
              <div className="office-gallery-stage">
                <SlideStage slide={slide} />
              </div>
            </section>
          ))}
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
