// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { enhanceDocument } from "./rendering";
import { defaultAppSettings } from "./settings-defaults";

describe("document rendering", () => {
  it("highlights fenced code in read mode and leaves live editors untouched", async () => {
    const readRoot = document.createElement("div");
    readRoot.innerHTML = `<pre><code class="language-javascript">const ready = true;</code></pre>`;
    await enhanceDocument(readRoot, defaultAppSettings(), "/tmp", { highlight: true });
    const readCode = readRoot.querySelector("pre code");
    expect(readCode?.className).toContain("hljs");
    expect(readCode?.querySelector(".hljs-keyword")?.textContent).toBe("const");

    const liveRoot = document.createElement("div");
    liveRoot.innerHTML = `<pre><code class="language-javascript">const ready = true;</code></pre>`;
    await enhanceDocument(liveRoot, defaultAppSettings(), "/tmp", { highlight: false });
    expect(liveRoot.querySelector("pre code")?.className).not.toContain("hljs");
    expect(liveRoot.querySelector(".hljs-keyword")).toBeNull();
  });
});
