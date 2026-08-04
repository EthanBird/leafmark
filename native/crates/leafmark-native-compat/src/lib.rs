use leafmark_editor::{
    EditError, EditResult, EditSemantic, EditTransaction, EditorDocument, TextOperation, TextRange,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum NativeImeEvent {
    Enabled,
    Disabled,
    Preedit {
        text: String,
        cursor: Option<TextRange>,
    },
    Commit {
        text: String,
    },
}

#[derive(Debug, Default)]
pub struct ImeBridge {
    enabled: bool,
}

impl ImeBridge {
    pub fn enabled(&self) -> bool {
        self.enabled
    }

    pub fn handle(
        &mut self,
        document: &mut EditorDocument,
        event: NativeImeEvent,
    ) -> Result<Option<EditResult>, EditError> {
        match event {
            NativeImeEvent::Enabled => {
                self.enabled = true;
                Ok(None)
            }
            NativeImeEvent::Disabled => {
                self.enabled = false;
                document.cancel_composition();
                Ok(None)
            }
            NativeImeEvent::Preedit { text, cursor } => {
                self.enabled = true;
                if document.composition().is_none() {
                    document.begin_composition(document.selection().range())?;
                }
                document.update_composition(text, cursor)?;
                Ok(None)
            }
            NativeImeEvent::Commit { text } => {
                self.enabled = true;
                if document.composition().is_none() {
                    document.begin_composition(document.selection().range())?;
                }
                document.commit_composition(text).map(Some)
            }
        }
    }
}

pub fn apply_full_value(
    document: &mut EditorDocument,
    next: &str,
    semantic: EditSemantic,
) -> Result<Option<EditResult>, EditError> {
    let current = document.source();
    if current == next {
        return Ok(None);
    }
    let current_chars = current.chars().collect::<Vec<_>>();
    let next_chars = next.chars().collect::<Vec<_>>();
    let mut prefix = 0;
    while prefix < current_chars.len()
        && prefix < next_chars.len()
        && current_chars[prefix] == next_chars[prefix]
    {
        prefix += 1;
    }
    let mut suffix = 0;
    while suffix < current_chars.len().saturating_sub(prefix)
        && suffix < next_chars.len().saturating_sub(prefix)
        && current_chars[current_chars.len() - 1 - suffix]
            == next_chars[next_chars.len() - 1 - suffix]
    {
        suffix += 1;
    }
    let replacement = next_chars[prefix..next_chars.len() - suffix]
        .iter()
        .collect::<String>();
    let range = TextRange::new(prefix, current_chars.len() - suffix);
    let caret = prefix + replacement.chars().count();
    let transaction = EditTransaction {
        base_revision: document.revision(),
        operations: vec![TextOperation::Replace {
            range,
            text: replacement,
        }],
        selection_after: leafmark_editor::Selection::caret(caret),
        semantic,
    };
    document.apply(transaction).map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;
    use leafmark_editor::{Selection, TextRange};

    #[test]
    fn full_value_fallback_applies_minimal_unicode_change() {
        let mut document = EditorDocument::new("你好世界");
        apply_full_value(&mut document, "你好新世界", EditSemantic::Typing).unwrap();
        assert_eq!(document.source(), "你好新世界");
        assert_eq!(document.selection(), Selection::caret(3));
        document.undo().unwrap();
        assert_eq!(document.source(), "你好世界");
    }

    #[test]
    fn explicit_ime_events_preserve_preedit_until_commit() {
        let mut document = EditorDocument::new("输入：");
        document
            .set_selection(Selection::caret(document.len_chars()))
            .unwrap();
        let mut bridge = ImeBridge::default();
        bridge
            .handle(&mut document, NativeImeEvent::Enabled)
            .unwrap();
        bridge
            .handle(
                &mut document,
                NativeImeEvent::Preedit {
                    text: "zhong".to_owned(),
                    cursor: Some(TextRange::new(0, 5)),
                },
            )
            .unwrap();
        assert_eq!(document.source(), "输入：");
        assert_eq!(document.composition().unwrap().preedit, "zhong");
        bridge
            .handle(
                &mut document,
                NativeImeEvent::Commit {
                    text: "中".to_owned(),
                },
            )
            .unwrap();
        assert_eq!(document.source(), "输入：中");
    }

    #[test]
    fn fallback_handles_deletion_without_replacing_unchanged_suffix() {
        let mut document = EditorDocument::new("abc中文xyz");
        apply_full_value(&mut document, "abc中xyz", EditSemantic::Delete).unwrap();
        assert_eq!(document.source(), "abc中xyz");
        assert_eq!(document.selection(), Selection::caret(4));
    }
}
