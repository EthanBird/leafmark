const escapeHtml = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

// Small browser-only fallback. The desktop build always uses pulldown-cmark in Rust.
export async function renderMarkdown(source: string): Promise<string> {
  const lines = source.split(/\r?\n/);
  const output: string[] = [];
  let fence = "";
  let fenceLanguage = "";
  let fenceBody: string[] = [];
  let displayMath = false;
  let displayMathBody: string[] = [];
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    output.push(`<p>${inline(paragraph.join(" "))}</p>`);
    paragraph = [];
  };

  for (const line of lines) {
    if (line.trim() === "$$") {
      if (!displayMath) {
        flushParagraph();
        displayMath = true;
      } else {
        output.push(`<div class="math-source math-display" data-math-source="${escapeHtml(displayMathBody.join("\n"))}"></div>`);
        displayMath = false;
        displayMathBody = [];
      }
      continue;
    }
    if (displayMath) {
      displayMathBody.push(line);
      continue;
    }
    const fenceMatch = line.match(/^```([\w-]*)\s*$/);
    if (fenceMatch) {
      if (!fence) {
        flushParagraph();
        fence = "```";
        fenceLanguage = fenceMatch[1] ?? "";
      } else {
        const body = fenceBody.join("\n");
        if (/^(mermaid)$/i.test(fenceLanguage)) {
          output.push(`<pre class="diagram-source" data-mermaid-source="${escapeHtml(body)}"><code>${escapeHtml(body)}</code></pre>`);
        } else if (/^(math|tex|latex)$/i.test(fenceLanguage)) {
          output.push(`<div class="math-source math-display" data-math-source="${escapeHtml(body)}"></div>`);
        } else {
          output.push(`<pre><code class="language-${escapeHtml(fenceLanguage)}">${escapeHtml(body)}</code></pre>`);
        }
        fence = "";
        fenceBody = [];
      }
      continue;
    }
    if (fence) {
      fenceBody.push(line);
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      const level = heading[1].length;
      output.push(`<h${level}>${inline(heading[2])}</h${level}>`);
    } else if (!line.trim()) {
      flushParagraph();
    } else {
      paragraph.push(line);
    }
  }
  flushParagraph();
  return output.join("\n");
}

function inline(value: string) {
  return escapeHtml(value)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`(.+?)`/g, "<code>$1</code>")
    .replace(/\$([^$\n]+)\$/g, '<span class="math-source" data-math-source="$1"></span>');
}
