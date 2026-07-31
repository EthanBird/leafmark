export function decodeSvgDataUrl(dataUrl: string) {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) throw new Error("PNG 页面序列化数据无效");
  const metadata = dataUrl.slice(0, comma);
  const payload = dataUrl.slice(comma + 1);
  if (/;base64(?:;|$)/i.test(metadata)) {
    const binary = atob(payload);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }
  return decodeURIComponent(payload);
}

export function cropSvg(
  svg: string,
  width: number,
  height: number,
  sourceY: number,
  sliceHeight: number,
  pixelWidth: number,
  pixelHeight: number,
) {
  const root = svg.replace(/<svg\b([^>]*)>/i, (_, attributes: string) => (
    `<svg${replaceAttributes(attributes, {
      width: String(pixelWidth),
      height: String(pixelHeight),
      viewBox: `0 0 ${width} ${sliceHeight}`,
      preserveAspectRatio: "none",
    })}>`
  ));
  return root.replace(
    /<foreignObject\b([^>]*)>/i,
    (_, attributes: string) => (
      `<foreignObject${replaceAttributes(attributes, {
        width: String(width),
        height: String(height),
        x: "0",
        y: String(-sourceY),
      })}>`
    ),
  );
}

function replaceAttributes(
  attributes: string,
  replacements: Record<string, string>,
) {
  let next = attributes;
  for (const name of Object.keys(replacements)) {
    next = next.replace(new RegExp(`\\s${name}=(?:"[^"]*"|'[^']*')`, "i"), "");
  }
  return `${next}${Object.entries(replacements)
    .map(([name, value]) => ` ${name}="${value}"`)
    .join("")}`;
}
