use leafmark_markdown::{Block, BlockKind, ParsedDocument, SourceRange};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Point {
    pub x: f32,
    pub y: f32,
}
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Size {
    pub width: f32,
    pub height: f32,
}
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Rect {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}
impl Rect {
    pub fn contains(self, point: Point) -> bool {
        point.x >= self.x
            && point.x <= self.x + self.width
            && point.y >= self.y
            && point.y <= self.y + self.height
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Color {
    pub red: u8,
    pub green: u8,
    pub blue: u8,
    pub alpha: u8,
}
impl Color {
    pub const fn rgb(red: u8, green: u8, blue: u8) -> Self {
        Self {
            red,
            green,
            blue,
            alpha: 255,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum PaintCommand {
    TextRun {
        text: String,
        origin: Point,
        font_size: f32,
        weight: u16,
        italic: bool,
        color: Color,
        source_range: SourceRange,
    },
    FillRect {
        rect: Rect,
        color: Color,
        radius: f32,
    },
    StrokeRect {
        rect: Rect,
        color: Color,
        width: f32,
        radius: f32,
    },
    Rule {
        from: Point,
        to: Point,
        color: Color,
        width: f32,
    },
    Placeholder {
        kind: PlaceholderKind,
        rect: Rect,
        source: String,
        source_range: SourceRange,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PlaceholderKind {
    Code,
    Math,
    Mermaid,
    Table,
    Image,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum HitAction {
    SelectText,
    OpenLink { destination: String },
    ToggleTask,
    EditAtomicBlock,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HitRegion {
    pub rect: Rect,
    pub source_range: SourceRange,
    pub action: HitAction,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AccessibilityRole {
    Document,
    Heading,
    Paragraph,
    List,
    ListItem,
    BlockQuote,
    Code,
    Math,
    Diagram,
    Table,
    Separator,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AccessibilityNode {
    pub role: AccessibilityRole,
    pub label: String,
    pub rect: Rect,
    pub source_range: SourceRange,
    pub level: Option<u8>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OutlineDestination {
    pub id: String,
    pub point: Point,
    pub source_range: SourceRange,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DocumentScene {
    pub size: Size,
    pub commands: Vec<PaintCommand>,
    pub hit_regions: Vec<HitRegion>,
    pub accessibility: Vec<AccessibilityNode>,
    pub outline: Vec<OutlineDestination>,
}
impl DocumentScene {
    pub fn hit_test(&self, point: Point) -> Option<&HitRegion> {
        self.hit_regions
            .iter()
            .rev()
            .find(|region| region.rect.contains(point))
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SceneTheme {
    pub surface: Color,
    pub raised: Color,
    pub text: Color,
    pub secondary: Color,
    pub border: Color,
    pub accent: Color,
    pub code_surface: Color,
}
impl Default for SceneTheme {
    fn default() -> Self {
        Self {
            surface: Color::rgb(247, 248, 244),
            raised: Color::rgb(255, 255, 255),
            text: Color::rgb(36, 48, 39),
            secondary: Color::rgb(98, 111, 101),
            border: Color::rgb(215, 221, 212),
            accent: Color::rgb(49, 95, 64),
            code_surface: Color::rgb(238, 241, 235),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LayoutConfig {
    pub width: f32,
    pub margin_horizontal: f32,
    pub margin_vertical: f32,
    pub base_font_size: f32,
    pub line_height: f32,
    pub block_gap: f32,
}
impl Default for LayoutConfig {
    fn default() -> Self {
        Self {
            width: 860.0,
            margin_horizontal: 52.0,
            margin_vertical: 42.0,
            base_font_size: 16.0,
            line_height: 1.75,
            block_gap: 14.0,
        }
    }
}

pub fn build_scene(
    document: &ParsedDocument,
    source: &str,
    config: LayoutConfig,
    theme: SceneTheme,
) -> DocumentScene {
    let content_width = (config.width - config.margin_horizontal * 2.0).max(120.0);
    let mut commands = vec![PaintCommand::FillRect {
        rect: Rect {
            x: 0.0,
            y: 0.0,
            width: config.width,
            height: 1.0,
        },
        color: theme.raised,
        radius: 0.0,
    }];
    let mut hit_regions = Vec::new();
    let mut accessibility = Vec::new();
    let mut outline = Vec::new();
    let mut y = config.margin_vertical;

    for block in document.blocks.iter().filter(|block| block.depth == 0) {
        let top = y;
        match &block.kind {
            BlockKind::Rule => {
                commands.push(PaintCommand::Rule {
                    from: Point {
                        x: config.margin_horizontal,
                        y: y + 8.0,
                    },
                    to: Point {
                        x: config.width - config.margin_horizontal,
                        y: y + 8.0,
                    },
                    color: theme.border,
                    width: 1.0,
                });
                y += 18.0;
            }
            BlockKind::CodeBlock { .. }
            | BlockKind::Mermaid
            | BlockKind::MathBlock
            | BlockKind::Table => {
                let kind = match &block.kind {
                    BlockKind::Mermaid => PlaceholderKind::Mermaid,
                    BlockKind::MathBlock => PlaceholderKind::Math,
                    BlockKind::Table => PlaceholderKind::Table,
                    _ => PlaceholderKind::Code,
                };
                let raw = source_fragment(source, block.range).to_owned();
                let lines = raw.lines().count().max(1) as f32;
                let height = match kind {
                    PlaceholderKind::Mermaid => (120.0 + lines * 8.0).min(360.0),
                    PlaceholderKind::Math => (54.0 + lines * 18.0).min(260.0),
                    PlaceholderKind::Table => (44.0 + lines * 24.0).min(520.0),
                    _ => (34.0 + lines * 22.0).min(620.0),
                };
                let rect = Rect {
                    x: config.margin_horizontal,
                    y,
                    width: content_width,
                    height,
                };
                commands.push(PaintCommand::FillRect {
                    rect,
                    color: theme.code_surface,
                    radius: 8.0,
                });
                commands.push(PaintCommand::StrokeRect {
                    rect,
                    color: theme.border,
                    width: 1.0,
                    radius: 8.0,
                });
                commands.push(PaintCommand::Placeholder {
                    kind,
                    rect,
                    source: raw,
                    source_range: block.range,
                });
                y += height;
            }
            _ => {
                let (font_size, weight, color, prefix_width) =
                    text_style(block, config.base_font_size, theme);
                let indent = if matches!(&block.kind, BlockKind::BlockQuote { .. }) {
                    18.0
                } else {
                    0.0
                };
                let available = (content_width - indent - prefix_width).max(80.0);
                let lines = wrap_text(&block.plain_text, available, font_size);
                let line_height = font_size * config.line_height;
                if matches!(&block.kind, BlockKind::BlockQuote { .. }) {
                    commands.push(PaintCommand::FillRect {
                        rect: Rect {
                            x: config.margin_horizontal,
                            y,
                            width: 4.0,
                            height: line_height * lines.len() as f32,
                        },
                        color: theme.accent,
                        radius: 2.0,
                    });
                }
                for (index, line) in lines.iter().enumerate() {
                    commands.push(PaintCommand::TextRun {
                        text: line.clone(),
                        origin: Point {
                            x: config.margin_horizontal + indent + prefix_width,
                            y: y + font_size + index as f32 * line_height,
                        },
                        font_size,
                        weight,
                        italic: false,
                        color,
                        source_range: block.range,
                    });
                }
                y += lines.len().max(1) as f32 * line_height;
            }
        }
        let rect = Rect {
            x: config.margin_horizontal,
            y: top,
            width: content_width,
            height: (y - top).max(1.0),
        };
        let (role, level) = accessibility_role(block);
        accessibility.push(AccessibilityNode {
            role,
            label: block.plain_text.clone(),
            rect,
            source_range: block.range,
            level,
        });
        hit_regions.push(HitRegion {
            rect,
            source_range: block.range,
            action: if matches!(&block.kind, BlockKind::Mermaid | BlockKind::MathBlock) {
                HitAction::EditAtomicBlock
            } else {
                HitAction::SelectText
            },
        });
        if matches!(&block.kind, BlockKind::Heading { .. }) {
            if let Some(item) = document
                .outline
                .iter()
                .find(|item| item.range == block.range)
            {
                outline.push(OutlineDestination {
                    id: item.id.clone(),
                    point: Point {
                        x: config.margin_horizontal,
                        y: top,
                    },
                    source_range: block.range,
                });
            }
        }
        y += config.block_gap;
    }

    y += config.margin_vertical - config.block_gap;
    if let Some(PaintCommand::FillRect { rect, .. }) = commands.first_mut() {
        rect.height = y.max(1.0);
    }
    accessibility.insert(
        0,
        AccessibilityNode {
            role: AccessibilityRole::Document,
            label: "Markdown document".to_owned(),
            rect: Rect {
                x: 0.0,
                y: 0.0,
                width: config.width,
                height: y,
            },
            source_range: SourceRange::new(0, document.source_len),
            level: None,
        },
    );
    DocumentScene {
        size: Size {
            width: config.width,
            height: y,
        },
        commands,
        hit_regions,
        accessibility,
        outline,
    }
}

fn source_fragment(source: &str, range: SourceRange) -> &str {
    if range.end <= source.len()
        && source.is_char_boundary(range.start)
        && source.is_char_boundary(range.end)
    {
        &source[range.start..range.end]
    } else {
        ""
    }
}

fn text_style(block: &Block, base: f32, theme: SceneTheme) -> (f32, u16, Color, f32) {
    match &block.kind {
        BlockKind::Heading { level } => {
            let scale = match *level {
                1 => 2.0,
                2 => 1.55,
                3 => 1.3,
                4 => 1.16,
                5 => 1.05,
                _ => 1.0,
            };
            (base * scale, 700, theme.text, 0.0)
        }
        BlockKind::List { start } => (
            base,
            400,
            theme.text,
            if start.is_some() { 24.0 } else { 18.0 },
        ),
        BlockKind::FootnoteDefinition { .. } => (base * 0.9, 400, theme.secondary, 0.0),
        _ => (base, 400, theme.text, 0.0),
    }
}

fn accessibility_role(block: &Block) -> (AccessibilityRole, Option<u8>) {
    match &block.kind {
        BlockKind::Heading { level } => (AccessibilityRole::Heading, Some(*level)),
        BlockKind::List { .. } => (AccessibilityRole::List, None),
        BlockKind::ListItem => (AccessibilityRole::ListItem, None),
        BlockKind::BlockQuote { .. } => (AccessibilityRole::BlockQuote, None),
        BlockKind::CodeBlock { .. } => (AccessibilityRole::Code, None),
        BlockKind::MathBlock => (AccessibilityRole::Math, None),
        BlockKind::Mermaid => (AccessibilityRole::Diagram, None),
        BlockKind::Table | BlockKind::TableHead | BlockKind::TableRow | BlockKind::TableCell => {
            (AccessibilityRole::Table, None)
        }
        BlockKind::Rule => (AccessibilityRole::Separator, None),
        _ => (AccessibilityRole::Paragraph, None),
    }
}

fn wrap_text(text: &str, width: f32, font_size: f32) -> Vec<String> {
    if text.is_empty() {
        return vec![String::new()];
    }
    let mut lines = Vec::new();
    for source_line in text.lines() {
        let mut current = String::new();
        let mut advance = 0.0;
        for character in source_line.chars() {
            let char_advance = estimated_advance(character, font_size);
            if !current.is_empty() && advance + char_advance > width {
                lines.push(std::mem::take(&mut current));
                advance = 0.0;
            }
            current.push(character);
            advance += char_advance;
        }
        lines.push(current);
    }
    if lines.is_empty() {
        lines.push(String::new());
    }
    lines
}

fn estimated_advance(character: char, font_size: f32) -> f32 {
    if character.is_whitespace() {
        font_size * 0.34
    } else if character.is_ascii() {
        font_size * 0.56
    } else {
        font_size
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use leafmark_markdown::parse_markdown;

    #[test]
    fn scene_preserves_outline_accessibility_hits_and_raw_atomic_source() {
        let source = "# 标题\n\n正文 **粗体**。\n\n```mermaid\nA-->B\n```\n\n```math\nx^2\n```\n";
        let parsed = parse_markdown(source);
        let scene = build_scene(
            &parsed,
            source,
            LayoutConfig::default(),
            SceneTheme::default(),
        );
        assert!(scene.size.height > 200.0);
        assert_eq!(scene.outline[0].id, "标题");
        assert!(scene
            .accessibility
            .iter()
            .any(|node| node.role == AccessibilityRole::Heading));
        assert!(scene.commands.iter().any(|command| matches!(command, PaintCommand::Placeholder { kind: PlaceholderKind::Mermaid, source, .. } if source.contains("A-->B"))));
        assert!(scene.commands.iter().any(|command| matches!(command, PaintCommand::Placeholder { kind: PlaceholderKind::Math, source, .. } if source.contains("x^2"))));
        let first = scene.hit_regions[0].rect;
        assert!(scene
            .hit_test(Point {
                x: first.x + 1.0,
                y: first.y + 1.0
            })
            .is_some());
    }

    #[test]
    fn long_cjk_text_wraps_deterministically() {
        let source = "一叶原生编辑器正在构建统一文档场景。这个句子会自动换行。\n";
        let parsed = parse_markdown(source);
        let scene = build_scene(
            &parsed,
            source,
            LayoutConfig {
                width: 220.0,
                margin_horizontal: 20.0,
                ..LayoutConfig::default()
            },
            SceneTheme::default(),
        );
        let runs = scene
            .commands
            .iter()
            .filter(|command| matches!(command, PaintCommand::TextRun { .. }))
            .count();
        assert!(runs >= 2);
    }
}
