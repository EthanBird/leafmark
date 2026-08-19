import { FileCode2, FileSpreadsheet, FileText, MonitorPlay } from "lucide-react";
import type { DocumentKind } from "../types";
import { PdfViewer } from "./office/PdfViewer";

interface DocumentViewerProps {
  assetPath: string;
  name: string;
}

export function DocumentViewer({ assetPath, name }: DocumentViewerProps) {
  return <PdfViewer assetPath={assetPath} name={name} />;
}

export function documentKindIcon(kind: DocumentKind) {
  if (kind === "spreadsheet") return FileSpreadsheet;
  if (kind === "presentation") return MonitorPlay;
  if (kind === "code") return FileCode2;
  return FileText;
}
