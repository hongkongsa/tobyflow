/**
 * NotificationBell - Hiển thị icon chuông với badge count ở header
 *
 * Singleton pattern. Hiển thị số lượng thông báo chưa đọc và mở NotificationPanel khi click.
 *
 * OPTIMIZATION: Polling chỉ chạy trên LEADER tab (qua SseBroadcastManager) để tránh
 * N tabs × 1 request/60s = N requests/60s gây quá tải server.
 *
 * Sử dụng:
 *   const bell = NotificationBell.getInstance();
 *   bell.init(document.querySelector('.header-actions'));
 */
class NotificationBell {
  static instance = null;

  constructor() {
    this.unreadCount = 0;
    this.panel = null;
    this.element = null;
    this.pollInterval = null;
    // [Audit fix 2026-05-24] 60s → 90s — giảm 33% polling requests.
    // SSE notification:new + notification:count_updated đã handle realtime.
    // Polling chỉ là fallback khi SSE down → 90s đủ timely.
    this.pollIntervalMs = 90000; // Poll mỗi 90 giây (backup cho SSE)
    this._boundHandleSSE = null;
    this._boundHandleCountUpdated = null;
    this._boundHandleLeaderChange = null;
    this._fetchDebounceTimer = null;
    this._lastFetchTime = 0;
  }

  /**
   * Lấy instance singleton
   * @returns {NotificationBell}
   */
  static getInstance() {
    if (!NotificationBell.instance) {
      NotificationBell.instance = new NotificationBell();
    }
    return NotificationBell.instance;
  }

  /**
   * Khởi tạo bell vào container
   * @param {HTMLElement} container - Container để render bell icon
   */
  init(container) {
    if (!container) {
      console.warn('[NotificationBell] Container không tồn tại');
      return;
    }

    // Tránh init lại nếu đã có element
    if (this.element) {
      console.log('[NotificationBell] Đã được khởi tạo, skip');
      return;
    }

    // Tạo element
    this.element = document.createElement('div');
    this.element.className = 'notification-bell';
    this.element.innerHTML = this.render();
    container.appendChild(this.element);

    // Bind events
    this._bindEvents();

    // Khởi tạo panel (singleton, chỉ tạo 1 lần)
    if (window.NotificationPanel && !this.panel) {
      this.panel = new window.NotificationPanel();
    }

    // Setup SSE listeners
    this._listenSSE();

    // Fetch count ban đầu (sẽ debounce nếu auth:login/became_leader fire cùng lúc)
    this.fetchUnreadCount();

    // Start polling backup (chỉ nếu là leader, không duplicate với became_leader event)
    // Delay để SseBroadcastManager có thời gian init và xác định role
    setTimeout(() => {
      if (!this.pollInterval) {
        this._startPolling();
      }
    }, 2000);

    // Inject styles
    this._injectStyles();

    console.log('[NotificationBell] Đã khởi tạo');
  }

  /**
   * Render HTML cho bell button với badge
   * @returns {string}
   */
  render() {
    const t = (key, fallback) => window.I18n?.t(key) || fallback;

    return `
      <button class="notification-bell-btn tobyflow-header-btn" type="button"
              title="${t('notification.bell.title', 'Thông báo')}"
              aria-label="${t('notification.bell.title', 'Thông báo')}">
        <svg class="notification-bell-icon" width="18" height="18" viewBox="0 0 24 24"
             fill="none" stroke="currentColor" stroke-width="2"
             stroke-linecap="round" stroke-linejoin="round">
          <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/>
          <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>
        </svg>
        <span class="notification-bell-badge hidden" id="notificationBadge">0</span>
      </button>
    `;
  }

  /**
   * Bind các sự kiện
   */
  _bindEvents() {
    const btn = this.element?.querySelector('.notification-bell-btn');
    if (btn) {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.togglePanel();
      });
    }

    // Click outside để đóng panel
    document.addEventListener('click', (e) => {
      if (this.panel?.isOpen &&
          !e.target.closest('.notification-bell') &&
          !e.target.closest('.notification-panel-overlay')) {
        this.panel.close();
      }
    });

    // ESC để đóng panel
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.panel?.isOpen) {
        this.panel.close();
      }
    });
  }

  /**
   * Update badge DOM
   * @param {number} count - Số thông báo chưa đọc
   */
  updateBadge(count) {
    this.unreadCount = count;
    const badge = this.element?.querySelector('#notificationBadge');

    if (!badge) return;

    if (count > 0) {
      // Hiện số, nếu > 99 thì hiện "99+"
      badge.textContent = count > 99 ? '99+' : count;
      badge.classList.remove('hidden');
      // Thêm animation bounce khi có notification mới
      badge.classList.add('notification-badge-bounce');
      setTimeout(() => badge.classList.remove('notification-badge-bounce'), 300);
    } else {
      badge.classList.add('hidden');
    }
  }

  /**
   * Fetch số lượng thông báo chưa đọc từ API
   * Debounced: chỉ fetch nếu cách lần fetch trước >= 5s để tránh spam
   * @param {boolean} force - Bỏ qua debounce nếu true (dùng cho user action)
   */
  async fetchUnreadCount(force = false) {
    if (!window.authManager?.isLoggedIn()) {
      this.updateBadge(0);
      return;
    }

    // Debounce: skip nếu đã fetch trong 5s gần đây (trừ khi force)
    const now = Date.now();
    const DEBOUNCE_MS = 5000;
    if (!force && this._lastFetchTime && (now - this._lastFetchTime < DEBOUNCE_MS)) {
      console.log('[NotificationBell] fetchUnreadCount debounced, skip');
      return;
    }
    this._lastFetchTime = now;

    try {
      const resp = await new Promise((resolve) => {
        chrome.runtime.sendMessage({
          action: 'apiRequest',
          method: 'GET',
          endpoint: 'notifications/unread-count',
          token: window.authManager?.token
        }, resolve);
      });

      if (chrome.runtime.lastError) {
        return; // Silent fail
      }

      if (resp?.success && resp?.data !== undefined) {
        // Handle nested data from proxy: { success, data: { success, data: { count } } }
        const apiData = resp.data?.data || resp.data || {};
        const count = typeof apiData === 'number'
          ? apiData
          : (apiData.count ?? apiData.unread_count ?? 0);
        this.updateBadge(count);
      }
      // Silent fail for 404/other errors (feature not deployed)
    } catch (err) {
      console.error('[NotificationBell] fetchUnreadCount error:', err);
    }
  }

  /**
   * Toggle mở/đóng NotificationPanel
   */
  togglePanel() {
    if (!this.panel) {
      if (window.NotificationPanel) {
        this.panel = new window.NotificationPanel();
      } else {
        console.warn('[NotificationBell] NotificationPanel chưa sẵn sàng');
        return;
      }
    }

    this.panel.toggle();
  }

  /**
   * Listen các sự kiện SSE liên quan đến notification
   */
  _listenSSE() {
    if (!window.eventBus) return;

    // Có notification mới
    this._boundHandleSSE = (data) => {
      console.log('[NotificationBell] SSE: notification.new', data);
      // Tăng badge count
      this.updateBadge(this.unreadCount + 1);
      // Nếu panel đang mở, refresh list
      if (this.panel?.isOpen) {
        this.panel.fetchNotifications();
      }
    };
    // SseClient + SseBroadcastManager emit với colon ('notification:new'),
    // không phải dot ('notification.new'). Subscribe đúng tên để nhận push.
    window.eventBus.on('notification:new', this._boundHandleSSE);

    // Server gửi count update (sau khi mark as read, etc.)
    this._boundHandleCountUpdated = (data) => {
      console.log('[NotificationBell] SSE: notification:count_updated', data);
      const count = typeof data === 'number' ? data : (data?.count ?? data?.unread_count ?? 0);
      this.updateBadge(count);
    };
    window.eventBus.on('notification:count_updated', this._boundHandleCountUpdated);

    // Auth events — chỉ fetch, polling sẽ được started bởi became_leader handler
    window.eventBus.on('auth:login', () => {
      this.fetchUnreadCount();
    });

    window.eventBus.on('auth:logout', () => {
      this.updateBadge(0);
      this._stopPolling();
      if (this.panel?.isOpen) {
        this.panel.close();
      }
    });

    // Leader/follower role changes - chỉ leader poll
    this._boundHandleLeaderChange = () => {
      console.log('[NotificationBell] Became leader, starting polling');
      this.fetchUnreadCount(); // Debounced, sẽ skip nếu gọi gần đây
      this._startPolling();
    };
    window.eventBus.on('broadcast:became_leader', this._boundHandleLeaderChange);

    window.eventBus.on('broadcast:became_follower', () => {
      console.log('[NotificationBell] Became follower, stopping polling');
      this._stopPolling();
    });
  }

  /**
   * Bắt đầu polling backup (phòng trường hợp SSE disconnect)
   * OPTIMIZATION: Chỉ LEADER tab mới poll để tránh N tabs × N requests
   */
  _startPolling() {
    this._stopPolling();

    if (!window.authManager?.isLoggedIn()) return;

    // Chỉ leader tab mới poll, followers nhận count qua SSE/BroadcastChannel
    if (window.SseBroadcastManager?.isInitialized() && !window.SseBroadcastManager.isLeader()) {
      console.log('[NotificationBell] Follower mode - skip polling, nhận count qua BroadcastChannel');
      return;
    }

    this.pollInterval = setInterval(() => {
      // Double-check vẫn là leader trước khi fetch
      if (window.SseBroadcastManager?.isInitialized() && !window.SseBroadcastManager.isLeader()) {
        this._stopPolling();
        return;
      }
      this.fetchUnreadCount();
    }, this.pollIntervalMs);
  }

  /**
   * Dừng polling
   */
  _stopPolling() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  /**
   * Inject CSS styles
   */
  _injectStyles() {
    if (document.getElementById('notification-bell-styles')) return;

    const style = document.createElement('style');
    style.id = 'notification-bell-styles';
    style.textContent = `
      /* NotificationBell Styles */
      .notification-bell {
        position: relative;
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }

      .notification-bell-btn {
        position: relative;
        /* Inherit af-header-btn styles, just override what's needed */
      }

      .notification-bell-icon {
        width: 16px;
        height: 16px;
        stroke: currentColor;
      }

      .notification-bell-badge {
        position: absolute;
        top: 0px;
        right: 0px;
        min-width: 14px;
        height: 14px;
        padding: 0 4px;
        border-radius: 7px;
        background: #ef4444;
        color: #fff;
        font-size: 9px;
        font-weight: 600;
        line-height: 14px;
        text-align: center;
        box-shadow: 0 2px 4px rgba(239, 68, 68, 0.3);
        pointer-events: none;
        transform-origin: center;
      }

      .notification-bell-badge.hidden {
        display: none;
      }

      @keyframes notification-badge-bounce {
        0%, 100% { transform: scale(1); }
        50% { transform: scale(1.2); }
      }

      .notification-badge-bounce {
        animation: notification-badge-bounce 0.3s ease;
      }

      /* Dark mode */
      [data-theme="dark"] .notification-bell-btn,
      .dark .notification-bell-btn {
        color: var(--foreground, #e5e5e5);
      }

      [data-theme="dark"] .notification-bell-btn:hover,
      .dark .notification-bell-btn:hover {
        background: var(--muted, rgba(255, 255, 255, 0.1));
      }
    `;

    document.head.appendChild(style);
  }

  /**
   * Cleanup và destroy
   */
  destroy() {
    this._stopPolling();
    if (this._fetchDebounceTimer) {
      clearTimeout(this._fetchDebounceTimer);
      this._fetchDebounceTimer = null;
    }

    // Remove SSE listeners
    if (window.eventBus) {
      if (this._boundHandleSSE) {
        window.eventBus.off('notification:new', this._boundHandleSSE);
      }
      if (this._boundHandleCountUpdated) {
        window.eventBus.off('notification:count_updated', this._boundHandleCountUpdated);
      }
      if (this._boundHandleLeaderChange) {
        window.eventBus.off('broadcast:became_leader', this._boundHandleLeaderChange);
      }
    }

    // Remove element
    if (this.element) {
      this.element.remove();
      this.element = null;
    }

    // Close panel
    if (this.panel) {
      this.panel.close();
      this.panel = null;
    }

    NotificationBell.instance = null;
    console.log('[NotificationBell] Đã destroy');
  }
}

// Export global
window.NotificationBell = NotificationBell;
