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
      "md", "markdown" -> "text/markdown"
      else -> super.getType(uri)
    }
  }
}
