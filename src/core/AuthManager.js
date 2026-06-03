/**
 * AuthManager - Quản lý xác thực cho extension
 * Lưu token trong chrome.storage.local (key: af_auth)
 * Gọi API qua background.js proxy (CORS-free)
 */
class AuthManager {
  constructor() {
    this.user = null;
    this.token = null;
    // Phase 6 Bug N.3: Centralize URL via ApiBaseConfig.DEFAULT (single source of truth).
    this.apiBaseUrl = (typeof window !== 'undefined' && window.ApiBaseConfig)
      ? window.ApiBaseConfig.DEFAULT
      : 'http://localhost:3000/api/v1';
    this.isInitialized = false;
    this._refreshing = false;
    this._rateLimitedUntil = 0;
    this._sessionInvalid = false;
    this._isLoggingOut = false;
    this._isLoggingOut = false;
    // Initialize promise so other modules can await AuthManager initialization even before init() is called
    this._initPromise = new Promise(resolve => {
      this._resolveInit = resolve;
    });
  }

  /**
   * Khởi tạo: load token + user đã lưu từ chrome.storage.local
   */
  async init() {
    // If init has already completed or is running without _resolveInit, return
    if (this.isInitialized) return this._initPromise;
    
    // Start initialization process
    (async () => {
      try {
      const stored = await new Promise(resolve => {
        chrome.storage.local.get(['af_auth'], result => {
          resolve(result.af_auth || null);
        });
      });

      if (stored) {
        this.token = stored.token || null;
        this.user = stored.user || null;
        if (stored.apiBaseUrl) {
          this.apiBaseUrl = stored.apiBaseUrl;
        }

        // [Fix workflow popup] Popup context TRUST sidePanel's auth state.
        // Không verify token với server (fetchUser/refreshToken) vì:
        //   1. SidePanel đã verify rồi, popup verify lại là redundant
        //   2. Nếu tạm lỗi network/server → popup clear token → trial mode →
        //      hiển thị "Đã hết lượt dùng thử" sai
        //   3. Nếu token THỰC SỰ expired, sidePanel sẽ detect + sync via storage
        // Popup's API calls sau này nếu fail, user sẽ biết.
        const isPopupWindow = !!(window.location.pathname.endsWith('workflow-editor.html') ||
                                 window.location.pathname.endsWith('angles-editor.html') ||
                                 window.location.pathname.endsWith('effects-editor.html') ||
                                 window.location.pathname.endsWith('settings.html'));

        // Xác minh token còn hiệu lực (CHỈ SidePanel, không popup)
        if (this.token && !isPopupWindow) {
          try {
            await this.fetchUser();
            console.log('[TobyFlow] AuthManager: Phiên đăng nhập được khôi phục');
            // [Audit Bug 1 fix] Emit auth:restored để StorageSettings (auto-init constructor
            // chạy trước authManager.init()) fetch user settings từ server.
            // auth:login chỉ emit khi explicit login/register, KHÔNG emit khi cold-restore.
            if (window.eventBus) {
              window.eventBus.emit('auth:restored', { user: this.user });
            }
          } catch (err) {
            // 429 = rate limited, không phải auth error → giữ token, skip verify
            if (err.httpStatus === 429 || err.code === 'RATE_LIMITED') {
              console.warn('[TobyFlow] AuthManager: Rate limited khi verify token, giữ session');
            } else if (err.code === 'EXTENSION_NOT_AUTHORIZED') {
              // Anti-clone reject — KHÔNG phải token expired. Giữ token, overlay sẽ tự
              // hide khi admin fix whitelist (qua background self-heal probe).
              console.warn('[TobyFlow] AuthManager: Extension not authorized — giữ session, đợi overlay self-heal');
            } else {
              console.warn('[TobyFlow] AuthManager: Token hết hạn, thử làm mới');
              try {
                await this.refreshToken();
              } catch (refreshErr) {
                // 429 khi refresh cũng không logout
                if (refreshErr.httpStatus === 429 || refreshErr.code === 'RATE_LIMITED') {
                  console.warn('[TobyFlow] AuthManager: Rate limited khi refresh, giữ session');
                } else if (refreshErr.code === 'EXTENSION_NOT_AUTHORIZED') {
                  console.warn('[TobyFlow] AuthManager: Refresh blocked by anti-clone — giữ session, đợi overlay self-heal');
                } else {
                  console.warn('[TobyFlow] AuthManager: Không thể làm mới token, đăng xuất');
                  await this._clearAuth();
                }
              }
            }
          }
        } else if (this.token && isPopupWindow) {
          console.log('[TobyFlow] AuthManager: Popup context — skip server verify, trust sidePanel state');
        }
      }

      this.isInitialized = true;
      console.log('[TobyFlow] AuthManager: Đã khởi tạo, đăng nhập:', this.isLoggedIn());
    } catch (err) {
      console.error('[TobyFlow] AuthManager: Lỗi khởi tạo', err);
      this.isInitialized = true;
    } finally {
      if (this._resolveInit) {
        this._resolveInit();
        this._resolveInit = null;
      }
    }
    })();
    return this._initPromise;
  }

  /**
   * Đăng nhập bằng email + mật khẩu
   */
  async login(email, password) {
    // [Fix switch user] Clear token TRƯỚC khi gọi login API
    // Tránh gửi token cũ (có thể đã bị invalidate) kèm request login.
    // Bug fix 2026-05-22: đặt NGOÀI try để catch block reference được (let/const trong try
    // không hoist sang catch scope → ReferenceError "oldToken is not defined" khi login fail).
    const oldToken = this.token;
    try {
      // Nếu đang có user khác login, xóa SSE session của họ trước
      // PHẢI await để đảm bảo session cũ được xóa trước khi login mới
      if (this.token && this.user) {
        try {
          await this._apiCall('POST', 'sse/end-session');
          console.log('[TobyFlow] AuthManager: SSE session cũ đã được xóa');
        } catch (sseErr) {
          // Silent fail
          console.warn('[TobyFlow] AuthManager: Không thể xóa SSE session cũ', sseErr.message);
        }
      }

      this.token = null;

      // Gửi X-Fingerprint header để backend dispatch MigrateAnonymousUsageJob
      // → migrate AnonymousUsage 30 ngày qua thành UsageRecord cho user_id mới.
      const fingerprint = await this._getStoredFingerprint();
      const headers = fingerprint ? { 'X-Fingerprint': fingerprint } : null;
      const response = await this._apiCall('POST', 'auth/login', { email, password }, false, headers);
      const { token, user } = response;

      if (!token) {
        throw new Error(window.I18n?.t('auth.loginNoToken') || 'Phản hồi đăng nhập không chứa token');
      }

      this.token = token;
      this.user = user;
      await this._saveAuth(token, user);

      console.log('[TobyFlow] AuthManager: Đăng nhập thành công -', user?.email);

      // [Fix login] Dùng resetForLogin() thay vì refresh() để tránh race condition với
      // background fetch anonymous đang chạy từ init (refresh() có dedup sẽ return
      // Promise cũ fetch anonymous → entitlements sai plan → overlay "Tính năng bị khóa").
      if (window.featureGate) {
        try {
          await window.featureGate.resetForLogin();
          console.log('[TobyFlow] AuthManager: Entitlements refreshed sau login, plan:', window.featureGate.plan?.slug);
        } catch (e) {
          console.warn('[TobyFlow] AuthManager: Không thể refresh entitlements', e);
        }
      }

      if (window.eventBus) {
        window.eventBus.emit('auth:login', { user });
      }

      return { token, user };
    } catch (err) {
      // [Fix switch user] Khôi phục token cũ nếu login thất bại
      // để user có thể tiếp tục dùng session cũ
      if (oldToken) {
        this.token = oldToken;
      }
      console.error('[TobyFlow] AuthManager: Đăng nhập thất bại', err.message);
      throw err;
    }
  }

  /**
   * Đăng ký tài khoản mới
   */
  async register(name, email, password, passwordConfirmation) {
    // [Fix switch user] Clear token TRƯỚC khi gọi register API
    const oldToken = this.token;
    this.token = null;

    try {
      // Gửi X-Fingerprint header để backend dispatch MigrateAnonymousUsageJob (xem login)
      const fingerprint = await this._getStoredFingerprint();
      const headers = fingerprint ? { 'X-Fingerprint': fingerprint } : null;
      const response = await this._apiCall('POST', 'auth/register', {
        name,
        email,
        password,
        password_confirmation: passwordConfirmation
      }, false, headers);

      console.log('[TobyFlow] AuthManager: Đăng ký thành công -', email);

      // Nếu server trả về token luôn thì tự đăng nhập
      if (response.token) {
        this.token = response.token;
        this.user = response.user;
        await this._saveAuth(response.token, response.user);

        // [Fix login] Dùng resetForLogin() thay vì refresh() để fetch entitlements
        // với token mới (bypass dedup của refresh() vẫn bám vào fetch anonymous cũ).
        if (window.featureGate) {
          try {
            await window.featureGate.resetForLogin();
            console.log('[TobyFlow] AuthManager: Entitlements refreshed sau register, plan:', window.featureGate.plan?.slug);
          } catch (e) {
            console.warn('[TobyFlow] AuthManager: Không thể refresh entitlements', e);
          }
        }

        if (window.eventBus) {
          window.eventBus.emit('auth:login', { user: response.user });
        }
      }

      return response;
    } catch (err) {
      // [Fix switch user] Khôi phục token cũ nếu register thất bại
      if (oldToken) {
        this.token = oldToken;
      }
      console.error('[TobyFlow] AuthManager: Đăng ký thất bại', err.message);
      throw err;
    }
  }

  /**
   * Đăng xuất: gọi API + xóa dữ liệu local
   *
   * Thứ tự quan trọng để tránh race condition:
   *   1. Disconnect SSE client-side NGAY (tránh nhận 'entitlements_changed' của user cũ)
   *   2. Gọi API sse/end-session + auth/logout (server-side cleanup)
   *   3. Reset FeatureGate memory về _freeDefaults (trước khi clear storage)
   *   4. Clear storage (storage listener nhìn thấy featureGate đã reset)
   *   5. Emit auth:logout event
   */
  async logout() {
    // [Fix drift] Set flag _isLoggingOut NGAY ĐẦU (sync). Flag giữ suốt toàn bộ
    // logout flow cho đến khi mọi thứ (storage, memory, emit) hoàn tất để:
    //  1. Chặn SSE 'entitlements_changed' overwrite memory với user cũ
    //  2. Chặn polling _detectAndSyncAuthDrift hiểu nhầm là external login
    //     khi storage af_auth chưa kịp clear nhưng token memory đã null.
    if (window.featureGate) {
      window.featureGate._isLoggingOut = true;
    }
    // 2026-05-25: Set flag AuthManager-level NGAY đầu logout để 401 retry guard skip refresh.
    // Trước fix: in-flight 401 fire trong logout flow (giữa sse/end-session và _clearAuth) →
    // trigger refresh → fail → emit auth:logout cascade lần 2. _sessionInvalid set sau _clearAuth
    // nên không bắt được. Flag này riêng để cover cửa sổ giữa logout start và _clearAuth.
    this._isLoggingOut = true;

    try {

    // [Fix #1] Disconnect SSE ngay đầu — EventSource có thể còn event buffered trong pipe.
    if (window.SseClient?.disconnect) {
      try {
        window.SseClient.disconnect();
      } catch (sseDisconnectErr) {
        console.warn('[TobyFlow] AuthManager: Lỗi disconnect SSE', sseDisconnectErr.message);
      }
    }

    try {
      if (this.token) {
        // Xóa SSE session TRƯỚC khi logout - PHẢI await để đảm bảo request được gửi
        // trước khi token bị xóa
        console.log('[TobyFlow] AuthManager: Bắt đầu logout, gọi sse/end-session...');
        try {
          const sseResult = await this._apiCall('POST', 'sse/end-session');
          console.log('[TobyFlow] AuthManager: SSE session đã được xóa', sseResult);
        } catch (sseErr) {
          // Silent fail - có thể token đã hết hạn hoặc không có session
          console.warn('[TobyFlow] AuthManager: Không thể xóa SSE session', sseErr.message, sseErr);
        }

        console.log('[TobyFlow] AuthManager: Gọi auth/logout...');
        await this._apiCall('POST', 'auth/logout');
        console.log('[TobyFlow] AuthManager: auth/logout thành công');
      } else {
        console.log('[TobyFlow] AuthManager: Không có token, bỏ qua API calls');
      }
    } catch (err) {
      // Vẫn xóa local dù API lỗi
      console.warn('[TobyFlow] AuthManager: Lỗi khi gọi API đăng xuất', err.message);
    }

    const previousUser = this.user;

    // Clear token/user SYNC ngay.
    this.token = null;
    this.user = null;

    // Reset FeatureGate memory NGAY (sync) — tránh storage.onChanged listener đọc
    // entitlements cũ (free plan) rồi render footer sai.
    // resetForLogout() set _isLoggingOut=true bên trong (đã set trước ở đầu hàm logout()),
    // await fetch anonymous trial, và cuối cùng set _isLoggingOut=false.
    if (window.featureGate) {
      await window.featureGate.resetForLogout();
    }

    // Clear storage SAU khi memory đã reset. Listener storage.onChanged đọc memory
    // đã là _freeDefaults/anonymous → footer render đúng.
    await this._clearAuth();

    // [Fix cascade] Sau explicit logout: SET _sessionInvalid = true để chặn các
    // authenticated _apiCall còn race-firing từ UI event cascade (updateFooterUI,
    // featuregate:refreshed, entitlements:changed, ...). Tránh hammer backend với
    // token null → 401 → refresh fail → log spam "Session expired" 10+ lần.
    // Anonymous calls (FeatureGate qua chrome.runtime.sendMessage direct) KHÔNG
    // qua _apiCall nên không bị block. auth/login bypass flag để re-login OK.
    this._sessionInvalid = true;

    console.log('[TobyFlow] AuthManager: Đã đăng xuất');

    if (window.eventBus) {
      window.eventBus.emit('auth:logout', { user: previousUser });
    }

    } finally {
      // [Fix drift] Clear flag SAU CÙNG — giờ storage + memory đồng bộ (cả 2 null),
      // polling drift check sẽ không còn trigger sai nữa.
      if (window.featureGate) {
        window.featureGate._isLoggingOut = false;
      }
      // 2026-05-25: Clear AuthManager-level flag. _sessionInvalid vẫn = true để block
      // tiếp future calls cho đến khi user login lại (reset trong _saveAuth).
      this._isLoggingOut = false;
    }
  }

  /**
   * Làm mới token
   */
  async refreshToken() {
    if (this._refreshing) {
      // Tránh gọi refresh đồng thời nhiều lần — timeout 15s
      return new Promise((resolve, reject) => {
        let elapsed = 0;
        const checkInterval = setInterval(() => {
          elapsed += 100;
          if (!this._refreshing) {
            clearInterval(checkInterval);
            this.token ? resolve({ token: this.token }) : reject(new Error(window.I18n?.t('auth.refreshTokenFailed') || 'Làm mới token thất bại'));
          } else if (elapsed >= 15000) {
            clearInterval(checkInterval);
            reject(new Error(window.I18n?.t('auth.refreshTokenTimeout') || 'Làm mới token quá thời gian'));
          }
        }, 100);
      });
    }

    this._refreshing = true;

    try {
      const response = await this._apiCall('POST', 'auth/refresh');
      const { token } = response;

      if (!token) {
        throw new Error(window.I18n?.t('auth.refreshNoToken') || 'Phản hồi làm mới không chứa token');
      }

      this.token = token;
      if (response.user) {
        this.user = response.user;
      }
      await this._saveAuth(this.token, this.user);

      console.log('[TobyFlow] AuthManager: Token đã được làm mới');
      return { token };
    } catch (err) {
      console.error('[TobyFlow] AuthManager: Làm mới token thất bại', err.message);
      throw err;
    } finally {
      this._refreshing = false;
    }
  }

  /**
   * Lấy thông tin user hiện tại từ server
   */
  async fetchUser() {
    const oldPlanSlug = this.user?.plan_slug;
    const response = await this._apiCall('GET', 'auth/me');
    this.user = response.user || response;
    await this._saveAuth(this.token, this.user);

    // Detect plan change and emit event
    const newPlanSlug = this.user?.plan_slug;
    if (oldPlanSlug && newPlanSlug && oldPlanSlug !== newPlanSlug) {
      console.log(`[TobyFlow] Plan changed: ${oldPlanSlug} → ${newPlanSlug}`);
      if (window.eventBus) {
        window.eventBus.emit('plan:changed', {
          oldPlan: oldPlanSlug,
          newPlan: newPlanSlug
        });
      }
    }

    return this.user;
  }

  /**
   * Kiểm tra đã đăng nhập chưa
   */
  isLoggedIn() {
    return !!this.token;
  }

  /**
   * Lấy token hiện tại
   */
  getToken() {
    return this.token;
  }

  /**
   * Lấy thông tin user đã cache
   */
  getUser() {
    return this.user;
  }

  /**
   * Kiểm tra user hiện tại có phải là admin không
   * Hỗ trợ cả 2 format: role === 'admin' hoặc is_admin === true
   * @returns {boolean}
   */
  isAdmin() {
    return this.user?.role === 'admin' || this.user?.is_admin === true;
  }

  /**
   * Kiểm tra user có quyền quản lý templates (workflow templates, prompt templates, v.v.)
   * Yêu cầu: đã đăng nhập VÀ là admin
   * @returns {boolean}
   */
  canManageTemplates() {
    return this.isLoggedIn() && this.isAdmin();
  }

  /**
   * Quên mật khẩu: gửi email reset link
   */
  async forgotPassword(email) {
    try {
      const response = await this._apiCall('POST', 'auth/forgot-password', { email });
      console.log('[TobyFlow] AuthManager: Đã gửi email khôi phục mật khẩu -', email);
      return response;
    } catch (err) {
      console.error('[TobyFlow] AuthManager: Gửi email khôi phục thất bại', err.message);
      throw err;
    }
  }

  /**
   * Gửi lại email xác minh (auth required — dùng cho user đã login)
   */
  async resendVerification() {
    try {
      const response = await this._apiCall('POST', 'auth/resend-verification');
      console.log('[TobyFlow] AuthManager: Đã gửi lại email xác minh');
      return response;
    } catch (err) {
      console.error('[TobyFlow] AuthManager: Gửi lại email xác minh thất bại', err.message);
      throw err;
    }
  }

  /**
   * SS-Phase B: Gửi lại email xác minh dùng email param (không cần token).
   * Dùng cho scenario: user login fail với EMAIL_NOT_VERIFIED → click "Gửi lại"
   * trên dialog/banner để nhận email mới mà chưa cần đăng nhập thành công.
   */
  async resendVerificationByEmail(email) {
    try {
      const response = await this._apiCall('POST', 'auth/resend-verification-public', { email }, false);
      console.log('[TobyFlow] AuthManager: Đã gửi lại email xác minh (public)');
      return response;
    } catch (err) {
      console.error('[TobyFlow] AuthManager: Gửi lại email xác minh (public) thất bại', err.message);
      throw err;
    }
  }

  /**
   * Đăng nhập / Đăng ký bằng Google OAuth
   * Lấy URL OAuth từ server rồi mở tab mới
   */
  async loginWithGoogle() {
    try {
      const response = await this._apiCall('GET', 'auth/google/url');
      const url = response.url || response;

      if (!url) {
        throw new Error(window.I18n?.t('auth.googleUrlMissing') || 'Không nhận được URL đăng nhập Google');
      }

      // Mở URL trong tab mới
      chrome.tabs.create({ url });

      console.log('[TobyFlow] AuthManager: Đã mở trang đăng nhập Google');
      return { url };
    } catch (err) {
      console.error('[TobyFlow] AuthManager: Đăng nhập Google thất bại', err.message);
      throw err;
    }
  }

  /**
   * Lấy URL OAuth để liên kết tài khoản Google (redirect flow).
   * Backend nhúng user_id vào state param để callback phân biệt link flow vs login flow.
   * Extension mở URL này trong tab mới, sau khi xác thực Google callback sẽ tự link.
   */
  async getLinkGoogleUrl() {
    try {
      const response = await this._apiCall('GET', 'auth/google/link-url');
      const url = response?.url || response;
      if (!url || typeof url !== 'string' || !url.startsWith('http')) {
        throw new Error(window.I18n?.t('auth.googleLinkUrlInvalid') || 'Không nhận được URL liên kết Google hợp lệ');
      }
      return { url };
    } catch (err) {
      console.error('[TobyFlow] AuthManager: Lấy URL liên kết Google thất bại', err.message);
      throw err;
    }
  }

  /**
   * @deprecated Dùng getLinkGoogleUrl() + redirect flow thay thế.
   * Phương thức này yêu cầu google_token từ Google Sign-In SDK (không phù hợp với extension).
   * Giữ lại để tương thích ngược.
   */
  async linkGoogle(googleToken) {
    try {
      const response = await this._apiCall('POST', 'auth/google/link', { google_token: googleToken });
      return response;
    } catch (err) {
      console.error('[TobyFlow] AuthManager: Liên kết Google thất bại', err.message);
      throw err;
    }
  }

  /**
   * Hủy liên kết tài khoản Google
   */
  async unlinkGoogle() {
    try {
      const response = await this._apiCall('POST', 'auth/google/unlink');
      console.log('[TobyFlow] AuthManager: Đã hủy liên kết Google');
      return response;
    } catch (err) {
      console.error('[TobyFlow] AuthManager: Hủy liên kết Google thất bại', err.message);
      throw err;
    }
  }

  // ===== Internal Methods =====

  /**
   * Lưu token + user vào chrome.storage.local
   */
  async _saveAuth(token, user) {
    // [Fix cascade] Reset flags khi có token mới → cho phép API resume.
    this._sessionInvalid = false;
    this._rateLimitedUntil = 0;
    // 2026-05-25: Reset logout flag (defensive, normally cleared trong logout finally)
    this._isLoggingOut = false;
    return new Promise(resolve => {
      chrome.storage.local.set({
        af_auth: {
          token,
          user,
          apiBaseUrl: this.apiBaseUrl,
          savedAt: Date.now()
        }
      }, resolve);
    });
  }

  /**
   * Xóa dữ liệu xác thực + server-synced data
   * Khi logout: xóa cả data đã sync từ server (tasks, workflows, nodes, edges, prompts, entitlements)
   * để tránh data cũ hiển thị cho anonymous user
   *
   * [Audit Bug 9 fix] Snapshot af_settings vào af_settings_pending_resync TRƯỚC khi clear
   * → cho phép restore khi user login lại (recover edit chưa kịp PUT do token expire mid-session).
   */
  async _clearAuth() {
    const previousUserId = this.user?.id ?? null;
    this.token = null;
    this.user = null;
    // [Fix cascade] Chỉ reset rate-limit cooldown — _sessionInvalid được set bởi
    // 401-refresh-fail flow ngay TRƯỚC khi gọi _clearAuth, nếu reset ở đây thì
    // các caller mới sau logout sẽ tiếp tục hammer backend.
    // Explicit logout() sẽ reset _sessionInvalid riêng ở cuối hàm.
    this._rateLimitedUntil = 0;

    // [Audit Bug 9 fix] Snapshot af_settings trước khi remove. StorageSettings.onAuthIn()
    // (login lần sau) check key này để merge restore vào server settings.
    try {
      const snap = await new Promise(resolve => {
        chrome.storage.local.get(['af_settings'], r => resolve(r.af_settings || null));
      });
      if (snap && Object.keys(snap).length > 0 && previousUserId) {
        await new Promise(resolve => {
          chrome.storage.local.set({
            af_settings_pending_resync: { user_id: previousUserId, settings: snap, saved_at: Date.now() }
          }, resolve);
        });
      }
    } catch (_) { /* snapshot best-effort, không block logout */ }

    return new Promise(resolve => {
      chrome.storage.local.remove([
        'af_auth',
        // Server-synced data — không lưu local sau logout
        'af_tasks',
        'af_workflows',
        'af_nodes',
        'af_edges',
        'af_user_prompts',
        // NOTE: af_entitlements KHÔNG xóa ở đây vì resetForLogout() đã fetch trial
        // entitlements và save vào cache. Nếu xóa ở đây, cache trial bị mất.
        'af_addon_prompts',
        // User settings - clear để không ảnh hưởng user khác login
        'af_settings',
        'af_settings_owner', // [Audit Bug 4] owner stamp, clear cùng af_settings
        // Daily stats - clear vì đã có user_id check nhưng tốt hơn là xóa luôn
        'af_daily_stats',
      ], resolve);
    });
  }

  /**
   * Đọc fingerprint anonymous từ chrome.storage.local (do UsageSync sinh ra).
   * Dùng cho header `X-Fingerprint` lúc login/register/refresh để backend
   * dispatch MigrateAnonymousUsageJob — chuyển AnonymousUsage 30 ngày qua
   * thành UsageRecord của user_id mới.
   */
  async _getStoredFingerprint() {
    try {
      const res = await new Promise(resolve => {
        chrome.storage.local.get(['af_fingerprint'], resolve);
      });
      const fp = res?.af_fingerprint;
      return (typeof fp === 'string' && fp.length >= 32) ? fp : null;
    } catch (_) {
      return null;
    }
  }

  /**
   * Gọi API qua background.js message passing (tránh CORS)
   * Tự động thử làm mới token khi gặp 401
   *
   * `extraHeaders` (optional): pass thêm headers (vd: X-Fingerprint cho migration job).
   * Background.js đã wire forward extraHeaders qua action 'apiRequest'.
   */
  async _apiCall(method, endpoint, data = null, _isRetry = false, extraHeaders = null) {
    // [Fix cascade] Short-circuit khi đang trong cooldown 429 — tránh hammer backend.
    // Mọi endpoint auth/* (login/refresh/logout/google/url/google/link/me/...) bypass
    // để user có thể login lại sau session expired hoặc rate limit cooldown.
    const isAuthEndpoint = endpoint.startsWith('auth/');
    if (!isAuthEndpoint && this._rateLimitedUntil > Date.now()) {
      const retryAfter = Math.ceil((this._rateLimitedUntil - Date.now()) / 1000);
      const err = new Error(window.I18n?.t('auth.rateLimited') || `Quá nhiều yêu cầu, vui lòng thử lại sau ${retryAfter} giây`);
      err.code = 'RATE_LIMITED';
      err.httpStatus = 429;
      err.retryAfter = retryAfter;
      return Promise.reject(err);
    }
    // [Fix cascade] Short-circuit khi session đã xác nhận expired — tránh refresh loop.
    // Reset khi user login thành công lại (_saveAuth).
    if (!isAuthEndpoint && this._sessionInvalid) {
      const err = new Error(window.I18n?.t('auth.sessionExpired') || 'Phiên đăng nhập hết hạn, vui lòng đăng nhập lại');
      err.code = 'UNAUTHENTICATED';
      err.httpStatus = 401;
      return Promise.reject(err);
    }
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({
        action: 'apiRequest',
        method,
        endpoint,
        data,
        token: this.token,
        headers: extraHeaders || undefined
      }, response => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message || (window.I18n?.t('auth.backgroundConnectionError') || 'Lỗi kết nối background')));
          return;
        }

        if (!response) {
          reject(new Error(window.I18n?.t('auth.noBackgroundResponse') || 'Không nhận được phản hồi từ background'));
          return;
        }

        if (response.success) {
          // Trả về object đầy đủ nếu có meta (phân trang), ngược lại chỉ trả data
          if (response.meta) {
            resolve({ data: response.data, meta: response.meta });
          } else {
            resolve(response.data);
          }
        } else {
          const errorCode = response.error?.code;
          const errorMessage = response.error?.message || (window.I18n?.t('auth.unknownApiError') || 'Lỗi API không xác định');
          const httpStatus = response.httpStatus;

          // Tự động thử refresh token khi gặp 401 (chỉ thử 1 lần)
          // CRITICAL: Skip retry cho sse/end-session để tránh infinite loop khi logout
          // 2026-05-25: Skip retry khi _sessionInvalid (sau logout) HOẶC _isLoggingOut (trong logout flow)
          // → tránh cascade refresh + emit auth:logout lần 2. In-flight 401 trong/sau logout sẽ
          // short-circuit ngay thay vì trigger refresh. _isLoggingOut bắt cửa sổ giữa logout start
          // và _clearAuth (khi _sessionInvalid chưa set).
          if (httpStatus === 401 && !_isRetry && !this._sessionInvalid && !this._isLoggingOut && endpoint !== 'auth/login' && endpoint !== 'auth/refresh' && endpoint !== 'sse/end-session') {
            console.warn('[TobyFlow] AuthManager: Nhận 401, thử làm mới token');
            this.refreshToken()
              .then(() => this._apiCall(method, endpoint, data, true))
              .then(resolve)
              .catch(() => {
                // [Fix cascade] Refresh thất bại = session permanently invalid.
                // Set flag để mọi _apiCall sau short-circuit ngay → tránh cascade
                // (FeatureGate background refresh, multi-tab polling, SSE reconnect, ...).
                // Reset flag khi user login thành công lại trong _saveAuth.
                this._sessionInvalid = true;
                // [Fix workflow popup logout] Popup/standalone window KHÔNG được clear storage
                // vì sẽ trigger sidePanel external logout cascade → sidebar bị logout sai.
                // SidePanel authoritative về auth state, popup chỉ "read-only".
                const isPopupWindow = !!(window.location.pathname.endsWith('workflow-editor.html') ||
                                         window.location.pathname.endsWith('angles-editor.html') ||
                                         window.location.pathname.endsWith('effects-editor.html') ||
                                         window.location.pathname.endsWith('settings.html'));
                if (isPopupWindow) {
                  console.warn('[TobyFlow] AuthManager: Popup context — skip _clearAuth để không ảnh hưởng sidePanel');
                  const err = new Error(window.I18n?.t('auth.sessionExpired') || 'Phiên đăng nhập hết hạn, vui lòng đăng nhập lại');
                  err.httpStatus = 401;
                  err.code = 'UNAUTHENTICATED';
                  reject(err);
                  return;
                }
                // SidePanel context: buộc đăng xuất như bình thường
                this._clearAuth().then(() => {
                  if (window.eventBus) {
                    window.eventBus.emit('auth:logout', { reason: 'token_expired' });
                  }
                  const err = new Error(window.I18n?.t('auth.sessionExpired') || 'Phiên đăng nhập hết hạn, vui lòng đăng nhập lại');
                  err.httpStatus = 401;
                  err.code = 'UNAUTHENTICATED';
                  reject(err);
                });
              });
            return;
          }

          // Handle 429 Rate Limit - emit event so UI can show warning.
          // Bug fix 2026-05-25: ưu tiên `response.retry_after` (background forward từ
          // Retry-After header). Default 15s thay vì 60s — backend Laravel rate limit
          // header thường 9-30s, 60s quá aggressive freeze toàn bộ UI khi miss header.
          if (httpStatus === 429) {
            const retryAfter = response.retry_after
              || response.data?.retry_after
              || response.headers?.['Retry-After']
              || 15;
            // Jitter +/- 20% để tránh thundering herd (nhiều endpoint cùng hết cooldown 1 lúc)
            const jitter = (Math.random() - 0.5) * 0.4; // -0.2 to +0.2
            const cooldownMs = Math.max(5, Number(retryAfter) * (1 + jitter)) * 1000;
            console.warn('[TobyFlow] AuthManager: Rate limited (429), retry after', retryAfter, 's (jittered:', (cooldownMs / 1000).toFixed(1), 's)');

            // [Fix cascade] Set cooldown để mọi caller mới bị short-circuit ngay,
            // không hammer backend trong khi backend đang stress.
            this._rateLimitedUntil = Date.now() + cooldownMs;

            // Emit event để UI hiển thị cảnh báo
            if (window.eventBus) {
              window.eventBus.emit('api:rate_limited', {
                endpoint,
                retryAfter,
                message: errorMessage
              });
            }

            const error = new Error(window.I18n?.t('auth.rateLimited') || 'Quá nhiều yêu cầu, vui lòng thử lại sau ' + retryAfter + ' giây');
            error.code = 'RATE_LIMITED';
            error.httpStatus = 429;
            error.retryAfter = retryAfter;
            reject(error);
            return;
          }

          // Create error with code + serverData attached for better error handling
          const error = new Error(errorMessage);
          error.code = errorCode;
          error.httpStatus = httpStatus;
          error.serverData = response.data || {};
          // Attach validation details (Laravel ValidationException → error.details: { field.path: [msgs] })
          // để caller (ApiStorage, WorkflowExecutor, ...) log field nào fail thay vì generic "Validation failed".
          error.details = response.error?.details || null;
          // Attach Laravel exception class name (vd "QueryException") để debug 5xx errors.
          error.exception = response.error?.exception || null;
          reject(error);
        }
      });
    });
  }
}

// Singleton instance
window.authManager = new AuthManager();
window.AuthManager = AuthManager;
