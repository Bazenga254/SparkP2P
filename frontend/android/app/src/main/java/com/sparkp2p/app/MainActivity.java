package com.sparkp2p.app;

import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    // Native auto-relay: read the logged-in trader's JWT straight from the web app's localStorage
    // (via WebView.evaluateJavascript, which works even when the Capacitor JS bridge / window.Capacitor
    // never injected) and run the relay foreground service ourselves — so the relay works on devices
    // whose WebView fails to inject the bridge. We only start the service while the activity is in the
    // foreground, because Android 14+ forbids starting a foreground service from the background.
    private static final String TAG = "SparkAutoRelay";
    private static final String API_BASE = "https://sparkp2p.com/api";
    private static final long CHECK_EVERY_MS = 15000;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private String lastToken = "";
    private volatile boolean resumed = false;
    private final Runnable watcher = new Runnable() {
        @Override public void run() {
            syncRelayFromLocalStorage();
            handler.postDelayed(this, CHECK_EVERY_MS);
        }
    };

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(SparkRelayPlugin.class);
        registerPlugin(BiometricAuthPlugin.class);
        registerPlugin(SmsOtpPlugin.class);
        super.onCreate(savedInstanceState);
        handler.postDelayed(watcher, 3000);
    }

    @Override
    public void onResume() {
        super.onResume();
        resumed = true;
        handler.postDelayed(this::syncRelayFromLocalStorage, 800);
    }

    @Override
    public void onPause() {
        resumed = false;
        super.onPause();
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        super.onDestroy();
    }

    private void syncRelayFromLocalStorage() {
        try {
            WebView wv = (getBridge() != null) ? getBridge().getWebView() : null;
            if (wv == null) { Log.i(TAG, "no webview yet"); return; }
            String js = "(function(){try{return (localStorage.getItem('token')||'')+'|'+(localStorage.getItem('sparkp2p_relay_on')||'');}catch(e){return '';}})()";
            wv.evaluateJavascript(js, value -> {
                String v = unquote(value);
                int sep = v.indexOf('|');
                String token = sep >= 0 ? v.substring(0, sep) : v;
                String relayFlag = sep >= 0 ? v.substring(sep + 1) : "";
                boolean explicitlyOff = "0".equals(relayFlag);
                boolean haveToken = token != null && !token.isEmpty();
                Log.i(TAG, "check: haveToken=" + haveToken + " off=" + explicitlyOff + " resumed=" + resumed
                        + " running=" + RelayService.running);

                if (haveToken && !explicitlyOff) {
                    boolean needStart = !token.equals(lastToken) || !RelayService.running;
                    if (needStart && resumed) {   // foreground-only start (Android 14+ rule)
                        try {
                            Intent i = new Intent(this, RelayService.class);
                            i.setAction(RelayService.ACTION_START);
                            i.putExtra("apiBase", API_BASE);
                            i.putExtra("token", token);
                            if (Build.VERSION.SDK_INT >= 26) startForegroundService(i);
                            else startService(i);
                            lastToken = token;   // only mark done on a successful start
                            Log.i(TAG, "relay service start requested");
                        } catch (Exception e) {
                            Log.e(TAG, "start failed: " + e.getMessage());
                        }
                    } else if (needStart) {
                        Log.i(TAG, "want start but not foreground — will retry");
                    }
                } else if (!haveToken && RelayService.running) {
                    lastToken = "";
                    Intent i = new Intent(this, RelayService.class);
                    i.setAction(RelayService.ACTION_STOP);
                    try { startService(i); } catch (Exception ignored) {}
                    Log.i(TAG, "logged out — relay stopped");
                }
            });
        } catch (Exception e) {
            Log.e(TAG, "sync error: " + e.getMessage());
        }
    }

    private static String unquote(String s) {
        if (s == null || s.equals("null")) return "";
        if (s.length() >= 2 && s.startsWith("\"") && s.endsWith("\"")) {
            s = s.substring(1, s.length() - 1);
        }
        return s.replace("\\\"", "\"").replace("\\\\", "\\");
    }
}
