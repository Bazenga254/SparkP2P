package com.sparkp2p.app;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;

// Capacitor bridge for the native relay. JS calls SparkRelay.start({apiBase, token}); the loop
// runs in RelayService (a foreground service) so it survives backgrounding/Doze.
// Place at: android/app/src/main/java/com/sparkp2p/app/SparkRelayPlugin.java
// Register in MainActivity.onCreate: registerPlugin(SparkRelayPlugin.class);
@CapacitorPlugin(name = "SparkRelay")
public class SparkRelayPlugin extends Plugin {

    @PluginMethod
    public void start(PluginCall call) {
        String apiBase = call.getString("apiBase", "https://sparkp2p.com/api");
        String token = call.getString("token");
        if (token == null || token.isEmpty()) { call.reject("token required"); return; }
        Intent i = new Intent(getContext(), RelayService.class);
        i.setAction(RelayService.ACTION_START);
        i.putExtra("apiBase", apiBase);
        i.putExtra("token", token);
        if (Build.VERSION.SDK_INT >= 26) getContext().startForegroundService(i);
        else getContext().startService(i);
        call.resolve();
    }

    @PluginMethod
    public void updateToken(PluginCall call) {
        String t = call.getString("token");
        if (t != null) RelayService.token = t;
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        Intent i = new Intent(getContext(), RelayService.class);
        i.setAction(RelayService.ACTION_STOP);
        getContext().startService(i);
        call.resolve();
    }

    @PluginMethod
    public void requestBatteryExemption(PluginCall call) {
        try {
            PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
            if (pm != null && !pm.isIgnoringBatteryOptimizations(getContext().getPackageName())) {
                Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
                i.setData(Uri.parse("package:" + getContext().getPackageName()));
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(i);
            }
        } catch (Exception ignored) {}
        call.resolve();
    }

    @PluginMethod
    public void status(PluginCall call) {
        JSObject r = new JSObject();
        r.put("running", RelayService.running);
        r.put("lastPoll", RelayService.lastPoll);
        r.put("jobs", RelayService.jobs);
        call.resolve(r);
    }
}
