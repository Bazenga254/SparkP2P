package com.sparkp2p.app;

import android.content.pm.PackageManager;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

// Bridge for the SMS-OTP reader: request the RECEIVE_SMS permission and report whether it's granted.
// The actual reading/forwarding is done by SmsReceiver (a manifest-registered broadcast receiver),
// so OTP SMS are caught and posted to the backend even when the app is in the background.
@CapacitorPlugin(name = "ChoiceSms")
public class ChoiceSmsPlugin extends Plugin {

    @PluginMethod
    public void requestPermission(PluginCall call) {
        try {
            if (getActivity() != null) {
                getActivity().requestPermissions(
                        new String[]{"android.permission.RECEIVE_SMS", "android.permission.READ_SMS"}, 9912);
            }
        } catch (Exception ignored) {}
        call.resolve();
    }

    @PluginMethod
    public void status(PluginCall call) {
        boolean granted = ContextCompat.checkSelfPermission(
                getContext(), "android.permission.RECEIVE_SMS") == PackageManager.PERMISSION_GRANTED;
        JSObject r = new JSObject();
        r.put("granted", granted);
        call.resolve(r);
    }
}
