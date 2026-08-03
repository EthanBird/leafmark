use std::{collections::VecDeque, error::Error, fmt};

use ropey::Rope;
use serde::{Deserialize, Serialize};

const DEFAULT_HISTORY_LIMIT: usize = 256;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextRange {
    pub start: usize,
    pub end: usize,
}

impl TextRange {
    pub fn new(start: usize, end: usize) -> Self {
        Self { start: start.min(end), end: start.max(end) }
    }
    pub fn caret(position: usize) -> Self { Self::new(position, position) }
    pub fn len(self) -> usize { self.end.saturating_sub(self.start) }
    pub fn is_empty(self) -> bool { self.start == self.end }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Selection {
    pub anchor: usize,
    pub focus: usize,
}

impl Selection {
    pub fn caret(position: usize) -> Self { Self { anchor: position, focus: position } }
    pub fn range(self) -> TextRange { TextRange::new(self.anchor, self.focus) }
    pub fn is_collapsed(self) -> bool { self.anchor == self.focus }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum EditSemantic { Typing, Paste, Delete, Format, Structural, Agent, Undo, Redo }

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum TextOperation {
    Insert { at: usize, text: String },
    Delete { range: TextRange },
    Replace { range: TextRange, text: String },
}

impl TextOperation {
    fn range(&self) -> TextRange {
        match self {
            Self::Insert { at, .. } => TextRange::caret(*at),
            Self::Delete { range } | Self::Replace { range, .. } => *range,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditTransaction {
    pub base_revision: u64,
    pub operations: Vec<TextOperation>,
    pub selection_after: Selection,
    pub semantic: EditSemantic,
}

impl EditTransaction {
    pub fn replace(base_revision: u64, range: TextRange, text: impl Into<String>, semantic: EditSemantic) -> Self {
        let text = text.into();
        let caret = range.start + text.chars().count();
        Self {
            base_revision,
            operations: vec![TextOperation::Replace { range, text }],
            selection_after: Selection::caret(caret),
            semantic,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EditResult {
    pub revision: u64,
    pub selection: Selection,
    pub chars: usize,
    pub bytes: usize,
    pub dirty: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompositionState {
    pub range: TextRange,
    pub preedit: String,
    pub cursor: Option<TextRange>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EditError {
    StaleRevision { expected: u64, received: u64 },
    OutOfBounds { range: TextRange, chars: usize },
    OverlappingOperations,
    InvalidSelection { selection: Selection, chars: usize },
    NoComposition,
}

impl fmt::Display for EditError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::StaleRevision { expected, received } => write!(f, "编辑事务版本过期：当前 {expected}，收到 {received}"),
            Self::OutOfBounds { range, chars } => write!(f, "编辑范围 {}..{} 超出文档字符数 {chars}", range.start, range.end),
            Self::OverlappingOperations => f.write_str("同一事务包含重叠编辑范围"),
            Self::InvalidSelection { selection, chars } => write!(f, "选区 {}..{} 超出文档字符数 {chars}", selection.anchor, selection.focus),
            Self::NoComposition => f.write_str("当前没有输入法组合文本"),
        }
    }
}
impl Error for EditError {}

#[derive(Clone)]
struct HistoryEntry {
    before: Rope,
    after: Rope,
    selection_before: Selection,
    selection_after: Selection,
    semantic: EditSemantic,
}

pub struct EditorDocument {
    rope: Rope,
    saved: Rope,
    revision: u64,
    selection: Selection,
    composition: Option<CompositionState>,
    undo: VecDeque<HistoryEntry>,
    redo: VecDeque<HistoryEntry>,
    history_limit: usize,
}

impl EditorDocument {
    pub fn new(source: &str) -> Self {
        let rope = Rope::from_str(source);
        Self {
            saved: rope.clone(), rope, revision: 0, selection: Selection::caret(0), composition: None,
            undo: VecDeque::new(), redo: VecDeque::new(), history_limit: DEFAULT_HISTORY_LIMIT,
        }
    }

    pub fn with_history_limit(source: &str, history_limit: usize) -> Self {
        let mut document = Self::new(source);
        document.history_limit = history_limit.max(1);
        document
    }

    pub fn revision(&self) -> u64 { self.revision }
    pub fn len_chars(&self) -> usize { self.rope.len_chars() }
    pub fn len_bytes(&self) -> usize { self.rope.len_bytes() }
    pub fn selection(&self) -> Selection { self.selection }
    pub fn composition(&self) -> Option<&CompositionState> { self.composition.as_ref() }
    pub fn source(&self) -> String { self.rope.to_string() }
    pub fn is_dirty(&self) -> bool { self.rope != self.saved }
    pub fn can_undo(&self) -> bool { !self.undo.is_empty() }
    pub fn can_redo(&self) -> bool { !self.redo.is_empty() }
    pub fn next_undo_semantic(&self) -> Option<EditSemantic> { self.undo.back().map(|entry| entry.semantic) }

    pub fn slice(&self, range: TextRange) -> Result<String, EditError> {
        self.validate_range(range)?;
        Ok(self.rope.slice(range.start..range.end).to_string())
    }

    pub fn char_to_byte(&self, character: usize) -> Result<usize, EditError> {
        if character > self.len_chars() {
            return Err(EditError::OutOfBounds { range: TextRange::caret(character), chars: self.len_chars() });
        }
        Ok(self.rope.char_to_byte(character))
    }

    pub fn byte_to_char(&self, byte: usize) -> Result<usize, EditError> {
        if byte > self.len_bytes() {
            return Err(EditError::OutOfBounds { range: TextRange::caret(byte), chars: self.len_chars() });
        }
        Ok(self.rope.byte_to_char(byte))
    }

    pub fn set_selection(&mut self, selection: Selection) -> Result<(), EditError> {
        self.validate_selection(selection)?;
        self.selection = selection;
        Ok(())
    }

    pub fn apply(&mut self, transaction: EditTransaction) -> Result<EditResult, EditError> {
        if transaction.base_revision != self.revision {
            return Err(EditError::StaleRevision { expected: self.revision, received: transaction.base_revision });
        }
        let mut indexed = transaction.operations.iter().enumerate().map(|(index, operation)| (index, operation.range())).collect::<Vec<_>>();
        for (_, range) in &indexed { self.validate_range(*range)?; }
        indexed.sort_by_key(|(index, range)| (range.start, range.end, *index));
        for pair in indexed.windows(2) {
            let (_, left) = pair[0];
            let (_, right) = pair[1];
            if right.start < left.end || (left.is_empty() && right.is_empty() && left.start == right.start) {
                return Err(EditError::OverlappingOperations);
            }
        }

        let before = self.rope.clone();
        let selection_before = self.selection;
        let mut operations = transaction.operations;
        operations.sort_by(|left, right| {
            let left = left.range();
            let right = right.range();
            right.start.cmp(&left.start).then_with(|| right.end.cmp(&left.end))
        });
        for operation in operations {
            match operation {
                TextOperation::Insert { at, text } => self.rope.insert(at, &text),
                TextOperation::Delete { range } => { self.rope.remove(range.start..range.end); }
                TextOperation::Replace { range, text } => {
                    self.rope.remove(range.start..range.end);
                    self.rope.insert(range.start, &text);
                }
            }
        }
        self.validate_selection(transaction.selection_after)?;
        self.selection = transaction.selection_after;
        self.composition = None;
        self.revision = self.revision.saturating_add(1);
        self.undo.push_back(HistoryEntry {
            before, after: self.rope.clone(), selection_before, selection_after: self.selection, semantic: transaction.semantic,
        });
        while self.undo.len() > self.history_limit { self.undo.pop_front(); }
        self.redo.clear();
        Ok(self.result())
    }

    pub fn replace_selection(&mut self, text: impl Into<String>, semantic: EditSemantic) -> Result<EditResult, EditError> {
        self.apply(EditTransaction::replace(self.revision, self.selection.range(), text, semantic))
    }

    pub fn undo(&mut self) -> Option<EditResult> {
        let entry = self.undo.pop_back()?;
        self.rope = entry.before.clone();
        self.selection = entry.selection_before;
        self.composition = None;
        self.revision = self.revision.saturating_add(1);
        self.redo.push_back(entry);
        Some(self.result())
    }

    pub fn redo(&mut self) -> Option<EditResult> {
        let entry = self.redo.pop_back()?;
        self.rope = entry.after.clone();
        self.selection = entry.selection_after;
        self.composition = None;
        self.revision = self.revision.saturating_add(1);
        self.undo.push_back(entry);
        Some(self.result())
    }

    pub fn mark_saved(&mut self) -> EditResult { self.saved = self.rope.clone(); self.result() }

    pub fn begin_composition(&mut self, range: TextRange) -> Result<(), EditError> {
        self.validate_range(range)?;
        self.composition = Some(CompositionState { range, preedit: String::new(), cursor: None });
        Ok(())
    }

    pub fn update_composition(&mut self, preedit: impl Into<String>, cursor: Option<TextRange>) -> Result<(), EditError> {
        let composition = self.composition.as_mut().ok_or(EditError::NoComposition)?;
        composition.preedit = preedit.into();
        composition.cursor = cursor;
        Ok(())
    }

    pub fn commit_composition(&mut self, text: impl Into<String>) -> Result<EditResult, EditError> {
        let composition = self.composition.take().ok_or(EditError::NoComposition)?;
        self.apply(EditTransaction::replace(self.revision, composition.range, text, EditSemantic::Typing))
    }

    pub fn cancel_composition(&mut self) { self.composition = None; }

    fn validate_range(&self, range: TextRange) -> Result<(), EditError> {
        if range.start > range.end || range.end > self.len_chars() {
            return Err(EditError::OutOfBounds { range, chars: self.len_chars() });
        }
        Ok(())
    }

    fn validate_selection(&self, selection: Selection) -> Result<(), EditError> {
        if selection.anchor > self.len_chars() || selection.focus > self.len_chars() {
            return Err(EditError::InvalidSelection { selection, chars: self.len_chars() });
        }
        Ok(())
    }

    fn result(&self) -> EditResult {
        EditResult { revision: self.revision, selection: self.selection, chars: self.len_chars(), bytes: self.len_bytes(), dirty: self.is_dirty() }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn edits_unicode_by_character_offset() {
        let mut document = EditorDocument::new("一叶🌿");
        document.set_selection(Selection::caret(2)).unwrap();
        document.replace_selection("原生", EditSemantic::Typing).unwrap();
        assert_eq!(document.source(), "一叶原生🌿");
        assert_eq!(document.selection(), Selection::caret(4));
        assert_eq!(document.char_to_byte(4).unwrap(), "一叶原生".len());
    }

    #[test]
    fn applies_non_overlapping_operations_against_one_revision() {
        let mut document = EditorDocument::new("abcdef");
        document.apply(EditTransaction {
            base_revision: 0,
            operations: vec![
                TextOperation::Replace { range: TextRange::new(1, 3), text: "XY".to_owned() },
                TextOperation::Delete { range: TextRange::new(4, 6) },
            ],
            selection_after: Selection::caret(4),
            semantic: EditSemantic::Structural,
        }).unwrap();
        assert_eq!(document.source(), "aXYd");
    }

    #[test]
    fn rejects_stale_and_overlapping_transactions() {
        let mut document = EditorDocument::new("abcdef");
        document.replace_selection("x", EditSemantic::Typing).unwrap();
        assert!(matches!(document.apply(EditTransaction::replace(0, TextRange::caret(0), "y", EditSemantic::Typing)), Err(EditError::StaleRevision { .. })));
        let overlapping = EditTransaction {
            base_revision: document.revision(),
            operations: vec![
                TextOperation::Delete { range: TextRange::new(0, 2) },
                TextOperation::Replace { range: TextRange::new(1, 3), text: "z".to_owned() },
            ],
            selection_after: Selection::caret(0),
            semantic: EditSemantic::Structural,
        };
        assert_eq!(document.apply(overlapping), Err(EditError::OverlappingOperations));
    }

    #[test]
    fn undo_redo_and_saved_state_are_content_based() {
        let mut document = EditorDocument::new("one");
        document.set_selection(Selection::caret(3)).unwrap();
        document.replace_selection(" two", EditSemantic::Typing).unwrap();
        assert!(document.is_dirty());
        document.mark_saved();
        assert!(!document.is_dirty());
        document.undo().unwrap();
        assert_eq!(document.source(), "one");
        assert!(document.is_dirty());
        document.redo().unwrap();
        assert_eq!(document.source(), "one two");
        assert!(!document.is_dirty());
    }

    #[test]
    fn composition_preedit_does_not_mutate_source_until_commit() {
        let mut document = EditorDocument::new("输入：");
        let end = document.len_chars();
        document.begin_composition(TextRange::caret(end)).unwrap();
        document.update_composition("zhong", Some(TextRange::new(0, 5))).unwrap();
        assert_eq!(document.source(), "输入：");
        assert_eq!(document.composition().unwrap().preedit, "zhong");
        document.commit_composition("中").unwrap();
        assert_eq!(document.source(), "输入：中");
    }
}
