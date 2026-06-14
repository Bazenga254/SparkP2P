package com.sparkp2p.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;

// Restarts the relay after a device reboot, IF the user had it enabled. Reads the persisted
// token/apiBase from SharedPreferences (saved by RelayService) so the user never has to reopen
// the app — once on, it survives reboots until they turn it off or uninstall.
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        if (action == null) return;
        if (!action.equals(Intent.ACTION_BOOT_COMPLETED) && !action.equals("android.intent.action.QUICKBOOT_POWERON")) return;

        SharedPreferences sp = context.getSharedPreferences(RelayService.PREFS, Context.MODE_PRIVATE);
        if (!sp.getBoolean("enabled", false)) return;
        String token = sp.getString("token", "");
        if (token == null || token.isEmpty()) return;

        Intent i = new Intent(context, RelayService.class);
        i.setAction(RelayService.ACTION_START);
        i.putExtra("apiBase", sp.getString("apiBase", "https://sparkp2p.com/api"));
        i.putExtra("token", token);
        if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(i);
        else context.startService(i);
    }
}
