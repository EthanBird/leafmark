import { AlignCenter, AlignLeft, AlignRight, Bold, Copy, EyeOff, Italic, Plus, Presentation, Redo2, Trash2, Type, Undo2 } from "lucide-react";
import { useRef, useState, type CSSProperties, type MouseEvent } from "react";
import { addPresentationSlide, loadPresentationSlide, mutateOffice, redoOffice, undoOffice, updatePresentationShape } from "../../office/office-client";
import type { PresentationOpenResult } from "../../office/types";
import type { SlideModel, SlideShape } from "../../office/slide";
import { ViewerLoading } from "./ViewerChrome";
import { AskAiRibbonButton } from "../AskAiToolbar";

const LAYOUTS: Array<{ value: NonNullable<SlideModel["layout"]>; label: string }> = [
  { value: "title", label: "标题" },
  { value: "titleContent", label: "标题和内容" },
  { value: "twoContent", label: "两栏内容" },
  { value: "blank", label: "空白" },
];

export function slideSurfaceStyle(slide: Pick<SlideModel, "background" | "backgroundImage">): CSSProperties {
  return {
    backgroundColor: slide.background,
    backgroundImage: slide.backgroundImage ? `url("${slide.backgroundImage}")` : undefined,
    backgroundSize: "cover",
    backgroundPosition: "center",
  };
}

export function SlideStage({ slide }: { slide: SlideModel }) {
  return (
    <div className="slide-canvas" style={slideSurfaceStyle(slide)}>
      {slide.shapes.map((item) => (
        <SlideShapeView key={item.id} item={item} active={false} playing />
      ))}
    </div>
  );
}

export function PresentationEditor({ documentKey, initial, onDirty }: { documentKey: string; initial: PresentationOpenResult; onDirty: () => void }) {
  const [slides, setSlides] = useState(initial.slides);
  const [slide, setSlide] = useState<SlideModel | null>(initial.active);
  const [loading, setLoading] = useState(false);
  const [activeShape, setActiveShape] = useState<string | null>(
    initial.active?.shapes.find((item) => item.kind === "text" || !item.kind)?.id
      ?? initial.active?.shapes[0]?.id
      ?? null,
  );
  const [tab, setTab] = useState<"home" | "show">("home");
  const [playing, setPlaying] = useState(false);
  const [engineError, setEngineError] = useState("");
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ id: string; dx: number; dy: number } | null>(null);

  const openSlide = async (index: number) => {
    setLoading(true);
    try {
      const next = await loadPresentationSlide(documentKey, index);
      setSlide(next);
      setActiveShape(next?.shapes[0]?.id ?? null);
    } finally {
      setLoading(false);
    }
  };

  const editShape = async (shapeId: string, text: string) => {
    if (!slide) return;
    onDirty();
    try {
      const next = await updatePresentationShape(documentKey, slide.index, shapeId, text);
      setSlide(next);
      setSlides((current) => current.map((item) => item.index === next?.index ? { index: next.index, title: next.title, hidden: next.hidden } : item));
      setEngineError("");
    } catch (reason) {
      setEngineError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const run = async (mutation: Parameters<typeof mutateOffice>[1]) => {
    onDirty();
    try {
      const result = await mutateOffice(documentKey, mutation) as { slides?: Array<{ index: number; title: string; hidden?: boolean }>; slide?: SlideModel | null };
      if (result.slides) setSlides(result.slides);
      if (result.slide) {
        setSlide(result.slide);
        setActiveShape(result.slide.shapes.find((item) => item.id === activeShape)?.id ?? result.slide.shapes[0]?.id ?? null);
      } else if (slide) await openSlide(Math.min(slide.index, (result.slides?.length ?? 1) - 1));
      setEngineError("");
    } catch (reason) {
      setEngineError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const history = async (direction: "undo" | "redo") => {
    const result = direction === "undo" ? await undoOffice(documentKey) : await redoOffice(documentKey);
    if (!result.ok || result.snapshot.type !== "presentation") return;
    onDirty();
    setSlides(result.snapshot.slides);
    setSlide(result.snapshot.active);
  };

  const visibleSlides = slides.filter((item) => !item.hidden);
  const playIndex = visibleSlides.findIndex((item) => item.index === slide?.index);
  const shape = slide?.shapes.find((item) => item.id === activeShape);

  const startDrag = (event: MouseEvent, item: SlideShape) => {
    if (event.button !== 0 || event.detail > 1) return;
    const target = event.target as HTMLElement;
    if (!event.altKey && target.isContentEditable) {
      setActiveShape(item.id);
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) return;
    const box = canvas.getBoundingClientRect();
    drag.current = { id: item.id, dx: event.clientX / box.width - item.x, dy: event.clientY / box.height - item.y };
    setActiveShape(item.id);
  };

  const onMove = (event: MouseEvent) => {
    if (!drag.current || !slide) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const box = canvas.getBoundingClientRect();
    const x = Math.max(0, Math.min(0.9, event.clientX / box.width - drag.current.dx));
    const y = Math.max(0, Math.min(0.9, event.clientY / box.height - drag.current.dy));
    setSlide({ ...slide, shapes: slide.shapes.map((item) => item.id === drag.current?.id ? { ...item, x, y } : item) });
  };

  const endDrag = () => {
    const current = drag.current;
    drag.current = null;
    if (!current || !slide) return;
    const moved = slide.shapes.find((item) => item.id === current.id);
    if (moved) void run({ op: "slideMove", index: slide.index, shapeId: moved.id, x: moved.x, y: moved.y, width: moved.width, height: moved.height });
  };

  if (playing && slide) {
    return (
      <div
        className="slide-show"
        tabIndex={0}
        onClick={() => {
          const next = visibleSlides[playIndex + 1] ?? visibleSlides[0];
          if (next) void openSlide(next.index);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") setPlaying(false);
          if (event.key === "ArrowRight" || event.key === " ") {
            const next = visibleSlides[Math.min(visibleSlides.length - 1, playIndex + 1)];
            if (next) void openSlide(next.index);
          }
          if (event.key === "ArrowLeft") {
            const prev = visibleSlides[Math.max(0, playIndex - 1)];
            if (prev) void openSlide(prev.index);
          }
        }}
      >
        <SlideStage slide={slide} />
        <small>{playIndex + 1} / {visibleSlides.length} · Esc 退出</small>
      </div>
    );
  }

  return (
    <div className="binary-viewer presentation-viewer office-editor" data-office="ppt">
      <div className="office-ribbon-wrap" style={{ gridColumn: "1 / -1" }}>
        <div className="office-ribbon-tabs" role="tablist">
          <button type="button" className={tab === "home" ? "active" : ""} onClick={() => setTab("home")}>开始</button>
          <button type="button" className={tab === "show" ? "active" : ""} onClick={() => setTab("show")}>幻灯片放映</button>
        </div>
        <div className="office-ribbon">
          <button type="button" title="撤销" onClick={() => void history("undo")}><Undo2 size={14} /></button>
          <button type="button" title="重做" onClick={() => void history("redo")}><Redo2 size={14} /></button>
          <span />
          {tab === "home" && (
            <>
              <button type="button" title="复制幻灯片" onClick={() => slide && void run({ op: "slideDuplicate", index: slide.index })}><Copy size={14} /></button>
              <button type="button" title="删除幻灯片" onClick={() => slide && void run({ op: "slideDelete", index: slide.index })}><Trash2 size={14} /></button>
              <button type="button" title="隐藏幻灯片" onClick={() => slide && void run({ op: "slideHide", index: slide.index, hidden: !slide.hidden })}><EyeOff size={14} /></button>
              <select aria-label="版式" value={slide?.layout ?? "titleContent"} onChange={(event) => slide && void run({ op: "slideLayout", index: slide.index, layout: event.target.value as NonNullable<SlideModel["layout"]> })}>
                {LAYOUTS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
              </select>
              <button type="button" title="文本框" onClick={() => slide && void run({ op: "slideAddTextBox", index: slide.index })}><Type size={14} /> 文本框</button>
              <AskAiRibbonButton
                getSelection={() => ({
                  text: window.getSelection()?.toString().trim() || shape?.text || slide?.shapes.map((item) => item.text).filter(Boolean).join("\n") || "",
                  kind: "presentation",
                  location: slide ? `幻灯片 ${slide.index + 1}${shape ? ` · ${shape.id}` : ""}` : undefined,
                })}
              />
              <span />
              <button type="button" title="加粗" disabled={!shape} onClick={() => slide && shape && void run({ op: "slideShape", index: slide.index, shapeId: shape.id, patch: { bold: !shape.bold } })}><Bold size={14} /></button>
              <button type="button" title="斜体" disabled={!shape} onClick={() => slide && shape && void run({ op: "slideShape", index: slide.index, shapeId: shape.id, patch: { italic: !shape.italic } })}><Italic size={14} /></button>
              <button type="button" title="左对齐" disabled={!shape} onClick={() => slide && shape && void run({ op: "slideShape", index: slide.index, shapeId: shape.id, patch: { align: "left" } })}><AlignLeft size={14} /></button>
              <button type="button" title="居中" disabled={!shape} onClick={() => slide && shape && void run({ op: "slideShape", index: slide.index, shapeId: shape.id, patch: { align: "center" } })}><AlignCenter size={14} /></button>
              <button type="button" title="右对齐" disabled={!shape} onClick={() => slide && shape && void run({ op: "slideShape", index: slide.index, shapeId: shape.id, patch: { align: "right" } })}><AlignRight size={14} /></button>
              <select aria-label="字号" disabled={!shape} value={shape?.fontSize ?? 18} onChange={(event) => slide && shape && void run({ op: "slideShape", index: slide.index, shapeId: shape.id, patch: { fontSize: Number(event.target.value) } })}>
                {[12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 44, 54, 72].map((size) => <option key={size} value={size}>{size}</option>)}
              </select>
              <label className="office-color">文字<input type="color" value={shape?.color || "#202124"} onChange={(event) => slide && shape && void run({ op: "slideShape", index: slide.index, shapeId: shape.id, patch: { color: event.target.value } })} /></label>
              <label className="office-color">填充<input type="color" value={shape?.fill || "#ffffff"} onChange={(event) => slide && shape && void run({ op: "slideShape", index: slide.index, shapeId: shape.id, patch: { fill: event.target.value } })} /></label>
              <label className="office-color">背景<input type="color" value={slide?.background || "#ffffff"} onChange={(event) => slide && void run({ op: "slideBackground", index: slide.index, background: event.target.value })} /></label>
            </>
          )}
          {tab === "show" && (
            <>
              <button type="button" title="从头开始" onClick={() => { const first = visibleSlides[0]; if (first) void openSlide(first.index).then(() => setPlaying(true)); }}><Presentation size={14} /> 从头放映</button>
              <button type="button" title="从当前" onClick={() => setPlaying(true)}>从当前</button>
            </>
          )}
        </div>
        {engineError && <div className="office-engine-error" data-office-error>{engineError}</div>}
      </div>
      <nav className="slide-list" aria-label="幻灯片">
        {slides.map((item) => (
          <button
            type="button"
            key={item.index}
            className={`${slide?.index === item.index ? "active" : ""}${item.hidden ? " hidden-slide" : ""}`}
            onClick={() => void openSlide(item.index)}
            onDragOver={(event) => event.preventDefault()}
            onDrop={() => slide && void run({ op: "slideReorder", from: slide.index, to: item.index })}
            draggable
            onDragStart={() => slide && setSlide({ ...slide })}
          >
            <span>{item.index + 1}</span>
            <strong>{item.hidden ? "（隐藏）" : ""}{item.title}</strong>
          </button>
        ))}
        <button type="button" className="slide-add" onClick={() => void addPresentationSlide(documentKey).then((result) => { setSlides(result.slides); setSlide(result.slide); onDirty(); })}><Plus size={12} /> 新建幻灯片</button>
      </nav>
      <div className="slide-stage-wrap">
        <div className="slide-stage">
          {loading && !slide ? <ViewerLoading label="正在载入幻灯片" /> : slide && (
            <div
              className="slide-canvas"
              ref={canvasRef}
              style={slideSurfaceStyle(slide)}
              onMouseMove={onMove}
              onMouseUp={endDrag}
              onMouseLeave={endDrag}
            >
              {slide.shapes.map((item) => (
                <SlideShapeView
                  key={item.id}
                  item={item}
                  active={activeShape === item.id}
                  playing={false}
                  onMouseDown={(event) => startDrag(event, item)}
                  onSelect={() => setActiveShape(item.id)}
                  onText={(text) => { if (text !== item.text) void editShape(item.id, text); }}
                />
              ))}
              {slide.imageCount > 0 && !slide.shapes.some((item) => item.kind === "image" && item.src) && (
                <span className="slide-media-note">此页包含 {slide.imageCount} 张图片，但未能解析媒体部件</span>
              )}
            </div>
          )}
        </div>
        <label className="slide-notes">
          备注
          <textarea
            value={slide?.notes ?? ""}
            placeholder="演讲者备注"
            onChange={(event) => slide && setSlide({ ...slide, notes: event.target.value })}
            onBlur={(event) => slide && void run({ op: "slideNotes", index: slide.index, notes: event.target.value })}
          />
        </label>
      </div>
    </div>
  );
}

function SlideShapeView({
  item,
  active,
  playing,
  onMouseDown,
  onSelect,
  onText,
}: {
  item: SlideShape;
  active: boolean;
  playing?: boolean;
  onMouseDown?: (event: MouseEvent) => void;
  onSelect?: () => void;
  onText?: (text: string) => void;
}) {
  const box = {
    left: `${item.x * 100}%`,
    top: `${item.y * 100}%`,
    width: `${item.width * 100}%`,
    height: `${item.height * 100}%`,
  };
  if (item.kind === "image") {
    const bleed = item.width >= 0.92 && item.height >= 0.92 && item.x <= 0.04 && item.y <= 0.04;
    return (
      <div
        className={`slide-shape slide-image${bleed ? " slide-image-bleed" : ""}${active ? " active" : ""}`}
        data-shape-kind="image"
        data-shape-id={item.id}
        style={box}
        onMouseDown={onMouseDown}
        onClick={onSelect}
      >
        {item.src
          ? <img src={item.src} alt="" draggable={false} />
          : <span className="slide-image-fallback">图片</span>}
      </div>
    );
  }
  if (item.kind === "table" && item.table) {
    return (
      <div
        className={`slide-shape slide-table${active ? " active" : ""}`}
        data-shape-kind="table"
        data-shape-id={item.id}
        style={{ ...box, fontSize: `${item.fontSize}px`, color: item.color }}
        onMouseDown={onMouseDown}
        onClick={onSelect}
      >
        <table>
          <tbody>
            {item.table.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.map((cell, cellIndex) => cell.hidden ? null : (
                  <td key={cellIndex} colSpan={cell.colSpan} rowSpan={cell.rowSpan}>{cell.text}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  return (
    <div
      className={`slide-shape slide-text${active ? " active" : ""}${item.fromLayout ? " slide-layout-ph" : ""}`}
      data-shape-kind="text"
      data-shape-id={item.id}
      contentEditable={!playing && !item.fromLayout}
      suppressContentEditableWarning
      style={{
        ...box,
        fontSize: `${item.fontSize}px`,
        color: item.color,
        fontWeight: item.bold ? 700 : 400,
        fontStyle: item.italic ? "italic" : "normal",
        textAlign: item.align,
        background: item.fill,
      }}
      onMouseDown={onMouseDown}
      onClick={onSelect}
      onBlur={(event) => {
        const text = event.currentTarget.innerText.replace(/\n$/, "");
        onText?.(text);
      }}
    >{item.text}</div>
  );
}
