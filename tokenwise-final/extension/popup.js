// TokenWise Popup Script
import { CONFIG } from './config.js';

// ── STATE ─────────────────────────────────────────────────────────────────────
let currentUser = null;
let authToken = null;
let settings = {};

// ── INIT ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // Version badge
  const manifest = chrome.runtime.getManifest();
  document.getElementById('version-badge').textContent = `v${manifest.version}`;

  // Theme
  const { theme: savedTheme } = await chrome.storage.local.get('theme');
  if (savedTheme === 'dark') document.body.classList.add('dark');

  document.getElementById('theme-btn').addEventListener('click', toggleTheme);

  // Load auth state
  await loadAuthState();
});

async function loadAuthState() {
  show('loading-state');

  // Check background for cached auth
  const res = await sendMessage({ type: 'GET_AUTH' });
  if (res?.user && res?.token) {
    currentUser = res.user;
    authToken = res.token;

    // Verify token is still valid
    const valid = await verifyToken(authToken);
    if (valid) {
      await showApp();
      return;
    } else {
      // Token expired
      await sendMessage({ type: 'CLEAR_AUTH' });
    }
  }

  // Not logged in — check if we have local-only data
  hide('loading-state');
  show('auth-state');
  setupAuthListeners();
}

async function verifyToken(token) {
  try {
    const res = await fetch(`${CONFIG.SUPABASE_URL}/auth/v1/user`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'apikey': CONFIG.SUPABASE_ANON_KEY,
      }
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ── AUTH ──────────────────────────────────────────────────────────────────────
function setupAuthListeners() {
  document.getElementById('btn-login').addEventListener('click', handleLogin);
  document.getElementById('btn-signup').addEventListener('click', handleSignup);
  document.getElementById('btn-reset').addEventListener('click', handleReset);
  document.getElementById('show-signup').addEventListener('click', () => switchAuth('signup'));
  document.getElementById('show-login').addEventListener('click', () => switchAuth('login'));
  document.getElementById('show-reset').addEventListener('click', () => switchAuth('reset'));
  document.getElementById('back-to-login').addEventListener('click', () => switchAuth('login'));

  // Enter key submits
  document.getElementById('login-password').addEventListener('keydown', e => {
    if (e.key === 'Enter') handleLogin();
  });
  document.getElementById('signup-password').addEventListener('keydown', e => {
    if (e.key === 'Enter') handleSignup();
  });
}

function switchAuth(view) {
  hide('auth-login');
  hide('auth-signup');
  hide('auth-reset');
  show(`auth-${view}`);
  clearErrors();
}

async function handleLogin() {
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  const errEl = document.getElementById('auth-error');

  if (!email || !password) { showError(errEl, 'Please fill in all fields.'); return; }

  const btn = document.getElementById('btn-login');
  btn.disabled = true;
  btn.textContent = 'Signing in…';

  try {
    const res = await fetch(`${CONFIG.SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': CONFIG.SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ email, password }),
    });

    const data = await res.json();
    if (!res.ok) { showError(errEl, data.error_description || data.message || 'Invalid credentials'); return; }

    authToken = data.access_token;
    currentUser = data.user;

    await sendMessage({ type: 'SET_AUTH', token: authToken, user: currentUser });
    await showApp();
  } catch (err) {
    showError(errEl, 'Network error. Please try again.');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign in';
  }
}

async function handleSignup() {
  const name = document.getElementById('signup-name').value.trim();
  const email = document.getElementById('signup-email').value.trim();
  const password = document.getElementById('signup-password').value;
  const errEl = document.getElementById('signup-error');

  if (!name || !email || !password) { showError(errEl, 'Please fill in all fields.'); return; }
  if (password.length < 8) { showError(errEl, 'Password must be at least 8 characters.'); return; }

  const btn = document.getElementById('btn-signup');
  btn.disabled = true;
  btn.textContent = 'Creating account…';

  try {
    const res = await fetch(`${CONFIG.SUPABASE_URL}/auth/v1/signup`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': CONFIG.SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ email, password, data: { full_name: name } }),
    });

    const data = await res.json();
    if (!res.ok) { showError(errEl, data.error_description || data.message || 'Signup failed'); return; }

    showToast('✓ Account created! Check your email to confirm.');
    switchAuth('login');
    document.getElementById('login-email').value = email;
  } catch (err) {
    showError(errEl, 'Network error. Please try again.');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Create account';
  }
}

async function handleReset() {
  const email = document.getElementById('reset-email').value.trim();
  const errEl = document.getElementById('reset-error');
  if (!email) { showError(errEl, 'Please enter your email.'); return; }

  const btn = document.getElementById('btn-reset');
  btn.disabled = true;
  btn.textContent = 'Sending…';

  try {
    const res = await fetch(`${CONFIG.SUPABASE_URL}/auth/v1/recover`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': CONFIG.SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ email }),
    });

    if (res.ok) {
      showToast('✓ Reset link sent — check your email.');
      switchAuth('login');
    } else {
      const d = await res.json();
      showError(errEl, d.message || 'Request failed');
    }
  } catch {
    showError(errEl, 'Network error.');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Send reset link';
  }
}

// ── APP ───────────────────────────────────────────────────────────────────────
async function showApp() {
  hide('loading-state');
  hide('auth-state');
  show('app-state');

  await loadSettings();
  await loadStats();
  setupAppListeners();
  applySettingsToUI();
}

function setupAppListeners() {
  // Tabs
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(`tab-${tab.dataset.tab}`).classList.add('active');
    });
  });

  // Sign out
  document.getElementById('btn-signout').addEventListener('click', async () => {
    await sendMessage({ type: 'CLEAR_AUTH' });
    currentUser = null;
    authToken = null;
    hide('app-state');
    show('auth-state');
    showToast('Signed out');
  });

  // Open app links
  document.getElementById('btn-open-dashboard').addEventListener('click', () => {
    chrome.tabs.create({ url: CONFIG.APP_URL + '#dashboard' });
  });
  document.getElementById('btn-open-analyzer').addEventListener('click', () => {
    chrome.tabs.create({ url: CONFIG.APP_URL });
  });
  document.getElementById('btn-upgrade').addEventListener('click', () => {
    chrome.tabs.create({ url: CONFIG.APP_URL + '#upgrade' });
  });

  // Site toggles
  ['claude', 'chatgpt', 'gemini'].forEach(site => {
    document.getElementById(`toggle-${site}`).addEventListener('change', saveSettings);
  });

  // Save settings button
  document.getElementById('btn-save-settings').addEventListener('click', saveSettings);
}

async function loadSettings() {
  const res = await sendMessage({ type: 'GET_SETTINGS' });
  settings = res?.settings || {};
}

function applySettingsToUI() {
  // User info
  const email = currentUser?.email || '';
  const name = currentUser?.user_metadata?.full_name || email.split('@')[0];
  document.getElementById('user-name').textContent = name;
  document.getElementById('user-email').textContent = email;
  document.getElementById('user-avatar').textContent = name.charAt(0).toUpperCase();

  // Toggles
  document.getElementById('toggle-claude').checked = settings.showOnClaude !== false;
  document.getElementById('toggle-chatgpt').checked = settings.showOnChatGPT !== false;
  document.getElementById('toggle-gemini').checked = settings.showOnGemini !== false;
  document.getElementById('set-show-widget').checked = settings.showWidget !== false;
  document.getElementById('set-theme').value = settings.theme || 'auto';
  document.getElementById('set-model').value = settings.defaultModel || 'claude-3-sonnet';
  document.getElementById('set-budget').value = settings.budgetAlertThreshold || 5.00;

  // Dot indicators
  document.getElementById('dot-claude').classList.toggle('active', settings.showOnClaude !== false);
  document.getElementById('dot-chatgpt').classList.toggle('active', settings.showOnChatGPT !== false);
  document.getElementById('dot-gemini').classList.toggle('active', settings.showOnGemini !== false);
}

async function saveSettings() {
  const newSettings = {
    showWidget: document.getElementById('set-show-widget').checked,
    showOnClaude: document.getElementById('toggle-claude').checked,
    showOnChatGPT: document.getElementById('toggle-chatgpt').checked,
    showOnGemini: document.getElementById('toggle-gemini').checked,
    theme: document.getElementById('set-theme').value,
    defaultModel: document.getElementById('set-model').value,
    budgetAlertThreshold: parseFloat(document.getElementById('set-budget').value) || 5.00,
  };

  await sendMessage({ type: 'SET_SETTINGS', settings: newSettings });
  settings = newSettings;
  applySettingsToUI();
  showToast('✓ Settings saved');
}

async function loadStats() {
  const res = await sendMessage({ type: 'GET_STATS' });
  const stats = res?.stats;
  if (!stats) return;

  document.getElementById('stat-tokens-today').textContent = formatNum(stats.today.tokens);
  document.getElementById('stat-sessions-today').textContent = `${stats.today.sessions} session${stats.today.sessions !== 1 ? 's' : ''}`;
  document.getElementById('stat-cost-today').textContent = '$' + (stats.today.cost || 0).toFixed(4);
  document.getElementById('stat-tokens-total').textContent = formatNum(stats.total.tokens);
  document.getElementById('stat-cost-total').textContent = '$' + (stats.total.cost || 0).toFixed(4);

  // Pending sync
  if (stats.pendingSync > 0) {
    const el = document.getElementById('pending-badge');
    el.classList.add('show');
    document.getElementById('pending-text').textContent = `${stats.pendingSync} session${stats.pendingSync !== 1 ? 's' : ''} pending sync — sign in to save`;
  }

  // Sync status
  if (!authToken) {
    document.getElementById('sync-dot').classList.add('offline');
    document.getElementById('sync-status').textContent = 'Not synced — sign in to save data';
  }
}

// ── THEME ─────────────────────────────────────────────────────────────────────
function toggleTheme() {
  const isDark = document.body.classList.toggle('dark');
  document.getElementById('theme-btn').textContent = isDark ? '☀️' : '🌙';
  chrome.storage.local.set({ theme: isDark ? 'dark' : 'light' });
}

// ── HELPERS ───────────────────────────────────────────────────────────────────
function sendMessage(msg) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage(msg, res => resolve(res || {}));
  });
}

function show(id) { const el = document.getElementById(id); if (el) el.style.display = ''; }
function hide(id) { const el = document.getElementById(id); if (el) el.style.display = 'none'; }

function showError(el, msg) {
  el.textContent = msg;
  el.style.display = 'block';
}

function clearErrors() {
  document.querySelectorAll('.auth-error').forEach(el => {
    el.style.display = 'none';
    el.textContent = '';
  });
}

function showToast(msg) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2500);
}

function formatNum(n) {
  if (!n) return '0';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return n.toLocaleString();
}
