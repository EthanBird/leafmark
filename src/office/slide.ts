import { decodeXml, encodeXml, xmlAttr } from "./xml";
import { clonePackage, findPackagePart, packageText, setPackageText, type OfficePackage, unzipPackage, zipPackage } from "./package";
import { parseXfrm, relationshipMedia } from "./media";

export interface SlideRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  fontSize?: number;
  color?: string;
}

export interface SlideShape {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
  color: string;
  bold: boolean;
  italic?: boolean;
  align: "left" | "center" | "right";
  text: string;
  fill?: string;
  kind?: "text" | "rect" | "image" | "table";
  src?: string;
  table?: string[][];
  originalXml?: string;
  dirty?: boolean;
}

export interface SlideModel {
  index: number;
  title: string;
  background: string;
  shapes: SlideShape[];
  imageCount: number;
  path: string;
  notes?: string;
  hidden?: boolean;
  layout?: "title" | "titleContent" | "blank" | "twoContent";
  originalXml?: string;
  dirty?: boolean;
}

export interface PresentationDocument {
  type: "presentation";
  format: "pptx" | "odp";
  slides: SlideModel[];
  files?: OfficePackage;
  width: number;
  height: number;
  editable: boolean;
}

export function openPptx(buffer: ArrayBuffer): PresentationDocument {
  const files = unzipPackage(buffer);
  const presentation = packageText(files, "ppt/presentation.xml", false);
  const sizeMatch = /<(?:p:)?sldSz\b[^>]*cx="(\d+)"[^>]*cy="(\d+)"/.exec(presentation)
    ?? /<(?:p:)?sldSz\b[^>]*cy="(\d+)"[^>]*cx="(\d+)"/.exec(presentation);
  const width = Number(sizeMatch?.[1] ?? 12_192_000);
  const height = Number(sizeMatch?.[2] ?? 6_858_000);
  const names = findPackagePart(files, /^ppt\/slides\/slide\d+\.xml$/);
  const slides = names.map((path, index) => {
    const model = parsePptxSlide(packageText(files, path), index, path, width, height, files);
    const notesXml = packageText(files, `ppt/notesSlides/notesSlide${index + 1}.xml`, false);
    if (notesXml) model.notes = extractSlideText(notesXml);
    if (/show="0"/.test(packageText(files, path))) model.hidden = true;
    return model;
  });
  return { type: "presentation", format: "pptx", slides, files, width, height, editable: true };
}

function parsePptxSlide(xml: string, index: number, path: string, slideWidth: number, slideHeight: number, files?: OfficePackage): SlideModel {
  const background = /<(?:a:)?srgbClr[^>]*val="([0-9A-Fa-f]{6})"/.exec(/<(?:p:)?bg\b[\s\S]*?<\/(?:p:)?bg>/.exec(xml)?.[0] ?? "")?.[1] ?? "ffffff";
  const relsPath = path.replace(/slides\/([^/]+)$/, "slides/_rels/$1.rels");
  const media = files ? relationshipMedia(files, relsPath, path).media : new Map<string, string>();
  const tree = /<(?:p:)?spTree\b[\s\S]*<\/(?:p:)?spTree>/.exec(xml)?.[0] ?? xml;
  const shapes = parseSlideTree(tree, index, slideWidth, slideHeight, media);
  const imageCount = shapes.filter((shape) => shape.kind === "image").length || [...xml.matchAll(/<(?:p:)?pic\b/g)].length;
  return {
    index,
    title: shapes.find((shape) => shape.text.trim())?.text.slice(0, 80) || `幻灯片 ${index + 1}`,
    background: `#${background}`,
    shapes,
    imageCount,
    path,
    originalXml: xml,
  };
}

function parseSlideTree(xml: string, index: number, slideWidth: number, slideHeight: number, media: Map<string, string>, origin?: { x: number; y: number; sx: number; sy: number }): SlideShape[] {
  const shapes: SlideShape[] = [];
  const ox = origin?.x ?? 0;
  const oy = origin?.y ?? 0;
  const sx = origin?.sx ?? 1;
  const sy = origin?.sy ?? 1;
  const push = (shape: SlideShape) => {
    shape.x = ox + shape.x * sx;
    shape.y = oy + shape.y * sy;
    shape.width *= sx;
    shape.height *= sy;
    shapes.push(shape);
  };
  for (const match of xml.matchAll(/<(?:p:)?grpSp\b[\s\S]*?<\/(?:p:)?grpSp>/g)) {
    const group = match[0];
    const inner = group.replace(/^<(?:p:)?grpSp\b[^>]*>/, "").replace(/<\/(?:p:)?grpSp>$/, "");
    const xfrm = parseXfrm(/<(?:p:)?grpSpPr\b[\s\S]*?<\/(?:p:)?grpSpPr>/.exec(group)?.[0] ?? group);
    const chExt = /<(?:a:)?chExt\b[^>]*\/?>/.exec(group)?.[0] ?? "";
    const childOrigin = xfrm
      ? {
          x: ox + (xfrm.x / slideWidth) * sx,
          y: oy + (xfrm.y / slideHeight) * sy,
          sx: sx * ((xfrm.cx || 1) / (Number(xmlAttr(chExt, "cx")) || xfrm.cx || 1)),
          sy: sy * ((xfrm.cy || 1) / (Number(xmlAttr(chExt, "cy")) || xfrm.cy || 1)),
        }
        : origin;
    shapes.push(...parseSlideTree(inner, index, slideWidth, slideHeight, media, childOrigin));
  }
  const withoutGroups = xml.replace(/<(?:p:)?grpSp\b[\s\S]*?<\/(?:p:)?grpSp>/g, "");
  for (const match of withoutGroups.matchAll(/<(?:p:)?pic\b[\s\S]*?<\/(?:p:)?pic>/g)) {
    const pic = match[0];
    const transform = parseXfrm(pic);
    const embed = xmlAttr(/<(?:a:)?blip\b[^>]*>/.exec(pic)?.[0] ?? "", "r:embed")
      || xmlAttr(/<(?:a:)?blip\b[^>]*>/.exec(pic)?.[0] ?? "", "r:link");
    push({
      id: `${index}:${shapes.length + Math.random().toString(36).slice(2, 6)}`,
      x: transform ? transform.x / slideWidth : 0.08,
      y: transform ? transform.y / slideHeight : 0.08,
      width: transform ? transform.cx / slideWidth : 0.4,
      height: transform ? transform.cy / slideHeight : 0.3,
      text: "",
      fontSize: 12,
      color: "#202124",
      bold: false,
      align: "left",
      kind: "image",
      src: embed ? media.get(embed) : undefined,
      originalXml: pic,
    });
  }
  for (const match of withoutGroups.matchAll(/<(?:p:)?graphicFrame\b[\s\S]*?<\/(?:p:)?graphicFrame>/g)) {
    const frame = match[0];
    const tableXml = /<(?:a:)?tbl\b[\s\S]*?<\/(?:a:)?tbl>/.exec(frame)?.[0];
    if (!tableXml) continue;
    const transform = parseXfrm(frame);
    const rows = [...tableXml.matchAll(/<(?:a:)?tr\b[\s\S]*?<\/(?:a:)?tr>/g)].map((row) =>
      [...row[0].matchAll(/<(?:a:)?tc\b[\s\S]*?<\/(?:a:)?tc>/g)].map((cell) => extractSlideText(cell[0])),
    );
    push({
      id: `${index}:${shapes.length + Math.random().toString(36).slice(2, 6)}`,
      x: transform ? transform.x / slideWidth : 0.08,
      y: transform ? transform.y / slideHeight : 0.2,
      width: transform ? transform.cx / slideWidth : 0.84,
      height: transform ? transform.cy / slideHeight : Math.max(0.12, rows.length * 0.08),
      text: rows.map((row) => row.join(" ")).join("\n"),
      fontSize: 14,
      color: "#202124",
      bold: false,
      align: "left",
      kind: "table",
      table: rows,
      originalXml: frame,
    });
  }
  for (const match of withoutGroups.matchAll(/<(?:p:)?sp\b[\s\S]*?<\/(?:p:)?sp>/g)) {
    const shape = match[0];
    const text = extractSlideText(shape);
    const transform = parseXfrm(shape);
    const fontSize = Number(xmlAttr(/<(?:a:)?rPr\b[^>]*>/.exec(shape)?.[0] ?? /<(?:a:)?defRPr\b[^>]*>/.exec(shape)?.[0] ?? "", "sz") || 1800) / 100;
    const color = xmlAttr(/<(?:a:)?srgbClr\b[^>]*>/.exec(shape)?.[0] ?? "", "val") || "202124";
    const alignValue = xmlAttr(/<(?:a:)?pPr\b[^>]*>/.exec(shape)?.[0] ?? "", "algn");
    push({
      id: `${index}:${shapes.length}`,
      x: transform ? transform.x / slideWidth : 0.08,
      y: transform ? transform.y / slideHeight : 0.08 + shapes.length * 0.1,
      width: transform ? transform.cx / slideWidth : 0.84,
      height: transform ? transform.cy / slideHeight : 0.12,
      text,
      fontSize: Math.max(10, Math.min(72, fontSize || 18)),
      color: `#${color}`,
      bold: /<(?:a:)?rPr\b[^>]*b="1"/.test(shape),
      italic: /<(?:a:)?rPr\b[^>]*i="1"/.test(shape),
      align: alignValue === "ctr" ? "center" : alignValue === "r" ? "right" : "left",
      kind: "text",
      originalXml: shape,
    });
  }
  return shapes.map((shape, shapeIndex) => ({ ...shape, id: `${index}:${shapeIndex}` }));
}

function extractSlideText(xml: string) {
  return [...xml.matchAll(/<(?:a:)?t\b(?:\s[^>]*)?>([\s\S]*?)<\/(?:a:)?t>/g)]
    .map((match) => decodeXml(match[1]))
    .join("")
    .replace(/\u000b/g, "\n");
}

export function openOdp(buffer: ArrayBuffer): PresentationDocument {
  const files = unzipPackage(buffer);
  const xml = packageText(files, "content.xml");
  const pages = [...xml.matchAll(/<draw:page\b[\s\S]*?<\/draw:page>/g)];
  const slides = pages.map((page, index) => {
    const paragraphs = [...page[0].matchAll(/<text:p\b[\s\S]*?<\/text:p>/g)]
      .map((item) => decodeXml(item[0].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim())
      .filter(Boolean);
    return {
      index,
      title: paragraphs[0]?.slice(0, 80) || `幻灯片 ${index + 1}`,
      background: "#ffffff",
      shapes: paragraphs.map((text, shapeIndex) => ({
        id: `${index}:${shapeIndex}`,
        x: 0.08,
        y: 0.08 + shapeIndex * 0.11,
        width: 0.84,
        height: 0.1,
        text,
        fontSize: shapeIndex === 0 ? 28 : 18,
        color: "#202124",
        bold: shapeIndex === 0,
        align: "left" as const,
        originalXml: "",
        dirty: true,
      })),
      imageCount: 0,
      path: "content.xml",
      originalXml: page[0],
    };
  });
  return {
    type: "presentation",
    format: "odp",
    slides,
    files,
    width: 12_192_000,
    height: 6_858_000,
    editable: true,
  };
}

export function updateShapeText(slide: SlideModel, shapeId: string, text: string) {
  const shape = slide.shapes.find((item) => item.id === shapeId);
  if (!shape) return;
  shape.text = text;
  shape.dirty = true;
  slide.dirty = true;
  slide.title = slide.shapes[0]?.text.slice(0, 80) || `幻灯片 ${slide.index + 1}`;
}

export function updateShapeStyle(slide: SlideModel, shapeId: string, patch: Partial<Pick<SlideShape, "bold" | "italic" | "fontSize" | "align" | "color" | "text" | "fill">>) {
  const shape = slide.shapes.find((item) => item.id === shapeId);
  if (!shape) return;
  Object.assign(shape, patch);
  shape.dirty = true;
  shape.originalXml = undefined;
  slide.dirty = true;
  if (patch.text !== undefined) slide.title = slide.shapes[0]?.text.slice(0, 80) || `幻灯片 ${slide.index + 1}`;
}

export function deleteShape(slide: SlideModel, shapeId: string) {
  const index = slide.shapes.findIndex((item) => item.id === shapeId);
  if (index < 0) return undefined;
  const [removed] = slide.shapes.splice(index, 1);
  slide.dirty = true;
  slide.title = slide.shapes[0]?.text.slice(0, 80) || `幻灯片 ${slide.index + 1}`;
  return removed;
}

export function setSlideBackground(slide: SlideModel, background: string) {
  slide.background = background.startsWith("#") ? background : `#${background}`;
  slide.dirty = true;
  slide.originalXml = undefined;
}

function reindexSlides(document: PresentationDocument) {
  document.slides.forEach((slide, index) => {
    slide.index = index;
    slide.path = `ppt/slides/slide${index + 1}.xml`;
    slide.shapes.forEach((shape, shapeIndex) => {
      shape.id = `${index}:${shapeIndex}`;
    });
  });
}

export function deleteSlide(document: PresentationDocument, index: number) {
  if (document.slides.length <= 1) return document.slides[0];
  const [removed] = document.slides.splice(index, 1);
  reindexSlides(document);
  return removed;
}

export function duplicateSlide(document: PresentationDocument, index: number) {
  const source = document.slides[index];
  if (!source) return addBlankSlide(document);
  const copy: SlideModel = {
    ...source,
    shapes: source.shapes.map((shape) => ({ ...shape, dirty: true, originalXml: undefined })),
    dirty: true,
    originalXml: undefined,
  };
  document.slides.splice(index + 1, 0, copy);
  reindexSlides(document);
  return document.slides[index + 1];
}

export function addBlankSlide(document: PresentationDocument) {
  const index = document.slides.length;
  const slide: SlideModel = {
    index,
    title: "新幻灯片",
    background: "#ffffff",
    shapes: [
      {
        id: `${index}:0`,
        x: 0.1,
        y: 0.12,
        width: 0.8,
        height: 0.16,
        text: "单击编辑标题",
        fontSize: 32,
        color: "#202124",
        bold: true,
        align: "center",
        dirty: true,
      },
      {
        id: `${index}:1`,
        x: 0.1,
        y: 0.36,
        width: 0.8,
        height: 0.4,
        text: "单击编辑正文",
        fontSize: 18,
        color: "#3c4043",
        bold: false,
        align: "left",
        dirty: true,
      },
    ],
    imageCount: 0,
    path: `ppt/slides/slide${index + 1}.xml`,
    dirty: true,
  };
  document.slides.push(slide);
  return slide;
}

export function addTextBox(slide: SlideModel, patch?: Partial<SlideShape>) {
  const shape: SlideShape = {
    id: `${slide.index}:${slide.shapes.length}`,
    x: 0.12,
    y: 0.2 + slide.shapes.length * 0.08,
    width: 0.76,
    height: 0.18,
    text: "文本框",
    fontSize: 18,
    color: "#202124",
    bold: false,
    align: "left",
    kind: "text",
    dirty: true,
    ...patch,
  };
  slide.shapes.push(shape);
  slide.dirty = true;
  return shape;
}

export function moveShape(slide: SlideModel, shapeId: string, x: number, y: number, width?: number, height?: number) {
  const shape = slide.shapes.find((item) => item.id === shapeId);
  if (!shape) return;
  shape.x = x;
  shape.y = y;
  if (width != null) shape.width = width;
  if (height != null) shape.height = height;
  shape.dirty = true;
  slide.dirty = true;
}

export function setSlideNotes(slide: SlideModel, notes: string) {
  slide.notes = notes;
  slide.dirty = true;
}

export function hideSlide(slide: SlideModel, hidden: boolean) {
  slide.hidden = hidden;
  slide.dirty = true;
}

export function applySlideLayout(slide: SlideModel, layout: NonNullable<SlideModel["layout"]>) {
  slide.layout = layout;
  slide.dirty = true;
  slide.originalXml = undefined;
  if (layout === "blank") {
    slide.shapes = [];
    return;
  }
  if (layout === "title") {
    slide.shapes = slide.shapes.slice(0, 1);
    if (!slide.shapes.length) addTextBox(slide, { y: 0.35, height: 0.2, fontSize: 36, bold: true, align: "center", text: "标题" });
    return;
  }
  if (layout === "titleContent") {
    if (!slide.shapes.length) addTextBox(slide, { y: 0.08, height: 0.16, fontSize: 32, bold: true, align: "center", text: "标题" });
    if (slide.shapes.length < 2) addTextBox(slide, { y: 0.32, height: 0.5, fontSize: 18, text: "单击编辑正文" });
    return;
  }
  if (layout === "twoContent" && slide.shapes.length < 3) {
    if (!slide.shapes.length) addTextBox(slide, { y: 0.08, height: 0.14, fontSize: 28, bold: true, align: "center", text: "标题" });
    addTextBox(slide, { x: 0.08, y: 0.32, width: 0.4, height: 0.5, text: "左侧" });
    addTextBox(slide, { x: 0.52, y: 0.32, width: 0.4, height: 0.5, text: "右侧" });
  }
}

export function reorderSlides(document: PresentationDocument, from: number, to: number) {
  const [slide] = document.slides.splice(from, 1);
  document.slides.splice(Math.max(0, Math.min(to, document.slides.length)), 0, slide);
  document.slides.forEach((item, index) => { item.index = index; });
}

export function serializePresentation(document: PresentationDocument): Uint8Array {
  if (document.format === "odp") return serializeOdp(document);
  const files = document.files ? clonePackage(document.files) : minimalPptx();
  for (const slide of document.slides) {
    setPackageText(files, slide.path || `ppt/slides/slide${slide.index + 1}.xml`, serializeSlideXml(slide, document));
    if (slide.notes) {
      setPackageText(files, `ppt/notesSlides/notesSlide${slide.index + 1}.xml`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:notes xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Notes"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>${encodeXml(slide.notes)}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>`);
    }
  }
  ensurePresentationParts(files, document);
  return zipPackage(files);
}

function serializeSlideXml(slide: SlideModel, document: PresentationDocument) {
  if (slide.originalXml && slide.shapes.some((shape) => shape.dirty || !shape.originalXml)) {
    let xml = slide.originalXml;
    for (const shape of slide.shapes) {
      if (!shape.originalXml) continue;
      let next = shape.kind === "image" || shape.kind === "table"
        ? shape.originalXml
        : rewriteShapeText(shape.originalXml, shape.text);
      next = rewriteShapeXfrm(next, shape, document);
      xml = xml.replace(shape.originalXml, next);
      shape.originalXml = next;
    }
    const missing = slide.shapes.filter((shape) => !shape.originalXml);
    if (missing.length) {
      const extra = missing.map((shape) => shapeXml(shape, document)).join("");
      xml = xml.replace(/<\/(?:p:)?spTree>/, `${extra}</p:spTree>`);
    }
    return xml;
  }
  if (slide.originalXml && !slide.dirty) return slide.originalXml;
  const shapes = slide.shapes.map((shape) => shape.originalXml && (shape.kind === "image" || shape.kind === "table")
    ? rewriteShapeXfrm(shape.originalXml, shape, document)
    : shapeXml(shape, document)).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"${slide.hidden ? ` show="0"` : ""}><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="${slide.background.replace(/^#/, "")}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${document.width}" cy="${document.height}"/><a:chOff x="0" y="0"/><a:chExt cx="${document.width}" cy="${document.height}"/></a:xfrm></p:grpSpPr>${shapes}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
}

function rewriteShapeXfrm(xml: string, shape: SlideShape, document: PresentationDocument) {
  const x = Math.round(shape.x * document.width);
  const y = Math.round(shape.y * document.height);
  const cx = Math.round(shape.width * document.width);
  const cy = Math.round(shape.height * document.height);
  let next = xml.replace(/<(?:a:)?off\b[^>]*\/?>/, `<a:off x="${x}" y="${y}"/>`);
  next = next.replace(/<(?:a:)?ext\b[^>]*\/?>/, `<a:ext cx="${cx}" cy="${cy}"/>`);
  return next;
}

function rewriteShapeText(xml: string, text: string) {
  const encoded = encodeXml(text);
  if (/<(?:a:)?t\b/.test(xml)) {
    let replaced = false;
    return xml.replace(/<(?:a:)?t\b(?:\s[^>]*)?>[\s\S]*?<\/(?:a:)?t>/g, (match) => {
      if (replaced) return match.replace(/>[\s\S]*</, "><");
      replaced = true;
      return match.replace(/>[\s\S]*</, ` xml:space="preserve">${encoded}<`);
    });
  }
  return xml.replace(/<(?:p:)?txBody>[\s\S]*?<\/(?:p:)?txBody>/, `<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>${encoded}</a:t></a:r></a:p></p:txBody>`);
}

function shapeXml(shape: SlideShape, document: PresentationDocument) {
  const x = Math.round(shape.x * document.width);
  const y = Math.round(shape.y * document.height);
  const cx = Math.round(shape.width * document.width);
  const cy = Math.round(shape.height * document.height);
  const align = shape.align === "center" ? "ctr" : shape.align === "right" ? "r" : "l";
  const fill = shape.fill ? `<a:solidFill><a:srgbClr val="${shape.fill.replace(/^#/, "")}"/></a:solidFill>` : "";
  return `<p:sp><p:nvSpPr><p:cNvPr id="${Number(shape.id.split(":")[1] ?? 2) + 2}" name="Text"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${fill}</p:spPr><p:txBody><a:bodyPr wrap="square"/><a:lstStyle/><a:p><a:pPr algn="${align}"/><a:r><a:rPr lang="zh-CN" sz="${Math.round(shape.fontSize * 100)}" b="${shape.bold ? 1 : 0}" i="${shape.italic ? 1 : 0}" dirty="0"><a:solidFill><a:srgbClr val="${shape.color.replace(/^#/, "")}"/></a:solidFill></a:rPr><a:t>${encodeXml(shape.text)}</a:t></a:r></a:p></p:txBody></p:sp>`;
}

function serializeOdp(document: PresentationDocument) {
  const files = document.files ? clonePackage(document.files) : {};
  const pages = document.slides.map((slide, index) => {
    const paragraphs = slide.shapes.map((shape) => `<text:p>${encodeXml(shape.text)}</text:p>`).join("");
    return `<draw:page draw:name="page${index + 1}" draw:style-name="dp1">${paragraphs}</draw:page>`;
  }).join("");
  setPackageText(files, "content.xml", `<?xml version="1.0" encoding="UTF-8"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:presentation>${pages}</office:presentation></office:body></office:document-content>`);
  if (!files["mimetype"]) files["mimetype"] = new TextEncoder().encode("application/vnd.oasis.opendocument.presentation");
  return zipPackage(files);
}

function ensurePresentationParts(files: OfficePackage, document: PresentationDocument) {
  const sldIdLst = document.slides.map((_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 2}"/>`).join("");
  const presentation = packageText(files, "ppt/presentation.xml", false);
  if (presentation && /<(?:p:)?sldIdLst\b[\s\S]*?<\/(?:p:)?sldIdLst>/.test(presentation)) {
    setPackageText(files, "ppt/presentation.xml", presentation.replace(/<(?:p:)?sldIdLst\b[\s\S]*?<\/(?:p:)?sldIdLst>/, `<p:sldIdLst>${sldIdLst}</p:sldIdLst>`));
  } else {
    setPackageText(files, "ppt/presentation.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldIdLst>${sldIdLst}</p:sldIdLst><p:sldSz cx="${document.width}" cy="${document.height}" type="screen16x9"/></p:presentation>`);
  }
  const rels = document.slides.map((_, index) => `<Relationship Id="rId${index + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${index + 1}.xml"/>`).join("");
  setPackageText(files, "ppt/_rels/presentation.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`);
  const types = packageText(files, "[Content_Types].xml", false)
    || `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>`;
  const withoutSlides = types.replace(/<Override PartName="\/ppt\/slides\/slide\d+\.xml"[^/]*\/>/g, "");
  const slideTypes = document.slides.map((_, index) => `<Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join("");
  const notesTypes = document.slides.filter((slide) => slide.notes).map((slide) => `<Override PartName="/ppt/notesSlides/notesSlide${slide.index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>`).join("");
  setPackageText(files, "[Content_Types].xml", withoutSlides.replace("</Types>", `${slideTypes}${notesTypes}</Types>`));
}

function minimalPptx(): OfficePackage {
  return {
    "[Content_Types].xml": new TextEncoder().encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>`),
    "_rels/.rels": new TextEncoder().encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>`),
    "ppt/_rels/presentation.xml.rels": new TextEncoder().encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>`),
  };
}
