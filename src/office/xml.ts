const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: "\"",
  apos: "'",
};

export function decodeXml(value: string) {
  return value
    .replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (entity, body: string) => {
      if (body[0] === "#") {
        const code = body[1] === "x" || body[1] === "X"
          ? Number.parseInt(body.slice(2), 16)
          : Number(body.slice(1));
        return Number.isFinite(code) ? String.fromCodePoint(code) : entity;
      }
      return NAMED_ENTITIES[body] ?? entity;
    });
}

export function encodeXml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function xmlText(xml: string, tags = ["w:t", "a:t", "t"]) {
  const pattern = new RegExp(`<(?:${tags.join("|")})(?:\\s[^>]*)?>([\\s\\S]*?)</(?:${tags.join("|")})>`, "g");
  return [...xml.matchAll(pattern)]
    .map((match) => decodeXml(match[1].replace(/<[^>]+>/g, "")))
    .join("");
}

export function xmlAttr(xml: string, name: string) {
  const match = new RegExp(`\\b${name}="([^"]*)"`, "i").exec(xml);
  return match ? decodeXml(match[1]) : "";
}

export function optionalPrefix(tag: string) {
  return `(?:[\\w.-]+:)?${tag}`;
}

export function matchAllBlocks(xml: string, tag: string) {
  const pattern = new RegExp(`<${optionalPrefix(tag)}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${optionalPrefix(tag)}>`, "g");
  return [...xml.matchAll(pattern)].map((match) => match[0]);
}

export function stripTag(xml: string, tag: string) {
  return xml.replace(new RegExp(`<${optionalPrefix(tag)}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${optionalPrefix(tag)}>`, "g"), "");
}

export function localName(tag: string) {
  const match = /^<\/?([\w.-]+:)?([\w.-]+)/.exec(tag);
  return match?.[2] ?? tag;
}

export function encodedTextNode(tag: string, text: string, extraAttrs = "") {
  const space = /^\s|\s$|\n|\t/.test(text) ? ` xml:space="preserve"` : "";
  return `<${tag}${extraAttrs}${space}>${encodeXml(text)}</${tag}>`;
}
