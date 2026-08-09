import { openPath } from "@tauri-apps/plugin-opener";
import { AlertTriangle, ChevronDown, FileSpreadsheet, FileText, MonitorPlay } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  loadPresentationSlide,
  loadSheetChunk,
  loadWordChunk,
  officeAssetUrl,
  openViewerDocument,
} from "../document-viewer-client";
import type {
  PresentationDocumentResult,
  PresentationSlide,
  SpreadsheetDocumentResult,
  SpreadsheetSheet,
  ViewerResult,
  WordBlock,
  WordDocumentResult,
} from "../document-viewer-types";
import type { DocumentKind } from "../types";

interface DocumentViewerProps {
  documentKey: string;
  kind: Exclude<DocumentKind, "markdown" | "unsupported">;
  format: string;
  assetPath: string;
  name: string;
}

export function DocumentViewer(props: DocumentViewerProps) {
  if (props.kind === "pdf") return <PdfViewer assetPath={props.assetPath} name={props.name} />;
  return <OfficeViewer {...props} kind={props.kind} />;
}

function PdfViewer({ assetPath, name }: { assetPath: string; name: string }) {
  const source = useMemo(() => officeAssetUrl(assetPath), [assetPath]);
  return (
    <div className="binary-viewer pdf-viewer">
      <iframe src={source} title={`PDF：${name}`} />
    </div>
  );
}

function OfficeViewer({ documentKey, kind, format, assetPath, name }: Omit<DocumentViewerProps, "kind"> & { kind: "word" | "spreadsheet" | "presentation" }) {
  const [result, setResult] = useState<ViewerResult | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setResult(null);
    setError("");
    void openViewerDocument({ key: documentKey, kind, format, assetPath }).then(
      (value) => active && setResult(value),
      (reason) => active && setError(reason instanceof Error ? reason.message : String(reason)),
    );
    return () => { active = false; };
  }, [assetPath, documentKey, format, kind]);

  if (error) return <ViewerMessage icon={<AlertTriangle />} title="文档解析失败" message={error} />;
  if (!result) return <ViewerLoading label={`正在快速解析 ${name}`} />;
  if (result.type === "compatibility") {
    return <ViewerMessage
      icon={<AlertTriangle />}
      title={result.title}
      message={result.message}
      action={<button type="button" className="primary-button" onClick={() => void openPath(assetPath)}>使用系统应用打开保留副本</button>}
    />;
  }
  if (result.type === "word") return <WordViewer documentKey={documentKey} initial={result} />;
  if (result.type === "spreadsheet") return <SpreadsheetViewer documentKey={documentKey} initial={result} />;
  return <PresentationViewer documentKey={documentKey} initial={result} />;
}

function WordViewer({ documentKey, initial }: { documentKey: string; initial: WordDocumentResult }) {
  const [blocks, setBlocks] = useState(initial.blocks);
  const [loading, setLoading] = useState(false);
  const loadMore = async () => {
    setLoading(true);
    try {
      const chunk = await loadWordChunk(documentKey, blocks.length);
      setBlocks((current) => [...current, ...chunk]);
    } finally {
      setLoading(false);
    }
  };
  return (
    <div className="binary-viewer word-viewer">
      <article className="word-page">
        {blocks.map((block, index) => <WordBlockView key={index} block={block} />)}
        {!blocks.length && <p className="viewer-empty">文档中没有可显示的文本。</p>}
        {blocks.length < initial.totalBlocks && (
          <button className="load-document-chunk" type="button" disabled={loading} onClick={() => void loadMore()}>
            <ChevronDown size={15} /> {loading ? "正在载入…" : `继续载入（剩余 ${(initial.totalBlocks - blocks.length).toLocaleString()} 段）`}
          </button>
        )}
      </article>
    </div>
  );
}

function WordBlockView({ block }: { block: WordBlock }) {
  if (block.kind === "heading") {
    const level = Math.max(1, Math.min(6, block.level ?? 2));
    const Heading = `h${level}` as keyof React.JSX.IntrinsicElements;
    return <Heading>{block.text}</Heading>;
  }
  if (block.kind === "table") {
    return <div className="word-table-wrap"><table><tbody>{block.rows?.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>)}</tbody></table></div>;
  }
  return <p>{block.text}</p>;
}

function SpreadsheetViewer({ documentKey, initial }: { documentKey: string; initial: SpreadsheetDocumentResult }) {
  const [sheet, setSheet] = useState<SpreadsheetSheet | null>(initial.active);
  const [loading, setLoading] = useState(false);
  const switchSheet = async (name: string) => {
    setLoading(true);
    try { setSheet(await loadSheetChunk(documentKey, name, 0, 120)); }
    finally { setLoading(false); }
  };
  const loadMore = async () => {
    if (!sheet) return;
    setLoading(true);
    try {
      const next = await loadSheetChunk(documentKey, sheet.name, sheet.rows.length, 200);
      setSheet((current) => current ? { ...current, rows: [...current.rows, ...next.rows] } : next);
    } finally { setLoading(false); }
  };
  return (
    <div className="binary-viewer spreadsheet-viewer">
      <nav className="sheet-tabs" aria-label="工作表">
        {initial.sheets.map((item) => <button type="button" key={item.name} className={sheet?.name === item.name ? "active" : ""} onClick={() => void switchSheet(item.name)} title={`${item.rows.toLocaleString()} 行 × ${item.columns.toLocaleString()} 列`}>{item.name}</button>)}
      </nav>
      <div className="sheet-scroll">
        {loading && !sheet ? <ViewerLoading label="正在载入工作表" /> : sheet && <table className="sheet-grid"><tbody>
          {sheet.rows.map((row, rowIndex) => <tr key={rowIndex}>
            <th>{sheet.startRow + rowIndex + 1}</th>
            {row.map((cell, columnIndex) => <td key={columnIndex} title={cell}>{cell}</td>)}
          </tr>)}
        </tbody></table>}
        {sheet && sheet.rows.length < sheet.totalRows && <button type="button" className="load-sheet-rows" disabled={loading} onClick={() => void loadMore()}>{loading ? "正在载入…" : `载入后续行（共 ${sheet.totalRows.toLocaleString()} 行）`}</button>}
      </div>
      {sheet && sheet.totalColumns > 160 && <div className="viewer-limit-note">为保持流畅，当前显示前 160 列；文档原件未被修改。</div>}
    </div>
  );
}

function PresentationViewer({ documentKey, initial }: { documentKey: string; initial: PresentationDocumentResult }) {
  const [slide, setSlide] = useState<PresentationSlide | null>(initial.active);
  const [loading, setLoading] = useState(false);
  const openSlide = async (index: number) => {
    setLoading(true);
    try { setSlide(await loadPresentationSlide(documentKey, index)); }
    finally { setLoading(false); }
  };
  return (
    <div className="binary-viewer presentation-viewer">
      <nav className="slide-list" aria-label="幻灯片">
        {initial.slides.map((item) => <button type="button" key={item.index} className={slide?.index === item.index ? "active" : ""} onClick={() => void openSlide(item.index)}><span>{item.index + 1}</span><strong>{item.title}</strong></button>)}
      </nav>
      <div className="slide-stage">
        {loading && !slide ? <ViewerLoading label="正在载入幻灯片" /> : slide && <SlideCanvas slide={slide} />}
      </div>
    </div>
  );
}

function SlideCanvas({ slide }: { slide: PresentationSlide }) {
  return <div className="slide-canvas" style={{ background: slide.background }}>
    {slide.shapes.map((shape, index) => <div key={index} className="slide-shape" style={{
      left: `${shape.x * 100}%`, top: `${shape.y * 100}%`, width: `${shape.width * 100}%`, height: `${shape.height * 100}%`,
      fontSize: `${shape.fontSize}px`, color: shape.color, fontWeight: shape.bold ? 700 : 400, textAlign: shape.align,
    }}>{shape.text}</div>)}
    {slide.imageCount > 0 && <span className="slide-media-note">此页包含 {slide.imageCount} 张图片；极速文本预览暂不展开媒体</span>}
  </div>;
}

function ViewerLoading({ label }: { label: string }) {
  return <div className="viewer-loading" role="status"><span /><strong>{label}</strong><small>解析在独立线程中进行，界面仍可操作</small></div>;
}

function ViewerMessage({ icon, title, message, action }: { icon: React.ReactNode; title: string; message: string; action?: React.ReactNode }) {
  return <div className="viewer-message">{icon}<h2>{title}</h2><p>{message}</p>{action}</div>;
}

export function documentKindIcon(kind: DocumentKind) {
  if (kind === "spreadsheet") return FileSpreadsheet;
  if (kind === "presentation") return MonitorPlay;
  return FileText;
}
