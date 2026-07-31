use std::{collections::BTreeMap, sync::OnceLock};

use serde::Serialize;

static SYSTEM_FONTS: OnceLock<Vec<String>> = OnceLock::new();

pub(crate) fn system_font_families() -> Vec<String> {
    SYSTEM_FONTS.get_or_init(load_system_font_families).clone()
}

fn load_system_font_families() -> Vec<String> {
    let database = load_database();
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportFontMetadata {
    family: String,
    postscript_name: String,
    collection: bool,
}

pub(crate) fn export_font_payload(
    preferred_family: &str,
    contains_cjk: bool,
) -> Result<Vec<u8>, String> {
    let database = load_database();
    let preferred = preferred_family.trim();
    let cjk_families = [
        "Microsoft YaHei UI",
        "Microsoft YaHei",
        "DengXian",
        "SimHei",
        "SimSun",
        "NSimSun",
        "FangSong",
        "KaiTi",
        "Noto Serif CJK SC",
        "Source Han Serif SC",
        "Noto Sans CJK SC",
        "Source Han Sans SC",
        "Noto Serif SC",
        "Noto Sans SC",
        "PingFang SC",
        "Songti SC",
        "Hiragino Sans GB",
        "WenQuanYi Micro Hei",
    ];
    let preferred_has_known_cjk_coverage = cjk_families
        .iter()
        .any(|family| family.eq_ignore_ascii_case(preferred))
        || preferred.to_lowercase().contains("cjk")
        || preferred.to_lowercase().contains("source han");

    let mut candidates = Vec::new();
    if !preferred.is_empty()
        && preferred != "system"
        && (!contains_cjk || preferred_has_known_cjk_coverage)
    {
        candidates.push(preferred);
    }
    if contains_cjk {
        candidates.extend(cjk_families);
    }
    if !contains_cjk && (preferred.is_empty() || preferred == "system") {
        candidates.extend(["Segoe UI", "Arial", "Roboto", "DejaVu Sans"]);
    }

    let find_family = |family: &str| {
        database.faces().find(|face| {
            face.families
                .iter()
                .any(|(name, _)| name.eq_ignore_ascii_case(family))
        })
    };
    let face = candidates
        .iter()
        .find_map(|family| find_family(family))
        .or_else(|| {
            contains_cjk
                .then(|| {
                    database.faces().find(|face| {
                        face.families.iter().any(|(name, _)| {
                            let lower = name.to_lowercase();
                            lower.contains("cjk")
                                || lower.contains("chinese")
                                || lower.contains("yahei")
                                || lower.contains("simsun")
                        })
                    })
                })
                .flatten()
        })
        .or_else(|| {
            (!contains_cjk)
                .then(|| database.faces().next())
                .flatten()
        })
        .ok_or_else(|| {
            if contains_cjk {
                "系统中没有覆盖中文的字体，请先安装思源宋体、Noto CJK 或微软雅黑".to_string()
            } else {
                "系统中没有可用于 PDF 的字体".to_string()
            }
        })?;

    let id = face.id;
    let family = face
        .families
        .first()
        .map(|(name, _)| name.clone())
        .unwrap_or_else(|| "LeafMark Export".to_string());
    let postscript_name = face.post_script_name.clone();
    let bytes = database
        .with_face_data(id, |data, _| data.to_vec())
        .ok_or_else(|| format!("无法读取系统字体：{family}"))?;
    let metadata = ExportFontMetadata {
        family,
        postscript_name,
        collection: bytes.starts_with(b"ttcf"),
    };
    let metadata = serde_json::to_vec(&metadata).map_err(|error| error.to_string())?;
    let metadata_len =
        u32::try_from(metadata.len()).map_err(|_| "字体元数据过大".to_string())?;
    let mut payload = Vec::with_capacity(4 + metadata.len() + bytes.len());
    payload.extend_from_slice(&metadata_len.to_le_bytes());
    payload.extend_from_slice(&metadata);
    payload.extend_from_slice(&bytes);
    Ok(payload)
}

fn load_database() -> fontdb::Database {
    let mut database = fontdb::Database::new();
    #[cfg(target_os = "android")]
    {
        database.load_fonts_dir("/system/fonts");
        database.load_fonts_dir("/product/fonts");
    }
    #[cfg(not(target_os = "android"))]
    database.load_system_fonts();
    database
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
