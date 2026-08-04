use std::{collections::HashMap, ops::Range};

use pulldown_cmark::{
    BlockQuoteKind, CodeBlockKind, Event, HeadingLevel, Options, Parser, Tag, TagEnd,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceRange {
    pub start: usize,
    pub end: usize,
}

impl SourceRange {
    pub fn new(start: usize, end: usize) -> Self {
        Self {
            start: start.min(end),
            end: end.max(start),
        }
    }

    pub fn len(self) -> usize {
        self.end.saturating_sub(self.start)
    }

    pub fn is_empty(self) -> bool {
        self.start == self.end
    }

    pub fn slice<'a>(self, source: &'a str) -> Option<&'a str> {
        source.get(self.start..self.end)
    }
}

impl From<Range<usize>> for SourceRange {
    fn from(value: Range<usize>) -> Self {
        Self::new(value.start, value.end)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AlertKind {
    Note,
    Tip,
    Important,
    Warning,
    Caution,
}

impl From<BlockQuoteKind> for AlertKind {
    fn from(value: BlockQuoteKind) -> Self {
        match value {
            BlockQuoteKind::Note => Self::Note,
            BlockQuoteKind::Tip => Self::Tip,
            BlockQuoteKind::Important => Self::Important,
            BlockQuoteKind::Warning => Self::Warning,
            BlockQuoteKind::Caution => Self::Caution,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum BlockKind {
    Paragraph,
    Heading { level: u8 },
    BlockQuote { alert: Option<AlertKind> },
    CodeBlock { language: String },
    Mermaid,
    MathBlock,
    List { start: Option<u64> },
    ListItem,
    FootnoteDefinition { label: String },
    DefinitionList,
    DefinitionTitle,
    DefinitionBody,
    Table,
    TableHead,
    TableRow,
    TableCell,
    HtmlBlock,
    Metadata,
    Rule,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Block {
    pub kind: BlockKind,
    pub range: SourceRange,
    pub plain_text: String,
    pub depth: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum InlineStyle {
    Emphasis,
    Strong,
    Strikethrough,
    Superscript,
    Subscript,
    Link { destination: String, title: String },
    Image { destination: String, title: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InlineSpan {
    pub style: InlineStyle,
    pub range: SourceRange,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum TokenKind {
    Text,
    Code,
    InlineMath,
    DisplayMath,
    RawHtml,
    FootnoteReference { label: String },
    SoftBreak,
    HardBreak,
    TaskMarker { checked: bool },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Token {
    pub kind: TokenKind,
    pub range: SourceRange,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlineItem {
    pub id: String,
    pub level: u8,
    pub text: String,
    pub range: SourceRange,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedDocument {
    pub source_len: usize,
    pub blocks: Vec<Block>,
    pub inline_spans: Vec<InlineSpan>,
    pub tokens: Vec<Token>,
    pub outline: Vec<OutlineItem>,
}

struct OpenBlock {
    kind: BlockKind,
    start: usize,
    text: String,
    depth: usize,
}

struct OpenInline {
    style: InlineStyle,
    start: usize,
}

pub fn parse_markdown(source: &str) -> ParsedDocument {
    let options = Options::ENABLE_TABLES
        | Options::ENABLE_FOOTNOTES
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_TASKLISTS
        | Options::ENABLE_SMART_PUNCTUATION
        | Options::ENABLE_HEADING_ATTRIBUTES
        | Options::ENABLE_MATH
        | Options::ENABLE_GFM;
    let mut blocks = Vec::new();
    let mut open_blocks: Vec<OpenBlock> = Vec::new();
    let mut inline_spans = Vec::new();
    let mut open_inlines: Vec<OpenInline> = Vec::new();
    let mut tokens = Vec::new();

    for (event, range) in Parser::new_ext(source, options).into_offset_iter() {
        let range = SourceRange::from(range);
        match event {
            Event::Start(tag) => {
                if let Some(kind) = block_kind(&tag) {
                    open_blocks.push(OpenBlock {
                        kind,
                        start: range.start,
                        text: String::new(),
                        depth: open_blocks.len(),
                    });
                } else if let Some(style) = inline_style(&tag) {
                    open_inlines.push(OpenInline {
                        style,
                        start: range.start,
                    });
                }
            }
            Event::End(tag) if is_block_end(tag) => {
                if let Some(open) = open_blocks.pop() {
                    blocks.push(Block {
                        kind: open.kind,
                        range: SourceRange::new(open.start, range.end),
                        plain_text: normalize_text(&open.text),
                        depth: open.depth,
                    });
                }
            }
            Event::End(tag) if is_inline_end(tag) => {
                if let Some(open) = open_inlines.pop() {
                    inline_spans.push(InlineSpan {
                        style: open.style,
                        range: SourceRange::new(open.start, range.end),
                    });
                }
            }
            Event::End(_) => {}
            Event::Text(value) => push_token(
                &mut open_blocks,
                &mut tokens,
                TokenKind::Text,
                range,
                value.to_string(),
            ),
            Event::Code(value) => push_token(
                &mut open_blocks,
                &mut tokens,
                TokenKind::Code,
                range,
                value.to_string(),
            ),
            Event::InlineMath(value) => push_token(
                &mut open_blocks,
                &mut tokens,
                TokenKind::InlineMath,
                range,
                value.to_string(),
            ),
            Event::DisplayMath(value) => push_token(
                &mut open_blocks,
                &mut tokens,
                TokenKind::DisplayMath,
                range,
                value.to_string(),
            ),
            Event::Html(value) | Event::InlineHtml(value) => push_token(
                &mut open_blocks,
                &mut tokens,
                TokenKind::RawHtml,
                range,
                value.to_string(),
            ),
            Event::FootnoteReference(label) => {
                let label = label.to_string();
                push_token(
                    &mut open_blocks,
                    &mut tokens,
                    TokenKind::FootnoteReference {
                        label: label.clone(),
                    },
                    range,
                    label,
                );
            }
            Event::SoftBreak => push_token(
                &mut open_blocks,
                &mut tokens,
                TokenKind::SoftBreak,
                range,
                "\n".to_owned(),
            ),
            Event::HardBreak => push_token(
                &mut open_blocks,
                &mut tokens,
                TokenKind::HardBreak,
                range,
                "\n".to_owned(),
            ),
            Event::Rule => blocks.push(Block {
                kind: BlockKind::Rule,
                range,
                plain_text: String::new(),
                depth: open_blocks.len(),
            }),
            Event::TaskListMarker(checked) => tokens.push(Token {
                kind: TokenKind::TaskMarker { checked },
                range,
                text: if checked { "[x]" } else { "[ ]" }.to_owned(),
            }),
        }
    }

    blocks.sort_by_key(|block| (block.range.start, block.depth, block.range.end));
    inline_spans.sort_by_key(|span| (span.range.start, span.range.end));
    tokens.sort_by_key(|token| (token.range.start, token.range.end));
    let outline = build_outline(&blocks);
    ParsedDocument {
        source_len: source.len(),
        blocks,
        inline_spans,
        tokens,
        outline,
    }
}

fn push_token(
    blocks: &mut [OpenBlock],
    tokens: &mut Vec<Token>,
    kind: TokenKind,
    range: SourceRange,
    text: String,
) {
    for block in blocks {
        block.text.push_str(&text);
    }
    tokens.push(Token { kind, range, text });
}

fn block_kind(tag: &Tag<'_>) -> Option<BlockKind> {
    Some(match tag {
        Tag::Paragraph => BlockKind::Paragraph,
        Tag::Heading { level, .. } => BlockKind::Heading {
            level: heading_level(*level),
        },
        Tag::BlockQuote(alert) => BlockKind::BlockQuote {
            alert: (*alert).map(AlertKind::from),
        },
        Tag::CodeBlock(kind) => {
            let language = match kind {
                CodeBlockKind::Indented => String::new(),
                CodeBlockKind::Fenced(language) => language.trim().to_ascii_lowercase(),
            };
            match language.as_str() {
                "mermaid" => BlockKind::Mermaid,
                "math" | "tex" | "latex" => BlockKind::MathBlock,
                _ => BlockKind::CodeBlock { language },
            }
        }
        Tag::HtmlBlock => BlockKind::HtmlBlock,
        Tag::List(start) => BlockKind::List { start: *start },
        Tag::Item => BlockKind::ListItem,
        Tag::FootnoteDefinition(label) => BlockKind::FootnoteDefinition {
            label: label.to_string(),
        },
        Tag::DefinitionList => BlockKind::DefinitionList,
        Tag::DefinitionListTitle => BlockKind::DefinitionTitle,
        Tag::DefinitionListDefinition => BlockKind::DefinitionBody,
        Tag::Table(_) => BlockKind::Table,
        Tag::TableHead => BlockKind::TableHead,
        Tag::TableRow => BlockKind::TableRow,
        Tag::TableCell => BlockKind::TableCell,
        Tag::MetadataBlock(_) => BlockKind::Metadata,
        Tag::Emphasis
        | Tag::Strong
        | Tag::Strikethrough
        | Tag::Superscript
        | Tag::Subscript
        | Tag::Link { .. }
        | Tag::Image { .. } => return None,
    })
}

fn inline_style(tag: &Tag<'_>) -> Option<InlineStyle> {
    match tag {
        Tag::Emphasis => Some(InlineStyle::Emphasis),
        Tag::Strong => Some(InlineStyle::Strong),
        Tag::Strikethrough => Some(InlineStyle::Strikethrough),
        Tag::Superscript => Some(InlineStyle::Superscript),
        Tag::Subscript => Some(InlineStyle::Subscript),
        Tag::Link {
            dest_url, title, ..
        } => Some(InlineStyle::Link {
            destination: dest_url.to_string(),
            title: title.to_string(),
        }),
        Tag::Image {
            dest_url, title, ..
        } => Some(InlineStyle::Image {
            destination: dest_url.to_string(),
            title: title.to_string(),
        }),
        _ => None,
    }
}

fn is_block_end(tag: TagEnd) -> bool {
    matches!(
        tag,
        TagEnd::Paragraph
            | TagEnd::Heading(_)
            | TagEnd::BlockQuote(_)
            | TagEnd::CodeBlock
            | TagEnd::HtmlBlock
            | TagEnd::List(_)
            | TagEnd::Item
            | TagEnd::FootnoteDefinition
            | TagEnd::DefinitionList
            | TagEnd::DefinitionListTitle
            | TagEnd::DefinitionListDefinition
            | TagEnd::Table
            | TagEnd::TableHead
            | TagEnd::TableRow
            | TagEnd::TableCell
            | TagEnd::MetadataBlock(_)
    )
}

fn is_inline_end(tag: TagEnd) -> bool {
    matches!(
        tag,
        TagEnd::Emphasis
            | TagEnd::Strong
            | TagEnd::Strikethrough
            | TagEnd::Superscript
            | TagEnd::Subscript
            | TagEnd::Link
            | TagEnd::Image
    )
}

fn normalize_text(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn heading_level(level: HeadingLevel) -> u8 {
    match level {
        HeadingLevel::H1 => 1,
        HeadingLevel::H2 => 2,
        HeadingLevel::H3 => 3,
        HeadingLevel::H4 => 4,
        HeadingLevel::H5 => 5,
        HeadingLevel::H6 => 6,
    }
}

fn build_outline(blocks: &[Block]) -> Vec<OutlineItem> {
    let mut ids = HashMap::<String, usize>::new();
    blocks
        .iter()
        .filter_map(|block| {
            let BlockKind::Heading { level } = &block.kind else {
                return None;
            };
            let base = slugify(&block.plain_text);
            let count = ids.entry(base.clone()).or_default();
            *count += 1;
            Some(OutlineItem {
                id: if *count == 1 {
                    base
                } else {
                    format!("{base}-{}", *count)
                },
                level: *level,
                text: block.plain_text.clone(),
                range: block.range,
            })
        })
        .collect()
}

fn slugify(value: &str) -> String {
    let mut slug = String::new();
    let mut separator = false;
    for character in value.trim().to_lowercase().chars() {
        if character.is_alphanumeric() || matches!(character, '_' | '-') {
            if separator && !slug.is_empty() && !slug.ends_with('-') {
                slug.push('-');
            }
            separator = false;
            slug.push(character);
        } else if character.is_whitespace() {
            separator = true;
        }
    }
    let slug = slug.trim_matches('-');
    if slug.is_empty() {
        "section".to_owned()
    } else {
        slug.to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_gfm_math_mermaid_and_ranges() {
        let source = "# 标题\n\n行内 $E=mc^2$ 与 **粗体**。\n\n```mermaid\nflowchart LR\nA-->B\n```\n\n| A | B |\n|---|---|\n| 1 | 2 |\n";
        let doc = parse_markdown(source);
        assert_eq!(doc.outline[0].id, "标题");
        assert!(doc.blocks.iter().any(|block| block.kind == BlockKind::Mermaid));
        assert!(doc.blocks.iter().any(|block| block.kind == BlockKind::Table));
        assert!(doc.tokens.iter().any(|token| {
            token.kind == TokenKind::InlineMath && token.text == "E=mc^2"
        }));
        assert!(doc
            .inline_spans
            .iter()
            .any(|span| span.style == InlineStyle::Strong));
        assert!(doc.blocks.iter().all(|block| block.range.end <= source.len()));
        assert_eq!(doc.outline[0].range.slice(source), Some("# 标题"));
    }

    #[test]
    fn creates_unique_outline_ids() {
        let doc = parse_markdown("# Same title\n\n## Same title\n\n# !!!\n");
        let ids = doc
            .outline
            .iter()
            .map(|item| item.id.as_str())
            .collect::<Vec<_>>();
        assert_eq!(ids, vec!["same-title", "same-title-2", "section"]);
    }

    #[test]
    fn keeps_raw_html_as_non_executable_data() {
        let doc = parse_markdown("<script>alert('no')</script>\n");
        let token = doc
            .tokens
            .iter()
            .find(|token| token.kind == TokenKind::RawHtml)
            .expect("raw html token");
        assert!(token.text.contains("<script>"));
    }

    #[test]
    fn classifies_math_fences_and_tasks() {
        let doc = parse_markdown("- [x] done\n\n```latex\nx^2\n```\n");
        assert!(doc.blocks.iter().any(|block| block.kind == BlockKind::MathBlock));
        assert!(doc.tokens.iter().any(|token| {
            token.kind == TokenKind::TaskMarker { checked: true }
        }));
    }
}
