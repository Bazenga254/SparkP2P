package com.sparkp2p.app;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.TextView;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

// Mobile chat-send for browserless trading. Binance has no REST chat API (DOM/WebSocket only), so we
// mirror the desktop: load the order page in OUR WebView (reusing the Binance session the merchant
// logged into via BinanceLoginActivity) and inject JS that types into the chat box and clicks Send.
//
// The send WebView is attached visibly as a brief full-screen overlay so the page actually lays out
// (a detached/headless WebView reports every element as invisible -> chat input never found), and so
// the merchant can see the message being sent. Removed as soon as the send finishes.
@CapacitorPlugin(name = "BinanceChat")
public class BinanceChatPlugin extends Plugin {

    private static final String DESKTOP_UA =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
    private static final String ORDER_URL = "https://p2p.binance.com/en/fiatOrderDetail?orderNo=";
    private static final long RENDER_WAIT_MS = 6000;   // let the chat panel render after page load
    private static final long TYPE_TO_SEND_MS = 800;
    private static final long TIMEOUT_MS = 40000;

    private WebView sender;
    private FrameLayout overlay;
    private PluginCall pending;
    private boolean injected;
    private final Handler ui = new Handler(Looper.getMainLooper());

    @PluginMethod
    public void openLogin(PluginCall call) {
        Activity act = getActivity();
        if (act == null) { call.reject("no activity"); return; }
        act.startActivity(new Intent(act, BinanceLoginActivity.class));
        call.resolve();
    }

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
                attachOverlay();
                ui.postDelayed(() -> finishIfPending("TIMEOUT"), TIMEOUT_MS);
                sender.loadUrl(ORDER_URL + order);
            } catch (Exception e) {
                finishIfPending("ERR:" + e.getMessage());
            }
        });
    }

    private void attachOverlay() {
        Activity act = getActivity();
        ViewGroup content = act.findViewById(android.R.id.content);
        overlay = new FrameLayout(act);
        overlay.setBackgroundColor(0xFF0B0E14);

        TextView hdr = new TextView(act);
        hdr.setText("SparkP2P — sending message…");
        hdr.setTextColor(0xFFF5A623);
        hdr.setTextSize(13);
        hdr.setPadding(28, 36, 28, 16);
        hdr.setGravity(Gravity.CENTER_VERTICAL);
        hdr.setBackgroundColor(0xFF111827);

        sender = new WebView(act);
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
        sender.setBackgroundColor(Color.WHITE);
        sender.setWebViewClient(new WebViewClient() {
            @Override public void onPageFinished(WebView view, String url) {
                if (url == null || !url.contains("fiatOrderDetail")) return;
                if (injected) return;
                injected = true;
                ui.postDelayed(BinanceChatPlugin.this::doType, RENDER_WAIT_MS);
            }
        });

        FrameLayout.LayoutParams hp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        FrameLayout.LayoutParams wp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
        wp.topMargin = 110;
        overlay.addView(sender, wp);
        overlay.addView(hdr, hp);
        content.addView(overlay, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    private void detachOverlay() {
        if (overlay != null) {
            try { ((ViewGroup) overlay.getParent()).removeView(overlay); } catch (Exception ignored) {}
        }
        if (sender != null) { try { sender.destroy(); } catch (Exception ignored) {} sender = null; }
        overlay = null;
    }

    private void doType() {
        if (pending == null || sender == null) return;
        String msg = pending.getString("message", "");
        sender.evaluateJavascript(TYPE_JS + "(" + JSONObject.quote(msg) + ")", typeResult -> {
            String tr = unquote(typeResult);
            if (tr.startsWith("NOINPUT")) { finishIfPending(tr); return; }
            ui.postDelayed(() -> doSend(tr), TYPE_TO_SEND_MS);
        });
    }

    private void doSend(String typeResult) {
        if (pending == null || sender == null) return;
        sender.evaluateJavascript(SEND_JS + "()", sendResult ->
            finishIfPending("typed=" + typeResult + " send=" + unquote(sendResult)));
    }

    private void finishIfPending(String result) {
        PluginCall c = pending;
        pending = null;
        detachOverlay();
        if (c == null) return;
        boolean ok = result != null && (result.contains("SENT") || result.contains("ENTER"));
        JSObject r = new JSObject();
        r.put("ok", ok);
        r.put("detail", result);
        c.resolve(r);
    }

    private static String unquote(String s) {
        if (s == null || s.equals("null")) return "";
        if (s.length() >= 2 && s.startsWith("\"") && s.endsWith("\"")) s = s.substring(1, s.length() - 1);
        return s.replace("\\\"", "\"").replace("\\\\", "\\").replace("\\n", " ");
    }

    // ── Ported chat-send DOM logic from desktop/app.js. On no input, returns rich diagnostics. ──
    private static final String TYPE_JS =
        "(function(msg){try{" +
        "function find(){var sels=['textarea[placeholder*=\"message\" i]','textarea[placeholder*=\"enter\" i]','input[placeholder*=\"message\" i]','textarea'];" +
        "for(var i=0;i<sels.length;i++){var c=document.querySelectorAll(sels[i]);for(var j=0;j<c.length;j++){var el=c[j];if(el.offsetParent!==null&&!el.disabled&&!el.readOnly)return{el:el,ce:false};}}" +
        "var eds=document.querySelectorAll('div[contenteditable=\"true\"]');for(var k=0;k<eds.length;k++){if(eds[k].offsetParent!==null)return{el:eds[k],ce:true};}return null;}" +
        "var f=find();" +
        "if(!f){return 'NOINPUT url='+location.href.slice(0,90)+' title='+document.title.slice(0,40)+' ta='+document.querySelectorAll('textarea').length+' inp='+document.querySelectorAll('input').length+' ce='+document.querySelectorAll('[contenteditable=\"true\"]').length+' if='+document.querySelectorAll('iframe').length;}" +
        "var input=f.el;input.focus();" +
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
