// Deep-link handler for the native app.
//
// After Google sign-in finishes in the Custom Tab, the backend redirects to
//   com.sparkp2p.app://auth?google_token=...&name=...&id=...&role=...&needs_profile=...
// Android routes that custom scheme back to this app (see the intent-filter in AndroidManifest),
// and @capacitor/app fires `appUrlOpen`. We grab the token, close the browser tab, and drop the
// user onto the dashboard *inside the app* — so the Capacitor bridge (and the relay) are live.
export async function initDeepLinks() {
  const C = window.Capacitor;
  if (!(C && C.isNativePlatform && C.isNativePlatform())) return;

  let App;
  try {
    ({ App } = await import('@capacitor/app'));
  } catch (e) {
    return; // plugin not available
  }

  const closeTab = () => {
    import('@capacitor/browser')
      .then(({ Browser }) => Browser.close().catch(() => {}))
      .catch(() => {});
  };

  const handle = (rawUrl) => {
    if (!rawUrl || rawUrl.indexOf('com.sparkp2p.app://auth') !== 0) return;
    closeTab();
    const p = new URLSearchParams(rawUrl.split('?')[1] || '');
    const err = p.get('error');
    if (err) {
      window.location.href = `/login?error=${encodeURIComponent(err)}`;
      return;
    }
    const token = p.get('google_token');
    if (!token) return;
    if (p.get('needs_profile') === '1') {
      // Google account without a real phone yet → reuse the web profile-completion screen.
      const q = new URLSearchParams({
        google_token: token,
        name: p.get('name') || '',
        id: p.get('id') || '',
        role: p.get('role') || 'trader',
        needs_profile: '1',
      });
      window.location.href = `/login?${q.toString()}`;
    } else {
      localStorage.setItem('token', token);
      if (localStorage.getItem('bio_enabled') === '1') localStorage.setItem('bio_token', token);
      window.location.href = '/dashboard';
    }
  };

  App.addListener('appUrlOpen', (event) => handle(event && event.url));

  // Cold start: the app may have been launched by the deep link itself.
  try {
    const launch = await App.getLaunchUrl();
    if (launch && launch.url) handle(launch.url);
  } catch (e) { /* ignore */ }
}
