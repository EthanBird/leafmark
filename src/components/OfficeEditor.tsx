import { openPath } from "@tauri-apps/plugin-opener";
import {
  AlertTriangle,
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  ChevronDown,
  Italic,
  Plus,
  Strikethrough,
  Underline,
} from "lucide-react";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import {
  addPresentationSlide,
  addWorkbookSheet,
  editSheetCell,
  isOfficeEditableFormat,
  loadPresentationSlide,
  loadSheetViewport,
  loadWordChunk,
  officeAssetUrl,
  openOfficeDocument,
  replaceWordBlock,
  serializeOfficeDocument,
  updatePresentationShape,
} from "../office/office-client";
import { colName } from "../office/formula";
import type { PresentationOpenResult, SpreadsheetOpenResult, WordOpenResult } from "../office/types";
import type { SlideModel } from "../office/slide";
import type { SheetViewport, ViewportCell } from "../office/sheet";
import type { WordBlock, WordParagraph } from "../office/word";
import { htmlToRuns, paragraphText } from "../office/word";
import type { DocumentKind } from "../types";

export interface OfficeEditorHandle {
  isDirty(): boolean;
  serialize(): Promise<Uint8Array>;
  markSaved(): void;
}

interface OfficeEditorProps {
  documentKey: string;
  kind: Exclude<DocumentKind, "markdown" | "unsupported">;
  format: string;
  assetPath: string;
  name: string;
  onDirtyChange: (dirty: boolean) => void;
}

const WORD_CHUNK = 160;
const ROW_H = 24;
const COL_W = 92;
const HEADER_W = 46;
const HEADER_H = 24;

export const OfficeEditor = forwardRef<OfficeEditorHandle, OfficeEditorProps>(function OfficeEditor(props, ref) {
  if (props.kind === "pdf") return <PdfViewer assetPath={props.assetPath} name={props.name} />;
  return <OfficeDocumentEditor {...props} kind={props.kind} ref={ref} />;
});

const OfficeDocumentEditor = forwardRef<OfficeEditorHandle, Omit<OfficeEditorProps, "kind"> & { kind: "word" | "spreadsheet" | "presentation" }>(
  function OfficeDocumentEditor({ documentKey, kind, format, assetPath, name, onDirtyChange }, ref) {
    const dirtyRef = useRef(false);
    const [result, setResult] = useState<WordOpenResult | SpreadsheetOpenResult | PresentationOpenResult | { type: "compatibility"; title: string; message: string } | null>(null);
    const [error, setError] = useState("");
    const markDirty = useCallback(() => {
      if (!dirtyRef.current) {
        dirtyRef.current = true;
        onDirtyChange(true);
      }
    }, [onDirtyChange]);
    const markClean = useCallback(() => {
      dirtyRef.current = false;
      onDirtyChange(false);
    }, [onDirtyChange]);

    useEffect(() => {
      let active = true;
      setResult(null);
      setError("");
      dirtyRef.current = false;
      onDirtyChange(false);
      void openOfficeDocument({ key: documentKey, kind, format, assetPath }).then(
        (value) => active && setResult(value),
        (reason) => active && setError(reason instanceof Error ? reason.message : String(reason)),
      );
      return () => { active = false; };
    }, [assetPath, documentKey, format, kind, onDirtyChange]);

    useImperativeHandle(ref, () => ({
      isDirty: () => dirtyRef.current,
      serialize: () => serializeOfficeDocument(documentKey),
      markSaved: () => markClean(),
    }), [documentKey, markClean]);

    if (error) return <ViewerMessage icon={<AlertTriangle />} title="文档解析失败" message={error} />;
    if (!result) return <ViewerLoading label={`正在秒开 ${name}`} />;
    if (result.type === "compatibility") {
      return <ViewerMessage
        icon={<AlertTriangle />}
        title={result.title}
        message={result.message}
        action={<button type="button" className="primary-button" onClick={() => void openPath(assetPath)}>使用系统应用打开保留副本</button>}
      />;
    }
    if (result.type === "word") return <WordEditor documentKey={documentKey} initial={result} editable={isOfficeEditableFormat(kind, format)} onDirty={markDirty} />;
    if (result.type === "spreadsheet") return <SpreadsheetEditor documentKey={documentKey} initial={result} onDirty={markDirty} />;
    return <PresentationEditor documentKey={documentKey} initial={result} onDirty={markDirty} />;
  },
);

function PdfViewer({ assetPath, name }: { assetPath: string; name: string }) {
  const source = useMemo(() => officeAssetUrl(assetPath), [assetPath]);
  return (
    <div className="binary-viewer pdf-viewer">
      <iframe src={source} title={`PDF：${name}`} />
    </div>
  );
}

function WordEditor({ documentKey, initial, editable, onDirty }: { documentKey: string; initial: WordOpenResult; editable: boolean; onDirty: () => void }) {
  const [blocks, setBlocks] = useState(initial.blocks);
  const [loading, setLoading] = useState(false);
  const persist = async (index: number, block: WordBlock) => {
    setBlocks((current) => current.map((item, itemIndex) => itemIndex === index ? block : item));
    onDirty();
    await replaceWordBlock(documentKey, index, block);
  };
  const loadMore = async () => {
    setLoading(true);
    try {
      const chunk = await loadWordChunk(documentKey, blocks.length, WORD_CHUNK);
      setBlocks((current) => [...current, ...chunk]);
    } finally {
      setLoading(false);
    }
  };
  const formatSelection = (command: string) => {
    document.execCommand(command);
  };
  return (
    <div className="binary-viewer word-viewer office-editor">
      {editable && (
        <div className="office-ribbon" role="toolbar" aria-label="Word 格式">
          <button type="button" onMouseDown={(event) => { event.preventDefault(); formatSelection("bold"); }} title="粗体"><Bold size={14} /></button>
          <button type="button" onMouseDown={(event) => { event.preventDefault(); formatSelection("italic"); }} title="斜体"><Italic size={14} /></button>
          <button type="button" onMouseDown={(event) => { event.preventDefault(); formatSelection("underline"); }} title="下划线"><Underline size={14} /></button>
          <button type="button" onMouseDown={(event) => { event.preventDefault(); formatSelection("strikeThrough"); }} title="删除线"><Strikethrough size={14} /></button>
          <span />
          <button type="button" onMouseDown={(event) => { event.preventDefault(); formatSelection("justifyLeft"); }} title="左对齐"><AlignLeft size={14} /></button>
          <button type="button" onMouseDown={(event) => { event.preventDefault(); formatSelection("justifyCenter"); }} title="居中"><AlignCenter size={14} /></button>
          <button type="button" onMouseDown={(event) => { event.preventDefault(); formatSelection("justifyRight"); }} title="右对齐"><AlignRight size={14} /></button>
          <span />
          <small>{initial.totalBlocks.toLocaleString()} 段 · {initial.firstPaintMs} ms 首屏</small>
        </div>
      )}
      <article className="word-page">
        {blocks.map((block, index) => <WordBlockEditor key={index} block={block} editable={editable} onChange={(next) => void persist(index, next)} />)}
        {!blocks.length && <p className="viewer-empty">开始输入文字。此文档会以 Microsoft Word OOXML 写回。</p>}
        {blocks.length < initial.totalBlocks && (
          <button className="load-document-chunk" type="button" disabled={loading} onClick={() => void loadMore()}>
            <ChevronDown size={15} /> {loading ? "正在载入…" : `继续载入（剩余 ${(initial.totalBlocks - blocks.length).toLocaleString()} 段）`}
          </button>
        )}
      </article>
    </div>
  );
}

function WordBlockEditor({ block, editable, onChange }: { block: WordBlock; editable: boolean; onChange: (block: WordBlock) => void }) {
  if (block.kind === "table") {
    return <div className="word-table-wrap"><table><tbody>{block.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td
      key={cellIndex}
      contentEditable={editable}
      suppressContentEditableWarning
      onBlur={(event) => {
        const text = event.currentTarget.innerText;
        if (text === cell.text) return;
        const rows = block.rows.map((current, currentRow) => current.map((item, currentCell) => currentRow === rowIndex && currentCell === cellIndex ? { ...item, text } : item));
        onChange({ ...block, rows, dirty: true });
      }}
    >{cell.text}</td>)}</tr>)}</tbody></table></div>;
  }
  const Tag = (block.kind === "heading" ? `h${Math.max(1, Math.min(6, block.level ?? 2))}` : "p") as "p" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
  return <Tag
    contentEditable={editable}
    suppressContentEditableWarning
    style={{ textAlign: block.align }}
    onBlur={(event) => {
      const runs = htmlToRuns(event.currentTarget.innerHTML);
      const next: WordParagraph = { ...block, runs, dirty: true };
      if (paragraphText(next) === paragraphText(block) && !event.currentTarget.querySelector("b,i,u,s,strong,em")) return;
      onChange(next);
    }}
  >{block.runs.map((run, index) => <span key={index} style={{
    color: run.color,
    fontSize: run.fontSize ? `${run.fontSize}pt` : undefined,
    fontFamily: run.font,
    fontWeight: run.bold ? 700 : undefined,
    fontStyle: run.italic ? "italic" : undefined,
    textDecoration: [run.underline ? "underline" : "", run.strike ? "line-through" : ""].filter(Boolean).join(" ") || undefined,
    whiteSpace: "pre-wrap",
  }}>{run.text}</span>)}</Tag>;
}

function SpreadsheetEditor({ documentKey, initial, onDirty }: { documentKey: string; initial: SpreadsheetOpenResult; onDirty: () => void }) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [sheets, setSheets] = useState(initial.sheets);
  const [sheetName, setSheetName] = useState(initial.active?.name ?? initial.sheets[0]?.name ?? "Sheet1");
  const [used, setUsed] = useState({ rows: initial.active?.rows ?? 0, cols: initial.active?.cols ?? 0 });
  const [cells, setCells] = useState(() => cellMap(initial.active));
  const [selection, setSelection] = useState({ row: 0, col: 0 });
  const [formula, setFormula] = useState(initial.active?.cells.find((cell) => cell.r === 0 && cell.c === 0)?.formula ?? "");
  const [editing, setEditing] = useState<string | null>(null);
  const [range, setRange] = useState({ rowStart: 0, colStart: 0, rowCount: SHEET_ROWS(), colCount: SHEET_COLS() });

  const totalRows = Math.max(used.rows + 24, 80);
  const totalCols = Math.max(used.cols + 8, 26);

  const applyViewport = (viewport: SheetViewport) => {
    setUsed({ rows: viewport.rows, cols: viewport.cols });
    setCells((current) => {
      const next = new Map(current);
      for (const cell of viewport.cells) next.set(`${cell.r}:${cell.c}`, cell);
      return next;
    });
  };

  const loadRange = useCallback(async (nextRange = range, name = sheetName) => {
    const viewport = await loadSheetViewport(documentKey, name, nextRange.rowStart, nextRange.rowCount, nextRange.colStart, nextRange.colCount);
    applyViewport(viewport);
  }, [documentKey, range, sheetName]);

  useEffect(() => {
    const node = scrollerRef.current;
    if (!node) return;
    let frame = 0;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rowStart = Math.max(0, Math.floor(node.scrollTop / ROW_H) - 4);
        const colStart = Math.max(0, Math.floor(node.scrollLeft / COL_W) - 2);
        const rowCount = Math.ceil(node.clientHeight / ROW_H) + 10;
        const colCount = Math.ceil(node.clientWidth / COL_W) + 6;
        const next = { rowStart, colStart, rowCount, colCount };
        setRange(next);
        void loadSheetViewport(documentKey, sheetName, rowStart, rowCount, colStart, colCount).then(applyViewport);
      });
    };
    node.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      node.removeEventListener("scroll", onScroll);
    };
  }, [documentKey, sheetName]);

  const selected = cells.get(`${selection.row}:${selection.col}`);
  useEffect(() => {
    setFormula(selected?.formula || selected?.display || "");
  }, [selected, selection.row, selection.col]);

  const commit = async (row: number, col: number, input: string) => {
    onDirty();
    const viewport = await editSheetCell(documentKey, sheetName, row, col, input);
    applyViewport(viewport);
    setEditing(null);
    await loadRange();
  };

  const switchSheet = async (name: string) => {
    setSheetName(name);
    setCells(new Map());
    setSelection({ row: 0, col: 0 });
    const viewport = await loadSheetViewport(documentKey, name, 0, SHEET_ROWS(), 0, SHEET_COLS());
    applyViewport(viewport);
    scrollerRef.current?.scrollTo({ top: 0, left: 0 });
  };

  const visibleRows: number[] = [];
  const visibleCols: number[] = [];
  for (let row = range.rowStart; row < Math.min(totalRows, range.rowStart + range.rowCount); row += 1) visibleRows.push(row);
  for (let col = range.colStart; col < Math.min(totalCols, range.colStart + range.colCount); col += 1) visibleCols.push(col);

  return (
    <div className="binary-viewer spreadsheet-viewer office-editor">
      <div className="office-ribbon sheet-formula-bar">
        <strong>{colName(selection.col)}{selection.row + 1}</strong>
        <input
          aria-label="公式栏"
          value={editing == null ? formula : editing}
          onChange={(event) => setEditing(event.target.value)}
          onFocus={() => setEditing(formula)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void commit(selection.row, selection.col, editing ?? formula);
            }
            if (event.key === "Escape") setEditing(null);
          }}
          onBlur={() => {
            if (editing != null && editing !== formula) void commit(selection.row, selection.col, editing);
            else setEditing(null);
          }}
        />
        <small>{used.rows.toLocaleString()} × {used.cols.toLocaleString()} · {initial.firstPaintMs} ms 首屏</small>
      </div>
      <div className="sheet-scroll sheet-virtual" ref={scrollerRef}>
        <div className="sheet-spacer" style={{ width: HEADER_W + totalCols * COL_W, height: HEADER_H + totalRows * ROW_H }}>
          <div className="sheet-corner" />
          {visibleCols.map((col) => <div key={`h${col}`} className="sheet-col-header" style={{ left: HEADER_W + col * COL_W, width: COL_W }}>{colName(col)}</div>)}
          {visibleRows.map((row) => <div key={`r${row}`} className="sheet-row-header" style={{ top: HEADER_H + row * ROW_H }}>{row + 1}</div>)}
          {visibleRows.map((row) => visibleCols.map((col) => {
            const cell = cells.get(`${row}:${col}`);
            const active = selection.row === row && selection.col === col;
            return <div
              key={`${row}:${col}`}
              className={`sheet-cell${active ? " active" : ""}${cell?.type === "n" || cell?.type === "f" ? " numeric" : ""}`}
              style={{ left: HEADER_W + col * COL_W, top: HEADER_H + row * ROW_H, width: COL_W, height: ROW_H }}
              onClick={() => { setSelection({ row, col }); setEditing(null); }}
              onDoubleClick={() => setEditing(cell?.formula || cell?.display || "")}
            >{cell?.display ?? ""}</div>;
          }))}
          {editing != null && (
            <input
              className="sheet-cell-input"
              style={{ left: HEADER_W + selection.col * COL_W, top: HEADER_H + selection.row * ROW_H, width: COL_W, height: ROW_H }}
              value={editing}
              autoFocus
              onChange={(event) => setEditing(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void commit(selection.row, selection.col, editing).then(() => setSelection({ row: selection.row + 1, col: selection.col }));
                } else if (event.key === "Tab") {
                  event.preventDefault();
                  void commit(selection.row, selection.col, editing).then(() => setSelection({ row: selection.row, col: selection.col + 1 }));
                } else if (event.key === "Escape") setEditing(null);
              }}
              onBlur={() => { if (editing !== (selected?.formula || selected?.display || "")) void commit(selection.row, selection.col, editing); else setEditing(null); }}
            />
          )}
        </div>
      </div>
      <nav className="sheet-tabs" aria-label="工作表">
        {sheets.map((item) => <button type="button" key={item.name} className={sheetName === item.name ? "active" : ""} onClick={() => void switchSheet(item.name)}>{item.name}</button>)}
        <button type="button" className="sheet-add" title="新建工作表" onClick={() => void addWorkbookSheet(documentKey).then((result) => { setSheets(result.sheets); onDirty(); void switchSheet(result.name); })}><Plus size={12} /></button>
      </nav>
    </div>
  );
}

function SHEET_ROWS() {
  return 80;
}
function SHEET_COLS() {
  return 26;
}

function cellMap(viewport: SheetViewport | null | undefined) {
  const map = new Map<string, ViewportCell>();
  for (const cell of viewport?.cells ?? []) map.set(`${cell.r}:${cell.c}`, cell);
  return map;
}

function PresentationEditor({ documentKey, initial, onDirty }: { documentKey: string; initial: PresentationOpenResult; onDirty: () => void }) {
  const [slides, setSlides] = useState(initial.slides);
  const [slide, setSlide] = useState<SlideModel | null>(initial.active);
  const [loading, setLoading] = useState(false);
  const openSlide = async (index: number) => {
    setLoading(true);
    try { setSlide(await loadPresentationSlide(documentKey, index)); }
    finally { setLoading(false); }
  };
  const editShape = async (shapeId: string, text: string) => {
    if (!slide) return;
    onDirty();
    const next = await updatePresentationShape(documentKey, slide.index, shapeId, text);
    setSlide(next);
    setSlides((current) => current.map((item) => item.index === next?.index ? { index: next.index, title: next.title } : item));
  };
  return (
    <div className="binary-viewer presentation-viewer office-editor">
      <nav className="slide-list" aria-label="幻灯片">
        {slides.map((item) => <button type="button" key={item.index} className={slide?.index === item.index ? "active" : ""} onClick={() => void openSlide(item.index)}><span>{item.index + 1}</span><strong>{item.title}</strong></button>)}
        <button type="button" className="slide-add" onClick={() => void addPresentationSlide(documentKey).then((result) => { setSlides(result.slides); setSlide(result.slide); onDirty(); })}><Plus size={12} /> 新建幻灯片</button>
      </nav>
      <div className="slide-stage">
        {loading && !slide ? <ViewerLoading label="正在载入幻灯片" /> : slide && <div className="slide-canvas" style={{ background: slide.background }}>
          {slide.shapes.map((shape) => <div
            key={shape.id}
            className="slide-shape"
            contentEditable
            suppressContentEditableWarning
            style={{
              left: `${shape.x * 100}%`,
              top: `${shape.y * 100}%`,
              width: `${shape.width * 100}%`,
              height: `${shape.height * 100}%`,
              fontSize: `${shape.fontSize}px`,
              color: shape.color,
              fontWeight: shape.bold ? 700 : 400,
              fontStyle: shape.italic ? "italic" : "normal",
              textAlign: shape.align,
            }}
            onBlur={(event) => {
              const text = event.currentTarget.innerText.replace(/\n$/, "");
              if (text !== shape.text) void editShape(shape.id, text);
            }}
          >{shape.text}</div>)}
          {slide.imageCount > 0 && <span className="slide-media-note">此页包含 {slide.imageCount} 张图片；原件媒体随 OOXML 包无损保留</span>}
        </div>}
      </div>
    </div>
  );
}

function ViewerLoading({ label }: { label: string }) {
  return <div className="viewer-loading" role="status"><span /><strong>{label}</strong><small>解析在独立线程中进行，窗口立刻可操作</small></div>;
}

function ViewerMessage({ icon, title, message, action }: { icon: React.ReactNode; title: string; message: string; action?: React.ReactNode }) {
  return <div className="viewer-message">{icon}<h2>{title}</h2><p>{message}</p>{action}</div>;
}
