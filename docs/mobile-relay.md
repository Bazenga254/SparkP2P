# SparkP2P Mobile App + Phone Relay (Android, Capacitor)

Goal: let traders run the per-trader **relay from their phone** so the bot can trade through
their own IP without a 24/7 desktop. Android-first (true background via a foreground service);
iOS is foreground-limited by Apple and is a later step.

## Why native (not a PWA)
A browser PWA **cannot** be the relay:
1. **CORS** — it must call `api.binance.com` and read the response; browsers block that cross-origin.
2. **No 24/7 background** — a backgrounded tab / service worker is suspended within seconds.
A Capacitor native app fixes both: Binance calls go through **native HTTP** (CapacitorHttp, no CORS),
and a **foreground service** keeps the relay loop alive in the background.

## Architecture (already wired in the web app)
- The native app simply **loads `https://sparkp2p.com`** (see `frontend/capacitor.config.json` →
  `server.url`). So the full app + every future deploy works with zero rebuild.
- The relay logic ships **inside the web app**: `frontend/src/mobile/relayAgent.js`. It is **inert in
  a normal browser** (`isNative()` false) and only activates inside the native wrapper. It mirrors the
  desktop loop: long-poll `GET /api/ext/relay/poll` → execute the pre-signed job against Binance via
  CapacitorHttp → `POST /api/ext/relay/result`.
- `frontend/src/components/MobileRelayBanner.jsx` is a mobile-only toggle ("Run trading relay on this
  phone") shown at the top of the dashboard; it starts/stops the agent + the foreground service.

## One-time build (on a machine with Android Studio + JDK 17)
```bash
cd frontend
npm i -D @capacitor/cli
npm i @capacitor/core @capacitor/android @capawesome/capacitor-android-foreground-service
npx cap add android          # generates the android/ project (uses capacitor.config.json)
npx cap sync android
```
Then in `android/app/src/main/AndroidManifest.xml` add the permissions + service:
```xml
<uses-permission android:name="android.permission.INTERNET"/>
<uses-permission android:name="android.permission.FOREGROUND_SERVICE"/>
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_DATA_SYNC"/>
<uses-permission android:name="android.permission.POST_NOTIFICATIONS"/>
<uses-permission android:name="android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS"/>
<!-- inside <application>: the foreground-service plugin registers its own service;
     verify it appears, with android:foregroundServiceType="dataSync" -->
```
Build / run:
```bash
npx cap open android         # opens Android Studio → Run on a device, or Build > APK/AAB
# or headless:
cd android && ./gradlew assembleRelease
```

## Foreground service / background survival
- The agent calls `ForegroundService.startForegroundService(...)` when the relay is turned on, which
  pins a persistent notification and keeps the process alive.
- Tell users to **disable battery optimisation** for SparkP2P (Settings → Apps → SparkP2P → Battery →
  Unrestricted) — otherwise Android Doze can still pause it. The app should also prompt
  `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` on first relay start.
- Provide a `smallIcon` drawable (the agent references `"splash"`; swap for a proper `ic_stat_*`).

## Verifying the relay
1. Log in on the phone app, flip **Run trading relay on this phone** on.
2. On the VPS, the trader shows **connected** (`relay_router.is_connected` — presence within 70s);
   admin "Online" lights up. Signed Binance actions (ads/update, EP-4/7/19) now route via the phone.
3. The banner shows `● Online` + a served-requests counter.

## Known limits / next steps
- **iOS**: relay runs only while the app is active (Apple background limits). Treat as foreground-only,
  or revisit with VoIP/silent-push nudges.
- **Robustness**: the loop runs in the WebView kept alive by the foreground service. For maximum
  reliability move the poll/execute/result loop into a **native Kotlin service** (hardening step) so
  it survives WebView throttling entirely.
- **Token refresh**: the agent uses the stored `token`; ensure the app refreshes it (the existing
  `/traders/refresh-token` flow) so long-lived relays don't expire.
