package com.sparkp2p.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import kotlinx.coroutines.*
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * Native SparkP2P relay. Mirrors desktop/app.js → startRelayAgent, but runs in a foreground
 * service with a wake lock so it survives backgrounding/Doze (no WebView throttling):
 *   long-poll GET {apiBase}/ext/relay/poll  →  execute the pre-signed job against api.binance.com
 *   from the phone's IP (OkHttp, no CORS)    →  POST {apiBase}/ext/relay/result {job_id, body}
 *
 * Placement: android/app/src/main/java/com/sparkp2p/app/RelayService.kt
 * Manifest (inside <application>):
 *   <service android:name=".RelayService" android:exported="false"
 *            android:foregroundServiceType="dataSync" />
 * Gradle (app/build.gradle dependencies): implementation("com.squareup.okhttp3:okhttp:4.12.0")
 */
class RelayService : Service() {

    companion object {
        const val ACTION_START = "com.sparkp2p.app.START"
        const val ACTION_STOP = "com.sparkp2p.app.STOP"
        private const val CH = "sparkp2p_relay"
        private const val NOTIF = 1001
        @Volatile var running = false
        @Volatile var lastPoll = 0L
        @Volatile var jobs = 0
        @Volatile var token = ""
        @Volatile var apiBase = "https://sparkp2p.com/api"
    }

    private val BINANCE = "https://api.binance.com"
    private val JSONT = "application/json".toMediaType()
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private var loopJob: Job? = null
    private var wake: PowerManager.WakeLock? = null
    private val http = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(40, TimeUnit.SECONDS)
        .writeTimeout(20, TimeUnit.SECONDS)
        .build()

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopLoop()
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }
        intent?.getStringExtra("apiBase")?.let { apiBase = it }
        intent?.getStringExtra("token")?.let { token = it }
        startForeground(NOTIF, buildNotification())
        startLoop()
        return START_STICKY   // OS restarts us if killed
    }

    private fun buildNotification(): Notification {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= 26) {
            nm.createNotificationChannel(NotificationChannel(CH, "SparkP2P relay", NotificationManager.IMPORTANCE_LOW))
        }
        return NotificationCompat.Builder(this, CH)
            .setContentTitle("SparkP2P relay")
            .setContentText("Keeping your trading relay online")
            .setSmallIcon(applicationInfo.icon)
            .setOngoing(true)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build()
    }

    private fun startLoop() {
        if (running) return
        running = true
        wake = (getSystemService(Context.POWER_SERVICE) as PowerManager)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "sparkp2p:relay")
            .also { it.setReferenceCounted(false); it.acquire() }
        loopJob = scope.launch {
            while (isActive && running) {
                try { tick() } catch (e: Exception) { delay(2000) }
            }
        }
    }

    private fun stopLoop() {
        running = false
        loopJob?.cancel()
        wake?.let { if (it.isHeld) it.release() }
        wake = null
    }

    private suspend fun tick() {
        val tk = token
        if (tk.isEmpty()) { delay(3000); return }

        // 1) long-poll for a job
        val pollReq = Request.Builder().url("$apiBase/ext/relay/poll")
            .header("Authorization", "Bearer $tk").get().build()
        val job: JSONObject? = http.newCall(pollReq).execute().use { resp ->
            if (!resp.isSuccessful) null
            else {
                val o = JSONObject(resp.body?.string() ?: "{}")
                if (o.has("job_id")) o else null
            }
        }
        lastPoll = System.currentTimeMillis()
        if (job == null) return                    // no job in the window — re-poll immediately
        jobs++

        // 2) execute against Binance from the phone's IP
        val respBody: Any = try { callBinance(job) } catch (e: Exception) {
            JSONObject().put("code", "RELAY_EXEC_ERROR").put("msg", e.message ?: "error")
        }

        // 3) return the result to the VPS
        val payload = JSONObject().put("job_id", job.getString("job_id")).put("body", respBody)
        val resReq = Request.Builder().url("$apiBase/ext/relay/result")
            .header("Authorization", "Bearer $tk")
            .post(payload.toString().toRequestBody(JSONT)).build()
        try { http.newCall(resReq).execute().close() } catch (_: Exception) {}
    }

    private fun callBinance(job: JSONObject): Any {
        val path = job.getString("path")
        val method = job.optString("method", "POST").uppercase()
        val urlB = (BINANCE + path).toHttpUrlOrNull()!!.newBuilder()
        job.optJSONObject("params")?.let { p ->
            p.keys().forEach { k -> urlB.addQueryParameter(k, p.get(k).toString()) }
        }
        val b = Request.Builder().url(urlB.build())
        job.optJSONObject("headers")?.let { h ->
            h.keys().forEach { k -> if (!k.lowercase().startsWith("x-relay-")) b.header(k, h.getString(k)) }
        }
        val bodyJson = if (job.isNull("body")) null else job.opt("body")?.toString()
        when (method) {
            "GET" -> b.get()
            else -> b.method(method, (bodyJson ?: "").toRequestBody(JSONT))
        }
        http.newCall(b.build()).execute().use { r ->
            val txt = r.body?.string() ?: "null"
            return try { JSONObject(txt) } catch (e: Exception) {
                try { JSONArray(txt) } catch (e2: Exception) { txt }
            }
        }
    }

    override fun onDestroy() {
        stopLoop()
        scope.cancel()
        super.onDestroy()
    }
}
