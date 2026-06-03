(function() {
  // Guard against double injection
  if (window._chatAIGeminiInjected) return;
  window._chatAIGeminiInjected = true;

  // Helper: sleep
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // ============ Dynamic Selector System (DOM Resilience) ============
  // Priority: Backend config only (Server-Only)
  const PROVIDER = 'gemini';
  let _selectorConfig = null;
  let _selectorConfigTime = 0;
  const _SELECTOR_CACHE_TTL = 30000; // 30s

  // Phase 6 Bug P (2026-06-03): Strict Server-Only — NO hardcoded _FALLBACK_SELECTORS.
  const _SELECTOR_WAIT_MAX_MS = 10000;
  const _SELECTOR_WAIT_INTERVAL_MS = 200;

  // Overlay i18n (4 locales — reuse sidebar wording `dialog.offline` family).
  const _OVERLAY_I18N = {
    vi: { title: 'Mất kết nối Internet', desc: 'Vui lòng kiểm tra lại kết nối mạng của bạn để tiếp tục sử dụng.', retry: 'Thử lại' },
    en: { title: 'No Internet Connection', desc: 'Please check your network connection to continue.', retry: 'Retry' },
    ja: { title: 'インターネット接続なし', desc: 'ネットワーク接続を確認してから再度お試しください。', retry: '再試行' },
    th: { title: 'ไม่มีการเชื่อมต่ออินเทอร์เน็ต', desc: 'กรุณาตรวจสอบการเชื่อมต่อเครือข่ายเพื่อใช้งานต่อ', retry: 'ลองอีกครั้ง' },
  };
  let _overlayLocale = 'vi';
  chrome.storage.local.get(['af_locale', 'af_settings'], (r) => {
    _overlayLocale = r.af_locale || (r.af_settings && r.af_settings.language) || 'vi';
  });

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
    const lang = _overlayLocale || 'vi';
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

  // Anti-clone overlay — hiển thị khi background broadcast EXTENSION_NOT_AUTHORIZED.
  function _showCloneDetectedOverlay() { return;
    if (document.getElementById('tobyflow-clone-detected-overlay')) return;
    const _lang = _overlayLocale || 'vi';
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

  function _queryWithFallback(key, defaultSelectors = null) {
    const config = _getDynamicSelector(key);
    const hardcoded = defaultSelectors || []; // Phase 6 Bug P: _FALLBACK_SELECTORS removed
    const isDynamic = config?.selectors?.length > 0;
    const selectors = isDynamic ? config.selectors : hardcoded;

    console.log(`[Selector:${PROVIDER}:${key}] ${isDynamic ? '🌐 DYNAMIC' : '📦 HARDCODED'} | Trying ${selectors.length} selectors`);

    for (let i = 0; i < selectors.length; i++) {
      try {
        const el = document.querySelector(selectors[i]);
        if (el) {
          console.log(`[Selector:${PROVIDER}:${key}] ✅ Match #${i + 1}: ${selectors[i]}`);
          return el;
        }
      } catch (e) { /* invalid selector */ }
    }
    console.log(`[Selector:${PROVIDER}:${key}] ❌ No match`);
    return null;
  }

  function _queryAllWithFallback(key, defaultSelectors = null) {
    const config = _getDynamicSelector(key);
    const hardcoded = defaultSelectors || []; // Phase 6 Bug P: _FALLBACK_SELECTORS removed
    const selectors = config?.selectors?.length > 0 ? config.selectors : hardcoded;

    for (let i = 0; i < selectors.length; i++) {
      try {
        const els = document.querySelectorAll(selectors[i]);
        if (els.length > 0) return els;
      } catch (e) { /* invalid selector */ }
    }
    return [];
  }

  // AI Agent prefix — Server-Only (2026-05-30 refactor).
  // Đọc từ PCM cache `chrome.storage.local.toby_provider_api_configs.data.gemini.configs.ai_agent_prefix.{locale}`.
  // Admin edit qua /admin/providers/gemini/api-configs → SSE broadcast → next submit dùng prefix mới.
  // Fallback: locale missing → EN. Config missing → '' (skip prefix wrap, submit raw prompt).
  async function getEnhancePrefix() {
    try {
      const result = await new Promise(resolve => {
        chrome.storage.local.get(['toby_provider_api_configs', 'af_locale'], r => resolve(r));
      });
      const locale = result?.af_locale || 'en';
      const prefixMap = result?.toby_provider_api_configs?.data?.gemini?.configs?.ai_agent_prefix;
      if (!prefixMap || typeof prefixMap !== 'object') {
        console.warn('[AI Agent] ai_agent_prefix config missing for gemini — skip prefix wrap (raw prompt)');
        return '';
      }
      return prefixMap[locale] || prefixMap.en || '';
    } catch (e) {
      console.warn('[AI Agent] getEnhancePrefix error:', e.message, '— skip prefix wrap');
      return '';
    }
  }

  // ============ Cloudflare/Google challenge detection ============
  // Defensive — Gemini hiếm khi có turnstile nhưng thêm để an toàn khi tab inactive.
  function detectGeminiChallenge() {
    // Dùng dynamic selector cho cloudflare iframe
    if (_queryWithFallback('cloudflare_iframe')) return true;
    if (_queryWithFallback('cloudflare_iframe', null)) return true;
    const overlays = document.querySelectorAll('div[role="dialog"], body > div');
    for (const el of overlays) {
      const txt = (el.innerText || '').toLowerCase();
      if (txt.includes("making sure you're human") ||
          txt.includes('verify you are human') ||
          (txt.includes('verifying') && txt.includes('cloudflare'))) {
        const style = window.getComputedStyle(el);
        if (style.display !== 'none' && style.visibility !== 'hidden') return true;
      }
    }
    return false;
  }

  async function waitForGeminiChallengeResolved(timeoutMs = 120000) {
    if (!detectGeminiChallenge()) return true;
    console.warn('[Gemini] Challenge detected — request tab activate + chờ user verify');
    try {
      await new Promise((resolve) => {
        chrome.runtime.sendMessage(
          { action: 'gemini:ensureActive', focusWindow: true, reason: 'challenge' },
          () => resolve()
        );
      });
    } catch (_) {}
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (!detectGeminiChallenge()) {
        await sleep(800);
        return true;
      }
      await sleep(800);
    }
    return false;
  }

  // Helper: simulateClick (full pointer event chain for Angular compatibility)
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

  // ============ Delete current conversation (2026-05-29) ============
  // Flow: Click conversation actions menu → Click Delete → Confirm "Xoá" in mat-dialog
  // DOM ref: data/dom/gemini-delete-message-com.html
  // Strict Server-Only: TẤT CẢ selectors đọc từ provider_configs.dom_selector qua _queryWithFallback.
  // 4 keys (seeded migration 2026_07_06_100002):
  //   conversation_actions_menu, delete_menu_item, delete_confirm_dialog, delete_confirm_button
  async function deleteCurrentConversation() {
    try {
      // 1. Find conversation actions menu button
      const actionsBtn = _queryWithFallback('conversation_actions_menu');
      if (!actionsBtn) {
        console.warn('[Gemini-delete] conversation_actions_menu selector không match — sidebar collapsed hoặc DOM changed');
        return false;
      }

      // 2. Click để mở context menu
      console.log('[Gemini-delete] Clicking actions menu button...');
      simulateClick(actionsBtn);
      await sleep(500);

      // 3. Wait for menu panel + tìm Delete item
      let deleteItem = null;
      const menuTimeout = Date.now() + 3000;
      while (Date.now() < menuTimeout) {
        deleteItem = _queryWithFallback('delete_menu_item');
        if (deleteItem) break;
        await sleep(200);
      }

      if (!deleteItem) {
        console.warn('[Gemini-delete] delete_menu_item selector không match');
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        return false;
      }

      console.log('[Gemini-delete] Clicking Delete menu item...');
      simulateClick(deleteItem);
      await sleep(500);

      // 4. Confirm dialog: tìm dialog container + button "Xoá"/"Delete" qua text match
      // (text match là pattern chuẩn cho confirm buttons — không phải CSS selector,
      // dialog selector từ server xác định container, button text match trong container).
      const confirmTimeout = Date.now() + 3000;
      let confirmBtn = null;
      while (Date.now() < confirmTimeout) {
        const dialog = _queryWithFallback('delete_confirm_dialog');
        if (dialog) {
          // Ưu tiên CSS selector từ delete_confirm_button trước
          const btnViaSelector = _queryWithFallback('delete_confirm_button', null);
          if (btnViaSelector && dialog.contains(btnViaSelector)) {
            const text = (btnViaSelector.textContent || '').trim().toLowerCase();
            if (text === 'xoá' || text === 'xóa' || text === 'delete' || text === 'remove') {
              confirmBtn = btnViaSelector;
              break;
            }
          }
          // Fallback: scan all buttons trong dialog, match text Xoá/Delete
          const buttons = dialog.querySelectorAll('button');
          for (const btn of buttons) {
            const text = (btn.textContent || '').trim().toLowerCase();
            if (text === 'xoá' || text === 'xóa' || text === 'delete' || text === 'remove') {
              confirmBtn = btn;
              break;
            }
          }
        }
        if (confirmBtn) break;
        await sleep(200);
      }

      if (!confirmBtn) {
        console.warn('[Gemini-delete] delete_confirm_dialog/button không match hoặc không có button text Xoá/Delete');
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        return false;
      }

      console.log('[Gemini-delete] Clicking confirm button...');
      simulateClick(confirmBtn);
      await sleep(500);

      console.log('[Gemini-delete] ✅ Đã xóa conversation thành công');
      return true;
    } catch (err) {
      console.error('[Gemini-delete] Lỗi khi xóa conversation:', err);
      return false;
    }
  }

  // Upload images via file input (Gemini 2025 UI)
  async function uploadImages(images) {
    if (!images || images.length === 0) return true;

    // Convert base64 to File objects
    const files = images.map(img => {
      const binary = atob(img.base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return new File([bytes], img.name || 'image.png', { type: img.type || 'image/png' });
    });

    console.log('[ChatAI] Gemini: Bắt đầu upload', files.length, 'ảnh');

    // Gemini KHÔNG có <input type="file"> trong DOM (verified 2026-05-17). Upload flow chính:
    //   - Click `add_button` (.upload-card-button) → menu hiện
    //   - Click menu item "Tải hình ảnh lên" → browser file dialog (cần user gesture, ext KHÔNG tự động được)
    // → Extension dùng paste (Method 1) hoặc drag & drop event (Method 2) làm path chính.
    //
    // Best-effort: vẫn click add_button để mở menu cho user thấy, nhưng KHÔNG đợi file_input.
    const attachBtn = _queryWithFallback('add_button');
    if (attachBtn) {
      console.log('[ChatAI] Gemini: Click add_button để mở upload menu (best-effort, user thấy menu)');
      simulateClick(attachBtn);
      await sleep(500);
      // Đóng menu lại để không cản drag/drop
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await sleep(200);
    }

    // Method 1: Fallback - paste qua clipboard (dùng dynamic selector cho composer)
    console.log('[ChatAI] Gemini: Thử paste qua clipboard');
    const editor = _queryWithFallback('composer') || document.activeElement;

    if (editor) {
      editor.focus();
      await sleep(200);

      // Tạo ClipboardEvent với files
      const dt = new DataTransfer();
      files.forEach(f => dt.items.add(f));

      const pasteEvent = new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: dt
      });

      editor.dispatchEvent(pasteEvent);
      await sleep(2000);

      // Check lại preview (dynamic selector)
      const hasPreview = _queryWithFallback('image_preview');
      if (hasPreview) {
        console.log('[ChatAI] Gemini: Upload thành công via paste');
        return true;
      }
    }

    // Method 2: Drag & drop (Strict Server-Only: composer → input_area_container → body) — primary path.
    console.log('[ChatAI] Gemini: Thử drag & drop');
    const dropTarget = _queryWithFallback('composer') ||
                       _queryWithFallback('input_area_container') ||
                       document.body;

    if (dropTarget) {
      const dt = new DataTransfer();
      files.forEach(f => dt.items.add(f));

      dropTarget.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer: dt }));
      await sleep(100);
      dropTarget.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
      await sleep(100);
      dropTarget.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
      await sleep(2000);

      // Dynamic selector for image preview
      const hasPreview = _queryWithFallback('image_preview');
      if (hasPreview) {
        console.log('[ChatAI] Gemini: Upload thành công via drag & drop');
        return true;
      }
    }

    console.error('[ChatAI] Không thể upload ảnh lên Gemini - vui lòng upload thủ công');
    // Trả về true để tiếp tục gửi text (user có thể tự paste ảnh)
    return true;
  }

  // Insert text into Gemini editor
  // IMPORTANT: Không được xóa content hiện có (ảnh upload) và không dispatch InputEvent với insertText
  // để tránh trigger Gemini auto-submit
  async function insertText(text) {
    console.log('[ChatAI] Gemini: Nhập text');

    // Tìm editor với dynamic selector (có fallback)
    let editor = _queryWithFallback('composer');

    // Nếu không tìm thấy ngay, chờ thêm
    if (!editor) {
      await sleep(500);
      editor = _queryWithFallback('composer');
    }

    if (!editor) {
      console.error('[ChatAI] Không tìm thấy ô nhập text trên Gemini');
      return false;
    }

    editor.focus();
    await sleep(200);

    // Clear existing content
    if (editor.tagName === 'TEXTAREA') {
      editor.value = text;
      editor.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      // Contenteditable div
      // KHÔNG dùng innerHTML = ... vì sẽ xóa ảnh đã upload
      // Thay vào đó dùng execCommand để APPEND text

      // Đưa cursor về cuối editor (sau ảnh nếu có)
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false); // collapse to end
      selection.removeAllRanges();
      selection.addRange(range);

      // Insert text bằng execCommand (không trigger auto-submit)
      // CRITICAL: KHÔNG dispatch input event vì sẽ trigger Gemini auto-submit
      const inserted = document.execCommand('insertText', false, text);

      if (!inserted) {
        console.log('[ChatAI] Gemini: execCommand failed, fallback to append');
        // Fallback: append text node
        const textNode = document.createTextNode(text);
        editor.appendChild(textNode);
      }

      // Verify text was inserted
      await sleep(200);
      if (!editor.textContent.includes(text.substring(0, 20))) {
        console.log('[ChatAI] Gemini: Fallback to direct append');
        // Direct append với paragraph
        const p = document.createElement('p');
        p.textContent = text;
        editor.appendChild(p);
        // Chỉ dispatch input trong fallback path, không phải main path
        editor.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }

    await sleep(300);
    console.log('[ChatAI] Gemini: Text đã nhập:', editor.textContent.substring(0, 50));
    return true;
  }

  // Click submit button
  async function clickSubmit() {
    console.log('[ChatAI] Gemini: Tìm nút gửi');
    await sleep(500);

    let sendBtn = null;
    const start = Date.now();
    while (Date.now() - start < 8000) {
      // Dùng dynamic selector cho submit button
      sendBtn = _queryWithFallback('submit_button');

      // Fallback: tìm button với icon arrow/send
      if (!sendBtn) {
        const buttons = document.querySelectorAll('button');
        for (const btn of buttons) {
          const svg = btn.querySelector('svg');
          if (svg) {
            // Check for send/arrow icon patterns
            const paths = svg.querySelectorAll('path');
            for (const path of paths) {
              const d = path.getAttribute('d') || '';
              // Common send icon patterns
              if (d.includes('M2.01 21L23 12') || // Send arrow
                  d.includes('M2 21l21-9') ||
                  d.includes('m4 4 16 8-16 8') ||
                  d.match(/M\d+.*L.*\d+.*12/)) {
                sendBtn = btn;
                break;
              }
            }
          }
          if (sendBtn) break;
        }
      }

      if (sendBtn && !sendBtn.disabled) {
        console.log('[ChatAI] Gemini: Tìm thấy nút gửi');
        break;
      }
      sendBtn = null;
      await sleep(300);
    }

    if (!sendBtn) {
      // Last resort: tìm button cuối cùng trong input area.
      // Strict Server-Only: input_area_container từ backend (migration 2026_06_04_100001).
      const inputArea = _queryWithFallback('input_area_container');
      if (inputArea) {
        const buttons = inputArea.querySelectorAll('button:not([disabled])');
        sendBtn = buttons[buttons.length - 1]; // Thường nút send ở cuối
      } else {
        console.debug('[Tier3] Gemini sendPrompt: input_area_container config miss');
      }
    }

    if (!sendBtn) {
      console.error('[ChatAI] Không tìm thấy nút gửi trên Gemini');
      return false;
    }

    console.log('[ChatAI] Gemini: Click nút gửi');
    simulateClick(sendBtn);

    // Fallback: nếu click không work, thử React onClick
    await sleep(500);
    const reactKey = Object.keys(sendBtn).find(k => k.startsWith('__reactProps$'));
    if (reactKey && sendBtn[reactKey]?.onClick) {
      sendBtn[reactKey].onClick({ preventDefault: () => {}, stopPropagation: () => {} });
    }

    return true;
  }

  // ============ CG-8: Snapshot Gemini conversation state ============
  // Gemini DOM dùng <user-query> + <model-response> elements để phân tách turns.
  function snapshotGeminiState() {
    // Dùng dynamic selector cho response container
    const responses = _queryAllWithFallback('response_container');
    return {
      turnCount: responses.length,
      lastIds: Array.from(responses)
        .slice(-5)
        .map((r, i) => r.dataset?.turnId || r.id || `idx-${i}`),
      timestamp: Date.now(),
    };
  }

  // ============ CG-8: Detect Gemini đang generate ============
  // Signals:
  //  - Nút stop hiển thị (aria-label="Stop response", "Dừng phản hồi", v.v.)
  //  - aria-busy="true" trên markdown container (streaming indicator)
  //  - Có phần tử với class chứa "loading" / "generating" / progress spinner
  // NOTE: KHÔNG dùng send button disabled vì nó disabled khi input rỗng (không phải khi generating)
  function isGeminiGenerating() {
    // Stop button với dynamic selector
    const stopBtn = _queryWithFallback('stop_button');
    if (stopBtn) return true;

    // Check aria-busy="true" trên markdown container - streaming indicator chính xác nhất
    const busyMarkdown = document.querySelector('.markdown[aria-busy="true"]');
    if (busyMarkdown) return true;

    // Check aria-busy="true" trên message-content container
    const busyMessageContent = document.querySelector('message-content[aria-busy="true"]');
    if (busyMessageContent) return true;

    // Spinner generic
    if (document.querySelector('mat-progress-bar:not([hidden])')) return true;

    return false;
  }

  // ============ Detection: Gemini tạo ảnh thay vì trả prompt text ============
  // Gemini hay hiểu sai yêu cầu enhance prompt → tự generate image thay vì return prompt text.
  // Detect patterns này để fallback về plain text thay vì dùng response sai.
  const IMAGE_GENERATION_PATTERNS = [
    // Vietnamese patterns
    /đang tạo (hình ảnh|ảnh|image)/i,
    /tôi sẽ tạo (hình ảnh|ảnh|một bức ảnh)/i,
    /để tôi tạo (hình ảnh|ảnh)/i,
    /tôi đang tạo/i,
    /hình ảnh (của bạn|cho bạn)/i,
    /tạo hình ảnh theo yêu cầu/i,
    /đây là (hình ảnh|ảnh)/i,
    // English patterns
    /creating (your |an |the )?image/i,
    /generating (your |an |the )?image/i,
    /i('m| am| will) (create|generate|make) (an |the |your )?image/i,
    /i('ll| will) (create|generate|make)/i,
    /i('ve| have) (created|generated|made)/i,
    /here('s| is) (the |your |an )?image/i,
    /let me (create|generate|make)/i,
    /working on (your |the |an )?image/i,
    /processing (your |the |an )?image/i,
    // Gemini announcement patterns — thường bắt đầu bằng OK/Sure rồi nói về tạo ảnh
    /^(ok|okay|sure|alright)[,.]?\s*(i('ll| will)|let me|here)/i,
  ];

  /**
   * Strip screen-reader announcement prefix mà Gemini render trong `.cdk-visually-hidden`.
   * VD: "Gemini đã nói\nĐể có được dấu tick xanh..." → "Để có được dấu tick xanh..."
   * Multi-locale + handle leading/trailing whitespace.
   */
  function stripScreenReaderPrefix(text) {
    if (!text) return '';
    const prefixes = [
      /^Gemini đã nói[\s\n]*/i,
      /^Gemini said[\s\n]*/i,
      /^G[ée]mini ha dicho[\s\n]*/i,
      /^Geminiが答えました[\s\n]*/i,
      /^Gemini พูดว่า[\s\n]*/i,
    ];
    let stripped = text;
    for (const re of prefixes) {
      stripped = stripped.replace(re, '');
    }
    return stripped.trim();
  }

  function isImageGenerationResponse(text) {
    if (!text || text.length < 5) return false;
    // Chỉ check 300 chars đầu — announcement thường ở đầu response
    const checkText = text.substring(0, 300).toLowerCase();
    for (const pattern of IMAGE_GENERATION_PATTERNS) {
      if (pattern.test(checkText)) {
        console.log('[Gemini-text] IMAGE_GENERATION detected:', pattern.toString(), '| text preview:', checkText.substring(0, 100));
        return true;
      }
    }
    return false;
  }

  // ============ CG-8: Poll đợi Gemini response xong ============
  async function waitForGeminiTextResult(baseline, timeout = 60000) {
    const startTime = Date.now();
    const pollInterval = 500;
    let lastDiag = 0;
    let lastTextLength = 0;
    let stableCount = 0;
    const STABLE_THRESHOLD = 3; // Text phải stable qua 3 poll cycles (~1.5s) mới coi là xong

    while (Date.now() - startTime < timeout) {
      // Dùng dynamic selector cho response container
      const responses = _queryAllWithFallback('response_container');

      // Chưa có response mới so với baseline → poll tiếp
      if (responses.length <= baseline.turnCount) {
        if (Date.now() - lastDiag > 5000) {
          console.log('[Gemini-text] Chưa có response mới — current:', responses.length, 'baseline:', baseline.turnCount);
          lastDiag = Date.now();
        }
        await sleep(pollInterval);
        continue;
      }

      const lastResponse = responses[responses.length - 1];
      if (!lastResponse) {
        await sleep(pollInterval);
        continue;
      }

      // Check streaming còn chạy không (signal-based)
      const signalGenerating = isGeminiGenerating();

      // Extract current text — ƯU TIÊN markdown content, EXCLUDE screen-reader prefix
      // (Gemini render <h2 class="cdk-visually-hidden screen-reader-model-response-label">Gemini đã nói</h2>
      // bên ngoài markdown container → fallback innerText sẽ capture cả prefix gây bug).
      let currentText = '';
      const markdownEl = lastResponse.querySelector('.markdown-main-panel') || lastResponse.querySelector('.markdown');
      const messageContentEl = lastResponse.querySelector('message-content .markdown') || lastResponse.querySelector('message-content');
      const contentEl = markdownEl || messageContentEl;

      if (contentEl && typeof contentEl.innerText === 'string') {
        currentText = contentEl.innerText.trim();
      }

      // Strip screen-reader prefix nếu lỡ capture (defensive)
      currentText = stripScreenReaderPrefix(currentText);

      // Text stability check: text phải không đổi qua STABLE_THRESHOLD cycles
      // Min length 20 chars — text < 20 thường là screen-reader prefix hoặc early stream
      const MIN_TEXT_LENGTH = 20;
      const currentTextLength = currentText.length;
      if (currentTextLength === lastTextLength && currentTextLength >= MIN_TEXT_LENGTH) {
        stableCount++;
      } else {
        stableCount = 0;
        lastTextLength = currentTextLength;
      }

      const isTextStable = stableCount >= STABLE_THRESHOLD;
      // Generating nếu: signal still streaming, HOẶC text quá ngắn (chưa load xong), HOẶC chưa stable
      const stillGenerating = signalGenerating
        || currentTextLength < MIN_TEXT_LENGTH
        || (!isTextStable && currentTextLength > 0);

      if (stillGenerating) {
        if (Date.now() - lastDiag > 5000) {
          console.log('[Gemini-text] Đang generate — signal:', signalGenerating, 'textLen:', currentTextLength, 'stable:', stableCount);
          lastDiag = Date.now();
        }
        await sleep(pollInterval);
        continue;
      }

      // Streaming xong + text stable → extract final text
      console.log('[Gemini-text] Extract từ:', markdownEl ? '.markdown' : (messageContentEl ? 'message-content' : 'model-response'), '| text length:', currentText.length);

      if (!currentText || currentText.length < MIN_TEXT_LENGTH) {
        // Defensive fallback: lastResponse.innerText nhưng strip screen-reader prefix
        const fallbackRaw = lastResponse.innerText?.trim() || '';
        const fallbackText = stripScreenReaderPrefix(fallbackRaw);
        if (fallbackText && fallbackText.length >= MIN_TEXT_LENGTH) {
          console.log('[Gemini-text] Fallback extract from model-response (stripped prefix) | text length:', fallbackText.length);
          currentText = fallbackText;
        } else {
          // Chờ thêm nếu mới bắt đầu (chưa hết timeout)
          if (Date.now() - startTime < 8000) {
            await sleep(pollInterval);
            continue;
          }
          return { success: false, error: 'TEXT_EMPTY_OR_TOO_SHORT', text: fallbackRaw };
        }
      }

      const turnId = lastResponse.dataset?.turnId || lastResponse.id || null;
      console.log('[Gemini-text] DONE — text length:', currentText.length, 'stableCount:', stableCount);

      // Check: Gemini tạo ảnh thay vì trả prompt text → coi như fail để fallback
      if (isImageGenerationResponse(currentText)) {
        console.warn('[Gemini-text] Gemini đang tạo ảnh thay vì trả prompt — trigger fallback');
        return { success: false, error: 'IMAGE_GENERATION_DETECTED', text: currentText };
      }

      return { success: true, text: currentText, turnId };
    }

    console.warn('[Gemini-text] TIMEOUT sau', timeout, 'ms');
    return { success: false, error: 'TIMEOUT' };
  }

  // Main handler
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // SSE invalidate: admin update DOM selector → reload config ngay để tránh race condition
    if (message.action === 'providerConfigUpdated') {
      chrome.storage.local.get(['toby_provider_configs'], (res) => {
        if (res.toby_provider_configs?.data) {
          _selectorConfig = res.toby_provider_configs.data;
          _selectorConfigTime = Date.now();
          const keyCount = Object.keys(_selectorConfig[PROVIDER]?.selectors || {}).length;
          console.log(`[Gemini] Provider config updated via SSE — reloaded ${keyCount} selectors`);
        } else {
          _selectorConfig = null;
          _selectorConfigTime = 0;
          console.warn('[Gemini] Provider config updated via SSE — storage empty, cache cleared');
        }
        sendResponse({ success: true });
      });
      return true; // async response
    }

    // Phase X: chatAI:execute — ChatAIModal flow (giữ nguyên)
    if (message.action === 'chatAI:execute') {
      (async () => {
        try {
          // 1. Upload images first (if any)
          if (message.images && message.images.length > 0) {
            const uploaded = await uploadImages(message.images);
            if (!uploaded) {
              sendResponse({ success: false, error: 'Không thể upload ảnh lên Gemini' });
              return;
            }
          }

          // 2. Insert text
          const textInserted = await insertText(message.text);
          if (!textInserted) {
            sendResponse({ success: false, error: 'Không thể nhập text vào Gemini' });
            return;
          }

          // 3. Chờ Gemini UI settle trước khi submit
          await sleep(800);

          // 4. Submit
          const submitted = await clickSubmit();
          if (!submitted) {
            sendResponse({ success: false, error: 'Không thể gửi tin nhắn trên Gemini' });
            return;
          }

          sendResponse({ success: true });
        } catch (err) {
          sendResponse({ success: false, error: err.message || 'Lỗi không xác định' });
        }
      })();

      return true; // async sendResponse
    }

    // Phase CG-8: gemini:submitAndWait — submit prompt + chờ text response
    // Payload: { action, text, images?, timeout }
    if (message.action === 'gemini:submitAndWait') {
      console.log(
        '[Gemini-listener] gemini:submitAndWait nhận, text len:', (message.text || '').length,
        'images:', (message.images || []).length
      );
      (async () => {
        try {
          // PRE-CHECK: Cloudflare/Google challenge detection (defensive — Gemini hiếm khi có
          // nhưng thêm để an toàn khi tab inactive). Pattern giống ChatGPT/Grok.
          if (detectGeminiChallenge()) {
            const resolved = await waitForGeminiChallengeResolved(120000);
            if (!resolved) {
              sendResponse({
                success: false,
                error: 'CHALLENGE_TIMEOUT',
                message: 'Gemini yêu cầu xác minh. Vui lòng mở tab Gemini, hoàn thành verification, sau đó chạy lại.',
              });
              return;
            }
          }

          // 1. Snapshot baseline TRƯỚC khi submit
          const baseline = snapshotGeminiState();

          // 2. Phase CG-8 ext: Upload ref images (nếu có) TRƯỚC khi insert text
          //    Reuse `uploadImages` đã có (Phase X) — Gemini cho phép ảnh đầu vào.
          if (Array.isArray(message.images) && message.images.length > 0) {
            const uploaded = await uploadImages(message.images);
            if (!uploaded) {
              sendResponse({ success: false, error: 'REF_UPLOAD_FAILED', message: 'Không thể upload ảnh ref lên Gemini' });
              return;
            }
            await sleep(500); // chờ Gemini UI settle sau upload
          }

          // 3. Insert text vào Quill editor — prefix bắt LLM trả plain prompt (Prompt enhance flow).
          //    Gemini cũng có thể trả markdown/giải thích dài dòng nếu không có constraint.
          const enhancePrefix = await getEnhancePrefix();
          const promptText = enhancePrefix + (message.text || '');
          const textInserted = await insertText(promptText);
          if (!textInserted) {
            sendResponse({ success: false, error: 'INSERT_FAILED' });
            return;
          }

          // 4. Wait UI settle + click submit
          await sleep(500);
          const submitted = await clickSubmit();
          if (!submitted) {
            sendResponse({ success: false, error: 'SEND_BUTTON_NOT_FOUND' });
            return;
          }

          // 5. Chờ kết quả text
          const timeout = message.timeout || 60000;
          const result = await waitForGeminiTextResult(baseline, timeout);
          sendResponse(result);
        } catch (err) {
          sendResponse({
            success: false,
            error: 'EXCEPTION',
            message: err.message || 'Lỗi không xác định',
          });
        }
      })();

      return true; // async sendResponse
    }

    // 2026-05-29: gemini:deleteCurrentConversation — xóa conversation hiện tại sau enhance.
    // Triggered từ WorkflowExecutor khi node Prompt có setting `delete_after_enhance=true`.
    if (message.action === 'gemini:deleteCurrentConversation') {
      (async () => {
        try {
          const success = await deleteCurrentConversation();
          sendResponse({ success });
        } catch (err) {
          console.error('[Gemini-listener] deleteCurrentConversation error:', err);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true; // async sendResponse
    }

    return false;
  });

  console.log('[ChatAI] Content script Gemini đã được inject (Phase X + CG-8)');
})();
