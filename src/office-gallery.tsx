import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { PresentationEditor } from "./components/office/PresentationEditor";
import { SpreadsheetEditor } from "./components/office/SpreadsheetEditor";
import { WordEditor } from "./components/office/WordEditor";
import { openOfficeFromBuffer } from "./office/office-client";
import type { PresentationOpenResult, SpreadsheetOpenResult, WordOpenResult } from "./office/types";
import "./styles.css";

type GalleryTab = "word" | "ppt" | "excel";

function tabFromHash(): GalleryTab {
  const hash = window.location.hash.toLowerCase();
  if (hash.includes("ppt")) return "ppt";
  if (hash.includes("excel") || hash.includes("xlsx") || hash.includes("sheet")) return "excel";
  return "word";
}

function OfficeGallery() {
  const [tab, setTab] = useState<GalleryTab>(tabFromHash);
  const [word, setWord] = useState<WordOpenResult | null>(null);
  const [ppt, setPpt] = useState<PresentationOpenResult | null>(null);
  const [excel, setExcel] = useState<SpreadsheetOpenResult | null>(null);
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
        const [wordRes, pptRes, excelRes] = await Promise.all([
          fetch("/office-fixtures/leafmark-sample.docx"),
          fetch("/office-fixtures/leafmark-sample.pptx"),
          fetch("/office-fixtures/leafmark-sample.xlsx"),
        ]);
        if (!wordRes.ok || !pptRes.ok || !excelRes.ok) throw new Error("无法读取视觉样张");
        const wordSnap = await openOfficeFromBuffer({ key: "gallery-word", kind: "word", format: "docx" }, await wordRes.arrayBuffer());
        const pptSnap = await openOfficeFromBuffer({ key: "gallery-ppt", kind: "presentation", format: "pptx" }, await pptRes.arrayBuffer());
        const excelSnap = await openOfficeFromBuffer({ key: "gallery-excel", kind: "spreadsheet", format: "xlsx" }, await excelRes.arrayBuffer());
        if (!active) return;
        if (wordSnap.type !== "word") throw new Error("Word 样张未能打开为可编辑文档");
        if (pptSnap.type !== "presentation") throw new Error("PPT 样张未能打开为可编辑文档");
        if (excelSnap.type !== "spreadsheet") throw new Error("Excel 样张未能打开为可编辑表格");
        setWord(wordSnap);
        setPpt(pptSnap);
        setExcel(excelSnap);
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

  const excelNote = useMemo(() => {
    if (!excel?.active) return "";
    const merges = excel.active.merges?.length ?? 0;
    const freeze = excel.active.freeze;
    const widths = excel.active.colWidths?.length ?? 0;
    return `${excel.active.name} · 合并 ${merges} · 冻结 ${freeze?.row ?? 0},${freeze?.col ?? 0} · 列宽 ${widths}`;
  }, [excel]);

  const select = (next: GalleryTab) => {
    window.location.hash = next;
    setTab(next);
  };

  const markDirty = () => setDirty(true);
  const ready = Boolean(word && ppt && excel);

  return (
    <div className="office-gallery" data-gallery-ready={ready ? "1" : "0"} data-dirty={dirty ? "1" : "0"}>
      <header className="office-gallery-bar">
        <strong>LeafMark 视觉预览</strong>
        <button type="button" className={tab === "word" ? "active" : ""} onClick={() => select("word")}>Word</button>
        <button type="button" className={tab === "ppt" ? "active" : ""} onClick={() => select("ppt")}>PowerPoint</button>
        <button type="button" className={tab === "excel" ? "active" : ""} onClick={() => select("excel")}>Excel</button>
        <small>
          {dirty ? "已修改 · " : ""}
          {tab === "word" ? wordNote : tab === "ppt" ? (ppt ? `${ppt.slides.length} 页 · ${ppt.slides.map((slide) => slide.title).join(" / ")}` : "") : excelNote}
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
      {tab === "excel" && excel && (
        <div className="office-gallery-pane" data-gallery="excel">
          <SpreadsheetEditor documentKey="gallery-excel" initial={excel} onDirty={markDirty} />
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
