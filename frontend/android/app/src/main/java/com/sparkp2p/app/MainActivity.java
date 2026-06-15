package com.sparkp2p.app;

import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    // Native auto-relay: read the logged-in trader's JWT straight from the web app's localStorage
    // (via WebView.evaluateJavascript, which works even when the Capacitor JS bridge / window.Capacitor
    // never injected) and run the relay foreground service ourselves. This makes the relay independent
    // of the JS bridge, so it works on devices whose WebView fails to inject the bridge.
    private static final String API_BASE = "https://sparkp2p.com/api";
    private static final long CHECK_EVERY_MS = 30000;   // re-read token / on-off flag every 30s

    private final Handler handler = new Handler(Looper.getMainLooper());
    private String lastToken = "";
    private final Runnable watcher = new Runnable() {
        @Override public void run() {
            syncRelayFromLocalStorage();
            handler.postDelayed(this, CHECK_EVERY_MS);
        }
    };

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(SparkRelayPlugin.class);
        super.onCreate(savedInstanceState);
        handler.postDelayed(watcher, 4000);   // let the WebView load first
    }

    @Override
    public void onResume() {
        super.onResume();
        handler.postDelayed(this::syncRelayFromLocalStorage, 800);
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        super.onDestroy();
    }

    private void syncRelayFromLocalStorage() {
        try {
            WebView wv = (getBridge() != null) ? getBridge().getWebView() : null;
            if (wv == null) return;
            // Returns "<token>|<relayFlag>". JWTs are base64url + dots, so '|' is a safe separator.
            String js = "(function(){try{return (localStorage.getItem('token')||'')+'|'+(localStorage.getItem('sparkp2p_relay_on')||'');}catch(e){return '';}})()";
            wv.evaluateJavascript(js, value -> {
                String v = unquote(value);
                int sep = v.indexOf('|');
                String token = sep >= 0 ? v.substring(0, sep) : v;
                String relayFlag = sep >= 0 ? v.substring(sep + 1) : "";
                boolean explicitlyOff = "0".equals(relayFlag);

                if (token != null && !token.isEmpty() && !explicitlyOff) {
                    // Logged in and not turned off → make sure the relay is running with this token.
                    if (!token.equals(lastToken) || !RelayService.running) {
                        lastToken = token;
                        Intent i = new Intent(this, RelayService.class);
                        i.setAction(RelayService.ACTION_START);
                        i.putExtra("apiBase", API_BASE);
                        i.putExtra("token", token);
                        if (Build.VERSION.SDK_INT >= 26) startForegroundService(i);
                        else startService(i);
                    }
                } else if ((token == null || token.isEmpty()) && RelayService.running) {
                    // Logged out → stop the relay.
                    lastToken = "";
                    Intent i = new Intent(this, RelayService.class);
                    i.setAction(RelayService.ACTION_STOP);
                    startService(i);
                }
            });
        } catch (Exception ignored) {}
    }

    // evaluateJavascript hands back a JSON-encoded value ("..." or null). JWT + flag contain no quotes
    // or backslashes, so a light strip/unescape is enough.
    private static String unquote(String s) {
        if (s == null || s.equals("null")) return "";
        if (s.length() >= 2 && s.startsWith("\"") && s.endsWith("\"")) {
            s = s.substring(1, s.length() - 1);
        }
        return s.replace("\\\"", "\"").replace("\\\\", "\\");
    }
}
