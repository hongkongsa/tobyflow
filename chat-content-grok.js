/**
 * chat-content-grok.js — Content script inject ON-DEMAND vào grok.com.
 *
 * -2 (Core foundation) cho Grok integration. Mirror pattern
 * chat-content-chatgpt.js (Phase CG-2/CG-3) nhưng dùng DOM Grok thực tế.
 *
 * Trách nhiệm chính:
 *  - Tìm editor TipTap/ProseMirror, clear, insertText, submit qua Enter key.
 *  - Apply settings: mode (image/video), ratio dropdown, image_quality (image), duration + resolution (video).
 *  - Upload ref images qua hidden file input.
 *  - Snapshot URL baseline → wait redirect sang /imagine/post/{uuid} → extract media URLs.
 *  - Detect login + error patterns (RATE_LIMIT/CONTENT_BLOCKED/NETWORK).
 *  - Listener `grok:submitAndWait`: full submit pipeline trả về { success, mediaUrls, ... }.
 *  - Theo dõi navigate (SPA) → báo background.js để GrokSession invalidate cache.
 *
 * Dùng cùng pattern execCommand + KeyboardEvent giống grok-extension (verified).
 * KHÔNG dùng bridge — Grok ProseMirror chấp nhận execCommand trực tiếp.
 */

(function() {
  // Cờ chung để background.js (grok:injectScript) nhận biết script đã load.
  // Đặt TRƯỚC guard để dù script bị inject lại lần 2 thì flag vẫn = true (idempotent).
  window.__tobyflowGrokLoaded__ = true;

  // Guard against double injection
  if (window._grokInjected) return;
  window._grokInjected = true;

  // Helper: sleep
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // ============ i18n for FloatingTracker (content script lightweight i18n) ============
  const _i18n = {
    _lang: 'vi',
    _strings: {
      vi: {
        preparing: 'Đang chuẩn bị',
        waitingVerification: 'Chờ xác minh Cloudflare...',
        waitingResult: 'Đang chờ kết quả...',
      },
      en: {
        preparing: 'Preparing',
        waitingVerification: 'Waiting for Cloudflare...',
        waitingResult: 'Waiting for result...',
      },
      ja: {
        preparing: '準備中',
        waitingVerification: 'Cloudflare認証待ち...',
        waitingResult: '結果を待っています...',
      },
      th: {
        preparing: 'กำลังเตรียม',
        waitingVerification: 'รอ Cloudflare...',
        waitingResult: 'กำลังรอผลลัพธ์...',
      },
    },
    t(key) {
      return this._strings[this._lang]?.[key] || this._strings.vi[key] || key;
    },
  };

  // Load user language from storage (async, fallback to 'vi')
  chrome.storage.local.get(['af_settings', 'af_locale'], (res) => {
    _i18n._lang = res.af_locale || res.af_settings?.language || 'vi';
    console.log(`[Grok-i18n] Language loaded: ${_i18n._lang}`);
  });

  // ============ Dynamic Selector System (DOM Resilience) ============
  // Priority: Backend config → Hardcoded defaults
  const PROVIDER = 'grok';
  let _selectorConfig = null;
  let _selectorConfigTime = 0;
  const _SELECTOR_CACHE_TTL = 30000; // 30s

  // Server-Only: Strict Server-Only — NO hardcoded _FALLBACK_SELECTORS.
  const _SELECTOR_WAIT_MAX_MS = 10000;
  const _SELECTOR_WAIT_INTERVAL_MS = 200;

  // Overlay i18n (4 locales — reuse sidebar wording `dialog.offline` family).
  const _OVERLAY_I18N = {
    vi: { title: 'Mất kết nối Internet', desc: 'Vui lòng kiểm tra lại kết nối mạng của bạn để tiếp tục sử dụng.', retry: 'Thử lại' },
    en: { title: 'No Internet Connection', desc: 'Please check your network connection to continue.', retry: 'Retry' },
    ja: { title: 'インターネット接続なし', desc: 'ネットワーク接続を確認してから再度お試しください。', retry: '再試行' },
    th: { title: 'ไม่มีการเชื่อมต่ออินเทอร์เน็ต', desc: 'กรุณาตรวจสอบการเชื่อมต่อเครือข่ายเพื่อใช้งานต่อ', retry: 'ลองอีกครั้ง' },
  };

  (function _ensureSelectorConfig() {
    const startTime = Date.now();
    let attempts = 0;
    let lastLogElapsed = 0;
    console.log(`[Selector:${PROVIDER}:ensure] ⏳ Waiting for server config in chrome.storage.local (timeout ${_SELECTOR_WAIT_MAX_MS}ms)...`);
    function checkStorage() {
      attempts++;
      chrome.storage.local.get(['toby_provider_configs'], (res) => {
        if (res.toby_provider_configs?.data?.[PROVIDER]) {
          _selectorConfig = res.toby_provider_configs.data;
          _selectorConfigTime = Date.now();
          const keyCount = Object.keys(_selectorConfig[PROVIDER]?.selectors || {}).length;
          console.log(`[Selector:${PROVIDER}:ensure] ✅ Loaded ${keyCount} selectors after ${attempts} attempts (${Date.now() - startTime}ms)`);
          return;
        }
        try {
          chrome.runtime.sendMessage({ action: 'getProviderConfigs', provider: PROVIDER }, () => {
            if (chrome.runtime.lastError) { /* SW suspended — silent */ }
          });
        } catch (_) { /* SW disconnected — silent */ }
        const elapsed = Date.now() - startTime;
        if (elapsed - lastLogElapsed >= 1000) {
          lastLogElapsed = elapsed;
          console.log(`[Selector:${PROVIDER}:ensure] ⏳ Still waiting (${(elapsed / 1000).toFixed(1)}s/${_SELECTOR_WAIT_MAX_MS / 1000}s, attempt #${attempts}) — re-triggering background fetch`);
        }
        if (elapsed > _SELECTOR_WAIT_MAX_MS) {
          console.error(`[Selector:${PROVIDER}:ensure] ❌ Timeout after ${attempts} attempts (${elapsed}ms). Server unreachable — showing overlay.`);
          _showConfigErrorOverlay();
          return;
        }
        setTimeout(checkStorage, _SELECTOR_WAIT_INTERVAL_MS);
      });
    }
    checkStorage();
  })();

  function _showConfigErrorOverlay() { return;
    if (document.getElementById('tobyflow-config-error-overlay')) {
      console.log(`[Selector:${PROVIDER}:overlay] ↩ Overlay already mounted — skip`);
      return;
    }
    const lang = (_i18n && _i18n._lang) || 'vi';
    const t = _OVERLAY_I18N[lang] || _OVERLAY_I18N.vi;
    const overlay = document.createElement('div');
    overlay.id = 'tobyflow-config-error-overlay';
    overlay.className = 'tobyflow-cfg-err-overlay';
    overlay.innerHTML = `
      <style>
        .tobyflow-cfg-err-overlay { position: fixed; inset: 0; z-index: 2147483647; background: rgba(10,10,14,0.95); -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px); display: flex; align-items: center; justify-content: center; color: #fff; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
        .tobyflow-cfg-err-content { display: flex; flex-direction: column; align-items: center; text-align: center; padding: 32px; max-width: 320px; }
        .tobyflow-cfg-err-icon { width: 80px; height: 80px; border-radius: 50%; background: rgba(239,68,68,0.15); display: flex; align-items: center; justify-content: center; margin-bottom: 20px; }
        .tobyflow-cfg-err-icon svg { color: #ef4444; }
        .tobyflow-cfg-err-title { font-size: 18px; font-weight: 600; color: #fff; margin: 0 0 8px 0; }
        .tobyflow-cfg-err-desc { font-size: 14px; color: rgba(255,255,255,0.6); margin: 0 0 24px 0; line-height: 1.5; }
        .tobyflow-cfg-err-retry-btn { display: inline-flex; align-items: center; gap: 8px; padding: 10px 20px; background: #fff; color: #1a1a1e; border: none; border-radius: 8px; font-size: 14px; font-weight: 500; cursor: pointer; transition: opacity 0.2s; }
        .tobyflow-cfg-err-retry-btn:hover { opacity: 0.9; }
        .tobyflow-cfg-err-retry-btn:active { opacity: 0.8; }
        .tobyflow-cfg-err-retry-btn svg { color: #1a1a1e; }
      </style>
      <div class="tobyflow-cfg-err-content">
        <div class="tobyflow-cfg-err-icon">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <line x1="2" y1="2" x2="22" y2="22"></line>
            <path d="M8.5 16.5a5 5 0 0 1 7 0"></path>
            <path d="M2 8.82a15 15 0 0 1 4.17-2.65"></path>
            <path d="M10.66 5c4.01-.36 8.14.9 11.34 3.76"></path>
            <path d="M16.85 11.25a10 10 0 0 1 2.22 1.68"></path>
            <path d="M5 13a10 10 0 0 1 5.24-2.76"></path>
            <line x1="12" y1="20" x2="12.01" y2="20"></line>
          </svg>
        </div>
        <h3 class="tobyflow-cfg-err-title"></h3>
        <p class="tobyflow-cfg-err-desc"></p>
        <button class="tobyflow-cfg-err-retry-btn" type="button">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M21 2v6h-6"></path>
            <path d="M3 12a9 9 0 0 1 15-6.7L21 8"></path>
            <path d="M3 22v-6h6"></path>
            <path d="M21 12a9 9 0 0 1-15 6.7L3 16"></path>
          </svg>
          <span></span>
        </button>
      </div>
    `;
    // Set text via textContent (avoid HTML injection from i18n strings)
    overlay.querySelector('.tobyflow-cfg-err-title').textContent = t.title;
    overlay.querySelector('.tobyflow-cfg-err-desc').textContent = t.desc;
    overlay.querySelector('.tobyflow-cfg-err-retry-btn span').textContent = t.retry;
    document.body.appendChild(overlay);
    overlay.querySelector('.tobyflow-cfg-err-retry-btn').addEventListener('click', () => {
      console.log(`[Selector:${PROVIDER}:overlay] 🔄 User clicked retry — reloading page`);
      overlay.remove();
      location.reload();
    });
    console.warn(`[Selector:${PROVIDER}:overlay] 🚫 Config error overlay shown (lang=${lang}) — server unreachable, user action required`);
  }

  // Anti-clone overlay — hiển thị khi background broadcast EXTENSION_NOT_AUTHORIZED.
  function _showCloneDetectedOverlay() { return;
    if (document.getElementById('tobyflow-clone-detected-overlay')) return;
    const _lang = (_i18n && _i18n._lang) || 'vi';
    const titleMap = { vi:'Extension không hợp lệ', en:'Extension Not Authorized', ja:'拡張機能が許可されていません', th:'ส่วนขยายไม่ได้รับอนุญาต' };
    const descMap = { vi:'Phiên bản extension này không có quyền truy cập API Toby Flow. Vui lòng cài lại từ Chrome Web Store để tiếp tục sử dụng.', en:'This extension version is not authorized to access Toby Flow API. Please reinstall from the Chrome Web Store to continue.', ja:'この拡張機能のバージョンは Toby Flow API へのアクセスが許可されていません。Chrome ウェブストアから再インストールしてください。', th:'ส่วนขยายเวอร์ชันนี้ไม่ได้รับอนุญาตให้เข้าถึง API ของ Toby Flow โปรดติดตั้งใหม่จาก Chrome เว็บสโตร์' };
    const btnMap = { vi:'Mở Chrome Web Store', en:'Open Chrome Web Store', ja:'Chrome ウェブストアを開く', th:'เปิด Chrome เว็บสโตร์' };
    const overlay = document.createElement('div');
    overlay.id = 'tobyflow-clone-detected-overlay';
    // KHÔNG hiển thị chrome.runtime.id — tránh gợi ý attacker biết ID hợp lệ để giả.
    overlay.innerHTML = `
      <style>
        #tobyflow-clone-detected-overlay { position: fixed; inset: 0; z-index: 2147483647; background: rgba(10,10,14,0.97); -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px); display: flex; align-items: center; justify-content: center; color: #fff; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
        #tobyflow-clone-detected-overlay .cd-content { display: flex; flex-direction: column; align-items: center; text-align: center; padding: 32px; max-width: 340px; }
        #tobyflow-clone-detected-overlay .cd-icon { width: 80px; height: 80px; border-radius: 50%; background: rgba(239,68,68,0.15); display: flex; align-items: center; justify-content: center; margin-bottom: 20px; color: #ef4444; }
        #tobyflow-clone-detected-overlay .cd-title { font-size: 18px; font-weight: 600; color: #fff; margin: 0 0 8px 0; }
        #tobyflow-clone-detected-overlay .cd-desc { font-size: 14px; color: rgba(255,255,255,0.65); margin: 0 0 24px 0; line-height: 1.55; }
        #tobyflow-clone-detected-overlay .cd-btn { display: inline-flex; align-items: center; gap: 8px; padding: 10px 20px; background: #fff; color: #1a1a1e; border-radius: 8px; font-size: 14px; font-weight: 500; cursor: pointer; text-decoration: none; }
        #tobyflow-clone-detected-overlay .cd-btn:hover { opacity: 0.9; }
      </style>
      <div class="cd-content">
        <div class="cd-icon">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>
            <line x1="9" y1="9" x2="15" y2="15"></line>
            <line x1="15" y1="9" x2="9" y2="15"></line>
          </svg>
        </div>
        <h3 class="cd-title">${titleMap[_lang] || titleMap.vi}</h3>
        <p class="cd-desc">${descMap[_lang] || descMap.vi}</p>
        <a class="cd-btn" target="_blank" rel="noopener" href="https://chromewebstore.google.com/">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
            <polyline points="15 3 21 3 21 9"></polyline>
            <line x1="10" y1="14" x2="21" y2="3"></line>
          </svg>
          <span>${btnMap[_lang] || btnMap.vi}</span>
        </a>
      </div>
    `;
    document.body.appendChild(overlay);
    console.error(`[Auth:${PROVIDER}] 🛡️ Clone-detected overlay shown — extension not authorized`);
  }

  function _hideCloneDetectedOverlay() {
    const el = document.getElementById('tobyflow-clone-detected-overlay');
    if (el) el.remove();
  }

  (function _initCloneDetectedListener() {
    try {
      // Delay 800ms — đợi background self-heal probe chạy trước (tránh flicker).
      setTimeout(() => {
        chrome.storage.local.get('tobyflow_extension_not_authorized', (res) => {
          if (res && res.tobyflow_extension_not_authorized) _showCloneDetectedOverlay();
        });
      }, 800);
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        if (changes.tobyflow_extension_not_authorized) {
          if (changes.tobyflow_extension_not_authorized.newValue) _showCloneDetectedOverlay();
          else _hideCloneDetectedOverlay();
        }
      });
      if (chrome.runtime && chrome.runtime.onMessage) {
        chrome.runtime.onMessage.addListener((msg) => {
          if (msg && msg.type === 'EXTENSION_NOT_AUTHORIZED') _showCloneDetectedOverlay();
          else if (msg && msg.type === 'EXTENSION_AUTHORIZED') _hideCloneDetectedOverlay();
        });
      }
      // Manual retry: click overlay → trigger background probe.
      document.addEventListener('click', (e) => {
        if (e.target?.closest?.('#tobyflow-clone-detected-overlay')) {
          try { chrome.runtime.sendMessage({ type: 'EXTENSION_AUTH_RETRY' }); } catch (_) {}
        }
      }, true);
    } catch (_) {}
  })();

  function _getDynamicSelector(key) {
    const now = Date.now();
    if (_selectorConfig && (now - _selectorConfigTime) < _SELECTOR_CACHE_TTL) {
      return _selectorConfig?.[PROVIDER]?.selectors?.[key] || null;
    }
    chrome.storage.local.get(['toby_provider_configs'], (res) => {
      if (res.toby_provider_configs?.data) {
        _selectorConfig = res.toby_provider_configs.data;
        _selectorConfigTime = Date.now();
      }
    });
    return _selectorConfig?.[PROVIDER]?.selectors?.[key] || null;
  }

  function _selStr(key) {
    const cfg = _getDynamicSelector(key);
    return cfg?.selectors?.length ? cfg.selectors.join(', ') : null;
  }

  function _q(key, scope = document) {
    const s = _selStr(key);
    if (!s) { console.debug(`[Tier3] _q(${key}) miss`); return null; }
    return scope.querySelector(s);
  }

  function _qa(key, scope = document) {
    const s = _selStr(key);
    if (!s) { console.debug(`[Tier3] _qa(${key}) miss`); return []; }
    return scope.querySelectorAll(s);
  }

  function _queryWithFallback(key, defaultSelectors = null, options = {}) {
    const config = _getDynamicSelector(key);
    const hardcoded = defaultSelectors || []; // Server-Only: _FALLBACK_SELECTORS removed
    const isDynamic = config?.selectors?.length > 0;
    const selectors = isDynamic ? config.selectors : hardcoded;
    const silent = options.silent || false;

    if (!silent) console.log(`[Selector:${PROVIDER}:${key}] ${isDynamic ? '🌐 DYNAMIC' : '📦 HARDCODED'} | Trying ${selectors.length} selectors`);

    for (let i = 0; i < selectors.length; i++) {
      try {
        const el = document.querySelector(selectors[i]);
        if (el) {
          console.log(`[Selector:${PROVIDER}:${key}] ✅ Match #${i + 1}: ${selectors[i]}`);
          return el;
        }
      } catch (e) { /* invalid selector */ }
    }
    if (!silent) console.log(`[Selector:${PROVIDER}:${key}] ❌ No match`);
    return null;
  }

  function _queryAllWithFallback(key, defaultSelectors = null) {
    const config = _getDynamicSelector(key);
    const hardcoded = defaultSelectors || []; // Server-Only: _FALLBACK_SELECTORS removed
    const selectors = config?.selectors?.length > 0 ? config.selectors : hardcoded;

    for (let i = 0; i < selectors.length; i++) {
      try {
        const els = document.querySelectorAll(selectors[i]);
        if (els.length > 0) return els;
      } catch (e) { /* invalid selector */ }
    }
    return [];
  }

  // ============ Macro-delay giữa các BƯỚC CHÍNH — sync với Flow's inputTimeout setting ============
  //
  // CHIẾN LƯỢC:
  //   - Micro-delay (sleep nhỏ trong sub-step như focus, dispatch event) → GIỮ HARDCODE
  //   - Macro-delay (gap giữa bước chính: settings → clear → upload → mention → insert → submit)
  //     → DÙNG getMacroDelay() = inputTimeout × 0.7. User control tốc độ tổng qua setting này.
  //
  // 2 biến tracking:
  //   __grokInputTimeoutMs: GIÁ TRỊ user setting (lấy từ payload, default 1200ms)
  //   __grokMacroDelayMs:   BIẾN TRUNG GIAN = 70% inputTimeoutMs
  let __grokInputTimeoutMs = 1200;
  let __grokMacroDelayMs = Math.round(1200 * 0.7);  // 840ms

  function getMacroDelay() {
    return __grokMacroDelayMs;
  }

  // Helper: simulateClick — full pointer/mouse event chain (Radix UI cần PointerEvent)
  function simulateClick(el) {
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, pointerType: 'mouse' };
    el.dispatchEvent(new PointerEvent('pointerdown', opts));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new PointerEvent('pointerup', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
  }

  // Helper: clickViaReact — gọi React onClick handler trực tiếp (Radix menu items)
  function clickViaReact(el) {
    if (!el) return false;
    const propsKey = Object.keys(el).find(k => k.startsWith('__reactProps$'));
    if (propsKey && el[propsKey] && typeof el[propsKey].onClick === 'function') {
      el[propsKey].onClick({
        preventDefault() {},
        stopPropagation() {},
        nativeEvent: new MouseEvent('click', { bubbles: true }),
        type: 'click', target: el, currentTarget: el,
      });
      return true;
    }
    return false;
  }

  // Helper: waitForElement
  async function waitForElement(selector, timeout = 10000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const el = document.querySelector(selector);
      if (el) return el;
      await sleep(300);
    }
    return null;
  }

  // ============ FloatingTracker: Progress indicator cho Grok page (đồng bộ style với Flow) ============
  const FloatingTracker = {
    _el: null,
    _startTime: null,
    _elapsedTimer: null,

    _create() {
      if (this._el && document.body.contains(this._el)) return;
      const existing = document.getElementById('tobyflow-grok-tracker');
      if (existing) existing.remove();

      const el = document.createElement('div');
      el.id = 'tobyflow-grok-tracker';
      el.style.cssText = `
        position: fixed; bottom: 16px; right: 18px; width: 280px;
        background: rgba(18,18,22,0.95); border: 1px solid rgba(255,255,255,0.1);
        border-radius: 12px; box-shadow: 0 8px 32px rgba(0,0,0,0.5);
        z-index: 2147483647; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 13px; color: #fff; display: none; overflow: hidden;
      `;
      el.innerHTML = `
        <div style="display:flex;align-items:center;gap:6px;padding:8px 12px;background:#1fbd53;border-bottom:1px solid rgba(255,255,255,0.15);">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0">
            <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
          </svg>
          <span style="flex:1;font-weight:600;font-size:12px;">Grok</span>
          <span class="tobyflow-ft-counter" style="font-size:11px;opacity:0.7;font-variant-numeric:tabular-nums;"></span>
          <span class="tobyflow-ft-elapsed" style="font-size:10px;opacity:0.5;font-variant-numeric:tabular-nums;margin-left:4px;"></span>
        </div>
        <div style="height:3px;background:rgba(255,255,255,0.08);overflow:hidden;">
          <div class="tobyflow-ft-progress" style="height:100%;width:0%;background:linear-gradient(90deg,#3b82f6,#60a5fa,#a78bfa);transition:width 0.3s ease-out;"></div>
        </div>
        <div class="tobyflow-ft-status" style="padding:8px 12px;font-size:11px;color:rgba(255,255,255,0.7);"></div>
      `;
      document.body.appendChild(el);
      this._el = el;
    },

    show(data) {
      this._create();
      this._el.style.display = 'block';
      this._startTime = Date.now();
      this._startElapsedTimer();
      this.update(data);
    },

    update(data) {
      if (!this._el) return;
      const { current = 0, total = 1, phase = '', prompt = '' } = data || {};
      const pct = total > 0 ? Math.round((current / total) * 100) : 0;

      this._el.querySelector('.tobyflow-ft-counter').textContent = `${current}/${total}`;
      this._el.querySelector('.tobyflow-ft-progress').style.width = `${pct}%`;

      let statusText = phase;
      if (prompt) statusText += `: ${prompt.substring(0, 40)}${prompt.length > 40 ? '...' : ''}`;
      this._el.querySelector('.tobyflow-ft-status').textContent = statusText;
    },

    _startElapsedTimer() {
      this._stopElapsedTimer();
      const elapsedEl = this._el?.querySelector('.tobyflow-ft-elapsed');
      if (!elapsedEl) return;
      this._elapsedTimer = setInterval(() => {
        const elapsed = Date.now() - this._startTime;
        const s = Math.floor(elapsed / 1000);
        const m = Math.floor(s / 60);
        elapsedEl.textContent = `${m < 10 ? '0' : ''}${m}:${(s % 60) < 10 ? '0' : ''}${s % 60}`;
      }, 1000);
    },

    _stopElapsedTimer() {
      if (this._elapsedTimer) {
        clearInterval(this._elapsedTimer);
        this._elapsedTimer = null;
      }
    },

    hide() {
      this._stopElapsedTimer();
      if (this._el) this._el.style.display = 'none';
    }
  };

  // ============ ExecutionBlocker: Block user interaction khi đang gen ============
  const ExecutionBlocker = {
    _el: null,
    _styleEl: null,
    _blocking: false,
    _escapeCount: 0,
    _escapeTimer: null,
    _timeoutId: null,
    _MAX_BLOCK_TIME: 3 * 60 * 1000, // 3 phút auto-timeout

    _injectStyles() {
      if (this._styleEl) return;
      const style = document.createElement('style');
      style.id = 'tobyflow-grok-blocker-styles';
      style.textContent = `
        @keyframes tobyflow-glow-pulse {
          0%, 100% { opacity: 0.4; }
          50% { opacity: 0.7; }
        }
        #tobyflow-grok-blocker {
          position: fixed; inset: 0; z-index: 2147483646;
          pointer-events: all; cursor: not-allowed; background: transparent;
        }
        #tobyflow-grok-blocker::before {
          content: ''; position: absolute; inset: 0;
          border: 5px solid #cdff01;
          border-radius: 12px;
          box-shadow:
            inset 0 0 0 2px rgba(205,255,1,0.5),
            inset 0 0 15px rgba(205,255,1,0.3),
            0 0 15px rgba(205,255,1,0.5),
            0 0 35px rgba(205,255,1,0.35),
            0 0 60px rgba(205,255,1,0.2),
            0 0 100px rgba(205,255,1,0.1);
          animation: tobyflow-glow-pulse 1.8s ease-in-out infinite;
          will-change: opacity;
          pointer-events: none;
        }
      `;
      document.head.appendChild(style);
      this._styleEl = style;
    },

    _blockEvent(e) {
      if (!ExecutionBlocker._blocking) return;
      if (!e.isTrusted) return; // Allow programmatic events
      if (e.target?.closest?.('#tobyflow-grok-tracker')) return; // Allow tracker clicks

      // Escape hatch: 3x Escape to force hide
      if (e.type === 'keydown' && e.key === 'Escape') {
        ExecutionBlocker._escapeCount++;
        clearTimeout(ExecutionBlocker._escapeTimer);
        ExecutionBlocker._escapeTimer = setTimeout(() => { ExecutionBlocker._escapeCount = 0; }, 2000);
        if (ExecutionBlocker._escapeCount >= 3) {
          console.warn('[Grok-ExecutionBlocker] Force hide via Escape x3');
          ExecutionBlocker._escapeCount = 0;
          ExecutionBlocker.hide();
          __grokAbort = true;
          __grokAbortAt = Date.now();
          return;
        }
      }
      e.stopPropagation();
      e.stopImmediatePropagation();
      e.preventDefault();
    },

    _attachBlockers() {
      if (this._blocking) return;
      this._blocking = true;
      const events = ['mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu', 'wheel', 'touchstart', 'touchend', 'keydown', 'keyup'];
      events.forEach(evt => document.addEventListener(evt, this._blockEvent, { capture: true, passive: false }));
    },

    _detachBlockers() {
      if (!this._blocking) return;
      this._blocking = false;
      const events = ['mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu', 'wheel', 'touchstart', 'touchend', 'keydown', 'keyup'];
      events.forEach(evt => document.removeEventListener(evt, this._blockEvent, { capture: true }));
    },

    show() {
      this._injectStyles();
      this._attachBlockers();
      this._startTimeout();
      if (this._el) { this._el.style.display = 'block'; return; }
      const el = document.createElement('div');
      el.id = 'tobyflow-grok-blocker';
      document.body.appendChild(el);
      this._el = el;
    },

    _startTimeout() {
      this._stopTimeout();
      this._timeoutId = setTimeout(() => {
        console.warn('[Grok-ExecutionBlocker] Auto-timeout, force hiding');
        this.hide();
        __grokAbort = true;
        __grokAbortAt = Date.now();
      }, this._MAX_BLOCK_TIME);
    },

    _stopTimeout() {
      if (this._timeoutId) { clearTimeout(this._timeoutId); this._timeoutId = null; }
    },

    hide() {
      this._detachBlockers();
      this._stopTimeout();
      this._escapeCount = 0;
      clearTimeout(this._escapeTimer);
      if (this._el) this._el.style.display = 'none';
    }
  };

  // ============ G-2.2: findGrokEditor ============
  // Verified từ grok-extension/grok-content.js — TipTap/ProseMirror.
  // Priority: Backend config → form contenteditable → .ProseMirror → .tiptap → any contenteditable.
  function findGrokEditor() {
    return _queryWithFallback('composer');
  }

  // ============ Pattern config (admin-tunable) ============
  // Patterns từ /admin/providers/grok → API Configs → GET /api/v1/providers/api-configs
  // GrokConfig fetch + cache vào chrome.storage.local.af_grok_config (TTL 1h).
  //
  // Strict Server-Only — NO hardcoded FALLBACK_GROK_PATTERNS.
  // Patterns đọc 100% từ `chrome.storage.local.af_grok_config` (background.js preload
  // hoặc GrokConfig sidebar fetcher từ provider_configs.api_config.error_patterns).
  let _grokPatterns = {
    rateLimit: [],
    contentBlocked: [],
    network: [],
    cloudflare: [],
    subscriptionRequired: [],
    notLoggedIn: [],   // [Bug 61 fix 2026-05-24] Text patterns detect button Sign in/Sign up khi chưa login
  };

  function _parsePatternStr(str) {
    if (!str || typeof str !== 'string') return [];
    return str.split('|').map(s => s.trim().toLowerCase()).filter(Boolean);
  }

  /**
   * Load patterns từ chrome.storage.local.af_grok_config.
   * @returns {Promise<boolean>} true nếu load có ít nhất 1 pattern
   */
  async function _loadGrokPatternsFromStorage() {
    try {
      const result = await new Promise((r) => chrome.storage.local.get(['af_grok_config'], r));
      const cfg = result?.af_grok_config?.data;
      if (!cfg) return false;
      _grokPatterns.rateLimit = _parsePatternStr(cfg.rate_limit_text);
      _grokPatterns.contentBlocked = _parsePatternStr(cfg.content_blocked_text);
      _grokPatterns.network = _parsePatternStr(cfg.network_error_text);
      _grokPatterns.cloudflare = _parsePatternStr(cfg.cloudflare_challenge_text);
      _grokPatterns.subscriptionRequired = _parsePatternStr(cfg.subscription_required_text);
      _grokPatterns.notLoggedIn = _parsePatternStr(cfg.not_logged_in_text);
      const total = Object.values(_grokPatterns).reduce((s, a) => s + a.length, 0);
      return total > 0;
    } catch (e) {
      return false;
    }
  }

  // Server-Only: Wait/retry pattern (giống _ensureSelectorConfig). Khác selectors:
  // KHÔNG block UI overlay vì error/cloudflare detection degrade gracefully.
  const _GROK_PATTERNS_WAIT_MAX_MS = 10000;
  const _GROK_PATTERNS_WAIT_INTERVAL_MS = 500;

  (async function _ensureGrokPatternsConfig() {
    const startTime = Date.now();
    let attempts = 0;
    let lastLogElapsed = 0;
    console.log(`[Grok:patterns:ensure] ⏳ Waiting for error patterns in chrome.storage.local.af_grok_config (timeout ${_GROK_PATTERNS_WAIT_MAX_MS}ms)...`);
    while (Date.now() - startTime < _GROK_PATTERNS_WAIT_MAX_MS) {
      attempts++;
      const ok = await _loadGrokPatternsFromStorage();
      if (ok) {
        const total = Object.values(_grokPatterns).reduce((s, a) => s + a.length, 0);
        console.log(`[Grok:patterns:ensure] ✅ Loaded ${total} patterns across ${Object.keys(_grokPatterns).length} categories after ${attempts} attempts (${Date.now() - startTime}ms)`);
        return;
      }
      try {
        chrome.runtime.sendMessage({ action: 'getProviderConfigs', provider: 'grok' }, () => {
          if (chrome.runtime.lastError) { /* SW suspended — silent */ }
        });
      } catch (_) { /* SW disconnected — silent */ }
      const elapsed = Date.now() - startTime;
      if (elapsed - lastLogElapsed >= 2000) {
        lastLogElapsed = elapsed;
        console.log(`[Grok:patterns:ensure] ⏳ Still waiting (${(elapsed / 1000).toFixed(1)}s/${_GROK_PATTERNS_WAIT_MAX_MS / 1000}s, attempt #${attempts})...`);
      }
      await new Promise(r => setTimeout(r, _GROK_PATTERNS_WAIT_INTERVAL_MS));
    }
    console.warn(`[Grok:patterns:ensure] ⚠️ Timeout after ${attempts} attempts — error/cloudflare detection degraded (cannot auto-detect CONTENT_BLOCKED/RATE_LIMIT/Cloudflare challenge). User vẫn submit được, chỉ là tracker hiển thị TIMEOUT thay vì error code chính xác.`);
  })();

  // Listen storage changes — khi sidebar refresh GrokConfig, tab grok.com cũng cập nhật
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.af_grok_config) {
        _loadGrokPatternsFromStorage();
      }
    });
  } catch (e) { /* ignore in non-extension context */ }

  // ============ Cloudflare challenge detection ============
  // Grok dùng Cloudflare turnstile. Tab inactive → turnstile có thể KHÔNG tự complete →
  // DOM operations chạy nhưng request bị Cloudflare block → gen processing mãi mãi.
  //
  // Detect strategies (mạnh → yếu):
  //   1. iframe[src*="challenges.cloudflare.com" / "turnstile"] — selector mạnh, locale-agnostic
  //   2. .cf-turnstile, [data-cf-turnstile] — container class, locale-agnostic
  //   3. Text overlay match patterns (admin-tunable qua _grokPatterns.cloudflare)
  //      → fallback khi Cloudflare đổi locale (Vietnamese/Thai/Japanese...)
  function detectCloudflareChallenge() {
    // Pattern 1: turnstile iframe (dynamic selector)
    // silent: true để giảm log noise (check này chạy mỗi polling iteration)
    if (_queryWithFallback('cloudflare_iframe', null, { silent: true })) return true;

    // Pattern 2: turnstile container div (dynamic selector)
    if (_queryWithFallback('cloudflare_turnstile', null, { silent: true })) return true;

    // Pattern 3: text indicator (admin-tunable). Chỉ scan element overlay (fixed/dialog)
    // để tránh false positive khi text xuất hiện trong content thông thường.
    const cloudflarePatterns = _grokPatterns.cloudflare;
    if (cloudflarePatterns.length === 0) return false;
    const overlays = _qa('cloudflare_overlay_dialog');
    for (const el of overlays) {
      const txt = (el.innerText || '').toLowerCase();
      if (cloudflarePatterns.some(p => txt.includes(p))) {
        // Verify still visible
        const style = window.getComputedStyle(el);
        if (style.display !== 'none' && style.visibility !== 'hidden') return true;
      }
    }
    return false;
  }

  // Attempt to trigger Cloudflare turnstile verification
  // Multiple strategies based on 2026 research:
  // 1. Gọi turnstile API nếu available (execute/reset)
  // 2. Focus + click vào turnstile iframe
  // 3. Click vào page để trigger general interaction
  // 4. Keyboard events (Space/Enter) trên focused element
  function attemptCloudflareClick() {
    console.log('[Grok] Attempting Cloudflare verification trigger...');

    // Strategy 0: Gọi Cloudflare Turnstile API nếu available
    // Turnstile expose window.turnstile với các methods: execute(), reset(), getResponse()
    if (window.turnstile) {
      try {
        // Tìm widget ID từ iframe hoặc container
        const turnstileIframe = _queryWithFallback('cloudflare_iframe');
        const widgetId = turnstileIframe?.id?.replace('cf-chl-widget-', '') || null;

        if (typeof window.turnstile.execute === 'function') {
          console.log('[Grok] Calling turnstile.execute()...');
          window.turnstile.execute(widgetId);
        } else if (typeof window.turnstile.reset === 'function') {
          console.log('[Grok] Calling turnstile.reset() to retry verification...');
          window.turnstile.reset(widgetId);
        }
      } catch (e) {
        console.warn('[Grok] Turnstile API call failed:', e.message);
      }
    }

    // Strategy 1: Focus + click vào turnstile iframe
    // Iframe ID pattern: cf-chl-widget-xxxxx
    const turnstileIframe = _queryWithFallback('cloudflare_iframe');
    if (turnstileIframe) {
      try {
        // Scroll into view để đảm bảo visible
        turnstileIframe.scrollIntoView({ behavior: 'instant', block: 'center' });

        // Focus iframe
        turnstileIframe.focus();

        const rect = turnstileIframe.getBoundingClientRect();
        // Click vào vị trí checkbox (thường ở bên trái, ~20px từ left, center vertically)
        const checkboxX = rect.left + 25;
        const checkboxY = rect.top + rect.height / 2;

        // Dispatch full mouse event sequence: mouseover → mousedown → mouseup → click
        const eventOptions = {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: checkboxX,
          clientY: checkboxY,
          button: 0,
          buttons: 1
        };

        turnstileIframe.dispatchEvent(new MouseEvent('mouseover', eventOptions));
        turnstileIframe.dispatchEvent(new MouseEvent('mousedown', eventOptions));
        turnstileIframe.dispatchEvent(new MouseEvent('mouseup', eventOptions));
        turnstileIframe.dispatchEvent(new MouseEvent('click', eventOptions));

        console.log('[Grok] Clicked turnstile iframe at checkbox position:', Math.round(checkboxX), Math.round(checkboxY));

        // Dispatch keyboard event (Space/Enter) sau khi focus — một số CF checks accept này
        turnstileIframe.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', keyCode: 32, bubbles: true }));
        turnstileIframe.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', code: 'Space', keyCode: 32, bubbles: true }));
        console.log('[Grok] Dispatched Space key on turnstile iframe');
      } catch (e) {
        console.warn('[Grok] Turnstile iframe interaction failed:', e.message);
      }
    }

    // Strategy 2: Click vào turnstile container (nếu có)
    const turnstileContainer = _queryWithFallback('cloudflare_turnstile');
    if (turnstileContainer) {
      try {
        const rect = turnstileContainer.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;

        const clickEvent = new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: centerX,
          clientY: centerY
        });
        turnstileContainer.dispatchEvent(clickEvent);
        console.log('[Grok] Clicked turnstile container at', Math.round(centerX), Math.round(centerY));
      } catch (e) {
        console.warn('[Grok] Turnstile container click failed:', e.message);
      }
    }

    // Strategy 3: Focus window + click page body để trigger general interaction
    try {
      window.focus();
      document.body.focus();

      const bodyClickEvent = new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: window.innerWidth / 2,
        clientY: window.innerHeight / 2
      });
      document.body.dispatchEvent(bodyClickEvent);
      console.log('[Grok] Clicked page body center');
    } catch (e) {
      console.warn('[Grok] Body click failed:', e.message);
    }

    // Strategy 4: Trigger full mouse sequence (some CF checks look for realistic mouse behavior)
    try {
      const centerX = window.innerWidth / 2;
      const centerY = window.innerHeight / 2;

      // Mousemove from corner to center (simulate real mouse movement)
      for (let i = 0; i <= 5; i++) {
        const x = (centerX * i) / 5;
        const y = (centerY * i) / 5;
        document.body.dispatchEvent(new MouseEvent('mousemove', {
          bubbles: true, view: window, clientX: x, clientY: y
        }));
      }

      // Full click sequence
      document.body.dispatchEvent(new MouseEvent('mousedown', {
        bubbles: true, cancelable: true, view: window,
        clientX: centerX, clientY: centerY, button: 0, buttons: 1
      }));
      document.body.dispatchEvent(new MouseEvent('mouseup', {
        bubbles: true, cancelable: true, view: window,
        clientX: centerX, clientY: centerY, button: 0, buttons: 0
      }));
      console.log('[Grok] Dispatched realistic mouse movement + click sequence');
    } catch (e) {
      console.warn('[Grok] Mouse sequence failed:', e.message);
    }
  }

  // Wait Cloudflare challenge resolved. Activate tab + thông báo background.
  // Poll DOM cho tới khi challenge biến mất (max timeoutMs).
  // Trả: true nếu resolved, false nếu timeout.
  async function waitForCloudflareResolved(timeoutMs = 120000) {
    if (!detectCloudflareChallenge()) return true; // Không có challenge

    console.warn('[Grok] Cloudflare challenge detected — request tab activate + auto-click + chờ verify');

    // Bug fix 2026-05-28: ExecutionBlocker (overlay pointer-events:all + capture listeners chặn click
    // isTrusted) → user KHÔNG click được Cloudflare captcha (auto-click programmatic không qua nổi
    // captcha thật). ẨN blocker để user tương tác captcha; re-show sau khi resolved để block tiếp gen.
    const _wasBlocking = ExecutionBlocker._blocking;
    if (_wasBlocking) {
      console.log('[Grok] Ẩn ExecutionBlocker để user click Cloudflare captcha');
      ExecutionBlocker.hide();
    }
    const _restoreBlocker = () => { if (_wasBlocking && !isAbortActive()) ExecutionBlocker.show(); };

    // Fix: Notify sidebar về challenge để show persistent notification.
    // User cần click vào màn hình verify nếu auto-click không qua được captcha.
    const _notifySidebar = (phase, elapsedSec = 0) => {
      try {
        chrome.runtime.sendMessage({
          action: 'cloudflare:challenge',
          provider: 'grok',
          phase, // 'detected' | 'waiting' | 'resolved' | 'timeout'
          elapsedSec,
          timeoutSec: Math.round(timeoutMs / 1000),
        }).catch(() => {});
      } catch (_) {}
    };
    _notifySidebar('detected', 0);

    // Notify background activate tab + bring window to front (cần user thấy).
    // Background có handler grok:ensureActive (CG-2 phase G-2). Add new flag focusWindow=true.
    try {
      await new Promise((resolve) => {
        chrome.runtime.sendMessage(
          { action: 'grok:ensureActive', focusWindow: true, reason: 'cloudflare_challenge' },
          () => resolve()
        );
      });
    } catch (_) {}

    // Chờ tab activate + DOM settle
    await sleep(500);

    // Attempt auto-click để trigger verification
    attemptCloudflareClick();

    // Poll cho đến khi challenge biến mất hoặc timeout
    const start = Date.now();
    let lastLog = 0;
    let clickAttempts = 1; // Đã click 1 lần ở trên
    const MAX_CLICK_ATTEMPTS = 5;
    const CLICK_RETRY_INTERVAL = 10000; // Retry click mỗi 10s

    while (Date.now() - start < timeoutMs) {
      if (isAbortActive()) return false;
      if (!detectCloudflareChallenge()) {
        const elapsedSec = Math.round((Date.now() - start) / 1000);
        console.log('[Grok] Cloudflare challenge resolved sau', elapsedSec, 's');
        _notifySidebar('resolved', elapsedSec);
        // Sleep nhỏ cho cookie/session settle
        await sleep(800);
        _restoreBlocker(); // re-show ExecutionBlocker — block tiếp phần gen còn lại
        // Trả focus về popup workflow/sidebar (window trước Cloudflare) — không kẹt ở tab grok.
        try { chrome.runtime.sendMessage({ action: 'grok:restoreFocus' }, () => {}); } catch (_) {}
        return true;
      }
      // Log mỗi 10s để user thấy đang chờ
      const elapsed = Date.now() - start;
      if (elapsed - lastLog >= 10000) {
        const elapsedSec = Math.round(elapsed / 1000);
        console.log('[Grok] Vẫn chờ Cloudflare challenge resolved...', elapsedSec, 's');
        lastLog = elapsed;
        _notifySidebar('waiting', elapsedSec);

        // Retry click mỗi 10s (max 5 lần)
        if (clickAttempts < MAX_CLICK_ATTEMPTS) {
          console.log('[Grok] Retry click attempt', clickAttempts + 1);
          attemptCloudflareClick();
          clickAttempts++;
        }
      }
      await sleep(800);
    }
    console.error('[Grok] Cloudflare challenge timeout sau', timeoutMs / 1000, 's');
    _notifySidebar('timeout', Math.round(timeoutMs / 1000));
    return false;
  }

  // ============ Age Verification Modal Detection & Handling ============
  // Grok hiển thị modal xác nhận tuổi khi submit prompt lần đầu.
  // Modal: [data-analytics-name="age_verification"]
  // Flow: detect modal → scroll đến năm >= 18 tuổi → click chọn → click Continue
  function detectAgeVerificationModal() {
    const modal = _queryWithFallback('age_verification_modal');
    return !!modal;
  }

  async function handleAgeVerificationModal(timeoutMs = 30000) {
    const modal = _queryWithFallback('age_verification_modal');
    if (!modal) return true; // Không có modal → pass

    console.log('[Grok] Age verification modal detected — auto-selecting birth year');

    try {
      // 1. Tìm scroll container chứa các năm
      const scrollContainer = _q('age_verification_scroll_container', modal);
      if (!scrollContainer) {
        console.warn('[Grok] Age verification: không tìm thấy scroll container');
        return false;
      }

      // 2. Tìm tất cả year buttons
      const yearButtons = _qa('age_verification_year_button', scrollContainer);
      if (yearButtons.length === 0) {
        console.warn('[Grok] Age verification: không tìm thấy year buttons');
        return false;
      }

      // 3. Tìm năm để chọn (>= 18 tuổi, ví dụ năm 2000)
      const currentYear = new Date().getFullYear();
      const targetYear = currentYear - 25; // Chọn 25 tuổi để safe
      let targetButton = null;

      for (const btn of yearButtons) {
        const yearText = (btn.textContent || '').trim();
        const year = parseInt(yearText, 10);
        if (!isNaN(year) && year <= targetYear) {
          targetButton = btn;
          break;
        }
      }

      // Fallback: chọn năm 2000 hoặc năm gần targetYear nhất
      if (!targetButton) {
        for (const btn of yearButtons) {
          const yearText = (btn.textContent || '').trim();
          if (yearText === '2000' || yearText === '1995' || yearText === '1990') {
            targetButton = btn;
            break;
          }
        }
      }

      if (!targetButton) {
        console.warn('[Grok] Age verification: không tìm thấy năm phù hợp');
        return false;
      }

      // 4. Scroll đến button và click. Fix: abort checks giữa các steps.
      if (isAbortActive()) return false;
      targetButton.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await sleep(300);
      if (isAbortActive()) return false;

      // Click via React hoặc simulateClick
      if (!clickViaReact(targetButton)) {
        simulateClick(targetButton);
      }
      console.log('[Grok] Age verification: đã chọn năm', targetButton.textContent?.trim());
      await sleep(500);
      if (isAbortActive()) return false;

      // 5. Tìm và click Continue button — text match trên year_button selector
      const allBtns = _qa('age_verification_year_button', modal);
      let continueBtnFound = null;
      for (const btn of allBtns) {
        const txt = (btn.textContent || '').toLowerCase().trim();
        if (txt === 'continue' && !btn.disabled) {
          continueBtnFound = btn;
          break;
        }
      }

      if (!continueBtnFound) {
        // Fallback: tìm continue button qua specific selector (button class footer)
        const footerBtns = _qa('age_verification_continue_button', modal);
        for (const btn of footerBtns) {
          if (!btn.disabled) {
            continueBtnFound = btn;
            break;
          }
        }
      }

      if (!continueBtnFound) {
        console.warn('[Grok] Age verification: Continue button vẫn disabled hoặc không tìm thấy');
        // Retry wait cho button enable. Fix: abort check trong retry loop.
        const start = Date.now();
        while (Date.now() - start < 5000) {
          if (isAbortActive()) return false;
          await sleep(300);
          for (const btn of allBtns) {
            const txt = (btn.textContent || '').toLowerCase().trim();
            if (txt === 'continue' && !btn.disabled) {
              continueBtnFound = btn;
              break;
            }
          }
          if (continueBtnFound) break;
        }
      }

      if (continueBtnFound) {
        if (isAbortActive()) return false;
        if (!clickViaReact(continueBtnFound)) {
          simulateClick(continueBtnFound);
        }
        console.log('[Grok] Age verification: đã click Continue');
        await sleep(500);

        // 6. Wait modal close. Fix: abort check trong close-wait loop.
        const closeStart = Date.now();
        while (Date.now() - closeStart < 5000) {
          if (isAbortActive()) return false;
          if (!_queryWithFallback('age_verification_modal')) {
            console.log('[Grok] Age verification: modal đã đóng');
            return true;
          }
          await sleep(200);
        }
        console.warn('[Grok] Age verification: modal chưa đóng sau 5s');
        return !_queryWithFallback('age_verification_modal');
      }

      return false;
    } catch (err) {
      console.error('[Grok] Age verification error:', err.message);
      return false;
    }
  }

  // ============ G-2.2: clearEditor ============
  // Reference grok-extension pattern: execCommand selectAll + delete (KHÔNG dùng bridge).
  async function clearEditor(editor) {
    if (!editor) editor = findGrokEditor();
    if (!editor) return false;

    editor.focus();
    await sleep(100);
    document.execCommand('selectAll', false, null);
    document.execCommand('delete', false, null);

    // Fallback: dispatch beforeinput để TipTap nhận biết thay đổi
    editor.dispatchEvent(new InputEvent('beforeinput', {
      inputType: 'deleteContentBackward',
      bubbles: true, cancelable: true,
    }));

    if (!editor.textContent.trim()) return true;

    // Fallback cuối: direct innerHTML
    editor.innerHTML = '<p><br></p>';
    editor.dispatchEvent(new InputEvent('input', { bubbles: true }));
    return true;
  }

  // ============================================================================
  //  Grok insertText — // ============================================================================
  //  Editor: TipTap/ProseMirror (`div[contenteditable="true"].tiptap.ProseMirror`)
  //  CRITICAL: loại bỏ '@' tránh trigger autocomplete (Enter sẽ chọn mention thay vì submit).
  //
  //  ┌─ INSERT (3 tier, tất cả VERIFIED work) ───────────────────────────────┐
  //  │ Tier 1 'execCommand'  PRIMARY  ✅ verified (Test 1 smoke)              │
  //  │   → document.execCommand('insertText', false, text)                   │
  //  │ Tier 2 'beforeInput'  FALLBACK ✅ verified (Test 2)                    │
  //  │   → editor.dispatchEvent(InputEvent('beforeinput'))                   │
  //  │ Tier 3 'innerHTML'    LAST     ✅ verified (Test 3)                    │
  //  │   → editor.innerHTML = '<p>...</p>' + InputEvent('input')             │
  //  └────────────────────────────────────────────────────────────────────────┘
  //
  //  ┌─ Force test (cross-world dataset, set qua DevTools console) ──────────┐
  //  │ ✅ document.documentElement.dataset.tobyGrokInsertForce = '<tier>'     │
  //  │    Reset: delete document.documentElement.dataset.tobyGrokInsertForce  │
  //  │ ❌ window.__GROK_INSERT_FORCE_TIER = ... — KHÔNG work qua DevTools     │
  //  │    (content script ISOLATED world ≠ DevTools console MAIN world)      │
  //  └────────────────────────────────────────────────────────────────────────┘
  async function insertText(editor, text) {
    if (!editor) editor = findGrokEditor();
    if (!editor) return false;

    const sanitized = String(text || '').replace(/@/g, '');
    // Force flag: content script chạy ISOLATED world → không thấy window.* set qua DevTools console (MAIN world).
    // Đọc cả 2: window.* (nếu set qua background) + documentElement.dataset.* (cross-world an toàn).
    // User set qua console: document.documentElement.dataset.tobyGrokInsertForce = 'beforeInput'
    const force = window.__GROK_INSERT_FORCE_TIER
               || document.documentElement.dataset.tobyGrokInsertForce
               || null;

    editor.focus();
    await sleep(200);

    function verifyInserted() {
      const sample = sanitized.substring(0, Math.min(10, sanitized.length));
      return editor.textContent.includes(sample);
    }

    const impls = {
      execCommand: function() {
        console.log('[Grok] Insert[execCommand] try');
        document.execCommand('insertText', false, sanitized);
      },
      beforeInput: function() {
        console.log('[Grok] Insert[beforeInput] try');
        editor.dispatchEvent(new InputEvent('beforeinput', {
          inputType: 'insertText',
          data: sanitized,
          bubbles: true, cancelable: true,
        }));
      },
      innerHTML: function() {
        console.log('[Grok] Insert[innerHTML] try (last resort)');
        editor.innerHTML = `<p>${sanitized.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`;
        editor.dispatchEvent(new InputEvent('input', { bubbles: true, data: sanitized }));
      },
    };
    const order = ['execCommand', 'beforeInput', 'innerHTML'];

    // Forced isolation
    if (force && impls[force]) {
      console.log('[Grok] Insert [FORCE=' + force + ']');
      try {
        impls[force]();
        return verifyInserted();
      } catch (e) {
        console.warn('[Grok] FORCE ' + force + ' failed:', e.message);
        return false;
      }
    }

    // Production chain
    for (const tier of order) {
      try {
        impls[tier]();
        if (verifyInserted()) {
          console.log('[Grok] ✅ Insert success via:', tier);
          return true;
        }
      } catch (e) {
        console.warn('[Grok] Insert ' + tier + ' error:', e.message);
      }
    }

    console.warn('[Grok] ❌ All insert tiers failed');
    return false;
  }

  // ============================================================================
  //  Grok clickSubmit — // ============================================================================
  //  Verified DOM (data/dom/grok-dom/dom/grok-editor-dom.html):
  //    - Editor + submit button NẰM TRONG <form> wrapper                       ⭐
  // - Submit button (selector key submit_button)
  //    - Submit button KHÔNG có __reactProps$ keys (Object.keys() = [])
  //      → reactPropsClick/reactOnClick DEAD CODE → đã BỎ
  //
  //  ┌─ SUBMIT (4 tier, tất cả VERIFIED work) ───────────────────────────────┐
  //  │ Tier 1 'formRequestSubmit' PRIMARY ✅ verified (Test 5)                │
  //  │   → form.requestSubmit(submitBtn) — HTML standard, native trusted     │
  //  │   ⭐ SILVER BULLET — KHÔNG cần fake event, resilient nhất             │
  //  │ Tier 2 'enterKey'         FALLBACK ✅ verified (Test 1 smoke)          │
  //  │   → KeyboardEvent('keydown' + 'keyup') trên editor                    │
  //  │ Tier 3 'simulateClick'    FALLBACK ✅ verified (Test 6)                │
  //  │   → PointerEvent + MouseEvent chain trên submit button                │
  //  │ Tier 4 'nativeClick'      LAST     ✅ verified (Test 7)                │
  //  │   → submitBtn.click()                                                 │
  //  │ ❌ 'reactPropsClick' / 'reactOnClick' — BỎ (verified dead — Test 4)    │
  //  │   → button không có __reactProps$ key                                 │
  //  └────────────────────────────────────────────────────────────────────────┘
  //
  //  ┌─ Force test (cross-world dataset, set qua DevTools console) ──────────┐
  //  │ ✅ document.documentElement.dataset.tobyGrokSubmitForce = '<tier>'     │
  //  │    Reset: delete document.documentElement.dataset.tobyGrokSubmitForce  │
  //  │ ❌ window.__GROK_SUBMIT_FORCE_METHOD = ... — KHÔNG work qua DevTools   │
  //  └────────────────────────────────────────────────────────────────────────┘
  async function clickSubmit(editor) {
    if (!editor) editor = findGrokEditor();
    if (!editor) return false;

    // Force flag cross-world (xem giải thích trong insertText)
    // User set qua console: document.documentElement.dataset.tobyGrokSubmitForce = 'reactPropsClick'
    const force = window.__GROK_SUBMIT_FORCE_METHOD
               || document.documentElement.dataset.tobyGrokSubmitForce
               || null;

    editor.focus();
    await sleep(200);

    function findSubmitBtn() {
      return _queryWithFallback('submit_button');
    }

    // Verify helper: poll mỗi 200ms tới 1500ms xem editor clear (signal Grok accept submit)
    // Trước: cố định 500ms → quá ngắn → fall through nhầm → multi-submit risk.
    // Mới: poll 200ms × 7 = 1400ms max, return sớm khi detect clear.
    async function verifySubmitted() {
      const maxMs = 1500;
      const interval = 200;
      let elapsed = 0;
      while (elapsed < maxMs) {
        await sleep(interval);
        elapsed += interval;
        const len = (editor.textContent || '').trim().length;
        if (len < 3) {
          console.log('[Grok] Submit verify: ✅ editor cleared after ' + elapsed + 'ms');
          return true;
        }
      }
      const finalLen = (editor.textContent || '').trim().length;
      console.log('[Grok] Submit verify: ❌ editor still has text after ' + maxMs + 'ms (len=' + finalLen + ')');
      return false;
    }

    // Method 1: Enter keydown trên editor (grok-extension reference pattern)
    // Verified primary — Grok form lắng nghe Enter → trigger native submit handler.
    async function tryEnterKey() {
      console.log('[Grok] Submit enterKey');
      editor.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter', code: 'Enter', keyCode: 13,
        bubbles: true, cancelable: true,
      }));
      editor.dispatchEvent(new KeyboardEvent('keyup', {
        key: 'Enter', code: 'Enter', keyCode: 13,
        bubbles: true,
      }));
      return true;
    }

    // Method 2: form.requestSubmit(submitBtn) — HTML standard, native trusted submit
    // Resilient NHẤT với trust check vì native API, KHÔNG cần fake event.
    // Verified DOM: Grok có <form> wrapping editor + button.
    async function tryFormRequestSubmit() {
      const submitBtn = findSubmitBtn();
      if (!submitBtn) {
        console.log('[Grok] formRequestSubmit skip: submit button NOT FOUND');
        return false;
      }
      const form = submitBtn.closest('form') || editor.closest('form');
      if (!form) {
        console.log('[Grok] formRequestSubmit skip: <form> ancestor NOT FOUND');
        return false;
      }
      if (typeof form.requestSubmit !== 'function') {
        console.log('[Grok] formRequestSubmit skip: form.requestSubmit not available');
        return false;
      }
      console.log('[Grok] Submit formRequestSubmit: native HTML form submit');
      try {
        form.requestSubmit(submitBtn);
        return true;
      } catch (e) {
        console.warn('[Grok] formRequestSubmit error:', e.message, '- fallback form.submit()');
        try { form.submit(); return true; } catch (e2) {
          console.warn('[Grok] form.submit() also failed:', e2.message);
          return false;
        }
      }
    }

    // Method 3: full pointer event chain
    async function trySimulateClick() {
      const submitBtn = findSubmitBtn();
      if (!submitBtn || submitBtn.disabled) return false;
      console.log('[Grok] Submit simulateClick');
      simulateClick(submitBtn);
      return true;
    }

    // Method 4: native btn.click() (last resort)
    async function tryNativeClick() {
      const submitBtn = findSubmitBtn();
      if (!submitBtn || submitBtn.disabled) return false;
      console.log('[Grok] Submit nativeClick');
      submitBtn.click();
      return true;
    }

    const impls = {
      formRequestSubmit: tryFormRequestSubmit,
      enterKey: tryEnterKey,
      simulateClick: trySimulateClick,
      nativeClick: tryNativeClick,
    };
    // Production order theo độ resilient với trust check (verified test 5/6/7: cả 4 đều work):
    //   1. formRequestSubmit — native HTML, KHÔNG cần fake event → silver bullet
    //   2. enterKey          — KeyboardEvent (có thể bị siết tương lai)
    //   3. simulateClick     — MouseEvent (có thể bị siết)
    //   4. nativeClick       — btn.click() (có thể bị siết)
    const order = ['formRequestSubmit', 'enterKey', 'simulateClick', 'nativeClick'];

    // Forced isolation
    if (force && impls[force]) {
      console.log('[Grok] Submit [FORCE=' + force + ']');
      try {
        const ok = await impls[force]();
        if (!ok) return false;
        return await verifySubmitted();
      } catch (e) {
        console.warn('[Grok] FORCE ' + force + ' failed:', e.message);
        return false;
      }
    }

    // Production chain
    for (const method of order) {
      try {
        const triggered = await impls[method]();
        if (!triggered) continue;
        if (await verifySubmitted()) {
          console.log('[Grok] ✅ Submit success via:', method);
          return true;
        }
      } catch (e) {
        console.warn('[Grok] Submit ' + method + ' error:', e.message);
      }
    }

    console.warn('[Grok] ❌ All submit methods failed');
    return false;
  }

  // selectMode — chọn mode 'image' | 'video'.
  // Strategy 1: selector key generation_mode + text match từ backend.
  // Strategy 2: SVG path fallback (api_config key mode_toggle_svg_paths).
  async function selectMode(mode) {
    // Server-Only: nhãn mode đọc từ api_config 'mode_labels' (pipe-separated, đa ngôn ngữ —
    // vd "Image|Hình ảnh"). Bỏ hardcode "Image"/"Video". Fallback tối thiểu khi config chưa load
    // (degraded) — Strategy 2 SVG là backup language-independent.
    const labelCfg = await _getGrokApiConfig('mode_labels');
    if (!labelCfg) console.debug('[Tier3] Grok selectMode: mode_labels config miss → fallback tối thiểu');
    const rawLabels = labelCfg?.[mode] ?? (mode === 'video' ? 'Video' : 'Image');
    const targetTexts = String(rawLabels).split('|').map(s => s.trim().toLowerCase()).filter(Boolean);

    // Strategy 1: aria-label radiogroup (dynamic selector) — match text với BẤT KỲ nhãn nào.
    const group = _queryWithFallback('generation_mode');
    if (group) {
      const radios = group.querySelectorAll('[role="radio"]');
      for (const radio of radios) {
        const text = (radio.textContent || '').trim().toLowerCase();
        if (targetTexts.some(t => text === t || text.includes(t))) {
          if (radio.getAttribute('aria-checked') === 'true') return true; // already selected
          simulateClick(radio);
          return true;
        }
      }
    }

    // Strategy 2: SVG path fallback — đọc path prefix từ backend api_config.
    const svgPaths = await _getGrokApiConfig('mode_toggle_svg_paths');
    const pathPrefix = svgPaths?.[mode];
    if (pathPrefix) {
      const allBtns = document.querySelectorAll('button');
      for (const btn of allBtns) {
        const path = btn.querySelector(`path[d^="${pathPrefix}"]`);
        if (path) {
          simulateClick(btn);
          return true;
        }
      }
    } else {
      console.debug('[Tier3] Grok mode_toggle_svg_paths config miss — strategy 2 skip');
    }

    return false;
  }

  /**
   * Strict Server-Only: đọc api_config Grok từ chrome.storage.toby_provider_api_configs.
   * Background.js đã preload key này từ backend khi extension start.
   * @param {string} key - 'ratios' | 'supported_durations' | 'supported_resolutions' | 'supported_image_qualities'
   * @returns {Promise<any|null>}
   */
  async function _getGrokApiConfig(key) {
    try {
      const result = await new Promise((r) => chrome.storage.local.get(['toby_provider_api_configs'], r));
      const cfg = result?.toby_provider_api_configs?.data?.grok?.configs?.[key];
      return cfg ?? null;
    } catch (_) { return null; }
  }

  // ============ G-2.2: selectRatio ============
  // Aspect Ratio = DROPDOWN (Radix menu), KHÔNG phải radiogroup.
  // Flow: click ratio button → menu mở → click menu item.
  // Input ratioKey: 'portrait'/'landscape'/'square'/'story'/'widescreen'.
  // Strict Server-Only: displayMap derive từ backend ratios (ui_name → value).
  async function selectRatio(ratioKey) {
    const ratiosCfg = await _getGrokApiConfig('ratios');
    const list = ratiosCfg?.image || ratiosCfg?.video; // Grok hỗ trợ cả image + video, list giống nhau
    if (!Array.isArray(list) || list.length === 0) {
      console.debug('[Tier3] Grok selectRatio: ratios config miss');
      return false;
    }
    const displayMap = {};
    for (const r of list) {
      if (r?.ui_name && r?.value) displayMap[r.ui_name] = r.value;
    }
    const targetRatio = displayMap[ratioKey] || ratioKey;

    const ratioBtn = _queryWithFallback('ratio_button');
    if (!ratioBtn) return false;

    // Skip nếu đã đúng
    const currentRatio = ratioBtn.querySelector('span')?.textContent?.trim();
    if (currentRatio === targetRatio) return true;

    // Mở dropdown nếu chưa mở
    const isOpen = ratioBtn.getAttribute('data-state') === 'open' ||
                   ratioBtn.getAttribute('aria-expanded') === 'true' ||
                   ratioBtn.closest('[data-state]')?.dataset.state === 'open';
    if (!isOpen) {
      simulateClick(ratioBtn);
      await sleep(500);
      const menuVisible = _queryWithFallback('open_menu');
      if (!menuVisible) {
        clickViaReact(ratioBtn);
        await sleep(500);
      }
    }

    // Strategy 1: match aria-label theo ratio value
    let menuItem = document.querySelector(`button[aria-label="${targetRatio}"]`);

    // Strategy 2: menu items với span text match
    if (!menuItem) {
      const items = _qa('ratio_menu_item');
      for (const item of items) {
        const span = item.querySelector('span');
        if (span && span.textContent.trim() === targetRatio) {
          menuItem = item;
          break;
        }
      }
    }

    // Strategy 3: broad search trong Radix poppers (retry 5 lần)
    if (!menuItem) {
      for (let attempt = 0; attempt < 5; attempt++) {
        const _omS = _selStr('open_menu');
        const poppers = _omS ? document.querySelectorAll(_omS) : [];
        if (!_omS) console.debug('[Tier3] open_menu config miss');
        for (const popper of poppers) {
          const allEls = popper.querySelectorAll('span, div, button');
          for (const el of allEls) {
            if (el.textContent.trim() === targetRatio) {
              menuItem = el.closest('[role="menuitem"], [role="menuitemradio"], button, div[tabindex]') || el;
              break;
            }
          }
          if (menuItem) break;
        }
        if (menuItem) break;
        await sleep(150);
      }
    }

    if (menuItem) {
      simulateClick(menuItem);
      await sleep(200);
      // Verify
      const newRatio = ratioBtn.querySelector('span')?.textContent?.trim();
      if (newRatio === targetRatio) return true;

      // Fallback clickViaReact
      clickViaReact(menuItem);
      await sleep(200);
      return true;
    }

    // Đóng menu khi không tìm thấy
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return false;
  }

  // ============ G-2.2: selectVideoDuration ============
  // Strict Server-Only: supported_durations từ backend api_config.
  async function selectVideoDuration(duration) {
    const supported = await _getGrokApiConfig('supported_durations');
    if (!Array.isArray(supported) || supported.length === 0) {
      console.debug('[Tier3] Grok selectVideoDuration: supported_durations config miss');
      return false;
    }
    if (!supported.includes(duration)) {
      console.warn(`[Grok] selectVideoDuration: "${duration}" không có trong supported [${supported.join(',')}]`);
      return false;
    }
    const group = _queryWithFallback('video_duration_picker');
    if (!group) { console.warn('[Grok] selectVideoDuration: picker group không thấy'); return false; }
    // Match robust: exact textContent HOẶC số thuần ("10s"→"10") — Grok render radio đôi khi
    // có icon/whitespace/format khác ("10 s", "10sec") làm exact match fragile.
    const want = String(duration).trim().toLowerCase();
    const wantNum = want.replace(/[^0-9]/g, '');
    const radios = group.querySelectorAll('[role="radio"]');
    const seen = [];
    for (const radio of radios) {
      const txt = (radio.textContent || '').trim();
      seen.push(txt);
      const norm = txt.toLowerCase();
      if (norm === want || (wantNum && norm.replace(/[^0-9]/g, '') === wantNum)) {
        if (radio.getAttribute('aria-checked') === 'true') {
          console.log(`[Grok] selectVideoDuration: "${duration}" đã chọn sẵn`);
          return true;
        }
        simulateClick(radio);
        console.log(`[Grok] selectVideoDuration: clicked "${txt}" cho duration "${duration}"`);
        return true;
      }
    }
    console.warn(`[Grok] selectVideoDuration: KHÔNG match "${duration}". Radios: [${seen.join(' | ')}]`);
    return false;
  }

  // ============ G-2.2: selectVideoResolution ============
  // Strict Server-Only: supported_resolutions từ backend api_config.
  async function selectVideoResolution(resolution) {
    const supported = await _getGrokApiConfig('supported_resolutions');
    if (!Array.isArray(supported) || supported.length === 0) {
      console.debug('[Tier3] Grok selectVideoResolution: supported_resolutions config miss');
      return false;
    }
    if (!supported.includes(resolution)) {
      console.warn(`[Grok] selectVideoResolution: "${resolution}" không có trong supported [${supported.join(',')}]`);
      return false;
    }
    const group = _queryWithFallback('video_resolution_picker');
    if (!group) { console.warn('[Grok] selectVideoResolution: picker group không thấy'); return false; }
    // Match robust: exact HOẶC số thuần ("720p"→"720").
    const want = String(resolution).trim().toLowerCase();
    const wantNum = want.replace(/[^0-9]/g, '');
    const radios = group.querySelectorAll('[role="radio"]');
    const seen = [];
    for (const radio of radios) {
      const txt = (radio.textContent || '').trim();
      seen.push(txt);
      const norm = txt.toLowerCase();
      if (norm === want || (wantNum && norm.replace(/[^0-9]/g, '') === wantNum)) {
        if (radio.getAttribute('aria-checked') === 'true') {
          console.log(`[Grok] selectVideoResolution: "${resolution}" đã chọn sẵn`);
          return true;
        }
        simulateClick(radio);
        console.log(`[Grok] selectVideoResolution: clicked "${txt}" cho resolution "${resolution}"`);
        return true;
      }
    }
    console.warn(`[Grok] selectVideoResolution: KHÔNG match "${resolution}". Radios: [${seen.join(' | ')}]`);
    return false;
  }

  // ============ selectImageQuality ============
  // Image quality radiogroup mới (Grok update 2026-04). DOM:
  // image quality picker container
  //     <div role="radio">Speed</div>
  //     <div role="radio">Quality</div>
  //   </div>
  // Chỉ hiện ở mode=image, không có ở mode=video.
  // Strict Server-Only: supported_image_qualities từ backend api_config.
  async function selectImageQuality(quality) {
    const supported = await _getGrokApiConfig('supported_image_qualities');
    if (!Array.isArray(supported) || supported.length === 0) {
      console.debug('[Tier3] Grok selectImageQuality: supported_image_qualities config miss');
      return false;
    }
    const target = String(quality || '').toLowerCase();
    if (!supported.includes(target)) return false;
    // Display text = Capitalize (vd 'speed' → 'Speed')
    const displayText = target.charAt(0).toUpperCase() + target.slice(1);
    const group = _queryWithFallback('image_quality_picker');
    if (!group) return false; // Không có ở mode=video
    const radios = group.querySelectorAll('[role="radio"]');
    for (const radio of radios) {
      if ((radio.textContent || '').trim() === displayText) {
        if (radio.getAttribute('aria-checked') === 'true') return true;
        simulateClick(radio);
        return true;
      }
    }
    return false;
  }

  // ============ G-2.2: applyGrokSettings ============
  // Apply settings tuần tự: mode → ratio → image_quality (image) → duration → resolution (video).
  async function applyGrokSettings(settings) {
    const { mode, ratio, duration, resolution, imageQuality } = settings || {};
    let ok = true;

    if (mode) {
      const modeOk = await selectMode(mode);
      await sleep(300); // chờ video controls xuất hiện/biến mất
      if (!modeOk) ok = false;
    }
    if (ratio) {
      const ratioOk = await selectRatio(ratio);
      await sleep(200);
      if (!ratioOk) ok = false;
    }
    // Image quality (Speed/Quality) — CHỈ apply khi mode='image'.
    // Mode='video' không có radiogroup này → selectImageQuality return false → KHÔNG fail toàn bộ.
    if (imageQuality && mode === 'image') {
      const qOk = await selectImageQuality(imageQuality);
      await sleep(200);
      // Không gán ok=false nếu không match — Grok có thể chưa render radiogroup ngay sau setMode.
      // Best-effort apply, log warning để debug.
      if (!qOk) console.warn('[Grok] selectImageQuality failed:', imageQuality);
    }
    if (duration) {
      const durOk = await selectVideoDuration(duration);
      await sleep(200);
      if (!durOk) ok = false;
    }
    if (resolution) {
      const resOk = await selectVideoResolution(resolution);
      await sleep(200);
      if (!resOk) ok = false;
    }

    return ok;
  }

  // removeExistingRefImages — xóa ref images cũ trên editor TRƯỚC upload mới.
  // Nút xoá thường ẩn (opacity-0) → click qua React onClick (bypass CSS opacity).
  async function removeExistingRefImages() {
    const removeImageBtns = _queryAllWithFallback('remove_image_button');
    let removedCount = 0;

    for (const btn of removeImageBtns) {
      const propsKey = Object.keys(btn).find(k => k.startsWith('__reactProps$'));
      if (propsKey && btn[propsKey]?.onClick) {
        try {
          btn[propsKey].onClick({
            preventDefault: function(){}, stopPropagation: function(){},
            nativeEvent: new MouseEvent('click', { bubbles: true }),
            type: 'click', target: btn, currentTarget: btn,
          });
        } catch (_) {
          btn.style.opacity = '1';
          simulateClick(btn);
        }
      } else {
        btn.style.opacity = '1';
        simulateClick(btn);
      }
      removedCount++;
      await sleep(300);
    }

    // Tier 2 fallback: broad selectors từ backend remove_image_button_broad + spatial scope
    // filter qua upload_container (chỉ click buttons gần upload area trong form, tránh
    // false-positive trên buttons có aria-label="Remove" elsewhere on page).
    if (removedCount === 0) {
      const cancelBtns = _queryAllWithFallback('remove_image_button_broad');
      const uploadContainerSel = _selStr('upload_container');
      const editorForm = document.querySelector('form');
      for (const btn of cancelBtns) {
        const isInForm = editorForm && editorForm.contains(btn);
        const isUploadRelated = uploadContainerSel ? !!btn.closest(uploadContainerSel) : false;
        if (isInForm || isUploadRelated) {
          simulateClick(btn);
          removedCount++;
          await sleep(200);
        }
      }
    }

    if (removedCount > 0) {
      console.log(`[Grok] removeExistingRefImages: đã xóa ${removedCount} ref image(s) cũ`);
    }
    return removedCount;
  }

  // ============ G-2.2: uploadImages ============
  // Upload ref images qua hidden file input (verified DOM grok-extension).
  // input[type="file"][accept="image/*"][name="files"]
  // CRITICAL — Reference grok-extension/grok-content.js addRefImages:
  //   - Inject file vào hidden input + dispatch change + React onChange
  //   - waitForUploadComplete timeout 30s (file lớn cần thời gian)
  //   - Detect failed upload (svg.lucide-triangle-alert) → remove
  //   - successCount: KHÔNG strict — file đã inject vào input đếm là đã xử lý
  //     (Grok upload background, @mention dropdown sẽ pick up)
  async function uploadImages(images) {
    if (!Array.isArray(images) || images.length === 0) return { success: true, count: 0 };

    let injectedCount = 0;
    let completedCount = 0;
    for (const data of images) {
      if (!data?.base64) continue;

      try {
        const binary = atob(data.base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const file = new File([bytes], data.name || 'ref.png', { type: data.type || 'image/png' });

        const fileInput = _queryWithFallback('file_input');
        if (!fileInput) {
          console.warn('[Grok] uploadImages: file input not found');
          continue;
        }

        const dt = new DataTransfer();
        dt.items.add(file);
        fileInput.files = dt.files;
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));

        // Trigger React onChange qua __reactProps$
        const propsKey = Object.keys(fileInput).find(k => k.startsWith('__reactProps$'));
        if (propsKey && typeof fileInput[propsKey]?.onChange === 'function') {
          fileInput[propsKey].onChange({
            target: fileInput, currentTarget: fileInput,
            preventDefault() {}, stopPropagation() {},
            nativeEvent: new Event('change'),
            type: 'change',
          });
        }

        injectedCount++;
        console.log(`[Grok] uploadImages: injected file ${injectedCount}/${images.length} (${data.name || 'ref.png'})`);

        // Wait initial 1s + poll upload status (timeout 30s match grok-extension)
        const uploadOk = await waitForUploadComplete(30000);
        if (uploadOk) completedCount++;
      } catch (err) {
        console.warn('[Grok] uploadImages error:', err.message);
      }
    }

    // CRITICAL: success = injectedCount > 0 (NOT completedCount).
    // File đã inject vào input → Grok đã nhận → @mention dropdown sẽ pick up.
    // Nếu ép completedCount, timeout dài → false negative → REF_UPLOAD_FAILED → block flow.
    return {
      success: injectedCount > 0,
      count: injectedCount,
      completed: completedCount,
      total: images.length,
    };
  }

  // Helper: chờ upload complete (reference grok-extension waitForUploadComplete pattern)
  // Fix: interruptibleSleep + isAbortActive check để user forceStop break sớm
  // (không phải đợi full 1s initial + poll cycles).
  async function waitForUploadComplete(timeout = 30000) {
    // Initial wait 1s — chờ Grok bắt đầu xử lý upload
    await interruptibleSleep(1000, 'upload-initial-wait');

    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (isAbortActive()) return false;
      // Check failed upload — svg.lucide-triangle-alert
      const failed = _queryWithFallback('upload_error_icon');
      if (failed) {
        console.warn('[Grok] Upload ảnh thất bại, xóa upload lỗi...');
        const removeBtn = failed.closest('button') || _q('upload_error_close_button')?.closest('button');
        if (removeBtn) {
          simulateClick(removeBtn);
          await sleep(500);
        }
        return false;
      }

      // Check still uploading: span.animate-pulse hoặc div.animate-spin
      const loading = _queryWithFallback('upload_loading_indicator');
      if (!loading) return true;
      await sleep(300);
    }
    console.warn('[Grok] waitForUploadComplete timeout');
    return false;
  }

  // ============ G-2.2: snapshotConversationState ============
  // Snapshot URL + thumbnail count để waitForResultPage biết khi nào đã đổi state.
  function snapshotConversationState() {
    return {
      url: window.location.href,
      timestamp: Date.now(),
    };
  }

  // ============ G-2.1b: clickFeedCard ============
  // Click card masonry trên /imagine feed (no-ref) để Grok navigate sang /imagine/post/.
  // Card .group/media-post-masonry-card dùng custom pointer handler (select-none, drag-vs-click) →
  // (1) dispatch FULL pointer+mouse sequence trên IMG với tọa độ tâm ảnh + pointer props đầy đủ,
  // (2) gọi TRỰC TIẾP React handler (onPointerDown→onPointerUp→onClick) walk-up từ img — bỏ qua
  //     isTrusted gate + khởi tạo đúng state drag-detect (down rồi up không di chuyển = click).
  function clickFeedCard(img) {
    const r = img.getBoundingClientRect();
    const cx = Math.max(1, Math.round(r.left + r.width / 2));
    const cy = Math.max(1, Math.round(r.top + r.height / 2));
    const pos = { bubbles: true, cancelable: true, composed: true, view: window, clientX: cx, clientY: cy, screenX: cx, screenY: cy, button: 0 };
    const pDown = { ...pos, pointerId: 1, pointerType: 'mouse', isPrimary: true, buttons: 1, width: 1, height: 1, pressure: 0.5 };
    const pUp = { ...pos, pointerId: 1, pointerType: 'mouse', isPrimary: true, buttons: 0, width: 1, height: 1, pressure: 0 };
    try {
      img.dispatchEvent(new PointerEvent('pointerover', pDown));
      img.dispatchEvent(new PointerEvent('pointerenter', pDown));
      img.dispatchEvent(new MouseEvent('mouseover', pos));
      img.dispatchEvent(new PointerEvent('pointerdown', pDown));
      img.dispatchEvent(new MouseEvent('mousedown', { ...pos, buttons: 1 }));
      img.dispatchEvent(new PointerEvent('pointerup', pUp));
      img.dispatchEvent(new MouseEvent('mouseup', pos));
      img.dispatchEvent(new MouseEvent('click', { ...pos, detail: 1 }));
    } catch (_) {}
    // React handler trực tiếp: walk-up tìm element có onClick/onPointer*, gọi theo đúng thứ tự.
    try {
      let el = img;
      for (let depth = 0; el && depth < 8; depth++, el = el.parentElement) {
        const rk = Object.keys(el).find(x => x.startsWith('__reactProps$'));
        const p = rk && el[rk];
        if (p && (typeof p.onClick === 'function' || typeof p.onPointerDown === 'function' || typeof p.onPointerUp === 'function')) {
          const synth = (type, extra) => ({ preventDefault() {}, stopPropagation() {}, isPropagationStopped: () => false, persist() {}, nativeEvent: new MouseEvent(type, pos), type, target: el, currentTarget: el, clientX: cx, clientY: cy, screenX: cx, screenY: cy, button: 0, detail: 1, ...extra });
          try { p.onPointerDown && p.onPointerDown(synth('pointerdown', { buttons: 1, pointerId: 1, pointerType: 'mouse' })); } catch (_) {}
          try { p.onPointerUp && p.onPointerUp(synth('pointerup', { buttons: 0, pointerId: 1, pointerType: 'mouse' })); } catch (_) {}
          try { p.onClick && p.onClick(synth('click', {})); } catch (_) {}
          break;
        }
      }
    } catch (_) {}
  }

  // ============ G-2.2: waitForResultPage ============
  // Poll URL change → khi match `/imagine/post/{uuid}` → return baseline.
  async function waitForResultPage(baseline, timeout = 60000) {
    const startTime = Date.now();
    const POLL_INTERVAL = 500;
    // Bug fix 2026-05-27: no-ref text-to-image → Grok Ở LẠI /imagine feed (masonry), KHÔNG redirect
    // /imagine/post/. Kết quả mới nhất = card đầu trong #imagine-masonry-section-0. Click card → Grok
    // navigate sang /imagine/post/{id} → vòng poll kế detect redirect → extractImageUrls lấy CDN full-res.
    const FEED_MIN_WAIT = 4000;     // chờ tối thiểu (gen cần thời gian) trước khi xét click feed
    let feedSettleKey = null, feedSettleN = 0, lastFeedClickAt = 0;

    while (Date.now() - startTime < timeout) {
      // Abort check — user click Stop → click Grok Stop button + break sớm.
      if (isAbortActive()) {
        console.log('[Grok-wait] Aborted → clicking Stop button');
        await clickGrokStopButton();
        return { redirected: false, url: window.location.href, aborted: true };
      }
      // Subscribe modal check — Grok hiện modal khi user chưa có plan
      if (detectSubscribeModal()) {
        return { redirected: false, url: window.location.href, subscriptionRequired: true };
      }
      const currentUrl = window.location.href;
      // Đã redirect sang /imagine/post/{uuid} → return
      if (currentUrl !== baseline.url && currentUrl.includes('/imagine/post/')) {
        return { redirected: true, url: currentUrl };
      }

      // Feed /imagine (no-ref): click card ảnh mới nhất để mở post. Card .cursor-pointer dùng custom
      // pointer handler (select-none, drag-vs-click) → cần FULL pointer sequence + tọa độ thật +
      // gọi trực tiếp React handler (bỏ qua isTrusted). Retry mỗi 3s tới khi navigate hoặc timeout.
      if (currentUrl.includes('/imagine') && !currentUrl.includes('/imagine/post/')
          && Date.now() - startTime > FEED_MIN_WAIT) {
        try {
          const section = _queryWithFallback('result_feed_section', null, { silent: true })
            || document.querySelector('[id^="imagine-masonry-section-0"]');
          // Ảnh result đầu tiên (non-blur, có src) trong section mới nhất = kết quả gen vừa xong.
          // Selector card image từ config result_feed_card_image (scope trong section), degraded fallback.
          const cardImgSels = _getDynamicSelector('result_feed_card_image')?.selectors
            || ['img[alt="Generated image"]:not([class*="blur"])'];
          let img = null;
          for (const sel of cardImgSels) {
            try { img = section?.querySelector(sel); } catch (_) {}
            if (img) break;
          }
          const src = img?.getAttribute('src') || '';
          if (img && src) {
            // Settle: src ổn định 2 poll → ảnh render xong (tránh click khi đang load).
            const key = src.length + ':' + src.slice(-48);
            if (key === feedSettleKey) {
              feedSettleN++;
              if (feedSettleN >= 2 && Date.now() - lastFeedClickAt > 3000) {
                lastFeedClickAt = Date.now();
                clickFeedCard(img);
                console.log('[Grok-wait] Feed /imagine: click ảnh mới nhất (section-0) → mở post (retry mỗi 3s)');
              }
            } else {
              feedSettleKey = key; feedSettleN = 0;
            }
          }
        } catch (e) { /* feed click best-effort */ }
      }

      await sleep(POLL_INTERVAL);
    }
    return { redirected: false, url: window.location.href };
  }

  // ============ findGenerationProgress ============
  // Tìm "Generating XX%" indicator trong placeholder Grok đang gen.
  // DOM pattern: indicator spans với progress %
  //
  // Return: số percent (0-100) nếu đang gen, null nếu không có placeholder
  // (= chưa start hoặc đã xong).
  function findGenerationProgress() {
    if (!window.location.href.includes('/imagine/post/')) return null;
    // Tìm span text matching ^XX%$ với parent có chứa "Generating"
    const allSpans = document.querySelectorAll('span');
    for (const span of allSpans) {
      const text = (span.textContent || '').trim();
      const match = text.match(/^(\d{1,3})%$/);
      if (!match) continue;
      const pct = parseInt(match[1], 10);
      if (pct < 0 || pct > 100) continue;
      // Verify nearby (parent or sibling) chứa "Generating" text → tránh nhầm với % khác
      const parent = span.parentElement;
      if (!parent) continue;
      const parentText = parent.textContent || '';
      if (/generating/i.test(parentText)) {
        return pct;
      }
    }
    return null;
  }

  // ============ G-2.2: extractImageUrls ============
  // Quét DOM result page (`/imagine/post/{uuid}`) tìm media URLs từ assets.grok.com.
  // Loại blur loading + ref images (excludeUrls).
  function extractImageUrls(excludeUrls = null, cdnHosts = null) {
    if (!window.location.href.includes('/imagine/post/')) return { mediaUrls: [], mediaType: 'image' };
    // Host whitelist từ config urls.cdn_patterns. Degraded fallback nếu config miss (cold start).
    const hosts = Array.isArray(cdnHosts) && cdnHosts.length ? cdnHosts
      : ['assets.grok.com', 'grok.x.ai', 'imagine-public.x.ai'];

    // Strict Server-Only: result_container selectors từ backend
    const container = _queryWithFallback('result_container');
    if (!container) {
      console.debug('[Tier3] Grok extractImageUrls: result_container miss');
      return { mediaUrls: [], mediaType: 'image' };
    }

    const seenUrls = new Set();
    const mediaUrls = [];
    let mediaType = 'image';

    // Bug fix 2026-05-27: _queryAllWithFallback IGNORE arg container (chỉ 2 params) → query TOÀN
    // document → vớ luôn ảnh recommended/related/feed NGOÀI result container (vd với-ref: result
    // assets.grok.com nhưng kèm ảnh imagine-public.x.ai recommended → extract nhầm). Fix: query
    // ĐÚNG trong container bằng selector từ config (degraded fallback nếu config miss).
    const queryInContainer = (key, fallbackSel) => {
      const sels = _getDynamicSelector(key)?.selectors || fallbackSel;
      for (const s of sels) {
        try { const found = container.querySelectorAll(s); if (found.length) return [...found]; } catch (_) {}
      }
      return [];
    };

    // Videos: ưu tiên detect video trước — selector key 'result_video' từ backend
    const videos = queryInContainer('result_video', ['video']);
    for (const video of videos) {
      const src = video.src || video.querySelector('source')?.src;
      if (src && (src.startsWith('https://') || src.startsWith('http://'))) {
        const baseUrl = src.split('?')[0];
        if (seenUrls.has(baseUrl)) continue;
        seenUrls.add(baseUrl);
        mediaUrls.push(src);
        mediaType = 'video';
      }
    }

    // Images: nếu không có video thì lấy image — selector key 'result_image' từ backend
    if (mediaUrls.length === 0) {
      const imgs = queryInContainer('result_image', ['img[src^="https://"]']);
      let nCand = 0, nReject = 0;
      for (const img of imgs) {
        if (img.alt === 'Loading') continue;
        if (img.className && (img.className.includes('blur-sm') || img.className.includes('blur-md'))) continue;
        if (img.width <= 10 || img.height <= 10) continue;
        if (img.naturalWidth > 0 && img.naturalWidth <= 10) continue;
        if (img.alt && img.alt.startsWith('Thumbnail')) continue;
        if (img.alt === 'Most recent favorite') continue;
        if (img.closest('nav') || img.closest('aside') || img.closest('[aria-label="Saved"]')) continue;

        // Host result từ config urls.cdn_patterns. imagine-public.x.ai = no-ref text-to-image
        // (path /imagine-public/images/{uuid}.jpg). cdn.grok.com loại vì chỉ là /_next static assets.
        const isFromGrokCdn = hosts.some(h => img.src.includes(h));
        const isAvatar = img.src.includes('/avatar') || img.src.includes('/profile');
        const isLogo = img.src.includes('/logo') || img.src.includes('/icon');
        if (!isFromGrokCdn || isAvatar || isLogo) continue;
        nCand++;

        const baseUrl = img.src.split('?')[0];
        if (seenUrls.has(baseUrl)) continue;
        if (excludeUrls && excludeUrls.has(baseUrl)) { nReject++; continue; }
        seenUrls.add(baseUrl);
        mediaUrls.push(img.src);
      }
      console.log(`[Grok-extract] container imgs=${imgs.length} candidates=${nCand} excluded=${nReject} → media=${mediaUrls.length} | hosts=${mediaUrls.map(u => u.split('/')[2]).join(',')}`);
    }

    return { mediaUrls, mediaType };
  }

  // ============ G-2.2: navigateBack ============
  // Quay về trang editor sau khi extract media (tránh tab kẹt result page).
  async function navigateBack() {
    if (!window.location.href.includes('/imagine/post/')) return true;

    // Strategy 1: Click Back button (React onClick → SPA navigation)
    const backBtn = _queryWithFallback('back_button');
    if (backBtn) {
      const propsKey = Object.keys(backBtn).find(k => k.startsWith('__reactProps$'));
      if (propsKey && backBtn[propsKey]?.onClick) {
        backBtn[propsKey].onClick({
          preventDefault() {}, stopPropagation() {},
          nativeEvent: new MouseEvent('click', { bubbles: true }),
          type: 'click', target: backBtn, currentTarget: backBtn,
        });
      } else {
        simulateClick(backBtn);
      }
      for (let i = 0; i < 10; i++) {
        await sleep(500);
        if (!window.location.href.includes('/imagine/post/')) return true;
      }
    }

    // Strategy 2: history.back()
    window.history.back();
    for (let i = 0; i < 10; i++) {
      await sleep(500);
      if (!window.location.href.includes('/imagine/post/')) return true;
    }

    return false;
  }

  // ============ G-2.2: detectError ============
  // Pattern match các loại lỗi phổ biến trên Grok.
  // strict server-only — patterns đọc từ chrome.storage.local.af_grok_config
  // (background.js preload từ provider_configs.api_config.error_patterns).
  // Nếu storage rỗng → detection degrade gracefully (return null, không phát hiện).
  function detectError() {
    const text = (document.body?.innerText || '').toLowerCase();
    if (_grokPatterns.rateLimit.some(p => text.includes(p))) return 'RATE_LIMIT';
    if (_grokPatterns.contentBlocked.some(p => text.includes(p))) return 'CONTENT_BLOCKED';
    if (_grokPatterns.network.some(p => text.includes(p))) return 'NETWORK';
    return null;
  }

  // ============ detectSubscribeModal ============
  // Grok hiển thị modal subscribe khi user chưa đăng ký plan.
  // Detection strategies:
  //   1. URL chứa #subscribe (grok.com/imagine#subscribe)
  //   2. Text patterns từ admin config (admin-tunable qua _grokPatterns.subscriptionRequired)
  //   3. Dialog/modal có nút upgrade/subscribe
  function detectSubscribeModal() {
    // Strategy 1: URL hash check
    if (window.location.hash === '#subscribe' || window.location.href.includes('#subscribe')) {
      return true;
    }

    // Strategy 2: Text indicator trong modal/dialog (admin-tunable patterns)
    const subscribePatterns = _grokPatterns.subscriptionRequired;
    if (subscribePatterns.length === 0) return false;

    const dialogs = _qa('modal_overlay_wrapper');
    for (const dialog of dialogs) {
      const text = (dialog.innerText || '').toLowerCase();
      if (subscribePatterns.some(p => text.includes(p))) {
        // Verify dialog is visible
        const style = window.getComputedStyle(dialog);
        if (style.display !== 'none' && style.visibility !== 'hidden') {
          return true;
        }
      }
    }

    // Strategy 3: Broader check — any overlay với subscribe text
    const overlays = _qa('modal_overlay_wrapper');
    for (const overlay of overlays) {
      const text = (overlay.innerText || '').toLowerCase();
      if (subscribePatterns.some(p => text.includes(p))) {
        const style = window.getComputedStyle(overlay);
        if (style.display !== 'none' && style.visibility !== 'hidden' && overlay.offsetHeight > 100) {
          return true;
        }
      }
    }

    return false;
  }

  // ============ Abort signal flag ============
  // Module-level flag để Loop trong handleSubmitAndWait check stop sớm.
  // Set qua message `grok:abort` (gửi từ sidebar khi user click Stop button task).
  //
  // Fix: Timestamp-guarded — abort message timestamp recorded.
  // Trước fix: handleSubmitAndWait reset __grokAbort=false → nếu abort message arrive
  // TRƯỚC submitAndWait, flag bị wipe → user click stop nhưng task vẫn chạy.
  // Sau fix: abort chỉ valid nếu requested SAU thời điểm call hiện tại start.
  let __grokAbort = false;
  let __grokAbortAt = 0;       // timestamp ms khi user request abort
  let __grokCallStartAt = 0;   // timestamp ms khi call hiện tại start

  // Helper: kiểm tra abort có hợp lệ cho call hiện tại không.
  // Abort cũ (trước call start) → ignore (race fix).
  function isAbortActive() {
    return __grokAbort && __grokAbortAt >= __grokCallStartAt;
  }

  // Helper: checkAbort — throw 'ABORTED:<stage>' để break early ở mọi phase.
  // Fix: trước đây flag chỉ check trong wait loops → user bấm forceStop ở phase
  // upload/insert/submit thì code vẫn chạy tiếp tới wait loop → delay > 1 phút.
  function checkAbort(stage) {
    if (isAbortActive()) {
      console.log('[Grok-abort] Aborted at stage:', stage);
      throw new Error('ABORTED:' + stage);
    }
  }

  // Fix: Interruptible sleep — break sớm khi user abort thay vì đợi full N ms.
  // Replace dài sleep(N) bằng helper này ở các spots > 500ms để abort latency thấp.
  // Polls __grokAbort mỗi 200ms. Nếu signal active → throw ABORTED ngay.
  async function interruptibleSleep(totalMs, stage = 'sleep') {
    const POLL = 200;
    const start = Date.now();
    while (Date.now() - start < totalMs) {
      if (isAbortActive()) {
        console.log('[Grok-abort] Interruptible sleep aborted at stage:', stage);
        throw new Error('ABORTED:' + stage);
      }
      const remaining = totalMs - (Date.now() - start);
      await sleep(Math.min(POLL, remaining));
    }
  }

  // Helper: click "Stop generating" button của Grok để halt backend gen.
  // Grok đang gen có button "Stop" với aria-label hoặc icon stop. Click để dừng ngay backend
  // thay vì để gen tiếp tới khi xong (waste quota + xuất hiện ảnh sau khi user đã bỏ).
  async function clickGrokStopButton() {
    const stopBtn = _queryWithFallback('stop_button');
    if (stopBtn && !stopBtn.disabled) {
      console.log('[Grok-abort] Clicking Grok Stop button to halt backend gen');
      try { stopBtn.click(); } catch (e) {}
      try { simulateClick(stopBtn); } catch (e) {}
      await sleep(300);
      return true;
    }
    console.log('[Grok-abort] Stop button not found or disabled');
    return false;
  }

  // ============ G-2.2: isLoggedIn / checkLoginRequired ============
  // Editor tồn tại = đã login. Có sign-in link = chưa login.
  function isLoggedIn() {
    const editor = findGrokEditor();
    if (!editor) return false;
    const loginLink = _queryWithFallback('auth_link');
    if (loginLink) {
      // Có thể là link signup không bắt buộc — check thêm nếu editor có thể tương tác
      const editorReadable = editor && editor.getAttribute('contenteditable') === 'true';
      if (!editorReadable) return false;
    }
    return true;
  }

  function checkLoginRequired() {
    return !isLoggedIn();
  }

  // ============ G-2.2: handleSubmitAndWait ============
  // Main pipeline: ensureOnEditor → snapshot → settings → upload refs → insert text → submit → wait result → extract.
  // Reference: grok-extension/grok-content.js — verified production flow.
  async function handleSubmitAndWait(payload, sendResponse) {
    // Fix: KHÔNG reset __grokAbort unconditionally — flag với
    // timestamp older than current call sẽ tự bị ignore qua isAbortActive(). Reset
    // chỉ khi flag stale (>5s) để dọn dẹp memory. Tránh wipe pending abort race.
    __grokCallStartAt = Date.now();
    if (__grokAbort && __grokAbortAt < __grokCallStartAt - 5000) {
      __grokAbort = false;
      __grokAbortAt = 0;
    }

    // Show FloatingTracker và ExecutionBlocker
    const promptPreview = (payload.text || '').substring(0, 50);
    FloatingTracker.show({ current: 0, total: 1, phase: _i18n.t('preparing'), prompt: promptPreview });
    ExecutionBlocker.show();

    try {
      const { text, images, settings, timeout, taskName } = payload;
      const timeoutMs = timeout || 120000;

      // 1. Login check
      if (checkLoginRequired()) {
        FloatingTracker.hide();
        ExecutionBlocker.hide();
        sendResponse({ success: false, error: 'NOT_LOGGED_IN' });
        return;
      }
      checkAbort('after-login-check');

      // 1b. Cloudflare challenge check — Grok dùng Cloudflare turnstile.
      // Tab inactive → turnstile có thể không tự complete (Cloudflare check tab visibility) →
      // DOM operations chạy nhưng submit bị block → gen processing mãi.
      // Fix: detect challenge → activate tab (focus window) → chờ user click verify (max 2 phút).
      if (detectCloudflareChallenge()) {
        FloatingTracker.update({ phase: _i18n.t('waitingVerification') });
        const resolved = await waitForCloudflareResolved(120000);
        if (!resolved) {
          FloatingTracker.hide();
          ExecutionBlocker.hide();
          sendResponse({
            success: false,
            error: 'CLOUDFLARE_CHALLENGE_TIMEOUT',
            message: 'Grok yêu cầu xác minh Cloudflare. Vui lòng mở tab Grok, hoàn thành verification, sau đó chạy lại.',
          });
          return;
        }
        checkAbort('after-cloudflare');
      }

      // 2. CRITICAL — ensureOnEditorPage: navigate về /imagine để có editor.
      // 2 cases cần navigate:
      //   a) /imagine/post/{uuid} — kết quả gen lần trước → click Back
      //   b) /imagine/saved — sau navigateBack post-response → cần chuyển sang /imagine
      //      vì /imagine/saved KHÔNG có prompt editor → findGrokEditor returns null →
      //      handleSubmitAndWait return EDITOR_NOT_FOUND ngay → task completed instantly.
      const _curUrl = window.location.href;
      if (_curUrl.includes('/imagine/post/')) {
        console.log('[Grok] handleSubmitAndWait: đang ở result page, navigate back về /imagine');
        await navigateBack();
        await sleep(500);
      } else if (_curUrl.includes('/imagine/saved') || _curUrl.match(/\/imagine\/projects/)) {
        console.log('[Grok] handleSubmitAndWait: đang ở /imagine/saved hoặc /projects, navigate sang /imagine');
        // Strategy 1: Click "Imagine" / "Generate" nav link (SPA navigation)
        const imagineNavBtn = _queryWithFallback('imagine_link');
        if (imagineNavBtn) {
          const propsKey = Object.keys(imagineNavBtn).find(k => k.startsWith('__reactProps$'));
          if (propsKey && imagineNavBtn[propsKey]?.onClick) {
            try {
              imagineNavBtn[propsKey].onClick({
                preventDefault: function(){}, stopPropagation: function(){},
                nativeEvent: new MouseEvent('click', { bubbles: true }),
                type: 'click', target: imagineNavBtn, currentTarget: imagineNavBtn,
              });
            } catch (_) {
              simulateClick(imagineNavBtn);
            }
          } else {
            simulateClick(imagineNavBtn);
          }
        } else {
          // Strategy 2: Direct navigation — đọc URL từ backend api_config.urls.imagine
          const urls = await _getGrokApiConfig('urls');
          const imagineUrl = urls?.imagine;
          if (imagineUrl) {
            window.location.href = imagineUrl;
          } else {
            console.debug('[Tier3] Grok urls.imagine config miss — skip navigate');
          }
        }
        // Wait for editor to appear (max 5s)
        const navStart = Date.now();
        while (Date.now() - navStart < 5000) {
          if (findGrokEditor() && window.location.href.includes('/imagine') && !window.location.href.includes('/imagine/saved') && !window.location.href.includes('/imagine/projects')) {
            break;
          }
          await sleep(200);
        }
        await sleep(500);
      }

      checkAbort('after-navigate');

      // 3. Snapshot baseline (sau khi đã navigate về editor page)
      const baseline = snapshotConversationState();

      // 4. Remove ref images cũ TRƯỚC settings (CRITICAL ORDER FIX):
      // Lý do: khi editor còn ref_img từ session trước, ratio button KHÔNG xuất hiện
      // → applyGrokSettings không set được ratio → fail. Phải clear refs trước để DOM
      // structure đúng → ratio button available → settings apply success.
      await removeExistingRefImages();
      await sleep(300); // chờ DOM update sau remove
      checkAbort('after-remove-refs');

      // 5. Apply settings (mode → ratio → image_quality | duration → resolution)
      if (settings) {
        await applyGrokSettings(settings);
        checkAbort('after-apply-settings');
        await sleep(getMacroDelay());  // Macro gap settings → clear editor
      }

      // 6. Tìm editor + clear
      const editor = findGrokEditor();
      if (!editor) {
        FloatingTracker.hide();
        ExecutionBlocker.hide();
        sendResponse({ success: false, error: 'EDITOR_NOT_FOUND' });
        return;
      }
      await clearEditor(editor);
      await sleep(300);
      checkAbort('after-clear-editor');
      await sleep(getMacroDelay());  // Macro gap clear → upload refs

      // 7. Upload ref images (nếu có).

      let refUrlsToExclude = null;
      let uploadedCount = 0;
      if (Array.isArray(images) && images.length > 0) {

        const uploadResult = await uploadImages(images);
        if (!uploadResult.success) {
          FloatingTracker.hide();
          ExecutionBlocker.hide();
          sendResponse({ success: false, error: 'REF_UPLOAD_FAILED', message: 'Không thể upload ref image' });
          return;
        }
        // Ưu tiên completedCount cho @mention loop — Grok dropdown chỉ list ảnh ĐÃ upload xong.
        // Nếu một số ảnh chưa kịp settle (waitForUploadComplete timeout) → không vào dropdown
        // → @ Enter không tìm thấy item → chỉ insert `@` literal.
        // Fallback: injectedCount nếu completedCount=0 (vd waitForUploadComplete fail nhưng file inject OK).
        uploadedCount = uploadResult.completed || uploadResult.count || 0;
        console.log(`[Grok] Upload result: injected=${uploadResult.count}, completed=${uploadResult.completed}, sẽ @mention ${uploadedCount} images`);
        // Capture ref image URLs trên trang để loại khỏi result detect
        refUrlsToExclude = new Set();
        const refImgs = _queryAllWithFallback('grok_cdn_image');
        for (const img of refImgs) {
          if (img.src) refUrlsToExclude.add(img.src.split('?')[0]);
        }
      }

      // 8. CRITICAL — @mention loop để attach uploaded images vào prompt context.
      // Reference grok-extension/grok-content.js: sau upload, phải type @ → ArrowDown (cho image
      // thứ 2+) → Enter để chọn ảnh từ autocomplete dropdown. KHÔNG @mention → ảnh ko attach
      // vào prompt → submit không gửi ref images.
      if (uploadedCount > 0) {
        console.log(`[Grok] @mention loop cho ${uploadedCount} ref image(s)`);

        // Helper: chờ autocomplete dropdown xuất hiện (poll multiple selectors để cover
        // Radix popper, cmdk command menu, Grok custom mention list).
        // Best-effort detection — nếu KHÔNG match selector nhưng dropdown vẫn render,
        // Enter dispatch vẫn select được item (Grok TipTap internal handler).
        // Vì vậy log ở mức debug (không phải warn) — không phải lỗi nếu mention vẫn work.
        const waitForMentionDropdown = async (timeoutMs = 1500) => {
          const start = Date.now();
          while (Date.now() - start < timeoutMs) {
            // Radix popover + listbox + cmdk + Grok custom mention list
            const dropdown = document.querySelector(
              '[role="listbox"], [role="menu"][data-state="open"], ' +
              '[data-radix-popper-content-wrapper] [role="option"], ' +
              '[role="option"][aria-selected], ' +
              '[cmdk-list], [cmdk-list-sizer], [data-cmdk-list], ' +
              '[data-radix-popper-content-wrapper], ' +
              'div[role="presentation"][data-state="open"]'
            );
            if (dropdown) return true;
            await sleep(80);
          }
          return false;
        };

        // Thu thập option elements visible trong dropdown để CLICK trực tiếp.
        const getMentionOptions = () => Array.from(document.querySelectorAll(
          '[data-radix-popper-content-wrapper] [role="option"], [role="listbox"] [role="option"], ' +
          '[cmdk-item], [data-cmdk-item], [role="menuitem"], [role="option"]'
        )).filter(el => el.offsetParent !== null);

        for (let imgIdx = 0; imgIdx < uploadedCount; imgIdx++) {
          // Re-query editor mỗi iteration (React có thể re-render sau upload/click)
          let curEditor = findGrokEditor();
          if (!curEditor) {
            console.warn('[Grok] @mention: editor not found at iteration', imgIdx);
            break;
          }
          curEditor.focus();
          await sleep(150);
          document.execCommand('insertText', false, '@');

          // Chờ dropdown render — poll thay vì sleep cố định (responsive hơn)
          const dropdownOpen = await waitForMentionDropdown(1500);
          await sleep(250); // settle delay

          // Bug fix 2026-05-27: ưu tiên CLICK option (đáng tin hơn ArrowDown+Enter — Grok đôi khi
          // KHÔNG pre-highlight item đầu → Enter chọn rỗng → chỉ còn "@" literal, ảnh ko attach
          // vào prompt context dù đã upload). Click chọn đúng item thứ (imgIdx).
          const options = getMentionOptions();
          if (options.length > 0) {
            const target = options[Math.min(imgIdx, options.length - 1)];
            simulateClick(target);
            console.log(`[Grok] @mention iter ${imgIdx + 1}: clicked option "${(target.textContent || '').trim().slice(0, 30)}" (${options.length} options visible)`);
            await sleep(400);
          } else {
            // Fallback: ArrowDown imgIdx lần + Enter (dropdown render nhưng selector ko match item).
            console.debug(`[Grok] @mention iter ${imgIdx + 1}: dropdownOpen=${dropdownOpen}, không thấy option element → fallback ArrowDown+Enter`);
            for (let arrowIdx = 0; arrowIdx < imgIdx; arrowIdx++) {
              curEditor.dispatchEvent(new KeyboardEvent('keydown', {
                key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, bubbles: true, cancelable: true,
              }));
              curEditor.dispatchEvent(new KeyboardEvent('keyup', {
                key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, bubbles: true,
              }));
              await sleep(120);
            }
            curEditor.dispatchEvent(new KeyboardEvent('keydown', {
              key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true,
            }));
            curEditor.dispatchEvent(new KeyboardEvent('keyup', {
              key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true,
            }));
            await sleep(400);
          }

          // Verify: log đuôi editor content để biết chip render hay còn "@" literal kẹt lại.
          const vEditor = findGrokEditor();
          console.log(`[Grok] @mention iter ${imgIdx + 1}: editor tail="${(vEditor?.textContent || '').slice(-40)}"`);
        }

        // Escape để đảm bảo dropdown đóng hoàn toàn (tránh Enter submit bị capture)
        const finalEditor = findGrokEditor();
        if (finalEditor) {
          finalEditor.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Escape', code: 'Escape', keyCode: 27,
            bubbles: true, cancelable: true,
          }));
          finalEditor.dispatchEvent(new KeyboardEvent('keyup', {
            key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true,
          }));
        }
        await sleep(200);
      }

      checkAbort('after-mention-loop');
      await sleep(getMacroDelay());  // Macro gap upload+mention → insert prompt

      // 9. Insert prompt text + submit (KeyboardEvent Enter)
      // Re-query editor — React có thể re-render sau @mention chips render.
      let editorAfterMention = findGrokEditor() || editor;

      // [Bug 59 fix 2026-05-23] Move cursor to END of editor trước khi insertText prompt.
      // Triệu chứng: chips render TRƯỚC text trong DOM, nhưng UI hiển thị `text[chip1][chip2]`
      // (text trước chips) — sai thứ tự user expect (ref images TRƯỚC, prompt SAU).
      // Root cause: Escape key sau @mention loop làm TipTap reset cursor về ĐẦU editor →
      // execCommand('insertText', prompt) prepend text vào đầu thay vì append sau chips.
      // Fix: Selection API explicit move cursor về END trước khi insertText.
      if (uploadedCount > 0) {
        try {
          editorAfterMention.focus();
          await sleep(80);
          const sel = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(editorAfterMention);
          range.collapse(false); // collapse to END (false = end)
          sel.removeAllRanges();
          sel.addRange(range);
          console.log('[Grok] Cursor moved to END before insertText (post-@mention)');
          await sleep(100);
        } catch (cursorErr) {
          console.warn('[Grok] Move cursor to end failed (non-fatal):', cursorErr.message);
        }
      }

      await insertText(editorAfterMention, text || '');
      await sleep(500);
      checkAbort('after-insert-prompt');
      await sleep(getMacroDelay());  // Macro gap insert → submit

      // Safety net: Escape lần nữa trước submit (đóng autocomplete nếu insertText trigger)
      editorAfterMention = findGrokEditor() || editorAfterMention;
      editorAfterMention.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape', code: 'Escape', keyCode: 27,
        bubbles: true, cancelable: true,
      }));
      editorAfterMention.dispatchEvent(new KeyboardEvent('keyup', {
        key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true,
      }));
      await sleep(100);

      checkAbort('before-submit');
      let submitOk = await clickSubmit(editorAfterMention);
      if (!submitOk) {
        FloatingTracker.hide();
        ExecutionBlocker.hide();
        // [Bug 60 fix 2026-05-24] Trước khi return SUBMIT_FAILED, check subscribe modal.
        // User chưa mua gói Grok Premium → submit button disabled/modal render → all 4 submit
        // tier fail. Detect modal để trả error CỤ THỂ thay vì generic SUBMIT_FAILED (user biết
        // upgrade gói thay vì confused "tại sao submit fail").
        // Poll 1.5s vì modal có thể render trễ sau attempts.
        const subDeadline = Date.now() + 1500;
        let _subDetectedEarly = false;
        while (Date.now() < subDeadline) {
          if (detectSubscribeModal()) { _subDetectedEarly = true; break; }
          await sleep(200);
        }
        if (_subDetectedEarly) {
          console.warn('[Grok] Subscribe modal detected sau clickSubmit fail → user chưa mua gói');
          sendResponse({
            success: false,
            error: 'SUBSCRIPTION_REQUIRED',
            message: 'Bạn chưa đăng ký gói Grok Premium. Vui lòng đăng ký tại grok.com để sử dụng tính năng tạo ảnh/video.',
          });
          return;
        }
        sendResponse({ success: false, error: 'SUBMIT_FAILED' });
        return;
      }
      checkAbort('after-submit');

      // 6b. Check age verification modal sau submit (Grok hiện modal cho account mới)
      // Nếu modal xuất hiện → handle → submit lại.
      // Fix: interruptibleSleep để abort không phải đợi full 800ms.
      await interruptibleSleep(800, 'after-submit-grace');
      checkAbort('post-submit-grace'); // Bug 52: double-check sau sleep
      if (detectAgeVerificationModal()) {
        console.log('[Grok] Age verification modal detected sau submit — handling...');
        const ageOk = await handleAgeVerificationModal(30000);
        // Fix: check abort TRƯỚC khi map ageOk=false sang AGE_VERIFICATION_FAILED.
        // User abort during handleAge → return false → mismap thành AGE error. Throw ABORTED
        // ngay nếu abort active để outer catch trả về ABORTED đúng.
        checkAbort('after-age-verification');
        if (!ageOk) {
          FloatingTracker.hide();
          ExecutionBlocker.hide();
          sendResponse({
            success: false,
            error: 'AGE_VERIFICATION_FAILED',
            message: 'Không thể xác nhận tuổi tự động. Vui lòng mở tab Grok, hoàn thành xác nhận tuổi thủ công, sau đó chạy lại.',
          });
          return;
        }
        await sleep(500);

        // Re-submit sau khi xác nhận tuổi
        console.log('[Grok] Re-submitting sau age verification...');
        const editorRetry = findGrokEditor();
        if (editorRetry) {
          submitOk = await clickSubmit(editorRetry);
          if (!submitOk) {
            FloatingTracker.hide();
            ExecutionBlocker.hide();
            sendResponse({ success: false, error: 'SUBMIT_FAILED_AFTER_AGE_VERIFY' });
            return;
          }
        }
        await sleep(500);
      }

      // 6c. Check subscribe modal sau submit (Grok hiện modal khi user chưa có plan).
      // Fix: Poll 3s thay vì check 1 shot — modal có thể xuất hiện trễ.
      // waitForResultPage cũng có check (line 1337), đây là fast-path để bail sớm.
      const subModalDeadline = Date.now() + 3000;
      let _subDetected = false;
      while (Date.now() < subModalDeadline) {
        if (isAbortActive()) {
          FloatingTracker.hide();
          ExecutionBlocker.hide();
          sendResponse({ success: false, error: 'ABORTED', message: 'User stopped task' });
          return;
        }
        if (detectSubscribeModal()) { _subDetected = true; break; }
        await sleep(250);
      }
      if (_subDetected) {
        console.warn('[Grok] Subscribe modal detected sau submit');
        FloatingTracker.hide();
        ExecutionBlocker.hide();
        sendResponse({
          success: false,
          error: 'SUBSCRIPTION_REQUIRED',
          message: 'Bạn chưa đăng ký gói Grok Premium. Vui lòng đăng ký tại grok.com để sử dụng tính năng tạo ảnh/video.',
        });
        return;
      }

      // 7. Wait result page redirect
      FloatingTracker.update({ current: 1, total: 1, phase: _i18n.t('waitingResult'), prompt: promptPreview });
      const waitResult = await waitForResultPage(baseline, timeoutMs);
      if (!waitResult.redirected) {
        FloatingTracker.hide();
        ExecutionBlocker.hide();
        // Aborted bởi user → return ABORTED
        if (waitResult.aborted) {
          sendResponse({ success: false, error: 'ABORTED', message: 'User stopped task' });
          return;
        }
        // Subscribe modal detected → return SUBSCRIPTION_REQUIRED
        if (waitResult.subscriptionRequired) {
          sendResponse({
            success: false,
            error: 'SUBSCRIPTION_REQUIRED',
            message: 'Bạn chưa đăng ký gói Grok Premium. Vui lòng đăng ký tại grok.com để sử dụng tính năng tạo ảnh/video.',
          });
          return;
        }
        // Check error trước khi báo timeout
        const err = detectError();
        if (err) {
          FloatingTracker.hide();
          ExecutionBlocker.hide();
          sendResponse({ success: false, error: err, message: 'Detected error trong khi chờ result' });
          return;
        }
        FloatingTracker.hide();
        ExecutionBlocker.hide();
        sendResponse({ success: false, error: 'TIMEOUT', message: 'Hết thời gian chờ redirect' });
        return;
      }

      // 8. Wait for media render (additional grace period).
      // Fix: interruptibleSleep — 3s là cửa sổ lớn nhất user phải đợi sau redirect,
      // dùng interruptible để forceStop break ngay thay vì block đầy 3s.
      await interruptibleSleep(3000, 'pre-extract-grace');

      // 9. Extract media URLs với progress monitoring + heartbeat detection.
      // STRATEGY: Thay vì phụ thuộc timeout cứng, monitor `Generating XX%` indicator của
      // Grok placeholder. Khi progress còn changing → coi như đang gen → KHÔNG timeout.
      // Khi progress idle > HEARTBEAT_TIMEOUT (= không đổi %) → coi stuck → timeout sớm.
      //
      // Hardcoded timeout dài (10 phút video, 5 phút image) chỉ là safety net cho case
      // progress indicator KHÔNG hiện hoặc bị block.
      const isVideoMode = settings?.mode === 'video';
      const extractBudget = isVideoMode
        ? Math.max(timeoutMs, 600000)   // Video: tối thiểu 10 phút
        : Math.max(timeoutMs, 300000);  // Image: tối thiểu 5 phút
      const HEARTBEAT_TIMEOUT = 90000;  // 90s không đổi % → coi stuck

      // Server-Only: host whitelist ảnh result đọc từ api_config urls.cdn_patterns (1 lần trước loop).
      const cdnHosts = (await _getGrokApiConfig('urls'))?.cdn_patterns;

      let mediaUrls = [];
      let mediaType = 'image';
      let lastProgress = -1;
      let lastProgressChangeTime = Date.now();
      let progressDetectedOnce = false;
      const extractDeadline = Date.now() + extractBudget;
      const startExtract = Date.now();

      while (Date.now() < extractDeadline) {
        // Abort check — user click Stop button task → click Grok Stop button + break ngay.
        if (isAbortActive()) {
          console.log('[Grok] Extract loop aborted by user → clicking Stop button');
          await clickGrokStopButton();
          FloatingTracker.hide();
          ExecutionBlocker.hide();
          sendResponse({ success: false, error: 'ABORTED', message: 'User stopped task' });
          return;
        }

        // Fix: Cloudflare re-emerge mid-extract → bail sớm với
        // CLOUDFLARE_CHALLENGE thay vì poll cho đến heartbeat timeout 90s.
        // Trường hợp gặp: session expire trong khi đang gen → Grok hiện turnstile lại.
        if (detectCloudflareChallenge()) {
          console.warn('[Grok] Cloudflare challenge re-emerged trong extract loop → abort');
          FloatingTracker.hide();
          ExecutionBlocker.hide();
          sendResponse({
            success: false,
            error: 'CLOUDFLARE_CHALLENGE_TIMEOUT',
            message: 'Cloudflare challenge xuất hiện lại trong quá trình gen — session có thể đã hết hạn. Vui lòng verify thủ công và chạy lại.',
          });
          return;
        }

        const extracted = extractImageUrls(refUrlsToExclude, cdnHosts);
        if (extracted.mediaUrls.length > 0) {
          mediaUrls = extracted.mediaUrls;
          mediaType = extracted.mediaType;
          // Fix: emit gen_progress=100 ngay khi extract done để tracker UI
          // chuyển trạng thái từ "Generating XX%" → "Hoàn tất" ngay lập tức.
          // Trước fix: tracker stuck ở giá trị progress cuối (vd 75%) cho đến khi
          // executor emit phase='completed' (vài giây sau).
          try {
            const elapsedSec = Math.round((Date.now() - startExtract) / 1000);
            chrome.runtime.sendMessage({
              action: 'grok:gen_progress',
              progress: 100,
              mode: isVideoMode ? 'video' : 'image',
              elapsed: elapsedSec,
            }).catch(() => {});
          } catch (_) {}
          break;
        }

        // Track progress qua "Generating XX%" placeholder.
        // CRITICAL — Grok có thể MẤT % đột ngột khi gen xong (không chạy đến 100% rồi disappear).
        // Vậy % chỉ là TRẠNG THÁI MONITOR, KHÔNG phải driver. Detection chính = media URL extract.
        // % disappear → continue poll media, KHÔNG assume done.
        const currentProgress = findGenerationProgress();
        if (currentProgress !== null) {
          progressDetectedOnce = true;
          if (currentProgress !== lastProgress) {
            const elapsedSec = Math.round((Date.now() - startExtract) / 1000);
            console.log(`[Grok] Generating ${currentProgress}% (elapsed ${elapsedSec}s)`);
            lastProgress = currentProgress;
            lastProgressChangeTime = Date.now();
            // Emit progress event tới sidebar/UI ExecutionTracker hiển thị %.
            // Best-effort, ignore lỗi (sidebar có thể đóng).
            try {
              chrome.runtime.sendMessage({
                action: 'grok:gen_progress',
                progress: currentProgress,
                mode: isVideoMode ? 'video' : 'image',
                elapsed: elapsedSec,
              }).catch(() => {});
            } catch (_) {}
          } else {
            // Progress idle quá lâu → coi stuck
            const idleMs = Date.now() - lastProgressChangeTime;
            if (idleMs > HEARTBEAT_TIMEOUT) {
              console.warn(`[Grok] Progress stuck at ${currentProgress}% for ${Math.round(idleMs/1000)}s → timeout sớm`);
              break;
            }
          }
        } else if (progressDetectedOnce) {
          // Progress đã từng hiện rồi biến mất → media có thể sắp render xong (HOẶC chưa).
          // KHÔNG assume done — tiếp tục poll media URL ở vòng sau.
        }

        // Detect error nếu có
        const err = detectError();
        if (err) {
          FloatingTracker.hide();
          ExecutionBlocker.hide();
          sendResponse({ success: false, error: err });
          return;
        }
        // Fix: giảm poll interval 1500ms → 700ms để latency detect-done thấp hơn.
        // Trước: gen xong → adapter chờ tới 1.5s mới nhận URL → executor delay.
        // Sau: adapter nhận URL trong < 1s sau gen done.
        await sleep(700);
      }

      if (mediaUrls.length === 0) {
        FloatingTracker.hide();
        ExecutionBlocker.hide();
        sendResponse({ success: false, error: 'NO_MEDIA_FOUND', message: 'Không trích xuất được URL media từ result page' });
        return;
      }

      // 10. Extract postId từ URL (TRƯỚC navigate — sau navigate URL đã đổi)
      const postIdMatch = waitResult.url.match(/\/imagine\/post\/([a-z0-9-]+)/i);
      const postId = postIdMatch ? postIdMatch[1] : null;

      // 11. Send response NGAY với mediaUrls (auto-download phía sidebar fetch CDN với cookie session
      // BEFORE navigate khỏi /imagine/post/ — CDN URL có signature TTL ngắn, fetch khi còn ở result page).
      FloatingTracker.hide();
      ExecutionBlocker.hide();
      sendResponse({
        success: true,
        mediaUrls,
        mediaType,
        postId,
        url: waitResult.url,
      });

      // 12. POST-RESPONSE: Navigate back về /imagine/saved (tham khảo grok-extension finally block).
      // Fire-and-forget — KHÔNG await response, sidebar đã nhận mediaUrls.
      // Reference grok-extension/grok-content.js: finally block navigate về /imagine/saved
      // để tab sạch sẽ cho lần submit kế tiếp + UX consistency với standalone AutoGrok.
      (async () => {
        try {
          // Wait briefly để sidebar nhận response + bắt đầu fetch CDN
          await sleep(1500);
          // Strategy 1: Click Back button (nếu vẫn ở /imagine/post/)
          if (window.location.href.includes('/imagine/post/')) {
            await navigateBack();
            await sleep(500);
          }
          // Strategy 2: Click Saved nav link (về /imagine/saved)
          const savedBtn = _queryWithFallback('saved_button') ||
                           _queryWithFallback('saved_button');
          if (savedBtn) {
            const propsKey = Object.keys(savedBtn).find(k => k.startsWith('__reactProps$'));
            if (propsKey && savedBtn[propsKey]?.onClick) {
              try {
                savedBtn[propsKey].onClick({
                  preventDefault: function(){}, stopPropagation: function(){},
                  nativeEvent: new MouseEvent('click', { bubbles: true }),
                  type: 'click', target: savedBtn, currentTarget: savedBtn,
                });
              } catch (_) {
                simulateClick(savedBtn);
              }
            } else {
              simulateClick(savedBtn);
            }
            console.log('[Grok] Navigated to /imagine/saved');
          } else if (!window.location.href.includes('/imagine/saved')) {
            // Strategy 3: Fallback direct navigation — đọc URL từ backend api_config.urls.saved
            console.log('[Grok] Saved button not found, fallback direct nav');
            const urls = await _getGrokApiConfig('urls');
            const savedUrl = urls?.saved;
            if (savedUrl) {
              window.location.href = savedUrl;
            } else {
              console.debug('[Tier3] Grok urls.saved config miss — skip navigate');
            }
          }
        } catch (navErr) {
          console.warn('[Grok] post-response navigate to /saved failed:', navErr?.message);
        }
      })();
    } catch (err) {
      FloatingTracker.hide();
      ExecutionBlocker.hide();
      // Fix: catch ABORT throws → click Grok Stop button để halt backend gen
      if (err.message && err.message.startsWith('ABORTED')) {
        const stage = err.message.replace('ABORTED:', '');
        console.log('[Grok] Caught ABORT at stage:', stage, '→ clicking Stop button');
        await clickGrokStopButton();
        sendResponse({
          success: false,
          error: 'ABORTED',
          message: 'User stopped at ' + stage,
        });
        return;
      }
      console.error('[Grok] handleSubmitAndWait error:', err);
      sendResponse({ success: false, error: 'EXCEPTION', message: err.message || 'Lỗi không xác định' });
    }
  }

  // ============ Listener registration ============
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message.action !== 'string') return false;

    // SSE invalidate: admin update DOM selector → reload config ngay để tránh race condition
    if (message.action === 'providerConfigUpdated') {
      chrome.storage.local.get(['toby_provider_configs'], (res) => {
        if (res.toby_provider_configs?.data) {
          _selectorConfig = res.toby_provider_configs.data;
          _selectorConfigTime = Date.now();
          const keyCount = Object.keys(_selectorConfig[PROVIDER]?.selectors || {}).length;
          console.log(`[Grok] Provider config updated via SSE — reloaded ${keyCount} selectors`);
        } else {
          _selectorConfig = null;
          _selectorConfigTime = 0;
          console.warn('[Grok] Provider config updated via SSE — storage empty, cache cleared');
        }
        sendResponse({ success: true });
      });
      return true; // async response
    }

    if (message.action === 'grok:submitAndWait') {
      // CRITICAL: MessageBridge.grokSubmitAndWait gửi nested structure
      // {action, payload: {text, images, settings, timeout, taskName}}
      // → unwrap message.payload trước khi pass vào handleSubmitAndWait.
      // Fallback to message itself nếu sender đã flatten (defensive).
      const innerPayload = message.payload && typeof message.payload === 'object'
        ? message.payload
        : message;
      // Set inputTimeoutMs từ payload (Adapter pass từ user setting). Default 1200 nếu không có.
      // Macro delay giữa các bước chính = 70% inputTimeoutMs.
      __grokInputTimeoutMs = Number(innerPayload.inputTimeoutMs) || 1200;
      __grokMacroDelayMs = Math.round(__grokInputTimeoutMs * 0.7);
      console.log('[Grok-listener] grok:submitAndWait nhận, text len:',
        (innerPayload.text || '').length, 'images:', (innerPayload.images || []).length,
        '| Timing — inputTimeout:', __grokInputTimeoutMs, 'ms | macroDelay:', __grokMacroDelayMs, 'ms (70%)');
      handleSubmitAndWait(innerPayload, sendResponse);
      return true; // async sendResponse
    }

    // Abort signal — set flag để loop trong handleSubmitAndWait break sớm.
    // Gửi từ sidebar khi user click Stop button task.
    if (message.action === 'grok:abort') {
      __grokAbort = true;
      __grokAbortAt = Date.now(); // Bug 50: timestamp guard cho race condition
      console.log('[Grok-listener] grok:abort received → set abort flag at', __grokAbortAt);
      // Hide trackers immediately
      FloatingTracker.hide();
      ExecutionBlocker.hide();
      sendResponse({ success: true });
      return false;
    }

    // applySettingsInline: gọi từ background `grok:applySettings` / `grok:setRatio`.
    // Inline call applyGrokSettings → trả { success } cho GrokSession.setRatio/setMode/...
    if (message.action === 'grok:applySettingsInline') {
      (async () => {
        try {
          const ok = await applyGrokSettings(message.settings || {});
          sendResponse({ success: !!ok });
        } catch (err) {
          sendResponse({ success: false, error: err.message || 'APPLY_FAILED' });
        }
      })();
      return true;
    }

    // grok:checkStatus — check login + cloudflare challenge status (cho confirm modal)
    if (message.action === 'grok:checkStatus') {
      const editor = _queryWithFallback('composer');
      const loginLink = _queryWithFallback('auth_link');

      // [Bug 61 fix 2026-05-24] Grok dùng <button type="button">Sign in</button> + <button>Sign up</button>
      // KHÔNG <a href="/login"> → selector `auth_link` (CSS href-based) KHÔNG match → false positive loggedIn.
      // DOM khi chưa login VẪN có composer (contenteditable="true") + form wrapper.
      // Fix: text-based detection — scan buttons text match patterns từ admin config (server-only).
      // Patterns lưu trong provider_configs.api_config.error_patterns.not_logged_in_text
      // → chrome.storage.local.af_grok_config → _grokPatterns.notLoggedIn (parse split by '|', lowercase).
      // Admin tune qua /admin/providers/grok → API Configs khi Grok đổi UI ("Welcome back", "Get started", ...).
      let signInButton = null;
      try {
        const patterns = _grokPatterns.notLoggedIn;
        if (patterns && patterns.length > 0) {
          const buttons = document.querySelectorAll('button[type="button"]');
          for (const btn of buttons) {
            const text = (btn.textContent || '').trim().toLowerCase();
            // Exact match (text === pattern) HOẶC contains (text chứa pattern) — cover cả case
            // "Sign in" literal và "Sign in with Google" / "Sign up now" variations.
            if (patterns.some(p => text === p || text.includes(p))) {
              signInButton = btn;
              break;
            }
          }
        }
        // Note: KHÔNG hardcode fallback — strict Server-Only. Nếu patterns rỗng (admin chưa config
        // hoặc storage chưa load), checkStatus chỉ rely vào composer + auth_link như cũ (degrade
        // gracefully, log warning để admin biết cần config).
        else {
          console.warn('[Grok] checkStatus: _grokPatterns.notLoggedIn empty — admin cần config not_logged_in_text');
        }
      } catch (_) { /* ignore */ }

      const loggedIn = !!editor && !loginLink && !signInButton;
      const cloudflareChallenge = detectCloudflareChallenge();

      if (signInButton) {
        console.log('[Grok] checkStatus: Sign in/up button detected → NOT logged in');
      }

      sendResponse({ loggedIn, cloudflareChallenge });
      return false;
    }

    return false;
  });

  // ============ SPA navigation tracking ============
  // Theo dõi URL change qua pushState/replaceState/popstate → báo background.js
  let _lastUrl = location.href;
  const _notifyNavigate = () => {
    if (location.href !== _lastUrl) {
      _lastUrl = location.href;
      try {
        chrome.runtime.sendMessage({ action: 'grok:navigated', url: location.href }).catch(() => {});
      } catch (e) {
        // Bỏ qua nếu runtime mất kết nối
      }
    }
  };

  try {
    const _origPushState = history.pushState;
    const _origReplaceState = history.replaceState;
    history.pushState = function() {
      _origPushState.apply(this, arguments);
      _notifyNavigate();
    };
    history.replaceState = function() {
      _origReplaceState.apply(this, arguments);
      _notifyNavigate();
    };
    window.addEventListener('popstate', _notifyNavigate);
  } catch (e) {
    // Bỏ qua nếu không hook được
  }

  console.log('[Grok] Content script đã được inject (-2)');
})();
