import { describe, expect, it } from "vitest";
import { cropSvg, decodeSvgDataUrl } from "./png-export-utils";

describe("PNG SVG slicing", () => {
  it("decodes the SVG data URL produced by html-to-image", () => {
    const source = '<svg xmlns="http://www.w3.org/2000/svg"><text>一叶</text></svg>';
    const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`;

    expect(decodeSvgDataUrl(dataUrl)).toBe(source);
  });

  it("keeps the full foreign object while cropping a worker tile", () => {
    const source = [
      '<svg width="800" height="6000" viewBox="0 0 800 6000">',
      '<foreignObject width="100%" height="100%" x="0" y="0">',
      "<article>content</article>",
      "</foreignObject></svg>",
    ].join("");

    const tile = cropSvg(source, 800, 6000, 960, 960, 2000, 2400);

    expect(tile).toContain('width="2000"');
    expect(tile).toContain('height="2400"');
    expect(tile).toContain('viewBox="0 0 800 960"');
    expect(tile).toContain('preserveAspectRatio="none"');
    expect(tile).toContain('<foreignObject width="800" height="6000" x="0" y="-960">');
  });
});
