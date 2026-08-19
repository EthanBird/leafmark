import { packageText, type OfficePackage } from "./package";
import { xmlAttr } from "./xml";

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  emf: "image/emf",
  wmf: "image/wmf",
  tif: "image/tiff",
  tiff: "image/tiff",
};

export function parseRelationships(xml: string) {
  const rels = new Map<string, string>();
  if (!xml) return rels;
  for (const match of xml.matchAll(/<(?:[\w.-]+:)?Relationship\b[^>]*>/g)) {
    const id = xmlAttr(match[0], "Id");
    const target = xmlAttr(match[0], "Target");
    if (id && target) rels.set(id, target.replace(/\\/g, "/"));
  }
  return rels;
}

export function resolvePackagePart(baseDir: string, target: string) {
  const normalized = target.replace(/\\/g, "/");
  if (normalized.startsWith("/")) return normalized.replace(/^\/+/, "");
  const base = baseDir.replace(/\\/g, "/").replace(/\/?[^/]*$/, "/");
  const parts = `${base}${normalized}`.split("/");
  const stack: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") stack.pop();
    else stack.push(part);
  }
  return stack.join("/");
}

export function mimeFromPart(part: string) {
  const ext = part.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

export function bytesToDataUrl(bytes: Uint8Array, mime: string) {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

export function mediaDataUrl(files: OfficePackage, part: string) {
  const bytes = files[part] ?? files[part.replace(/\\/g, "/")];
  if (!bytes?.length) return undefined;
  return bytesToDataUrl(bytes, mimeFromPart(part));
}

export function relationshipMedia(files: OfficePackage, relsPath: string, baseDir: string) {
  const rels = parseRelationships(packageText(files, relsPath, false));
  const media = new Map<string, string>();
  for (const [id, target] of rels) {
    if (/^https?:|^file:/i.test(target)) continue;
    const part = resolvePackagePart(baseDir, target);
    const url = mediaDataUrl(files, part);
    if (url) media.set(id, url);
  }
  return { rels, media };
}

export interface DrawingExtent {
  x: number;
  y: number;
  cx: number;
  cy: number;
}

export function parseXfrm(xml: string): DrawingExtent | null {
  const xfrm = /<(?:(?:a|p):)?xfrm\b[\s\S]*?<\/(?:(?:a|p):)?xfrm>/.exec(xml)?.[0]
    ?? /<(?:(?:a|p):)?xfrm\b[^>]*\/>/.exec(xml)?.[0]
    ?? xml;
  const off = /<(?:a:)?off\b[^>]*\/?>/.exec(xfrm)?.[0] ?? "";
  const ext = /<(?:a:)?ext\b[^>]*\/?>/.exec(xfrm)?.[0] ?? "";
  if (!off && !ext) return null;
  return {
    x: Number(xmlAttr(off, "x") || "0"),
    y: Number(xmlAttr(off, "y") || "0"),
    cx: Number(xmlAttr(ext, "cx") || "0"),
    cy: Number(xmlAttr(ext, "cy") || "0"),
  };
}

export function emuToPx(emu: number) {
  if (!Number.isFinite(emu) || emu <= 0) return undefined;
  return Math.max(8, Math.round(emu / 9525));
}
