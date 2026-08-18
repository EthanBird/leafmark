import { openDocx, openRtf, serializeWord, type WordDocument } from "../word";
import { openSpreadsheet, serializeWorkbook, type WorkbookModel } from "../sheet";
import { openOdp, openPptx, serializePresentation, type PresentationDocument } from "../slide";
import type { OfficeKind } from "../types";

export type OfficeModel = WordDocument | WorkbookModel | PresentationDocument;

export interface CompatibilityDocument {
  type: "compatibility";
  title: string;
  message: string;
}

export function openOfficeModel(kind: OfficeKind, format: string, buffer: ArrayBuffer): OfficeModel | CompatibilityDocument {
  const normalized = format.toLowerCase();
  if (kind === "word") {
    if (normalized === "docx") return openDocx(buffer);
    if (normalized === "rtf") return openRtf(buffer);
    return { type: "compatibility", title: "旧版 Word 文档", message: "二进制 .doc 需要 Microsoft Office 排版引擎才能完整还原。原件已安全保留，可交给系统应用打开。" };
  }
  if (kind === "spreadsheet") return openSpreadsheet(buffer, normalized);
  if (kind === "presentation") {
    if (normalized === "pptx") return openPptx(buffer);
    if (normalized === "odp") return openOdp(buffer);
    return { type: "compatibility", title: "旧版 PowerPoint 文档", message: "二进制 .ppt 需要 Microsoft Office 排版引擎才能完整还原。原件已安全保留，可交给系统应用打开。" };
  }
  return { type: "compatibility", title: "暂不支持的格式", message: `无法解析 ${format.toUpperCase()} 文档。` };
}

export function serializeOfficeModel(model: OfficeModel) {
  if (model.type === "word") return serializeWord(model);
  if (model.type === "spreadsheet") return serializeWorkbook(model);
  return serializePresentation(model);
}

export function isWord(model: OfficeModel): model is WordDocument {
  return model.type === "word";
}

export function isWorkbook(model: OfficeModel): model is WorkbookModel {
  return model.type === "spreadsheet";
}

export function isPresentation(model: OfficeModel): model is PresentationDocument {
  return model.type === "presentation";
}
