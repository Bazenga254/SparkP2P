package com.sparkp2p.app;

import android.app.Activity;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

// Visible WebView where the merchant logs into Binance (normal web login: phone/email + password +
// 2FA). The session cookies persist in the app-global CookieManager, so the headless send WebView in
// BinanceChatPlugin can reuse them. This is OUR WebView loading Binance's website — not the sandboxed
// native Binance app. Closed by the user once they reach the logged-in P2P area (a banner appears).
public class BinanceLoginActivity extends Activity {
    private WebView web;
    // Mobile UA for login (easier to use on a phone screen). Cookies are UA-agnostic, so the send
    // WebView can still use a desktop UA to match the desktop chat selectors.
    private static final String LOGIN_UA =
        "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);

        // Top bar: status text + Done button
        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setPadding(24, 24, 24, 24);
        bar.setBackgroundColor(0xFF111827);
        final TextView status = new TextView(this);
        status.setText("Log in to Binance — then tap Done");
        status.setTextColor(0xFFF5A623);
        status.setTextSize(14);
        LinearLayout.LayoutParams tlp = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        status.setLayoutParams(tlp);
        Button done = new Button(this);
        done.setText("Done");
        done.setOnClickListener(v -> finishOk());
        bar.addView(status);
        bar.addView(done);
        root.addView(bar, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setUserAgentString(LOGIN_UA);
        s.setDatabaseEnabled(true);

        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        cm.setAcceptThirdPartyCookies(web, true);

        web.setWebChromeClient(new WebChromeClient());
        web.setWebViewClient(new WebViewClient() {
            @Override public void onPageFinished(WebView view, String url) {
                CookieManager.getInstance().flush();
                // Once the user lands in the logged-in P2P area, nudge them they can finish.
                if (url != null && url.contains("p2p.binance.com")) {
                    status.setText("Logged in — tap Done to finish");
                }
            }
        });
        root.addView(web, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        setContentView(root);
        web.loadUrl("https://accounts.binance.com/en/login");
    }

    private void finishOk() {
        CookieManager.getInstance().flush();
        setResult(Activity.RESULT_OK);
        finish();
    }

    @Override public void onBackPressed() { finishOk(); }

    @Override protected void onDestroy() {
        if (web != null) {
            try { ((ViewGroup) web.getParent()).removeView(web); } catch (Exception ignored) {}
            web.destroy();
        }
        super.onDestroy();
    }
}
