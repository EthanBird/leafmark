use std::{collections::BTreeMap, sync::OnceLock};

static SYSTEM_FONTS: OnceLock<Vec<String>> = OnceLock::new();

pub(crate) fn system_font_families() -> Vec<String> {
    SYSTEM_FONTS.get_or_init(load_system_font_families).clone()
}

fn load_system_font_families() -> Vec<String> {
    let mut database = fontdb::Database::new();
    database.load_system_fonts();

    let mut families = BTreeMap::new();
    for face in database.faces() {
        for (family, _) in &face.families {
            let family = family.trim();
            if family.is_empty() || family.chars().any(char::is_control) {
                continue;
            }
            families
                .entry(family.to_lowercase())
                .or_insert_with(|| family.to_owned());
        }
    }

    families.into_values().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn font_names_are_sorted_unique_and_safe() {
        let fonts = system_font_families();
        assert!(fonts
            .windows(2)
            .all(|pair| pair[0].to_lowercase() < pair[1].to_lowercase()));
        assert!(fonts
            .iter()
            .all(|family| !family.is_empty() && !family.chars().any(char::is_control)));
    }
}
