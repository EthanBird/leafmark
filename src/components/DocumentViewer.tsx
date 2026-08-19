import { FileCode2, FileSpreadsheet, FileText, MonitorPlay } from "lucide-react";
import { useMemo } from "react";
import { officeAssetUrl } from "../office/office-client";
import type { DocumentKind } from "../types";

interface DocumentViewerProps {
  assetPath: string;
  name: string;
}

export function DocumentViewer({ assetPath, name }: DocumentViewerProps) {
  const source = useMemo(() => officeAssetUrl(assetPath), [assetPath]);
  return (
    <div className="binary-viewer pdf-viewer">
      <iframe src={source} title={`PDF：${name}`} />
    </div>
  );
}

export function documentKindIcon(kind: DocumentKind) {
  if (kind === "spreadsheet") return FileSpreadsheet;
  if (kind === "presentation") return MonitorPlay;
  if (kind === "code") return FileCode2;
  return FileText;
}
