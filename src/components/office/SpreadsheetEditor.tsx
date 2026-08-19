import { AlignCenter, AlignLeft, AlignRight, Bold, ClipboardPaste, Columns3, Copy, Filter, Italic, Plus, Redo2, Rows3, Trash2, Underline, Undo2, WrapText } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { colName } from "../../office/formula";
import {
  addWorkbookSheet,
  copySheetRange,
  editSheetCell,
  loadSheetViewport,
  mutateOffice,
  redoOffice,
  undoOffice,
} from "../../office/office-client";
import { a1Range } from "../../office/office-agent";
import type { CellFormat, SheetMerge, SheetViewport, ViewportCell } from "../../office/sheet";
import type { SpreadsheetOpenResult } from "../../office/types";
import { AskAiRibbonButton } from "../AskAiToolbar";

const ROW_H = 24;
const COL_W = 92;
const HEADER_W = 46;
const HEADER_H = 24;
const NUM_FMTS: Array<{ value: CellFormat["numFmt"]; label: string }> = [
  { value: "general", label: "常规" },
  { value: "number", label: "数值" },
  { value: "currency", label: "货币" },
  { value: "percent", label: "百分比" },
  { value: "date", label: "日期" },
  { value: "scientific", label: "科学计数" },
  { value: "text", label: "文本" },
];

export function SpreadsheetEditor({ documentKey, initial, onDirty }: { documentKey: string; initial: SpreadsheetOpenResult; onDirty: () => void }) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const clipboard = useRef<string[][]>([]);
  const [sheets, setSheets] = useState(initial.sheets);
  const [sheetName, setSheetName] = useState(initial.active?.name ?? initial.sheets[0]?.name ?? "Sheet1");
  const [used, setUsed] = useState({ rows: initial.active?.rows ?? 0, cols: initial.active?.cols ?? 0 });
  const [cells, setCells] = useState(() => cellMap(initial.active));
  const [merges, setMerges] = useState<SheetMerge[]>(initial.active?.merges ?? []);
  const [freeze, setFreeze] = useState(initial.active?.freeze ?? { row: 0, col: 0 });
  const [selection, setSelection] = useState({ row: 0, col: 0, row2: 0, col2: 0 });
  const [formula, setFormula] = useState(initial.active?.cells.find((cell) => cell.r === 0 && cell.c === 0)?.formula ?? "");
  const [editing, setEditing] = useState<string | null>(null);
  const [range, setRange] = useState({ rowStart: 0, colStart: 0, rowCount: 80, colCount: 26 });
  const [tab, setTab] = useState<"home" | "data">("home");

  const totalRows = Math.max(used.rows + 24, 80);
  const totalCols = Math.max(used.cols + 8, 26);
  const rowStartSel = Math.min(selection.row, selection.row2);
  const rowEndSel = Math.max(selection.row, selection.row2);
  const colStartSel = Math.min(selection.col, selection.col2);
  const colEndSel = Math.max(selection.col, selection.col2);
  const selected = cells.get(`${selection.row}:${selection.col}`);

  const applyViewport = (viewport: SheetViewport) => {
    setUsed({ rows: viewport.rows, cols: viewport.cols });
    setSheetName(viewport.name);
    if (viewport.merges) setMerges(viewport.merges);
    if (viewport.freeze) setFreeze(viewport.freeze);
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

  const run = async (mutation: Parameters<typeof mutateOffice>[1]) => {
    onDirty();
    const result = await mutateOffice(documentKey, mutation) as { sheets?: Array<{ name: string; rows: number; cols: number }>; name?: string };
    if (result.sheets) setSheets(result.sheets);
    if (result.name) setSheetName(result.name);
    setCells(new Map());
    await loadRange();
  };

  const switchSheet = async (name: string) => {
    setSheetName(name);
    setCells(new Map());
    setSelection({ row: 0, col: 0, row2: 0, col2: 0 });
    const viewport = await loadSheetViewport(documentKey, name, 0, 80, 0, 26);
    applyViewport(viewport);
    scrollerRef.current?.scrollTo({ top: 0, left: 0 });
  };

  const history = async (direction: "undo" | "redo") => {
    const result = direction === "undo" ? await undoOffice(documentKey) : await redoOffice(documentKey);
    if (!result.ok) return;
    onDirty();
    if (result.snapshot.type === "spreadsheet") setSheets(result.snapshot.sheets);
    setCells(new Map());
    await loadRange();
  };

  const copy = async () => {
    clipboard.current = await copySheetRange(documentKey, sheetName, rowStartSel, colStartSel, rowEndSel - rowStartSel + 1, colEndSel - colStartSel + 1);
    try {
      await navigator.clipboard.writeText(clipboard.current.map((line) => line.join("\t")).join("\n"));
    } catch {
      /* 无剪贴板权限时仍保留内存副本 */
    }
  };

  const paste = async (text?: string) => {
    const raw = text ?? clipboard.current.map((line) => line.join("\t")).join("\n");
    const values = raw.split(/\r?\n/).map((line) => line.split("\t"));
    if (!values.length || (values.length === 1 && values[0].length === 1 && values[0][0] === "")) return;
    await run({ op: "sheetPaste", name: sheetName, row: selection.row, col: selection.col, values });
  };

  const formatSel = (format: CellFormat) => run({
    op: "sheetFormat",
    name: sheetName,
    row: rowStartSel,
    col: colStartSel,
    rowCount: rowEndSel - rowStartSel + 1,
    colCount: colEndSel - colStartSel + 1,
    format,
  });

  useEffect(() => {
    const node = rootRef.current;
    if (!node) return;
    const onKey = (event: KeyboardEvent) => {
      const meta = event.ctrlKey || event.metaKey;
      if (editing != null && event.key !== "Escape" && !meta) return;
      if (meta && event.key.toLowerCase() === "z") { event.preventDefault(); void history(event.shiftKey ? "redo" : "undo"); return; }
      if (meta && event.key.toLowerCase() === "y") { event.preventDefault(); void history("redo"); return; }
      if (meta && event.key.toLowerCase() === "c") { event.preventDefault(); void copy(); return; }
      if (meta && event.key.toLowerCase() === "b") { event.preventDefault(); void formatSel({ bold: !selected?.bold }); return; }
      if (meta && event.key.toLowerCase() === "v") {
        event.preventDefault();
        void navigator.clipboard.readText().then((text) => paste(text)).catch(() => paste());
        return;
      }
      if (meta && event.key.toLowerCase() === "d") {
        event.preventDefault();
        void run({ op: "sheetFill", name: sheetName, row: rowStartSel, col: colStartSel, rowCount: rowEndSel - rowStartSel + 1, colCount: colEndSel - colStartSel + 1 });
        return;
      }
      if (meta && event.key.toLowerCase() === "r") {
        event.preventDefault();
        void run({ op: "sheetFillRight", name: sheetName, row: rowStartSel, col: colStartSel, rowCount: rowEndSel - rowStartSel + 1, colCount: colEndSel - colStartSel + 1 });
        return;
      }
      if (editing != null) return;
      if (event.key === "F2") { event.preventDefault(); setEditing(selected?.formula || selected?.display || ""); return; }
      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        void commit(selection.row, selection.col, "");
        return;
      }
      const move = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1], Enter: [1, 0], Tab: [0, event.shiftKey ? -1 : 1] }[event.key];
      if (!move) return;
      event.preventDefault();
      const row = Math.max(0, selection.row + move[0]);
      const col = Math.max(0, selection.col + move[1]);
      if (event.shiftKey && event.key.startsWith("Arrow")) setSelection((current) => ({ ...current, row2: row, col2: col }));
      else setSelection({ row, col, row2: row, col2: col });
    };
    node.addEventListener("keydown", onKey);
    return () => node.removeEventListener("keydown", onKey);
  }, [editing, selection, selected, sheetName, documentKey]);

  const visibleRows: number[] = [];
  const visibleCols: number[] = [];
  for (let row = range.rowStart; row < Math.min(totalRows, range.rowStart + range.rowCount); row += 1) visibleRows.push(row);
  for (let col = range.colStart; col < Math.min(totalCols, range.colStart + range.colCount); col += 1) visibleCols.push(col);

  const covered = (row: number, col: number) => merges.some((item) => !(item.r === row && item.c === col) && row >= item.r && row < item.r + item.rows && col >= item.c && col < item.c + item.cols);

  return (
    <div className="binary-viewer spreadsheet-viewer office-editor" ref={rootRef} tabIndex={0}>
      <div className="office-ribbon-wrap">
        <div className="office-ribbon-tabs" role="tablist">
          <button type="button" className={tab === "home" ? "active" : ""} onClick={() => setTab("home")}>开始</button>
          <button type="button" className={tab === "data" ? "active" : ""} onClick={() => setTab("data")}>数据</button>
        </div>
        <div className="office-ribbon sheet-toolbar">
          <button type="button" title="撤销" onClick={() => void history("undo")}><Undo2 size={14} /></button>
          <button type="button" title="重做" onClick={() => void history("redo")}><Redo2 size={14} /></button>
          <span />
          {tab === "home" && (
            <>
              <button type="button" title="复制" onClick={() => void copy()}><Copy size={14} /></button>
              <AskAiRibbonButton
                getSelection={async () => {
                  const values = await copySheetRange(documentKey, sheetName, rowStartSel, colStartSel, rowEndSel - rowStartSel + 1, colEndSel - colStartSel + 1);
                  const text = values.map((line) => line.join("\t")).join("\n").trim();
                  if (!text) return null;
                  return {
                    text,
                    kind: "spreadsheet",
                    location: `${sheetName}!${a1Range(rowStartSel, colStartSel, rowEndSel - rowStartSel + 1, colEndSel - colStartSel + 1)}`,
                  };
                }}
              />
              <button type="button" title="粘贴" onClick={() => void paste()}><ClipboardPaste size={14} /></button>
              <button type="button" title="向下填充" onClick={() => void run({ op: "sheetFill", name: sheetName, row: rowStartSel, col: colStartSel, rowCount: rowEndSel - rowStartSel + 1, colCount: colEndSel - colStartSel + 1 })}>↓填</button>
              <button type="button" title="向右填充" onClick={() => void run({ op: "sheetFillRight", name: sheetName, row: rowStartSel, col: colStartSel, rowCount: rowEndSel - rowStartSel + 1, colCount: colEndSel - colStartSel + 1 })}>→填</button>
              <span />
              <button type="button" title="加粗" onClick={() => void formatSel({ bold: !selected?.bold })}><Bold size={14} /></button>
              <button type="button" title="斜体" onClick={() => void formatSel({ italic: true })}><Italic size={14} /></button>
              <button type="button" title="下划线" onClick={() => void formatSel({ underline: true })}><Underline size={14} /></button>
              <button type="button" title="自动换行" onClick={() => void formatSel({ wrap: !selected?.wrap })}><WrapText size={14} /></button>
              <button type="button" title="左对齐" onClick={() => void formatSel({ align: "left" })}><AlignLeft size={14} /></button>
              <button type="button" title="居中" onClick={() => void formatSel({ align: "center" })}><AlignCenter size={14} /></button>
              <button type="button" title="右对齐" onClick={() => void formatSel({ align: "right" })}><AlignRight size={14} /></button>
              <label className="office-color" title="字体颜色"><input type="color" value={selected?.color || "#202124"} onChange={(event) => void formatSel({ color: event.target.value })} /></label>
              <label className="office-color" title="填充色"><input type="color" value={selected?.fill || "#ffffff"} onChange={(event) => void formatSel({ fill: event.target.value })} /></label>
              <select aria-label="数字格式" value="general" onChange={(event) => void formatSel({ numFmt: event.target.value as CellFormat["numFmt"] })}>
                {NUM_FMTS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
              </select>
              <button type="button" title="合并单元格" onClick={() => void run({ op: "sheetMerge", name: sheetName, row: rowStartSel, col: colStartSel, rowCount: rowEndSel - rowStartSel + 1, colCount: colEndSel - colStartSel + 1, merge: true })}>合并</button>
              <button type="button" title="取消合并" onClick={() => void run({ op: "sheetMerge", name: sheetName, row: rowStartSel, col: colStartSel, rowCount: 1, colCount: 1, merge: false })}>取消合并</button>
              <button type="button" title="自动求和" onClick={() => void run({ op: "sheetAutoSum", name: sheetName, row: rowStartSel, col: colStartSel, rowCount: rowEndSel - rowStartSel + 1, colCount: colEndSel - colStartSel + 1 })}>Σ</button>
              <span />
              <button type="button" title="插入行" onClick={() => void run({ op: "sheetInsert", name: sheetName, axis: "row", index: selection.row, count: 1 })}><Rows3 size={14} /></button>
              <button type="button" title="插入列" onClick={() => void run({ op: "sheetInsert", name: sheetName, axis: "col", index: selection.col, count: 1 })}><Columns3 size={14} /></button>
              <button type="button" title="删除行" onClick={() => void run({ op: "sheetDelete", name: sheetName, axis: "row", index: selection.row, count: 1 })}><Trash2 size={14} /></button>
              <button type="button" title="删除列" onClick={() => void run({ op: "sheetDelete", name: sheetName, axis: "col", index: selection.col, count: 1 })}>删列</button>
              <label className="office-field">列宽 <input type="number" min={4} max={80} defaultValue={10} onBlur={(event) => void run({ op: "sheetWidth", name: sheetName, col: selection.col, width: Number(event.target.value) || 10 })} /></label>
            </>
          )}
          {tab === "data" && (
            <>
              <button type="button" title="升序" onClick={() => void run({ op: "sheetSort", name: sheetName, row: rowStartSel, col: colStartSel, rowCount: rowEndSel - rowStartSel + 1, colCount: colEndSel - colStartSel + 1, sortCol: 0, ascending: true })}>升序</button>
              <button type="button" title="降序" onClick={() => void run({ op: "sheetSort", name: sheetName, row: rowStartSel, col: colStartSel, rowCount: rowEndSel - rowStartSel + 1, colCount: colEndSel - colStartSel + 1, sortCol: 0, ascending: false })}>降序</button>
              <button type="button" title="自动筛选" onClick={() => void run({ op: "sheetFilter", name: sheetName, row: rowStartSel, col: colStartSel, rowCount: rowEndSel - rowStartSel + 1, colCount: colEndSel - colStartSel + 1 })}><Filter size={14} /> 筛选</button>
              <button type="button" title="冻结窗格" onClick={() => void run({ op: "sheetFreeze", name: sheetName, row: selection.row, col: selection.col })}>冻结</button>
              <button type="button" title="取消冻结" onClick={() => void run({ op: "sheetFreeze", name: sheetName, row: 0, col: 0 })}>取消冻结</button>
            </>
          )}
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
          <small>{used.rows.toLocaleString()} × {used.cols.toLocaleString()}{freeze.row || freeze.col ? ` · 冻结 ${freeze.row},${freeze.col}` : ""}</small>
        </div>
      </div>
      <div className="sheet-scroll sheet-virtual" ref={scrollerRef}>
        <div className="sheet-spacer" style={{ width: HEADER_W + totalCols * COL_W, height: HEADER_H + totalRows * ROW_H }}>
          <div className="sheet-corner" />
          {visibleCols.map((col) => <div key={`h${col}`} className="sheet-col-header" style={{ left: HEADER_W + col * COL_W, width: COL_W }}>{colName(col)}</div>)}
          {visibleRows.map((row) => <div key={`r${row}`} className="sheet-row-header" style={{ top: HEADER_H + row * ROW_H }}>{row + 1}</div>)}
          {visibleRows.map((row) => visibleCols.map((col) => {
            if (covered(row, col)) return null;
            const cell = cells.get(`${row}:${col}`);
            const merge = merges.find((item) => item.r === row && item.c === col);
            const active = selection.row === row && selection.col === col;
            const inRange = row >= rowStartSel && row <= rowEndSel && col >= colStartSel && col <= colEndSel;
            return <div
              key={`${row}:${col}`}
              className={`sheet-cell${active ? " active" : ""}${inRange ? " selected" : ""}${cell?.type === "n" || cell?.type === "f" ? " numeric" : ""}${cell?.wrap ? " wrap" : ""}`}
              style={{
                left: HEADER_W + col * COL_W,
                top: HEADER_H + row * ROW_H,
                width: COL_W * (merge?.cols ?? 1),
                height: ROW_H * (merge?.rows ?? 1),
                fontWeight: cell?.bold ? 700 : undefined,
                color: cell?.color,
                background: cell?.fill,
                textAlign: cell?.align as "left" | "center" | "right" | undefined,
                whiteSpace: cell?.wrap ? "pre-wrap" : undefined,
                zIndex: merge ? 2 : undefined,
              }}
              onClick={(event) => {
                if (event.shiftKey) setSelection((current) => ({ ...current, row2: row, col2: col }));
                else setSelection({ row, col, row2: row, col2: col });
                setEditing(null);
              }}
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
                  void commit(selection.row, selection.col, editing).then(() => setSelection({ row: selection.row + 1, col: selection.col, row2: selection.row + 1, col2: selection.col }));
                } else if (event.key === "Tab") {
                  event.preventDefault();
                  void commit(selection.row, selection.col, editing).then(() => setSelection({ row: selection.row, col: selection.col + 1, row2: selection.row, col2: selection.col + 1 }));
                } else if (event.key === "Escape") setEditing(null);
              }}
              onBlur={() => { if (editing !== (selected?.formula || selected?.display || "")) void commit(selection.row, selection.col, editing); else setEditing(null); }}
            />
          )}
        </div>
      </div>
      <nav className="sheet-tabs" aria-label="工作表">
        {sheets.map((item) => (
          <button
            type="button"
            key={item.name}
            className={sheetName === item.name ? "active" : ""}
            onClick={() => void switchSheet(item.name)}
            onDoubleClick={() => {
              const next = window.prompt("工作表名称", item.name);
              if (next && next !== item.name) void run({ op: "sheetRename", name: item.name, next });
            }}
          >{item.name}</button>
        ))}
        <button type="button" className="sheet-add" title="新建工作表" onClick={() => void addWorkbookSheet(documentKey).then((result) => { setSheets(result.sheets); onDirty(); void switchSheet(result.name); })}><Plus size={12} /></button>
        <button type="button" className="sheet-add" title="删除工作表" onClick={() => sheets.length > 1 && void run({ op: "sheetRemove", name: sheetName })}>删除表</button>
      </nav>
    </div>
  );
}

function cellMap(viewport: SheetViewport | null | undefined) {
  const map = new Map<string, ViewportCell>();
  for (const cell of viewport?.cells ?? []) map.set(`${cell.r}:${cell.c}`, cell);
  return map;
}
