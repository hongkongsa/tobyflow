/**
 * Toby Flow - App Entry Point
 * Khởi tạo tất cả components và modules
 */

(function() {
  'use strict';

  const DEBUG = true;

  // Note: Đã remove SW keep-alive port + heartbeat sau khi xác định root cause thực sự
  // là Chrome HTTP cache (fix bằng cache: 'no-store' trong background.js apiRequest handler).
  // SW lifecycle không phải nguyên nhân bug login/logout refresh quyền.

  // ─── Shared Bank Name Mapping ──────────────────────────
  const BANK_NAMES = {
    'MB': 'MB Bank',
    'TCB': 'Techcombank',
    'VCB': 'Vietcombank',
    'ACB': 'ACB',
    'BIDV': 'BIDV',
    'VTB': 'Vietinbank',
    'TPB': 'TPBank',
    'STB': 'Sacombank',
    'SHB': 'SHB',
    'MSB': 'MSB',
    'VPB': 'VPBank',
    'SCB': 'SCB',
    'OCB': 'OCB',
    'EIB': 'Eximbank',
  };

  function log(...args) {
    if (DEBUG) console.log('[TobyFlow]', ...args);
  }

  /**
   * sidePanel-compatible sendLog — writes to logContainer DOM directly
   * (content.js sendLog không available trong sidePanel context)
   */
  function sidebarLog(msg, level = 'info') {
    console.log(`[TobyFlow] ${msg}`);
    const logContainer = document.getElementById('logContainer');
    if (logContainer) {
      const div = document.createElement('div');
      div.className = `log-entry ${level}`;
      div.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
      logContainer.appendChild(div);
      logContainer.scrollTop = logContainer.scrollHeight;
    }
    const logTabBtn = document.querySelector('.tobyflow-tab[data-tab="tab-logs"]');
    if (logTabBtn && !logTabBtn.classList.contains('active')) {
      logTabBtn.classList.add('has-new');
    }
  }
  window.sidebarLog = sidebarLog;

  /**
   * Global notification toast — top center, auto dismiss
   * @param {string} message
   * @param {'success'|'error'|'info'|'warning'} type
   * @param {number} duration ms (default 2500)
   */
  const _notifIcons = {
    success: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>',
    error: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>',
    info: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>',
    warning: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>',
  };
  let _notifTimer = null;
  // 2026-05-31: dedup — skip toast trùng (message+type) trong 3s.
  // Tránh spam khi workflow nhiều nodes cùng trigger 1 loại warning.
  let _lastNotif = { key: '', timestamp: 0 };
  window.showNotification = function(message, type = 'success', duration) {
    // K.9 (2026-05-29): error mặc định 5000ms (user cần đọc kỹ), success/info 2500ms.
    const ms = typeof duration === 'number' ? duration : (type === 'error' ? 5000 : 2500);
    const dedupKey = `${type}::${message}`;
    const now = Date.now();
    if (_lastNotif.key === dedupKey && (now - _lastNotif.timestamp) < 3000) {
      return; // Skip duplicate within 3s
    }
    _lastNotif = { key: dedupKey, timestamp: now };
    // Remove existing
    const existing = document.querySelector('.tobyflow-notification');
    if (existing) {
      clearTimeout(_notifTimer);
      existing.remove();
    }
    const el = document.createElement('div');
    el.className = `tobyflow-notification ${type}`;
    el.innerHTML = `${_notifIcons[type] || _notifIcons.info}<span>${message}</span>`;
    document.body.appendChild(el);

    // K.8 (2026-05-29): Hover-pause UX — user hover chuột → giữ toast hiển thị
    // (clear auto-dismiss timer). Bỏ chuột ra → restart timer ngắn hơn (1500ms)
    // để toast biến mất nhanh sau khi user đã đọc xong.
    const RESUME_DURATION = 1500;
    const startDismissTimer = (delay) => {
      _notifTimer = setTimeout(() => {
        el.classList.add('tobyflow-notif-out');
        setTimeout(() => el.remove(), 300);
      }, delay);
    };
    startDismissTimer(ms);
    el.addEventListener('mouseenter', () => {
      if (_notifTimer) {
        clearTimeout(_notifTimer);
        _notifTimer = null;
      }
    });
    el.addEventListener('mouseleave', () => {
      // Chỉ restart nếu toast chưa fade-out (mouseleave fire khi removing animation).
      if (!el.classList.contains('tobyflow-notif-out')) {
        startDismissTimer(RESUME_DURATION);
      }
    });
  };

  // Bug 49 fix (2026-05-13): Cloudflare challenge notification — persistent toast
  // user phải click vào tab Grok để verify captcha. Update mỗi 10s với elapsed time.
  // Auto-dismiss khi resolved, escalate styling sau 30s nếu chưa pass.
  function _showCloudflareToast(msg) {
    const existing = document.getElementById('tobyflow-cloudflare-toast');
    const ELAPSED_URGENT_SEC = 30;
    const provider = msg.provider || 'grok';
    const providerLabel = provider === 'grok' ? 'Grok' : provider.charAt(0).toUpperCase() + provider.slice(1);

    // Helper: I18n.t() trả về key string khi không tìm thấy → check và dùng fallback
    const _t = (key, params, fallback) => {
      const result = window.I18n?.t(key, params);
      return (result && result !== key && !result.startsWith('cloudflare.')) ? result : fallback;
    };

    if (msg.phase === 'resolved') {
      // Hide + show success briefly
      if (existing) {
        existing.classList.add('tobyflow-notif-out');
        setTimeout(() => existing.remove(), 300);
      }
      window.showNotification?.(
        _t('cloudflare.resolved', { provider: providerLabel, sec: msg.elapsedSec },
          `✓ Cloudflare ${providerLabel} đã verify (${msg.elapsedSec}s)`),
        'success',
        3000
      );
      return;
    }

    if (msg.phase === 'timeout') {
      if (existing) existing.remove();
      window.showNotification?.(
        _t('cloudflare.timeout', { provider: providerLabel },
          `⚠️ Cloudflare ${providerLabel} verify timeout — vui lòng thử lại`),
        'error',
        5000
      );
      return;
    }

    // detected | waiting → persistent toast
    const elapsed = msg.elapsedSec || 0;
    const isUrgent = elapsed >= ELAPSED_URGENT_SEC;
    const titleText = isUrgent
      ? _t('cloudflare.urgent', { provider: providerLabel },
          `🛡️ Cloudflare ${providerLabel} — cần bạn click verify!`)
      : _t('cloudflare.detected', { provider: providerLabel },
          `🛡️ Cloudflare ${providerLabel} challenge — đang chờ verify…`);
    const subtitleText = _t('cloudflare.subtitle', { sec: elapsed },
      `Đã chờ ${elapsed}s. Nếu lâu không pass, hãy click vào tab ${providerLabel} để verify thủ công.`);
    const openTabText = _t('cloudflare.openTab', { provider: providerLabel }, `Mở ${providerLabel}`);

    let el = existing;
    if (!el) {
      el = document.createElement('div');
      el.id = 'tobyflow-cloudflare-toast';
      el.className = 'tobyflow-cloudflare-toast';
      document.body.appendChild(el);
    }
    el.classList.toggle('is-urgent', isUrgent);
    el.innerHTML = `
      <div class="tobyflow-cf-toast-icon">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path></svg>
      </div>
      <div class="tobyflow-cf-toast-body">
        <div class="tobyflow-cf-toast-title">${titleText}</div>
        <div class="tobyflow-cf-toast-subtitle">${subtitleText}</div>
      </div>
      <button type="button" class="tobyflow-cf-toast-btn" data-action="focus-tab">
        ${openTabText}
      </button>
    `;
    // Click action → send focus tab message back tới background
    el.querySelector('[data-action="focus-tab"]')?.addEventListener('click', () => {
      try {
        chrome.runtime.sendMessage({ action: 'grok:ensureActive', focusWindow: true, reason: 'user_click_toast' });
      } catch (_) {}
    });
  }

  // Listen cloudflare:challenge broadcasts từ background
  try {
    chrome.runtime?.onMessage?.addListener((msg) => {
      if (msg?.action === 'cloudflare:challenge') {
        try { _showCloudflareToast(msg); } catch (e) { console.warn('[CloudflareToast] error:', e?.message); }
      }
    });
  } catch (_) {}

  // U-1.5: Project context
  window._currentProjectId = null;
  window._currentProjectName = null;
  window._targetFlowTabId = null; // Tab ID mà sidePanel đang làm việc (tránh gửi message đến tab sai)
  let _projectNavigating = false;
  let _projectContextResolved = false; // Flag: đã nhận được response từ _requestProjectContext
  let _isInitialRetrying = false; // Flag: đang trong quá trình retry ban đầu (chưa show overlay)

  // Connecting overlay: hiển thị khi đang kết nối Flow page
  function _showConnectingOverlay() {
    const overlay = document.getElementById('tobyflow-connecting-overlay');
    if (overlay) {
      overlay.classList.remove('hidden');
    }
  }

  function _hideConnectingOverlay() {
    const overlay = document.getElementById('tobyflow-connecting-overlay');
    if (overlay) {
      overlay.classList.add('hidden');
    }
  }

  // Provider login polling state
  const _loginPollingState = {
    chatgpt: { active: false, intervalId: null },
    grok: { active: false, intervalId: null },
  };

  /**
   * Poll login status cho provider (ChatGPT/Grok) sau khi user mở tab login.
   * Khi phát hiện đã login → show toast thông báo + emit event để UI có thể retry.
   * Timeout 3 phút, poll mỗi 3 giây.
   *
   * @param {'chatgpt'|'grok'} provider
   * @param {number} tabId
   */
  async function _pollProviderLogin(provider, tabId) {
    if (!tabId || !provider) return;
    const state = _loginPollingState[provider];
    if (!state) return;

    // Nếu đang poll provider này → skip
    if (state.active) {
      console.log(`[TobyFlow] Already polling ${provider} login`);
      return;
    }

    state.active = true;
    const POLL_INTERVAL = 3000; // 3s
    const TIMEOUT = 180000; // 3 phút
    const startTime = Date.now();

    const providerName = provider === 'chatgpt' ? 'ChatGPT' : 'Grok';
    const checkAction = `${provider}:checkLogin`;

    console.log(`[TobyFlow] Start polling ${provider} login status, tabId=${tabId}`);

    const poll = async () => {
      // Timeout check
      if (Date.now() - startTime > TIMEOUT) {
        console.log(`[TobyFlow] ${provider} login polling timeout`);
        _stopLoginPolling(provider);
        return;
      }

      try {
        // Check if tab still exists
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        if (!tab) {
          console.log(`[TobyFlow] ${provider} tab closed, stop polling`);
          _stopLoginPolling(provider);
          return;
        }

        // Send check login request
        const resp = await new Promise((resolve) => {
          chrome.runtime.sendMessage({ action: checkAction, tabId }, resolve);
        });

        if (resp?.success && resp?.ready) {
          console.log(`[TobyFlow] ${provider} login detected!`);
          _stopLoginPolling(provider);

          // Show success toast
          window.showNotification?.(
            window.I18n?.t(`${provider}.loginSuccess`) || `Đã đăng nhập ${providerName}. Bạn có thể chạy lại task.`,
            'success',
            4000
          );

          // Emit event để UI có thể handle (vd: auto-retry)
          window.eventBus?.emit(`${provider}:login_success`, { tabId });
        }
      } catch (err) {
        console.warn(`[TobyFlow] ${provider} login poll error:`, err.message);
      }
    };

    // Start polling
    state.intervalId = setInterval(poll, POLL_INTERVAL);
    // First poll immediately
    poll();
  }

  function _stopLoginPolling(provider) {
    const state = _loginPollingState[provider];
    if (!state) return;
    if (state.intervalId) {
      clearInterval(state.intervalId);
      state.intervalId = null;
    }
    state.active = false;
  }

  /**
   * Check queue trống và reload Flow page nếu cần trước khi run workflow/task.
   * Giúp đảm bảo Flow page ở trạng thái fresh, tránh stuck/stale state.
   *
   * Chỉ reload khi:
   * - Pipeline queue hoàn toàn trống (không có active jobs, pending items, downloads)
   * - Không đang trong quá trình reload khác
   *
   * @param {string} caller - Tên caller để log ('workflow' | 'task')
   * @returns {Promise<boolean>} true nếu đã reload hoặc không cần reload, false nếu lỗi
   */
  async function _checkQueueAndReloadIfEmpty(caller = 'workflow') {
    try {
      // Kiểm tra PromptQueue có tồn tại và có thể access không
      const queue = window.PromptQueue?.getInstance?.();
      if (!queue) {
        console.log(`[TobyFlow] _checkQueueAndReloadIfEmpty(${caller}): PromptQueue not available, skip`);
        return true; // Không có queue → không cần reload
      }

      // Kiểm tra queue status
      const activeJobs = queue.activeJobCount || 0;
      const pendingItems = queue.pendingCount || 0;
      const isRunning = queue.isRunning || false;

      console.log(`[TobyFlow] _checkQueueAndReloadIfEmpty(${caller}): activeJobs=${activeJobs}, pendingItems=${pendingItems}, isRunning=${isRunning}`);

      // Nếu queue đang có tác vụ → không reload, để tiếp tục bình thường
      if (activeJobs > 0 || pendingItems > 0 || isRunning) {
        console.log(`[TobyFlow] _checkQueueAndReloadIfEmpty(${caller}): queue not empty, skip reload`);
        return true;
      }

      // Queue trống → reload Flow page
      console.log(`[TobyFlow] _checkQueueAndReloadIfEmpty(${caller}): queue empty, reloading Flow page...`);

      // Hiện thông báo cho user biết đang reload (duration dài hơn để user thấy)
      window.showNotification?.(
        window.I18n?.t('common.refreshingFlow') || 'Đang làm mới trang Flow...',
        'info',
        5000
      );

      // Gửi reload message
      if (window.MessageBridge) {
        // Snapshot thời điểm trước reload để verify sau
        const reloadTimestamp = Date.now();

        try {
          await window.MessageBridge.sendToContentScript('autoReloadFlow', {});
        } catch (e) {
          console.warn(`[TobyFlow] _checkQueueAndReloadIfEmpty(${caller}): reload message failed:`, e.message);
          return true; // Vẫn cho phép tiếp tục nếu reload fail
        }

        // Chờ content script mất kết nối (reload thật) rồi mới poll ready
        // Timeout ngắn để detect reload đã xảy ra
        await new Promise(r => setTimeout(r, 500));

        // Chờ editor ready (max 15s)
        const ready = await _waitForFlowEditorReady(15000);
        const reloadDuration = Date.now() - reloadTimestamp;

        // Chỉ hiện notification khi:
        // 1. Editor ready
        // 2. Đã có thời gian reload hợp lý (> 1s) - tránh false positive khi editor đã ready từ trước
        if (!ready) {
          console.warn(`[TobyFlow] _checkQueueAndReloadIfEmpty(${caller}): editor not ready after reload`);
          window.showNotification?.(
            window.I18n?.t('common.flowReloadFailed') || 'Không thể làm mới trang Flow',
            'warning',
            3000
          );
        } else if (reloadDuration > 1000) {
          // Thông báo reload thành công - chỉ khi thực sự có reload (> 1s)
          console.log(`[TobyFlow] _checkQueueAndReloadIfEmpty(${caller}): reload done in ${reloadDuration}ms`);
          window.showNotification?.(
            window.I18n?.t('common.flowReady') || 'Trang Flow đã sẵn sàng',
            'success',
            2000
          );
        } else {
          // Editor ready quá nhanh → có thể không thực sự reload, skip notification
          console.log(`[TobyFlow] _checkQueueAndReloadIfEmpty(${caller}): ready too fast (${reloadDuration}ms), skip notification`);
        }

        // Extra settle delay cho React render
        await new Promise(r => setTimeout(r, 1500));

        console.log(`[TobyFlow] _checkQueueAndReloadIfEmpty(${caller}): reload complete`);
      }

      return true;
    } catch (err) {
      console.error(`[TobyFlow] _checkQueueAndReloadIfEmpty(${caller}) error:`, err.message);
      return true; // Vẫn cho phép tiếp tục nếu có lỗi
    }
  }

  /**
   * Chờ Flow editor ready sau reload.
   * Sử dụng checkContentScriptAlive handler (trả về { alive, hasEditor }).
   * @param {number} timeout - Max time to wait (ms)
   * @returns {Promise<boolean>}
   */
  async function _waitForFlowEditorReady(timeout = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      try {
        const resp = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('timeout')), 3000);
          if (window.MessageBridge) {
            window.MessageBridge.sendToContentScript('checkContentScriptAlive', {})
              .then(r => { clearTimeout(timer); resolve(r); })
              .catch(e => { clearTimeout(timer); reject(e); });
          } else {
            clearTimeout(timer);
            reject(new Error('no MessageBridge'));
          }
        });
        // checkContentScriptAlive trả về { alive: true, hasEditor: boolean }
        if (resp?.alive && resp?.hasEditor) return true;
      } catch (_) {
        // Ignore và retry
      }
      await new Promise(r => setTimeout(r, 500));
    }
    return false;
  }

  // Expose để workflow/task có thể gọi
  window._checkQueueAndReloadIfEmpty = _checkQueueAndReloadIfEmpty;

  // Extract project name từ tab/document title (fallback khi DOM extraction fail)
  // Flow title format: "ProjectName - Flow - Labs" hoặc "ProjectName — Google Labs"
  function _extractProjectNameFromTitle(title) {
    if (!title) return null;
    // Format: "Flow - Project Name" hoặc "Project Name - Flow - Labs"
    const parts = title.split(/\s*[-–—|]\s*/);
    // Tìm phần KHÔNG phải generic text (Flow, Labs, Google...)
    for (const part of parts) {
      const candidate = part.trim();
      if (!candidate || candidate.length === 0 || candidate.length >= 100) continue;
      const lower = candidate.toLowerCase();
      if (lower === 'flow' || lower === 'labs' || lower.includes('labs.google')
        || lower.includes('google')) continue;
      return candidate;
    }
    return null;
  }

  // U-1.6: Lưu project vào danh sách đã truy cập + sync lên backend
  async function _saveProjectToList(projectId, projectName) {
    if (!projectId) return;
    try {
      const result = await chrome.storage.local.get('af_projects');
      const projects = result.af_projects || {};
      projects[projectId] = {
        name: projectName || projects[projectId]?.name || projectId.substring(0, 8),
        last_accessed: Date.now()
      };
      await chrome.storage.local.set({ af_projects: projects });

      // Sync lên backend (fire and forget)
      if (window.ProjectHelper?.syncCurrentProject && projectName) {
        window.ProjectHelper.syncCurrentProject().catch(() => {});
      }
    } catch (e) {
      console.warn('[TobyFlow] _saveProjectToList error:', e.message);
    }
  }

  // Xóa project khỏi danh sách
  async function _removeProjectFromList(projectId) {
    if (!projectId) return;
    try {
      const result = await chrome.storage.local.get('af_projects');
      const projects = result.af_projects || {};
      delete projects[projectId];
      await chrome.storage.local.set({ af_projects: projects });
    } catch (e) {
      console.warn('[TobyFlow] _removeProjectFromList error:', e.message);
    }
  }

  // Auto-cleanup projects quá cũ (>30 ngày không access)
  async function _cleanupStaleProjects() {
    try {
      const result = await chrome.storage.local.get('af_projects');
      const projects = result.af_projects || {};
      const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000; // 30 ngày
      let changed = false;
      for (const [id, data] of Object.entries(projects)) {
        if (data.last_accessed && data.last_accessed < cutoff && id !== window._currentProjectId) {
          delete projects[id];
          changed = true;
        }
      }
      if (changed) {
        await chrome.storage.local.set({ af_projects: projects });
        console.log('[TobyFlow] Đã dọn projects cũ (>30 ngày)');
      }
    } catch (e) {
      console.warn('[TobyFlow] _cleanupStaleProjects error:', e.message);
    }
  }

  // Sync danh sách projects từ Flow DOM (scan home page) + tab titles
  async function _syncProjectsFromFlow() {
    try {
      const tabs = await chrome.tabs.query({ url: window.ProviderConfigManager?.getTabQuery('flow') });
      if (tabs.length === 0) return;

      // Phase 1: Sync tên project từ các tab đang mở trong project (via tab.title + getProjectContext)
      const projectTabs = tabs.filter(t => t.url && t.url.match(/\/project\/[a-f0-9-]+/));
      if (projectTabs.length > 0) {
        const result0 = await chrome.storage.local.get('af_projects');
        const projects0 = result0.af_projects || {};
        let changed0 = false;
        for (const pt of projectTabs) {
          const pidMatch = pt.url.match(/\/project\/([a-f0-9-]+)/);
          if (!pidMatch) continue;
          const pid = pidMatch[1];

          // Lấy tên từ content.js (extractProjectName)
          let pName = null;
          try {
            const ctxResp = await new Promise((resolve) => {
              chrome.tabs.sendMessage(pt.id, { action: 'getProjectContext' }, (r) => {
                if (chrome.runtime.lastError) resolve(null);
                else resolve(r);
              });
            });
            pName = ctxResp?.projectName || null;
          } catch (e) {}

          // Fallback: tab title
          if (!pName && pt.title) {
            pName = _extractProjectNameFromTitle(pt.title);
          }

          if (pName && projects0[pid] && projects0[pid].name !== pName) {
            projects0[pid].name = pName;
            changed0 = true;
          }
          if (pName && !projects0[pid]) {
            projects0[pid] = { name: pName, last_accessed: 0 };
            changed0 = true;
          }
        }
        if (changed0) {
          await chrome.storage.local.set({ af_projects: projects0 });
        }
      }

      // Phase 2: Scan home page cho project list (nếu có tab ở homepage)
      const homeTab = tabs.find(t => t.url && !t.url.match(/\/project\/[a-f0-9-]+/));
      const targetTab = homeTab || tabs[0];

      const resp = await new Promise((resolve) => {
        chrome.tabs.sendMessage(targetTab.id, { action: 'scanFlowProjects' }, (r) => {
          if (chrome.runtime.lastError) resolve(null);
          else resolve(r);
        });
      });

      if (!resp?.projects?.length) return;

      const result = await chrome.storage.local.get('af_projects');
      const projects = result.af_projects || {};
      let changed = false;

      // Tập hợp project IDs thực sự còn tồn tại trên Flow
      const flowProjectIds = new Set(resp.projects.map(p => p.id));

      // Cập nhật tên project từ Flow DOM (rename detection)
      for (const fp of resp.projects) {
        if (fp.name && projects[fp.id] && projects[fp.id].name !== fp.name) {
          projects[fp.id].name = fp.name;
          changed = true;
        }
        // Nếu project trên Flow mà extension chưa biết → thêm vào
        if (!projects[fp.id]) {
          projects[fp.id] = {
            name: fp.name || fp.id.substring(0, 8),
            last_accessed: 0 // Chưa access qua extension
          };
          changed = true;
        }
      }

      // Đánh dấu projects không còn trên Flow (chỉ khi scan được từ home page)
      if (resp.isHomePage) {
        for (const [id, data] of Object.entries(projects)) {
          if (!flowProjectIds.has(id) && id !== window._currentProjectId) {
            // Không xóa ngay — đánh dấu _notOnFlow để xử lý sau
            if (!data._notOnFlow) {
              projects[id]._notOnFlow = Date.now();
              changed = true;
            } else if (Date.now() - data._notOnFlow > 7 * 24 * 60 * 60 * 1000) {
              // Đã 7 ngày không thấy trên Flow → xóa
              delete projects[id];
              changed = true;
            }
          } else if (data._notOnFlow && flowProjectIds.has(id)) {
            // Project xuất hiện lại → xóa flag
            delete data._notOnFlow;
            changed = true;
          }
        }
      }

      if (changed) {
        await chrome.storage.local.set({ af_projects: projects });
      }
    } catch (e) {
      // sidePanel có thể không có chrome.tabs
      console.warn('[TobyFlow] _syncProjectsFromFlow error:', e.message);
    }
  }

  // U-4.6: Cap nhat project indicator tren sidebar
  function _updateProjectIndicator() {
    const indicator = document.getElementById('project-indicator');
    const nameEl = document.getElementById('project-indicator-name');
    if (!indicator || !nameEl) return;

    if (window._currentProjectId && window._currentProjectName) {
      indicator.style.display = '';
      nameEl.textContent = window._currentProjectName;
    } else if (window._currentProjectId) {
      indicator.style.display = '';
      nameEl.textContent = window._currentProjectId.substring(0, 12) + '...';
    } else {
      indicator.style.display = 'none';
    }
  }

  function _setProjectNavigating(active) {
    _projectNavigating = active;
    const indicator = document.getElementById('project-indicator');
    const overlay = document.querySelector('.project-select-overlay');
    if (indicator) {
      indicator.classList.toggle('project-navigating', active);
    }
    if (overlay) {
      overlay.classList.toggle('project-navigating', active);
    }
  }

  // U-4.6: Toggle project dropdown
  async function _toggleProjectDropdown() {
    if (_projectNavigating) return;
    const dropdown = document.getElementById('project-indicator-dropdown');
    if (!dropdown) return;

    if (dropdown.style.display !== 'none') {
      dropdown.style.display = 'none';
      return;
    }

    const result = await chrome.storage.local.get('af_projects');
    const projects = result.af_projects || {};
    const sorted = Object.entries(projects)
      .sort(([, a], [, b]) => (b.last_accessed || 0) - (a.last_accessed || 0));

    if (sorted.length === 0) {
      dropdown.innerHTML = `<div class="project-indicator-item" style="color: rgba(255,255,255,0.4); cursor: default;">${window.I18n?.t('project.noProjects') || 'Chưa có project'}</div>`;
    } else {
      dropdown.innerHTML = sorted.map(([id, data]) => {
        const isActive = id === window._currentProjectId;
        const name = data.name || id.substring(0, 12);
        const date = data.last_accessed ? window.I18n?.formatDate?.(data.last_accessed) || new Date(data.last_accessed).toLocaleDateString() : '';
        const staleClass = data._notOnFlow ? ' project-indicator-item--stale' : '';
        return `<div class="project-indicator-item${isActive ? ' active' : ''}${staleClass}" data-project-id="${id}">
          <div class="project-indicator-item-info">
            <span class="project-indicator-item-name">${name}</span>
            <span class="project-indicator-item-date">${date}</span>
          </div>
          ${!isActive ? `<button class="project-indicator-item-delete" data-delete-id="${id}" title="Xóa khỏi danh sách">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
          </button>` : ''}
        </div>`;
      }).join('');
    }

    dropdown.style.display = '';

    // Delete handler
    dropdown.querySelectorAll('.project-indicator-item-delete').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const deleteId = btn.dataset.deleteId;
        await _removeProjectFromList(deleteId);
        btn.closest('.project-indicator-item').remove();
        // Nếu list rỗng, cập nhật
        if (!dropdown.querySelector('.project-indicator-item[data-project-id]')) {
          dropdown.innerHTML = `<div class="project-indicator-item" style="color: rgba(255,255,255,0.4); cursor: default;">${window.I18n?.t('project.noProjects') || 'Chưa có project'}</div>`;
        }
      });
    });

    // Click handler for items
    dropdown.querySelectorAll('.project-indicator-item[data-project-id]').forEach(item => {
      item.addEventListener('click', (e) => {
        if (e.target.closest('.project-indicator-item-delete')) return;
        if (_projectNavigating) return;
        const projectId = item.dataset.projectId;
        if (projectId === window._currentProjectId) {
          dropdown.style.display = 'none';
          return;
        }

        // Disable select trong khi redirect
        _setProjectNavigating(true);

        // Cập nhật project state + UI + emit event để reload data
        const projectData = projects[projectId];
        const projectName = projectData?.name || projectId.substring(0, 12);
        const oldId = window._currentProjectId;
        window._currentProjectId = projectId;
        window._currentProjectName = projectName;
        _updateProjectIndicator();
        _saveProjectToList(projectId, projectName);

        // Emit project:changed để các tab reload data
        if (oldId !== projectId) {
          window.eventBus?.emit('project:changed', { projectId, projectName });
        }

        // Group C/Initiative 7: base URL từ ProviderConfigManager (server-driven).
        // Pattern '/vi/' locale strip — Google auto-redirect theo browser locale.
        const _flowBase = window.ProviderConfigManager?.getBaseUrlSync('flow');
        chrome.runtime.sendMessage({
          action: 'navigateToProject',
          url: `${_flowBase}/project/${projectId}`,
          projectId
        });
        dropdown.style.display = 'none';

        // After navigation, confirm project context with retry
        _requestProjectContextWithRetry(3, 1500);
      });
    });

    // Close on click outside
    const closeHandler = (e) => {
      if (!dropdown.contains(e.target) && e.target.id !== 'project-indicator-btn') {
        dropdown.style.display = 'none';
        document.removeEventListener('click', closeHandler);
      }
    };
    setTimeout(() => document.addEventListener('click', closeHandler), 0);
  }

  // Regex chuẩn cho Flow URL — locale prefix có thể là vi/en/ja/th/ko/zh/.../không có
  // Examples: https://labs.google/fx/tools/flow, /fx/vi/tools/flow, /fx/en/tools/flow
  const FLOW_HOMEPAGE_REGEX = /^https:\/\/labs\.google\/fx(\/[a-z]{2,5})?\/tools\/flow\/?(\?.*)?$/;
  const FLOW_PROJECT_REGEX = /\/project\/[a-f0-9-]+/;
  const _isFlowHomepageTab = (tab) => !!(tab?.url && FLOW_HOMEPAGE_REGEX.test(tab.url));
  const _isFlowProjectTab = (tab) => !!(tab?.url && FLOW_PROJECT_REGEX.test(tab.url));

  // Tạo dự án mới — smart: nếu đã có Flow homepage tab → click trực tiếp, không reload.
  // Nếu chưa có → navigate tới Flow home rồi mới click.
  async function _createNewProject() {
    if (_projectNavigating) return;
    _setProjectNavigating(true);

    // Check Flow tabs sẵn có
    let homepageTab = null;
    try {
      const tabs = await chrome.tabs.query({ url: window.ProviderConfigManager?.getTabQuery('flow') });
      homepageTab = tabs.find(_isFlowHomepageTab);
    } catch (e) { /* ignore */ }

    const handleClickResp = (resp) => {
      if (resp?.success) {
        _requestProjectContextWithRetry(5, 2000);
      } else {
        console.warn('[TobyFlow] Không tìm thấy nút tạo dự án:', resp?.result?.error || resp?.error);
        _setProjectNavigating(false);
      }
    };

    if (homepageTab) {
      // Có Flow homepage tab → activate + click trực tiếp (không reload, nhanh hơn)
      try {
        await chrome.tabs.update(homepageTab.id, { active: true });
        await chrome.windows?.update?.(homepageTab.windowId, { focused: true });
      } catch (e) { /* ignore */ }
      // Delay 300ms cho tab active settle, sau đó click
      setTimeout(() => {
        chrome.runtime.sendMessage({ action: 'clickCreateNewProject' }, handleClickResp);
      }, 300);
    } else {
      // Không có Flow tab → navigate tới Flow home + click
      // Group C/Initiative 7: base URL từ ProviderConfigManager
      const _flowHome = window.ProviderConfigManager?.getBaseUrlSync('flow');
      chrome.runtime.sendMessage({
        action: 'navigateToProject',
        url: _flowHome
      }, () => {
        setTimeout(() => {
          chrome.runtime.sendMessage({ action: 'clickCreateNewProject' }, handleClickResp);
        }, 1000);
      });
    }
  }

  // Debounce duplicate calls — tab activation event + flowTabActivated message
  // có thể fire trong vòng <500ms gây 2 lần init duplicate
  let _requestProjectContextTimer = null;
  let _requestProjectContextInflight = null;
  async function _requestProjectContext() {
    // Nếu đang in-flight → return same promise (dedup concurrent)
    if (_requestProjectContextInflight) return _requestProjectContextInflight;
    // Nếu vừa fire trong 500ms gần đây → reject duplicate
    if (_requestProjectContextTimer) return;
    _requestProjectContextTimer = setTimeout(() => { _requestProjectContextTimer = null; }, 500);

    _requestProjectContextInflight = (async () => {
      try {
        return await _requestProjectContextImpl();
      } finally {
        _requestProjectContextInflight = null;
      }
    })();
    return _requestProjectContextInflight;
  }

  // U-1.5: Yêu cầu project context từ content.js
  async function _requestProjectContextImpl() {
    // Helper: xử lý response từ content.js
    // tabId: ID của tab mà response đến từ (để track target tab)
    function _handleProjectResponse(resp, tabId = null, tabTitle = null) {
      _projectContextResolved = true;
      _hideConnectingOverlay();
      if (resp?.projectId) {
        window._currentProjectId = resp.projectId;
        // Project name resolution chain:
        // 1. extractProjectName() từ DOM header input
        // 2. document.title parsing (từ content.js)
        // 3. Chrome tab.title parsing (từ caller)
        // 4. null (sẽ fallback trong _saveProjectToList)
        let projectName = resp.projectName || null;
        if (!projectName) {
          projectName = _extractProjectNameFromTitle(resp.documentTitle || tabTitle);
        }
        window._currentProjectName = projectName;
        // CRITICAL: Lưu tabId để MessageBridge gửi message đến đúng tab
        if (tabId) {
          window._targetFlowTabId = tabId;
          window.MessageBridge?.setTargetTabId?.(tabId);
          console.log('[TobyFlow] Target Flow tab set:', tabId, 'Project:', resp.projectId, 'Name:', projectName);
          // Apply Flow page settings sớm (Grid view + show tile details) — 1-time per tab session
          window.MessageBridge?.sendToContentScript?.('applyFlowPageSettings', {}).catch(() => {});
        }
        _saveProjectToList(resp.projectId, projectName);
        _hideProjectSelectOverlay();
        _updateProjectIndicator();
        _setProjectNavigating(false);
      } else {
        // Home page hoặc không có project → show overlay (trừ khi đang retry)
        window._currentProjectId = null;
        window._currentProjectName = null;
        // Vẫn track tab active để có thể gửi message (dù không có project)
        if (tabId) {
          window._targetFlowTabId = tabId;
          window.MessageBridge?.setTargetTabId?.(tabId);
          // Apply Flow page settings sớm — 1-time per tab session
          window.MessageBridge?.sendToContentScript?.('applyFlowPageSettings', {}).catch(() => {});
        }
        _updateProjectIndicator();
        // CRITICAL: Chỉ show overlay nếu KHÔNG đang trong quá trình retry
        // (để tránh show overlay khi content.js chưa sẵn sàng)
        if (!_isInitialRetrying) {
          _showProjectSelectOverlay();
        }
      }
    }

    try {
      // Gửi message tới tất cả Flow tabs — tìm tab có project
      const tabs = await chrome.tabs.query({ url: window.ProviderConfigManager?.getTabQuery('flow') });
      if (tabs.length === 0) {
        window._targetFlowTabId = null;
        _handleProjectResponse(null);
        return;
      }

      // Tìm active Flow tab trước, sau đó fallback các tab khác
      const activeTab = tabs.find(t => t.active) || tabs[0];
      const orderedTabs = [activeTab, ...tabs.filter(t => t.id !== activeTab.id)];

      let foundProject = false;
      for (const tab of orderedTabs) {
        try {
          const resp = await new Promise((resolve) => {
            chrome.tabs.sendMessage(tab.id, { action: 'getProjectContext' }, (r) => {
              if (chrome.runtime.lastError) resolve(null);
              else resolve(r);
            });
          });
          if (resp?.projectId) {
            _handleProjectResponse(resp, tab.id, tab.title); // Truyền tabId + title fallback
            foundProject = true;
            break;
          }
        } catch (e) {}
      }

      // Không tab nào có project → dùng active tab
      if (!foundProject) {
        window._targetFlowTabId = activeTab.id;
        _handleProjectResponse(null, activeTab.id);
      }
    } catch (e) {
      // sidePanel context might not have chrome.tabs — use background.js
      try {
        chrome.runtime.sendMessage({ action: 'getFlowProjectContext' }, (resp) => {
          if (chrome.runtime.lastError) {
            _handleProjectResponse(null);
            return;
          }
          // background.js trả về cả tabId + tabTitle
          _handleProjectResponse(resp, resp?.tabId || null, resp?.tabTitle || null);
        });
      } catch (e2) {
        _handleProjectResponse(null);
      }
    }
  }

  // Retry _requestProjectContext after navigation to confirm sidebar state
  // CRITICAL: Chỉ retry nếu chưa có currentProjectId (content.js có thể chưa sẵn sàng)
  // firstCallImmediate: gọi ngay lần đầu (không delay), chỉ delay cho retry sau
  // suppressOverlay: true → không show overlay cho đến khi hết retry (dùng cho init)
  function _requestProjectContextWithRetry(maxRetries = 3, delayMs = 1500, firstCallImmediate = false, suppressOverlay = false) {
    let attempt = 0;
    // Nếu suppressOverlay, đặt flag để _handleProjectResponse không show overlay
    if (suppressOverlay) {
      _isInitialRetrying = true;
    }
    const tryRequest = async () => {
      attempt++;
      await _requestProjectContext();
      // Chỉ retry nếu vẫn chưa có project (content.js có thể chưa ready)
      if (!window._currentProjectId && attempt < maxRetries) {
        setTimeout(() => tryRequest(), delayMs);
      } else {
        // Hết retry hoặc đã tìm thấy project
        if (suppressOverlay) {
          _isInitialRetrying = false;
          _hideConnectingOverlay();
          // Nếu vẫn không có project sau khi hết retry → show overlay ngay
          if (!window._currentProjectId) {
            _showProjectSelectOverlay();
          }
        }
        // Safety: clear navigating state sau khi hết retries
        _setProjectNavigating(false);
      }
    };
    if (firstCallImmediate) {
      tryRequest();
    } else {
      setTimeout(() => tryRequest(), delayMs);
    }
  }

  // U-4.5: Project select overlay
  async function _showProjectSelectOverlay() {
    const container = document.getElementById('sidebar-content') || document.body;
    // Kiểm tra đã có overlay chưa
    if (container.querySelector('.project-select-overlay')) return;

    // [Layer 1] DEFENSIVE GUARD + check Flow tab availability
    // 3 case:
    //   1. CÓ Flow project tab → sync state silent + ABORT show modal
    //   2. CÓ Flow homepage tab (no project) → render modal Select project bình thường
    //   3. KHÔNG có Flow tab nào → ABORT show modal (overlay "Chưa mở Google Flow" sẽ handle)
    try {
      if (chrome.tabs?.query) {
        const tabs = await chrome.tabs.query({ url: window.ProviderConfigManager?.getTabQuery('flow') });
        // Case 3: không có Flow tab → skip show modal (để overlay "Chưa mở Flow" handle)
        if (tabs.length === 0) {
          console.log('[TobyFlow] _showProjectSelectOverlay aborted: no Flow tab open');
          return;
        }
        // Case 1: có project tab → sync + abort
        for (const tab of tabs) {
          const projectId = tab.url?.match(/\/project\/([a-f0-9-]+)/)?.[1];
          if (projectId) {
            if (window._currentProjectId !== projectId) {
              console.log('[TobyFlow] _showProjectSelectOverlay aborted: defensive guard found project', projectId);
              window._currentProjectId = projectId;
              window._targetFlowTabId = tab.id;
              window.MessageBridge?.setTargetTabId?.(tab.id);
              _updateProjectIndicator();
            }
            return;  // Skip show overlay
          }
        }
        // Case 2: có Flow tab nhưng homepage → tiếp tục render modal
      }
    } catch (e) { /* fail open — tiếp tục show */ }

    const result = await chrome.storage.local.get('af_projects');
    let projects = result.af_projects || {};

    // Sync project list từ Flow homepage tab — chạy 1 lần khi modal mở.
    // Helper show/hide loading indicator trong modal header.
    const _setSyncingUI = (overlayEl, isSyncing) => {
      if (!overlayEl || !overlayEl.isConnected) return;
      const indicator = overlayEl.querySelector('.project-select-syncing');
      if (indicator) indicator.style.display = isSyncing ? 'inline-flex' : 'none';
    };
    const _asyncScanFlowProjects = window._asyncScanFlowProjects = async (overlayEl, force = false) => {
      // [ANTI-LOOP] 3 lớp guard:
      //   1. _modalScanInProgress: block concurrent — modal mở/đóng nhanh không spawn 2 scan
      //   2. _lastModalScanTime: cooldown 10s — modal mở/đóng/mở liên tục không re-scan
      //      (force=true bypass cooldown — user explicit click resync button)
      //   3. abort khi overlay disconnected (modal đóng giữa chừng → skip update)
      if (window._modalScanInProgress) {
        console.log('[TobyFlow] scanFlowProjects SKIP: already in progress');
        _setSyncingUI(overlayEl, false);
        return;
      }
      const now = Date.now();
      const MODAL_SCAN_COOLDOWN_MS = 10000;
      if (!force && window._lastModalScanTime && (now - window._lastModalScanTime < MODAL_SCAN_COOLDOWN_MS)) {
        const remainSec = Math.ceil((MODAL_SCAN_COOLDOWN_MS - (now - window._lastModalScanTime)) / 1000);
        console.log('[TobyFlow] scanFlowProjects SKIP: cooldown', remainSec + 's remaining (use resync button to force)');
        _setSyncingUI(overlayEl, false);
        return;
      }
      window._modalScanInProgress = true;
      window._lastModalScanTime = now;
      if (force) console.log('[TobyFlow] scanFlowProjects FORCE: resync button clicked');
      try {
        if (!chrome.tabs?.query) return;
        const flowTabs = await chrome.tabs.query({ url: window.ProviderConfigManager?.getTabQuery('flow') });
        if (flowTabs.length === 0) return;
        const homeTab = flowTabs.find(t => t.url && !t.url.match(/\/project\/[a-f0-9-]+/));
        const scanTab = homeTab || flowTabs[0];
        // Show loading indicator
        _setSyncingUI(overlayEl, true);
        const scanResult = await Promise.race([
          new Promise((resolve) => {
            chrome.tabs.sendMessage(scanTab.id, { action: 'scanFlowProjects' }, (r) => {
              if (chrome.runtime.lastError) resolve(null);
              else resolve(r);
            });
          }),
          new Promise((resolve) => setTimeout(() => resolve(null), 3000))
        ]);
        if (!scanResult?.projects?.length) {
          _setSyncingUI(overlayEl, false);
          return;
        }

        // Re-read storage (có thể đã thay đổi)
        const freshResult = await chrome.storage.local.get('af_projects');
        const freshProjects = freshResult.af_projects || {};
        const flowProjectIds = new Set(scanResult.projects.map(p => p.id));
        let changed = false;

        if (scanResult.isHomePage) {
          for (const [id, data] of Object.entries(freshProjects)) {
            if (!flowProjectIds.has(id)) {
              if (!data._notOnFlow) { freshProjects[id] = { ...data, _notOnFlow: true }; changed = true; }
            } else if (data._notOnFlow) {
              delete freshProjects[id]._notOnFlow; changed = true;
            }
          }
        }
        for (const proj of scanResult.projects) {
          if (!freshProjects[proj.id]) {
            freshProjects[proj.id] = {
              name: proj.name || proj.id.substring(0, 8),
              last_accessed: Date.now(),
              flowOrder: proj.flowOrder,  // DOM order trên Flow homepage
            };
            changed = true;
          } else {
            // Update name nếu Flow đã rename
            if (proj.name && freshProjects[proj.id].name !== proj.name) {
              freshProjects[proj.id].name = proj.name;
              changed = true;
            }
            // ALWAYS update flowOrder mỗi lần scan (Flow re-sort khi modify project)
            if (typeof proj.flowOrder === 'number' && freshProjects[proj.id].flowOrder !== proj.flowOrder) {
              freshProjects[proj.id].flowOrder = proj.flowOrder;
              changed = true;
            }
          }
        }
        if (!changed) {
          _setSyncingUI(overlayEl, false);
          return;
        }
        await chrome.storage.local.set({ af_projects: freshProjects });

        // Update overlay list nếu vẫn còn trên DOM
        if (!overlayEl || !overlayEl.isConnected) {
          _setSyncingUI(overlayEl, false);
          return;
        }
        const listEl = overlayEl.querySelector('.project-select-list');
        const countEl = overlayEl.querySelector('.project-select-search-count');
        if (!listEl) {
          _setSyncingUI(overlayEl, false);
          return;
        }

        // Sort theo flowOrder ASC (preserve thứ tự Flow homepage), fallback last_accessed DESC
        const updatedSorted = Object.entries(freshProjects)
          .sort(([, a], [, b]) => {
            const aHasOrder = typeof a.flowOrder === 'number';
            const bHasOrder = typeof b.flowOrder === 'number';
            if (aHasOrder && bHasOrder) return a.flowOrder - b.flowOrder;
            if (aHasOrder) return -1;  // có flowOrder → ưu tiên lên đầu
            if (bHasOrder) return 1;
            return (b.last_accessed || 0) - (a.last_accessed || 0);  // fallback
          });
        listEl.innerHTML = updatedSorted.map(([id, data]) => _buildProjectItemHTML(id, data)).join('');
        if (countEl) countEl.textContent = `${updatedSorted.length}`;
        // Hide loading + show synced indicator briefly
        const indicator = overlayEl.querySelector('.project-select-syncing');
        if (indicator) {
          indicator.innerHTML = '<span style="color: #10b981;">✓</span> ' + (window.I18n?.t('project.synced') || 'Đã đồng bộ');
          setTimeout(() => _setSyncingUI(overlayEl, false), 1500);
        }
      } catch (err) {
        console.warn('[TobyFlow] async scanFlowProjects failed:', err.message);
        _setSyncingUI(overlayEl, false);
      } finally {
        // [ANTI-LOOP] release flag dù success hay fail — đảm bảo modal sau có thể scan
        window._modalScanInProgress = false;
      }
    };

    // Sort theo flowOrder ASC (preserve Flow homepage order), fallback last_accessed DESC
    const sorted = Object.entries(projects)
      .sort(([, a], [, b]) => {
        const aHasOrder = typeof a.flowOrder === 'number';
        const bHasOrder = typeof b.flowOrder === 'number';
        if (aHasOrder && bHasOrder) return a.flowOrder - b.flowOrder;
        if (aHasOrder) return -1;
        if (bHasOrder) return 1;
        return (b.last_accessed || 0) - (a.last_accessed || 0);
      });

    const overlay = document.createElement('div');
    overlay.className = 'project-select-overlay';

    // Build compact project item HTML (single row: name + date inline)
    function _buildProjectItemHTML(id, data) {
      const date = data.last_accessed ? window.I18n?.formatDate?.(data.last_accessed) || new Date(data.last_accessed).toLocaleDateString() : '';
      const name = data.name || id.substring(0, 8);
      const staleClass = data._notOnFlow ? ' project-select-item--stale' : '';
      const staleSuffix = data._notOnFlow ? ` · ${I18n.t('project.maybeDeleted')}` : '';
      return `<div class="project-select-item${staleClass}" data-project-id="${id}" data-project-name="${(name || '').toLowerCase()}" title="${name}${date ? ' — ' + date : ''}">
        <div class="project-select-item-info">
          <span class="project-select-name">${name}</span>
          ${date ? `<span class="project-select-date">${date}${staleSuffix}</span>` : ''}
        </div>
        <button class="project-select-item-delete" data-delete-id="${id}" title="${I18n.t('common.delete')}">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
        </button>
      </div>`;
    }

    const hasProjects = sorted.length > 0;

    overlay.innerHTML = `
      <div class="project-select-content">
        <div class="project-select-header" style="display: flex; align-items: flex-start; gap: 10px;">
          <svg class="project-select-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
          </svg>
          <div class="project-select-header-text" style="flex: 1; min-width: 0;">
            <div class="project-select-title">
              ${I18n.t('project.selectTitle')}
              <span class="project-select-syncing" style="display: none; margin-left: 8px; font-size: 11px; font-weight: 400; color: rgba(255,255,255,0.6); align-items: center; gap: 4px;">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="animation: spin 1s linear infinite;">
                  <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
                </svg>
                ${I18n.t('project.syncing') || 'Đang đồng bộ...'}
              </span>
            </div>
            <div class="project-select-desc">${I18n.t('project.selectDesc')}</div>
          </div>
          <button class="project-select-resync" type="button"
                  title="${I18n.t('project.resync') || 'Đồng bộ lại'}"
                  style="flex-shrink: 0; width: 28px; height: 28px; display: inline-flex; align-items: center; justify-content: center;
                         background: transparent; border: 1px solid rgba(255,255,255,0.12); border-radius: 6px;
                         color: rgba(255,255,255,0.65); cursor: pointer; transition: all 0.15s;">
            <svg class="project-select-resync-icon" width="14" height="14" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="23 4 23 10 17 10"></polyline>
              <polyline points="1 20 1 14 7 14"></polyline>
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
            </svg>
          </button>
        </div>
        <div class="project-select-search-wrap">
          <svg class="project-select-search-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line>
          </svg>
          <input type="text" class="project-select-search" placeholder="${I18n.t('project.searchPlaceholder')}" autocomplete="off" spellcheck="false" />
          ${hasProjects ? `<span class="project-select-search-count">${sorted.length}</span>` : ''}
        </div>
        <div class="project-select-list">
          ${hasProjects
            ? sorted.map(([id, data]) => _buildProjectItemHTML(id, data)).join('')
            : `<div class="project-select-empty">
                <p>${I18n.t('project.emptyMsg')}</p>
              </div>`}
        </div>
        <div class="project-select-actions">
          <button class="project-select-create-btn">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
            ${I18n.t('project.createNew')}
          </button>
        </div>
      </div>`;

    // Search filter — always active
    {
      const searchInput = overlay.querySelector('.project-select-search');
      const countEl = overlay.querySelector('.project-select-search-count');
      const listEl = overlay.querySelector('.project-select-list');
      let _searchTimeout = null;

      // Virtual scroll: render items in batches for large lists
      const BATCH_SIZE = 30;
      let _renderedCount = Math.min(sorted.length, BATCH_SIZE);
      let _currentQuery = '';

      // Lazy render more items on scroll
      if (sorted.length > BATCH_SIZE) {
        // Initially render only first batch
        const items = listEl.querySelectorAll('.project-select-item[data-project-id]');
        items.forEach((item, idx) => {
          if (idx >= BATCH_SIZE) item.style.display = 'none';
        });

        listEl.addEventListener('scroll', () => {
          if (_currentQuery) return; // Search active — all items managed by filter
          const { scrollTop, scrollHeight, clientHeight } = listEl;
          if (scrollTop + clientHeight >= scrollHeight - 40 && _renderedCount < sorted.length) {
            const items = listEl.querySelectorAll('.project-select-item[data-project-id]');
            const nextBatch = Math.min(_renderedCount + BATCH_SIZE, sorted.length);
            for (let i = _renderedCount; i < nextBatch; i++) {
              if (items[i]) items[i].style.display = '';
            }
            _renderedCount = nextBatch;
          }
        }, { passive: true });
      }

      searchInput?.addEventListener('input', () => {
        clearTimeout(_searchTimeout);
        _searchTimeout = setTimeout(() => {
          const query = (searchInput.value || '').toLowerCase().trim();
          _currentQuery = query;
          const items = listEl.querySelectorAll('.project-select-item[data-project-id]');
          let visibleCount = 0;
          items.forEach(item => {
            const name = item.dataset.projectName || '';
            const match = !query || name.includes(query);
            item.style.display = match ? '' : 'none';
            if (match) visibleCount++;
          });
          if (countEl) countEl.textContent = query ? `${visibleCount}/${sorted.length}` : `${sorted.length}`;
          // Reset virtual scroll when search cleared
          if (!query && sorted.length > BATCH_SIZE) {
            _renderedCount = BATCH_SIZE;
            items.forEach((item, idx) => {
              item.style.display = idx < BATCH_SIZE ? '' : 'none';
            });
          }
          // Show/hide empty state
          let emptyEl = listEl.querySelector('.project-select-empty');
          if (visibleCount === 0 && query) {
            if (!emptyEl) {
              emptyEl = document.createElement('div');
              emptyEl.className = 'project-select-empty';
              emptyEl.innerHTML = `<p>${I18n.t('project.noMatch')}</p>`;
              listEl.appendChild(emptyEl);
            }
            emptyEl.style.display = '';
          } else if (emptyEl) {
            emptyEl.style.display = visibleCount > 0 ? 'none' : '';
          }
        }, 150);
      });
    }

    // Delete handlers (event delegation)
    const listContainer = overlay.querySelector('.project-select-list');
    listContainer?.addEventListener('click', async (e) => {
      const delBtn = e.target.closest('.project-select-item-delete');
      if (delBtn) {
        e.stopPropagation();
        const deleteId = delBtn.dataset.deleteId;
        await _removeProjectFromList(deleteId);
        delBtn.closest('.project-select-item').remove();
        // Update count
        const countEl = overlay.querySelector('.project-select-search-count');
        const remainingItems = listContainer.querySelectorAll('.project-select-item[data-project-id]');
        if (countEl) countEl.textContent = `${remainingItems.length}`;
        // Nếu list rỗng, update
        if (remainingItems.length === 0) {
          listContainer.innerHTML = `<div class="project-select-empty"><p>${I18n.t('project.emptyMsg')}</p></div>`;
        }
        return;
      }

      // Project click handler
      const item = e.target.closest('.project-select-item[data-project-id]');
      if (!item || _projectNavigating) return;
      _setProjectNavigating(true);
      const projectId = item.dataset.projectId;
      const projectData = projects[projectId];
      const projectName = projectData?.name || projectId.substring(0, 8);

      // Cập nhật state + ẩn overlay ngay
      const oldId = window._currentProjectId;
      window._currentProjectId = projectId;
      window._currentProjectName = projectName;
      _updateProjectIndicator();
      _saveProjectToList(projectId, projectName);
      _hideProjectSelectOverlay();

      // Emit event để các tab reload data
      if (oldId !== projectId) {
        window.eventBus?.emit('project:changed', { projectId, projectName });
      }

      // Group C/Initiative 7: base URL từ ProviderConfigManager
      const _flowBase2 = window.ProviderConfigManager?.getBaseUrlSync('flow');
      chrome.runtime.sendMessage({
        action: 'navigateToProject',
        url: `${_flowBase2}/project/${projectId}`,
        projectId
      });

      // Retry xác nhận context sau navigation
      _requestProjectContextWithRetry(3, 1500);
    });

    const createOverlayBtn = overlay.querySelector('.project-select-create-btn');
    if (createOverlayBtn) {
      createOverlayBtn.addEventListener('click', () => {
        _hideProjectSelectOverlay();
        _createNewProject();
      });
    }

    // Bỏ button "Open Flow" — modal chỉ show khi đã có Flow tab (xem Layer 1 guard ở đầu function)

    // Resync button — bypass cooldown, force scan ngay khi user click
    const resyncBtn = overlay.querySelector('.project-select-resync');
    if (resyncBtn) {
      resyncBtn.addEventListener('mouseenter', () => {
        resyncBtn.style.background = 'rgba(255,255,255,0.05)';
        resyncBtn.style.color = 'rgba(255,255,255,0.9)';
      });
      resyncBtn.addEventListener('mouseleave', () => {
        resyncBtn.style.background = 'transparent';
        resyncBtn.style.color = 'rgba(255,255,255,0.65)';
      });
      resyncBtn.addEventListener('click', () => {
        // Spin icon khi đang sync
        const icon = resyncBtn.querySelector('.project-select-resync-icon');
        if (icon) icon.style.animation = 'spin 0.8s linear infinite';
        resyncBtn.disabled = true;
        // Force bypass cooldown — user explicit request
        _asyncScanFlowProjects(overlay, /*force=*/true).finally(() => {
          if (icon) icon.style.animation = '';
          resyncBtn.disabled = false;
        });
      });
    }

    container.appendChild(overlay);

    // Auto-focus search
    setTimeout(() => overlay.querySelector('.project-select-search')?.focus(), 100);

    // Fire-and-forget: scan Flow homepage để sync project list (auto khi modal mở)
    _asyncScanFlowProjects(overlay);
  }

  function _hideProjectSelectOverlay() {
    const overlay = document.querySelector('.project-select-overlay');
    if (overlay) overlay.remove();
  }

  // Export for other modules
  window._showProjectSelectOverlay = _showProjectSelectOverlay;
  window._hideProjectSelectOverlay = _hideProjectSelectOverlay;
  window._requestProjectContext = _requestProjectContext;

  // Helper: scan Flow projects từ homepage tab + update af_projects storage.
  // Standalone version (không update overlay UI). Dùng cho Layer 2 periodic poll khi
  // detect homepage tab. Cooldown để tránh spam scan.
  // Anti-loop: trả false nếu skip do cooldown; chỉ update storage khi data CHANGED.
  let _scanFlowProjectsCooldown = 0;
  const SCAN_FLOW_PROJECTS_COOLDOWN_MS = 30000;  // 30s giữa 2 lần scan
  async function _scanAndUpdateFlowProjects(scanTabId, force = false) {
    const now = Date.now();
    if (!force && now < _scanFlowProjectsCooldown) return false;
    _scanFlowProjectsCooldown = now + SCAN_FLOW_PROJECTS_COOLDOWN_MS;

    try {
      const scanResult = await Promise.race([
        new Promise((resolve) => {
          chrome.tabs.sendMessage(scanTabId, { action: 'scanFlowProjects' }, (r) => {
            if (chrome.runtime.lastError) resolve(null);
            else resolve(r);
          });
        }),
        new Promise((resolve) => setTimeout(() => resolve(null), 3000))
      ]);
      if (!scanResult?.projects) return false;

      const freshResult = await chrome.storage.local.get('af_projects');
      const freshProjects = freshResult.af_projects || {};
      const flowProjectIds = new Set(scanResult.projects.map(p => p.id));
      let changed = false;

      // Mark _notOnFlow cho projects KHÔNG còn trong Flow homepage list
      // Restore khi xuất hiện trở lại
      if (scanResult.isHomePage) {
        for (const [id, data] of Object.entries(freshProjects)) {
          if (!flowProjectIds.has(id) && id !== window._currentProjectId) {
            if (!data._notOnFlow) {
              freshProjects[id] = { ...data, _notOnFlow: Date.now() };
              changed = true;
            }
          } else if (data._notOnFlow && flowProjectIds.has(id)) {
            delete freshProjects[id]._notOnFlow;
            changed = true;
          }
        }
      }
      // Add/update projects có trên Flow
      for (const proj of scanResult.projects) {
        if (!freshProjects[proj.id]) {
          freshProjects[proj.id] = {
            name: proj.name || proj.id.substring(0, 8),
            last_accessed: Date.now(),
          };
          changed = true;
        } else if (proj.name && freshProjects[proj.id].name !== proj.name) {
          freshProjects[proj.id].name = proj.name;
          changed = true;
        }
      }
      if (changed) {
        await chrome.storage.local.set({ af_projects: freshProjects });
        console.log('[TobyFlow] Auto-scan Flow projects: updated storage with', scanResult.projects.length, 'projects');
        _updateProjectIndicator();
      }
      return true;
    } catch (e) {
      console.warn('[TobyFlow] Auto-scan Flow projects failed:', e?.message);
      return false;
    }
  }
  window._scanAndUpdateFlowProjects = _scanAndUpdateFlowProjects;

  // [Layer 2] Periodic re-sync project context với Flow tab URL realtime.
  // Self-heal khi state lệch (event miss, race condition, sidepanel suspended).
  // Anti-loop: chỉ trigger update khi state ACTUAL ≠ EXPECTED.
  // Cooldown 1s giữa 2 lần thực sự run (poll mỗi 3s nhưng skip nếu < 1s từ lần trước).
  let _projectSyncCooldown = 0;
  const PROJECT_SYNC_INTERVAL_MS = 3000;
  setInterval(async () => {
    if (!chrome.tabs?.query) return;
    const now = Date.now();
    if (now < _projectSyncCooldown) return;
    _projectSyncCooldown = now + 1000;
    try {
      const tabs = await chrome.tabs.query({ url: window.ProviderConfigManager?.getTabQuery('flow') });
      let projectFound = null;
      for (const tab of tabs) {
        const m = tab.url?.match(/\/project\/([a-f0-9-]+)/);
        if (m) { projectFound = { id: m[1], tab }; break; }
      }
      const overlayVisible = !!document.querySelector('.project-select-overlay');

      if (projectFound && overlayVisible) {
        console.log('[TobyFlow] Periodic re-sync: hide stale overlay, project=', projectFound.id);
        if (window._currentProjectId !== projectFound.id) {
          window._currentProjectId = projectFound.id;
          window._targetFlowTabId = projectFound.tab.id;
          window.MessageBridge?.setTargetTabId?.(projectFound.tab.id);
        }
        _hideProjectSelectOverlay();
        _updateProjectIndicator();
      } else if (!projectFound && tabs.length === 0 && window._currentProjectId) {
        console.log('[TobyFlow] Periodic re-sync: no Flow tab, clear stale project state');
        window._currentProjectId = null;
        window._currentProjectName = null;
        _updateProjectIndicator();
      } else if (projectFound && window._currentProjectId !== projectFound.id) {
        console.log('[TobyFlow] Periodic re-sync: state out of sync, update to', projectFound.id);
        window._currentProjectId = projectFound.id;
        window._targetFlowTabId = projectFound.tab.id;
        window.MessageBridge?.setTargetTabId?.(projectFound.tab.id);
        _updateProjectIndicator();
      }
    } catch (e) { /* ignore */ }
  }, PROJECT_SYNC_INTERVAL_MS);

  // Global pending upload cache (fallback nếu PendingUploadStore chưa restore)
  if (!window.pendingUploadFiles) window.pendingUploadFiles = new Map();
  if (!window.uploadedFileCache) window.uploadedFileCache = new Map();

  // uploadPendingFiles & reuploadMissingFiles: đã chuyển sang FileUploader.js (shared giữa sidebar + workflow popup)

  // Khởi tạo khi DOM ready - with loading state management (I-2)
  async function init() {
    log('Initializing...');

    // Phase 2: Run storage migration (remove deprecated keys, cleanup)
    try { window.StorageMigration?.run?.(); } catch (e) { console.warn('[init] StorageMigration error:', e.message); }

    // Phase 2: Pre-fetch ExecutionConfig from server (background, không block init)
    try { window.ExecutionConfig?.getConfig?.(); } catch (e) { /* ignore */ }

    // ─────────────────────────────────────────────────────────────────────────
    // Fix 429 Race Condition (Option C Enhanced):
    // Background.js fetches configs on install/startup và signal `_tobyConfigsReady`.
    // Sidebar check signal trước khi gọi PCM fetch → nếu fresh (<30s) skip fetch,
    // PCM sẽ đọc từ chrome.storage cache (đã được background warm).
    // Nếu stale/missing → delegate fetch cho background qua message.
    // ─────────────────────────────────────────────────────────────────────────
    const _CONFIGS_READY_KEY = '_tobyConfigsReady';
    const _CONFIGS_READY_TTL_MS = 30000; // 30s
    let _skipPcmFetch = false;
    try {
      const stored = await new Promise(r => chrome.storage.local.get([_CONFIGS_READY_KEY], r));
      const readyAt = stored?.[_CONFIGS_READY_KEY] || 0;
      if (Date.now() - readyAt < _CONFIGS_READY_TTL_MS) {
        _skipPcmFetch = true;
        log('Configs warm from background (skip sidebar fetch)');
      } else {
        // Delegate fetch to background (centralized, avoid duplicate)
        try {
          await new Promise((resolve, reject) => {
            chrome.runtime.sendMessage({ action: 'FETCH_CONFIGS_IF_NEEDED' }, (resp) => {
              if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
              else resolve(resp);
            });
          });
          _skipPcmFetch = true;
          log('Configs fetched via background delegation');
        } catch (e) {
          log('Background fetch delegation failed, sidebar will fetch:', e.message);
        }
      }
    } catch (e) { /* ignore — sidebar will fetch as fallback */ }

    // Fetch ChatGPT + Grok error patterns from admin (background, không block init).
    // Cache 1h vào chrome.storage.local.af_chatgpt_config + af_grok_config →
    // content script chatgpt.com / grok.com đọc patterns runtime.
    try { window.ChatGPTConfig?.fetchInBackground?.(); } catch (e) { /* ignore */ }
    try { window.GrokConfig?.fetchInBackground?.(); } catch (e) { /* ignore */ }
    // PCM fetch: skip nếu background đã warm cache
    if (!_skipPcmFetch) {
      try { window.ProviderConfigManager?.fetchInBackground?.(); } catch (e) { /* ignore */ }
      try { window.ProviderConfigManager?._fetchApiConfigs?.().catch(() => {}); } catch (e) { /* ignore */ }
    }
    // ProviderMeta: fetch data here (warm cache), but init() with SSE listener later after eventBus is created
    try { window.ProviderMeta?.fetch?.(); } catch (e) { /* ignore */ }

    // Phase 3: Bridge URLs cache to background.js sau khi api_configs fetch xong.
    // Background.js (service worker) không import PCM nên cần bridge qua chrome.storage.session.
    try {
      const pcm = window.ProviderConfigManager;
      if (pcm?._apiConfigsCache?.data) {
        const urlsCache = {};
        for (const [slug, cfg] of Object.entries(pcm._apiConfigsCache.data)) {
          if (cfg?.configs?.urls) {
            urlsCache[slug] = cfg.configs.urls;
          }
        }
        if (Object.keys(urlsCache).length > 0) {
          chrome.runtime?.sendMessage?.({ action: 'updateProviderUrlsCache', data: urlsCache }).catch(() => {});
        }
      }
    } catch (e) { /* ignore */ }

    // Phase 3: Mandatory config prefetch với error handling.
    // Nếu tất cả configs fetch thành công → tiếp tục init.
    // Nếu fail và cache expired → ConfigErrorHandler sẽ hiện overlay.
    try {
      await Promise.all([
        window.ProviderConfigManager?.fetchMandatory?.('api_configs').catch(e => {
          if (window.ConfigRequiredError?.is?.(e)) {
            console.warn('[init] Phase 3: api_configs mandatory fetch failed');
          }
          return null;
        }),
        window.ModelRegistry?.fetchMandatory?.().catch(e => {
          if (window.ConfigRequiredError?.is?.(e)) {
            console.warn('[init] Phase 3: models mandatory fetch failed');
          }
          return null;
        }),
        // Flow Voice Selector — fetch base catalog (graceful: empty array nếu fail) +
        // init cross-context sync (chrome.storage.onChanged listener) để nhận update
        // realtime khi settings.html click Resync trong window/tab khác.
        (() => {
          window.VoiceRegistry?.initCrossContextSync?.();
          return window.VoiceRegistry?.getBaseCatalog?.('flow').catch(e => {
            console.warn('[init] VoiceRegistry base catalog fetch failed:', e.message);
            return null;
          });
        })(),
      ]);
    } catch (e) { /* ignore aggregate error */ }

    const overlay = document.getElementById('tobyflow-loading-overlay');
    const loadingText = document.getElementById('tobyflow-loading-text');

    // Helper: update loading text
    function setLoadingText(text) {
      if (loadingText) loadingText.textContent = text;
    }

    // Helper: hide loading overlay with fade
    function hideLoadingOverlay() {
      if (overlay) {
        overlay.classList.add('tobyflow-loading-overlay--hidden');
        setTimeout(() => overlay.remove(), 300);
      }
    }

    // Check offline state (I-2) - Show full overlay when offline
    const offlineOverlay = document.getElementById('tobyflow-offline-overlay');
    const offlineRetryBtn = document.getElementById('tobyflow-offline-retry-btn');

    // Fix 2026-05-17: Auto-hide khi server up lại (không cần user click Retry).
    // Trước fix: `online` event chỉ fire khi BROWSER mất/có Internet → server down mà Internet OK
    // → overlay show mãi cho đến khi user click Retry manually.
    // Sau fix: khi overlay show, start polling ServerHealthCheck mỗi 10s; server reachable → tự hide.
    let _offlineHealthPollInterval = null;
    const _OFFLINE_HEALTH_POLL_MS = 10000; // 10s

    function showOfflineOverlay() {
      if (offlineOverlay) {
        offlineOverlay.classList.remove('hidden');
      }
      // Start polling server health — auto hide khi server up lại
      if (_offlineHealthPollInterval) return; // already polling
      _offlineHealthPollInterval = setInterval(async () => {
        if (!navigator.onLine) return; // skip nếu browser offline (online event sẽ trigger sau)
        try {
          window.ServerHealthCheck?.reset(); // bypass 30s cache để check fresh
          const isHealthy = await checkServerConnection();
          if (isHealthy) {
            console.log('[App] Server reachable lại → auto hide offline overlay');
            hideOfflineOverlay();
            // Refresh entitlements + configs để UI sync state mới
            try { await window.featureGate?.refresh?.(); } catch (_) {}
          }
        } catch (_) { /* silent — next poll sẽ retry */ }
      }, _OFFLINE_HEALTH_POLL_MS);
      console.log('[App] Offline overlay shown — started health polling every', _OFFLINE_HEALTH_POLL_MS, 'ms');
    }

    function hideOfflineOverlay() {
      if (offlineOverlay) {
        offlineOverlay.classList.add('hidden');
      }
      // Stop polling khi overlay đã ẩn
      if (_offlineHealthPollInterval) {
        clearInterval(_offlineHealthPollInterval);
        _offlineHealthPollInterval = null;
        console.log('[App] Offline overlay hidden — stopped health polling');
      }
    }

    // ─────────────────────────────────────────────────────────────────────
    // Anti-clone overlay: hiển thị khi background detect 403 EXTENSION_NOT_AUTHORIZED.
    // Text i18n do clone-detected-i18n.js (early) + I18n class (sau, data-i18n) handle —
    // không hardcode labels ở đây. Storage flag persist qua reload.
    // ─────────────────────────────────────────────────────────────────────
    const cloneDetectedOverlay = document.getElementById('tobyflow-clone-detected-overlay');
    function _showCloneDetectedOverlay() { return;
      if (!cloneDetectedOverlay) return;
      cloneDetectedOverlay.classList.remove('hidden');
      // Set store URL từ system config (extension_url) hoặc fallback Chrome Web Store.
      // KHÔNG hiển thị chrome.runtime.id — tránh gợi ý attacker biết ID hợp lệ để giả.
      const storeBtn = document.getElementById('tobyflow-clone-detected-store-btn');
      if (storeBtn && !storeBtn.href) {
        try {
          const cfg = window.SystemConfig?.getAppConfig?.() || {};
          storeBtn.href = cfg.extension_url || 'https://chromewebstore.google.com/';
        } catch (_) {
          storeBtn.href = 'https://chromewebstore.google.com/';
        }
      }
      console.error('[App] 🛡️ Clone-detected overlay shown — extension not authorized');
    }
    function _hideCloneDetectedOverlay() {
      if (cloneDetectedOverlay) cloneDetectedOverlay.classList.add('hidden');
    }

    // 1. Check sau 800ms — đợi background self-heal probe chạy trước (immediate on load).
    // Nếu admin vừa tắt toggle → probe sẽ clear flag trong < 500ms → tránh flicker overlay.
    // Sau 800ms vẫn còn flag = thực sự bị reject → show overlay.
    setTimeout(() => {
      try {
        chrome.storage.local.get(['tobyflow_extension_not_authorized', 'tobyflow_device_banned'], (res) => {
          if (res?.tobyflow_extension_not_authorized || res?.tobyflow_device_banned) _showCloneDetectedOverlay();
        });
      } catch (_) {}
    }, 800);

    // Khi user trigger user action (click) → request manual retry probe
    try {
      const retryHandler = () => {
        chrome.runtime.sendMessage({ type: 'EXTENSION_AUTH_RETRY' }).catch(() => {});
      };
      cloneDetectedOverlay?.addEventListener('click', retryHandler);
    } catch (_) {}

    // 2. Listen storage change (background detect → set flag)
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        // Clone-detected (extension_id whitelist) HOẶC device-ban (per-device hard block)
        // dùng chung overlay. Recompute từ storage để hide đúng khi CẢ HAI flag đã clear.
        if (changes.tobyflow_extension_not_authorized || changes.tobyflow_device_banned) {
          chrome.storage.local.get(['tobyflow_extension_not_authorized', 'tobyflow_device_banned'], (res) => {
            if (res?.tobyflow_extension_not_authorized || res?.tobyflow_device_banned) _showCloneDetectedOverlay();
            else _hideCloneDetectedOverlay();
          });
        }
      });
    } catch (_) {}

    // 3. Listen runtime message (faster trong cùng context)
    try {
      chrome.runtime.onMessage.addListener((msg) => {
        if (msg?.type === 'EXTENSION_NOT_AUTHORIZED' || msg?.type === 'DEVICE_BANNED') _showCloneDetectedOverlay();
        else if (msg?.type === 'EXTENSION_AUTHORIZED' || msg?.type === 'DEVICE_UNBANNED') {
          _hideCloneDetectedOverlay();
          // Reset AuthManager session-invalid flag (có thể đã bị set sai do 403 cascade).
          try { if (window.authManager) window.authManager._sessionInvalid = false; } catch (_) {}
          // Re-fetch SystemConfig + entitlements khi authorize lại — đảm bảo
          // Google login button + entitlements không bị stuck ở defaults sau recovery.
          (async () => {
            try { await window.SystemConfig?.fetch?.(true); window.SystemConfig?.applyToUI?.(); } catch (_) {}
            try { await window.featureGate?.refresh?.(); } catch (_) {}
          })();
        }
      });
    } catch (_) {}

    // Check connection with Toby server (Server-Only Architecture - Phase 0)
    // Uses ServerHealthCheck.js to verify server connectivity, not just internet.
    async function checkServerConnection() {
      // First check if browser is online
      if (!navigator.onLine) return false;
      // Then verify Toby server is reachable
      return await window.ServerHealthCheck?.check(true) ?? false;
    }

    async function handleOnlineStatusChange() {
      if (!navigator.onLine) {
        showOfflineOverlay();
        return;
      }

      // Server-Only: check Toby server, not just internet
      const isConnected = await checkServerConnection();
      if (!isConnected) {
        showOfflineOverlay();
      } else {
        hideOfflineOverlay();
      }
    }

    // Initial check - Server-Only Architecture
    // Check both internet AND Toby server connectivity
    if (!navigator.onLine) {
      setLoadingText(window.I18n?.t('dialog.offline') || 'Đang mất kết nối Internet');
      showOfflineOverlay();
    } else {
      // Check server health asynchronously
      checkServerConnection().then(isHealthy => {
        if (!isHealthy) {
          setLoadingText(window.I18n?.t('dialog.serverUnavailable') || 'Không thể kết nối đến máy chủ');
          showOfflineOverlay();
        }
      });
    }

    // Listen for online/offline changes
    window.addEventListener('online', handleOnlineStatusChange);
    window.addEventListener('offline', handleOnlineStatusChange);

    // [Audit Bug 8 fix] Listen `config:offline` từ StorageSettings._loadServerDefaults
    // (emit khi 3 retry attempts hết → server unreachable). Show overlay + start health
    // polling — auto hide khi server up lại, không cần user click Retry.
    window.eventBus?.on?.('config:offline', ({ source, error }) => {
      console.warn(`[App] config:offline received (source=${source}, error=${error}) → show overlay`);
      showOfflineOverlay();
    });

    // Retry button handler
    if (offlineRetryBtn) {
      offlineRetryBtn.addEventListener('click', async () => {
        offlineRetryBtn.disabled = true;
        offlineRetryBtn.innerHTML = `
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="tobyflow-spin">
            <path d="M21 12a9 9 0 1 1-6.219-8.56"></path>
          </svg>
          ${window.I18n?.t('app.checking') || 'Đang kiểm tra...'}
        `;

        // Server-Only: reset cache and check Toby server
        window.ServerHealthCheck?.reset();
        const isConnected = await checkServerConnection();

        if (isConnected) {
          hideOfflineOverlay();
          // Refresh data from server
          if (window.featureGate) {
            await window.featureGate.refresh();
          }
          // Also refresh provider configs — refresh() clear cache + refetch (public API).
          // Fix: invalidateCache()/fetchApiConfigs() không tồn tại → TypeError trên click Retry.
          if (window.ProviderConfigManager?.refresh) {
            await window.ProviderConfigManager.refresh();
          }
        } else {
          offlineRetryBtn.disabled = false;
          offlineRetryBtn.innerHTML = `
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 2v6h-6"></path>
              <path d="M3 12a9 9 0 0 1 15-6.7L21 8"></path>
              <path d="M3 22v-6h6"></path>
              <path d="M21 12a9 9 0 0 1-15 6.7L3 16"></path>
            </svg>
            ${window.I18n?.t('common.retry') || 'Thử lại'}
          `;
        }
      });
    }

    // U-1.5: Lắng nghe project context từ content.js hoặc background.js
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      // [NEW] Flow homepage projects count changed (lazy load qua scroll)
      // → re-scan modal nếu đang mở. Anti-loop: cooldown trong _asyncScanFlowProjects (10s).
      if (msg.action === 'flowHomepageProjectsChanged') {
        const overlay = document.querySelector('.project-select-overlay');
        if (overlay) {
          console.log('[TobyFlow] Flow homepage projects changed (count=' + msg.count + ') → re-scan modal');
          // Trigger re-scan (sẽ bị cooldown skip nếu < 10s từ lần scan trước).
          // Force=true để bypass cooldown — user thấy list cập nhật theo Flow scroll realtime.
          if (typeof window._asyncScanFlowProjects === 'function') {
            window._asyncScanFlowProjects(overlay, /*force=*/true);
          }
        }
        if (sendResponse) sendResponse({ ok: true });
        return;
      }

      if (msg.action === 'projectContext') {
        // Mark as resolved and hide connecting overlay
        _projectContextResolved = true;
        _hideConnectingOverlay();

        const oldId = window._currentProjectId;
        const newId = msg.projectId || null;

        // CRITICAL: Update target tab từ sender (content.js gửi từ tab nào)
        // Chỉ set target khi đây là project tab (có projectId)
        // Homepage (projectId=null) không có editor/tiles → giữ target cũ
        if (newId) {
          if (sender?.tab?.id) {
            window._targetFlowTabId = sender.tab.id;
            window.MessageBridge?.setTargetTabId?.(sender.tab.id);
          } else if (msg.tabId) {
            window._targetFlowTabId = msg.tabId;
            window.MessageBridge?.setTargetTabId?.(msg.tabId);
          }
        } else if (!window._targetFlowTabId) {
          // Lần đầu init chưa có target → set tạm để không bị null
          if (sender?.tab?.id) {
            window._targetFlowTabId = sender.tab.id;
            window.MessageBridge?.setTargetTabId?.(sender.tab.id);
          } else if (msg.tabId) {
            window._targetFlowTabId = msg.tabId;
            window.MessageBridge?.setTargetTabId?.(msg.tabId);
          }
        }

        // Nếu fromTabUpdate và chỉ là null → chỉ cập nhật khi projectName cũng null
        // (tránh xóa projectName khi background.js chưa có projectName)
        if (msg.fromTabUpdate && newId && !msg.projectName && window._currentProjectName) {
          // Chỉ cập nhật projectId, giữ projectName cũ cho tới khi content.js gửi đầy đủ
          window._currentProjectId = newId;
        } else {
          window._currentProjectId = newId;
          window._currentProjectName = msg.projectName || null;
        }

        if (newId) {
          _saveProjectToList(newId, msg.projectName);
        }
        _updateProjectIndicator();

        // Update overlay state khi project context thay đổi
        if (newId) {
          _hideProjectSelectOverlay();
        } else {
          _showProjectSelectOverlay();
        }

        if (oldId !== newId) {
          window.eventBus?.emit('project:changed', { projectId: newId, projectName: msg.projectName });
        }
        if (sendResponse) sendResponse({ ok: true });
      }
    });

    // Listen for tab activated events để update _targetFlowTabId khi user switch tab
    // CRITICAL: Đảm bảo gửi message đến đúng tab khi user có nhiều Flow tabs
    if (chrome.tabs?.onActivated) {
      chrome.tabs.onActivated.addListener(async (activeInfo) => {
        try {
          const tab = await chrome.tabs.get(activeInfo.tabId);
          if (tab?.url?.startsWith('https://labs.google/fx/')) {
            // Chỉ set target tab khi đây là project tab (có /project/ trong URL)
            // Homepage tab không có editor/tiles → gửi message sẽ fail
            const isProjectTab = tab.url.match(/\/project\/[a-f0-9-]+/);
            if (isProjectTab) {
              window._targetFlowTabId = activeInfo.tabId;
              window.MessageBridge?.setTargetTabId?.(activeInfo.tabId);
              console.log('[TobyFlow] Tab activated, target Flow tab updated:', activeInfo.tabId);
              // Apply Flow page settings sớm khi switch tab — 1-time per tab session
              window.MessageBridge?.sendToContentScript?.('applyFlowPageSettings', {}).catch(() => {});
            } else {
              console.log('[TobyFlow] Tab activated is Flow homepage, keeping existing target tab');
            }
            // Request project context từ tab mới (cả homepage lẫn project)
            _requestProjectContext();
          }
        } catch (e) {
          // Tab might be closed or inaccessible
        }
      });
    }

    // U-1.5: Yêu cầu project context từ content.js khi khởi tạo
    // CRITICAL: Dùng retry vì content.js có thể chưa sẵn sàng khi sidePanel mở
    // firstCallImmediate=true: gọi ngay lần đầu, retry sau 1s nếu fail
    // suppressOverlay=true: không show overlay cho đến khi hết retry
    _requestProjectContextWithRetry(3, 1000, true, true);

    try {
      // 1. Initialize EventBus
      if (!window.eventBus) {
        window.eventBus = new EventBus();
      }
      log('EventBus ready');

      // 1a. ProviderMeta: init SSE listener now that eventBus exists
      // (fetch() was called earlier in _warmServerConfigs to warm cache)
      try { window.ProviderMeta?.init?.(); } catch (e) { /* ignore */ }

      // 1a2. Initialize I18n (load saved locale + apply translations)
      if (window.I18n) {
        await I18n.init();
        // Apply translations after locale is loaded from storage
        I18n.applyTranslations(document.body);
        log('I18n ready, locale:', I18n.getLocale());

        // Listen for locale changes and re-apply translations
        window.eventBus.on('i18n:changed', ({ locale }) => {
          I18n.applyTranslations(document.body);
          log('I18n locale changed to:', locale);
        });

        // Group E: Listen for server reload (SSE i18n_updated → I18n.reload → emit 'i18n:reloaded')
        // → re-apply translations vào DOM ngay khi server data về (không cần user reload extension).
        window.eventBus.on('i18n:reloaded', ({ locale }) => {
          I18n.applyTranslations(document.body);
          log('I18n reloaded from server for locale:', locale);
        });

        // [API SPAM FIX — Phase 2.3] Global toast khi backend trả 429.
        // AuthManager._apiCall (line ~691-712) emit api:rate_limited khi gặp 429.
        // Throttle dedup: chỉ show 1 toast / 60s để tránh spam.
        let _lastRateLimitToastAt = 0;
        window.eventBus.on('api:rate_limited', ({ retryAfter } = {}) => {
          const now = Date.now();
          if (now - _lastRateLimitToastAt < 60 * 1000) return; // dedup 60s
          _lastRateLimitToastAt = now;
          const seconds = Number(retryAfter) || 60;
          const msg = window.I18n?.t?.('auth.rateLimitedToast', { seconds })
            || `Gói của bạn đang bị giới hạn. Thử lại sau ${seconds}s`;
          window.showNotification?.(msg, 'warning', Math.min(seconds * 1000, 8000));
        });

        // Phase CG-2: ChatGPT chưa đăng nhập → mở dialog + polling login status
        window.eventBus.on('chatgpt:login_required', async () => {
          const dialog = window.customDialog || window.CustomDialog;
          if (!dialog?.confirm) return;
          const ok = await dialog.confirm(
            window.I18n?.t('chatgpt.loginRequiredMsg') || 'Bạn chưa đăng nhập ChatGPT. Mở tab để đăng nhập?',
            {
              title: window.I18n?.t('chatgpt.loginRequiredTitle') || 'Cần đăng nhập ChatGPT',
              type: 'warning',
              confirmText: window.I18n?.t('chatgpt.openTab') || 'Mở tab',
              cancelText: window.I18n?.t('common.cancel') || 'Hủy',
            }
          );
          if (ok) {
            try {
              // [Fix] Reuse existing ChatGPT tab instead of opening new one
              const response = await chrome.runtime.sendMessage({
                action: 'openOrActivateTab',
                urlPattern: window.ProviderConfigManager?.getTabQuery('chatgpt'),
                createUrl: window.ProviderConfigManager?.getCreateUrl('chatgpt'),
                activate: true
              });
              if (response?.tabId) {
                // Start polling login status sau khi mở/activate tab
                _pollProviderLogin('chatgpt', response.tabId);
              }
            } catch (err) {
              console.error('[TobyFlow] Không mở được tab ChatGPT:', err);
            }
          }
        });

        // G-5.9: Grok chưa đăng nhập → mở dialog + polling login status (mirror ChatGPT)
        window.eventBus.on('grok:login_required', async () => {
          const dialog = window.customDialog || window.CustomDialog;
          if (!dialog?.confirm) return;
          const ok = await dialog.confirm(
            window.I18n?.t('grok.loginRequiredMsg') || 'Bạn chưa đăng nhập Grok. Mở tab để đăng nhập?',
            {
              title: window.I18n?.t('grok.loginRequiredTitle') || 'Cần đăng nhập Grok',
              type: 'warning',
              confirmText: window.I18n?.t('grok.openTab') || window.I18n?.t('chatgpt.openTab') || 'Mở tab',
              cancelText: window.I18n?.t('common.cancel') || 'Hủy',
            }
          );
          if (ok) {
            try {
              // [Fix] Reuse existing Grok tab instead of opening new one
              const response = await chrome.runtime.sendMessage({
                action: 'openOrActivateTab',
                urlPattern: window.ProviderConfigManager?.getTabQuery('grok'),
                createUrl: window.ProviderConfigManager?.getProviderUrl('grok', 'imagine') || window.ProviderConfigManager?.getCreateUrl('grok'),
                activate: true
              });
              if (response?.tabId) {
                // Start polling login status sau khi mở/activate tab
                _pollProviderLogin('grok', response.tabId);
              }
            } catch (err) {
              console.error('[TobyFlow] Không mở được tab Grok:', err);
            }
          }
        });
      }

      // 1b. Initialize AuthManager
      setLoadingText(window.I18n?.t('app.checkingLogin') || 'Đang kiểm tra đăng nhập...');
      if (window.authManager) {
        await window.authManager.init();
        log('AuthManager ready, logged in:', window.authManager.isLoggedIn());

        // [Feature: IP Geolocation 2026-05-23] Init LocationCache (fetch /location/me nếu cache empty/expired).
        // [Perf 2026-05-23] Bỏ refetch on auth:login/auth:restored — IP user hiếm đổi.
        // Cache TTL 24h tự handle. User travel quốc tế → đợi 24h hoặc clear chrome.storage manual.
        if (window.LocationCache) {
          window.LocationCache.init().catch(e => console.warn('[App] LocationCache init failed:', e.message));
        }

        // Initialize RequestCoalescer for popup window coordination
        // Popup windows delegate GET requests to sidePanel to avoid duplicate API calls
        if (window.RequestCoalescer) {
          window.RequestCoalescer.init();
          log('RequestCoalescer ready, isLeader:', window.RequestCoalescer.isLeader());
        }

        // Setup login/logout UI handlers
        setupAuthUI();
        setupUpgradeUI();
        // Pre-fetch plans cho module-blocked overlay + crown labels (free vs premium).
        // /api/v1/plans là public endpoint → fetch CẢ anonymous user để
        // canFreePlanUse() có data quyết định "Yêu cầu login" vs "Premium".
        // Sau khi plans load → emit featuregate:refreshed để crown sites re-render label đúng.
        fetchPlans().then(plans => {
          if (plans) {
            window._cachedPlans = plans;
            window.eventBus?.emit('featuregate:refreshed', {
              plan: window.featureGate?.plan,
              entitlements: window.featureGate?.entitlements,
            });
          }
        }).catch(() => {});
        setupTipCoffee();
        setupContactModal();
        setupExtensionLink();
        setupSettingsLogout();
        setupUsageStatsModal();
        setupNotificationBell();
        setupConversionTriggers();
        setupReferralUI();
        setupLanguageModal();
      }

      // 1c. Initialize FeatureGate (for both logged-in users and anonymous trial limits)
      if (window.featureGate) {
        await window.featureGate.init();
        log('FeatureGate ready, plan:', window.featureGate.getPlan()?.slug || 'trial');
      }

      // SS-6: Fetch system settings and apply to UI
      if (window.SystemConfig) {
        setLoadingText(window.I18n?.t('app.loadingSystemConfig') || 'Đang tải cấu hình hệ thống...');
        await window.SystemConfig.fetch();
        window.SystemConfig.applyToUI();
        log('SystemConfig ready, maintenance_mode:', window.SystemConfig.getBool('maintenance_mode'));
      }

      // 1d+1e. If logged in, fetch data in parallel
      if (window.authManager?.isLoggedIn()) {
        setLoadingText(window.I18n?.t('app.loadingConfig') || 'Đang tải cấu hình...');
        await window.featureGate?.init?.();
        log('FeatureGate ready');

        // R-2.2: SSE connect khi khởi tạo nếu đã đăng nhập
        if (window.SseClient) {
          console.log('[SSE] Đã đăng nhập → kết nối SSE ban đầu');
          window.SseClient.connect();
        }
      }

      // 1e. Initialize AnnouncementManager (Phase I — renamed từ ChangelogManager,
      // scope mở rộng: release/alert/promo/maintenance + 2 mode badge/popup).
      if (window.AnnouncementManager) {
        window.AnnouncementManager.init();
        log('AnnouncementManager ready');
      }

      // [Phase 5 2026-05-24] ConfigVersionPoller — lightweight version check fallback cho SSE drop.
      // Replace 2-phút interval + focus-driven full refresh. Fetch /config/versions (~200B)
      // định kỳ, diff cached versions, trigger module refresh nếu mismatch.
      // Backward compat: 404 endpoint chưa deploy → log warn + skip (graceful degrade).
      if (window.ConfigVersionPoller) {
        await window.ConfigVersionPoller.init();
        log('ConfigVersionPoller ready');
      }

      // Helper function to add image to GenTab (used by message listener and pending queue)
      function _addImageToGenTabInternal(tileId, fileName, thumbnail) {
        if (!tileId) {
          return { success: false, error: 'Missing tileId' };
        }
        // Check GenTab available
        if (!window.GenTab?.fileIdsInput) {
          return { success: false, error: 'GenTab not ready' };
        }
        // Check duplicate
        const existingIds = (window.GenTab.fileIdsInput.value || '').split(',').map(s => s.trim()).filter(Boolean);
        if (existingIds.includes(tileId)) {
          return { success: true, alreadyExists: true };
        }
        // Cache thumbnail và fileName
        if (thumbnail) {
          window.GenTab.thumbnailCache = window.GenTab.thumbnailCache || {};
          window.GenTab.thumbnailCache[tileId] = thumbnail;
        }
        if (fileName) {
          window.GenTab.fileNameCache = window.GenTab.fileNameCache || {};
          window.GenTab.fileNameCache[tileId] = fileName;
        }
        // Add to fileIdsInput
        const newIds = [...existingIds, tileId];
        window.GenTab.fileIdsInput.value = newIds.join(', ');
        window.GenTab.fileIdsInput.dispatchEvent(new Event('input', { bubbles: true }));
        // Re-render thumbnails
        if (typeof window.GenTab.renderFileIdThumbnails === 'function') {
          window.GenTab.renderFileIdThumbnails();
        }
        return { success: true, alreadyExists: false };
      }

      // Process pending images from background.js queue (when sidePanel was closed)
      async function _processPendingAddToGenTab() {
        try {
          const storage = await chrome.storage.local.get(['_pendingAddToGenTab']);
          const pending = storage._pendingAddToGenTab || [];
          if (pending.length === 0) return;

          console.log(`[TobyFlow] Processing ${pending.length} pending addImageToGenTab`);
          let addedCount = 0;
          for (const item of pending) {
            const result = _addImageToGenTabInternal(item.tileId, item.fileName, item.thumbnail);
            if (result.success && !result.alreadyExists) {
              addedCount++;
            }
          }

          // Clear pending queue
          await chrome.storage.local.remove('_pendingAddToGenTab');

          if (addedCount > 0) {
            sidebarLog(`Đã thêm ${addedCount} ảnh vào Tab 1 (từ Flow page)`, 'success');
          }
        } catch (e) {
          console.warn('[TobyFlow] Error processing pending addToGenTab:', e);
        }
      }

      // Listen for log messages forwarded from content.js
      chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (msg.action === 'contentLog') {
          sidebarLog(msg.msg, msg.level || 'info');
        }
        if (msg.action === 'promptExecutionComplete') {
          sidebarLog(window.I18n?.t('app.executionComplete', { completed: msg.completedCount, total: msg.totalCount }) || `Execution hoàn tất: ${msg.completedCount}/${msg.totalCount} thành công`, msg.failedCount > 0 ? 'warn' : 'info');
        }
        // Settings saved từ settings popup window
        if (msg.action === 'settingsSaved') {
          window.showNotification?.(msg.message || window.I18n?.t('settings.saved') || 'Cài đặt đã được cập nhật', 'success', 3000);
        }
        // PQ: Pipeline control từ FloatingTracker trong Flow page
        if (msg.action === 'queue:stop_all') {
          if (window.PromptQueue) {
            PromptQueue.getInstance()?.stopAll();
          }
        }
        if (msg.action === 'queue:stop_job' && msg.jobId) {
          window.eventBus?.emit('queue:stop_job', { jobId: msg.jobId });
        }
        if (msg.action === 'queue:pause_job' && msg.jobId) {
          window.eventBus?.emit('queue:pause_job', { jobId: msg.jobId });
        }
        if (msg.action === 'queue:resume_job' && msg.jobId) {
          window.eventBus?.emit('queue:resume_job', { jobId: msg.jobId });
        }
        // Flow tab trở lại active → auto-upload pending local files + re-sync project context
        if (msg.action === 'flowTabActivated') {
          if (window.ImmediateUploader) {
            window.ImmediateUploader.uploadAllPending().then((result) => {
              if (result.uploaded > 0) {
                console.log(`[TobyFlow] Auto-uploaded ${result.uploaded} pending file(s) khi Flow tab active`);
              }
            }).catch(() => {});
          }
          // Re-sync project context khi user switch Flow tab (mỗi Flow tab có thể ở project khác)
          _requestProjectContext();
        }
        // Thêm ảnh từ Flow page vào GenTab ref images (click overlay "+" button trên tile)
        if (msg.action === 'addImageToGenTab') {
          const result = _addImageToGenTabInternal(msg.tileId, msg.fileName, msg.thumbnail);
          sendResponse(result);
          return true;
        }
        // Không giữ message port
        return false;
      });

      // Forward execution:log events vào sidebar log tab
      window.eventBus.on('execution:log', (data) => {
        const nodeId = data.nodeId;
        let prefix = '';
        if (nodeId && window.workflowEditor) {
          const name = window.workflowEditor._getNodeNameById?.(nodeId);
          if (name) prefix = `[${name}] `;
        }
        const level = data.type === 'success' ? 'info' : data.type || 'info';
        sidebarLog(`${prefix}${data.message}`, level);
      });

      // 1f. Restore pending uploads from IndexedDB
      if (window.PendingUploadStore) {
        await PendingUploadStore.restore();
        await PendingUploadStore.restoreCache();
        await PendingUploadStore.restoreLightweight();
        log('PendingUploadStore ready');

        // Cleanup stale upload refs that are no longer in IndexedDB (expired or cleared)
        if (window.GenTab?.cleanupUnavailableUploads) {
          window.GenTab.cleanupUnavailableUploads();
        }

        // S2: Schedule periodic cleanup cho IndexedDB (dọn entries hết hạn)
        PendingUploadStore._scheduleCleanup();

        // Re-render thumbnails vì GenTab.init() chạy trước PendingUploadStore.restore()
        // → lúc đó pendingUploadFiles còn rỗng, thumbnail upload_ không hiển thị
        if (window.pendingUploadFiles?.size > 0 && window.GenTab?.renderFileIdThumbnails) {
          window.GenTab.renderFileIdThumbnails();
        }

        // Process pending images from Flow page "+" button (added while sidePanel was closed)
        _processPendingAddToGenTab();
      }

      // 2. Initialize StorageManager
      setLoadingText(window.I18n?.t('msg.loadingData') || 'Đang tải dữ liệu...');
      if (!window.storageManager) {
        window.storageManager = new StorageManager();
      }
      await window.storageManager.init();
      log('StorageManager ready, mode:', window.storageManager.getMode());

      // 2b. Apply saved settings (theme, position, executor)
      if (window.StorageSettings && !window.storageSettings) {
        window.storageSettings = new StorageSettings();
      }

      // 2b0. Re-apply StorageSettings to GenTab (GenTab.init runs before storageSettings exists)
      // This ensures ratio/genType/model from Settings popup are applied correctly
      if (window.GenTab?._applyStorageSettings) {
        window.GenTab._applyStorageSettings();
      }

      // 2b1. Warm cache cho 3 Group B managers (fire-and-forget)
      // PERF FIX (2026-05-17): bỏ duplicate PCM fetch ở đây — đã fire ở init() Block 1 (line 1512+1516).
      // Trước fix: cùng endpoints `/providers/dom-selectors` + `/providers/api-configs` fetch 2 lần
      // (Block 1 + Block 2) trong cùng init session → server VPS 1.9GB RAM bị áp lực (PHP-FPM
      // mỗi request ~40MB). Block 1 đã fire sớm hơn → data sẵn sàng khi Block 2 reach.
      try {
        window.ModelRegistry?.fetchInBackground?.();
        window.ValidationRules?.fetchInBackground?.();
        // PCM fetches đã được trigger ở line 1512 + 1516 — không cần duplicate ở đây.
        // Nếu Block 1 còn pending → dedup qua `_fetchPromise` (chấp nhận concurrent call).
      } catch (_) { /* ignore — managers chưa load thì skip */ }

      // 2b2. Initialize GenerationHistory (auto-save hooks)
      if (window.generationHistory) {
        await window.generationHistory.init();
        log('GenerationHistory ready');
      }

      // 2b3. Initialize UserPromptsManager
      if (window.userPromptsManager) {
        await window.userPromptsManager.init();
        log('UserPromptsManager ready');
      }

      // 2b4. SnippetsPanel removed from Tab Gen (prompt search modal replaces it)

      // 2b4c. Initialize NotificationManager
      if (window.NotificationManager) {
        await NotificationManager.init();
        log('NotificationManager ready');
      }

      // 2c. Initialize ImagePickerModal (shared singleton)
      if (window.ImagePickerModal && !window.imagePickerModal) {
        window.imagePickerModal = new ImagePickerModal();
        log('ImagePickerModal ready');
      }

      // 2d. Initialize TaskModal early (singleton, listens on eventBus)
      if (window.TaskModal && !window.taskModal) {
        window.taskModal = new TaskModal();
        log('TaskModal ready');
      }

      // 2e. Setup task executor listener for Tab 2
      setupTaskExecutor();

      // 2f. Initialize ExecutionTracker floating panel
      if (window.ExecutionTracker) {
        ExecutionTracker.init();
        log('ExecutionTracker ready');
      }

      // 2f.0. Initialize PipelineFooter (Pipeline Queue mode progress bar)
      if (window.PipelineFooter) {
        PipelineFooter.init();
        log('PipelineFooter ready');
      }

      // 2f.1. Relay execution:tracker_update → FloatingTracker trên Flow page (legacy mode)
      // Cho phép task/workflow/angles owners hiển thị progress trên FloatingTracker
      if (window.eventBus && typeof MessageBridge !== 'undefined') {
        let _trackerStartedAt = null;
        window.eventBus.on('execution:tracker_update', (data) => {
          // Pipeline mode: FloatingTracker đã nhận data qua pq:trackerUpdate riêng
          if (window.PromptQueue && PromptQueue.isEnabled()) return;
          // prompts owner: content.js tự gọi FloatingTracker.updateLegacy() trực tiếp
          if (data.owner === 'prompts') return;

          if (data.phase === 'started') _trackerStartedAt = Date.now();
          const status = data.phase === 'completed' ? 'completed'
            : data.phase === 'error' ? 'stopped'
            : data.phase === 'paused' ? 'paused' : 'running';

          MessageBridge.sendToContentScript('legacyTrackerUpdate', {
            data: {
              owner: data.owner,
              label: data.label || data.owner,
              status: status,
              current: data.current || 0,
              total: data.total || 0,
              failed: data.errorCount || 0,
              startedAt: _trackerStartedAt
            }
          }).catch(() => {});
        });
      }

      // 2g. Initialize QueueMonitor sub-tab in logs
      if (window.QueueMonitor) {
        QueueMonitor.init();
        log('QueueMonitor ready');
      }

      // 2h. Setup logs sub-tab switching
      _setupLogsSubtabs();

      // 2i. Setup prompts sub-tab switching (Templates / My Prompts)
      _setupPromptsSubtabs();

      // NOTE: Workflow subtabs được xử lý bởi WorkflowTab.js (có sẵn overlay logic)

      // 3. Hook into existing tab switching
      setLoadingText(window.I18n?.t('app.initializingUI') || 'Đang khởi tạo giao diện...');
      document.querySelectorAll('.tobyflow-tab').forEach(btn => {
        btn.addEventListener('click', async () => {
          const tabId = btn.dataset.tab;
          const pane = document.getElementById(tabId);

          // Module check cho tabs không có subtabs
          // tab-workflow và tab-templates có subtab overlays riêng
          // tab-gen: check theo provider_status (gen_enabled OR chatgpt_enabled OR grok_enabled)
          if (tabId === 'tab-gen' && window.featureGate && pane) {
            const fg = window.featureGate;
            const anyProviderEnabled = fg.canUse?.('gen_enabled') || fg.canUse?.('chatgpt_enabled') || fg.canUse?.('grok_enabled');
            if (!anyProviderEnabled) {
              showModuleBlockedOverlay(pane, 'gen');
              return;
            }
          } else if (tabId === 'tab-tasks' && window.featureGate && pane) {
            const syncAllowed = window.featureGate.isModuleEnabled?.('tasks') === true;
            if (!syncAllowed) {
              showModuleBlockedOverlay(pane, 'tasks');
              return;
            }
          }

          initializeTab(tabId);
        });
      });

      // 3b. Angles button opens separate window (not a tab)
      const anglesBtn = document.getElementById('anglesToolbarBtn');
      if (anglesBtn) {
        anglesBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          // Check angles_enabled trước khi mở
          if (window.featureGate) {
            const isEnabled = await window.featureGate.isModuleEnabledAsync('angles');
            if (!isEnabled) {
              await window.featureGate.showModuleBlockedDialog('angles');
              return;
            }
          }
          chrome.runtime.sendMessage({
            action: 'openAnglesEditor',
            projectId: window._currentProjectId || null,
            projectName: window._currentProjectName || null
          });
        });
      }

      // 3c. Effects button opens separate window
      const effectsBtn = document.getElementById('effectsToolbarBtn');
      if (effectsBtn) {
        effectsBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          // Check effects_enabled trước khi mở (fallback to angles_enabled if not defined)
          if (window.featureGate) {
            const isEnabled = await window.featureGate.isModuleEnabledAsync('effects');
            if (!isEnabled) {
              await window.featureGate.showModuleBlockedDialog('effects');
              return;
            }
          }
          chrome.runtime.sendMessage({
            action: 'openEffectsEditor',
            projectId: window._currentProjectId || null,
            projectName: window._currentProjectName || null
          });
        });
      }

      // 3d. Telegram button opens settings popup at telegram tab
      const telegramBtn = document.getElementById('telegramToolbarBtn');
      if (telegramBtn) {
        telegramBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          chrome.runtime.sendMessage({ action: 'openSettings', tab: 'telegram' });
        });
      }

      // U-4.6: Project indicator click handler
      const projBtn = document.getElementById('project-indicator-btn');
      if (projBtn) {
        projBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          _toggleProjectDropdown();
        });
      }

      // Nút tạo dự án mới
      const createBtn = document.getElementById('project-create-btn');
      if (createBtn) {
        createBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          _createNewProject();
        });
      }

      // 4. Initialize first active tab (restore from local storage)
      let activeTabId = null;
      try {
        const localData = await chrome.storage.local.get('af_active_sidebar_tab');
        activeTabId = localData?.af_active_sidebar_tab || null;
      } catch (e) { /* storage unavailable */ }

      // Nếu có saved tab → switch sang tab đó
      if (activeTabId && document.getElementById(activeTabId)) {
        const tabBtns = document.querySelectorAll('.tobyflow-tab');
        const tabPanes = document.querySelectorAll('.tab-pane');
        tabBtns.forEach(b => {
          b.classList.toggle('active', b.dataset.tab === activeTabId);
        });
        tabPanes.forEach(p => {
          p.classList.toggle('active', p.id === activeTabId);
        });
      }

      const activeTab = document.querySelector('.tab-pane.active');
      if (activeTab) {
        // Check module access TRƯỚC khi init tab (tránh flickering)
        const moduleCheck = await checkModuleAccess(activeTab.id);

        // Remove module-pending class sau khi check xong
        activeTab.classList.remove('module-pending');

        if (!moduleCheck.allowed) {
          showModuleBlockedOverlay(activeTab, moduleCheck.module);
          // Không init tab content khi module bị khóa
        } else {
          await initializeTab(activeTab.id);
        }
      }

      log('App initialized successfully');

      // 5. Background thumbnail recovery: scan Flow DOM and refresh stale CDN URLs
      refreshAllThumbnails();

      // 6. Background project list maintenance
      // Auto-cleanup projects quá cũ (>30 ngày)
      _cleanupStaleProjects();
      // Sync danh sách projects từ Flow DOM (rename detection + xóa detection)
      setTimeout(() => _syncProjectsFromFlow(), 3000);

    } catch (error) {
      console.error('[TobyFlow] Init failed:', error);

      // Show error state with retry button (I-2)
      setLoadingText(window.I18n?.t('app.loadError') || 'Lỗi tải dữ liệu. Thử lại...');
      const loadingContent = overlay?.querySelector('.tobyflow-loading-content');
      if (loadingContent && !loadingContent.querySelector('.tobyflow-loading-retry')) {
        const retryBtn = document.createElement('button');
        retryBtn.className = 'btn btn-primary tobyflow-loading-retry';
        retryBtn.textContent = window.I18n?.t('common.retry') || 'Thử lại';
        retryBtn.style.marginTop = '12px';
        retryBtn.addEventListener('click', () => {
          retryBtn.remove();
          overlay?.classList.remove('tobyflow-loading-overlay--hidden');
          init();
        });
        loadingContent.appendChild(retryBtn);
      }
      return; // Don't hide overlay on error
    }

    // Hide loading overlay on success
    hideLoadingOverlay();

    // Show connecting overlay if still waiting for project context
    if (!_projectContextResolved && _isInitialRetrying) {
      _showConnectingOverlay();
    }

    // U-4.5: Hiển thị project select overlay nếu chưa có project
    // Chỉ show overlay nếu _requestProjectContext chưa resolve sau 3 giây (safety net)
    // CRITICAL: Cũng check _isInitialRetrying để tránh conflict với retry logic
    setTimeout(() => {
      if (!_projectContextResolved && !window._currentProjectId && !_isInitialRetrying) {
        _hideConnectingOverlay();
        _showProjectSelectOverlay();
      }
    }, 3000);
  }

  /**
   * Scan Flow DOM and refresh stale/expired thumbnail URLs across all stored data.
   * Runs in background after init — non-blocking, fire-and-forget.
   */
  async function refreshAllThumbnails() {
    // Delay to let content.js fully connect
    await new Promise(r => setTimeout(r, 2000));

    try {
      if (!window.MessageBridge) return;
      const scan = await MessageBridge.scanFlowImages();
      const images = scan?.images || [];
      if (images.length === 0) return;

      // Build fileId → thumbnail map from Flow DOM
      const flowThumbMap = {};
      for (const img of images) {
        if (img.fileId && img.thumbnail) {
          flowThumbMap[img.fileId] = img.thumbnail;
        }
      }

      log('Thumbnail recovery: scanned', images.length, 'tiles from Flow');

      let updatedCount = 0;

      // 1. Refresh task thumbnails (ref + result)
      try {
        const tasksRaw = await new Promise(resolve => {
          chrome.storage.local.get(['af_tasks'], r => resolve(r.af_tasks || []));
        });
        let tasksChanged = false;
        for (const task of tasksRaw) {
          // Refresh ref_thumbnails
          if (task.ref_thumbnails && task.ref_file_ids) {
            const refIds = task.ref_file_ids.split(',').map(s => s.trim()).filter(Boolean);
            for (const id of refIds) {
              if (flowThumbMap[id] && task.ref_thumbnails[id] !== flowThumbMap[id]) {
                task.ref_thumbnails[id] = flowThumbMap[id];
                tasksChanged = true;
                updatedCount++;
              }
            }
          }
          // Refresh result_thumbnails
          if (task.result_thumbnails && task.result_file_ids) {
            const resultIds = task.result_file_ids.split(',').map(s => s.trim()).filter(Boolean);
            for (const id of resultIds) {
              if (flowThumbMap[id]) {
                const existing = task.result_thumbnails[id];
                const existingThumb = typeof existing === 'object' ? existing?.thumbnail : existing;
                if (existingThumb !== flowThumbMap[id]) {
                  // Preserve type field if exists
                  if (typeof existing === 'object' && existing?.type === 'video') {
                    task.result_thumbnails[id] = { ...existing, thumbnail: flowThumbMap[id] };
                  } else {
                    task.result_thumbnails[id] = flowThumbMap[id];
                  }
                  tasksChanged = true;
                  updatedCount++;
                }
              }
            }
          }
        }
        if (tasksChanged) {
          await new Promise(resolve => {
            chrome.storage.local.set({ af_tasks: tasksRaw }, resolve);
          });
          // Re-render task list if visible
          const autoTab = document.getElementById('tab-tasks');
          if (autoTab?.__multiTaskTab?.taskList) {
            autoTab.__multiTaskTab.taskList.loadTasks();
          }
        }
      } catch (e) {
        console.warn('[ThumbnailRecovery] Tasks refresh failed:', e.message);
      }

      // 2. Refresh angles results
      try {
        const anglesResults = await new Promise(resolve => {
          chrome.storage.local.get(['af_angles_results'], r => resolve(r.af_angles_results || []));
        });
        let anglesChanged = false;
        for (const entry of anglesResults) {
          if (entry.file_id && flowThumbMap[entry.file_id]) {
            if (entry.thumbnail_url !== flowThumbMap[entry.file_id]) {
              entry.thumbnail_url = flowThumbMap[entry.file_id];
              anglesChanged = true;
              updatedCount++;
            }
          }
        }
        if (anglesChanged) {
          await new Promise(resolve => {
            chrome.storage.local.set({ af_angles_results: anglesResults }, resolve);
          });
        }
      } catch (e) {
        console.warn('[ThumbnailRecovery] Angles refresh failed:', e.message);
      }

      // 3. Refresh workflow node thumbnails (ref + result)
      try {
        const nodesRaw = await new Promise(resolve => {
          chrome.storage.local.get(['af_nodes'], r => resolve(r.af_nodes || []));
        });
        let nodesChanged = false;
        for (const node of nodesRaw) {
          // Refresh ref_thumbnails
          if (node.ref_thumbnails) {
            for (const [fileId, url] of Object.entries(node.ref_thumbnails)) {
              if (flowThumbMap[fileId] && url !== flowThumbMap[fileId]) {
                node.ref_thumbnails[fileId] = flowThumbMap[fileId];
                nodesChanged = true;
                updatedCount++;
              }
            }
          }
          // Refresh result_thumbnails
          if (node.result_thumbnails) {
            for (const [fileId, url] of Object.entries(node.result_thumbnails)) {
              if (flowThumbMap[fileId] && url !== flowThumbMap[fileId]) {
                node.result_thumbnails[fileId] = flowThumbMap[fileId];
                nodesChanged = true;
                updatedCount++;
              }
            }
          }
        }
        if (nodesChanged) {
          await new Promise(resolve => {
            chrome.storage.local.set({ af_nodes: nodesRaw }, resolve);
          });
        }
      } catch (e) {
        console.warn('[ThumbnailRecovery] Nodes refresh failed:', e.message);
      }

      if (updatedCount > 0) {
        log('Thumbnail recovery: updated', updatedCount, 'thumbnails');
      }
    } catch (e) {
      // Silent fail — Flow tab may not be available
      console.warn('[ThumbnailRecovery] Scan failed:', e.message);
    }
  }

  /**
   * Hiển thị overlay khi module bị khóa
   * @param {HTMLElement} pane - Tab pane element
   * @param {string} module - Tên module (gen, tasks, workflows, angles)
   */
  function showModuleBlockedOverlay(pane, module) {
    // Xóa overlay cũ nếu có
    hideModuleBlockedOverlay(pane);

    const moduleNames = {
      gen: 'Generate',
      prompt_templates: 'Prompt Templates',
      tasks: 'Tasks',
      workflows: 'Workflows',
      angles: 'Angles'
    };
    const moduleName = moduleNames[module] || module;
    const isLoggedIn = window.authManager?.isLoggedIn();

    // SS: Kiểm tra show_upgrade_ui để quyết định hiển thị nút nâng cấp hay liên hệ
    const showUpgrade = window.SystemConfig?.getBool('show_upgrade_ui') !== false;
    const contactUrl = window.SystemConfig?.get('upgrade_contact_url', '');

    let actionBtnLabel, actionBtnClass;
    if (!isLoggedIn) {
      actionBtnLabel = window.I18n?.t('auth.login') || 'Đăng nhập';
      actionBtnClass = 'module-blocked-btn';
    } else if (showUpgrade) {
      actionBtnLabel = window.I18n?.t('common.upgrade') || 'Nâng cấp';
      actionBtnClass = 'module-blocked-btn module-blocked-btn-upgrade';
    } else if (contactUrl) {
      actionBtnLabel = window.I18n?.t('overlay.contact') || 'Liên hệ';
      actionBtnClass = 'module-blocked-btn';
    } else {
      actionBtnLabel = '';
      actionBtnClass = '';
    }

    const overlay = document.createElement('div');
    overlay.className = 'module-blocked-overlay';
    overlay.innerHTML = `
      <div class="module-blocked-content">
        <div class="module-blocked-icon">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
            <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
          </svg>
        </div>
        <h3 class="module-blocked-title">${isLoggedIn ? (window.I18n?.t('overlay.moduleBlocked') || 'Tính năng bị khóa') : (window.I18n?.t('overlay.requiresLogin') || 'Yêu cầu đăng nhập')}</h3>
        <p class="module-blocked-desc">${isLoggedIn
          ? `${window.I18n?.t('overlay.descriptionUpgrade', { module: moduleName }) || `Gói hiện tại không bao gồm tính năng <strong>${moduleName}</strong>`}.<br>${showUpgrade ? (window.I18n?.t('app.upgradeToUse') || 'Nâng cấp để sử dụng.') : (window.I18n?.t('app.contactAdmin') || 'Liên hệ admin để được hỗ trợ.')}`
          : `${window.I18n?.t('overlay.description', { module: moduleName }) || `Tính năng <strong>${moduleName}</strong> yêu cầu đăng nhập`}.<br>${window.I18n?.t('app.loginToUse') || 'Đăng nhập để sử dụng đầy đủ.'}`
        }</p>
        ${actionBtnLabel ? `<button class="${actionBtnClass}">${actionBtnLabel}</button>` : ''}
      </div>
    `;

    // Handle button click
    const actionBtn = overlay.querySelector('.module-blocked-btn');
    if (actionBtn) {
      actionBtn.addEventListener('click', () => {
        if (!isLoggedIn) {
          // Mở login overlay
          const loginOverlay = document.getElementById('loginOverlay');
          if (loginOverlay) {
            loginOverlay.classList.remove('hidden');
          } else {
            chrome.runtime.sendMessage({ action: 'openSettings' });
          }
        } else if (showUpgrade) {
          // Mở upgrade modal (fetch plans + render)
          if (typeof window.openUpgradeModal === 'function') {
            window.openUpgradeModal();
          }
        } else if (contactUrl) {
          // Mở link liên hệ
          window.open(contactUrl, '_blank');
        }
      });
    }

    pane.style.position = 'relative';
    pane.appendChild(overlay);
  }

  /**
   * Ẩn overlay module blocked
   * @param {HTMLElement} pane - Tab pane element
   */
  function hideModuleBlockedOverlay(pane) {
    const existing = pane.querySelector('.module-blocked-overlay');
    if (existing) existing.remove();
  }

  /**
   * Refresh tất cả module overlays khi entitlements thay đổi
   * Gọi khi: featuregate:refreshed, auth:login, auth:logout
   * TỐI ƯU: Sử dụng sync check (không await) vì data đã có trong cache
   */
  function refreshModuleOverlays() {
    if (!window.featureGate) return;

    // NOTE: tab-templates và tab-workflow sử dụng subtab overlays
    // nên không cần module overlay ở parent level
    // NOTE: tab-gen giờ check theo provider_status thay vì gen_enabled global
    const tabModuleMap = {
      'tab-tasks': 'tasks'
    };

    for (const [tabId, module] of Object.entries(tabModuleMap)) {
      const pane = document.getElementById(tabId);
      if (!pane) continue;

      pane.classList.remove('module-pending');

      const isEnabled = window.featureGate.isModuleEnabled(module);
      if (!isEnabled) {
        showModuleBlockedOverlay(pane, module);
      } else {
        hideModuleBlockedOverlay(pane);
      }
    }

    // tab-gen: check theo provider_status - hiện overlay chỉ khi TẤT CẢ providers đều bị khóa
    const genPane = document.getElementById('tab-gen');
    if (genPane) {
      genPane.classList.remove('module-pending');
      const fg = window.featureGate;
      const anyProviderEnabled = fg.canUse?.('gen_enabled') || fg.canUse?.('chatgpt_enabled') || fg.canUse?.('grok_enabled');
      if (!anyProviderEnabled) {
        showModuleBlockedOverlay(genPane, 'gen');
      } else {
        hideModuleBlockedOverlay(genPane);
      }
    }

    // Xóa module-pending cho tab-templates (dùng prompts subtab overlays)
    const templatesPane = document.getElementById('tab-templates');
    if (templatesPane) {
      templatesPane.classList.remove('module-pending');
      hideModuleBlockedOverlay(templatesPane);
    }

    // Xóa module-pending cho tab-workflow (WorkflowTab tự xử lý overlays)
    const workflowPane = document.getElementById('tab-workflow');
    if (workflowPane) {
      workflowPane.classList.remove('module-pending');
      hideModuleBlockedOverlay(workflowPane);
    }

    // Refresh subtab overlays
    refreshSubtabOverlays();
  }

  // Expose để có thể gọi từ nơi khác
  window.refreshModuleOverlays = refreshModuleOverlays;

  /**
   * Check module access trước khi cho phép chuyển tab
   * @param {string} tabId - ID của tab (tab-gen, tab-tasks, tab-workflow, etc.)
   * @returns {{ allowed: boolean, module: string|null }}
   */
  async function checkModuleAccess(tabId) {
    if (!window.featureGate) {
      return { allowed: true, module: null };
    }

    // Tabs có subtabs luôn allowed ở parent level (check ở subtab level)
    if (tabId === 'tab-templates' || tabId === 'tab-workflow') {
      return { allowed: true, module: null };
    }

    // tab-gen: check theo provider_status - allowed nếu BẤT KỲ provider nào enabled
    if (tabId === 'tab-gen') {
      const fg = window.featureGate;
      const anyProviderEnabled = fg.canUse?.('gen_enabled') || fg.canUse?.('chatgpt_enabled') || fg.canUse?.('grok_enabled');
      return { allowed: anyProviderEnabled, module: anyProviderEnabled ? null : 'gen' };
    }

    // Map tab ID → module name (chỉ cho tabs không có subtabs)
    const tabModuleMap = {
      'tab-tasks': 'tasks'
    };

    const module = tabModuleMap[tabId];
    if (!module) {
      // Tab không cần check (history, logs, settings)
      return { allowed: true, module: null };
    }

    const isEnabled = await window.featureGate.isModuleEnabledAsync(module);
    return { allowed: isEnabled, module };
  }

  // Setup tab switching logic
  function setupTabSwitching() {
    const tabButtons = document.querySelectorAll('.tobyflow-tab');
    const tabPanes = document.querySelectorAll('.tab-pane');

    tabButtons.forEach(btn => {
      btn.addEventListener('click', async () => {
        const tabId = btn.dataset.tab;

        // UA-2: Cap nhat active tab cho usage tracking
        if (window.UsageSync) window.UsageSync.setActiveTab(tabId);

        // Update buttons
        tabButtons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        // Update panes
        tabPanes.forEach(pane => {
          pane.classList.remove('active');
          if (pane.id === tabId) {
            pane.classList.add('active');
          }
        });

        const activePane = document.getElementById(tabId);

        // Sync check qua cache TRƯỚC để show overlay NGAY (tránh delay khi cache expired
        // — isModuleEnabledAsync sẽ await refresh network ~vài trăm ms đến vài giây).
        // Sau đó async refresh nền + re-check → adjust overlay nếu state thực thay đổi.
        // NOTE: tab-templates và tab-workflow sử dụng subtab overlays thay cho module overlay
        // NOTE: tab-gen check theo provider_status (gen_enabled OR chatgpt_enabled OR grok_enabled)
        const tabModuleMap = {
          'tab-tasks': 'tasks'
          // 'tab-gen' xử lý riêng theo provider_status
          // 'tab-templates' và 'tab-workflow' dùng subtab overlays
        };
        const module = tabModuleMap[tabId];

        // Nếu là tab-templates, refresh prompts subtab overlays
        if (tabId === 'tab-templates') {
          if (activePane) activePane.classList.remove('module-pending');
          refreshSubtabOverlays();
        }
        // tab-workflow: WorkflowTab tự xử lý overlays trong _switchSubtab/_applySubtabFeatureGate
        if (tabId === 'tab-workflow') {
          if (activePane) activePane.classList.remove('module-pending');
        }

        if (activePane) {
          activePane.classList.remove('module-pending');
        }

        // tab-gen: check theo provider_status
        let syncAllowed;
        if (tabId === 'tab-gen') {
          const fg = window.featureGate;
          syncAllowed = !!(fg?.canUse?.('gen_enabled') || fg?.canUse?.('chatgpt_enabled') || fg?.canUse?.('grok_enabled'));
          if (!syncAllowed && activePane) {
            showModuleBlockedOverlay(activePane, 'gen');
          }
        } else {
          // Các tab khác: sync check theo module
          syncAllowed = !module || (window.featureGate?.isModuleEnabled?.(module) === true);
          if (!syncAllowed && activePane && module) {
            showModuleBlockedOverlay(activePane, module);
          }
        }

        // Async refresh nền — nếu state thay đổi sau refresh, adjust overlay
        // (KHÔNG await để không block UI; refreshModuleOverlays sẽ đồng bộ tất cả tab).
        if (tabId === 'tab-gen' && window.featureGate) {
          // tab-gen: async refresh và re-check provider_status
          window.featureGate.refresh?.().then(() => {
            if (!activePane) return;
            const fg = window.featureGate;
            const freshAllowed = !!(fg?.canUse?.('gen_enabled') || fg?.canUse?.('chatgpt_enabled') || fg?.canUse?.('grok_enabled'));
            if (!freshAllowed && syncAllowed) {
              showModuleBlockedOverlay(activePane, 'gen');
            } else if (freshAllowed && !syncAllowed) {
              hideModuleBlockedOverlay(activePane);
              initializeTab(tabId).catch((err) => console.warn('[TobyFlow] initializeTab error:', err));
            }
          }).catch((err) => console.warn('[TobyFlow] featureGate.refresh error:', err));
        } else if (module && window.featureGate) {
          window.featureGate.isModuleEnabledAsync(module).then((freshAllowed) => {
            if (!activePane) return;
            if (!freshAllowed && syncAllowed) {
              showModuleBlockedOverlay(activePane, module);
            } else if (freshAllowed && !syncAllowed) {
              hideModuleBlockedOverlay(activePane);
              initializeTab(tabId).catch((err) => console.warn('[TobyFlow] initializeTab error:', err));
            }
          }).catch((err) => console.warn('[TobyFlow] isModuleEnabledAsync error:', err));
        }

        if (!syncAllowed && (tabId === 'tab-gen' || module)) {
          // Module/Provider bị khóa (theo cache) → không init tab content
          return;
        }

        // Module enabled → ẩn overlay (nếu có từ trước) và init tab
        if (activePane) {
          hideModuleBlockedOverlay(activePane);
        }

        // Show tab loading spinner
        let tabSpinner = null;
        if (activePane) {
          tabSpinner = document.createElement('div');
          tabSpinner.className = 'tobyflow-tab-loading';
          tabSpinner.innerHTML = '<div class="tobyflow-loading-spinner"></div>';
          activePane.appendChild(tabSpinner);
        }

        // Initialize tab content
        await initializeTab(tabId);

        // Remove tab loading spinner
        if (tabSpinner) tabSpinner.remove();
      });
    });
  }

  // Initialize specific tab
  async function initializeTab(tabId) {
    log('Initializing tab:', tabId);

    switch (tabId) {
      case 'tab-templates':
        // Templates Tab — render into subtab-templates pane
        if (window.TemplatesTab) {
          const subtabContainer = document.getElementById('subtab-templates');
          if (subtabContainer && !subtabContainer.__templatesTab) {
            subtabContainer.__templatesTab = new TemplatesTab(subtabContainer);
            await subtabContainer.__templatesTab.init();
          } else if (subtabContainer?.__templatesTab) {
            subtabContainer.__templatesTab.reload();
          }
        }
        // MyPromptsTab — sub-tab switching + My Prompt management
        if (window.MyPromptsTab && !window.MyPromptsTab._initialized) {
          MyPromptsTab.init();
          window.MyPromptsTab._initialized = true;
        }
        break;

      case 'tab-tasks':
        // Multi Task Tab
        if (window.MultiTaskTab) {
          const container = document.getElementById('tab-tasks');
          if (container && !container.__multiTaskTab) {
            container.__multiTaskTab = new MultiTaskTab(container);
            await container.__multiTaskTab.init();
          } else if (container?.__multiTaskTab?.taskList) {
            container.__multiTaskTab.taskList.loadTasks();
          }
          // Check for local data needing migration
          if (window.storageManager?.mode === 'api') {
            window.storageManager.checkAndPromptMigration('tasks');
          }
        }
        break;

      case 'tab-workflow':
        // Toby Flow Tab
        if (window.WorkflowTab) {
          const container = document.getElementById('tab-workflow');
          if (container && !container.__tobyflowTab) {
            container.__tobyflowTab = new WorkflowTab(container);
            await container.__tobyflowTab.init();
          } else if (container?.__tobyflowTab?.workflowList) {
            container.__tobyflowTab.workflowList.loadWorkflows();
            // Cũng load shared workflows để section "Được chia sẻ với tôi"
            // refresh khi user chuyển vào tab (vd sau khi accept share ở tab khác)
            container.__tobyflowTab.workflowList.loadSharedWorkflows();
          }
          // Check for local data needing migration
          if (window.storageManager?.mode === 'api') {
            window.storageManager.checkAndPromptMigration('workflows');
          }
        }
        break;

      case 'tab-history':
        // History Tab
        if (window.HistoryTab) {
          const container = document.getElementById('tab-history');
          if (container && !container.__historyTab) {
            container.__historyTab = new HistoryTab(container);
            await container.__historyTab.init();
          } else if (container?.__historyTab) {
            container.__historyTab.reload();
          }
        }
        break;

      case 'tab-photos':
        // Photos Tab with sub-tabs
        if (window.PhotosTab) {
          await window.PhotosTab.init();
        }
        break;

      default:
        // Tab 1 (Prompts) - handled by existing content.js
        break;
    }
  }

  // Load CSS dynamically
  function loadCSS(href) {
    if (document.querySelector(`link[href="${href}"]`)) return;

    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    document.head.appendChild(link);
  }

  // Load JS dynamically
  function loadJS(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) {
        resolve();
        return;
      }

      const script = document.createElement('script');
      script.src = src;
      script.onload = resolve;
      script.onerror = reject;
      document.head.appendChild(script);
    });
  }

  // Logs sub-tab switching (Nhật ký / Hàng đợi)
  function _setupLogsSubtabs() {
    const subtabs = document.querySelectorAll('.tobyflow-logs-subtab');
    const mainContent = document.getElementById('logsMainContent');
    const queueContent = document.getElementById('logsQueueContent');

    if (!subtabs.length || !mainContent || !queueContent) return;

    subtabs.forEach(btn => {
      btn.addEventListener('click', () => {
        const target = btn.dataset.subtab;

        // Update active pill
        subtabs.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        // Toggle content visibility
        if (target === 'logs-main') {
          mainContent.classList.remove('tobyflow-logs-subtab-content--hidden');
          queueContent.classList.add('tobyflow-logs-subtab-content--hidden');
          if (window.QueueMonitor) {
            QueueMonitor.getInstance()?.setVisible(false);
          }
        } else if (target === 'logs-queue') {
          mainContent.classList.add('tobyflow-logs-subtab-content--hidden');
          queueContent.classList.remove('tobyflow-logs-subtab-content--hidden');
          if (window.QueueMonitor) {
            QueueMonitor.getInstance()?.setVisible(true);
          }
        }
      });
    });
  }

  // Prompts sub-tab switching with permission check
  function _setupPromptsSubtabs() {
    const subtabs = document.querySelectorAll('.prompts-subtab');
    const panes = {
      'subtab-templates': document.getElementById('subtab-templates'),
      'subtab-myprompts': document.getElementById('subtab-myprompts')
    };

    if (!subtabs.length) return;

    subtabs.forEach(btn => {
      btn.addEventListener('click', () => {
        const target = btn.dataset.subtab;

        // Update active pill
        subtabs.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        // Toggle pane visibility
        Object.entries(panes).forEach(([id, pane]) => {
          if (!pane) return;
          if (id === target) {
            pane.classList.add('active');
          } else {
            pane.classList.remove('active');
          }
        });

        // Check permission and show overlay if needed
        _checkSubtabPermission(target, panes[target]);
      });
    });

    // Initial check for default active subtab
    const activeSubtab = document.querySelector('.prompts-subtab.active');
    if (activeSubtab) {
      const target = activeSubtab.dataset.subtab;
      _checkSubtabPermission(target, panes[target]);
    }
  }

  // NOTE: Workflow subtabs được xử lý bởi WorkflowTab.js với _applySubtabFeatureGate()

  /**
   * Check permission for prompts subtab and show/hide overlay
   * @param {string} subtabId - ID của subtab (subtab-templates, subtab-myprompts)
   * @param {HTMLElement} pane - Subtab pane element
   */
  function _checkSubtabPermission(subtabId, pane) {
    if (!pane || !window.featureGate) return;

    // Map subtab ID -> feature key to check (chỉ prompts subtabs)
    const subtabFeatureMap = {
      'subtab-templates': { key: 'prompt_templates_enabled', type: 'boolean', name: 'Prompt Templates' },
      'subtab-myprompts': { key: 'snippets_max', type: 'quota', name: 'My Prompts' }
    };

    const featureConfig = subtabFeatureMap[subtabId];
    if (!featureConfig) return;

    const isLoggedIn = window.authManager?.isLoggedIn();
    let isAllowed = false;

    if (featureConfig.type === 'boolean') {
      isAllowed = window.featureGate.canUse(featureConfig.key);
    } else if (featureConfig.type === 'quota') {
      // Sử dụng checkQuota để kiểm tra quota
      const quotaInfo = window.featureGate.checkQuota(featureConfig.key);
      // Cho phép nếu limit > 0 hoặc unlimited (có quyền dùng feature)
      isAllowed = quotaInfo.limit === 'unlimited' || quotaInfo.limit > 0;
    }

    if (!isAllowed) {
      _showSubtabBlockedOverlay(pane, featureConfig.name, isLoggedIn);
    } else {
      _hideSubtabBlockedOverlay(pane);
    }
  }

  /**
   * Show overlay khi subtab bị khóa
   * @param {HTMLElement} pane - Subtab pane element
   * @param {string} featureName - Tên feature để hiển thị
   * @param {boolean} isLoggedIn - User đã login chưa
   */
  function _showSubtabBlockedOverlay(pane, featureName, isLoggedIn) {
    // Xóa overlay cũ nếu có
    _hideSubtabBlockedOverlay(pane);

    const showUpgrade = window.SystemConfig?.getBool('show_upgrade_ui') !== false;
    const contactUrl = window.SystemConfig?.get('upgrade_contact_url', '');

    let actionBtnLabel, actionBtnClass;
    if (!isLoggedIn) {
      actionBtnLabel = window.I18n?.t('auth.login') || 'Đăng nhập';
      actionBtnClass = 'subtab-blocked-btn';
    } else if (showUpgrade) {
      actionBtnLabel = window.I18n?.t('common.upgrade') || 'Nâng cấp';
      actionBtnClass = 'subtab-blocked-btn subtab-blocked-btn-upgrade';
    } else if (contactUrl) {
      actionBtnLabel = window.I18n?.t('overlay.contact') || 'Liên hệ';
      actionBtnClass = 'subtab-blocked-btn';
    } else {
      actionBtnLabel = '';
      actionBtnClass = '';
    }

    const overlay = document.createElement('div');
    overlay.className = 'subtab-blocked-overlay';
    overlay.innerHTML = `
      <div class="subtab-blocked-content">
        <div class="subtab-blocked-icon">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
            <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
          </svg>
        </div>
        <h3 class="subtab-blocked-title">${isLoggedIn ? (window.I18n?.t('overlay.moduleBlocked') || 'Tính năng bị khóa') : (window.I18n?.t('overlay.requiresLogin') || 'Yêu cầu đăng nhập')}</h3>
        <p class="subtab-blocked-desc">${isLoggedIn
          ? `${window.I18n?.t('overlay.descriptionUpgrade', { module: featureName }) || `Gói hiện tại không bao gồm tính năng <strong>${featureName}</strong>`}.<br>${showUpgrade ? (window.I18n?.t('app.upgradeToUse') || 'Nâng cấp để sử dụng.') : (window.I18n?.t('app.contactAdmin') || 'Liên hệ admin để được hỗ trợ.')}`
          : `${window.I18n?.t('overlay.description', { module: featureName }) || `Tính năng <strong>${featureName}</strong> yêu cầu đăng nhập`}.<br>${window.I18n?.t('app.loginToUse') || 'Đăng nhập để sử dụng đầy đủ.'}`
        }</p>
        ${actionBtnLabel ? `<button class="${actionBtnClass}">${actionBtnLabel}</button>` : ''}
      </div>
    `;

    // Handle button click
    const actionBtn = overlay.querySelector('.subtab-blocked-btn');
    if (actionBtn) {
      actionBtn.addEventListener('click', () => {
        if (!isLoggedIn) {
          const loginOverlay = document.getElementById('loginOverlay');
          if (loginOverlay) {
            loginOverlay.classList.remove('hidden');
          } else {
            chrome.runtime.sendMessage({ action: 'openSettings' });
          }
        } else if (showUpgrade) {
          if (typeof window.openUpgradeModal === 'function') {
            window.openUpgradeModal();
          }
        } else if (contactUrl) {
          window.open(contactUrl, '_blank');
        }
      });
    }

    pane.style.position = 'relative';
    pane.appendChild(overlay);
  }

  /**
   * Ẩn overlay subtab blocked
   * @param {HTMLElement} pane - Subtab pane element
   */
  function _hideSubtabBlockedOverlay(pane) {
    const existing = pane.querySelector('.subtab-blocked-overlay');
    if (existing) existing.remove();
  }

  /**
   * Refresh prompts subtab overlays khi entitlements thay đổi
   * NOTE: Workflow subtabs được xử lý bởi WorkflowTab._applySubtabFeatureGate()
   */
  function refreshSubtabOverlays() {
    // Prompts subtabs
    const promptsActiveSubtab = document.querySelector('.prompts-subtab.active');
    if (promptsActiveSubtab) {
      const target = promptsActiveSubtab.dataset.subtab;
      const pane = document.getElementById(target);
      if (pane) _checkSubtabPermission(target, pane);
    }

    // Workflow subtabs - trigger WorkflowTab refresh
    const workflowTab = document.getElementById('tab-workflow');
    if (workflowTab?.__tobyflowTab?._applySubtabFeatureGate) {
      const currentSubtab = workflowTab.__tobyflowTab._currentSubtab || 'templates';
      workflowTab.__tobyflowTab._applySubtabFeatureGate(currentSubtab);
    }
  }

  // Expose để có thể gọi từ nơi khác
  window.refreshSubtabOverlays = refreshSubtabOverlays;

  // Task executor for Tab 2 (Multi Task)
  function setupTaskExecutor() {
    if (!window.eventBus) return;

    window.eventBus.on('task:run', async (data) => {
      const { task } = data;

      // ExecutionLock: kiểm tra trước khi chạy
      if (window.ExecutionLock && ExecutionLock.isBlockedBy('task')) {
        const shouldStop = await ExecutionLock.showBlockedDialog('task');
        if (!shouldStop) return;
        await ExecutionLock.stopCurrent();
      }
      if (window.ExecutionLock) ExecutionLock.acquire('task', `Task: ${task.task_name || task.task_id}`);

      // Activate provider tab when execution starts.
      // CRITICAL: Chỉ activate Flow tab cho task provider=flow. ChatGPT/Grok tasks BYPASS Flow
      // editor — activate Flow tab sẽ steal focus + làm lệch context (chatgpt/grok.com tab bị
      // mất active state → React throttle → submit fails). Match GenTab pattern.
      const _taskProvider = task?.provider || 'flow';
      try {
        if (_taskProvider === 'chatgpt' && window.ChatGPTSession?.ensureReady) {
          window.ChatGPTSession.ensureReady({ createIfMissing: true, activate: true })
            .then(() => window.ChatGPTSession.ensureTabActive?.())
            .catch(err => console.warn('[Task] ChatGPT activate failed:', err?.message || err));
        } else if (_taskProvider === 'grok' && window.GrokSession?.ensureReady) {
          window.GrokSession.ensureReady({ createIfMissing: true, activate: true })
            .then(() => window.GrokSession.ensureTabActive?.())
            .catch(err => console.warn('[Task] Grok activate failed:', err?.message || err));
        } else {
          chrome.runtime.sendMessage({ action: 'activateFlowTabForExecution' }).catch(() => {});
        }
      } catch (e) {
        console.warn('[executeSingleTask] Error activating provider tab:', e);
      }

      // SP-2.4: ExecutionGate - xin phep server truoc khi chay task
      let _taskExecutionToken = null;
      // Calculate prompt count for quota check and tracking
      const taskPrompts = (task.multi_prompt && task.prompts?.length > 1) ? task.prompts : [task.prompt];
      const taskPromptCount = taskPrompts.length;
      if (window.ExecutionGate) {
        try {
          // Bug fix 2026-05-22: pass provider để backend ALSO deduct chatgpt/grok/gemini_run_max.
          const gate = await ExecutionGate.request('task_run', taskPromptCount, { owner: 'task', label: task.task_name || task.task_id, provider: task.provider || 'flow' });
          if (!gate.allowed) {
            ExecutionGate.showDeniedDialog(gate, 'Task');
            if (window.ExecutionLock) ExecutionLock.release('task');
            return;
          }
          _taskExecutionToken = gate.token;
          window._currentTaskExecutionToken = _taskExecutionToken;
        } catch (e) {
          if (window.QuotaErrorHandler?.handleIfQuotaError(e, 'Task')) {
            console.warn('[Task] ExecutionGate denied:', e.code || e.reason);
            if (window.ExecutionLock) ExecutionLock.release('task');
            return;
          }
          console.error('[Task] ExecutionGate request failed, proceeding:', e.message);
        }
      }

      log('Executing task:', task.task_id, task.task_name);
      // Emit tracker started
      if (window.eventBus) {
        window.eventBus.emit('execution:tracker_update', {
          owner: 'task', label: `Task: ${task.task_name || task.task_id}`,
          phase: 'started', current: 0, total: 1
        });
      }
      const isPipeline = window.PromptQueue && PromptQueue.isEnabled();
      try {
        const taskResult = await executeSingleTask(task, { _executionToken: isPipeline ? _taskExecutionToken : null });

        // Bug 1+3 fix (2026-05-17): đọc actual counts từ taskResult (ChatGPT/Grok inner return
        // { success, failed, results, stopped }). Flow path return undefined → fallback taskPromptCount.
        const actualSuccess = taskResult?.success ?? taskPromptCount;
        const actualFailed = taskResult?.failed ?? 0;
        const wasStopped = taskResult?.stopped ?? false;

        // SP-2.4: ExecutionGate complete (chỉ direct mode — pipeline tự handle qua PromptQueue)
        if (!isPipeline && window.ExecutionGate && _taskExecutionToken) {
          // Bug 2+3 fix: status reflect actual outcome (kể cả stopped case).
          // ExecutionTracker._handleStop CHỈ set flag, KHÔNG cancel/complete token →
          // outer caller có scope đúng (single-task successCount) để gọi partial complete.
          let status;
          if (wasStopped) {
            // User stop giữa chừng: partial nếu đã có ≥1 success, failed nếu 0 success.
            // Server backend: partial refund = (promptCount - successful_count); failed refund = promptCount.
            status = actualSuccess > 0 ? 'partial' : 'failed';
          } else if (actualSuccess === 0) {
            status = 'failed';
          } else if (actualFailed > 0) {
            status = 'partial';
          } else {
            status = 'success';
          }
          const extraData = status === 'partial' ? { successful_count: actualSuccess } : {};
          ExecutionGate.complete(_taskExecutionToken, status, extraData);
        }
        // Bug 1 fix: track actual successful prompts thay vì task definition total.
        // Trước fix: recordPromptSubmit(taskPromptCount) → over-count khi user stop hoặc partial fail.
        if (window.featureGate && actualSuccess > 0) {
          window.featureGate.recordTaskRun(); // 1 task run
          window.featureGate.recordGenRun();
          window.featureGate.recordPromptSubmit(actualSuccess, 'task');
        }
        window._currentTaskExecutionToken = null;
      } catch (err) {
        // SP-2.4: ExecutionGate complete (chỉ direct mode)
        if (!isPipeline && window.ExecutionGate && _taskExecutionToken) {
          ExecutionGate.complete(_taskExecutionToken, 'failed', { error: err.message || String(err) });
        }
        window._currentTaskExecutionToken = null;
      }
      // Emit tracker completed
      if (window.eventBus) {
        window.eventBus.emit('execution:tracker_update', {
          owner: 'task', phase: 'completed', current: 1, total: 1
        });
      }

      if (window.ExecutionLock) ExecutionLock.release('task');
    });

    window.eventBus.on('tasks:run_batch', async (data) => {
      const { tasks, mode } = data;
      const isParallel = mode === 'parallel';

      // ExecutionLock: kiểm tra trước khi chạy batch
      if (window.ExecutionLock && ExecutionLock.isBlockedBy('task')) {
        const shouldStop = await ExecutionLock.showBlockedDialog('task');
        if (!shouldStop) return;
        await ExecutionLock.stopCurrent();
      }
      if (window.ExecutionLock) ExecutionLock.acquire('task', `Task batch (${tasks.length})`);

      // Activate provider tab when batch execution starts.
      // CRITICAL: Multi-provider batch (mixed Flow+ChatGPT+Grok) → activate FIRST task's provider.
      // executeSingleTask sẽ tự switch tab cho từng task khác provider trong vòng lặp.
      // Trước fix: always activate Flow → ChatGPT/Grok tasks fail submit.
      const _firstTask = tasks[0] || {};
      const _firstProvider = _firstTask.provider || 'flow';
      try {
        if (_firstProvider === 'chatgpt' && window.ChatGPTSession?.ensureReady) {
          window.ChatGPTSession.ensureReady({ createIfMissing: true, activate: true })
            .then(() => window.ChatGPTSession.ensureTabActive?.())
            .catch(err => console.warn('[runAllTasks] ChatGPT activate failed:', err?.message || err));
        } else if (_firstProvider === 'grok' && window.GrokSession?.ensureReady) {
          window.GrokSession.ensureReady({ createIfMissing: true, activate: true })
            .then(() => window.GrokSession.ensureTabActive?.())
            .catch(err => console.warn('[runAllTasks] Grok activate failed:', err?.message || err));
        } else {
          chrome.runtime.sendMessage({ action: 'activateFlowTabForExecution' }).catch(() => {});
        }
      } catch (e) {
        console.warn('[runAllTasks] Error activating provider tab:', e);
      }

      // SP-2.4: ExecutionGate - xin phep server truoc khi chay batch
      let _batchExecutionToken = null;
      if (window.ExecutionGate) {
        try {
          const totalPrompts = tasks.reduce((sum, t) => {
            return sum + ((t.multi_prompt && t.prompts?.length > 1) ? t.prompts.length : 1);
          }, 0);
          // Bug fix 2026-05-22: pass provider nếu batch dùng đồng nhất 1 provider.
          // Mixed batch → skip provider deduct (acceptable: batch là power user feature, ít dùng).
          const _uniqueProviders = new Set(tasks.map(t => t.provider || 'flow'));
          const _batchProvider = _uniqueProviders.size === 1 ? [..._uniqueProviders][0] : null;
          const gate = await ExecutionGate.request('task_run', totalPrompts, { owner: 'task', label: 'Task batch', provider: _batchProvider });
          if (!gate.allowed) {
            ExecutionGate.showDeniedDialog(gate, 'Task');
            if (window.ExecutionLock) ExecutionLock.release('task');
            if (window.eventBus) window.eventBus.emit('tasks:batch_complete');
            return;
          }
          _batchExecutionToken = gate.token;
          window._currentTaskExecutionToken = _batchExecutionToken;
        } catch (e) {
          if (window.QuotaErrorHandler?.handleIfQuotaError(e, 'Task')) {
            console.warn('[Task] ExecutionGate batch denied:', e.code || e.reason);
            if (window.ExecutionLock) ExecutionLock.release('task');
            if (window.eventBus) window.eventBus.emit('tasks:batch_complete');
            return;
          }
          console.error('[Task] ExecutionGate batch request failed, proceeding:', e.message);
        }
      }

      log('Executing batch:', tasks.length, 'tasks, mode:', mode || 'sequential');

      // CG-6.4 + G-5.7 BUG FIX: Pipeline (PromptQueue) Flow-only.
      // Nếu batch có task provider!='flow' (chatgpt/grok) → BYPASS pipeline,
      // dùng path direct (line 2317+) để executeSingleTask route đúng adapter.
      const _hasNonFlowProvider = tasks.some(t => t.provider && t.provider !== 'flow');

      // Chuyển sang pipeline PromptQueue nếu bật VÀ batch chỉ có Flow tasks
      if (window.PromptQueue && PromptQueue.isEnabled() && !_hasNonFlowProvider) {
        const afS = window._afSettings || {};
        const settingsPerTask = tasks.map(t => {
          const gt = t.media_type || afS.defaultGenType || 'Image';
          const isVid = gt === 'Video';
          // Group C: Model defaults từ ModelRegistry (server-driven)
          // Phase 6 Bug N.1: strict Server-Only — không fallback hardcoded model name
          const _defVid = window.ModelRegistry?.safeGetDefault('flow', 'video');
          const _defImg = window.ModelRegistry?.safeGetDefault('flow', 'image');
          return {
            genType: gt,
            ratio: t.ratio || afS.defaultRatio || '9:16',
            model: t.model || (isVid ? (afS.defaultVideoModel || _defVid) : (afS.defaultImageModel || _defImg)),
            isFrames: isVid && t.video_input_type === 'Frames',
            quantity: t.quantity || 1,
          };
        });
        const effectiveMode = isParallel ? 'parallel' : 'sequential';
        const result = await PromptQueue.getInstance().submitTaskBatch(
          tasks, effectiveMode, settingsPerTask, { _executionToken: _batchExecutionToken }
        );
        log(`Pipeline batch hoàn tất: ${result.completed} thành công, ${result.failed} thất bại`);
        // ExecutionGate complete/cancel đã được PromptQueue handle — không double-complete
        window._currentTaskExecutionToken = null;
        // Track usage: pipeline batch completed - BUG FIX: only count COMPLETED tasks/prompts
        // (was counting ALL tasks even when stopped mid-execution)
        if (window.featureGate && result.completed > 0) {
          // Track tasks_run_max: 1 per COMPLETED task (not all tasks)
          for (let i = 0; i < result.completed; i++) {
            window.featureGate.recordTaskRun();
          }
          window.featureGate.recordGenRun();
          // Calculate prompts for COMPLETED tasks only (using completion ratio for estimation)
          const totalPlannedPrompts = tasks.reduce((sum, t) => {
            return sum + ((t.multi_prompt && t.prompts?.length > 1) ? t.prompts.length : 1);
          }, 0);
          const completedPrompts = Math.round(totalPlannedPrompts * (result.completed / tasks.length));
          window.featureGate.recordPromptSubmit(completedPrompts || 1, 'task_pipeline');
        }
        // Emit tracker completed
        if (window.eventBus) {
          window.eventBus.emit('execution:tracker_update', {
            owner: 'task', phase: 'completed', current: tasks.length, total: tasks.length
          });
          window.eventBus.emit('tasks:batch_complete');
        }
        if (window.ExecutionLock) ExecutionLock.release('task');
        return;
      }

      // Emit tracker started for batch
      if (window.eventBus) {
        window.eventBus.emit('execution:tracker_update', {
          owner: 'task', label: 'Run All Tasks',
          phase: 'started', current: 0, total: tasks.length,
          taskBatch: { current: 1, total: tasks.length, taskName: tasks[0]?.task_name || '' }
        });
      }

      if (isParallel) {
        // Song song: stagger tasks — chờ submit xong + delay → start task tiếp
        const delayMs = (window.workflowExecutor?.settings?.delayBetweenNodes || 3000);
        const taskPromises = [];

        for (let i = 0; i < tasks.length; i++) {
          if (window._taskBatchStopped) break;
          const task = tasks[i];

          // Emit tracker progress for parallel batch
          if (window.eventBus) {
            window.eventBus.emit('execution:tracker_update', {
              owner: 'task', label: 'Run All Tasks',
              phase: 'prompt_submitting', current: i + 1, total: tasks.length,
              taskBatch: { current: i + 1, total: tasks.length, taskName: task.task_name || '' }
            });
          }

          // Tạo signal cho "đã submit xong"
          let markSubmitted;
          const submittedPromise = new Promise(r => { markSubmitted = r; });

          // Fire-and-forget: task chạy độc lập (chờ tiles + retry riêng)
          const p = executeSingleTask(task, {
            isParallel: true,
            onSubmitted: markSubmitted
          }).catch(() => {});
          taskPromises.push(p);

          // Chờ task này submit xong
          await submittedPromise;

          // Delay giữa các task (theo setting)
          if (i < tasks.length - 1 && !window._taskBatchStopped) {
            await new Promise(r => setTimeout(r, delayMs));
          }
        }

        // Tất cả tasks đã submit xong → re-enable button sớm (không chờ tiles/download)
        if (window.eventBus) {
          window.eventBus.emit('tasks:all_submitted');
        }

        // Chờ tất cả tasks hoàn thành (tiles + retry)
        await Promise.allSettled(taskPromises);
      } else {
        // Tuần tự: chờ task hoàn thành rồi mới chạy task tiếp
        for (let i = 0; i < tasks.length; i++) {
          if (window._taskBatchStopped) break;
          const task = tasks[i];
          // Emit tracker task batch progress
          if (window.eventBus) {
            window.eventBus.emit('execution:tracker_update', {
              owner: 'task', label: 'Run All Tasks',
              phase: 'prompt_submitting', current: i + 1, total: tasks.length,
              taskBatch: { current: i + 1, total: tasks.length, taskName: task.task_name || '' }
            });
          }
          await executeSingleTask(task);
        }
      }

      window._taskBatchStopped = false;
      // Emit tracker batch completed
      if (window.eventBus) {
        window.eventBus.emit('execution:tracker_update', {
          owner: 'task', phase: 'completed', current: tasks.length, total: tasks.length
        });
      }
      // SP-2.4: ExecutionGate complete (batch — chỉ direct mode, pipeline tự handle)
      // Bug 2 fix: khi batch stop, partial complete cần `successful_count` để server refund đúng.
      // Note: best-effort estimate — batch không track per-prompt success count cross-tasks,
      // dùng (tasks.length - currentTaskIndex) làm approximation cho tasks chưa chạy.
      // Tracking chính xác cần Phase 7 refactor batch result aggregation.
      if (window.ExecutionGate && _batchExecutionToken) {
        const batchStatus = window._taskBatchStopped ? 'partial' : 'success';
        // Best-effort: nếu stop mid-batch, ước lượng successful_count = sum of completed tasks' prompts.
        // Hiện chưa track, dùng 0 fallback → server treat như cancel-equivalent (refund tất cả còn lại).
        const batchExtra = batchStatus === 'partial' ? { successful_count: 0 } : {};
        ExecutionGate.complete(_batchExecutionToken, batchStatus, batchExtra);
        window._currentTaskExecutionToken = null;
      }
      // Track usage: calculate total prompts from all tasks in batch
      // Bug 1 note: batch path dùng tổng prompts từ task definitions. Chính xác hơn cần aggregate
      // từng task's executeSingleTask return value — defer Phase 7. Hiện chấp nhận over-count
      // local stats khi batch stop (server-side tracking riêng qua ExecutionService).
      const batchTotalPrompts = tasks.reduce((sum, t) => {
        return sum + ((t.multi_prompt && t.prompts?.length > 1) ? t.prompts.length : 1);
      }, 0);
      if (window.featureGate && batchTotalPrompts > 0) {
        // Track tasks_run_max: 1 per task in batch
        for (let i = 0; i < tasks.length; i++) {
          window.featureGate.recordTaskRun();
        }
        window.featureGate.recordGenRun();
        window.featureGate.recordPromptSubmit(batchTotalPrompts, 'task_batch');
      }
      if (typeof notifyCompletion === 'function') {
        notifyCompletion('Toby Flow', window.I18n?.t('app.batchComplete', { count: tasks.length }) || `Đã hoàn tất batch ${tasks.length} tasks!`);
      }
      if (window.eventBus) {
        window.eventBus.emit('tasks:batch_complete');
      }
      if (window.ExecutionLock) ExecutionLock.release('task');
    });
  }

  /**
   * CG-6.3: Thực thi task qua ChatGPT provider.
   *
   * Khác Flow path:
   *  - Đi qua window.ChatGPTAdapter (qua ProviderRegistry).
   *  - Không dùng PromptQueue (Pipeline mode hiện chỉ wire Flow). ChatGPT đi
   *    direct call qua MessageBridge.chatGPTSubmitAndWait bên trong adapter.
   *  - Ref images: ChatGPT chỉ accept pre-resolved object array (base64). Tile
   *    ID resolution defer sang CG-7 — hiện tại pass [] và để adapter warn.
   *  - Sequential prompts: gửi tuần tự, không parallel (1 tab / 1 editor).
   *  - ExecutionGate dùng action 'chatgpt_run' (đã được map trong adapter).
   *
   * Trả về { success, failed, results } theo convention executeSingleTask.
   */
  /**
   * Fix 10: Resolve task ref_file_ids → base64 objects cho ChatGPT.
   * Port logic từ GenTab._submitViaChatGPT.
   * - task.ref_file_ids: comma-separated string (tile IDs)
   * - task.ref_thumbnails: { tile_id: 'cdn_url' } — có thể là map object
   * - task.ref_file_names: { tile_id: 'uuid.png' }
   * - Cap maxRefImages (default 4 cho ChatGPT)
   * - Fetch URL → base64 qua background.js (bypass CORS)
   *
   * @param {object} task
   * @param {object} adapter - ChatGPTAdapter
   * @returns {Promise<Array<{base64,name,type}>>}
   */
  async function _resolveChatGPTTaskRefs(task, adapter) {
    const idsRaw = task?.ref_file_ids || '';
    const ids = (idsRaw || '').split(',').map(s => s.trim()).filter(Boolean);
    if (ids.length === 0) return { resolved: [], fids: [] };

    const maxRef = adapter?.capabilities?.maxRefImages || 4;
    // Mention mode: resolve TẤT CẢ refs (no pre-cap) vì filter @mention per-prompt
    // sẽ tự bound dưới maxRef. Mode khác: cap trước để tiết kiệm fetch.
    const isMentionMode = task?.ref_image_mode === 'mention';
    const idsToResolve = isMentionMode ? ids : ids.slice(0, maxRef);
    if (!isMentionMode && ids.length > maxRef) {
      console.warn(`[executeTaskViaChatGPT] Vượt giới hạn ref ${maxRef} — chỉ gửi ${maxRef} ảnh đầu`);
    }

    // Lấy thumbnail map: ref_thumbnails có thể là object map { tile_id: url }
    const thumbMap = task?.ref_thumbnails || {};
    const fnMap = task?.ref_file_names || {};

    const resolved = [];
    const fids = [];
    for (const tid of idsToResolve) {
      // Ưu tiên thumbnail từ task data, fallback GenTab.thumbnailCache
      let thumbUrl = null;
      if (typeof thumbMap === 'object' && thumbMap[tid]) {
        // ref_thumbnails có thể là string URL hoặc object {thumbnail, type, file_name}
        const entry = thumbMap[tid];
        thumbUrl = (typeof entry === 'string') ? entry : (entry?.thumbnail || null);
      }
      if (!thumbUrl && window.GenTab?.thumbnailCache?.[tid]) {
        thumbUrl = window.GenTab.thumbnailCache[tid];
      }
      const fileName = fnMap[tid] || window.GenTab?.fileNameCache?.[tid] || `${tid}.png`;
      if (!thumbUrl) {
        console.warn('[executeTaskViaChatGPT] ref skipped — không có thumbnail URL:', tid);
        continue;
      }

      try {
        const fetchResp = await new Promise((resolve) => {
          chrome.runtime.sendMessage({ action: 'fetchBlob', url: thumbUrl }, (r) => resolve(r));
        });
        if (fetchResp?.success && fetchResp.base64) {
          const m = fetchResp.base64.match(/^data:(.+?);base64,(.+)$/);
          if (m) {
            resolved.push({ base64: m[2], name: fileName, type: m[1] });
          } else {
            resolved.push({ base64: fetchResp.base64, name: fileName, type: 'image/png' });
          }
          fids.push(tid);
        }
      } catch (err) {
        console.warn('[executeTaskViaChatGPT] fetch ref blob error:', tid, err.message);
      }
    }
    return { resolved, fids };
  }

  async function _executeTaskViaChatGPT(task, ctx = {}) {
    const { signalSubmitted } = ctx;
    if (!window.ProviderRegistry) {
      throw new Error('ProviderRegistry not loaded');
    }
    const adapter = window.ProviderRegistry.get('chatgpt');
    if (!adapter) {
      throw new Error('ChatGPT adapter not available');
    }

    // CRITICAL — Update task.status='running' để TaskList card hiện running UI (giống Flow path).
    if (window.storageManager) {
      try { await window.storageManager.updateTaskStatus(task.task_id, 'running'); } catch (_) {}
    }
    if (window.eventBus) {
      window.eventBus.emit('task:status_changed', { taskId: task.task_id, status: 'running' });
    }

    // 1. Đảm bảo session sẵn sàng (tab + login + composer ready).
    const ready = await adapter.ensureReady();
    if (!ready || !ready.ready) {
      // Phát event để app.js dialog "Cần đăng nhập ChatGPT" bắt
      if (ready?.error === 'NOT_LOGGED_IN') {
        window.eventBus?.emit('chatgpt:login_required');
      }
      throw new Error(ready?.error || 'CHATGPT_NOT_READY');
    }

    // 2. Multi-prompt support: tách prompts giống Flow path.
    const prompts = (task.multi_prompt && task.prompts && task.prompts.length > 1)
      ? task.prompts
      : [task.prompt];
    const promptCount = prompts.length;

    // 3. ExecutionGate: SKIP nội bộ — task:run handler đã request 'task_run' token (outer gate).
    // Trước fix: request thêm 'chatgpt_run' ở đây gây DOUBLE QUOTA → backend có thể fail →
    // fallback client deny → throw → task completed instantly.
    // Outer task_run đã cover quota check; feature gate `chatgpt_enabled` đã verify permission.
    let gate = null;

    // 4. Submit tuần tự từng prompt (ChatGPT chỉ có 1 editor / tab).
    const results = [];
    let successCount = 0;
    let failedCount = 0;
    // Bug fix: collectedIds/collectedThumbs PHẢI declare NGOÀI try block để finalize logic
    // (Tier 1/1.5/2) truy cập được. Trước fix block-scoped const trong try → ReferenceError
    // "collectedIds is not defined" trong finalize → result_thumbnails không persist.
    const collectedIds = [];
    const collectedThumbs = {};
    let thumbCounter = 0;
    try {
      // Báo signal submitted ngay sau khi qua quota check (UI unlock)
      try { signalSubmitted?.(); } catch (_) {}

      // Fix 10: Resolve task ref_file_ids → base64 (port logic từ GenTab._submitViaChatGPT)
      const { resolved: refImagesResolved, fids: refResolvedFids } = await _resolveChatGPTTaskRefs(task, adapter);

      // Mention mode: pre-build map slug → fid để filter refs per-prompt
      const taskIsMentionMode = task?.ref_image_mode === 'mention';
      const taskMaxRef = adapter?.capabilities?.maxRefImages || 4;
      let taskMentionNameToFid = null;
      if (taskIsMentionMode) {
        const slugMap = task?.ref_image_names || {};
        taskMentionNameToFid = {};
        for (const fid of refResolvedFids) {
          const slug = slugMap[fid];
          if (slug) taskMentionNameToFid[String(slug).toLowerCase()] = fid;
        }
      }

      // Fix 7: Auto-download settings cho task path
      const taskAutoDownload = !!(task.auto_download) && !!(window.featureGate?.canUse?.('auto_download'));

      // Delete after gen setting — đọc từ task config (saved by TaskModal)
      const deleteAfterGen = !!task.chatgpt_delete_after_gen;

      // Single source of truth qua DownloadHelper.getSettings() — tránh bug mismatch key
      // (fileNameTemplate vs legacy `downloadTemplate`). Fix 2026-05-22.
      const _cgTaskDl = await window.DownloadHelper.getSettings();
      const _cgTaskDownloadFolder = _cgTaskDl.folder;
      const _cgTaskDownloadTemplate = _cgTaskDl.template;

      // Đọc af_settings cho chatgptFallbackPrefix — Adapter Option B ưu tiên explicit prefix,
      // nếu undefined → adapter tự đọc storage qua `_getFallbackPrefix()`. Pass-through tránh
      // adapter mỗi prompt phải re-read storage. Bug fix: trước đây dùng `_cgTaskSettings`
      // chưa declared → ReferenceError "is not defined" khi run ChatGPT task.
      const _cgTaskSettings = await new Promise(resolve =>
        chrome.storage.local.get(['af_settings'], r => resolve(r.af_settings || {}))
      );

      // collectedIds/collectedThumbs/thumbCounter — đã declare NGOÀI try block để finalize
      // (Tier 1/1.5/2) truy cập được. Loop dưới push synthetic ID 'cg_{timestamp}_{idx}'.

      for (let i = 0; i < prompts.length; i++) {
        if (window._taskShouldStop || window._taskBatchStopped) {
          console.log('[executeTaskViaChatGPT] Stopped by user');
          break;
        }
        const prompt = prompts[i];

        // Mention mode: filter refs theo @mention trong prompt hiện tại + cap maxRef
        let refsForThisPrompt = refImagesResolved;
        if (taskIsMentionMode && taskMentionNameToFid) {
          const mentions = prompt.match(/@([\p{L}\p{N}_]+)/gu) || [];
          const matchedFids = new Set();
          for (const m of mentions) {
            const name = m.substring(1).toLowerCase();
            const fid = taskMentionNameToFid[name];
            if (fid) matchedFids.add(fid);
          }
          refsForThisPrompt = refImagesResolved.filter((_, idx) => matchedFids.has(refResolvedFids[idx]));
          if (refsForThisPrompt.length > taskMaxRef) {
            console.warn(`[executeTaskViaChatGPT] prompt ${i + 1}: ${refsForThisPrompt.length} mention vượt cap ${taskMaxRef} — chỉ gửi ${taskMaxRef} đầu`);
            refsForThisPrompt = refsForThisPrompt.slice(0, taskMaxRef);
          }
        }

        try {
          const result = await adapter.submit({
            prompt,
            // Fix 10: pass resolved refs (base64 objects)
            refFileIds: refsForThisPrompt,
            settings: {
              ratio: task.ratio || 'story',
              model: task.model || _cgTaskSettings.chatgptModel || null, // Instant | Thinking (GPT-5.5)
              // Đồng bộ với GenTab pattern: truyền explicit fallbackPrefix từ user settings.
              // ChatGPTAdapter Option B sẽ ưu tiên giá trị này; nếu undefined → tự đọc storage qua _getFallbackPrefix().
              fallbackPrefix: _cgTaskSettings.chatgptFallbackPrefix || 'Generate an image of: ',
            },
            taskName: task.task_name || null,
          });
          if (result && result.success) {
            successCount++;
            // Bug 2 fix: expose live successCount để ExecutionTracker._handleStop
            // có thể `complete('partial', { successful_count })` chính xác khi user stop.
            window._currentTaskSuccessCount = successCount;
            if (Array.isArray(result.imageUrls)) {
              results.push(...result.imageUrls);
              // Capture each URL với synthetic ID để TaskList/TaskModal render thumbnails.
              const _ts = Date.now();
              for (const url of result.imageUrls) {
                if (!url) continue;
                const synthId = `cg_${_ts}_${thumbCounter++}`;
                collectedIds.push(synthId);
                collectedThumbs[synthId] = {
                  thumbnail: url,
                  type: 'image',
                  file_name: '',
                };
              }
            }

            // Fix 7: Auto-download cho task path — fetch CDN URL → blob → chrome.downloads
            if (taskAutoDownload && result.tabId && Array.isArray(result.imageUrls)) {
              for (let urlIdx = 0; urlIdx < result.imageUrls.length; urlIdx++) {
                const url = result.imageUrls[urlIdx];
                try {
                  const fetchResp = await window.MessageBridge?.chatGPTFetchImage?.(url, result.tabId);
                  if (fetchResp?.success && fetchResp.base64) {
                    const blob = await (await fetch(fetchResp.base64)).blob();
                    const blobUrl = URL.createObjectURL(blob);
                    // Tái dùng GenTab helper — pass downloadFolder + downloadTemplate từ user settings.
                    const filename = window.GenTab?._buildChatGPTFilename?.(
                      _cgTaskDownloadTemplate,
                      window._currentProjectName || 'flow',
                      prompt,
                      i + 1,
                      urlIdx + 1,
                      '',
                      task.task_name,
                      _cgTaskDownloadFolder // ← root folder từ user settings
                    ) || `${_cgTaskDownloadFolder}/${task.task_name}/chatgpt_${Date.now()}.png`;
                    await new Promise((resolve) => {
                      chrome.runtime.sendMessage(
                        { action: 'chromeDownload', url: blobUrl, filename, waitForComplete: deleteAfterGen },
                        () => resolve()
                      );
                    });
                    setTimeout(() => URL.revokeObjectURL(blobUrl), deleteAfterGen ? 5000 : 30000);
                  }
                } catch (dlErr) {
                  console.warn('[executeTaskViaChatGPT] auto-download error:', dlErr);
                }
              }
            }

            // Delete after gen: xóa tin nhắn khỏi ChatGPT sau khi download xong
            if (deleteAfterGen && window.ChatGPTSession) {
              try {
                const deleteResp = await window.ChatGPTSession.deleteLastMessage();
                if (deleteResp?.success) {
                  console.log('[executeTaskViaChatGPT] deleteAfterGen: deleted message');
                } else {
                  console.warn('[executeTaskViaChatGPT] deleteAfterGen failed:', deleteResp?.error);
                }
              } catch (delErr) {
                console.warn('[executeTaskViaChatGPT] deleteAfterGen error:', delErr.message);
              }
            }

            // Incremental persist: lưu results ngay sau mỗi prompt thành công
            // Giúp bảo toàn kết quả khi user stop giữa chừng
            if (collectedIds.length > 0 && window.storageManager) {
              try {
                const partialTask = await window.storageManager.getTask(task.task_id);
                if (partialTask) {
                  const existingIds = (partialTask.result_file_ids || '').split(',').map(s => s.trim()).filter(Boolean);
                  const mergedIds = [...new Set([...existingIds, ...collectedIds])];
                  partialTask.result_file_ids = mergedIds.join(', ');
                  partialTask.result_thumbnails = { ...(partialTask.result_thumbnails || {}), ...collectedThumbs };
                  await window.storageManager.saveTask(partialTask);
                  console.log('[executeTaskViaChatGPT] Incremental save:', collectedIds.length, 'results');
                }
              } catch (partialErr) {
                console.warn('[executeTaskViaChatGPT] Incremental save failed:', partialErr.message);
              }
            }
          } else {
            failedCount++;
            console.warn('[executeTaskViaChatGPT] Submit failed:', result?.error, result?.message);

            // LIMIT_ALERT: ChatGPT free plan đã hết quota → break loop, cảnh báo user
            if (result?.error === 'LIMIT_ALERT') {
              console.warn('[executeTaskViaChatGPT] LIMIT_ALERT — dừng task');
              failedCount += (prompts.length - i - 1);  // các prompt còn lại đều fail
              if (window.customDialog?.alert) {
                const msg = result.message
                  || "ChatGPT đã hết lượt tạo ảnh trên gói Free. Vui lòng nâng cấp ChatGPT Plus hoặc thử lại sau.";
                window.customDialog.alert(msg, {
                  title: 'ChatGPT — Hết lượt tạo ảnh',
                  type: 'warning',
                });
              }
              break;
            }
          }
        } catch (e) {
          failedCount++;
          console.error('[executeTaskViaChatGPT] Submit exception:', e?.message || e);
        }
        // Anti rate-limit: nghỉ 2s giữa các prompts (chỉ khi còn prompt tiếp theo).
        if (i < prompts.length - 1) {
          await new Promise((r) => setTimeout(r, 2000));
        }
      }

      // 5. ExecutionGate complete: success nếu có ít nhất 1 prompt thành công.
      if (gate && gate.token && window.ExecutionGate) {
        await window.ExecutionGate.complete(gate.token, successCount > 0 ? 'success' : 'failed');
      }
    } catch (err) {
      if (gate && gate.token && window.ExecutionGate) {
        try { await window.ExecutionGate.complete(gate.token, 'failed'); } catch (_) {}
      }
      // Update task status → failed (cho TaskList UI)
      if (window.storageManager) {
        try { await window.storageManager.updateTaskStatus(task.task_id, 'failed'); } catch (_) {}
      }
      if (window.eventBus) {
        window.eventBus.emit('task:status_changed', { taskId: task.task_id, status: 'failed' });
      }
      throw err;
    }

    // ATOMIC persist — combine result_thumbnails + status vào 1 saveTask để tránh
    // race condition. Stopped path → status='pending' để task có thể run lại.
    const wasStopped = window._taskShouldStop || window._taskBatchStopped;
    const finalStatus = wasStopped
      ? 'pending'
      : (successCount > 0 ? 'completed' : 'failed');

    if (window.storageManager) {
      let persisted = false;
      try {
        const freshTask = await window.storageManager.getTask(task.task_id);
        if (freshTask) {
          if (collectedIds.length > 0) {
            // Merge results for multi-prompt tasks — dùng Set để deduplicate (incremental save đã lưu trước đó)
            const existingIds = (freshTask.result_file_ids || '').split(',').map(s => s.trim()).filter(Boolean);
            const mergedIds = [...new Set([...existingIds, ...collectedIds])];
            freshTask.result_file_ids = mergedIds.join(', ');
            freshTask.result_thumbnails = { ...(freshTask.result_thumbnails || {}), ...collectedThumbs };
          }
          freshTask.status = finalStatus;
          if (finalStatus === 'completed' || finalStatus === 'failed') {
            freshTask.executed_at = Date.now();
          }
          await window.storageManager.saveTask(freshTask);
          task.result_file_ids = freshTask.result_file_ids;
          task.result_thumbnails = freshTask.result_thumbnails;
          task.status = freshTask.status;
          persisted = true;
        }
      } catch (e) {
        console.warn('[executeTaskViaChatGPT] Persist final task failed:', e.message);
      }

      // Bug fix: nếu getTask/saveTask fail, dùng 3-tier fallback để persist result data + status.
      // Tier 1.5: saveTask với cleaned payload — strip Grok fields có thể chưa migrate (defensive).
      // Tier 2: PATCH với result data — cần backend TaskController fix.
      // Tier 3: PATCH chỉ status — đảm bảo UI clear running.
      if (!persisted) {
        const mergedResultIds = collectedIds.length > 0
          ? [...((task.result_file_ids || '').split(',').map(s => s.trim()).filter(Boolean)), ...collectedIds].join(', ')
          : (task.result_file_ids || '');
        const mergedThumbs = collectedIds.length > 0
          ? { ...(task.result_thumbnails || {}), ...collectedThumbs }
          : (task.result_thumbnails || null);

        // Tier 1.5: saveTask với cleaned payload
        try {
          const freshTaskRetry = await window.storageManager.getTask(task.task_id);
          if (freshTaskRetry) {
            const cleanedTask = { ...freshTaskRetry };
            delete cleanedTask.grok_mode;
            delete cleanedTask.grok_duration;
            delete cleanedTask.grok_resolution;
            delete cleanedTask.grok_image_quality;
            cleanedTask.result_file_ids = mergedResultIds;
            cleanedTask.result_thumbnails = mergedThumbs;
            cleanedTask.status = finalStatus;
            cleanedTask.executed_at = Date.now();
            await window.storageManager.saveTask(cleanedTask);
            task.result_file_ids = mergedResultIds;
            task.result_thumbnails = mergedThumbs;
            task.status = finalStatus;
            persisted = true;
            console.log('[executeTaskViaChatGPT] Tier 1.5 saveTask cleaned OK');
          }
        } catch (e) {
          console.warn('[executeTaskViaChatGPT] Tier 1.5 saveTask cleaned failed:', e.message);
        }

        // Tier 2: PATCH với result data
        if (!persisted) {
          try {
            await window.storageManager.updateTaskStatus(task.task_id, finalStatus, mergedResultIds, {
              result_thumbnails: mergedThumbs,
              executed_at: new Date().toISOString(),
            });
            task.status = finalStatus;
            if (collectedIds.length > 0) {
              task.result_file_ids = mergedResultIds;
              task.result_thumbnails = mergedThumbs;
            }
            persisted = true;
          } catch (e) {
            console.warn('[executeTaskViaChatGPT] Tier 2 PATCH với result data failed:', e.message);
          }
        }

        // Tier 3: Last resort - status only
        if (!persisted) {
          try {
            await window.storageManager.updateTaskStatus(task.task_id, finalStatus);
            task.status = finalStatus;
            console.warn('[executeTaskViaChatGPT] Tier 3 status-only OK (result data lost)');
          } catch (e) {
            console.error('[executeTaskViaChatGPT] Tier 3 updateTaskStatus failed:', e.message);
            task.status = finalStatus;
          }
        }
      }
    }

    if (window.eventBus) {
      window.eventBus.emit('task:status_changed', {
        taskId: task.task_id,
        taskName: task.task_name,
        mediaType: task.media_type,
        status: finalStatus,
        prompt: task.prompt || '',
        media_type: task.media_type || 'image',
        model: '',
        ratio: task.ratio || '',
        // Phase Analytics-3: ChatGPT task — N prompt (multi_prompt) × 1 ảnh/prompt
        prompt_count: (task.multi_prompt && task.prompts?.length) ? task.prompts.length : 1,
        quantity: 1,
        ref_file_ids: task.ref_file_ids || '',
        result_file_ids: task.result_file_ids || '',
        result_thumbnails: task.result_thumbnails ? Object.values(task.result_thumbnails) : [],
        result_file_names: {},
        task_id: task.task_id,
        provider: 'chatgpt', // SS-Phase G: _executeTaskViaChatGPT path
        project_id: task.project_id || null,
        auto_download: !!task.auto_download
      });
      if (finalStatus === 'completed') {
        window.eventBus.emit('task:complete', {
          taskId: task.task_id,
          taskName: task.task_name,
          resultCount: collectedIds.length
        });
      }
    }

    return { success: successCount, failed: failedCount, results, stopped: wasStopped };
  }

  /**
   * G-5.9: Resolve task ref images cho Grok task path.
   * Mirror `_resolveChatGPTTaskRefs` nhưng dùng GrokAdapter capabilities (maxRefImages=4).
   *
   * - Input: `task.ref_file_ids` (comma-separated tile IDs Flow), `task.ref_thumbnails`
   *   (object map, có thể là string URL hoặc {thumbnail, type, file_name}).
   * - Cap maxRefImages (default 4 cho Grok)
   * - Fetch URL → base64 qua background.js (bypass CORS)
   *
   * @param {object} task
   * @param {object} adapter - GrokAdapter
   * @returns {Promise<Array<{base64,name,type}>>}
   */
  async function _resolveGrokTaskRefs(task, adapter) {
    const idsRaw = task?.ref_file_ids || '';
    const ids = (idsRaw || '').split(',').map(s => s.trim()).filter(Boolean);
    if (ids.length === 0) return { resolved: [], fids: [] };

    const maxRef = adapter?.capabilities?.maxRefImages || 4;
    // Mention mode: resolve TẤT CẢ refs (no pre-cap) vì filter @mention per-prompt
    // sẽ tự bound dưới maxRef.
    const isMentionMode = task?.ref_image_mode === 'mention';
    const idsToResolve = isMentionMode ? ids : ids.slice(0, maxRef);
    if (!isMentionMode && ids.length > maxRef) {
      console.warn(`[executeTaskViaGrok] Vượt giới hạn ref ${maxRef} — chỉ gửi ${maxRef} ảnh đầu`);
    }

    const thumbMap = task?.ref_thumbnails || {};
    const fnMap = task?.ref_file_names || {};

    const resolved = [];
    const fids = [];
    for (const tid of idsToResolve) {
      // Ưu tiên thumbnail từ task data, fallback GenTab.thumbnailCache
      let thumbUrl = null;
      if (typeof thumbMap === 'object' && thumbMap[tid]) {
        const entry = thumbMap[tid];
        thumbUrl = (typeof entry === 'string') ? entry : (entry?.thumbnail || null);
      }
      if (!thumbUrl && window.GenTab?.thumbnailCache?.[tid]) {
        thumbUrl = window.GenTab.thumbnailCache[tid];
      }
      const fileName = fnMap[tid] || window.GenTab?.fileNameCache?.[tid] || `${tid}.png`;
      if (!thumbUrl) {
        console.warn('[executeTaskViaGrok] ref skipped — không có thumbnail URL:', tid);
        continue;
      }

      try {
        const fetchResp = await new Promise((resolve) => {
          chrome.runtime.sendMessage({ action: 'fetchBlob', url: thumbUrl }, (r) => resolve(r));
        });
        if (fetchResp?.success && fetchResp.base64) {
          const m = fetchResp.base64.match(/^data:(.+?);base64,(.+)$/);
          if (m) {
            resolved.push({ base64: m[2], name: fileName, type: m[1] });
          } else {
            resolved.push({ base64: fetchResp.base64, name: fileName, type: 'image/png' });
          }
          fids.push(tid);
        }
      } catch (err) {
        console.warn('[executeTaskViaGrok] fetch ref blob error:', tid, err.message);
      }
    }
    return { resolved, fids };
  }

  /**
   * G-5.9: Execute task via Grok provider (mirror _executeTaskViaChatGPT).
   *
   * Pipeline mode: ChatGPT/Grok tasks BYPASS PromptQueue (Pipeline path Flow-only).
   * Note rõ trong comment để future devs không nhầm — nếu cần Pipeline support cho
   * Grok, tách Phase G-9 (low priority — Grok sequential tự nhiên rồi, không hưởng
   * lợi từ Pipeline).
   *
   * @param {object} task
   * @param {object} ctx - { signalSubmitted }
   * @returns {Promise<{success, failed, results}>}
   */
  async function _executeTaskViaGrok(task, ctx = {}) {
    const { signalSubmitted } = ctx;
    if (!window.ProviderRegistry) {
      throw new Error('ProviderRegistry not loaded');
    }
    const adapter = window.ProviderRegistry.get('grok');
    if (!adapter) {
      throw new Error('GROK_ADAPTER_NOT_LOADED');
    }

    // CRITICAL — Update task.status='running' để TaskList card hiện running UI (giống Flow path).
    // Trước fix: chỉ Flow path update status (line 3145+), ChatGPT/Grok bypass → card không hiện.
    if (window.storageManager) {
      try { await window.storageManager.updateTaskStatus(task.task_id, 'running'); } catch (_) {}
    }
    if (window.eventBus) {
      window.eventBus.emit('task:status_changed', { taskId: task.task_id, status: 'running' });
    }

    // 1. Đảm bảo session sẵn sàng (tab + login + content script ready).
    const ready = await adapter.ensureReady();
    if (!ready || !ready.ready) {
      // Phát event để app.js dialog "Cần đăng nhập Grok" bắt
      if (ready?.error === 'NOT_LOGGED_IN') {
        window.eventBus?.emit('grok:login_required');
      }
      throw new Error(ready?.error || 'GROK_NOT_READY');
    }

    // 2. Multi-prompt support: tách prompts giống Flow path.
    const prompts = (task.multi_prompt && task.prompts && task.prompts.length > 1)
      ? task.prompts
      : [task.prompt];
    const promptCount = prompts.length;

    // 3. ExecutionGate: SKIP nội bộ — task:run handler đã request 'task_run' token (outer gate).
    // Trước fix: request thêm 'grok_run' ở đây gây DOUBLE QUOTA → backend 500 → fallback client deny
    // → throw QUOTA_EXHAUSTED → task completed instantly.
    // Outer task_run đã cover quota check; feature gate `grok_enabled` (line 2477+ caller path)
    // đã verify permission. Không cần inner gate.
    let gate = null;

    // 4. Submit tuần tự từng prompt (Grok chỉ có 1 editor / tab + redirect flow).
    const results = [];
    let successCount = 0;
    let failedCount = 0;
    // Bug fix: collectedIds/collectedThumbs PHẢI declare NGOÀI try block để finalize logic
    // (Tier 1/1.5/2 trong if (window.storageManager) block) truy cập được. Trước fix block-scoped
    // const trong try → ReferenceError "collectedIds is not defined" trong finalize → mất result data.
    const collectedIds = [];
    const collectedThumbs = {};
    let thumbCounter = 0;
    try {
      // Báo signal submitted ngay sau khi qua quota check (UI unlock)
      try { signalSubmitted?.(); } catch (_) {}

      // Resolve task ref_file_ids → base64 (port logic từ ChatGPT path)
      const { resolved: refImagesResolved, fids: refResolvedFids } = await _resolveGrokTaskRefs(task, adapter);

      // Mention mode: pre-build map slug → fid để filter refs per-prompt
      const taskIsMentionMode = task?.ref_image_mode === 'mention';
      const taskMaxRef = adapter?.capabilities?.maxRefImages || 4;
      let taskMentionNameToFid = null;
      if (taskIsMentionMode) {
        const slugMap = task?.ref_image_names || {};
        taskMentionNameToFid = {};
        for (const fid of refResolvedFids) {
          const slug = slugMap[fid];
          if (slug) taskMentionNameToFid[String(slug).toLowerCase()] = fid;
        }
      }

      // Auto-download settings cho task path
      const taskAutoDownload = !!(task.auto_download) && !!(window.featureGate?.canUse?.('auto_download'));

      // Single source of truth qua DownloadHelper.getSettings() — tránh bug mismatch key. Fix 2026-05-22.
      const _grokTaskDl = await window.DownloadHelper.getSettings();
      const _grokTaskDownloadFolder = _grokTaskDl.folder;
      const _grokTaskDownloadTemplate = _grokTaskDl.template;

      // collectedIds/collectedThumbs/thumbCounter — đã declare NGOÀI try block (line ~2918) để
      // finalize block (Tier 1/1.5/2 phía sau) truy cập được. Loop dưới push vào.
      // Format result_thumbnails giống Flow: { tileId: { thumbnail, type, file_name } }.

      // Watchdog: poll _taskShouldStop mỗi 500ms, gửi grok:abort tới content script khi detect.
      // adapter.submit có thể block lâu (gen video 5 phút) → cần signal abort qua message.
      let _grokWatchdogTimer = null;
      const _startWatchdog = (tabIdToAbort) => {
        if (_grokWatchdogTimer) return;
        _grokWatchdogTimer = setInterval(() => {
          if (window._taskShouldStop || window._taskBatchStopped) {
            console.log('[executeTaskViaGrok] Stop detected → abort content script');
            if (tabIdToAbort && window.MessageBridge?.grokAbort) {
              window.MessageBridge.grokAbort(tabIdToAbort).catch(() => {});
            }
            clearInterval(_grokWatchdogTimer);
            _grokWatchdogTimer = null;
          }
        }, 500);
      };
      const _stopWatchdog = () => {
        if (_grokWatchdogTimer) {
          clearInterval(_grokWatchdogTimer);
          _grokWatchdogTimer = null;
        }
      };

      // Get tabId early để watchdog có sẵn target ngay.
      const _grokTabInfo = await window.GrokSession?.getTabInfo?.();
      const _grokTabId = _grokTabInfo?.tabId;

      for (let i = 0; i < prompts.length; i++) {
        if (window._taskShouldStop || window._taskBatchStopped) {
          console.log('[executeTaskViaGrok] Stopped by user');
          break;
        }
        const prompt = prompts[i];

        // Mention mode: filter refs theo @mention trong prompt hiện tại + cap maxRef
        let refsForThisPrompt = refImagesResolved;
        if (taskIsMentionMode && taskMentionNameToFid) {
          const mentions = prompt.match(/@([\p{L}\p{N}_]+)/gu) || [];
          const matchedFids = new Set();
          for (const m of mentions) {
            const name = m.substring(1).toLowerCase();
            const fid = taskMentionNameToFid[name];
            if (fid) matchedFids.add(fid);
          }
          refsForThisPrompt = refImagesResolved.filter((_, idx) => matchedFids.has(refResolvedFids[idx]));
          if (refsForThisPrompt.length > taskMaxRef) {
            console.warn(`[executeTaskViaGrok] prompt ${i + 1}: ${refsForThisPrompt.length} mention vượt cap ${taskMaxRef} — chỉ gửi ${taskMaxRef} đầu`);
            refsForThisPrompt = refsForThisPrompt.slice(0, taskMaxRef);
          }
        }

        _startWatchdog(_grokTabId);
        try {
          const result = await adapter.submit({
            prompt,
            refFileIds: refsForThisPrompt,
            settings: {
              mode: task.grok_mode || 'image',
              ratio: task.ratio || 'widescreen',
              quantity: task.quantity || 1,
              duration: task.grok_duration || '6s',
              resolution: task.grok_resolution || '720p',
              imageQuality: task.grok_image_quality || 'speed',
              timeout: 180000,
            },
            taskName: task.task_name || null,
          });
          _stopWatchdog();
          // Abort path — adapter.submit return với error='ABORTED' khi user click stop.
          if (result?.error === 'ABORTED') {
            console.log('[executeTaskViaGrok] Adapter returned ABORTED → break loop');
            break;
          }
          if (result && result.success) {
            successCount++;
            // Bug 2 fix: expose live successCount để ExecutionTracker._handleStop
            // có thể `complete('partial', { successful_count })` chính xác khi user stop.
            window._currentTaskSuccessCount = successCount;
            if (Array.isArray(result.mediaUrls)) {
              results.push(...result.mediaUrls);
              // Capture each URL với synthetic ID để TaskList/TaskModal render thumbnails.
              // Grok có thể trả video → set type='video' để TaskList render <video> tag.
              const _ts = Date.now();
              const isVideo = result.mediaType === 'video' || (task.grok_mode === 'video');
              for (const url of result.mediaUrls) {
                if (!url) continue;
                const synthId = `grok_${_ts}_${thumbCounter++}`;
                collectedIds.push(synthId);
                collectedThumbs[synthId] = {
                  thumbnail: url,
                  type: isVideo ? 'video' : 'image',
                  file_name: '',
                };
              }
            }

            // Auto-download cho task path — fetch CDN URL → blob → chrome.downloads
            if (taskAutoDownload && result.tabId && Array.isArray(result.mediaUrls)) {
              for (let urlIdx = 0; urlIdx < result.mediaUrls.length; urlIdx++) {
                // Bug fix: check stop flag trước mỗi download → break sớm khi user click Stop
                if (window._taskShouldStop || window._taskBatchStopped) {
                  console.log('[executeTaskViaGrok] Stop detected during auto-download → break');
                  break;
                }
                const url = result.mediaUrls[urlIdx];
                try {
                  const fetchResp = await window.MessageBridge?.grokFetchImage?.(url, result.tabId);
                  if (fetchResp?.success && fetchResp.base64) {
                    const blob = await (await fetch(fetchResp.base64)).blob();
                    const blobUrl = URL.createObjectURL(blob);
                    // Determine extension: video MP4, else PNG
                    const isVideo = result.mediaType === 'video' || (task.grok_mode === 'video');
                    const ext = isVideo ? 'mp4' : 'png';
                    // Tái dùng GenTab _buildChatGPTFilename helper (signature giống — Grok dùng cùng pattern).
                    // Pass downloadFolder + downloadTemplate từ settings để file save đúng folder user set.
                    let filename = window.GenTab?._buildChatGPTFilename?.(
                      _grokTaskDownloadTemplate,
                      window._currentProjectName || 'flow',
                      prompt,
                      i + 1,
                      urlIdx + 1,
                      '',
                      task.task_name,
                      _grokTaskDownloadFolder // ← root folder từ user settings
                    ) || `${_grokTaskDownloadFolder}/${task.task_name || 'grok'}/grok_${Date.now()}.${ext}`;
                    // Replace extension nếu helper trả PNG mặc định và task là video
                    if (isVideo && filename.endsWith('.png')) {
                      filename = filename.replace(/\.png$/i, '.mp4');
                    }
                    await new Promise((resolve) => {
                      chrome.runtime.sendMessage(
                        { action: 'chromeDownload', url: blobUrl, filename },
                        () => resolve()
                      );
                    });
                    setTimeout(() => URL.revokeObjectURL(blobUrl), 30000);
                  }
                } catch (dlErr) {
                  console.warn('[executeTaskViaGrok] auto-download error:', dlErr);
                }
              }
            }

            // Incremental persist: lưu results ngay sau mỗi prompt thành công
            // Giúp bảo toàn kết quả khi user stop giữa chừng
            if (collectedIds.length > 0 && window.storageManager) {
              try {
                const partialTask = await window.storageManager.getTask(task.task_id);
                if (partialTask) {
                  const existingIds = (partialTask.result_file_ids || '').split(',').map(s => s.trim()).filter(Boolean);
                  const mergedIds = [...new Set([...existingIds, ...collectedIds])];
                  partialTask.result_file_ids = mergedIds.join(', ');
                  partialTask.result_thumbnails = { ...(partialTask.result_thumbnails || {}), ...collectedThumbs };
                  await window.storageManager.saveTask(partialTask);
                  console.log('[executeTaskViaGrok] Incremental save:', collectedIds.length, 'results');
                }
              } catch (partialErr) {
                console.warn('[executeTaskViaGrok] Incremental save failed:', partialErr.message);
              }
            }
          } else {
            failedCount++;
            console.warn('[executeTaskViaGrok] Submit failed:', result?.error, result?.message);

            // LIMIT_ALERT: Grok đã hết quota → break loop, cảnh báo user
            if (result?.error === 'LIMIT_ALERT' || result?.error === 'RATE_LIMIT') {
              console.warn('[executeTaskViaGrok] LIMIT_ALERT — dừng task');
              failedCount += (prompts.length - i - 1);
              if (window.customDialog?.alert) {
                const msg = result.message
                  || 'Grok đã hết lượt tạo. Vui lòng thử lại sau hoặc nâng cấp gói.';
                window.customDialog.alert(msg, {
                  title: 'Grok — Hết lượt tạo',
                  type: 'warning',
                });
              }
              break;
            }
          }
        } catch (e) {
          _stopWatchdog();
          failedCount++;
          console.error('[executeTaskViaGrok] Submit exception:', e?.message || e);
        }
        // Anti rate-limit: nghỉ 2s giữa các prompts (chỉ khi còn prompt tiếp theo).
        if (i < prompts.length - 1) {
          await new Promise((r) => setTimeout(r, 2000));
        }
      }

      // Cleanup watchdog (nếu chưa cleared trong loop).
      _stopWatchdog();

      // 5. ExecutionGate complete: success nếu có ít nhất 1 prompt thành công.
      if (gate && gate.token && window.ExecutionGate) {
        await window.ExecutionGate.complete(gate.token, successCount > 0 ? 'success' : 'failed');
      }
    } catch (err) {
      _stopWatchdog();
      if (gate && gate.token && window.ExecutionGate) {
        try { await window.ExecutionGate.complete(gate.token, 'failed'); } catch (_) {}
      }
      // Update task status → failed (cho TaskList UI)
      if (window.storageManager) {
        try { await window.storageManager.updateTaskStatus(task.task_id, 'failed'); } catch (_) {}
      }
      if (window.eventBus) {
        window.eventBus.emit('task:status_changed', { taskId: task.task_id, status: 'failed' });
      }
      throw err;
    }

    // ATOMIC persist — combine result_thumbnails + status vào 1 saveTask để tránh
    // race condition (TaskList loadTasks giữa 2 saveTask thấy status='running' với
    // result_thumbnails đã có nhưng card không render thumb vì check status==='completed').
    // Stopped path → status='pending' để task có thể run lại.
    const wasStopped = window._taskShouldStop || window._taskBatchStopped;
    const finalStatus = wasStopped
      ? 'pending'
      : (successCount > 0 ? 'completed' : 'failed');

    if (window.storageManager) {
      let persisted = false;
      try {
        const freshTask = await window.storageManager.getTask(task.task_id);
        if (freshTask) {
          // Merge result thumbnails (nếu có)
          if (collectedIds.length > 0) {
            // Merge results for multi-prompt tasks — dùng Set để deduplicate (incremental save đã lưu trước đó)
            const existingIds = (freshTask.result_file_ids || '').split(',').map(s => s.trim()).filter(Boolean);
            const mergedIds = [...new Set([...existingIds, ...collectedIds])];
            freshTask.result_file_ids = mergedIds.join(', ');
            freshTask.result_thumbnails = { ...(freshTask.result_thumbnails || {}), ...collectedThumbs };
          }
          // Set status + executed_at trong CÙNG saveTask
          freshTask.status = finalStatus;
          if (finalStatus === 'completed' || finalStatus === 'failed') {
            freshTask.executed_at = Date.now();
          }
          await window.storageManager.saveTask(freshTask);
          // Update local reference cho event payload.
          task.result_file_ids = freshTask.result_file_ids;
          task.result_thumbnails = freshTask.result_thumbnails;
          task.status = freshTask.status;
          persisted = true;
        }
      } catch (e) {
        console.warn('[executeTaskViaGrok] Persist final task failed:', e.message);
      }

      // Bug fix: nếu getTask/saveTask fail (race condition / API timeout / SQL schema mismatch),
      // vẫn PHẢI update status + result data để UI clear "running" + tab Result hiện thumbnails.
      //
      // Tier 1.5 (NEW): Retry saveTask với CLEANED payload — loại Grok-specific fields có thể
      //   gây SQL error nếu user's backend chưa migrate (grok_mode, grok_duration, etc.).
      //   UpdateTaskRequest validation có sẵn rule cho result_thumbnails từ lâu → PUT path
      //   đáng tin cậy hơn PATCH (PATCH endpoint mới được fix gần đây, có thể user chưa deploy).
      //
      // Tier 2: PATCH /tasks/{id}/status với result data — chỉ work nếu backend đã có fix
      //   thêm result_thumbnails vào $request->only() trong TaskController.updateStatus.
      //
      // Tier 3: PATCH chỉ status — đảm bảo UI clear "running" badge dù backend reject result.
      if (!persisted) {
        const mergedResultIds = collectedIds.length > 0
          ? [...((task.result_file_ids || '').split(',').map(s => s.trim()).filter(Boolean)), ...collectedIds].join(', ')
          : (task.result_file_ids || '');
        const mergedThumbs = collectedIds.length > 0
          ? { ...(task.result_thumbnails || {}), ...collectedThumbs }
          : (task.result_thumbnails || null);

        // Tier 1.5: saveTask với cleaned payload (strip Grok config fields có thể chưa migrate)
        try {
          const freshTaskRetry = await window.storageManager.getTask(task.task_id);
          if (freshTaskRetry) {
            const cleanedTask = { ...freshTaskRetry };
            // Strip Grok-specific fields có thể gây SQL "Unknown column" nếu backend chưa migrate
            delete cleanedTask.grok_mode;
            delete cleanedTask.grok_duration;
            delete cleanedTask.grok_resolution;
            delete cleanedTask.grok_image_quality;
            cleanedTask.result_file_ids = mergedResultIds;
            cleanedTask.result_thumbnails = mergedThumbs;
            cleanedTask.status = finalStatus;
            cleanedTask.executed_at = Date.now();
            await window.storageManager.saveTask(cleanedTask);
            task.result_file_ids = mergedResultIds;
            task.result_thumbnails = mergedThumbs;
            task.status = finalStatus;
            persisted = true;
            console.log('[executeTaskViaGrok] Tier 1.5 saveTask cleaned payload OK');
          }
        } catch (e) {
          console.warn('[executeTaskViaGrok] Tier 1.5 saveTask cleaned failed:', e.message);
        }
      }

      // Tier 2: PATCH với result data (cần backend fix mới)
      if (!persisted) {
        const mergedResultIds = collectedIds.length > 0
          ? [...((task.result_file_ids || '').split(',').map(s => s.trim()).filter(Boolean)), ...collectedIds].join(', ')
          : (task.result_file_ids || '');
        const mergedThumbs = collectedIds.length > 0
          ? { ...(task.result_thumbnails || {}), ...collectedThumbs }
          : (task.result_thumbnails || null);
        try {
          await window.storageManager.updateTaskStatus(task.task_id, finalStatus, mergedResultIds, {
            result_thumbnails: mergedThumbs,
            executed_at: new Date().toISOString(),
          });
          task.status = finalStatus;
          if (collectedIds.length > 0) {
            task.result_file_ids = mergedResultIds;
            task.result_thumbnails = mergedThumbs;
          }
          persisted = true;
        } catch (e) {
          console.warn('[executeTaskViaGrok] Tier 2 PATCH với result data failed:', e.message);
        }
      }

      // Tier 3: Last resort - PATCH chỉ với status để UI clear "running" badge.
      if (!persisted) {
        try {
          await window.storageManager.updateTaskStatus(task.task_id, finalStatus);
          task.status = finalStatus;
          console.warn('[executeTaskViaGrok] Tier 3 status-only update OK (result data lost)');
        } catch (e) {
          console.error('[executeTaskViaGrok] Tier 3 updateTaskStatus failed:', e.message);
          task.status = finalStatus;
        }
      }
    }

    if (window.eventBus) {
      window.eventBus.emit('task:status_changed', {
        taskId: task.task_id,
        taskName: task.task_name,
        mediaType: task.media_type,
        status: finalStatus,
        prompt: task.prompt || '',
        media_type: task.grok_mode === 'video' ? 'Video' : (task.media_type || 'image'),
        model: '',
        ratio: task.ratio || '',
        // Phase Analytics-3: Grok task — N prompt × Grok quantity (image: 1/2/4, video: 1)
        prompt_count: (task.multi_prompt && task.prompts?.length) ? task.prompts.length : 1,
        quantity: parseInt(task.quantity) || 1,
        ref_file_ids: task.ref_file_ids || '',
        result_file_ids: task.result_file_ids || '',
        result_thumbnails: task.result_thumbnails ? Object.values(task.result_thumbnails) : [],
        result_file_names: {},
        task_id: task.task_id,
        provider: 'grok', // SS-Phase G: _executeTaskViaGrok path
        project_id: task.project_id || null,
        auto_download: !!task.auto_download
      });
      // Emit task:complete cho NotificationManager (giống Flow path).
      if (finalStatus === 'completed') {
        window.eventBus.emit('task:complete', {
          taskId: task.task_id,
          taskName: task.task_name,
          resultCount: collectedIds.length
        });
      }
    }

    return { success: successCount, failed: failedCount, results, stopped: wasStopped };
  }

  async function executeSingleTask(task, options = {}) {
    const { isParallel = false, onSubmitted } = options;
    let submittedSignaled = false;

    // Helper: signal submitted (chỉ gọi 1 lần)
    const signalSubmitted = () => {
      if (!submittedSignaled) {
        submittedSignaled = true;
        onSubmitted?.();
      }
    };

    // Reset stop flag (chỉ reset nếu chưa bị stop từ batch)
    if (!window._taskBatchStopped) {
      window._taskShouldStop = false;
    }

    // Bug 2 fix: reset success counter cho task mới (ChatGPT/Grok inner sẽ update).
    // ExecutionTracker._handleStop đọc counter này để complete('partial') với đúng số.
    window._currentTaskSuccessCount = 0;

    // CG-6.3 + G-5.8: Provider routing — nếu task được tạo cho ChatGPT/Grok thì đi qua adapter
    // riêng, không qua Flow editor. Default 'flow' để task cũ giữ behavior cũ.
    const providerKey = task.provider || 'flow';
    if (providerKey === 'grok') {
      // G-5.10: Pipeline mode bypass — Grok tasks BYPASS PromptQueue (Pipeline Flow-only).
      // Note rõ trong _executeTaskViaGrok comment để future devs không nhầm.
      return await _executeTaskViaGrok(task, { signalSubmitted });
    }
    if (providerKey === 'chatgpt') {
      return await _executeTaskViaChatGPT(task, { signalSubmitted });
    }
    // Flow path bên dưới giữ nguyên — KHÔNG xóa logic existing.

    // Smart Clone: reconstruct ref_file_ids từ ref_file_names/ref_thumbnails khi clone cross-project
    // Clone giữ metadata (file_names + thumbnails) nhưng xóa tile_ids → cần rebuild ref_file_ids
    if (!task.ref_file_ids && task.ref_file_names && Object.keys(task.ref_file_names).length > 0) {
      const reconstructedIds = Object.keys(task.ref_file_names);
      task.ref_file_ids = reconstructedIds.join(', ');
      log('Smart Clone: reconstructed ref_file_ids from ref_file_names:', task.ref_file_ids);
    } else if (!task.ref_file_ids && task.ref_thumbnails && Object.keys(task.ref_thumbnails).length > 0) {
      const reconstructedIds = Object.keys(task.ref_thumbnails);
      task.ref_file_ids = reconstructedIds.join(', ');
      log('Smart Clone: reconstructed ref_file_ids from ref_thumbnails:', task.ref_file_ids);
    }

    // Upload pending local files trước khi chạy
    log('Task ref_file_ids BEFORE upload:', task.ref_file_ids);
    if (task.ref_file_ids && task.ref_file_ids.includes('upload_')) {
      const beforeUpload = task.ref_file_ids;
      task.ref_file_ids = await window.uploadPendingFiles(task.ref_file_ids);
      log('Task ref_file_ids AFTER upload:', beforeUpload, '->', task.ref_file_ids);
      sidebarLog(`Ref IDs sau upload: ${task.ref_file_ids}`, 'info');

      // Defensive: drop orphan upload_xxx keys nếu uploadPendingFiles không resolve được
      // (memory pendingUploadFiles lost / upload thất bại). Trước fix: orphan placeholder leak
      // vào content.js → addFileToPrompt(upload_xxx) fail silently → user thấy "thiếu 1 ref".
      if (task.ref_file_ids && task.ref_file_ids.includes('upload_')) {
        const beforeFilter = task.ref_file_ids;
        const filteredIds = beforeFilter.split(',').map(s => s.trim()).filter(id => id && !id.startsWith('upload_'));
        const droppedCount = beforeFilter.split(',').map(s => s.trim()).filter(id => id.startsWith('upload_')).length;
        task.ref_file_ids = filteredIds.join(', ');
        if (droppedCount > 0) {
          log(`Dropped ${droppedCount} orphan upload_* key(s):`, beforeFilter, '->', task.ref_file_ids);
          sidebarLog(`Cảnh báo: ${droppedCount} ảnh upload local không khôi phục được — task chạy với ${filteredIds.length} ảnh còn lại`, 'warn');
        }
      }

      // Cập nhật ref_thumbnails + ref_file_names keys: upload_xxx → real tile_id
      // BUG-T1 FIX: Thêm || '' để tránh crash khi ref_file_ids undefined/null
      if (beforeUpload !== task.ref_file_ids) {
        const oldIds = (beforeUpload || '').split(',').map(s => s.trim()).filter(Boolean);
        const newIds = (task.ref_file_ids || '').split(',').map(s => s.trim()).filter(Boolean);

        // Transfer thumbnails
        if (task.ref_thumbnails) {
          const updatedThumbs = {};
          for (let i = 0; i < oldIds.length; i++) {
            const oldId = oldIds[i];
            const newId = newIds[i] || oldId;
            const thumb = task.ref_thumbnails[oldId];
            if (thumb) updatedThumbs[newId] = thumb;
          }
          // Giữ lại thumbnails của IDs không thay đổi
          for (const [id, thumb] of Object.entries(task.ref_thumbnails)) {
            if (!updatedThumbs[id] && !oldIds.includes(id)) updatedThumbs[id] = thumb;
          }
          // Override bằng thumbnail MỚI từ Flow (từ MediaRegistry populated by FileUploader)
          for (const newId of newIds) {
            if (MediaRegistry.getThumb(newId)) {
              updatedThumbs[newId] = MediaRegistry.getThumb(newId);
            }
          }
          task.ref_thumbnails = updatedThumbs;
        }

        // CRITICAL: Transfer ref_file_names (UUIDs) từ MediaRegistry
        // FileUploader.uploadPendingFiles đã populate cache này với data MỚI từ tileDetails
        const updatedFileNames = { ...(task.ref_file_names || {}) };
        for (let i = 0; i < oldIds.length; i++) {
          const oldId = oldIds[i];
          const newId = newIds[i] || oldId;
          // Transfer existing file_name nếu có
          if (updatedFileNames[oldId] && oldId !== newId) {
            updatedFileNames[newId] = updatedFileNames[oldId];
            delete updatedFileNames[oldId];
          }
        }
        // Override bằng file_name MỚI từ Flow
        for (const newId of newIds) {
          if (MediaRegistry.getFileName(newId)) {
            updatedFileNames[newId] = MediaRegistry.getFileName(newId);
          }
        }
        if (Object.keys(updatedFileNames).length > 0) {
          task.ref_file_names = updatedFileNames;
        }

        // CRITICAL: Transfer ref_image_names (mention name map) — cùng logic với ref_file_names
        // Nếu không transfer, mention resolve sẽ fail cho IDs đã thay đổi
        if (task.ref_image_names) {
          const updatedImageNames = { ...(task.ref_image_names) };
          for (let i = 0; i < oldIds.length; i++) {
            const oldId = oldIds[i];
            const newId = newIds[i] || oldId;
            if (updatedImageNames[oldId] && oldId !== newId) {
              updatedImageNames[newId] = updatedImageNames[oldId];
              delete updatedImageNames[oldId];
            }
          }
          task.ref_image_names = updatedImageNames;
        }
      }

      if (window.storageManager) {
        await window.storageManager.saveTask(task);
        const saved = await window.storageManager.getTask(task.task_id);
        log('Task ref_file_ids IN STORAGE after save:', saved?.ref_file_ids);
        if (saved?.ref_file_ids !== task.ref_file_ids) {
          log('WARNING: Storage mismatch! task:', task.ref_file_ids, 'stored:', saved?.ref_file_ids);
        }
      }
    }
    // Smart Clone frames: reconstruct frame_file_id từ file_name khi clone cross-project
    // Frame reupload sẽ được xử lý bởi correctFileIds + reuploadMissingFiles trong content.js
    if (!task.frame_1_file_id && task.frame_1_file_name) {
      task.frame_1_file_id = task.frame_1_file_name; // Dùng file_name làm placeholder → correctFileIds sẽ tìm tile
      log('Smart Clone: reconstructed frame_1_file_id from file_name:', task.frame_1_file_name);
    }
    if (!task.frame_2_file_id && task.frame_2_file_name) {
      task.frame_2_file_id = task.frame_2_file_name;
      log('Smart Clone: reconstructed frame_2_file_id from file_name:', task.frame_2_file_name);
    }

    if (task.frame_1_file_id && task.frame_1_file_id.startsWith('upload_')) {
      try {
        const result = await window.uploadPendingFiles(task.frame_1_file_id);
        if (!result || result.includes('upload_')) {
          throw new Error('Frame 1 upload failed');
        }
        task.frame_1_file_id = result;
        // Capture file_name từ MediaRegistry (populated by FileUploader.uploadPendingFiles)
        if (MediaRegistry.getFileName(result)) {
          task.frame_1_file_name = MediaRegistry.getFileName(result);
        }
        if (window.storageManager) await window.storageManager.saveTask(task);
      } catch (e) {
        console.error('[executeSingleTask] Frame 1 upload error:', e.message);
        sidebarLog?.('Frame upload thất bại: ' + e.message, 'error');
      }
    }
    if (task.frame_2_file_id && task.frame_2_file_id.startsWith('upload_')) {
      try {
        const result = await window.uploadPendingFiles(task.frame_2_file_id);
        if (!result || result.includes('upload_')) {
          throw new Error('Frame 2 upload failed');
        }
        task.frame_2_file_id = result;
        // Capture file_name từ MediaRegistry (populated by FileUploader.uploadPendingFiles)
        if (MediaRegistry.getFileName(result)) {
          task.frame_2_file_name = MediaRegistry.getFileName(result);
        }
        if (window.storageManager) await window.storageManager.saveTask(task);
      } catch (e) {
        console.error('[executeSingleTask] Frame 2 upload error:', e.message);
        sidebarLog?.('Frame upload thất bại: ' + e.message, 'error');
      }
    }

    // Upload pending per-prompt frame pairs
    if (task.frame_pairs && Array.isArray(task.frame_pairs)) {
      let framePairsChanged = false;
      for (const fp of task.frame_pairs) {
        if (fp.frame1 && fp.frame1.startsWith('upload_')) {
          const result = await window.uploadPendingFiles(fp.frame1);
          fp.frame1 = result;
          if (MediaRegistry.getFileName(result)) fp.frame1FileName = MediaRegistry.getFileName(result);
          framePairsChanged = true;
        }
        if (fp.frame2 && fp.frame2.startsWith('upload_')) {
          const result = await window.uploadPendingFiles(fp.frame2);
          fp.frame2 = result;
          if (MediaRegistry.getFileName(result)) fp.frame2FileName = MediaRegistry.getFileName(result);
          framePairsChanged = true;
        }
      }
      if (framePairsChanged && window.storageManager) {
        await window.storageManager.saveTask(task);
      }
    }

    // Re-upload ref files nếu tile không còn trên page
    if (task.ref_file_ids && !task.ref_file_ids.includes('upload_')) {
      // Note: correctStaleFileIds tự wait selector config + gọi ensureFlowTilesLoaded (Tầng 3) nếu cần
      // Lưu original IDs trước correctFileIds để reupload cache lookup đúng key
      const originalRefFileIds = task.ref_file_ids;

      // 5-tầng: correct stale IDs bằng file_name + thumbnail URL matching
      // Phase R fix: dùng ref_file_names (không phải result_file_names)
      const thumbMap = task.ref_thumbnails || {};
      const fnMap = task.ref_file_names || {};
      if (typeof window.correctFileIds === 'function' && (Object.keys(thumbMap).length > 0 || Object.keys(fnMap).length > 0)) {
        const beforeCorrectIds = (task.ref_file_ids || '').split(',').map(s => s.trim()).filter(Boolean);
        const { correctedIds, changed } = await window.correctFileIds(task.ref_file_ids, thumbMap, fnMap);
        if (changed) {
          log('Ref IDs corrected via file_name/thumbnail matching:', task.ref_file_ids, '->', correctedIds);
          const afterCorrectIds = correctedIds.split(',').map(s => s.trim()).filter(Boolean);
          // Transfer ref_image_names keys: old corrected → new corrected
          if (task.ref_image_names) {
            const updatedNames = { ...(task.ref_image_names) };
            for (let ci = 0; ci < beforeCorrectIds.length; ci++) {
              const oldId = beforeCorrectIds[ci];
              const newId = afterCorrectIds[ci] || oldId;
              if (updatedNames[oldId] && oldId !== newId) {
                updatedNames[newId] = updatedNames[oldId];
                delete updatedNames[oldId];
              }
            }
            task.ref_image_names = updatedNames;
          }
          task.ref_file_ids = correctedIds;
        }
      }
      // Tầng 5: re-upload nếu vẫn còn missing
      log('Checking tiles for ref_file_ids:', task.ref_file_ids);
      const beforeIds = (task.ref_file_ids || '').split(',').map(s => s.trim()).filter(Boolean);
      const updated = await window.reuploadMissingFiles(task.ref_file_ids, task.ref_thumbnails || {}, originalRefFileIds, task.ref_file_names || {});
      if (updated !== task.ref_file_ids) {
        log('Ref IDs changed after reupload:', task.ref_file_ids, '->', updated);
        // Transfer ref_image_names keys: old → reuploaded
        const beforeReupIds = beforeIds;
        const afterReupIds = (updated || '').split(',').map(s => s.trim()).filter(Boolean);
        if (task.ref_image_names) {
          const updatedNames = { ...(task.ref_image_names) };
          for (let ri = 0; ri < beforeReupIds.length; ri++) {
            const oldId = beforeReupIds[ri];
            const newId = afterReupIds[ri] || oldId;
            if (updatedNames[oldId] && oldId !== newId) {
              updatedNames[newId] = updatedNames[oldId];
              delete updatedNames[oldId];
            }
          }
          task.ref_image_names = updatedNames;
        }
        // Fix B: Transfer ref_file_names + ref_thumbnails (oldId → newId) +
        // augment với MediaRegistry data MỚI từ reupload (FileUploader.reuploadMissingFiles
        // ghi vào MediaRegistry sau khi upload tile mới). Trước fix: chỉ transfer ref_image_names
        // → fileNameMap truyền xuống content.js thiếu entry cho new tile_id → addFileToPrompt
        // fallback by file_name fail.
        const updatedFileNames = { ...(task.ref_file_names || {}) };
        const updatedThumbs = { ...(task.ref_thumbnails || {}) };
        for (let ri = 0; ri < beforeReupIds.length; ri++) {
          const oldId = beforeReupIds[ri];
          const newId = afterReupIds[ri] || oldId;
          if (oldId !== newId) {
            if (updatedFileNames[oldId]) {
              updatedFileNames[newId] = updatedFileNames[oldId];
              delete updatedFileNames[oldId];
            }
            if (updatedThumbs[oldId]) {
              updatedThumbs[newId] = updatedThumbs[oldId];
              delete updatedThumbs[oldId];
            }
          }
        }
        for (const newId of afterReupIds) {
          if (MediaRegistry.getFileName(newId)) updatedFileNames[newId] = MediaRegistry.getFileName(newId);
          if (MediaRegistry.getThumb(newId)) updatedThumbs[newId] = MediaRegistry.getThumb(newId);
        }
        task.ref_file_names = updatedFileNames;
        task.ref_thumbnails = updatedThumbs;
        task.ref_file_ids = updated;
        if (window.storageManager) await window.storageManager.saveTask(task);
      }
      // Warning khi có ảnh tham chiếu bị mất
      const afterIds = (updated || '').split(',').map(s => s.trim()).filter(Boolean);
      const droppedCount = beforeIds.length - afterIds.length;
      if (droppedCount > 0) {
        const warnMsg = window.I18n?.t('app.refDropped', { dropped: droppedCount, remaining: afterIds.length }) || `${droppedCount} ảnh tham chiếu không tìm thấy và đã bị bỏ qua. Task chạy với ${afterIds.length} ảnh còn lại.`;
        if (typeof sendLog === 'function') sendLog(warnMsg, 'warn');
        log(warnMsg);
        // Nếu TẤT CẢ ref bị mất → hỏi user
        if (afterIds.length === 0 && beforeIds.length > 0) {
          const shouldContinue = await window.customDialog?.confirm?.(
            window.I18n?.t('app.allRefsLost') || 'Tất cả ảnh tham chiếu không tìm thấy và không thể khôi phục. Tiếp tục chạy task không có ảnh tham chiếu?',
            { title: window.I18n?.t('app.missingRefs') || 'Thiếu ảnh tham chiếu', type: 'warning' }
          );
          if (!shouldContinue) {
            if (typeof sendLog === 'function') sendLog(window.I18n?.t('app.taskCancelledMissingRef') || 'Task bị hủy do thiếu ảnh tham chiếu.', 'warn');
            return;
          }
        }
      }
    }

    // Update status to running
    if (window.storageManager) {
      await window.storageManager.updateTaskStatus(task.task_id, 'running');
    }
    if (window.eventBus) {
      window.eventBus.emit('task:status_changed', { taskId: task.task_id, status: 'running' });
    }

    const tileTimeout = (window.RetryHelper?.getConfig()?.tileTimeout) || 180000;

    sidebarLog(window.I18n?.t('app.startingTask', { name: task.task_name }) || `Bắt đầu task "${task.task_name}"...`, 'info');

    // UA-3.4: Theo doi bat dau task
    window.UsageSync?.trackEvent('task_start', { task_id: task.task_id, multi_prompt: !!task.multi_prompt });

    try {
      // Check user stop
      if (window._taskShouldStop || window._taskBatchStopped) {
        if (window.storageManager) {
          await window.storageManager.updateTaskStatus(task.task_id, 'pending');
        }
        if (window.eventBus) {
          window.eventBus.emit('task:status_changed', { taskId: task.task_id, status: 'pending' });
        }
        signalSubmitted();
        throw new Error('TASK_STOPPED');
      }

      const afS = window._afSettings || {};
      const genType = task.media_type || afS.defaultGenType || 'Image';
      const ratio = task.ratio || afS.defaultRatio || '9:16';
      const isVideo = genType === 'Video';
      // Phase 6 Bug N.1: strict Server-Only — không fallback hardcoded model name
      const _defImg = window.ModelRegistry?.safeGetDefault('flow', 'image');
      const _defVid = window.ModelRegistry?.safeGetDefault('flow', 'video');
      const model = task.model || (isVideo ? (afS.defaultVideoModel || _defVid) : (afS.defaultImageModel || _defImg));
      const isVideoFrames = isVideo && task.video_input_type === 'Frames';

      // Multi-prompt: dùng task.prompts (đã split) nếu có, fallback task.prompt (raw text)
      const rawPrompts = (task.multi_prompt && task.prompts?.length > 1)
        ? task.prompts
        : [task.prompt];
      const quantity = task.quantity || 1;

      // Mention mode: GIỮ NGUYÊN @mention_name trong prompt khi submit đến Flow
      // (trước đây strip @mentions, nhưng theo yêu cầu mới giữ nguyên prompt có @mention)
      // rawPrompts vẫn được dùng cho regex matching bên dưới (build mentionData)
      const refMode = task.ref_image_mode || 'all';
      const prompts = rawPrompts;

      let fileIds = [];
      let frameFileIds = null;
      if (isVideoFrames) {
        // Per-prompt frame pairs (multi-prompt) or global pair (single)
        if (task.frame_pairs && Array.isArray(task.frame_pairs) && task.frame_pairs.length > 0) {
          frameFileIds = task.frame_pairs.map(fp => ({
            frame1: fp.frame1 || '',
            frame2: fp.frame2 || ''
          }));
        } else {
          frameFileIds = {
            frame1: task.frame_1_file_id || '',
            frame2: task.frame_2_file_id || ''
          };
        }
      } else if (task.ref_file_ids) {
        fileIds = task.ref_file_ids.split(',').map(s => s.trim()).filter(Boolean);
      }

      // Fix C: Augment task.ref_file_names + task.ref_thumbnails từ MediaRegistry
      // (populated bởi FileUploader sau upload + ImmediateUploader-via-TaskModal sau Fix A).
      // Đảm bảo fileNameMap truyền xuống content.js đầy đủ cho cross-project fallback —
      // nếu thiếu file_name, addFileToPrompt fallback by file_name fail → ref bị bỏ qua.
      if (window.MediaRegistry && fileIds.length > 0) {
        if (!task.ref_file_names) task.ref_file_names = {};
        if (!task.ref_thumbnails) task.ref_thumbnails = {};
        for (const fid of fileIds) {
          if (!task.ref_file_names[fid]) {
            const fn = MediaRegistry.getFileName(fid);
            if (fn) task.ref_file_names[fid] = fn;
          }
          if (!task.ref_thumbnails[fid]) {
            const tu = MediaRegistry.getThumb(fid);
            if (tu) task.ref_thumbnails[fid] = tu;
          }
        }
      }

      log(`--- Task: "${task.task_name}" ---`);
      log(window.I18n?.t('app.taskSettings', { genType, ratio, model }) || `Cài đặt: ${genType}, ${ratio}, ${model}`);
      if (prompts.length > 1) log(`Multi-prompt: ${prompts.length} prompts`);
      if (fileIds.length > 0) log(`Ref images: ${fileIds.length} file(s)`);

      // Chuyển sang pipeline PromptQueue nếu bật
      if (window.PromptQueue && PromptQueue.isEnabled()) {
        signalSubmitted();

        // Build pipelineRefFileIds: include frame IDs for video frames mode
        let pipelineRefFileIds = fileIds;
        let refImageMode = refMode;
        if (isVideoFrames && frameFileIds) {
          if (Array.isArray(frameFileIds)) {
            // Per-prompt frame pairs: collect unique frame IDs + build sequential ref
            const frameIdSet = new Set();
            frameFileIds.forEach(fp => {
              if (fp?.frame1) frameIdSet.add(fp.frame1);
              if (fp?.frame2) frameIdSet.add(fp.frame2);
            });
            pipelineRefFileIds = [...frameIdSet];
            refImageMode = 'sequential';
          } else {
            // Legacy single pair
            const frameIds = [];
            if (frameFileIds.frame1) frameIds.push(frameFileIds.frame1);
            if (frameFileIds.frame2) frameIds.push(frameFileIds.frame2);
            pipelineRefFileIds = frameIds;
          }
        }

        // Build refFileIdsPerPrompt for per-prompt frame pairs (Video+Frames multi-prompt)
        let refFileIdsPerPrompt = null;
        let taskMentionData = null;
        if (isVideoFrames && Array.isArray(frameFileIds)) {
          // Per-prompt frames: each prompt gets its own frame1+frame2
          refFileIdsPerPrompt = frameFileIds.map(fp => {
            const ids = [];
            if (fp?.frame1) ids.push(fp.frame1);
            if (fp?.frame2) ids.push(fp.frame2);
            return ids;
          });
        } else if (refMode === 'sequential' && fileIds.length > 0) {
          // Sequential: mỗi prompt nhận 1 ref image theo thứ tự
          refFileIdsPerPrompt = rawPrompts.map((_, idx) =>
            idx < fileIds.length ? [fileIds[idx]] : []
          );
        } else if (refMode === 'mention' && fileIds.length > 0 && task.ref_image_names) {
          // Mention mode: resolve @mentions trong từng rawPrompt → chỉ ref matching
          const nameToFileId = {};
          for (const fid of fileIds) {
            const name = task.ref_image_names[fid];
            // Index lower-case để case-insensitive match (autocomplete cũng case-insensitive)
            if (name) nameToFileId[name.toLowerCase()] = fid;
          }
          // Regex unicode (\p{L} = letter, \p{N} = number) — accept Vietnamese, emoji, accent
          refFileIdsPerPrompt = rawPrompts.map(prompt => {
            const mentions = prompt.match(/@([\p{L}\p{N}_]+)/gu) || [];
            const ids = [];
            for (const m of mentions) {
              const name = m.substring(1).toLowerCase(); // bỏ @ + lower
              if (nameToFileId[name] && !ids.includes(nameToFileId[name])) {
                ids.push(nameToFileId[name]);
              }
            }
            return ids;
          });
          // Build mentionData per prompt cho EditorExecutor fileNameMap
          const fileNameMap = task.ref_file_names || {};
          taskMentionData = rawPrompts.map((_, i) => ({
            refImages: (refFileIdsPerPrompt[i] || []).map(fid => ({
              file_id: fid,
              file_name: fileNameMap[fid] || null,
            })),
          }));
        }

        // 2026-05-27: apply model duration override cho TASK (has_ref → vd 8s, has_ref_video → 10s).
        // Trước đây task KHÔNG áp duration override (chỉ GenTab + Workflow) → gap. Giờ đồng bộ.
        let _taskFlowDuration = isVideo ? (task.video_duration || null) : null;
        if (isVideo && _taskFlowDuration && Array.isArray(pipelineRefFileIds) && pipelineRefFileIds.length > 0) {
          const _taskFlowAdapter = window.ProviderRegistry?.get?.('flow');
          const _taskRefThumbs = task.ref_thumbnails || {};
          const _taskHasRefVideo = pipelineRefFileIds.some(id => {
            const rt = _taskRefThumbs[id];
            return !!(rt && typeof rt === 'object' && rt.type === 'video');
          });
          const _taskForced = _taskFlowAdapter?.getDurationOverride?.({
            modelValue: model,
            hasRef: true,
            hasRefVideo: _taskHasRefVideo,
            inputType: task.video_input_type || 'Ingredients',
          });
          if (_taskForced) _taskFlowDuration = _taskForced;
        }

        // Build refFileNames map cho TẤT CẢ ref ids (gồm cả per-prompt frames).
        // Cần thiết cho tier2 fallback addFileToPrompt sau reload Flow — fileName UUID Flow persistent.
        // Source: task.ref_file_names (chính) + GenTab.fileNameCache (fallback từ upload session).
        const _taskRefFileNames = { ...(task.ref_file_names || {}) };
        for (const fid of (pipelineRefFileIds || [])) {
          if (!_taskRefFileNames[fid] && window.GenTab?.fileNameCache?.[fid]) {
            _taskRefFileNames[fid] = window.GenTab.fileNameCache[fid];
          }
        }
        if (Array.isArray(refFileIdsPerPrompt)) {
          for (const arr of refFileIdsPerPrompt) {
            for (const fid of (arr || [])) {
              if (!_taskRefFileNames[fid] && window.GenTab?.fileNameCache?.[fid]) {
                _taskRefFileNames[fid] = window.GenTab.fileNameCache[fid];
              }
            }
          }
        }

        // Video download resolution: 720p/1080p (vs image 1k/2k)
        const result = await PromptQueue.getInstance().submitJob({
          owner: 'task',
          label: `Task: ${task.task_name || task.task_id}`,
          prompts,
          settings: {
            genType,
            ratio,
            model,
            isFrames: !!frameFileIds,
            quantity,
            flowVideoDuration: _taskFlowDuration,
          },
          refFileIds: pipelineRefFileIds,
          refFileNames: _taskRefFileNames,
          refImageMode: isVideoFrames ? (Array.isArray(frameFileIds) ? 'sequential' : 'all') : refMode,
          refFileIdsPerPrompt,
          mentionData: taskMentionData,
          autoDownload: (window.featureGate?.canUse('auto_download') ?? false) && !!task.auto_download,
          // Truyền cả 2 fields riêng — PromptQueue isVideo tự chọn _videoDownloadResolution.
          // Trước smart map vào 1 field → PromptQueue line 659 đọc _videoDownloadResolution
          // → undefined → fallback DOM/720p → bug 1080p config nhưng download 720p.
          downloadResolution: task.download_resolution || null,
          videoDownloadResolution: task.video_download_resolution || null,
          taskName: task.task_name || null, // Subfolder cho auto-download
          taskId: task.task_id || task.id, // CRITICAL: Pass taskId để PromptQueue persist result
          _executionToken: options._executionToken || null, // Pass token to PromptQueue
        });
        // Cập nhật trạng thái task
        if (window.storageManager) {
          await window.storageManager.updateTaskStatus(task.task_id, result.stopped ? 'pending' : 'completed');
        }
        if (window.eventBus) {
          const pipelineStatus = result.stopped ? 'pending' : 'completed';
          // Fetch fresh task from storage to get updated result data from PromptQueue
          let freshResultData = {};
          if (pipelineStatus === 'completed' && window.storageManager) {
            try {
              const freshTask = await window.storageManager.getTask(task.task_id);
              if (freshTask) {
                freshResultData = {
                  result_thumbnails: freshTask.result_thumbnails ? Object.values(freshTask.result_thumbnails) : [],
                  result_file_ids: freshTask.result_file_ids || '',
                  result_file_names: freshTask.result_file_names || {},
                };
              }
            } catch (e) {
              console.warn('[executeSingleTask] Failed to fetch fresh task for result:', e.message);
            }
          }
          window.eventBus.emit('task:status_changed', {
            taskId: task.task_id,
            status: pipelineStatus,
            // History fields (only when completed)
            ...(pipelineStatus === 'completed' ? {
              prompt: task.prompt || '',
              media_type: task.media_type || 'image',
              model: model || '',
              ratio: ratio || '',
              // Phase Analytics-3: Pipeline Flow task — N prompt × Flow quantity (1-4)
              prompt_count: (task.multi_prompt && task.prompts?.length) ? task.prompts.length : 1,
              quantity: parseInt(task.quantity) || 1,
              ref_file_ids: task.ref_file_ids || '',
              ...freshResultData,
              task_id: task.task_id,
              provider: task.provider || 'flow', // SS-Phase G: pipeline Flow task path (ChatGPT/Grok đã return sớm ở dòng trên)
              project_id: task.project_id || window._currentProjectId || null,
              auto_download: !!task.auto_download
            } : {})
          });
        }
        return result;
      }

      // Capture preTileIds as fallback (khi content.js không trả resultTileIds)
      let preTileIds = [];
      if (window.MessageBridge) {
        try {
          const resp = await window.MessageBridge.getCurrentTileIds();
          preTileIds = resp?.tileIds || [];
        } catch (e) {}
      }

      let runResult = null;
      if (window.MessageBridge) {
        // Check if content.js is stuck in isRunning state → force reset
        try {
          const state = await window.MessageBridge.getRunningState();
          sidebarLog(`Content script state: isRunning=${state?.isRunning}, shouldStop=${state?.shouldStop}`, 'info');
          if (state?.isRunning) {
            sidebarLog('Content script stuck, forcing stop...', 'warn');
            await window.MessageBridge.stopExecution();
            await new Promise(r => setTimeout(r, 1000));
          }
        } catch (e) {
          sidebarLog(window.I18n?.t('app.cannotConnectContent', { message: e.message }) || `Không thể kết nối content script: ${e.message}`, 'error');
          sidebarLog(window.I18n?.t('app.refreshFlowTab') || 'Hãy thử refresh tab Google Flow rồi chạy lại.', 'warn');
          signalSubmitted();
          throw e;
        }

        sidebarLog(window.I18n?.t('app.sendingPrompts', { count: prompts.length, genType, ratio, model }) || `Gửi ${prompts.length} prompt(s) đến Google Flow... (${genType}, ${ratio}, ${model})`, 'info');
        // Build refImageMode + refFileIdsPerPrompt cho legacy path
        let refPerPrompt = refMode === 'sequential' && prompts.length > 1;
        let refFileIdsPerPrompt = null;
        let legacyMentionData = null;
        let legacyRefMode = refMode;
        // Per-prompt frame pairs for legacy path
        if (isVideoFrames && Array.isArray(frameFileIds)) {
          refPerPrompt = true;
          legacyRefMode = 'sequential';
          refFileIdsPerPrompt = frameFileIds.map(fp => {
            const ids = [];
            if (fp?.frame1) ids.push(fp.frame1);
            if (fp?.frame2) ids.push(fp.frame2);
            return ids;
          });
        } else if (refMode === 'sequential' && fileIds.length > 0) {
          refFileIdsPerPrompt = rawPrompts.map((_, idx) =>
            idx < fileIds.length ? [fileIds[idx]] : []
          );
        } else if (refMode === 'mention' && fileIds.length > 0 && task.ref_image_names) {
          // Build mentionData cho content.js legacy mention handling (dùng rawPrompts để regex match @mentions)
          const nameToFileId = {};
          for (const fid of fileIds) {
            const name = task.ref_image_names[fid];
            if (name) nameToFileId[name] = fid;
          }
          const fileNameMap2 = task.ref_file_names || {};
          legacyMentionData = rawPrompts.map(prompt => {
            const mentions = prompt.match(/@([a-zA-Z0-9_]+)/g) || [];
            const refImages = [];
            const seen = new Set();
            for (const m of mentions) {
              const name = m.substring(1);
              const fid = nameToFileId[name];
              if (fid && !seen.has(fid)) {
                seen.add(fid);
                refImages.push({ file_id: fid, file_name: fileNameMap2[fid] || null, name });
              }
            }
            return { refImages };
          });
        }
        runResult = await window.MessageBridge.runAutoPrompt({
          prompts,
          // Phase 2c+: Server-Only — ExecutionConfig source of truth. inputTimeout vẫn là user setting hợp lệ.
          delayBetweenMs: (window.ExecutionConfig?.safeGetDelayBetweenPromptsSec?.() ?? 5) * 1000,
          inputTimeoutMs: window.storageSettings?.getSettings()?.inputTimeout || 1200,
          fileIds,
          fileNameMap: task.ref_file_names || {},
          genType,
          aspectRatio: ratio,
          modelName: model,
          frameFileIds,
          noTileWait: isParallel,
          quantity,
          // Check feature gate: nếu không có quyền, force autoDownload = false
          autoDownload: (window.featureGate?.canUse('auto_download') ?? false) && !!task.auto_download,
          // Truyền 2 fields riêng — content.js downloadTileMedia line 1369 dùng videoDownloadResolution
          // override khi tile có <video>. Trước smart map vào 1 field → videoDownloadResolution mặc định '720p'
          // → override 1080p → 720p sai. Phải truyền cả 2 cho cả image + video task.
          downloadResolution: task.download_resolution || '1k',
          videoDownloadResolution: task.video_download_resolution || '720p',
          refImageMode: legacyRefMode,
          refPerPrompt,
          refFileIdsPerPrompt,
          mentionData: legacyMentionData,
          taskName: task.task_name || null,
          // Flow Voice Selector — pass voice nếu task có (chỉ flow + Video + supports_voice)
          voice: (task.voice_slug && task.voice_search_value)
            ? { slug: task.voice_slug, search_value: task.voice_search_value }
            : null,
        });

        sidebarLog(`runAutoPrompt kết quả: ${JSON.stringify(runResult || 'undefined')}`, 'info');

        if (runResult?.blocked) {
          signalSubmitted();
          throw new Error(window.I18n?.t('app.flowBusyRetry') || 'Google Flow đang bận xử lý. Hãy thử dừng và chạy lại.');
        }
      } else if (typeof applySettings === 'function' && typeof runAutoPrompt === 'function') {
        let refFileIdsPerPrompt2 = null;
        let legacyMentionData2 = null;
        let legacyRefMode2 = refMode;
        let legacyRefPerPrompt2 = refMode === 'sequential' && prompts.length > 1;
        // Per-prompt frame pairs
        if (isVideoFrames && Array.isArray(frameFileIds)) {
          legacyRefPerPrompt2 = true;
          legacyRefMode2 = 'sequential';
          refFileIdsPerPrompt2 = frameFileIds.map(fp => {
            const ids = [];
            if (fp?.frame1) ids.push(fp.frame1);
            if (fp?.frame2) ids.push(fp.frame2);
            return ids;
          });
        } else if (refMode === 'sequential' && fileIds.length > 0) {
          refFileIdsPerPrompt2 = rawPrompts.map((_, idx) =>
            idx < fileIds.length ? [fileIds[idx]] : []
          );
        } else if (refMode === 'mention' && fileIds.length > 0 && task.ref_image_names) {
          // Build mentionData cho content.js mention handling (dùng rawPrompts để regex match)
          const nameToFid2 = {};
          for (const fid of fileIds) {
            const name = task.ref_image_names[fid];
            if (name) nameToFid2[name] = fid;
          }
          const fnMap2 = task.ref_file_names || {};
          legacyMentionData2 = rawPrompts.map(prompt => {
            const mentions = prompt.match(/@([a-zA-Z0-9_]+)/g) || [];
            const refImages = [];
            const seen = new Set();
            for (const m of mentions) {
              const name = m.substring(1);
              const fid = nameToFid2[name];
              if (fid && !seen.has(fid)) {
                seen.add(fid);
                refImages.push({ file_id: fid, file_name: fnMap2[fid] || null, name });
              }
            }
            return { refImages };
          });
        }
        runResult = await runAutoPrompt({
          prompts,
          // Phase 2c+: Server-Only — ExecutionConfig source of truth. inputTimeout vẫn là user setting hợp lệ.
          delayBetweenMs: (window.ExecutionConfig?.safeGetDelayBetweenPromptsSec?.() ?? 5) * 1000,
          inputTimeoutMs: window.storageSettings?.getSettings()?.inputTimeout || 1200,
          fileIds,
          fileNameMap: task.ref_file_names || {},
          genType,
          aspectRatio: ratio,
          modelName: model,
          frameFileIds,
          noTileWait: isParallel,
          quantity,
          // Check feature gate: nếu không có quyền, force autoDownload = false
          autoDownload: (window.featureGate?.canUse('auto_download') ?? false) && !!task.auto_download,
          // Truyền 2 fields riêng — đồng nhất với MessageBridge.runAutoPrompt path ở trên.
          downloadResolution: task.download_resolution || '1k',
          videoDownloadResolution: task.video_download_resolution || '720p',
          refImageMode: legacyRefMode2,
          refPerPrompt: legacyRefPerPrompt2,
          refFileIdsPerPrompt: refFileIdsPerPrompt2,
          mentionData: legacyMentionData2,
          taskName: task.task_name || null,
          // Flow Voice Selector
          voice: (task.voice_slug && task.voice_search_value)
            ? { slug: task.voice_slug, search_value: task.voice_search_value }
            : null,
        });
      } else {
        signalSubmitted();
        throw new Error(window.I18n?.t('app.cannotExecuteTask') || 'Không thể thực thi task: thiếu kết nối tới Google Flow');
      }

      log('runAutoPrompt hoàn tất.');

      // Signal submitted (cho parallel mode: unblock task tiếp theo)
      signalSubmitted();

      // Nếu đã bị stop, lưu partial results (nếu có) rồi skip tile wait
      if (window._taskShouldStop || window._taskBatchStopped) {
        // Save partial results từ content.js (nếu có)
        const partialTiles = runResult?.resultTileIds || [];
        if (partialTiles.length > 0 && window.storageManager) {
          try {
            const freshTask = await window.storageManager.getTask(task.task_id);
            if (freshTask) {
              const existingIds = (freshTask.result_file_ids || '').split(',').map(s => s.trim()).filter(Boolean);
              const mergedIds = [...new Set([...existingIds, ...partialTiles])];
              freshTask.result_file_ids = mergedIds.join(', ');
              freshTask.status = 'pending';
              await window.storageManager.saveTask(freshTask);
              console.log('[executeSingleTask] Flow partial save:', partialTiles.length, 'results');
            }
          } catch (partialErr) {
            console.warn('[executeSingleTask] Flow partial save failed:', partialErr.message);
          }
        } else if (window.storageManager) {
          await window.storageManager.updateTaskStatus(task.task_id, 'pending');
        }
        if (window.eventBus) {
          window.eventBus.emit('task:status_changed', { taskId: task.task_id, status: 'pending' });
        }
        throw new Error('TASK_STOPPED');
      }

      // Lấy kết quả tiles — ưu tiên resultTileIds từ content.js (chính xác per-prompt)
      let pureNewTiles = runResult?.resultTileIds || [];
      let capturedThumbnails = {};

      if (pureNewTiles.length === 0 && window.MessageBridge) {
        const baselineTileIds = runResult?.preTileIds || preTileIds;
        const baselineFileNames = runResult?.preFileNames || null;

        if (isParallel) {
          sidebarLog(`Task "${task.task_name}": chờ kết quả tiles (baseline: ${baselineTileIds.length} tiles)...`, 'info');
          try {
            const tileResult = await window.MessageBridge.waitForNewTiles(
              baselineTileIds, tileTimeout, { captureFileNames: true, preFileNames: baselineFileNames }
            );
            const newTiles = tileResult?.tiles || [];
            capturedThumbnails = tileResult?.thumbnails || {};
            if (newTiles.length > 0) {
              const actualRefIds = runResult?.uploadedFileIds || fileIds;
              const refIdSet = new Set(actualRefIds);
              let candidates = newTiles.filter(id => !refIdSet.has(id));

              if (tileResult?.failed && candidates.length > 0 && window.MessageBridge) {
                const successOnly = [];
                for (const tid of candidates) {
                  const info = capturedThumbnails[tid];
                  if (info?.thumbnail || info?.file_name) {
                    successOnly.push(tid);
                  }
                }
                if (successOnly.length < candidates.length) {
                  const failCount = candidates.length - successOnly.length;
                  sidebarLog(window.I18n?.t('app.taskPartialFail', { name: task.task_name, failed: failCount, success: successOnly.length }) || `Task "${task.task_name}": ${failCount} ảnh thất bại, ${successOnly.length} thành công`, 'warn');
                }
                candidates = successOnly;
              }

              pureNewTiles = candidates;
              if (pureNewTiles.length > 0) {
                sidebarLog(window.I18n?.t('app.taskNewResults', { name: task.task_name, count: pureNewTiles.length }) || `Task "${task.task_name}": ${pureNewTiles.length} kết quả mới`, 'success');
              }
            }
          } catch (e) {}
        } else {
          try {
            const tileResult = await window.MessageBridge.waitForNewTiles(
              baselineTileIds, 10000, { captureFileNames: true, preFileNames: baselineFileNames }
            );
            const newTiles = tileResult?.tiles || [];
            capturedThumbnails = tileResult?.thumbnails || {};
            if (newTiles.length > 0) {
              const actualRefIds = runResult?.uploadedFileIds || fileIds;
              const refIdSet = new Set(actualRefIds);
              pureNewTiles = newTiles.filter(id => !refIdSet.has(id));
            }
          } catch (e) {}
        }
      }

      // Check stop lần nữa sau wait — lưu partial results nếu có
      if (window._taskShouldStop || window._taskBatchStopped) {
        if (pureNewTiles.length > 0 && window.storageManager) {
          try {
            const freshTask = await window.storageManager.getTask(task.task_id);
            if (freshTask) {
              const existingIds = (freshTask.result_file_ids || '').split(',').map(s => s.trim()).filter(Boolean);
              const mergedIds = [...new Set([...existingIds, ...pureNewTiles])];
              freshTask.result_file_ids = mergedIds.join(', ');
              // Capture thumbnails cho partial results
              if (Object.keys(capturedThumbnails).length > 0) {
                const thumbs = {};
                for (const tileId of pureNewTiles) {
                  const info = capturedThumbnails[tileId];
                  if (info?.thumbnail) {
                    thumbs[tileId] = info.type === 'video'
                      ? { thumbnail: info.thumbnail, type: 'video', file_name: info.file_name || '' }
                      : info.thumbnail;
                  }
                }
                if (Object.keys(thumbs).length > 0) {
                  freshTask.result_thumbnails = { ...(freshTask.result_thumbnails || {}), ...thumbs };
                }
              }
              freshTask.status = 'pending';
              await window.storageManager.saveTask(freshTask);
              console.log('[executeSingleTask] Flow partial save (post-wait):', pureNewTiles.length, 'results');
            }
          } catch (partialErr) {
            console.warn('[executeSingleTask] Flow partial save failed:', partialErr.message);
          }
        } else if (window.storageManager) {
          await window.storageManager.updateTaskStatus(task.task_id, 'pending');
        }
        if (window.eventBus) {
          window.eventBus.emit('task:status_changed', { taskId: task.task_id, status: 'pending' });
        }
        throw new Error('TASK_STOPPED');
      }

      // Update task ref_file_ids if upload_xxx were replaced with real IDs
      const actualRefIds = runResult?.uploadedFileIds || fileIds;
      if (runResult?.uploadedFileIds && actualRefIds.join(',') !== fileIds.join(',')) {
        const oldRefIds = task.ref_file_ids;
        task.ref_file_ids = actualRefIds.join(', ');

        if (task.ref_thumbnails) {
          const oldArr = oldRefIds ? oldRefIds.split(',').map(s => s.trim()).filter(Boolean) : fileIds;
          const newArr = actualRefIds;
          const migrated = {};
          for (let i = 0; i < oldArr.length; i++) {
            const thumb = task.ref_thumbnails[oldArr[i]];
            if (thumb && newArr[i]) migrated[newArr[i]] = thumb;
          }
          for (const [id, thumb] of Object.entries(task.ref_thumbnails)) {
            if (!migrated[id] && !oldArr.includes(id)) migrated[id] = thumb;
          }
          task.ref_thumbnails = migrated;
        }

        if (window.storageManager) {
          const freshTask = await window.storageManager.getTask(task.task_id);
          if (freshTask) {
            freshTask.ref_file_ids = task.ref_file_ids;
            freshTask.ref_thumbnails = task.ref_thumbnails;
            await window.storageManager.saveTask(freshTask);
          }
        }
      }

      if (pureNewTiles.length === 0 && !window._taskShouldStop) {
        sidebarLog(window.I18n?.t('app.taskFailedNoResults', { name: task.task_name }) || `Task "${task.task_name}" thất bại: không có kết quả mới`, 'error');
        throw new Error(window.I18n?.t('app.noNewResultsError') || 'Không có kết quả mới sau khi submit - có thể Google Flow bị lỗi');
      }

      const resultFileIds = pureNewTiles.join(', ');

      if (window.storageManager) {
        await window.storageManager.updateTaskStatus(task.task_id, 'completed', resultFileIds);
      }

      // UA-3.4: Theo doi hoan thanh task
      window.UsageSync?.trackEvent('task_complete', { task_id: task.task_id, success: true });
      // NOTE: KHÔNG track flow_prompt_total ở đây vì:
      // - Flow tasks qua Pipeline (PromptQueue) → EditorExecutor đã track khi submit
      // - ChatGPT/Grok adapter tự increment chatgpt_prompt_total/grok_prompt_total
      // Trước đây có bug DOUBLE COUNT: EditorExecutor track khi submit + app.js track khi complete

      // Persist result thumbnails + file_names
      if (pureNewTiles.length > 0) {
        try {
          const thumbs = {};
          const fileNames = {};

          for (const tileId of pureNewTiles) {
            const info = capturedThumbnails[tileId];
            if (info?.thumbnail) {
              // Persist type field for video detection in UI rendering
              if (info.type === 'video') {
                thumbs[tileId] = { thumbnail: info.thumbnail, type: 'video', file_name: info.file_name || '' };
              } else {
                thumbs[tileId] = info.thumbnail;
              }
            }
            if (info?.file_name) fileNames[tileId] = info.file_name;
          }

          const missingTiles = pureNewTiles.filter(id => !thumbs[id] && !fileNames[id]);
          if (missingTiles.length > 0 && window.MessageBridge) {
            const scanResult = await MessageBridge.getThumbnailsByIds(missingTiles);
            const results = scanResult?.results || {};
            for (const tileId of missingTiles) {
              const scanInfo = results[tileId];
              if (scanInfo?.thumbnail && !thumbs[tileId]) {
                if (scanInfo.type === 'video') {
                  thumbs[tileId] = { thumbnail: scanInfo.thumbnail, type: 'video', file_name: scanInfo.file_name || '' };
                } else {
                  thumbs[tileId] = scanInfo.thumbnail;
                }
              }
              if (scanInfo?.file_name && !fileNames[tileId]) fileNames[tileId] = scanInfo.file_name;
            }
          }

          if ((Object.keys(thumbs).length > 0 || Object.keys(fileNames).length > 0) && window.storageManager) {
            const freshTask = await window.storageManager.getTask(task.task_id);
            if (freshTask) {
              freshTask.result_thumbnails = { ...(freshTask.result_thumbnails || {}), ...thumbs };
              if (Object.keys(fileNames).length > 0) {
                freshTask.result_file_names = { ...(freshTask.result_file_names || {}), ...fileNames };
              }
              await window.storageManager.saveTask(freshTask);
            }
          }
        } catch (e) {
          console.warn('[Task] Persist result thumbnails failed:', e.message);
        }
      }

      if (window.eventBus) {
        window.eventBus.emit('task:status_changed', {
          taskId: task.task_id,
          taskName: task.task_name,
          mediaType: task.media_type,
          status: 'completed',
          resultFileIds,
          // History fields
          prompt: task.prompt || '',
          media_type: task.media_type || 'image',
          model: model || '',
          ratio: ratio || '',
          // Phase Analytics-3: Legacy Flow task — N prompt × Flow quantity (1-4)
          prompt_count: (task.multi_prompt && task.prompts?.length) ? task.prompts.length : 1,
          quantity: parseInt(task.quantity) || 1,
          ref_file_ids: task.ref_file_ids || '',
          result_file_ids: resultFileIds || '',
          result_thumbnails: task.result_thumbnails ? Object.values(task.result_thumbnails) : [],
          result_file_names: task.result_file_names || {},
          task_id: task.task_id,
          provider: task.provider || 'flow', // SS-Phase G: legacy task path (Flow default)
          project_id: task.project_id || window._currentProjectId || null,
          auto_download: !!task.auto_download
        });
        // Emit task:complete for NotificationManager
        window.eventBus.emit('task:complete', {
          taskId: task.task_id,
          taskName: task.task_name,
          resultCount: pureNewTiles.length
        });
      }
    } catch (error) {
      // Đảm bảo submitted signal luôn được gọi (unblock parallel loop)
      signalSubmitted();

      if (error.message === 'TASK_STOPPED') {
        sidebarLog(window.I18n?.t('app.taskStopped', { name: task.task_name }) || `Task "${task.task_name}" đã dừng.`, 'warn');
        return;
      }

      console.error('[TaskExecutor] Task failed:', task.task_id, error);
      sidebarLog(window.I18n?.t('app.taskFailed', { name: task.task_name, error: error?.message }) || `Task "${task.task_name}" thất bại: ${error?.message}`, 'error');
      // UA-3.4: Theo doi task that bai
      window.UsageSync?.trackEvent('task_complete', { task_id: task.task_id, success: false });
      if (window.storageManager) {
        await window.storageManager.updateTaskStatus(task.task_id, 'failed');
      }
      if (window.eventBus) {
        window.eventBus.emit('task:status_changed', { taskId: task.task_id, status: 'failed', error: error?.message });
      }
    }
  }

  // ─── Auth UI ──────────────────────────────────────────────
  function setupAuthUI() {
    const loginBtn = document.getElementById('loginBtn');
    const userMenu = document.getElementById('userMenu');
    const userMenuBtn = document.getElementById('userMenuBtn');
    const loginOverlay = document.getElementById('loginOverlay');
    const loginCloseBtn = document.getElementById('loginCloseBtn');
    const loginSubmitBtn = document.getElementById('loginSubmitBtn');
    const registerSubmitBtn = document.getElementById('registerSubmitBtn');
    const switchToRegister = document.getElementById('switchToRegister');
    const switchToLogin = document.getElementById('switchToLogin');
    const logoutBtn = document.getElementById('logoutBtn');
    const userDropdown = document.getElementById('userDropdown');

    function updateAuthUI() {
      const isLoggedIn = window.authManager?.isLoggedIn();
      if (loginBtn) loginBtn.classList.toggle('hidden', isLoggedIn);
      if (userMenu) userMenu.classList.toggle('hidden', !isLoggedIn);
      if (isLoggedIn) {
        const user = window.authManager.getUser();
        const nameEl = document.getElementById('userDisplayName');
        const planEl = document.getElementById('userDisplayPlan');
        if (nameEl) nameEl.textContent = user?.name || 'User';
        if (planEl) planEl.textContent = window.featureGate?.plan?.name || user?.plan_name || user?.plan_slug || 'Free';
      }
      updateFooterUI();
      updatePremiumBadge();
      // Toggle logout button trong settings menu
      const settingsLogoutBtn = document.getElementById('settingsLogoutBtn');
      if (settingsLogoutBtn) {
        settingsLogoutBtn.classList.toggle('hidden', !isLoggedIn);
      }
      // Toggle upgrade button trong settings menu (luôn hiện khi đã login)
      const settingsUpgradeBtn = document.getElementById('settingsUpgradeBtn');
      if (settingsUpgradeBtn) {
        const showUpgradeUI = window.SystemConfig?.getBool('show_upgrade_ui') !== false;
        settingsUpgradeBtn.classList.toggle('hidden', !isLoggedIn || !showUpgradeUI);
      }
    }

    // Update footer based on user state (guest/free/premium)
    function updateFooterUI() {
      const footerGuest = document.getElementById('footerGuest');
      const footerFree = document.getElementById('footerFree');
      const footerPremium = document.getElementById('footerPremium');

      const isLoggedIn = window.authManager?.isLoggedIn();
      const user = window.authManager?.getUser();
      const isPremium = user?.plan_slug === 'unlimited' || user?.plan_slug === 'premium' || user?.plan_slug === 'autoflow-pro' || user?.plan_slug === 'autogrok-pro';

      // Hide all first
      footerGuest?.classList.add('hidden');
      footerFree?.classList.add('hidden');
      footerPremium?.classList.add('hidden');

      if (!isLoggedIn) {
        footerGuest?.classList.remove('hidden');
        updateTrialFooterBars();
      } else if (isPremium) {
        footerPremium?.classList.remove('hidden');
        updatePremiumFooterFeatures();
        // Update plan name in footer pro label
        const planNameEl = document.getElementById('footerProLabelText');
        const footerProLabel = document.getElementById('footerProLabel');
        if (planNameEl) {
          // Map plan_slug to display name
          const planDisplayName = (user?.plan_slug === 'autoflow-pro' || user?.plan_slug === 'autogrok-pro') ? 'Pro' : 'Premium';
          planNameEl.textContent = planDisplayName;
          // Update tooltip
          if (footerProLabel) {
            footerProLabel.setAttribute('title', `Xem đặc quyền ${planDisplayName}`);
          }
        }
      } else {
        footerFree?.classList.remove('hidden');
        updateFooterUsageBars();
      }
    }

    // Update Premium footer features + quotas based on entitlements
    function updatePremiumFooterFeatures() {
      if (!window.featureGate) return;

      // GP-6.2: Global Prompt Quota (prompt_submit_max) thay vì per-module gen_run_max
      const genEl = document.getElementById('footerPremiumGen');
      if (genEl) {
        const globalQuota = window.featureGate.checkQuota('prompt_submit_max');
        const genQuota = window.featureGate.checkQuota('gen_run_max');
        // Ưu tiên global quota nếu có, fallback sang gen_run_max
        const quota = (globalQuota.limit && globalQuota.limit !== 'unlimited') ? globalQuota : genQuota;
        const used = quota.used || 0;
        const limit = (quota.limit === 'unlimited' || quota.limit === -1) ? '∞' : (quota.limit || 500);
        const valueEl = genEl.querySelector('.footer-usage-value');
        if (valueEl) {
          if (limit === '∞') {
            valueEl.textContent = '∞';
            valueEl.classList.add('footer-usage-unlimited');
          } else {
            valueEl.textContent = `${used}/${limit}`;
            valueEl.classList.remove('footer-usage-unlimited');
          }
        }
        // Set dynamic tooltip with plan limit info
        const tooltipText = window.I18n?.t('footer.promptTooltipDetail', { used, limit }) ||
          `${used}/${limit} ${window.I18n?.t('footer.promptTooltip') || 'prompts today'}`;
        genEl.setAttribute('data-tooltip', tooltipText);
      }

      // Tasks quota (từ server, không hardcode ∞)
      const tasksEl = document.getElementById('footerPremiumTasks');
      if (tasksEl) {
        const quota = window.featureGate.checkQuota('tasks_max');
        const used = quota.used || 0;
        const limit = quota.limit === 'unlimited' ? '∞' : (quota.limit || '∞');
        const valueEl = tasksEl.querySelector('.footer-usage-value');
        if (valueEl) {
          if (limit === '∞') {
            valueEl.textContent = '∞';
            valueEl.classList.add('footer-usage-unlimited');
          } else {
            valueEl.textContent = `${used}/${limit}`;
            valueEl.classList.remove('footer-usage-unlimited');
          }
        }
        // Set dynamic tooltip with plan limit info
        const tooltipText = window.I18n?.t('footer.taskTooltipDetail', { used, limit }) ||
          `${used}/${limit} ${window.I18n?.t('footer.taskTooltip') || 'tasks created'}`;
        tasksEl.setAttribute('data-tooltip', tooltipText);
      }

      // Workflows quota (từ server, không hardcode ∞)
      const workflowsEl = document.getElementById('footerPremiumWorkflows');
      if (workflowsEl) {
        const quota = window.featureGate.checkQuota('workflows_max');
        const used = quota.used || 0;
        const limit = quota.limit === 'unlimited' ? '∞' : (quota.limit || '∞');
        const valueEl = workflowsEl.querySelector('.footer-usage-value');
        if (valueEl) {
          if (limit === '∞') {
            valueEl.textContent = '∞';
            valueEl.classList.add('footer-usage-unlimited');
          } else {
            valueEl.textContent = `${used}/${limit}`;
            valueEl.classList.remove('footer-usage-unlimited');
          }
        }
        // Set dynamic tooltip with plan limit info
        const tooltipText = window.I18n?.t('footer.wfTooltipDetail', { used, limit }) ||
          `${used}/${limit} ${window.I18n?.t('footer.wfTooltip') || 'workflows created'}`;
        workflowsEl.setAttribute('data-tooltip', tooltipText);
      }

      // Boolean features
      updateFooterFeatureStatus(
        'footerPremiumDownload',
        window.featureGate.canUse('auto_download')
      );

      updateFooterFeatureStatus(
        'footerPremiumRetry',
        window.featureGate.canUse('retry_on_fail')
      );
    }

    /**
     * Update footer feature status (icon)
     * @param {string} elementId - Element ID
     * @param {boolean} enabled - Feature enabled state
     */
    function updateFooterFeatureStatus(elementId, enabled) {
      const el = document.getElementById(elementId);
      if (!el) return;

      el.setAttribute('data-enabled', enabled);

      // Update status icon (switch between check and X)
      const statusEl = el.querySelector('.footer-feature-status');
      if (statusEl) {
        statusEl.className = `footer-feature-status footer-feature-status--${enabled ? 'on' : 'off'}`;
        statusEl.innerHTML = enabled
          ? '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M20 6L9 17l-5-5"/></svg>'
          : '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>';
      }
    }

    // Update usage values in footer for trial (not logged in) users
    // Counts ACTUAL items from storage, not cumulative create actions
    async function updateTrialFooterBars() {
      if (!window.featureGate) return;

      const config = window.featureGate.getConfig();

      // GP-6.2: Global Prompt Quota (prompt_submit_max) thay vì per-module gen_run_max
      const genEl = document.getElementById('footerTrialGen');
      if (genEl) {
        const globalQuota = window.featureGate.checkQuota('prompt_submit_max');
        const genQuota = window.featureGate.checkQuota('gen_run_max');
        // Ưu tiên global quota nếu có, fallback sang gen_run_max
        const quota = (globalQuota.limit && globalQuota.limit !== 'unlimited') ? globalQuota : genQuota;
        const used = quota.used || 0;
        const limit = (quota.limit === 'unlimited' || quota.limit === -1) ? '∞' : (quota.limit || 20);
        const valueEl = genEl.querySelector('.footer-usage-value');
        if (valueEl) valueEl.textContent = `${used}/${limit}`;
        // Set dynamic tooltip with plan limit info
        const tooltipText = window.I18n?.t('footer.promptTooltipDetail', { used, limit }) ||
          `${used}/${limit} ${window.I18n?.t('footer.promptTooltip') || 'prompts today'}`;
        genEl.setAttribute('data-tooltip', tooltipText);
      }

      // Tasks usage - count actual tasks from storage
      const tasksEl = document.getElementById('footerTrialTasks');
      if (tasksEl) {
        let used = 0;
        try {
          if (window.storageManager) {
            const tasks = await window.storageManager.getTasks();
            used = tasks?.length || 0;
          }
        } catch (e) { /* ignore */ }
        const limit = config.tasks_max_create || 2;
        const valueEl = tasksEl.querySelector('.footer-usage-value');
        if (valueEl) valueEl.textContent = `${used}/${limit}`;
        // Set dynamic tooltip with plan limit info
        const tooltipText = window.I18n?.t('footer.taskTooltipDetail', { used, limit }) ||
          `${used}/${limit} ${window.I18n?.t('footer.taskTooltip') || 'tasks created'}`;
        tasksEl.setAttribute('data-tooltip', tooltipText);
      }

      // Workflows usage - count actual workflows from storage
      const workflowsEl = document.getElementById('footerTrialWorkflows');
      if (workflowsEl) {
        let used = 0;
        try {
          if (window.storageManager) {
            const workflows = await window.storageManager.getWorkflows();
            used = workflows?.length || 0;
          }
        } catch (e) { /* ignore */ }
        const limit = config.workflows_max_create || 1;
        const valueEl = workflowsEl.querySelector('.footer-usage-value');
        if (valueEl) valueEl.textContent = `${used}/${limit}`;
        // Set dynamic tooltip with plan limit info
        const tooltipText = window.I18n?.t('footer.wfTooltipDetail', { used, limit }) ||
          `${used}/${limit} ${window.I18n?.t('footer.wfTooltip') || 'workflows created'}`;
        workflowsEl.setAttribute('data-tooltip', tooltipText);
      }

      // Auto Download feature (boolean) - check từ server entitlements
      updateFooterFeatureStatus(
        'footerTrialAutoDownload',
        window.featureGate.canUse('auto_download')
      );

      // Retry on Fail feature (boolean) - check từ server entitlements
      updateFooterFeatureStatus(
        'footerTrialRetryFail',
        window.featureGate.canUse('retry_on_fail')
      );

      // Update all toggles based on entitlements
      updateAutoDownloadToggles();
    }

    // Update usage values in footer for free users (compact inline)
    async function updateFooterUsageBars() {
      if (!window.featureGate) return;

      // Read daily stats from storage (same source as Today's Stats modal)
      const today = new Date().toISOString().slice(0, 10);
      const currentUserId = window.authManager?.user?.id || null;
      const result = await new Promise(resolve => {
        chrome.storage.local.get(['af_daily_stats'], r => resolve(r));
      });
      const stats = result.af_daily_stats || {};
      const isValidStats = stats._date === today && stats._user_id === currentUserId;

      // Get limits from featureGate first (needed for promptUsed calculation)
      const fg = window.featureGate;
      const config = fg?.getConfig?.() || {};
      const promptQuota = fg?.checkQuota?.('prompt_submit_max') || {};

      // Get daily stats values - prefer server usage for consistency with Settings Popup
      const localPromptTotal = isValidStats
        ? (stats.flow_prompt_total || 0) + (stats.chatgpt_prompt_total || 0) + (stats.gemini_prompt_total || 0) + (stats.grok_prompt_total || 0)
        : 0;
      const promptUsed = (promptQuota.used !== undefined && promptQuota.used > 0) ? promptQuota.used : localPromptTotal;
      const taskUsed = isValidStats ? (stats.task_run || 0) : 0;
      const wfUsed = isValidStats ? (stats.workflow_run || 0) : 0;
      const promptsMax = promptQuota.limit === 'unlimited' ? '∞' : (promptQuota.limit ?? 50);
      // Use creation limits (tasks_max, workflows_max) instead of run limits
      const tasksQuota = fg?.checkQuota?.('tasks_max') || {};
      const wfQuota = fg?.checkQuota?.('workflows_max') || {};
      const tasksMax = tasksQuota.limit === 'unlimited' ? '∞' : (tasksQuota.limit ?? config.tasks_max_create ?? 10);
      const wfMax = wfQuota.limit === 'unlimited' ? '∞' : (wfQuota.limit ?? config.workflows_max_create ?? 5);
      // Get actual created counts from quota (not daily runs)
      const tasksCreated = tasksQuota.used ?? 0;
      const wfCreated = wfQuota.used ?? 0;

      // Helper to update quota display
      const updateQuotaEl = (elId, used, limit) => {
        const el = document.getElementById(elId);
        if (!el) return;
        const valueEl = el.querySelector('.footer-usage-value');
        if (valueEl) {
          const isUnlimited = limit === '∞';
          valueEl.textContent = isUnlimited ? '∞' : `${used}/${limit}`;
          valueEl.classList.toggle('footer-usage-unlimited', isUnlimited);
        }
        el.setAttribute('title', `${used}/${limit}`);
      };

      // Update all quota displays
      // Prompts: daily submit count
      updateQuotaEl('footerUsageGen', promptUsed, promptsMax);
      updateQuotaEl('footerPremiumGen', promptUsed, promptsMax);
      // Tasks & Workflows: total created count (not daily runs)
      updateQuotaEl('footerUsageTasks', tasksCreated, tasksMax);
      updateQuotaEl('footerPremiumTasks', tasksCreated, tasksMax);
      updateQuotaEl('footerUsageWorkflows', wfCreated, wfMax);
      updateQuotaEl('footerPremiumWorkflows', wfCreated, wfMax);

      // Auto Download feature (boolean)
      updateFooterFeatureStatus(
        'footerAutoDownload',
        window.featureGate.canUse('auto_download')
      );
      updateFooterFeatureStatus(
        'footerPremiumDownload',
        window.featureGate.canUse('auto_download')
      );

      // Retry on Fail feature (boolean)
      updateFooterFeatureStatus(
        'footerRetryFail',
        window.featureGate.canUse('retry_on_fail')
      );
      updateFooterFeatureStatus(
        'footerPremiumRetry',
        window.featureGate.canUse('retry_on_fail')
      );

      // Update all toggles based on entitlements
      updateAutoDownloadToggles();
    }

    /**
     * Update tất cả auto_download toggles dựa trên entitlements
     * Disable toggle nếu feature không được phép trong plan
     */
    function updateAutoDownloadToggles() {
      const canUseAutoDownload = window.featureGate?.canUse('auto_download') ?? false;

      // Tab Gen toggle
      const genTabToggle = document.getElementById('genTabAutoDownload');
      if (genTabToggle) {
        _applyFeatureToggleState(genTabToggle, canUseAutoDownload, 'auto_download');
      }

      // Toolbar toggle
      const toolbarToggle = document.getElementById('autoDownloadToggle');
      if (toolbarToggle) {
        _applyFeatureToggleState(toolbarToggle, canUseAutoDownload, 'auto_download');
      }

      // Sync download fields visibility after toggle state change
      // (programmatic .checked change does NOT fire 'change' event)
      if (window.GenTab?._syncDownloadVisibility) {
        window.GenTab._syncDownloadVisibility();
      }
    }

    /**
     * Update tất cả feature-gated toggles (pipeline_queue_enabled, retry_on_fail, etc.)
     * Gọi khi featuregate:refreshed
     */
    function updateFeatureGatedToggles() {
      // Queue toggle
      const canUseQueue = window.featureGate?.canUse('pipeline_queue_enabled') ?? false;
      const queueToggle = document.getElementById('queueEnabled');
      if (queueToggle) {
        _applyFeatureToggleState(queueToggle, canUseQueue, 'pipeline_queue_enabled');
      }
    }

    /**
     * Helper: apply feature gate state to a toggle
     * disable + uncheck + add crown icon khi không có quyền
     */
    function _applyFeatureToggleState(toggle, canUse, featureKey) {
      const label = toggle.closest('label') || toggle.closest('.toolbar-toggle');
      if (!label) return;

      if (canUse) {
        toggle.disabled = false;
        label.classList.remove('feature-disabled');
        label.removeAttribute('title');
        // Remove crown icon nếu có
        (label.querySelector('.premium-crown') || label.parentElement?.querySelector('.premium-crown'))?.remove();
      } else {
        toggle.disabled = true;
        toggle.checked = false;
        label.classList.add('feature-disabled');
        label.setAttribute('title', window.I18n?.t('app.requiresPremium') || 'Tính năng này yêu cầu gói Premium');
        // Add crown icon nếu chưa có — pass featureKey để label đúng theo plan
        _ensurePremiumCrown(label, featureKey);
      }
    }

    /**
     * Thêm icon crown vàng inline bên phải toggle label để user biết cần nâng cấp plan
     */
    function _ensurePremiumCrown(label, featureKey) {
      const parent = label.parentElement || label;
      // Always sync content (label có thể đổi từ "Premium" → "Yêu cầu login" sau khi
      // plans cache load xong → emit featuregate:refreshed → re-call helper). KHÔNG
      // early-return khi crown đã tồn tại — phải update innerHTML + title.
      let crown = parent.querySelector('.premium-crown');
      const created = !crown;
      if (created) {
        crown = document.createElement('span');
        crown.className = 'premium-crown';
      }
      // Anonymous + free plan có quyền → "Yêu cầu login"; else → "Premium"
      crown.innerHTML = window.featureGate?.renderCrownHTML?.(featureKey)
        || '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M5 16L3 5L8.5 10L12 4L15.5 10L21 5L19 16H5ZM19 19C19 19.6 18.6 20 18 20H6C5.4 20 5 19.6 5 19V18H19V19Z"></path></svg> Premium';
      const lbl = window.featureGate?.getCrownLabel?.(featureKey);
      if (lbl) crown.title = lbl;
      if (!created) return; // already in DOM, content đã sync xong
      // Try to place inline after toggle label text
      const toggleLabel = label.querySelector('.toggle-label');
      if (toggleLabel) {
        toggleLabel.insertAdjacentElement('afterend', crown);
      } else {
        label.insertAdjacentElement('afterend', crown);
      }
    }

    // Expose để các module khác có thể gọi
    window.updateAutoDownloadToggles = updateAutoDownloadToggles;
    window.updateFeatureGatedToggles = updateFeatureGatedToggles;
    window._applyFeatureToggleState = _applyFeatureToggleState;
    window._ensurePremiumCrown = _ensurePremiumCrown;

    // Update premium crown badge in header
    function updatePremiumBadge() {
      const crownEl = document.getElementById('headerPremiumCrown');
      const planBadge = document.getElementById('userPlanBadge');

      const isLoggedIn = window.authManager?.isLoggedIn();
      const user = window.authManager?.getUser();
      const isPremium = user?.plan_slug === 'unlimited' || user?.plan_slug === 'premium' || user?.plan_slug === 'autoflow-pro' || user?.plan_slug === 'autogrok-pro' || user?.plan_slug === 'pro';

      // Crown badge (legacy)
      if (crownEl) {
        crownEl.classList.toggle('hidden', !isLoggedIn || !isPremium);
      }

      // User plan badge in header
      if (planBadge) {
        if (!isLoggedIn) {
          planBadge.classList.add('hidden');
        } else {
          planBadge.classList.remove('hidden');
          if (isPremium) {
            const planName = (user?.plan_slug === 'autoflow-pro' || user?.plan_slug === 'autogrok-pro') ? 'Pro' : 'Premium';
            planBadge.textContent = planName;
            planBadge.setAttribute('data-plan', 'pro');
          } else {
            planBadge.textContent = 'Free';
            planBadge.setAttribute('data-plan', 'free');
          }
        }
      }
    }

    // Login button -> show overlay
    if (loginBtn) {
      loginBtn.addEventListener('click', () => {
        if (loginOverlay) loginOverlay.classList.remove('hidden');
      });
    }

    // Close overlay
    if (loginCloseBtn) {
      loginCloseBtn.addEventListener('click', () => {
        if (loginOverlay) loginOverlay.classList.add('hidden');
      });
    }

    // Switch forms
    if (switchToRegister) {
      switchToRegister.addEventListener('click', (e) => {
        e.preventDefault();
        document.getElementById('loginForm')?.classList.add('hidden');
        document.getElementById('registerForm')?.classList.remove('hidden');
        document.getElementById('loginModalTitle').textContent = window.I18n?.t('auth.register') || 'Đăng ký';
      });
    }
    if (switchToLogin) {
      switchToLogin.addEventListener('click', (e) => {
        e.preventDefault();
        document.getElementById('registerForm')?.classList.add('hidden');
        document.getElementById('loginForm')?.classList.remove('hidden');
        document.getElementById('loginModalTitle').textContent = window.I18n?.t('auth.login') || 'Đăng nhập';
      });
    }

    // Login submit
    if (loginSubmitBtn) {
      loginSubmitBtn.addEventListener('click', async () => {
        const email = document.getElementById('loginEmail')?.value?.trim();
        const password = document.getElementById('loginPassword')?.value;
        const errorEl = document.getElementById('loginError');

        if (!email || !password) {
          if (errorEl) { errorEl.textContent = window.I18n?.t('auth.enterEmailPassword') || 'Vui lòng nhập email và mật khẩu'; errorEl.classList.remove('hidden'); }
          return;
        }

        loginSubmitBtn.disabled = true;
        loginSubmitBtn.textContent = window.I18n?.t('msg.loggingIn') || 'Đang đăng nhập...';

        try {
          await window.authManager.login(email, password);
          if (loginOverlay) loginOverlay.classList.add('hidden');
          updateAuthUI();
          setupOnboarding();
          // Re-init storage with API mode
          if (window.storageManager) {
            await window.storageManager.switchToApi();
          }
        } catch (e) {
          // SS-Phase B: Special handling cho EMAIL_NOT_VERIFIED — show resend prompt thay vì
          // generic error. Nếu user click "Gửi lại" → call resendVerificationByEmail (public).
          if (e.code === 'EMAIL_NOT_VERIFIED') {
            // Check system setting
            const emailVerificationRequired = window.SystemConfig?.getBool('email_verification_required') !== false;

            if (!emailVerificationRequired) {
              // Setting đã tắt nhưng server vẫn block → thông báo info, không prompt resend
              if (errorEl) {
                errorEl.textContent = window.I18n?.t('auth.emailVerifyDisabledButBlocked') ||
                  'Email chưa xác minh. Vui lòng liên hệ admin hoặc kiểm tra hộp thư để xác minh.';
                errorEl.classList.remove('hidden');
              }
            } else {
              // Setting bật → hiển thị dialog resend như bình thường
              try {
                const wantResend = await window.customDialog?.confirm?.(
                  window.I18n?.t('auth.emailNotVerifiedMsg') ||
                  'Email chưa xác minh. Gửi lại email xác minh?',
                  {
                    title: window.I18n?.t('auth.emailNotVerifiedTitle') || 'Email chưa xác minh',
                    type: 'warning',
                    confirmText: window.I18n?.t('auth.resendVerify') || 'Gửi lại',
                    cancelText: window.I18n?.t('common.cancel') || 'Đóng',
                  }
                );
                if (wantResend) {
                  await window.authManager.resendVerificationByEmail(email);
                  if (errorEl) {
                    errorEl.textContent = window.I18n?.t('auth.verifyResent') ||
                      'Email xác minh đã được gửi lại. Kiểm tra hộp thư rồi đăng nhập lại.';
                    errorEl.classList.remove('hidden');
                  }
                }
              } catch (resendErr) {
                if (errorEl) { errorEl.textContent = resendErr.message || 'Gửi lại email thất bại'; errorEl.classList.remove('hidden'); }
              }
            }
          } else {
            if (errorEl) { errorEl.textContent = e.message || window.I18n?.t('auth.loginFailed') || 'Đăng nhập thất bại'; errorEl.classList.remove('hidden'); }
          }
        } finally {
          loginSubmitBtn.disabled = false;
          loginSubmitBtn.textContent = window.I18n?.t('auth.login') || 'Đăng nhập';
        }
      });
    }

    // Register submit
    if (registerSubmitBtn) {
      registerSubmitBtn.addEventListener('click', async () => {
        const name = document.getElementById('registerName')?.value?.trim();
        const email = document.getElementById('registerEmail')?.value?.trim();
        const password = document.getElementById('registerPassword')?.value;
        const passwordConfirm = document.getElementById('registerPasswordConfirm')?.value;
        const errorEl = document.getElementById('registerError');

        if (!name || !email || !password || !passwordConfirm) {
          if (errorEl) { errorEl.textContent = window.I18n?.t('auth.fillAllFields') || 'Vui lòng điền đầy đủ thông tin'; errorEl.classList.remove('hidden'); }
          return;
        }
        if (password !== passwordConfirm) {
          if (errorEl) { errorEl.textContent = window.I18n?.t('auth.passwordMismatch') || 'Mật khẩu xác nhận không khớp'; errorEl.classList.remove('hidden'); }
          return;
        }

        registerSubmitBtn.disabled = true;
        registerSubmitBtn.textContent = window.I18n?.t('auth.registering') || 'Đang đăng ký...';

        try {
          await window.authManager.register(name, email, password, passwordConfirm);
          if (loginOverlay) loginOverlay.classList.add('hidden');
          updateAuthUI();
          setupOnboarding();
          if (window.storageManager) {
            await window.storageManager.switchToApi();
          }
        } catch (e) {
          if (errorEl) { errorEl.textContent = e.message || window.I18n?.t('auth.registerFailed') || 'Đăng ký thất bại'; errorEl.classList.remove('hidden'); }
        } finally {
          registerSubmitBtn.disabled = false;
          registerSubmitBtn.textContent = window.I18n?.t('auth.register') || 'Đăng ký';
        }
      });
    }

    // AU-2.7: Forgot password link
    const forgotPasswordLink = document.getElementById('forgotPasswordLink');
    if (forgotPasswordLink) {
      forgotPasswordLink.addEventListener('click', async (e) => {
        e.preventDefault();
        const email = document.getElementById('loginEmail')?.value?.trim();
        if (!email) {
          if (window.customDialog) {
            window.customDialog.alert(window.I18n?.t('auth.enterEmailFirst') || 'Vui lòng nhập email trước khi yêu cầu khôi phục mật khẩu.', { title: window.I18n?.t('auth.enterEmail') || 'Nhập email' });
          }
          document.getElementById('loginEmail')?.focus();
          return;
        }

        forgotPasswordLink.style.pointerEvents = 'none';
        forgotPasswordLink.textContent = window.I18n?.t('app.sending') || 'Đang gửi...';

        try {
          await window.authManager.forgotPassword(email);
          if (window.customDialog) {
            window.customDialog.alert(window.I18n?.t('auth.resetEmailSent') || 'Đã gửi email khôi phục mật khẩu. Vui lòng kiểm tra hộp thư của bạn.', { title: window.I18n?.t('common.success') || 'Thành công', type: 'success' });
          }
        } catch (err) {
          if (window.customDialog) {
            window.customDialog.alert(err.message || window.I18n?.t('auth.resetEmailFailed') || 'Không thể gửi email khôi phục. Vui lòng thử lại sau.', { title: window.I18n?.t('common.error') || 'Lỗi', type: 'error' });
          }
        } finally {
          forgotPasswordLink.style.pointerEvents = '';
          forgotPasswordLink.textContent = window.I18n?.t('auth.forgotPassword') || 'Quên mật khẩu?';
        }
      });
    }

    // AU-4.10 + AU-4.11: Google login/register buttons
    const googleLoginBtn = document.getElementById('googleLoginBtn');
    const googleRegisterBtn = document.getElementById('googleRegisterBtn');

    let _googleAuthPending = false;
    async function handleGoogleAuth(e) {
      // Debounce: tránh click nhiều lần gây 429
      if (_googleAuthPending) return;
      _googleAuthPending = true;

      const btn = e?.currentTarget;
      const originalText = btn?.textContent;
      if (btn) {
        btn.disabled = true;
        btn.textContent = window.I18n?.t('auth.connecting') || 'Connecting...';
      }

      try {
        await window.authManager.loginWithGoogle();
        // OAuth flow continues in new tab → background.js handles token
      } catch (err) {
        if (window.customDialog) {
          window.customDialog.alert(err.message || window.I18n?.t('app.googleConnectError') || 'Không thể kết nối với Google. Vui lòng thử lại.', { title: window.I18n?.t('common.error') || 'Lỗi', type: 'error' });
        }
      } finally {
        // Reset sau 3 giây (cho phép thử lại nếu tab không mở được)
        setTimeout(() => {
          _googleAuthPending = false;
          if (btn) {
            btn.disabled = false;
            btn.textContent = originalText;
          }
        }, 3000);
      }
    }

    if (googleLoginBtn) {
      googleLoginBtn.addEventListener('click', handleGoogleAuth);
    }
    if (googleRegisterBtn) {
      googleRegisterBtn.addEventListener('click', handleGoogleAuth);
    }

    // AU-4.13: Listen for OAuth success from background.js
    // CRITICAL: KHÔNG dùng `async` listener — Chrome MV3 sẽ treat returned Promise
    // như async response intent → giữ message channel mở → caller nhận `null` cho TẤT CẢ
    // chrome.runtime.sendMessage khác (kể cả từ popup window). Wrap async work trong IIFE.
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg.action !== 'auth:oauthLogin' || !msg.token) return;
      (async () => {
        // Check nếu storage handler đã xử lý login này (token đã được set)
        if (window.authManager?.token === msg.token) {
          console.log('[TobyFlow] OAuth: Skip message handler, storage handler đã xử lý');
          return;
        }

        // Set flag để storage handler không xử lý duplicate
        window._oauthLoginProcessing = true;

        // Update AuthManager state
        window.authManager.token = msg.token;
        window.authManager.user = msg.user || null;
        // [Fix re-login] Reset cascade-block flags được set bởi logout/refresh-fail trước đó.
        // Nếu không reset, mọi _apiCall non-auth sẽ bị short-circuit với UNAUTHENTICATED →
        // login OAuth thành công nhưng extension vẫn báo chưa login.
        window.authManager._sessionInvalid = false;
        window.authManager._rateLimitedUntil = 0;

        // Close login overlay
        if (loginOverlay) loginOverlay.classList.add('hidden');

        // Update UI
        updateAuthUI();
        setupOnboarding();

        // Refresh FeatureGate TRƯỚC khi emit auth:login để có data mới nhất
        if (window.featureGate) {
          try {
            await window.featureGate.resetForLogin();
            console.log('[TobyFlow] OAuth: Entitlements refreshed');
          } catch (e) {
            console.warn('[TobyFlow] OAuth: Không thể refresh entitlements', e);
          }
        }

        // Switch to API storage (await để clear local trước khi emit auth:login)
        if (window.storageManager) {
          await window.storageManager.switchToApi();
        }

        // Fetch full user info
        window.authManager.fetchUser().then(() => {
          updateAuthUI();
          checkEmailVerification();
        }).catch(() => {});

        // Emit auth event
        if (window.eventBus) {
          window.eventBus.emit('auth:login', { user: msg.user });
        }

        // Clear flag sau khi xử lý xong
        window._oauthLoginProcessing = false;
      })();
    });

    // Note: Đã remove auth drift polling (setInterval 3s + chrome.alarms listener) sau khi
    // xác định root cause là Chrome HTTP cache. storage.onChanged + runtime.onMessage
    // listener đã handle đủ login/logout sync, không cần polling tốn CPU.

    // F36: Handle payment completion from checkout page
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg.action === 'payment:completed') {
        // Close upgrade modal if open
        const upgradeOverlay = document.getElementById('upgradeOverlay');
        if (upgradeOverlay && !upgradeOverlay.classList.contains('hidden')) {
          upgradeOverlay.classList.add('hidden');
        }

        // Refresh entitlements (plan may have changed)
        if (window.featureGate) {
          window.featureGate.refreshAsync();
        }

        // Show success toast
        if (typeof showToast === 'function') {
          showToast('Thanh toán thành công! Gói đã được kích hoạt.');
        }

        // Log
        if (typeof sendLog === 'function') {
          sendLog('[Payment] Thanh toán thành công, order: ' + (msg.orderId || ''), 'info');
        }
      }

      if (msg.action === 'payment:cancelled') {
        if (typeof showToast === 'function') {
          showToast('Thanh toán đã bị hủy.');
        }
      }
    });

    // AU-3.9 + AU-3.10: Email verification banner
    const emailVerifyBanner = document.getElementById('emailVerifyBanner');
    const emailVerifyResendBtn = document.getElementById('emailVerifyResendBtn');
    const emailVerifyCloseBtn = document.getElementById('emailVerifyCloseBtn');
    let _emailVerifyDismissed = false;

    function checkEmailVerification() {
      if (!emailVerifyBanner) return;

      // Check system setting - nếu email_verification_required = false thì không hiển thị banner
      const emailVerificationRequired = window.SystemConfig?.getBool('email_verification_required') !== false;
      if (!emailVerificationRequired) {
        emailVerifyBanner.classList.add('hidden');
        return;
      }

      const isLoggedIn = window.authManager?.isLoggedIn();
      const user = window.authManager?.getUser();

      if (isLoggedIn && user && user.email_verified === false && !_emailVerifyDismissed) {
        emailVerifyBanner.classList.remove('hidden');
      } else {
        emailVerifyBanner.classList.add('hidden');
      }
    }

    if (emailVerifyCloseBtn) {
      emailVerifyCloseBtn.addEventListener('click', () => {
        _emailVerifyDismissed = true;
        emailVerifyBanner?.classList.add('hidden');
      });
    }

    if (emailVerifyResendBtn) {
      emailVerifyResendBtn.addEventListener('click', async () => {
        emailVerifyResendBtn.disabled = true;
        emailVerifyResendBtn.textContent = window.I18n?.t('app.sending') || 'Đang gửi...';

        try {
          await window.authManager.resendVerification();
          emailVerifyResendBtn.textContent = window.I18n?.t('app.sent') || 'Đã gửi!';

          // Disable 60 giây tránh spam
          let countdown = 60;
          const interval = setInterval(() => {
            countdown--;
            if (countdown <= 0) {
              clearInterval(interval);
              emailVerifyResendBtn.textContent = window.I18n?.t('auth.resendEmail') || 'Gửi lại email';
              emailVerifyResendBtn.disabled = false;
            } else {
              emailVerifyResendBtn.textContent = window.I18n?.t('app.waitCountdown', { seconds: countdown }) || `Chờ ${countdown}s`;
            }
          }, 1000);
        } catch (err) {
          emailVerifyResendBtn.textContent = window.I18n?.t('auth.resendEmail') || 'Gửi lại email';
          emailVerifyResendBtn.disabled = false;
          if (window.customDialog) {
            window.customDialog.alert(err.message || window.I18n?.t('auth.resendEmailFailed') || 'Không thể gửi email xác minh. Vui lòng thử lại sau.', { title: window.I18n?.t('common.error') || 'Lỗi', type: 'error' });
          }
        }
      });
    }

    // Check email verification on login
    if (window.eventBus) {
      window.eventBus.on('auth:login', () => {
        _emailVerifyDismissed = false;
        setTimeout(checkEmailVerification, 500);
      });
      window.eventBus.on('auth:logout', () => {
        _emailVerifyDismissed = false;
        emailVerifyBanner?.classList.add('hidden');
      });
    }

    // Initial check
    checkEmailVerification();

    // Multi-tab warning banner
    const multiTabBanner = document.getElementById('multiTabBanner');
    const multiTabCount = document.getElementById('multiTabCount');
    const multiTabCloseBtn = document.getElementById('multiTabCloseBtn');
    const multiTabDismissBtn = document.getElementById('multiTabDismissBtn');
    let _multiTabDismissed = false;

    async function checkMultiFlowTabs() {
      if (!multiTabBanner || _multiTabDismissed) return;
      try {
        const tabs = await chrome.tabs.query({ url: window.ProviderConfigManager?.getTabQuery('flow') });
        if (tabs.length > 1) {
          if (multiTabCount) multiTabCount.textContent = tabs.length;
          multiTabBanner.classList.remove('hidden');
        } else {
          multiTabBanner.classList.add('hidden');
        }
      } catch (e) {
        // Silently ignore — tabs API may not be available
      }
    }

    if (multiTabCloseBtn) {
      multiTabCloseBtn.addEventListener('click', async () => {
        try {
          const targetTabId = window._targetFlowTabId || null;
          const tabs = await chrome.tabs.query({ url: window.ProviderConfigManager?.getTabQuery('flow') });
          const otherTabs = tabs.filter(t => t.id !== targetTabId);
          if (otherTabs.length === 0 && tabs.length > 1) {
            // No target set — keep active tab, close others
            const activeTabs = tabs.filter(t => t.active);
            const keepId = activeTabs.length > 0 ? activeTabs[0].id : tabs[0].id;
            const toClose = tabs.filter(t => t.id !== keepId);
            for (const t of toClose) {
              await chrome.tabs.remove(t.id);
            }
          } else {
            for (const t of otherTabs) {
              await chrome.tabs.remove(t.id);
            }
          }
          multiTabBanner.classList.add('hidden');
        } catch (e) {
          console.warn('[TobyFlow] Failed to close other tabs:', e.message);
        }
      });
    }

    if (multiTabDismissBtn) {
      multiTabDismissBtn.addEventListener('click', () => {
        _multiTabDismissed = true;
        multiTabBanner?.classList.add('hidden');
      });
    }

    // Listen for tab changes to re-check
    try {
      chrome.tabs.onCreated.addListener(() => {
        _multiTabDismissed = false;
        setTimeout(checkMultiFlowTabs, 500);
      });
      chrome.tabs.onRemoved.addListener(() => {
        setTimeout(checkMultiFlowTabs, 500);
      });
      chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
        if (changeInfo.url && changeInfo.url.includes('labs.google/fx')) {
          _multiTabDismissed = false;
          setTimeout(checkMultiFlowTabs, 500);
        }
      });
    } catch (e) {
      // Tab events may not be available in all contexts
    }

    // Initial check
    checkMultiFlowTabs();

    // User menu toggle
    if (userMenuBtn) {
      userMenuBtn.addEventListener('click', () => {
        if (userDropdown) userDropdown.classList.toggle('hidden');
      });
      // Close dropdown on outside click
      document.addEventListener('click', (e) => {
        if (userDropdown && !userDropdown.classList.contains('hidden') && !userMenuBtn.contains(e.target) && !userDropdown.contains(e.target)) {
          userDropdown.classList.add('hidden');
        }
      });
    }

    // Logout
    if (logoutBtn) {
      logoutBtn.addEventListener('click', async () => {
        if (userDropdown) userDropdown.classList.add('hidden');
        await window.authManager.logout();
        updateAuthUI();
        // Switch back to local storage
        if (window.storageManager) {
          window.storageManager.switchToLocal();
        }
      });
    }

    // ─── Module Overlays (thay thế Auth Gate Overlays cũ) ──────────────────────────────
    // Module-blocked-overlay giờ được quản lý bởi refreshModuleOverlays()
    // Không còn sử dụng các auth-gate-overlay riêng lẻ trong HTML

    // Listen for auth events
    if (window.eventBus) {
      window.eventBus.on('auth:login', updateAuthUI);
      window.eventBus.on('auth:logout', updateAuthUI);
      window.eventBus.on('auth:login', refreshModuleOverlays);
      window.eventBus.on('auth:login', refreshSubtabOverlays);
      // NOTE: auth:logout refreshModuleOverlays đã được xử lý trong handler riêng
      // (sau resetForLogout) để đảm bảo FeatureGate đã reset trước khi refresh overlays

      // Auto-init tab-tasks khi login nếu module được enabled
      // (TaskList chưa init nếu trước đó module bị block)
      window.eventBus.on('auth:login', async () => {
        const tasksPane = document.getElementById('tab-tasks');
        if (!tasksPane) return;
        // Đợi featureGate refresh xong
        await new Promise(r => setTimeout(r, 500));
        const isAllowed = window.featureGate?.isModuleEnabled?.('tasks') === true;
        if (isAllowed) {
          hideModuleBlockedOverlay(tasksPane);
          // Init hoặc reload TaskList
          if (tasksPane.__multiTaskTab?.taskList) {
            tasksPane.__multiTaskTab.taskList.loadTasks();
          } else {
            initializeTab('tab-tasks').catch(e => console.warn('[TobyFlow] tab-tasks init error:', e));
          }
        }
      });

      // R-2.2: SSE lifecycle — connect khi login, disconnect khi logout
      window.eventBus.on('auth:login', () => {
        if (window.SseClient) {
          console.log('[SSE] Auth login → kết nối SSE');
          window.SseClient.connect();
        }
      });
      window.eventBus.on('auth:logout', () => {
        if (window.SseClient) {
          console.log('[SSE] Auth logout → ngắt kết nối SSE');
          window.SseClient.disconnect();
        }
      });

      // Clear & reload UI lists khi logout (server-synced data đã bị xóa bởi _clearAuth)
      // NOTE: FeatureGate.resetForLogout() đã được gọi trong AuthManager.logout() TRƯỚC khi emit event
      window.eventBus.on('auth:logout', () => {
        console.log('[TobyFlow] Auth logout → reload UI lists (data cleared)');

        // Emit storage events → TaskList & WorkflowList sẽ tự reload (đọc từ local → empty)
        window.eventBus.emit('storage:task_deleted');
        window.eventBus.emit('storage:workflow_deleted');
        // Reload UserPromptsManager (clear in-memory, sẽ fallback sang _loadLocal → empty)
        if (window.userPromptsManager) {
          window.userPromptsManager.prompts = [];
          window.userPromptsManager.isInitialized = false;
        }
        // Refresh subtab overlays after logout
        refreshSubtabOverlays();
      });

      // Handle API auth errors (401/403) from ApiStorage - switch to local mode
      window.eventBus.on('api:auth_error', () => {
        console.warn('[TobyFlow] API auth error → switching to local mode');
        if (window.storageManager?.mode === 'api') {
          window.storageManager.switchToLocal();
        }
        // Emit logout để UI update
        if (window.authManager?.isLoggedIn()) {
          window.authManager._clearAuth?.().then(() => {
            window.eventBus.emit('auth:logout', { reason: 'api_auth_error' });
          }).catch(() => {});
        }
      });

      // Listen for trial usage changes (anonymous users)
      window.eventBus.on('trialgate:usage_changed', () => {
        refreshModuleOverlays();
        refreshSubtabOverlays();
        updateTrialFooterBars();
      });

      // Listen for storage changes (task/workflow create/delete) to update footer counts
      // Dùng updateFooterUI() thay vì gọi riêng trial/free — đảm bảo premium footer cũng được update
      window.eventBus.on('storage:task_saved', () => {
        updateFooterUI();
        refreshModuleOverlays();
      });
      window.eventBus.on('storage:task_deleted', () => {
        updateFooterUI();
        refreshModuleOverlays();
      });
      window.eventBus.on('storage:workflow_saved', () => {
        updateFooterUI();
        refreshModuleOverlays();
      });
      window.eventBus.on('storage:workflow_deleted', () => {
        updateFooterUI();
        refreshModuleOverlays();
      });
      window.eventBus.on('storage:workflow_full_saved', () => {
        updateFooterUI();
        refreshModuleOverlays();
      });

      // === R-2.3: SSE Event Handlers ===

      // Entitlements thay đổi từ server (plan upgrade/downgrade/admin change)
      window.eventBus.on('sse:entitlements_changed', async (data) => {
        console.log('[SSE] Entitlements thay đổi, plan:', data?.plan?.slug);
        // Relay tới popup windows (settings, workflow editor) để chúng refresh featureGate/UI
        try { chrome.runtime.sendMessage({ action: 'sseRelay:entitlements_changed', data }).catch(() => {}); } catch (e) { /* ignore */ }
        if (data?.features && data?.plan) {
          // E3.1: Delegate to FeatureGate.handleSseEntitlementsChanged()
          // Method này sẽ:
          // - Update entitlements + plan
          // - Set _lastSseRefresh timestamp (cho conditional refresh)
          // - Save cache
          // - Emit featuregate:refreshed event
          if (window.featureGate?.handleSseEntitlementsChanged) {
            window.featureGate.handleSseEntitlementsChanged(data);
          }

          // Update authManager.user.plan_slug để footer UI đúng
          if (window.authManager?.user && data.plan?.slug) {
            window.authManager.user.plan_slug = data.plan.slug;
            if (data.plan.name) {
              window.authManager.user.plan_name = data.plan.name;
            }
            // Persist to storage
            const stored = await chrome.storage.local.get('af_auth');
            if (stored.af_auth) {
              stored.af_auth.user = window.authManager.user;
              await chrome.storage.local.set({ af_auth: stored.af_auth });
            }
          }

          // Refresh UI components (bổ sung cho event listener)
          if (typeof updateFooterUI === 'function') updateFooterUI();
          if (typeof updateAuthUI === 'function') updateAuthUI();
        }
      });

      // Plan activated - hiện overlay chúc mừng (chỉ 1 lần per order)
      window.eventBus.on('sse:plan_activated', async (data) => {
        console.log('[SSE] Plan activated:', data?.plan_slug, data?.is_upgrade ? '(upgrade)' : '');
        if (!data?.order_id) return;

        // [Upgrade Prorated 2026-05-31] Refresh user data sau plan_activated để extension
        // có plan_expires_at + plan_billing_cycle MỚI (entitlements_changed event chỉ update
        // plan_slug + plan_name). Nếu không refresh → lần mở upgrade modal kế tiếp tính credit
        // sai vì dùng expires_at cũ. Best-effort, không block overlay show.
        try { await window.authManager?.fetchUser?.(); } catch (_) {}

        // Check đã show overlay cho order này chưa
        const storageKey = 'af_shown_plan_activated';
        const stored = await chrome.storage.local.get(storageKey);
        const shownOrders = stored[storageKey] || [];

        if (shownOrders.includes(data.order_id)) {
          console.log('[SSE] Đã show overlay cho order này rồi:', data.order_id);
          return;
        }

        // Đánh dấu đã show
        shownOrders.push(data.order_id);
        // Giữ tối đa 50 order IDs gần nhất
        if (shownOrders.length > 50) shownOrders.shift();
        await chrome.storage.local.set({ [storageKey]: shownOrders });

        // Hiện overlay chúc mừng
        showPlanActivatedOverlay(data);
      });

      // Force logout từ admin
      window.eventBus.on('sse:force_logout', (data) => {
        console.log('[SSE] Force logout:', data?.reason);
        // Relay tới popup windows để chúng đóng window (tránh user thao tác trên session đã bị revoke)
        try { chrome.runtime.sendMessage({ action: 'sseRelay:force_logout', data }).catch(() => {}); } catch (e) { /* ignore */ }
        if (window.SseClient) window.SseClient.disconnect();
        window.authManager?.logout(data?.reason || 'admin_revoked');
      });

      // Session bị thay thế bởi thiết bị khác — chỉ disconnect, không hiện modal
      // Trạng thái SSE đã thể hiện qua icon status ở header
      window.eventBus.on('sse:session_replaced', (data) => {
        console.log('[SSE] Phiên bị thay thế:', data?.device_info);
        if (window.SseClient) window.SseClient.disconnect();
      });

      // Thông báo từ hệ thống
      window.eventBus.on('sse:announcement', (data) => {
        if (window.customDialog && data?.message) {
          window.customDialog.alert(
            data.message,
            { title: data?.title || window.I18n?.t('app.systemNotification') || 'Thông báo hệ thống', type: data?.type || 'info' }
          );
        }
      });

      // SS: System settings thay đổi từ admin (show/hide upgrade, maintenance, etc.)
      window.eventBus.on('sse:system_settings_changed', (data) => {
        console.log('[SSE] System settings thay đổi', data?.section || 'all');
        if (window.SystemConfig) {
          window.SystemConfig.handleSseUpdate(data);
        }
        // Re-check email verification banner khi setting thay đổi
        if (typeof checkEmailVerification === 'function') {
          checkEmailVerification();
        }
      });

      // Refresh ChatGPT/Grok error_patterns khi admin update qua
      // /admin/providers → API Configs (event provider:api_config_updated).
      window.eventBus.on('provider:api_config_updated', ({ provider, key }) => {
        if (key === 'error_patterns' || key === 'ui_text_patterns') {
          if (provider === 'chatgpt') {
            console.log('[SSE] Provider API config updated — refresh ChatGPTConfig');
            window.ChatGPTConfig?.refresh?.();
          } else if (provider === 'grok') {
            console.log('[SSE] Provider API config updated — refresh GrokConfig');
            window.GrokConfig?.refresh?.();
          }
        }
      });

      // Telegram command (Phase V) -- TelegramExecutor xu ly
      if (window.TelegramExecutor) {
        window.TelegramExecutor.init();
      }

      // UA: Khoi tao usage analytics tracking
      if (window.UsageSync) {
        window.UsageSync.init();
      }

      // R-2.4: SSE status indicator + notification banner
      const _sseStates = ['connected', 'disconnected', 'connecting'];
      function _setSseDotState(state, title) {
        const dot = document.querySelector('#sseStatusDot');
        if (!dot) return;
        for (const s of _sseStates) dot.classList.remove(s);
        dot.classList.add(state);
        dot.title = title;
      }

      // SSE notification banner
      const sseNotif = document.getElementById('sseNotif');
      const sseNotifText = document.getElementById('sseNotifText');
      const sseNotifClose = document.getElementById('sseNotifClose');
      let _sseDisconnectTimer = null;
      let _sseWasConnected = false;
      let _sseNotifDismissed = false; // User dismissed, don't show again until reconnect
      // [Audit fix 2026-05-24] Track SSE disconnect → reconnect → trigger refresh để catch missed events
      let _sseHasDisconnected = false;

      function _showSseNotif(message) {
        if (!sseNotif || _sseNotifDismissed) return;
        if (sseNotifText) sseNotifText.textContent = message;
        sseNotif.classList.remove('hidden');
      }

      function _hideSseNotif() {
        if (sseNotif) sseNotif.classList.add('hidden');
      }

      // Close button handler
      if (sseNotifClose) {
        sseNotifClose.addEventListener('click', () => {
          _hideSseNotif();
          _sseNotifDismissed = true;
        });
      }

      window.eventBus.on('sse:connected', () => {
        _setSseDotState('connected', window.I18n?.t('app.sseConnected') || 'Realtime: Đã kết nối');
        _sseWasConnected = true;
        _sseNotifDismissed = false; // Reset dismiss flag on reconnect
        _hideSseNotif();
        if (_sseDisconnectTimer) {
          clearTimeout(_sseDisconnectTimer);
          _sseDisconnectTimer = null;
        }

        // [Audit fix 2026-05-24] SSE reconnect → trigger refresh entitlements để catch
        // missed events (vd entitlements_changed publish lúc SSE down → Redis replay TTL
        // 300s có thể hết hạn → event lost forever → user stuck plan cũ).
        // First connect (post-init) → skip (FeatureGate.init() auto fetch nếu cache stale).
        // Subsequent reconnect → trigger refresh với source 'sse_reconnect' bypass SSE skip.
        if (_sseHasDisconnected && window.authManager?.isLoggedIn()) {
          console.log('[TobyFlow] SSE reconnected → trigger refreshPermissions to catch missed events');
          refreshPermissions('sse_reconnect').catch(() => {});
        }
        _sseHasDisconnected = false;
      });

      window.eventBus.on('sse:disconnected', () => {
        // [Audit fix 2026-05-24] Track disconnect để sse:connected handler biết đây là reconnect
        // → trigger refresh catch missed events
        _sseHasDisconnected = true;
        // Show login prompt for not-logged-in users
        if (!window.authManager?.isLoggedIn()) {
          _setSseDotState('disconnected', window.I18n?.t('app.sseLoginRequired') || 'Đăng nhập để sử dụng đầy đủ');
          _showSseNotif(window.I18n?.t('app.sseLoginPrompt') || 'Đăng nhập để sử dụng đầy đủ chức năng miễn phí');
          return;
        }
        _setSseDotState('disconnected', window.I18n?.t('app.sseDisconnected') || 'Realtime: Mất kết nối');
        // Only show notification if was previously connected and doesn't reconnect within 10s
        if (_sseWasConnected && !_sseDisconnectTimer) {
          _sseDisconnectTimer = setTimeout(() => {
            _sseDisconnectTimer = null;
            if (!window.SseClient?.isConnected()) {
              _showSseNotif(window.I18n?.t('app.sseDisconnectShort') || 'Mất kết nối realtime');
            }
          }, 10000);
        }
      });

      window.eventBus.on('sse:connecting', () => {
        _setSseDotState('connecting', window.I18n?.t('app.sseConnecting') || 'Realtime: Đang kết nối...');
      });

      window.eventBus.on('sse:gave_up', () => {
        // Show login prompt for not-logged-in users
        if (!window.authManager?.isLoggedIn()) {
          _setSseDotState('disconnected', window.I18n?.t('app.sseLoginRequired') || 'Đăng nhập để sử dụng đầy đủ');
          _showSseNotif(window.I18n?.t('app.sseLoginPrompt') || 'Đăng nhập để sử dụng đầy đủ chức năng miễn phí');
          return;
        }
        _setSseDotState('disconnected', window.I18n?.t('app.sseGaveUp') || 'Realtime: Không thể kết nối server. Sẽ thử lại khi focus.');
        _showSseNotif(window.I18n?.t('app.sseGaveUpShort') || 'Không thể kết nối server');
      });

      // Listen for follower mode - tab is receiving events via BroadcastChannel
      window.eventBus.on('sse:follower_mode', () => {
        _setSseDotState('connected', window.I18n?.t('app.sseFollowerMode') || 'Realtime: Follower - qua BroadcastChannel');
        _sseWasConnected = true;
        _sseNotifDismissed = false;
        _hideSseNotif();
        if (_sseDisconnectTimer) {
          clearTimeout(_sseDisconnectTimer);
          _sseDisconnectTimer = null;
        }
      });

      // Initial state: show login prompt for not-logged-in users
      if (!window.authManager?.isLoggedIn()) {
        _setSseDotState('disconnected', window.I18n?.t('app.sseLoginRequired') || 'Đăng nhập để sử dụng đầy đủ');
        _showSseNotif(window.I18n?.t('app.sseLoginPrompt') || 'Đăng nhập để sử dụng đầy đủ chức năng miễn phí');
      }

      // Hide login prompt when user logs in
      window.eventBus.on('auth:login', () => {
        _hideSseNotif();
        _sseNotifDismissed = false;
      });

      // Update SSE banner text when language changes
      window.eventBus.on('i18n:changed', () => {
        if (!sseNotif || sseNotif.classList.contains('hidden')) return;
        // Re-show with updated language
        if (!window.authManager?.isLoggedIn()) {
          _setSseDotState('disconnected', window.I18n?.t('app.sseLoginRequired') || 'Đăng nhập để sử dụng đầy đủ');
          if (sseNotifText) sseNotifText.textContent = window.I18n?.t('app.sseLoginPrompt') || 'Đăng nhập để sử dụng đầy đủ chức năng miễn phí';
        } else if (!window.SseClient?.isConnected()) {
          _setSseDotState('disconnected', window.I18n?.t('app.sseDisconnected') || 'Realtime: Mất kết nối');
          if (sseNotifText) sseNotifText.textContent = window.I18n?.t('app.sseDisconnectShort') || 'Mất kết nối realtime';
        }
      });

      // Listen for album:use event - add album images to tab_gen ref images
      // async handler: STALE images get uploaded immediately (like local file uploads)
      window.eventBus.on('album:use', async (data) => {
        const { images } = data;
        if (!images || images.length === 0) return;

        // Add images to GenTab ref images
        if (window.GenTab && window.GenTab.fileIdsInput && window.AlbumList) {
          const existingIds = (window.GenTab.fileIdsInput.value || '').split(',')
            .map(s => s.trim()).filter(Boolean);

          const newIds = [];
          for (const img of images) {
            const fileId = img.file_id || img.fileId;
            // Skip duplicate (by file_id if exists)
            if (fileId && existingIds.includes(fileId)) continue;

            // Check image status for STALE detection
            const status = await window.AlbumList._checkImageStatus(img);

            // Prepare image — STALE/no-file-id gets upload_xxx key, ALIVE gets file_id
            const useKey = await window.AlbumList._prepareImageForGenTab(img, status);
            if (useKey && !existingIds.includes(useKey)) {
              newIds.push(useKey);
            }
          }

          if (newIds.length > 0) {
            const mergedIds = [...existingIds, ...newIds];
            window.GenTab.fileIdsInput.value = mergedIds.join(', ');
            window.GenTab.fileIdsInput.dispatchEvent(new Event('input', { bubbles: true }));
            window.GenTab.renderFileIdThumbnails();
            window.GenTab._refreshMentionHelper();
            window.GenTab.saveState();

            // Switch to gen tab
            const genTabBtn = document.querySelector('.tobyflow-tab[data-tab="tab-gen"]');
            if (genTabBtn) genTabBtn.click();
          }
        }
      });

      // Listen for capture:start event - trigger screen capture, optionally add to album
      window.eventBus.on('capture:start', async (data) => {
        if (!window.ScreenCapture) {
          console.warn('[TobyFlow] ScreenCapture not available');
          return;
        }
        const result = await ScreenCapture.startCapture();
        if (!result.success || !result.uploadId) return;

        // Emit capture:complete cho AlbumCreateModal và các listeners khác
        window.eventBus.emit('capture:complete', {
          uploadId: result.uploadId,
          captureName: result.captureName,
          thumbnail: window.pendingUploadFiles?.get(result.uploadId)?.thumbnail || null
        });

        // Nếu có targetAlbumId → thêm ảnh vào album
        if (data?.targetAlbumId && window.ImageStore) {
          try {
            const pending = window.pendingUploadFiles?.get(result.uploadId);
            const thumbBlob = pending?.thumbnail || null;
            const imageData = {
              name: result.captureName || ('capture_' + Date.now().toString(36)),
              type: 'capture',
              original_name: result.captureName,
              pending_upload_key: result.uploadId  // Track upload key for later resolution
            };
            await window.ImageStore.addImage(data.targetAlbumId, imageData, thumbBlob, pending?.file || null);
            console.log('[TobyFlow] Capture added to album:', data.targetAlbumId);
            // Refresh album list
            window.eventBus.emit('album:refresh');
          } catch (e) {
            console.error('[TobyFlow] Failed to add capture to album:', e);
          }
        }
      });

      // Listen for upload:completed to update album images with file_id
      // (Capture images added to albums have pending_upload_key but no file_id)
      window.eventBus.on('upload:completed', async (data) => {
        if (!data?.key || !window.ImageStore) return;
        try {
          // Find album images with matching pending_upload_key
          const images = await window.ImageStore.getImagesNeedingResolution();
          const matching = images.filter(img => img.pending_upload_key === data.key);

          for (const img of matching) {
            await window.ImageStore.updateImage(img.id, {
              file_id: data.tile_id,
              file_name: data.file_name,
              thumbnail_url: data.thumbnail_url,
              pending_upload_key: null  // Clear pending flag
            });
            console.log('[TobyFlow] Album image updated after upload:', img.id, data.tile_id);
          }

          if (matching.length > 0) {
            window.eventBus.emit('album:refresh');
          }
        } catch (e) {
          console.warn('[TobyFlow] Failed to update album image after upload:', e);
        }
      });

      // Listen for plan changes (triggered when fetchUser detects plan_slug change)
      window.eventBus.on('plan:changed', (data) => {
        console.log(`[TobyFlow] Plan changed event: ${data.oldPlan} → ${data.newPlan}`);
        updateAuthUI();
        refreshModuleOverlays();
        // Clear cached plans so upgrade modal refetches
        cachedPlans = null;
      });
    }

    // Initial state
    updateAuthUI();
    refreshModuleOverlays();

    // Listen for messages from other contexts (workflow editor popup window)
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg.action === 'executionStatusUpdate' || msg.action === 'workflowEditorClosed') {
        // Workflow was saved/created/run from popup window - update footer & gates
        updateTrialFooterBars();
        updateFooterUsageBars();
        refreshModuleOverlays();
      }
      // Settings popup closed → refresh entitlements/account UI in case user changed plan
      if (msg.action === 'settingsClosed') {
        try { window.featureGate?.refresh?.(); } catch (e) { /* ignore */ }
        updateTrialFooterBars();
        updateFooterUsageBars();
        refreshModuleOverlays();
        updateAuthUI?.();
      }
      // Relay từ background.js khi popup window (angles/effects) yêu cầu mở upgrade modal
      if (msg.action === 'showUpgradeModal' && typeof window.openUpgradeModal === 'function') {
        window.openUpgradeModal();
      }

      // Relay từ workflow editor popup khi user click "Sao chép template" ở chế độ preview
      if (msg.action === 'cloneWorkflowTemplate' && msg.templateId) {
        if (window.workflowTemplateList?._copyTemplateToWorkflow) {
          window.workflowTemplateList._copyTemplateToWorkflow(msg.templateId);
        }
        sendResponse?.({ ok: true });
      }

      // Relay từ workflow editor popup khi admin click "Chỉnh sửa template" ở chế độ preview
      if (msg.action === 'editWorkflowTemplate' && msg.templateId) {
        if (window.workflowTemplateList?._openTemplateForEdit) {
          window.workflowTemplateList._openTemplateForEdit(msg.templateId);
        }
        sendResponse?.({ ok: true });
      }

      // Relay template events từ popup editor → sidebar để refresh template list
      if (msg.action === 'templateCreated' && msg.templateId) {
        if (window.eventBus) {
          window.eventBus.emit('template:created', { templateId: msg.templateId });
        }
      }
      if (msg.action === 'templateUpdated' && msg.templateId) {
        if (window.eventBus) {
          window.eventBus.emit('template:updated', { templateId: msg.templateId });
        }
      }

      // Relay từ popup editor khi clone shared workflow thành công
      if (msg.action === 'workflowClonedFromShared' && msg.workflow) {
        (async () => {
          // Refresh workflow list
          if (window.workflowList?.loadWorkflows) {
            await window.workflowList.loadWorkflows();
          }
          // Refresh featureGate quota
          if (window.featureGate) {
            window.featureGate.refresh().catch(() => {});
          }
          // Chuyển sang tab workflows và mở editor
          const workflowsTab = document.querySelector('[data-subtab="workflows"]');
          if (workflowsTab) workflowsTab.click();
          // Mở workflow editor với workflow mới
          setTimeout(() => {
            if (window.workflowList?._openWorkflow) {
              window.workflowList._openWorkflow(msg.workflow.wf_id);
            } else if (window.eventBus) {
              window.eventBus.emit('workflow:open_editor', { mode: 'edit', workflow: msg.workflow });
            }
          }, 300);
        })();
      }

      // Grok generation progress relay từ chat-content-grok.js → ExecutionTracker.
      // CRITICAL — KHÔNG pass `owner` + `phase` + `label` để giữ nguyên context của lock
      // hiện tại (prompts/task/workflow). ExecutionTracker._render merge data → nếu pass
      // owner='prompts' sẽ override label "Task: ABC" hoặc "Workflow: XYZ" → SAI.
      // Chỉ pass progress fields → tracker render "Generating XX%" giữ label gốc.
      // Đồng bộ cho cả 3 path: GenTab (lock=prompts), Task (lock=task), Workflow node (lock=workflow).
      if (msg.action === 'grok:gen_progress' && window.eventBus) {
        window.eventBus.emit('execution:tracker_update', {
          genProgress: msg.progress,
          genElapsed: msg.elapsed,
          genMode: msg.mode,
        });
      }
      // Relay từ background.js khi settings popup yêu cầu hiển thị login overlay
      if (msg.action === 'showLoginOverlay') {
        const loginOverlay = document.getElementById('loginOverlay');
        if (loginOverlay) {
          loginOverlay.classList.remove('hidden');
        }
      }
      // ExecutionLock broadcast from popup windows (workflow, angles, effects)
      // Relay vào local eventBus để ExecutionTracker + GenTab + TaskList nhận
      // ALSO sync ExecutionLock state để getState() trả về đúng
      if (msg.action === 'execution:lock_broadcast' && msg.state) {
        // Skip self-echo: background relay broadcasts đến cả sender — local eventBus
        // đã emit ngay trong _emitChange rồi, re-emit sẽ làm ExecutionTracker fire 2 lần.
        if (msg._originId && msg._originId === window.ExecutionLock?._contextId) {
          return; // continue to other handlers if any
        }
        console.log('[app.js] Received execution:lock_broadcast:', msg.state);
        // Sync ExecutionLock state
        if (window.ExecutionLock) {
          if (msg.state.locked) {
            ExecutionLock._owner = msg.state.owner;
            ExecutionLock._label = msg.state.label;
            ExecutionLock._lockedAt = msg.state.lockedAt;
          } else {
            ExecutionLock._owner = null;
            ExecutionLock._label = '';
            ExecutionLock._lockedAt = null;
          }
        }
        window.eventBus?.emit('execution:lock_changed', msg.state);
      }
      // execution:tracker_update broadcast from popup windows
      if (msg.action === 'execution:tracker_broadcast' && msg.data) {
        // Skip self-echo (same lý do như execution:lock_broadcast trên)
        if (msg._originId && msg._originId === window.ExecutionLock?._contextId) {
          return;
        }
        console.log('[app.js] Received execution:tracker_broadcast:', msg.data);
        window.eventBus?.emit('execution:tracker_update', msg.data);
      }
      // PromptQueue state broadcast from popup windows (workflow, angles)
      // Cache external jobs để merge với local jobs trong QueueMonitor
      if (msg.action === 'pq:state_broadcast' && msg.snapshot) {
        window._externalQueueSnapshot = msg.snapshot;
        window._externalQueueTimestamp = Date.now();
        window.eventBus?.emit('queue:external_state', msg.snapshot);
      }
    });

    // Update footer + toggles when featuregate refreshes (ensures data is loaded)
    if (window.eventBus) {
      window.eventBus.on('featuregate:refreshed', () => {
        updateFooterUI();
        refreshModuleOverlays();
        updateAutoDownloadToggles();
        updateFeatureGatedToggles();
      });
    }

    // Force refresh featuregate on initial load if logged in
    if (window.authManager?.isLoggedIn() && window.featureGate) {
      window.featureGate.refresh().then(() => {
        updateFooterUI();
      });
    }

    // ─── Realtime Auth Sync ──────────────────────────────
    // Detect logout from Settings window or other contexts via storage change
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;

      // Auth changes
      if (changes.af_auth) {
        const newVal = changes.af_auth.newValue;
        const wasLoggedIn = window.authManager?.isLoggedIn();

        if (!newVal && wasLoggedIn) {
          // Token was removed externally (e.g., logout from settings window or landing page)
          console.log('[TobyFlow] Auth: Phát hiện đăng xuất từ context khác');

          // [Fix #1 — external logout path] Disconnect SSE NGAY để chặn event buffered
          // trong EventSource pipe overwrite entitlements sau khi resetForLogout().
          if (window.SseClient?.disconnect) {
            try {
              window.SseClient.disconnect();
            } catch (e) {
              console.warn('[TobyFlow] Auth: Lỗi disconnect SSE external logout', e.message);
            }
          }

          // CRITICAL: Lấy old token từ storage change và gọi sse/end-session TRƯỚC khi clear local state
          // Vì external logout (landing page) đã gọi auth/logout → token đã bị invalidate trên server
          // Nhưng SSE session vẫn còn trong Redis, cần xóa nó
          const oldToken = changes.af_auth.oldValue?.token;
          if (oldToken) {
            console.log('[TobyFlow] Auth: Gọi sse/end-session với old token...');
            // Gọi trực tiếp qua background.js với old token (không qua authManager vì sẽ dùng token mới = null)
            chrome.runtime.sendMessage({
              action: 'apiRequest',
              method: 'POST',
              endpoint: 'sse/end-session',
              data: null,
              token: oldToken
            }, (response) => {
              if (chrome.runtime.lastError) {
                console.warn('[TobyFlow] Auth: Lỗi gọi sse/end-session:', chrome.runtime.lastError.message);
              } else if (response?.success) {
                console.log('[TobyFlow] Auth: SSE session đã được xóa thành công');
              } else {
                // 401 là bình thường nếu token đã bị invalidate bởi auth/logout
                console.warn('[TobyFlow] Auth: sse/end-session thất bại (có thể token đã hết hạn):', response?.error?.message);
              }
            });
          }

          window.authManager.token = null;
          window.authManager.user = null;
          if (window.storageManager) {
            window.storageManager.switchToLocal();
          }

          // CRITICAL: Reset FeatureGate TRƯỚC khi updateAuthUI và refresh overlays
          // Để UI (footer, overlay) hiển thị đúng trial entitlements thay vì logged-in user's data
          (async () => {
            if (window.featureGate) {
              try {
                await window.featureGate.resetForLogout();
                console.log('[TobyFlow] Auth: FeatureGate reset sau external logout');
              } catch (err) {
                console.warn('[TobyFlow] Auth: Lỗi reset FeatureGate:', err.message);
              }
            }
            // Update UI SAU khi featureGate đã reset để footer/overlay hiển thị đúng
            updateAuthUI();
            refreshModuleOverlays();
            if (window.eventBus) {
              window.eventBus.emit('auth:logout', { reason: 'external_logout' });
            }
          })();
        } else if (newVal?.token && !wasLoggedIn) {
          // Token was added externally (e.g., login from another context like Google OAuth)
          // Skip nếu message handler đang xử lý hoặc đã xử lý xong cùng login event
          if (window._oauthLoginProcessing) {
            console.log('[TobyFlow] Auth: Skip storage handler, message handler đang xử lý');
            return;
          }
          // Check nếu token đã được set bởi message handler (chạy trước storage handler)
          if (window.authManager?.token === newVal.token) {
            console.log('[TobyFlow] Auth: Skip storage handler, token đã được set');
            return;
          }
          console.log('[TobyFlow] Auth: Phát hiện đăng nhập từ context khác');
          window.authManager.token = newVal.token;
          window.authManager.user = newVal.user;
          // [Fix re-login] Reset cascade-block flags từ logout/refresh-fail trước đó.
          // Tránh _apiCall non-auth bị reject UNAUTHENTICATED dù đã có token mới.
          window.authManager._sessionInvalid = false;
          window.authManager._rateLimitedUntil = 0;

          // Close login overlay (CRITICAL for OAuth flow)
          if (loginOverlay) loginOverlay.classList.add('hidden');

          // Update UI
          updateAuthUI();
          setupOnboarding();

          // Refresh FeatureGate TRƯỚC rồi mới refreshModuleOverlays và emit auth:login
          // CRITICAL: Dùng resetForLogin() thay vì refresh() để tránh race condition
          // với background init refresh (đang fetch trial data)
          (async () => {
            // Switch to API storage FIRST (must await to avoid race condition)
            if (window.storageManager) {
              await window.storageManager.switchToApi();
              console.log('[TobyFlow] Storage: Switched to API mode');
            }

            if (window.featureGate) {
              try {
                await window.featureGate.resetForLogin();
                console.log('[TobyFlow] Storage: Entitlements refreshed sau login');
              } catch (e) {
                console.warn('[TobyFlow] Storage: Không thể refresh entitlements', e);
              }
            }

            refreshModuleOverlays();

            // Fetch full user info
            window.authManager.fetchUser().then(() => {
              updateAuthUI();
              checkEmailVerification();
            }).catch(() => {});

            // Emit auth event (triggers SSE connect, etc.)
            if (window.eventBus) {
              window.eventBus.emit('auth:login', { user: newVal.user });
            }
          })();
        }
      }

      // Task/Workflow changes from other contexts (popup editor window)
      if (changes.af_tasks || changes.af_workflows) {
        updateTrialFooterBars();
        updateFooterUsageBars();
        refreshModuleOverlays();
      }

      // Entitlements changes - background SW đã fetch và save → reload vào memory + refresh UI
      if (changes.af_entitlements) {
        const newCache = changes.af_entitlements.newValue;

        // CRITICAL: Nếu cache bị XÓA (newValue = undefined), KHÔNG update UI ở đây
        // vì logout flow đang chạy async và sẽ tự update UI sau khi resetForLogout() xong.
        // Nếu update UI lúc này, featureGate có thể chưa reset → hiển thị sai.
        if (!newCache) {
          console.log('[TobyFlow] Entitlements removed (logout), skip UI update here');
          return;
        }

        console.log('[TobyFlow] Entitlements changed, reload memory + refresh overlays');
        if (window.featureGate) {
          // CRITICAL: Validate cache user_id match với current auth state
          // Tránh load data của user khác (race condition khi logout/login)
          // ALSO: Anonymous user cache phải có plan.slug === 'trial' (giống _loadCache validation)
          const currentUserId = window.authManager?.user?.id || null;
          const cacheUserId = newCache.user_id || null;
          const cachePlanSlug = newCache.plan?.slug;

          let isValidCache = false;
          if (currentUserId) {
            // Logged-in: cache phải của đúng user
            isValidCache = cacheUserId === currentUserId;
          } else {
            // Anonymous: cache phải có user_id=null VÀ plan=trial
            isValidCache = cacheUserId === null && cachePlanSlug === 'trial';
          }

          if (!isValidCache) {
            console.log('[TobyFlow] Entitlements: Skip reload, invalid cache', 'cacheUserId:', cacheUserId, 'currentUserId:', currentUserId, 'cachePlan:', cachePlanSlug);
          } else {
            // Reload vào FeatureGate memory để checkQuota/isModuleEnabled đọc data mới
            if (newCache.entitlements) window.featureGate.entitlements = newCache.entitlements;
            if (newCache.plan !== undefined) window.featureGate.plan = newCache.plan;
            if (newCache.lastFetch) window.featureGate.lastFetch = newCache.lastFetch;
            // Emit event để các components khác re-render
            if (window.eventBus) {
              window.eventBus.emit('featuregate:refreshed', {
                plan: newCache.plan,
                entitlements: newCache.entitlements,
                source: 'background-fetch',
              });
            }
          }
        }
        refreshModuleOverlays();
        updateFooterUI();
      }
    });

    // Refresh permissions from server
    async function refreshPermissions(source = 'unknown') {
      if (!window.authManager?.isLoggedIn()) return false;

      // [Fix B] Skip nếu đang logout hoặc đã có refresh đang chạy
      if (window.featureGate?._isLoggingOut || window.featureGate?._refreshPending) {
        console.log(`[TobyFlow] refreshPermissions skip (${source}) — đang logout hoặc đã có refresh`);
        return false;
      }

      console.log(`[TobyFlow] Refreshing permissions (${source}) — delegate ConfigVersionPoller for config/entitlements + fetchUser for profile`);
      try {
        // [Phase 5 2026-05-24] Delegate entitlements + module configs to ConfigVersionPoller.
        // Poller checks /config/versions (~200B), diff cached versions, force refresh chỉ modules
        // có mismatch. Replace previous: skip-when-SSE-connected + force refresh full /entitlements.
        // CRITICAL: vẫn fetchUser() riêng — backend KHÔNG có SSE event user_updated → name/avatar/locale stale.
        // 'sse_reconnect'/'plan_change'/'manual'/'login' bypass version cache (version có thể vừa bump).
        const isExplicitAction = ['plan_change', 'manual', 'login', 'sse_reconnect'].includes(source);
        await Promise.all([
          window.authManager.fetchUser(),
          window.ConfigVersionPoller?.checkAndRefresh?.({ trigger: source })
            // Fallback: nếu ConfigVersionPoller chưa load (race rare) → fall back to FeatureGate.refresh
            ?? (isExplicitAction ? window.featureGate?.refresh?.({ force: true }) : window.featureGate?.refresh?.()),
        ]);

        // Update UI with new data
        updateAuthUI();

        const plan = window.featureGate?.getPlan?.();
        console.log(`[TobyFlow] Permissions refreshed: plan=${plan?.slug || 'unknown'}`);
        return true;
      } catch (err) {
        console.warn('[TobyFlow] Refresh failed:', err.message);
        return false;
      }
    }

    // [Phase 5 2026-05-24 Polish 2] Removed 2-phút setInterval periodic refresh.
    // ConfigVersionPoller._adjustPollingCadence() đã handle SSE-down case (poll mỗi 5 phút
    // khi disconnected) — coverage tốt hơn 2 phút interval cũ + chỉ fetch 200B versions
    // thay vì full entitlements + user fetch mỗi 2 phút.

    // Focus sync: refresh when user returns to extension
    let lastRefreshTime = 0; // Start at 0 so first focus triggers refresh
    // [Audit fix 2026-05-24] Cooldown 10s → 60s — focus refresh spam giảm 6x.
    // SSE đã handle realtime nên focus refresh chỉ là fallback khi SSE down.
    // 60s đủ nhanh để bắt mọi state change nếu SSE thực sự broken.
    const REFRESH_COOLDOWN = 60000; // 60s cooldown

    document.addEventListener('visibilitychange', async () => {
      // SSE giữ kết nối liên tục (chỉ disconnect khi logout)
      // Không disconnect/reconnect theo visibility để tránh session_replaced liên tục
      if (document.hidden) return;

      // Reconnect nếu bị mất kết nối (lỗi mạng, server restart) — reset backoff
      if (window.authManager?.isLoggedIn() && window.SseClient && !window.SseClient.isConnected()) {
        window.SseClient.forceReconnect();
      }
      // (tiếp tục logic refresh cũ bên dưới)

      const now = Date.now();
      if (now - lastRefreshTime < REFRESH_COOLDOWN) return;
      lastRefreshTime = now;

      // [Fix B] Skip refresh nếu đang logout hoặc đã có refresh đang chạy
      // → tránh race với resetForLogout/resetForLogin → 2 /entitlements concurrent
      if (window.featureGate?._isLoggingOut || window.featureGate?._refreshPending) {
        console.log('[TobyFlow] visibilitychange skip refresh — đang logout hoặc đã có refresh');
        return;
      }

      // Login user: refresh FeatureGate
      if (window.authManager?.isLoggedIn()) {
        await refreshPermissions('focus');
      } else {
        // Not login user: refresh FeatureGate (trial config)
        if (window.featureGate) {
          console.log('[TobyFlow] Refreshing FeatureGate trial config (focus)...');
          await window.featureGate.refresh();
          updateTrialFooterBars();
          refreshModuleOverlays();
        }
      }
    });

    // Also listen for window focus (sidePanel may not trigger visibilitychange)
    window.addEventListener('focus', async () => {
      // R-2.2: SSE reconnect khi focus + đã đăng nhập — reset backoff
      if (window.authManager?.isLoggedIn() && window.SseClient && !window.SseClient.isConnected()) {
        console.log('[SSE] Window focus + đã đăng nhập → kết nối SSE');
        window.SseClient.forceReconnect();
      }

      const now = Date.now();
      if (now - lastRefreshTime < REFRESH_COOLDOWN) return;
      lastRefreshTime = now;

      // [Fix B] Skip refresh nếu đang trong logout flow hoặc đã có refresh đang chạy.
      // Tránh race với resetForLogout/resetForLogin → 2 /entitlements concurrent.
      if (window.featureGate?._isLoggingOut || window.featureGate?._refreshPending) {
        console.log('[TobyFlow] window-focus skip refresh — đang logout hoặc đã có refresh');
        return;
      }

      // Login user: refresh FeatureGate
      if (window.authManager?.isLoggedIn()) {
        await refreshPermissions('window-focus');
      } else {
        // Not login user: refresh FeatureGate (trial config)
        if (window.featureGate) {
          console.log('[TobyFlow] Refreshing FeatureGate trial config (window-focus)...');
          await window.featureGate.refresh();
          updateTrialFooterBars();
          refreshModuleOverlays();
        }
      }
    });

    // Periodic refresh for not-login users (FeatureGate trial config, fallback khi SSE không hoạt động)
    setInterval(async () => {
      // [Fix B] Guard tương tự cho periodic interval
      if (window.featureGate?._isLoggingOut || window.featureGate?._refreshPending) return;
      if (!window.authManager?.isLoggedIn() && window.featureGate && !window.SseClient?.isConnected()) {
        console.log('[TobyFlow] Refreshing FeatureGate trial config (interval)...');
        await window.featureGate.refresh();
        updateTrialFooterBars();
        refreshModuleOverlays();
      }
    }, 120000); // 2 minutes
  }

  // ─── Usage Dashboard Widget ──────────────────────────────
  async function updateUsageDashboard() {
    const container = document.getElementById('usageDashboardContent');
    if (!container || !window.featureGate || !window.authManager?.isLoggedIn()) return;

    try {
      const promptsQuota = window.featureGate.checkQuota('gen_run_max');
      const tasksQuota = window.featureGate.checkQuota('tasks_max');
      const plan = window.featureGate.getPlan();

      container.innerHTML = `
        <div class="usage-item">
          <span class="usage-label">${window.I18n?.t('app.promptsToday') || 'Prompts hôm nay'}</span>
          <span class="usage-value">${promptsQuota.used || 0}/${promptsQuota.limit === 'unlimited' ? '∞' : promptsQuota.limit || '—'}</span>
          ${promptsQuota.limit !== 'unlimited' ? `<div class="usage-bar"><div class="usage-bar-fill" style="width: ${Math.min(100, ((promptsQuota.used || 0) / (promptsQuota.limit || 1)) * 100)}%"></div></div>` : ''}
        </div>
        <div class="usage-item">
          <span class="usage-label">Tasks</span>
          <span class="usage-value">${tasksQuota.used || 0}/${tasksQuota.limit === 'unlimited' ? '∞' : tasksQuota.limit || '—'}</span>
        </div>
        <div class="usage-plan">
          <span class="usage-plan-badge ${(plan?.slug === 'unlimited' || plan?.slug === 'premium' || plan?.slug === 'autoflow-pro' || plan?.slug === 'autogrok-pro' || plan?.slug === 'pro') ? 'plan-unlimited' : 'plan-free'}">${plan?.name || 'Free'}</span>
        </div>
      `;
    } catch (e) {
      log('Usage dashboard update failed:', e.message);
    }
  }

  // ─── Upgrade UI ──────────────────────────────────────────

  // Extension scope: 'flow' for Toby Flow, 'grok' for AutoGrok
  const EXTENSION_SCOPE = 'flow';

  // Fetch plans từ API mỗi lần (không cache, luôn lấy data mới nhất)
  // Filter by extension scope để chỉ hiển thị plans phù hợp với extension này
  async function fetchPlans() {
    try {
      const response = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({
          action: 'apiRequest',
          method: 'GET',
          // include_internal=1 để response có cả 'free' plan → crown logic
          // quyết định "Yêu cầu login" (free có quyền) vs "Premium" (free không có).
          endpoint: `plans?extension=${EXTENSION_SCOPE}&include_internal=1`
        }, (resp) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (resp?.success && resp?.data) {
            resolve(resp.data);
          } else {
            reject(new Error(resp?.error?.message || resp?.error || 'Không lấy được danh sách gói'));
          }
        });
      });
      return response;
    } catch (e) {
      console.warn('[TobyFlow] Fetch plans failed:', e.message);
      return null;
    }
  }

  // Cache active payment providers
  async function fetchActiveProviders() {
    try {
      return await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({
          action: 'apiRequest',
          method: 'GET',
          endpoint: 'payment-settings/providers'
        }, (resp) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (resp?.success && resp?.data) {
            resolve(resp.data.providers || []);
          } else {
            reject(new Error(resp?.error?.message || 'Không lấy được danh sách phương thức thanh toán'));
          }
        });
      });
    } catch (e) {
      console.warn('[TobyFlow] Fetch active providers failed:', e.message);
      return null;
    }
  }

  // Store selected plan and billing cycle for checkout
  let selectedPlanId = null;
  let selectedBillingCycle = 'monthly';

  // [Upgrade Prorated 2026-05-31] State cho flow upgrade
  // _isUpgradeMode true khi user đã có plan trả phí (không phải trial/free) — UI hiển thị
  // section "Gói hiện tại", lọc downgrade, fetch quote async khi đổi plan/cycle.
  let _currentUpgradeQuote = null; // {from_plan, to_plan, credit, final_amount, ...}
  let _lastQuoteKey = null; // Cache key "${planId}|${cycle}|${currency}" — đã settled render

  // [Upgrade Prorated 2026-05-31] SVG icon map cho upgrade UI — đồng bộ Feather style với
  // pattern existing trong app.js (viewBox 24, stroke 2). Thay thế emojis 📦💰💳✨⚠️ℹ️⏳
  // để icon scale + theme color chuẩn (currentColor inherit từ context).
  const _UPGRADE_ICONS = {
    package: '<svg class="upgrade-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path><polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline><line x1="12" y1="22.08" x2="12" y2="12"></line></svg>',
    credit: '<svg class="upgrade-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8"></path><path d="M12 18V6"></path></svg>',
    card: '<svg class="upgrade-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"></rect><line x1="2" y1="10" x2="22" y2="10"></line></svg>',
    sparkles: '<svg class="upgrade-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5z"></path><path d="M19 14l.5 1.5L21 16l-1.5.5L19 18l-.5-1.5L17 16l1.5-.5z"></path></svg>',
    warning: '<svg class="upgrade-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>',
    info: '<svg class="upgrade-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>',
    spinner: '<svg class="upgrade-icon upgrade-icon-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="2" x2="12" y2="6"></line><line x1="12" y1="18" x2="12" y2="22"></line><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"></line><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"></line><line x1="2" y1="12" x2="6" y2="12"></line><line x1="18" y1="12" x2="22" y2="12"></line><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"></line><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"></line></svg>',
  };

  // [Upgrade Prorated 2026-05-31] i18n locale → BCP-47 cho toLocaleDateString.
  // Trước fix: chỉ vi='vi-VN', else='en-US' → ja/th user thấy date format en-US (sai i18n).
  function _upgradeDateLocale() {
    const loc = (window.I18n?.getLocale?.() || 'vi').toLowerCase();
    return { vi: 'vi-VN', en: 'en-US', ja: 'ja-JP', th: 'th-TH' }[loc] || 'en-US';
  }

  // Fetch quote upgrade từ backend. Trả null nếu user free/trial/expired (credit=0)
  // hoặc nếu error (downgrade_not_supported/use_renewal_flow).
  async function fetchUpgradeQuote(planId, billingCycle, currency) {
    try {
      console.log('[Upgrade Quote] Request:', { planId, billingCycle, currency });
      const resp = await window.authManager._apiCall('POST', 'orders/upgrade-quote', {
        plan_id: planId,
        billing_cycle: billingCycle,
        currency: currency,
      });
      console.log('[Upgrade Quote] Response:', resp);
      // Backend trả { success, data: {from_plan, to_plan, credit, final_amount, ...} }
      // authManager._apiCall thường unwrap.data → resp = data trực tiếp.
      const quote = resp?.from_plan !== undefined ? resp : (resp?.data || null);
      console.log('[Upgrade Quote] Parsed quote:', quote);
      return quote;
    } catch (e) {
      console.warn('[Upgrade Quote] Error:', e?.error?.code || e.message, e);
      return { _error_code: e?.error?.code || e?.code || 'QUOTE_FAILED', _error_message: e.message };
    }
  }

  function renderUpgradeModal(plans) {
    const container = document.getElementById('upgradePlansContainer');
    if (!container || !plans) return;

    // [Upgrade Prorated 2026-05-31] Detect context "upgrade" vs "mua mới":
    //  - User đã có plan trả phí (KHÔNG phải trial/free/null) → upgrade mode:
    //      + Hiển thị section "Gói hiện tại + còn N ngày"
    //      + Lọc downgrade plans (display_order thấp hơn)
    //      + Lọc cycles thấp hơn nếu cùng plan
    //      + Fetch quote async + render breakdown credit khi hợp lệ
    //  - User trial/free/expired → flow CŨ (mua mới, không credit)
    const user = window.authManager?.getUser();
    const userPlanSlug = user?.plan_slug;
    const userPlanCycle = user?.plan_billing_cycle;
    const userExpiresAtIso = user?.plan_expires_at;
    const userExpiresAt = userExpiresAtIso ? new Date(userExpiresAtIso) : null;
    const isPlanExpired = userExpiresAt && userExpiresAt.getTime() < Date.now();
    const isLifetime = userPlanCycle === 'lifetime' || (userPlanSlug && !['trial', 'free'].includes(userPlanSlug) && !userExpiresAtIso);
    const isUpgradeMode = !!(userPlanSlug && !['trial', 'free'].includes(userPlanSlug) && !isPlanExpired && !isLifetime);
    const currentPlanInfo = isUpgradeMode ? plans.find(p => p.slug === userPlanSlug) : null;

    // Filter non-free/non-trial plans (giữ lại plan user đang dùng để có thể gia hạn).
    // Trong upgrade mode: lọc thêm downgrade — chỉ giữ plan có display_order >= current
    // (cùng plan slug OK để cho phép upgrade cycle Monthly→Yearly→Lifetime).
    let premiumPlans = plans.filter(p => p.slug !== 'free' && p.slug !== 'trial');
    if (isUpgradeMode && currentPlanInfo) {
      const currentOrder = currentPlanInfo.display_order ?? 0;
      premiumPlans = premiumPlans.filter(p =>
        p.slug === currentPlanInfo.slug || (p.display_order ?? 0) >= currentOrder
      );
    }
    if (!premiumPlans.length) return;

    // Default to first plan
    if (!selectedPlanId) {
      selectedPlanId = premiumPlans[0].id;
    }

    // Find default billing cycle for the selected plan
    const selectedPlan = premiumPlans.find(p => p.id === selectedPlanId) || premiumPlans[0];
    selectedPlanId = selectedPlan.id;

    // Determine available cycles for the selected plan
    const t = (key, fallback) => window.I18n?.t(key) || fallback;
    // [Feature: IP Geolocation 2026-05-23] Render giá theo currency từ LocationCache.
    // VND user → đọc price_monthly/yearly/lifetime, USD user → đọc price_usd_*.
    const currency = window.LocationCache?.getCurrency?.() || 'VND';
    const priceKey = (cycle) => currency === 'USD' ? `price_usd_${cycle}` : `price_${cycle}`;
    let availableCycles = [];
    const priceMonthly = selectedPlan[priceKey('monthly')];
    const priceYearly = selectedPlan[priceKey('yearly')];
    const priceLifetime = selectedPlan[priceKey('lifetime')];
    if (priceMonthly != null) availableCycles.push({ key: 'monthly', label: t('dialog.month', 'Tháng'), price: priceMonthly });
    if (priceYearly != null) availableCycles.push({ key: 'yearly', label: t('dialog.year', 'Năm'), price: priceYearly });
    if (priceLifetime != null) availableCycles.push({ key: 'lifetime', label: t('dialog.upgradeLifetime', 'Trọn đời'), price: priceLifetime });

    // [Upgrade Prorated 2026-05-31 Audit fix] Trong upgrade mode + cùng plan: GIỮ TẤT CẢ cycles
    // (bao gồm cycle hiện tại) để user có thể RENEW cùng plan/cycle. Trước fix: filter cycle cao
    // hơn current → active user không có cách renew Pro Yearly (chỉ thấy Lifetime).
    // Khi user chọn cycle cùng current → backend ProrationCalculator throw 'use_renewal_flow' →
    // UI render info box "Đây là gia hạn cùng gói" + handlePayment submit KHÔNG is_upgrade flag
    // → markAsPaid cộng dồn behavior cũ. Cycle cao hơn → bình thường tính credit prorated.

    // Ensure selected cycle is valid for this plan
    if (!availableCycles.find(c => c.key === selectedBillingCycle)) {
      selectedBillingCycle = availableCycles[0]?.key || 'monthly';
    }

    const currentCycle = availableCycles.find(c => c.key === selectedBillingCycle) || availableCycles[0];
    const currentPrice = (currentCycle?.price || 0);

    const cycleNoteMap = {
      'monthly': t('dialog.perMonth', 'mỗi tháng'),
      'yearly': t('dialog.perYear', 'mỗi năm'),
      'lifetime': t('dialog.lifetimeDesc', 'Mua 1 lần, dùng mãi mãi')
    };

    // Show up to 6 features with truthy display values
    const displayFeatures = (selectedPlan.features || [])
      .filter(f => f.display)
      .slice(0, 6);

    let html = '';

    // [Upgrade Prorated 2026-05-31] Build "Gói hiện tại" card HTML — render LAST ở bottom modal
    // (move xuống cuối theo user request). Variable, append sau breakdown container.
    let currentPlanCardHtml = '';
    if (isUpgradeMode && currentPlanInfo) {
      const _msPerDay = 86400000;
      const remainingDays = userExpiresAt ? Math.max(0, Math.ceil((userExpiresAt.getTime() - Date.now()) / _msPerDay)) : 0;
      const cycleLabelMap = {
        monthly: t('upgrade.cycleMonthlyShort', 'Hàng tháng'),
        yearly: t('upgrade.cycleYearlyShort', 'Hàng năm'),
        lifetime: t('upgrade.cycleLifetimeShort', 'Trọn đời'),
      };
      const cycleLabel = cycleLabelMap[userPlanCycle] || userPlanCycle || '';
      const expiresFmt = userExpiresAt
        ? userExpiresAt.toLocaleDateString(_upgradeDateLocale(), { day: '2-digit', month: '2-digit', year: 'numeric' })
        : '—';
      currentPlanCardHtml = `
        <div class="upgrade-current-plan-card">
          <div class="upgrade-current-plan-label">${_UPGRADE_ICONS.package}${t('upgrade.currentPlanLabel', 'Gói hiện tại')}</div>
          <div class="upgrade-current-plan-name">${currentPlanInfo.name}${cycleLabel ? ` <span class="upgrade-current-plan-cycle">(${cycleLabel})</span>` : ''}</div>
          <div class="upgrade-current-plan-expires">
            ${t('upgrade.expiresAtLabel', 'Hết hạn')}: <strong>${expiresFmt}</strong>
            · ${t('upgrade.remainingDays', 'còn {{days}} ngày').replace('{{days}}', String(remainingDays))}
          </div>
        </div>
      `;
    }

    // Plan cards (if multiple plans)
    if (premiumPlans.length > 1) {
      html += '<div class="upgrade-plan-selector">';
      premiumPlans.forEach(plan => {
        const isActive = plan.id === selectedPlanId;
        const isCurrentPlan = plan.slug === userPlanSlug;
        html += `
          <button class="upgrade-plan-tab ${isActive ? 'active' : ''} ${isCurrentPlan ? 'current-plan' : ''}" data-plan-id="${plan.id}">
            ${plan.name}${isCurrentPlan ? ' <span class="current-badge">' + t('dialog.currentPlan', 'Đang dùng') + '</span>' : ''}
          </button>`;
      });
      html += '</div>';
    }

    // Plan card
    const isSelectedCurrentPlan = selectedPlan.slug === userPlanSlug;
    html += `
      <div class="upgrade-plan-card" data-plan-id="${selectedPlan.id}">
        <div class="upgrade-plan-name">
          ${selectedPlan.name}
          ${isSelectedCurrentPlan ? '<span class="current-plan-badge">' + t('dialog.currentPlan', 'Đang dùng') + '</span>' : ''}
        </div>`;

    // Billing cycle pills (if more than 1 cycle)
    if (availableCycles.length > 1) {
      html += '<div class="upgrade-cycle-pills">';
      availableCycles.forEach(cycle => {
        const isActive = cycle.key === selectedBillingCycle;
        html += `<button class="cycle-pill ${isActive ? 'active' : ''}" data-cycle="${cycle.key}">${cycle.label}</button>`;
      });
      html += '</div>';
    }

    // [Feature: IP Geolocation 2026-05-23] Currency-aware price formatting.
    // VND: "1.500.000 \u0111" | USD: "$59.99"
    const priceFormatted = currency === 'USD'
      ? '$' + Number(currentPrice).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : (window.I18n?.formatNumber?.(currentPrice) || Number(currentPrice).toLocaleString()) + ' \u0111';

    // Currency toggle dropdown \u2014 g\u00f3c tr\u00ean-ph\u1ea3i plan card
    const toggleHtml = `
      <div class="upgrade-currency-toggle" title="${t('upgrade.currencyToggleHint', '\u0110\u1ed5i \u0111\u01a1n v\u1ecb ti\u1ec1n')}">
        <button class="currency-pill ${currency === 'VND' ? 'active' : ''}" data-currency="VND">VND</button>
        <button class="currency-pill ${currency === 'USD' ? 'active' : ''}" data-currency="USD">USD</button>
      </div>`;

    html += `
        <div class="upgrade-price-row">
          <div class="upgrade-price">${priceFormatted}</div>
          ${toggleHtml}
        </div>
        <div class="upgrade-price-note">${cycleNoteMap[selectedBillingCycle] || ''}</div>`;

    if (selectedPlan.content) {
      // Custom content từ admin — dùng PlanContentRenderer để render JSON
      const renderedContent = window.PlanContentRenderer
        ? window.PlanContentRenderer.render(selectedPlan.content, { variant: 'dark' })
        : selectedPlan.content;

      html += `
        <div class="upgrade-plan-content">${renderedContent}</div>
      </div>
      `;
    } else {
      // Fallback: hiển thị feature list mặc định
      html += `
        <ul class="upgrade-feature-list">
          ${displayFeatures.map(f => `
            <li class="upgrade-feature-item">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>
              ${f.name}: <strong>${f.display}</strong>
            </li>
          `).join('')}
        </ul>
      </div>
      `;
    }

    // [Upgrade Prorated 2026-05-31] Placeholder div cho breakdown card — fetch async sau
    // render (tránh block UI). Reuse div này khi user đổi plan/cycle.
    if (isUpgradeMode) {
      html += '<div id="upgradeBreakdownContainer" class="upgrade-breakdown-container"></div>';
    }

    // 2026-05-31: append "Gói hiện tại" card xuống BOTTOM modal (user request).
    html += currentPlanCardHtml;

    container.innerHTML = html;

    // Bind plan tab clicks
    container.querySelectorAll('.upgrade-plan-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        selectedPlanId = parseInt(btn.dataset.planId, 10);
        _currentUpgradeQuote = null; // Invalidate quote khi đổi plan
        _lastQuoteKey = null;
        renderUpgradeModal(plans);
      });
    });

    // Bind cycle pill clicks
    container.querySelectorAll('.cycle-pill').forEach(btn => {
      btn.addEventListener('click', () => {
        selectedBillingCycle = btn.dataset.cycle;
        _currentUpgradeQuote = null; // Invalidate quote khi đổi cycle
        _lastQuoteKey = null;
        renderUpgradeModal(plans);
      });
    });

    // [Feature: IP Geolocation 2026-05-23] Bind currency toggle.
    // Click → save vào LocationCache (persist af_settings.preferred_currency) → re-render.
    container.querySelectorAll('.currency-pill').forEach(btn => {
      btn.addEventListener('click', async () => {
        const newCurrency = btn.dataset.currency;
        if (window.LocationCache?.setPreferredCurrency) {
          await window.LocationCache.setPreferredCurrency(newCurrency);
        }
        _currentUpgradeQuote = null; // Invalidate quote khi đổi currency
        _lastQuoteKey = null;
        renderUpgradeModal(plans);
      });
    });

    // [Upgrade Prorated 2026-05-31] Async fetch + render breakdown card
    // Chỉ chạy nếu upgrade mode + có availableCycles (tránh empty pills sau filter)
    if (isUpgradeMode && availableCycles.length > 0) {
      const quoteKey = `${selectedPlanId}|${selectedBillingCycle}|${currency}`;
      // Render loading state ngay (UI responsive) trong khi fetch
      const breakdownEl = container.querySelector('#upgradeBreakdownContainer');
      if (breakdownEl && _lastQuoteKey !== quoteKey) {
        breakdownEl.innerHTML = `<div class="upgrade-breakdown-loading">${_UPGRADE_ICONS.spinner}${t('upgrade.calculating', 'Đang tính credit...')}</div>`;
      }
      // Skip nếu đã settle key này rồi (đã có render đúng)
      if (_lastQuoteKey === quoteKey) return;

      // Audit fix 2026-05-31: Bỏ guard _quoteFetchInFlight vì gây race —
      // user click cycle A → fetch A start → click cycle B (rapid) → fetch B bị skip →
      // fetch A complete → render breakdown A trong UI B. Allow concurrent fetches,
      // discard stale result bằng key compare sau fetch.
      const myKey = quoteKey;
      (async () => {
        const quote = await fetchUpgradeQuote(selectedPlanId, selectedBillingCycle, currency);
        // Check user vẫn còn ở selection cũ không (snapshot tại completion time)
        const currentCurrency = (window.LocationCache?.getCurrency?.() || 'VND');
        const currentKey = `${selectedPlanId}|${selectedBillingCycle}|${currentCurrency}`;
        if (currentKey !== myKey) {
          // User đã chuyển sang plan/cycle/currency khác → discard quote stale
          return;
        }
        if (_lastQuoteKey === myKey) {
          // Race khác đã render xong key này → tránh double render
          return;
        }
        _lastQuoteKey = myKey;
        _currentUpgradeQuote = quote;
        _renderUpgradeBreakdown(quote, currentCurrency);
      })();
    }
  }

  // [Upgrade Prorated 2026-05-31] Render breakdown card với credit calculation.
  // Quote response shape: {from_plan, to_plan, credit, final_amount, currency, new_expires_at, savings_percent}
  // Hoặc {_error_code, _error_message} nếu backend trả 422 (vd 'use_renewal_flow', 'downgrade_not_supported')
  function _renderUpgradeBreakdown(quote, currency) {
    const el = document.getElementById('upgradeBreakdownContainer');
    if (!el) return;
    const t = (key, fallback) => window.I18n?.t(key) || fallback;

    // Error cases — UI giải thích cho user
    if (quote?._error_code) {
      const code = quote._error_code;
      if (code === 'PRORATION_USE_RENEWAL_FLOW' || code === 'use_renewal_flow') {
        // Cùng plan + cùng cycle → user đang gia hạn, không phải upgrade
        el.innerHTML = `
          <div class="upgrade-breakdown-info">
            ${_UPGRADE_ICONS.info}${t('upgrade.renewalNotice', 'Đây là gia hạn cùng gói. Nhấn nút thanh toán bên dưới để gia hạn (cộng dồn thời gian).')}
          </div>`;
      } else if (code === 'PRORATION_DOWNGRADE_NOT_SUPPORTED' || code === 'downgrade_not_supported') {
        el.innerHTML = `<div class="upgrade-breakdown-error">${_UPGRADE_ICONS.warning}${t('upgrade.errorDowngrade', 'Không hỗ trợ hạ cấp gói')}</div>`;
      } else if (code === 'PRORATION_LIFETIME_CANNOT_UPGRADE' || code === 'lifetime_cannot_upgrade') {
        el.innerHTML = `<div class="upgrade-breakdown-error">${_UPGRADE_ICONS.info}${t('upgrade.errorLifetimeCannot', 'Gói trọn đời không thể nâng cấp')}</div>`;
      } else {
        // Soft fallback — không render gì, để user vẫn mua được như flow cũ
        el.innerHTML = '';
      }
      return;
    }

    // Credit=0 → user là free/trial/expired hoặc lý do khác → không render breakdown (giữ flow cũ)
    if (!quote || !quote.credit || quote.credit <= 0) {
      el.innerHTML = '';
      return;
    }

    const fmt = (n) => {
      if (currency === 'USD') return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      return (window.I18n?.formatNumber?.(n) || Number(n).toLocaleString()) + ' đ';
    };

    const fromName = quote.from_plan?.name || quote.from_plan?.slug || '';
    const newExpiresFmt = quote.new_expires_at
      ? new Date(quote.new_expires_at).toLocaleDateString(_upgradeDateLocale(), { day: '2-digit', month: '2-digit', year: 'numeric' })
      : '—';
    // [i18n fix 2026-05-31] Cycle tag localized — trước fix hiển thị raw 'yearly'/'monthly'/'lifetime'
    const _cycleLabels = {
      monthly: t('upgrade.cycleMonthlyShort', 'Hàng tháng'),
      yearly: t('upgrade.cycleYearlyShort', 'Hàng năm'),
      lifetime: t('upgrade.cycleLifetimeShort', 'Trọn đời'),
    };
    const toCycleLabel = _cycleLabels[quote.to_plan.billing_cycle] || quote.to_plan.billing_cycle;

    el.innerHTML = `
      <div class="upgrade-breakdown-card">
        <div class="upgrade-breakdown-row">
          <span>${quote.to_plan.name} <span class="upgrade-breakdown-cycle-tag">${toCycleLabel}</span></span>
          <span class="upgrade-breakdown-original-price">${fmt(quote.to_plan.price)}</span>
        </div>
        <div class="upgrade-breakdown-row upgrade-breakdown-credit-row">
          <span>${_UPGRADE_ICONS.credit}${t('upgrade.creditFromPlan', 'Credit từ {{plan}}').replace('{{plan}}', fromName)}</span>
          <span class="upgrade-breakdown-credit-amount">-${fmt(quote.credit)}</span>
        </div>
        <div class="upgrade-breakdown-divider"></div>
        <div class="upgrade-breakdown-row upgrade-breakdown-total-row">
          <span>${_UPGRADE_ICONS.card}${t('upgrade.youPay', 'Bạn cần trả')}</span>
          <span class="upgrade-breakdown-final-amount">${fmt(quote.final_amount)}</span>
        </div>
        ${quote.savings_percent > 0 ? `
          <div class="upgrade-breakdown-savings">${_UPGRADE_ICONS.sparkles}${t('upgrade.savingsPercent', 'Tiết kiệm {{pct}}%').replace('{{pct}}', String(quote.savings_percent))}</div>
        ` : ''}
      </div>
      <div class="upgrade-warning-box">
        ${_UPGRADE_ICONS.warning}${t('upgrade.warningCreditConverted', 'Số tiền {{oldPlan}} còn lại ({{amount}}) đã được quy đổi thành credit và trừ vào hóa đơn này. Gói {{oldPlan}} hiện tại sẽ kết thúc khi nâng cấp. Gói mới hết hạn {{newExpiresAt}}.')
          .replace(/\{\{oldPlan\}\}/g, fromName)
          .replace('{{amount}}', fmt(quote.credit))
          .replace('{{newExpiresAt}}', newExpiresFmt)}
      </div>
    `;
  }

  /**
   * Show VietQR payment modal
   * @param {Object} data - API response data with QR info
   */
  function showVietQRModal(data) {
    // Remove existing modal if any
    const existingModal = document.getElementById('vietqrPaymentOverlay');
    if (existingModal) existingModal.remove();

    const bankCode = data.bank_info?.bank || data.bank_code || '';
    const bankName = BANK_NAMES[bankCode] || bankCode;

    const overlay = document.createElement('div');
    overlay.id = 'vietqrPaymentOverlay';
    overlay.className = 'vietqr-payment-overlay';
    overlay.innerHTML = `
      <div class="vietqr-payment-modal">
        <div class="vietqr-payment-header">
          <h3>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="3" y="3" width="18" height="18" rx="2"/>
              <path d="M7 7h.01"/>
              <path d="M17 7h.01"/>
              <path d="M7 17h.01"/>
              <path d="M17 17h.01"/>
            </svg>
            ${window.I18n?.t('upgrade.bankTransfer') || 'Thanh toán chuyển khoản'}
          </h3>
          <button class="vietqr-close-btn" id="vietqrCloseBtn">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>
        <div class="vietqr-payment-body">
          <div class="vietqr-qr-container">
            <img src="${data.qr_url}" alt="QR Code" class="vietqr-qr-image" />
          </div>
          <div class="vietqr-info-section">
            <div class="vietqr-info-row">
              <span class="vietqr-info-label">${window.I18n?.t('upgrade.bankName') || 'Ngân hàng'}</span>
              <span class="vietqr-info-value">${bankName}</span>
            </div>
            <div class="vietqr-info-row">
              <span class="vietqr-info-label">${window.I18n?.t('upgrade.accountNo') || 'Số tài khoản'}</span>
              <span class="vietqr-info-value vietqr-copyable" data-copy="${data.bank_info?.account_no || data.account_no}">
                ${data.bank_info?.account_no || data.account_no}
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                </svg>
              </span>
            </div>
            <div class="vietqr-info-row">
              <span class="vietqr-info-label">${window.I18n?.t('upgrade.accountName') || 'Chủ tài khoản'}</span>
              <span class="vietqr-info-value">${data.bank_info?.account_name || data.account_name}</span>
            </div>
            <div class="vietqr-info-row vietqr-amount-row">
              <span class="vietqr-info-label">${window.I18n?.t('upgrade.amount') || 'Số tiền'}</span>
              <span class="vietqr-info-value vietqr-amount">${window.I18n?.formatNumber?.(data.amount || 0) || (data.amount || 0).toLocaleString()}đ</span>
            </div>
            <div class="vietqr-info-row">
              <span class="vietqr-info-label">${window.I18n?.t('upgrade.transferContent') || 'Nội dung CK'}</span>
              <span class="vietqr-info-value vietqr-copyable vietqr-transfer-content" data-copy="${data.transfer_content}">
                ${data.transfer_content}
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                </svg>
              </span>
            </div>
          </div>
          <div class="vietqr-notice">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"/>
              <path d="M12 16v-4"/>
              <path d="M12 8h.01"/>
            </svg>
            <span>${window.I18n?.t('upgrade.transferNotice') || 'Vui lòng nhập đúng nội dung chuyển khoản để đơn hàng được xử lý tự động.'}</span>
          </div>
          <button class="btn vietqr-confirm-btn" id="vietqrConfirmBtn">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="20 6 9 17 4 12"></polyline>
            </svg>
            ${window.I18n?.t('upgrade.transferred') || 'Đã chuyển khoản'}
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    // Copy functionality
    overlay.querySelectorAll('.vietqr-copyable').forEach(el => {
      el.addEventListener('click', async () => {
        const textToCopy = el.dataset.copy;
        try {
          await navigator.clipboard.writeText(textToCopy);
          el.classList.add('copied');
          setTimeout(() => el.classList.remove('copied'), 1500);
        } catch (e) {
          console.error('[TobyFlow] Copy failed:', e);
        }
      });
    });

    // Payment status polling state
    let pollingInterval = null;
    const POLL_INTERVAL_MS = 10000; // 10 giay
    const POLL_TIMEOUT_MS = 300000; // 5 phut
    const orderId = data.order_id;

    function stopPolling() {
      if (pollingInterval) {
        clearInterval(pollingInterval);
        pollingInterval = null;
      }
    }

    function removeOverlay() {
      stopPolling();
      overlay.remove();
    }

    // Close modal
    const closeBtn = overlay.querySelector('#vietqrCloseBtn');
    closeBtn?.addEventListener('click', () => {
      removeOverlay();
    });

    // Click outside to close
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        removeOverlay();
      }
    });

    // Confirm button — start polling for payment status
    const confirmBtn = overlay.querySelector('#vietqrConfirmBtn');
    confirmBtn?.addEventListener('click', () => {
      // Guard: must be logged in and have order ID
      if (!window.authManager?.isLoggedIn() || !orderId) {
        removeOverlay();
        if (window.customDialog) {
          window.customDialog.alert(
            window.I18n?.t('upgrade.orderReceived') || 'Cảm ơn bạn! Đơn hàng sẽ được xử lý trong vòng 24 giờ sau khi chúng tôi xác nhận thanh toán.',
            { title: window.I18n?.t('upgrade.orderReceivedTitle') || 'Đã ghi nhận', type: 'success' }
          );
        }
        return;
      }

      // Disable button and change text to polling state
      confirmBtn.disabled = true;
      confirmBtn.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="vietqr-spinner">
          <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
        </svg>
        ${window.I18n?.t('app.checking') || 'Đang kiểm tra...'}
      `;
      confirmBtn.style.opacity = '0.7';
      confirmBtn.style.cursor = 'not-allowed';

      const pollStartTime = Date.now();

      async function checkOrderStatus() {
        try {
          const response = await window.authManager._apiCall('GET', `billing/orders/${orderId}/status`);
          const status = response?.data?.status || response?.status;
          if (status === 'paid') {
            // Payment confirmed
            stopPolling();
            removeOverlay();

            if (window.customDialog) {
              window.customDialog.alert(
                window.I18n?.t('upgrade.paymentSuccess') || 'Thanh toán thành công! Gói của bạn đã được kích hoạt.',
                { title: window.I18n?.t('upgrade.paymentSuccessTitle') || 'Thanh toán thành công', type: 'success' }
              );
            }

            // Refresh entitlements to unlock features
            if (window.featureGate?.refreshAsync) {
              try {
                await window.featureGate.refreshAsync();
              } catch (e) {
                console.error('[TobyFlow] Failed to refresh entitlements after payment:', e);
              }
            }
            return;
          }
        } catch (err) {
          console.error('[TobyFlow] Payment status check failed:', err.message);
        }

        // Check timeout (5 minutes)
        if (Date.now() - pollStartTime >= POLL_TIMEOUT_MS) {
          stopPolling();

          // Re-enable button
          confirmBtn.disabled = false;
          confirmBtn.innerHTML = `
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="20 6 9 17 4 12"></polyline>
            </svg>
            ${window.I18n?.t('upgrade.transferred') || 'Đã chuyển khoản'}
          `;
          confirmBtn.style.opacity = '';
          confirmBtn.style.cursor = '';

          if (window.customDialog) {
            window.customDialog.alert(
              window.I18n?.t('upgrade.paymentPending') || 'Chưa nhận được thanh toán. Đơn hàng sẽ được xử lý khi admin xác nhận.',
              { title: window.I18n?.t('upgrade.paymentPendingTitle') || 'Đang chờ xác nhận', type: 'info' }
            );
          }
        }
      }

      // Check immediately, then poll every 10 seconds
      checkOrderStatus();
      pollingInterval = setInterval(checkOrderStatus, POLL_INTERVAL_MS);
    });
  }

  /**
   * Show plan activated overlay - chỉ hiện 1 lần khi order được confirm
   * @param {Object} data - SSE event data with order/plan info
   */
  function showPlanActivatedOverlay(data) {
    // Remove existing overlay if any
    const existingOverlay = document.getElementById('planActivatedOverlay');
    if (existingOverlay) existingOverlay.remove();

    const planName = data.plan_name || data.plan_slug || 'Premium';
    const billingCycleText = {
      'monthly': window.I18n?.t('upgrade.monthly') || 'Tháng',
      'yearly': window.I18n?.t('upgrade.yearly') || 'Năm',
      'lifetime': window.I18n?.t('upgrade.lifetime') || 'Trọn đời',
    }[data.billing_cycle] || data.billing_cycle;

    const overlay = document.createElement('div');
    overlay.id = 'planActivatedOverlay';
    overlay.className = 'plan-activated-overlay';
    overlay.innerHTML = `
      <div class="plan-activated-modal">
        <div class="plan-activated-confetti"></div>
        <div class="plan-activated-icon">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
            <polyline points="22 4 12 14.01 9 11.01"/>
          </svg>
        </div>
        <h2 class="plan-activated-title">
          ${window.I18n?.t('upgrade.activatedTitle') || '🎉 Kích hoạt thành công!'}
        </h2>
        <p class="plan-activated-message">
          ${window.I18n?.t('upgrade.activatedMessage', { plan: planName }) || `Chúc mừng bạn đã nâng cấp lên <strong>${planName}</strong>!`}
        </p>
        <div class="plan-activated-details">
          <div class="plan-activated-detail-row">
            <span class="plan-activated-detail-label">${window.I18n?.t('upgrade.plan') || 'Gói'}</span>
            <span class="plan-activated-detail-value">${planName}</span>
          </div>
          <div class="plan-activated-detail-row">
            <span class="plan-activated-detail-label">${window.I18n?.t('upgrade.cycle') || 'Chu kỳ'}</span>
            <span class="plan-activated-detail-value">${billingCycleText}</span>
          </div>
          ${data.order_invoice_number ? `
          <div class="plan-activated-detail-row">
            <span class="plan-activated-detail-label">${window.I18n?.t('upgrade.orderNo') || 'Mã đơn'}</span>
            <span class="plan-activated-detail-value plan-activated-order-no">${data.order_invoice_number}</span>
          </div>
          ` : ''}
        </div>
        <p class="plan-activated-thanks">
          ${window.I18n?.t('upgrade.thanksMessage') || 'Cảm ơn bạn đã tin tưởng và đồng hành cùng chúng tôi! 💚'}
        </p>
        <button class="btn plan-activated-btn" id="planActivatedCloseBtn">
          ${window.I18n?.t('upgrade.startUsing') || 'Bắt đầu sử dụng'}
        </button>
      </div>
    `;

    document.body.appendChild(overlay);

    // Auto-close after 15 seconds
    const autoCloseTimer = setTimeout(() => {
      overlay.remove();
    }, 15000);

    // Close handlers
    const closeBtn = overlay.querySelector('#planActivatedCloseBtn');
    closeBtn?.addEventListener('click', () => {
      clearTimeout(autoCloseTimer);
      overlay.remove();
    });

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        clearTimeout(autoCloseTimer);
        overlay.remove();
      }
    });

    // Trigger confetti animation
    setTimeout(() => {
      overlay.querySelector('.plan-activated-confetti')?.classList.add('active');
    }, 100);

    console.log('[TobyFlow] Plan activated overlay shown for order:', data.order_id);
  }

  function setupUpgradeUI() {
    const upgradeBtn = document.getElementById('upgradeBtn');
    const upgradeOverlay = document.getElementById('upgradeOverlay');
    const upgradeCloseBtn = document.getElementById('upgradeCloseBtn');
    // Error wrapper đã removed khỏi DOM upgrade modal — error giờ hiện qua sidebar notification (showNotification).
    // Auth errors: thay vì button "Đăng nhập lại" inline, close modal + auto-open login modal.

    // Open upgrade modal and fetch plans
    async function openUpgradeModal() {
      // SS: Guard — không mở nếu admin đã tắt upgrade prompts
      if (window.SystemConfig?.getBool('show_upgrade_ui') === false) {
        const contactUrl = window.SystemConfig?.get('upgrade_contact_url', '');
        if (contactUrl) {
          window.open(contactUrl, '_blank');
        }
        return;
      }

      // Fix: Move upgrade overlay ra document.body (cùng level với TaskModal/WorkflowEditor overlays).
      // Lý do: nếu giữ trong #flow-auto-sidebar-root, stacking context của sidebar giới hạn z-index
      // → upgrade modal bị TaskModal đè dù z-index cao hơn.
      if (upgradeOverlay && upgradeOverlay.parentElement !== document.body) {
        document.body.appendChild(upgradeOverlay);
      }
      if (upgradeOverlay) upgradeOverlay.classList.remove('hidden');
      // Re-trigger footer slide-up animation cho mỗi lần open modal
      // (xóa class + force reflow + re-add → CSS animation chạy lại).
      const _upgradeFooter = upgradeOverlay?.querySelector('.upgrade-modal-footer');
      if (_upgradeFooter) {
        _upgradeFooter.style.animation = 'none';
        // eslint-disable-next-line no-unused-expressions
        _upgradeFooter.offsetHeight; // force reflow
        _upgradeFooter.style.animation = '';
      }

      // Fetch plans and active providers in parallel
      const [plans, activeProviders] = await Promise.all([
        fetchPlans(),
        fetchActiveProviders()
      ]);

      if (plans) {
        window._cachedPlans = plans;
        renderUpgradeModal(plans);
      }

      // Show/hide payment buttons based on active providers from server
      // [Perf 2026-05-23] Cache providers list — currency toggle KHÔNG refetch (chỉ re-apply filter).
      window._cachedActiveProviders = activeProviders;
      _applyActiveProviders(activeProviders);
    }

    /**
     * Show/hide payment method buttons based on active providers
     * Bug fix 2026-05-22: thêm sepay (trước đây quên → SePay luôn show dù admin disable).
     *
     * [Feature: IP Geolocation 2026-05-23] Filter providers theo currency:
     *  - VND: VietQR + SePay (chỉ providers VN nhận VND)
     *  - USD: Stripe + PayPal + Polar (international providers)
     * Nếu admin enabled cả 5 providers, user vẫn chỉ thấy 2-3 button phù hợp currency.
     */
    function _applyActiveProviders(providers) {
      const vietqrBtn = document.getElementById('payVietQR');
      const sepayBtn = document.getElementById('paySePay');
      const stripeBtn = document.getElementById('payStripe');
      const paypalBtn = document.getElementById('payPayPal');
      const polarBtn = document.getElementById('payPolar');
      const paymentSection = document.getElementById('upgradePaymentMethods');
      const paymentButtons = paymentSection?.querySelector('.upgrade-payment-buttons');

      if (!providers || !Array.isArray(providers)) return;

      const currency = window.LocationCache?.getCurrency?.() || 'VND';
      const isVND = currency === 'VND';

      const hasVietQR = providers.includes('vietqr') && isVND;
      const hasSePay = providers.includes('sepay') && isVND;
      const hasStripe = providers.includes('stripe') && !isVND;
      const hasPayPal = providers.includes('paypal') && !isVND;
      const hasPolar = providers.includes('polar') && !isVND;
      const activeCount = (hasVietQR ? 1 : 0) + (hasSePay ? 1 : 0) + (hasStripe ? 1 : 0) + (hasPayPal ? 1 : 0) + (hasPolar ? 1 : 0);

      if (vietqrBtn) vietqrBtn.classList.toggle('hidden', !hasVietQR);
      if (sepayBtn) sepayBtn.classList.toggle('hidden', !hasSePay);
      if (stripeBtn) stripeBtn.classList.toggle('hidden', !hasStripe);
      if (paypalBtn) paypalBtn.classList.toggle('hidden', !hasPayPal);
      if (polarBtn) polarBtn.classList.toggle('hidden', !hasPolar);

      // Single provider: full-width button
      if (paymentButtons) {
        paymentButtons.classList.toggle('single-provider', activeCount === 1);
      }

      // Hide entire payment section if no provider is active
      if (paymentSection) {
        paymentSection.classList.toggle('hidden', activeCount === 0);
      }
    }

    // [Feature: IP Geolocation 2026-05-23] Re-apply providers khi user toggle currency.
    // [Perf 2026-05-23] Dùng cached providers list — KHÔNG refetch API (providers không đổi,
    // chỉ filter logic visiblility theo currency). Fallback fetch nếu cache empty (rare).
    if (window.eventBus) {
      window.eventBus.on('location:currency_changed', async () => {
        const cached = window._cachedActiveProviders;
        if (cached) {
          _applyActiveProviders(cached);
        } else {
          // Fallback: cache empty (chưa mở upgrade modal lần nào) → fetch
          const providers = await fetchActiveProviders();
          if (providers) {
            window._cachedActiveProviders = providers;
            _applyActiveProviders(providers);
          }
        }
      });
    }

    // Expose globally cho popup windows relay (angles/effects → background → sidePanel)
    window.openUpgradeModal = openUpgradeModal;

    // Open upgrade modal from user dropdown
    if (upgradeBtn) {
      upgradeBtn.addEventListener('click', () => {
        const userDropdown = document.getElementById('userDropdown');
        if (userDropdown) userDropdown.classList.add('hidden');
        openUpgradeModal();
      });
    }

    // Footer upgrade button (for free users)
    const footerUpgradeBtn = document.getElementById('footerUpgradeBtn');
    if (footerUpgradeBtn) {
      footerUpgradeBtn.addEventListener('click', openUpgradeModal);
    }

    // Footer register button (for guests)
    const footerRegisterBtn = document.getElementById('footerRegisterBtn');
    if (footerRegisterBtn) {
      footerRegisterBtn.addEventListener('click', () => {
        if (loginOverlay) loginOverlay.classList.remove('hidden');
      });
    }

    // Footer premium badge (for premium users) -> show benefits modal
    const footerPremiumBtn = document.getElementById('footerPremiumBtn');
    const premiumBenefitsOverlay = document.getElementById('premiumBenefitsOverlay');
    const premiumBenefitsCloseBtn = document.getElementById('premiumBenefitsCloseBtn');
    const premiumBenefitsContent = document.getElementById('premiumBenefitsContent');
    const premiumBenefitsTitle = document.getElementById('premiumBenefitsTitle');

    if (footerPremiumBtn && premiumBenefitsOverlay) {
      footerPremiumBtn.addEventListener('click', async () => {
        // Update modal title based on user's plan
        if (premiumBenefitsTitle) {
          const user = window.authManager?.getUser();
          const planDisplayName = (user?.plan_slug === 'autoflow-pro' || user?.plan_slug === 'autogrok-pro') ? 'Pro' : 'Premium';
          premiumBenefitsTitle.textContent = `Đặc quyền ${planDisplayName}`;
        }
        premiumBenefitsOverlay.classList.remove('hidden');
        await renderPremiumBenefits();
      });
    }

    if (premiumBenefitsCloseBtn && premiumBenefitsOverlay) {
      premiumBenefitsCloseBtn.addEventListener('click', () => {
        premiumBenefitsOverlay.classList.add('hidden');
      });
    }

    // Click outside to close premium benefits modal
    if (premiumBenefitsOverlay) {
      premiumBenefitsOverlay.addEventListener('click', (e) => {
        if (e.target === premiumBenefitsOverlay) {
          premiumBenefitsOverlay.classList.add('hidden');
        }
      });
    }

    // Render premium benefits from API
    async function renderPremiumBenefits() {
      if (!premiumBenefitsContent) return;

      premiumBenefitsContent.innerHTML = `<div class="upgrade-loading">${window.I18n?.t('common.loading') || 'Đang tải...'}</div>`;

      try {
        const plans = await fetchPlans();
        if (plans) window._cachedPlans = plans;

        // Get user's current plan_slug and find matching plan
        const user = window.authManager?.getUser();
        const userPlanSlug = user?.plan_slug;

        // Find user's plan first, fallback to first non-free/trial plan
        let premiumPlan = userPlanSlug ? plans?.find(p => p.slug === userPlanSlug) : null;
        if (!premiumPlan) {
          premiumPlan = plans?.find(p => p.slug !== 'free' && p.slug !== 'trial');
        }

        if (!premiumPlan) {
          premiumBenefitsContent.innerHTML = `<p style="color: var(--text-secondary); text-align: center;">${window.I18n?.t('upgrade.noBenefits') || 'Không có thông tin đặc quyền.'}</p>`;
          return;
        }

        // Ưu tiên hiển thị content từ API qua PlanContentRenderer
        if (premiumPlan.content) {
          const rendered = window.PlanContentRenderer
            ? window.PlanContentRenderer.render(premiumPlan.content, { variant: 'dark' })
            : '';
          if (rendered) {
            premiumBenefitsContent.innerHTML = `<div class="premium-plan-content">${rendered}</div>`;
            return;
          }
        }

        // Fallback: render features nếu không có content
        if (!premiumPlan.features?.length) {
          premiumBenefitsContent.innerHTML = `<p style="color: var(--text-secondary); text-align: center;">${window.I18n?.t('upgrade.noBenefits') || 'Không có thông tin đặc quyền.'}</p>`;
          return;
        }

        let html = '<ul class="premium-benefits-list">';
        premiumPlan.features.forEach(f => {
          const value = f.value === 'true' || f.value === '-1' || f.value === 'unlimited'
            ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>'
            : `<span class="benefit-value">${f.value === '-1' ? '∞' : f.value}</span>`;
          html += `
            <li class="premium-benefit-item">
              <span class="benefit-check">${value}</span>
              <span class="benefit-label">${f.name || f.key}</span>
            </li>`;
        });
        html += '</ul>';

        premiumBenefitsContent.innerHTML = html;
      } catch (e) {
        console.error('[TobyFlow] Failed to load premium benefits:', e);
        premiumBenefitsContent.innerHTML = `<p style="color: var(--text-error); text-align: center;">${window.I18n?.t('upgrade.loadBenefitsFailed') || 'Không thể tải đặc quyền. Vui lòng thử lại.'}</p>`;
      }
    }

    // Close upgrade modal
    if (upgradeCloseBtn) {
      upgradeCloseBtn.addEventListener('click', () => {
        if (upgradeOverlay) upgradeOverlay.classList.add('hidden');
      });
    }

    // [SSE Phase 1 2026-05-23] Speedup polling 3s khi user đang chờ payment.
    // Tự restore 30s khi nhận sse:plan_activated event (Order::activate fire) hoặc 30 phút timeout.
    // Chỉ ảnh hưởng polling mode (free user) — premium SSE realtime KHÔNG bị ảnh hưởng.
    // Idempotent: nếu gọi lần 2 trước khi event/timeout fire → clear old listener + restart.
    // [Audit fix Finding 5] Handle cold-start race — nếu mode chưa polling khi user click payment,
    // defer activate qua eventBus.once('sse:connected') hoặc 5s timeout.
    let _paymentSpeedupCleanup = null;
    function _setupPaymentSpeedup(orderId) {
      // Cleanup previous setup nếu user mở payment thứ 2 trước khi cái cũ kết thúc
      if (_paymentSpeedupCleanup) {
        try { _paymentSpeedupCleanup(); } catch (_) {}
        _paymentSpeedupCleanup = null;
      }

      const tryActivate = () => {
        const mode = window.SseClient?.getMode?.();
        // Chỉ activate khi polling mode (free user). Premium SSE realtime → không cần speedup.
        if (mode !== 'polling') {
          console.log('[Payment Speedup] Mode is', mode, '— skip speedup (premium hoặc not initialized)');
          return false;
        }
        try {
          window.SseClient.setPollingInterval(3000);
          console.log('[Payment Speedup] Polling boost 3s for order:', orderId);
        } catch (e) { /* ignore */ }
        return true;
      };

      const restore = () => {
        try { window.SseClient?.setPollingInterval?.(30000); } catch (_) {}
      };

      // Listener: order paid → restore 30s + cleanup
      const handler = (data) => {
        // Match theo order_id nếu có (type-safe string compare cho cả number + string variants)
        if (!orderId || String(data?.order_id) === String(orderId)) {
          console.log('[Payment Speedup] plan_activated received, restore polling 30s');
          restore();
          cleanup();
        }
      };
      window.eventBus?.on?.('sse:plan_activated', handler);

      // Safety timeout 30 phút — restore + cleanup dù event chưa fire (vd user bỏ payment)
      const safetyTimer = setTimeout(() => {
        console.log('[Payment Speedup] 30min safety timeout, restore polling 30s');
        restore();
        cleanup();
      }, 30 * 60 * 1000);

      const cleanup = () => {
        clearTimeout(safetyTimer);
        clearTimeout(deferTimer);
        try { window.eventBus?.off?.('sse:plan_activated', handler); } catch (_) {}
        try { window.eventBus?.off?.('sse:connected', deferHandler); } catch (_) {}
        _paymentSpeedupCleanup = null;
      };

      // [Audit fix Finding 5] Try activate ngay. Nếu chưa polling mode (cold start race) →
      // defer qua eventBus.on('sse:connected') hoặc 5s timeout fallback.
      let deferTimer = null;
      const deferHandler = () => {
        if (tryActivate()) {
          // Đã activate — không cần defer nữa
          if (deferTimer) clearTimeout(deferTimer);
        }
      };
      if (!tryActivate()) {
        console.log('[Payment Speedup] Defer activate — chờ sse:connected hoặc 5s timeout');
        window.eventBus?.on?.('sse:connected', deferHandler);
        // Safety: nếu sau 5s vẫn chưa connect → bỏ qua (user có thể đã đóng modal)
        deferTimer = setTimeout(() => {
          tryActivate();
          try { window.eventBus?.off?.('sse:connected', deferHandler); } catch (_) {}
        }, 5000);
      }

      _paymentSpeedupCleanup = () => {
        restore();
        cleanup();
      };
    }

    // Payment handler — opens checkout page on browser tab
    async function handlePayment(provider) {
      const payBtnMap = { vietqr: 'payVietQR', sepay: 'paySePay', stripe: 'payStripe', paypal: 'payPayPal', polar: 'payPolar' };
      const payBtn = document.getElementById(payBtnMap[provider]);
      if (payBtn) payBtn.disabled = true;

      try {
        if (!window.authManager) {
          throw new Error(window.I18n?.t('upgrade.loginRequired') || 'Vui lòng đăng nhập trước khi thanh toán');
        }

        if (!selectedPlanId) {
          throw new Error(window.I18n?.t('upgrade.selectPlanFirst') || 'Vui lòng chọn gói trước khi thanh toán');
        }

        // [Upgrade Prorated 2026-05-31] Pass is_upgrade=true nếu có quote credit > 0
        // Backend re-validate + recompute amount qua ProrationCalculator (KHÔNG trust số FE).
        // Nếu user thực ra là free/trial/expired → backend tự skip credit (credit=0 silent).
        // Verify quote còn match plan/cycle/currency user đang chọn (tránh stale state nếu user
        // race-click pay trong khi quote đang fetch hoặc đổi currency).
        const _payCurrency = (window.LocationCache?.getCurrency?.() || 'VND');
        const isUpgradePayload = !!(
          _currentUpgradeQuote
          && _currentUpgradeQuote.credit > 0
          && !_currentUpgradeQuote._error_code
          && _currentUpgradeQuote.to_plan?.slug
          && _currentUpgradeQuote.to_plan.billing_cycle === selectedBillingCycle
          && _currentUpgradeQuote.currency === _payCurrency
        );

        const payload = {
          plan_id: selectedPlanId,
          provider: provider,
          billing_cycle: selectedBillingCycle,
        };
        if (isUpgradePayload) {
          payload.is_upgrade = true;
        }

        const response = await window.authManager._apiCall('POST', 'orders', payload);

        if (response?.checkout_url) {
          // Mở trang thanh toán trên trình duyệt
          chrome.tabs.create({ url: response.checkout_url });
          // Đóng modal
          if (upgradeOverlay) upgradeOverlay.classList.add('hidden');
          // [SSE Phase 1 2026-05-23] Speedup polling 3s khi user đang chờ payment.
          // Khi nhận sse:plan_activated (Order::activate fire) hoặc 30 phút timeout → restore 30s.
          // Chỉ ảnh hưởng polling mode (free user), không ảnh hưởng SSE realtime (premium).
          _setupPaymentSpeedup(response.order_id);
          // Toast thông báo
          if (typeof sendLog === 'function') {
            sendLog(window.I18n?.t('upgrade.openingCheckout') || 'Đang mở trang thanh toán...', 'info');
          }
        } else if (response?.qr_url) {
          // Backward compatibility: old API returns qr_url
          if (upgradeOverlay) upgradeOverlay.classList.add('hidden');
          showVietQRModal(response);
          // [SSE Phase 1 2026-05-23] Speedup polling cho legacy qr_url flow
          _setupPaymentSpeedup(response.order_id);
        } else {
          throw new Error(window.I18n?.t('upgrade.checkoutFailed') || 'Không nhận được liên kết thanh toán');
        }
      } catch (e) {
        console.error('[Upgrade] Payment error:', e);
        const isAuthError = e.status === 401 || e.code === 'UNAUTHENTICATED' ||
          (e.message && (e.message.includes('expired') || e.message.includes('Unauthenticated') || e.message.includes('đăng nhập')));

        // Error wrapper đã chuyển ra sidebar notification toast — non-blocking, dismiss-able.
        const errMsg = e.message || window.I18n?.t('upgrade.checkoutFailed') || 'Thanh toán thất bại, vui lòng thử lại';
        window.showNotification?.(errMsg, 'error', 5000);

        // Auth error: tự close upgrade modal + open login modal (thay cho button "Đăng nhập lại" inline cũ).
        if (isAuthError) {
          if (upgradeOverlay) upgradeOverlay.classList.add('hidden');
          if (window.authManager?.showLoginModal) {
            window.authManager.showLoginModal();
          } else {
            const loginOverlay = document.getElementById('loginOverlay');
            if (loginOverlay) loginOverlay.classList.remove('hidden');
          }
        }

        if (typeof sendLog === 'function') {
          sendLog('Lỗi thanh toán: ' + (e.message || ''), 'error');
        }
      } finally {
        if (payBtn) payBtn.disabled = false;
      }
    }

    // Bind payment buttons
    const payVietQRBtn = document.getElementById('payVietQR');
    const paySePayBtn = document.getElementById('paySePay');
    const payStripeBtn = document.getElementById('payStripe');
    const payPayPalBtn = document.getElementById('payPayPal');
    const payPolarBtn = document.getElementById('payPolar');

    if (payVietQRBtn) {
      payVietQRBtn.addEventListener('click', () => handlePayment('vietqr'));
    }
    if (paySePayBtn) {
      paySePayBtn.addEventListener('click', () => handlePayment('sepay'));
    }
    if (payStripeBtn) {
      payStripeBtn.addEventListener('click', () => handlePayment('stripe'));
    }
    if (payPayPalBtn) {
      payPayPalBtn.addEventListener('click', () => handlePayment('paypal'));
    }
    if (payPolarBtn) {
      payPolarBtn.addEventListener('click', () => handlePayment('polar'));
    }

    // Login button đã removed khỏi DOM — auth error giờ tự close modal + open login modal
    // trong handler `catch (e)` ở handlePayment().

    // [Upgrade Prorated 2026-05-31] Hide upgrade button chỉ khi user ở top tier hoặc lifetime
    // (KHÔNG thể nâng cấp được nữa). Trước fix: hide cho mọi paid plan → autoflow-pro user
    // không thấy button để upgrade lên premium.
    //
    // Logic mới:
    //  - Lifetime → hide (không có higher tier)
    //  - Premium / unlimited (top tier) → hide
    //  - Pro / autoflow-pro / autogrok-pro / free / trial → show (có path upgrade)
    function checkPlanAndToggleUpgrade() {
      if (!window.authManager?.isLoggedIn()) return;
      const user = window.authManager.getUser();
      if (upgradeBtn) {
        const isTopTier = user?.plan_slug === 'unlimited' || user?.plan_slug === 'premium';
        const isLifetime = user?.plan_billing_cycle === 'lifetime';
        const cannotUpgrade = isTopTier || isLifetime;
        upgradeBtn.classList.toggle('hidden', cannotUpgrade);
      }
    }

    if (window.eventBus) {
      window.eventBus.on('auth:login', checkPlanAndToggleUpgrade);
    }

    checkPlanAndToggleUpgrade();
  }

  // ─── Tip Coffee Feature ──────────────────────────────
  function setupTipCoffee() {
    const tipCoffeeBtn = document.getElementById('tipCoffeeBtn');

    // Open tip page on browser tab instead of showing QR in extension
    // Phase 3.5 Bug I: dùng authManager.apiBaseUrl, server-only — không fallback hardcode
    if (tipCoffeeBtn) {
      tipCoffeeBtn.addEventListener('click', () => {
        const apiBaseUrl = window.authManager?.apiBaseUrl;
        if (!apiBaseUrl) return;
        const baseUrl = apiBaseUrl.replace(/\/api\/v\d+$/, '');
        chrome.tabs.create({ url: baseUrl + '/tip' });
      });
    }

    // Upgrade button in settings dropdown
    const settingsUpgradeBtn = document.getElementById('settingsUpgradeBtn');
    if (settingsUpgradeBtn) {
      settingsUpgradeBtn.addEventListener('click', () => {
        // Close settings dropdown
        document.getElementById('settingsDropdown')?.classList.remove('open');
        // Open upgrade modal
        if (typeof window.openUpgradeModal === 'function') {
          window.openUpgradeModal();
        }
      });
    }
  }

  // ─── Contact Modal ──────────────────────────────
  function setupContactModal() {
    const contactBtn = document.getElementById('contactBtn');
    const contactOverlay = document.getElementById('contactOverlay');
    const contactCloseBtn = document.getElementById('contactCloseBtn');
    const contactGuideLink = document.getElementById('contactGuideLink');
    const contactZaloLink = document.getElementById('contactZaloLink');
    const contactTelegramLink = document.getElementById('contactTelegramLink');
    const contactFacebookLink = document.getElementById('contactFacebookLink');
    const contactZaloUrl = document.getElementById('contactZaloUrl');
    const contactTelegramUrl = document.getElementById('contactTelegramUrl');
    const contactFacebookUrl = document.getElementById('contactFacebookUrl');
    const contactNoLinks = document.getElementById('contactNoLinks');

    if (!contactBtn || !contactOverlay) return;

    // Bind guide link URL dựa vào authManager.apiBaseUrl (strip /api/v1)
    // Phase 3.5 Bug I: server-only — không fallback hardcode
    if (contactGuideLink) {
      const apiBase = window.authManager?.apiBaseUrl;
      if (apiBase) {
        const siteBase = apiBase.replace(/\/api\/v\d+\/?$/, '');
        contactGuideLink.href = `${siteBase}/guide`;
      }
    }

    // Open modal - always fetch fresh from API (no cache)
    contactBtn.addEventListener('click', async () => {
      // Close settings dropdown if open
      document.getElementById('settingsDropdown')?.classList.remove('open');

      // Show modal immediately with loading state
      contactOverlay.classList.remove('hidden');
      if (contactZaloLink) contactZaloLink.classList.add('hidden');
      if (contactTelegramLink) contactTelegramLink.classList.add('hidden');
      if (contactFacebookLink) contactFacebookLink.classList.add('hidden');
      if (contactNoLinks) contactNoLinks.classList.add('hidden');

      // Fetch fresh settings from API (forceRefresh = true)
      let zaloUrl = '';
      let telegramUrl = '';
      let facebookUrl = '';
      try {
        const settings = await window.SystemConfig?.fetch(true);
        zaloUrl = settings?.zalo_contact_url || '';
        telegramUrl = settings?.telegram_contact_url || '';
        facebookUrl = settings?.facebook_contact_url || '';
      } catch (err) {
        console.warn('[ContactModal] Failed to fetch settings:', err);
      }

      let hasLinks = false;

      if (zaloUrl && contactZaloLink) {
        contactZaloLink.href = zaloUrl;
        contactZaloLink.classList.remove('hidden');
        if (contactZaloUrl) {
          // Extract username from URL for display
          try {
            const urlObj = new URL(zaloUrl);
            contactZaloUrl.textContent = urlObj.pathname.replace(/^\//, '') || urlObj.hostname;
          } catch {
            contactZaloUrl.textContent = zaloUrl;
          }
        }
        hasLinks = true;
      } else if (contactZaloLink) {
        contactZaloLink.classList.add('hidden');
      }

      if (telegramUrl && contactTelegramLink) {
        contactTelegramLink.href = telegramUrl;
        contactTelegramLink.classList.remove('hidden');
        if (contactTelegramUrl) {
          // Extract username from URL for display
          try {
            const urlObj = new URL(telegramUrl);
            contactTelegramUrl.textContent = urlObj.pathname.replace(/^\//, '') || urlObj.hostname;
          } catch {
            contactTelegramUrl.textContent = telegramUrl;
          }
        }
        hasLinks = true;
      } else if (contactTelegramLink) {
        contactTelegramLink.classList.add('hidden');
      }

      if (facebookUrl && contactFacebookLink) {
        contactFacebookLink.href = facebookUrl;
        contactFacebookLink.classList.remove('hidden');
        if (contactFacebookUrl) {
          // Extract page name from URL for display
          try {
            const urlObj = new URL(facebookUrl);
            contactFacebookUrl.textContent = urlObj.pathname.replace(/^\//, '') || urlObj.hostname;
          } catch {
            contactFacebookUrl.textContent = facebookUrl;
          }
        }
        hasLinks = true;
      } else if (contactFacebookLink) {
        contactFacebookLink.classList.add('hidden');
      }

      // Guide link luôn hiện → không bao giờ empty state. Chỉ show nếu hoàn toàn
      // không có Zalo/Telegram/Facebook VÀ guide link cũng không có (edge case — guide link
      // được render static trong HTML, chỉ ẩn nếu explicit).
      if (contactNoLinks) {
        const hasAnyLink = hasLinks || (contactGuideLink && !contactGuideLink.classList.contains('hidden'));
        contactNoLinks.classList.toggle('hidden', hasAnyLink);
      }
    });

    // Close modal
    const closeModal = () => {
      contactOverlay.classList.add('hidden');
    };

    if (contactCloseBtn) {
      contactCloseBtn.addEventListener('click', closeModal);
    }

    // Close when clicking overlay background
    contactOverlay.addEventListener('click', (e) => {
      if (e.target === contactOverlay) {
        closeModal();
      }
    });
  }

  // ─── Extension Link Button ──────────────────────────────
  function setupExtensionLink() {
    const extensionLinkBtn = document.getElementById('extensionLinkBtn');
    if (!extensionLinkBtn) return;

    // Strict Server-Only: extension URL từ SystemConfig (system_settings.app.extension_url).
    // Backend SystemSettingSeeder seed sẵn → KHÔNG fallback hardcoded URL.
    const updateExtensionLink = async () => {
      try {
        const settings = await window.SystemConfig?.fetch();
        const extensionUrl = settings?.extension_url;
        if (extensionUrl) {
          extensionLinkBtn.classList.remove('hidden');
          extensionLinkBtn.dataset.url = extensionUrl;
        } else {
          console.debug('[Tier3] ExtensionLink: system_settings.app.extension_url empty — hiding button');
          extensionLinkBtn.classList.add('hidden');
        }
      } catch (err) {
        console.debug('[Tier3] ExtensionLink fetch failed, hiding button:', err.message);
        extensionLinkBtn.classList.add('hidden');
      }
    };

    // Initial check
    updateExtensionLink();

    // Click handler
    extensionLinkBtn.addEventListener('click', () => {
      const url = extensionLinkBtn.dataset.url;
      if (url) {
        // Close settings dropdown
        document.getElementById('settingsDropdown')?.classList.remove('open');
        window.open(url, '_blank', 'noopener,noreferrer');
      }
    });
  }

  // ─── Settings Logout Button ──────────────────────────────
  function setupSettingsLogout() {
    const settingsLogoutBtn = document.getElementById('settingsLogoutBtn');
    if (!settingsLogoutBtn) return;

    settingsLogoutBtn.addEventListener('click', async () => {
      // Close settings dropdown
      document.getElementById('settingsDropdown')?.classList.remove('open');

      // Confirm logout
      const t = (key, fallback) => window.I18n?.t(key) || fallback;
      const confirmed = confirm(t('auth.logoutConfirm', 'Bạn có chắc muốn đăng xuất?'));

      if (confirmed && window.authManager) {
        try {
          await window.authManager.logout();
        } catch (err) {
          console.error('[SettingsLogout] Logout failed:', err);
        }
      }
    });
  }

  // ─── Usage Stats Modal ──────────────────────────────
  function setupUsageStatsModal() {
    const overlay = document.getElementById('usageStatsOverlay');
    const closeBtn = document.getElementById('usageStatsCloseBtn');
    const upgradeBtn = document.getElementById('usageStatsUpgradeBtn');
    const loginBtn = document.getElementById('usageStatsLoginBtn');
    const quotasElements = document.querySelectorAll('.footer-usage-quotas');
    const userPlanBadge = document.getElementById('userPlanBadge');

    if (!overlay) return;

    function openModal() {
      updateUsageStats();
      overlay.classList.remove('hidden');
    }

    function closeModal() {
      overlay.classList.add('hidden');
    }

    async function updateUsageStats() {
      const promptsEl = document.getElementById('usageStatsPrompts');
      const tasksEl = document.getElementById('usageStatsTasks');
      const workflowsEl = document.getElementById('usageStatsWorkflows');
      const planNameEl = document.getElementById('usageStatsPlanName');
      const premiumTeaser = document.getElementById('usageStatsPremiumTeaser');
      const expiryContainer = document.getElementById('usageStatsExpiry');
      const expiryDateEl = document.getElementById('usageStatsExpiryDate');
      // Progress bars
      const promptsBar = document.getElementById('usageStatsPromptsBar');
      const tasksBar = document.getElementById('usageStatsTasksBar');
      const workflowsBar = document.getElementById('usageStatsWorkflowsBar');
      // Items for warning states
      const promptsItem = document.getElementById('usageStatsPromptsItem');
      const tasksItem = document.getElementById('usageStatsTasksItem');
      const workflowsItem = document.getElementById('usageStatsWorkflowsItem');
      // Key features
      const featurePipeline = document.getElementById('usageStatsFeaturePipeline');
      const featureAutoDownload = document.getElementById('usageStatsFeatureAutoDownload');
      const featureAutoRetry = document.getElementById('usageStatsFeatureAutoRetry');

      try {
        const fg = window.featureGate;
        const plan = fg?.getPlan?.();
        const planSlug = plan?.slug || 'free';

        if (planNameEl) {
          planNameEl.textContent = plan?.name || 'Free';
        }

        // Show expiry date for paid plans (not free)
        if (expiryContainer && expiryDateEl) {
          const expiresAt = plan?.expires_at;
          const isPaidPlan = planSlug !== 'free' && planSlug !== 'trial';

          console.log('[UsageStats] Plan expiry check:', { planSlug, isPaidPlan, expiresAt, plan });

          if (isPaidPlan && expiresAt) {
            const expiryDate = new Date(expiresAt);
            const now = new Date();
            const daysUntilExpiry = Math.ceil((expiryDate - now) / (1000 * 60 * 60 * 24));

            const dateStr = window.I18n?.formatDate?.(expiryDate) || expiryDate.toLocaleDateString();

            expiryDateEl.textContent = dateStr;
            expiryContainer.classList.remove('hidden', 'expiring-soon', 'expired');

            if (daysUntilExpiry <= 0) {
              expiryContainer.classList.add('expired');
              expiryDateEl.textContent = window.I18n?.t('usageStats.expired') || 'Đã hết hạn';
            } else if (daysUntilExpiry <= 7) {
              expiryContainer.classList.add('expiring-soon');
              expiryDateEl.textContent = `${dateStr} (${daysUntilExpiry} ngày)`;
            }
          } else {
            expiryContainer.classList.add('hidden');
          }
        }

        // Update key features based on user plan
        const updateFeature = (el, featureKey) => {
          if (!el) return;
          const canUse = fg?.canUse?.(featureKey) ?? false;
          el.setAttribute('data-enabled', canUse ? 'true' : 'false');

          const statusEl = el.querySelector('.usage-stats-feature-status');
          if (statusEl) {
            statusEl.classList.remove('usage-stats-feature-status--on', 'usage-stats-feature-status--off');
            statusEl.classList.add(canUse ? 'usage-stats-feature-status--on' : 'usage-stats-feature-status--off');
            statusEl.innerHTML = canUse
              ? ''
              : '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>';
          }
        };

        updateFeature(featurePipeline, 'pipeline_queue_enabled');
        updateFeature(featureAutoDownload, 'auto_download');
        updateFeature(featureAutoRetry, 'retry_on_fail');

        // Update provider support status + quota + progress bar
        const updateProvider = (id, featureKey, quotaKey) => {
          const el = document.getElementById(id);
          if (!el) return;
          const canUse = fg?.canUse?.(featureKey) ?? false;
          el.setAttribute('data-enabled', canUse ? 'true' : 'false');

          // Update quota display + progress bar
          const quotaEl = document.getElementById(id + 'Quota');
          const quota = fg?.checkQuota?.(quotaKey) || {};
          const limit = quota.limit;
          const used = quota.used || 0;
          const isUnlimited = limit === -1 || limit === 'unlimited' || limit === '∞';

          if (quotaEl) {
            const valueText = isUnlimited ? `${used}/∞` : `${used}/${limit || 0}`;
            quotaEl.innerHTML = '';
            const valueSpan = document.createElement('span');
            valueSpan.className = 'usage-stats-provider-quota-value';
            valueSpan.textContent = valueText;
            const periodSpan = document.createElement('span');
            periodSpan.className = 'usage-stats-provider-quota-period';
            periodSpan.textContent = '/day';
            quotaEl.appendChild(valueSpan);
            quotaEl.appendChild(periodSpan);
            quotaEl.classList.toggle('unlimited', isUnlimited);
          }

          // Update progress bar fill width
          const progressEl = document.getElementById(id + 'Progress');
          if (progressEl) {
            const fillEl = progressEl.querySelector('.usage-stats-provider-progress-fill');
            if (fillEl) {
              if (isUnlimited || !limit) {
                // Unlimited hoặc chưa có limit → bar full màu success
                fillEl.style.width = isUnlimited ? '100%' : '0%';
                progressEl.setAttribute('data-state', isUnlimited ? 'unlimited' : 'empty');
              } else {
                const ratio = Math.min(100, Math.max(0, (used / limit) * 100));
                fillEl.style.width = `${ratio}%`;
                // State để CSS đổi màu khi gần hết quota (warning >80%, danger >=100%)
                let state = 'normal';
                if (ratio >= 100) state = 'danger';
                else if (ratio >= 80) state = 'warning';
                progressEl.setAttribute('data-state', state);
              }
            }
          }
        };
        // Quota mapping per provider (theo user spec):
        // - Flow: gen_run_max
        // - ChatGPT: chatgpt_run_max
        // - Grok: grok_run_max
        updateProvider('usageStatsProviderFlow', 'gen_enabled', 'gen_run_max');
        updateProvider('usageStatsProviderChatGPT', 'chatgpt_enabled', 'chatgpt_run_max');
        updateProvider('usageStatsProviderGrok', 'grok_enabled', 'grok_run_max');

        // Show/hide teasers based on login state
        const loginTeaser = document.getElementById('usageStatsLoginTeaser');
        const isLoggedIn = window.authManager?.isLoggedIn();
        const showUpgrade = isLoggedIn && (planSlug === 'free' || planSlug === 'trial');
        const showLogin = !isLoggedIn;

        if (loginTeaser) {
          loginTeaser.classList.toggle('hidden', !showLogin);
        }
        if (premiumTeaser) {
          premiumTeaser.classList.toggle('hidden', !showUpgrade);
        }

        const today = new Date().toISOString().slice(0, 10);
        const currentUserId = window.authManager?.user?.id || null;
        const result = await new Promise(resolve => {
          chrome.storage.local.get(['af_daily_stats'], r => resolve(r));
        });
        const stats = result.af_daily_stats || {};

        // Get max quotas from featureGate (use creation limits for tasks/workflows)
        const config = fg?.getConfig?.() || {};
        const promptQuota = fg?.checkQuota?.('prompt_submit_max') || {};
        const promptsMax = promptQuota.limit === 'unlimited' ? -1 : (promptQuota.limit ?? -1);
        // Tasks & Workflows: use creation limits (tasks_max, workflows_max)
        const tasksQuota = fg?.checkQuota?.('tasks_max') || {};
        const wfQuota = fg?.checkQuota?.('workflows_max') || {};
        const tasksMax = tasksQuota.limit === 'unlimited' ? -1 : (tasksQuota.limit ?? config.tasks_max_create ?? -1);
        const workflowsMax = wfQuota.limit === 'unlimited' ? -1 : (wfQuota.limit ?? config.workflows_max_create ?? -1);
        // Get actual created counts from quota
        const tasksCreated = tasksQuota.used ?? 0;
        const wfCreated = wfQuota.used ?? 0;

        // Check if stats belong to current user and today
        const isValidStats = stats._date === today && stats._user_id === currentUserId;

        // Helper to format and update progress
        const updateStat = (el, bar, item, used, max) => {
          const isUnlimited = max === -1 || max === '∞' || max === 'unlimited';
          const displayMax = isUnlimited ? '∞' : max;
          if (el) {
            el.textContent = `${used}/${displayMax}`;
            el.classList.toggle('usage-stats-unlimited', isUnlimited);
          }

          // Update progress bar
          if (bar) {
            const percent = isUnlimited ? Math.min(used * 2, 100) : Math.min((used / max) * 100, 100);
            bar.style.width = `${percent}%`;
          }

          // Warning states
          if (item && !isUnlimited) {
            const ratio = used / max;
            item.classList.remove('warning', 'danger');
            if (ratio >= 1) {
              item.classList.add('danger');
            } else if (ratio >= 0.8) {
              item.classList.add('warning');
            }
          }
        };

        // Prompts: prefer server usage (promptQuota.used) for consistency with Settings Popup
        // Fallback to local af_daily_stats if server value not available
        const localPromptTotal = isValidStats
          ? (stats.flow_prompt_total || 0) + (stats.chatgpt_prompt_total || 0) + (stats.gemini_prompt_total || 0) + (stats.grok_prompt_total || 0)
          : 0;
        const promptUsed = (promptQuota.used !== undefined && promptQuota.used > 0) ? promptQuota.used : localPromptTotal;
        // Tasks & Workflows: total created count from quota (not daily runs)

        updateStat(promptsEl, promptsBar, promptsItem, promptUsed, promptsMax);
        updateStat(tasksEl, tasksBar, tasksItem, tasksCreated, tasksMax);
        updateStat(workflowsEl, workflowsBar, workflowsItem, wfCreated, workflowsMax);

      } catch (err) {
        console.error('[UsageStats] Failed to update:', err);
      }
    }

    // Click on footer quotas
    quotasElements.forEach(el => {
      el.addEventListener('click', openModal);
    });

    // Click on user plan badge (header)
    if (userPlanBadge) {
      userPlanBadge.style.cursor = 'pointer';
      userPlanBadge.addEventListener('click', openModal);
    }

    // Click on footer pro label
    const proLabels = document.querySelectorAll('.footer-pro-label');
    proLabels.forEach(el => {
      el.addEventListener('click', openModal);
    });

    // Click on footer features (Download, Retry) opens modal
    const footerFeatures = document.querySelectorAll('.footer-feature');
    footerFeatures.forEach(el => {
      el.style.cursor = 'pointer';
      el.addEventListener('click', openModal);
    });

    if (closeBtn) {
      closeBtn.addEventListener('click', closeModal);
    }

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeModal();
    });

    if (upgradeBtn) {
      upgradeBtn.addEventListener('click', () => {
        closeModal();
        // Mở modal upgrade thay vì link pricing
        if (typeof window.openUpgradeModal === 'function') {
          window.openUpgradeModal();
        } else {
          try { chrome.runtime.sendMessage({ action: 'showUpgradeModal' }); } catch (e) {}
        }
      });
    }

    // Login button for not-logged-in users
    if (loginBtn) {
      loginBtn.addEventListener('click', () => {
        closeModal();
        // Mở login modal
        if (window.authManager?.showLoginModal) {
          window.authManager.showLoginModal();
        } else {
          const loginOverlay = document.getElementById('loginOverlay');
          if (loginOverlay) loginOverlay.classList.remove('hidden');
        }
      });
    }
  }

  // ─── Notification Bell ──────────────────────────────
  function setupNotificationBell() {
    if (!window.NotificationBell) {
      console.warn('[NotificationBell] Class chưa được load');
      return;
    }

    // Tránh khởi tạo duplicate
    if (document.getElementById('notificationBellWrapper')) {
      return;
    }

    // Tìm container trong header actions
    const headerActions = document.querySelector('.tobyflow-header-actions');
    if (!headerActions) {
      console.warn('[NotificationBell] Không tìm thấy .tobyflow-header-actions');
      return;
    }

    // Tạo wrapper để đặt trước login button
    const bellWrapper = document.createElement('div');
    bellWrapper.id = 'notificationBellWrapper';
    bellWrapper.style.display = 'inline-flex';

    // Chèn trước tobyflow-header-user (login button area)
    const headerUser = headerActions.querySelector('.tobyflow-header-user');
    if (headerUser) {
      headerActions.insertBefore(bellWrapper, headerUser);
    } else {
      headerActions.appendChild(bellWrapper);
    }

    // Khởi tạo NotificationBell
    const bell = window.NotificationBell.getInstance();
    bell.init(bellWrapper);

    console.log('[NotificationBell] Đã khởi tạo trong header');
  }

  // ─── F10: Onboarding Flow ──────────────────────────────
  function setupOnboarding() {
    chrome.storage.local.get('af_onboarding_done', (result) => {
      if (result.af_onboarding_done) return;

      const overlay = document.getElementById('onboardingOverlay');
      const tooltip = document.getElementById('onboardingTooltip');
      const content = document.getElementById('onboardingContent');
      const stepIndicator = document.getElementById('onboardingStepIndicator');
      const nextBtn = document.getElementById('onboardingNextBtn');
      const skipBtn = document.getElementById('onboardingSkipBtn');

      if (!overlay || !tooltip || !content) return;

      const steps = [
        {
          target: null,
          title: window.I18n?.t('onboarding.welcomeTitle') || 'Chào mừng đến Toby Flow!',
          description: window.I18n?.t('onboarding.welcomeDesc') || 'Công cụ giúp bạn tự động tạo ảnh và video trên Google Flow. Hãy cùng khám phá các tính năng chính.',
          position: 'center'
        },
        {
          target: '[data-tab="tab-gen"]',
          title: window.I18n?.t('onboarding.genTabTitle') || 'Tab Gen',
          description: window.I18n?.t('onboarding.genTabDesc') || 'Nhập prompt và generate ảnh/video. Đây là nơi bạn bắt đầu mọi tác vụ.',
          position: 'bottom'
        },
        {
          target: '#startBtn',
          title: window.I18n?.t('onboarding.generateBtnTitle') || 'Nút Generate',
          description: window.I18n?.t('onboarding.generateBtnDesc') || 'Click để bắt đầu tạo ảnh/video từ prompt của bạn.',
          position: 'top'
        },
        {
          target: null,
          title: window.I18n?.t('onboarding.readyTitle') || 'Bạn đã sẵn sàng!',
          description: window.I18n?.t('onboarding.readyDesc') || 'Khám phá thêm các tính năng khác như Multi Task, WorkFlow và Templates. Chúc bạn sáng tạo vui vẻ!',
          position: 'center'
        }
      ];

      let currentStep = 0;
      let highlightedEl = null;

      function finishOnboarding() {
        if (highlightedEl) highlightedEl.classList.remove('tobyflow-onboarding-highlight');
        overlay.classList.add('hidden');
        chrome.storage.local.set({ af_onboarding_done: true });
      }

      function showStep(index) {
        // Clean previous highlight
        if (highlightedEl) {
          highlightedEl.classList.remove('tobyflow-onboarding-highlight');
          highlightedEl = null;
        }

        // Reset transform/position before repositioning
        tooltip.style.transform = '';
        tooltip.style.top = '';
        tooltip.style.left = '';

        const step = steps[index];
        content.innerHTML = `<h3>${step.title}</h3><p>${step.description}</p>`;
        stepIndicator.textContent = `${index + 1} / ${steps.length}`;

        const isLast = index === steps.length - 1;
        nextBtn.textContent = isLast ? (window.I18n?.t('onboarding.done') || 'Hoàn thành') : (window.I18n?.t('onboarding.next') || 'Tiếp theo');

        if (step.target) {
          const targetEl = document.querySelector(step.target);
          if (targetEl) {
            highlightedEl = targetEl;
            targetEl.classList.add('tobyflow-onboarding-highlight');

            // Position tooltip relative to target
            const rect = targetEl.getBoundingClientRect();
            const sidebarRoot = document.getElementById('flow-auto-sidebar-root');
            const sidebarRect = sidebarRoot ? sidebarRoot.getBoundingClientRect() : { left: 0, top: 0, width: 600, height: 800 };

            tooltip.style.position = 'absolute';

            const relLeft = rect.left - sidebarRect.left;
            const relTop = rect.top - sidebarRect.top;
            const tooltipH = tooltip.offsetHeight;
            const margin = 12;

            let top;
            if (step.position === 'bottom') {
              top = relTop + rect.height + margin;
            } else {
              top = relTop - tooltipH - margin;
            }

            // Clamp: if tooltip would go off-screen, flip or center
            if (top < 8) {
              top = relTop + rect.height + margin;
            }
            if (top + tooltipH > sidebarRect.height - 8) {
              top = Math.max(8, relTop - tooltipH - margin);
            }

            tooltip.style.top = top + 'px';
            tooltip.style.left = Math.max(8, Math.min(relLeft, sidebarRect.width - 288)) + 'px';
          } else {
            centerTooltip();
          }
        } else {
          centerTooltip();
        }
      }

      function centerTooltip() {
        tooltip.style.top = '50%';
        tooltip.style.left = '50%';
        tooltip.style.transform = 'translate(-50%, -50%)';
      }

      nextBtn.addEventListener('click', () => {
        if (currentStep < steps.length - 1) {
          currentStep++;
          showStep(currentStep);
        } else {
          finishOnboarding();
        }
      });

      skipBtn.addEventListener('click', finishOnboarding);

      // Start onboarding
      overlay.classList.remove('hidden');
      showStep(0);
    });
  }

  // ─── F11: Conversion Triggers ──────────────────────────

  // ─── Language Modal ──────────────────────────────────────
  function setupLanguageModal() {
    const languageBtn = document.getElementById('languageBtn');
    const languageOverlay = document.getElementById('languageOverlay');
    const languageCloseBtn = document.getElementById('languageCloseBtn');
    const languageOptions = document.querySelectorAll('.language-option');

    // Open modal
    if (languageBtn) {
      languageBtn.addEventListener('click', () => {
        if (languageOverlay) languageOverlay.classList.remove('hidden');
      });
    }

    // Close modal
    if (languageCloseBtn) {
      languageCloseBtn.addEventListener('click', () => {
        if (languageOverlay) languageOverlay.classList.add('hidden');
      });
    }

    // Click outside to close
    if (languageOverlay) {
      languageOverlay.addEventListener('click', (e) => {
        if (e.target === languageOverlay) {
          languageOverlay.classList.add('hidden');
        }
      });
    }

    // Language selection
    languageOptions.forEach(option => {
      option.addEventListener('click', () => {
        const lang = option.dataset.lang;

        // Update active state
        languageOptions.forEach(opt => opt.classList.remove('active'));
        option.classList.add('active');

        // Apply language change via I18n
        if (window.I18n) {
          I18n.setLocale(lang, true);
        }
        console.log('[TobyFlow] Language changed to:', lang);

        // Close modal
        if (languageOverlay) languageOverlay.classList.add('hidden');
      });
    });

    // Load active language từ I18n (single source of truth — KHÔNG query storage trực tiếp).
    // Bug trước: query af_locale → fallback hardcode 'vi'. Inconsistency với I18n.init()
    // dùng browser locale → modal active='vi' nhưng UI render 'en'.
    const syncActiveLang = () => {
      const currentLang = window.I18n?.getLocale?.() || 'vi';
      languageOptions.forEach(opt => {
        opt.classList.toggle('active', opt.dataset.lang === currentLang);
      });
    };
    syncActiveLang();
    // Re-sync khi locale đổi từ nơi khác (modal khác, settings, etc)
    window.eventBus?.on('i18n:changed', syncActiveLang);
  }

  // ===== Referral UI (G6) =====
  function setupReferralUI() {
    const referralSection = document.getElementById('referralSection');
    if (!referralSection) return;

    const codeValue = document.getElementById('referralCodeValue');
    const copyBtn = document.getElementById('referralCopyBtn');
    const shareBtn = document.getElementById('referralShareBtn');
    const registeredEl = document.getElementById('referralRegistered');
    const convertedEl = document.getElementById('referralConverted');

    async function loadReferralData() {
      if (!window.authManager?.isLoggedIn()) return;

      try {
        // Fetch referral code
        const codeData = await window.authManager._apiCall('GET', 'referral/code');
        if (codeData?.referral_code && codeValue) {
          codeValue.textContent = codeData.referral_code;
        }

        // Fetch referral stats
        const statsData = await window.authManager._apiCall('GET', 'referral/stats');
        if (statsData) {
          if (registeredEl) registeredEl.textContent = window.I18n?.t('user.referralStats', { count: statsData.total_registered || 0 }) || `${statsData.total_registered || 0} đã đăng ký`;
          if (convertedEl) convertedEl.textContent = window.I18n?.t('user.referralConverted', { count: statsData.total_converted || 0 }) || `${statsData.total_converted || 0} đã nâng cấp`;
        }
      } catch (e) {
        console.warn('[TobyFlow] Failed to load referral data:', e);
      }
    }

    // Copy referral code
    if (copyBtn) {
      copyBtn.addEventListener('click', async () => {
        const code = codeValue?.textContent;
        if (!code || code === '---') return;
        try {
          await navigator.clipboard.writeText(code);
          copyBtn.title = window.I18n?.t('msg.copySuccess') || 'Đã sao chép!';
          setTimeout(() => { copyBtn.title = window.I18n?.t('app.copyCode') || 'Sao chép mã'; }, 2000);
        } catch (e) {
          console.warn('[TobyFlow] Clipboard write failed:', e);
        }
      });
    }

    // Share referral
    if (shareBtn) {
      shareBtn.addEventListener('click', async () => {
        const code = codeValue?.textContent;
        if (!code || code === '---') return;
        const shareText = window.I18n?.t('app.shareReferralText', { code }) || `Dùng thử Toby Flow! Dùng mã giới thiệu của mình: ${code}`;
        if (navigator.share) {
          try {
            await navigator.share({ title: 'Toby Flow', text: shareText });
          } catch (e) {
            // User cancelled share
          }
        } else {
          try {
            await navigator.clipboard.writeText(shareText);
            shareBtn.title = window.I18n?.t('app.linkCopied') || 'Đã sao chép link!';
            setTimeout(() => { shareBtn.title = window.I18n?.t('common.share') || 'Chia sẻ'; }, 2000);
          } catch (e) {
            console.warn('[TobyFlow] Clipboard write failed:', e);
          }
        }
      });
    }

    // Load on auth change
    if (window.eventBus) {
      window.eventBus.on('auth:login', () => loadReferralData());
    }

    // Initial load
    loadReferralData();
  }

  function setupConversionTriggers() {
    if (!window.eventBus) return;

    const toastEl = document.getElementById('conversionToast');
    const toastMsg = document.getElementById('conversionToastMsg');
    const toastUpgradeBtn = document.getElementById('conversionToastUpgradeBtn');
    const toastCloseBtn = document.getElementById('conversionToastCloseBtn');

    let toastTimer = null;

    function showUpgradeOverlay() {
      if (typeof window.openUpgradeModal === 'function') {
        window.openUpgradeModal();
      }
    }

    function showToast(message) {
      if (!toastEl || !toastMsg) return;
      if (toastTimer) clearTimeout(toastTimer);
      toastMsg.textContent = message;
      toastEl.classList.remove('hidden');
      // Auto-dismiss after 8s
      toastTimer = setTimeout(() => {
        toastEl.classList.add('hidden');
      }, 8000);
    }

    function hideToast() {
      if (toastEl) toastEl.classList.add('hidden');
      if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
    }

    // Expose showToast globally for SSE handlers and other modules
    window.showToast = showToast;

    // Inline nudge for locked features
    window.eventBus.on('feature:locked', (data) => {
      const featureName = data?.feature || '';
      log('Feature locked:', featureName);

      // Insert inline nudge near the locked element if a container is provided
      if (data?.container && data.container instanceof HTMLElement) {
        const existing = data.container.querySelector('.tobyflow-conversion-inline-nudge');
        if (existing) return;

        const nudge = document.createElement('div');
        nudge.className = 'tobyflow-conversion-inline-nudge';
        nudge.innerHTML = `
          <div class="tobyflow-conversion-inline-nudge__icon">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
              <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
            </svg>
          </div>
          <span class="tobyflow-conversion-inline-nudge__text">${window.I18n?.t('upgrade.unlockFeature') || 'Nâng cấp để mở khóa tính năng này'}</span>
          <button class="btn btn-primary btn-sm tobyflow-conversion-inline-nudge__btn">${window.I18n?.t('common.upgrade') || 'Nâng cấp'}</button>
        `;
        nudge.querySelector('.tobyflow-conversion-inline-nudge__btn').addEventListener('click', showUpgradeOverlay);
        data.container.prepend(nudge);
      } else {
        // Fallback: show toast if no container context
        showToast(window.I18n?.t('msg.upgradeRequired') || 'Tính năng này yêu cầu nâng cấp tài khoản.');
      }
    });

    // Toast for quota exceeded
    window.eventBus.on('quota:exceeded', (data) => {
      log('Quota exceeded:', data?.quota);
      showToast(window.I18n?.t('msg.quotaExhausted') || 'Bạn đã hết lượt sử dụng hôm nay. Nâng cấp để không giới hạn');
    });

    // GP-6.3: Toast warning khi global quota còn <10%
    window.eventBus.on('quota:warning', (data) => {
      const remaining = data?.remaining ?? 0;
      const limit = data?.limit ?? 0;
      log('Quota warning:', remaining, '/', limit, 'remaining');
      showToast(window.I18n?.t('app.quotaWarning', { remaining, limit }) || `Còn ${remaining}/${limit} lượt prompt hôm nay. Nâng cấp để không giới hạn`);
    });

    // GP-6.4: Dialog khi global quota đã hết (exhausted)
    window.eventBus.on('quota:exhausted', (data) => {
      const limit = data?.limit ?? 0;
      const module = data?.module || 'Generate';
      log('Quota exhausted:', limit, 'limit for', module);

      if (window.customDialog) {
        // SS: Check show_upgrade_ui để quyết định hiển thị nút nào
        const showUpgrade = window.SystemConfig?.getBool('show_upgrade_ui') !== false;
        const contactUrl = window.SystemConfig?.get('upgrade_contact_url', '');

        // Build buttons based on show_upgrade_ui setting
        const buttons = [
          { label: window.I18n?.t('common.close') || 'Đóng', primary: false, action: () => {} }
        ];

        if (showUpgrade) {
          // Show_upgrade_ui ON: hiện nút "Nâng cấp ngay"
          buttons.push({
            label: window.I18n?.t('upgrade.upgradeNow') || 'Nâng cấp ngay',
            primary: true,
            action: () => {
              showUpgradeOverlay();
            }
          });
        } else if (contactUrl) {
          // Show_upgrade_ui OFF nhưng có contact URL: hiện nút "Liên hệ"
          buttons.push({
            label: window.I18n?.t('overlay.contact') || 'Liên hệ',
            primary: true,
            action: () => {
              window.open(contactUrl, '_blank');
            }
          });
        }
        // Nếu show_upgrade_ui OFF và không có contactUrl: chỉ có nút "Đóng"

        window.customDialog.alert(
          `<div style="line-height:1.6">
            <p>${window.I18n?.t('app.quotaExhaustedMsg', { limit }) || `Bạn đã sử dụng hết <strong>${limit} lượt prompt</strong> hôm nay.`}</p>
            <p style="margin-top:12px;color:var(--muted-foreground)">${showUpgrade ? (window.I18n?.t('app.upgradeForUnlimited') || 'Nâng cấp lên gói Premium để nhận không giới hạn lượt prompt mỗi ngày và nhiều tính năng khác.') : (window.I18n?.t('app.contactAdminUpgrade') || 'Vui lòng liên hệ admin để nâng cấp gói.')}</p>
          </div>`,
          {
            title: window.I18n?.t('msg.globalQuotaExhausted') || 'Đã hết lượt prompt hôm nay',
            type: 'warning',
            html: true,
            buttons
          }
        );
      }
    });

    // Toast upgrade button -> open upgrade modal
    if (toastUpgradeBtn) {
      toastUpgradeBtn.addEventListener('click', () => {
        hideToast();
        showUpgradeOverlay();
      });
    }

    // Toast close button
    if (toastCloseBtn) {
      toastCloseBtn.addEventListener('click', hideToast);
    }

    // Upload failed notification — show toast + log to Logs tab
    window.eventBus?.on('upload:failed', (data) => {
      const errorMsg = data?.error || 'Unknown error';
      const shortKey = data?.key ? data.key.substring(0, 15) + '...' : '';
      const displayMsg = window.I18n?.t('msg.uploadFailed', { error: errorMsg }) || `Upload thất bại: ${errorMsg}`;
      showToast(displayMsg);
      if (typeof sendLog === 'function') {
        sendLog(`[Upload] ${shortKey ? shortKey + ' — ' : ''}${errorMsg}`, 'error');
      }
    });
  }

  // Export for external access
  window.TobyFlowApp = {
    init,
    initializeTab,
    loadCSS,
    loadJS
  };

  // Do NOT auto-init here - content.js will call TobyFlowApp.init()
  // after sidebar HTML is injected into the page

})();
