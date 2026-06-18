package com.sparkp2p.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.Build;
import android.os.Bundle;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.gms.auth.api.phone.SmsRetriever;
import com.google.android.gms.common.api.CommonStatusCodes;
import com.google.android.gms.common.api.Status;

/**
 * Reads the incoming OTP SMS automatically (Android SMS Retriever API) and forwards the message
 * text to JS, which extracts the 6-digit code and fills the login boxes — no user permission and
 * no consent dialog needed. The OTP SMS must end with this app's 11-char hash.
 */
@CapacitorPlugin(name = "SmsOtp")
public class SmsOtpPlugin extends Plugin {

    private BroadcastReceiver receiver;

    @PluginMethod
    public void start(PluginCall call) {
        try {
            SmsRetriever.getClient(getContext()).startSmsRetriever();
            registerReceiver();
            call.resolve();
        } catch (Exception e) {
            call.reject("SMS retriever failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        unregisterReceiver();
        call.resolve();
    }

    private void registerReceiver() {
        unregisterReceiver();
        receiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                if (!SmsRetriever.SMS_RETRIEVED_ACTION.equals(intent.getAction())) return;
                Bundle extras = intent.getExtras();
                if (extras == null) return;
                Status status = (Status) extras.get(SmsRetriever.EXTRA_STATUS);
                JSObject ret = new JSObject();
                if (status != null && status.getStatusCode() == CommonStatusCodes.SUCCESS) {
                    String message = extras.getString(SmsRetriever.EXTRA_SMS_MESSAGE);
                    ret.put("message", message == null ? "" : message);
                } else {
                    ret.put("timeout", true);
                }
                notifyListeners("sms", ret);
                unregisterReceiver();
            }
        };
        IntentFilter filter = new IntentFilter(SmsRetriever.SMS_RETRIEVED_ACTION);
        if (Build.VERSION.SDK_INT >= 34) {
            getContext().registerReceiver(receiver, filter, SmsRetriever.SEND_PERMISSION, null, Context.RECEIVER_EXPORTED);
        } else {
            getContext().registerReceiver(receiver, filter, SmsRetriever.SEND_PERMISSION, null);
        }
    }

    private void unregisterReceiver() {
        if (receiver != null) {
            try { getContext().unregisterReceiver(receiver); } catch (Exception ignored) {}
            receiver = null;
        }
    }

    @Override
    protected void handleOnDestroy() {
        unregisterReceiver();
        super.handleOnDestroy();
    }
}
