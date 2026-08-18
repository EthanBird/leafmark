import { AlignCenter, AlignLeft, AlignRight, Bold, ChevronDown, Heading1, Heading2, Heading3, Italic, List, ListOrdered, Redo2, Search, Strikethrough, Underline, Undo2 } from "lucide-react";
import { useRef, useState } from "react";
import { loadWordChunk, mutateOffice, redoOffice, replaceWordBlock, undoOffice } from "../../office/office-client";
import type { WordOpenResult } from "../../office/types";
import type { WordBlock, WordParagraph } from "../../office/word";
import { htmlToRuns, paragraphText } from "../../office/word";

const WORD_CHUNK = 160;

export function WordEditor({ documentKey, initial, editable, onDirty }: { documentKey: string; initial: WordOpenResult; editable: boolean; onDirty: () => void }) {
  const [blocks, setBlocks] = useState(initial.blocks);
  const [loading, setLoading] = useState(false);
  const [focus, setFocus] = useState(0);
  const [query, setQuery] = useState("");
  const [findOpen, setFindOpen] = useState(false);
  const articleRef = useRef<HTMLElement | null>(null);

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

  const formatSelection = (command: string) => document.execCommand(command);

  const applyStyle = async (patch: { align?: WordParagraph["align"]; kind?: WordParagraph["kind"]; level?: number; list?: WordParagraph["list"] | null }) => {
    const block = blocks[focus];
    if (!block || block.kind === "table") return;
    onDirty();
    await mutateOffice(documentKey, { op: "wordStyle", index: focus, patch });
    const next = { ...block, ...patch, dirty: true } as WordParagraph;
    if (patch.kind === "heading") next.level = patch.level ?? 1;
    if (patch.kind === "paragraph") next.level = undefined;
    if (patch.list === null) next.list = undefined;
    else if (patch.list) next.list = { ...patch.list, numId: patch.list.type === "bullet" ? 1 : 2 };
    setBlocks((current) => current.map((item, index) => index === focus ? next : item));
  };

  const history = async (direction: "undo" | "redo") => {
    const result = direction === "undo" ? await undoOffice(documentKey) : await redoOffice(documentKey);
    if (!result.ok || result.snapshot.type !== "word") return;
    setBlocks(result.snapshot.blocks);
    onDirty();
  };

  const findNext = () => {
    if (!query.trim()) return;
    const start = focus + 1;
    const hay = [...blocks.slice(start), ...blocks.slice(0, start)];
    const found = hay.findIndex((block) => block.kind !== "table" && paragraphText(block).includes(query));
    if (found < 0) return;
    const index = (start + found) % blocks.length;
    setFocus(index);
    articleRef.current?.querySelectorAll("[data-word-block]")[index]?.scrollIntoView({ block: "center" });
  };

  return (
    <div className="binary-viewer word-viewer office-editor">
      {editable && (
        <div className="office-ribbon" role="toolbar" aria-label="Word 格式">
          <button type="button" title="撤销" onClick={() => void history("undo")}><Undo2 size={14} /></button>
          <button type="button" title="重做" onClick={() => void history("redo")}><Redo2 size={14} /></button>
          <span />
          <button type="button" onMouseDown={(event) => { event.preventDefault(); formatSelection("bold"); }} title="粗体"><Bold size={14} /></button>
          <button type="button" onMouseDown={(event) => { event.preventDefault(); formatSelection("italic"); }} title="斜体"><Italic size={14} /></button>
          <button type="button" onMouseDown={(event) => { event.preventDefault(); formatSelection("underline"); }} title="下划线"><Underline size={14} /></button>
          <button type="button" onMouseDown={(event) => { event.preventDefault(); formatSelection("strikeThrough"); }} title="删除线"><Strikethrough size={14} /></button>
          <span />
          <button type="button" onMouseDown={(event) => { event.preventDefault(); formatSelection("justifyLeft"); void applyStyle({ align: "left" }); }} title="左对齐"><AlignLeft size={14} /></button>
          <button type="button" onMouseDown={(event) => { event.preventDefault(); formatSelection("justifyCenter"); void applyStyle({ align: "center" }); }} title="居中"><AlignCenter size={14} /></button>
          <button type="button" onMouseDown={(event) => { event.preventDefault(); formatSelection("justifyRight"); void applyStyle({ align: "right" }); }} title="右对齐"><AlignRight size={14} /></button>
          <span />
          <button type="button" title="标题 1" onMouseDown={(event) => { event.preventDefault(); void applyStyle({ kind: "heading", level: 1 }); }}><Heading1 size={14} /></button>
          <button type="button" title="标题 2" onMouseDown={(event) => { event.preventDefault(); void applyStyle({ kind: "heading", level: 2 }); }}><Heading2 size={14} /></button>
          <button type="button" title="标题 3" onMouseDown={(event) => { event.preventDefault(); void applyStyle({ kind: "heading", level: 3 }); }}><Heading3 size={14} /></button>
          <button type="button" title="项目符号" onMouseDown={(event) => { event.preventDefault(); void applyStyle({ list: { type: "bullet", level: 0, numId: 1 } }); }}><List size={14} /></button>
          <button type="button" title="编号列表" onMouseDown={(event) => { event.preventDefault(); void applyStyle({ list: { type: "number", level: 0, numId: 2 } }); }}><ListOrdered size={14} /></button>
          <span />
          <button type="button" title="查找" onClick={() => setFindOpen((open) => !open)}><Search size={14} /></button>
          {findOpen && (
            <input
              className="office-find"
              value={query}
              placeholder="查找"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") findNext(); }}
            />
          )}
          <small>{initial.totalBlocks.toLocaleString()} 段 · {initial.firstPaintMs} ms 首屏</small>
        </div>
      )}
      <article className="word-page" ref={articleRef}>
        {blocks.map((block, index) => (
          <WordBlockEditor
            key={index}
            block={block}
            editable={editable}
            active={focus === index}
            onFocus={() => setFocus(index)}
            onChange={(next) => void persist(index, next)}
            onSplit={(offset) => {
              const current = blocks[index];
              if (current.kind === "table") return;
              onDirty();
              const [left, right] = splitLocal(current, offset);
              setBlocks((items) => {
                const copy = [...items];
                copy[index] = left;
                copy.splice(index + 1, 0, right);
                return copy;
              });
              setFocus(index + 1);
              void mutateOffice(documentKey, { op: "wordSplit", index, offset });
            }}
          />
        ))}
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

function splitLocal(block: WordParagraph, offset: number): [WordParagraph, WordParagraph] {
  const text = paragraphText(block);
  const at = Math.max(0, Math.min(offset, text.length));
  let seen = 0;
  const left: WordParagraph["runs"] = [];
  const right: WordParagraph["runs"] = [];
  for (const run of block.runs) {
    const start = seen;
    const end = seen + run.text.length;
    if (end <= at) left.push({ ...run });
    else if (start >= at) right.push({ ...run });
    else {
      if (at > start) left.push({ ...run, text: run.text.slice(0, at - start) });
      if (end > at) right.push({ ...run, text: run.text.slice(at - start) });
    }
    seen = end;
  }
  return [
    { ...block, runs: left.length ? left : [{ text: "" }], dirty: true },
    { ...block, runs: right.length ? right : [{ text: "" }], dirty: true },
  ];
}

function WordBlockEditor({
  block,
  editable,
  active,
  onFocus,
  onChange,
  onSplit,
}: {
  block: WordBlock;
  editable: boolean;
  active: boolean;
  onFocus: () => void;
  onChange: (block: WordBlock) => void;
  onSplit: (offset: number) => void;
}) {
  if (block.kind === "table") {
    return <div className="word-table-wrap" data-word-block onFocus={onFocus}><table><tbody>{block.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td
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
  const listClass = block.list ? `word-list word-list-${block.list.type}` : "";
  return <Tag
    data-word-block
    className={`${listClass}${active ? " word-block-active" : ""}`}
    contentEditable={editable}
    suppressContentEditableWarning
    style={{ textAlign: block.align }}
    onFocus={onFocus}
    onKeyDown={(event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        onSplit(caretOffset(event.currentTarget));
      }
    }}
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

function caretOffset(node: HTMLElement) {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return node.innerText.length;
  const range = selection.getRangeAt(0);
  const pre = range.cloneRange();
  pre.selectNodeContents(node);
  pre.setEnd(range.endContainer, range.endOffset);
  return pre.toString().length;
}
