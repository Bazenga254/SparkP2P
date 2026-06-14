package com.sparkp2p.app

import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings

/**
 * Capacitor bridge for the native relay. The JS calls SparkRelay.start({apiBase, token}) when the
 * user enables the phone relay; the actual poll→Binance→result loop runs in RelayService (a
 * foreground service) so it survives WebView throttling and app backgrounding.
 *
 * Placement: android/app/src/main/java/com/sparkp2p/app/SparkRelayPlugin.kt
 * Register in MainActivity.onCreate (before super.onCreate): registerPlugin(SparkRelayPlugin::class.java)
 */
@CapacitorPlugin(name = "SparkRelay")
class SparkRelayPlugin : Plugin() {

    @PluginMethod
    fun start(call: PluginCall) {
        val apiBase = call.getString("apiBase") ?: "https://sparkp2p.com/api"
        val token = call.getString("token")
        if (token.isNullOrEmpty()) { call.reject("token required"); return }
        val i = Intent(context, RelayService::class.java).apply {
            action = RelayService.ACTION_START
            putExtra("apiBase", apiBase)
            putExtra("token", token)
        }
        if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(i) else context.startService(i)
        call.resolve()
    }

    @PluginMethod
    fun updateToken(call: PluginCall) {
        call.getString("token")?.let { RelayService.token = it }
        call.resolve()
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        val i = Intent(context, RelayService::class.java).apply { action = RelayService.ACTION_STOP }
        context.startService(i)
        call.resolve()
    }

    @PluginMethod
    fun requestBatteryExemption(call: PluginCall) {
        try {
            val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
            if (!pm.isIgnoringBatteryOptimizations(context.packageName)) {
                val i = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                    data = Uri.parse("package:" + context.packageName)
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                context.startActivity(i)
            }
        } catch (_: Exception) { /* setting unavailable on this device — ignore */ }
        call.resolve()
    }

    @PluginMethod
    fun status(call: PluginCall) {
        val r = JSObject()
        r.put("running", RelayService.running)
        r.put("lastPoll", RelayService.lastPoll)
        r.put("jobs", RelayService.jobs)
        call.resolve(r)
    }
}
