package com.sparkp2p.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.telephony.SmsMessage;

import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import org.json.JSONObject;

import java.io.IOException;
import java.util.regex.Pattern;

// Reads incoming SMS and forwards any that carry a numeric code (e.g. Choice Bank transaction OTPs)
// to the backend, which extracts the code and confirms the pending operation. This is the automation
// channel that actually works for Choice (email can't be verified). Sideloaded app, so READ/RECEIVE
// SMS is allowed (no Play Store restriction). Posts from native (with the stored relay JWT) so it
// fires even when the app is backgrounded.
public class SmsReceiver extends BroadcastReceiver {
    private static final OkHttpClient HTTP = new OkHttpClient();
    private static final MediaType JSONT = MediaType.parse("application/json");
    // Any 4–8 digit code — Choice OTPs are 6 digits; broad here, the backend filters precisely.
    private static final Pattern CODE = Pattern.compile("\\b\\d{4,8}\\b");

    @Override
    public void onReceive(Context context, Intent intent) {
        if (!"android.provider.Telephony.SMS_RECEIVED".equals(intent.getAction())) return;
        Bundle bundle = intent.getExtras();
        if (bundle == null) return;
        try {
            Object[] pdus = (Object[]) bundle.get("pdus");
            if (pdus == null) return;
            String format = bundle.getString("format");
            StringBuilder body = new StringBuilder();
            String sender = "";
            for (Object pdu : pdus) {
                SmsMessage sms = SmsMessage.createFromPdu((byte[]) pdu, format);
                if (sms == null) continue;
                if (sender.isEmpty()) sender = sms.getOriginatingAddress();
                body.append(sms.getMessageBody());
            }
            String text = body.toString();
            String snd = sender == null ? "" : sender.toLowerCase();
            // Only forward Choice Bank OTP texts — never the user's other SMS (privacy + noise).
            if (!snd.contains("choice")) return;
            if (text.isEmpty() || !CODE.matcher(text).find()) return;
            relay(context, sender, text);
        } catch (Exception ignored) {}
    }

    private void relay(Context ctx, String sender, String body) {
        SharedPreferences sp = ctx.getSharedPreferences("spark_relay", Context.MODE_PRIVATE);
        String token = sp.getString("token", "");
        String apiBase = sp.getString("apiBase", "https://sparkp2p.com/api");
        if (token == null || token.isEmpty()) return;
        try {
            JSONObject o = new JSONObject()
                    .put("sender", sender == null ? "" : sender)
                    .put("body", body);
            Request req = new Request.Builder()
                    .url(apiBase + "/ext/sms-otp")
                    .header("Authorization", "Bearer " + token)
                    .post(RequestBody.create(JSONT, o.toString()))
                    .build();
            HTTP.newCall(req).enqueue(new Callback() {
                @Override public void onFailure(Call call, IOException e) {}
                @Override public void onResponse(Call call, Response r) { r.close(); }
            });
        } catch (Exception ignored) {}
    }
}
