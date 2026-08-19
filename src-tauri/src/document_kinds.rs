use std::path::Path;

pub const MARKDOWN_EXTENSIONS: &[&str] = &["md", "markdown", "mdx"];
pub const WORD_EXTENSIONS: &[&str] = &["docx", "doc", "rtf"];
pub const SPREADSHEET_EXTENSIONS: &[&str] = &["xlsx", "xls", "xlsb", "ods", "csv"];
pub const PRESENTATION_EXTENSIONS: &[&str] = &["pptx", "ppt", "odp"];
pub const PDF_EXTENSIONS: &[&str] = &["pdf"];
pub const CODE_EXTENSIONS: &[&str] = &[
    "ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts",
    "json", "jsonc", "json5",
    "html", "htm", "xhtml",
    "css", "scss", "sass", "less",
    "vue", "svelte", "astro",
    "py", "pyi", "pyw",
    "go", "mod", "sum",
    "rs",
    "java",
    "kt", "kts",
    "c", "h", "cpp", "cxx", "cc", "hpp", "hxx", "hh", "mm", "m",
    "cs",
    "php", "phtml",
    "rb", "erb",
    "swift",
    "dart",
    "lua",
    "sh", "bash", "zsh", "fish", "ksh", "ps1", "psm1", "psd1", "bat", "cmd",
    "sql",
    "yaml", "yml",
    "toml",
    "xml", "xsd", "xsl", "xslt", "svg", "plist",
    "ini", "conf", "cfg", "cnf", "env", "properties", "props",
    "gradle", "groovy",
    "proto", "protobuf",
    "graphql", "gql",
    "cmake", "mk", "mak",
    "txt", "text", "log",
    "gitignore", "gitattributes", "gitmodules", "editorconfig", "npmrc", "nvmrc",
    "prettierrc", "eslintrc", "babelrc",
    "lock",
    "tf", "hcl",
    "r",
    "scala", "sc",
    "ex", "exs",
    "hs",
    "erl", "hrl",
    "clj", "cljs",
    "lisp", "el",
    "vim",
    "wat",
    "diff", "patch",
    "ipynb",
    "dockerfile",
];
pub const CODE_FILENAMES: &[&str] = &[
    "dockerfile",
    "makefile",
    "gnumakefile",
    "cmakelists.txt",
    "gemfile",
    "rakefile",
    "procfile",
    "vagrantfile",
    "justfile",
    "podfile",
    "brewfile",
];

/// File extension used for kind / highlight lookup.
///
/// Rust's `Path::extension()` is `None` when the only `.` is a leading one
/// (`.gitignore`, `.env`, `.editorconfig`). Treat that remainder as the
/// extension so those Unix-hidden names match `CODE_EXTENSIONS`.
fn normalized_extension(path: &Path) -> Option<String> {
    if let Some(ext) = path
        .extension()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
    {
        return Some(ext.to_ascii_lowercase());
    }

    let name = path.file_name()?.to_str()?;
    let rest = name.strip_prefix('.')?;
    if rest.is_empty() || rest.contains('.') {
        return None;
    }
    Some(rest.to_ascii_lowercase())
}

pub fn document_kind(path: &Path) -> Option<&'static str> {
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if CODE_FILENAMES.contains(&file_name.as_str()) {
        return Some("code");
    }
    let extension = normalized_extension(path)?;
    if MARKDOWN_EXTENSIONS.contains(&extension.as_str()) {
        Some("markdown")
    } else if WORD_EXTENSIONS.contains(&extension.as_str()) {
        Some("word")
    } else if SPREADSHEET_EXTENSIONS.contains(&extension.as_str()) {
        Some("spreadsheet")
    } else if PRESENTATION_EXTENSIONS.contains(&extension.as_str()) {
        Some("presentation")
    } else if PDF_EXTENSIONS.contains(&extension.as_str()) {
        Some("pdf")
    } else if CODE_EXTENSIONS.contains(&extension.as_str()) {
        Some("code")
    } else {
        None
    }
}

pub fn is_supported_document(path: &Path) -> bool {
    document_kind(path).is_some()
}

pub fn is_markdown(path: &Path) -> bool {
    document_kind(path) == Some("markdown")
}

pub fn is_code(path: &Path) -> bool {
    document_kind(path) == Some("code")
}

pub fn is_text_document(path: &Path) -> bool {
    is_markdown(path) || is_code(path)
}

pub fn highlight_language(path: &Path) -> &'static str {
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if file_name == "dockerfile" || file_name.ends_with(".dockerfile") {
        return "dockerfile";
    }
    if matches!(file_name.as_str(), "makefile" | "gnumakefile" | "justfile")
        || file_name.ends_with(".mk")
        || file_name.ends_with(".mak")
    {
        return "makefile";
    }
    if file_name == "cmakelists.txt" || file_name.ends_with(".cmake") {
        return "cmake";
    }
    if file_name == "gemfile" || file_name == "rakefile" || file_name == "podfile" {
        return "ruby";
    }
    match normalized_extension(path).unwrap_or_default().as_str() {
        "ts" | "mts" | "cts" | "tsx" => "typescript",
        "js" | "mjs" | "cjs" | "jsx" => "javascript",
        "json" | "jsonc" | "json5" | "ipynb" | "lock" => "json",
        "html" | "htm" | "xhtml" | "vue" | "svelte" | "astro" | "svg" => "xml",
        "xml" | "xsd" | "xsl" | "xslt" | "plist" => "xml",
        "css" => "css",
        "scss" | "sass" => "scss",
        "less" => "less",
        "py" | "pyi" | "pyw" => "python",
        "go" | "mod" | "sum" => "go",
        "rs" => "rust",
        "java" => "java",
        "kt" | "kts" => "kotlin",
        "c" | "h" => "c",
        "cpp" | "cxx" | "cc" | "hpp" | "hxx" | "hh" | "mm" => "cpp",
        "m" => "objectivec",
        "cs" => "csharp",
        "php" | "phtml" => "php",
        "rb" | "erb" => "ruby",
        "swift" => "swift",
        "dart" => "dart",
        "lua" => "lua",
        "sh" | "bash" | "zsh" | "fish" | "ksh" => "bash",
        "ps1" | "psm1" | "psd1" => "powershell",
        "bat" | "cmd" => "dos",
        "sql" => "sql",
        "yaml" | "yml" => "yaml",
        "toml" => "ini",
        "ini" | "conf" | "cfg" | "cnf" | "env" | "properties" | "props" | "editorconfig"
        | "npmrc" | "nvmrc" | "gitignore" | "gitattributes" | "gitmodules" => "ini",
        "gradle" | "groovy" => "groovy",
        "proto" | "protobuf" => "protobuf",
        "graphql" | "gql" => "graphql",
        "cmake" => "cmake",
        "tf" | "hcl" => "bash",
        "r" => "r",
        "scala" | "sc" => "scala",
        "ex" | "exs" => "elixir",
        "hs" => "haskell",
        "erl" | "hrl" => "erlang",
        "clj" | "cljs" | "lisp" | "el" => "lisp",
        "vim" => "vim",
        "wat" => "wasm",
        "diff" | "patch" => "diff",
        "dockerfile" => "dockerfile",
        "prettierrc" | "eslintrc" | "babelrc" => "json",
        _ => "plaintext",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn classifies_markdown_office_and_code() {
        assert_eq!(document_kind(Path::new("notes.md")), Some("markdown"));
        assert_eq!(document_kind(Path::new("deck.pptx")), Some("presentation"));
        assert_eq!(document_kind(Path::new("src/app.ts")), Some("code"));
        assert_eq!(document_kind(Path::new("Dockerfile")), Some("code"));
        assert_eq!(Path::new(".gitignore").extension(), None);
        assert_eq!(document_kind(Path::new(".gitignore")), Some("code"));
        assert_eq!(document_kind(Path::new(".env")), Some("code"));
        assert_eq!(document_kind(Path::new(".editorconfig")), Some("code"));
        assert_eq!(document_kind(Path::new("ignore.bin")), None);
        assert!(is_text_document(Path::new("main.py")));
        assert_eq!(highlight_language(Path::new("App.tsx")), "typescript");
        assert_eq!(highlight_language(Path::new("Makefile")), "makefile");
        assert_eq!(highlight_language(Path::new(".gitignore")), "ini");
    }
}
