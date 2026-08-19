package com.leafmark.desktop

import android.net.Uri
import androidx.core.content.FileProvider

/** Limits shared content URIs to the paths declared in res/xml/file_paths.xml. */
class LeafMarkFileProvider : FileProvider() {
  override fun getType(uri: Uri): String? {
    val extension = uri.lastPathSegment
      ?.substringAfterLast('.', "")
      ?.lowercase()
    return when (extension) {
      "md", "markdown", "mdx" -> "text/markdown"
      "json", "jsonc", "json5" -> "application/json"
      "html", "htm" -> "text/html"
      "css" -> "text/css"
      "js", "mjs", "cjs" -> "application/javascript"
      "xml", "svg" -> "application/xml"
      "pdf" -> "application/pdf"
      "docx" -> "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      "xlsx" -> "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      "pptx" -> "application/vnd.openxmlformats-officedocument.presentationml.presentation"
      "txt", "py", "ts", "tsx", "java", "kt", "go", "rs", "c", "h", "cpp", "cs", "php", "rb",
      "swift", "dart", "lua", "sh", "sql", "yml", "yaml", "toml", "ini", "vue" -> "text/plain"
      else -> super.getType(uri)
    }
  }
}
