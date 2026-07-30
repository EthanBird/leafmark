package com.leafmark.desktop

import android.content.Intent
import android.os.Bundle
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    normalizeMarkdownEditIntent(intent)
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  override fun onNewIntent(intent: Intent) {
    normalizeMarkdownEditIntent(intent)
    super.onNewIntent(intent)
  }

  private fun normalizeMarkdownEditIntent(intent: Intent?) {
    if (intent?.action == Intent.ACTION_EDIT) {
      intent.action = Intent.ACTION_VIEW
    }
  }
}
