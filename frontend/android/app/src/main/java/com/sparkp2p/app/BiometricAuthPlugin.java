package com.sparkp2p.app;

import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import androidx.fragment.app.FragmentActivity;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.concurrent.Executor;

// Fingerprint / face / device-credential unlock via AndroidX BiometricPrompt. Used to lock the app
// on open so a logged-in trader unlocks with biometrics instead of re-entering their password.
@CapacitorPlugin(name = "BiometricAuth")
public class BiometricAuthPlugin extends Plugin {

    private static final int AUTHENTICATORS =
            BiometricManager.Authenticators.BIOMETRIC_WEAK | BiometricManager.Authenticators.DEVICE_CREDENTIAL;

    @PluginMethod
    public void isAvailable(PluginCall call) {
        JSObject r = new JSObject();
        try {
            int res = BiometricManager.from(getContext()).canAuthenticate(AUTHENTICATORS);
            r.put("available", res == BiometricManager.BIOMETRIC_SUCCESS);
        } catch (Exception e) {
            r.put("available", false);
        }
        call.resolve(r);
    }

    @PluginMethod
    public void authenticate(PluginCall call) {
        final String reason = call.getString("reason", "Unlock SparkP2P");
        final FragmentActivity activity = (getActivity() instanceof FragmentActivity) ? (FragmentActivity) getActivity() : null;
        if (activity == null) { call.reject("no activity"); return; }
        activity.runOnUiThread(() -> {
            try {
                Executor exec = ContextCompat.getMainExecutor(getContext());
                BiometricPrompt prompt = new BiometricPrompt(activity, exec, new BiometricPrompt.AuthenticationCallback() {
                    @Override public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                        JSObject r = new JSObject(); r.put("success", true); call.resolve(r);
                    }
                    @Override public void onAuthenticationError(int code, CharSequence err) {
                        JSObject r = new JSObject(); r.put("success", false);
                        r.put("code", code); r.put("error", err == null ? "" : err.toString());
                        call.resolve(r);
                    }
                    @Override public void onAuthenticationFailed() { /* a single attempt failed; prompt stays open */ }
                });
                BiometricPrompt.PromptInfo info = new BiometricPrompt.PromptInfo.Builder()
                        .setTitle("SparkP2P")
                        .setSubtitle(reason)
                        .setAllowedAuthenticators(AUTHENTICATORS)
                        .build();
                prompt.authenticate(info);
            } catch (Exception e) {
                JSObject r = new JSObject(); r.put("success", false); r.put("error", e.getMessage());
                call.resolve(r);
            }
        });
    }
}
