(function() {
  // Flag để background.js nhận biết script đã load (idempotent)
  window.__tobyflowChatGPTLoaded__ = true;

  // Guard against double injection
  if (window._chatAIInjected) return;
  window._chatAIInjected = true;

  // Abort flag — timestamp-guarded để tránh race condition
  let __chatgptAbort = false;
  let __chatgptAbortAt = 0;
  let __chatgptCallStartAt = 0;

  function isAbortActive() {
    return __chatgptAbort && __chatgptAbortAt >= __chatgptCallStartAt;
  }

  // Helper: sleep
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // Interruptible sleep — break sớm khi user abort
  async function interruptibleSleep(totalMs, stage = 'sleep') {
    const POLL = 200;
    const start = Date.now();
    while (Date.now() - start < totalMs) {
      if (isAbortActive()) {
        console.log('[ChatGPT-abort] Interruptible sleep aborted at stage:', stage);
        throw new Error('ABORTED:' + stage);
      }
      const remaining = totalMs - (Date.now() - start);
      await sleep(Math.min(POLL, remaining));
    }
  }

  // ============ i18n for FloatingTracker (content script lightweight i18n) ============
  const _i18n = {
    _lang: 'vi',
    _strings: {
      vi: {
        preparing: 'Đang chuẩn bị',
        waitingVerification: 'Chờ xác minh...',
        waitingResult: 'Đang chờ kết quả...',
      },
      en: {
        preparing: 'Preparing',
        waitingVerification: 'Waiting for verification...',
        waitingResult: 'Waiting for result...',
      },
      ja: {
        preparing: '準備中',
        waitingVerification: '認証待ち...',
        waitingResult: '結果を待っています...',
      },
      th: {
        preparing: 'กำลังเตรียม',
        waitingVerification: 'รอการยืนยัน...',
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
    console.log(`[ChatGPT-i18n] Language loaded: ${_i18n._lang}`);
  });

  // ============ Dynamic Selector System (DOM Resilience) ============
  // Server-Only: Strict Server-Only — NO hardcoded _FALLBACK_SELECTORS.
  const PROVIDER = 'chatgpt';
  let _selectorConfig = null;
  let _selectorConfigTime = 0;
  const _SELECTOR_CACHE_TTL = 30000; // 30s

  // Server-Only: Wait/retry/overlay pattern
  const _SELECTOR_WAIT_MAX_MS = 10000;
  const _SELECTOR_WAIT_INTERVAL_MS = 200;

  // Overlay i18n (4 locales)
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

  function _queryWithFallback(key, defaultSelectors = null, options = {}) {
    const config = _getDynamicSelector(key);
    const hardcoded = defaultSelectors || []; // Server-Only: _FALLBACK_SELECTORS removed
    const isDynamic = config?.selectors?.length > 0;
    const selectors = isDynamic ? config.selectors : hardcoded;
    const silent = options.silent || false;
    const scope = options.scope || document;

    if (!silent) console.log(`[Selector:${PROVIDER}:${key}] ${isDynamic ? '🌐 DYNAMIC' : '📦 HARDCODED'} | Trying ${selectors.length} selectors`);

    for (let i = 0; i < selectors.length; i++) {
      try {
        const el = scope.querySelector(selectors[i]);
        if (el) {
          if (!silent) console.log(`[Selector:${PROVIDER}:${key}] ✅ Match #${i + 1}: ${selectors[i]}`);
          return el;
        }
      } catch (e) { /* invalid selector */ }
    }
    if (!silent) console.log(`[Selector:${PROVIDER}:${key}] ❌ No match`);
    return null;
  }

  function _queryAllWithFallback(key, defaultSelectors = null, scope = null) {
    const config = _getDynamicSelector(key);
    const hardcoded = defaultSelectors || []; // Server-Only: _FALLBACK_SELECTORS removed
    const selectors = config?.selectors?.length > 0 ? config.selectors : hardcoded;
    const root = scope || document;

    for (let i = 0; i < selectors.length; i++) {
      try {
        const els = root.querySelectorAll(selectors[i]);
        if (els.length > 0) return els;
      } catch (e) { /* invalid selector */ }
    }
    return [];
  }

  // Helper: Get selectors array for a key (dynamic only, no hardcoded fallback)
  function _getSelectorsForKey(key) {
    const config = _getDynamicSelector(key);
    const isDynamic = config?.selectors?.length > 0;
    const selectors = isDynamic ? config.selectors : []; // Server-Only: _FALLBACK_SELECTORS removed
    console.log(`[Selector:${PROVIDER}:${key}] ${isDynamic ? '🌐 DYNAMIC' : '⚠️ EMPTY'} | ${selectors.length} selectors`);
    return selectors;
  }

  // Helper: Check if generating indicator exists in element (or global document)
  // Server-Only: dynamic selectors
  function _hasGeneratingIndicator(el = document) {
    const selectors = _getSelectorsForKey('generating_indicator');
    for (const sel of selectors) {
      try {
        if (el.querySelector(sel)) return true;
      } catch (e) { /* invalid selector */ }
    }
    return false;
  }

  // Helper: Query all CDN images in scope (Server-Only: dynamic cdn_image selectors)
  // ChatGPT CDN có thể là: estuary/content, oaiusercontent, sandboxed.openai, backend-api
  function _queryCdnImages(scope = document) {
    const selectors = _getSelectorsForKey('cdn_image');
    if (selectors.length === 0) return [];
    // Build combined selector for efficiency
    const combined = selectors.join(', ');
    try {
      return scope.querySelectorAll(combined);
    } catch (e) {
      // Fallback: query each selector individually
      const results = [];
      for (const sel of selectors) {
        try {
          results.push(...scope.querySelectorAll(sel));
        } catch (_) { /* invalid selector */ }
      }
      return results;
    }
  }

  // ============ Macro-delay giữa các BƯỚC CHÍNH — sync với Flow's inputTimeout setting ============
  //
  // CHIẾN LƯỢC:
  //   - Micro-delay (sleep nhỏ trong sub-step như focus, dispatch event, wait React render)
  //     → GIỮ HARDCODE — vì có lý do kỹ thuật cụ thể, không scale theo user setting.
  //   - Macro-delay (gap GIỮA các bước chính: upload → activate → clear → insert → submit)
  //     → DÙNG getMacroDelay() = inputTimeout × 0.7. User control tốc độ tổng qua setting này.
  //
  // FLOW PIPELINE ChatGPT:
  //   removeRefs + uploadRefs
  //     ↓ sleep(getMacroDelay())   ← 840ms khi inputTimeout=1200
  //   activateImageMode
  //     ↓ sleep(getMacroDelay())
  //   injectTextAndSubmit (clear + insert + submit)
  //
  // 2 biến tracking:
  //   __chatgptInputTimeoutMs: GIÁ TRỊ user setting (lấy từ payload, default 1200ms)
  //   __chatgptMacroDelayMs:   BIẾN TRUNG GIAN = 70% inputTimeoutMs
  let __chatgptInputTimeoutMs = 1200;
  let __chatgptMacroDelayMs = Math.round(1200 * 0.7);  // 840ms

  function getMacroDelay() {
    return __chatgptMacroDelayMs;
  }

  // Helper: checkAbort — throw 'ABORTED:<stage>' để break early ở mọi phase, KHÔNG chỉ wait loops.
  // Bug fix 2026-05-09: trước đây flag chỉ check trong waitForResult → user bấm forceStop ở phase
  // upload/insert/submit thì code vẫn tiếp tục chạy tới khi vào wait loop → delay > 1 phút.
  // Giờ throw ngay khi flag set → catch trong handleSubmitAndWait + click Stop button của ChatGPT.
  function checkAbort(stage) {
    if (isAbortActive()) {
      console.log('[ChatGPT-abort] Aborted at stage:', stage);
      throw new Error('ABORTED:' + stage);
    }
  }

  // Helper: click "Stop generating" button của ChatGPT để halt backend gen.
  // Quan trọng vì kể cả khi extension abort wait loop, ChatGPT backend vẫn tiếp tục gen
  // → user thấy ảnh hiện ra dù đã bấm Stop. Click stop button = backend dừng ngay.
  async function clickChatGPTStopButton() {
    const stopBtn = _queryWithFallback('stop_button');
    if (stopBtn && !stopBtn.disabled) {
      console.log('[ChatGPT-abort] Clicking ChatGPT Stop button to halt backend gen');
      try { stopBtn.click(); } catch (e) {}
      try { simulateClick(stopBtn); } catch (e) {}
      await sleep(300);
      return true;
    }
    console.log('[ChatGPT-abort] Stop button not found or disabled');
    return false;
  }

  // ============ Delete last assistant message (2026-05-16) ============
  // Flow: Click "More actions" button on last assistant turn → Click "Delete" menu item → Confirm in modal
  // Used when setting `chatgpt_delete_after_gen` is enabled.
  async function deleteLastAssistantMessage(turnEl = null) {
    try {
      // Strategy: Click header "conversation options" button → Delete menu item
      // This is more reliable than finding "More actions" on individual messages
      // DOM refs: data/dom/chatgpt-dom/chatgpt-mess-header.md, chatgpt-mess-delete-menu.md

      // 1. Find conversation options button in header
      const headerSelectors = _getSelectorsForKey('conversation_options_button');
      let optionsBtn = null;
      for (const sel of headerSelectors) {
        optionsBtn = document.querySelector(sel);
        if (optionsBtn) break;
      }
      // Server-Only: không fallback inline, chỉ dùng server config
      if (!optionsBtn) {
        console.warn('[ChatGPT-delete] Không tìm thấy nút conversation options trong header');
        return false;
      }

      // 2. Click to open menu
      console.log('[ChatGPT-delete] Clicking conversation options button...');
      simulateClick(optionsBtn);
      await sleep(500);

      // 3. Wait for menu to open — Server-Only: dynamic open_menu selector
      let openMenu = null;
      const menuTimeout = Date.now() + 3000;
      while (Date.now() < menuTimeout) {
        openMenu = _queryWithFallback('open_menu', null, { silent: true });
        if (openMenu) break;
        await sleep(200);
      }

      if (!openMenu) {
        console.warn('[ChatGPT-delete] Menu không mở');
        return false;
      }

      // 4. Find and click "Delete" menu item — Server-Only: dynamic selectors
      let deleteMenuItem = _queryWithFallback('delete_chat_menu_item', null, { scope: openMenu, silent: true });
      if (!deleteMenuItem) {
        // Fallback: tìm qua text content
        const menuItems = _queryAllWithFallback('menu_items', null, openMenu);
        for (const item of menuItems) {
          const text = item.textContent?.trim().toLowerCase();
          if (text === 'delete' || text === 'xóa' || text.includes('delete')) {
            deleteMenuItem = item;
            break;
          }
        }
      }

      if (!deleteMenuItem) {
        console.warn('[ChatGPT-delete] Không tìm thấy menu item "Delete"');
        document.body.click();
        return false;
      }

      console.log('[ChatGPT-delete] Clicking "Delete" menu item...');
      simulateClick(deleteMenuItem);
      await sleep(500);

      // 5. Wait for confirm modal and click confirm button
      // Server-Only: dynamic selector (challenge_overlay covers dialog/alertdialog)
      const confirmTimeout = Date.now() + 3000;
      const confirmSelectors = _getSelectorsForKey('delete_confirm_button');
      let confirmBtn = null;
      while (Date.now() < confirmTimeout) {
        const dialog = _queryWithFallback('challenge_overlay', null, { silent: true });
        if (dialog) {
          for (const sel of confirmSelectors) {
            try {
              confirmBtn = dialog.querySelector(sel);
              if (confirmBtn) break;
            } catch (_) { /* invalid selector */ }
          }
          if (!confirmBtn) {
            const buttons = dialog.querySelectorAll('button');
            for (const btn of buttons) {
              const text = btn.textContent?.trim().toLowerCase();
              if (text === 'delete' || text === 'xóa') {
                confirmBtn = btn;
                break;
              }
            }
          }
        }
        if (confirmBtn) break;
        await sleep(200);
      }

      if (!confirmBtn) {
        console.warn('[ChatGPT-delete] Không tìm thấy nút xác nhận trong modal');
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        return false;
      }

      console.log('[ChatGPT-delete] Clicking confirm button...');
      simulateClick(confirmBtn);
      await sleep(500);

      console.log('[ChatGPT-delete] ✅ Đã xóa conversation thành công');
      return true;
    } catch (err) {
      console.error('[ChatGPT-delete] Lỗi khi xóa conversation:', err);
      return false;
    }
  }

  // Helper: simulateClick (full pointer event chain for React compatibility)
  function simulateClick(el) {
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 };
    el.dispatchEvent(new PointerEvent('pointerdown', opts));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new PointerEvent('pointerup', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
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

  // ============ FloatingTracker: Progress indicator cho ChatGPT page (đồng bộ style với Flow) ============
  const FloatingTracker = {
    _el: null,
    _startTime: null,
    _elapsedTimer: null,

    _create() {
      if (this._el && document.body.contains(this._el)) return;
      const existing = document.getElementById('tobyflow-chatgpt-tracker');
      if (existing) existing.remove();

      const el = document.createElement('div');
      el.id = 'tobyflow-chatgpt-tracker';
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
          <span style="flex:1;font-weight:600;font-size:12px;">ChatGPT</span>
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
    _MAX_BLOCK_TIME: 7 * 60 * 1000, // 7 phút — cao hơn detection timeout+grace (gen ảnh chậm) để overlay không tự ẩn giữa chừng

    _injectStyles() {
      if (this._styleEl) return;
      const style = document.createElement('style');
      style.id = 'tobyflow-chatgpt-blocker-styles';
      style.textContent = `
        @keyframes tobyflow-glow-pulse {
          0%, 100% { opacity: 0.4; }
          50% { opacity: 0.7; }
        }
        #tobyflow-chatgpt-blocker {
          position: fixed; inset: 0; z-index: 2147483646;
          pointer-events: all; cursor: not-allowed; background: transparent;
        }
        #tobyflow-chatgpt-blocker::before {
          content: ''; position: absolute; inset: 0;
          border: 5px solid #cdff01;
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
      if (e.target?.closest?.('#tobyflow-chatgpt-tracker')) return; // Allow tracker clicks

      // Escape hatch: 3x Escape to force hide
      if (e.type === 'keydown' && e.key === 'Escape') {
        ExecutionBlocker._escapeCount++;
        clearTimeout(ExecutionBlocker._escapeTimer);
        ExecutionBlocker._escapeTimer = setTimeout(() => { ExecutionBlocker._escapeCount = 0; }, 2000);
        if (ExecutionBlocker._escapeCount >= 3) {
          console.warn('[ChatGPT-ExecutionBlocker] Force hide via Escape x3');
          ExecutionBlocker._escapeCount = 0;
          ExecutionBlocker.hide();
          __chatgptAbort = true;
          __chatgptAbortAt = Date.now();
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
      el.id = 'tobyflow-chatgpt-blocker';
      document.body.appendChild(el);
      this._el = el;
    },

    _startTimeout() {
      this._stopTimeout();
      this._timeoutId = setTimeout(() => {
        // 2026-05-27: CHỈ ẩn overlay (unblock UI), KHÔNG set __chatgptAbort. Trước fix: auto-timeout
        // set abort → gen ảnh chậm (>_MAX_BLOCK_TIME) bị "User stopped during grace" dù ChatGPT vẫn
        // đang gen → node fail đỏ oan. Detection loop có timeout+grace riêng để kết thúc đúng cách.
        console.warn('[ChatGPT-ExecutionBlocker] Auto-timeout, force hiding (KHÔNG abort — detection tự xử lý)');
        this.hide();
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

  // ============ HELPER: Remove ref images cũ trên ChatGPT composer ============
  // Server-Only: dynamic remove_ref_image_button selector
  // Click qua React onClick để bypass CSS opacity nếu có.
  async function removeExistingChatGPTRefImages() {
    const removeBtns = _queryAllWithFallback('remove_ref_image_button');
    let removedCount = 0;

    for (const btn of removeBtns) {
      const propsKey = Object.keys(btn).find(k => k.startsWith('__reactProps$'));
      if (propsKey && btn[propsKey]?.onClick) {
        try {
          btn[propsKey].onClick({
            preventDefault: function(){}, stopPropagation: function(){},
            nativeEvent: new MouseEvent('click', { bubbles: true }),
            type: 'click', target: btn, currentTarget: btn,
          });
        } catch (_) {
          simulateClick(btn);
        }
      } else {
        simulateClick(btn);
      }
      removedCount++;
      await sleep(250);
    }

    if (removedCount > 0) {
      console.log(`[ChatGPT] removeExistingRefImages: đã xóa ${removedCount} ref image(s) cũ`);
    }
    return removedCount;
  }

  // ============ Cloudflare/captcha challenge detection ============
  // ChatGPT đôi khi có verification challenge (Cloudflare turnstile hoặc OpenAI captcha).
  // Tab inactive → challenge có thể không tự complete → DOM operations bị block silent.
  // Pattern giống chat-content-grok.js.
  function detectChatGPTChallenge() {
    // Server-Only: dynamic cloudflare_iframe selector
    if (_queryWithFallback('cloudflare_iframe', null, { silent: true })) return true;
    // OpenAI specific: "Verify you are human" page
    // Server-Only: dynamic selectors + text_match from config
    const overlays = _queryAllWithFallback('challenge_overlay', null, { silent: true });
    const selectorConfig = _getDynamicSelector('challenge_overlay') || {};
    const textMatches = selectorConfig.text_match || [];
    for (const el of overlays) {
      const txt = (el.innerText || '').toLowerCase();
      const matchesServerPattern = textMatches.some(pattern => txt.includes(pattern.toLowerCase()));
      // Extra: Cloudflare specific detection (not in server config)
      const matchesCloudflare = txt.includes('verifying') && txt.includes('cloudflare');
      if (matchesServerPattern || matchesCloudflare) {
        const style = window.getComputedStyle(el);
        if (style.display !== 'none' && style.visibility !== 'hidden') return true;
      }
    }
    return false;
  }

  async function waitForChatGPTChallengeResolved(timeoutMs = 120000) {
    if (!detectChatGPTChallenge()) return true;
    console.warn('[ChatGPT] Challenge detected — request tab activate + chờ user verify');
    try {
      await new Promise((resolve) => {
        chrome.runtime.sendMessage(
          { action: 'chatgpt:ensureActive', focusWindow: true, reason: 'challenge' },
          () => resolve()
        );
      });
    } catch (_) {}
    const start = Date.now();
    let lastLog = 0;
    while (Date.now() - start < timeoutMs) {
      // Abort check — tránh block user khi đang chờ challenge
      if (isAbortActive()) {
        console.log('[ChatGPT] Challenge wait aborted by user');
        return false;
      }
      if (!detectChatGPTChallenge()) {
        console.log('[ChatGPT] Challenge resolved sau', Math.round((Date.now() - start) / 1000), 's');
        await sleep(800);
        return true;
      }
      const elapsed = Date.now() - start;
      if (elapsed - lastLog >= 10000) {
        console.log('[ChatGPT] Vẫn chờ challenge resolved...', Math.round(elapsed / 1000), 's');
        lastLog = elapsed;
      }
      await sleep(800);
    }
    console.error('[ChatGPT] Challenge timeout sau', timeoutMs / 1000, 's');
    return false;
  }

  // ============ HELPER: Click "New chat" và chờ editor ready ============
  // Lý do: ChatGPT có thể bị stuck state hoặc image mode bị hạn chế trong conversation cũ.
  // Tạo new chat đảm bảo clean state + đủ quota upload refs cho fresh conversation.
  async function clickNewChatAndWaitReady(timeoutMs = 10000) {
    const log = (...args) => console.log('[ChatGPT-newchat]', ...args);

    // 1. Tìm button "New chat" trong sidebar
    //    Selector: a[data-testid="create-new-chat-button"] hoặc a[href="/"] có text "New chat"
    let newChatBtn = _queryWithFallback('new_chat_button');
    if (!newChatBtn) {
      // Fallback: tìm link với text "New chat" (Server-Only: dynamic chat_history_home_link)
      const cfg = _getDynamicSelector('chat_history_home_link');
      const selectors = cfg?.selectors || []; // Server-Only: no hardcoded fallback
      if (selectors.length > 0) {
        const sidebarLinks = document.querySelectorAll(selectors.join(', '));
        for (const link of sidebarLinks) {
          if ((link.textContent || '').includes('New chat')) {
            newChatBtn = link;
            break;
          }
        }
      }
    }

    if (!newChatBtn) {
      log('WARN: New chat button không tìm thấy — skip, dùng conversation hiện tại');
      return false;
    }

    // 2. Check nếu đã ở trang new chat (URL = "/" hoặc "/?" hoặc đã empty conversation)
    //    Nếu đã ở new chat, không cần click lại
    const currentPath = window.location.pathname;
    if (currentPath === '/' || currentPath === '') {
      // Check thêm: conversation có empty không (không có messages)
      // Server-Only: dynamic message_author selector
      const _maCfg = _getDynamicSelector('message_author');
      const _maSelectors = _maCfg?.selectors || []; // Server-Only: no hardcoded fallback
      const messages = _maSelectors.length > 0 ? document.querySelectorAll(_maSelectors.join(', ')) : [];
      if (messages.length === 0) {
        log('Đã ở new chat page với empty conversation — skip click');
        return true;
      }
    }

    // 3. Click button
    log('Click New chat button...');
    simulateClick(newChatBtn);

    // 4. Chờ navigation và editor ready
    //    - URL chuyển về "/"
    //    - ProseMirror editor xuất hiện và focusable
    const startTime = Date.now();
    let editorReady = false;

    while (Date.now() - startTime < timeoutMs) {
      // Check URL
      const path = window.location.pathname;
      if (path !== '/' && path !== '') {
        await sleep(200);
        continue;
      }

      // Check editor ready
      const editor = _queryWithFallback('composer');
      if (editor) {
        // Verify editor is interactive (not disabled/loading)
        const isDisabled = editor.getAttribute('aria-disabled') === 'true' ||
                          editor.closest('[aria-busy="true"]');
        if (!isDisabled) {
          editorReady = true;
          break;
        }
      }

      await sleep(200);
    }

    if (editorReady) {
      log('New chat ready sau', Date.now() - startTime, 'ms');
      // Extra sleep để React hydrate hoàn toàn
      await sleep(300);
      return true;
    }

    log('WARN: Editor không ready sau', timeoutMs, 'ms');
    return false;
  }

  // ============ HELPER: Deactivate image mode TRƯỚC khi submit text (Prompt enhance flow) ============
  // ChatGPT giữ image mode active xuyên session (sticky). Nếu Prompt node enhance gọi text-only mà
  // image mode vẫn ON → ChatGPT có thể trả về image hoặc reply mang context image-gen → response sai.
  // Giải pháp: detect image mode active (qua ratio button visible) → click composer plus → click
  // "Create image" item để toggle off → quay về plain chat.
  async function deactivateImageModeIfActive() {
    const ratioBtn = _queryWithFallback('ratio_button');
    if (!ratioBtn) return false; // Đã ở text mode

    console.log('[ChatGPT] Image mode đang active — deactivate trước khi submit text');

    // Click element qua cả PointerEvent chain + React onClick (Radix menuitemradio cần onSelect)
    const clickEl = (el) => {
      if (!el) return;
      try { simulateClick(el); } catch (_) {}
      const propsKey = Object.keys(el).find(k => k.startsWith('__reactProps$'));
      const props = propsKey ? el[propsKey] : null;
      try {
        if (props && typeof props.onSelect === 'function') {
          props.onSelect({ preventDefault() {}, stopPropagation() {} });
        } else if (props && typeof props.onClick === 'function') {
          props.onClick({ preventDefault() {}, stopPropagation() {}, nativeEvent: new MouseEvent('click'), type: 'click', target: el, currentTarget: el });
        }
      } catch (_) {}
    };

    // 1. Đóng menu cũ nếu đang mở
    try {
      const openMenu = _queryWithFallback('open_menu');
      if (openMenu) {
        document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await sleep(80);
      }
    } catch (_) {}

    // 2. Click composer plus
    const plusBtn = _queryWithFallback('plus_button');
    if (!plusBtn) {
      console.warn('[ChatGPT] deactivateImageMode: composer plus button không tìm thấy');
      return false;
    }
    clickEl(plusBtn);

    // 3. Chờ menu render — Server-Only: dynamic open_menu selector
    let menu = null;
    for (let i = 0; i < 6; i++) {
      await sleep(80);
      menu = _queryWithFallback('open_menu', null, { silent: true });
      if (menu) break;
    }
    if (!menu) {
      console.warn('[ChatGPT] deactivateImageMode: menu không render');
      return false;
    }

    // 4. Tìm "Create image" item và toggle off
    const items = _queryAllWithFallback('menu_items', null, menu);
    for (const item of items) {
      const text = (item.innerText || '').trim().toLowerCase();
      if (text === 'create image' || text === 'create an image' || text.startsWith('create image')) {
        const checked = item.getAttribute('aria-checked') === 'true' || item.getAttribute('data-state') === 'checked';
        if (checked) {
          clickEl(item);
          console.log('[ChatGPT] deactivateImageMode: đã click toggle off');
        }
        break;
      }
    }

    // 5. Đóng menu (Escape) — phòng trường hợp menu không tự đóng
    await sleep(150);
    try {
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    } catch (_) {}
    await sleep(150);

    // 6. Verify ratio button đã biến mất → image mode off
    const stillActive = !!_queryWithFallback('ratio_button');
    return !stillActive;
  }

  // ============ HELPER: đọc api_config chatgpt từ chrome.storage ============
  async function _getChatGPTApiConfig(key) {
    try {
      const result = await new Promise((r) => chrome.storage.local.get(['toby_provider_api_configs'], r));
      return result?.toby_provider_api_configs?.data?.chatgpt?.configs?.[key] ?? null;
    } catch (_) { return null; }
  }

  // ============ selectChatGPTModel — chọn GPT-5.5 variant (Instant/Thinking) ============
  // Mở model switcher pill trong composer → click menuitemradio khớp text. Match by TEXT từ
  // api_config chatgpt_model_labels (đa ngôn ngữ) — KHÔNG dùng data-testid (chứa version gpt-5-5).
  async function selectChatGPTModel(modelValue) {
    if (!modelValue) return false;
    const labelCfg = await _getChatGPTApiConfig('chatgpt_model_labels');
    // Fallback: value chính là text menu (Instant/Thinking) khi config chưa load.
    const rawLabels = labelCfg?.[modelValue] ?? modelValue;
    const targetTexts = String(rawLabels).split('|').map(s => s.trim().toLowerCase()).filter(Boolean);
    if (targetTexts.length === 0) return false;

    // Click qua PointerEvent + React onSelect (Radix menuitemradio cần onSelect).
    const clickEl = (el) => {
      if (!el) return;
      try { simulateClick(el); } catch (_) {}
      const propsKey = Object.keys(el).find(k => k.startsWith('__reactProps$'));
      const props = propsKey ? el[propsKey] : null;
      try {
        if (props && typeof props.onSelect === 'function') {
          props.onSelect({ preventDefault() {}, stopPropagation() {} });
        } else if (props && typeof props.onClick === 'function') {
          props.onClick({ preventDefault() {}, stopPropagation() {}, nativeEvent: new MouseEvent('click'), type: 'click', target: el, currentTarget: el });
        }
      } catch (_) {}
    };
    const closeMenu = () => { try { document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); } catch (_) {} };

    const switcherBtn = _queryWithFallback('model_switcher_button', null, { silent: true });
    if (!switcherBtn) { console.warn('[ChatGPT] selectChatGPTModel: model_switcher_button không thấy'); return false; }

    // Pill đã hiển thị đúng model → skip (tránh mở menu thừa).
    const curText = (switcherBtn.innerText || switcherBtn.textContent || '').trim().toLowerCase();
    if (targetTexts.some(t => curText === t || curText.includes(t))) {
      console.log(`[ChatGPT] selectChatGPTModel: "${modelValue}" đã active`);
      return true;
    }

    clickEl(switcherBtn);

    // Chờ menu render (menuitemradio). Text-match tự scope đúng menu model (chỉ menu này có Instant/Thinking).
    let items = [];
    for (let i = 0; i < 10; i++) {
      await sleep(100);
      items = Array.from(_queryAllWithFallback('mode_menu_item'));
      if (items.length > 0) break;
    }
    if (items.length === 0) {
      console.warn('[ChatGPT] selectChatGPTModel: menu model không render');
      closeMenu();
      return false;
    }

    for (const item of items) {
      const txt = (item.innerText || item.textContent || '').trim().toLowerCase();
      if (targetTexts.some(t => txt === t || txt.includes(t))) {
        clickEl(item);
        console.log(`[ChatGPT] selectChatGPTModel: clicked "${(item.innerText || '').trim()}" cho "${modelValue}"`);
        await sleep(200);
        closeMenu();
        return true;
      }
    }
    console.warn(`[ChatGPT] selectChatGPTModel: KHÔNG match "${modelValue}". Items: [${items.map(i => (i.innerText || '').trim()).join(' | ')}]`);
    closeMenu();
    return false;
  }

  // ============ HELPER: Activate image mode VÀ chọn ratio TRƯỚC khi submit ============
  // Flow thực tế ChatGPT: Click plus → Create image → chọn ratio → upload refs → input text → submit
  // Ratio mapping: '1:1' | '16:9' | '9:16' (ChatGPT chỉ hỗ trợ 3 ratio này)
  async function activateImageMode(ratio = '1:1') {
    const ratioBtn = _queryWithFallback('ratio_button');

    // Click element qua cả PointerEvent chain + React onClick
    const clickEl = (el) => {
      if (!el) return;
      try { simulateClick(el); } catch (_) {}
      const propsKey = Object.keys(el).find(k => k.startsWith('__reactProps$'));
      const props = propsKey ? el[propsKey] : null;
      try {
        if (props && typeof props.onSelect === 'function') {
          props.onSelect({ preventDefault() {}, stopPropagation() {} });
        } else if (props && typeof props.onClick === 'function') {
          props.onClick({ preventDefault() {}, stopPropagation() {}, nativeEvent: new MouseEvent('click'), type: 'click', target: el, currentTarget: el });
        }
      } catch (_) {}
    };

    // Nếu image mode chưa active → activate
    if (!ratioBtn) {
      console.log('[ChatGPT] Image mode chưa active — đang activate...');

      // 1. Đóng menu cũ nếu đang mở
      try {
        const openMenu = _queryWithFallback('open_menu');
        if (openMenu) {
          document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          await sleep(80);
        }
      } catch (_) {}

      // 2. Click composer plus
      const plusBtn = _queryWithFallback('plus_button');
      if (!plusBtn) {
        console.warn('[ChatGPT] activateImageMode: composer plus button không tìm thấy');
        return false;
      }
      clickEl(plusBtn);

      // 3. Chờ menu render — Server-Only: dynamic open_menu selector
      let menu = null;
      for (let i = 0; i < 6; i++) {
        await sleep(80);
        menu = _queryWithFallback('open_menu', null, { silent: true });
        if (menu) break;
      }
      if (!menu) {
        console.warn('[ChatGPT] activateImageMode: menu không render');
        return false;
      }

      // 4. Click "Create image" để toggle on
      const items = _queryAllWithFallback('menu_items', null, menu);
      let found = false;
      for (const item of items) {
        const text = (item.innerText || '').trim().toLowerCase();
        if (text === 'create image' || text === 'create an image' || text.startsWith('create image')) {
          const checked = item.getAttribute('aria-checked') === 'true' || item.getAttribute('data-state') === 'checked';
          if (!checked) {
            clickEl(item);
            console.log('[ChatGPT] activateImageMode: đã click toggle on "Create image"');
          }
          found = true;
          break;
        }
      }
      if (!found) {
        console.warn('[ChatGPT] activateImageMode: không tìm thấy "Create image" item');
        // Đóng menu
        try { document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); } catch (_) {}
        return false;
      }

      // 5. Chờ ratio button xuất hiện với retry
      let newRatioBtn = null;
      for (let i = 0; i < 8; i++) {
        await sleep(100);
        newRatioBtn = _queryWithFallback('ratio_button', null, { silent: true });
        if (newRatioBtn) break;
      }
      if (!newRatioBtn) {
        console.warn('[ChatGPT] activateImageMode: ratio button không xuất hiện sau khi activate');
      }
      // Delay để ChatGPT UI stabilize trước khi click ratio
      await sleep(getMacroDelay());
    }

    // 6. Chọn ratio nếu được chỉ định
    let ratioSelected = false;
    if (ratio) {
      // Retry tìm ratio button (có thể cần thời gian render)
      let newRatioBtn = null;
      for (let i = 0; i < 5; i++) {
        newRatioBtn = _queryWithFallback('ratio_button', null, { silent: i > 0 });
        if (newRatioBtn) break;
        await sleep(100);
      }
      if (newRatioBtn) {
        // Map ratio key → aria-label (sync với background.js ARIA_LABEL_MAP)
        const RATIO_ARIA_MAP = {
          story: 'Story 9:16',
          portrait: 'Portrait 3:4',
          square: 'Square 1:1',
          landscape: 'Landscape 4:3',
          widescreen: 'Widescreen 16:9',
          '9:16': 'Story 9:16',
          '3:4': 'Portrait 3:4',
          '1:1': 'Square 1:1',
          '4:3': 'Landscape 4:3',
          '16:9': 'Widescreen 16:9',
        };
        const targetAriaLabel = RATIO_ARIA_MAP[ratio] || null;

        // Delay trước khi click để UI stable (tăng từ 200 → 300ms)
        await sleep(300);
        // Click ratio button để mở dropdown
        clickEl(newRatioBtn);
        console.log('[ChatGPT] activateImageMode: đã click ratio button, waiting for dropdown...');

        // Chờ dropdown render với retry (tăng delay 80 → 120ms, retry 6 → 10)
        let ratioMenu = null;
        for (let i = 0; i < 10; i++) {
          await sleep(120);
          // Try open_menu first, then fallback to listbox (ChatGPT ratio picker uses listbox)
          ratioMenu = _queryWithFallback('open_menu', null, { silent: true });
          if (!ratioMenu) {
            ratioMenu = document.querySelector('[role="listbox"]');
          }
          if (ratioMenu) break;
        }

        // Collect ratio items từ menu hoặc fallback tìm trong document
        let ratioItems = [];
        if (ratioMenu) {
          console.log('[ChatGPT] activateImageMode: dropdown found, tagName:', ratioMenu.tagName, 'role:', ratioMenu.getAttribute('role'));
          ratioItems = _queryAllWithFallback('menu_items', null, ratioMenu);
          // Fallback: tìm options trong listbox
          if (ratioItems.length === 0) {
            ratioItems = ratioMenu.querySelectorAll('[role="option"], [role="menuitemradio"], [role="menuitem"]');
          }
          console.log('[ChatGPT] activateImageMode: found', ratioItems.length, 'items in dropdown');
          // Debug: log aria-labels of items
          if (ratioItems.length > 0) {
            const labels = Array.from(ratioItems).map(it => it.getAttribute('aria-label') || it.innerText?.substring(0, 30)).join(', ');
            console.log('[ChatGPT] activateImageMode: item labels:', labels);
          }
        } else {
          console.log('[ChatGPT] activateImageMode: dropdown NOT found after retries');
        }
        // Final fallback: tìm aria-label match trực tiếp trong document
        if (ratioItems.length === 0 && targetAriaLabel) {
          const directMatch = document.querySelector(`[aria-label="${targetAriaLabel}"]`);
          if (directMatch) {
            ratioItems = [directMatch];
            console.log('[ChatGPT] activateImageMode: found ratio via direct aria-label query');
          } else {
            console.log('[ChatGPT] activateImageMode: direct aria-label query failed for:', targetAriaLabel);
          }
        }

        let found = false;
        for (const item of ratioItems) {
          // Primary: match aria-label exact
          if (targetAriaLabel && item.getAttribute('aria-label') === targetAriaLabel) {
            clickEl(item);
            console.log('[ChatGPT] activateImageMode: đã chọn ratio via aria-label', ratio, targetAriaLabel);
            found = true;
            break;
          }
        }
        // Fallback: match text case-insensitive
        if (!found) {
          const ratioLower = ratio.toLowerCase();
          for (const item of ratioItems) {
            const text = (item.innerText || '').trim().toLowerCase();
            if (text === ratioLower || text.includes(ratioLower) || text.includes(ratio)) {
              clickEl(item);
              console.log('[ChatGPT] activateImageMode: đã chọn ratio via text fallback', ratio);
              found = true;
              break;
            }
          }
        }
        await sleep(150);
        // Đóng menu nếu còn mở
        try { document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); } catch (_) {}
        ratioSelected = found;
      }
    }

    // 7. Verify image mode đã active
    // Return true nếu ratio đã được chọn thành công, hoặc ratio_button còn visible
    await sleep(200);
    const verified = !!_queryWithFallback('ratio_button');
    console.log('[ChatGPT] activateImageMode: verified =', verified, 'ratioSelected =', ratioSelected);
    return ratioSelected || verified;
  }

  // AI Agent prefix — Server-Only (2026-05-30 refactor).
  // Đọc từ PCM cache `chrome.storage.local.toby_provider_api_configs.data.chatgpt.configs.ai_agent_prefix.{locale}`.
  // Admin edit qua /admin/providers/chatgpt/api-configs → SSE broadcast → next submit dùng prefix mới.
  // Fallback: locale missing → EN. Config missing → '' (skip prefix wrap, submit raw prompt).
  async function getEnhancePrefix() {
    try {
      const result = await new Promise(resolve => {
        chrome.storage.local.get(['toby_provider_api_configs', 'af_locale'], r => resolve(r));
      });
      const locale = result?.af_locale || 'en';
      const prefixMap = result?.toby_provider_api_configs?.data?.chatgpt?.configs?.ai_agent_prefix;
      if (!prefixMap || typeof prefixMap !== 'object') {
        console.warn('[AI Agent] ai_agent_prefix config missing for chatgpt — skip prefix wrap (raw prompt)');
        return '';
      }
      return prefixMap[locale] || prefixMap.en || '';
    } catch (e) {
      console.warn('[AI Agent] getEnhancePrefix error:', e.message, '— skip prefix wrap');
      return '';
    }
  }

  // ============ HELPER: Inject ref images vào ChatGPT (extract từ Phase X) ============
  // Dùng chung cho cả listener `chatAI:execute` (Phase X) và `chatgpt:submitAndWait` (CG-3).
  async function injectRefImages(images) {
    if (!images || images.length === 0) return true;

    // CRITICAL — remove ref images cũ TRƯỚC upload mới.
    // Nếu user đã upload ref ở session trước (chưa clear), upload mới sẽ append → preview
    // có ref cũ + ref mới → submit context sai. Match Flow/Grok pattern.
    await removeExistingChatGPTRefImages();
    await sleep(300);

    // Convert base64 thành File objects
    const files = images.map(img => {
      const binary = atob(img.base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return new File([bytes], img.name || 'image.png', { type: img.type || 'image/png' });
    });

    // Tìm input file — RETRY trước khi fallback click plus (tránh mở menu reset image mode)
    // Input #upload-photos có class sr-only (hidden) nhưng LUÔN tồn tại trong DOM
    let fileInput = null;
    for (let retry = 0; retry < 3; retry++) {
      fileInput = _queryWithFallback('file_input');
      if (fileInput) break;
      await sleep(200);
    }

    // Server-Only: không fallback inline hardcode

    // LAST RESORT: Click plus button — có thể RESET IMAGE MODE!
    // Sau đó step 4 (ACTIVATE IMAGE MODE) trong chatgpt:submitAndWait — chạy SAU model (4a) +
    // upload → là thao tác composer cuối trước submit → re-activate image mode (survive mọi reset).
    if (!fileInput) {
      console.warn('[ChatGPT] #upload-photos không tìm thấy, fallback click plus button');
      const plusBtn = _queryWithFallback('plus_button');
      if (plusBtn) {
        simulateClick(plusBtn);
        await sleep(300);
        fileInput = _queryWithFallback('file_input');
        // Đóng menu ngay lập tức để giảm thiểu ảnh hưởng đến state
        try {
          document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        } catch (_) {}
        await sleep(100);
      }
    }

    if (!fileInput) {
      console.error('[ChatGPT] Không tìm thấy input file để upload ref image');
      return false;
    }

    // Inject files qua DataTransfer
    const dt = new DataTransfer();
    files.forEach(f => dt.items.add(f));
    fileInput.files = dt.files;
    fileInput.dispatchEvent(new Event('change', { bubbles: true }));

    // Chờ preview xuất hiện. Bug 57 fix: interruptibleSleep để user forceStop break sớm
    // trong cửa sổ 2s này (longest single-sleep window pre-submit).
    await interruptibleSleep(2000, 'after-upload-files');
    return true;
  }

  // ============ HELPER: Inject text + click submit (extract từ Phase X) ============
  // ============================================================================
  //  ChatGPT injectTextAndSubmit — pipeline 7 steps với fallback chain
  //  Test verified 2026-05-09 (chatgpt-submit-prompt-test.txt)
  // ============================================================================
  //
  //  ┌─ CLEAR (Step 1b) — chỉ chạy khi editor có stale text ─────────────────┐
  //  │ Tier 1 'selectAllDelete'   PRIMARY  ✅ verified work                   │
  //  │   → execCommand('selectAll') + execCommand('delete')                  │
  //  │ Tier 2 'innerHTMLReset'    FALLBACK ✅ verified work (Test 7 manual)   │
  //  │   → editor.innerHTML = '<p><br/></p>' + InputEvent('input')           │
  //  └────────────────────────────────────────────────────────────────────────┘
  //
  //  ┌─ INSERT (Step 2) ─────────────────────────────────────────────────────┐
  //  │ Tier 1 'pasteEvent'        PRIMARY  ✅ verified work (smoke test)      │
  //  │   → ClipboardEvent('paste') + DataTransfer text/plain                 │
  //  │ Tier 2 'execCommand'       FALLBACK ✅ verified work (Test 2)          │
  //  │   → document.execCommand('insertText', false, text)                   │
  //  │ Tier 3 'innerHTMLReplace'  LAST     ✅ verified work (Test 3)          │
  //  │   → editor.innerHTML = '<p>...</p>' + InputEvent('input')             │
  //  │ ❌ 'reactPropsBeforeInput'  DEAD     ❌ verified fail (Test 1)          │
  //  │   → editor #prompt-textarea KHÔNG có __reactProps$ key → ĐÃ BỎ        │
  //  └────────────────────────────────────────────────────────────────────────┘
  //
  //  ┌─ SUBMIT (Step 3-7) ───────────────────────────────────────────────────┐
  //  │ Tier 1 'enterKey'          PRIMARY  ✅ verified work (smoke test)      │
  //  │   → KeyboardEvent('keydown' + 'keypress' + 'keyup') trên editor       │
  //  │ Tier 2 'simulateClick'     FALLBACK ✅ verified work (Test 4)          │
  //  │   → PointerEvent + MouseEvent chain trên submit button                │
  //  │ Tier 3 'reactOnClick'      FALLBACK ✅ verified work (Test 5)          │
  //  │   → submitBtn.__reactProps.onClick (plain object, KHÔNG có isTrusted) │
  //  │ Tier 4 'formRequestSubmit' LAST     ✅ verified work (Test 6)          │
  //  │   → form.requestSubmit(submitBtn) — HTML standard, native trusted     │
  //  │   ⭐ Resilient nhất khi OpenAI siết trust check tương lai             │
  //  └────────────────────────────────────────────────────────────────────────┘
  //
  //  ┌─ Force test flag (cross-world dataset, set qua DevTools console) ─────┐
  //  │ document.documentElement.dataset.tobyChatgptClearForce  = '...'        │
  //  │ document.documentElement.dataset.tobyChatgptInsertForce = '...'        │
  //  │ document.documentElement.dataset.tobyChatgptSubmitForce = '...'        │
  //  │ Reset: delete document.documentElement.dataset.tobyChatgpt<X>Force     │
  //  └────────────────────────────────────────────────────────────────────────┘
  // ============================================================================
  async function injectTextAndSubmit(text) {
    const log = (...args) => console.log('[ChatGPT-submit]', ...args);

    // 1. Tìm editor — Server-Only: dynamic composer selector với retry
    let editor = null;
    const editorTimeout = Date.now() + 10000;
    while (Date.now() < editorTimeout) {
      editor = _queryWithFallback('composer', null, { silent: true });
      if (editor) break;
      await sleep(200);
    }
    if (!editor) {
      log('FAIL: EDITOR_NOT_FOUND');
      throw new Error('EDITOR_NOT_FOUND');
    }
    log('Step 1: Editor found', editor.id || editor.className);

    editor.focus();
    await sleep(150);

    // 1b. CLEAR editor — Force flag: document.documentElement.dataset.tobyChatgptClearForce
    //     Tiers: 'selectAllDelete' (primary), 'innerHTMLReset' (fallback)
    //     CRITICAL: KHÔNG clear khi editor đã empty (sẽ phá ProseMirror state).
    const clearForce = document.documentElement.dataset.tobyChatgptClearForce || null;
    if (clearForce) log('Step 1b [FORCE=' + clearForce + ']');
    const editorTextBeforeClear = (editor.textContent || '').trim();
    if (editorTextBeforeClear.length > 0 || clearForce) {
      log('Step 1b: Clearing editor (length=' + editorTextBeforeClear.length + ')');
      try {
        // Tier selectAllDelete (primary)
        if (!clearForce || clearForce === 'selectAllDelete') {
          log('Step 1b[selectAllDelete]: execCommand selectAll+delete');
          document.execCommand('selectAll', false, null);
          await sleep(50);
          document.execCommand('delete', false, null);
          await sleep(100);
        }
        // Tier innerHTMLReset (fallback nếu primary fail HOẶC force)
        const stillHasText = (editor.textContent || '').trim().length > 0;
        if (clearForce === 'innerHTMLReset' || (!clearForce && stillHasText)) {
          log('Step 1b[innerHTMLReset]: editor.innerHTML reset');
          editor.innerHTML = '<p><br class="ProseMirror-trailingBreak"></p>';
          editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContent' }));
          await sleep(80);
        }
        log('Step 1b OK: editor cleared, current length=', editor.textContent.length);
      } catch (clearErr) {
        log('Step 1b clear failed (non-fatal):', clearErr.message);
      }
      editor.focus();
      await sleep(80);
    } else {
      log('Step 1b: Editor đã empty, skip clear (tránh phá ProseMirror state)');
    }

    // 2. INSERT — Force flag: document.documentElement.dataset.tobyChatgptInsertForce
    //    Tiers: 'pasteEvent' (primary) | 'execCommand' | 'innerHTMLReplace'
    //    BỎ tier reactPropsBeforeInput: VERIFIED dead code (Test 1 2026-05-09)
    //      → ChatGPT ProseMirror editor #prompt-textarea KHÔNG có __reactProps$ key
    const insertForce = document.documentElement.dataset.tobyChatgptInsertForce || null;
    if (insertForce) log('Step 2 [FORCE=' + insertForce + ']');
    const sample = text.substring(0, Math.min(20, text.length));
    const inserted = () => editor.textContent.includes(sample);

    // Tier pasteEvent (primary)
    if (!insertForce || insertForce === 'pasteEvent') {
      log('Step 2[pasteEvent]: ClipboardEvent paste, length=', text.length);
      try {
        const dt = new DataTransfer();
        dt.setData('text/plain', text);
        editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
        await sleep(300);
      } catch (e) { log('Step 2[pasteEvent] fail:', e.message); }
    }

    // Tier execCommand
    if (insertForce === 'execCommand' || (!insertForce && !inserted())) {
      log('Step 2[execCommand]: document.execCommand insertText');
      document.execCommand('insertText', false, text);
      await sleep(200);
    }

    // Tier innerHTMLReplace (last resort)
    if (insertForce === 'innerHTMLReplace' || (!insertForce && !inserted())) {
      log('Step 2[innerHTMLReplace]: editor.innerHTML + InputEvent (last resort)');
      editor.innerHTML = `<p>${text.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`;
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      await sleep(200);
    }

    // [B] Fix force silent fail: nếu force mode nhưng tier skip (no-op) → editor empty → submit empty
    // Verify sau insert, nếu force mode + insert fail → throw rõ ràng thay vì silent submit empty.
    if (insertForce && !inserted()) {
      log('Step 2 [FORCE=' + insertForce + '] FAILED: tier không insert được text. Editor length=' + editor.textContent.length);
      throw new Error('FORCE_INSERT_TIER_FAILED:' + insertForce);
    }

    // CRITICAL: Dispatch input event SAU paste để React's ProseMirror onChange handler chạy.
    // ClipboardEvent paste cập nhật DOM nhưng đôi khi React state không sync → submit button
    // visually enabled nhưng React internal state still empty → click không submit.
    editor.dispatchEvent(new InputEvent('input', {
      bubbles: true, cancelable: true,
      inputType: 'insertFromPaste', data: text,
    }));
    await sleep(150);

    log('Step 2 OK: editor.textContent length=', editor.textContent.length);

    // 3-7. SUBMIT — Force flag: document.documentElement.dataset.tobyChatgptSubmitForce
    //      Tiers: 'enterKey' (primary) | 'simulateClick' | 'reactOnClick' | 'formRequestSubmit'
    const submitForce = document.documentElement.dataset.tobyChatgptSubmitForce || null;
    if (submitForce) log('Step 3-7 [FORCE=' + submitForce + ']');
    const submitted = () => (editor.textContent || '').trim().length < 5;

    // Tier enterKey (primary)
    if (!submitForce || submitForce === 'enterKey') {
      log('Step 3[enterKey]: KeyboardEvent keydown+keypress+keyup');
      editor.focus();
      await sleep(80);
      const enterOpts = {
        key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
        bubbles: true, cancelable: true, composed: true,
      };
      try {
        editor.dispatchEvent(new KeyboardEvent('keydown', enterOpts));
        editor.dispatchEvent(new KeyboardEvent('keypress', enterOpts));
        editor.dispatchEvent(new KeyboardEvent('keyup', enterOpts));
      } catch (e) { log('Step 3[enterKey] dispatch fail:', e.message); }
      await sleep(1500);
      if (submitted()) {
        log('Step 4 OK: editor cleared → submit thành công via enterKey');
        return true;
      }
      // Force mode: don't fall through (chỉ test 1 tier)
      if (submitForce === 'enterKey') {
        log('Step 4 [FORCE=enterKey] DONE: editor still has text');
        return true;
      }
    }

    // Tier simulateClick + reactOnClick (Step 5 — share logic find button)
    let sendBtn = null;
    if (submitForce === 'simulateClick' || submitForce === 'reactOnClick' || (!submitForce && !submitted())) {
      log('Step 5: tìm submit button cho simulateClick/reactOnClick fallback');
      // 2026-05-31: bump timeout 3s → 30s + detect file-tile upload state.
      // Long prompt (>4-5K chars) → ChatGPT auto-convert thành .txt file attachment →
      // submit button disabled trong upload. File tile có button[name="expand-file-tile"]
      // ("Show in text field") + spinner. Đợi spinner clear + button enabled.
      const start = Date.now();
      const POLL_TIMEOUT = 30000; // 30s max — đủ upload file lớn
      let lastDiag = 0;
      while (Date.now() - start < POLL_TIMEOUT) {
        const candidate = _queryWithFallback('submit_button');
        if (candidate && !candidate.disabled) { sendBtn = candidate; break; }
        // Diagnostic mỗi 3s để debug stuck state
        if (Date.now() - lastDiag > 3000) {
          const fileTile = document.querySelector('button[name="expand-file-tile"]');
          const fileSpinner = document.querySelector('.composer-attach .animate-spin, [name="expand-file-tile"] ~ * .animate-spin');
          log(`Step 5 polling: btn=${!!candidate} disabled=${candidate?.disabled} fileTile=${!!fileTile} spinner=${!!fileSpinner}`);
          lastDiag = Date.now();
        }
        await sleep(200);
      }
      if (!sendBtn) {
        log('FAIL: SEND_BUTTON_NOT_FOUND_OR_DISABLED. Editor content:', editor.textContent.substring(0, 50));
        if (submitForce) return true; // Force mode tolerant
        throw new Error('SEND_BUTTON_NOT_FOUND');
      }

      // Tier simulateClick
      if (!submitForce || submitForce === 'simulateClick') {
        log('Step 5[simulateClick]: PointerEvent + MouseEvent chain');
        const rect = sendBtn.getBoundingClientRect();
        const opts = { bubbles: true, cancelable: true, view: window,
          clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
        try {
          sendBtn.dispatchEvent(new PointerEvent('pointerdown', opts));
          sendBtn.dispatchEvent(new MouseEvent('mousedown', opts));
          sendBtn.dispatchEvent(new PointerEvent('pointerup', opts));
          sendBtn.dispatchEvent(new MouseEvent('mouseup', opts));
          sendBtn.dispatchEvent(new MouseEvent('click', opts));
        } catch (e) { log('Step 5[simulateClick] fail:', e.message); }
      }

      // Tier reactOnClick (chạy sau simulateClick trong production, hoặc force isolated)
      if (submitForce === 'reactOnClick' || (!submitForce)) {
        const propsKey = Object.keys(sendBtn).find(k => k.startsWith('__reactProps$'));
        const props = propsKey ? sendBtn[propsKey] : null;
        if (props && typeof props.onClick === 'function') {
          log('Step 5[reactOnClick]: React props onClick (plain object, no isTrusted)');
          try {
            props.onClick({
              preventDefault() {}, stopPropagation() {},
              nativeEvent: new MouseEvent('click'),
              type: 'click', target: sendBtn, currentTarget: sendBtn,
            });
          } catch (e) { log('Step 5[reactOnClick] fail:', e.message); }
        } else if (submitForce === 'reactOnClick') {
          log('Step 5[reactOnClick] skip: __reactProps.onClick not found');
        }
      }

      // Verify (production mode only — force mode return ngay)
      if (!submitForce) {
        await sleep(1500);
        if (submitted()) {
          log('Step 6 OK: editor cleared sau click → submit thành công');
          return true;
        }
      } else if (submitForce === 'simulateClick' || submitForce === 'reactOnClick') {
        log('Step 6 [FORCE=' + submitForce + '] DONE');
        return true;
      }
    }

    // Tier formRequestSubmit (Step 7 — last resort hoặc force)
    if (submitForce === 'formRequestSubmit' || (!submitForce && !submitted())) {
      log('Step 7[formRequestSubmit]: form.requestSubmit() native HTML');
      try {
        const formBtn = sendBtn || _queryWithFallback('submit_button') || _queryWithFallback('submit_button');
        const form = (formBtn && formBtn.closest('form')) || editor.closest('form');
        if (form && typeof form.requestSubmit === 'function') {
          form.requestSubmit(formBtn);
          await sleep(1000);
          if (submitted()) {
            log('Step 7[formRequestSubmit] OK: editor cleared');
            return true;
          }
          log('Step 7[formRequestSubmit] không clear editor');
        } else {
          log('Step 7[formRequestSubmit] skip: form không tồn tại hoặc không hỗ trợ requestSubmit');
        }
      } catch (e) {
        log('Step 7[formRequestSubmit] fail:', e.message);
      }
    }

    log('Step 7 DONE: All submit strategies đã thử');
    return true;
  }

  // ============ Wrapper Phase X: giữ tương thích listener `chatAI:execute` ============
  async function uploadImages(images) {
    try {
      return await injectRefImages(images);
    } catch (err) {
      console.error('[ChatAI] uploadImages error:', err.message);
      return false;
    }
  }

  async function insertText(text) {
    // Server-Only: dynamic composer selector với retry
    let editor = null;
    const timeout = Date.now() + 5000;
    while (Date.now() < timeout) {
      editor = _queryWithFallback('composer', null, { silent: true });
      if (editor) break;
      await sleep(200);
    }
    if (!editor) {
      console.error('[ChatAI] Không tìm thấy ô nhập text trên ChatGPT');
      return false;
    }
    editor.focus();
    await sleep(200);
    document.execCommand('insertText', false, text);
    await sleep(200);
    if (!editor.textContent.includes(text.substring(0, 20))) {
      editor.innerHTML = `<p>${text}</p>`;
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    }
    return true;
  }

  async function clickSubmit() {
    await sleep(500);
    // Server-Only: dynamic submit_button selector (không fallback inline)
    let sendBtn = null;
    const start = Date.now();
    while (Date.now() - start < 5000) {
      sendBtn = _queryWithFallback('submit_button', null, { silent: true });
      if (sendBtn && !sendBtn.disabled) break;
      sendBtn = null;
      await sleep(300);
    }
    if (!sendBtn) {
      console.error('[ChatAI] Không tìm thấy nút gửi trên ChatGPT');
      return false;
    }
    simulateClick(sendBtn);
    return true;
  }

  // ============ CG-3.x: Check ChatGPT image creation limit alert (free plan) ============
  // ChatGPT free plan khi hết quota image gen sẽ hiện banner trên editor:
  // "You've reached your image creation limit. Upgrade to ChatGPT Plus or try again after H:MM AM/PM."
  // Detect TRƯỚC khi submit → tránh lãng phí thao tác.
  function checkImageLimitAlert() {
    // Normalize: chuyển ký tự đặc biệt về ASCII để match đa dạng quotes
    const normalize = (s) => (s || '')
      .replace(/[’‘]/g, "'")        // smart quotes → apostrophe
      .replace(/[  ]/g, ' ')        // narrow/non-break space → space
      .toLowerCase();

    // Tìm trong body.innerText (rẻ + reliable)
    const bodyText = normalize(document.body?.innerText || '');
    const limitPhrase = "reached your image creation limit";
    if (!bodyText.includes(limitPhrase)) return null;

    // Extract message gốc (trước normalize) để hiện cho user
    const fullText = document.body?.innerText || '';
    // Tìm câu chứa phrase (split theo "."  hoặc "\n")
    const sentences = fullText.split(/[\n]+/);
    let matchSentence = '';
    for (const sent of sentences) {
      if (normalize(sent).includes(limitPhrase)) {
        matchSentence = sent.trim();
        break;
      }
    }
    return {
      detected: true,
      message: matchSentence || "You've reached your image creation limit on the free plan.",
    };
  }

  // ============ CG-3.1: Snapshot conversation state ============
  // Lưu turnCount + 5 turn ID gần nhất + existing image file_ids để waitForImageResult so sánh.
  // CRITICAL: existingImageFileIds dùng để loại trừ ảnh CŨ trong chat history khi global fallback
  // detect → tránh bug "submit prompt trên chat có lịch sử → ext download ảnh cũ ngay".
  function snapshotConversationState() {
    const turns = _queryAllWithFallback('conversation_turn');

    // Capture file_ids của TẤT CẢ CDN images (generated + ref/uploaded) trên page TRƯỚC submit
    // Server-Only: dynamic cdn_image selectors
    const existingImageFileIds = new Set();
    const allCdnImgs = _queryCdnImages(document);
    for (const img of allCdnImgs) {
      if (!img.src) continue;
      const m = img.src.match(/[?&]id=(file_[a-z0-9]+)/i);
      if (m) existingImageFileIds.add(m[1]);
    }
    console.log('[ChatGPT-snapshot] 📸 Baseline:', turns.length, 'turns,', existingImageFileIds.size, 'existing file_ids (incl. refs)');

    return {
      turnCount: turns.length,
      existingImageFileIds, // Set<file_xxx> — bao gồm cả generated + ref/uploaded
      lastTurnIds: Array.from(turns)
        .slice(-5)
        .map(t => t.dataset.turnId || t.dataset.testid),
      timestamp: Date.now(),
    };
  }

  // ============ CG-3.1: Streaming detection (multi-signal) ============
  // ChatGPT image gen DOM THẬT (verify từ chatgpt-Generating-dom.html):
  // - KHÔNG có [data-testid="stop-button"]
  // - Signal RELIABLE: element có aria-label="Generating image..." trong turn
  // - Send button có thể disabled hoặc không
  function isStreaming(turnEl) {
    // (A) PRIMARY signal cho image gen: generating indicator trong turn hoặc global
    if (_hasGeneratingIndicator(turnEl)) return true;
    if (_hasGeneratingIndicator()) return true;

    // (B) Stop button tồn tại global khi đang stream text (không phải image)
    if (_queryWithFallback('stop_button')) return true;

    // (C) Send button đang disabled (state trong khi assistant đang trả lời)
    const sendBtn = _queryWithFallback('submit_button');
    if (sendBtn?.disabled) return true;

    // (D) Có skeleton/shimmer/animate-pulse trong turn nhưng chưa có img generated
    const hasSkeleton = turnEl.querySelector(
      '[class*="skeleton"], [class*="shimmer"], [class*="animate-pulse"]'
    );
    const hasImg = !!_findGeneratedImg(turnEl);
    if (hasSkeleton && !hasImg) return true;

    return false;
  }

  // ============ CG-3.1 Helper: Tìm img đã generated trong turn ============
  // ChatGPT CDN có thể là: estuary/content?id=file_xxx, oaiusercontent.com,
  // sandboxed.openai.com, files.oaiusercontent.com... → match nhiều pattern.
  // Loại blur-2xl backdrop duplicate.
  // PRIORITY: alt-based TRƯỚC (signal mạnh nhất — chỉ image gen mới có alt^="Generated image")
  // → loại trừ ref/uploaded images (alt="Uploaded image") cùng có estuary URL.
  function _findGeneratedImg(turnEl) {
    // Priority 1: Server-Only dynamic generated_image selector
    const altMatch = _queryWithFallback('generated_image', null, { scope: turnEl, silent: true });
    if (altMatch && !altMatch.classList.contains('blur-2xl') && altMatch.src) return altMatch;

    // Priority 2: CDN URL (fallback nếu alt missing)
    // Server-Only: dynamic cdn_image selectors
    // FIX: INCLUSIVE filter — chỉ chấp nhận "Generated image..." hoặc "" (siblings)
    const candidates = _queryCdnImages(turnEl);
    for (const img of candidates) {
      if (img.classList.contains('blur-2xl')) continue;
      const alt = img.getAttribute('alt') || '';
      const isGenerated = alt.toLowerCase().startsWith('generated image');
      const isSibling = alt === '';
      if (!isGenerated && !isSibling) continue;
      if (img.src) return img;
    }

    // DEBUG: Log if we have img but no match (once per 5s to avoid spam)
    if (!_findGeneratedImg._lastDebug || Date.now() - _findGeneratedImg._lastDebug > 5000) {
      const allImgs = turnEl.querySelectorAll('img');
      if (allImgs.length > 0) {
        console.log('[ChatGPT-find] 🔍 No generated img found, turn has', allImgs.length, 'imgs');
        for (let i = 0; i < Math.min(allImgs.length, 3); i++) {
          const img = allImgs[i];
          console.log('  [' + i + '] src:', (img.src || '').slice(0, 80), '| alt:', (img.alt || '').slice(0, 40));
        }
        _findGeneratedImg._lastDebug = Date.now();
      }
    }
    return null;
  }

  // ============ CG-3.1: Error detection ============
  // Patterns từ /admin/providers/chatgpt → API Configs → provider_configs.api_config.error_patterns
  // ChatGPTConfig fetch + cache vào chrome.storage.local.af_chatgpt_config (TTL 1h).
  //
  // Strict Server-Only — NO hardcoded FALLBACK_PATTERNS.
  // Patterns đọc 100% từ `chrome.storage.local.af_chatgpt_config` (background.js preload).
  let _activePatterns = {
    rateLimit: [],
    contentBlocked: [],
    imageGenFailed: [],
    network: [],
    textOnly: [],
    cloudflare: [],
  };

  // Parse pipe-separated string thành array lowercase
  function _parsePatternString(str) {
    if (!str || typeof str !== 'string') return [];
    return str.split('|').map(s => s.trim().toLowerCase()).filter(Boolean);
  }

  /**
   * Load patterns từ chrome.storage.local.af_chatgpt_config.
   * @returns {Promise<boolean>} true nếu load có ít nhất 1 pattern
   */
  async function _loadPatternsFromStorage() {
    try {
      const result = await new Promise((r) => chrome.storage.local.get(['af_chatgpt_config'], r));
      const cfg = result?.af_chatgpt_config?.data;
      if (!cfg) return false;
      _activePatterns.rateLimit = _parsePatternString(cfg.rate_limit_error_text);
      _activePatterns.contentBlocked = _parsePatternString(cfg.content_blocked_text);
      _activePatterns.imageGenFailed = _parsePatternString(cfg.image_gen_failed_text);
      _activePatterns.network = _parsePatternString(cfg.network_error_text);
      _activePatterns.textOnly = _parsePatternString(cfg.text_only_pattern);
      _activePatterns.cloudflare = _parsePatternString(cfg.cloudflare_challenge_text);
      const total = Object.values(_activePatterns).reduce((s, a) => s + a.length, 0);
      return total > 0;
    } catch (e) {
      return false;
    }
  }

  // Server-Only: Wait/retry pattern (giống _ensureSelectorConfig). Khác selectors:
  // KHÔNG block UI overlay vì error detection degrade gracefully.
  const _PATTERNS_WAIT_MAX_MS = 10000;
  const _PATTERNS_WAIT_INTERVAL_MS = 500;

  (async function _ensurePatternsConfig() {
    const startTime = Date.now();
    let attempts = 0;
    let lastLogElapsed = 0;
    console.log(`[ChatGPT:patterns:ensure] ⏳ Waiting for error patterns in chrome.storage.local.af_chatgpt_config (timeout ${_PATTERNS_WAIT_MAX_MS}ms)...`);
    while (Date.now() - startTime < _PATTERNS_WAIT_MAX_MS) {
      attempts++;
      const ok = await _loadPatternsFromStorage();
      if (ok) {
        const total = Object.values(_activePatterns).reduce((s, a) => s + a.length, 0);
        console.log(`[ChatGPT:patterns:ensure] ✅ Loaded ${total} patterns across ${Object.keys(_activePatterns).length} categories after ${attempts} attempts (${Date.now() - startTime}ms)`);
        return;
      }
      try {
        chrome.runtime.sendMessage({ action: 'getProviderConfigs', provider: PROVIDER }, () => {
          if (chrome.runtime.lastError) { /* SW suspended — silent */ }
        });
      } catch (_) { /* SW disconnected — silent */ }
      const elapsed = Date.now() - startTime;
      if (elapsed - lastLogElapsed >= 2000) {
        lastLogElapsed = elapsed;
        console.log(`[ChatGPT:patterns:ensure] ⏳ Still waiting (${(elapsed / 1000).toFixed(1)}s/${_PATTERNS_WAIT_MAX_MS / 1000}s, attempt #${attempts})...`);
      }
      await new Promise(r => setTimeout(r, _PATTERNS_WAIT_INTERVAL_MS));
    }
    console.warn(`[ChatGPT:patterns:ensure] ⚠️ Timeout after ${attempts} attempts — error detection degraded. User vẫn submit được, chỉ là tracker hiển thị TIMEOUT thay vì error code chính xác.`);
  })();

  // Listen storage changes — khi sidebar refresh ChatGPTConfig, tab chatgpt.com cũng cập nhật
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.af_chatgpt_config) {
        _loadPatternsFromStorage();
      }
    });
  } catch (e) { /* ignore in non-extension context */ }

  function detectError(turnEl) {
    const text = (turnEl.innerText || '').toLowerCase();
    if (_activePatterns.rateLimit.some(p => text.includes(p))) return 'RATE_LIMIT';
    if (_activePatterns.contentBlocked.some(p => text.includes(p))) return 'CONTENT_BLOCKED';
    if (_activePatterns.imageGenFailed.some(p => text.includes(p))) return 'IMAGE_GEN_FAILED';
    if (_activePatterns.network.some(p => text.includes(p))) return 'NETWORK';
    return null;
  }

  // ============ CG-3.1: Extract image URLs từ turn ============
  // Server-Only: dynamic cdn_image selectors
  // Bỏ qua duplicate blur backdrop (class blur-2xl) và dedup theo FILE_ID (không phải full URL).
  // Reference DOM verified: 1 generated image render thành 3 <img> tags với cùng file_id
  // nhưng signature/timestamp khác nhau → full URL dedup KHÔNG dedup được.
  // FIX: extract `file_xxx` từ URL → dedup theo file_id để tránh download trùng N lần.
  function extractImageUrls(turnEl) {
    const images = _queryCdnImages(turnEl);
    // DEBUG: Dump ALL images in turn to diagnose selector mismatches
    const allImgs = turnEl.querySelectorAll('img');
    if (allImgs.length > 0 && images.length === 0) {
      console.log('[ChatGPT-extract] 🔍 DEBUG: CDN selector miss, dumping all', allImgs.length, 'imgs:');
      for (let i = 0; i < Math.min(allImgs.length, 5); i++) {
        const img = allImgs[i];
        console.log('  [' + i + '] src:', (img.src || '').slice(0, 100), '| alt:', (img.alt || '').slice(0, 50));
      }
    }
    // Map<fileId, url> — keep first occurrence per file_id (typically the highest-quality one with alt^="Generated image")
    const urlByFileId = new Map();
    const candidates = [];
    let debugInfo = { total: images.length, skippedBlur: 0, skippedRef: 0, skippedEmpty: 0 };
    for (const img of images) {
      if (img.classList.contains('blur-2xl')) { debugInfo.skippedBlur++; continue; }
      const src = img.src;
      if (!src) { debugInfo.skippedEmpty++; continue; }
      const alt = img.getAttribute('alt') || '';
      // FIX: INCLUSIVE filter — chỉ chấp nhận "Generated image..." hoặc "" (siblings)
      // ChatGPT đã đổi alt của ref images từ "Uploaded image" sang UUID (vd: "70bc7693-2579-4af8-...")
      // → filter cũ (exclude "Uploaded image") không còn hoạt động
      const isGenerated = alt.toLowerCase().startsWith('generated image');
      const isSibling = alt === '';
      if (!isGenerated && !isSibling) {
        console.log('[ChatGPT-extract] ⏭️ Skip non-generated:', alt.slice(0, 50), '| file_id:', src.match(/[?&]id=(file_[a-z0-9]+)/i)?.[1]);
        debugInfo.skippedRef++;
        continue;
      }
      candidates.push({ src, alt });
    }
    console.log('[ChatGPT-extract] 📊 Images in turn:', JSON.stringify(debugInfo), '| Candidates after filter:', candidates.length);

    // Sort: prioritize "Generated image: ..." alt first (chính), then "" alt (siblings)
    candidates.sort((a, b) => {
      const aGen = a.alt.toLowerCase().startsWith('generated image') ? 0 : 1;
      const bGen = b.alt.toLowerCase().startsWith('generated image') ? 0 : 1;
      return aGen - bGen;
    });

    for (const c of candidates) {
      const fileIdMatch = c.src.match(/[?&]id=(file_[a-z0-9]+)/i);
      const key = fileIdMatch ? fileIdMatch[1] : c.src; // fallback dedup by full URL nếu không có file_id
      if (!urlByFileId.has(key)) {
        urlByFileId.set(key, c.src);
      }
    }

    // Fallback: Server-Only dynamic generated_image selector
    if (urlByFileId.size === 0) {
      const altMatches = _queryAllWithFallback('generated_image', null, turnEl);
      for (const img of altMatches) {
        if (img.classList.contains('blur-2xl')) continue;
        if (!img.src) continue;
        // Bug fix 2026-05-27: loại ref images (alt=UUID) — selector generated_image có
        // img[src*="/backend-api/"] match cả ref. Chỉ nhận generated thật (alt^="Generated image" hoặc "").
        const a = img.getAttribute('alt') || '';
        if (!(a.toLowerCase().startsWith('generated image') || a === '')) continue;
        const fileIdMatch = img.src.match(/[?&]id=(file_[a-z0-9]+)/i);
        const key = fileIdMatch ? fileIdMatch[1] : img.src;
        if (!urlByFileId.has(key)) urlByFileId.set(key, img.src);
      }
    }
    return Array.from(urlByFileId.values());
  }

  // ============ CG-8: Poll conversation đợi TEXT result (Prompt node enhance) ============
  // Khác waitForImageResult: KHÔNG check img estuary, chỉ chờ assistant turn xong streaming
  // rồi extract innerText. Dùng cho Prompt node enhance qua ChatGPT (text-only).
  async function waitForTextResult(baseline, timeout = 60000) {
    const startTime = Date.now();
    const pollInterval = 500;
    let lastDiag = 0;
    let lastTextLength = 0;
    let stableCount = 0;
    // 2026-05-31: Bump threshold 3 → 8 (~4s). Bug: long AI response (5000+ chars) thường
    // có pause 1-2s giữa các đoạn (model thinking / network) → stop_button vô hình tạm thời
    // → stability false positive ở 1.5s → capture partial. Vd user case: image_prompt_4
    // chỉ get 35 chars, video_prompt_4 marker không xuất hiện → text_extract fail cascade.
    const STABLE_THRESHOLD = 8; // Text phải stable qua 8 poll cycles (~4s) mới coi là xong

    while (Date.now() - startTime < timeout) {
      // Check abort flag
      if (isAbortActive()) {
        console.log('[ChatGPT-text] Aborted by user → clicking Stop button');
        await clickChatGPTStopButton();
        return { success: false, error: 'ABORTED', message: 'User stopped execution' };
      }

      // Server-Only: dynamic assistant_turn + conversation_turn selectors
      const allAssistantTurns = _queryAllWithFallback('assistant_turn');
      const allTurns = _queryAllWithFallback('conversation_turn');

      // Chưa có turn mới so với baseline → tiếp tục poll
      if (allTurns.length <= baseline.turnCount) {
        if (Date.now() - lastDiag > 5000) {
          console.log('[ChatGPT-text] Chưa có turn mới — turnCount:', allTurns.length, 'baseline:', baseline.turnCount);
          lastDiag = Date.now();
        }
        await sleep(pollInterval);
        continue;
      }

      const lastAssistantTurn = allAssistantTurns[allAssistantTurns.length - 1];
      if (!lastAssistantTurn) {
        await sleep(pollInterval);
        continue;
      }

      // 1. Detect error trước (ưu tiên RATE_LIMIT/CONTENT_BLOCKED/...)
      const error = detectError(lastAssistantTurn);
      if (error) {
        console.log('[ChatGPT-text] Error:', error);
        return {
          success: false,
          error,
          message: (lastAssistantTurn.innerText || '').slice(0, 500),
        };
      }

      // 2. Detect streaming qua nhiều signal:
      //    - aria-label="Stop generating" hoặc "Stop" button tồn tại
      //    - data-testid="stop-button" tồn tại
      //    - Có progress/loading indicators
      //    - Text vẫn đang thay đổi (stability check)
      const stopGenBtn = _queryWithFallback('stop_button');
      const stillGeneratingImg = _hasGeneratingIndicator(lastAssistantTurn);

      // Check thinking/loading indicators trong turn (Server-Only: dynamic selector)
      const hasThinkingIndicator = _queryWithFallback('thinking_indicator', null, { scope: lastAssistantTurn, silent: true });

      // Signal-based streaming detection
      const signalStreaming = !!stopGenBtn || !!stillGeneratingImg || !!hasThinkingIndicator;

      // 3. Extract current text để check stability (Server-Only: dynamic selectors)
      let currentText = '';
      const roleWrapper = _queryWithFallback('message_author', null, { scope: lastAssistantTurn, silent: true });
      const markdownEl = _queryWithFallback('response_text_content', null, { scope: roleWrapper || lastAssistantTurn, silent: true });
      if (markdownEl && typeof markdownEl.innerText === 'string') {
        currentText = markdownEl.innerText.trim();
      } else if (roleWrapper && typeof roleWrapper.innerText === 'string') {
        currentText = roleWrapper.innerText.trim();
      }
      if (!currentText) {
        currentText = (lastAssistantTurn.innerText || '').trim();
      }

      // Text stability check: text phải không đổi qua STABLE_THRESHOLD cycles
      const currentTextLength = currentText.length;
      if (currentTextLength === lastTextLength && currentTextLength > 0) {
        stableCount++;
      } else {
        stableCount = 0;
        lastTextLength = currentTextLength;
      }

      const isTextStable = stableCount >= STABLE_THRESHOLD;
      const stillStreaming = signalStreaming || (!isTextStable && currentTextLength > 0);

      if (stillStreaming) {
        if (Date.now() - lastDiag > 5000) {
          console.log('[ChatGPT-text] Streaming — signals:', !!stopGenBtn, 'textLen:', currentTextLength, 'stable:', stableCount);
          lastDiag = Date.now();
        }
        await sleep(pollInterval);
        continue;
      }

      // 4. Streaming xong + text stable → return
      if (!currentText || currentText.length < 1) {
        // Turn complete nhưng rỗng — chờ thêm một chút
        if (Date.now() - startTime < 5000) {
          await sleep(pollInterval);
          continue;
        }
        return { success: false, error: 'TEXT_EMPTY' };
      }

      const turnId =
        lastAssistantTurn.dataset.turnId ||
        lastAssistantTurn.dataset.testid ||
        null;

      console.log('[ChatGPT-text] DONE — text length:', currentText.length, 'stableCount:', stableCount);
      return { success: true, text: currentText, turnId };
    }

    console.warn('[ChatGPT-text] TIMEOUT sau', timeout, 'ms');
    return { success: false, error: 'TIMEOUT' };
  }

  // ============ CG-3.1: Poll conversation đợi image result ============
  async function waitForImageResult(baseline, timeout = 120000) {
    const startTime = Date.now();
    const pollInterval = 1000;
    let lastDiag = 0;
    let textOnlyStreamStart = null;
    let postCompleteTextOnlyStart = null;
    const TEXT_ONLY_THRESHOLD_MS = 15000;
    const POST_COMPLETE_GRACE_MS = 5000;
    const MIN_WAIT_BEFORE_PATTERN_CHECK_MS = 5000;
    const MIN_WAIT_WITH_POSITIVE_MS = 10000;
    const MIN_TEXT_FOR_ERROR_CHECK = 80;

    // Positive indicators: ChatGPT có thể nói trước khi gen ảnh - KHÔNG trigger error sớm
    const POSITIVE_INDICATORS = [
      "i'll create", "i'll generate", "i'll make", "let me create", "let me generate",
      "creating", "generating", "here's", "here is", "sure", "absolutely", "of course",
    ];

    // Helper: check có positive indicator không (đang chuẩn bị gen)
    function hasPositiveIndicator(text) {
      if (!text) return false;
      const lower = text.toLowerCase();
      return POSITIVE_INDICATORS.some(p => lower.includes(p));
    }

    // Helper: check text có match pattern TEXT_ONLY không (ChatGPT trả text thay vì gen ảnh)
    function matchesTextOnlyPattern(text) {
      if (!text || text.length < 50) return false;
      const lower = text.toLowerCase();
      const patterns = _activePatterns.textOnly || []; // Server-Only: no hardcoded fallback
      return patterns.some(p => lower.includes(p));
    }

    // Helper: check tất cả error patterns và trả về error code nếu match
    function matchesAnyErrorPattern(text) {
      if (!text || text.length < MIN_TEXT_FOR_ERROR_CHECK) return null;
      const lower = text.toLowerCase();

      // Check từng loại error pattern
      const checks = [
        { key: 'rateLimit', error: 'RATE_LIMIT' },
        { key: 'contentBlocked', error: 'CONTENT_BLOCKED' },
        { key: 'imageGenFailed', error: 'IMAGE_GEN_FAILED' },
      ];

      for (const { key, error } of checks) {
        const patterns = _activePatterns[key] || []; // Server-Only: no hardcoded fallback
        if (patterns.some(p => lower.includes(p))) {
          return { error, text: text.slice(0, 500) };
        }
      }
      return null;
    }

    // Helper: tìm assistant turn MỚI (sau baseline) — ưu tiên turn có generating/result markers.
    // Server-Only: dynamic assistant_turn + image_action_buttons selectors
    function findNewAssistantTurn() {
      const allAssistantTurns = _queryAllWithFallback('assistant_turn');
      if (!allAssistantTurns.length) return null;

      // Get image_action_buttons selectors for fast-path check
      const actionBtnSelectors = _getSelectorsForKey('image_action_buttons');

      // Strategy 1: turn có dấu hiệu image generating/done — ưu tiên cao nhất
      for (let i = allAssistantTurns.length - 1; i >= 0; i--) {
        const turn = allAssistantTurns[i];
        // Check generating indicator
        if (_hasGeneratingIndicator(turn)) return turn;
        // Check image action buttons (Server-Only: dynamic)
        for (const sel of actionBtnSelectors) {
          if (turn.querySelector(sel)) return turn;
        }
        // Check generated image (Server-Only: dynamic)
        if (_queryWithFallback('generated_image', null, { scope: turn, silent: true })) return turn;
      }

      // Strategy 2: turn có testid number > baseline.turnCount (turn mới created sau submit)
      const newTurns = Array.from(allAssistantTurns).filter(turn => {
        const testid = turn.dataset.testid || turn.getAttribute('data-testid') || '';
        const m = testid.match(/conversation-turn-(\d+)/);
        if (!m) return false;
        return parseInt(m[1], 10) > baseline.turnCount;
      });
      if (newTurns.length > 0) return newTurns[newTurns.length - 1];

      // Strategy 3: fallback — last assistant turn (legacy)
      return allAssistantTurns[allAssistantTurns.length - 1];
    }

    // HEARTBEAT-based wait (bug fix 2026-05-27): KHÔNG timeout cứng. Còn indicator "Generating image"
    // = ChatGPT đang vẽ → chờ tiếp (reset đồng hồ). User báo gen nhiều ref chậm > timeout cũ →
    // timeout-oan dù gen thành công. `timeout` thành GIỚI HẠN cho case CHƯA bao giờ gen; MAX_WAIT là
    // trần an toàn tuyệt đối; HEARTBEAT_MS = ngưỡng coi stuck sau khi indicator tắt. (Mirror Grok.)
    const MAX_WAIT = Math.max(timeout, 600000);
    const HEARTBEAT_MS = 90000;
    let genSeenOnce = false;
    let lastGenActive = Date.now();
    while (Date.now() - startTime < MAX_WAIT) {
      // Check abort flag
      if (isAbortActive()) {
        console.log('[ChatGPT-image] Aborted by user → clicking Stop button');
        await clickChatGPTStopButton();
        return { success: false, error: 'ABORTED', message: 'User stopped execution' };
      }

      // Mid-flight challenge detect — bail sớm nếu session expire
      if (detectChatGPTChallenge()) {
        console.warn('[ChatGPT-image] Challenge re-emerged mid-stream → abort');
        return {
          success: false,
          error: 'CHALLENGE_TIMEOUT',
          message: 'ChatGPT yêu cầu xác minh trong khi gen — vui lòng verify thủ công và chạy lại.',
        };
      }

      const allTurns = _queryAllWithFallback('conversation_turn');

      // PRIORITY FALLBACK — Document-level detection nếu turn-based detection KHÔNG work.
      // Reference: chatgpt-Generating-dom.html cho fresh chat ChatGPT có thể dùng DOM markup
      // KHÁC `[data-testid^="conversation-turn-"]` (vd thread placeholder, redirect /c/{id}).
      // Detect qua selectors độc lập với turn structure:
      //   1. img[alt^="Generated image"] anywhere → image gen done globally
      //   2. button[aria-label="Like this image"] anywhere → post-action button visible
      // CRITICAL: Loại trừ ảnh có file_id trong baseline.existingImageFileIds → tránh bug
      // "submit trên chat có lịch sử → lấy ảnh cũ trước đó". Chỉ consider ảnh MỚI sau submit.
      const baselineFileIds = baseline.existingImageFileIds || new Set();
      // Bug fix 2026-05-27: dùng cdn_image (match theo SRC: estuary/content, backend-api...) thay vì
      // generated_image (alt-only) — ChatGPT set alt="Generated image" TRỄ nên trong cửa sổ render
      // ảnh đã có src nhưng alt="" → generated_image alt-only miss → timeout. cdn_image bắt sớm theo src;
      // alt-filter bên dưới (isGenerated || isSibling) vẫn loại ref images (alt=UUID) + baseline loại ảnh cũ.
      const allGenImgs = _queryCdnImages(document);

      // Build map of NEW images only (file_id NOT in baseline)
      // FIX: alt filter — chỉ chấp nhận "Generated image..." hoặc "" (sibling), LOẠI ref images (alt=UUID).
      const urlByFileId = new Map();
      for (const img of allGenImgs) {
        if (img.classList.contains('blur-2xl') || !img.src) continue;
        const alt = img.getAttribute('alt') || '';
        const isGenerated = alt.toLowerCase().startsWith('generated image');
        const isSibling = alt === '';
        if (!isGenerated && !isSibling) continue; // skip ref images (UUID alt)
        const m = img.src.match(/[?&]id=(file_[a-z0-9]+)/i);
        if (!m) continue;
        const fileId = m[1];
        if (baselineFileIds.has(fileId)) continue; // skip CŨ
        if (!urlByFileId.has(fileId)) urlByFileId.set(fileId, img.src);
      }

      const newImageUrls = Array.from(urlByFileId.values());
      const globalGenerating = _hasGeneratingIndicator();

      // HEARTBEAT: còn đang vẽ → chờ tiếp (reset đồng hồ). Stuck khi indicator tắt > HEARTBEAT_MS mà
      // chưa có ảnh, HOẶC chưa từng thấy indicator sau `timeout` (TEXT_ONLY/error tự bắt sớm hơn).
      // Đặt TRƯỚC success-check; chỉ break khi newImageUrls===0 nên không cướp ảnh vừa render.
      if (globalGenerating) {
        genSeenOnce = true;
        lastGenActive = Date.now();
      } else if (newImageUrls.length === 0) {
        if (genSeenOnce) {
          if (Date.now() - lastGenActive > HEARTBEAT_MS) {
            console.warn(`[ChatGPT-detect] Heartbeat: indicator gen tắt > ${HEARTBEAT_MS / 1000}s + chưa có ảnh → stuck, dừng chờ`);
            break;
          }
        } else if (Date.now() - startTime > timeout) {
          console.warn('[ChatGPT-detect] Heartbeat: chưa từng thấy indicator gen sau', timeout, 'ms → dừng chờ');
          break;
        }
      }

      // Trust global fallback CHỈ KHI:
      //   - Có ảnh MỚI (file_id ngoài baseline)
      //   - VÀ KHÔNG còn "Generating image..." indicator (gen đã xong cho ảnh mới)
      if (newImageUrls.length > 0 && !globalGenerating) {
        // Find first NEW Generated image alt (ưu tiên "Generated image..." alt)
        let altText = '';
        for (const img of allGenImgs) {
          if (img.classList.contains('blur-2xl') || !img.src) continue;
          const alt = img.getAttribute('alt') || '';
          // Chỉ lấy alt từ generated images, không phải ref (UUID alt)
          if (!alt.toLowerCase().startsWith('generated image')) continue;
          const m = img.src.match(/[?&]id=(file_[a-z0-9]+)/i);
          if (m && !baselineFileIds.has(m[1])) {
            altText = alt;
            break;
          }
        }
        console.log('[ChatGPT-detect] DONE (global fallback) — NEW urls:', newImageUrls.length, 'baseline cũ:', baselineFileIds.size, 'alt:', altText.slice(0, 60));
        return {
          success: true,
          imageUrls: newImageUrls,
          altPrompt: altText.replace(/^Generated image:\s*/i, ''),
          turnId: null,
        };
      }

      // Chưa có turn mới so với baseline → tiếp tục poll (NHƯNG cũng kiểm tra global Generating)
      if (allTurns.length <= baseline.turnCount) {
        if (Date.now() - lastDiag > 3000) { // throttle 3s (giảm từ 5s) cho debug responsive hơn
          const genState = globalGenerating ? 'GENERATING (global)' : 'idle';
          const url = window.location.pathname;
          // Log URL để detect SPA navigation (vd /c/{id} mới vs /c/{id} cũ)
          console.log('[ChatGPT-detect] Chưa có turn mới — turnCount:', allTurns.length, 'baseline:', baseline.turnCount, 'state:', genState, 'url:', url);
          lastDiag = Date.now();
        }
        await sleep(pollInterval);
        continue;
      }

      // Tìm assistant turn MỚI qua multi-strategy (avoid stale old turn)
      const lastAssistantTurn = findNewAssistantTurn();
      if (!lastAssistantTurn) {
        await sleep(pollInterval);
        continue;
      }

      // 1. Detect error trước (ưu tiên cao)
      const error = detectError(lastAssistantTurn);
      if (error) {
        console.log('[ChatGPT-detect] Error:', error);
        return { success: false, error, message: (lastAssistantTurn.innerText || '').slice(0, 500) };
      }

      // Paragen-multigen: 2 ảnh để user chọn, không có post-action buttons
      // Server-Only: dynamic selectors
      const paragenContainer = _queryWithFallback('paragen_container', null, { scope: lastAssistantTurn, silent: true }) ||
                               _queryWithFallback('paragen_container', null, { silent: true });
      if (paragenContainer) {
        const paragenImgs = Array.from(_queryAllWithFallback('generated_image', null, paragenContainer))
          .filter(img => !img.classList.contains('blur-2xl') && img.src && img.src.startsWith('http'));
        const stillLoadingInParagen = !!_queryWithFallback('generating_indicator', null, { scope: paragenContainer, silent: true });
        if (paragenImgs.length >= 2 && !stillLoadingInParagen) {
          // 2 ảnh đã render xong trong paragen → trust + return success
          const paragenUrls = paragenImgs.map(img => img.src);
          // Dedup by file_id
          const seen = new Set();
          const dedupedUrls = paragenUrls.filter(url => {
            const m = url.match(/[?&]id=(file_[a-z0-9]+)/i);
            const key = m ? m[1] : url;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
          console.log('[ChatGPT-detect] DONE (paragen-multigen) —', dedupedUrls.length, 'ảnh sẵn sàng');
          return {
            success: true,
            imageUrls: dedupedUrls,
            altPrompt: paragenImgs[0]?.alt?.replace(/^Generated image:?\s*/i, '') || '',
            turnId: lastAssistantTurn.dataset.turnId || lastAssistantTurn.dataset.testid || null,
          };
        }
      }

      // 2. Check image đã generated chưa — dùng _findGeneratedImg (có fallback nhiều CDN + alt-based)
      const generatedImg = _findGeneratedImg(lastAssistantTurn);
      let imageUrls = extractImageUrls(lastAssistantTurn);

      // Bug fix: Filter out images that existed BEFORE submit (based on file_id in baseline)
      // This prevents returning old images when findNewAssistantTurn falls back to an old turn
      // Note: baselineFileIds đã khai báo ở đầu while loop (line ~960)
      const preFilterCount = imageUrls.length;
      if (baselineFileIds.size > 0) {
        imageUrls = imageUrls.filter((url) => {
          const m = url.match(/[?&]id=(file_[a-z0-9]+)/i);
          if (!m) return true; // No file_id → can't filter, assume new
          const isOld = baselineFileIds.has(m[1]);
          if (isOld) console.log('[ChatGPT-detect] ⏭️ Filter old/ref image:', m[1]);
          return !isOld;
        });
      }
      if (preFilterCount !== imageUrls.length) {
        console.log('[ChatGPT-detect] 🔍 Baseline filter:', preFilterCount, '→', imageUrls.length, '| baselineIds:', baselineFileIds.size);
      }

      // FAST-PATH: post-action buttons (Like/Edit/Dislike/More actions) chỉ render khi gen XONG.
      // Reference DOM verified (chatgpt-result-image.html). Không cần check streaming khi gặp markers này.
      // Server-Only: dynamic selector (image_action_buttons covers Like/Edit/Dislike)
      const postActionDone = !!_queryWithFallback('image_action_buttons', null, { scope: lastAssistantTurn, silent: true });

      if (generatedImg && imageUrls.length > 0) {
        // Verify alt text — KHÔNG strict (selector đã match alt^="Generated image" nếu fallback path)
        const altText = generatedImg.getAttribute('alt') || '';
        const isGeneratedAlt = altText.toLowerCase().startsWith('generated image');

        // Conditions to trust result:
        // - postActionDone (Like/Edit button present — strongest signal)
        // - HOẶC alt^="Generated image" (alt confirm)
        // - HOẶC URL match (estuary/oaiusercontent) + đã hết streaming
        if (postActionDone || isGeneratedAlt || !isStreaming(lastAssistantTurn)) {
          const turnId = lastAssistantTurn.dataset.turnId || lastAssistantTurn.dataset.testid || null;
          console.log('[ChatGPT-detect] DONE — urls:', imageUrls.length, 'alt:', altText.slice(0, 60), 'postAction:', postActionDone);
          return {
            success: true,
            imageUrls,
            altPrompt: isGeneratedAlt ? altText.replace(/^Generated image:\s*/i, '') : altText,
            turnId,
          };
        }
        // Có img nhưng vẫn streaming → wait tiếp
      }

      // 3. Check streaming còn chạy không
      if (isStreaming(lastAssistantTurn)) {
        // PROACTIVE TEXT_ONLY detection — Server-Only: dynamic selectors
        const hasImageMarker = _hasGeneratingIndicator(lastAssistantTurn) ||
                               !!_queryWithFallback('generated_image', null, { scope: lastAssistantTurn, silent: true }) ||
                               _hasGeneratingIndicator();
        const currentText = (lastAssistantTurn.innerText || '').trim();
        const textLen = currentText.length;

        if (!hasImageMarker && textLen > 50) {
          const elapsedMs = Date.now() - startTime;
          const hasPositive = hasPositiveIndicator(currentText);

          // SKIP pattern check nếu: có positive indicator + chưa đủ thời gian
          // (ChatGPT có thể nói "Sure, I'll create..." trước khi hiện Generating indicator)
          // Bug fix: Nếu có positive indicator, chờ lâu hơn (10s) vì ChatGPT placeholder
          // có thể dài >150 chars nhưng vẫn đang chuẩn bị gen ảnh.
          const waitThreshold = hasPositive ? MIN_WAIT_WITH_POSITIVE_MS : MIN_WAIT_BEFORE_PATTERN_CHECK_MS;
          const shouldCheckPatterns = elapsedMs > waitThreshold;

          if (shouldCheckPatterns) {
            // FAST DETECTION 1: Check error patterns (rateLimit, contentBlocked, imageGenFailed)
            const errorMatch = matchesAnyErrorPattern(currentText);
            if (errorMatch) {
              console.log('[ChatGPT-detect]', errorMatch.error, '(pattern match):', currentText.slice(0, 100));
              return { success: false, error: errorMatch.error, text: errorMatch.text };
            }

            // FAST DETECTION 2: Check TEXT_ONLY pattern
            if (matchesTextOnlyPattern(currentText)) {
              // Re-check generating indicator trước khi return (race condition)
              // Server-Only: dynamic selectors
              const recheckMarker = _hasGeneratingIndicator(lastAssistantTurn) ||
                                    !!_queryWithFallback('generated_image', null, { scope: lastAssistantTurn, silent: true }) ||
                                    _hasGeneratingIndicator();
              if (recheckMarker) {
                console.log('[ChatGPT-detect] TEXT_ONLY avoided — generating indicator xuất hiện sau text');
                // Reset và tiếp tục poll
              } else {
                console.log('[ChatGPT-detect] TEXT_ONLY (pattern match):', currentText.slice(0, 100));
                return { success: false, error: 'TEXT_ONLY', text: currentText.slice(0, 500) };
              }
            }
          }

          // FALLBACK: Chờ threshold nếu pattern không match nhưng text dài + ko có image marker
          if (!textOnlyStreamStart) {
            textOnlyStreamStart = Date.now();
            console.log('[ChatGPT-detect] TEXT_ONLY tracking started — textLen:', textLen, 'hasPositive:', hasPositive);
          } else if (Date.now() - textOnlyStreamStart > TEXT_ONLY_THRESHOLD_MS) {
            // Final scan — image marker có thể vừa xuất hiện (race condition)
            // Server-Only: dynamic selectors
            const finalImg = _queryWithFallback('generated_image', null, { scope: lastAssistantTurn, silent: true }) ||
                             _queryWithFallback('generated_image', null, { silent: true }) ||
                             _queryWithFallback('generating_indicator', null, { scope: lastAssistantTurn, silent: true }) ||
                             _queryWithFallback('generating_indicator', null, { silent: true });
            if (finalImg) {
              console.log('[ChatGPT-detect] TEXT_ONLY false positive avoided — image marker xuất hiện:', finalImg.tagName);
              textOnlyStreamStart = null;
              await sleep(pollInterval);
              continue;
            }
            console.log('[ChatGPT-detect] TEXT_ONLY (timeout) — streaming text >' + (TEXT_ONLY_THRESHOLD_MS / 1000) + 's, no image marker:', currentText.slice(0, 100));
            return { success: false, error: 'TEXT_ONLY', text: currentText.slice(0, 500) };
          }
        } else if (hasImageMarker) {
          textOnlyStreamStart = null;
        }

        if (Date.now() - lastDiag > 5000) {
          console.log('[ChatGPT-detect] Streaming, hasImg:', !!generatedImg, 'textOnlyTracking:', !!textOnlyStreamStart);
          lastDiag = Date.now();
        }
        await sleep(pollInterval);
        continue;
      }

      // 4. Turn complete nhưng không có image → check pending img hoặc TEXT_ONLY
      // Server-Only: dynamic generated_image selector
      const pendingGenImg = _queryWithFallback('generated_image', null, { scope: lastAssistantTurn, silent: true }) ||
                            _queryWithFallback('generated_image', null, { silent: true });
      const imgPending = pendingGenImg && (!pendingGenImg.src || pendingGenImg.classList.contains('blur-2xl'));
      if (imgPending) {
        postCompleteTextOnlyStart = null; // Reset grace period — image đang load
        if (Date.now() - lastDiag > 3000) {
          const reason = !pendingGenImg.src ? 'src loading' : 'blur-2xl transition';
          console.log('[ChatGPT-detect] Pending img (' + reason + '):', pendingGenImg.alt?.slice(0, 40));
          lastDiag = Date.now();
        }
        await sleep(pollInterval);
        continue;
      }

      const text = (lastAssistantTurn.innerText || '').trim();
      if (text.length > 20) {
        // Check error patterns trước (rateLimit, contentBlocked, imageGenFailed)
        const errorMatch = matchesAnyErrorPattern(text);
        if (errorMatch) {
          console.log('[ChatGPT-detect]', errorMatch.error, '(post-complete):', text.slice(0, 100));
          return { success: false, error: errorMatch.error, text: errorMatch.text };
        }

        // Global fallback — check image render trước khi return TEXT_ONLY
        // Server-Only: dynamic generated_image selector
        const globalGenImg = _queryWithFallback('generated_image', null, { silent: true });
        if (globalGenImg && globalGenImg.src && !globalGenImg.classList.contains('blur-2xl')) {
          const fileIdMatch = globalGenImg.src.match(/[?&]id=(file_[a-z0-9]+)/i);
          const fileId = fileIdMatch?.[1];
          const isNewImage = !fileId || !baselineFileIds.has(fileId);
          if (isNewImage) {
            console.log('[ChatGPT-detect] TEXT_ONLY avoided via global fallback — found new image:', globalGenImg.alt?.slice(0, 50));
            postCompleteTextOnlyStart = null; // Reset grace period
            // Continue polling to let the normal success path handle extraction
            await sleep(pollInterval);
            continue;
          }
        }

        // Also check generating indicator globally — image still being generated
        if (_hasGeneratingIndicator()) {
          console.log('[ChatGPT-detect] TEXT_ONLY avoided — global generating indicator present');
          postCompleteTextOnlyStart = null; // Reset grace period
          await sleep(pollInterval);
          continue;
        }

        // Grace period — chờ DOM kịp update image render
        if (!postCompleteTextOnlyStart) {
          postCompleteTextOnlyStart = Date.now();
          console.log('[ChatGPT-detect] TEXT_ONLY grace period started — waiting for potential late image render');
        }

        if (Date.now() - postCompleteTextOnlyStart < POST_COMPLETE_GRACE_MS) {
          // Final comprehensive scan giống với global fallback ở đầu loop
          const allGenImgsGrace = _queryAllWithFallback('generated_image');
          let foundNewImageInGrace = false;
          for (const img of allGenImgsGrace) {
            if (img.classList.contains('blur-2xl') || !img.src) continue;
            const alt = img.getAttribute('alt') || '';
            const isGenerated = alt.toLowerCase().startsWith('generated image');
            const isSibling = alt === '';
            if (!isGenerated && !isSibling) continue;
            const m = img.src.match(/[?&]id=(file_[a-z0-9]+)/i);
            if (!m) continue;
            if (baselineFileIds.has(m[1])) continue;
            // Found new image during grace period!
            console.log('[ChatGPT-detect] TEXT_ONLY avoided during grace period — found new image:', alt.slice(0, 50));
            postCompleteTextOnlyStart = null;
            foundNewImageInGrace = true;
            break;
          }
          if (foundNewImageInGrace) {
            await sleep(pollInterval);
            continue;
          }
          // No image found yet, continue polling within grace period
          await sleep(pollInterval);
          continue;
        }

        // Grace period exhausted, truly TEXT_ONLY
        console.log('[ChatGPT-detect] TEXT_ONLY (post-complete) after', POST_COMPLETE_GRACE_MS, 'ms grace:', text.slice(0, 100));
        return { success: false, error: 'TEXT_ONLY', text: text.slice(0, 500) };
      }

      await sleep(pollInterval);
    }

    // Timeout grace: nếu có image marker → extend chờ render xong.
    // Dùng cdn_image (src-based) để hasPendingImage=true cả khi alt chưa set (vào grace re-check).
    // Grace dùng isRealGen lọc ref nên vào grace vì ref cũng vô hại (sẽ bail nếu không có generated thật).
    const finalImg = _queryCdnImages(document).length > 0;
    const finalLoadingIndicator = _hasGeneratingIndicator();
    const hasPendingImage = !!(finalImg || finalLoadingIndicator);
    if (hasPendingImage) {
      console.warn('[ChatGPT-detect] TIMEOUT sau', timeout, 'ms — có image marker → extend grace động (cap 240s, gen ảnh chậm)');
      const graceMaxDeadline = Date.now() + 240000; // cap 240s — chờ ChatGPT gen ảnh chậm
      let postGenGraceStart = null; // mốc indicator tắt — chờ ảnh render trễ trước khi bail
      while (Date.now() < graceMaxDeadline) {
        if (isAbortActive()) {
          await clickChatGPTStopButton();
          return { success: false, error: 'ABORTED', message: 'User stopped during grace' };
        }
        // Re-check image — Server-Only: dynamic selector.
        // Bug fix 2026-05-27: selector generated_image có img[src*="/backend-api/"] match CẢ ref images
        // (ref cũng src backend-api, không aria-hidden) → grace cũ (chỉ lọc blur+http) trả NHẦM 2 ref
        // images của upstream image nodes thành "kết quả". Lọc: chỉ ảnh generated thật (alt^="Generated
        // image" hoặc alt="" sibling — LOẠI ref alt=UUID) + loại ảnh cũ trong baseline.
        const baseIds = baseline.existingImageFileIds || new Set();
        const isRealGen = (img) => {
          if (img.classList.contains('blur-2xl') || !img.src?.startsWith('http')) return false;
          const a = img.getAttribute('alt') || '';
          if (!(a.toLowerCase().startsWith('generated image') || a === '')) return false; // loại ref (alt=UUID)
          const m = img.src.match(/[?&]id=(file_[a-z0-9]+)/i);
          if (m && baseIds.has(m[1])) return false; // loại ảnh cũ / ref đã có trước submit
          return true;
        };
        const genImgs = Array.from(_queryCdnImages(document)).filter(isRealGen);
        if (genImgs.length > 0) {
          console.log('[ChatGPT-detect] Image rendered trong grace period:', genImgs[0].src.slice(0, 80));
          const dedup = [...new Map(genImgs.map(img => {
            const m = img.src.match(/[?&]id=(file_[a-z0-9]+)/i);
            return [m ? m[1] : img.src, img.src];
          })).values()];
          return {
            success: true,
            imageUrls: dedup,
            altPrompt: genImgs[0].alt?.replace(/^Generated image:\s*/i, '') || '',
            turnId: null,
          };
        }
        // Bug fix 2026-05-27: KHÔNG bail NGAY khi indicator tắt. ChatGPT gen xong (indicator tắt)
        // nhưng asset ảnh render vào DOM TRỄ vài giây → bail ngay → miss ảnh → timeout-oan dù gen OK
        // (xác nhận page-log: "ngừng generate, không có ảnh" rồi ảnh hiện sau). Chờ thêm 10s sau khi
        // indicator tắt cho ảnh render (genImgs re-check mỗi vòng 2s sẽ bắt được nếu ảnh kịp render).
        if (!_hasGeneratingIndicator()) {
          if (!postGenGraceStart) {
            postGenGraceStart = Date.now();
          } else if (Date.now() - postGenGraceStart > 10000) {
            console.warn('[ChatGPT-detect] Grace: indicator tắt + không có ảnh sau 10s → kết thúc');
            return { success: false, error: 'TIMEOUT', hasPendingImage: false };
          }
        } else {
          postGenGraceStart = null; // còn generating → reset đồng hồ chờ post-gen
        }
        await sleep(2000);
      }
      console.warn('[ChatGPT-detect] TIMEOUT sau grace 240s — image vẫn pending, return với hasPendingImage hint');
      return { success: false, error: 'TIMEOUT', hasPendingImage: true };
    }

    console.warn('[ChatGPT-detect] TIMEOUT sau', timeout, 'ms — không có image marker');
    return { success: false, error: 'TIMEOUT', hasPendingImage: false };
  }

  // Main handler — giữ NGUYÊN logic Phase X (ChatAIModal) + thêm các listener CG-2/CG-3.
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // SSE invalidate: admin update DOM selector → clear cache để query fresh
    if (message.action === 'providerConfigUpdated') {
      _selectorConfig = null;
      _selectorConfigTime = 0;
      console.log('[ChatGPT] Provider config updated via SSE — selector cache invalidated');
      sendResponse({ success: true });
      return false;
    }

    // chatAI:execute — ChatAIModal flow
    if (message.action === 'chatAI:execute') {
      (async () => {
        try {
          // 1. Upload images first (if any)
          if (message.images && message.images.length > 0) {
            const uploaded = await uploadImages(message.images);
            if (!uploaded) {
              sendResponse({ success: false, error: 'Không thể upload ảnh lên ChatGPT' });
              return;
            }
          }

          // 2. Insert text
          const textInserted = await insertText(message.text);
          if (!textInserted) {
            sendResponse({ success: false, error: 'Không thể nhập text vào ChatGPT' });
            return;
          }

          // 3. Submit
          const submitted = await clickSubmit();
          if (!submitted) {
            sendResponse({ success: false, error: 'Không thể gửi tin nhắn trên ChatGPT' });
            return;
          }

          sendResponse({ success: true });
        } catch (err) {
          sendResponse({ success: false, error: err.message || 'Lỗi không xác định' });
        }
      })();

      return true; // async sendResponse
    }

    // chatgpt:submitAndWait — submit prompt + chờ kết quả (image/text mode)
    if (message.action === 'chatgpt:submitAndWait') {
      // Timestamp-guarded reset — chỉ wipe stale abort > 5s
      __chatgptCallStartAt = Date.now();
      if (__chatgptAbort && __chatgptAbortAt < __chatgptCallStartAt - 5000) {
        __chatgptAbort = false;
        __chatgptAbortAt = 0;
      }
      // Set inputTimeoutMs từ payload (Adapter pass từ user setting). Default 1200 nếu không có.
      // Macro delay giữa các bước chính = 70% inputTimeoutMs.
      __chatgptInputTimeoutMs = Number(message.inputTimeoutMs) || 1200;
      __chatgptMacroDelayMs = Math.round(__chatgptInputTimeoutMs * 0.7);
      console.log('[ChatGPT] Timing — inputTimeout:', __chatgptInputTimeoutMs, 'ms | macroDelay:', __chatgptMacroDelayMs, 'ms (70%)');

      const isTextMode =
        message.expectText === true || message.settings?.imageMode === false;
      console.log(
        '[ChatGPT-listener] chatgpt:submitAndWait nhận, mode:', isTextMode ? 'text' : 'image',
        'text len:', (message.text || '').length,
        'images:', (message.images || []).length,
      );

      // Show FloatingTracker và ExecutionBlocker
      const promptPreview = (message.text || '').substring(0, 50);
      FloatingTracker.show({ current: 0, total: 1, phase: _i18n.t('preparing'), prompt: promptPreview });
      ExecutionBlocker.show();

      (async () => {
        try {
          // PRE-CHECK: Cloudflare/OpenAI challenge — tab inactive → challenge stuck → DOM ops fail silent.
          if (detectChatGPTChallenge()) {
            FloatingTracker.update({ phase: _i18n.t('waitingVerification') });
            const resolved = await waitForChatGPTChallengeResolved(120000);
            if (!resolved) {
              FloatingTracker.hide();
              ExecutionBlocker.hide();
              sendResponse({
                success: false,
                error: 'CHALLENGE_TIMEOUT',
                message: 'ChatGPT yêu cầu xác minh. Vui lòng mở tab ChatGPT, hoàn thành verification, sau đó chạy lại.',
              });
              return;
            }
          }
          checkAbort('after-challenge-check');

          // NEW CHAT: Skip clickNewChatAndWaitReady — ensureTabActive đã navigate về homepage.
          // Homepage https://chatgpt.com/ = new chat + fresh UI state (fix ChatGPT bugs).
          // Chỉ cần verify đang ở homepage trước khi tiếp tục.
          const shouldNewChat = !isTextMode && (message.settings?.newChat !== false);
          if (shouldNewChat) {
            const currentPath = window.location.pathname;
            if (currentPath === '/' || currentPath === '') {
              console.log('[ChatGPT] Already at homepage (new chat) — skipping clickNewChatAndWaitReady');
            } else {
              // Fallback: nếu chưa ở homepage, thử click new chat button
              console.log('[ChatGPT] Not at homepage, trying clickNewChatAndWaitReady...');
              const newChatReady = await clickNewChatAndWaitReady(8000);
              if (!newChatReady) {
                console.warn('[ChatGPT] New chat không ready — tiếp tục với conversation hiện tại');
              }
            }
            checkAbort('after-new-chat');
            await sleep(getMacroDelay());  // Macro gap → upload refs
          }

          // PRE-CHECK: Detect image creation limit alert — chỉ áp dụng khi đang ở image mode.
          // Text mode (Prompt node) không liên quan đến image quota → bỏ qua check.
          if (!isTextMode) {
            const limitAlert = checkImageLimitAlert();
            if (limitAlert?.detected) {
              console.warn('[ChatGPT-listener] LIMIT_ALERT detected — bỏ qua submit:', limitAlert.message);
              FloatingTracker.hide();
              ExecutionBlocker.hide();
              sendResponse({
                success: false,
                error: 'LIMIT_ALERT',
                message: limitAlert.message,
              });
              return;
            }
          }

          // 1. CRITICAL FIX: Chờ hoàn tất generation đang chạy (nếu có) TRƯỚC khi capture baseline.
          // Bug: Task A gen ảnh → Task B submit → baseline capture khi A đang gen → A xong trước B
          // → B's waitForImageResult thấy ảnh A là "mới" (không trong baseline) → trả về ảnh SAI!
          // Fix: Đợi generating indicator biến mất trước khi capture baseline.
          const existingGenIndicator = _hasGeneratingIndicator();
          if (existingGenIndicator) {
            console.log('[ChatGPT] Đang có image generation từ task trước — chờ hoàn tất...');
            const maxWaitGen = 120000; // 2 phút max
            const startWaitGen = Date.now();
            while (Date.now() - startWaitGen < maxWaitGen) {
              if (isAbortActive()) {
                FloatingTracker.hide();
                ExecutionBlocker.hide();
                sendResponse({ success: false, error: 'ABORTED', message: 'User stopped' });
                return;
              }
              const stillGen = _hasGeneratingIndicator();
              if (!stillGen) {
                console.log('[ChatGPT] Generation trước đã hoàn tất — tiếp tục submit task mới');
                break;
              }
              await sleep(1000);
            }
            // Sau khi gen trước xong, sleep thêm để DOM update file_id
            await sleep(500);
          }

          // 2. Snapshot baseline TRƯỚC khi submit (sau khi đã chờ gen cũ xong)
          const baseline = snapshotConversationState();

          // 3. Quyết định text submit + cleanup mode
          //    - Image mode: nếu image mode active thì giữ nguyên, ngược lại fallback prefix.
          //    - Text mode: deactivate image mode (sticky) + prepend prefix bắt LLM trả plain prompt.
          let textToSubmit = message.text || '';
          if (isTextMode) {
            // Bug fix: ChatGPT image mode sticky → Prompt enhance gọi text mà image mode vẫn ON
            // → response có thể trả về image hoặc reply dài dòng. Force toggle off TRƯỚC khi submit.
            try { await deactivateImageModeIfActive(); } catch (e) {
              console.warn('[ChatGPT] deactivateImageMode error:', e?.message);
            }
            // Prefix bắt LLM trả plain prompt text — theo ngôn ngữ user setting (fallback EN).
            const enhancePrefix = await getEnhancePrefix();
            textToSubmit = enhancePrefix + textToSubmit;
          }

          // 3b. Upload ref images TRƯỚC, activate image mode SAU.
          // Verified 2026-05-09 (user feedback): ChatGPT KHÔNG yêu cầu image mode active để upload.
          // Trước đây code activate 2 lần (trước upload + sau upload re-activate) — DƯ THỪA.
          // Flow tối ưu: upload trước (clean DOM) → activate 1 lần sau → submit.
          // Lý do: activate trước upload làm upload reset state → cần re-activate → tốn 2 cycle.
          //         Activate sau upload thì state stable, chỉ cần 1 cycle.
          //
          // CRITICAL: GỌI removeExistingChatGPTRefImages() ngay cả khi task không có refs —
          // bug fix: refs cũ từ session trước còn dính trong composer → submit kéo theo context sai.
          await removeExistingChatGPTRefImages();
          await sleep(200);
          checkAbort('after-remove-refs');

          if (Array.isArray(message.images) && message.images.length > 0) {
            const uploaded = await injectRefImages(message.images);
            if (!uploaded) {
              sendResponse({
                success: false,
                error: 'REF_UPLOAD_FAILED',
                message: 'Không thể upload ref image lên ChatGPT',
              });
              return;
            }
            checkAbort('after-upload-refs');
            // Giảm delay để click ratio trong lúc upload progress chưa hoàn toàn settle
            // (ChatGPT UI: click ratio khi có file uploading = open dropdown, sau khi settle = toggle off)
            await sleep(150);
          }

          // 4a. Chọn model GPT-5.5 (Instant/Thinking) TRƯỚC khi activate image mode.
          // CRITICAL (bug fix 2026-05-27): đổi model RESET tools composer (xóa "Create image") → nếu
          // chọn model SAU image mode → mất image mode → submit thành TEXT gen (log: total:0). Phải
          // chọn model trước → activateImageMode là bước CUỐI trước submit → image mode survive.
          if (!isTextMode && message.settings?.model) {
            await selectChatGPTModel(message.settings.model);
            checkAbort('after-select-model');
            await sleep(getMacroDelay());
          }

          // 4. ACTIVATE IMAGE MODE + RATIO (1 lần duy nhất, sau model + upload refs).
          if (!isTextMode && message.settings?.imageMode) {
            const ratio = message.settings?.ratio || '1:1';
            console.log('[ChatGPT] Activating image mode với ratio:', ratio);
            const activated = await activateImageMode(ratio);
            if (!activated) {
              console.warn('[ChatGPT] Không thể activate image mode — sẽ dùng fallback prefix');
              if (message.settings?.fallbackPrefix) {
                textToSubmit = message.settings.fallbackPrefix + textToSubmit;
              }
            }
            checkAbort('after-activate-image-mode');
            await sleep(getMacroDelay());  // Macro gap activate → injectTextAndSubmit (clear+insert+submit)
          }

          // 5. Inject text + click submit
          await injectTextAndSubmit(textToSubmit);

          // 6. Chờ kết quả — branch theo mode.
          checkAbort('before-wait-result');
          FloatingTracker.update({ current: 1, total: 1, phase: _i18n.t('waitingResult'), prompt: promptPreview });
          const timeout = message.timeout || (isTextMode ? 60000 : 300000); // image fallback 120s→300s (gen nhiều ref chậm)
          const result = isTextMode
            ? await waitForTextResult(baseline, timeout)
            : await waitForImageResult(baseline, timeout);

          FloatingTracker.hide();
          ExecutionBlocker.hide();
          sendResponse(result);
        } catch (err) {
          FloatingTracker.hide();
          ExecutionBlocker.hide();
          // Bug fix 2026-05-09: catch ABORT throws → click ChatGPT Stop button để halt backend gen
          if (err.message && err.message.startsWith('ABORTED')) {
            const stage = err.message.replace('ABORTED:', '');
            console.log('[ChatGPT] Caught ABORT at stage:', stage, '→ clicking Stop button');
            await clickChatGPTStopButton();
            sendResponse({
              success: false,
              error: 'ABORTED',
              message: 'User stopped at ' + stage,
            });
            return;
          }
          sendResponse({
            success: false,
            error: 'EXCEPTION',
            message: err.message || 'Lỗi không xác định',
          });
        }
      })();

      return true; // async sendResponse
    }

    // chatgpt:abort — Set abort flag để các hàm wait/poll exit sớm
    if (message.action === 'chatgpt:abort') {
      __chatgptAbort = true;
      __chatgptAbortAt = Date.now();
      console.log('[ChatGPT-listener] chatgpt:abort received → set abort flag at', __chatgptAbortAt);
      // Hide trackers immediately
      FloatingTracker.hide();
      ExecutionBlocker.hide();
      sendResponse({ success: true });
      return false;
    }

    // chatgpt:deleteLastMessage — Xóa tin nhắn assistant gần nhất (2026-05-16)
    // Triggered after successful generation when setting `chatgpt_delete_after_gen` is enabled.
    if (message.action === 'chatgpt:deleteLastMessage') {
      (async () => {
        try {
          const success = await deleteLastAssistantMessage();
          sendResponse({ success });
        } catch (err) {
          console.error('[ChatGPT-listener] deleteLastMessage error:', err);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true; // async sendResponse
    }

    // Không xử lý các action khác trong listener này
    return false;
  });

  // Theo dõi navigate sang conversation mới (SPA pushState)
  let _lastUrl = location.href;
  const _notifyNavigate = () => {
    if (location.href !== _lastUrl) {
      _lastUrl = location.href;
      try {
        chrome.runtime.sendMessage({ action: 'chatgpt:navigated', url: location.href }).catch(() => {});
      } catch (e) {
        // Bỏ qua nếu runtime mất kết nối
      }
    }
  };

  // Hook pushState/replaceState để bắt SPA navigation
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

  console.log('[ChatAI] Content script ChatGPT đã được inject (Phase X + CG-2 + CG-3)');
})();
