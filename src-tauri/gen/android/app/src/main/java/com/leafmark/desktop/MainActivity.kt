package com.leafmark.desktop

import android.content.ClipData
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.view.WindowCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    setIntent(normalizeMarkdownIntent(intent))
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  override fun onNewIntent(intent: Intent) {
    val normalized = normalizeMarkdownIntent(intent)
    setIntent(normalized)
    super.onNewIntent(normalized)
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    webView.addJavascriptInterface(LeafMarkAndroidBridge(), "LeafMarkAndroid")
    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        webView.evaluateJavascript(
          "typeof window.__LEAFMARK_ANDROID_BACK__ === 'function' && Boolean(window.__LEAFMARK_ANDROID_BACK__())",
        ) { handled ->
          if (handled == "true") return@evaluateJavascript
          isEnabled = false
          onBackPressedDispatcher.onBackPressed()
          isEnabled = true
        }
      }
    })
  }

  private inner class LeafMarkAndroidBridge {
    @JavascriptInterface
    fun setDarkMode(dark: Boolean) {
      runOnUiThread {
        val controller = WindowCompat.getInsetsController(window, window.decorView)
        controller.isAppearanceLightStatusBars = !dark
        controller.isAppearanceLightNavigationBars = !dark
      }
    }
  }

  private fun normalizeMarkdownIntent(source: Intent?): Intent {
    val intent = source ?: Intent()
    if (intent.action == Intent.ACTION_EDIT) {
      intent.action = Intent.ACTION_VIEW
    }

    val streams = sharedStreams(intent)
    if (streams.isNotEmpty()) {
      if (intent.clipData == null) {
        val clip = ClipData.newUri(contentResolver, "Markdown document", streams.first())
        streams.drop(1).forEach { clip.addItem(ClipData.Item(it)) }
        intent.clipData = clip
      }
      intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      // Chat apps often attach a caption in EXTRA_TEXT. Tauri treats a text/plain
      // caption as a second document, so discard it when a real file is present.
      intent.removeExtra(Intent.EXTRA_TEXT)
    }
    return intent
  }

  @Suppress("DEPRECATION")
  private fun sharedStreams(intent: Intent): List<Uri> {
    if (intent.action != Intent.ACTION_SEND && intent.action != Intent.ACTION_SEND_MULTIPLE) {
      return emptyList()
    }
    val streams = mutableListOf<Uri>()
    intent.clipData?.let { clip ->
      for (index in 0 until clip.itemCount) {
        clip.getItemAt(index).uri?.let(streams::add)
      }
    }
    if (intent.action == Intent.ACTION_SEND) {
      intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)?.let(streams::add)
    } else {
      intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)
        ?.filterNotNull()
        ?.let(streams::addAll)
    }
    return streams.distinct()
  }
}
