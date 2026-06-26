package com.sparkp2p.app;

import android.app.Activity;
import android.os.Bundle;
import android.os.Message;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

// Visible WebView where the merchant logs into Binance (normal web login: email/phone + password +
// 2FA, OR "Continue with Google"). Session cookies persist in the app-global CookieManager so the
// headless send WebView in BinanceChatPlugin can reuse them. This is OUR WebView loading Binance's
// website — not the sandboxed native Binance app.
//
// Google sign-in opens a popup window (window.open) and refuses known WebView user-agents, so we:
//   (1) advertise a real (non-"wv") Chrome UA, and
//   (2) support multiple windows + onCreateWindow, hosting the OAuth popup in an overlay WebView
//       that closes itself when Google finishes — returning to the now-logged-in main WebView.
public class BinanceLoginActivity extends Activity {
    private WebView web;
    private FrameLayout container;
    private WebView popup;
    // A real mobile Chrome UA WITHOUT the "; wv)" token, so Google doesn't reject the sign-in.
    private static final String LOGIN_UA =
        "Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);

        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setPadding(24, 24, 24, 24);
        bar.setBackgroundColor(0xFF111827);
        final TextView status = new TextView(this);
        status.setText("Log in to Binance — then tap Done");
        status.setTextColor(0xFFF5A623);
        status.setTextSize(14);
        status.setLayoutParams(new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        Button done = new Button(this);
        done.setText("Done");
        done.setOnClickListener(v -> finishOk());
        bar.addView(status);
        bar.addView(done);
        root.addView(bar, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        container = new FrameLayout(this);
        root.addView(container, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        web = newConfiguredWebView();
        web.setWebViewClient(new WebViewClient() {
            @Override public void onPageFinished(WebView view, String url) {
                CookieManager.getInstance().flush();
                if (url != null && url.contains("p2p.binance.com")) status.setText("Logged in — tap Done");
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            // Google OAuth (and Binance) open the sign-in flow as a popup window.
            @Override
            public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, Message resultMsg) {
                popup = newConfiguredWebView();
                popup.setWebViewClient(new WebViewClient());
                popup.setWebChromeClient(new WebChromeClient() {
                    @Override public void onCloseWindow(WebView w) { closePopup(); }
                });
                container.addView(popup, new FrameLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                WebView.WebViewTransport t = (WebView.WebViewTransport) resultMsg.obj;
                t.setWebView(popup);
                resultMsg.sendToTarget();
                return true;
            }
            @Override public void onCloseWindow(WebView w) { if (w == popup) closePopup(); }
        });
        container.addView(web, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        setContentView(root);
        web.loadUrl("https://accounts.binance.com/en/login");
    }

    private WebView newConfiguredWebView() {
        WebView w = new WebView(this);
        WebSettings s = w.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setUserAgentString(LOGIN_UA);
        s.setSupportMultipleWindows(true);
        s.setJavaScriptCanOpenWindowsAutomatically(true);
        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        cm.setAcceptThirdPartyCookies(w, true);
        return w;
    }

    private void closePopup() {
        if (popup != null) {
            CookieManager.getInstance().flush();
            try { container.removeView(popup); } catch (Exception ignored) {}
            popup.destroy();
            popup = null;
        }
    }

    private void finishOk() {
        CookieManager.getInstance().flush();
        setResult(Activity.RESULT_OK);
        finish();
    }

    @Override public void onBackPressed() {
        if (popup != null) { closePopup(); return; }   // back closes the OAuth popup, not the activity
        finishOk();
    }

    @Override protected void onDestroy() {
        closePopup();
        if (web != null) {
            try { ((ViewGroup) web.getParent()).removeView(web); } catch (Exception ignored) {}
            web.destroy();
        }
        super.onDestroy();
    }
}
