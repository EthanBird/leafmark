package com.leafmark.desktop

import android.Manifest
import android.content.ClipData
import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.core.view.WindowCompat
import java.io.File
import java.io.FileInputStream
import java.io.FileNotFoundException
import java.io.IOException
import java.io.OutputStream
import org.json.JSONObject

class MainActivity : TauriActivity() {
  private var leafMarkWebView: WebView? = null
  @Volatile private var activityResumed: Boolean = false

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

  override fun onResume() {
    super.onResume()
    activityResumed = true
  }

  override fun onPause() {
    activityResumed = false
    super.onPause()
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    leafMarkWebView = webView
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

    @JavascriptInterface
    fun startAgentKeepAlive(turnId: String, phase: String): String {
      return try {
        requestAgentNotificationPermissionIfNeeded()
        AgentKeepAliveService.start(this@MainActivity, turnId, phase, true)
        ""
      } catch (error: Exception) {
        error.message ?: error.javaClass.simpleName
      }
    }

    @JavascriptInterface
    fun updateAgentKeepAlive(turnId: String, phase: String): String {
      return try {
        AgentKeepAliveService.update(this@MainActivity, turnId, phase)
        ""
      } catch (error: Exception) {
        error.message ?: error.javaClass.simpleName
      }
    }

    @JavascriptInterface
    fun completeAgentKeepAlive(turnId: String): String {
      return try {
        AgentKeepAliveService.complete(this@MainActivity, turnId)
        ""
      } catch (error: Exception) {
        error.message ?: error.javaClass.simpleName
      }
    }

    @JavascriptInterface
    fun consumeAgentCancellation(turnId: String): Boolean {
      return AgentKeepAliveService.consumeCancellation(this@MainActivity, turnId)
    }

    @JavascriptInterface
    fun writePreparedExport(targetUri: String, stagedPath: String, requestId: String) {
      Thread({
        var stagedFile: File? = null
        try {
          stagedFile = validateStagedFile(stagedPath, "export-staging")
          val uri = Uri.parse(targetUri)
          if (uri.scheme != ContentResolver.SCHEME_CONTENT || uri.authority.isNullOrBlank()) {
            throw SecurityException("导出目标不是有效的 Android content URI")
          }
          val expectedBytes = stagedFile.length()
          val writtenBytes = FileInputStream(stagedFile).use { input ->
            openExportOutput(uri).use { output ->
              val copied = input.copyTo(output, DEFAULT_BUFFER_SIZE)
              output.flush()
              copied
            }
          }
          if (writtenBytes != expectedBytes) {
            throw IOException("导出写入不完整：应写入 $expectedBytes 字节，实际 $writtenBytes 字节")
          }
          dispatchExportResult(requestId, "write", true, writtenBytes, null)
        } catch (error: Exception) {
          dispatchExportResult(
            requestId,
            "write",
            false,
            0,
            error.message ?: error.javaClass.simpleName,
          )
        } finally {
          stagedFile?.let { file ->
            file.delete()
            file.parentFile?.delete()
          }
        }
      }, "leafmark-export-writer").start()
    }

    @JavascriptInterface
    fun sharePreparedExport(stagedPath: String, mimeType: String, requestId: String) {
      try {
        val stagedFile = validateStagedFile(stagedPath, "shared-exports")
        val normalizedMime = validateShareMimeType(mimeType)
        val contentUri = FileProvider.getUriForFile(
          this@MainActivity,
          "${BuildConfig.APPLICATION_ID}.fileprovider",
          stagedFile,
        )
        runOnUiThread {
          try {
            val sendIntent = Intent(Intent.ACTION_SEND).apply {
              type = normalizedMime
              putExtra(Intent.EXTRA_STREAM, contentUri)
              putExtra(Intent.EXTRA_TITLE, stagedFile.name)
              clipData = ClipData.newUri(contentResolver, stagedFile.name, contentUri)
              addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            startActivity(Intent.createChooser(sendIntent, "分享 ${stagedFile.name}"))
            dispatchExportResult(requestId, "share", true, stagedFile.length(), null)
          } catch (error: Exception) {
            dispatchExportResult(
              requestId,
              "share",
              false,
              0,
              error.message ?: error.javaClass.simpleName,
            )
          }
        }
      } catch (error: Exception) {
        dispatchExportResult(
          requestId,
          "share",
          false,
          0,
          error.message ?: error.javaClass.simpleName,
        )
      }
    }
  }

  /**
   * Android 13 hides ordinary foreground-service notifications until this
   * runtime permission is granted. Asking is deliberately fire-and-forget: a
   * denial must not prevent the user-started foreground service from running.
   */
  private fun requestAgentNotificationPermissionIfNeeded() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
    if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return

    runOnUiThread {
      if (!activityResumed || isFinishing || isDestroyed) return@runOnUiThread
      if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) {
        return@runOnUiThread
      }
      val preferences = getSharedPreferences(PERMISSION_PREFERENCES, Context.MODE_PRIVATE)
      if (preferences.getBoolean(PREF_NOTIFICATION_PERMISSION_REQUESTED, false)) return@runOnUiThread

      // Persist before showing the platform dialog so Activity recreation does
      // not cause a prompt loop. Users who decline can still enable it later in
      // Android system settings.
      preferences.edit().putBoolean(PREF_NOTIFICATION_PERMISSION_REQUESTED, true).apply()
      ActivityCompat.requestPermissions(
        this,
        arrayOf(Manifest.permission.POST_NOTIFICATIONS),
        REQUEST_NOTIFICATION_PERMISSION,
      )
    }
  }

  private fun validateStagedFile(stagedPath: String, rootName: String): File {
    val root = File(cacheDir, rootName).canonicalFile
    val stagedFile = File(stagedPath).canonicalFile
    val rootPrefix = root.path + File.separator
    if (!stagedFile.path.startsWith(rootPrefix) || !stagedFile.isFile) {
      throw SecurityException("暂存文件无效或超出 LeafMark 私有目录")
    }
    return stagedFile
  }

  private fun validateShareMimeType(mimeType: String): String {
    val normalized = mimeType.trim().lowercase()
    return when (normalized) {
      "text/markdown",
      "text/x-markdown",
      "application/x-markdown",
      "text/plain",
      "text/html",
      "image/png",
      "application/pdf" -> normalized
      else -> throw SecurityException("不支持分享此文件类型：$mimeType")
    }
  }

  private fun openExportOutput(uri: Uri): OutputStream {
    return try {
      contentResolver.openOutputStream(uri, "wt")
        ?: throw IOException("Android 文档提供方没有返回可写入的数据流")
    } catch (firstError: FileNotFoundException) {
      try {
        contentResolver.openOutputStream(uri, "w")
          ?: throw IOException("Android 文档提供方没有返回可写入的数据流")
      } catch (fallbackError: Exception) {
        fallbackError.addSuppressed(firstError)
        throw fallbackError
      }
    } catch (firstError: IllegalArgumentException) {
      try {
        contentResolver.openOutputStream(uri, "w")
          ?: throw IOException("Android 文档提供方没有返回可写入的数据流")
      } catch (fallbackError: Exception) {
        fallbackError.addSuppressed(firstError)
        throw fallbackError
      }
    }
  }

  private fun dispatchExportResult(
    requestId: String,
    operation: String,
    ok: Boolean,
    bytesWritten: Long,
    error: String?,
  ) {
    val detail = JSONObject().apply {
      put("requestId", requestId)
      put("operation", operation)
      put("ok", ok)
      put("bytesWritten", bytesWritten)
      if (error != null) put("error", error)
    }
    val script = "window.dispatchEvent(new CustomEvent('leafmark-android-export-result',{detail:$detail}));"
    runOnUiThread {
      leafMarkWebView?.evaluateJavascript(script, null)
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

  companion object {
    private const val PERMISSION_PREFERENCES = "leafmark-android-permissions"
    private const val PREF_NOTIFICATION_PERMISSION_REQUESTED = "agent-notification-requested"
    private const val REQUEST_NOTIFICATION_PERMISSION = 19022
  }
}
