import { encodedTextNode, encodeXml, decodeXml, xmlAttr } from "./xml";
import { clonePackage, packageText, setPackageText, type OfficePackage, unzipPackage, zipPackage } from "./package";

export interface WordRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  fontSize?: number;
  color?: string;
  font?: string;
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
  runs: WordRun[];
  originalXml?: string;
  dirty?: boolean;
}

export interface WordTableCell {
  text: string;
  originalXml?: string;
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
  editable: true;
}

const DEFAULT_SECT_PR = "<w:sectPr><w:pgSz w:w=\"11906\" w:h=\"16838\"/><w:pgMar w:top=\"1440\" w:right=\"1440\" w:bottom=\"1440\" w:left=\"1440\"/></w:sectPr>";

export function parseWordBlocks(xml: string, lists = new Map<number, "bullet" | "number">()): { blocks: WordBlock[]; sectPr: string } {
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
    blocks.push(parseParagraph(token, lists));
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

function parseParagraph(xml: string, lists = new Map<number, "bullet" | "number">()): WordParagraph {
  const style = xmlAttr(/<w:pStyle\b[^>]*>/.exec(xml)?.[0] ?? "", "w:val");
  const alignRaw = xmlAttr(/<w:jc\b[^>]*>/.exec(xml)?.[0] ?? "", "w:val");
  const heading = /(?:heading|标题)\s*([1-6])/i.exec(style);
  const numPr = /<w:numPr\b[\s\S]*?<\/w:numPr>/.exec(xml)?.[0] ?? "";
  const numId = Number(xmlAttr(/<w:numId\b[^>]*>/.exec(numPr)?.[0] ?? "", "w:val"));
  const ilvl = Number(xmlAttr(/<w:ilvl\b[^>]*>/.exec(numPr)?.[0] ?? "", "w:val"));
  const runs = parseRuns(xml);
  const align = alignRaw === "center" || alignRaw === "ctr"
    ? "center"
    : alignRaw === "right" || alignRaw === "end"
      ? "right"
      : alignRaw === "both" || alignRaw === "distribute"
        ? "justify"
        : alignRaw
          ? "left"
          : undefined;
  return {
    kind: heading ? "heading" : "paragraph",
    level: heading ? Number(heading[1]) : undefined,
    style: style || undefined,
    align,
    list: numId
      ? { type: lists.get(numId) ?? (numId === 1 ? "bullet" : "number"), level: Number.isFinite(ilvl) ? ilvl : 0, numId }
      : undefined,
    runs: runs.length ? runs : [{ text: "" }],
    originalXml: xml,
  };
}

function parseRuns(xml: string): WordRun[] {
  const runs: WordRun[] = [];
  for (const token of xml.matchAll(/<w:r(?:\s[^>]*)?>[\s\S]*?<\/w:r>/g)) {
    const run = token[0];
    const rPr = /<w:rPr\b[\s\S]*?<\/w:rPr>/.exec(run)?.[0] ?? "";
    const text = extractRunText(run);
    if (!text && !/<w:br\b|<w:tab\b|<w:t\b/.test(run)) continue;
    const fontSize = Number(xmlAttr(/<w:sz\b[^>]*>/.exec(rPr)?.[0] ?? "", "w:val"));
    const color = xmlAttr(/<w:color\b[^>]*>/.exec(rPr)?.[0] ?? "", "w:val");
    const font = xmlAttr(/<w:rFonts\b[^>]*>/.exec(rPr)?.[0] ?? "", "w:ascii")
      || xmlAttr(/<w:rFonts\b[^>]*>/.exec(rPr)?.[0] ?? "", "w:eastAsia");
    runs.push({
      text,
      bold: /<w:b\b(?:\s[^>]*)?(?:\/\s*>|>\s*<\/w:b>)/.test(rPr) && xmlAttr(/<w:b\b[^>]*>/.exec(rPr)?.[0] ?? "", "w:val") !== "0",
      italic: /<w:i\b(?:\s[^>]*)?(?:\/\s*>|>\s*<\/w:i>)/.test(rPr) && xmlAttr(/<w:i\b[^>]*>/.exec(rPr)?.[0] ?? "", "w:val") !== "0",
      underline: /<w:u\b/.test(rPr) && xmlAttr(/<w:u\b[^>]*>/.exec(rPr)?.[0] ?? "", "w:val") !== "none",
      strike: /<w:strike\b|<w:dstrike\b/.test(rPr),
      fontSize: fontSize ? fontSize / 2 : undefined,
      color: color && color !== "auto" ? `#${color.replace(/^#/, "")}` : undefined,
      font: font || undefined,
    });
  }
  return runs;
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
  const rows = [...xml.matchAll(/<w:tr(?:\s[^>]*)?>[\s\S]*?<\/w:tr>/g)].map((row) =>
    [...row[0].matchAll(/<w:tc(?:\s[^>]*)?>[\s\S]*?<\/w:tc>/g)].map((cell) => ({
      text: extractRunText(cell[0]).replace(/\s+/g, " ").trim(),
      originalXml: cell[0],
    })),
  );
  return { kind: "table", rows, originalXml: xml };
}

export function paragraphText(block: WordParagraph) {
  return block.runs.map((run) => run.text).join("");
}

export function openDocx(buffer: ArrayBuffer): WordDocument {
  const files = unzipPackage(buffer);
  const xml = packageText(files, "word/document.xml");
  const lists = parseNumbering(packageText(files, "word/numbering.xml", false));
  const parsed = parseWordBlocks(xml, lists);
  return {
    type: "word",
    format: "docx",
    blocks: parsed.blocks,
    files,
    sectPr: parsed.sectPr,
    editable: true,
  };
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
  const body = document.blocks.map((block) => serializeBlock(block)).join("");
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:w10="urn:schemas-microsoft-com:office:word" xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:wne="http://schemas.microsoft.com/office/word/2006/wordml" mc:Ignorable="wpc"><w:body>${body}${document.sectPr || DEFAULT_SECT_PR}</w:body></w:document>`;
  setPackageText(files, "word/document.xml", xml);
  if (document.blocks.some((block) => block.kind !== "table" && block.list)) ensureNumberingParts(files);
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
  const runs = (block.runs.length ? block.runs : [{ text: "" }]).map(serializeRun).join("");
  return `<w:p>${style || align || list ? `<w:pPr>${style}${align}${list}</w:pPr>` : ""}${runs}</w:p>`;
}

function serializeRun(run: WordRun) {
  const props: string[] = [];
  if (run.bold) props.push("<w:b/>");
  if (run.italic) props.push("<w:i/>");
  if (run.underline) props.push("<w:u w:val=\"single\"/>");
  if (run.strike) props.push("<w:strike/>");
  if (run.fontSize) props.push(`<w:sz w:val="${Math.round(run.fontSize * 2)}"/><w:szCs w:val="${Math.round(run.fontSize * 2)}"/>`);
  if (run.color) props.push(`<w:color w:val="${encodeXml(run.color.replace(/^#/, ""))}"/>`);
  if (run.font) props.push(`<w:rFonts w:ascii="${encodeXml(run.font)}" w:hAnsi="${encodeXml(run.font)}" w:eastAsia="${encodeXml(run.font)}"/>`);
  const text = run.text.replace(/\n/g, "") ;
  const parts = run.text.split("\n");
  const body = parts.map((part, index) => `${encodedTextNode("w:t", part)}${index < parts.length - 1 ? "<w:br/>" : ""}`).join("");
  return `<w:r>${props.length ? `<w:rPr>${props.join("")}</w:rPr>` : ""}${body || encodedTextNode("w:t", text)}</w:r>`;
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
  const source = html.replace(/&nbsp;/g, " ").replace(/<div>/gi, "").replace(/<\/div>/gi, "\n").replace(/<p>/gi, "").replace(/<\/p>/gi, "\n");
  const runs: WordRun[] = [];
  const style = { bold: false, italic: false, underline: false, strike: false };
  const pattern = /<\/?(b|strong|i|em|u|s|strike|br)(?:\s[^>]*)?>|[^<]+/gi;
  for (const match of source.matchAll(pattern)) {
    const token = match[0];
    const tag = /^<\/?([a-z]+)/i.exec(token)?.[1]?.toLowerCase();
    if (tag === "br") {
      pushRun(runs, { ...style, text: "\n" });
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
    if (tag === "s" || tag === "strike") {
      style.strike = !token.startsWith("</");
      continue;
    }
    if (token.startsWith("<")) continue;
    const run: WordRun = { text: decodeXml(token) };
    if (style.bold) run.bold = true;
    if (style.italic) run.italic = true;
    if (style.underline) run.underline = true;
    if (style.strike) run.strike = true;
    pushRun(runs, run);
  }
  return mergeRuns(runs.length ? runs : [{ text: "" }]);
}

function pushRun(runs: WordRun[], run: WordRun) {
  if (!run.text) return;
  const previous = runs[runs.length - 1];
  if (previous
    && Boolean(previous.bold) === Boolean(run.bold)
    && Boolean(previous.italic) === Boolean(run.italic)
    && Boolean(previous.underline) === Boolean(run.underline)
    && Boolean(previous.strike) === Boolean(run.strike)
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
      && previous.bold === run.bold
      && previous.italic === run.italic
      && previous.underline === run.underline
      && previous.strike === run.strike
      && previous.fontSize === run.fontSize
      && previous.color === run.color
      && previous.font === run.font
    ) {
      previous.text += run.text;
    } else {
      merged.push({ ...run });
    }
  }
  return merged;
}

function ensureNumberingParts(files: OfficePackage) {
  if (!packageText(files, "word/numbering.xml", false)) {
    setPackageText(files, "word/numbering.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum><w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>`);
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

export function applyParagraphStyle(
  block: WordParagraph,
  patch: Partial<Pick<WordParagraph, "align" | "kind" | "level" | "style">> & { list?: WordList | null },
): WordParagraph {
  const next: WordParagraph = { ...block, dirty: true, originalXml: undefined };
  if (patch.align !== undefined) next.align = patch.align;
  if (patch.style !== undefined) next.style = patch.style;
  if (patch.kind !== undefined) next.kind = patch.kind;
  if (patch.level !== undefined) next.level = patch.level;
  if (patch.kind === "heading" && !next.level) next.level = 1;
  if (patch.kind === "paragraph") {
    next.level = undefined;
    if (!patch.style) next.style = undefined;
  }
  if (patch.list === null) next.list = undefined;
  else if (patch.list) next.list = { ...patch.list, numId: patch.list.numId || (patch.list.type === "bullet" ? 1 : 2) };
  return next;
}

export function applyRunStyle(runs: WordRun[], style: Partial<WordRun>): WordRun[] {
  return mergeRuns(runs.map((run) => ({ ...run, ...style })));
}
