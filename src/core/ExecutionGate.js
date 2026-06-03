/**
 * ExecutionGate -- Server-side execution permission & token management
 * Moi lan thuc thi (generate, task, workflow, angles) phai xin phep server truoc.
 * Server cap token 1 lan dung, het han sau 5 phut.
 *
 * Fallback: khi server khong kha dung, dung FeatureGate client-side check (nhu cu).
 */
class ExecutionGate {
  static _REQUEST_TIMEOUT = 5000; // 5s timeout cho server call
  static _activeTokens = new Map(); // Track active tokens for cleanup on unload

  /**
   * Xin phep server truoc khi chay
   * @param {string} action - 'generate'|'task_run'|'workflow_run'|'angles_run'
   * @param {number} promptCount - so prompt can chay
   * @param {object} metadata - { owner, label }
   * @returns {Promise<{ allowed: boolean, token?: string, remaining?: number, reason?: string }>}
   */
  static async request(action, promptCount = 1, metadata = {}) {
    return {
      allowed: true,
      token: 'dev-token-123',
      remaining: 999,
      limit: 999,
      used: 0,
      global_remaining: 999,
      global_limit: 999,
      global_used: 0,
      prompt_count: promptCount,
      reason: 'SERVER_APPROVED'
    };
  }

  /**
   * Bao ket qua sau khi chay xong.
   * Sau khi bao server, refresh FeatureGate de lay remaining chinh xac.
   *
   * @param {string} token - execution token from request()
   * @param {string} status - 'success'|'failed'|'partial'
   * @param {object} resultData - { tile_count, error }
   */
  static async complete(token, status = 'success', resultData = {}) {
    // Token null = caller chua xin token (e.g. anonymous user, hoac request() fail) —
    // van refresh FeatureGate de sync entitlements voi server.
    if (!token) {
      this._refreshFeatureGate();
      return;
    }

    // Bug 48 fix (2026-05-13): Idempotent — nếu token đã completed (e.g. adapter + executor
    // cùng catch error rồi call complete), bỏ qua call thứ 2 để tránh duplicate
    // POST /execution/complete + duplicate FeatureGate refresh.
    if (!this._activeTokens.has(token)) {
      console.log('[ExecutionGate] complete: token already completed, skip duplicate', token);
      return;
    }

    // Remove from active tracking
    this._activeTokens.delete(token);

    // Non-blocking: fire and forget, refresh FeatureGate sau khi hoan thanh
    this._apiCall('POST', 'execution/complete', {
      token,
      status,
      result_data: Object.keys(resultData).length > 0 ? resultData : undefined,
    }).then(() => {
      console.log('[ExecutionGate] complete:', token, status);
      this._refreshFeatureGate();
    }).catch((err) => {
      console.error('[ExecutionGate] complete failed (non-blocking):', err.message);
      // Van refresh de sync trang thai
      this._refreshFeatureGate();
    });
  }

  /**
   * Huy token khi user stop/cancel truoc khi chay xong.
   * Server se rollback quota, refresh FeatureGate de sync.
   *
   * @param {string} token
   */
  static async cancel(token) {
    // Token null = caller chua xin token, khong can bao server (no-op).
    if (!token) return;

    // Remove from active tracking
    this._activeTokens.delete(token);

    // Non-blocking: fire and forget, refresh FeatureGate sau khi cancel
    this._apiCall('POST', 'execution/cancel', {
      token,
    }).then(() => {
      console.log('[ExecutionGate] cancel:', token);
      // Server da rollback quota, refresh de sync remaining
      this._refreshFeatureGate();
    }).catch((err) => {
      console.error('[ExecutionGate] cancel failed (non-blocking):', err.message);
      this._refreshFeatureGate();
    });
  }

  /**
   * Bug 54 fix (2026-05-13): Cancel TẤT CẢ active tokens — dùng cho forceStop.
   * Trước fix: ExecutionTracker._handleStop chỉ cancel `_currentTaskExecutionToken`.
   * Workflow execution dùng per-node tokens (cgToken/grokToken local trong
   * WorkflowExecutor) → không cancel được → quota vẫn hold ở server.
   * Sau fix: clear hết Map _activeTokens, server rollback quota.
   *
   * @returns {number} count of tokens cancelled
   */
  static async cancelAll() {
    const tokens = Array.from(this._activeTokens.keys());
    if (tokens.length === 0) return 0;
    console.log('[ExecutionGate] cancelAll:', tokens.length, 'active tokens');
    for (const token of tokens) {
      // Fire-and-forget; cancel() đã handle non-blocking + remove từ Map
      this.cancel(token).catch(() => {});
    }
    return tokens.length;
  }

  /**
   * Fallback khi server khong kha dung
   * Dung FeatureGate client-side check (FAIL-CLOSED: deny if cache too stale)
   *
   * SECURITY: Fallback phải là fail-closed để tránh:
   * - User vượt quota khi server down
   * - Drift lớn giữa local vs server usage
   *
   * [Audit Bug 4 fix 2026-06-22] Strict Server-Only: TTL 60s thay vì 1h.
   * Trước fix: cache 1h cho phép user offline lâu → vượt quota thật + pending sync FIFO overflow.
   * Sau fix: chỉ allow trong jitter window 60s (server vừa blip ngắn) — khớp Server-Only spec.
   * CLAUDE.md anti-pattern #4: "Cho phép dùng feature khi offline → Block UI, hiện overlay".
   */
  static _fallbackCheck(action, promptCount, metadata = {}) {
    const featureKeyMap = {
      generate: 'gen_run_max',           // Legacy: backward compatible
      generate_flow: 'gen_run_max',      // Flow provider
      generate_chatgpt: 'chatgpt_run_max', // ChatGPT provider
      generate_grok: 'grok_run_max',     // Grok provider
      task_run: 'tasks_run_max',
      workflow_run: 'workflows_run_max',
      angles_run: 'angles_run_max',
      effects_run: 'effects_run_max',
    };

    const featureKey = featureKeyMap[action];
    // [Audit Bug 4 fix] 60s = jitter window cho transient blip (DNS, single failed packet).
    // Trước fix: 1h → user offline cả tiếng vẫn pass → drift quota nghiêm trọng.
    const OFFLINE_CACHE_TTL = 60 * 1000; // 60s - chỉ cover jitter, không cover offline thật

    // FAIL-CLOSED: Kiểm tra cache có hợp lệ không
    const fg = window.featureGate;
    const cacheAge = fg?.lastFetch ? (Date.now() - fg.lastFetch) : Infinity;

    // Nếu cache quá cũ (> 60s) hoặc không có → DENY (fail-closed)
    if (cacheAge > OFFLINE_CACHE_TTL) {
      console.warn('[ExecutionGate] fallback DENIED (strict server-only): cache age ' + Math.round(cacheAge / 1000) + 's > 60s threshold');
      return {
        allowed: false,
        token: null,
        reason: 'OFFLINE_CACHE_STALE',
        prompt_count: promptCount,
      };
    }

    // FeatureGate có cache nhưng không có quota info → DENY
    const quota = fg?.checkQuota(featureKey);
    if (!quota) {
      console.warn('[ExecutionGate] fallback DENIED: no quota info for', featureKey, '- fail-closed');
      return {
        allowed: false,
        token: null,
        reason: 'OFFLINE_NO_QUOTA_INFO',
        prompt_count: promptCount,
      };
    }

    // Kiem tra quota co cho phep khong
    // quota.allowed co the la true/false/undefined
    const moduleAllowed = quota.allowed !== false;

    // GP-5: ALSO check global prompt_submit_max in fallback mode
    // Module quota OK but global quota exhausted → DENY
    const globalQuota = fg?.checkQuota?.('prompt_submit_max');
    if (globalQuota && globalQuota.allowed === false) {
      console.warn('[ExecutionGate] fallback DENIED: global prompt_submit_max exhausted');
      return {
        allowed: false,
        token: null,
        reason: 'GLOBAL_QUOTA_EXCEEDED',
        prompt_count: promptCount,
        global_remaining: globalQuota.remaining,
        global_limit: globalQuota.limit,
        global_used: globalQuota.used,
      };
    }

    const allowed = moduleAllowed;

    console.log('[ExecutionGate] fallback:', featureKey, '- allowed:', allowed, ', remaining:', quota.remaining);

    // UA-5: Khi fallback xảy ra và được phép, lưu execution để sync sau
    if (allowed) {
      try {
        chrome.storage.local.get(['af_pending_sync'], (res) => {
          const pending = res.af_pending_sync || [];
          pending.push({
            action,
            prompt_count: promptCount,
            timestamp: new Date().toISOString(),
            owner: metadata?.owner || null,
            label: metadata?.label || null,
          });
          // Max 100 items (FIFO)
          if (pending.length > 100) pending.splice(0, pending.length - 100);
          chrome.storage.local.set({ af_pending_sync: pending });
        });
      } catch (e) {
        // Ignore storage errors during fallback
      }
    }

    return {
      allowed,
      token: null,
      reason: allowed ? 'OFFLINE_FALLBACK' : 'QUOTA_EXCEEDED',
      remaining: typeof quota.remaining === 'number' ? quota.remaining : undefined,
      limit: typeof quota.limit === 'number' ? quota.limit : undefined,
      used: typeof quota.used === 'number' ? quota.used : undefined,
      // GP-7.5: Truyền prompt_count để showDeniedDialog hiển thị thông báo rõ ràng
      prompt_count: promptCount,
    };
  }

  /**
   * API call ho tro ca anonymous va logged-in
   * Boc trong Promise.race voi timeout de dam bao khong treo
   */
  static _apiCall(method, endpoint, data) {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error('Request timeout after ' + this._REQUEST_TIMEOUT + 'ms'));
      }, this._REQUEST_TIMEOUT);

      const done = (fn, val) => {
        clearTimeout(timeoutId);
        fn(val);
      };

      if (window.authManager?.isLoggedIn()) {
        window.authManager._apiCall(method, endpoint, data)
          .then(res => done(resolve, res))
          .catch(err => done(reject, err));
        return;
      }

      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage({
          action: 'apiRequest',
          method,
          endpoint,
          data,
        }, (resp) => {
          if (chrome.runtime.lastError) {
            done(reject, new Error(chrome.runtime.lastError.message));
            return;
          }
          if (resp?.success) {
            if (resp.meta) {
              done(resolve, { data: resp.data, meta: resp.meta });
            } else {
              done(resolve, resp.data);
            }
          } else {
            // Tao error voi code va serverData de request() xu ly dung
            const err = new Error(resp?.error?.message || 'API request failed');
            err.code = resp?.error?.code || null;
            err.serverData = resp?.data || {};
            done(reject, err);
          }
        });
      } else {
        done(reject, new Error('No API transport available'));
      }
    });
  }

  /**
   * Hiển thị dialog khi server từ chối (QUOTA_EXCEEDED, GLOBAL_QUOTA_EXCEEDED, MODULE_DISABLED...)
   * Dùng chung cho tất cả callers để đảm bảo UI nhất quán.
   * @param {object} gate - kết quả từ request()
   * @param {string} moduleName - tên module hiển thị (vd: 'Generate', 'Task', 'Workflow')
   */
  static showDeniedDialog(gate, moduleName = '') {
    const Dialog = window.customDialog;
    if (!Dialog) return;

    // SS: Check show_upgrade_ui để quyết định hiển thị nút nào
    const showUpgrade = window.SystemConfig?.getBool('show_upgrade_ui') !== false;
    const contactUrl = window.SystemConfig?.get('upgrade_contact_url', '');

    // Build upgrade action button based on settings
    const getUpgradeButton = () => {
      if (showUpgrade) {
        return {
          label: window.I18n?.t('gate.upgradeNow') || 'Nâng cấp ngay',
          primary: true,
          action: () => {
            // Sidebar context: call directly
            if (typeof window.openUpgradeModal === 'function') {
              window.openUpgradeModal();
            } else {
              // Popup context: send message to sidebar
              chrome.runtime.sendMessage({ action: 'showUpgradeModal' }).catch(() => {});
            }
          }
        };
      } else if (contactUrl) {
        return {
          label: window.I18n?.t('gate.contact') || 'Liên hệ',
          primary: true,
          action: () => {
            window.open(contactUrl, '_blank');
          }
        };
      }
      return null;
    };

    const buildButtons = () => {
      const buttons = [{ label: window.I18n?.t('common.close') || 'Đóng', primary: false, action: () => {} }];
      const upgradeBtn = getUpgradeButton();
      if (upgradeBtn) buttons.push(upgradeBtn);
      return buttons;
    };

    // GP-4.3: Hiển thị thông báo riêng cho GLOBAL_QUOTA_EXCEEDED
    // GP-8: Global quota check promptCount, có thể "không đủ lượt" nếu remaining > 0 nhưng < promptCount
    if (gate.reason === 'GLOBAL_QUOTA_EXCEEDED') {
      const globalLimit = gate.global_limit ?? gate.limit ?? '?';
      const globalUsed = gate.global_used ?? gate.used ?? '?';
      const globalRemaining = (typeof globalLimit === 'number' && typeof globalUsed === 'number') ? (globalLimit - globalUsed) : null;
      const promptCount = gate.prompt_count ?? gate.promptCount ?? null;

      let message;
      let title;
      // GP-8: Phân biệt "hết prompt" vs "không đủ prompt cho batch"
      if (globalRemaining !== null && globalRemaining > 0 && promptCount !== null && promptCount > globalRemaining) {
        // Còn prompt nhưng không đủ cho số prompts yêu cầu
        title = window.I18n?.t('gate.insufficientQuotaTitle') || 'Không đủ quota prompt';
        message = (window.I18n?.t('gate.insufficientQuotaMsg', { promptCount, globalRemaining, globalLimit, globalUsed }) || `Tác vụ cần ${promptCount} prompt nhưng chỉ còn ${globalRemaining} prompt.\n\nGiới hạn: ${globalLimit} prompt/ngày\nĐã dùng: ${globalUsed} prompt\nCòn lại: ${globalRemaining} prompt`) + '\n\n' +
          (showUpgrade ? (window.I18n?.t('gate.insufficientQuotaUpgrade') || 'Giảm số prompt hoặc nâng cấp gói để tăng giới hạn.') : (window.I18n?.t('gate.insufficientQuotaContact') || 'Giảm số prompt hoặc liên hệ admin để tăng giới hạn.'));
      } else {
        // Hết prompt hoàn toàn
        title = window.I18n?.t('gate.dailyQuotaExhaustedTitle') || 'Hết quota prompt hàng ngày';
        message = (window.I18n?.t('gate.dailyQuotaExhaustedMsg', { globalLimit, globalUsed }) || `Bạn đã sử dụng hết ${globalLimit} prompt trong ngày.\n\nĐã dùng: ${globalUsed}/${globalLimit} prompt`) + '\n\n' +
          (window.I18n?.t('gate.dailyQuotaGlobalNote') || 'Global quota áp dụng cho tất cả tính năng (Generate, Task, Workflow, Angles, Effects).') + '\n\n' +
          (showUpgrade ? (window.I18n?.t('gate.dailyQuotaUpgrade') || 'Nâng cấp gói để có thêm quota.') : (window.I18n?.t('gate.dailyQuotaContact') || 'Vui lòng liên hệ admin để nâng cấp.'));
      }
      Dialog.alert(message, { title, type: 'warning', buttons: buildButtons() });
    } else if (gate.reason === 'QUOTA_EXCEEDED') {
      // GP-8: Module quota (*_run_max) chỉ đếm số lần RUN, không check promptCount
      // QUOTA_EXCEEDED cho module chỉ xảy ra khi remaining < 1 (hết lượt hoàn toàn)
      const limit = gate.limit ?? '?';
      const used = gate.used ?? '?';

      const title = window.I18n?.t('gate.usageLimitTitle') || 'Hết lượt sử dụng';
      const message = (window.I18n?.t('gate.usageLimitMsg', { moduleName: moduleName || '', limit, used }) || `Đã hết lượt sử dụng${moduleName ? ' ' + moduleName : ''} hôm nay.\n\nGiới hạn: ${limit} lượt/ngày\nĐã dùng: ${used} lượt`) + '\n\n' +
        (showUpgrade ? (window.I18n?.t('gate.usageLimitUpgrade') || 'Nâng cấp gói để tăng giới hạn.') : (window.I18n?.t('gate.usageLimitContact') || 'Vui lòng liên hệ admin để tăng giới hạn.'));
      Dialog.alert(message, { title, type: 'warning', buttons: buildButtons() });
    } else if (gate.reason === 'MODULE_DISABLED' || gate.reason === 'FEATURE_LOCKED') {
      Dialog.alert(
        (window.I18n?.t('gate.featureLockedMsg', { moduleName: moduleName || '' }) || `Tính năng${moduleName ? ' ' + moduleName : ''} bị khóa cho gói hiện tại.`) + '\n\n' +
        (showUpgrade ? (window.I18n?.t('gate.featureLockedUpgrade') || 'Nâng cấp gói để sử dụng tính năng này.') : (window.I18n?.t('gate.featureLockedContact') || 'Vui lòng liên hệ admin để mở khóa.')),
        { title: window.I18n?.t('gate.featureLockedTitle') || 'Tính năng bị khóa', type: 'warning', buttons: buildButtons() }
      );
    } else {
      Dialog.alert(
        (window.I18n?.t('gate.notAllowedMsg', { moduleName: moduleName || '' }) || `Không được phép chạy${moduleName ? ' ' + moduleName : ''}.`) + '\n' +
        (gate.reason || ''),
        { title: window.I18n?.t('gate.notAllowedTitle') || 'Không thể thực hiện', type: 'warning' }
      );
    }
  }

  /**
   * Refresh FeatureGate de lay remaining chinh xac tu server.
   * Non-blocking, goi sau khi execution hoan thanh hoac huy.
   *
   * [API SPAM FIX — Phase 3.3] Skip refresh nếu vừa refresh < 30s.
   * Lý do: chạy nhiều workflow liên tiếp (vd batch run) → mỗi workflow gọi
   * complete() → refresh FeatureGate → spam GET /quotas/current. Throttle 30s
   * đủ cho user thấy quota update kịp thời + giảm load backend.
   */
  static _refreshFeatureGate() {
    if (!window.featureGate || typeof window.featureGate.refresh !== 'function') return;
    const now = Date.now();
    const lastRefresh = ExecutionGate._lastFeatureGateRefreshAt || 0;
    if (now - lastRefresh < 30 * 1000) {
      console.log('[ExecutionGate] Skip FeatureGate refresh (vừa refresh ' + Math.round((now - lastRefresh) / 1000) + 's trước)');
      return;
    }
    ExecutionGate._lastFeatureGateRefreshAt = now;
    window.featureGate.refresh().catch((err) => {
      console.warn('[ExecutionGate] FeatureGate refresh failed:', err.message);
      // Reset timestamp on fail để cho lần sau có thể retry
      ExecutionGate._lastFeatureGateRefreshAt = 0;
    });
  }

  /**
   * Auto-cancel active tokens khi window unload (tab close, navigate away)
   * Goi 1 lan khi load file
   */
  static _initCleanup() {
    if (typeof window === 'undefined') return;
    window.addEventListener('unload', () => {
      for (const [token] of this._activeTokens) {
        try {
          const baseUrl = window.authManager?.apiBaseUrl;
          const authToken = window.authManager?.token;
          if (baseUrl && authToken) {
            const url = baseUrl + '/execution/cancel';
            const body = JSON.stringify({ token });
            try {
              fetch(url, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': 'Bearer ' + authToken,
                },
                body,
                keepalive: true,
              }).catch(() => {});
            } catch (_fetchErr) {
              if (navigator.sendBeacon) {
                const blob = new Blob([body], { type: 'application/json' });
                navigator.sendBeacon(url, blob);
              }
            }
          } else if (navigator.sendBeacon && baseUrl) {
            const url = baseUrl + '/execution/cancel';
            const blob = new Blob(
              [JSON.stringify({ token })],
              { type: 'application/json' }
            );
            navigator.sendBeacon(url, blob);
          }
        } catch (e) {
          // Ignore errors during unload
        }
      }
      this._activeTokens.clear();
    });
  }
}

// Init cleanup listener
ExecutionGate._initCleanup();

window.ExecutionGate = ExecutionGate;
