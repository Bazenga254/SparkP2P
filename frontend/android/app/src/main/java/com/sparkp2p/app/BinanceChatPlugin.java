package com.sparkp2p.app;

import android.app.Activity;
import android.content.Intent;
import android.os.Handler;
import android.os.Looper;
import android.webkit.CookieManager;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

// Mobile chat-send for browserless trading. Binance has no REST chat API (DOM/WebSocket only), so we
// mirror the desktop: load the order page in OUR WebView (reusing the Binance session the merchant
// logged into via BinanceLoginActivity) and inject JS that types into the chat box and clicks Send.
//   SparkRelay (RelayService) handles the HMAC API actions; this plugin handles chat.
@CapacitorPlugin(name = "BinanceChat")
public class BinanceChatPlugin extends Plugin {

    // Desktop UA so Binance serves the desktop P2P layout the ported selectors expect.
    private static final String DESKTOP_UA =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
    private static final String ORDER_URL = "https://p2p.binance.com/en/fiatOrderDetail?orderNo=";
    private static final long RENDER_WAIT_MS = 4500;   // let the chat panel render after page load
    private static final long TYPE_TO_SEND_MS = 700;   // mirror desktop's type→send gap
    private static final long TIMEOUT_MS = 35000;

    private WebView sender;                 // headless, reused across sends
    private PluginCall pending;
    private boolean injected;
    private final Handler ui = new Handler(Looper.getMainLooper());

    // ── openLogin: visible Binance web login; cookies persist app-globally ──────────
    @PluginMethod
    public void openLogin(PluginCall call) {
        Activity act = getActivity();
        if (act == null) { call.reject("no activity"); return; }
        Intent i = new Intent(act, BinanceLoginActivity.class);
        act.startActivity(i);
        call.resolve();
    }

    // ── status: is there a Binance session cookie? (heuristic: p20t present) ─────────
    @PluginMethod
    public void status(PluginCall call) {
        String c = CookieManager.getInstance().getCookie("https://p2p.binance.com");
        String w = CookieManager.getInstance().getCookie("https://www.binance.com");
        boolean loggedIn = (c != null && c.contains("p20t=")) || (w != null && w.contains("p20t="));
        JSObject r = new JSObject();
        r.put("loggedIn", loggedIn);
        call.resolve(r);
    }

    @PluginMethod
    public void logout(PluginCall call) {
        CookieManager cm = CookieManager.getInstance();
        cm.removeAllCookies(null);
        cm.flush();
        call.resolve();
    }

    // ── sendMessage({orderNumber, message}) ─────────────────────────────────────────
    @PluginMethod
    public void sendMessage(PluginCall call) {
        final String order = call.getString("orderNumber", "");
        final String msg = call.getString("message", "");
        if (order.isEmpty() || msg.isEmpty()) { call.reject("orderNumber and message required"); return; }
        if (pending != null) { call.reject("busy: another send in progress"); return; }
        pending = call;
        injected = false;

        ui.post(() -> {
            try {
                ensureWebView();
                final String url = ORDER_URL + order;
                ui.postDelayed(() -> finishIfPending("TIMEOUT"), TIMEOUT_MS);
                sender.loadUrl(url);
            } catch (Exception e) {
                finishIfPending("ERR:" + e.getMessage());
            }
        });
    }

    private void ensureWebView() {
        if (sender != null) return;
        sender = new WebView(getContext());
        WebSettings s = sender.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setUserAgentString(DESKTOP_UA);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        cm.setAcceptThirdPartyCookies(sender, true);
        sender.setWebViewClient(new WebViewClient() {
            @Override public void onPageFinished(WebView view, String url) {
                if (url == null || !url.contains("fiatOrderDetail")) return;   // ignore redirects/login bounces
                if (injected) return;
                injected = true;
                ui.postDelayed(BinanceChatPlugin.this::doType, RENDER_WAIT_MS);
            }
        });
    }

    private void doType() {
        if (pending == null) return;
        String msg = pending.getString("message", "");
        sender.evaluateJavascript(TYPE_JS + "(" + jsonStr(msg) + ")", typeResult ->
            ui.postDelayed(() -> doSend(typeResult), TYPE_TO_SEND_MS));
    }

    private void doSend(String typeResult) {
        if (pending == null) return;
        String tr = unquote(typeResult);
        if ("NO_INPUT".equals(tr)) { finishIfPending("NO_INPUT"); return; }
        sender.evaluateJavascript(SEND_JS + "()", sendResult ->
            finishIfPending("typed=" + tr + " send=" + unquote(sendResult)));
    }

    private void finishIfPending(String result) {
        PluginCall c = pending;
        pending = null;
        if (c == null) return;
        boolean ok = result != null && (result.contains("SENT") || result.contains("ENTER"));
        JSObject r = new JSObject();
        r.put("ok", ok);
        r.put("detail", result);
        c.resolve(r);
    }

    // JSON-encode a string into a JS literal (safe for direct injection).
    private static String jsonStr(String s) { return JSONObject.quote(s); }
    private static String unquote(String s) {
        if (s == null || s.equals("null")) return "";
        if (s.length() >= 2 && s.startsWith("\"") && s.endsWith("\"")) s = s.substring(1, s.length() - 1);
        return s.replace("\\\"", "\"").replace("\\\\", "\\");
    }

    // ── Ported chat-send DOM logic from desktop/app.js (sendChatMessage) ─────────────
    private static final String TYPE_JS =
        "(function(msg){try{" +
        "function find(){var sels=['textarea[placeholder*=\"message\" i]','textarea[placeholder*=\"enter\" i]','input[placeholder*=\"message\" i]','textarea'];" +
        "for(var i=0;i<sels.length;i++){var c=document.querySelectorAll(sels[i]);for(var j=0;j<c.length;j++){var el=c[j];if(el.offsetParent!==null&&!el.disabled&&!el.readOnly)return{el:el,ce:false};}}" +
        "var eds=document.querySelectorAll('div[contenteditable=\"true\"]');for(var k=0;k<eds.length;k++){if(eds[k].offsetParent!==null)return{el:eds[k],ce:true};}return null;}" +
        "var f=find();if(!f)return 'NO_INPUT';var input=f.el;input.focus();" +
        "if(f.ce){input.textContent='';input.dispatchEvent(new Event('input',{bubbles:true}));document.execCommand('insertText',false,msg);input.dispatchEvent(new InputEvent('input',{bubbles:true,data:msg}));}" +
        "else{var proto=input.tagName==='TEXTAREA'?window.HTMLTextAreaElement.prototype:window.HTMLInputElement.prototype;var d=Object.getOwnPropertyDescriptor(proto,'value');var set=d&&d.set;if(set)set.call(input,msg);else input.value=msg;input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));}" +
        "return 'TYPED';}catch(e){return 'ERR:'+(e&&e.message?e.message:e);}})";

    private static final String SEND_JS =
        "(function(){try{" +
        "var sels=['textarea[placeholder*=\"message\" i]','textarea[placeholder*=\"enter\" i]','input[placeholder*=\"message\" i]','textarea','div[contenteditable=\"true\"]'];" +
        "var input=null;for(var i=0;i<sels.length;i++){var c=document.querySelectorAll(sels[i]);for(var j=0;j<c.length;j++){if(c[j].offsetParent!==null&&!c[j].disabled){input=c[j];break;}}if(input)break;}" +
        "var container=input?input.parentElement:document.body;" +
        "for(var n=0;n<8&&container;n++){var btns=container.querySelectorAll('button[type=\"submit\"], button:not([disabled])');for(var b=0;b<btns.length;b++){if(btns[b].offsetParent!==null){btns[b].click();return 'SENT';}}container=container.parentElement;}" +
        "var all=document.querySelectorAll('button[type=\"submit\"]');for(var a=0;a<all.length;a++){if(all[a].offsetParent!==null){all[a].click();return 'SENT';}}" +
        "if(input){input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true}));return 'ENTER';}return 'NO_BTN';}catch(e){return 'ERR:'+(e&&e.message?e.message:e);}})";
}
