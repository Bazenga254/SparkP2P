const API_BASE = 'https://sparkp2p.com/api';

// DOM references
const loginView = document.getElementById('login-view');
const mainView = document.getElementById('main-view');
const noBinanceWarning = document.getElementById('no-binance-warning');
const pollerTitle = document.getElementById('poller-title');
const pollerSubtitle = document.getElementById('poller-subtitle');
const pollerToggleBtn = document.getElementById('poller-toggle-btn');
const binanceDot = document.getElementById('binance-dot');
const binanceStatus = document.getElementById('binance-status');
const vpsDot = document.getElementById('vps-dot');
const vpsStatus = document.getElementById('vps-status');
const ordersCount = document.getElementById('orders-count');
const actionsCount = document.getElementById('actions-count');
const lastPollTime = document.getElementById('last-poll-time');
const actionMsg = document.getElementById('action-msg');
const loginMsg = document.getElementById('login-msg');

// ── Init ──────────────────────────────────────────────────

async function init() {
  const { sparkp2p_token } = await chrome.storage.local.get('sparkp2p_token');
  if (sparkp2p_token) {
    showMainView();
    refreshStatus();
  } else {
    showLoginView();
  }
}

function showLoginView() {
  loginView.classList.remove('hidden');
  mainView.classList.add('hidden');
}

function showMainView() {
  loginView.classList.add('hidden');
  mainView.classList.remove('hidden');
}

// ── Login ─────────────────────────────────────────────────

document.getElementById('login-btn').addEventListener('click', async () => {
  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;

  if (!email || !password) {
    showMsg(loginMsg, 'Enter email and password', 'error');
    return;
  }

  const btn = document.getElementById('login-btn');
  btn.disabled = true;
  btn.textContent = 'Logging in...';

  try {
    const res = await fetch(`${API_BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });

    const data = await res.json();

    if (!res.ok) {
      showMsg(loginMsg, data.detail || 'Login failed', 'error');
      btn.disabled = false;
      btn.textContent = 'Login to SparkP2P';
      return;
    }

    await chrome.storage.local.set({
      sparkp2p_token: data.access_token,
      sparkp2p_user: data.full_name,
    });

    showMainView();
    refreshStatus();
    showMsg(actionMsg, `Welcome, ${data.full_name}!`, 'success');
  } catch (err) {
    showMsg(loginMsg, 'Connection failed: ' + err.message, 'error');
  }

  btn.disabled = false;
  btn.textContent = 'Login to SparkP2P';
});

// ── Poller toggle ─────────────────────────────────────────

pollerToggleBtn.addEventListener('click', async () => {
  const { poller_running } = await chrome.storage.local.get('poller_running');

  if (poller_running) {
    // Stop
    chrome.runtime.sendMessage({ type: 'STOP_POLLER' }, (resp) => {
      updatePollerUI(false);
      showMsg(actionMsg, 'Poller stopped', 'error');
    });
  } else {
    // Start
    chrome.runtime.sendMessage({ type: 'START_POLLER' }, (resp) => {
      if (resp?.started) {
        updatePollerUI(true);
        showMsg(actionMsg, 'Poller started — monitoring Binance orders', 'success');
      } else {
        showMsg(actionMsg, 'Could not start poller. Make sure you are logged in.', 'error');
      }
    });
  }
});

function updatePollerUI(running) {
  if (running) {
    pollerTitle.textContent = 'Poller: Running';
    pollerSubtitle.textContent = 'Polling Binance every ~10 seconds';
    pollerToggleBtn.textContent = 'Stop';
    pollerToggleBtn.className = 'poller-btn btn-stop';
  } else {
    pollerTitle.textContent = 'Poller: Stopped';
    pollerSubtitle.textContent = 'Not polling Binance';
    pollerToggleBtn.textContent = 'Start';
    pollerToggleBtn.className = 'poller-btn btn-success';
  }
}

// ── Refresh status ────────────────────────────────────────

document.getElementById('check-btn').addEventListener('click', refreshStatus);

async function refreshStatus() {
  try {
    // Get status from background
    chrome.runtime.sendMessage({ type: 'GET_STATUS' }, async (status) => {
      if (!status) {
        updatePollerUI(false);
        return;
      }

      // Poller state
      updatePollerUI(status.poller_running);

      // Binance tab
      if (status.binance_tab_found) {
        binanceDot.className = 'dot green';
        binanceStatus.textContent = 'Active';
        noBinanceWarning.classList.add('hidden');
      } else {
        binanceDot.className = 'dot red';
        binanceStatus.textContent = 'No Tab';
        noBinanceWarning.classList.remove('hidden');
      }

      // Stats
      ordersCount.textContent = status.stats?.orders_tracked || 0;
      actionsCount.textContent = status.stats?.actions_executed || 0;
      document.getElementById('stat-polls').textContent = status.stats?.polls || 0;
      document.getElementById('stat-errors').textContent = status.stats?.errors || 0;
      document.getElementById('stat-last-error').textContent = status.stats?.last_error || 'None';

      // Last poll time
      if (status.last_poll) {
        lastPollTime.textContent = formatTimeAgo(status.last_poll);
      }
    });

    // Check VPS connection
    const { sparkp2p_token } = await chrome.storage.local.get('sparkp2p_token');
    if (sparkp2p_token) {
      try {
        const res = await fetch(`${API_BASE}/traders/me`, {
          headers: { 'Authorization': `Bearer ${sparkp2p_token}` },
        });
        if (res.ok) {
          const data = await res.json();
          vpsDot.className = 'dot green';
          vpsStatus.textContent = data.full_name ? 'Connected' : 'OK';
        } else {
          vpsDot.className = 'dot red';
          vpsStatus.textContent = 'Auth Error';
        }
      } catch (e) {
        vpsDot.className = 'dot red';
        vpsStatus.textContent = 'Offline';
      }
    }
  } catch (err) {
    console.error('[SparkP2P Popup] Status refresh error:', err);
  }
}

// ── Open Binance tab ──────────────────────────────────────

document.getElementById('open-binance-btn').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'OPEN_BINANCE_TAB' });
  showMsg(actionMsg, 'Opening Binance P2P...', 'success');
  // Re-check after a moment
  setTimeout(refreshStatus, 2000);
});

// ── Sync cookies ──────────────────────────────────────────

document.getElementById('sync-btn').addEventListener('click', async () => {
  const btn = document.getElementById('sync-btn');
  btn.disabled = true;
  btn.textContent = 'Syncing...';

  chrome.runtime.sendMessage({ type: 'FORCE_SYNC' }, (resp) => {
    if (resp?.done) {
      showMsg(actionMsg, 'Cookies synced to VPS', 'success');
    } else {
      showMsg(actionMsg, 'Sync failed', 'error');
    }
    btn.disabled = false;
    btn.textContent = 'Sync Cookies to VPS';
  });
});

// ── Logout ────────────────────────────────────────────────

document.getElementById('logout-btn').addEventListener('click', async () => {
  // Stop poller first
  chrome.runtime.sendMessage({ type: 'STOP_POLLER' });
  await chrome.storage.local.remove([
    'sparkp2p_token', 'sparkp2p_user', 'last_sync',
    'poller_running', 'last_poll', 'last_heartbeat', 'poll_stats',
  ]);
  showLoginView();
});

// ── Helpers ───────────────────────────────────────────────

function formatTimeAgo(isoTime) {
  const date = new Date(isoTime);
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);

  if (seconds < 10) return 'Just now';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

function showMsg(el, text, type) {
  el.innerHTML = `<div class="msg ${type}">${text}</div>`;
  setTimeout(() => { el.innerHTML = ''; }, 6000);
}

// ── Auto-refresh every 5 seconds while popup is open ─────

setInterval(refreshStatus, 5000);

// ── Init ─────────────────────────────────────────────────

init();
