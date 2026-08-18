import { Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  ASK_AI_INTENTS,
  askAiAbout,
  selectionInside,
  type AskAiIntent,
  type AskAiSelection,
} from "../ask-ai";

interface AskAiToolbarProps {
  path?: string;
  kind?: string;
  location?: string;
  rootRef?: React.RefObject<HTMLElement | null>;
}

export function AskAiToolbar({ path, kind, location, rootRef }: AskAiToolbarProps) {
  const [open, setOpen] = useState<{ text: string; x: number; y: number } | null>(null);
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onMouseUp = () => {
      window.setTimeout(() => {
        const root = rootRef?.current ?? document.querySelector(".document-host");
        const selected = selectionInside(root);
        if (!selected) {
          setOpen(null);
          return;
        }
        const width = 280;
        const left = Math.max(8, Math.min(selected.rect.left, window.innerWidth - width - 8));
        const top = Math.max(8, Math.min(selected.rect.bottom + 6, window.innerHeight - 48));
        setOpen({ text: selected.text, x: left, y: top });
      }, 0);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(null);
    };
    const onScroll = () => setOpen(null);
    document.addEventListener("mouseup", onMouseUp);
    document.addEventListener("keyup", onMouseUp);
    document.addEventListener("keydown", onKey);
    document.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mouseup", onMouseUp);
      document.removeEventListener("keyup", onMouseUp);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, [rootRef]);

  if (!open) return null;
  const payload: AskAiSelection = { text: open.text, path, kind, location };
  return (
    <div
      ref={barRef}
      className="ask-ai-toolbar"
      role="toolbar"
      aria-label="划词问 AI"
      style={{ left: open.x, top: open.y }}
      onMouseDown={(event) => event.preventDefault()}
    >
      <Sparkles size={12} />
      {ASK_AI_INTENTS.map((intent) => (
        <button
          key={intent.id}
          type="button"
          title={intent.title}
          onClick={() => {
            askAiAbout(payload, intent.id as AskAiIntent);
            setOpen(null);
          }}
        >{intent.label}</button>
      ))}
    </div>
  );
}

export function AskAiRibbonButton({ getSelection, disabled }: { getSelection: () => AskAiSelection; disabled?: boolean }) {
  return (
    <button
      type="button"
      title="划词问 AI"
      disabled={disabled}
      onClick={() => {
        const selection = getSelection();
        if (!selection.text.trim()) return;
        askAiAbout(selection, "ask");
      }}
    >
      <Sparkles size={14} /> 问 AI
    </button>
  );
}
