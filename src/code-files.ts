import type { DocumentKind } from "./types";

export const MARKDOWN_EXTENSIONS = ["md", "markdown", "mdx"] as const;
export const CODE_EXTENSIONS = [
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
] as const;

export const CODE_FILENAMES = [
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
] as const;

export const OFFICE_AND_PDF_EXTENSIONS = [
  "docx", "doc", "rtf",
  "xlsx", "xls", "xlsb", "ods", "csv",
  "pptx", "ppt", "odp",
  "pdf",
] as const;

export const IMPORT_DOCUMENT_EXTENSIONS = [
  ...MARKDOWN_EXTENSIONS,
  ...OFFICE_AND_PDF_EXTENSIONS,
  ...CODE_EXTENSIONS,
] as const;

const CODE_EXTENSION_SET = new Set<string>(CODE_EXTENSIONS);
const MARKDOWN_EXTENSION_SET = new Set<string>(MARKDOWN_EXTENSIONS);
const CODE_FILENAME_SET = new Set<string>(CODE_FILENAMES);

export function isTextKind(kind: string | undefined): kind is "markdown" | "code" {
  return kind === "markdown" || kind === "code";
}

export function fileNameFromPath(path: string) {
  return path.replaceAll("\\", "/").split("/").at(-1) ?? path;
}

export function extensionFromPath(path: string) {
  const name = fileNameFromPath(path);
  const index = name.lastIndexOf(".");
  return index >= 0 ? name.slice(index + 1).toLocaleLowerCase() : "";
}

export function documentKindFromPath(path: string): DocumentKind | null {
  const name = fileNameFromPath(path).toLocaleLowerCase();
  if (CODE_FILENAME_SET.has(name)) return "code";
  const extension = extensionFromPath(path);
  if (MARKDOWN_EXTENSION_SET.has(extension)) return "markdown";
  if (extension === "docx" || extension === "doc" || extension === "rtf") return "word";
  if (extension === "xlsx" || extension === "xls" || extension === "xlsb" || extension === "ods" || extension === "csv") return "spreadsheet";
  if (extension === "pptx" || extension === "ppt" || extension === "odp") return "presentation";
  if (extension === "pdf") return "pdf";
  if (CODE_EXTENSION_SET.has(extension)) return "code";
  return null;
}

export function highlightLanguageFromPath(path: string) {
  const name = fileNameFromPath(path).toLocaleLowerCase();
  if (name === "dockerfile" || name.endsWith(".dockerfile")) return "dockerfile";
  if (name === "makefile" || name === "gnumakefile" || name === "justfile") return "makefile";
  if (name === "cmakelists.txt") return "cmake";
  if (name === "gemfile" || name === "rakefile" || name === "podfile") return "ruby";
  switch (extensionFromPath(path)) {
    case "ts":
    case "mts":
    case "cts":
    case "tsx":
      return "typescript";
    case "js":
    case "mjs":
    case "cjs":
    case "jsx":
      return "javascript";
    case "json":
    case "jsonc":
    case "json5":
    case "ipynb":
    case "lock":
    case "prettierrc":
    case "eslintrc":
    case "babelrc":
      return "json";
    case "html":
    case "htm":
    case "xhtml":
    case "vue":
    case "svelte":
    case "astro":
    case "svg":
    case "xml":
    case "xsd":
    case "xsl":
    case "xslt":
    case "plist":
      return "xml";
    case "css":
      return "css";
    case "scss":
    case "sass":
      return "scss";
    case "less":
      return "less";
    case "py":
    case "pyi":
    case "pyw":
      return "python";
    case "go":
    case "mod":
    case "sum":
      return "go";
    case "rs":
      return "rust";
    case "java":
      return "java";
    case "kt":
    case "kts":
      return "kotlin";
    case "c":
    case "h":
      return "c";
    case "cpp":
    case "cxx":
    case "cc":
    case "hpp":
    case "hxx":
    case "hh":
    case "mm":
      return "cpp";
    case "m":
      return "objectivec";
    case "cs":
      return "csharp";
    case "php":
    case "phtml":
      return "php";
    case "rb":
    case "erb":
      return "ruby";
    case "swift":
      return "swift";
    case "dart":
      return "dart";
    case "lua":
      return "lua";
    case "sh":
    case "bash":
    case "zsh":
    case "fish":
    case "ksh":
      return "bash";
    case "ps1":
    case "psm1":
    case "psd1":
      return "powershell";
    case "sql":
      return "sql";
    case "yaml":
    case "yml":
      return "yaml";
    case "toml":
    case "ini":
    case "conf":
    case "cfg":
    case "cnf":
    case "env":
    case "properties":
    case "props":
    case "editorconfig":
    case "npmrc":
    case "nvmrc":
    case "gitignore":
    case "gitattributes":
    case "gitmodules":
      return "ini";
    case "gradle":
    case "groovy":
      return "groovy";
    case "proto":
    case "protobuf":
      return "protobuf";
    case "graphql":
    case "gql":
      return "graphql";
    case "cmake":
      return "cmake";
    case "mk":
    case "mak":
      return "makefile";
    case "r":
      return "r";
    case "scala":
    case "sc":
      return "scala";
    case "ex":
    case "exs":
      return "elixir";
    case "hs":
      return "haskell";
    case "diff":
    case "patch":
      return "diff";
    case "dockerfile":
      return "dockerfile";
    default:
      return "plaintext";
  }
}

export function languageLabel(language: string, path = "") {
  const extension = extensionFromPath(path).toUpperCase();
  if (language === "plaintext") return extension || "TEXT";
  return language.toUpperCase();
}

export function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function renderCodeHtml(source: string, language: string) {
  const lang = language.trim() || "plaintext";
  return `<pre class="code-document"><code class="language-${escapeHtml(lang)}">${escapeHtml(source)}</code></pre>\n`;
}
