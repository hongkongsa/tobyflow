/**
 * Background Service Worker - Toby Flow v2.0
 * Handles settings window, keyboard shortcuts, sidePanel, and cross-context communication
 */

let settingsWindowId = null;
let workflowWindowId = null;
// 2026-05-28: window đang focus TRƯỚC khi focus grok cho Cloudflare challenge → restore sau khi
// resolved (grok:restoreFocus) để trả focus về popup workflow/sidebar thay vì kẹt ở tab grok.
let _grokFocusReturnWindowId = null;
let editingWorkflowId = null;
let templateWindowId = null;
let anglesWindowId = null;
let effectsWindowId = null;

// Track all extension popup windows for cleanup on extension reload/unload
const _extensionPopupWindows = new Set();

// Phase 3.5 Bug I: API base URL — service worker cannot import window.authManager.
// Default constant + cache from chrome.storage.local (set by sidebar after login).
// Single source of truth so changing backend domain only needs 1 edit + chrome.storage.local update.
const API_BASE_DEFAULT = 'http://localhost:3000/api/v1';
let _apiBaseUrl = API_BASE_DEFAULT;
chrome.storage.local.get(['apiBaseUrl'], (data) => {
  if (data?.apiBaseUrl) _apiBaseUrl = data.apiBaseUrl;
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.apiBaseUrl?.newValue) {
    _apiBaseUrl = changes.apiBaseUrl.newValue;
  }
});
function getApiBaseUrl() { return _apiBaseUrl; }

// ─────────────────────────────────────────────────────────────────────────────
// Anti-clone: detect backend reject 403 { error: { code: 'EXTENSION_NOT_AUTHORIZED' }}
// Backend VerifyExtensionId middleware reject khi runtime.id không nằm trong whitelist.
// Persist flag + broadcast → sidebar/content scripts render clone-detected overlay.
// Self-heal periodic: nếu admin update whitelist → tự clear flag không cần reload.
// ─────────────────────────────────────────────────────────────────────────────
function _isExtensionAuthRejection(body, httpStatus) {
  return httpStatus === 403 && body && body.error && body.error.code === 'EXTENSION_NOT_AUTHORIZED';
}

async function _handleExtensionAuthRejection() {
  try {
    await new Promise(resolve => {
      chrome.storage.local.set({
        tobyflow_extension_not_authorized: {
          at: Date.now(),
          reason: 'whitelist_miss',
          ext_id: chrome.runtime.id,
        },
      }, resolve);
    });
    chrome.runtime.sendMessage({ type: 'EXTENSION_NOT_AUTHORIZED' }).catch(() => {});
    console.error('[Auth] 🛡️ Extension not authorized — clone-detected overlay triggered');
  } catch (e) {
    console.error('[Auth] Failed to set ext-not-authorized flag', e);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Device ban (hard-block per-device). /enroll trả DEVICE_BANNED khi (extension_id,
// device_fingerprint) bị revoke với reason hard-ban (abuse/compromised/manual).
// Khác clone-detected (whitelist extension_id). Set cờ persistent → gate MỌI
// apiRequest/_signedFetch (chặn cứng, kể cả unsigned bypass ở log_only) + broadcast
// overlay. Recovery: re-enroll thành công khi admin restore (reason → revoked_at=null).
// ─────────────────────────────────────────────────────────────────────────────
const DEVICE_BANNED_FLAG = 'tobyflow_device_banned';
let _deviceBanned = false;
try {
  chrome.storage.local.get(DEVICE_BANNED_FLAG, (res) => { _deviceBanned = !!res?.[DEVICE_BANNED_FLAG]; });
} catch (_) {}

async function _handleDeviceBanned(reason) {
  const wasBanned = _deviceBanned;
  _deviceBanned = true;
  try {
    await new Promise(r => chrome.storage.local.set({
      [DEVICE_BANNED_FLAG]: { at: Date.now(), reason: reason || 'banned', ext_id: chrome.runtime.id },
    }, r));
    if (!wasBanned) {
      chrome.runtime.sendMessage({ type: 'DEVICE_BANNED' }).catch(() => {});
      console.error('[Enrollment] 🚫 Device banned — block ALL requests + overlay');
    }
  } catch (_) {}
}

async function _clearDeviceBanned() {
  if (!_deviceBanned) return;
  _deviceBanned = false;
  try {
    await new Promise(r => chrome.storage.local.remove(DEVICE_BANNED_FLAG, r));
    chrome.runtime.sendMessage({ type: 'DEVICE_UNBANNED' }).catch(() => {});
    console.log('[Enrollment] ✅ Device un-banned — access restored');
  } catch (_) {}
}

// Recovery: thử re-enroll khi đang banned (admin có thể đã restore). Chỉ gọi on
// focus/activation/manual — KHÔNG setInterval tight (route /enroll throttle 30/giờ).
async function _deviceBanRecoveryProbe() {
  if (!_deviceBanned) return;
  try { await _ensureEnrollment(true); } catch (_) {}
}

// Self-heal: nếu admin thêm ID vào whitelist (hoặc tắt toggle) sau khi reject → recover tự động.
// Probe endpoint /entitlements (public, light, throttle:60, qua verify.extension_id middleware).
// Toggle OFF → 200 OK → clear flag. Toggle ON + ID mismatch → 403 EXTENSION_NOT_AUTHORIZED.
async function _selfHealProbe() {
  try {
    const stored = await new Promise(resolve =>
      chrome.storage.local.get('tobyflow_extension_not_authorized', resolve));
    if (!stored?.tobyflow_extension_not_authorized) return;

    const apiBase = getApiBaseUrl();
    const r = await _signedFetch(`${apiBase}/entitlements`, {
      method: 'GET',
      headers: { 'X-Extension-Id': chrome.runtime.id, 'Accept': 'application/json' },
      cache: 'no-store',
    });

    // Re-check body marker: 200 OK = recovered, 403 EXTENSION_NOT_AUTHORIZED = still rejected.
    // Treat 404/network as inconclusive (skip update flag) — đợi probe sau.
    if (r.ok) {
      await new Promise(resolve =>
        chrome.storage.local.remove('tobyflow_extension_not_authorized', resolve));
      chrome.runtime.sendMessage({ type: 'EXTENSION_AUTHORIZED' }).catch(() => {});
      console.log('[Auth] ✅ Extension re-authorized — flag cleared');
    } else if (r.status === 403) {
      try {
        const body = await r.clone().json();
        if (body?.error?.code === 'EXTENSION_NOT_AUTHORIZED') {
          console.log('[Auth] 🛡️ Probe still rejected — flag retained');
        }
      } catch (_) {}
    }
  } catch (_) { /* network error — retry next interval */ }
}

// Clear flag + probe ngay khi extension install/update/reload (user reload từ chrome://extensions).
// Probe ngay khi background load (tránh chờ interval đầu).
_selfHealProbe();

// NOTE: onInstalled/onStartup listeners đã được consolidate vào 1 nơi duy nhất
// ở cuối file (sau _prefetchAllConfigs definition) để đảm bảo thứ tự chạy đúng:
// 1. Clear cache → 2. Prefetch configs → 3. Enrollment → 4. Inject scripts
// Xem "=== CONSOLIDATED STARTUP LISTENERS ===" section.

// Periodic probe mỗi 1 phút (giảm từ 5 phút) để recovery nhanh hơn.
setInterval(_selfHealProbe, 60 * 1000);

// Trigger probe khi user focus tab (background tự gọi self-heal khi user thực sự dùng).
try {
  chrome.tabs.onActivated.addListener(() => { _selfHealProbe(); _deviceBanRecoveryProbe(); });
  chrome.windows.onFocusChanged?.addListener?.((id) => {
    if (id !== chrome.windows.WINDOW_ID_NONE) { _selfHealProbe(); _deviceBanRecoveryProbe(); }
  });
} catch (_) {}

// Manual retry từ sidebar/content scripts (button click trong overlay).
// Cùng button retry recover cả clone-detected lẫn device-ban.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'EXTENSION_AUTH_RETRY' || msg?.type === 'DEVICE_BAN_RETRY') {
    Promise.all([_selfHealProbe(), _deviceBanRecoveryProbe()])
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true; // async response
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// HMAC Request Signing (Sprint 2 — EXTENSION_ENROLLMENT_HMAC_PLAN.md)
//
// Mỗi extension instance enroll 1 lần với backend → nhận {client_id, secret}
// → ký mỗi outgoing request với HMAC-SHA256("{ts}:{METHOD}:{path}:{body_sha256}")
// → backend VerifySignature middleware verify (Sprint 1 log_only, Sprint 4 enforce).
//
// Storage keys:
//   toby_client_enrollment — {client_id, secret, expires_at, device_fingerprint}
//   toby_device_fp         — UUID persistent per install
//
// Re-enroll khi: enrollment missing | expires < 1 day | server return 403 revoke codes.
// ─────────────────────────────────────────────────────────────────────────────
const ENROLLMENT_KEY = 'toby_client_enrollment';
const DEVICE_FP_KEY = 'toby_device_fp';
const ENROLLMENT_REFRESH_BEFORE_EXPIRY_MS = 24 * 3600 * 1000; // refresh nếu < 1 ngày trước expire
const SIGNATURE_RETRY_CODES = new Set(['REVOKED_CLIENT', 'EXPIRED_CLIENT', 'INVALID_CLIENT']);

let _cachedEnrollment = null;
let _enrollmentPromise = null; // dedup concurrent enroll attempts

// Load cached enrollment vào memory (warm SW wake-up)
chrome.storage.local.get([ENROLLMENT_KEY], (res) => {
  if (res?.[ENROLLMENT_KEY]) _cachedEnrollment = res[ENROLLMENT_KEY];
});

// Invalidate memory cache khi storage thay đổi (multi-tab consistency)
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[ENROLLMENT_KEY]) {
    _cachedEnrollment = changes[ENROLLMENT_KEY].newValue || null;
  }
});

async function _getOrCreateDeviceFingerprint() {
  const stored = await new Promise(r => chrome.storage.local.get([DEVICE_FP_KEY], r));
  if (stored[DEVICE_FP_KEY]) return stored[DEVICE_FP_KEY];
  const fp = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : Array.from(crypto.getRandomValues(new Uint8Array(16)))
        .map(b => b.toString(16).padStart(2, '0')).join('');
  await new Promise(r => chrome.storage.local.set({ [DEVICE_FP_KEY]: fp }, r));
  return fp;
}

async function _getEnrollment() {
  if (_cachedEnrollment) return _cachedEnrollment;
  const stored = await new Promise(r => chrome.storage.local.get([ENROLLMENT_KEY], r));
  _cachedEnrollment = stored[ENROLLMENT_KEY] || null;
  return _cachedEnrollment;
}

function _isEnrollmentValid(e) {
  if (!e || !e.client_id || !e.secret) return false;
  if (!e.expires_at) return true; // legacy / undefined expiry → treat as valid
  const expiresAt = new Date(e.expires_at).getTime();
  return !isNaN(expiresAt) && expiresAt > Date.now() + ENROLLMENT_REFRESH_BEFORE_EXPIRY_MS;
}

async function _doEnrollment() {
  try {
    const fp = await _getOrCreateDeviceFingerprint();
    const apiBase = getApiBaseUrl();
    const extVersion = chrome.runtime.getManifest()?.version || 'unknown';

    const response = await fetch(`${apiBase}/enroll`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-Extension-Id': chrome.runtime.id,
      },
      body: JSON.stringify({
        device_fingerprint: fp,
        ext_version: extVersion,
      }),
      cache: 'no-store',
    });

    if (!response.ok) {
      // 403 DEVICE_BANNED → log + abort, không retry
      if (response.status === 403) {
        try {
          const body = await response.clone().json();
          if (body?.error?.code === 'DEVICE_BANNED') {
            console.error('[Enrollment] 🚫 Device banned, abort enrollment');
            // Clear any stale enrollment để tránh dùng secret cũ
            await new Promise(r => chrome.storage.local.remove([ENROLLMENT_KEY], r));
            _cachedEnrollment = null;
            // Set cờ persistent → gate mọi request + overlay (chặn cứng, đóng unsigned bypass)
            await _handleDeviceBanned(body?.error?.message || 'banned');
            return null;
          }
          // 403 EXTENSION_NOT_AUTHORIZED (whitelist miss) → bubble up đến anti-clone handler
          if (_isExtensionAuthRejection(body, 403)) {
            _handleExtensionAuthRejection();
            return null;
          }
        } catch (_) {}
      }
      console.warn('[Enrollment] Failed HTTP', response.status);
      return null;
    }

    const json = await response.json();
    if (!json.success || !json.data?.client_id || !json.data?.secret) {
      console.warn('[Enrollment] Invalid response shape', json);
      return null;
    }

    const enrollment = {
      client_id: json.data.client_id,
      secret: json.data.secret,
      expires_at: json.data.expires_at,
      device_fingerprint: fp,
    };

    await new Promise(r => chrome.storage.local.set({ [ENROLLMENT_KEY]: enrollment }, r));
    _cachedEnrollment = enrollment;
    console.log('[Enrollment] ✅ Enrolled successfully:', enrollment.client_id);
    // Re-enroll thành công = device không còn banned (admin đã restore) → gỡ cờ + overlay
    await _clearDeviceBanned();
    return enrollment;
  } catch (e) {
    console.warn('[Enrollment] Network error:', e.message);
    return null;
  }
}

async function _ensureEnrollment(force = false) {
  // Reuse pending attempt nếu đang enroll (chống race khi multiple apiRequest concurrent)
  if (_enrollmentPromise) return _enrollmentPromise;

  if (!force) {
    const existing = await _getEnrollment();
    if (_isEnrollmentValid(existing)) return existing;
  }

  _enrollmentPromise = _doEnrollment();
  try {
    return await _enrollmentPromise;
  } finally {
    _enrollmentPromise = null;
  }
}

async function _sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text || ''));
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Build HMAC signature headers cho outgoing API request.
 * @param {string} method - 'GET', 'POST', ...
 * @param {string} path - URL pathname (vd '/api/v1/entitlements')
 * @param {string} body - request body (JSON string hoặc empty)
 * @returns {Promise<Object>} headers object (rỗng nếu chưa enroll)
 */
async function _buildSignatureHeaders(method, path, body = '') {
  const enrollment = await _getEnrollment();
  if (!enrollment || !enrollment.secret || !enrollment.client_id) return {};

  const timestamp = Math.floor(Date.now() / 1000);
  const bodyHash = await _sha256Hex(body || '');
  const normalizedPath = '/' + String(path || '').replace(/^\/+/, '');
  const message = `${timestamp}:${String(method || 'GET').toUpperCase()}:${normalizedPath}:${bodyHash}`;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(enrollment.secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sigBytes = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  const sig = Array.from(new Uint8Array(sigBytes))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  return {
    'X-Client-Id': enrollment.client_id,
    'X-Timestamp': String(timestamp),
    'X-Signature': sig,
  };
}

async function _clearEnrollment() {
  _cachedEnrollment = null;
  await new Promise(r => chrome.storage.local.remove([ENROLLMENT_KEY], r));
}

/**
 * fetch wrapper inject HMAC signature headers cho direct fetch() calls
 * (ngoài apiRequest handler). Dùng cho _selfHealProbe, _fetchProviderConfigs,
 * _fetchApiConfigs, selector-failure analytics, system-config/execution.
 *
 * Skip auto-sign nếu url là /enroll (chicken-and-egg) hoặc options.body là FormData.
 */
async function _signedFetch(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  const method = (options.method || 'GET').toUpperCase();
  const isEnroll = typeof url === 'string' && /\/enroll(\?|$)/.test(url);
  // Device banned → chặn cứng (trừ /enroll để recovery). Trả 403 synthetic, không gửi request.
  if (_deviceBanned && !isEnroll) {
    return new Response(
      JSON.stringify({ success: false, error: { code: 'DEVICE_BANNED', message: 'Device banned' } }),
      { status: 403, headers: { 'Content-Type': 'application/json' } }
    );
  }
  const bodyIsString = typeof options.body === 'string';
  if (!isEnroll && (!options.body || bodyIsString)) {
    try {
      const pathForSig = new URL(url).pathname;
      const bodyStr = bodyIsString ? options.body : '';
      const sigHeaders = await _buildSignatureHeaders(method, pathForSig, bodyStr);
      Object.assign(headers, sigHeaders);
    } catch (_) { /* signing optional — fail silent in log_only mode */ }
  }
  return fetch(url, { ...options, headers });
}

// Trigger enrollment lúc SW wake (fire-and-forget, nếu enrollment valid sẽ no-op).
// NOTE: onInstalled/onStartup enrollment đã move vào consolidated listeners cuối file.
_ensureEnrollment().catch(() => {});

// Phase 3.5 Bug D: Bootstrap URLs minimized — chỉ giữ keys thực sự được access early-boot.
// Service worker context cannot import PCM. Sidebar push server cache vào chrome.storage.session
// → getProviderUrl() prefers server cache (line 70-90). PROVIDER_URLS = last-resort bootstrap.
// Keys dropped vs prev version: chatgpt.base, gemini.base, grok.saved, grok.base, grok.cdnPatterns.
// Removed keys vẫn available via _serverUrlsCache (sidebar sync) hoặc admin Providers config.
const PROVIDER_URLS = {
  flow: {
    tabQuery: 'https://labs.google/fx/*',
    createUrl: 'https://labs.google/fx/tools/flow',
    localeCreate: 'https://labs.google/fx/vi/tools/flow',
    base: 'https://labs.google/fx',
  },
  chatgpt: {
    tabQuery: '*://chatgpt.com/*',
    createUrl: 'https://chatgpt.com/',
  },
  grok: {
    tabQuery: '*://grok.com/*',
    tabQueryPatterns: ['*://grok.com/*', 'https://x.com/i/grok*'],
    createUrl: 'https://grok.com/',
    imagine: 'https://grok.com/imagine',
  },
  gemini: {
    tabQuery: '*://gemini.google.com/*',
    createUrl: 'https://gemini.google.com/app',
  },
};

// Phase 3: Cache URLs từ server (populated by sidebar qua message 'updateProviderUrlsCache')
let _serverUrlsCache = null;

/**
 * Phase 3: Get provider URL - check server cache first, fallback to bootstrap.
 * @param {string} provider - 'flow' | 'chatgpt' | 'grok' | 'gemini'
 * @param {string} key - 'tabQuery' | 'createUrl' | 'base' | etc.
 * @returns {string|string[]|null}
 */
function getProviderUrl(provider, key) {
  // 1. Server cache (camelCase key)
  if (_serverUrlsCache?.[provider]?.[key]) {
    return _serverUrlsCache[provider][key];
  }
  // 2. Server cache (snake_case key - backend format)
  const snakeKey = key.replace(/([A-Z])/g, '_$1').toLowerCase();
  if (_serverUrlsCache?.[provider]?.[snakeKey]) {
    return _serverUrlsCache[provider][snakeKey];
  }
  // 3. Bootstrap fallback
  return PROVIDER_URLS[provider]?.[key] || null;
}

// Load server URLs cache từ session storage (nếu sidebar đã populate)
chrome.storage?.session?.get(['_provider_urls_cache'], (result) => {
  if (result?._provider_urls_cache) {
    _serverUrlsCache = result._provider_urls_cache;
    console.log('[Background] Loaded server URLs cache from session storage');
  }
});

// Restore window IDs from session storage (survives SW hibernation)
chrome.storage?.session?.get([
  '_settingsWindowId',
  '_workflowWindowId',
  '_editingWorkflowId',
  '_templateWindowId',
  '_anglesWindowId',
  '_effectsWindowId',
], (result) => {
  if (result?._settingsWindowId) {
    settingsWindowId = result._settingsWindowId;
    _extensionPopupWindows.add(result._settingsWindowId);
  }
  if (result?._workflowWindowId) {
    workflowWindowId = result._workflowWindowId;
    _extensionPopupWindows.add(result._workflowWindowId);
  }
  if (result?._editingWorkflowId) {
    editingWorkflowId = result._editingWorkflowId;
  }
  if (result?._templateWindowId) {
    templateWindowId = result._templateWindowId;
    _extensionPopupWindows.add(result._templateWindowId);
  }
  if (result?._anglesWindowId) {
    anglesWindowId = result._anglesWindowId;
    _extensionPopupWindows.add(result._anglesWindowId);
  }
  if (result?._effectsWindowId) {
    effectsWindowId = result._effectsWindowId;
    _extensionPopupWindows.add(result._effectsWindowId);
  }
});

// Lock flag to prevent race condition when opening settings window
let _settingsWindowOpening = false;

/** Persist popup window IDs to session storage (survives SW hibernation) */
function _persistWindowIds() {
  chrome.storage?.session?.set({
    _settingsWindowId: settingsWindowId,
    _workflowWindowId: workflowWindowId,
    _editingWorkflowId: editingWorkflowId,
    _templateWindowId: templateWindowId,
    _anglesWindowId: anglesWindowId,
    _effectsWindowId: effectsWindowId,
  }).catch(() => {});
}

// Close all extension popup windows (called on extension suspend/reload)
async function _closeAllExtensionPopups() {
  const windowIds = [..._extensionPopupWindows];
  for (const windowId of windowIds) {
    try {
      await chrome.windows.remove(windowId);
    } catch (e) {
      // Window may already be closed
    }
  }
  _extensionPopupWindows.clear();
  settingsWindowId = null;
  workflowWindowId = null;
  editingWorkflowId = null;
  templateWindowId = null;
  anglesWindowId = null;
  effectsWindowId = null;
  _persistWindowIds();
}

// Close popup windows when extension is about to be suspended/reloaded
chrome.runtime.onSuspend.addListener(() => {
  console.log('[Background] Extension suspending, closing popup windows...');
  _closeAllExtensionPopups();
});

// Phase 3.5 Bug C.5: Release execution token khi service worker suspend.
// Best-effort fetch với keepalive=true để Chrome cho phép complete request sau khi SW chết.
// Cron `execution:cleanup` (every 10 min) là safety net cho case này fail.
chrome.runtime.onSuspend.addListener(() => {
  try {
    chrome.storage.local.get(['af_running_workflow'], (data) => {
      const execId = data?.af_running_workflow?.execution_id;
      if (!execId) return;
      // keepalive=true: cho phép fetch complete dù SW bị kill
      fetch(`${getApiBaseUrl()}/executions/${execId}/complete`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'X-Extension-Id': chrome.runtime.id,
        },
        body: JSON.stringify({ status: 'stopped', summary: { reason: 'sw_suspend' } }),
        keepalive: true,
        credentials: 'include',
      }).catch(() => { /* best effort - cron cleanup is safety net */ });
      console.log('[Background] onSuspend: released execution token', execId);
    });
  } catch (_) { /* ignore */ }
});

/**
 * Open or activate an existing tab matching the URL pattern
 * @param {string} urlPattern - URL pattern to search for existing tabs (e.g., 'https://chatgpt.com/*')
 * @param {string} createUrl - URL to create if no existing tab found
 * @param {boolean} activate - Whether to activate/focus the tab (default: true)
 * @returns {Promise<chrome.tabs.Tab>} - The existing or newly created tab
 */
async function openOrActivateTab(urlPattern, createUrl, activate = true) {
  try {
    // Search for existing tabs matching the pattern
    const existingTabs = await chrome.tabs.query({ url: urlPattern });

    if (existingTabs.length > 0) {
      // Tab exists - activate it
      const tab = existingTabs[0];
      if (activate) {
        await chrome.tabs.update(tab.id, { active: true });
        await chrome.windows.update(tab.windowId, { focused: true });
      }
      console.log(`[TobyFlow] Activated existing tab: ${tab.url?.substring(0, 50)}`);
      return tab;
    } else {
      // No existing tab - create new one
      const newTab = await chrome.tabs.create({ url: createUrl, active: activate });
      console.log(`[TobyFlow] Created new tab: ${createUrl}`);
      return newTab;
    }
  } catch (err) {
    console.error('[TobyFlow] openOrActivateTab error:', err);
    // Fallback: just create new tab
    return await chrome.tabs.create({ url: createUrl, active: activate });
  }
}

function _isAllowedUrl(url) {
  try {
    const u = new URL(url);
    if (['localhost', '127.0.0.1', '0.0.0.0'].includes(u.hostname)) return false;
    if (!['https:', 'http:'].includes(u.protocol)) return false;
    if (u.hostname.endsWith('.local')) return false;
    return true;
  } catch { return false; }
}

/**
 * Tính vị trí popup window: kế bên trái sidebar
 * Sidebar nằm bên phải, rộng ~600px → popup đặt sát trái sidebar
 * @param {number} popupWidth - Chiều rộng popup
 * @param {number} popupHeight - Chiều cao popup
 * @returns {{ left: number, top: number }}
 */
async function _calcWindowPosition(popupWidth, popupHeight) {
  try {
    const currentWin = await chrome.windows.getCurrent();
    const winLeft = currentWin.left || 0;
    const winTop = currentWin.top || 0;
    const winWidth = currentWin.width || 1440;
    const winHeight = currentWin.height || 900;

    const sidebarWidth = 600;
    // Popup nằm kế bên trái sidebar: right edge of popup = left edge of sidebar
    const sidebarLeft = winLeft + winWidth - sidebarWidth;
    let left = sidebarLeft - popupWidth;

    // Nếu popup bị tràn ra ngoài bên trái màn hình → đặt tại winLeft
    if (left < winLeft) left = winLeft;

    // Canh giữa theo chiều dọc trong browser window
    let top = winTop + Math.round((winHeight - popupHeight) / 2);
    if (top < winTop) top = winTop;

    return { left, top };
  } catch (e) {
    // Fallback nếu không lấy được window info
    return { left: 100, top: 100 };
  }
}

// === Download Rename System ===
// Khi Flow native download xảy ra, extension can thiệp đổi tên file + folder
// content.js gọi 'prepareDownloadRename' trước khi trigger Flow menu
// FIFO queue: hỗ trợ nhiều downloads liên tiếp (2+ hình submit cùng lúc)
let _pendingDownloadRenames = []; // [{ folder, filename, expires }]

chrome.downloads.onDeterminingFilename.addListener((downloadItem, suggest) => {
  // ============================================================
  // GIẢI PHÁP CHÍNH: Check byExtensionId TRƯỚC TIÊN
  // Nếu download do extension KHÁC initiate → skip ngay, KHÔNG gọi suggest()
  // Điều này tránh conflict giữa Toby Flow và AutoGrok
  // ============================================================
  const initiatorExtId = downloadItem.byExtensionId;
  if (initiatorExtId && initiatorExtId !== chrome.runtime.id) {
    // Download do extension khác initiate → để extension đó xử lý
    console.log(`[TobyFlow] onDeterminingFilename: initiated by different extension (${initiatorExtId}), skip`);
    return;
  }

  // Dọn entries hết hạn
  const now = Date.now();
  _pendingDownloadRenames = _pendingDownloadRenames.filter(r => now <= r.expires);

  // Không có pending rename nào → skip
  if (_pendingDownloadRenames.length === 0) {
    console.log(`[TobyFlow] onDeterminingFilename: no pending renames, skip. file="${downloadItem.filename}"`);
    return;
  }

  const url = downloadItem.url || '';
  const referrer = downloadItem.referrer || '';
  const filename = downloadItem.filename || '';
  const mime = downloadItem.mime || '';

  // Nếu download do extension này initiate (byExtensionId === chrome.runtime.id)
  // → xử lý ngay với pending rename
  if (initiatorExtId === chrome.runtime.id) {
    // Tìm rename entry phù hợp nhất
    let renameIdx = 0;
    const urlUuidMatch = url.match(/name=([a-f0-9-]{36})/i);
    if (urlUuidMatch) {
      const urlUuid = urlUuidMatch[1];
      const matchIdx = _pendingDownloadRenames.findIndex(r =>
        r.identifier && (r.identifier.includes(urlUuid) || urlUuid.includes(r.identifier))
      );
      if (matchIdx >= 0) renameIdx = matchIdx;
    }
    const rename = _pendingDownloadRenames.splice(renameIdx, 1)[0];
    const origExt = downloadItem.filename?.split('.').pop() || 'png';
    const customName = rename.filename.includes('.') ? rename.filename : `${rename.filename}.${origExt}`;
    const fullPath = rename.folder ? `${rename.folder}/${customName}` : customName;
    console.log(`[TobyFlow] Download rename (own extension): ${downloadItem.filename} → ${fullPath}`);
    suggest({ filename: fullPath, conflictAction: 'uniquify' });
    return;
  }

  // ============================================================
  // Từ đây: byExtensionId = undefined (download từ browser/user, ví dụ Flow context menu)
  // Chỉ xử lý nếu download từ Google Flow page
  // ============================================================

  // Skip nếu referrer là từ Grok
  if (referrer.includes('grok.com') || referrer.includes('x.com')) {
    console.log(`[TobyFlow] onDeterminingFilename: referrer is Grok/X, skip`);
    return;
  }

  // Skip nếu URL có vẻ là từ Grok
  const looksLikeGrokUrl = url.includes('grok.com') ||
    url.includes('imagine-public.x.ai') ||
    url.includes('assets.grok') ||
    url.includes('video.grok');
  if (looksLikeGrokUrl) {
    console.log(`[TobyFlow] onDeterminingFilename: URL looks like Grok, skip`);
    return;
  }

  // Check nếu download từ Google Flow
  const hasFlowReferrer = referrer.includes('labs.google');
  const hasFlowUrl = url.includes('labs.google') || url.includes('getMediaUrlRedirect');

  // Video downloads
  const isVideoDownload = mime.startsWith('video/') ||
    filename.endsWith('.mp4') ||
    filename.endsWith('.webm') ||
    filename.endsWith('.mov');

  // Xác định có phải Flow download không
  const isFlowDownload = hasFlowReferrer || hasFlowUrl ||
    ((url.includes('googleusercontent.com') || url.includes('storage.googleapis.com') || url.includes('googlevideo.com')) && hasFlowReferrer) ||
    (url.startsWith('blob:') && hasFlowReferrer) ||
    (isVideoDownload && hasFlowReferrer);

  if (!isFlowDownload) {
    console.log(`[TobyFlow] onDeterminingFilename: not from Flow page, skip`);
    return;
  }

  // Tìm rename entry phù hợp nhất
  let renameIdx = 0;
  const urlUuidMatch = url.match(/name=([a-f0-9-]{36})/i);
  if (urlUuidMatch) {
    const urlUuid = urlUuidMatch[1];
    const matchIdx = _pendingDownloadRenames.findIndex(r =>
      r.identifier && (r.identifier.includes(urlUuid) || urlUuid.includes(r.identifier))
    );
    if (matchIdx >= 0) renameIdx = matchIdx;
  }

  const rename = _pendingDownloadRenames.splice(renameIdx, 1)[0];
  let origExt = downloadItem.filename?.split('.').pop()?.toLowerCase() || 'png';
  // Bug fix: Flow context menu đôi khi trả về HTML page (server response error /
  // auth redirect / media chưa ready) → downloadItem.filename = "media.html" hay tương tự
  // → save file thành .html SAI. Detect & override sang ext đúng theo mime + filename hint.
  if (origExt === 'html' || origExt === 'htm') {
    if (mime.startsWith('video/') || isVideoDownload) {
      origExt = 'mp4';
    } else if (mime.startsWith('image/')) {
      origExt = mime === 'image/jpeg' ? 'jpg' : (mime.split('/')[1] || 'png');
    } else {
      // Mime cũng không cho biết → infer từ rename context (nếu có ext trong tên)
      origExt = 'png'; // safe default cho Flow image
    }
    console.warn(`[TobyFlow] Download rename: HTML response detected (filename="${downloadItem.filename}", mime="${mime}") → coerce ext to "${origExt}"`);
  }
  const customName = rename.filename.includes('.') ? rename.filename : `${rename.filename}.${origExt}`;
  const fullPath = rename.folder ? `${rename.folder}/${customName}` : customName;

  console.log(`[TobyFlow] Download rename: ${downloadItem.filename} → ${fullPath}`);
  suggest({ filename: fullPath, conflictAction: 'uniquify' });
});

// Note: Đã remove chrome.alarms + port keep-alive sau khi xác định root cause thực sự là
// Chrome HTTP cache (fix bằng cache: 'no-store' trong apiRequest handler). SW lifecycle
// không phải nguyên nhân bug login/logout refresh quyền.
//
// UPDATE: Restore lightweight SW keep-alive sau khi user báo "Failed to fetch" liên tục
// khi mở tab Workflow / Tasks. Root cause: Chrome MV3 SW idle timeout ~30s khi không có
// event nào → fetch() trong handler fail vì SW bị suspend giữa chừng.
// Pattern tiêu chuẩn: chrome.alarms periodic ngắn (>= 30s/0.5 min) để wake SW.
chrome.alarms.create('swKeepAlive', { periodInMinutes: 0.5 });

// Note: Đã remove bgFetchEntitlements + persistent logger sau khi xác định root cause
// là Chrome HTTP cache. SidePanel tự fetch entitlements qua apiRequest handler đã đủ
// (bây giờ fetch options có cache: 'no-store' để bypass cache stale).

// === Phase FAR-1: Silent session refresh ===
// Mục tiêu: Refresh OAuth bearer token định kỳ qua Next.js soft-navigation
// để tránh user phải F5 manual khi Flow gen fail. Plan: docs/plans/flow-auto-retry-plan.md
//
// Phase 2c: FAR settings now server-controlled via /api/v1/system-config/execution
// Background SW fetches from server (fallback to defaults).
//
// Settings (server system_settings.group='execution'):
//   - flow_session_refresh_enabled (bool, default false)
//   - flow_session_refresh_interval_min (int, 5-120, default 120)

// Phase 2c Test: Enable verbose logging
const _FAR_DEBUG = true;

// Cache cho execution config (background SW không có access đến ExecutionConfig class)
let _executionConfigCache = null;
let _executionConfigCacheTime = 0;
const _EXECUTION_CONFIG_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function _fetchExecutionConfig() {
  try {
    // Check in-memory cache
    if (_executionConfigCache && Date.now() - _executionConfigCacheTime < _EXECUTION_CONFIG_CACHE_TTL_MS) {
      if (_FAR_DEBUG) console.log('[background] Using cached execution config');
      return _executionConfigCache;
    }

    // PERF FIX (2026-05-17): Đọc chrome.storage.local.af_execution_config TRƯỚC HTTP fetch.
    // Sidebar ExecutionConfig (sidebar context) đã ghi storage này sau khi fetch — background
    // có thể reuse thay vì fetch riêng. Giảm duplicate request lên VPS server (1.9GB RAM).
    try {
      const stored = await new Promise(resolve => {
        chrome.storage.local.get(['af_execution_config'], res => resolve(res?.af_execution_config));
      });
      if (stored && typeof stored === 'object' && (stored.workflow || stored.flow_recovery)) {
        _executionConfigCache = stored;
        _executionConfigCacheTime = Date.now();
        if (_FAR_DEBUG) console.log('[background] Execution config from chrome.storage (sidebar preload), SKIP HTTP fetch');
        return _executionConfigCache;
      }
    } catch (_) { /* storage read failed — fall through to HTTP */ }

    if (_FAR_DEBUG) console.log('[background] Fetching execution config from server...');
    const response = await _signedFetch(`${getApiBaseUrl()}/system-config/execution`, {
      method: 'GET',
      cache: 'no-store',
      headers: { 'X-Extension-Id': chrome.runtime.id },
    });
    if (response.status === 403) {
      try {
        const body = await response.clone().json();
        if (_isExtensionAuthRejection(body, 403)) _handleExtensionAuthRejection();
      } catch (_) {}
    }

    if (!response.ok) {
      if (_FAR_DEBUG) console.warn('[background] Server returned non-OK:', response.status);
      return _executionConfigCache || {};
    }

    const json = await response.json();
    if (json.success && json.data) {
      _executionConfigCache = json.data;
      _executionConfigCacheTime = Date.now();
      // PERF FIX: write storage để sidebar ExecutionConfig.fetch reuse thay vì fetch HTTP riêng.
      try { chrome.storage.local.set({ af_execution_config: json.data }); } catch (_) {}
      if (_FAR_DEBUG) {
        console.log('[background] ✓ Execution config loaded from server:');
        console.log('  flow_recovery:', JSON.stringify(json.data.flow_recovery || {}));
      }
      return _executionConfigCache;
    }
    return _executionConfigCache || {};
  } catch (e) {
    console.warn('[background] _fetchExecutionConfig error:', e.message);
    return _executionConfigCache || {};
  }
}

async function rescheduleFlowSessionAlarm() {
  try {
    const config = await _fetchExecutionConfig();
    const farConfig = config.flow_recovery || {};

    if (_FAR_DEBUG) {
      console.log('[background] FAR config:');
      console.log('  session_refresh_enabled:', farConfig.session_refresh_enabled);
      console.log('  session_refresh_interval_min:', farConfig.session_refresh_interval_min);
    }

    // Server-controlled: session_refresh_enabled (default false)
    if (farConfig.session_refresh_enabled !== true) {
      chrome.alarms.clear('flowSessionRefresh');
      console.log('[TobyFlow] ✓ Flow session refresh DISABLED (server config)');
      return;
    }

    // Server-controlled: session_refresh_interval_min (default 120)
    const intervalMin = parseInt(farConfig.session_refresh_interval_min || 120, 10);
    // Clamp 5-120 (match validation rule)
    const clampedMin = Math.max(5, Math.min(120, intervalMin));
    chrome.alarms.create('flowSessionRefresh', { periodInMinutes: clampedMin });
    console.log('[TobyFlow] ✓ Flow session refresh ENABLED, interval:', clampedMin, 'min');
  } catch (e) {
    console.warn('[TobyFlow] rescheduleFlowSessionAlarm error:', e.message);
  }
}

// Init alarm khi background SW start
rescheduleFlowSessionAlarm();

// ─── DEV PRELOADER: Seed chrome.storage với mock data từ local server ────────
// Giải quyết cache_empty errors do sync methods (getModelsSync, getVideoDurationsSync)
// được gọi trước khi async fetch hoàn tất.
// Mỗi lần background SW start → LUÔN fetch lại (không skip theo TTL)
// Dev mode: server là localhost → response time ~1ms, overhead không đáng kể.
async function _devPreloadLocalServerData() {
  try {
    const apiBase = getApiBaseUrl();
    const TTL_4H = 4 * 60 * 60 * 1000;
    const now = Date.now();

    // Fetch tất cả endpoints song song để giảm total latency
    const [modelsResp, apiCfgResp, domResp] = await Promise.allSettled([
      fetch(`${apiBase}/provider-models`, { cache: 'no-store' }),
      fetch(`${apiBase}/providers/api-configs`, { cache: 'no-store' }),
      fetch(`${apiBase}/providers/dom-selectors`, { cache: 'no-store' }),
    ]);

    // --- Seed provider-models (ModelRegistry cache key: 'toby_provider_models') ---
    if (modelsResp.status === 'fulfilled' && modelsResp.value.ok) {
      try {
        const json = await modelsResp.value.json();
        if (json.success && Array.isArray(json.data)) {
          const cacheEntry = { data: json.data, expiresAt: now + TTL_4H, fetchedAt: now };
          chrome.storage.local.set({ toby_provider_models: cacheEntry });
          console.log('[DevPreload] ✅ toby_provider_models seeded:', json.data.length, 'models');
        }
      } catch (e) {
        console.warn('[DevPreload] provider-models parse failed:', e.message);
      }
    } else {
      console.warn('[DevPreload] provider-models fetch failed (server running?)');
    }

    // --- Seed api-configs (PCM cache key: 'toby_provider_api_configs') ---
    if (apiCfgResp.status === 'fulfilled' && apiCfgResp.value.ok) {
      try {
        const json = await apiCfgResp.value.json();
        if (json.success && json.data) {
          const cacheEntry = { data: json.data, expiresAt: now + TTL_4H, fetchedAt: now };
          chrome.storage.local.set({ toby_provider_api_configs: cacheEntry });
          console.log('[DevPreload] ✅ toby_provider_api_configs seeded for:', Object.keys(json.data));
        }
      } catch (e) {
        console.warn('[DevPreload] api-configs parse failed:', e.message);
      }
    } else {
      console.warn('[DevPreload] api-configs fetch failed (server running?)');
    }

    // --- Seed provider DOM selectors (PCM dom-selectors cache key: 'toby_provider_configs') ---
    if (domResp.status === 'fulfilled' && domResp.value.ok) {
      try {
        const json = await domResp.value.json();
        if (json.success && json.data) {
          const cacheEntry = { data: json.data, expiresAt: now + TTL_4H, fetchedAt: now };
          chrome.storage.local.set({ toby_provider_configs: cacheEntry });
          console.log('[DevPreload] ✅ toby_provider_configs (dom-selectors) seeded');
        }
      } catch (e) {
        console.warn('[DevPreload] dom-selectors parse failed:', e.message);
      }
    } else {
      console.warn('[DevPreload] dom-selectors fetch failed (server running?)');
    }

    // --- Seed local DEV login session (af_auth) ---
    // Để extension tự nhận mình là bản cao cấp khi boot
    const existingAuth = await new Promise(r => chrome.storage.local.get(['af_auth'], r));
    if (!existingAuth.af_auth || !existingAuth.af_auth.token) {
      try {
        const loginResp = await fetch(`${apiBase}/auth/login`, { method: 'POST' });
        if (loginResp.ok) {
          const json = await loginResp.json();
          if (json.success && json.data) {
            chrome.storage.local.set({
              af_auth: {
                token: json.data.token,
                user: json.data.user,
                apiBaseUrl: apiBase,
                savedAt: now
              }
            });
            console.log('[DevPreload] ✅ af_auth seeded (Pro mode active)');
          }
        }
      } catch (e) {
        console.warn('[DevPreload] login stub failed:', e.message);
      }
    }

  } catch (e) {
    console.warn('[DevPreload] Preload error:', e.message);
  }
}

// Chạy ngay khi background SW start
_devPreloadLocalServerData();

// Phase 2c: Listen for SSE updates via sidebar → storage bridge
// Sidebar receives SSE system_settings_changed → updates af_execution_config cache
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  // Re-schedule khi execution config cache changes
  if (changes.af_execution_config) {
    _executionConfigCache = changes.af_execution_config.newValue;
    _executionConfigCacheTime = Date.now();
    rescheduleFlowSessionAlarm();
  }
});

// Alarm handler — gửi message đến TẤT CẢ Flow tabs để refresh session
chrome.alarms.onAlarm.addListener(async (alarm) => {
  // SW keep-alive — chỉ cần listener fire để Chrome reset idle timeout
  if (alarm.name === 'swKeepAlive') return;
  if (alarm.name !== 'flowSessionRefresh') return;
  try {
    const tabs = await chrome.tabs.query({ url: PROVIDER_URLS.flow.tabQuery });
    for (const tab of tabs) {
      try {
        await chrome.tabs.sendMessage(tab.id, { action: 'flow:refreshSession' });
      } catch (e) {
        // Tab content script chưa ready hoặc orphan — skip silent
      }
    }
  } catch (e) {
    console.warn('[TobyFlow] flowSessionRefresh alarm error:', e.message);
  }
});

// === Auto-inject content script vào existing Google Flow tabs ===
// NOTE: onInstalled listener đã move vào consolidated section cuối file.
// Giữ helper function để inject content scripts (được gọi từ consolidated listener).
function _autoInjectContentScripts() {
  chrome.tabs.query({ url: PROVIDER_URLS.flow.tabQuery }, (tabs) => {
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, { action: 'ping' }, (response) => {
        if (chrome.runtime.lastError || !response) {
          chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['content.js']
          }).catch(err => console.warn('[TobyFlow] Auto-inject failed for tab', tab.id, err.message));
        } else {
          console.log('[TobyFlow] content.js đã active trong tab', tab.id, '→ skip auto-inject');
        }
      });
    }
  });
}

// === chrome.sidePanel Setup ===
// GLOBAL MODE: 1 sidePanel instance cho tất cả tabs (không cần sync state giữa các tabs)
if (chrome.sidePanel) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
    .catch(err => console.warn('[TobyFlow] sidePanel setPanelBehavior error:', err));

  // Global sidePanel - không dùng tabId → 1 instance duy nhất
  chrome.sidePanel.setOptions({
    path: 'sidebar.html',
    enabled: true
  }).catch(err => console.warn('[TobyFlow] sidePanel setOptions error:', err));

  // Vẫn cần notify project context khi Flow tab URL thay đổi
  chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
    if (!tab.url) return;
    if (tab.url.startsWith(PROVIDER_URLS.flow.base)) {
      // Khi Flow tab URL thay đổi (SPA navigation hoặc page load), thông báo sidebar cập nhật project context
      if (info.status === 'complete' || info.url) {
        const projectMatch = tab.url.match(/\/project\/([a-f0-9-]+)/);
        const projectId = projectMatch ? projectMatch[1] : null;
        // Gửi projectContext tới sidebar để cập nhật state
        chrome.runtime.sendMessage({
          action: 'projectContext',
          projectId: projectId,
          projectName: null, // Sẽ được cập nhật sau khi content.js sẵn sàng
          fromTabUpdate: true
        }).catch(() => {});
        // Nếu đang ở project page, yêu cầu content.js gửi context đầy đủ (có projectName)
        if (projectId) {
          setTimeout(() => {
            chrome.tabs.sendMessage(tabId, { action: 'getProjectContext' }, (resp) => {
              if (chrome.runtime.lastError || !resp?.projectId) return;
              chrome.runtime.sendMessage({
                action: 'projectContext',
                projectId: resp.projectId,
                projectName: resp.projectName
              }).catch(() => {});
            });
          }, 500);
        }
      }
    }
  });

  // Detect khi user switch sang Flow tab → notify sidePanel
  chrome.tabs.onActivated.addListener(async (activeInfo) => {
    try {
      const tab = await chrome.tabs.get(activeInfo.tabId);
      if (tab.url && tab.url.startsWith(PROVIDER_URLS.flow.base)) {
        // Notify sidePanel để upload pending files + re-sync project context
        chrome.runtime.sendMessage({
          action: 'flowTabActivated',
          tabId: activeInfo.tabId,
          url: tab.url
        }).catch(() => {});
      }
    } catch (e) {
      // Tab không tồn tại hoặc lỗi khác — bỏ qua
    }
  });
}

// Open settings in a separate popup window
async function openSettingsWindow(tab = null) {
  // Prevent race condition: multiple clicks before window is created
  if (_settingsWindowOpening) return;

  const hashSuffix = tab ? `#${tab}` : '';

  // Check if window already exists (in-memory)
  if (settingsWindowId !== null) {
    try {
      const win = await chrome.windows.get(settingsWindowId, { populate: true });
      if (win) {
        // Nếu có tab param → update URL để switch tab; nếu không → chỉ focus
        if (tab && win.tabs?.[0]) {
          chrome.tabs.update(win.tabs[0].id, { url: chrome.runtime.getURL('settings.html' + hashSuffix) });
        }
        chrome.windows.update(settingsWindowId, { focused: true });
        return;
      }
    } catch (e) {
      settingsWindowId = null;
      _persistWindowIds();
    }
  }

  // Fallback: check session storage (SW may have hibernated)
  if (settingsWindowId === null) {
    try {
      const stored = await chrome.storage?.session?.get(['_settingsWindowId']);
      if (stored?._settingsWindowId) {
        const win = await chrome.windows.get(stored._settingsWindowId, { populate: true });
        if (win) {
          settingsWindowId = stored._settingsWindowId;
          _extensionPopupWindows.add(settingsWindowId);
          if (tab && win.tabs?.[0]) {
            chrome.tabs.update(win.tabs[0].id, { url: chrome.runtime.getURL('settings.html' + hashSuffix) });
          }
          chrome.windows.update(settingsWindowId, { focused: true });
          return;
        }
      }
    } catch (e) {
      // Window doesn't exist, proceed to create
    }
  }

  _settingsWindowOpening = true;
  try {
    // Tính vị trí kế bên trái sidebar
    const pos = await _calcWindowPosition(580, 850);
    const win = await chrome.windows.create({
      url: chrome.runtime.getURL('settings.html' + hashSuffix),
      type: 'popup',
      width: 580,
      height: 850,
      left: pos.left,
      top: pos.top,
      focused: true
    });

    settingsWindowId = win.id;
    _extensionPopupWindows.add(win.id);
    _persistWindowIds();
  } finally {
    _settingsWindowOpening = false;
  }
}

// Open workflow editor in a separate popup window
let _workflowWindowOpening = false;
async function openWorkflowWindow(workflowData) {
  console.log('[Background] openWorkflowWindow called, _workflowWindowOpening:', _workflowWindowOpening, 'workflowWindowId:', workflowWindowId);
  // Prevent race condition: multiple messages arriving before window is created
  if (_workflowWindowOpening) {
    console.log('[Background] openWorkflowWindow blocked - already opening');
    return;
  }

  // Track which workflow is being edited
  editingWorkflowId = workflowData?.workflow?.wf_id || null;
  _persistWindowIds();

  // Check if window already exists (in-memory)
  if (workflowWindowId !== null) {
    try {
      const win = await chrome.windows.get(workflowWindowId);
      if (win) {
        chrome.windows.update(workflowWindowId, { focused: true });
        // Always reload workflow data (may have been reset/updated)
        if (workflowData) {
          chrome.runtime.sendMessage({ action: 'loadWorkflowInEditor', data: workflowData });
        }
        editingWorkflowId = workflowData?.workflow?.wf_id || null;
        _persistWindowIds();
        return;
      }
    } catch (e) {
      console.log('[Background] openWorkflowWindow - window.get failed, clearing workflowWindowId');
      workflowWindowId = null;
      _persistWindowIds();
    }
  }

  // Fallback: check session storage (SW may have hibernated)
  if (workflowWindowId === null) {
    try {
      const stored = await chrome.storage?.session?.get(['_workflowWindowId']);
      console.log('[Background] openWorkflowWindow - session storage check:', stored?._workflowWindowId);
      if (stored?._workflowWindowId) {
        const win = await chrome.windows.get(stored._workflowWindowId);
        if (win) {
          console.log('[Background] openWorkflowWindow - found window in session storage, focusing');
          workflowWindowId = stored._workflowWindowId;
          _extensionPopupWindows.add(workflowWindowId);
          chrome.windows.update(workflowWindowId, { focused: true });
          if (workflowData) {
            chrome.runtime.sendMessage({ action: 'loadWorkflowInEditor', data: workflowData });
          }
          editingWorkflowId = workflowData?.workflow?.wf_id || null;
          _persistWindowIds();
          return;
        }
      }
    } catch (e) {
      console.log('[Background] openWorkflowWindow - session storage window invalid, will create new');
      // Window doesn't exist, proceed to create
    }
  }

  console.log('[Background] openWorkflowWindow - creating new window');
  _workflowWindowOpening = true;
  let pendingWorkflowSet = false;
  try {
    // Store workflow data for the new window to pick up
    if (workflowData) {
      await chrome.storage.local.set({ _pendingWorkflow: workflowData });
      pendingWorkflowSet = true;
    }

    // Default size — bump lên 90% Flow window nếu user đang dùng monitor lớn.
    // Lý do: workflow nhiều node + 16:9 monitor → 1440×900 chật. 90% Flow window
    // đảm bảo workflow editor vừa với màn hình user (Flow đã được user resize sẵn).
    let winWidth = 1440;
    let winHeight = 900;
    try {
      const flowTabs = await chrome.tabs.query({ url: PROVIDER_URLS.flow.tabQuery });
      if (flowTabs.length > 0 && flowTabs[0].windowId) {
        const flowWin = await chrome.windows.get(flowTabs[0].windowId);
        if (flowWin?.width && flowWin?.height) {
          const targetW = Math.round(flowWin.width * 0.9);
          const targetH = Math.round(flowWin.height * 0.9);
          // Chỉ tăng — không giảm. Default 1440×900 là baseline tối thiểu.
          if (targetW > winWidth) winWidth = targetW;
          if (targetH > winHeight) winHeight = targetH;
          console.log('[Background] Workflow window size:', winWidth, 'x', winHeight, '(Flow window:', flowWin.width, 'x', flowWin.height, ')');
        }
      }
    } catch (sizeErr) {
      console.warn('[Background] Failed to read Flow window size:', sizeErr.message);
    }

    const pos = await _calcWindowPosition(winWidth, winHeight);
    const win = await chrome.windows.create({
      url: chrome.runtime.getURL('workflow-editor.html'),
      type: 'popup',
      width: winWidth,
      height: winHeight,
      left: pos.left,
      top: pos.top,
      focused: true
    });

    workflowWindowId = win.id;
    _extensionPopupWindows.add(win.id);
    _persistWindowIds();
    pendingWorkflowSet = false; // window created OK, init script sẽ consume + remove
  } catch (createErr) {
    // Gap 4 fix: nếu chrome.windows.create fail → _pendingWorkflow stuck. Lần
    // sau open editor mới (kể cả workflow KHÁC) sẽ load workflow cũ vì init
    // line ~188 đọc _pendingWorkflow. Cleanup để tránh ghi nhầm.
    console.error('[Background] openWorkflowWindow create failed:', createErr.message);
    if (pendingWorkflowSet) {
      try { await chrome.storage.local.remove('_pendingWorkflow'); } catch (e) {}
    }
    // Không throw để tránh unhandled rejection ở caller (line ~1075, 1097 không await)
  } finally {
    _workflowWindowOpening = false;
  }
}

// Open template editor in a separate popup window (giống workflow editor)
let _templateWindowOpening = false;

async function openTemplateEditorWindow(templateData) {
  // Prevent race condition
  if (_templateWindowOpening) return;

  // Check if window already exists (in-memory)
  if (templateWindowId !== null) {
    try {
      const win = await chrome.windows.get(templateWindowId);
      if (win) {
        chrome.windows.update(templateWindowId, { focused: true });
        // Reload template data nếu có
        if (templateData) {
          await chrome.storage.local.set({ _pendingTemplate: templateData });
          chrome.runtime.sendMessage({ action: 'loadTemplateInEditor', data: templateData });
        }
        return;
      }
    } catch (e) {
      templateWindowId = null;
      _persistWindowIds();
    }
  }

  // Fallback: check session storage (SW may have hibernated)
  if (templateWindowId === null) {
    try {
      const stored = await chrome.storage?.session?.get(['_templateWindowId']);
      if (stored?._templateWindowId) {
        const win = await chrome.windows.get(stored._templateWindowId);
        if (win) {
          templateWindowId = stored._templateWindowId;
          _extensionPopupWindows.add(templateWindowId);
          chrome.windows.update(templateWindowId, { focused: true });
          if (templateData) {
            await chrome.storage.local.set({ _pendingTemplate: templateData });
            chrome.runtime.sendMessage({ action: 'loadTemplateInEditor', data: templateData });
          }
          return;
        }
      }
    } catch (e) {
      // Window doesn't exist, proceed to create
    }
  }

  _templateWindowOpening = true;
  try {
    // Store template data for the new window to pick up
    // Chỉ set _pendingTemplate nếu templateData có đầy đủ dữ liệu (nodes, edges)
    // Nếu chỉ có { mode, templateId } thì sidebar đã set _pendingTemplate trước đó rồi
    if (templateData && templateData.nodes) {
      await chrome.storage.local.set({ _pendingTemplate: templateData });
    } else if (!templateData) {
      await chrome.storage.local.remove('_pendingTemplate');
    }
    // Nếu templateData là { mode, templateId } - không làm gì, giữ nguyên _pendingTemplate từ sidebar

    // Smart sizing giống workflow editor - 90% Flow window hoặc default 1440x900
    let winWidth = 1440;
    let winHeight = 900;
    try {
      const flowTabs = await chrome.tabs.query({ url: PROVIDER_URLS.flow.tabQuery });
      if (flowTabs.length > 0 && flowTabs[0].windowId) {
        const flowWin = await chrome.windows.get(flowTabs[0].windowId);
        if (flowWin?.width && flowWin?.height) {
          const targetW = Math.round(flowWin.width * 0.9);
          const targetH = Math.round(flowWin.height * 0.9);
          if (targetW > winWidth) winWidth = targetW;
          if (targetH > winHeight) winHeight = targetH;
          console.log('[Background] Template editor window size:', winWidth, 'x', winHeight);
        }
      }
    } catch (sizeErr) {
      console.warn('[Background] Failed to read Flow window size:', sizeErr.message);
    }

    // Build URL với params
    let url = 'workflow-template-editor.html';
    if (templateData?.mode) {
      const params = new URLSearchParams();
      params.set('mode', templateData.mode);
      if (templateData.templateId) {
        params.set('templateId', String(templateData.templateId));
      }
      url += '?' + params.toString();
    }

    const pos = await _calcWindowPosition(winWidth, winHeight);
    const win = await chrome.windows.create({
      url: chrome.runtime.getURL(url),
      type: 'popup',
      width: winWidth,
      height: winHeight,
      left: pos.left,
      top: pos.top,
      focused: true
    });

    templateWindowId = win.id;
    _extensionPopupWindows.add(win.id);
    _persistWindowIds();
  } finally {
    _templateWindowOpening = false;
  }
}

// Open angles editor in a separate popup window
let _anglesWindowOpening = false;
async function openAnglesWindow() {
  if (_anglesWindowOpening) return;

  // Check if window already exists (in-memory)
  if (anglesWindowId !== null) {
    try {
      const win = await chrome.windows.get(anglesWindowId);
      if (win) {
        chrome.windows.update(anglesWindowId, { focused: true });
        return;
      }
    } catch (e) {
      anglesWindowId = null;
      _persistWindowIds();
    }
  }

  // Fallback: check session storage (SW may have hibernated)
  if (anglesWindowId === null) {
    try {
      const stored = await chrome.storage?.session?.get(['_anglesWindowId']);
      if (stored?._anglesWindowId) {
        const win = await chrome.windows.get(stored._anglesWindowId);
        if (win) {
          anglesWindowId = stored._anglesWindowId;
          _extensionPopupWindows.add(anglesWindowId);
          chrome.windows.update(anglesWindowId, { focused: true });
          return;
        }
      }
    } catch (e) {
      // Window doesn't exist, proceed to create
    }
  }

  _anglesWindowOpening = true;
  try {
    const pos = await _calcWindowPosition(1200, 950);
    const win = await chrome.windows.create({
      url: chrome.runtime.getURL('angles-editor.html'),
      type: 'popup',
      width: 1200,
      height: 950,
      left: pos.left,
      top: pos.top,
      focused: true
    });

    anglesWindowId = win.id;
    _extensionPopupWindows.add(win.id);
    _persistWindowIds();
  } finally {
    _anglesWindowOpening = false;
  }
}

// ─── Effects Editor Window ───────────────────────────────────────────────
let _effectsWindowOpening = false;

async function openEffectsWindow() {
  if (_effectsWindowOpening) return;

  // Check if window already exists (in-memory)
  if (effectsWindowId !== null) {
    try {
      const win = await chrome.windows.get(effectsWindowId);
      if (win) {
        chrome.windows.update(effectsWindowId, { focused: true });
        return;
      }
    } catch (e) {
      effectsWindowId = null;
      _persistWindowIds();
    }
  }

  // Fallback: check session storage (SW may have hibernated)
  if (effectsWindowId === null) {
    try {
      const stored = await chrome.storage?.session?.get(['_effectsWindowId']);
      if (stored?._effectsWindowId) {
        const win = await chrome.windows.get(stored._effectsWindowId);
        if (win) {
          effectsWindowId = stored._effectsWindowId;
          _extensionPopupWindows.add(effectsWindowId);
          chrome.windows.update(effectsWindowId, { focused: true });
          return;
        }
      }
    } catch (e) {
      // Window doesn't exist, proceed to create
    }
  }

  _effectsWindowOpening = true;
  try {
    const pos = await _calcWindowPosition(1200, 900);
    const win = await chrome.windows.create({
      url: chrome.runtime.getURL('effects-editor.html'),
      type: 'popup',
      width: 1200,
      height: 900,
      left: pos.left,
      top: pos.top,
      focused: true
    });

    effectsWindowId = win.id;
    _extensionPopupWindows.add(win.id);
    _persistWindowIds();
  } finally {
    _effectsWindowOpening = false;
  }
}

// Clean up when windows close
chrome.windows.onRemoved.addListener(async (windowId) => {
  // Remove from tracking Set
  _extensionPopupWindows.delete(windowId);

  // Settings window: check in-memory first, then session storage fallback (SW hibernation)
  let isSettingsWindow = (windowId === settingsWindowId);
  if (!isSettingsWindow) {
    try {
      const stored = await chrome.storage?.session?.get(['_settingsWindowId']);
      if (stored?._settingsWindowId === windowId) isSettingsWindow = true;
    } catch (e) { /* ignore */ }
  }
  if (isSettingsWindow) {
    settingsWindowId = null;
    _persistWindowIds();
    // Notify sidePanel: settings closed (refresh entitlements/account UI if needed)
    chrome.runtime.sendMessage({ action: 'settingsClosed' }).catch(() => {});
  }

  // Workflow window
  let isWorkflowWindow = (windowId === workflowWindowId);
  console.log('[Background] onRemoved windowId:', windowId, 'workflowWindowId:', workflowWindowId, 'isWorkflow:', isWorkflowWindow);
  if (!isWorkflowWindow) {
    try {
      const stored = await chrome.storage?.session?.get(['_workflowWindowId']);
      if (stored?._workflowWindowId === windowId) {
        isWorkflowWindow = true;
        console.log('[Background] onRemoved - matched via session storage');
      }
    } catch (e) { /* ignore */ }
  }
  if (isWorkflowWindow) {
    console.log('[Background] onRemoved - clearing workflow window state');
    workflowWindowId = null;
    editingWorkflowId = null;
    _persistWindowIds();
    chrome.runtime.sendMessage({ action: 'workflowEditorClosed' }).catch(() => {});
  }

  // Template editor window
  let isTemplateWindow = (windowId === templateWindowId);
  if (!isTemplateWindow) {
    try {
      const stored = await chrome.storage?.session?.get(['_templateWindowId']);
      if (stored?._templateWindowId === windowId) isTemplateWindow = true;
    } catch (e) { /* ignore */ }
  }
  if (isTemplateWindow) {
    templateWindowId = null;
    _persistWindowIds();
    chrome.runtime.sendMessage({ action: 'templateEditorClosed' }).catch(() => {});
  }

  // Angles window
  let isAnglesWindow = (windowId === anglesWindowId);
  if (!isAnglesWindow) {
    try {
      const stored = await chrome.storage?.session?.get(['_anglesWindowId']);
      if (stored?._anglesWindowId === windowId) isAnglesWindow = true;
    } catch (e) { /* ignore */ }
  }
  if (isAnglesWindow) {
    anglesWindowId = null;
    _persistWindowIds();
  }

  // Effects window
  let isEffectsWindow = (windowId === effectsWindowId);
  if (!isEffectsWindow) {
    try {
      const stored = await chrome.storage?.session?.get(['_effectsWindowId']);
      if (stored?._effectsWindowId === windowId) isEffectsWindow = true;
    } catch (e) { /* ignore */ }
  }
  if (isEffectsWindow) {
    effectsWindowId = null;
    _persistWindowIds();
  }
});

// Handle messages from content script and settings page
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Ping handler để wake up service worker (MV3 hibernation)
  if (message.action === 'ping') {
    sendResponse({ ok: true });
    return true;
  }

  // Phase 3: Receive URLs cache from sidebar (populated after server fetch)
  if (message.action === 'updateProviderUrlsCache') {
    const urls = message.data;
    if (urls && typeof urls === 'object') {
      _serverUrlsCache = urls;
      // Persist to session storage (survives service worker hibernation)
      chrome.storage?.session?.set({ _provider_urls_cache: urls });
      console.log('[Background] Updated provider URLs cache from sidebar');
    }
    sendResponse({ success: true });
    return false;
  }

  // ===== Provider Config Handlers (DOM Resilience Plan) =====
  // Note: Service worker uses self (globalThis), not window
  if (message.action === 'getProviderConfigs') {
    (async () => {
      try {
        const { provider } = message;
        const cached = await _getProviderConfigsFromCache();
        if (cached?.data?.[provider]) {
          sendResponse({ success: true, data: cached.data[provider] });
        } else {
          const data = await _fetchProviderConfigs();
          sendResponse({ success: true, data: data?.[provider] || null });
        }
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  // Handler for API configs fetch trigger (content.js calls when cache empty)
  if (message.action === 'getProviderApiConfigs') {
    (async () => {
      try {
        // Trigger fetch (will populate chrome.storage.local.toby_provider_api_configs)
        await _fetchApiConfigs();
        sendResponse({ success: true });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  if (message.action === 'reportSelectorFailure') {
    (async () => {
      try {
        const { provider, key, tried_selectors } = message.data || {};
        const baseUrl = await _getApiBaseUrl();
        _signedFetch(`${baseUrl}/api/v1/analytics/selector-failure`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Extension-Id': chrome.runtime.id,
          },
          body: JSON.stringify({
            provider,
            key,
            tried_selectors,
            timestamp: new Date().toISOString(),
          }),
        }).then(async (resp) => {
          if (resp.status === 403) {
            try {
              const body = await resp.clone().json();
              if (_isExtensionAuthRejection(body, 403)) _handleExtensionAuthRejection();
            } catch (_) {}
          }
        }).catch(() => {});
      } catch {}
    })();
    sendResponse({ success: true });
    return false;
  }

  // Broadcast provider config update to all content scripts
  if (message.action === 'providerConfigUpdated') {
    chrome.tabs.query({}, tabs => {
      tabs.forEach(tab => {
        chrome.tabs.sendMessage(tab.id, {
          action: 'providerConfigUpdated',
          data: message.data,
        }).catch(() => {});
      });
    });
    sendResponse({ success: true });
    return false;
  }

  // Broadcast provider api_config update (ratios, download_resolutions, error_patterns)
  // tới content scripts để invalidate cache (content scripts đọc từ chrome.storage).
  if (message.action === 'providerApiConfigUpdated') {
    chrome.tabs.query({}, tabs => {
      tabs.forEach(tab => {
        chrome.tabs.sendMessage(tab.id, {
          action: 'providerApiConfigUpdated',
          data: message.data,
        }).catch(() => {});
      });
    });
    sendResponse({ success: true });
    return false;
  }

  // Mở Flow tab để login (gọi từ settings popup)
  if (message.action === 'openFlowTabForLogin') {
    (async () => {
      try {
        console.log('[Background] openFlowTabForLogin called');
        // Tìm Flow tab đã mở
        const flowTabs = await chrome.tabs.query({ url: PROVIDER_URLS.flow.tabQuery });
        console.log('[Background] Found Flow tabs:', flowTabs.length);

        if (flowTabs.length > 0) {
          // Focus vào Flow tab đã có
          await chrome.tabs.update(flowTabs[0].id, { active: true });
          await chrome.windows.update(flowTabs[0].windowId, { focused: true });
          console.log('[Background] Focused existing Flow tab:', flowTabs[0].id);
        } else {
          // Tạo Flow tab mới
          const newTab = await chrome.tabs.create({ url: PROVIDER_URLS.flow.createUrl });
          console.log('[Background] Created new Flow tab:', newTab.id);
        }
      } catch (err) {
        console.error('[Background] openFlowTabForLogin error:', err);
      }
    })();
    return true;
  }

  // Mở hoặc activate provider tab (ChatGPT/Grok) - gọi từ workflow editor
  if (message.action === 'openProviderTab') {
    (async () => {
      try {
        const provider = message.provider;
        const focusWindow = message.focusWindow !== false; // Default true for backwards compat
        const providerConfig = {
          chatgpt: {
            urlPattern: PROVIDER_URLS.chatgpt.tabQuery,
            createUrl: PROVIDER_URLS.chatgpt.createUrl
          },
          grok: {
            urlPattern: PROVIDER_URLS.grok.tabQueryPatterns,
            createUrl: PROVIDER_URLS.grok.createUrl
          },
          gemini: {
            urlPattern: PROVIDER_URLS.gemini.tabQuery,
            createUrl: PROVIDER_URLS.gemini.createUrl
          }
        };
        const config = providerConfig[provider];
        if (!config) {
          sendResponse({ ok: false, error: 'UNKNOWN_PROVIDER' });
          return;
        }
        // Grok có 2 URL patterns
        const patterns = Array.isArray(config.urlPattern) ? config.urlPattern : [config.urlPattern];
        let existingTab = null;
        for (const pattern of patterns) {
          const tabs = await chrome.tabs.query({ url: pattern });
          if (tabs.length > 0) {
            existingTab = tabs[0];
            break;
          }
        }
        if (existingTab) {
          await chrome.tabs.update(existingTab.id, { active: true });
          if (focusWindow) {
            await chrome.windows.update(existingTab.windowId, { focused: true });
          }
          console.log(`[Background] Activated existing ${provider} tab:`, existingTab.id, focusWindow ? '(focused)' : '(no focus)');
          sendResponse({ ok: true, tabId: existingTab.id, existing: true });
        } else {
          const newTab = await chrome.tabs.create({ url: config.createUrl, active: true });
          if (focusWindow) {
            await chrome.windows.update(newTab.windowId, { focused: true });
          }
          console.log(`[Background] Created new ${provider} tab:`, newTab.id, focusWindow ? '(focused)' : '(no focus)');
          sendResponse({ ok: true, tabId: newTab.id, existing: false });
        }
      } catch (err) {
        console.error('[Background] openProviderTab error:', err);
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  if (message.action === 'openSettings') {
    openSettingsWindow(message.tab || null);
    sendResponse({ ok: true });
    return true;
  }

  if (message.action === 'openUpgradeModal') {
    // Relay đến sidePanel để mở upgrade modal
    chrome.runtime.sendMessage({ action: 'showUpgradeModal' }).catch(() => {});
    sendResponse({ ok: true });
    return true;
  }

  if (message.action === 'openLoginModal') {
    // Relay đến sidePanel để mở login overlay
    chrome.runtime.sendMessage({ action: 'showLoginOverlay' }).catch(() => {});
    sendResponse({ ok: true });
    return true;
  }

  if (message.action === 'openSidePanel') {
    // Mở sidePanel (gọi từ settings popup khi user click login)
    // CRITICAL: sidePanel chỉ enable trên Flow tabs (labs.google/fx), không phải tabs khác
    (async () => {
      try {
        let tabId = null;

        // 1. Tìm Flow tab đã mở
        const flowTabs = await chrome.tabs.query({ url: PROVIDER_URLS.flow.tabQuery });
        if (flowTabs.length > 0) {
          tabId = flowTabs[0].id;
          console.log('[Background] Found existing Flow tab:', tabId);
        } else {
          // 2. Không có Flow tab → tạo mới và chờ load
          console.log('[Background] No Flow tab found, creating new one');
          const newTab = await chrome.tabs.create({ url: PROVIDER_URLS.flow.createUrl });
          tabId = newTab.id;

          // Chờ tab load xong (status: complete) để sidePanel được enable
          await new Promise((resolve) => {
            const checkLoaded = (updatedTabId, info) => {
              if (updatedTabId === tabId && info.status === 'complete') {
                chrome.tabs.onUpdated.removeListener(checkLoaded);
                resolve();
              }
            };
            chrome.tabs.onUpdated.addListener(checkLoaded);
            // Timeout fallback 10s
            setTimeout(() => {
              chrome.tabs.onUpdated.removeListener(checkLoaded);
              resolve();
            }, 10000);
          });

          // Thêm delay nhỏ sau khi load để đảm bảo sidePanel được enable
          await new Promise(r => setTimeout(r, 300));
        }

        // Mở sidePanel trên Flow tab
        await chrome.sidePanel.open({ tabId });

        // Đóng settings popup nếu được yêu cầu
        // (chrome.windows.remove sẽ fire onRemoved listener → cleanup settingsWindowId + persist)
        if (message.closeSettingsWindow && settingsWindowId) {
          try {
            await chrome.windows.remove(settingsWindowId);
          } catch (e) {
            // Window đã đóng hoặc không tồn tại — fallback cleanup
            settingsWindowId = null;
            _persistWindowIds();
          }
        }

        // Thông báo sidePanel hiển thị login overlay nếu cần
        if (message.showLoginOverlay) {
          // Delay để sidePanel kịp load
          setTimeout(() => {
            chrome.runtime.sendMessage({ action: 'showLoginOverlay' }).catch(() => {});
          }, 500);
        }

        sendResponse({ ok: true });
      } catch (e) {
        console.error('[Background] openSidePanel error:', e.message, e);
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true; // async response
  }

  if (message.action === 'openWorkflowEditor') {
    openWorkflowWindow(message.data || null);
    sendResponse({ ok: true });
    return true;
  }

  // Open template editor window (với smart sizing giống workflow editor)
  if (message.action === 'openTemplateEditor') {
    openTemplateEditorWindow(message.data || null);
    sendResponse({ ok: true });
    return true;
  }

  // Preview workflow template trong popup window readonly (Phase 4 — Option A)
  if (message.action === 'openWorkflowTemplatePreview') {
    const template = message.template;
    if (!template) { sendResponse({ ok: false, error: 'NO_TEMPLATE' }); return true; }
    (async () => {
      // Stash template data cho window mới đọc + flag preview mode
      await chrome.storage.local.set({
        _pendingTemplatePreview: { template, timestamp: Date.now() },
      });
      // Reuse openWorkflowWindow logic — workflow-editor-init.js sẽ check flag
      openWorkflowWindow(null);
      sendResponse({ ok: true });
    })();
    return true;
  }

  // Relay import-from-preview-window → sidePanel WorkflowTemplateList._handleImport
  if (message.action === 'importWorkflowTemplate') {
    if (message.template) {
      chrome.storage.local.set({
        _pendingTemplateImport: { template: message.template, timestamp: Date.now() },
      });
      // Notify sidePanel to pick up
      chrome.runtime.sendMessage({ action: 'workflowTemplateImportRequested', template: message.template }).catch(() => {});
    }
    sendResponse({ ok: true });
    return true;
  }

  if (message.action === 'openAnglesEditor') {
    // Lưu project context cho angles editor
    if (message.projectId) {
      chrome.storage.local.set({
        _pendingAnglesProject: {
          projectId: message.projectId,
          projectName: message.projectName || null
        }
      });
    }
    openAnglesWindow();
    sendResponse({ ok: true });
    return true;
  }

  if (message.action === 'openEffectsEditor') {
    // Lưu project context cho effects editor
    if (message.projectId) {
      chrome.storage.local.set({
        _pendingEffectsProject: {
          projectId: message.projectId,
          projectName: message.projectName || null
        }
      });
    }
    openEffectsWindow();
    sendResponse({ ok: true });
    return true;
  }

  if (message.action === 'executionStatusUpdate') {
    // Relay execution status between popup and sidePanel
    chrome.runtime.sendMessage(message).catch(() => {});
    sendResponse({ ok: true });
    return true;
  }

  if (message.action === 'workflowSaved') {
    // Relay workflow saved event between popup editor and sidePanel
    chrome.runtime.sendMessage(message).catch(() => {});
    sendResponse({ ok: true });
    return true;
  }

  // Gap 3 fix: Relay workflow deleted event để popup editor đang mở wf_id đó biết và đóng
  if (message.action === 'workflowDeleted') {
    chrome.runtime.sendMessage(message).catch(() => {});
    // Nếu editor đang mở chính wf_id này → reset editingWorkflowId tracking
    if (editingWorkflowId && editingWorkflowId === message.wfId) {
      editingWorkflowId = null;
      _persistWindowIds();
    }
    sendResponse({ ok: true });
    return true;
  }

  // Relay workflow execution events between popup editor and sidePanel.
  // [Audit Bug 7 fix 2026-06-22, re-audit fix] Queue CHỈ khi không có receiver nào.
  //
  // Bug fix 2026-05-25 (duplicate events): chrome.runtime.sendMessage TỪ sender (popup/sidebar)
  // đã auto-broadcast tới mọi extension context. Background re-send với
  // chrome.runtime.sendMessage(message) → broadcast LẠI → sidebar nhận lần 2.
  // → Listener fire 2 lần cho cùng 1 event (execution:started/completed/...).
  // Fix: tag `_bg_relayed` để break loop. Khi re-send, set tag → handler skip nếu thấy tag.
  if (message.action === 'workflowExecutionEvent') {
    // Self-echo guard: nếu message ĐÃ có tag → đây là re-broadcast của chính background
    // → KHÔNG re-send nữa. Bản gốc đã được sender broadcast tới mọi context.
    if (message._bg_relayed) {
      sendResponse({ ok: true });
      return true;
    }
    chrome.runtime.sendMessage({ ...message, _bg_relayed: true })
      .then(() => {
        // Có receiver → không cần queue
      })
      .catch(() => {
        // Không có receiver (sidepanel đóng) → persist vào chrome.storage.session FIFO queue
        try {
          const sessionStore = chrome.storage?.session;
          if (!sessionStore) return;
          sessionStore.get(['af_execution_event_queue'], (res) => {
            const queue = Array.isArray(res?.af_execution_event_queue) ? res.af_execution_event_queue : [];
            queue.push({ ...message, _queued_at: Date.now() });
            if (queue.length > 50) queue.splice(0, queue.length - 50);
            sessionStore.set({ af_execution_event_queue: queue });
          });
        } catch (_) { /* best effort */ }
      });
    sendResponse({ ok: true });
    return true;
  }

  // Relay retry status from content.js to sidePanel for footer display
  if (message.action === 'retry:status') {
    chrome.runtime.sendMessage(message).catch(() => {});
    sendResponse({ ok: true });
    return true;
  }

  // Handle addImageToGenTab from content.js "+" overlay button
  // Store in pending queue so sidePanel can pick up when opened
  if (message.action === 'addImageToGenTab') {
    const { tileId, fileName, thumbnail } = message;
    if (!tileId) {
      sendResponse({ success: false, error: 'Missing tileId' });
      return true;
    }
    (async () => {
      try {
        // Try to relay to sidePanel first (if open)
        // Use Promise with timeout to detect if sidePanel is listening
        let sidePanelHandled = false;
        try {
          const result = await Promise.race([
            new Promise((resolve) => {
              chrome.runtime.sendMessage({
                action: 'addImageToGenTab',
                tileId, fileName, thumbnail,
                _fromBackground: true
              }, (resp) => {
                if (chrome.runtime.lastError) {
                  resolve(null);
                } else {
                  resolve(resp);
                }
              });
            }),
            new Promise(resolve => setTimeout(() => resolve(null), 200))
          ]);
          if (result?.success !== undefined) {
            sidePanelHandled = true;
            sendResponse(result);
          }
        } catch (e) {
          // sidePanel not ready
        }

        // If sidePanel didn't handle, store to pending queue
        if (!sidePanelHandled) {
          const storage = await chrome.storage.local.get(['_pendingAddToGenTab']);
          const pending = storage._pendingAddToGenTab || [];

          // Check duplicate
          if (pending.some(p => p.tileId === tileId)) {
            sendResponse({ success: true, alreadyExists: true, queued: true });
            return;
          }

          pending.push({ tileId, fileName, thumbnail, addedAt: Date.now() });
          // Keep max 20 pending items
          while (pending.length > 20) pending.shift();

          await chrome.storage.local.set({ _pendingAddToGenTab: pending });
          sendResponse({ success: true, queued: true });
        }
      } catch (e) {
        console.error('[Background] addImageToGenTab error:', e);
        sendResponse({ success: false, error: e.message });
      }
    })();
    return true; // async response
  }

  if (message.action === 'getEditingWorkflowId') {
    sendResponse({ editingWorkflowId });
    return true;
  }

  if (message.action === 'updateEditingWorkflowId') {
    editingWorkflowId = message.wfId || null;
    _persistWindowIds();
    sendResponse({ ok: true });
    return true;
  }

  if (message.action === 'getSettingsWindowId') {
    sendResponse({ windowId: settingsWindowId });
    return true;
  }

  // Relay message from settings to content script
  if (message.action === 'settingsAction') {
    chrome.tabs.query({ url: PROVIDER_URLS.flow.tabQuery }, (tabs) => {
      tabs.forEach(tab => {
        chrome.tabs.sendMessage(tab.id, message.payload);
      });
    });
    sendResponse({ ok: true });
    return true;
  }

  // Set extension badge (from NotificationManager)
  if (message.action === 'setBadge') {
    // Guard: chrome.action only exists if manifest has "action" defined
    if (chrome.action) {
      chrome.action.setBadgeText({ text: message.text || '' });
      chrome.action.setBadgeBackgroundColor({ color: '#cdff01' });
    }
    sendResponse({ success: true });
    return true;
  }

  // Show notification (from NotificationManager) - dùng chrome.notifications API
  if (message.action === 'showNotification') {
    const notifId = 'tobyflow-' + Date.now();
    chrome.notifications.create(notifId, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
      title: message.title || 'Toby Flow',
      message: message.body || '',
      priority: 2,
    }, () => {
      if (chrome.runtime.lastError) {
        console.warn('[background] Notification error:', chrome.runtime.lastError.message);
      }
    });
    // Auto-clear after 5 seconds
    setTimeout(() => {
      chrome.notifications.clear(notifId);
    }, 5000);
    sendResponse({ success: true });
    return true;
  }

  // Ensure Flow tab is ready for upload (Phase S2.1: ImmediateUploader)
  // Google Flow KHÔNG THỂ process file upload khi tab inactive
  // (tile status=failed ngay do Chrome throttle React rendering)
  // → Nếu tab inactive: tạm activate ~2s cho upload, rồi restore tab cũ
  // CRITICAL: Nhận targetTabId để đảm bảo đúng tab khi có nhiều Flow tabs
  if (message.action === 'checkFlowTabOpen' || message.action === 'ensureFlowTabReady') {
    (async () => {
      try {
        const tabs = await chrome.tabs.query({ url: PROVIDER_URLS.flow.tabQuery });
        if (!tabs || tabs.length === 0) {
          sendResponse({ isOpen: false });
          return;
        }

        // CRITICAL: Ưu tiên targetTabId từ caller (nếu có)
        let flowTab = null;
        if (message.targetTabId) {
          flowTab = tabs.find(t => t.id === message.targetTabId);
        }
        // Fallback: active tab hoặc tab đầu tiên
        if (!flowTab) {
          flowTab = tabs.find(t => t.active) || tabs[0];
        }

        // Post-audit fix: PING content script + inject nếu chưa attach.
        // Root cause "Could not establish connection. Receiving end does not exist":
        // manifest.content_scripts chỉ inject lúc navigate vào URL match → tab mở
        // TRƯỚC khi extension reload/update sẽ KHÔNG có content script attached.
        const _ensureContentScriptReady = async (tabId) => {
          try {
            const pingResult = await chrome.tabs.sendMessage(tabId, { action: 'ping' });
            if (pingResult?.pong) return { injected: false };
          } catch (_) { /* Content script không có → inject */ }
          try {
            await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
            await new Promise(r => setTimeout(r, 300));
            return { injected: true };
          } catch (e) {
            console.warn('[ensureFlowTabReady] Inject failed:', e?.message);
            return { injected: false, error: e?.message };
          }
        };

        // Nếu target tab đã active → ping + return
        if (flowTab.active) {
          const ready = await _ensureContentScriptReady(flowTab.id);
          sendResponse({ isOpen: true, tabId: flowTab.id, wasInjected: ready.injected });
          return;
        }

        // Tab tồn tại nhưng inactive → tạm activate cho upload
        // Lưu tab đang active hiện tại để restore sau
        const [currentActiveTab] = await chrome.tabs.query({ active: true, windowId: flowTab.windowId });
        const previousTabId = currentActiveTab?.id || null;

        // Activate Flow tab
        await chrome.tabs.update(flowTab.id, { active: true });
        // Chờ React rendering wake up (Chrome unthrottle ngay khi tab active)
        await new Promise(r => setTimeout(r, 600));

        // Sau khi activate → ping + inject nếu cần
        const ready = await _ensureContentScriptReady(flowTab.id);

        sendResponse({
          isOpen: true,
          tabId: flowTab.id,
          wasActivated: true,
          wasInjected: ready.injected,
          previousTabId
        });
      } catch (e) {
        sendResponse({ isOpen: false });
      }
    })();
    return true;
  }

  // Ensure Flow tab active cho download (context menu cần tab active để React render menu)
  if (message.action === 'ensureFlowTabActive') {
    (async () => {
      try {
        const tabs = await chrome.tabs.query({ url: PROVIDER_URLS.flow.tabQuery });
        if (!tabs || tabs.length === 0) {
          sendResponse({ ok: false });
          return;
        }
        const flowTab = tabs.find(t => t.active) || tabs[0];
        if (flowTab.active) {
          sendResponse({ ok: true, tabId: flowTab.id, wasActivated: false });
          return;
        }
        await chrome.tabs.update(flowTab.id, { active: true });
        sendResponse({ ok: true, tabId: flowTab.id, wasActivated: true });
      } catch (e) {
        sendResponse({ ok: false });
      }
    })();
    return true;
  }

  // Restore tab sau khi upload xong (ImmediateUploader gọi sau upload)
  if (message.action === 'restorePreviousTab') {
    if (message.previousTabId) {
      chrome.tabs.update(message.previousTabId, { active: true }).catch(() => {});
    }
    sendResponse({ ok: true });
    return true;
  }

  // PQ: Pipeline control từ FloatingTracker trong content script → relay to sidePanel
  if (message.action === 'pq:stopAll') {
    chrome.runtime.sendMessage({ action: 'queue:stop_all' }).catch(() => {});
    sendResponse({ ok: true });
    return true;
  }
  if (message.action === 'pq:stopJob') {
    chrome.runtime.sendMessage({ action: 'queue:stop_job', jobId: message.jobId }).catch(() => {});
    sendResponse({ ok: true });
    return true;
  }
  if (message.action === 'pq:pauseJob') {
    chrome.runtime.sendMessage({ action: 'queue:pause_job', jobId: message.jobId }).catch(() => {});
    sendResponse({ ok: true });
    return true;
  }
  if (message.action === 'pq:resumeJob') {
    chrome.runtime.sendMessage({ action: 'queue:resume_job', jobId: message.jobId }).catch(() => {});
    sendResponse({ ok: true });
    return true;
  }

  // ExecutionLock broadcast relay — popup ↔ sidePanel cross-window sync
  if (message.action === 'execution:lock_broadcast') {
    // Relay to all contexts (sidePanel sẽ nhận và emit lên local eventBus)
    chrome.runtime.sendMessage(message).catch(() => {});
    sendResponse({ ok: true });
    return true;
  }

  // ExecutionTracker broadcast relay — popup → sidePanel tracker update
  if (message.action === 'execution:tracker_broadcast') {
    chrome.runtime.sendMessage(message).catch(() => {});
    sendResponse({ ok: true });
    return true;
  }

  // Đóng các tabs thừa của 1 provider (giữ tabs[0], close phần còn lại).
  // Trigger từ UI duplicate warning button "Đóng tabs thừa" (2026-05-22).
  if (message.action === 'closeExtraProviderTabs') {
    (async () => {
      try {
        const provider = message.provider;
        const urlPatterns = {
          flow: PROVIDER_URLS.flow.tabQuery,
          chatgpt: PROVIDER_URLS.chatgpt.tabQuery,
          grok: PROVIDER_URLS.grok.tabQuery,
          gemini: PROVIDER_URLS.gemini.tabQuery,
        };
        const pattern = urlPatterns[provider];
        if (!pattern) {
          sendResponse({ ok: false, error: 'Unknown provider', closed: 0 });
          return;
        }
        const tabs = await chrome.tabs.query({ url: pattern });
        if (!tabs || tabs.length <= 1) {
          sendResponse({ ok: true, closed: 0, kept: tabs?.[0]?.id || null });
          return;
        }
        // Giữ tab đầu tiên (theo Chrome tabs.query order — thường là tab cũ nhất)
        const keepTab = tabs[0];
        const extras = tabs.slice(1);
        const extrasIds = extras.map(t => t.id).filter(Boolean);
        if (extrasIds.length > 0) {
          await chrome.tabs.remove(extrasIds);
        }
        console.log(`[TobyFlow] closeExtraProviderTabs(${provider}): closed ${extrasIds.length} extras, kept tabId=${keepTab.id}`);
        sendResponse({ ok: true, closed: extrasIds.length, kept: keepTab.id });
      } catch (e) {
        console.warn('[TobyFlow] closeExtraProviderTabs error:', e.message);
        sendResponse({ ok: false, error: e.message, closed: 0 });
      }
    })();
    return true;
  }

  // Query số lượng tabs đang mở của 1 provider (flow/chatgpt/grok)
  // Dùng cho duplicate-tab warning trong UI khi user click provider tab.
  if (message.action === 'queryProviderTabs') {
    (async () => {
      try {
        const provider = message.provider;
        const urlPatterns = {
          flow: PROVIDER_URLS.flow.tabQuery,
          chatgpt: PROVIDER_URLS.chatgpt.tabQuery,
          grok: PROVIDER_URLS.grok.tabQuery,
          gemini: PROVIDER_URLS.gemini.tabQuery,
        };
        const pattern = urlPatterns[provider];
        if (!pattern) {
          sendResponse({ count: 0, error: 'Unknown provider' });
          return;
        }
        const tabs = await chrome.tabs.query({ url: pattern });
        sendResponse({ count: tabs?.length || 0, tabs: (tabs || []).map(t => ({ id: t.id, url: t.url })) });
      } catch (e) {
        sendResponse({ count: 0, error: e.message });
      }
    })();
    return true;
  }

  // Activate Flow tab when execution starts (any module)
  if (message.action === 'activateFlowTabForExecution') {
    (async () => {
      try {
        const tabs = await chrome.tabs.query({ url: PROVIDER_URLS.flow.tabQuery });
        if (!tabs || tabs.length === 0) {
          sendResponse({ ok: false, error: 'No Flow tab found' });
          return;
        }
        const flowTab = tabs.find(t => t.active) || tabs[0];
        if (!flowTab.active) {
          await chrome.tabs.update(flowTab.id, { active: true });
        }
        sendResponse({ ok: true, tabId: flowTab.id });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  // Send webhook notification (proxy from content script)
  if (message.action === 'sendWebhook') {
    const { url, data } = message;
    if (!_isAllowedUrl(url)) {
      sendResponse({ success: false, error: 'URL not allowed' });
      return true;
    }
    (async () => {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        });
        sendResponse({ success: response.ok, status: response.status });
      } catch (err) {
        console.warn('[TobyFlow] Webhook send failed:', err.message);
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  // Chuẩn bị rename cho download tiếp theo từ Flow
  if (message.action === 'prepareDownloadRename') {
    // Tăng TTL từ 15s lên 30s để handle network delays
    // Thêm identifier để match chính xác khi concurrent downloads
    const renameEntry = {
      folder: message.folder || '',
      filename: message.filename || '',
      identifier: message.identifier || message.filename || '', // Match bằng filename nếu không có identifier riêng
      expires: Date.now() + 30000 // Hết hạn sau 30s (tăng từ 15s)
    };
    _pendingDownloadRenames.push(renameEntry);
    console.log(`[TobyFlow] prepareDownloadRename queued: folder="${message.folder}", filename="${message.filename}", identifier="${renameEntry.identifier}", queueSize=${_pendingDownloadRenames.length}`);
    sendResponse({ ok: true });
    return true;
  }

  // Download file via chrome.downloads API (reliable, handles Google CDN auth)
  // waitForComplete=true: đợi download hoàn tất mới trả response (dùng cho delete-after-gen flow)
  if (message.action === 'chromeDownload') {
    const { url, filename, waitForComplete } = message;

    // CRITICAL: Validate URL - reject placeholder/invalid URLs
    if (!url ||
        url.includes('media.html') ||
        url.endsWith('.html') ||
        (!url.startsWith('http://') && !url.startsWith('https://') && !url.startsWith('blob:'))) {
      console.warn(`[TobyFlow] chromeDownload: invalid/placeholder URL rejected: ${url?.substring(0, 80)}`);
      sendResponse({ success: false, error: 'Invalid or placeholder URL rejected' });
      return true;
    }

    // Debug log filename — giúp debug case folder không respect
    console.log(`[TobyFlow] chromeDownload: filename="${filename}", url="${url?.substring(0, 60)}...", waitForComplete=${!!waitForComplete}`);

    (async () => {
      try {
        // CRITICAL FIX: chrome.downloads.download không tự dùng filename nếu blob URL +
        // download item bị onDeterminingFilename listener khác override. Để chắc chắn filename
        // có folder path được Chrome respect, push vào _pendingDownloadRenames trước khi gọi
        // chrome.downloads.download — listener line 117 sẽ pick up và suggest() đúng path.
        if (filename && filename.includes('/')) {
          const lastSlash = filename.lastIndexOf('/');
          const folder = filename.substring(0, lastSlash);
          const justFile = filename.substring(lastSlash + 1);
          _pendingDownloadRenames.push({
            folder,
            filename: justFile,
            identifier: justFile,
            expires: Date.now() + 30000,
          });
          console.log(`[TobyFlow] chromeDownload: queued rename folder="${folder}", file="${justFile}"`);
        }

        const downloadId = await chrome.downloads.download({
          url,
          filename: filename || undefined,
          conflictAction: 'uniquify'
        });

        // Nếu không cần đợi complete, trả về ngay
        if (!waitForComplete) {
          sendResponse({ success: true, downloadId });
          return;
        }

        // Đợi download hoàn tất qua chrome.downloads.onChanged
        const timeout = 30000; // 30s timeout
        const startTime = Date.now();

        const waitForDownloadComplete = () => {
          return new Promise((resolve, reject) => {
            const onChanged = (delta) => {
              if (delta.id !== downloadId) return;

              // Download hoàn tất
              if (delta.state?.current === 'complete') {
                chrome.downloads.onChanged.removeListener(onChanged);
                resolve({ success: true, downloadId, state: 'complete' });
              }
              // Download bị interrupt/cancel
              else if (delta.state?.current === 'interrupted') {
                chrome.downloads.onChanged.removeListener(onChanged);
                resolve({ success: false, downloadId, state: 'interrupted', error: delta.error?.current });
              }
            };

            chrome.downloads.onChanged.addListener(onChanged);

            // Timeout fallback
            setTimeout(() => {
              chrome.downloads.onChanged.removeListener(onChanged);
              // Check trạng thái hiện tại trước khi timeout
              chrome.downloads.search({ id: downloadId }, (items) => {
                if (items?.[0]?.state === 'complete') {
                  resolve({ success: true, downloadId, state: 'complete' });
                } else {
                  resolve({ success: false, downloadId, state: 'timeout', error: 'Download timeout' });
                }
              });
            }, timeout);
          });
        };

        const result = await waitForDownloadComplete();
        console.log(`[TobyFlow] chromeDownload complete: id=${downloadId}, state=${result.state}`);
        sendResponse(result);
      } catch (err) {
        console.warn('[TobyFlow] chrome.downloads failed:', err.message);
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  // API proxy: chuyển tiếp request từ content script đến backend (tránh CORS)
  if (message.action === 'apiRequest') {
    const { method, endpoint, data, token, headers: extraHeaders, isFormData, formDataFields } = message;

    // [Fix cascade] Global rate-limit cooldown — bắt mọi caller (cả _apiCall lẫn
    // anonymous direct sendMessage). Mọi endpoint auth/* bypass để user recover login.
    const isAuthEndpoint = endpoint && endpoint.startsWith('auth/');
    if (!isAuthEndpoint && globalThis._apiRateLimitedUntil > Date.now()) {
      const retryAfter = Math.ceil((globalThis._apiRateLimitedUntil - Date.now()) / 1000);
      sendResponse({
        success: false,
        error: { code: 'RATE_LIMITED', message: `Too many requests, please try again later (${retryAfter}s)` },
        httpStatus: 429,
        // Bug fix 2026-05-25: forward retry_after để caller (AuthManager) dùng đúng cooldown
        // server-side (vd 9s) thay vì fallback 60s default → freeze toàn bộ API quá lâu.
        retry_after: retryAfter,
        data: { retry_after: retryAfter },
      });
      return true;
    }

    // Device banned → chặn cứng MỌI request (kể cả unsigned ở log_only mode). Không gửi đi.
    // Recovery qua re-enroll (focus/activation/retry) → _clearDeviceBanned gỡ cờ.
    if (_deviceBanned) {
      sendResponse({
        success: false,
        error: { code: 'DEVICE_BANNED', message: 'Device has been banned' },
        httpStatus: 403,
      });
      return true;
    }

    (async () => {
      try {
        // Phase 3.5 Bug I: dùng getApiBaseUrl() helper thay vì hardcoded fallback
        const stored = await new Promise(resolve => {
          chrome.storage.local.get(['af_auth'], result => resolve(result.af_auth || {}));
        });
        const apiBaseUrl = stored.apiBaseUrl || getApiBaseUrl();
        const url = `${apiBaseUrl}/${endpoint}`;

        // Chuẩn bị headers
        // Lưu ý: Nếu là FormData thì KHÔNG set Content-Type để browser tự thêm boundary
        const headers = {
          'Accept': 'application/json',
          'X-Extension-Id': chrome.runtime.id
        };
        if (!isFormData) {
          headers['Content-Type'] = 'application/json';
        }
        // Gửi version để backend filter node types tương thích (workflow_node_types)
        // Ext cũ (1.0.4) sẽ KHÔNG nhận types có min_extension_version > '1.0.4'
        try {
          const extVersion = chrome.runtime.getManifest()?.version;
          if (extVersion) headers['X-Ext-Version'] = extVersion;
        } catch (_) {}
        if (token) {
          headers['Authorization'] = `Bearer ${token}`;
        }
        // Forward extra headers từ caller (vd: X-Fingerprint cho UsageSync anonymous)
        if (extraHeaders && typeof extraHeaders === 'object') {
          for (const [k, v] of Object.entries(extraHeaders)) {
            if (typeof v === 'string') headers[k] = v;
          }
        }

        // Chuẩn bị fetch options
        // [Fix cache] cache: 'no-store' để Chrome KHÔNG cache response theo URL.
        // Nếu không: login với token A → cache plan=free. Sau logout, anonymous call
        // cùng URL /entitlements → Chrome serve lại plan=free từ cache → UI revert sai.
        const fetchOptions = { method, headers, cache: 'no-store' };
        if ((data || formDataFields) && method !== 'GET' && method !== 'HEAD') {
          // Hỗ trợ FormData upload (EWT-4): khi isFormData=true, formDataFields chứa
          // thông tin file đã encode base64 (vì FormData không serialize qua message)
          // Format: { file: { name, type, base64 }, ...otherFields }
          if (isFormData && formDataFields) {
            const formData = new FormData();
            for (const [key, value] of Object.entries(formDataFields)) {
              if (value && typeof value === 'object' && value.base64 && value.type) {
                // Đây là file, convert base64 → Blob
                const byteString = atob(value.base64);
                const ab = new ArrayBuffer(byteString.length);
                const ia = new Uint8Array(ab);
                for (let i = 0; i < byteString.length; i++) {
                  ia[i] = byteString.charCodeAt(i);
                }
                const blob = new Blob([ab], { type: value.type });
                formData.append(key, blob, value.name || 'file');
              } else {
                // Field thường
                formData.append(key, value);
              }
            }
            fetchOptions.body = formData;
          } else if (data) {
            fetchOptions.body = JSON.stringify(data);
          }
        }

        // Sprint 2 (HMAC): ký request với enrollment secret.
        // Skip cho /enroll (chicken-and-egg — chưa có secret) và FormData uploads
        // (multipart body khó hash deterministic + endpoints này đều auth nên không vào
        // verify.signature group). Sai mismatch trong log_only mode chỉ tạo log warn.
        const isEnrollEndpoint = typeof endpoint === 'string' && (endpoint === 'enroll' || endpoint.startsWith('enroll?'));
        let pathForSig = '';
        let bodyStringForSig = '';
        if (!isEnrollEndpoint && !isFormData) {
          try {
            pathForSig = new URL(url).pathname;
          } catch (_) {
            pathForSig = `/${String(endpoint || '').replace(/^\/+/, '')}`;
          }
          bodyStringForSig = (typeof fetchOptions.body === 'string') ? fetchOptions.body : '';
          const sigHeaders = await _buildSignatureHeaders(method || 'GET', pathForSig, bodyStringForSig);
          Object.assign(headers, sigHeaders);
        }

        let response = await fetch(url, fetchOptions);
        let httpStatus = response.status;

        // Sprint 2 (HMAC retry): nếu 403 với revoke codes → clear enrollment, re-enroll,
        // retry 1 lần với secret mới. Skip cho /enroll, FormData (body stream đã consumed).
        if (httpStatus === 403 && !isEnrollEndpoint && !isFormData) {
          let peekBody = null;
          try {
            peekBody = JSON.parse(await response.clone().text());
          } catch (_) {}
          const errCode = peekBody?.error?.code;
          if (errCode === 'CLIENT_BANNED' || errCode === 'DEVICE_BANNED') {
            // Hard-ban từ server → self-block (cờ + overlay + gate). KHÔNG clear enrollment /
            // re-enroll → giữ client_id để backend tiếp tục chặn (đóng unsigned bypass).
            // Recovery qua re-enroll probe (focus/activation/retry) khi admin restore.
            await _handleDeviceBanned(peekBody?.error?.message || 'banned');
          } else if (errCode && SIGNATURE_RETRY_CODES.has(errCode)) {
            console.warn('[Signature] 403', errCode, '→ re-enroll + retry once');
            await _clearEnrollment();
            const fresh = await _ensureEnrollment(true);
            if (fresh) {
              // Strip stale signature headers + apply fresh
              delete headers['X-Client-Id'];
              delete headers['X-Timestamp'];
              delete headers['X-Signature'];
              const newSig = await _buildSignatureHeaders(method || 'GET', pathForSig, bodyStringForSig);
              Object.assign(headers, newSig);
              response = await fetch(url, fetchOptions);
              httpStatus = response.status;
            }
          }
        }
        let body;

        // [Fix cascade] Set global cooldown ngay khi backend trả 429.
        // Đọc Retry-After header (số giây) hoặc default 60s.
        if (httpStatus === 429) {
          const retryAfterHeader = response.headers.get('Retry-After');
          const retryAfter = Number(retryAfterHeader) || 60;
          globalThis._apiRateLimitedUntil = Date.now() + retryAfter * 1000;
          console.warn(`[TobyFlow] API Proxy: 429 received, global cooldown set ${retryAfter}s`);
        }

        // Đọc response text trước, rồi parse JSON
        // Vì response body chỉ có thể đọc 1 lần, cần làm theo thứ tự này để có text khi JSON parse fail
        const responseText = await response.text();

        try {
          body = JSON.parse(responseText);
        } catch (parseErr) {
          // JSON parse failed — likely server returned HTML (error page, maintenance, redirect)
          const isHtml = responseText.trim().startsWith('<') || responseText.includes('<!DOCTYPE');
          const preview = responseText.substring(0, 200).replace(/\s+/g, ' ').trim();

          // Anti-clone short-circuit — backend luôn trả JSON, nhưng phòng trường hợp HTML 403
          // (vd reverse proxy intercept) → vẫn parse OK ở fallback bên dưới, skip ở đây.

          console.error(`[TobyFlow] API Proxy: JSON parse failed for ${endpoint}`, JSON.stringify({
            status: httpStatus,
            isHtml,
            preview: preview || '(empty response)'
          }));

          // Tạo message có ích hơn cho user
          let userMessage = 'Phản hồi không phải JSON hợp lệ';
          if (httpStatus === 429) {
            userMessage = 'Too many requests, please try again later';
          } else if (httpStatus === 502 || httpStatus === 503 || httpStatus === 504) {
            userMessage = 'Server đang bảo trì hoặc quá tải, vui lòng thử lại sau';
          } else if (httpStatus === 500) {
            userMessage = 'Lỗi server nội bộ, vui lòng thử lại sau';
          } else if (isHtml) {
            userMessage = `Server trả về HTML thay vì JSON (HTTP ${httpStatus})`;
          }

          body = {
            success: false,
            error: {
              code: httpStatus === 429 ? 'RATE_LIMITED' : 'PARSE_ERROR',
              message: userMessage,
              debug: { httpStatus, isHtml, preview: preview.substring(0, 100) }
            }
          };
        }

        // Anti-clone: detect 403 EXTENSION_NOT_AUTHORIZED → trigger clone-detected overlay.
        // Đặt sau JSON parse, trước success branch — chạy 1 lần cho mọi caller qua apiRequest.
        if (_isExtensionAuthRejection(body, httpStatus)) {
          _handleExtensionAuthRejection();
          sendResponse({
            success: false,
            error: body.error,
            httpStatus,
          });
          return;
        }

        if (body.success) {
          sendResponse({ success: true, data: body.data, meta: body.meta, httpStatus });
        } else {
          // Laravel unhandled exceptions trả `{message, exception, file, line, trace}` shape thay vì
          // convention `{success, error: {code, message, details}}`. Surface message để FE log
          // có context thay vì generic "Lỗi HTTP 500". Trace/file/line stripped khỏi response cho safety.
          let errorObj = body.error;
          if (!errorObj) {
            if (body.message || body.exception) {
              errorObj = {
                code: body.exception ? 'SERVER_EXCEPTION' : 'UNKNOWN',
                message: body.message || `Lỗi HTTP ${httpStatus}`,
                exception: body.exception, // Laravel exception class name (vd "Illuminate\\Database\\QueryException")
              };
            } else {
              errorObj = { code: 'UNKNOWN', message: `Lỗi HTTP ${httpStatus}` };
            }
          }
          // Bug fix 2026-05-25: 429 → include retry_after từ Retry-After header để caller
          // (AuthManager) dùng đúng cooldown server-side thay vì default 60s.
          const responsePayload = {
            success: false,
            error: errorObj,
            data: body.data || {},
            httpStatus,
          };
          if (httpStatus === 429) {
            const retryAfterHeader = response.headers.get('Retry-After');
            const retryAfter = Number(retryAfterHeader) || Number(body.data?.retry_after) || 60;
            responsePayload.retry_after = retryAfter;
            responsePayload.data = { ...(body.data || {}), retry_after: retryAfter };
          }
          sendResponse(responsePayload);
        }
      } catch (err) {
        console.error('[TobyFlow] API Proxy: Lỗi kết nối', err.message);
        sendResponse({
          success: false,
          error: { code: 'NETWORK_ERROR', message: err.message || 'Không thể kết nối đến server' },
          httpStatus: 0
        });
      }
    })();

    // Trả về true để giữ sendResponse cho async callback
    return true;
  }

  // === Screen Capture Handler (Q2.2) ===
  // Capture the visible tab in the focused window
  // Supports capturing from any tab using optional_host_permissions
  if (message.action === 'captureScreen') {
    (async () => {
      try {
        // Global rate limiter: Chrome giới hạn ~2 captureVisibleTab calls/second
        const now = Date.now();
        if (globalThis._lastCaptureTime && (now - globalThis._lastCaptureTime) < 600) {
          const waitMs = 600 - (now - globalThis._lastCaptureTime);
          console.log(`[TobyFlow] captureScreen rate limited, waiting ${waitMs}ms...`);
          await new Promise(r => setTimeout(r, waitMs));
        }
        globalThis._lastCaptureTime = Date.now();

        // Check if at least one Flow tab is open (required for uploading later)
        const flowTabs = await chrome.tabs.query({ url: PROVIDER_URLS.flow.tabQuery });
        if (flowTabs.length === 0) {
          sendResponse({
            success: false,
            error: 'Chưa mở Google Flow. Cần mở labs.google/fx để upload ảnh chụp.',
            action: 'openFlow'
          });
          return;
        }

        // Get the currently focused window
        const focusedWindow = await chrome.windows.getLastFocused({ populate: true });
        if (!focusedWindow || !focusedWindow.tabs) {
          sendResponse({ success: false, error: 'Không tìm thấy cửa sổ đang active' });
          return;
        }

        // Find the active tab in this window
        const activeTab = focusedWindow.tabs.find(t => t.active);
        if (!activeTab) {
          sendResponse({ success: false, error: 'Không tìm thấy tab đang active' });
          return;
        }

        console.log(`[TobyFlow] captureScreen: url=${activeTab.url?.substring(0, 50)}, windowId=${focusedWindow.id}`);

        // Helper function to attempt capture
        const attemptCapture = async () => {
          await chrome.windows.update(focusedWindow.id, { focused: true });
          await new Promise(r => setTimeout(r, 150));
          globalThis._lastCaptureTime = Date.now();
          return await chrome.tabs.captureVisibleTab(focusedWindow.id, { format: 'png' });
        };

        // Try to capture directly
        try {
          const dataUrl = await attemptCapture();
          sendResponse({ success: true, dataUrl, tabId: activeTab.id });
          return;
        } catch (e) {
          console.warn('[TobyFlow] First capture attempt failed:', e.message);

          // Rate limit error → wait and retry
          if (/quota/i.test(e?.message)) {
            console.log('[TobyFlow] Rate limit, waiting 1s...');
            await new Promise(r => setTimeout(r, 1000));
            globalThis._lastCaptureTime = Date.now();
            try {
              const dataUrl = await attemptCapture();
              sendResponse({ success: true, dataUrl, tabId: activeTab.id });
              return;
            } catch (e2) {
              console.warn('[TobyFlow] Retry after rate limit failed:', e2.message);
            }
          }

          // Permission error → check if <all_urls> optional permission is granted
          if (/permission/i.test(e?.message)) {
            // Check if we have <all_urls> permission
            const hasAllUrls = await chrome.permissions.contains({ origins: ['<all_urls>'] });
            console.log('[TobyFlow] Permission denied, hasAllUrls:', hasAllUrls);

            if (!hasAllUrls) {
              // Request user to grant optional permission
              sendResponse({
                success: false,
                error: 'Cần cấp quyền để chụp màn hình từ trang này.',
                action: 'requestCapturePermission'
              });
              return;
            }

            // Has permission but still failed - might be a special page (chrome://, etc.)
            sendResponse({
              success: false,
              error: 'Không thể chụp trang này (trang hệ thống hoặc trang đặc biệt).'
            });
            return;
          }

          // Other error
          sendResponse({
            success: false,
            error: 'Lỗi chụp màn hình: ' + (e?.message || 'Unknown error')
          });
        }
      } catch (err) {
        console.error('[TobyFlow] captureScreen error:', err.message);
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  // === Request Capture Permission Handler ===
  // Request optional <all_urls> permission for capturing any tab
  if (message.action === 'requestCapturePermission') {
    (async () => {
      try {
        // Check if already have permission
        const hasPermission = await chrome.permissions.contains({ origins: ['<all_urls>'] });
        if (hasPermission) {
          sendResponse({ success: true, granted: true, alreadyHad: true });
          return;
        }

        // Request permission - this will show Chrome's permission dialog
        const granted = await chrome.permissions.request({ origins: ['<all_urls>'] });
        console.log('[TobyFlow] Capture permission request result:', granted);
        sendResponse({ success: true, granted });
      } catch (err) {
        console.error('[TobyFlow] requestCapturePermission error:', err.message);
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  // === Open Flow Tab Handler ===
  // Open Google Flow or activate existing tab (used when Flow is not open for capture)
  if (message.action === 'openFlowTab') {
    (async () => {
      try {
        const tab = await openOrActivateTab(PROVIDER_URLS.flow.tabQuery, PROVIDER_URLS.flow.createUrl);
        sendResponse({ success: true, tabId: tab.id });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  // === Generic Open or Activate Tab Handler ===
  // Can be used for ChatGPT, Grok, Flow, etc.
  if (message.action === 'openOrActivateTab') {
    (async () => {
      try {
        const { urlPattern, createUrl, activate = true } = message;
        if (!urlPattern || !createUrl) {
          sendResponse({ success: false, error: 'Missing urlPattern or createUrl' });
          return;
        }
        const tab = await openOrActivateTab(urlPattern, createUrl, activate);
        sendResponse({ success: true, tabId: tab.id, url: tab.url });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  // === Start Crop Selection on Active Tab (Q2.4) ===
  // Inject crop overlay into ANY active tab (not just Flow)
  if (message.action === 'startCropOnActiveTab') {
    (async () => {
      try {
        // Check if at least one Flow tab is open (required for uploading later)
        const flowTabs = await chrome.tabs.query({ url: PROVIDER_URLS.flow.tabQuery });
        if (flowTabs.length === 0) {
          sendResponse({
            success: false,
            error: 'Chưa mở Google Flow. Cần mở labs.google/fx để upload ảnh chụp.',
            action: 'openFlow'
          });
          return;
        }

        // Get the currently focused window and active tab
        const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (!activeTab || !activeTab.id) {
          sendResponse({ success: false, error: 'Không tìm thấy tab đang active' });
          return;
        }

        // Skip chrome:// and edge:// URLs (cannot inject)
        if (activeTab.url?.startsWith('chrome://') || activeTab.url?.startsWith('edge://') || activeTab.url?.startsWith('about:')) {
          sendResponse({ success: false, error: 'Không thể chụp trang hệ thống (chrome://, edge://)' });
          return;
        }

        // Get locale for translations
        const storage = await chrome.storage.local.get(['af_locale']);
        const locale = storage.af_locale || 'vi';

        // Capture overlay translations
        const captureI18n = {
          vi: { captureBtn: 'Chụp', cancelBtn: 'Hủy', namePlaceholder: 'Tên ảnh (cho @mention)', areaTooSmall: 'Vùng chọn quá nhỏ' },
          en: { captureBtn: 'Capture', cancelBtn: 'Cancel', namePlaceholder: 'Image name (for @mention)', areaTooSmall: 'Selection area too small' },
          th: { captureBtn: 'จับภาพ', cancelBtn: 'ยกเลิก', namePlaceholder: 'ชื่อภาพ (สำหรับ @mention)', areaTooSmall: 'พื้นที่เลือกเล็กเกินไป' },
          ja: { captureBtn: 'キャプチャ', cancelBtn: 'キャンセル', namePlaceholder: '画像名（@mention用）', areaTooSmall: '選択範囲が小さすぎます' }
        };
        const t = captureI18n[locale] || captureI18n.vi;

        // Inject crop overlay script into the active tab
        const results = await chrome.scripting.executeScript({
          target: { tabId: activeTab.id },
          args: [t],
          func: (translations) => {
            return new Promise((resolve) => {
              // Remove existing overlay if any
              const existing = document.getElementById('tobyflow-crop-overlay');
              if (existing) existing.remove();

              // S7.2: Default name với timestamp
              const defaultName = 'capture_' + Date.now().toString(36);

              // Create overlay
              const overlay = document.createElement('div');
              overlay.id = 'tobyflow-crop-overlay';
              overlay.innerHTML = `
                <div class="tobyflow-crop-selection" id="tobyflow-crop-selection">
                  <div class="tobyflow-crop-controls" id="tobyflow-crop-controls">
                    <div class="tobyflow-crop-name-row">
                      <input type="text" id="tobyflow-crop-name-input" class="tobyflow-crop-name-input"
                        placeholder="${translations.namePlaceholder}" value="${defaultName}" maxlength="50"
                        autocomplete="off" spellcheck="false">
                    </div>
                    <div class="tobyflow-crop-btn-row">
                      <button class="tobyflow-crop-btn tobyflow-crop-btn-capture" id="tobyflow-crop-capture-btn">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                          <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path>
                          <circle cx="12" cy="13" r="4"></circle>
                        </svg>
                        ${translations.captureBtn}
                      </button>
                      <button class="tobyflow-crop-btn tobyflow-crop-btn-cancel" id="tobyflow-crop-cancel-btn">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                          <line x1="18" y1="6" x2="6" y2="18"></line>
                          <line x1="6" y1="6" x2="18" y2="18"></line>
                        </svg>
                        ${translations.cancelBtn}
                      </button>
                    </div>
                  </div>
                </div>
              `;

              // Inject styles
              const style = document.createElement('style');
              style.id = 'tobyflow-crop-styles-injected';
              style.textContent = `
                #tobyflow-crop-overlay {
                  position: fixed;
                  inset: 0;
                  background: rgba(0,0,0,0.5);
                  z-index: 2147483647;
                  cursor: crosshair;
                }
                #tobyflow-crop-overlay .tobyflow-crop-selection {
                  position: absolute;
                  border: 2px dashed #fff;
                  background: transparent;
                  display: none;
                  box-shadow: 0 0 0 9999px rgba(0,0,0,0.5);
                }
                #tobyflow-crop-overlay .tobyflow-crop-controls {
                  position: absolute;
                  bottom: -90px;
                  left: 50%;
                  transform: translateX(-50%);
                  display: none;
                  flex-direction: column;
                  gap: 8px;
                  z-index: 2147483647;
                  white-space: nowrap;
                }
                #tobyflow-crop-overlay .tobyflow-crop-controls.visible {
                  display: flex;
                }
                #tobyflow-crop-overlay .tobyflow-crop-name-row {
                  display: flex;
                  justify-content: center;
                }
                #tobyflow-crop-overlay .tobyflow-crop-name-input {
                  width: 220px;
                  padding: 8px 12px;
                  border: 1px solid rgba(255,255,255,0.3);
                  border-radius: 6px;
                  background: rgba(30,30,35,0.95);
                  color: #fff;
                  font-size: 13px;
                  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                  outline: none;
                  text-align: center;
                }
                #tobyflow-crop-overlay .tobyflow-crop-name-input:focus {
                  border-color: #cdff01;
                }
                #tobyflow-crop-overlay .tobyflow-crop-name-input::placeholder {
                  color: rgba(255,255,255,0.5);
                }
                #tobyflow-crop-overlay .tobyflow-crop-btn-row {
                  display: flex;
                  gap: 8px;
                  justify-content: center;
                }
                #tobyflow-crop-overlay .tobyflow-crop-btn {
                  display: flex;
                  align-items: center;
                  gap: 6px;
                  padding: 10px 20px;
                  border: none;
                  border-radius: 8px;
                  font-size: 14px;
                  font-weight: 500;
                  cursor: pointer;
                  transition: all 0.15s ease;
                  box-shadow: 0 4px 12px rgba(0,0,0,0.3);
                  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                }
                #tobyflow-crop-overlay .tobyflow-crop-btn svg { flex-shrink: 0; }
                #tobyflow-crop-overlay .tobyflow-crop-btn-capture {
                  background: #cdff01;
                  color: #1c1c1f;
                }
                #tobyflow-crop-overlay .tobyflow-crop-btn-capture:hover {
                  background: #d4ff33;
                  transform: scale(1.02);
                }
                #tobyflow-crop-overlay .tobyflow-crop-btn-cancel {
                  background: rgba(40,40,45,0.95);
                  color: #fff;
                  border: 1px solid rgba(255,255,255,0.15);
                }
                #tobyflow-crop-overlay .tobyflow-crop-btn-cancel:hover {
                  background: rgba(60,60,65,0.95);
                }
              `;
              document.head.appendChild(style);
              document.body.appendChild(overlay);

              // Selection state
              let startX = 0, startY = 0;
              let isDrawing = false;
              const selection = document.getElementById('tobyflow-crop-selection');
              const controls = document.getElementById('tobyflow-crop-controls');

              // Mouse handlers
              overlay.addEventListener('mousedown', (e) => {
                if (e.target.closest('.tobyflow-crop-controls')) return;
                isDrawing = true;
                controls.classList.remove('visible');
                startX = e.clientX;
                startY = e.clientY;
                selection.style.left = startX + 'px';
                selection.style.top = startY + 'px';
                selection.style.width = '0px';
                selection.style.height = '0px';
                selection.style.display = 'block';
              });

              overlay.addEventListener('mousemove', (e) => {
                if (!isDrawing) return;
                const w = e.clientX - startX;
                const h = e.clientY - startY;
                if (w < 0) {
                  selection.style.left = e.clientX + 'px';
                  selection.style.width = (-w) + 'px';
                } else {
                  selection.style.left = startX + 'px';
                  selection.style.width = w + 'px';
                }
                if (h < 0) {
                  selection.style.top = e.clientY + 'px';
                  selection.style.height = (-h) + 'px';
                } else {
                  selection.style.top = startY + 'px';
                  selection.style.height = h + 'px';
                }
              });

              overlay.addEventListener('mouseup', () => {
                if (!isDrawing) return;
                isDrawing = false;
                const rect = selection.getBoundingClientRect();
                if (rect.width >= 20 && rect.height >= 20) {
                  controls.classList.add('visible');
                }
              });

              // Capture button - S7.3: Truyền name về cùng với cropRect
              document.getElementById('tobyflow-crop-capture-btn').addEventListener('click', () => {
                const rect = selection.getBoundingClientRect();
                const cropRect = {
                  x: Math.round(rect.left * window.devicePixelRatio),
                  y: Math.round(rect.top * window.devicePixelRatio),
                  width: Math.round(rect.width * window.devicePixelRatio),
                  height: Math.round(rect.height * window.devicePixelRatio)
                };
                // S7.3: Lấy tên ảnh từ input
                const nameInput = document.getElementById('tobyflow-crop-name-input');
                let captureName = (nameInput?.value || '').trim();
                // Sanitize name: chỉ giữ alphanumeric và underscore
                captureName = captureName.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 50);
                if (!captureName) {
                  captureName = 'capture_' + Date.now().toString(36);
                }

                overlay.remove();
                document.getElementById('tobyflow-crop-styles-injected')?.remove();
                if (cropRect.width < 20 || cropRect.height < 20) {
                  resolve({ success: false, error: translations.areaTooSmall });
                } else {
                  resolve({ success: true, cropRect, captureName });
                }
              });

              // Cancel button
              document.getElementById('tobyflow-crop-cancel-btn').addEventListener('click', () => {
                overlay.remove();
                document.getElementById('tobyflow-crop-styles-injected')?.remove();
                resolve({ success: false, cancelled: true });
              });

              // ESC key to cancel
              const escHandler = (e) => {
                if (e.key === 'Escape') {
                  overlay.remove();
                  document.getElementById('tobyflow-crop-styles-injected')?.remove();
                  document.removeEventListener('keydown', escHandler);
                  resolve({ success: false, cancelled: true });
                }
              };
              document.addEventListener('keydown', escHandler);
            });
          }
        });

        // Get result from injected script
        const result = results?.[0]?.result;
        if (result) {
          sendResponse({ ...result, tabId: activeTab.id });
        } else {
          sendResponse({ success: false, error: 'Không thể inject overlay vào trang này' });
        }
      } catch (err) {
        console.error('[TobyFlow] startCropOnActiveTab error:', err.message);
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  if (message.action === 'navigateToProject') {
    const url = message.url;
    (async () => {
      try {
        const tabs = await chrome.tabs.query({ url: PROVIDER_URLS.flow.tabQuery });
        if (tabs.length > 0) {
          await chrome.tabs.update(tabs[0].id, { url, active: true });
          await chrome.windows.update(tabs[0].windowId, { focused: true });
        } else {
          await chrome.tabs.create({ url });
        }
        sendResponse({ success: true });
      } catch (e) {
        sendResponse({ success: false, error: e.message });
      }
    })();
    return true;
  }

  if (message.action === 'clickCreateNewProject') {
    (async () => {
      try {
        const tabs = await chrome.tabs.query({ url: PROVIDER_URLS.flow.tabQuery });
        if (tabs.length === 0) {
          sendResponse({ success: false, error: 'Không tìm thấy tab Flow' });
          return;
        }
        // Target: active flow tab (đã activate bởi _createNewProject/navigateToProject) → fallback tabs[0].
        const target = tabs.find(t => t.active) || tabs[0];

        // Bug fix 2026-05-28: ĐỢI tab load xong trước khi inject. Sau navigateToProject (reload URL),
        // page chưa render React SPA → inject sớm → script chạy trên page đang load (hoặc bị reload kill)
        // → poll không thấy nút → "redirect nhưng không click". Đợi status='complete' (tới ~8s).
        for (let i = 0; i < 40; i++) {
          let st;
          try { st = (await chrome.tabs.get(target.id))?.status; } catch (_) { break; }
          if (st === 'complete') break;
          await new Promise(r => setTimeout(r, 200));
        }

        // Strict Server-Only: button matchers từ provider_configs.dom_selector.new_project_button
        // (text_match + icon_text + selectors) + icon_element selector. Fallback degraded nếu cache miss.
        const storage = await new Promise(r => chrome.storage.local.get(['toby_provider_configs'], r));
        const flowSel = storage?.toby_provider_configs?.data?.flow?.dom_selectors || {};
        const npCfg = flowSel.new_project_button || {};
        const iconText = Array.isArray(npCfg.icon_text) && npCfg.icon_text.length ? npCfg.icon_text : ['add_2', 'add', 'add_circle'];
        const textMatch = Array.isArray(npCfg.text_match) && npCfg.text_match.length ? npCfg.text_match : ['New project', 'Dự án mới', 'Create new project', 'Tạo dự án'];
        const btnSelectors = (Array.isArray(npCfg.selectors) && npCfg.selectors.length ? npCfg.selectors : ['button', '[role="button"]']).join(', ');
        const iconSelectorJoined = (Array.isArray(flowSel.icon_element?.selectors) && flowSel.icon_element.selectors.length
          ? flowSel.icon_element.selectors : ['i.google-symbols']).join(', ');

        // Inject polling script — Flow React SPA, nút có thể render trễ sau load → poll 12s.
        const results = await chrome.scripting.executeScript({
          target: { tabId: target.id },
          args: [iconSelectorJoined, iconText, textMatch, btnSelectors],
          func: (ICON_SELECTOR, ICON_TEXT, TEXT_MATCH, BTN_SEL) => {
            return new Promise((resolve) => {
              const maxWait = 12000;
              const interval = 500;
              let elapsed = 0;

              // Flow React SPA — btn.click() thuần đôi khi KHÔNG trigger onClick (handler nghe
              // pointer/synthetic). Dùng full event sequence + React props.onClick (pattern chatgpt/grok).
              function robustClick(el) {
                const opts = { bubbles: true, cancelable: true, view: window, button: 0 };
                try { el.dispatchEvent(new PointerEvent('pointerdown', opts)); } catch (_) {}
                try { el.dispatchEvent(new MouseEvent('mousedown', opts)); } catch (_) {}
                try { el.dispatchEvent(new PointerEvent('pointerup', opts)); } catch (_) {}
                try { el.dispatchEvent(new MouseEvent('mouseup', opts)); } catch (_) {}
                try { el.dispatchEvent(new MouseEvent('click', opts)); } catch (_) {}
                try {
                  const k = Object.keys(el).find(x => x.startsWith('__reactProps$'));
                  if (k && typeof el[k]?.onClick === 'function') {
                    el[k].onClick({ preventDefault() {}, stopPropagation() {}, nativeEvent: new MouseEvent('click', opts), type: 'click', target: el, currentTarget: el, button: 0 });
                  }
                } catch (_) {}
              }

              function tryClick() {
                const candidates = document.querySelectorAll(BTN_SEL);
                // Strategy 1: icon match (Material Symbol 'add_2' trong <i class="google-symbols">)
                for (const el of candidates) {
                  const icons = el.querySelectorAll(ICON_SELECTOR);
                  for (const icon of icons) {
                    if (ICON_TEXT.includes((icon.textContent || '').trim())) {
                      robustClick(el);
                      resolve({ clicked: true, method: 'icon' });
                      return;
                    }
                  }
                }
                // Strategy 2: text match (text nút, đa ngôn ngữ)
                for (const el of candidates) {
                  const text = (el.textContent || '').trim();
                  if (TEXT_MATCH.some(m => text.includes(m))) {
                    robustClick(el);
                    resolve({ clicked: true, method: 'text' });
                    return;
                  }
                }

                elapsed += interval;
                if (elapsed >= maxWait) resolve({ clicked: false, error: 'timeout' });
                else setTimeout(tryClick, interval);
              }

              tryClick();
            });
          }
        });
        const result = results?.[0]?.result;
        sendResponse({ success: !!result?.clicked, result });
      } catch (e) {
        sendResponse({ success: false, error: e.message });
      }
    })();
    return true;
  }

  if (message.action === 'getFlowProjectContext') {
    (async () => {
      try {
        const tabs = await chrome.tabs.query({ url: PROVIDER_URLS.flow.tabQuery });
        if (tabs.length > 0) {
          // Ưu tiên active tab, fallback tab đầu tiên
          const activeTab = tabs.find(t => t.active) || tabs[0];
          chrome.tabs.sendMessage(activeTab.id, { action: 'getProjectContext' }, (resp) => {
            if (chrome.runtime.lastError) {
              sendResponse({ projectId: null, tabId: activeTab.id });
              return;
            }
            // CRITICAL: Include tabId + tabTitle để sidePanel có thể track target tab + fallback name
            sendResponse({ ...(resp || { projectId: null }), tabId: activeTab.id, tabTitle: activeTab.title || null });
          });
        } else {
          sendResponse({ projectId: null, tabId: null });
        }
      } catch (e) {
        sendResponse({ projectId: null, tabId: null });
      }
    })();
    return true;
  }

  // Fetch blob tu URL (dung cho TelegramExecutor upload ref image, bypass CORS)
  if (message.action === 'fetchBlob') {
    if (!_isAllowedUrl(message.url)) {
      sendResponse({ success: false, error: 'URL not allowed' });
      return true;
    }
    (async () => {
      try {
        const resp = await fetch(message.url);
        if (!resp.ok) {
          sendResponse({ success: false, error: `HTTP ${resp.status} ${resp.statusText}` });
          return;
        }
        const contentType = resp.headers.get('content-type') || '';
        // Reject non-image responses (e.g. HTML error pages)
        if (message.expectImage && !contentType.startsWith('image/')) {
          sendResponse({ success: false, error: `Not an image: ${contentType}` });
          return;
        }
        const buffer = await resp.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        const base64 = btoa(binary);
        sendResponse({ success: true, base64, contentType });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  // Check if image URL is still valid (lightweight GET with small range)
  if (message.action === 'checkImageUrl') {
    (async () => {
      try {
        // Google CDN may not support HEAD properly, use GET with range
        const resp = await fetch(message.url, {
          method: 'GET',
          headers: { 'Range': 'bytes=0-0' }
        });
        // 200 or 206 = alive, 404 = dead
        const alive = resp.status >= 200 && resp.status < 400;
        console.log('[checkImageUrl]', message.url.substring(0, 80), '→', resp.status, alive ? 'alive' : 'dead');
        sendResponse({ success: true, alive, status: resp.status });
      } catch (err) {
        console.log('[checkImageUrl] error:', err.message);
        sendResponse({ success: true, alive: false, error: err.message });
      }
    })();
    return true;
  }

  // === Chat AI Integration (Phase X) ===
  // Gửi tin nhắn + ảnh đến ChatGPT hoặc Gemini qua content script
  // FIX: Chỉ tìm/tạo tab trong CÙNG window với tab hiện tại (không mở window mới)
  if (message.action === 'chatAI:send') {
    const { model, text, images } = message;
    const targetUrl = model === 'chatgpt' ? PROVIDER_URLS.chatgpt.createUrl : PROVIDER_URLS.gemini.createUrl;
    const queryUrl = model === 'chatgpt' ? PROVIDER_URLS.chatgpt.tabQuery : PROVIDER_URLS.gemini.tabQuery;
    const scriptFile = model === 'chatgpt' ? 'chat-content-chatgpt.js' : 'chat-content-gemini.js';

    (async () => {
      try {
        // Lấy windowId: từ sender tab, hoặc lấy focused window (khi gửi từ sidePanel)
        let currentWindowId = sender.tab?.windowId;
        if (!currentWindowId) {
          const focusedWindow = await chrome.windows.getCurrent();
          currentWindowId = focusedWindow?.id;
        }

        // 1. Tìm hoặc tạo tab trong CÙNG WINDOW
        let tabs = await chrome.tabs.query({ url: queryUrl, windowId: currentWindowId });
        let tabId;

        if (tabs.length > 0) {
          tabId = tabs[0].id;
          await chrome.tabs.update(tabId, { active: true });
          // Nếu tab đã load xong → không cần navigate lại
          const tabInfo = await chrome.tabs.get(tabId);
          if (tabInfo.status !== 'complete') {
            // Tab đang loading → chờ load xong
            await new Promise((resolve, reject) => {
              const timeout = setTimeout(() => {
                chrome.tabs.onUpdated.removeListener(listener);
                reject(new Error('Timeout chờ tải trang'));
              }, 15000);

              const listener = (updatedTabId, changeInfo) => {
                if (updatedTabId === tabId && changeInfo.status === 'complete') {
                  clearTimeout(timeout);
                  chrome.tabs.onUpdated.removeListener(listener);
                  resolve();
                }
              };
              chrome.tabs.onUpdated.addListener(listener);
            });
          }
        } else {
          // Tạo tab mới TRONG CÙNG WINDOW và chờ load xong
          const tab = await chrome.tabs.create({ url: targetUrl, active: true, windowId: currentWindowId });
          tabId = tab.id;

          await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
              chrome.tabs.onUpdated.removeListener(listener);
              reject(new Error('Timeout chờ tải trang'));
            }, 15000);

            const listener = (updatedTabId, changeInfo) => {
              if (updatedTabId === tabId && changeInfo.status === 'complete') {
                clearTimeout(timeout);
                chrome.tabs.onUpdated.removeListener(listener);
                resolve();
              }
            };
            chrome.tabs.onUpdated.addListener(listener);
          });
        }

        // 2. Chờ trang khởi tạo JS đầy đủ
        await new Promise(r => setTimeout(r, 2000));

        // 3. Inject content script tương ứng
        await chrome.scripting.executeScript({
          target: { tabId },
          files: [scriptFile]
        });

        // 4. Chờ content script sẵn sàng
        await new Promise(r => setTimeout(r, 500));

        // 5. Gửi lệnh thực thi đến content script
        chrome.tabs.sendMessage(tabId, {
          action: 'chatAI:execute',
          text,
          images
        }, (resp) => {
          if (chrome.runtime.lastError) {
            sendResponse({ success: false, error: chrome.runtime.lastError.message || 'Không nhận được phản hồi' });
            return;
          }
          sendResponse(resp || { success: true });
        });

      } catch (err) {
        console.error('[TobyFlow] chatAI:send error:', err.message);
        sendResponse({ success: false, error: err.message || 'Lỗi không xác định' });
      }
    })();

    return true; // Giữ sendResponse cho async callback
  }

  // === OAuth Google Success (Phase AU-4.13) ===
  // Nhận token từ OAuth success page → gọi /auth/me → lưu vào af_auth → notify sidePanel
  if (message.action === 'oauth:success') {
    const senderUrl = sender.tab?.url || '';
    if (!senderUrl.includes('/auth/google/success')) {
      sendResponse({ success: false, error: 'Invalid sender URL' });
      return true;
    }
    const { token } = message;
    if (token) {
      (async () => {
        try {
          // Lấy apiBaseUrl hiện tại
          const stored = await new Promise(resolve => {
            chrome.storage.local.get(['af_auth'], result => resolve(result.af_auth || {}));
          });
          // Phase 3.5 Bug I: dùng getApiBaseUrl() helper
          const apiBaseUrl = stored.apiBaseUrl || getApiBaseUrl();

          // Nếu có user cũ đang login, xóa SSE session của họ trước (fire-and-forget)
          // Điều này đảm bảo session SSE cũ được cleanup khi switch account qua Google OAuth
          if (stored.token && stored.user) {
            console.log('[TobyFlow] OAuth: clearing SSE session for previous user');
            fetch(`${apiBaseUrl}/sse/end-session`, {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${stored.token}`,
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'X-Extension-Id': chrome.runtime.id,
              }
            }).then(async (resp) => {
              if (resp.status === 403) {
                try {
                  const body = await resp.clone().json();
                  if (_isExtensionAuthRejection(body, 403)) _handleExtensionAuthRejection();
                } catch (_) {}
              }
            }).catch(() => {
              // Silent fail - expected khi token đã hết hạn
            });
          }

          // Gọi /auth/me để lấy user data đầy đủ (bao gồm google_id)
          let user = null;
          try {
            const resp = await fetch(`${apiBaseUrl}/auth/me`, {
              method: 'GET',
              headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/json',
                'X-Extension-Id': chrome.runtime.id,
              }
            });
            if (resp.status === 403) {
              try {
                const body = await resp.clone().json();
                if (_isExtensionAuthRejection(body, 403)) _handleExtensionAuthRejection();
              } catch (_) {}
            }
            if (resp.ok) {
              const data = await resp.json();
              user = data?.data?.user || data?.user || null;
              console.log('[TobyFlow] OAuth: fetched user data from /auth/me', user?.google_id ? 'with google_id' : 'without google_id');
            }
          } catch (fetchErr) {
            console.warn('[TobyFlow] OAuth: failed to fetch /auth/me, continuing with null user', fetchErr.message);
          }

          // Lưu auth data
          await new Promise(resolve => {
            chrome.storage.local.set({
              af_auth: {
                token,
                user,
                apiBaseUrl,
                savedAt: Date.now()
              }
            }, resolve);
          });

          console.log('[TobyFlow] OAuth success: token saved');

          // Notify tất cả contexts (sidePanel, popups)
          chrome.runtime.sendMessage({
            action: 'auth:oauthLogin',
            token,
            user
          }).catch(() => {});

          // Sau khi login success: đóng OAuth tab + activate Google Flow tab.
          // Delay 1.5s để user thấy "Đăng nhập thành công" rồi tab đóng.
          if (sender.tab?.id) {
            const oauthTabId = sender.tab.id;
            const oauthWindowId = sender.tab.windowId;
            setTimeout(async () => {
              try {
                await chrome.tabs.remove(oauthTabId);
              } catch (err) {
                console.warn('[TobyFlow] Không thể đóng OAuth tab:', err.message);
              }
              // Tìm Flow tab trong cùng window (hoặc bất kỳ window nếu không có)
              // và activate nó để user tiếp tục thao tác.
              try {
                let flowTabs = await chrome.tabs.query({
                  url: PROVIDER_URLS.flow.tabQuery,
                  windowId: oauthWindowId,
                });
                if (!flowTabs.length) {
                  flowTabs = await chrome.tabs.query({ url: PROVIDER_URLS.flow.tabQuery });
                }
                if (flowTabs.length > 0) {
                  const flowTab = flowTabs[0];
                  await chrome.tabs.update(flowTab.id, { active: true });
                  if (flowTab.windowId !== undefined) {
                    await chrome.windows.update(flowTab.windowId, { focused: true });
                  }
                  console.log('[TobyFlow] Activated Flow tab sau OAuth login');
                } else {
                  console.log('[TobyFlow] Không tìm thấy Flow tab để activate');
                }
              } catch (err) {
                console.warn('[TobyFlow] Không thể activate Flow tab:', err.message);
              }
            }, 1500);
          }

          sendResponse({ success: true });
        } catch (err) {
          console.error('[TobyFlow] OAuth save error:', err.message);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }
    sendResponse({ success: false, error: 'Missing token' });
    return true;
  }

  // === OAuth Google Link Success (Phase AU-4.14) ===
  // Nhận thông báo từ OAuth success page (link flow) → notify sidePanel/settings
  if (message.action === 'oauth:linked') {
    const senderUrl = sender.tab?.url || '';
    if (!senderUrl.includes('/auth/google/success')) {
      sendResponse({ success: false, error: 'Invalid sender URL' });
      return true;
    }

    console.log('[TobyFlow] Google link success: notifying extension');

    // Notify tất cả contexts (sidePanel, settings popup)
    chrome.runtime.sendMessage({
      action: 'auth:googleLinked'
    }).catch(() => {});

    sendResponse({ success: true });
    return true;
  }

  // Payment success callback from checkout page
  if (message.action === 'payment:success') {
    // Relay to all extension contexts (sidePanel, popups)
    chrome.runtime.sendMessage({
      action: 'payment:completed',
      orderId: message.orderId,
      status: message.status || 'paid'
    }).catch(() => {});
    sendResponse({ ok: true });
    return true;
  }

  // Payment cancelled callback from checkout page
  if (message.action === 'payment:cancelled') {
    chrome.runtime.sendMessage({
      action: 'payment:cancelled',
      orderId: message.orderId
    }).catch(() => {});
    sendResponse({ ok: true });
    return true;
  }

  // ============================================================
  // === Phase CG-2: ChatGPT Session Manager handlers ============
  // ============================================================
  // Các action `chatgpt:*` riêng biệt với `chatAI:send` (Phase X).
  // Dùng cho ChatGPTSession.js phía sidePanel để quản lý tab + image mode.
  // ============================================================

  // Helper sleep dùng chung trong các executeScript func bên dưới
  // (Khai báo inline trong từng func vì func chạy ở context tab khác — không có closure).
  // Inline pattern: `const sleep = (ms) => new Promise(r => setTimeout(r, ms));`

  if (message.action === 'chatgpt:findOrCreateTab') {
    const { createIfMissing = true, activate = true } = message;
    (async () => {
      try {
        // Lấy windowId từ sender hoặc focused window
        let currentWindowId = sender.tab?.windowId;
        if (!currentWindowId) {
          const focusedWindow = await chrome.windows.getCurrent();
          currentWindowId = focusedWindow?.id;
        }

        // Tìm tab chatgpt.com — ưu tiên trong cùng window
        let tabs = await chrome.tabs.query({ url: PROVIDER_URLS.chatgpt.tabQuery, windowId: currentWindowId });
        if (tabs.length === 0) {
          // Fallback: tìm trên mọi window
          tabs = await chrome.tabs.query({ url: PROVIDER_URLS.chatgpt.tabQuery });
        }

        let tabId;
        if (tabs.length > 0) {
          tabId = tabs[0].id;
        } else if (createIfMissing) {
          const tab = await chrome.tabs.create({
            url: PROVIDER_URLS.chatgpt.createUrl,
            active: !!activate,
            windowId: currentWindowId,
          });
          tabId = tab.id;
          // Chờ tab load xong (max 15s)
          await new Promise((resolve) => {
            const timeout = setTimeout(() => {
              chrome.tabs.onUpdated.removeListener(listener);
              resolve();
            }, 15000);
            const listener = (updatedTabId, changeInfo) => {
              if (updatedTabId === tabId && changeInfo.status === 'complete') {
                clearTimeout(timeout);
                chrome.tabs.onUpdated.removeListener(listener);
                resolve();
              }
            };
            chrome.tabs.onUpdated.addListener(listener);
          });
        } else {
          sendResponse({ success: false, error: 'NO_TAB' });
          return;
        }

        sendResponse({ success: true, tabId });
      } catch (err) {
        console.error('[TobyFlow] chatgpt:findOrCreateTab error:', err.message);
        sendResponse({ success: false, error: err.message || 'NO_TAB' });
      }
    })();
    return true;
  }

  if (message.action === 'chatgpt:ensureActive') {
    // Support 2 caller patterns: sidePanel pass tabId, content script fallback sender.tab.id
    const tabId = message.tabId || sender?.tab?.id;
    const focusWindow = message.focusWindow === true;
    const navigateToHome = message.navigateToHome === true;
    (async () => {
      try {
        if (!tabId) { sendResponse({ success: false, error: 'NO_TAB' }); return; }
        let tabInfo = await chrome.tabs.get(tabId);

        // Navigate về homepage nếu đang ở conversation page (fix image mode bug)
        // GenTab pattern: navigate về homepage → tạo new chat → UI state reset
        // forceRefresh: luôn navigate ngay cả khi đã ở homepage (fix stale React state)
        const isAtHomepage = tabInfo.url && tabInfo.url.match(/^https:\/\/chatgpt\.com\/?(\?|#|$)/);
        const shouldNavigate = navigateToHome && (!isAtHomepage || message.forceRefresh);
        if (shouldNavigate) {
          console.log('[TobyFlow] chatgpt:ensureActive navigating to homepage from:', tabInfo.url, 'forceRefresh:', !!message.forceRefresh);
          // Thêm timestamp query để force React re-render khi đã ở homepage
          const targetUrl = isAtHomepage ? `https://chatgpt.com/?_t=${Date.now()}` : 'https://chatgpt.com/';
          await chrome.tabs.update(tabId, { url: targetUrl });

          // Đợi page load complete
          await new Promise((resolve) => {
            const checkComplete = async () => {
              try {
                const tab = await chrome.tabs.get(tabId);
                if (tab.status === 'complete' && tab.url?.includes('chatgpt.com')) {
                  resolve();
                } else {
                  setTimeout(checkComplete, 200);
                }
              } catch { resolve(); }
            };
            setTimeout(checkComplete, 300);
          });

          // Đợi React hydration — giảm 800→400ms (preflight poll loop sẽ verify ready)
          await new Promise(r => setTimeout(r, 400));
          tabInfo = await chrome.tabs.get(tabId);
          console.log('[TobyFlow] chatgpt:ensureActive homepage navigation complete');
        }

        if (!tabInfo.active) {
          await chrome.tabs.update(tabId, { active: true });
          // Chờ React unthrottle (300ms — pattern giống Flow tab)
          await new Promise(r => setTimeout(r, 300));
        }
        // Cloudflare/captcha challenge: bring window to front + drawAttention.
        if (focusWindow && tabInfo.windowId) {
          try {
            await chrome.windows.update(tabInfo.windowId, { focused: true, drawAttention: true });
          } catch (winErr) {
            console.warn('[TobyFlow] chatgpt:ensureActive focusWindow failed:', winErr.message);
          }
        }
        sendResponse({ success: true, active: true });
      } catch (err) {
        console.error('[TobyFlow] chatgpt:ensureActive error:', err.message);
        sendResponse({ success: false, error: err.message || 'ACTIVATE_FAILED' });
      }
    })();
    return true;
  }

  if (message.action === 'chatgpt:injectScript') {
    const { tabId } = message;
    (async () => {
      try {
        if (!tabId) { sendResponse({ success: false, error: 'NO_TAB' }); return; }

        // 2026-05-25: Pre-check tab URL — tab có thể đã redirect login (auth.openai.com /
        // accounts.google.com) giữa lúc findOrCreateTab và injectScript fire. executeScript
        // sẽ fail "Cannot access contents..." vì URL mới không match host_permissions.
        // Skip silent thay vì log error spam.
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        if (!tab?.url || !tab.url.startsWith('https://chatgpt.com/')) {
          sendResponse({ success: false, error: 'NOT_CHATGPT_URL', url: tab?.url || '' });
          return;
        }

        // Kiểm tra flag double-inject — nếu đã có thì không inject lại
        const checkResults = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => !!window.__tobyflowChatGPTLoaded__,
        });
        const alreadyLoaded = !!(checkResults && checkResults[0] && checkResults[0].result);

        if (!alreadyLoaded) {
          await chrome.scripting.executeScript({
            target: { tabId },
            files: ['chat-content-chatgpt.js'],
          });
        }
        sendResponse({ success: true, alreadyLoaded });
      } catch (err) {
        // Demote error → warn (host permission fail = harmless race, không phải crash)
        console.warn('[TobyFlow] chatgpt:injectScript skipped:', err.message);
        sendResponse({ success: false, error: err.message || 'INJECT_FAILED' });
      }
    })();
    return true;
  }

  if (message.action === 'chatgpt:checkLogin') {
    const { tabId } = message;
    (async () => {
      try {
        if (!tabId) { sendResponse({ success: false, error: 'NO_TAB' }); return; }

        // [Server-Only refactor 2026-05-24] Đọc selectors + text patterns từ chrome.storage thay hardcode.
        // - Selectors: toby_provider_configs.chatgpt.dom_selectors.{composer,login_button,auth_link}
        // - Text patterns: af_chatgpt_config.data.not_logged_in_text (split by '|')
        // Admin tune qua /admin/providers/chatgpt khi OpenAI đổi UI → SSE auto sync.
        const storage = await chrome.storage.local.get(['toby_provider_configs', 'af_chatgpt_config']);
        const chatgptSelectors = storage?.toby_provider_configs?.data?.chatgpt?.dom_selectors || {};
        const composerSelectors = chatgptSelectors?.composer?.selectors || ['#prompt-textarea'];
        const loginBtnSelectors = chatgptSelectors?.login_button?.selectors || ['[data-testid="login-button"]'];
        const authLinkSelectors = chatgptSelectors?.auth_link?.selectors || ['a[href*="/auth/login"]'];

        const notLoggedInRaw = storage?.af_chatgpt_config?.data?.not_logged_in_text || '';
        const notLoggedInPatterns = notLoggedInRaw
          .split('|')
          .map(s => s.trim().toLowerCase())
          .filter(Boolean);

        const args = {
          composerSelectors,
          loginBtnSelectors,
          authLinkSelectors,
          notLoggedInPatterns,
        };

        const results = await chrome.scripting.executeScript({
          target: { tabId },
          args: [args],
          // Func phải standalone — không reference closure outside
          func: function checkLoginStatus(cfg) {
            const queryFirst = (selectors) => {
              if (!Array.isArray(selectors)) return null;
              for (const sel of selectors) {
                try {
                  const el = document.querySelector(sel);
                  if (el) return el;
                } catch (_) { /* invalid selector skip */ }
              }
              return null;
            };

            const editor = queryFirst(cfg.composerSelectors);
            const loginBtn = queryFirst(cfg.loginBtnSelectors);
            const loginLink = queryFirst(cfg.authLinkSelectors);

            // Text-based fallback (defensive nếu OpenAI đổi data-testid)
            let signInTextBtn = null;
            if (cfg.notLoggedInPatterns && cfg.notLoggedInPatterns.length > 0) {
              try {
                const buttons = document.querySelectorAll('button');
                for (const btn of buttons) {
                  const text = (btn.textContent || '').trim().toLowerCase();
                  if (!text || text.length > 30) continue; // skip empty + long text
                  if (cfg.notLoggedInPatterns.some(p => text === p || text.includes(p))) {
                    signInTextBtn = btn;
                    break;
                  }
                }
              } catch (_) { /* ignore */ }
            }

            if (!editor) return { ready: false, error: 'EDITOR_NOT_FOUND' };
            if (loginBtn || loginLink || signInTextBtn) {
              return {
                ready: false,
                error: 'NOT_LOGGED_IN',
                _detected: signInTextBtn ? 'text_pattern' : (loginBtn ? 'login_button' : 'auth_link'),
              };
            }
            return { ready: true };
          },
        });
        const result = (results && results[0] && results[0].result) || { ready: false, error: 'EDITOR_NOT_FOUND' };
        if (result._detected) {
          console.log('[TobyFlow] chatgpt:checkLogin NOT_LOGGED_IN detected via:', result._detected);
        }
        delete result._detected; // internal field, không gửi consumer
        sendResponse({ success: true, ...result });
      } catch (err) {
        console.error('[TobyFlow] chatgpt:checkLogin error:', err.message);
        sendResponse({ success: false, error: err.message || 'CHECK_FAILED' });
      }
    })();
    return true;
  }

  // ===========================================================================
  // Phase CG-8: Gemini handlers (stub minimal — text-only Prompt node enhance)
  // ===========================================================================

  if (message.action === 'gemini:findOrCreateTab') {
    const { createIfMissing = true, activate = true } = message;
    (async () => {
      try {
        let currentWindowId = sender.tab?.windowId;
        if (!currentWindowId) {
          const focusedWindow = await chrome.windows.getCurrent();
          currentWindowId = focusedWindow?.id;
        }

        let tabs = await chrome.tabs.query({ url: PROVIDER_URLS.gemini.tabQuery, windowId: currentWindowId });
        if (tabs.length === 0) {
          tabs = await chrome.tabs.query({ url: PROVIDER_URLS.gemini.tabQuery });
        }

        let tabId;
        if (tabs.length > 0) {
          tabId = tabs[0].id;
        } else if (createIfMissing) {
          const tab = await chrome.tabs.create({
            url: PROVIDER_URLS.gemini.createUrl,
            active: !!activate,
            windowId: currentWindowId,
          });
          tabId = tab.id;
          await new Promise((resolve) => {
            const timeout = setTimeout(() => {
              chrome.tabs.onUpdated.removeListener(listener);
              resolve();
            }, 15000);
            const listener = (updatedTabId, changeInfo) => {
              if (updatedTabId === tabId && changeInfo.status === 'complete') {
                clearTimeout(timeout);
                chrome.tabs.onUpdated.removeListener(listener);
                resolve();
              }
            };
            chrome.tabs.onUpdated.addListener(listener);
          });
        } else {
          sendResponse({ success: false, error: 'NO_TAB' });
          return;
        }

        sendResponse({ success: true, tabId });
      } catch (err) {
        console.error('[TobyFlow] gemini:findOrCreateTab error:', err.message);
        sendResponse({ success: false, error: err.message || 'NO_TAB' });
      }
    })();
    return true;
  }

  if (message.action === 'gemini:ensureActive') {
    // Support 2 caller patterns: sidePanel pass tabId, content script fallback sender.tab.id
    const tabId = message.tabId || sender?.tab?.id;
    const focusWindow = message.focusWindow === true;
    (async () => {
      try {
        if (!tabId) { sendResponse({ success: false, error: 'NO_TAB' }); return; }
        const tabInfo = await chrome.tabs.get(tabId);
        if (!tabInfo.active) {
          await chrome.tabs.update(tabId, { active: true });
          await new Promise(r => setTimeout(r, 300));
        }
        // Cloudflare/captcha challenge: bring window to front + drawAttention.
        if (focusWindow && tabInfo.windowId) {
          try {
            await chrome.windows.update(tabInfo.windowId, { focused: true, drawAttention: true });
          } catch (winErr) {
            console.warn('[TobyFlow] gemini:ensureActive focusWindow failed:', winErr.message);
          }
        }
        sendResponse({ success: true, active: true });
      } catch (err) {
        console.error('[TobyFlow] gemini:ensureActive error:', err.message);
        sendResponse({ success: false, error: err.message || 'ACTIVATE_FAILED' });
      }
    })();
    return true;
  }

  if (message.action === 'gemini:injectScript') {
    const { tabId } = message;
    (async () => {
      try {
        if (!tabId) { sendResponse({ success: false, error: 'NO_TAB' }); return; }

        // 2026-05-25: Pre-check tab URL (race tab redirect — silent skip).
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        if (!tab?.url || !tab.url.startsWith('https://gemini.google.com/')) {
          sendResponse({ success: false, error: 'NOT_GEMINI_URL', url: tab?.url || '' });
          return;
        }

        // Guard double-inject (chat-content-gemini.js dùng flag _chatAIGeminiInjected)
        const checkResults = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => !!window._chatAIGeminiInjected,
        });
        const alreadyLoaded = !!(checkResults && checkResults[0] && checkResults[0].result);

        if (!alreadyLoaded) {
          await chrome.scripting.executeScript({
            target: { tabId },
            files: ['chat-content-gemini.js'],
          });
        }
        sendResponse({ success: true, alreadyLoaded });
      } catch (err) {
        console.warn('[TobyFlow] gemini:injectScript skipped:', err.message);
        sendResponse({ success: false, error: err.message || 'INJECT_FAILED' });
      }
    })();
    return true;
  }

  if (message.action === 'gemini:checkLogin') {
    const { tabId } = message;
    (async () => {
      try {
        if (!tabId) { sendResponse({ success: false, error: 'NO_TAB' }); return; }

        // 2026-05-31 fix: SPA Gemini chậm hydrate sau khi activate tab → editor element
        // chưa render → checkLogin lần đầu fail "EDITOR_NOT_FOUND" mặc dù user logged in.
        // Retry 4 lần × 400ms (tổng ~1.6s) với fallback signals đáng tin hơn (URL pattern,
        // sidebar nav menu) để giảm false negative.
        const runCheck = async () => {
          const results = await chrome.scripting.executeScript({
            target: { tabId },
            func: function checkGeminiLogin() {
              const url = location.href || '';
              // Tín hiệu 1 (negative): URL hard signin
              if (/\/(ServiceLogin|signin|accounts\.google\.com)/.test(url)) {
                return { ready: false, error: 'NOT_LOGGED_IN' };
              }
              // Tín hiệu 2 (positive): editor prompt input render
              const editor =
                document.querySelector('.ql-editor[contenteditable="true"]') ||
                document.querySelector('rich-textarea [contenteditable="true"]') ||
                document.querySelector('div[role="textbox"][contenteditable="true"]');
              if (editor) return { ready: true };
              // Tín hiệu 3 (positive): sidebar nav menu (chỉ hiện khi logged in)
              const sidebarNav =
                document.querySelector('side-navigation, [data-test-id="side-nav"], #side-navigation') ||
                document.querySelector('button[aria-label*="account"i], img[alt*="account"i][role]');
              if (sidebarNav) return { ready: true };
              // Tín hiệu 4 (negative): signin link DOM
              const signinLink = document.querySelector('a[href*="accounts.google.com/ServiceLogin"], a[href*="signin"]');
              if (signinLink) return { ready: false, error: 'NOT_LOGGED_IN' };
              return { ready: false, error: 'EDITOR_NOT_FOUND' };
            },
          });
          return (results && results[0] && results[0].result) || { ready: false, error: 'EDITOR_NOT_FOUND' };
        };

        const RETRY_MAX = 4;
        const RETRY_DELAY = 400;
        let result = await runCheck();
        for (let i = 1; i < RETRY_MAX && !result.ready && result.error === 'EDITOR_NOT_FOUND'; i++) {
          await new Promise(r => setTimeout(r, RETRY_DELAY));
          result = await runCheck();
        }
        sendResponse({ success: true, ...result });
      } catch (err) {
        console.error('[TobyFlow] gemini:checkLogin error:', err.message);
        sendResponse({ success: false, error: err.message || 'CHECK_FAILED' });
      }
    })();
    return true;
  }

  if (message.action === 'gemini:getTabInfo') {
    const { tabId } = message;
    (async () => {
      try {
        if (!tabId) { sendResponse({ success: false, error: 'NO_TAB' }); return; }
        const tabInfo = await chrome.tabs.get(tabId);
        sendResponse({ success: true, url: tabInfo?.url || null, active: !!tabInfo?.active });
      } catch (err) {
        sendResponse({ success: false, error: err.message || 'TAB_NOT_FOUND' });
      }
    })();
    return true;
  }

  if (message.action === 'gemini:closeTab') {
    const { tabId } = message;
    (async () => {
      try {
        if (tabId) {
          try { await chrome.tabs.remove(tabId); } catch (e) { /* tab có thể đã đóng */ }
        }
        sendResponse({ success: true });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  if (message.action === 'chatgpt:activateImageMode') {
    const { tabId } = message;
    (async () => {
      try {
        if (!tabId) { sendResponse({ success: false, error: 'NO_TAB' }); return; }

        const results = await chrome.scripting.executeScript({
          target: { tabId },
          func: async function activateImageMode() {
            const sleep = (ms) => new Promise(r => setTimeout(r, ms));
            const log = (...args) => console.log('[ChatGPT-activate]', ...args);

            // Helper: click element bằng cả real MouseEvent + React onClick (max compat)
            const clickElement = (el) => {
              if (!el) return false;
              // 1. Real mouse events (visible click animation + native React handler)
              const rect = el.getBoundingClientRect();
              const x = rect.left + rect.width / 2;
              const y = rect.top + rect.height / 2;
              const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
              try {
                el.dispatchEvent(new PointerEvent('pointerdown', opts));
                el.dispatchEvent(new MouseEvent('mousedown', opts));
                el.dispatchEvent(new PointerEvent('pointerup', opts));
                el.dispatchEvent(new MouseEvent('mouseup', opts));
                el.dispatchEvent(new MouseEvent('click', opts));
              } catch (e) { /* ignore */ }
              // 2. Fallback React onClick/onSelect props (cho Radix menuitemradio)
              const propsKey = Object.keys(el).find(k => k.startsWith('__reactProps$'));
              const props = propsKey ? el[propsKey] : null;
              try {
                if (props && typeof props.onSelect === 'function') {
                  props.onSelect({ preventDefault() {}, stopPropagation() {} });
                } else if (props && typeof props.onClick === 'function') {
                  props.onClick({ preventDefault() {}, stopPropagation() {}, nativeEvent: new MouseEvent('click'), type: 'click', target: el, currentTarget: el });
                }
              } catch (e) { /* ignore */ }
              return true;
            };

            // Đóng menu cũ nếu đang mở (tránh state cũ ảnh hưởng) — chỉ chờ 60ms
            try {
              const openMenu = document.querySelector('div[role="menu"][data-state="open"]');
              if (openMenu) {
                document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
                await sleep(60);
              }
            } catch (e) {}

            // 1. Detect đã ở image mode — ratio dropdown đã visible
            const existingRatioBtn = document.querySelector('button[aria-label="Choose image aspect ratio"]');
            if (existingRatioBtn) {
              log('Step 1: ratio button đã visible — image mode đã active, skip click composer');
              return { activated: true, ratioControlAvailable: true, alreadyActive: true };
            }

            // 2. Click composer plus button (visible click)
            const plusBtn = document.querySelector('#composer-plus-btn')
              || document.querySelector('[data-testid="composer-plus-btn"]');
            if (!plusBtn) {
              log('Step 2 FAIL: PLUS_BUTTON_NOT_FOUND');
              return { activated: false, error: 'PLUS_BUTTON_NOT_FOUND' };
            }
            log('Step 2: Click composer plus button');
            clickElement(plusBtn);

            // 3. Chờ menu render (Radix portal — append vào body, retry nhanh)
            let menuContainer = null;
            for (let i = 0; i < 6; i++) {
              await sleep(80);
              menuContainer = document.querySelector('div[role="menu"][data-radix-menu-content][data-state="open"]');
              if (menuContainer) break;
            }
            if (!menuContainer) {
              log('Step 3 FAIL: MENU_NOT_RENDERED sau 480ms');
              return { activated: false, error: 'MENU_NOT_RENDERED' };
            }
            log('Step 3: Menu rendered');

            // 4. Tìm item "Create image"
            const menuItems = menuContainer.querySelectorAll('[role="menuitemradio"], [role="menuitem"]');
            let createImageItem = null;
            let alreadyChecked = false;
            for (const item of menuItems) {
              const text = (item.innerText || '').trim().toLowerCase();
              if (text === 'create image' || text === 'create an image' || text.startsWith('create image')) {
                createImageItem = item;
                alreadyChecked = item.getAttribute('aria-checked') === 'true'
                  || item.getAttribute('data-state') === 'checked';
                break;
              }
            }
            if (!createImageItem) {
              log('Step 4 FAIL: MENU_ITEM_NOT_FOUND. Items found:', Array.from(menuItems).map(i => i.innerText?.trim()));
              return { activated: false, error: 'MENU_ITEM_NOT_FOUND' };
            }
            log('Step 4: Click "Create image" item (alreadyChecked:', alreadyChecked, ')');

            // 5. Click item — CẢ KHI alreadyChecked (force re-toggle để đảm bảo state đúng)
            //    nếu alreadyChecked → đóng menu bằng Escape (không click again gây toggle off)
            if (!alreadyChecked) {
              clickElement(createImageItem);
            } else {
              try {
                document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
              } catch (e) {}
            }

            // 6. Chờ ratio dropdown render (retry nhanh)
            let ratioBtn = null;
            for (let i = 0; i < 8; i++) {
              await sleep(80);
              ratioBtn = document.querySelector('button[aria-label="Choose image aspect ratio"]');
              if (ratioBtn) break;
            }
            log('Step 6:', ratioBtn ? 'Ratio button visible' : 'RATIO_CONTROL_NOT_RENDERED sau 640ms');

            return {
              activated: !!ratioBtn,
              ratioControlAvailable: !!ratioBtn,
              wasAlreadyChecked: alreadyChecked,
              error: ratioBtn ? null : 'RATIO_CONTROL_NOT_RENDERED',
            };
          },
        });

        const result = (results && results[0] && results[0].result) || { activated: false, error: 'EXEC_FAILED' };
        sendResponse({ success: !!result.activated, ...result });
      } catch (err) {
        console.error('[TobyFlow] chatgpt:activateImageMode error:', err.message);
        sendResponse({ success: false, activated: false, error: err.message || 'EXEC_FAILED' });
      }
    })();
    return true;
  }

  if (message.action === 'chatgpt:setRatio') {
    const { tabId, ratio, ariaLabelMap } = message;
    (async () => {
      try {
        if (!tabId) { sendResponse({ success: false, error: 'NO_TAB' }); return; }
        if (!ratio) { sendResponse({ success: false, error: 'INVALID_RATIO_KEY' }); return; }

        // Strict Server-Only: caller (ChatGPTSession.setRatio) MUST truyền ariaLabelMap từ
        // ChatGPTAdapter.capabilities.ratioAriaLabels (derive từ PCM ratios cache).
        // Nếu missing → return error, KHÔNG fallback hardcoded.
        if (!ariaLabelMap || typeof ariaLabelMap !== 'object' || Object.keys(ariaLabelMap).length === 0) {
          console.debug('[Tier3] chatgpt:setRatio missing ariaLabelMap — caller phải truyền từ ChatGPTAdapter.capabilities');
          sendResponse({ success: false, error: 'MISSING_ARIA_LABEL_MAP' });
          return;
        }
        const resolvedAriaLabelMap = ariaLabelMap;

        const results = await chrome.scripting.executeScript({
          target: { tabId },
          args: [ratio, resolvedAriaLabelMap],
          func: async function setRatio(ratioKey, ARIA_LABEL_MAP) {
            const sleep = (ms) => new Promise(r => setTimeout(r, ms));
            const log = (...args) => console.log('[ChatGPT-setRatio]', ...args);

            const clickElement = (el) => {
              if (!el) return false;
              const rect = el.getBoundingClientRect();
              const opts = { bubbles: true, cancelable: true, view: window, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
              try {
                el.dispatchEvent(new PointerEvent('pointerdown', opts));
                el.dispatchEvent(new MouseEvent('mousedown', opts));
                el.dispatchEvent(new PointerEvent('pointerup', opts));
                el.dispatchEvent(new MouseEvent('mouseup', opts));
                el.dispatchEvent(new MouseEvent('click', opts));
              } catch (e) {}
              const propsKey = Object.keys(el).find(k => k.startsWith('__reactProps$'));
              const props = propsKey ? el[propsKey] : null;
              try {
                if (props && typeof props.onSelect === 'function') {
                  props.onSelect({ preventDefault() {}, stopPropagation() {} });
                } else if (props && typeof props.onClick === 'function') {
                  props.onClick({ preventDefault() {}, stopPropagation() {}, nativeEvent: new MouseEvent('click'), type: 'click', target: el, currentTarget: el });
                }
              } catch (e) {}
              return true;
            };

            const targetAriaLabel = ARIA_LABEL_MAP?.[ratioKey];
            if (!targetAriaLabel) return { success: false, error: 'INVALID_RATIO_KEY' };

            const ratioBtn = document.querySelector('button[aria-label="Choose image aspect ratio"]');
            if (!ratioBtn) {
              log('FAIL: RATIO_BUTTON_NOT_FOUND');
              return { success: false, error: 'RATIO_BUTTON_NOT_FOUND' };
            }
            log('Step 1: Click ratio button →', targetAriaLabel);
            clickElement(ratioBtn);

            // Chờ dropdown render (retry 5 lần)
            let items = [];
            for (let i = 0; i < 5; i++) {
              await sleep(150);
              items = document.querySelectorAll('[role="menuitemradio"]');
              if (items.length >= 5) break; // 5 ratios + có thể thêm Auto
            }
            log('Step 2: Found', items.length, 'menuitemradio options');

            // Primary: aria-label exact
            let target = null;
            for (const item of items) {
              if (item.getAttribute('aria-label') === targetAriaLabel) { target = item; break; }
            }
            if (!target) {
              const ratioName = targetAriaLabel.split(' ')[0].toLowerCase();
              for (const item of items) {
                const text = (item.innerText || '').trim().toLowerCase();
                if (text.startsWith(ratioName)) { target = item; break; }
              }
            }
            if (!target) {
              log('FAIL: RATIO_OPTION_NOT_FOUND. Items aria-labels:', Array.from(items).map(i => i.getAttribute('aria-label')));
              return { success: false, error: 'RATIO_OPTION_NOT_FOUND' };
            }
            log('Step 3: Click target option');
            clickElement(target);

            return { success: true };
          },
        });

        const result = (results && results[0] && results[0].result) || { success: false, error: 'EXEC_FAILED' };
        sendResponse(result);
      } catch (err) {
        console.error('[TobyFlow] chatgpt:setRatio error:', err.message);
        sendResponse({ success: false, error: err.message || 'EXEC_FAILED' });
      }
    })();
    return true;
  }

  // Generic fetch image as base64 - for Flow URLs that need authentication
  if (message.action === 'fetchImageAsBase64') {
    const { url } = message;
    (async () => {
      try {
        if (!url) {
          sendResponse({ success: false, error: 'MISSING_URL' });
          return;
        }

        // Find a Flow tab to inject the fetch (Flow tabs have cookies)
        const flowTabs = await chrome.tabs.query({ url: '*://labs.google/*' });
        if (flowTabs.length === 0) {
          // Fallback: try direct fetch (might work if URL doesn't need auth)
          try {
            const resp = await fetch(url);
            if (!resp.ok) {
              sendResponse({ success: false, error: 'HTTP_' + resp.status });
              return;
            }
            const blob = await resp.blob();
            const contentType = blob.type || 'image/jpeg';
            const arrayBuffer = await blob.arrayBuffer();
            const base64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));
            sendResponse({ success: true, base64, contentType });
          } catch (e) {
            sendResponse({ success: false, error: 'NO_FLOW_TAB_AND_DIRECT_FAILED' });
          }
          return;
        }

        const tabId = flowTabs[0].id;
        // Inject fetch trong context tab Flow.
        // KHÔNG dùng credentials: 'include' vì redirect chain `labs.google` →
        // `flow-content.google` trả `Access-Control-Allow-Origin: *` → CORS
        // block credentialed request. Signed URL của CDN đã đủ để authenticate
        // qua Expires + Signature query params.
        const [scriptResult] = await chrome.scripting.executeScript({
          target: { tabId },
          func: async (imgUrl) => {
            try {
              const resp = await fetch(imgUrl);
              if (!resp.ok) return { ok: false, status: resp.status, error: 'HTTP_' + resp.status };
              const blob = await resp.blob();
              return await new Promise((resolve) => {
                const reader = new FileReader();
                reader.onload = () => {
                  // Extract base64 from data URL
                  const dataUrl = reader.result;
                  const base64 = dataUrl.split(',')[1];
                  resolve({
                    ok: true,
                    base64: base64,
                    contentType: blob.type || 'image/jpeg',
                    size: blob.size,
                  });
                };
                reader.onerror = () => resolve({ ok: false, error: 'READ_ERROR' });
                reader.readAsDataURL(blob);
              });
            } catch (e) {
              return { ok: false, error: e.message || 'FETCH_EXCEPTION' };
            }
          },
          args: [url],
        });

        const r = scriptResult?.result;
        if (!r?.ok) {
          sendResponse({ success: false, error: r?.error || 'FETCH_FAILED' });
          return;
        }
        sendResponse({
          success: true,
          base64: r.base64,
          contentType: r.contentType,
          size: r.size,
        });
      } catch (err) {
        console.error('[TobyFlow] fetchImageAsBase64 error:', err.message);
        sendResponse({ success: false, error: 'EXCEPTION', message: err.message });
      }
    })();
    return true;
  }

  if (message.action === 'chatgpt:fetchImage') {
    // Phase CG-3.4: Fetch ChatGPT CDN image qua cookie session của tab chatgpt.com.
    // URL CDN dạng `https://chatgpt.com/backend-api/estuary/content?id=file_xxx&sig=...`
    // CHỈ accessible khi có cookie chatgpt.com — KHÔNG thể fetch từ background context
    // hay tab khác. Phải inject `chrome.scripting.executeScript` vào tab ChatGPT để fetch.
    const { url, tabId } = message;
    (async () => {
      try {
        if (!url || !tabId) {
          sendResponse({ success: false, error: 'MISSING_PARAMS' });
          return;
        }
        // Inject fetch trong context tab ChatGPT (cookie session authenticated)
        const [scriptResult] = await chrome.scripting.executeScript({
          target: { tabId },
          func: async (imgUrl) => {
            try {
              const resp = await fetch(imgUrl, { credentials: 'include' });
              if (!resp.ok) return { ok: false, status: resp.status, error: 'HTTP_' + resp.status };
              const blob = await resp.blob();
              // Convert blob → base64 data URL qua FileReader
              return await new Promise((resolve) => {
                const reader = new FileReader();
                reader.onload = () => resolve({
                  ok: true,
                  base64: reader.result,
                  mime: blob.type || 'image/png',
                  size: blob.size,
                });
                reader.onerror = () => resolve({ ok: false, error: 'READ_ERROR' });
                reader.readAsDataURL(blob);
              });
            } catch (e) {
              return { ok: false, error: e.message || 'FETCH_EXCEPTION' };
            }
          },
          args: [url],
        });
        const r = scriptResult?.result;
        if (!r?.ok) {
          sendResponse({
            success: false,
            error: r?.error || 'FETCH_FAILED',
            status: r?.status,
          });
          return;
        }
        sendResponse({
          success: true,
          base64: r.base64,
          mime: r.mime,
          size: r.size,
        });
      } catch (err) {
        console.error('[TobyFlow] chatgpt:fetchImage error:', err.message);
        sendResponse({ success: false, error: 'EXCEPTION', message: err.message });
      }
    })();
    return true;
  }

  if (message.action === 'chatgpt:closeTab') {
    const { tabId } = message;
    (async () => {
      try {
        if (!tabId) { sendResponse({ success: true }); return; }
        try {
          await chrome.tabs.remove(tabId);
        } catch (e) {
          // Tab có thể đã đóng — bỏ qua
        }
        sendResponse({ success: true });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  if (message.action === 'chatgpt:navigated') {
    // Chỉ relay khi message đến TỪ content script (sender.tab tồn tại). Bản broadcast
    // background gửi ra sidePanel KHÔNG có sender.tab → tránh infinite loop.
    if (!sender.tab) {
      sendResponse({ success: true, skipped: true });
      return true;
    }
    const tabId = sender.tab.id;
    // Đổi action name để tránh listener này bắt lại bản broadcast của chính nó.
    chrome.runtime.sendMessage({
      action: 'chatgpt:navigatedBroadcast',
      tabId,
      url: message.url,
    }).catch(() => {});
    sendResponse({ success: true });
    return true;
  }

  if (message.action === 'chatgpt:getTabInfo') {
    const { tabId } = message;
    (async () => {
      try {
        if (!tabId) { sendResponse({ success: false, error: 'NO_TAB' }); return; }
        const tabInfo = await chrome.tabs.get(tabId);
        sendResponse({
          success: true,
          url: tabInfo.url || null,
          active: !!tabInfo.active,
          status: tabInfo.status,
        });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  // ============================================================
  // === Phase G-2: Grok Session Manager handlers ================
  // ============================================================
  // Các action `grok:*` riêng biệt với chatgpt:* / gemini:* / chatAI:send.
  // Mirror pattern ChatGPT (Phase CG-2) cho Grok provider.
  // ============================================================

  if (message.action === 'grok:findOrCreateTab') {
    const { createIfMissing = true, activate = true } = message;
    (async () => {
      try {
        let currentWindowId = sender.tab?.windowId;
        if (!currentWindowId) {
          const focusedWindow = await chrome.windows.getCurrent();
          currentWindowId = focusedWindow?.id;
        }

        // Tìm tab grok.com — ưu tiên trong cùng window
        let tabs = await chrome.tabs.query({ url: PROVIDER_URLS.grok.tabQuery, windowId: currentWindowId });
        if (tabs.length === 0) {
          tabs = await chrome.tabs.query({ url: PROVIDER_URLS.grok.tabQuery });
        }

        let tabId;
        if (tabs.length > 0) {
          // Ưu tiên tab đã ở /imagine (sẵn sàng tương tác)
          const imagineTab = tabs.find(t => t.url && t.url.includes('/imagine'));
          if (imagineTab) {
            tabId = imagineTab.id;
          } else {
            // Tab grok.com tồn tại nhưng KHÔNG ở /imagine → navigate đến /imagine
            tabId = tabs[0].id;
            await chrome.tabs.update(tabId, { url: PROVIDER_URLS.grok.imagine });
            // Chờ navigation complete
            await new Promise((resolve) => {
              const timeout = setTimeout(() => {
                chrome.tabs.onUpdated.removeListener(listener);
                resolve();
              }, 10000);
              const listener = (updatedTabId, changeInfo) => {
                if (updatedTabId === tabId && changeInfo.status === 'complete') {
                  clearTimeout(timeout);
                  chrome.tabs.onUpdated.removeListener(listener);
                  resolve();
                }
              };
              chrome.tabs.onUpdated.addListener(listener);
            });
          }
        } else if (createIfMissing) {
          const tab = await chrome.tabs.create({
            url: PROVIDER_URLS.grok.imagine,
            active: !!activate,
            windowId: currentWindowId,
          });
          tabId = tab.id;
          // Chờ tab load xong (max 15s)
          await new Promise((resolve) => {
            const timeout = setTimeout(() => {
              chrome.tabs.onUpdated.removeListener(listener);
              resolve();
            }, 15000);
            const listener = (updatedTabId, changeInfo) => {
              if (updatedTabId === tabId && changeInfo.status === 'complete') {
                clearTimeout(timeout);
                chrome.tabs.onUpdated.removeListener(listener);
                resolve();
              }
            };
            chrome.tabs.onUpdated.addListener(listener);
          });
        } else {
          sendResponse({ success: false, error: 'NO_TAB' });
          return;
        }

        sendResponse({ success: true, tabId });
      } catch (err) {
        console.error('[TobyFlow] grok:findOrCreateTab error:', err.message);
        sendResponse({ success: false, error: err.message || 'NO_TAB' });
      }
    })();
    return true;
  }

  if (message.action === 'cloudflare:challenge') {
    // Bug 49 forward: content script Grok gửi event → broadcast tới mọi extension page
    // (sidebar + workflow popup). chrome.runtime.sendMessage không có tabId → đến tất cả listener.
    try {
      chrome.runtime.sendMessage({
        action: 'cloudflare:challenge',
        provider: message.provider,
        phase: message.phase,
        elapsedSec: message.elapsedSec || 0,
        timeoutSec: message.timeoutSec || 120,
        tabId: sender?.tab?.id || null,
      }).catch(() => { /* no listener — sidebar maybe closed */ });
    } catch (_) {}
    sendResponse?.({ success: true });
    return false;
  }

  if (message.action === 'grok:ensureActive') {
    // Support 2 caller patterns:
    //   - sidePanel: pass tabId explicit
    //   - content script (Grok page itself): no tabId → fallback sender.tab.id
    const tabId = message.tabId || sender?.tab?.id;
    const focusWindow = message.focusWindow === true;
    (async () => {
      try {
        if (!tabId) { sendResponse({ success: false, error: 'NO_TAB' }); return; }
        const tabInfo = await chrome.tabs.get(tabId);
        if (!tabInfo.active) {
          await chrome.tabs.update(tabId, { active: true });
          // Chờ React unthrottle (300ms — pattern giống Flow/ChatGPT)
          await new Promise(r => setTimeout(r, 300));
        }
        // Cloudflare challenge: cần bring window to front để user thấy turnstile.
        // Tab có thể active trong window background → user vẫn không thấy.
        if (focusWindow && tabInfo.windowId) {
          try {
            // Nhớ window đang focus (popup workflow-editor) TRƯỚC khi focus grok → restore sau Cloudflare.
            // Set-or-clear: nếu window đang focus CHÍNH là grok (GenTab đã focusWindow:true) → clear
            // (không restore, grok giữ focus). Chỉ workflow-editor (popup ≠ grok) mới remember + restore.
            try {
              const prev = await chrome.windows.getLastFocused();
              _grokFocusReturnWindowId = (prev && prev.id !== tabInfo.windowId) ? prev.id : null;
            } catch (_) {}
            await chrome.windows.update(tabInfo.windowId, { focused: true, drawAttention: true });
          } catch (winErr) {
            console.warn('[TobyFlow] grok:ensureActive focusWindow failed:', winErr.message);
          }
        }
        sendResponse({ success: true, active: true });
      } catch (err) {
        console.error('[TobyFlow] grok:ensureActive error:', err.message);
        sendResponse({ success: false, error: err.message || 'ACTIVATE_FAILED' });
      }
    })();
    return true;
  }

  // 2026-05-28: trả focus về window TRƯỚC Cloudflare (popup workflow/sidebar) sau khi challenge
  // resolved + submit xong → không kẹt focus ở tab grok. No-op nếu không có window đã nhớ.
  if (message.action === 'grok:restoreFocus') {
    (async () => {
      try {
        if (_grokFocusReturnWindowId != null) {
          const wid = _grokFocusReturnWindowId;
          _grokFocusReturnWindowId = null;
          try {
            await chrome.windows.get(wid); // verify còn tồn tại
            await chrome.windows.update(wid, { focused: true });
          } catch (_) { /* window đã đóng → bỏ qua */ }
        }
        sendResponse({ success: true });
      } catch (e) {
        sendResponse({ success: false, error: e?.message });
      }
    })();
    return true;
  }

  if (message.action === 'grok:injectScript') {
    const { tabId } = message;
    (async () => {
      try {
        if (!tabId) { sendResponse({ success: false, error: 'NO_TAB' }); return; }

        // 2026-05-25: Pre-check tab URL (race tab redirect — silent skip).
        // Grok hợp lệ ở 2 host: grok.com (chính) + x.com/i/grok (sub-route).
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        const url = tab?.url || '';
        const isGrokUrl = url.startsWith('https://grok.com/') || url.includes('://x.com/i/grok');
        if (!isGrokUrl) {
          sendResponse({ success: false, error: 'NOT_GROK_URL', url });
          return;
        }

        // Kiểm tra flag double-inject
        const checkResults = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => !!window.__tobyflowGrokLoaded__,
        });
        const alreadyLoaded = !!(checkResults && checkResults[0] && checkResults[0].result);

        if (!alreadyLoaded) {
          await chrome.scripting.executeScript({
            target: { tabId },
            files: ['chat-content-grok.js'],
          });
        }
        sendResponse({ success: true, alreadyLoaded });
      } catch (err) {
        console.warn('[TobyFlow] grok:injectScript skipped:', err.message);
        sendResponse({ success: false, error: err.message || 'INJECT_FAILED' });
      }
    })();
    return true;
  }

  if (message.action === 'grok:checkLogin') {
    const { tabId } = message;
    (async () => {
      try {
        if (!tabId) { sendResponse({ success: false, error: 'NO_TAB' }); return; }

        const results = await chrome.scripting.executeScript({
          target: { tabId },
          // Func phải standalone — không reference closure outside
          func: function checkGrokLoginStatus() {
            // Editor TipTap: form contenteditable
            const editor = document.querySelector("form div[contenteditable='true']")
                        || document.querySelector('.ProseMirror')
                        || document.querySelector('.tiptap');
            // Login link: a[href*="/login"]
            const loginLink = document.querySelector('a[href*="/login"]')
                           || document.querySelector('a[href*="/signin"]');

            if (!editor) {
              // Nếu có login link rõ ràng + không có editor → chưa login
              if (loginLink) return { ready: false, error: 'NOT_LOGGED_IN' };
              return { ready: false, error: 'EDITOR_NOT_FOUND' };
            }
            return { ready: true };
          },
        });
        const result = (results && results[0] && results[0].result) || { ready: false, error: 'EDITOR_NOT_FOUND' };
        sendResponse({ success: true, ...result });
      } catch (err) {
        console.error('[TobyFlow] grok:checkLogin error:', err.message);
        sendResponse({ success: false, error: err.message || 'CHECK_FAILED' });
      }
    })();
    return true;
  }

  if (message.action === 'grok:applySettings' || message.action === 'grok:setRatio') {
    // Relay tới content script để gọi applyGrokSettings (đã sẵn trong chat-content-grok.js).
    // grok:setRatio là alias chỉ apply ratio.
    const { tabId, settings, ratio } = message;
    (async () => {
      try {
        if (!tabId) { sendResponse({ success: false, error: 'NO_TAB' }); return; }

        // Build payload settings
        let payload = settings || {};
        if (message.action === 'grok:setRatio' && ratio) {
          payload = { ratio };
        }

        // Inject inline func gọi applyGrokSettings nếu content script đã loaded.
        // applyGrokSettings được expose qua handler grok:applySettingsInline (chưa có) — thay
        // bằng inline executeScript thực thi trực tiếp các DOM operations.
        // Để đơn giản + idempotent, gọi qua tabs.sendMessage tới content script:
        const sent = await new Promise((resolve) => {
          chrome.tabs.sendMessage(tabId, {
            action: 'grok:applySettingsInline',
            settings: payload,
          }, (resp) => {
            if (chrome.runtime.lastError) {
              resolve({ success: false, error: chrome.runtime.lastError.message });
              return;
            }
            resolve(resp || { success: false, error: 'NO_RESPONSE' });
          });
        });
        sendResponse(sent);
      } catch (err) {
        console.error('[TobyFlow] grok:applySettings error:', err.message);
        sendResponse({ success: false, error: err.message || 'APPLY_FAILED' });
      }
    })();
    return true;
  }

  if (message.action === 'grok:fetchImage' || message.action === 'grok:fetchMedia') {
    // Phase G-2: Fetch media URL (assets.grok.com) qua cookie session của tab grok.com.
    const { url, tabId } = message;
    (async () => {
      try {
        if (!url) {
          sendResponse({ success: false, error: 'MISSING_PARAMS' });
          return;
        }
        const fetchHost = (() => { try { return new URL(url).hostname; } catch (_) { return ''; } })();
        // Host KHÔNG phải grok.com (vd imagine-public.x.ai no-ref text-to-image) = cross-origin với
        // tab grok.com → page-context fetch bị CORS chặn. Fetch trong SW (host_permissions *.x.ai)
        // bypass CORS. grok.com hosts (assets.grok.com) giữ tab-inject vì cần cookie session.
        if (!fetchHost.endsWith('grok.com')) {
          try {
            const resp = await fetch(url, { credentials: 'include' });
            if (!resp.ok) { sendResponse({ success: false, error: 'HTTP_' + resp.status, status: resp.status }); return; }
            const blob = await resp.blob();
            const bytes = new Uint8Array(await blob.arrayBuffer());
            let bin = '';
            const CH = 0x8000; // chunk tránh stack overflow ảnh lớn
            for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
            const mime = blob.type || 'image/jpeg';
            sendResponse({ success: true, base64: `data:${mime};base64,` + btoa(bin), mime, size: blob.size });
          } catch (e) {
            sendResponse({ success: false, error: e.message || 'SW_FETCH_FAILED' });
          }
          return;
        }
        if (!tabId) {
          sendResponse({ success: false, error: 'MISSING_PARAMS' });
          return;
        }
        // Inject fetch trong context tab Grok (cookie session)
        const [scriptResult] = await chrome.scripting.executeScript({
          target: { tabId },
          func: async (mediaUrl) => {
            try {
              const resp = await fetch(mediaUrl, { credentials: 'include' });
              if (!resp.ok) return { ok: false, status: resp.status, error: 'HTTP_' + resp.status };
              const blob = await resp.blob();
              return await new Promise((resolve) => {
                const reader = new FileReader();
                reader.onload = () => resolve({
                  ok: true,
                  base64: reader.result,
                  mime: blob.type || 'image/png',
                  size: blob.size,
                });
                reader.onerror = () => resolve({ ok: false, error: 'READ_ERROR' });
                reader.readAsDataURL(blob);
              });
            } catch (e) {
              return { ok: false, error: e.message || 'FETCH_EXCEPTION' };
            }
          },
          args: [url],
        });
        const r = scriptResult?.result;
        if (!r?.ok) {
          sendResponse({
            success: false,
            error: r?.error || 'FETCH_FAILED',
            status: r?.status,
          });
          return;
        }
        sendResponse({
          success: true,
          base64: r.base64,
          mime: r.mime,
          size: r.size,
        });
      } catch (err) {
        console.error('[TobyFlow] grok:fetchImage error:', err.message);
        sendResponse({ success: false, error: 'EXCEPTION', message: err.message });
      }
    })();
    return true;
  }

  if (message.action === 'grok:closeTab') {
    const { tabId } = message;
    (async () => {
      try {
        if (!tabId) { sendResponse({ success: true }); return; }
        try {
          await chrome.tabs.remove(tabId);
        } catch (e) {
          // Tab có thể đã đóng — bỏ qua
        }
        sendResponse({ success: true });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  if (message.action === 'grok:submitAndWait') {
    // Relay tới content script (chat-content-grok.js đã sẵn listener).
    const { tabId } = message;
    (async () => {
      try {
        if (!tabId) { sendResponse({ success: false, error: 'NO_TAB' }); return; }
        // Forward toàn bộ payload đến content script
        const payload = { ...message };
        delete payload.tabId; // không cần bên content script
        const resp = await new Promise((resolve) => {
          chrome.tabs.sendMessage(tabId, payload, (r) => {
            if (chrome.runtime.lastError) {
              resolve({ success: false, error: chrome.runtime.lastError.message });
              return;
            }
            resolve(r || { success: false, error: 'NO_RESPONSE' });
          });
        });
        sendResponse(resp);
      } catch (err) {
        console.error('[TobyFlow] grok:submitAndWait error:', err.message);
        sendResponse({ success: false, error: 'EXCEPTION', message: err.message });
      }
    })();
    return true;
  }

  if (message.action === 'grok:navigated') {
    // CRITICAL re-broadcast loop fix: chỉ relay khi đến từ content script (sender.tab tồn tại).
    // Bản broadcast `grok:navigatedBroadcast` sidePanel nhận sẽ KHÔNG có sender.tab → tránh loop.
    if (!sender.tab) {
      sendResponse({ success: true, skipped: true });
      return true;
    }
    const tabId = sender.tab.id;
    chrome.runtime.sendMessage({
      action: 'grok:navigatedBroadcast',
      tabId,
      url: message.url,
    }).catch(() => {});
    sendResponse({ success: true });
    return true;
  }

  if (message.action === 'grok:getTabInfo') {
    const { tabId } = message;
    (async () => {
      try {
        if (!tabId) { sendResponse({ success: false, error: 'NO_TAB' }); return; }
        const tabInfo = await chrome.tabs.get(tabId);
        sendResponse({
          success: true,
          url: tabInfo.url || null,
          active: !!tabInfo.active,
          status: tabInfo.status,
        });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  // Không xử lý messages khác (contentLog, promptExecutionComplete, etc.)
  // Return false/undefined để Chrome biết listener này không handle message này
  return false;
});

// === Phase CG-2: Forward chatgpt.com tab close events đến ChatGPTSession ===
// Khi user đóng tab chatgpt.com → broadcast 'chatgpt:tabClosed' để ChatGPTSession reset cache.
chrome.tabs.onRemoved.addListener((tabId) => {
  // Broadcast tới mọi context (sidePanel + popups). ChatGPTSession sẽ tự lọc theo _tabId.
  chrome.runtime.sendMessage({ action: 'chatgpt:tabClosed', tabId }).catch(() => {});
  // Phase G-2: cùng listener cho Grok — GrokSession sẽ tự lọc theo _tabId.
  chrome.runtime.sendMessage({ action: 'grok:tabClosed', tabId }).catch(() => {});
});

// === Phase G-2: Forward grok.com tab navigation events ===
// Khi tab grok.com đổi URL (status='complete'), relay broadcast để GrokSession invalidate UI cache.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  if (!tab || !tab.url || !tab.url.includes('grok.com')) return;
  chrome.runtime.sendMessage({
    action: 'grok:navigatedBroadcast',
    tabId,
    url: tab.url,
  }).catch(() => {});
});

// Keyboard shortcuts
chrome.commands?.onCommand?.addListener((command) => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]) {
      chrome.tabs.sendMessage(tabs[0].id, { action: 'command', command });
    }
  });
});

// ===== Provider Config Helpers (DOM Resilience Plan) =====
const _PROVIDER_CONFIG_CACHE_KEY = 'toby_provider_configs';
const _PROVIDER_CONFIG_TTL_MS = 60 * 60 * 1000; // 1h

async function _getApiBaseUrl() {
  return new Promise(resolve => {
    chrome.storage.local.get(['af_api_url'], res => {
      // Phase 3.5 Bug I: derive từ API_BASE_DEFAULT (strip /api/v1 suffix nếu có)
      resolve(res?.af_api_url || API_BASE_DEFAULT.replace(/\/api\/v\d+\/?$/, ''));
    });
  });
}

async function _getProviderConfigsFromCache() {
  return new Promise(resolve => {
    chrome.storage.local.get([_PROVIDER_CONFIG_CACHE_KEY], res => {
      const cached = res?.[_PROVIDER_CONFIG_CACHE_KEY];
      if (cached && Date.now() < cached.expiresAt) {
        resolve(cached);
      } else {
        resolve(null);
      }
    });
  });
}

async function _fetchProviderConfigs() {
  try {
    const cached = await _getProviderConfigsFromCache();
    if (cached) return cached.data;

    const baseUrl = await _getApiBaseUrl();
    const resp = await _signedFetch(`${baseUrl}/api/v1/providers/dom-selectors`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'X-Extension-Id': chrome.runtime.id,
      },
    });

    if (resp.status === 403) {
      try {
        const body = await resp.clone().json();
        if (_isExtensionAuthRejection(body, 403)) {
          _handleExtensionAuthRejection();
          return null;
        }
      } catch (_) {}
    }

    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = await resp.json();

    if (json.success && json.data) {
      const cacheData = {
        data: json.data,
        expiresAt: Date.now() + _PROVIDER_CONFIG_TTL_MS,
        fetchedAt: Date.now(),
      };
      chrome.storage.local.set({ [_PROVIDER_CONFIG_CACHE_KEY]: cacheData });
      return json.data;
    }
  } catch (e) {
    console.warn('[Background] Provider config fetch failed:', e.message);
  }
  return null;
}

// ===== API Configs (ratios, download_resolutions, error_patterns) =====
const _API_CONFIGS_CACHE_KEY = 'toby_provider_api_configs';
const _API_CONFIGS_TTL_MS = 60 * 60 * 1000; // 1h

async function _fetchApiConfigs() {
  try {
    // Check cache first
    const cached = await new Promise(resolve => {
      chrome.storage.local.get([_API_CONFIGS_CACHE_KEY], res => {
        const data = res?.[_API_CONFIGS_CACHE_KEY];
        if (data && Date.now() < data.expiresAt) {
          resolve(data);
        } else {
          resolve(null);
        }
      });
    });
    if (cached) return cached.data;

    const baseUrl = await _getApiBaseUrl();
    const resp = await _signedFetch(`${baseUrl}/api/v1/providers/api-configs`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'X-Extension-Id': chrome.runtime.id,
      },
    });

    if (resp.status === 403) {
      try {
        const body = await resp.clone().json();
        if (_isExtensionAuthRejection(body, 403)) {
          _handleExtensionAuthRejection();
          return null;
        }
      } catch (_) {}
    }

    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = await resp.json();

    if (json.success && json.data) {
      const cacheData = {
        data: json.data,
        expiresAt: Date.now() + _API_CONFIGS_TTL_MS,
        fetchedAt: Date.now(),
      };
      chrome.storage.local.set({ [_API_CONFIGS_CACHE_KEY]: cacheData });

      // Derive patterns cho content scripts (chat-content-chatgpt.js, chat-content-grok.js)
      // — đọc từ `af_chatgpt_config`/`af_grok_config` storage key.
      // Cold start (sidebar chưa mở) cần data trong storage trước khi content script chạy.
      // ChatGPT có 2 keys api_config (error_patterns + ui_text_patterns) — MERGE thành 1 flat object
      // để content script đọc trực tiếp `cfg.delete_menu_text`, `cfg.cloudflare_challenge_text`, ...
      try {
        const cgErrorPatterns = json.data?.chatgpt?.configs?.error_patterns || {};
        const cgUiTextPatterns = json.data?.chatgpt?.configs?.ui_text_patterns || {};
        const cgMerged = { ...cgErrorPatterns, ...cgUiTextPatterns };
        if (Object.keys(cgMerged).length > 0) {
          chrome.storage.local.set({ af_chatgpt_config: { data: cgMerged, fetched_at: Date.now() } });
        }
        const grokPatterns = json.data?.grok?.configs?.error_patterns;
        if (grokPatterns && typeof grokPatterns === 'object') {
          chrome.storage.local.set({ af_grok_config: { data: grokPatterns, fetched_at: Date.now() } });
        }
      } catch (_) { /* ignore */ }

      return json.data;
    }
  } catch (e) {
    console.warn('[Background] API configs fetch failed:', e.message);
  }
  return null;
}

// Pre-fetch provider configs on extension startup
// Signal `_tobyConfigsReady` cho sidebar biết background đã fetch xong → tránh duplicate API calls (429).
const _CONFIGS_READY_KEY = '_tobyConfigsReady';
const _CONFIGS_READY_TTL_MS = 30000; // 30s — sidebar check nếu < 30s thì skip fetch
let _prefetchPromise = null; // Lock: prevent concurrent fetches

async function _prefetchAllConfigs() {
  // Dedup: nếu đang fetch → return promise đang chạy thay vì fetch lại
  if (_prefetchPromise) {
    console.log('[Background] Config fetch already in progress, waiting...');
    return _prefetchPromise;
  }
  _prefetchPromise = (async () => {
    try {
      await Promise.all([
        _fetchProviderConfigs(),
        _fetchApiConfigs(),
      ]);
      // Signal sidebar: background đã fetch xong, cache đã warm
      chrome.storage.local.set({ [_CONFIGS_READY_KEY]: Date.now() });
      console.log('[Background] Provider configs + API configs pre-fetched, signaled _tobyConfigsReady');
    } catch (e) {
      console.warn('[Background] Pre-fetch configs failed:', e.message);
    } finally {
      _prefetchPromise = null;
    }
  })();
  return _prefetchPromise;
}

// =============================================================================
// === CONSOLIDATED STARTUP LISTENERS ===
// Gộp tất cả onInstalled/onStartup vào 1 nơi để đảm bảo thứ tự chạy đúng.
// Tránh race condition giữa cache clear và prefetch (trước đây là listeners riêng).
// =============================================================================

chrome.runtime.onInstalled.addListener(async (details) => {
  console.log('[Background] onInstalled:', details.reason);

  // Step 1: Clear auth rejection flag (cho fresh check sau reload)
  try {
    await new Promise(r => chrome.storage.local.remove('tobyflow_extension_not_authorized', r));
    chrome.runtime.sendMessage({ type: 'EXTENSION_AUTHORIZED' }).catch(() => {});
    console.log('[Auth] 🔄 Extension reloaded — flag cleared, fresh check');
  } catch (_) {}

  // Step 2: Clear config cache CHỈ khi version THỰC SỰ đổi (install / update version khác).
  // 2026-05-28: reload extension (kể cả dev reload cùng version) fire reason='update' với
  // previousVersion === version hiện tại → KHÔNG clear (giữ cache warm → sidebar đọc config ngay,
  // không phải chờ re-fetch → loading nhanh). config_version polling/SSE vẫn refresh nếu server đổi.
  const _curVersion = chrome.runtime.getManifest().version;
  const _isRealUpdate = details.reason === 'update'
    && details.previousVersion && details.previousVersion !== _curVersion;
  if (details.reason === 'install' || _isRealUpdate) {
    await new Promise(r => chrome.storage.local.remove([
      'toby_provider_models',
      'toby_provider_api_configs',
      'toby_provider_dom_selectors',
      _CONFIGS_READY_KEY, // Clear ready signal too
    ], r));
    console.log('[TobyFlow] Cache cleared on', details.reason,
      details.previousVersion ? `(v${details.previousVersion} → v${_curVersion})` : '');
  } else {
    console.log('[TobyFlow] Reload cùng version (v' + _curVersion + ') — GIỮ cache warm, prefetch refresh nền');
  }

  // Step 3: Prefetch fresh configs (SAU khi cache đã clear)
  await _prefetchAllConfigs();

  // Step 4: Ensure enrollment
  _ensureEnrollment().catch(() => {});

  // Step 5: Redirect to Flow on first install
  if (details.reason === 'install') {
    chrome.tabs.create({ url: PROVIDER_URLS.flow.localeCreate });
  }

  // Step 6: Auto-inject content scripts vào existing tabs
  if (typeof _autoInjectContentScripts === 'function') {
    _autoInjectContentScripts();
  }
});

chrome.runtime.onStartup.addListener(async () => {
  console.log('[Background] onStartup');

  // Step 1: Prefetch configs (cache đã có từ trước, chỉ refresh nếu stale)
  await _prefetchAllConfigs();

  // Step 2: Self-heal probe
  _selfHealProbe();

  // Step 3: Ensure enrollment
  _ensureEnrollment().catch(() => {});
});

// Message handler: sidebar request fetch if cache stale
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.action === 'FETCH_CONFIGS_IF_NEEDED') {
    (async () => {
      try {
        // Check if already fetched recently
        const stored = await new Promise(r => chrome.storage.local.get([_CONFIGS_READY_KEY], r));
        const readyAt = stored?.[_CONFIGS_READY_KEY] || 0;
        if (Date.now() - readyAt < _CONFIGS_READY_TTL_MS) {
          sendResponse({ success: true, cached: true });
          return;
        }
        // Fetch and signal
        await _prefetchAllConfigs();
        sendResponse({ success: true, cached: false });
      } catch (e) {
        sendResponse({ success: false, error: e.message });
      }
    })();
    return true; // async response
  }
});
