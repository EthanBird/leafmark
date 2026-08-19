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
  rootRef?: { current: HTMLElement | null };
}

export function AskAiToolbar({ path, kind, location, rootRef }: AskAiToolbarProps) {
  const [open, setOpen] = useState<{ text: string; x: number; y: number } | null>(null);

  useEffect(() => {
    const syncFromEvent = (event: Event) => {
      if (ignoreAskAiTarget(event.target)) return;
      window.setTimeout(() => {
        const root = rootRef?.current
          ?? (event.target instanceof Element ? event.target.closest(".document-host") : null)
          ?? document.querySelector(".document-host");
        const selected = selectionInside(root);
        if (!selected) {
          setOpen((current) => current ? null : current);
          return;
        }
        const position = askAiToolbarPosition(selected.rect);
        setOpen((current) => {
          if (current && current.text === selected.text && current.x === position.x && current.y === position.y) return current;
          return { text: selected.text, x: position.x, y: position.y };
        });
      }, 0);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(null);
      else syncFromEvent(event);
    };
    const onScroll = () => setOpen(null);
    document.addEventListener("mouseup", syncFromEvent);
    document.addEventListener("touchend", syncFromEvent, { passive: true });
    document.addEventListener("selectionchange", syncFromEvent);
    document.addEventListener("keyup", syncFromEvent);
    document.addEventListener("keydown", onKey);
    document.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mouseup", syncFromEvent);
      document.removeEventListener("touchend", syncFromEvent);
      document.removeEventListener("selectionchange", syncFromEvent);
      document.removeEventListener("keyup", syncFromEvent);
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
  compact,
}: {
  getSelection: () => AskAiSelection | null | Promise<AskAiSelection | null>;
  disabled?: boolean;
  compact?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className={compact ? "ask-ai-action" : undefined}
      title="划词问 AI"
      disabled={disabled || busy}
      onMouseDown={(event) => event.preventDefault()}
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
