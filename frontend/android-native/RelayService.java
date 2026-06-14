package com.sparkp2p.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import okhttp3.HttpUrl;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.Iterator;
import java.util.concurrent.TimeUnit;

// Native SparkP2P relay. Mirrors desktop/app.js startRelayAgent, in a foreground service + wake
// lock so it survives backgrounding/Doze:
//   GET {apiBase}/ext/relay/poll  ->  call api.binance.com (from the phone IP, no CORS)  ->
//   POST {apiBase}/ext/relay/result {job_id, body}
// Place at: android/app/src/main/java/com/sparkp2p/app/RelayService.java
public class RelayService extends Service {
    public static final String ACTION_START = "com.sparkp2p.app.START";
    public static final String ACTION_STOP  = "com.sparkp2p.app.STOP";
    private static final String CH = "sparkp2p_relay";
    private static final int NOTIF = 1001;

    public static volatile boolean running = false;
    public static volatile long lastPoll = 0L;
    public static volatile int jobs = 0;
    public static volatile String token = "";
    public static volatile String apiBase = "https://sparkp2p.com/api";

    private static final String BINANCE = "https://api.binance.com";
    private static final MediaType JSONT = MediaType.parse("application/json");
    private Thread loopThread;
    private PowerManager.WakeLock wake;
    private final OkHttpClient http = new OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(40, TimeUnit.SECONDS)
            .writeTimeout(20, TimeUnit.SECONDS)
            .build();

    @Nullable @Override public IBinder onBind(Intent intent) { return null; }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopLoop();
            stopForeground(true);
            stopSelf();
            return START_NOT_STICKY;
        }
        if (intent != null) {
            if (intent.getStringExtra("apiBase") != null) apiBase = intent.getStringExtra("apiBase");
            if (intent.getStringExtra("token") != null) token = intent.getStringExtra("token");
        }
        startForeground(NOTIF, buildNotification());
        startLoop();
        return START_STICKY;
    }

    private Notification buildNotification() {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26 && nm != null) {
            nm.createNotificationChannel(new NotificationChannel(CH, "SparkP2P relay", NotificationManager.IMPORTANCE_LOW));
        }
        return new NotificationCompat.Builder(this, CH)
                .setContentTitle("SparkP2P relay")
                .setContentText("Keeping your trading relay online")
                .setSmallIcon(getApplicationInfo().icon)
                .setOngoing(true)
                .build();
    }

    private void startLoop() {
        if (running) return;
        running = true;
        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        wake = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "sparkp2p:relay");
        wake.setReferenceCounted(false);
        wake.acquire();
        loopThread = new Thread(this::runLoop);
        loopThread.start();
    }

    private void stopLoop() {
        running = false;
        if (loopThread != null) loopThread.interrupt();
        if (wake != null && wake.isHeld()) wake.release();
        wake = null;
    }

    private void runLoop() {
        while (running) {
            try { tick(); } catch (Exception e) { sleep(2000); }
        }
    }

    private void sleep(long ms) { try { Thread.sleep(ms); } catch (InterruptedException ignored) {} }

    private void tick() throws Exception {
        String tk = token;
        if (tk.isEmpty()) { sleep(3000); return; }

        Request pollReq = new Request.Builder().url(apiBase + "/ext/relay/poll")
                .header("Authorization", "Bearer " + tk).get().build();
        JSONObject job = null;
        try (Response resp = http.newCall(pollReq).execute()) {
            if (resp.isSuccessful() && resp.body() != null) {
                JSONObject o = new JSONObject(resp.body().string());
                if (o.has("job_id")) job = o;
            } else { sleep(2000); }
        }
        lastPoll = System.currentTimeMillis();
        if (job == null) return;
        jobs++;

        Object respBody;
        try { respBody = callBinance(job); }
        catch (Exception e) {
            respBody = new JSONObject().put("code", "RELAY_EXEC_ERROR").put("msg", e.getMessage() == null ? "error" : e.getMessage());
        }
        JSONObject payload = new JSONObject().put("job_id", job.getString("job_id")).put("body", respBody);
        Request resReq = new Request.Builder().url(apiBase + "/ext/relay/result")
                .header("Authorization", "Bearer " + tk)
                .post(RequestBody.create(JSONT, payload.toString())).build();
        try (Response r = http.newCall(resReq).execute()) { /* ignore */ }
    }

    private Object callBinance(JSONObject job) throws Exception {
        String path = job.getString("path");
        String method = job.optString("method", "POST").toUpperCase();
        HttpUrl.Builder urlB = HttpUrl.parse(BINANCE + path).newBuilder();
        JSONObject params = job.optJSONObject("params");
        if (params != null) {
            for (Iterator<String> it = params.keys(); it.hasNext();) {
                String k = it.next();
                urlB.addQueryParameter(k, String.valueOf(params.get(k)));
            }
        }
        Request.Builder b = new Request.Builder().url(urlB.build());
        JSONObject headers = job.optJSONObject("headers");
        if (headers != null) {
            for (Iterator<String> it = headers.keys(); it.hasNext();) {
                String k = it.next();
                if (!k.toLowerCase().startsWith("x-relay-")) b.header(k, headers.getString(k));
            }
        }
        String bodyJson = job.isNull("body") || job.opt("body") == null ? null : job.opt("body").toString();
        if ("GET".equals(method)) b.get();
        else b.method(method, RequestBody.create(JSONT, bodyJson == null ? "" : bodyJson));

        try (Response r = http.newCall(b.build()).execute()) {
            String txt = r.body() != null ? r.body().string() : "null";
            try { return new JSONObject(txt); }
            catch (Exception e) { try { return new JSONArray(txt); } catch (Exception e2) { return txt; } }
        }
    }

    @Override public void onDestroy() { stopLoop(); super.onDestroy(); }
}
