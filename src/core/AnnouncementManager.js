/**
 * SS-Phase I: AnnouncementManager — admin notification system mở rộng (renamed từ ChangelogManager).
 *
 * Cover use cases: release notes / alert / promo / maintenance notice.
 * Khác ChangelogManager cũ:
 *   - Trigger: dùng SERVER version token thay vì chrome.runtime.getManifest().version
 *     → admin update content (title/body/type) → user nhận thông báo NGAY (không cần update extension)
 *   - 2 mode hiển thị: badge (chỉ chấm đỏ) hoặc popup (auto modal lần đầu)
 *   - Type-aware: release/alert/promo/maintenance → màu icon + tooltip khác nhau
 *   - SSE realtime: nhận event 'announcement_changed' từ backend admin save
 *   - First-time guard: user mới install KHÔNG show thông báo cũ (markSeen ngay lần đầu)
 *
 * Storage keys:
 *   - af_announcement_seen_version: version đã xem (server token)
 *   - af_announcement_initialized:  flag first-time đã setup
 *
 * DOM IDs (giữ tên cũ `changelog*` để tránh refactor sidebar.html — chỉ JS class rename):
 *   - #changelogBtn, #changelogBadge, #changelogOverlay, #changelogTitle, #changelogBody, #changelogCloseBtn
 *
 * CSS classes (giữ `.tobyflow-announcement-*` trong sidebar.css — chỉ rename ở admin Vue preview).
 */
class AnnouncementManager {
  static _STORAGE_KEY_VERSION = 'af_announcement_seen_version';
  static _STORAGE_KEY_INIT = 'af_announcement_initialized';
  // Polling fallback khi SSE disconnect — 30 phút check 1 lần.
  static _POLL_INTERVAL_MS = 30 * 60 * 1000;
  static _pollTimer = null;
  static _lastFetched = null;

  /**
   * Khởi tạo: fetch announcement, so version, show theo mode.
   * Subscribe SSE 'announcement_changed' để nhận realtime update.
   */
  static async init() {
    // 1. Fetch announcement từ server
    const data = await this._fetchAnnouncement();
    this._lastFetched = data;
    if (!data || !data.version) {
      this._bindEvents();
      return;
    }

    // 2. First-time guard: user mới install — KHÔNG show thông báo cũ.
    //    Set seen=current_version + flag init → lần sau chỉ show thông báo MỚI.
    const stored = await new Promise((resolve) => {
      chrome.storage.local.get([this._STORAGE_KEY_VERSION, this._STORAGE_KEY_INIT], resolve);
    });

    if (!stored[this._STORAGE_KEY_INIT]) {
      await new Promise((resolve) => {
        chrome.storage.local.set({
          [this._STORAGE_KEY_VERSION]: data.version,
          [this._STORAGE_KEY_INIT]: true,
        }, resolve);
      });
      this._bindEvents();
      this._startPolling();
      this._subscribeSSE();
      console.log('[TobyFlow] AnnouncementManager: first-time init, suppress legacy notification');
      return;
    }

    // 3. Version mới → hiển thị theo mode
    if (data.version !== stored[this._STORAGE_KEY_VERSION]) {
      this._showByMode(data);
    }

    this._bindEvents();
    this._startPolling();
    this._subscribeSSE();
    console.log('[TobyFlow] AnnouncementManager initialized');
  }

  /**
   * Hiển thị theo display_mode: badge (silent) hoặc popup (auto modal).
   * Empty content → KHÔNG show dù mode=popup (tránh empty modal).
   */
  static _showByMode(data) {
    if (!data || !data.content || !data.content.trim()) return;
    if (data.display_mode === 'popup') {
      this._openModal(data);
    } else {
      this._showBadge();
    }
  }

  /**
   * Subscribe SSE event để nhận announcement update realtime từ admin.
   * Payload: { version, display_mode, type, forced? }
   */
  static _subscribeSSE() {
    if (!window.eventBus) return;
    if (this._sseBound) return;
    this._sseBound = true;
    window.eventBus.on('sse:announcement_changed', async (payload) => {
      try {
        const stored = await new Promise((resolve) => {
          chrome.storage.local.get([this._STORAGE_KEY_VERSION], resolve);
        });
        if (payload?.version === stored[this._STORAGE_KEY_VERSION]) return;
        // Version đổi → fetch full content → hiển thị
        const data = await this._fetchAnnouncement();
        this._lastFetched = data;
        if (data) this._showByMode(data);
      } catch (err) {
        console.warn('[TobyFlow] AnnouncementManager: SSE handler failed', err.message);
      }
    });
  }

  /**
   * Polling fallback khi SSE disconnect — fetch định kỳ + so version.
   * Skip nếu document hidden (extension closed) để tiết kiệm network.
   * Chỉ leader mới poll để tránh nhiều tabs cùng fetch.
   */
  static _startPolling() {
    if (this._pollTimer) return;

    // Chỉ leader mới poll - followers nhận qua BroadcastChannel
    if (window.SseBroadcastManager?.isInitialized() && !window.SseBroadcastManager.isLeader()) {
      console.log('[AnnouncementManager] Follower mode - skip polling');
      return;
    }

    this._pollTimer = setInterval(async () => {
      if (document.visibilityState === 'hidden') return;
      // Double-check vẫn là leader
      if (window.SseBroadcastManager?.isInitialized() && !window.SseBroadcastManager.isLeader()) {
        this._stopPolling();
        return;
      }
      try {
        const data = await this._fetchAnnouncement();
        this._lastFetched = data;
        if (!data || !data.version) return;
        const stored = await new Promise((resolve) => {
          chrome.storage.local.get([this._STORAGE_KEY_VERSION], resolve);
        });
        if (data.version !== stored[this._STORAGE_KEY_VERSION]) {
          this._showByMode(data);
        }
      } catch (_) { /* silent */ }
    }, this._POLL_INTERVAL_MS);
  }

  /**
   * Dừng polling
   */
  static _stopPolling() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  /**
   * Hiển thị badge dot trên #changelogBtn (DOM ID giữ nguyên tên cũ).
   */
  static _showBadge() {
    const badge = document.getElementById('changelogBadge');
    if (badge) badge.classList.remove('hidden');
  }

  static _hideBadge() {
    const badge = document.getElementById('changelogBadge');
    if (badge) badge.classList.add('hidden');
  }

  /**
   * Đánh dấu user đã xem version hiện tại — không hiện lại đến khi version đổi.
   */
  static markSeen(version) {
    if (!version) return;
    chrome.storage.local.set({ [this._STORAGE_KEY_VERSION]: version });
    this._hideBadge();
  }

  /**
   * Fetch announcement từ backend (API mới `/api/v1/announcement`).
   * @returns {Promise<{title, content, type, display_mode, version, updated_at} | null>}
   */
  static async _fetchAnnouncement() {
    try {
      const apiBaseUrl = window.ApiBaseConfig.get();
      // Anti-clone: X-Extension-Id để pass VerifyExtensionId middleware khi toggle ON
      const headers = {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      };
      try { if (chrome?.runtime?.id) headers['X-Extension-Id'] = chrome.runtime.id; } catch (_) {}
      // Sprint 3 HMAC: ký để pass VerifySignature enforce mode (đồng bộ background.js)
      try { Object.assign(headers, await (window.RequestSigner?.headers?.('GET', new URL(`${apiBaseUrl}/announcement`).pathname, '') || {})); } catch (_) {}
      const response = await fetch(`${apiBaseUrl}/announcement`, {
        method: 'GET',
        headers,
        cache: 'no-store',
      });
      if (!response.ok) {
        console.warn('[TobyFlow] Announcement API non-OK:', response.status);
        return null;
      }
      const data = await response.json();
      if (data.success && data.data) return data.data;
      return null;
    } catch (err) {
      console.warn('[TobyFlow] Failed to fetch announcement:', err.message);
      return null;
    }
  }

  /**
   * Render announcement vào modal body. Type-aware: thêm class CSS theo type
   * để admin/CSS có thể style khác nhau cho mỗi loại nếu cần (defer styling).
   */
  static _renderContent(data) {
    const body = document.getElementById('changelogBody');
    const title = document.getElementById('changelogTitle');
    if (!body) return;

    if (!data || !data.content) {
      const fallbackTitle = (window.I18n?.t?.('announcement.title')) || 'Có gì mới?';
      const emptyText = (window.I18n?.t?.('announcement.empty')) || 'Chưa có thông báo mới.';
      body.innerHTML = `<p class="tobyflow-announcement-empty">${emptyText}</p>`;
      if (title) title.textContent = fallbackTitle;
      return;
    }

    if (title && data.title) title.textContent = data.title;
    const typeClass = data.type ? ` tobyflow-announcement-content--${data.type}` : '';
    body.innerHTML = `<div class="tobyflow-announcement-content${typeClass}">${data.content}</div>`;
  }

  static _showLoading() {
    const body = document.getElementById('changelogBody');
    if (body) {
      const loadingText = (window.I18n?.t?.('common.loading')) || 'Đang tải...';
      body.innerHTML = `<div class="tobyflow-announcement-loading">${loadingText}</div>`;
    }
  }

  /**
   * Mở modal. Nếu data đã có sẵn (vd auto-popup) → render ngay; ngược lại fetch.
   * markSeen với version của data đã render — đảm bảo close = mark đúng version.
   */
  static async _openModal(prefetched = null) {
    const overlay = document.getElementById('changelogOverlay');
    if (overlay) overlay.classList.remove('hidden');

    let data = prefetched;
    if (!data) {
      this._showLoading();
      data = await this._fetchAnnouncement();
      this._lastFetched = data;
    }
    this._renderContent(data);
    if (data?.version) this.markSeen(data.version);
  }

  static _closeModal() {
    const overlay = document.getElementById('changelogOverlay');
    if (overlay) overlay.classList.add('hidden');
  }

  /**
   * Bind UI events. Click button → open modal (manual). Click close/overlay → close.
   */
  static _bindEvents() {
    if (this._eventsBound) return;
    this._eventsBound = true;

    const btn = document.getElementById('changelogBtn');
    const closeBtn = document.getElementById('changelogCloseBtn');
    const overlay = document.getElementById('changelogOverlay');

    if (btn) {
      btn.addEventListener('click', () => this._openModal());
    }
    if (closeBtn) {
      closeBtn.addEventListener('click', () => this._closeModal());
    }
    if (overlay) {
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) this._closeModal();
      });
    }
  }
}

window.AnnouncementManager = AnnouncementManager;
// Backward-compat alias: code cũ tham chiếu ChangelogManager vẫn work
window.ChangelogManager = AnnouncementManager;
