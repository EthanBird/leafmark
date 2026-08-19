import { Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import {
  ASK_AI_INTENTS,
  askAiAbout,
  askAiToolbarPosition,
  ignoreAskAiTarget,
  selectionInside,
  type AskAiSelection,
} from "../ask-ai";

interface AskAiToolbarProps {
  path?: string;
  kind?: AskAiSelection["kind"];
  location?: string;
  rootRef?: React.RefObject<HTMLElement | null>;
}

export function AskAiToolbar({ path, kind, location, rootRef }: AskAiToolbarProps) {
  const [open, setOpen] = useState<{ text: string; x: number; y: number } | null>(null);

  useEffect(() => {
    const onMouseUp = (event: Event) => {
      if (ignoreAskAiTarget(event.target)) return;
      window.setTimeout(() => {
        const root = rootRef?.current
          ?? (event.target instanceof Element ? event.target.closest(".document-host") : null);
        const selected = selectionInside(root);
        if (!selected) {
          setOpen(null);
          return;
        }
        const position = askAiToolbarPosition(selected.rect);
        setOpen({ text: selected.text, x: position.x, y: position.y });
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
            askAiAbout(payload, intent.id);
            setOpen(null);
          }}
        >{intent.label}</button>
      ))}
    </div>
  );
}

export function AskAiRibbonButton({
  getSelection,
  disabled,
}: {
  getSelection: () => AskAiSelection | null | Promise<AskAiSelection | null>;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      title="划词问 AI"
      disabled={disabled || busy}
      onClick={() => {
        void (async () => {
          setBusy(true);
          try {
            const selection = await getSelection();
            if (!selection?.text.trim()) return;
            askAiAbout(selection, "ask");
          } finally {
            setBusy(false);
          }
        })();
      }}
    >
      <Sparkles size={14} /> 问 AI
    </button>
  );
}
