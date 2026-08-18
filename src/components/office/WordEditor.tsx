import { AlignCenter, AlignJustify, AlignLeft, AlignRight, Bold, ChevronDown, Heading1, Heading2, Heading3, IndentDecrease, IndentIncrease, Italic, Link, List, ListOrdered, Redo2, Replace, Search, Strikethrough, Subscript, Superscript, Table, Underline, Undo2 } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { loadWordChunk, mutateOffice, redoOffice, replaceWordBlock, undoOffice } from "../../office/office-client";
import type { OfficeMutation, WordOpenResult } from "../../office/types";
import type { WordBlock, WordParagraph, WordRun } from "../../office/word";
import { htmlToRuns, paragraphText, wordCount } from "../../office/word";

const WORD_CHUNK = 160;
const FONTS = ["微软雅黑", "宋体", "黑体", "楷体", "Calibri", "Arial", "Times New Roman", "Consolas"];
const SIZES = [9, 10, 10.5, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 36, 48, 72];
const HIGHLIGHTS = ["yellow", "green", "cyan", "magenta", "blue", "red", "darkYellow", "darkGreen", "lightGray"];

export function WordEditor({ documentKey, initial, editable, onDirty }: { documentKey: string; initial: WordOpenResult; editable: boolean; onDirty: () => void }) {
  const [blocks, setBlocks] = useState(initial.blocks);
  const [loading, setLoading] = useState(false);
  const [focus, setFocus] = useState(0);
  const [tab, setTab] = useState<"home" | "insert">("home");
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [findOpen, setFindOpen] = useState(false);
  const [header, setHeader] = useState(initial.header ?? "");
  const [footer, setFooter] = useState(initial.footer ?? "");
  const articleRef = useRef<HTMLElement | null>(null);
  const counts = useMemo(() => wordCount(blocks), [blocks]);
  const focused = blocks[focus];
  const paragraph = focused && focused.kind !== "table" ? focused : undefined;

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

  const applyMutation = async (mutation: OfficeMutation, nextBlocks?: WordBlock[]) => {
    onDirty();
    const result = await mutateOffice(documentKey, mutation) as { blocks?: WordBlock[]; block?: WordBlock; header?: string; footer?: string; totalBlocks?: number };
    if (result.blocks) setBlocks(result.blocks);
    else if (nextBlocks) setBlocks(nextBlocks);
    else if (result.block && "index" in mutation) {
      setBlocks((current) => current.map((item, index) => index === mutation.index ? result.block as WordBlock : item));
    }
    if (result.header !== undefined) setHeader(result.header ?? "");
    if (result.footer !== undefined) setFooter(result.footer ?? "");
  };

  const applyStyle = async (patch: NonNullable<Extract<OfficeMutation, { op: "wordStyle" }>["patch"]>) => {
    if (!paragraph) return;
    const next = { ...paragraph, ...patch, dirty: true } as WordParagraph;
    if (patch.kind === "heading") next.level = patch.level ?? 1;
    if (patch.kind === "paragraph") next.level = undefined;
    if (patch.list === null) next.list = undefined;
    else if (patch.list) next.list = { ...patch.list, numId: patch.list.type === "bullet" ? 1 : 2 };
    await applyMutation({ op: "wordStyle", index: focus, patch }, blocks.map((item, index) => index === focus ? next : item));
  };

  const applyRun = async (style: Partial<WordRun>) => {
    if (!paragraph) return;
    const runs = paragraph.runs.map((run) => ({ ...run, ...style }));
    await applyMutation({ op: "wordRunStyle", index: focus, style }, blocks.map((item, index) => index === focus ? { ...paragraph, runs, dirty: true } : item));
  };

  const history = async (direction: "undo" | "redo") => {
    const result = direction === "undo" ? await undoOffice(documentKey) : await redoOffice(documentKey);
    if (!result.ok || result.snapshot.type !== "word") return;
    setBlocks(result.snapshot.blocks);
    setHeader(result.snapshot.header ?? "");
    setFooter(result.snapshot.footer ?? "");
    onDirty();
  };

  const findNext = () => {
    if (!query.trim()) return;
    const start = focus + 1;
    const hay = [...blocks.slice(start), ...blocks.slice(0, start)];
    const found = hay.findIndex((block) => (block.kind === "table" ? block.rows.flat().some((cell) => cell.text.includes(query)) : paragraphText(block).includes(query)));
    if (found < 0) return;
    const index = (start + found) % blocks.length;
    setFocus(index);
    articleRef.current?.querySelectorAll("[data-word-block]")[index]?.scrollIntoView({ block: "center" });
  };

  const changeIndent = async (delta: number) => {
    if (!paragraph) return;
    const indent = Math.max(0, Math.min(8, (paragraph.indent ?? 0) + delta));
    const list = paragraph.list ? { ...paragraph.list, level: Math.max(0, Math.min(8, paragraph.list.level + delta)) } : paragraph.list;
    await applyStyle({ indent, list: list ?? undefined });
  };

  return (
    <div className="binary-viewer word-viewer office-editor">
      {editable && (
        <div className="office-ribbon-wrap">
          <div className="office-ribbon-tabs" role="tablist">
            <button type="button" className={tab === "home" ? "active" : ""} onClick={() => setTab("home")}>开始</button>
            <button type="button" className={tab === "insert" ? "active" : ""} onClick={() => setTab("insert")}>插入</button>
          </div>
          <div className="office-ribbon" role="toolbar" aria-label="WPS 文字">
            <button type="button" title="撤销" onClick={() => void history("undo")}><Undo2 size={14} /></button>
            <button type="button" title="重做" onClick={() => void history("redo")}><Redo2 size={14} /></button>
            <span />
            {tab === "home" && (
              <>
                <select aria-label="字体" value={paragraph?.runs[0]?.font ?? "微软雅黑"} onChange={(event) => void applyRun({ font: event.target.value })}>
                  {FONTS.map((font) => <option key={font}>{font}</option>)}
                </select>
                <select aria-label="字号" value={paragraph?.runs[0]?.fontSize ?? 11} onChange={(event) => void applyRun({ fontSize: Number(event.target.value) })}>
                  {SIZES.map((size) => <option key={size} value={size}>{size}</option>)}
                </select>
                <button type="button" title="粗体" onClick={() => void applyRun({ bold: !paragraph?.runs.some((run) => run.bold) })}><Bold size={14} /></button>
                <button type="button" title="斜体" onClick={() => void applyRun({ italic: !paragraph?.runs.some((run) => run.italic) })}><Italic size={14} /></button>
                <button type="button" title="下划线" onClick={() => void applyRun({ underline: !paragraph?.runs.some((run) => run.underline) })}><Underline size={14} /></button>
                <button type="button" title="删除线" onClick={() => void applyRun({ strike: !paragraph?.runs.some((run) => run.strike) })}><Strikethrough size={14} /></button>
                <button type="button" title="下标" onClick={() => void applyRun({ vertAlign: paragraph?.runs[0]?.vertAlign === "subscript" ? undefined : "subscript" })}><Subscript size={14} /></button>
                <button type="button" title="上标" onClick={() => void applyRun({ vertAlign: paragraph?.runs[0]?.vertAlign === "superscript" ? undefined : "superscript" })}><Superscript size={14} /></button>
                <label className="office-color" title="字体颜色">
                  <input type="color" value={paragraph?.runs[0]?.color || "#202124"} onChange={(event) => void applyRun({ color: event.target.value })} />
                </label>
                <select aria-label="高亮" title="突出显示" value={paragraph?.runs[0]?.highlight ?? ""} onChange={(event) => void applyRun({ highlight: event.target.value || undefined })}>
                  <option value="">无高亮</option>
                  {HIGHLIGHTS.map((color) => <option key={color} value={color}>{color}</option>)}
                </select>
                <span />
                <button type="button" title="左对齐" onClick={() => void applyStyle({ align: "left" })}><AlignLeft size={14} /></button>
                <button type="button" title="居中" onClick={() => void applyStyle({ align: "center" })}><AlignCenter size={14} /></button>
                <button type="button" title="右对齐" onClick={() => void applyStyle({ align: "right" })}><AlignRight size={14} /></button>
                <button type="button" title="两端对齐" onClick={() => void applyStyle({ align: "justify" })}><AlignJustify size={14} /></button>
                <button type="button" title="减少缩进" onClick={() => void changeIndent(-1)}><IndentDecrease size={14} /></button>
                <button type="button" title="增加缩进" onClick={() => void changeIndent(1)}><IndentIncrease size={14} /></button>
                <select aria-label="行距" value={paragraph?.lineSpacing ?? 1.15} onChange={(event) => void applyStyle({ lineSpacing: Number(event.target.value) })}>
                  <option value={1}>单倍</option>
                  <option value={1.15}>1.15</option>
                  <option value={1.5}>1.5 倍</option>
                  <option value={2}>2 倍</option>
                </select>
                <span />
                <button type="button" title="标题 1" onClick={() => void applyStyle({ kind: "heading", level: 1 })}><Heading1 size={14} /></button>
                <button type="button" title="标题 2" onClick={() => void applyStyle({ kind: "heading", level: 2 })}><Heading2 size={14} /></button>
                <button type="button" title="标题 3" onClick={() => void applyStyle({ kind: "heading", level: 3 })}><Heading3 size={14} /></button>
                <button type="button" title="正文" onClick={() => void applyStyle({ kind: "paragraph" })}>正文</button>
                <button type="button" title="项目符号" onClick={() => void applyStyle({ list: { type: "bullet", level: paragraph?.list?.level ?? 0, numId: 1 } })}><List size={14} /></button>
                <button type="button" title="编号列表" onClick={() => void applyStyle({ list: { type: "number", level: paragraph?.list?.level ?? 0, numId: 2 } })}><ListOrdered size={14} /></button>
                <button type="button" title="清除格式" onClick={() => {
                  if (!paragraph) return;
                  void persist(focus, { kind: "paragraph", runs: [{ text: paragraphText(paragraph) }], dirty: true });
                }}>清除</button>
                <span />
                <button type="button" title="查找" onClick={() => setFindOpen((open) => !open)}><Search size={14} /></button>
                {findOpen && (
                  <>
                    <input className="office-find" value={query} placeholder="查找" onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") findNext(); }} />
                    <input className="office-find" value={replacement} placeholder="替换为" onChange={(event) => setReplacement(event.target.value)} />
                    <button type="button" title="全部替换" onClick={() => void applyMutation({ op: "wordFindReplace", query, replacement, all: true })}><Replace size={14} /></button>
                  </>
                )}
              </>
            )}
            {tab === "insert" && (
              <>
                <button type="button" title="插入表格" onClick={() => void applyMutation({ op: "wordTable", action: "insert", index: focus + 1, rows: 3, cols: 3 })}><Table size={14} /> 表格</button>
                {focused?.kind === "table" && (
                  <>
                    <button type="button" onClick={() => void applyMutation({ op: "wordTable", action: "insertRow", index: focus, row: 0 })}>插入行</button>
                    <button type="button" onClick={() => void applyMutation({ op: "wordTable", action: "insertCol", index: focus, col: 0 })}>插入列</button>
                    <button type="button" onClick={() => void applyMutation({ op: "wordTable", action: "deleteRow", index: focus, row: 0 })}>删除行</button>
                    <button type="button" onClick={() => void applyMutation({ op: "wordTable", action: "deleteCol", index: focus, col: 0 })}>删除列</button>
                  </>
                )}
                <button type="button" title="分页符" onClick={() => void applyStyle({ pageBreak: !paragraph?.pageBreak })}>分页符</button>
                <button type="button" title="超链接" onClick={() => {
                  const href = window.prompt("链接地址或书签", paragraph?.runs[0]?.hyperlink ?? "https://");
                  if (href != null) void applyRun({ hyperlink: href || undefined, underline: Boolean(href), color: href ? "#0563C1" : undefined });
                }}><Link size={14} /></button>
                <label className="office-field">页眉 <input value={header} onChange={(event) => setHeader(event.target.value)} onBlur={() => void applyMutation({ op: "wordHeaderFooter", header, footer })} /></label>
                <label className="office-field">页脚 <input value={footer} onChange={(event) => setFooter(event.target.value)} onBlur={() => void applyMutation({ op: "wordHeaderFooter", header, footer })} /></label>
              </>
            )}
            <small>{counts.words.toLocaleString()} 词 · {counts.characters.toLocaleString()} 字 · {initial.totalBlocks.toLocaleString()} 段</small>
          </div>
        </div>
      )}
      <article className="word-page" ref={articleRef}>
        {header && <div className="word-header-band">{header}</div>}
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
        {!blocks.length && <p className="viewer-empty">开始输入文字。此文档会以 Microsoft Word / WPS 文字 OOXML 写回。</p>}
        {blocks.length < initial.totalBlocks && (
          <button className="load-document-chunk" type="button" disabled={loading} onClick={() => void loadMore()}>
            <ChevronDown size={15} /> {loading ? "正在载入…" : `继续载入（剩余 ${(initial.totalBlocks - blocks.length).toLocaleString()} 段）`}
          </button>
        )}
        {footer && <div className="word-footer-band">{footer}</div>}
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
    className={`${listClass}${active ? " word-block-active" : ""}${block.pageBreak ? " word-page-break" : ""}`}
    contentEditable={editable}
    suppressContentEditableWarning
    style={{
      textAlign: block.align,
      marginLeft: block.indent ? `${block.indent * 1.4}em` : undefined,
      lineHeight: block.lineSpacing,
      paddingTop: block.spacingBefore ? block.spacingBefore / 20 : undefined,
    }}
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
    background: run.highlight && !/^#|[0-9A-Fa-f]{6}/.test(run.highlight) ? run.highlight : run.highlight ? `#${run.highlight.replace(/^#/, "")}` : undefined,
    verticalAlign: run.vertAlign === "subscript" ? "sub" : run.vertAlign === "superscript" ? "super" : undefined,
    whiteSpace: "pre-wrap",
  }}>{run.hyperlink ? <a href={run.hyperlink} onClick={(event) => event.preventDefault()}>{run.text}</a> : run.text}</span>)}</Tag>;
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
