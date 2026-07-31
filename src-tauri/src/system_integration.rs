use serde::Serialize;
#[cfg(windows)]
use std::{
    os::windows::process::CommandExt,
    process::{Command, Stdio},
};
use std::{
    ffi::OsStr,
    path::{Path, PathBuf},
};
#[cfg(windows)]
use winreg::{enums::HKEY_CURRENT_USER, RegKey};

const MARKDOWN_EXTENSIONS: [&str; 2] = ["md", "markdown"];
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AssociationStatus {
    pub supported: bool,
    pub registered: bool,
    pub is_default: bool,
    pub message: String,
}

pub(crate) fn markdown_paths_from_args<I, S>(args: I, cwd: &Path) -> Vec<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let mut paths = Vec::new();
    for argument in args {
        let candidate = PathBuf::from(argument.as_ref());
        let candidate = if candidate.is_absolute() {
            candidate
        } else {
            cwd.join(candidate)
        };
        if !is_markdown(&candidate) || !candidate.is_file() {
            continue;
        }
        let Ok(canonical) = candidate.canonicalize() else {
            continue;
        };
        let normalized = canonical.to_string_lossy().into_owned();
        if !paths.contains(&normalized) {
            paths.push(normalized);
        }
    }
    paths
}

#[cfg(windows)]
pub(crate) fn association_status() -> AssociationStatus {
    let registered = reg_query(r"HKCU\Software\RegisteredApplications", Some("LeafMark")).is_some();
    let is_default = reg_query(
        r"HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.md\UserChoice",
        Some("ProgId"),
    )
    .is_some_and(|value| value.eq_ignore_ascii_case("LeafMark.Markdown"));
    AssociationStatus {
        supported: true,
        registered,
        is_default,
        message: if is_default {
            "LeafMark 已是 .md 的默认应用".into()
        } else if registered {
            "LeafMark 已加入“打开方式”，可在 Windows 设置中设为默认".into()
        } else {
            "注册后可在 Windows 设置中将 LeafMark 设为默认".into()
        },
    }
}

#[cfg(target_os = "android")]
pub(crate) fn association_status() -> AssociationStatus {
    AssociationStatus {
        supported: false,
        registered: true,
        is_default: false,
        message: "LeafMark 已注册为 Markdown 打开方式；可在文件管理器或其他应用中选择 LeafMark"
            .into(),
    }
}

#[cfg(not(any(windows, target_os = "android")))]
pub(crate) fn association_status() -> AssociationStatus {
    AssociationStatus {
        supported: false,
        registered: false,
        is_default: false,
        message: "当前平台暂不支持在应用内更改默认 Markdown 打开方式".into(),
    }
}

#[cfg(windows)]
pub(crate) fn configure_markdown_association() -> Result<AssociationStatus, String> {
    let executable = std::env::current_exe().map_err(error_string)?;
    let executable = executable.to_string_lossy();
    let open_command = format!("\"{executable}\" \"%1\"");
    let icon = format!("{executable},0");

    reg_add(
        r"HKCU\Software\Classes\LeafMark.Markdown",
        None,
        "Markdown 文档",
    )?;
    reg_add(
        r"HKCU\Software\Classes\LeafMark.Markdown\DefaultIcon",
        None,
        &icon,
    )?;
    reg_add(
        r"HKCU\Software\Classes\LeafMark.Markdown\shell\open\command",
        None,
        &open_command,
    )?;
    reg_add(
        r"HKCU\Software\Classes\.md\OpenWithProgids",
        Some("LeafMark.Markdown"),
        "",
    )?;
    reg_add(
        r"HKCU\Software\Classes\.markdown\OpenWithProgids",
        Some("LeafMark.Markdown"),
        "",
    )?;
    reg_add(
        r"HKCU\Software\LeafMark\Capabilities",
        Some("ApplicationName"),
        "LeafMark",
    )?;
    reg_add(
        r"HKCU\Software\LeafMark\Capabilities",
        Some("ApplicationDescription"),
        "高性能、本地优先的 Markdown 阅读与写作应用",
    )?;
    reg_add(
        r"HKCU\Software\LeafMark\Capabilities\FileAssociations",
        Some(".md"),
        "LeafMark.Markdown",
    )?;
    reg_add(
        r"HKCU\Software\LeafMark\Capabilities\FileAssociations",
        Some(".markdown"),
        "LeafMark.Markdown",
    )?;
    reg_add(
        r"HKCU\Software\RegisteredApplications",
        Some("LeafMark"),
        r"Software\LeafMark\Capabilities",
    )?;

    let targeted = hidden_command("explorer.exe")
        .arg("ms-settings:defaultapps?registeredAppUser=LeafMark")
        .spawn();
    if targeted.is_err() {
        hidden_command("explorer.exe")
            .arg("ms-settings:defaultapps")
            .spawn()
            .map_err(error_string)?;
    }
    Ok(association_status())
}

#[cfg(target_os = "android")]
pub(crate) fn configure_markdown_association() -> Result<AssociationStatus, String> {
    Err("请在 Android 的“打开方式”选择器中选择 LeafMark，并按需设为始终使用".into())
}

#[cfg(not(any(windows, target_os = "android")))]
pub(crate) fn configure_markdown_association() -> Result<AssociationStatus, String> {
    Err("当前平台不支持在应用内配置默认 Markdown 打开方式".into())
}

fn is_markdown(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .is_some_and(|extension| {
            MARKDOWN_EXTENSIONS.contains(&extension.to_ascii_lowercase().as_str())
        })
}

#[cfg(windows)]
fn reg_add(key: &str, value_name: Option<&str>, data: &str) -> Result<(), String> {
    let root = RegKey::predef(HKEY_CURRENT_USER);
    let path = hkcu_subkey_path(key)?;
    let (subkey, _) = root.create_subkey(path).map_err(error_string)?;
    subkey
        .set_value(value_name.unwrap_or_default(), &data)
        .map_err(error_string)
}

#[cfg(windows)]
fn reg_query(key: &str, value_name: Option<&str>) -> Option<String> {
    let root = RegKey::predef(HKEY_CURRENT_USER);
    let path = hkcu_subkey_path(key).ok()?;
    root.open_subkey(path)
        .ok()?
        .get_value(value_name.unwrap_or_default())
        .ok()
}

#[cfg(windows)]
fn hkcu_subkey_path(key: &str) -> Result<&str, String> {
    key.strip_prefix("HKCU\\")
        .ok_or_else(|| format!("仅支持 HKCU 注册表路径：{key}"))
}

#[cfg(windows)]
fn hidden_command(program: &str) -> Command {
    let mut command = Command::new(program);
    command
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command
}

#[cfg(windows)]
fn error_string(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn extracts_only_existing_markdown_paths() {
        let root = std::env::temp_dir().join(format!("leafmark-args-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("open.md"), "# open").unwrap();
        fs::write(root.join("ignore.txt"), "ignore").unwrap();

        let paths =
            markdown_paths_from_args(["leafmark", "open.md", "ignore.txt", "missing.md"], &root);

        assert_eq!(paths.len(), 1);
        assert!(paths[0].ends_with("open.md"));
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(windows)]
    #[test]
    fn validates_hkcu_registry_paths_without_spawning_reg_exe() {
        assert_eq!(
            hkcu_subkey_path(r"HKCU\Software\LeafMark").unwrap(),
            r"Software\LeafMark"
        );
        assert!(hkcu_subkey_path(r"HKLM\Software\LeafMark").is_err());
    }
}
