import { decodeXml, encodeXml, xmlAttr } from "./xml";
import { clonePackage, findPackagePart, packageText, setPackageText, type OfficePackage, unzipPackage, zipPackage } from "./package";

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
  const slides = names.map((path, index) => parsePptxSlide(packageText(files, path), index, path, width, height));
  return { type: "presentation", format: "pptx", slides, files, width, height, editable: true };
}

function parsePptxSlide(xml: string, index: number, path: string, slideWidth: number, slideHeight: number): SlideModel {
  const background = /<(?:a:)?srgbClr[^>]*val="([0-9A-Fa-f]{6})"/.exec(/<(?:p:)?bg\b[\s\S]*?<\/(?:p:)?bg>/.exec(xml)?.[0] ?? "")?.[1] ?? "ffffff";
  const shapes: SlideShape[] = [];
  for (const match of xml.matchAll(/<(?:p:)?sp\b[\s\S]*?<\/(?:p:)?sp>/g)) {
    const shape = match[0];
    const text = extractSlideText(shape);
    const transform = /<(?:a:)?off\b[^>]*x="(-?\d+)"[^>]*y="(-?\d+)"[\s\S]*?<(?:a:)?ext\b[^>]*cx="(\d+)"[^>]*cy="(\d+)"/.exec(shape);
    const fontSize = Number(xmlAttr(/<(?:a:)?rPr\b[^>]*>/.exec(shape)?.[0] ?? /<(?:a:)?defRPr\b[^>]*>/.exec(shape)?.[0] ?? "", "sz") || 1800) / 100;
    const color = xmlAttr(/<(?:a:)?srgbClr\b[^>]*>/.exec(shape)?.[0] ?? "", "val") || "202124";
    const alignValue = xmlAttr(/<(?:a:)?pPr\b[^>]*>/.exec(shape)?.[0] ?? "", "algn");
    shapes.push({
      id: `${index}:${shapes.length}`,
      x: transform ? Number(transform[1]) / slideWidth : 0.08,
      y: transform ? Number(transform[2]) / slideHeight : 0.08 + shapes.length * 0.1,
      width: transform ? Number(transform[3]) / slideWidth : 0.84,
      height: transform ? Number(transform[4]) / slideHeight : 0.12,
      text,
      fontSize: Math.max(10, Math.min(72, fontSize || 18)),
      color: `#${color}`,
      bold: /<(?:a:)?rPr\b[^>]*b="1"/.test(shape),
      italic: /<(?:a:)?rPr\b[^>]*i="1"/.test(shape),
      align: alignValue === "ctr" ? "center" : alignValue === "r" ? "right" : "left",
      originalXml: shape,
    });
  }
  const imageCount = [...xml.matchAll(/<(?:p:)?pic\b/g)].length;
  return {
    index,
    title: shapes[0]?.text.slice(0, 80) || `幻灯片 ${index + 1}`,
    background: `#${background}`,
    shapes,
    imageCount,
    path,
    originalXml: xml,
  };
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

export function serializePresentation(document: PresentationDocument): Uint8Array {
  if (document.format === "odp") return serializeOdp(document);
  const files = document.files ? clonePackage(document.files) : minimalPptx();
  for (const slide of document.slides) {
    setPackageText(files, slide.path || `ppt/slides/slide${slide.index + 1}.xml`, serializeSlideXml(slide, document));
  }
  ensurePresentationParts(files, document);
  return zipPackage(files);
}

function serializeSlideXml(slide: SlideModel, document: PresentationDocument) {
  if (slide.originalXml && slide.shapes.some((shape) => shape.dirty || !shape.originalXml)) {
    let xml = slide.originalXml;
    for (const shape of slide.shapes) {
      if (!shape.originalXml) continue;
      xml = xml.replace(shape.originalXml, rewriteShapeText(shape.originalXml, shape.text));
    }
    const missing = slide.shapes.filter((shape) => !shape.originalXml);
    if (missing.length) {
      const extra = missing.map((shape) => shapeXml(shape, document)).join("");
      xml = xml.replace(/<\/(?:p:)?spTree>/, `${extra}</p:spTree>`);
    }
    return xml;
  }
  if (slide.originalXml && !slide.dirty) return slide.originalXml;
  const shapes = slide.shapes.map((shape) => shapeXml(shape, document)).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="${slide.background.replace(/^#/, "")}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${document.width}" cy="${document.height}"/><a:chOff x="0" y="0"/><a:chExt cx="${document.width}" cy="${document.height}"/></a:xfrm></p:grpSpPr>${shapes}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
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
  return `<p:sp><p:nvSpPr><p:cNvPr id="${Number(shape.id.split(":")[1] ?? 2) + 2}" name="Text"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr wrap="square"/><a:lstStyle/><a:p><a:pPr algn="${align}"/><a:r><a:rPr lang="zh-CN" sz="${Math.round(shape.fontSize * 100)}" b="${shape.bold ? 1 : 0}" dirty="0"><a:solidFill><a:srgbClr val="${shape.color.replace(/^#/, "")}"/></a:solidFill></a:rPr><a:t>${encodeXml(shape.text)}</a:t></a:r></a:p></p:txBody></p:sp>`;
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
  if (!packageText(files, "ppt/presentation.xml", false)) {
    setPackageText(files, "ppt/presentation.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldIdLst>${sldIdLst}</p:sldIdLst><p:sldSz cx="${document.width}" cy="${document.height}" type="screen16x9"/></p:presentation>`);
  }
}

function minimalPptx(): OfficePackage {
  return {
    "[Content_Types].xml": new TextEncoder().encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>`),
    "_rels/.rels": new TextEncoder().encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>`),
    "ppt/_rels/presentation.xml.rels": new TextEncoder().encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>`),
  };
}
