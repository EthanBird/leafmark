package com.leafmark.desktop

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

/**
 * Keeps an explicitly user-started Agent turn in Android's foreground class.
 *
 * This service owns only lifecycle, notification and a bounded wake lock. The
 * Agent runtime remains the source of truth and should consume
 * [ACTION_CANCEL_REQUESTED] before calling [complete]. Starting the service
 * must happen while MainActivity is visible; Android 12+ can reject a new
 * foreground service started after the app is already in the background.
 */
class AgentKeepAliveService : Service() {
  private var activeTurnId: String = ""
  private var activePhase: String = DEFAULT_PHASE
  private var startedAtMs: Long = 0L
  private var stoppingTurnId: String = ""
  private var useWakeLock: Boolean = false
  private var wakeLock: PowerManager.WakeLock? = null
  private val mainHandler = Handler(Looper.getMainLooper())
  private val forceStopAfterCancellation = Runnable {
    if (stoppingTurnId.isNotBlank() && stoppingTurnId == activeTurnId) {
      Log.w(TAG, "Agent did not acknowledge cancellation within ${CANCEL_ACK_TIMEOUT_MS}ms")
      stopKeepAlive()
    }
  }
  private val runtimeWatchdog = Runnable {
    val turnId = activeTurnId
    if (turnId.isNotBlank()) {
      Log.w(TAG, "Agent keep-alive reached the one-hour watchdog limit")
      recordCancellation(turnId)
      broadcastCancellation(turnId, "watchdog")
    }
    stopKeepAlive()
  }

  override fun onCreate() {
    super.onCreate()
    createNotificationChannel()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent == null) {
      // START_NOT_STICKY should not normally receive a null restart intent. If
      // it does, do not resurrect a notification without a live WebView job.
      stopKeepAlive()
      return START_NOT_STICKY
    }

    return when (intent.action ?: ACTION_START) {
      ACTION_STOP -> handleCancellationRequest(intent)
      ACTION_COMPLETE -> handleCompletion(intent)
      ACTION_START, ACTION_UPDATE -> handleStartOrUpdate(intent)
      else -> {
        Log.w(TAG, "Ignoring unknown Agent service action: ${intent.action}")
        START_NOT_STICKY
      }
    }
  }

  private fun handleStartOrUpdate(intent: Intent): Int {
    val action = intent.action ?: ACTION_START
    val preferences = preferences()
    val persistedTurnId = preferences.getString(PREF_ACTIVE_TURN, "").orEmpty()
    val requestedTurnId = intent.getStringExtra(EXTRA_TURN_ID)
      .orEmpty()
      .ifBlank { activeTurnId.ifBlank { persistedTurnId } }
    if (requestedTurnId.isBlank()) {
      Log.w(TAG, "Refusing to keep alive an Agent turn without an id")
      stopKeepAlive()
      return START_NOT_STICKY
    }

    val priorTurnId = activeTurnId.ifBlank { persistedTurnId }
    if (action == ACTION_UPDATE && priorTurnId.isNotBlank() && requestedTurnId != priorTurnId) {
      Log.w(TAG, "Ignoring stale Agent phase update for $requestedTurnId; active turn is $priorTurnId")
      return START_NOT_STICKY
    }
    if (action == ACTION_START && priorTurnId.isNotBlank() && requestedTurnId != priorTurnId) {
      // A fresh explicit user action replaces an orphaned service state. A late
      // completion for the old turn is rejected by handleCompletion below.
      mainHandler.removeCallbacks(forceStopAfterCancellation)
      stoppingTurnId = ""
      releaseWakeLock()
    }

    activeTurnId = requestedTurnId
    activePhase = if (stoppingTurnId == activeTurnId) {
      STOPPING_PHASE
    } else {
      sanitizePhase(intent.getStringExtra(EXTRA_PHASE)
        ?: preferences.getString(PREF_ACTIVE_PHASE, DEFAULT_PHASE))
    }
    useWakeLock = if (intent.hasExtra(EXTRA_USE_WAKE_LOCK)) {
      intent.getBooleanExtra(EXTRA_USE_WAKE_LOCK, false)
    } else {
      preferences.getBoolean(PREF_USE_WAKE_LOCK, useWakeLock)
    }

    val now = System.currentTimeMillis()
    val persistedStartedAt = preferences.getLong(PREF_STARTED_AT, 0L)
    val continuingPersistedTurn = requestedTurnId == persistedTurnId
    startedAtMs = when {
      activeTurnId == priorTurnId && startedAtMs in 1L..now -> startedAtMs
      continuingPersistedTurn && persistedStartedAt in 1L..now -> persistedStartedAt
      else -> now
    }
    preferences.edit()
      .putString(PREF_ACTIVE_TURN, activeTurnId)
      .putString(PREF_ACTIVE_PHASE, activePhase)
      .putBoolean(PREF_USE_WAKE_LOCK, useWakeLock)
      .putLong(PREF_STARTED_AT, startedAtMs)
      .apply()

    if (now - startedAtMs >= MAX_RUNTIME_MS) {
      runtimeWatchdog.run()
      return START_NOT_STICKY
    }

    try {
      showForegroundNotification(stoppingTurnId == activeTurnId)
      if (useWakeLock) acquireWakeLock() else releaseWakeLock()
    } catch (error: RuntimeException) {
      Log.e(TAG, "Unable to promote Agent service to foreground", error)
      stopKeepAlive()
      return START_NOT_STICKY
    }

    scheduleRuntimeWatchdog(now)
    return START_NOT_STICKY
  }

  private fun handleCancellationRequest(intent: Intent): Int {
    val turnId = resolvedTurnId(intent)
    if (turnId.isBlank()) {
      stopKeepAlive()
      return START_NOT_STICKY
    }
    if (activeTurnId.isNotBlank() && activeTurnId != turnId) {
      Log.w(TAG, "Ignoring stale cancellation for $turnId; active turn is $activeTurnId")
      return START_NOT_STICKY
    }
    if (activeTurnId.isBlank()) activeTurnId = turnId

    recordCancellation(turnId)
    broadcastCancellation(turnId, "notification")
    activePhase = STOPPING_PHASE
    preferences().edit().putString(PREF_ACTIVE_PHASE, activePhase).apply()
    try {
      showForegroundNotification(stopping = true)
    } catch (error: RuntimeException) {
      Log.e(TAG, "Unable to show Agent cancellation state", error)
      stopKeepAlive()
      return START_NOT_STICKY
    }

    // Repeated taps must not extend the grace period indefinitely.
    if (stoppingTurnId != turnId) {
      mainHandler.removeCallbacks(forceStopAfterCancellation)
      stoppingTurnId = turnId
      mainHandler.postDelayed(forceStopAfterCancellation, CANCEL_ACK_TIMEOUT_MS)
    }
    return START_NOT_STICKY
  }

  private fun handleCompletion(intent: Intent): Int {
    val turnId = resolvedTurnId(intent)
    if (activeTurnId.isNotBlank() && turnId.isNotBlank() && activeTurnId != turnId) {
      Log.w(TAG, "Ignoring stale completion for $turnId; active turn is $activeTurnId")
      return START_NOT_STICKY
    }
    stopKeepAlive()
    return START_NOT_STICKY
  }

  private fun resolvedTurnId(intent: Intent): String = intent.getStringExtra(EXTRA_TURN_ID)
    .orEmpty()
    .ifBlank { activeTurnId.ifBlank { preferences().getString(PREF_ACTIVE_TURN, "").orEmpty() } }

  private fun showForegroundNotification(stopping: Boolean) {
    ServiceCompat.startForeground(
      this,
      NOTIFICATION_ID,
      buildNotification(activeTurnId, activePhase, stopping),
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
      } else {
        0
      },
    )
  }

  private fun scheduleRuntimeWatchdog(now: Long = System.currentTimeMillis()) {
    mainHandler.removeCallbacks(runtimeWatchdog)
    val elapsed = (now - startedAtMs).coerceAtLeast(0L)
    val remaining = (MAX_RUNTIME_MS - elapsed).coerceAtLeast(0L)
    if (remaining == 0L) runtimeWatchdog.run()
    else mainHandler.postDelayed(runtimeWatchdog, remaining)
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onTaskRemoved(rootIntent: Intent?) {
    val turnId = activeTurnId.ifBlank { preferences().getString(PREF_ACTIVE_TURN, "").orEmpty() }
    if (turnId.isNotBlank()) {
      recordCancellation(turnId)
      broadcastCancellation(turnId, "task_removed")
    }
    stopKeepAlive()
    super.onTaskRemoved(rootIntent)
  }

  @androidx.annotation.RequiresApi(35)
  override fun onTimeout(startId: Int, fgsType: Int) {
    Log.w(TAG, "Android foreground-service time limit reached for Agent turn")
    val turnId = activeTurnId
    if (turnId.isNotBlank()) {
      recordCancellation(turnId)
      broadcastCancellation(turnId, "android_timeout")
    }
    stopKeepAlive()
  }

  override fun onDestroy() {
    mainHandler.removeCallbacks(forceStopAfterCancellation)
    mainHandler.removeCallbacks(runtimeWatchdog)
    releaseWakeLock()
    super.onDestroy()
  }

  private fun buildNotification(turnId: String, phase: String, stopping: Boolean): Notification {
    val openIntent = packageManager.getLaunchIntentForPackage(packageName)
      ?: Intent(this, MainActivity::class.java)
    openIntent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    val openPendingIntent = PendingIntent.getActivity(
      this,
      NOTIFICATION_ID,
      openIntent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    val stopPendingIntent = PendingIntent.getService(
      this,
      NOTIFICATION_ID + 1,
      Intent(this, AgentKeepAliveService::class.java)
        .setAction(ACTION_STOP)
        .putExtra(EXTRA_TURN_ID, turnId),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

    val builder = NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(android.R.drawable.stat_sys_upload)
      .setContentTitle(if (stopping) "一叶 Agent 正在停止" else "一叶 Agent 正在工作")
      .setContentText(phase)
      .setContentIntent(openPendingIntent)
      .setCategory(NotificationCompat.CATEGORY_SERVICE)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
      .setOnlyAlertOnce(true)
      .setOngoing(true)
    if (!stopping) {
      builder.addAction(android.R.drawable.ic_menu_close_clear_cancel, "停止", stopPendingIntent)
    }
    return builder.build()
  }

  private fun createNotificationChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val channel = NotificationChannel(
      CHANNEL_ID,
      "Agent 后台任务",
      NotificationManager.IMPORTANCE_LOW,
    ).apply {
      description = "显示仍在运行的 LeafMark Agent 任务"
      setShowBadge(false)
      enableLights(false)
      enableVibration(false)
      setSound(null, null)
      lockscreenVisibility = Notification.VISIBILITY_PRIVATE
    }
    getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
  }

  private fun acquireWakeLock() {
    if (wakeLock?.isHeld == true) return
    try {
      val manager = getSystemService(Context.POWER_SERVICE) as PowerManager
      wakeLock = manager.newWakeLock(
        PowerManager.PARTIAL_WAKE_LOCK,
        "$packageName:AgentTurn",
      ).apply {
        setReferenceCounted(false)
        acquire(MAX_WAKE_LOCK_MS)
      }
    } catch (error: RuntimeException) {
      // WAKE_LOCK is optional. The foreground service still improves process
      // priority if a distributor chooses not to declare that permission.
      wakeLock = null
      Log.w(TAG, "Agent wake lock is unavailable", error)
    }
  }

  private fun releaseWakeLock() {
    wakeLock?.let { lock ->
      if (lock.isHeld) {
        try {
          lock.release()
        } catch (error: RuntimeException) {
          Log.w(TAG, "Unable to release Agent wake lock", error)
        }
      }
    }
    wakeLock = null
  }

  private fun recordCancellation(turnId: String) {
    if (turnId.isBlank()) return
    preferences().edit().putBoolean(cancelPreference(turnId), true).apply()
  }

  private fun broadcastCancellation(turnId: String, reason: String) {
    try {
      sendBroadcast(
        Intent(ACTION_CANCEL_REQUESTED)
          .setPackage(packageName)
          .putExtra(EXTRA_TURN_ID, turnId)
          .putExtra(EXTRA_CANCEL_REASON, reason),
      )
    } catch (error: RuntimeException) {
      Log.w(TAG, "Unable to broadcast Agent cancellation", error)
    }
  }

  private fun stopKeepAlive() {
    mainHandler.removeCallbacks(forceStopAfterCancellation)
    mainHandler.removeCallbacks(runtimeWatchdog)
    releaseWakeLock()
    preferences().edit()
      .remove(PREF_ACTIVE_TURN)
      .remove(PREF_ACTIVE_PHASE)
      .remove(PREF_USE_WAKE_LOCK)
      .remove(PREF_STARTED_AT)
      .apply()
    activeTurnId = ""
    activePhase = DEFAULT_PHASE
    startedAtMs = 0L
    stoppingTurnId = ""
    stopForeground(STOP_FOREGROUND_REMOVE)
    stopSelf()
  }

  private fun preferences() = getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)

  companion object {
    const val ACTION_CANCEL_REQUESTED = "com.leafmark.desktop.agent.CANCEL_REQUESTED"
    const val EXTRA_TURN_ID = "turnId"
    const val EXTRA_PHASE = "phase"
    const val EXTRA_USE_WAKE_LOCK = "useWakeLock"
    const val EXTRA_CANCEL_REASON = "reason"

    private const val TAG = "LeafMarkAgentService"
    private const val CHANNEL_ID = "leafmark-agent-running"
    private const val NOTIFICATION_ID = 19021
    private const val PREFERENCES = "leafmark-agent-service"
    private const val PREF_ACTIVE_TURN = "active-turn"
    private const val PREF_ACTIVE_PHASE = "active-phase"
    private const val PREF_USE_WAKE_LOCK = "use-wake-lock"
    private const val PREF_STARTED_AT = "started-at-ms"
    private const val ACTION_START = "com.leafmark.desktop.agent.START"
    private const val ACTION_UPDATE = "com.leafmark.desktop.agent.UPDATE"
    private const val ACTION_STOP = "com.leafmark.desktop.agent.STOP"
    private const val ACTION_COMPLETE = "com.leafmark.desktop.agent.COMPLETE"
    private const val DEFAULT_PHASE = "正在处理请求…"
    private const val STOPPING_PHASE = "正在停止 Agent，请稍候…"
    private const val MAX_PHASE_LENGTH = 96
    private const val MAX_RUNTIME_MS = 60L * 60L * 1000L
    private const val MAX_WAKE_LOCK_MS = MAX_RUNTIME_MS
    private const val CANCEL_ACK_TIMEOUT_MS = 30L * 1000L

    @JvmStatic
    fun start(
      context: Context,
      turnId: String,
      phase: String = DEFAULT_PHASE,
      useWakeLock: Boolean = true,
    ) {
      val intent = Intent(context, AgentKeepAliveService::class.java)
        .setAction(ACTION_START)
        .putExtra(EXTRA_TURN_ID, turnId)
        .putExtra(EXTRA_PHASE, sanitizePhase(phase))
        .putExtra(EXTRA_USE_WAKE_LOCK, useWakeLock)
      ContextCompat.startForegroundService(context.applicationContext, intent)
    }

    @JvmStatic
    fun update(context: Context, turnId: String, phase: String) {
      val intent = Intent(context, AgentKeepAliveService::class.java)
        .setAction(ACTION_UPDATE)
        .putExtra(EXTRA_TURN_ID, turnId)
        .putExtra(EXTRA_PHASE, sanitizePhase(phase))
      context.applicationContext.startService(intent)
    }

    /** Programmatic normal completion; unlike the notification action, no cancel is recorded. */
    @JvmStatic
    fun complete(context: Context, turnId: String) {
      context.applicationContext.startService(
        Intent(context, AgentKeepAliveService::class.java)
          .setAction(ACTION_COMPLETE)
          .putExtra(EXTRA_TURN_ID, turnId),
      )
    }

    /** Used by a future bridge or receiver to acknowledge a notification stop request once. */
    @JvmStatic
    fun consumeCancellation(context: Context, turnId: String): Boolean {
      if (turnId.isBlank()) return false
      val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
      val key = cancelPreference(turnId)
      val requested = preferences.getBoolean(key, false)
      if (requested) preferences.edit().remove(key).apply()
      return requested
    }

    private fun sanitizePhase(value: String?): String = value
      .orEmpty()
      .replace(Regex("\\s+"), " ")
      .trim()
      .ifBlank { DEFAULT_PHASE }
      .take(MAX_PHASE_LENGTH)

    private fun cancelPreference(turnId: String) = "cancel:$turnId"
  }
}
