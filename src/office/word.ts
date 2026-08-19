import { encodedTextNode, encodeXml, decodeXml, xmlAttr } from "./xml";
import { clonePackage, packageText, setPackageText, type OfficePackage, unzipPackage, zipPackage } from "./package";
import { emuToPx, relationshipHyperlinks, relationshipMedia } from "./media";

export interface WordImage {
  src: string;
  rId?: string;
  width?: number;
  height?: number;
  wrap?: "inline" | "square" | "tight" | "topAndBottom" | "behind" | "inFront";
  float?: "left" | "right";
  originalXml?: string;
}

export interface WordRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  fontSize?: number;
  color?: string;
  font?: string;
  highlight?: string;
  vertAlign?: "subscript" | "superscript";
  hyperlink?: string;
  image?: WordImage;
}

export interface WordList {
  type: "bullet" | "number";
  level: number;
  numId: number;
}

export interface WordParagraph {
  kind: "paragraph" | "heading";
  align?: "left" | "center" | "right" | "justify";
  level?: number;
  style?: string;
  list?: WordList;
  indent?: number;
  spacingBefore?: number;
  spacingAfter?: number;
  lineSpacing?: number;
  pageBreak?: boolean;
  runs: WordRun[];
  originalXml?: string;
  dirty?: boolean;
}

export interface WordTableCell {
  text: string;
  originalXml?: string;
  colSpan?: number;
  rowSpan?: number;
  hidden?: boolean;
}

export interface WordTable {
  kind: "table";
  rows: WordTableCell[][];
  originalXml?: string;
  dirty?: boolean;
}

export type WordBlock = WordParagraph | WordTable;

export interface WordDocument {
  type: "word";
  format: "docx" | "rtf";
  blocks: WordBlock[];
  files?: OfficePackage;
  sectPr: string;
  header?: string;
  footer?: string;
  editable: true;
}

const DEFAULT_SECT_PR = "<w:sectPr><w:pgSz w:w=\"11906\" w:h=\"16838\"/><w:pgMar w:top=\"1440\" w:right=\"1440\" w:bottom=\"1440\" w:left=\"1440\"/></w:sectPr>";

export function parseWordBlocks(
  xml: string,
  lists = new Map<number, "bullet" | "number">(),
  media = new Map<string, string>(),
  hyperlinks = new Map<string, string>(),
): { blocks: WordBlock[]; sectPr: string } {
  const sectPr = /<w:sectPr\b[\s\S]*?<\/w:sectPr>/.exec(xml)?.[0] ?? DEFAULT_SECT_PR;
  const body = xml.replace(/<w:sectPr\b[\s\S]*?<\/w:sectPr>/, "");
  const blocks: WordBlock[] = [];
  const tokenPattern = /<w:tbl(?:\s[^>]*)?>[\s\S]*?<\/w:tbl>|<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g;
  for (const match of body.matchAll(tokenPattern)) {
    const token = match[0];
    if (token.startsWith("<w:tbl")) {
      blocks.push(parseTable(token));
      continue;
    }
    blocks.push(parseParagraph(token, lists, media, hyperlinks));
  }
  return { blocks, sectPr };
}

function parseNumbering(xml: string) {
  const abstracts = new Map<number, "bullet" | "number">();
  for (const match of xml.matchAll(/<w:abstractNum\b[\s\S]*?<\/w:abstractNum>/g)) {
    const id = Number(xmlAttr(match[0].slice(0, 80), "w:abstractNumId"));
    const fmt = xmlAttr(/<w:numFmt\b[^>]*>/.exec(match[0])?.[0] ?? "", "w:val");
    abstracts.set(id, fmt === "bullet" ? "bullet" : "number");
  }
  const lists = new Map<number, "bullet" | "number">();
  for (const match of xml.matchAll(/<w:num\b[\s\S]*?<\/w:num>/g)) {
    const id = Number(xmlAttr(match[0].slice(0, 60), "w:numId"));
    const abstract = Number(xmlAttr(/<w:abstractNumId\b[^>]*>/.exec(match[0])?.[0] ?? "", "w:val"));
    lists.set(id, abstracts.get(abstract) ?? "number");
  }
  return lists;
}

function parseParagraph(
  xml: string,
  lists = new Map<number, "bullet" | "number">(),
  media = new Map<string, string>(),
  hyperlinks = new Map<string, string>(),
): WordParagraph {
  const style = xmlAttr(/<w:pStyle\b[^>]*>/.exec(xml)?.[0] ?? "", "w:val");
  const alignRaw = xmlAttr(/<w:jc\b[^>]*>/.exec(xml)?.[0] ?? "", "w:val");
  const heading = /(?:heading|标题)\s*([1-6])/i.exec(style);
  const numPr = /<w:numPr\b[\s\S]*?<\/w:numPr>/.exec(xml)?.[0] ?? "";
  const numId = Number(xmlAttr(/<w:numId\b[^>]*>/.exec(numPr)?.[0] ?? "", "w:val"));
  const ilvl = Number(xmlAttr(/<w:ilvl\b[^>]*>/.exec(numPr)?.[0] ?? "", "w:val"));
  const runs = parseRuns(xml, media, hyperlinks);
  const align = alignRaw === "center" || alignRaw === "ctr"
    ? "center"
    : alignRaw === "right" || alignRaw === "end"
      ? "right"
      : alignRaw === "both" || alignRaw === "distribute"
        ? "justify"
        : alignRaw
          ? "left"
          : undefined;
  const left = Number(xmlAttr(/<w:ind\b[^>]*>/.exec(xml)?.[0] ?? "", "w:left"));
  const before = Number(xmlAttr(/<w:spacing\b[^>]*>/.exec(xml)?.[0] ?? "", "w:before"));
  const after = Number(xmlAttr(/<w:spacing\b[^>]*>/.exec(xml)?.[0] ?? "", "w:after"));
  const line = Number(xmlAttr(/<w:spacing\b[^>]*>/.exec(xml)?.[0] ?? "", "w:line"));
  const pageBreak = /<w:pageBreakBefore\b/.test(xml);
  const listLevel = Number.isFinite(ilvl) ? ilvl : 0;
  return {
    kind: heading ? "heading" : "paragraph",
    level: heading ? Number(heading[1]) : undefined,
    style: style || undefined,
    align,
    list: numId
      ? { type: lists.get(numId) ?? (numId === 1 ? "bullet" : "number"), level: listLevel, numId }
      : listFromParagraphStyle(style, listLevel),
    indent: Number.isFinite(left) && left > 0 ? Math.round(left / 720) : undefined,
    spacingBefore: Number.isFinite(before) && before ? before : undefined,
    spacingAfter: Number.isFinite(after) && after ? after : undefined,
    lineSpacing: Number.isFinite(line) && line ? line / 240 : undefined,
    pageBreak: pageBreak || undefined,
    runs: runs.length ? runs : [{ text: "" }],
    originalXml: xml,
  };
}

function listFromParagraphStyle(style: string, level: number): WordList | undefined {
  const name = style.replace(/[\s_-]+/g, "").toLowerCase();
  if (!name) return undefined;
  const numbered = /listnumber|listnumbered|编号列表|^编号$/.test(name);
  const bulleted = /listbullet|项目符号/.test(name);
  if (!numbered && !bulleted) return undefined;
  const suffix = /(\d+)$/.exec(name);
  return {
    type: numbered ? "number" : "bullet",
    level: suffix ? Math.max(0, Number(suffix[1]) - 1) : level,
    numId: numbered ? 2 : 1,
  };
}

function parseRuns(xml: string, media = new Map<string, string>(), hyperlinks = new Map<string, string>()): WordRun[] {
  const runs: WordRun[] = [];
  const pattern = /<w:hyperlink\b[\s\S]*?<\/w:hyperlink>|<w:r(?:\s[^>]*)?>[\s\S]*?<\/w:r>/g;
  for (const token of xml.matchAll(pattern)) {
    const raw = token[0];
    if (raw.startsWith("<w:hyperlink")) {
      const open = raw.slice(0, raw.indexOf(">") + 1);
      const rId = xmlAttr(open, "r:id");
      const href = xmlAttr(open, "w:anchor")
        || (rId ? hyperlinks.get(rId) : undefined)
        || xmlAttr(open, "w:tooltip")
        || rId;
      for (const run of parsePlainRuns(raw, media)) runs.push({ ...run, hyperlink: href || run.hyperlink });
      continue;
    }
    const run = parsePlainRun(raw, media);
    if (run) runs.push(run);
  }
  return runs;
}

function parsePlainRuns(xml: string, media = new Map<string, string>()): WordRun[] {
  const runs: WordRun[] = [];
  for (const token of xml.matchAll(/<w:r(?:\s[^>]*)?>[\s\S]*?<\/w:r>/g)) {
    const run = parsePlainRun(token[0], media);
    if (run) runs.push(run);
  }
  return runs;
}

function parsePlainRun(run: string, media = new Map<string, string>()): WordRun | undefined {
  const image = parseDrawingRun(run, media);
  if (image) return { text: "", image };
  const rPr = /<w:rPr\b[\s\S]*?<\/w:rPr>/.exec(run)?.[0] ?? "";
  const text = extractRunText(run);
  if (!text && !/<w:br\b|<w:tab\b|<w:t\b/.test(run)) return undefined;
  const fontSize = Number(xmlAttr(/<w:sz\b[^>]*>/.exec(rPr)?.[0] ?? "", "w:val"));
  const color = xmlAttr(/<w:color\b[^>]*>/.exec(rPr)?.[0] ?? "", "w:val");
  const font = xmlAttr(/<w:rFonts\b[^>]*>/.exec(rPr)?.[0] ?? "", "w:ascii")
    || xmlAttr(/<w:rFonts\b[^>]*>/.exec(rPr)?.[0] ?? "", "w:eastAsia");
  const highlight = xmlAttr(/<w:highlight\b[^>]*>/.exec(rPr)?.[0] ?? "", "w:val")
    || xmlAttr(/<w:shd\b[^>]*>/.exec(rPr)?.[0] ?? "", "w:fill");
  const vert = xmlAttr(/<w:vertAlign\b[^>]*>/.exec(rPr)?.[0] ?? "", "w:val");
  return {
    text,
    bold: /<w:b\b(?:\s[^>]*)?(?:\/\s*>|>\s*<\/w:b>)/.test(rPr) && xmlAttr(/<w:b\b[^>]*>/.exec(rPr)?.[0] ?? "", "w:val") !== "0",
    italic: /<w:i\b(?:\s[^>]*)?(?:\/\s*>|>\s*<\/w:i>)/.test(rPr) && xmlAttr(/<w:i\b[^>]*>/.exec(rPr)?.[0] ?? "", "w:val") !== "0",
    underline: /<w:u\b/.test(rPr) && xmlAttr(/<w:u\b[^>]*>/.exec(rPr)?.[0] ?? "", "w:val") !== "none",
    strike: /<w:strike\b|<w:dstrike\b/.test(rPr),
    fontSize: fontSize ? fontSize / 2 : undefined,
    color: color && color !== "auto" ? `#${color.replace(/^#/, "")}` : undefined,
    font: font || undefined,
    highlight: highlight && highlight !== "auto" && highlight !== "none" ? highlight : undefined,
    vertAlign: vert === "subscript" || vert === "superscript" ? vert : undefined,
  };
}

function parseDrawingRun(run: string, media: Map<string, string>): WordImage | undefined {
  const drawing = /<w:drawing\b[\s\S]*?<\/w:drawing>|<w:pict\b[\s\S]*?<\/w:pict>/.exec(run)?.[0];
  if (!drawing) return undefined;
  const embed = xmlAttr(/<(?:a:)?blip\b[^>]*>/.exec(drawing)?.[0] ?? "", "r:embed")
    || xmlAttr(/<(?:a:)?blip\b[^>]*>/.exec(drawing)?.[0] ?? "", "r:link")
    || xmlAttr(/<(?:v:)?imagedata\b[^>]*>/.exec(drawing)?.[0] ?? "", "r:id");
  if (!embed) return undefined;
  const src = media.get(embed);
  const extent = /<(?:wp:)?extent\b[^>]*>/.exec(drawing)?.[0]
    || /<(?:a:)?ext\b[^>]*>/.exec(drawing)?.[0]
    || "";
  const wrap = parseImageWrap(drawing);
  const image: WordImage = {
    src: src ?? "",
    rId: embed,
    width: emuToPx(Number(xmlAttr(extent, "cx"))),
    height: emuToPx(Number(xmlAttr(extent, "cy"))),
    wrap: wrap.wrap,
    float: wrap.float,
    originalXml: drawing,
  };
  return image;
}

function parseImageWrap(drawing: string): { wrap?: WordImage["wrap"]; float?: WordImage["float"] } {
  if (/<(?:wp:)?inline\b/.test(drawing) && !/<(?:wp:)?anchor\b/.test(drawing)) return { wrap: "inline" };
  const wrap: WordImage["wrap"] = /<(?:wp:)?wrapSquare\b/.test(drawing) || /<(?:wp:)?wrapTight\b/.test(drawing) || /<(?:wp:)?wrapThrough\b/.test(drawing)
    ? (/<(?:wp:)?wrapTight\b/.test(drawing) ? "tight" : "square")
    : /<(?:wp:)?wrapTopAndBottom\b/.test(drawing)
      ? "topAndBottom"
      : /<(?:wp:)?wrapNone\b/.test(drawing)
        ? (/behindDoc="1"/.test(drawing) ? "behind" : "inFront")
        : /<(?:wp:)?anchor\b/.test(drawing) ? "square" : "inline";
  const posH = /<(?:wp:)?positionH\b[\s\S]*?<\/(?:wp:)?positionH>/.exec(drawing)?.[0] ?? "";
  const align = /<(?:wp:)?align\b[^>]*>([^<]+)/.exec(posH)?.[1]?.trim();
  const offset = Number(/<(?:wp:)?posOffset\b[^>]*>([^<]+)/.exec(posH)?.[1] ?? "0");
  const float: WordImage["float"] = align === "right" || offset > 3_000_000 ? "right" : wrap !== "inline" ? "left" : undefined;
  return { wrap, float };
}

function extractRunText(run: string) {
  const withBreaks = run
    .replace(/<w:tab\b[^>]*\/?>/g, "\t")
    .replace(/<w:br\b[^>]*\/?>/g, "\n")
    .replace(/<w:cr\b[^>]*\/?>/g, "\n");
  return [...withBreaks.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)]
    .map((match) => decodeXml(match[1]))
    .join("");
}

function parseTable(xml: string): WordTable {
  const parsed = [...xml.matchAll(/<w:tr(?:\s[^>]*)?>[\s\S]*?<\/w:tr>/g)].map((row) => {
    let gridCol = 0;
    return [...row[0].matchAll(/<w:tc(?:\s[^>]*)?>[\s\S]*?<\/w:tc>/g)].map((cell) => {
      const tcPr = /<w:tcPr\b[\s\S]*?<\/w:tcPr>/.exec(cell[0])?.[0] ?? /<w:tcPr\b[^>]*\/>/.exec(cell[0])?.[0] ?? "";
      const span = Number(xmlAttr(/<w:gridSpan\b[^>]*>/.exec(tcPr)?.[0] ?? "", "w:val")) || 1;
      const vMergeTag = /<w:vMerge\b[^>]*>/.exec(tcPr)?.[0];
      const vMergeVal = vMergeTag ? xmlAttr(vMergeTag, "w:val") : "";
      const vMerge = !vMergeTag ? undefined : !vMergeVal || vMergeVal === "continue" ? "continue" as const : "restart" as const;
      const item = {
        text: extractRunText(cell[0]).replace(/\s+/g, " ").trim(),
        originalXml: cell[0],
        colSpan: span > 1 ? span : undefined,
        vMerge,
        gridCol,
      };
      gridCol += span;
      return item;
    });
  });
  const rows: WordTableCell[][] = parsed.map((row) => row.map((cell) => ({
    text: cell.text,
    originalXml: cell.originalXml,
    colSpan: cell.colSpan,
  })));
  parsed.forEach((row, rowIndex) => {
    row.forEach((cell, cellIndex) => {
      if (cell.vMerge !== "restart") {
        if (cell.vMerge === "continue") rows[rowIndex][cellIndex].hidden = true;
        return;
      }
      let rowSpan = 1;
      for (let next = rowIndex + 1; next < parsed.length; next += 1) {
        const below = parsed[next].find((item) => item.gridCol === cell.gridCol && item.vMerge === "continue");
        if (!below) break;
        rowSpan += 1;
      }
      if (rowSpan > 1) rows[rowIndex][cellIndex].rowSpan = rowSpan;
    });
  });
  return { kind: "table", rows, originalXml: xml };
}

export function paragraphText(block: WordParagraph) {
  return block.runs.map((run) => run.image ? "" : run.text).join("");
}

export function openDocx(buffer: ArrayBuffer): WordDocument {
  const files = unzipPackage(buffer);
  const xml = packageText(files, "word/document.xml");
  const lists = parseNumbering(packageText(files, "word/numbering.xml", false));
  const { media } = relationshipMedia(files, "word/_rels/document.xml.rels", "word/document.xml");
  const hyperlinks = relationshipHyperlinks(files, "word/_rels/document.xml.rels");
  const parsed = parseWordBlocks(xml, lists, media, hyperlinks);
  return {
    type: "word",
    format: "docx",
    blocks: parsed.blocks,
    files,
    sectPr: parsed.sectPr,
    header: extractPlain(packageText(files, "word/header1.xml", false) || packageText(files, "word/header2.xml", false)),
    footer: extractPlain(packageText(files, "word/footer1.xml", false) || packageText(files, "word/footer2.xml", false)),
    editable: true,
  };
}

function extractPlain(xml: string) {
  if (!xml) return undefined;
  const text = [...xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((match) => decodeXml(match[1])).join("");
  return text || undefined;
}

export function openRtf(buffer: ArrayBuffer): WordDocument {
  const source = new TextDecoder("utf-8").decode(buffer);
  const text = source
    .replace(/\\par[d]?\b/g, "\n")
    .replace(/\\tab\b/g, "\t")
    .replace(/\\'[0-9a-fA-F]{2}/g, (value) => String.fromCharCode(Number.parseInt(value.slice(2), 16)))
    .replace(/\\u(-?\d+)\??/g, (_, value: string) => String.fromCharCode((Number(value) + 65536) % 65536))
    .replace(/\\[a-zA-Z]+-?\d* ?/g, "")
    .replace(/[{}]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const blocks: WordBlock[] = (text || "").split(/\n/).map((line) => ({
    kind: "paragraph" as const,
    runs: [{ text: line }],
    dirty: true,
  }));
  return {
    type: "word",
    format: "rtf",
    blocks: blocks.length ? blocks : [{ kind: "paragraph", runs: [{ text: "" }], dirty: true }],
    sectPr: DEFAULT_SECT_PR,
    editable: true,
  };
}

export function serializeWord(document: WordDocument): Uint8Array {
  if (document.format === "rtf") return new TextEncoder().encode(serializeRtf(document.blocks));
  const files = document.files ? clonePackage(document.files) : minimalDocxParts();
  if (document.blocks.some((block) => block.kind !== "table" && block.list)) ensureNumberingParts(files);
  if (document.header || document.footer) ensureHeaderFooterParts(files, document);
  const body = document.blocks.map((block) => serializeBlock(block)).join("");
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:w10="urn:schemas-microsoft-com:office:word" xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:wne="http://schemas.microsoft.com/office/word/2006/wordml" mc:Ignorable="wpc"><w:body>${body}${document.sectPr || DEFAULT_SECT_PR}</w:body></w:document>`;
  setPackageText(files, "word/document.xml", xml);
  return zipPackage(files);
}

function serializeBlock(block: WordBlock) {
  if (block.kind === "table") {
    if (!block.dirty && block.originalXml) return block.originalXml;
    const rows = block.rows.map((row) => `<w:tr>${row.map((cell) => `<w:tc><w:p>${serializeRun({ text: cell.text })}</w:p></w:tc>`).join("")}</w:tr>`).join("");
    return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr>${rows}</w:tbl>`;
  }
  if (!block.dirty && block.originalXml) return block.originalXml;
  const style = block.kind === "heading"
    ? `<w:pStyle w:val="Heading${Math.max(1, Math.min(6, block.level ?? 1))}"/>`
    : block.style
      ? `<w:pStyle w:val="${encodeXml(block.style)}"/>`
      : "";
  const align = block.align && block.align !== "left"
    ? `<w:jc w:val="${block.align === "center" ? "center" : block.align === "right" ? "right" : "both"}"/>`
    : "";
  const list = block.list
    ? `<w:numPr><w:ilvl w:val="${block.list.level}"/><w:numId w:val="${block.list.numId}"/></w:numPr>`
    : "";
  const indent = block.indent ? `<w:ind w:left="${block.indent * 720}"/>` : "";
  const spacing = block.spacingBefore || block.spacingAfter || block.lineSpacing
    ? `<w:spacing${block.spacingBefore ? ` w:before="${block.spacingBefore}"` : ""}${block.spacingAfter ? ` w:after="${block.spacingAfter}"` : ""}${block.lineSpacing ? ` w:line="${Math.round(block.lineSpacing * 240)}" w:lineRule="auto"` : ""}/>`
    : "";
  const pageBreak = block.pageBreak ? "<w:pageBreakBefore/>" : "";
  const runs = (block.runs.length ? block.runs : [{ text: "" }]).map(serializeRun).join("");
  const pPr = `${style}${align}${list}${indent}${spacing}${pageBreak}`;
  return `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ""}${runs}</w:p>`;
}

function serializeRun(run: WordRun) {
  if (run.image?.originalXml) return run.image.originalXml;
  if (run.image) return "";
  const props: string[] = [];
  if (run.bold) props.push("<w:b/>");
  if (run.italic) props.push("<w:i/>");
  if (run.underline) props.push("<w:u w:val=\"single\"/>");
  if (run.strike) props.push("<w:strike/>");
  if (run.font) props.push(`<w:rFonts w:ascii="${encodeXml(run.font)}" w:hAnsi="${encodeXml(run.font)}" w:eastAsia="${encodeXml(run.font)}"/>`);
  if (run.fontSize) props.push(`<w:sz w:val="${Math.round(run.fontSize * 2)}"/><w:szCs w:val="${Math.round(run.fontSize * 2)}"/>`);
  if (run.color) props.push(`<w:color w:val="${encodeXml(run.color.replace(/^#/, ""))}"/>`);
  if (run.highlight) {
    const fill = run.highlight.replace(/^#/, "");
    if (/^[0-9A-Fa-f]{6}$/.test(fill)) props.push(`<w:shd w:val="clear" w:color="auto" w:fill="${fill.toUpperCase()}"/>`);
    else props.push(`<w:highlight w:val="${encodeXml(fill)}"/>`);
  }
  if (run.vertAlign) props.push(`<w:vertAlign w:val="${run.vertAlign}"/>`);
  if (run.hyperlink) {
    props.push("<w:u w:val=\"single\"/>");
    if (!run.color) props.push("<w:color w:val=\"0563C1\"/>");
  }
  const text = run.text.replace(/\n/g, "") ;
  const parts = run.text.split("\n");
  const body = parts.map((part, index) => `${encodedTextNode("w:t", part)}${index < parts.length - 1 ? "<w:br/>" : ""}`).join("");
  const inner = `<w:r>${props.length ? `<w:rPr>${props.join("")}</w:rPr>` : ""}${body || encodedTextNode("w:t", text)}</w:r>`;
  if (run.hyperlink) return `<w:hyperlink w:tooltip="${encodeXml(run.hyperlink)}" w:anchor="${encodeXml(run.hyperlink)}">${inner}</w:hyperlink>`;
  return inner;
}

function serializeRtf(blocks: WordBlock[]) {
  const lines = blocks.map((block) => {
    if (block.kind === "table") {
      return block.rows.map((row) => row.map((cell) => rtfEscape(cell.text)).join("\t")).join("\\par\n");
    }
    const prefix = block.kind === "heading" ? `\\b\\fs${24 + (6 - (block.level ?? 1)) * 4} ` : "";
    return `${prefix}${rtfEscape(paragraphText(block))}`;
  });
  return `{\\rtf1\\ansi\\deff0\\nouicompat{\\fonttbl{\\f0\\fnil\\fcharset134 Microsoft YaHei UI;}}\\viewkind4\\uc1\\pard\\sa200\\sl276\\slmult1\\f0\\fs22\\lang2052\n${lines.join("\\par\n")}\\par\n}`;
}

function rtfEscape(value: string) {
  return [...value].map((char) => {
    const code = char.codePointAt(0) ?? 0;
    if (char === "\\") return "\\\\";
    if (char === "{") return "\\{";
    if (char === "}") return "\\}";
    if (code < 128) return char;
    return `\\u${code}?`;
  }).join("");
}

function minimalDocxParts(): OfficePackage {
  return {
    "[Content_Types].xml": new TextEncoder().encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`),
    "_rels/.rels": new TextEncoder().encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`),
    "word/document.xml": new TextEncoder().encode("<w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:body><w:p/></w:body></w:document>"),
  };
}

export function htmlToRuns(html: string): WordRun[] {
  const source = html
    .replace(/&nbsp;/gi, " ")
    .replace(/<div[^>]*>/gi, "")
    .replace(/<\/div>/gi, "\n")
    .replace(/<p[^>]*>/gi, "")
    .replace(/<\/p>/gi, "\n");
  if (typeof DOMParser !== "undefined") {
    try {
      const doc = new DOMParser().parseFromString(`<div>${source}</div>`, "text/html");
      const runs = walkHtmlNode(doc.body, emptyStyle());
      return mergeRuns(runs.length ? runs : [{ text: "" }]);
    } catch {
      /* fall through to the tokenizer */
    }
  }
  return htmlToRunsFallback(source);
}

export function runsToHtml(runs: WordRun[]) {
  return runs.map((run) => {
    if (run.image) {
      const width = run.image.width ? ` width="${run.image.width}"` : "";
      const height = run.image.height ? ` height="${run.image.height}"` : "";
      const rid = run.image.rId ? ` data-rid="${encodeXml(run.image.rId)}"` : "";
      const wrap = run.image.wrap ? ` data-wrap="${run.image.wrap}"` : "";
      const float = run.image.float ? ` data-float="${run.image.float}"` : "";
      const klass = ["word-pic", run.image.wrap && run.image.wrap !== "inline" ? `word-wrap-${run.image.wrap}` : "", run.image.float ? `word-float-${run.image.float}` : ""]
        .filter(Boolean)
        .join(" ");
      return `<img src="${encodeXml(run.image.src)}" class="${klass}"${rid}${wrap}${float}${width}${height} alt="" contenteditable="false" />`;
    }
    let html = encodeXml(run.text).replace(/\n/g, "<br>");
    if (run.hyperlink) html = `<a href="${encodeXml(run.hyperlink)}">${html}</a>`;
    const css: string[] = [];
    if (run.bold) css.push("font-weight:700");
    if (run.italic) css.push("font-style:italic");
    const deco = [run.underline ? "underline" : "", run.strike ? "line-through" : ""].filter(Boolean).join(" ");
    if (deco) css.push(`text-decoration:${deco}`);
    if (run.color) css.push(`color:${run.color}`);
    if (run.fontSize) css.push(`font-size:${run.fontSize}pt`);
    if (run.font) css.push(`font-family:${run.font}`);
    if (run.highlight) css.push(`background:${/^#|[0-9A-Fa-f]{6}/.test(run.highlight) ? `#${run.highlight.replace(/^#/, "")}` : run.highlight}`);
    if (run.vertAlign === "subscript") css.push("vertical-align:sub");
    if (run.vertAlign === "superscript") css.push("vertical-align:super");
    const tags: string[] = [];
    if (run.bold) tags.push("b");
    if (run.italic) tags.push("i");
    if (run.underline) tags.push("u");
    if (run.strike) tags.push("s");
    let wrapped = html;
    for (const tag of tags) wrapped = `<${tag}>${wrapped}</${tag}>`;
    if (css.length) wrapped = `<span style="${css.join(";")}">${wrapped}</span>`;
    return wrapped;
  }).join("");
}

export function restoreImageRuns(next: WordRun[], previous: WordRun[]) {
  const originals = previous.filter((run) => run.image);
  if (!originals.length) return next;
  let index = 0;
  return next.map((run) => {
    if (!run.image) return run;
    const match = originals.find((item) => item.image && (
      (run.image?.rId && item.image.rId === run.image.rId)
      || (run.image?.src && item.image.src === run.image.src)
    )) ?? originals[index++];
    if (!match?.image) return run;
    return { ...run, image: { ...match.image, ...run.image, originalXml: match.image.originalXml || run.image.originalXml } };
  });
}

interface HtmlStyle {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  hyperlink?: string;
}

function emptyStyle(): HtmlStyle {
  return { bold: false, italic: false, underline: false, strike: false };
}

function walkHtmlNode(node: Node, style: HtmlStyle): WordRun[] {
  const runs: WordRun[] = [];
  node.childNodes.forEach((child) => {
    if (child.nodeType === 3) {
      pushRun(runs, styledRun(child.textContent ?? "", style));
      return;
    }
    if (!(child instanceof Element)) return;
    const tag = child.tagName.toLowerCase();
    if (tag === "br") {
      pushRun(runs, styledRun("\n", style));
      return;
    }
    if (tag === "img") {
      const src = child.getAttribute("src") || "";
      if (src) {
        const wrap = child.getAttribute("data-wrap") as WordImage["wrap"] | null;
        const float = child.getAttribute("data-float") as WordImage["float"] | null;
        runs.push({
          text: "",
          image: {
            src,
            rId: child.getAttribute("data-rid") || undefined,
            width: Number(child.getAttribute("width")) || undefined,
            height: Number(child.getAttribute("height")) || undefined,
            wrap: wrap || undefined,
            float: float || undefined,
          },
        });
      }
      return;
    }
    if (tag === "a") {
      const href = child.getAttribute("href") || child.getAttribute("data-href") || "";
      runs.push(...walkHtmlNode(child, { ...style, hyperlink: href || style.hyperlink, underline: true }));
      return;
    }
    if (tag === "script" || tag === "style") return;
    const next = { ...style };
    if (tag === "b" || tag === "strong") next.bold = true;
    if (tag === "i" || tag === "em") next.italic = true;
    if (tag === "u") next.underline = true;
    if (tag === "s" || tag === "strike" || tag === "del") next.strike = true;
    const css = `${child.getAttribute("style") ?? ""} ${child instanceof HTMLElement ? `${child.style.fontWeight} ${child.style.fontStyle} ${child.style.textDecoration}` : ""}`;
    if (/font-weight\s*:\s*(bold|[7-9]00)|\b(bold|[7-9]00)\b/i.test(css)) next.bold = true;
    if (/font-style\s*:\s*italic|\bitalic\b/i.test(css)) next.italic = true;
    if (/underline/i.test(css)) next.underline = true;
    if (/line-through/i.test(css)) next.strike = true;
    runs.push(...walkHtmlNode(child, next));
  });
  return runs;
}

function styledRun(text: string, style: HtmlStyle): WordRun {
  const run: WordRun = { text };
  if (style.bold) run.bold = true;
  if (style.italic) run.italic = true;
  if (style.underline) run.underline = true;
  if (style.strike) run.strike = true;
  if (style.hyperlink) run.hyperlink = style.hyperlink;
  return run;
}

function htmlToRunsFallback(source: string): WordRun[] {
  const runs: WordRun[] = [];
  const style = emptyStyle();
  const pattern = /<img\b[^>]*>|<\/?[a-zA-Z][^>]*>|[^<]+/gi;
  for (const match of source.matchAll(pattern)) {
    const token = match[0];
    if (/^<img\b/i.test(token)) {
      const src = /src="([^"]*)"/i.exec(token)?.[1] || "";
      const rid = /data-rid="([^"]*)"/i.exec(token)?.[1];
      const wrap = /data-wrap="([^"]*)"/i.exec(token)?.[1] as WordImage["wrap"] | undefined;
      const float = /data-float="([^"]*)"/i.exec(token)?.[1] as WordImage["float"] | undefined;
      if (src) runs.push({ text: "", image: { src, rId: rid, wrap, float } });
      continue;
    }
    const tag = /^<\/?([a-z]+)/i.exec(token)?.[1]?.toLowerCase();
    if (tag === "a") {
      if (!token.startsWith("</")) {
        style.hyperlink = /href="([^"]*)"/i.exec(token)?.[1] || /data-href="([^"]*)"/i.exec(token)?.[1] || style.hyperlink;
        style.underline = true;
      } else {
        style.hyperlink = undefined;
      }
      continue;
    }
    if (tag === "br") {
      pushRun(runs, styledRun("\n", style));
      continue;
    }
    if (tag === "b" || tag === "strong") {
      style.bold = !token.startsWith("</");
      continue;
    }
    if (tag === "i" || tag === "em") {
      style.italic = !token.startsWith("</");
      continue;
    }
    if (tag === "u") {
      style.underline = !token.startsWith("</");
      continue;
    }
    if (tag === "s" || tag === "strike" || tag === "del") {
      style.strike = !token.startsWith("</");
      continue;
    }
    if (token.startsWith("<")) {
      const opening = /^<([a-z]+)([^>]*)>/i.exec(token);
      if (opening && !token.startsWith("</")) {
        if (/font-weight\s*:\s*(bold|[7-9]00)/i.test(opening[2])) style.bold = true;
        if (/font-style\s*:\s*italic/i.test(opening[2])) style.italic = true;
        if (/text-decoration[^"';]*underline/i.test(opening[2])) style.underline = true;
        if (/text-decoration[^"';]*line-through/i.test(opening[2])) style.strike = true;
      } else if (opening?.[1] === "span" || token.startsWith("</span")) {
        if (token.startsWith("</span")) {
          style.bold = false;
          style.italic = false;
          style.underline = false;
          style.strike = false;
        }
      }
      continue;
    }
    pushRun(runs, styledRun(decodeXml(token), style));
  }
  return mergeRuns(runs.length ? runs : [{ text: "" }]);
}

function pushRun(runs: WordRun[], run: WordRun) {
  if (run.image) {
    runs.push(run);
    return;
  }
  if (!run.text) return;
  const previous = runs[runs.length - 1];
  if (previous
    && !previous.image && !run.image
    && Boolean(previous.bold) === Boolean(run.bold)
    && Boolean(previous.italic) === Boolean(run.italic)
    && Boolean(previous.underline) === Boolean(run.underline)
    && Boolean(previous.strike) === Boolean(run.strike)
    && previous.hyperlink === run.hyperlink
  ) {
    previous.text += run.text;
    return;
  }
  runs.push(run);
}

function mergeRuns(runs: WordRun[]) {
  const merged: WordRun[] = [];
  for (const run of runs) {
    const previous = merged[merged.length - 1];
    if (previous
      && !previous.image && !run.image
      && previous.bold === run.bold
      && previous.italic === run.italic
      && previous.underline === run.underline
      && previous.strike === run.strike
      && previous.fontSize === run.fontSize
      && previous.color === run.color
      && previous.font === run.font
      && previous.highlight === run.highlight
      && previous.vertAlign === run.vertAlign
      && previous.hyperlink === run.hyperlink
    ) {
      previous.text += run.text;
    } else {
      merged.push({ ...run });
    }
  }
  return merged;
}

function numberingLevels(kind: "bullet" | "number") {
  return Array.from({ length: 9 }, (_, level) => {
    const left = 720 * (level + 1);
    const fmt = kind === "bullet" ? "bullet" : level % 2 === 0 ? "decimal" : "lowerLetter";
    const text = kind === "bullet" ? "•" : `%${level + 1}.`;
    return `<w:lvl w:ilvl="${level}"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/><w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${left}" w:hanging="360"/></w:pPr></w:lvl>`;
  }).join("");
}

function ensureNumberingParts(files: OfficePackage) {
  if (!packageText(files, "word/numbering.xml", false)) {
    setPackageText(files, "word/numbering.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>${numberingLevels("bullet")}</w:abstractNum><w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>${numberingLevels("number")}</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>`);
  }
  const types = packageText(files, "[Content_Types].xml", false);
  if (types && !types.includes("/word/numbering.xml")) {
    setPackageText(
      files,
      "[Content_Types].xml",
      types.replace("</Types>", `<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>`),
    );
  }
  const relsPath = "word/_rels/document.xml.rels";
  const rels = packageText(files, relsPath, false)
    || `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`;
  if (!rels.includes("numbering.xml")) {
    setPackageText(
      files,
      relsPath,
      rels.replace(
        "</Relationships>",
        `<Relationship Id="rIdNumbering" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>`,
      ),
    );
  }
}

export function insertWordBlock(document: WordDocument, index: number, block: WordBlock) {
  document.blocks.splice(Math.max(0, Math.min(index, document.blocks.length)), 0, { ...block, dirty: true });
  return document.blocks.length;
}

export function deleteWordBlock(document: WordDocument, index: number) {
  const [removed] = document.blocks.splice(index, 1);
  return removed;
}

export function replaceWordBlock(document: WordDocument, index: number, block: WordBlock) {
  const previous = document.blocks[index];
  document.blocks[index] = { ...block, dirty: true };
  return previous;
}

export function splitParagraph(block: WordParagraph, offset: number): [WordParagraph, WordParagraph] {
  const text = paragraphText(block);
  const at = Math.max(0, Math.min(offset, text.length));
  let seen = 0;
  const left: WordRun[] = [];
  const right: WordRun[] = [];
  for (const run of block.runs) {
    const start = seen;
    const end = seen + run.text.length;
    if (end <= at) left.push({ ...run });
    else if (start >= at) right.push({ ...run });
    else {
      if (at > start) left.push({ ...run, text: run.text.slice(0, at - start) });
      if (end > at) right.push({ ...run, text: run.text.slice(at - start) });
    }
    seen = end;
  }
  const a: WordParagraph = { ...block, runs: left.length ? left : [{ text: "" }], dirty: true, originalXml: undefined };
  const b: WordParagraph = { ...block, runs: right.length ? right : [{ text: "" }], dirty: true, originalXml: undefined };
  return [a, b];
}

export function applyRunStyle(runs: WordRun[], style: Partial<WordRun>): WordRun[] {
  return mergeRuns(runs.map((run) => ({ ...run, ...style })));
}

export function applyParagraphStyle(
  block: WordParagraph,
  patch: Partial<Pick<WordParagraph, "align" | "kind" | "level" | "style" | "indent" | "lineSpacing" | "pageBreak" | "spacingBefore" | "spacingAfter">> & { list?: WordList | null },
): WordParagraph {
  const next: WordParagraph = { ...block, dirty: true, originalXml: undefined };
  if (patch.align !== undefined) next.align = patch.align;
  if (patch.style !== undefined) next.style = patch.style;
  if (patch.kind !== undefined) next.kind = patch.kind;
  if (patch.level !== undefined) next.level = patch.level;
  if (patch.indent !== undefined) next.indent = patch.indent;
  if (patch.lineSpacing !== undefined) next.lineSpacing = patch.lineSpacing;
  if (patch.pageBreak !== undefined) next.pageBreak = patch.pageBreak;
  if (patch.spacingBefore !== undefined) next.spacingBefore = patch.spacingBefore;
  if (patch.spacingAfter !== undefined) next.spacingAfter = patch.spacingAfter;
  if (patch.kind === "heading" && !next.level) next.level = 1;
  if (patch.kind === "paragraph") {
    next.level = undefined;
    if (!patch.style) next.style = undefined;
  }
  if (patch.list === null) next.list = undefined;
  else if (patch.list) next.list = { ...patch.list, numId: patch.list.numId || (patch.list.type === "bullet" ? 1 : 2) };
  return next;
}

export function wordCount(blocks: WordBlock[]) {
  let characters = 0;
  let words = 0;
  let paragraphs = 0;
  for (const block of blocks) {
    const text = block.kind === "table"
      ? block.rows.map((row) => row.map((cell) => cell.text).join(" ")).join(" ")
      : paragraphText(block);
    const trimmed = text.trim();
    if (trimmed) paragraphs += 1;
    characters += text.replace(/\s/g, "").length;
    words += (trimmed.match(/[\p{L}\p{N}]+/gu) ?? []).length;
  }
  return { characters, words, paragraphs };
}

export function findReplaceWord(document: WordDocument, query: string, replacement: string, all = true) {
  if (!query) return 0;
  let count = 0;
  document.blocks.forEach((block, index) => {
    if (block.kind === "table") {
      const next = block.rows.map((row) => row.map((cell) => {
        if (!cell.text.includes(query)) return cell;
        count += cell.text.split(query).length - 1;
        return { ...cell, text: all ? cell.text.split(query).join(replacement) : cell.text.replace(query, replacement) };
      }));
      document.blocks[index] = { ...block, rows: next, dirty: true, originalXml: undefined };
      return;
    }
    const text = paragraphText(block);
    if (!text.includes(query)) return;
    count += text.split(query).length - 1;
    const nextText = all ? text.split(query).join(replacement) : text.replace(query, replacement);
    document.blocks[index] = { ...block, runs: [{ ...block.runs[0], text: nextText }], dirty: true, originalXml: undefined };
  });
  return count;
}

export function insertTable(document: WordDocument, index: number, rows: number, cols: number) {
  const table: WordTable = {
    kind: "table",
    dirty: true,
    rows: Array.from({ length: Math.max(1, rows) }, () => Array.from({ length: Math.max(1, cols) }, () => ({ text: "" }))),
  };
  insertWordBlock(document, index, table);
  return table;
}

export function tableMutate(document: WordDocument, index: number, action: "insertRow" | "insertCol" | "deleteRow" | "deleteCol" | "setCell", row = 0, col = 0, text = "") {
  const block = document.blocks[index];
  if (!block || block.kind !== "table") return;
  const table = { ...block, rows: block.rows.map((line) => line.map((cell) => ({ ...cell }))), dirty: true, originalXml: undefined };
  const width = table.rows[0]?.length ?? 1;
  if (action === "insertRow") table.rows.splice(row, 0, Array.from({ length: width }, () => ({ text: "" })));
  if (action === "deleteRow" && table.rows.length > 1) table.rows.splice(row, 1);
  if (action === "insertCol") table.rows.forEach((line) => line.splice(col, 0, { text: "" }));
  if (action === "deleteCol" && width > 1) table.rows.forEach((line) => line.splice(col, 1));
  if (action === "setCell" && table.rows[row]?.[col]) table.rows[row][col] = { ...table.rows[row][col], text };
  document.blocks[index] = table;
}

export function setHeaderFooter(document: WordDocument, header?: string, footer?: string) {
  if (header !== undefined) document.header = header;
  if (footer !== undefined) document.footer = footer;
}

export function clearParagraphFormat(block: WordParagraph): WordParagraph {
  return {
    kind: "paragraph",
    runs: [{ text: paragraphText(block) }],
    dirty: true,
  };
}

function ensureHeaderFooterParts(files: OfficePackage, document: WordDocument) {
  const header = document.header ?? "";
  const footer = document.footer ?? "";
  if (header) {
    setPackageText(files, "word/header1.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p>${serializeRun({ text: header })}</w:p></w:hdr>`);
  }
  if (footer) {
    setPackageText(files, "word/footer1.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p>${serializeRun({ text: footer })}</w:p></w:ftr>`);
  }
  let types = packageText(files, "[Content_Types].xml", false);
  if (types && header && !types.includes("/word/header1.xml")) types = types.replace("</Types>", `<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/></Types>`);
  if (types && footer && !types.includes("/word/footer1.xml")) types = types.replace("</Types>", `<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/></Types>`);
  if (types) setPackageText(files, "[Content_Types].xml", types);
  const relsPath = "word/_rels/document.xml.rels";
  let rels = packageText(files, relsPath, false)
    || `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`;
  if (header && !rels.includes("header1.xml")) rels = rels.replace("</Relationships>", `<Relationship Id="rIdHeader" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/></Relationships>`);
  if (footer && !rels.includes("footer1.xml")) rels = rels.replace("</Relationships>", `<Relationship Id="rIdFooter" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/></Relationships>`);
  setPackageText(files, relsPath, rels);
  const extra = `${header ? `<w:headerReference w:type="default" r:id="rIdHeader"/>` : ""}${footer ? `<w:footerReference w:type="default" r:id="rIdFooter"/>` : ""}`;
  if (extra && !document.sectPr.includes("headerReference") && !document.sectPr.includes("footerReference")) {
    document.sectPr = document.sectPr.replace("<w:sectPr", `<w:sectPr xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`);
    document.sectPr = document.sectPr.replace(">", `>${extra}`);
  }
}
