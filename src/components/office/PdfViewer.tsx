import { ChevronLeft, ChevronRight, FileText, Minus, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { officeAssetUrl } from "../../office/office-client";
import { ViewerLoading, ViewerMessage } from "./ViewerChrome";

interface PdfViewerProps {
  assetPath: string;
  name: string;
}

export function PdfViewer({ assetPath, name }: PdfViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pdfRef = useRef<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [scale, setScale] = useState(1.15);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [fallback, setFallback] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    setFallback(false);
    setPage(1);
    void (async () => {
      try {
        const pdfjs = await import("pdfjs-dist");
        const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
        pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
        const response = await fetch(officeAssetUrl(assetPath));
        if (!response.ok) throw new Error(`无法读取 PDF（HTTP ${response.status}）`);
        const data = await response.arrayBuffer();
        const pdf = await pdfjs.getDocument({
          data,
          isEvalSupported: false,
          disableFontFace: false,
          useSystemFonts: true,
        }).promise;
        if (cancelled) {
          await pdf.destroy();
          return;
        }
        pdfRef.current = pdf;
        setPages(pdf.numPages);
        setLoading(false);
      } catch (reason) {
        if (cancelled) return;
        pdfRef.current = null;
        setError(reason instanceof Error ? reason.message : String(reason));
        setFallback(true);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      void pdfRef.current?.destroy();
      pdfRef.current = null;
    };
  }, [assetPath]);

  useEffect(() => {
    const pdf = pdfRef.current;
    const canvas = canvasRef.current;
    if (!pdf || !canvas || loading || fallback) return;
    let cancelled = false;
    void (async () => {
      const current = await pdf.getPage(page);
      if (cancelled) return;
      const viewport = current.getViewport({ scale });
      const context = canvas.getContext("2d");
      if (!context) return;
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      canvas.style.width = `${Math.ceil(viewport.width)}px`;
      canvas.style.height = `${Math.ceil(viewport.height)}px`;
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      await current.render({ canvasContext: context, viewport }).promise;
    })().catch((reason) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => { cancelled = true; };
  }, [page, scale, loading, fallback, assetPath]);

  if (loading) return <ViewerLoading label={`正在打开 ${name}`} />;
  if (fallback) {
    return (
      <div className="binary-viewer pdf-viewer">
        {error && <ViewerMessage icon={<FileText />} title="改用系统 PDF 查看器" message={error} />}
        <iframe src={officeAssetUrl(assetPath)} title={`PDF：${name}`} />
      </div>
    );
  }

  return (
    <div className="binary-viewer pdf-js-viewer">
      <div className="pdf-js-toolbar" role="toolbar" aria-label="PDF 阅读">
        <button type="button" title="上一页" disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}><ChevronLeft size={14} /></button>
        <label>
          <input
            type="number"
            min={1}
            max={pages}
            value={page}
            onChange={(event) => setPage(Math.max(1, Math.min(pages, Number(event.target.value) || 1)))}
          />
          / {pages}
        </label>
        <button type="button" title="下一页" disabled={page >= pages} onClick={() => setPage((value) => Math.min(pages, value + 1))}><ChevronRight size={14} /></button>
        <span />
        <button type="button" title="缩小" onClick={() => setScale((value) => Math.max(0.5, Math.round((value - 0.15) * 100) / 100))}><Minus size={14} /></button>
        <small>{Math.round(scale * 100)}%</small>
        <button type="button" title="放大" onClick={() => setScale((value) => Math.min(2.5, Math.round((value + 0.15) * 100) / 100))}><Plus size={14} /></button>
        <strong>{name}</strong>
      </div>
      <div className="pdf-js-pages">
        {error && <p className="pdf-js-error">{error}</p>}
        <canvas ref={canvasRef} />
      </div>
    </div>
  );
}
