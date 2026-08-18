import { AlignCenter, AlignLeft, AlignRight, Bold, Copy, Italic, Plus, Redo2, Trash2, Undo2 } from "lucide-react";
import { useState } from "react";
import { addPresentationSlide, loadPresentationSlide, mutateOffice, redoOffice, undoOffice, updatePresentationShape } from "../../office/office-client";
import type { PresentationOpenResult } from "../../office/types";
import type { SlideModel } from "../../office/slide";
import { ViewerLoading } from "./ViewerChrome";

export function PresentationEditor({ documentKey, initial, onDirty }: { documentKey: string; initial: PresentationOpenResult; onDirty: () => void }) {
  const [slides, setSlides] = useState(initial.slides);
  const [slide, setSlide] = useState<SlideModel | null>(initial.active);
  const [loading, setLoading] = useState(false);
  const [activeShape, setActiveShape] = useState<string | null>(initial.active?.shapes[0]?.id ?? null);

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
    const next = await updatePresentationShape(documentKey, slide.index, shapeId, text);
    setSlide(next);
    setSlides((current) => current.map((item) => item.index === next?.index ? { index: next.index, title: next.title } : item));
  };

  const run = async (mutation: Parameters<typeof mutateOffice>[1]) => {
    onDirty();
    const result = await mutateOffice(documentKey, mutation) as { slides?: Array<{ index: number; title: string }>; slide?: SlideModel | null };
    if (result.slides) setSlides(result.slides);
    if (result.slide) {
      setSlide(result.slide);
      setActiveShape(result.slide.shapes[0]?.id ?? null);
    } else if (slide) await openSlide(Math.min(slide.index, (result.slides?.length ?? 1) - 1));
  };

  const history = async (direction: "undo" | "redo") => {
    const result = direction === "undo" ? await undoOffice(documentKey) : await redoOffice(documentKey);
    if (!result.ok || result.snapshot.type !== "presentation") return;
    onDirty();
    setSlides(result.snapshot.slides);
    setSlide(result.snapshot.active);
  };

  const shape = slide?.shapes.find((item) => item.id === activeShape);

  return (
    <div className="binary-viewer presentation-viewer office-editor">
      <div className="office-ribbon">
        <button type="button" title="撤销" onClick={() => void history("undo")}><Undo2 size={14} /></button>
        <button type="button" title="重做" onClick={() => void history("redo")}><Redo2 size={14} /></button>
        <span />
        <button type="button" title="复制幻灯片" onClick={() => slide && void run({ op: "slideDuplicate", index: slide.index })}><Copy size={14} /></button>
        <button type="button" title="删除幻灯片" onClick={() => slide && void run({ op: "slideDelete", index: slide.index })}><Trash2 size={14} /></button>
        <span />
        <button type="button" title="加粗" disabled={!shape} onClick={() => slide && shape && void run({ op: "slideShape", index: slide.index, shapeId: shape.id, patch: { bold: !shape.bold } })}><Bold size={14} /></button>
        <button type="button" title="斜体" disabled={!shape} onClick={() => slide && shape && void run({ op: "slideShape", index: slide.index, shapeId: shape.id, patch: { italic: !shape.italic } })}><Italic size={14} /></button>
        <button type="button" title="左对齐" disabled={!shape} onClick={() => slide && shape && void run({ op: "slideShape", index: slide.index, shapeId: shape.id, patch: { align: "left" } })}><AlignLeft size={14} /></button>
        <button type="button" title="居中" disabled={!shape} onClick={() => slide && shape && void run({ op: "slideShape", index: slide.index, shapeId: shape.id, patch: { align: "center" } })}><AlignCenter size={14} /></button>
        <button type="button" title="右对齐" disabled={!shape} onClick={() => slide && shape && void run({ op: "slideShape", index: slide.index, shapeId: shape.id, patch: { align: "right" } })}><AlignRight size={14} /></button>
        <label className="office-color">
          背景
          <input type="color" value={slide?.background || "#ffffff"} onChange={(event) => slide && void run({ op: "slideBackground", index: slide.index, background: event.target.value })} />
        </label>
      </div>
      <nav className="slide-list" aria-label="幻灯片">
        {slides.map((item) => <button type="button" key={item.index} className={slide?.index === item.index ? "active" : ""} onClick={() => void openSlide(item.index)}><span>{item.index + 1}</span><strong>{item.title}</strong></button>)}
        <button type="button" className="slide-add" onClick={() => void addPresentationSlide(documentKey).then((result) => { setSlides(result.slides); setSlide(result.slide); onDirty(); })}><Plus size={12} /> 新建幻灯片</button>
      </nav>
      <div className="slide-stage">
        {loading && !slide ? <ViewerLoading label="正在载入幻灯片" /> : slide && <div className="slide-canvas" style={{ background: slide.background }}>
          {slide.shapes.map((item) => <div
            key={item.id}
            className={`slide-shape${activeShape === item.id ? " active" : ""}`}
            contentEditable
            suppressContentEditableWarning
            style={{
              left: `${item.x * 100}%`,
              top: `${item.y * 100}%`,
              width: `${item.width * 100}%`,
              height: `${item.height * 100}%`,
              fontSize: `${item.fontSize}px`,
              color: item.color,
              fontWeight: item.bold ? 700 : 400,
              fontStyle: item.italic ? "italic" : "normal",
              textAlign: item.align,
            }}
            onMouseDown={() => setActiveShape(item.id)}
            onBlur={(event) => {
              const text = event.currentTarget.innerText.replace(/\n$/, "");
              if (text !== item.text) void editShape(item.id, text);
            }}
          >{item.text}</div>)}
          {slide.imageCount > 0 && <span className="slide-media-note">此页包含 {slide.imageCount} 张图片；原件媒体随 OOXML 包无损保留</span>}
        </div>}
      </div>
    </div>
  );
}
