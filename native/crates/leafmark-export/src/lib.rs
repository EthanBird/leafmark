use leafmark_scene::{Color, DocumentScene, PaintCommand, PlaceholderKind};
use pulldown_cmark::{html, CodeBlockKind, CowStr, Event, Options, Parser, Tag, TagEnd};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HtmlTheme {
    pub surface: String,
    pub text: String,
    pub secondary: String,
    pub border: String,
    pub accent: String,
    pub code_surface: String,
    pub font_family: String,
    pub font_size_px: u32,
    pub line_height_hundredths: u32,
    pub content_width_px: u32,
}

impl Default for HtmlTheme {
    fn default() -> Self {
        Self {
            surface: "#ffffff".to_owned(),
            text: "#243027".to_owned(),
            secondary: "#626f65".to_owned(),
            border: "#d7ddd4".to_owned(),
            accent: "#315f40".to_owned(),
            code_surface: "#eef1eb".to_owned(),
            font_family: "system-ui, sans-serif".to_owned(),
            font_size_px: 16,
            line_height_hundredths: 175,
            content_width_px: 860,
        }
    }
}

pub fn export_markdown(source: &str) -> Vec<u8> {
    source.as_bytes().to_vec()
}

pub fn export_standalone_html(source: &str, title: &str, theme: &HtmlTheme) -> String {
    let body = render_safe_markdown_html(source);
    let css = format!(
        ":root{{--surface:{};--text:{};--secondary:{};--border:{};--accent:{};--code:{};--font:{};--font-size:{}px;--line-height:{:.2};--width:{}px}}*{{box-sizing:border-box}}html,body{{margin:0;background:var(--surface);color:var(--text)}}body{{font-family:var(--font);font-size:var(--font-size);line-height:var(--line-height)}}.markdown-body{{max-width:var(--width);margin:0 auto;padding:48px 32px;overflow-wrap:anywhere}}h1,h2,h3,h4,h5,h6{{line-height:1.3}}a{{color:var(--accent)}}pre,code{{background:var(--code);border-radius:6px}}pre{{padding:14px;overflow:auto;border:1px solid var(--border)}}code{{padding:.12em .3em}}blockquote{{margin-left:0;padding-left:16px;border-left:4px solid var(--accent);color:var(--secondary)}}table{{width:100%;border-collapse:collapse}}th,td{{padding:8px 10px;border:1px solid var(--border)}}.math-source,.diagram-source{{white-space:pre-wrap}}.math-display{{display:block;padding:14px;text-align:center;border:1px solid var(--border)}}",
        sanitize_css_value(&theme.surface),
        sanitize_css_value(&theme.text),
        sanitize_css_value(&theme.secondary),
        sanitize_css_value(&theme.border),
        sanitize_css_value(&theme.accent),
        sanitize_css_value(&theme.code_surface),
        sanitize_css_value(&theme.font_family),
        theme.font_size_px.clamp(8, 72),
        (theme.line_height_hundredths as f32 / 100.0).clamp(1.0, 3.0),
        theme.content_width_px.clamp(320, 2400),
    );
    format!(
        "<!doctype html>\n<html lang=\"zh-CN\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n<title>{}</title>\n<style>{css}</style>\n</head>\n<body><main class=\"markdown-body\">{body}</main></body>\n</html>\n",
        escape_html(title),
    )
}

pub fn render_safe_markdown_html(source: &str) -> String {
    let options = Options::ENABLE_TABLES
        | Options::ENABLE_FOOTNOTES
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_TASKLISTS
        | Options::ENABLE_SMART_PUNCTUATION
        | Options::ENABLE_HEADING_ATTRIBUTES
        | Options::ENABLE_MATH
        | Options::ENABLE_GFM;
    let parser = Parser::new_ext(source, options);
    let mut events = Vec::new();
    let mut special: Option<(SpecialBlock, String)> = None;

    for event in parser {
        if let Some((_, body)) = special.as_mut() {
            match event {
                Event::End(TagEnd::CodeBlock) => {
                    let (kind, body) = special.take().expect("special block exists");
                    events.push(Event::Html(CowStr::Boxed(
                        render_special(kind, &body).into_boxed_str(),
                    )));
                }
                Event::Text(value) | Event::Code(value) => body.push_str(&value),
                Event::SoftBreak | Event::HardBreak => body.push('\n'),
                _ => {}
            }
            continue;
        }

        match event {
            Event::Start(Tag::CodeBlock(CodeBlockKind::Fenced(language))) => {
                let language = language.trim().to_ascii_lowercase();
                let kind = match language.as_str() {
                    "mermaid" => Some(SpecialBlock::Mermaid),
                    "math" | "tex" | "latex" => Some(SpecialBlock::Math),
                    _ => None,
                };
                if let Some(kind) = kind {
                    special = Some((kind, String::new()));
                } else {
                    events.push(Event::Start(Tag::CodeBlock(CodeBlockKind::Fenced(
                        CowStr::Boxed(language.into_boxed_str()),
                    ))));
                }
            }
            Event::InlineMath(value) => events.push(Event::Html(CowStr::Boxed(
                format!(
                    "<code class=\"math-source\" data-math-source=\"{}\">{}</code>",
                    escape_attribute(&value),
                    escape_html(&value)
                )
                .into_boxed_str(),
            ))),
            Event::DisplayMath(value) => events.push(Event::Html(CowStr::Boxed(
                format!(
                    "<pre class=\"math-source math-display\" data-math-source=\"{}\"><code>{}</code></pre>",
                    escape_attribute(&value),
                    escape_html(&value)
                )
                .into_boxed_str(),
            ))),
            Event::Html(value) | Event::InlineHtml(value) => events.push(Event::Text(value)),
            other => events.push(other),
        }
    }

    if let Some((kind, body)) = special {
        events.push(Event::Html(CowStr::Boxed(
            render_special(kind, &body).into_boxed_str(),
        )));
    }
    let mut output = String::with_capacity(source.len().saturating_mul(2));
    html::push_html(&mut output, events.into_iter());
    output
}

pub fn export_scene_svg(scene: &DocumentScene) -> String {
    let width = finite_nonnegative(scene.size.width);
    let height = finite_nonnegative(scene.size.height);
    let mut output = format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{width}\" height=\"{height}\" viewBox=\"0 0 {width} {height}\" role=\"img\">"
    );
    for command in &scene.commands {
        append_svg_command(&mut output, command);
    }
    output.push_str("</svg>");
    output
}

fn append_svg_command(output: &mut String, command: &PaintCommand) {
    match command {
        PaintCommand::TextRun {
            text,
            origin,
            font_size,
            weight,
            italic,
            color,
            ..
        } => output.push_str(&format!(
            "<text x=\"{}\" y=\"{}\" font-size=\"{}\" font-weight=\"{}\" font-style=\"{}\" fill=\"{}\"{}>{}</text>",
            finite(origin.x),
            finite(origin.y),
            finite_nonnegative(*font_size),
            weight,
            if *italic { "italic" } else { "normal" },
            color_hex(*color),
            opacity_attribute(*color),
            escape_html(text),
        )),
        PaintCommand::FillRect { rect, color, radius } => output.push_str(&format!(
            "<rect x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" rx=\"{}\" fill=\"{}\"{}/>",
            finite(rect.x),
            finite(rect.y),
            finite_nonnegative(rect.width),
            finite_nonnegative(rect.height),
            finite_nonnegative(*radius),
            color_hex(*color),
            opacity_attribute(*color),
        )),
        PaintCommand::StrokeRect {
            rect,
            color,
            width,
            radius,
        } => output.push_str(&format!(
            "<rect x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" rx=\"{}\" fill=\"none\" stroke=\"{}\" stroke-width=\"{}\"{}/>",
            finite(rect.x),
            finite(rect.y),
            finite_nonnegative(rect.width),
            finite_nonnegative(rect.height),
            finite_nonnegative(*radius),
            color_hex(*color),
            finite_nonnegative(*width),
            opacity_attribute(*color),
        )),
        PaintCommand::Rule {
            from,
            to,
            color,
            width,
        } => output.push_str(&format!(
            "<line x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\" stroke=\"{}\" stroke-width=\"{}\"{}/>",
            finite(from.x),
            finite(from.y),
            finite(to.x),
            finite(to.y),
            color_hex(*color),
            finite_nonnegative(*width),
            opacity_attribute(*color),
        )),
        PaintCommand::Placeholder {
            kind,
            rect,
            source,
            ..
        } => {
            let label = match kind {
                PlaceholderKind::Code => "Code",
                PlaceholderKind::Math => "Math",
                PlaceholderKind::Mermaid => "Mermaid",
                PlaceholderKind::Table => "Table",
                PlaceholderKind::Image => "Image",
            };
            let preview = source
                .lines()
                .find(|line| !line.trim().is_empty())
                .unwrap_or_default();
            output.push_str(&format!(
                "<text x=\"{}\" y=\"{}\" font-size=\"13\" font-weight=\"700\" fill=\"#315f40\">{label}</text><text x=\"{}\" y=\"{}\" font-size=\"12\" fill=\"#626f65\">{}</text>",
                finite(rect.x + 12.0),
                finite(rect.y + 22.0),
                finite(rect.x + 12.0),
                finite(rect.y + 43.0),
                escape_html(&preview.chars().take(100).collect::<String>()),
            ));
        }
    }
}

#[derive(Clone, Copy)]
enum SpecialBlock {
    Mermaid,
    Math,
}

fn render_special(kind: SpecialBlock, source: &str) -> String {
    match kind {
        SpecialBlock::Mermaid => format!(
            "<pre class=\"diagram-source\" data-mermaid-source=\"{}\"><code>{}</code></pre>",
            escape_attribute(source),
            escape_html(source),
        ),
        SpecialBlock::Math => format!(
            "<pre class=\"math-source math-display\" data-math-source=\"{}\"><code>{}</code></pre>",
            escape_attribute(source.trim()),
            escape_html(source.trim()),
        ),
    }
}

fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn escape_attribute(value: &str) -> String {
    escape_html(value)
        .replace('\r', "&#13;")
        .replace('\n', "&#10;")
}

fn sanitize_css_value(value: &str) -> String {
    value
        .chars()
        .filter(|character| {
            !matches!(character, ';' | '{' | '}' | '<' | '>') && !character.is_control()
        })
        .collect()
}

fn color_hex(color: Color) -> String {
    format!("#{:02x}{:02x}{:02x}", color.red, color.green, color.blue)
}

fn opacity_attribute(color: Color) -> String {
    if color.alpha == 255 {
        String::new()
    } else {
        format!(" opacity=\"{:.3}\"", f32::from(color.alpha) / 255.0)
    }
}

fn finite(value: f32) -> f32 {
    if value.is_finite() {
        value
    } else {
        0.0
    }
}

fn finite_nonnegative(value: f32) -> f32 {
    finite(value).max(0.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use leafmark_markdown::parse_markdown;
    use leafmark_scene::{build_scene, LayoutConfig, Rect, SceneTheme, Size};

    #[test]
    fn standalone_html_escapes_raw_html_and_title() {
        let html = export_standalone_html(
            "# Hi\n\n<script>alert(1)</script>\n",
            "<Leaf & Mark>",
            &HtmlTheme::default(),
        );
        assert!(html.contains("&lt;Leaf &amp; Mark&gt;"));
        assert!(!html.contains("<script>"));
        assert!(html.contains("&lt;script&gt;"));
    }

    #[test]
    fn standalone_html_preserves_math_and_mermaid_without_javascript() {
        let html = export_standalone_html(
            "$E=mc^2$\n\n```mermaid\nA-->B\n```\n",
            "Demo",
            &HtmlTheme::default(),
        );
        assert!(html.contains("data-math-source=\"E=mc^2\""));
        assert!(html.contains("data-mermaid-source="));
        assert!(html.contains("A--&gt;B"));
        assert!(!html.contains("<script"));
    }

    #[test]
    fn scene_svg_contains_text_and_only_finite_values() {
        let source = "# 一叶\n\n正文\n";
        let parsed = parse_markdown(source);
        let scene = build_scene(
            &parsed,
            source,
            LayoutConfig::default(),
            SceneTheme::default(),
        );
        let svg = export_scene_svg(&scene);
        assert!(svg.starts_with("<svg"));
        assert!(svg.contains("<text"));
        assert!(!svg.contains("NaN"));
        assert!(!svg.contains("inf"));
    }

    #[test]
    fn malformed_scene_values_are_sanitized() {
        let scene = DocumentScene {
            size: Size {
                width: f32::NAN,
                height: f32::INFINITY,
            },
            commands: vec![PaintCommand::FillRect {
                rect: Rect {
                    x: -10.0,
                    y: f32::NAN,
                    width: 20.0,
                    height: 30.0,
                },
                color: Color::rgb(1, 2, 3),
                radius: 0.0,
            }],
            hit_regions: Vec::new(),
            accessibility: Vec::new(),
            outline: Vec::new(),
        };
        let svg = export_scene_svg(&scene);
        assert!(!svg.contains("NaN"));
        assert!(!svg.contains("inf"));
    }
}
