import { describe, expect, it } from "vitest";
import { calculatePdfSlices, exportExtension } from "./exporting";

describe("exporting", () => {
  it("maps every export format to the correct extension", () => {
    expect(exportExtension("markdown")).toBe("md");
    expect(exportExtension("html")).toBe("html");
    expect(exportExtension("png")).toBe("png");
    expect(exportExtension("pdf-long")).toBe("pdf");
    expect(exportExtension("pdf-pages")).toBe("pdf");
  });

  it("covers the whole canvas with non-overlapping standard PDF slices", () => {
    const slices = calculatePdfSlices(1600, 5000);
    expect(slices.length).toBeGreaterThan(1);
    expect(slices[0].sourceY).toBe(0);
    for (let index = 1; index < slices.length; index += 1) {
      expect(slices[index].sourceY).toBeCloseTo(slices[index - 1].sourceY + slices[index - 1].sourceHeight);
    }
    const last = slices.at(-1)!;
    expect(last.sourceY + last.sourceHeight).toBeCloseTo(5000);
  });
});
