import { openPath } from "@tauri-apps/plugin-opener";
import { AlertTriangle } from "lucide-react";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import {
  isOfficeEditableFormat,
  officeAssetUrl,
  officeDocumentStatus,
  openOfficeDocument,
  serializeOfficeDocument,
} from "../office/office-client";
import { OFFICE_MUTATED_EVENT } from "../ask-ai";
import type { PresentationOpenResult, SpreadsheetOpenResult, WordOpenResult } from "../office/types";
import type { DocumentKind } from "../types";
import { PresentationEditor } from "./office/PresentationEditor";
import { SpreadsheetEditor } from "./office/SpreadsheetEditor";
import { ViewerLoading, ViewerMessage } from "./office/ViewerChrome";
import { WordEditor } from "./office/WordEditor";

export interface OfficeEditorHandle {
  isDirty(): boolean;
  serialize(): Promise<Uint8Array>;
  markSaved(): void;
  markDirty(): void;
  reload(): Promise<void>;
}

interface OfficeEditorProps {
  documentKey: string;
  kind: Exclude<DocumentKind, "markdown" | "code" | "unsupported">;
  format: string;
  assetPath: string;
  name: string;
  onDirtyChange: (dirty: boolean) => void;
}

export const OfficeEditor = forwardRef<OfficeEditorHandle, OfficeEditorProps>(function OfficeEditor(props, ref) {
  if (props.kind === "pdf") return <PdfViewer assetPath={props.assetPath} name={props.name} />;
  return <OfficeDocumentEditor {...props} kind={props.kind} ref={ref} />;
});

const OfficeDocumentEditor = forwardRef<OfficeEditorHandle, Omit<OfficeEditorProps, "kind"> & { kind: "word" | "spreadsheet" | "presentation" }>(
  function OfficeDocumentEditor({ documentKey, kind, format, assetPath, name, onDirtyChange }, ref) {
    const dirtyRef = useRef(false);
    const [result, setResult] = useState<WordOpenResult | SpreadsheetOpenResult | PresentationOpenResult | { type: "compatibility"; title: string; message: string } | null>(null);
    const [error, setError] = useState("");
    const [revision, setRevision] = useState(0);
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

    useEffect(() => {
      const onMutated = (event: Event) => {
        const key = (event as CustomEvent<{ key?: string }>).detail?.key;
        if (key !== documentKey) return;
        void officeDocumentStatus(documentKey).then((snapshot) => {
          if (snapshot) {
            setResult(snapshot);
            setRevision((value) => value + 1);
          }
        }).catch(() => undefined);
      };
      window.addEventListener(OFFICE_MUTATED_EVENT, onMutated);
      return () => window.removeEventListener(OFFICE_MUTATED_EVENT, onMutated);
    }, [documentKey]);

    useImperativeHandle(ref, () => ({
      isDirty: () => dirtyRef.current,
      serialize: () => serializeOfficeDocument(documentKey),
      markSaved: () => markClean(),
      markDirty,
      reload: async () => {
        const snapshot = await officeDocumentStatus(documentKey);
        if (snapshot) {
          setResult(snapshot);
          setRevision((value) => value + 1);
        }
      },
    }), [documentKey, markClean, markDirty]);

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
    if (result.type === "word") return <WordEditor key={revision} documentKey={documentKey} initial={result} editable={isOfficeEditableFormat(kind, format)} onDirty={markDirty} />;
    if (result.type === "spreadsheet") return <SpreadsheetEditor key={revision} documentKey={documentKey} initial={result} onDirty={markDirty} />;
    return <PresentationEditor key={revision} documentKey={documentKey} initial={result} onDirty={markDirty} />;
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
