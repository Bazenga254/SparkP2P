# Native relay (Kotlin foreground service) — drop-in

These two files make the relay loop run in **native Android code** (a foreground service with a
wake lock) instead of the WebView, so it survives backgrounding/Doze. The web agent
(`src/mobile/relayAgent.js`) auto-detects the `SparkRelay` plugin and prefers it; if it isn't
present it falls back to the WebView loop (foreground-only).

## After `npx cap add android`
1. **Copy the files** into the app package:
   ```
   android/app/src/main/java/com/sparkp2p/app/SparkRelayPlugin.kt
   android/app/src/main/java/com/sparkp2p/app/RelayService.kt
   ```
   (If `appId` differs from `com.sparkp2p.app`, change the `package` line + folder to match.)

2. **Register the plugin** in `MainActivity.kt`:
   ```kotlin
   import com.getcapacitor.BridgeActivity
   import android.os.Bundle
   class MainActivity : BridgeActivity() {
     override fun onCreate(savedInstanceState: Bundle?) {
       registerPlugin(SparkRelayPlugin::class.java)
       super.onCreate(savedInstanceState)
     }
   }
   ```

3. **OkHttp dependency** — `android/app/build.gradle` → `dependencies { ... }`:
   ```gradle
   implementation("com.squareup.okhttp3:okhttp:4.12.0")
   ```

4. **Manifest** — `android/app/src/main/AndroidManifest.xml`:
   ```xml
   <uses-permission android:name="android.permission.INTERNET"/>
   <uses-permission android:name="android.permission.FOREGROUND_SERVICE"/>
   <uses-permission android:name="android.permission.FOREGROUND_SERVICE_DATA_SYNC"/>
   <uses-permission android:name="android.permission.POST_NOTIFICATIONS"/>
   <uses-permission android:name="android.permission.WAKE_LOCK"/>
   <uses-permission android:name="android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS"/>
   <!-- inside <application> -->
   <service android:name=".RelayService" android:exported="false"
            android:foregroundServiceType="dataSync"/>
   ```

5. `npx cap sync android` → run/build in Android Studio.

## How it behaves
- JS `SparkRelay.start({apiBase, token})` starts `RelayService` in the foreground (persistent
  notification) and runs `poll → Binance → result` natively via OkHttp.
- The web agent polls `SparkRelay.status()` every 5s for the banner and pushes a fresh `token`
  (so long-lived relays don't expire).
- `START_STICKY` + wake lock keep it alive; still advise users to disable battery optimisation.
