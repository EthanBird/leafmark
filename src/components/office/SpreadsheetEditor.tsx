import { Columns3, Copy, ClipboardPaste, Plus, Redo2, Rows3, Trash2, Undo2 } from "lucide-react";
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
import type { SpreadsheetOpenResult } from "../../office/types";
import type { SheetViewport, ViewportCell } from "../../office/sheet";

const ROW_H = 24;
const COL_W = 92;
const HEADER_W = 46;
const HEADER_H = 24;

export function SpreadsheetEditor({ documentKey, initial, onDirty }: { documentKey: string; initial: SpreadsheetOpenResult; onDirty: () => void }) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const clipboard = useRef<string[][]>([]);
  const [sheets, setSheets] = useState(initial.sheets);
  const [sheetName, setSheetName] = useState(initial.active?.name ?? initial.sheets[0]?.name ?? "Sheet1");
  const [used, setUsed] = useState({ rows: initial.active?.rows ?? 0, cols: initial.active?.cols ?? 0 });
  const [cells, setCells] = useState(() => cellMap(initial.active));
  const [selection, setSelection] = useState({ row: 0, col: 0, row2: 0, col2: 0 });
  const [formula, setFormula] = useState(initial.active?.cells.find((cell) => cell.r === 0 && cell.c === 0)?.formula ?? "");
  const [editing, setEditing] = useState<string | null>(null);
  const [range, setRange] = useState({ rowStart: 0, colStart: 0, rowCount: 80, colCount: 26 });

  const totalRows = Math.max(used.rows + 24, 80);
  const totalCols = Math.max(used.cols + 8, 26);
  const rowStartSel = Math.min(selection.row, selection.row2);
  const rowEndSel = Math.max(selection.row, selection.row2);
  const colStartSel = Math.min(selection.col, selection.col2);
  const colEndSel = Math.max(selection.col, selection.col2);

  const applyViewport = (viewport: SheetViewport) => {
    setUsed({ rows: viewport.rows, cols: viewport.cols });
    setSheetName(viewport.name);
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
    setSelection({ row: 0, col: 0, row2: 0, col2: 0 });
    const viewport = await loadSheetViewport(documentKey, name, 0, 80, 0, 26);
    applyViewport(viewport);
    scrollerRef.current?.scrollTo({ top: 0, left: 0 });
  };

  const history = async (direction: "undo" | "redo") => {
    const result = direction === "undo" ? await undoOffice(documentKey) : await redoOffice(documentKey);
    if (!result.ok) return;
    onDirty();
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
    onDirty();
    await mutateOffice(documentKey, { op: "sheetPaste", name: sheetName, row: selection.row, col: selection.col, values });
    setCells(new Map());
    await loadRange();
  };

  const fill = async () => {
    onDirty();
    await mutateOffice(documentKey, { op: "sheetFill", name: sheetName, row: rowStartSel, col: colStartSel, rowCount: rowEndSel - rowStartSel + 1, colCount: colEndSel - colStartSel + 1 });
    setCells(new Map());
    await loadRange();
  };

  const insertAxis = async (axis: "row" | "col") => {
    onDirty();
    await mutateOffice(documentKey, { op: "sheetInsert", name: sheetName, axis, index: axis === "row" ? selection.row : selection.col, count: 1 });
    setCells(new Map());
    await loadRange();
  };

  const deleteAxis = async (axis: "row" | "col") => {
    onDirty();
    await mutateOffice(documentKey, { op: "sheetDelete", name: sheetName, axis, index: axis === "row" ? selection.row : selection.col, count: 1 });
    setCells(new Map());
    await loadRange();
  };

  useEffect(() => {
    const node = rootRef.current;
    if (!node) return;
    const onKey = (event: KeyboardEvent) => {
      const meta = event.ctrlKey || event.metaKey;
      if (editing != null && event.key !== "Escape" && !meta) return;
      if (meta && event.key.toLowerCase() === "z") { event.preventDefault(); void history(event.shiftKey ? "redo" : "undo"); return; }
      if (meta && event.key.toLowerCase() === "y") { event.preventDefault(); void history("redo"); return; }
      if (meta && event.key.toLowerCase() === "c") { event.preventDefault(); void copy(); return; }
      if (meta && event.key.toLowerCase() === "v") {
        event.preventDefault();
        void navigator.clipboard.readText().then((text) => paste(text)).catch(() => paste());
        return;
      }
      if (meta && event.key.toLowerCase() === "d") { event.preventDefault(); void fill(); return; }
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

  return (
    <div className="binary-viewer spreadsheet-viewer office-editor" ref={rootRef} tabIndex={0}>
      <div className="office-ribbon sheet-toolbar">
        <button type="button" title="撤销" onClick={() => void history("undo")}><Undo2 size={14} /></button>
        <button type="button" title="重做" onClick={() => void history("redo")}><Redo2 size={14} /></button>
        <span />
        <button type="button" title="复制" onClick={() => void copy()}><Copy size={14} /></button>
        <button type="button" title="粘贴" onClick={() => void paste()}><ClipboardPaste size={14} /></button>
        <button type="button" title="向下填充" onClick={() => void fill()}>Fill</button>
        <span />
        <button type="button" title="插入行" onClick={() => void insertAxis("row")}><Rows3 size={14} /></button>
        <button type="button" title="插入列" onClick={() => void insertAxis("col")}><Columns3 size={14} /></button>
        <button type="button" title="删除行" onClick={() => void deleteAxis("row")}><Trash2 size={14} /></button>
        <span />
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
            const inRange = row >= rowStartSel && row <= rowEndSel && col >= colStartSel && col <= colEndSel;
            return <div
              key={`${row}:${col}`}
              className={`sheet-cell${active ? " active" : ""}${inRange ? " selected" : ""}${cell?.type === "n" || cell?.type === "f" ? " numeric" : ""}`}
              style={{ left: HEADER_W + col * COL_W, top: HEADER_H + row * ROW_H, width: COL_W, height: ROW_H }}
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
        {sheets.map((item) => <button type="button" key={item.name} className={sheetName === item.name ? "active" : ""} onClick={() => void switchSheet(item.name)}>{item.name}</button>)}
        <button type="button" className="sheet-add" title="新建工作表" onClick={() => void addWorkbookSheet(documentKey).then((result) => { setSheets(result.sheets); onDirty(); void switchSheet(result.name); })}><Plus size={12} /></button>
      </nav>
    </div>
  );
}

function cellMap(viewport: SheetViewport | null | undefined) {
  const map = new Map<string, ViewportCell>();
  for (const cell of viewport?.cells ?? []) map.set(`${cell.r}:${cell.c}`, cell);
  return map;
}
