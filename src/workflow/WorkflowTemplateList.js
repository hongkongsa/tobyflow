/**
 * WorkflowTemplateList - Browse and import workflow templates from server
 */
class WorkflowTemplateList {
  constructor(container) {
    this.container = container;
    this.templates = [];
    this.categories = [];
    this.selectedCategory = null;
    this.searchQuery = '';
    this.currentPage = 1;
    this.lastPage = 1;
    this.loading = false;
    this._searchTimeout = null;
    this._i18nHandler = null;
    this._isCopyingTemplate = false; // Lock để tránh duplicate click

    this.render();
    this._bindEvents();
    this._loadCategories();
    this._loadTemplates();

    // Listen for import-from-preview-window message (Option A flow)
    if (chrome?.runtime?.onMessage) {
      chrome.runtime.onMessage.addListener((message) => {
        if (message?.action === 'workflowTemplateImportRequested' && message.template) {
          this._handleImport(message.template).catch((err) => {
            console.warn('[WorkflowTemplateList] Import from preview failed:', err);
          });
        }
        // Listen for template editor window closed -> refresh list
        if (message?.action === 'templateEditorClosed') {
          console.log('[WorkflowTemplateList] Template editor closed, refreshing list...');
          this._loadTemplates(false);
        }
      });
    }
  }

  /**
   * Escape HTML to prevent XSS
   * @param {string} str
   * @returns {string}
   */
  _escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  /**
   * Render a single star icon
   */
  _renderStar(filled) {
    if (filled) {
      return `<svg class="wf-star wf-star--filled" width="12" height="12" viewBox="0 0 24 24" fill="#f59e0b" stroke="#f59e0b" stroke-width="1"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>`;
    }
    return `<svg class="wf-star wf-star--empty" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#888" stroke-width="1.5"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>`;
  }

  /**
   * Render combined rating (interactive stars + avg display) - for modal detail
   * User can click to rate, and also see the average rating
   */
  _renderCombinedRating(templateId, avgRating, ratingsCount, userRating = 0) {
    const hasRating = ratingsCount && ratingsCount > 0;
    const isLoggedIn = window.authManager?.isLoggedIn() || false;

    let starsHtml = '';
    for (let i = 1; i <= 5; i++) {
      const filled = i <= (userRating || 0);
      if (isLoggedIn) {
        starsHtml += `<span class="wf-star-interactive${filled ? ' wf-star-interactive--selected' : ''}" data-rating="${i}" data-template-id="${templateId}">${this._renderStar(filled)}</span>`;
      } else {
        const displayFilled = i <= Math.round(avgRating || 0);
        starsHtml += this._renderStar(displayFilled);
      }
    }

    const avgText = hasRating ? `<span class="wf-combined-rating__avg">${avgRating}</span>` : '';
    const countText = hasRating ? `<span class="wf-combined-rating__count">(${ratingsCount})</span>` : '';

    return `
      <div class="wf-combined-rating${isLoggedIn ? ' wf-combined-rating--interactive' : ''}" data-template-id="${templateId}">
        <span class="wf-combined-rating__stars">${starsHtml}</span>
        ${avgText}
        ${countText}
      </div>
    `;
  }

  /**
   * Render rating display (read-only stars + avg + count)
   */
  _renderRatingDisplay(avgRating, ratingsCount) {
    const hasRating = ratingsCount && ratingsCount > 0;
    const roundedRating = hasRating ? Math.round(avgRating) : 0;

    let starsHtml = '';
    for (let i = 1; i <= 5; i++) {
      starsHtml += this._renderStar(i <= roundedRating);
    }

    return `
      <span class="wf-template-rating${!hasRating ? ' wf-template-rating--empty' : ''}">
        <span class="wf-template-rating__stars">${starsHtml}</span>
        ${hasRating ? `<span class="wf-template-rating__text">${avgRating}</span>` : ''}
      </span>
    `;
  }

  /**
   * Render interactive star rating (clickable) - for modal detail
   */
  _renderInteractiveRating(templateId, userRating = 0) {
    let starsHtml = '';
    for (let i = 1; i <= 5; i++) {
      const filled = i <= userRating;
      starsHtml += `<span class="wf-star-interactive${filled ? ' wf-star-interactive--selected' : ''}" data-rating="${i}" data-template-id="${templateId}">${this._renderStar(filled)}</span>`;
    }
    return `
      <div class="wf-template-rating-interactive" data-template-id="${templateId}">
        <span class="wf-template-rating-interactive__label">${window.I18n?.t('workflow.rateLabel') || 'Your rating:'}</span>
        <span class="wf-template-rating-interactive__stars">${starsHtml}</span>
      </div>
    `;
  }

  /**
   * Bind hover/click events for interactive rating stars
   * Works with both old .wf-template-rating-interactive__stars and new .wf-combined-rating__stars
   */
  _bindInteractiveRating(container, templateId) {
    // Try new combined rating first, fallback to old interactive rating
    let starsContainer = container.querySelector('.wf-combined-rating--interactive .wf-combined-rating__stars');
    if (!starsContainer) {
      starsContainer = container.querySelector('.wf-template-rating-interactive__stars');
    }
    if (!starsContainer) return;

    const starSpans = starsContainer.querySelectorAll('.wf-star-interactive');
    if (starSpans.length === 0) return;

    starSpans.forEach(span => {
      // Hover effect
      span.addEventListener('mouseenter', () => {
        const hoverRating = parseInt(span.dataset.rating, 10);
        starSpans.forEach((s, idx) => {
          const svgEl = s.querySelector('svg');
          if (idx < hoverRating) {
            svgEl.setAttribute('fill', '#f59e0b');
            svgEl.setAttribute('stroke', '#f59e0b');
            svgEl.classList.add('wf-star--filled');
            svgEl.classList.remove('wf-star--empty');
          } else {
            svgEl.setAttribute('fill', 'none');
            svgEl.setAttribute('stroke', '#888');
            svgEl.classList.remove('wf-star--filled');
            svgEl.classList.add('wf-star--empty');
          }
        });
      });

      // Click to rate
      span.addEventListener('click', () => {
        const rating = parseInt(span.dataset.rating, 10);
        this._rateWorkflowTemplate(templateId, rating, starsContainer);
      });
    });

    // Reset on mouse leave
    starsContainer.addEventListener('mouseleave', () => {
      starSpans.forEach(s => {
        const svgEl = s.querySelector('svg');
        if (s.classList.contains('wf-star-interactive--selected')) {
          svgEl.setAttribute('fill', '#f59e0b');
          svgEl.setAttribute('stroke', '#f59e0b');
          svgEl.classList.add('wf-star--filled');
          svgEl.classList.remove('wf-star--empty');
        } else {
          svgEl.setAttribute('fill', 'none');
          svgEl.setAttribute('stroke', '#888');
          svgEl.classList.remove('wf-star--filled');
          svgEl.classList.add('wf-star--empty');
        }
      });
    });
  }

  /**
   * Submit rating to server
   */
  async _rateWorkflowTemplate(templateId, rating, starsContainer) {
    try {
      console.log('[WorkflowTemplateList] Rating template', templateId, 'stars:', rating);

      const result = await this._apiCall(`workflow-templates/${templateId}/rate`, 'POST', { rating });
      const data = result.data || result;

      // Update star UI to show selected rating
      if (starsContainer) {
        const starSpans = starsContainer.querySelectorAll('.wf-star-interactive');
        starSpans.forEach((s, i) => {
          const svgEl = s.querySelector('svg');
          if (i < rating) {
            svgEl.setAttribute('fill', '#f59e0b');
            svgEl.setAttribute('stroke', '#f59e0b');
            svgEl.classList.add('wf-star--filled');
            svgEl.classList.remove('wf-star--empty');
            s.classList.add('wf-star-interactive--selected');
          } else {
            svgEl.setAttribute('fill', 'none');
            svgEl.setAttribute('stroke', '#888');
            svgEl.classList.remove('wf-star--filled');
            svgEl.classList.add('wf-star--empty');
            s.classList.remove('wf-star-interactive--selected');
          }
        });
      }

      // Update card rating display
      const card = this.container.querySelector(`.wf-template-card[data-template-id="${templateId}"]`);
      if (card && data.avg_rating !== undefined) {
        const ratingEl = card.querySelector('.wf-template-rating');
        if (ratingEl) {
          ratingEl.outerHTML = this._renderRatingDisplay(data.avg_rating, data.ratings_count);
        }

        // Update cached template data
        const tpl = this.templates.find(t => String(t.id) === String(templateId));
        if (tpl) {
          tpl.avg_rating = data.avg_rating;
          tpl.ratings_count = data.ratings_count;
          tpl.user_rating = rating;
        }
      }

      // Update modal combined rating display if open (avg + count text)
      const modalCombinedRating = document.querySelector('.wf-detail-modal .wf-combined-rating');
      if (modalCombinedRating && data.avg_rating !== undefined) {
        const avgEl = modalCombinedRating.querySelector('.wf-combined-rating__avg');
        const countEl = modalCombinedRating.querySelector('.wf-combined-rating__count');
        const hintEl = modalCombinedRating.querySelector('.wf-combined-rating__hint');
        if (avgEl) avgEl.textContent = data.avg_rating;
        else {
          const avgSpan = document.createElement('span');
          avgSpan.className = 'wf-combined-rating__avg';
          avgSpan.textContent = data.avg_rating;
          modalCombinedRating.querySelector('.wf-combined-rating__stars')?.after(avgSpan);
        }
        if (countEl) countEl.textContent = `(${data.ratings_count})`;
        else {
          const countSpan = document.createElement('span');
          countSpan.className = 'wf-combined-rating__count';
          countSpan.textContent = `(${data.ratings_count})`;
          modalCombinedRating.querySelector('.wf-combined-rating__avg')?.after(countSpan);
        }
        if (hintEl) hintEl.remove();
      }
      // Fallback: old modal rating display
      const modalRatingDisplay = document.querySelector('.wf-detail-modal .wf-template-rating');
      if (modalRatingDisplay && data.avg_rating !== undefined) {
        modalRatingDisplay.outerHTML = this._renderRatingDisplay(data.avg_rating, data.ratings_count);
      }

      window.showNotification?.(
        window.I18n?.t('workflow.ratedTemplate', { rating }) || `Đã đánh giá ${rating} sao`,
        'success'
      );

      console.log('[WorkflowTemplateList] Rated template', templateId, '-> avg:', data.avg_rating);
    } catch (err) {
      console.error('[WorkflowTemplateList] Rate template error:', templateId, err.message);
      window.showNotification?.(
        (window.I18n?.t('workflow.rateError') || 'Lỗi gửi đánh giá: ') + err.message,
        'error'
      );
    }
  }

  /**
   * Render main UI structure
   */
  render() {
    const t = (key, params) => {
      const val = window.I18n?.t?.(key, params);
      return val && val !== key ? val : key;
    };

    // EWT-10: Chỉ admin mới có quyền tạo/quản lý template
    // 2026-05-25: Đồng nhất với check ở _createNewTemplate (line 2290) + _editTemplate +
    // _saveTemplateChanges → dùng canonical canManageWorkflowTemplates() (isLoggedIn AND isAdmin).
    // Trước: isAdmin() raw không guard isLoggedIn → có thể show button khi user.is_admin=true
    // nhưng chưa login. Sau: cùng source of truth với click handler.
    const canManageTemplates = window.featureGate?.canManageWorkflowTemplates?.()
      || (window.authManager?.canManageTemplates?.() ?? false);

    // Track quyền đã render — featuregate:refreshed handler dùng để chỉ re-render khi đổi
    this._renderedCanManage = canManageTemplates;

    this.container.innerHTML = `
      <div class="wf-template-list">
        <div class="wf-template-search-row">
          <div class="wf-template-search-box">
            <svg class="wf-search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="11" cy="11" r="8"/>
              <path d="m21 21-4.3-4.3"/>
            </svg>
            <input type="text" class="wf-search-input" placeholder="${t('workflow.searchTemplate')}" />
          </div>
          <select class="wf-category-select compact-select">
            <option value="">${t('workflow.allCategories')}</option>
          </select>
          ${canManageTemplates ? `
            <button class="wf-create-template-btn" title="${t('workflow.createNewTemplate') || 'Tạo Template mới'}">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="12" y1="5" x2="12" y2="19"></line>
                <line x1="5" y1="12" x2="19" y2="12"></line>
              </svg>
              <span>${t('workflow.createTemplate') || 'Tạo Template'}</span>
            </button>
          ` : ''}
        </div>

        <div class="wf-template-empty hidden">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="3" width="7" height="7" rx="1"/>
            <rect x="14" y="3" width="7" height="7" rx="1"/>
            <rect x="3" y="14" width="7" height="7" rx="1"/>
            <rect x="14" y="14" width="7" height="7" rx="1"/>
          </svg>
          <p>${t('workflow.noTemplates')}</p>
        </div>

        <div class="wf-template-grid">
          ${this._renderSkeletons()}
        </div>

        <button class="wf-load-more hidden">
          ${t('workflow.loadMore')}
        </button>
      </div>
    `;
  }

  /**
   * Render loading skeletons
   */
  /**
   * [API SPAM FIX — Phase 2.2] Banner cảnh báo rate-limited + auto-retry sau cooldown.
   * Tránh xóa danh sách templates khiến user thấy empty UI khi backend rate limit.
   */
  _showRateLimitBanner(retryAfter) {
    let banner = this.container.querySelector('.wf-rate-limit-banner');
    if (!banner) {
      banner = document.createElement('div');
      banner.className = 'wf-rate-limit-banner';
      this.container.prepend(banner);
    }
    banner.style.display = 'flex';

    const clockIcon = `<svg class="wf-rate-limit-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`;
    const tBase = window.I18n?.t?.('workflow.rateLimitedBanner') || 'Gói của bạn đang bị giới hạn. Tự động thử lại sau {seconds}s...';
    let remaining = retryAfter;
    const update = () => {
      const text = tBase.replace('{seconds}', `<span class="wf-rate-limit-countdown">${remaining}</span>`);
      banner.innerHTML = `${clockIcon}<span class="wf-rate-limit-text">${text}</span>`;
    };
    update();

    if (this._rateLimitTimer) clearInterval(this._rateLimitTimer);
    if (this._rateLimitRetryTimer) clearTimeout(this._rateLimitRetryTimer);

    this._rateLimitTimer = setInterval(() => {
      remaining--;
      if (remaining <= 0) {
        clearInterval(this._rateLimitTimer);
        this._rateLimitTimer = null;
        banner.style.display = 'none';
      } else { update(); }
    }, 1000);

    this._rateLimitRetryTimer = setTimeout(() => {
      this._rateLimitRetryTimer = null;
      this._loadTemplates(false);
    }, retryAfter * 1000);
  }

  _renderSkeletons() {
    return `
      <div class="wf-template-card skeleton">
        <div class="wf-template-thumb skeleton-thumb"></div>
        <div class="wf-template-info">
          <div class="skeleton-text"></div>
          <div class="skeleton-text short"></div>
        </div>
      </div>
      <div class="wf-template-card skeleton">
        <div class="wf-template-thumb skeleton-thumb"></div>
        <div class="wf-template-info">
          <div class="skeleton-text"></div>
          <div class="skeleton-text short"></div>
        </div>
      </div>
      <div class="wf-template-card skeleton">
        <div class="wf-template-thumb skeleton-thumb"></div>
        <div class="wf-template-info">
          <div class="skeleton-text"></div>
          <div class="skeleton-text short"></div>
        </div>
      </div>
      <div class="wf-template-card skeleton">
        <div class="wf-template-thumb skeleton-thumb"></div>
        <div class="wf-template-info">
          <div class="skeleton-text"></div>
          <div class="skeleton-text short"></div>
        </div>
      </div>
    `;
  }

  /**
   * Bind DOM events
   */
  _bindEvents() {
    // Search input with debounce
    const searchInput = this.container.querySelector('.wf-search-input');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        this._handleSearch(e.target.value);
      });
    }

    // Category select dropdown
    const categorySelect = this.container.querySelector('.wf-category-select');
    if (categorySelect) {
      categorySelect.addEventListener('change', (e) => {
        const categoryId = e.target.value || null;
        this._handleCategoryFilter(categoryId);
      });
    }

    // EWT-10: Nút tạo template mới (chỉ admin)
    const createTemplateBtn = this.container.querySelector('.wf-create-template-btn');
    if (createTemplateBtn) {
      createTemplateBtn.addEventListener('click', () => {
        this._createNewTemplate();
      });
    }

    // Template cards - use event delegation
    const gridContainer = this.container.querySelector('.wf-template-grid');
    if (gridContainer) {
      gridContainer.addEventListener('click', (e) => {
        const card = e.target.closest('.wf-template-card');
        if (!card) return;

        const templateId = card.dataset.templateId;
        if (!templateId) return;

        const template = this.templates.find(t => String(t.id) === String(templateId));
        if (!template) return;

        // EWT-12.3: Kiểm tra click vào lock overlay hoặc upgrade button
        const lockOverlay = e.target.closest('.wf-template-lock-overlay');
        const upgradeBtn = e.target.closest('.wf-template-upgrade-btn');
        if (lockOverlay || upgradeBtn) {
          // Hiển thị upgrade prompt modal
          this._showUpgradePrompt(template);
          return;
        }

        // EWT-12.3: Nếu template bị khóa, hiển thị upgrade prompt
        const isLocked = card.dataset.isLocked === 'true';
        if (isLocked) {
          this._showUpgradePrompt(template);
          return;
        }

        // EWT-6.4: Kiểm tra nút "Chỉnh sửa" được click (admin only)
        const editBtn = e.target.closest('.wf-template-edit-btn');
        if (editBtn) {
          // Mở template trong editor để chỉnh sửa
          this._openTemplateForEdit(template.id);
          return;
        }

        // Kiểm tra nút "Video demo" được click
        const videoBtn = e.target.closest('.wf-template-video-btn');
        if (videoBtn) {
          const videoUrl = videoBtn.dataset.videoUrl;
          if (videoUrl) {
            this._showVideoModal(videoUrl);
          }
          return;
        }

        // Kiểm tra nút "Copy share link" được click
        const shareBtn = e.target.closest('.wf-template-share-btn');
        if (shareBtn) {
          e.stopPropagation();
          const slug = shareBtn.dataset.templateSlug;
          if (slug) {
            this._copyTemplateShareLink(slug);
          }
          return;
        }

        // Kiểm tra nút "Xem trước" được click (preview icon trên thumbnail)
        const previewBtn = e.target.closest('.wf-template-preview-btn');
        if (previewBtn) {
          // Mở modal chi tiết template
          this._showTemplateDetail(template);
          return;
        }

        // Kiểm tra nút "Sử dụng" được click (cho user đã đăng nhập - clone qua API)
        const useBtn = e.target.closest('.wf-template-use-btn');
        if (useBtn) {
          // Clone template qua API (EWT-8)
          this._copyTemplateToWorkflow(template.id);
          return;
        }

        // Click vào card info (không phải thumbnail buttons) -> hiển thị chi tiết
        const cardInfo = e.target.closest('.wf-template-info');
        if (cardInfo) {
          this._showTemplateDetail(template);
          return;
        }

        // Click vào thumbnail (không phải buttons trên thumbnail) -> hiển thị chi tiết
        const thumb = e.target.closest('.wf-template-thumb');
        if (thumb && !e.target.closest('button')) {
          this._showTemplateDetail(template);
          return;
        }
      });
    }

    // Load more button
    const loadMoreBtn = this.container.querySelector('.wf-load-more');
    if (loadMoreBtn) {
      loadMoreBtn.addEventListener('click', () => {
        if (!this.loading && this.currentPage < this.lastPage) {
          this._loadTemplates(true);
        }
      });
    }

    // Listen for i18n changes — store handler reference for cleanup
    if (window.eventBus) {
      this._i18nHandler = () => {
        this.render();
        this._bindEvents();
        this._renderCategories();
        this._renderTemplates();
      };
      window.eventBus.on('i18n:changed', this._i18nHandler);

      // EWT-10: Listen for template created/updated events to refresh list
      this._templateCreatedHandler = () => {
        console.log('[WorkflowTemplateList] Template created, refreshing list...');
        this._loadTemplates(false);
      };
      this._templateUpdatedHandler = () => {
        console.log('[WorkflowTemplateList] Template updated, refreshing list...');
        this._loadTemplates(false);
      };
      window.eventBus.on('template:created', this._templateCreatedHandler);
      window.eventBus.on('template:updated', this._templateUpdatedHandler);

      // Reload templates khi user login (có thể có premium templates)
      // 2026-05-25 BUG FIX: PHẢI call `_bindEvents()` sau mỗi `render()` vì innerHTML replace
      // wipe toàn bộ DOM bao gồm `.wf-template-grid` → click listener gắn trên grid cũ bị mất.
      // Trước fix: user login/logout → render() → click vào template card không có tác dụng
      // (không mở detail modal) cho đến khi loadTemplates() finish + re-bind.
      this._authLoginHandler = () => {
        console.log('[WorkflowTemplateList] User logged in, refreshing templates...');
        try { this.render(); this._bindEvents(); } catch (e) { /* ignore */ }
        this._loadTemplates(false);
      };
      window.eventBus.on('auth:login', this._authLoginHandler);

      // Reload templates khi user logout (ẩn premium templates)
      this._authLogoutHandler = () => {
        console.log('[WorkflowTemplateList] User logged out, refreshing templates...');
        try { this.render(); this._bindEvents(); } catch (e) { /* ignore */ }
        this._loadTemplates(false);
      };
      window.eventBus.on('auth:logout', this._authLogoutHandler);

      // 2026-05-25: Re-render khi entitlements/user info update (vd: user promote → admin via SSE).
      // Đảm bảo button "Tạo Template" visibility đồng bộ với canManageWorkflowTemplates().
      //
      // 2026-05-26 BUG FIX (SSE → template kẹt loading): featuregate:refreshed fire trên MỌI
      // entitlements_changed SSE + config version bump. render() reset grid về skeleton nhưng
      // handler cũ KHÔNG gọi _loadTemplates() → skeleton kẹt mãi phải refresh. Đồng thời reload
      // thừa mỗi SSE. Fix: chỉ re-render khi quyền quản lý đổi, và khi re-render PHẢI reload lại
      // (giống _authLoginHandler/_authLogoutHandler). Quyền không đổi → no-op (giữ nguyên grid).
      this._featuregateRefreshHandler = () => {
        const canManage = window.featureGate?.canManageWorkflowTemplates?.()
          || (window.authManager?.canManageTemplates?.() ?? false);
        if (canManage === this._renderedCanManage) return; // quyền không đổi → bỏ qua, tránh reload/flash thừa
        try { this.render(); this._bindEvents(); } catch (e) { /* ignore */ }
        this._loadTemplates(false);
      };
      window.eventBus.on('featuregate:refreshed', this._featuregateRefreshHandler);
    }
  }

  /**
   * API call helper - works for both anonymous and logged-in users
   */
  async _apiCall(endpoint, method = 'GET', data = null) {
    // Use authManager if logged in
    if (window.authManager?.isLoggedIn()) {
      return window.authManager._apiCall(method, endpoint, data);
    }

    // Anonymous: call via background.js với 20s timeout (tránh promise hang forever
    // khi MV3 service worker sleep hoặc network stuck → loading flag stuck → user phải reload).
    return new Promise((resolve, reject) => {
      let settled = false;
      const timeoutId = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error('Request timeout (20s) - background unresponsive'));
      }, 20000);

      try {
        chrome.runtime.sendMessage({
          action: 'apiRequest',
          method,
          endpoint,
          data
        }, (resp) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeoutId);

          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (resp?.success) {
            // Handle pagination
            if (resp.meta) {
              resolve({ data: resp.data, meta: resp.meta });
            } else {
              resolve(resp.data);
            }
          } else {
            reject(new Error(resp?.error?.message || 'API Error'));
          }
        });
      } catch (err) {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        reject(err);
      }
    });
  }

  /**
   * Load categories from API
   */
  async _loadCategories() {
    try {
      const result = await this._apiCall('workflow-templates/categories');
      this.categories = Array.isArray(result) ? result : (result?.data || []);
      this._renderCategories();
    } catch (err) {
      console.error('[WorkflowTemplateList] Failed to load categories:', err);
    }
  }

  /**
   * Render category select options
   */
  _renderCategories() {
    const t = (key) => {
      const val = window.I18n?.t?.(key);
      return val && val !== key ? val : key;
    };
    const selectEl = this.container.querySelector('.wf-category-select');
    if (!selectEl) return;

    let html = `<option value="">${t('workflow.allCategories')}</option>`;

    for (const cat of this.categories) {
      const isSelected = String(this.selectedCategory) === String(cat.id);
      html += `<option value="${cat.id}" ${isSelected ? 'selected' : ''}>${cat.name || cat.title}</option>`;
    }

    selectEl.innerHTML = html;
  }

  /**
   * Public method to reload templates (for external refresh calls)
   */
  loadTemplates() {
    return this._loadTemplates(false);
  }

  /**
   * Load templates from API
   * @param {boolean} append - true for load more / infinite scroll
   */
  async _loadTemplates(append = false) {
    // 2026-05-25 BUG FIX: stuck loading flag. Nếu lần fetch trước hang (MV3 service worker
    // sleep, network timeout, ...) và finally chưa fire, this.loading=true mãi → mọi
    // _loadTemplates() sau early-return → skeleton stuck. Force reset sau 30s timeout.
    if (this.loading) {
      const since = this._loadingStartedAt || 0;
      if (Date.now() - since < 30000) return; // legitimate concurrent call
      console.warn('[WorkflowTemplateList] Loading flag stuck > 30s, force reset');
      this.loading = false;
    }
    this.loading = true;
    this._loadingStartedAt = Date.now();
    const grid = this.container.querySelector('.wf-template-grid');
    const loadMoreBtn = this.container.querySelector('.wf-load-more');
    const emptyState = this.container.querySelector('.wf-template-empty');

    // Show skeletons if not appending
    if (!append && grid) {
      grid.innerHTML = this._renderSkeletons();
    }

    // Hide empty state
    if (emptyState) {
      emptyState.classList.add('hidden');
    }

    try {
      const page = append ? this.currentPage + 1 : 1;
      const params = new URLSearchParams();
      params.set('page', String(page));
      params.set('per_page', '20');

      if (this.selectedCategory) {
        params.set('category_id', this.selectedCategory);
      }

      if (this.searchQuery) {
        params.set('search', this.searchQuery);
      }

      const endpoint = `workflow-templates?${params.toString()}`;
      const result = await this._apiCall(endpoint);

      // Handle both paginated and non-paginated responses
      let newTemplates = [];
      if (Array.isArray(result)) {
        newTemplates = result;
        this.lastPage = 1;
        this.currentPage = 1;
      } else if (result?.data) {
        newTemplates = result.data;
        this.lastPage = result.meta?.last_page || 1;
        this.currentPage = result.meta?.current_page || page;
      }

      if (append) {
        this.templates = [...this.templates, ...newTemplates];
      } else {
        this.templates = newTemplates;
      }

      this._renderTemplates();

      // Show/hide load more button
      if (loadMoreBtn) {
        if (this.currentPage < this.lastPage && this.templates.length > 0) {
          loadMoreBtn.classList.remove('hidden');
        } else {
          loadMoreBtn.classList.add('hidden');
        }
      }

      // Show empty state if no templates
      if (this.templates.length === 0 && emptyState) {
        emptyState.classList.remove('hidden');
      }

    } catch (err) {
      // [API SPAM FIX — Phase 2.2] 429 → giữ data cũ + show banner + auto-retry.
      // Tránh xóa danh sách khiến user thấy empty UI.
      if (err?.code === 'RATE_LIMITED' || err?.httpStatus === 429) {
        const retryAfter = Number(err.retryAfter) || 60;
        console.warn('[WorkflowTemplateList] Rate limited, giữ data cũ, retry sau', retryAfter, 's');
        this._showRateLimitBanner(retryAfter);
        // Re-render data cũ (nếu skeleton đang show, replace lại)
        if (this.templates.length > 0) {
          this._renderTemplates();
        }
      } else {
        console.error('[WorkflowTemplateList] Failed to load templates:', err);
        if (grid && !append) {
          grid.innerHTML = '';
        }
        if (emptyState) {
          emptyState.classList.remove('hidden');
        }
      }
    } finally {
      this.loading = false;
      this._loadingStartedAt = 0;
    }
  }

  /**
   * Render template cards
   */
  _renderTemplates() {
    const grid = this.container.querySelector('.wf-template-grid');
    if (!grid) return;

    if (this.templates.length === 0) {
      grid.innerHTML = '';
      return;
    }

    let html = '';
    for (const template of this.templates) {
      html += this._renderTemplateCard(template);
    }

    grid.innerHTML = html;
  }

  /**
   * Render a single template card
   * @param {Object} template
   */
  _renderTemplateCard(template) {
    const t = (key) => {
      const val = window.I18n?.t?.(key);
      return val && val !== key ? val : key;
    };

    // Thumbnail with fallback
    // Backend returns thumbnail_url, frontend also accepts thumbnail/preview_image for compatibility
    const thumbnail = template.thumbnail_url || template.thumbnail || template.preview_image || '';
    if (!thumbnail) {
      console.log('[WorkflowTemplateList] Template card missing thumbnail:', template.id, template.name);
    }
    const thumbnailStyle = thumbnail
      ? `background-image: url('${thumbnail}')`
      : 'background: linear-gradient(135deg, var(--muted) 0%, var(--surface) 100%)';

    // Category badge
    const categoryName = template.category?.name || template.category_name || '';

    // Use count
    const useCount = template.use_count || template.uses || 0;

    // EWT-12.1: Kiểm tra template có phải premium không
    const isPremiumTemplate = template.is_premium || false;

    // EWT-12.2: Kiểm tra user có quyền truy cập premium templates không
    const canAccessPremium = window.featureGate?.canAccessPremiumTemplates() || false;

    // EWT-12.3: Template bị khóa nếu là premium và user không có quyền
    const isLocked = isPremiumTemplate && !canAccessPremium;

    // Kiểm tra user đã đăng nhập để hiển thị button phù hợp
    // - Đã đăng nhập: hiển thị nút "Sử dụng" (clone qua API)
    // - Chưa đăng nhập: hiển thị nút "Nhập" (import local)
    const isLoggedIn = window.authManager?.isLoggedIn() || false;

    // EWT-6.4: Chỉ admin mới hiển thị nút "Chỉnh sửa"
    const isAdmin = window.authManager?.isAdmin?.() || false;

    // EWT-12.1: Premium badge (icon crown + text)
    const premiumBadge = isPremiumTemplate ? `
      <div class="wf-template-premium-badge" title="${t('workflow.premiumTemplate') || 'Template Premium'}">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
          <path d="M5 16L3 5L8.5 10L12 4L15.5 10L21 5L19 16H5ZM19 19C19 19.6 18.6 20 18 20H6C5.4 20 5 19.6 5 19V18H19V19Z"/>
        </svg>
        <span>Premium</span>
      </div>
    ` : '';

    // EWT-12.3: Lock overlay cho free users (khi template premium và user không có quyền)
    const lockOverlay = isLocked ? `
      <div class="wf-template-lock-overlay" data-action="upgrade">
        <div class="wf-template-lock-icon">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
            <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
          </svg>
        </div>
        <span class="wf-template-lock-text">${t('workflow.premiumRequired') || 'Yêu cầu Premium'}</span>
      </div>
    ` : '';

    // Button chỉnh sửa template (chỉ hiển thị cho admin)
    const editButton = isAdmin ? `
      <button class="wf-template-edit-btn" title="${t('workflow.editTemplate') || 'Chỉnh sửa template'}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
        </svg>
      </button>
    ` : '';

    // Button copy public share link (slug-based) — yêu cầu có slug.
    const shareButton = template.slug ? `
      <button class="wf-template-share-btn" data-template-slug="${this._escapeHtml(template.slug)}" title="${t('workflow.copyShareLink') || 'Copy link chia sẻ'}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
          <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
        </svg>
      </button>
    ` : '';

    // Button xem video demo (hiển thị khi có video_url)
    const videoButton = template.video_url ? `
      <button class="wf-template-video-btn" data-video-url="${this._escapeHtml(template.video_url)}" title="${t('workflow.watchDemo') || 'Xem video demo'}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
          <path d="M19.615 3.184c-3.604-.246-11.631-.245-15.23 0-3.897.266-4.356 2.62-4.385 8.816.029 6.185.484 8.549 4.385 8.816 3.6.245 11.626.246 15.23 0 3.897-.266 4.356-2.62 4.385-8.816-.029-6.185-.484-8.549-4.385-8.816zm-10.615 12.816v-8l8 3.993-8 4.007z"/>
        </svg>
      </button>
    ` : '';

    // Hover overlay với preview + use buttons (giống prompt template design)
    // Chỉ hiển thị nếu template không bị khóa
    const hoverOverlay = !isLocked ? `
      <div class="wf-template-hover-overlay">
        <button class="wf-template-preview-btn" title="${t('workflow.previewTemplate') || 'Xem trước'}">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
            <circle cx="12" cy="12" r="3"/>
          </svg>
        </button>
        <button class="wf-template-use-btn" title="${t('workflow.useTemplate') || 'Sử dụng template'}">
          <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor"><path d="M11.8525 4.21651L11.7221 3.2387C11.6906 3.00226 11.4889 2.82568 11.2504 2.82568C11.0118 2.82568 10.8102 3.00226 10.7786 3.23869L10.6483 4.21651C10.2658 7.0847 8.00939 9.34115 5.14119 9.72358L4.16338 9.85396C3.92694 9.88549 3.75037 10.0872 3.75037 10.3257C3.75037 10.5642 3.92694 10.7659 4.16338 10.7974L5.14119 10.9278C8.00938 11.3102 10.2658 13.5667 10.6483 16.4349L10.7786 17.4127C10.8102 17.6491 11.0118 17.8257 11.2504 17.8257C11.4889 17.8257 11.6906 17.6491 11.7221 17.4127L11.8525 16.4349C12.2349 13.5667 14.4913 11.3102 17.3595 10.9278L18.3374 10.7974C18.5738 10.7659 18.7504 10.5642 18.7504 10.3257C18.7504 10.0872 18.5738 9.88549 18.3374 9.85396L17.3595 9.72358C14.4913 9.34115 12.2349 7.0847 11.8525 4.21651Z"></path><path d="M4.6519 14.7568L4.82063 14.2084C4.84491 14.1295 4.91781 14.0757 5.00037 14.0757C5.08292 14.0757 5.15582 14.1295 5.1801 14.2084L5.34883 14.7568C5.56525 15.4602 6.11587 16.0108 6.81925 16.2272L7.36762 16.3959C7.44652 16.4202 7.50037 16.4931 7.50037 16.5757C7.50037 16.6582 7.44652 16.7311 7.36762 16.7554L6.81926 16.9241C6.11587 17.1406 5.56525 17.6912 5.34883 18.3946L5.1801 18.9429C5.15582 19.0218 5.08292 19.0757 5.00037 19.0757C4.91781 19.0757 4.84491 19.0218 4.82063 18.9429L4.65191 18.3946C4.43548 17.6912 3.88486 17.1406 3.18147 16.9241L2.63311 16.7554C2.55421 16.7311 2.50037 16.6582 2.50037 16.5757C2.50037 16.4931 2.55421 16.4202 2.63311 16.3959L3.18148 16.2272C3.88486 16.0108 4.43548 15.4602 4.6519 14.7568Z"></path></svg>
          ${t('workflow.useTemplate') || 'Sử dụng'}
        </button>
      </div>
    ` : '';

    // EWT-12.4: Upgrade overlay cho template bị khóa
    const upgradeOverlay = isLocked ? `
      <div class="wf-template-hover-overlay wf-template-hover-overlay--locked">
        <button class="wf-template-upgrade-btn" title="${t('common.upgrade') || 'Upgrade'}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <path d="M5 16L3 5L8.5 10L12 4L15.5 10L21 5L19 16H5ZM19 19C19 19.6 18.6 20 18 20H6C5.4 20 5 19.6 5 19V18H19V19Z"/>
          </svg>
          ${t('common.upgrade') || 'Upgrade'}
        </button>
      </div>
    ` : '';

    return `
      <div class="wf-template-card${isLocked ? ' wf-template-locked' : ''}${isPremiumTemplate ? ' wf-template-premium' : ''}" data-template-id="${template.id}" data-is-premium="${isPremiumTemplate}" data-is-locked="${isLocked}">
        <div class="wf-template-thumb" style="${thumbnailStyle}">
          ${!thumbnail ? `
            <svg class="wf-template-placeholder" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2"/>
              <circle cx="8.5" cy="8.5" r="1.5"/>
              <path d="M21 15l-5-5L5 21"/>
            </svg>
          ` : ''}
          ${premiumBadge}
          ${lockOverlay}
          ${hoverOverlay}
          ${upgradeOverlay}
          ${videoButton}
          ${shareButton}
          ${editButton}
        </div>
        <div class="wf-template-info">
          <div class="wf-template-name" title="${this._escapeHtml(template.name)}">${this._escapeHtml(template.name) || t('workflow.unnamed')}</div>
          <div class="wf-template-meta">
            ${categoryName ? `<span class="wf-template-category">${this._escapeHtml(categoryName)}</span>` : ''}
            <span class="wf-template-nodes-count" title="${t('workflow.nodesInWorkflow') || 'Số node'}">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M6.17 3.646a.5.5 0 0 1 .707 0l5.477 5.477a.5.5 0 0 1 0 .707l-1.366 1.366a4.373 4.373 0 1 1-6.184-6.184L6.17 3.646Zm.353 1.061L5.508 5.723 5.5 5.73a3.373 3.373 0 1 0 4.77 4.77l.006-.008 1.016-1.015-4.77-4.77Z" fill="currentColor"/><path fill-rule="evenodd" clip-rule="evenodd" d="M5.354 10.646a.5.5 0 0 1 0 .707L3.02 13.688a.5.5 0 1 1-.707-.707l2.334-2.334a.5.5 0 0 1 .707 0ZM10.354 2.313a.5.5 0 0 1 0 .707L8.02 5.354a.5.5 0 0 1-.707-.708l2.334-2.333a.5.5 0 0 1 .707 0ZM13.687 5.646a.5.5 0 0 1 0 .708l-2.333 2.333a.5.5 0 1 1-.707-.707l2.333-2.334a.5.5 0 0 1 .707 0Z" fill="currentColor"/></svg>
              ${(template.nodes || []).length} ${t('workflow.nodes') || 'nodes'}
            </span>
          </div>
          <div class="wf-template-footer">
            <span class="wf-template-use-count">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M15.5385 11.4899C17.7949 11.4899 19.641 9.65316 19.641 7.40826C19.641 5.16336 17.7949 3.32663 15.5385 3.32663C15.4359 3.32663 15.3334 3.32663 15.2308 3.32663C15.8462 4.34704 16.2564 5.57153 16.2564 6.79602C16.2564 8.53071 15.5385 10.1634 14.4103 11.3879C14.718 11.4899 15.1282 11.4899 15.5385 11.4899Z" fill="currentColor"/><path d="M17.2821 13.6326H16.2565C17.7949 14.9591 18.8206 17 18.8206 19.2448C18.8206 19.7551 18.718 20.1632 18.6154 20.5714C19.9488 20.3673 20.7693 20.0612 21.2821 19.7551C21.7949 19.4489 22.0001 18.9387 22.0001 18.3265C22.0001 15.7755 19.8462 13.6326 17.2821 13.6326Z" fill="currentColor"/><path d="M9.38459 11.4898C10.6154 11.4898 11.641 11.0817 12.5641 10.2654C13.5897 9.44903 14.1025 8.1225 14.1025 6.79597C14.1025 5.77556 13.7948 4.75515 13.1795 4.04087C12.3589 2.81638 11.0256 2.00005 9.38459 2.00005C6.82049 2.00005 4.66664 4.14291 4.66664 6.69393C4.66664 9.34699 6.82049 11.4898 9.38459 11.4898Z" fill="currentColor"/><path d="M12.1538 13.9389C11.8462 13.9389 11.641 13.8369 11.3333 13.8369H7.4359C4.46154 13.8369 2 16.2859 2 19.245C2 19.9593 2.30769 20.4695 2.82051 20.8777C3.64103 21.3879 5.58974 22.0001 9.38461 22.0001C13.1795 22.0001 15.0256 21.3879 15.9487 20.8777C15.9487 20.8777 16.0513 20.7757 16.1538 20.7757C16.5641 20.4695 16.8718 19.9593 16.8718 19.245C16.7692 16.592 14.8205 14.3471 12.1538 13.9389Z" fill="currentColor"/></svg>
              ${useCount}
            </span>
            ${this._renderRatingDisplay(template.avg_rating || template.rating_avg, template.ratings_count || template.rating_count)}
          </div>
        </div>
      </div>
    `;
  }

  /**
   * Handle template import
   * @param {Object} template
   */
  async _handleImport(template) {
    console.log('[WorkflowTemplateList] Import template:', template.id, template.name);

    const t = (key, params) => {
      const val = window.I18n?.t?.(key, params);
      return val && val !== key ? val : key;
    };

    // Show importing indicator
    const importBtns = this.container.querySelectorAll('.wf-template-import-btn');
    importBtns.forEach(btn => btn.disabled = true);

    try {
      await this._importTemplate(template);

      // Track usage (fire and forget)
      this._trackTemplateUse(template.id);

      // Show success message
      if (window.customDialog) {
        window.customDialog.alert(t('workflow.importSuccess'), { type: 'success' });
      }

    } catch (err) {
      console.error('[WorkflowTemplateList] Import failed:', err);

      // Check if it's a quota error - ApiStorage already shows modal
      if (err.code === 'QUOTA_EXCEEDED' || err.message?.includes('giới hạn')) {
        return;
      }

      // REQUIRES_LOGIN error - show login prompt (defensive, normally caught by canCreateWorkflowAsync)
      if (err.message === 'REQUIRES_LOGIN') {
        window.featureGate?.showLoginPrompt(
          t('workflow.requireLoginToImport') || 'Import template yêu cầu đăng nhập'
        );
        return;
      }

      if (window.customDialog) {
        window.customDialog.alert(t('workflow.importFailed') + ': ' + err.message, { type: 'error' });
      }
    } finally {
      importBtns.forEach(btn => btn.disabled = false);
    }
  }

  /**
   * Import template as a new workflow (WT-13.3-13.6)
   * @param {Object} template
   */
  async _importTemplate(template) {
    const t = (key, params) => {
      const val = window.I18n?.t?.(key, params);
      return val && val !== key ? val : key;
    };
    const dialog = window.customDialog || window.CustomDialog;

    // 0. Check quota (async để đảm bảo data mới nhất từ server theo user plan)
    if (window.featureGate) {
      const canCreate = await window.featureGate.canCreateWorkflowAsync();
      if (!canCreate) {
        const isLoggedIn = window.authManager?.isLoggedIn();
        if (!isLoggedIn) {
          window.featureGate.showLoginPrompt(
            t('workflow.requireLoginToImport') || 'Import template yêu cầu đăng nhập'
          );
        } else {
          const quota = window.featureGate.checkQuota('workflows_max');
          const shouldUpgrade = await dialog?.confirm(
            t('workflow.quotaLimitReached', { limit: quota.limit, used: quota.used }) ||
            `Gói của bạn giới hạn tối đa ${quota.limit} workflow. Bạn đã có ${quota.used} workflow. Nâng cấp Premium để tạo không giới hạn.`,
            {
              title: t('workflow.quotaLimitTitle') || 'Limit reached',
              type: 'warning',
              confirmText: t('common.upgrade') || 'Upgrade',
              cancelText: t('common.later') || 'Later'
            }
          );
          if (shouldUpgrade && typeof window.openUpgradeModal === 'function') {
            window.openUpgradeModal();
          }
        }
        return;
      }
    }

    // 0b. Bug fix: Check workflows_nodes_max — chống import template vượt quota.
    // Admin có thể tạo template 10 nodes nhưng user free chỉ được 5. Phải verify trước import.
    if (window.featureGate && Array.isArray(template.nodes)) {
      try {
        const nodeQuota = window.featureGate.checkQuota('workflows_nodes_max');
        const limit = nodeQuota?.limit;
        if (limit !== 'unlimited' && limit !== '-1' && limit > 0 && template.nodes.length > limit) {
          const shouldUpgrade = await dialog?.confirm(
            t('workflow.templateNodeQuotaExceeded', { count: template.nodes.length, limit }) ||
            `Template "${template.name}" có ${template.nodes.length} node nhưng gói của bạn chỉ cho phép tối đa ${limit} node/workflow. Vui lòng chọn Template có ${limit} node hoặc nâng cấp lên gói Pro.`,
            {
              title: t('workflow.limitReached') || 'Vượt giới hạn nodes',
              type: 'warning',
              confirmText: t('common.upgrade') || 'Upgrade',
              cancelText: t('common.later') || 'Later',
            }
          );
          if (shouldUpgrade) {
            if (typeof window.openUpgradeModal === 'function') {
              window.openUpgradeModal();
            } else {
              try { chrome.runtime.sendMessage({ action: 'showUpgradeModal' }); } catch (e) {}
            }
          }
          return;
        }
      } catch (e) { /* graceful: skip nếu featureGate chưa ready */ }
    }

    // 0c. Check per-node-type feature gate — template có thể chứa node yêu cầu feature
    // mà gói user hiện tại KHÔNG có (chatgpt/grok/prompt-enhance/telegram).
    // → Warning + offer upgrade trước khi import (không cho user import nhưng run fail sau).
    if (window.featureGate && Array.isArray(template.nodes)) {
      try {
        const featureMap = {
          chatgpt: 'chatgpt_enabled',
          grok: 'grok_enabled',
          telegram: 'telegram_enabled',
        };
        const missingFeatures = new Set();
        for (const node of template.nodes) {
          const featureKey = featureMap[node.node_type] || featureMap[node.type];
          if (featureKey && !window.featureGate.canUse(featureKey)) {
            missingFeatures.add(node.node_type || node.type);
          }
          // AI Agent rename (2026-05-30): AI Agent node với use_ai=true cần ai_agent_enabled
          if ((node.node_type === 'prompt' || node.type === 'prompt') && node.use_ai === true) {
            if (!window.featureGate?.canUseAiAgent?.()) {
              missingFeatures.add('ai-agent');
            }
          }
        }
        if (missingFeatures.size > 0) {
          const list = Array.from(missingFeatures).join(', ');
          const shouldUpgrade = await dialog?.confirm(
            t('workflow.templateMissingFeatures', { features: list }) ||
            `Template chứa node yêu cầu tính năng (${list}) mà gói hiện tại của bạn không hỗ trợ. Hãy nâng cấp gói để dùng template này.`,
            {
              title: t('workflow.missingFeaturesTitle') || 'Thiếu tính năng',
              type: 'warning',
              confirmText: t('common.upgrade') || 'Upgrade',
              cancelText: t('common.later') || 'Later',
            }
          );
          if (shouldUpgrade) {
            if (typeof window.openUpgradeModal === 'function') {
              window.openUpgradeModal();
            } else {
              try { chrome.runtime.sendMessage({ action: 'showUpgradeModal' }); } catch (e) {}
            }
          }
          return;
        }
      } catch (e) { /* graceful */ }
    }

    // 0b. Get unique name to avoid duplicates
    const baseName = (template.name || t('workflow.unnamed')) + ' (Import)';
    const uniqueName = await this._getUniqueName(baseName);

    // 1. Clone template data into workflow
    const workflow = {
      // UUID + timestamp tránh collision khi rapid clone từ template.
      wf_id: window.IdGenerator ? window.IdGenerator.next('wf') : ('wf_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)),
      wf_name: uniqueName,
      wf_description: template.description || '',
      enabled: true,
      // Settings from template
      parallel: template.settings?.parallel || false,
      quantity: template.settings?.quantity || 1,
      exec_delay: template.settings?.exec_delay || 3,
      exec_timeout: template.settings?.exec_timeout || 120,
      exec_retries: template.settings?.exec_retries || 2,
      stop_on_error: template.settings?.stop_on_error || false,
      // Project context
      project_id: window._currentProjectId || null,
      project_name: window._currentProjectName || null,
      created_at: Date.now(),
      updated_at: Date.now()
    };

    // 2. Clone nodes với ref_img conversion (WT-13.5)
    const { nodes, nodeIdMap } = this._convertNodesForImport(template.nodes || []);

    // 3. Clone edges với remapped node IDs
    const edges = (template.edges || []).map(e => {
      // Support both formats: source_node_id/target_node_id and source/target
      const oldSourceId = e.source_node_id || e.source;
      const oldTargetId = e.target_node_id || e.target;

      return {
        ...e,
        edge_id: e.edge_id || e.id || (window.IdGenerator ? window.IdGenerator.next('edge') : ('edge_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5))),
        // CRITICAL: Remap node IDs
        source_node_id: nodeIdMap[oldSourceId] || oldSourceId,
        target_node_id: nodeIdMap[oldTargetId] || oldTargetId,
        // Ensure edge has proper structure
        source_handle: e.source_handle || e.sourceHandle || e.output_class || 'output_1',
        target_handle: e.target_handle || e.targetHandle || e.input_class || 'input_1',
        source_port: e.source_port || e.sourcePort || null,
        target_port: e.target_port || e.targetPort || null,
      };
    });

    // 4. Save to storage (WT-13.6)
    await this._saveImportedWorkflow(workflow, nodes, edges);

    // 5. Record trial usage for anonymous users
    if (window.featureGate && !window.authManager?.isLoggedIn()) {
      await window.featureGate.recordWorkflowCreated();
    }

    // 6. Refresh featureGate to update workflow count
    if (window.featureGate) {
      window.featureGate.refresh({ force: true }).catch(e => console.warn('[WorkflowTemplateList] FeatureGate refresh failed:', e));
    }

    // 7. Switch to Workflows tab + open editor (WT-13.7)
    if (window.eventBus) {
      window.eventBus.emit('workflow:subtab_changed', { subtab: 'workflows' });
      // Small delay to ensure subtab switch completes
      setTimeout(() => {
        window.eventBus.emit('workflow:open_editor', {
          mode: 'edit',
          workflow: workflow
        });
      }, 100);
    }
  }

  /**
   * Convert template nodes for import (WT-13.5)
   * - Generate new node_ids
   * - Convert ref_img_urls to ref_thumbnails (trigger re-upload flow)
   * - Remap frame_X_source upstream node IDs
   * @param {Array} templateNodes
   * @returns {{nodes: Array, nodeIdMap: Object}} nodes và mapping cũ->mới
   */
  _convertNodesForImport(templateNodes) {
    const nodeIdMap = {}; // old_id -> new_id mapping for edges

    // Pass 1: Build nodeIdMap first
    templateNodes.forEach(node => {
      const oldNodeId = node.node_id || node.id;
      if (oldNodeId) {
        const newNodeId = window.IdGenerator ? window.IdGenerator.next('node') : ('node_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9));
        nodeIdMap[oldNodeId] = newNodeId;
      }
    });

    // Pass 2: Convert nodes with remapped IDs
    const nodes = templateNodes.map(node => {
      const oldNodeId = node.node_id || node.id;
      const newNodeId = nodeIdMap[oldNodeId] || (window.IdGenerator ? window.IdGenerator.next('node') : ('node_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9)));

      const importedNode = {
        ...node,
        node_id: newNodeId,
        status: null, // Reset status
        error_message: null,
        result_file_ids: null,
        result_thumbnails: null,
        result_file_names: null
      };

      // Convert ref_img_urls -> ref_thumbnails (trigger re-upload flow)
      if (node.ref_img_urls && Array.isArray(node.ref_img_urls) && node.ref_img_urls.length > 0) {
        const importKeys = [];
        importedNode.ref_thumbnails = {};
        importedNode.ref_file_names = {};
        node.ref_img_urls.forEach((url, idx) => {
          const key = `upload_import_${Date.now()}_${idx}_${Math.random().toString(36).substr(2, 5)}`;
          importKeys.push(key);
          importedNode.ref_thumbnails[key] = url;
        });
        // CRITICAL: ref_file_ids phải chứa các keys để editor hiển thị thumbnails
        importedNode.ref_file_ids = importKeys.join(', ');
      }

      // Same for frame URLs (video)
      if (node.frame_1_url) {
        importedNode.frame_1_file_id = '';
        importedNode.frame_1_thumbnail = node.frame_1_url;
        importedNode.frame_1_file_name = null;
      }
      if (node.frame_2_url) {
        importedNode.frame_2_file_id = '';
        importedNode.frame_2_thumbnail = node.frame_2_url;
        importedNode.frame_2_file_name = null;
      }

      // CRITICAL FIX: Remap frame_X_source if referencing upstream node
      // frame_X_source can be 'manual', '', or node_id of upstream node
      if (importedNode.frame_1_source && importedNode.frame_1_source !== 'manual' && importedNode.frame_1_source !== '') {
        importedNode.frame_1_source = nodeIdMap[importedNode.frame_1_source] || importedNode.frame_1_source;
      }
      if (importedNode.frame_2_source && importedNode.frame_2_source !== 'manual' && importedNode.frame_2_source !== '') {
        importedNode.frame_2_source = nodeIdMap[importedNode.frame_2_source] || importedNode.frame_2_source;
      }

      return importedNode;
    });

    return { nodes, nodeIdMap };
  }

  /**
   * Save imported workflow to storage (WT-13.6)
   * @param {Object} workflow
   * @param {Array} nodes
   * @param {Array} edges
   */
  async _saveImportedWorkflow(workflow, nodes, edges) {
    // Use StorageManager pattern
    if (window.storageManager) {
      await window.storageManager.saveWorkflowFull(workflow, nodes, edges);
    } else {
      // Fallback: direct chrome.storage.local
      const result = await chrome.storage.local.get(['af_workflows', 'af_nodes', 'af_edges']);
      const workflows = result.af_workflows || [];
      const allNodes = result.af_nodes || [];
      const allEdges = result.af_edges || [];

      // Add workflow
      workflows.push(workflow);

      // Add nodes (with workflow reference)
      const nodesWithWfId = nodes.map(n => ({ ...n, wf_id: workflow.wf_id }));
      allNodes.push(...nodesWithWfId);

      // Add edges (with workflow reference)
      const edgesWithWfId = edges.map(e => ({ ...e, wf_id: workflow.wf_id }));
      allEdges.push(...edgesWithWfId);

      await chrome.storage.local.set({
        'af_workflows': workflows,
        'af_nodes': allNodes,
        'af_edges': allEdges
      });
    }

    // Emit event for WorkflowList to refresh
    if (window.eventBus) {
      window.eventBus.emit('storage:workflow_full_saved', { wfId: workflow.wf_id });
      window.eventBus.emit('workflow:imported', { workflowId: workflow.wf_id });
    }

    console.log('[WorkflowTemplateList] Workflow imported:', workflow.wf_id);
  }

  /**
   * Show template detail modal (WT-13.1-13.2)
   * @param {Object} template
   */
  _showTemplateDetail(template) {
    const t = (key, params) => {
      const val = window.I18n?.t?.(key, params);
      return val && val !== key ? val : key;
    };

    console.log('[WorkflowTemplateList] Showing template detail:', {
      id: template.id,
      name: template.name,
      thumbnail_url: template.thumbnail_url,
      description: template.description
    });

    // Thumbnail with fallback
    // Backend returns thumbnail_url, frontend also accepts thumbnail/preview_image for compatibility
    const thumbnail = template.thumbnail_url || template.thumbnail || template.preview_image || '';
    const thumbnailHtml = thumbnail
      ? `<img src="${thumbnail}" class="wf-detail-thumb-img" alt="${this._escapeHtml(template.name)}" />`
      : `<div class="wf-detail-thumb-placeholder">
           <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
             <rect x="3" y="3" width="18" height="18" rx="2"/>
             <circle cx="8.5" cy="8.5" r="1.5"/>
             <path d="M21 15l-5-5L5 21"/>
           </svg>
         </div>`;

    // Category badge
    const categoryName = template.category?.name || template.category_name || '';

    // Use count
    const useCount = template.use_count || template.uses || 0;

    // Nodes preview — render gọn dạng inline pill list, color theo node type
    let nodesPreview = '';
    if (template.nodes && Array.isArray(template.nodes) && template.nodes.length > 0) {
      nodesPreview = `
        <div class="wf-detail-nodes wf-detail-nodes-compact">
          ${template.nodes.map(node => {
            const type = (node.type || node.node_type || 'default').toString().toLowerCase();
            const label = this._escapeHtml(node.node_name || node.data?.node_name || node.name || node.type || 'node');
            return `<span class="wf-detail-node-pill wf-detail-node-pill--${type}">${label}</span>`;
          }).join('')}
        </div>
      `;
    }

    // Kiểm tra user đã đăng nhập để hiển thị button phù hợp trong modal
    const isLoggedIn = window.authManager?.isLoggedIn() || false;

    // Button action chính: "Sử dụng" (clone qua API) nếu đã đăng nhập, "Nhập" (import local) nếu chưa
    const primaryActionBtn = isLoggedIn
      ? `<button class="wf-detail-use-btn">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 5v14"/>
            <path d="M5 12h14"/>
          </svg>
          ${t('workflow.useTemplate') || 'Sử dụng'}
        </button>`
      : `<button class="wf-detail-import-btn">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="7 10 12 15 17 10"/>
            <line x1="12" y1="15" x2="12" y2="3"/>
          </svg>
          ${t('workflow.importTemplate')}
        </button>`;

    // Create modal HTML
    const modalHtml = `
      <div class="wf-detail-modal-overlay">
        <div class="wf-detail-modal">
          <div class="wf-detail-header">
            <h3 class="wf-detail-title">${this._escapeHtml(template.name) || t('workflow.unnamed')}</h3>
            <div class="wf-detail-header-actions">
              ${template.video_url ? `
                <button class="wf-detail-video-btn" data-video-url="${this._escapeHtml(template.video_url)}" title="${t('workflow.watchDemo') || 'Xem video demo'}">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M19.615 3.184c-3.604-.246-11.631-.245-15.23 0-3.897.266-4.356 2.62-4.385 8.816.029 6.185.484 8.549 4.385 8.816 3.6.245 11.626.246 15.23 0 3.897-.266 4.356-2.62 4.385-8.816-.029-6.185-.484-8.549-4.385-8.816zm-10.615 12.816v-8l8 3.993-8 4.007z"/>
                  </svg>
                </button>
              ` : ''}
              <button class="wf-detail-close-btn" title="${t('common.close')}">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18"></line>
                  <line x1="6" y1="6" x2="18" y2="18"></line>
                </svg>
              </button>
            </div>
          </div>
          <div class="wf-detail-body">
            <div class="wf-detail-thumb">
              ${thumbnailHtml}
            </div>
            <div class="wf-detail-info">
              ${template.description ? `<p class="wf-detail-desc">${this._escapeHtml(template.description)}</p>` : ''}
              <div class="wf-detail-meta">
                <div class="wf-detail-meta-left">
                  ${categoryName ? `<span class="wf-detail-category">${this._escapeHtml(categoryName)}</span>` : ''}
                  <span class="wf-detail-uses">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M15.5385 11.4899C17.7949 11.4899 19.641 9.65316 19.641 7.40826C19.641 5.16336 17.7949 3.32663 15.5385 3.32663C15.4359 3.32663 15.3334 3.32663 15.2308 3.32663C15.8462 4.34704 16.2564 5.57153 16.2564 6.79602C16.2564 8.53071 15.5385 10.1634 14.4103 11.3879C14.718 11.4899 15.1282 11.4899 15.5385 11.4899Z" fill="currentColor"/><path d="M17.2821 13.6326H16.2565C17.7949 14.9591 18.8206 17 18.8206 19.2448C18.8206 19.7551 18.718 20.1632 18.6154 20.5714C19.9488 20.3673 20.7693 20.0612 21.2821 19.7551C21.7949 19.4489 22.0001 18.9387 22.0001 18.3265C22.0001 15.7755 19.8462 13.6326 17.2821 13.6326Z" fill="currentColor"/><path d="M9.38459 11.4898C10.6154 11.4898 11.641 11.0817 12.5641 10.2654C13.5897 9.44903 14.1025 8.1225 14.1025 6.79597C14.1025 5.77556 13.7948 4.75515 13.1795 4.04087C12.3589 2.81638 11.0256 2.00005 9.38459 2.00005C6.82049 2.00005 4.66664 4.14291 4.66664 6.69393C4.66664 9.34699 6.82049 11.4898 9.38459 11.4898Z" fill="currentColor"/><path d="M12.1538 13.9389C11.8462 13.9389 11.641 13.8369 11.3333 13.8369H7.4359C4.46154 13.8369 2 16.2859 2 19.245C2 19.9593 2.30769 20.4695 2.82051 20.8777C3.64103 21.3879 5.58974 22.0001 9.38461 22.0001C13.1795 22.0001 15.0256 21.3879 15.9487 20.8777C15.9487 20.8777 16.0513 20.7757 16.1538 20.7757C16.5641 20.4695 16.8718 19.9593 16.8718 19.245C16.7692 16.592 14.8205 14.3471 12.1538 13.9389Z" fill="currentColor"/></svg>
                    ${useCount} ${t('workflow.useCount')}
                  </span>
                  <span class="wf-detail-nodes-count" title="${t('workflow.nodesInWorkflow') || 'Số node trong workflow'}">
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M6.17 3.646a.5.5 0 0 1 .707 0l5.477 5.477a.5.5 0 0 1 0 .707l-1.366 1.366a4.373 4.373 0 1 1-6.184-6.184L6.17 3.646Zm.353 1.061L5.508 5.723 5.5 5.73a3.373 3.373 0 1 0 4.77 4.77l.006-.008 1.016-1.015-4.77-4.77Z" fill="currentColor"/><path fill-rule="evenodd" clip-rule="evenodd" d="M5.354 10.646a.5.5 0 0 1 0 .707L3.02 13.688a.5.5 0 1 1-.707-.707l2.334-2.334a.5.5 0 0 1 .707 0ZM10.354 2.313a.5.5 0 0 1 0 .707L8.02 5.354a.5.5 0 0 1-.707-.708l2.334-2.333a.5.5 0 0 1 .707 0ZM13.687 5.646a.5.5 0 0 1 0 .708l-2.333 2.333a.5.5 0 1 1-.707-.707l2.333-2.334a.5.5 0 0 1 .707 0Z" fill="currentColor"/></svg>
                    ${(template.nodes || []).length} ${t('workflow.nodes') || 'nodes'}
                  </span>
                </div>
                <div class="wf-detail-meta-right">
                  ${this._renderCombinedRating(template.id, template.avg_rating || template.rating_avg, template.ratings_count || template.rating_count, template.user_rating)}
                </div>
              </div>
            </div>
            ${nodesPreview}
          </div>
          <div class="wf-detail-footer">
            <button class="wf-detail-cancel-btn">${t('common.cancel')}</button>
            <button class="wf-detail-preview-btn">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                <circle cx="12" cy="12" r="3"/>
              </svg>
              ${t('workflow.previewBtn') || 'Xem trước'}
            </button>
            ${primaryActionBtn}
          </div>
        </div>
      </div>
    `;

    // Remove existing modal if any
    const existingModal = document.querySelector('.wf-detail-modal-overlay');
    if (existingModal) existingModal.remove();

    // Insert modal
    document.body.insertAdjacentHTML('beforeend', modalHtml);

    const modalOverlay = document.querySelector('.wf-detail-modal-overlay');
    const closeBtn = modalOverlay.querySelector('.wf-detail-close-btn');
    const cancelBtn = modalOverlay.querySelector('.wf-detail-cancel-btn');
    const importBtn = modalOverlay.querySelector('.wf-detail-import-btn');
    const useBtn = modalOverlay.querySelector('.wf-detail-use-btn');
    const previewBtn = modalOverlay.querySelector('.wf-detail-preview-btn');

    // Close handlers
    const closeModal = () => {
      modalOverlay.remove();
    };

    closeBtn.addEventListener('click', closeModal);
    cancelBtn.addEventListener('click', closeModal);
    modalOverlay.addEventListener('click', (e) => {
      if (e.target === modalOverlay) closeModal();
    });

    // Bind interactive rating events
    this._bindInteractiveRating(modalOverlay, template.id);

    // Preview handler — mở template trong workflow editor read-only (Option B)
    // Cùng UX với shared workflow — popup editor + diagram đầy đủ + flag read-only
    if (previewBtn) {
      previewBtn.addEventListener('click', () => {
        closeModal();
        this._openTemplateInEditor(template);
      });
    }

    // Video handler — mở modal xem video YouTube
    const videoBtn = modalOverlay.querySelector('.wf-detail-video-btn');
    if (videoBtn) {
      videoBtn.addEventListener('click', () => {
        const videoUrl = videoBtn.dataset.videoUrl;
        if (videoUrl) {
          this._showVideoModal(videoUrl);
        }
      });
    }

    // Use handler (clone qua API - cho user đã đăng nhập)
    if (useBtn) {
      useBtn.addEventListener('click', async () => {
        closeModal();
        await this._copyTemplateToWorkflow(template.id);
      });
    }

    // Import handler (import local - cho user chưa đăng nhập)
    if (importBtn) {
      importBtn.addEventListener('click', async () => {
        closeModal();
        await this._handleImport(template);
      });
    }

    // ESC to close — move removeEventListener into closeModal
    const escHandler = (e) => {
      if (e.key === 'Escape') {
        closeModal();
      }
    };
    document.addEventListener('keydown', escHandler);

    // Override closeModal to include ESC handler cleanup
    const originalCloseModal = closeModal;
    const closeModalWithCleanup = () => {
      document.removeEventListener('keydown', escHandler);
      originalCloseModal();
    };

    // Rebind close handlers to use cleanup version
    closeBtn.removeEventListener('click', closeModal);
    cancelBtn.removeEventListener('click', closeModal);
    closeBtn.addEventListener('click', closeModalWithCleanup);
    cancelBtn.addEventListener('click', closeModalWithCleanup);
    modalOverlay.removeEventListener('click', closeModal);
    modalOverlay.addEventListener('click', (e) => {
      if (e.target === modalOverlay) closeModalWithCleanup();
    });

    // Rebind use handler (clone qua API - cho user đã đăng nhập)
    if (useBtn) {
      useBtn.removeEventListener('click', useBtn._handler);
      useBtn._handler = async () => {
        closeModalWithCleanup();
        await this._copyTemplateToWorkflow(template.id);
      };
      useBtn.addEventListener('click', useBtn._handler);
    }

    // Rebind import handler (import local - cho user chưa đăng nhập)
    if (importBtn) {
      importBtn.removeEventListener('click', importBtn._handler);
      importBtn._handler = async () => {
        closeModalWithCleanup();
        await this._handleImport(template);
      };
      importBtn.addEventListener('click', importBtn._handler);
    }
  }

  /**
   * Show video modal to play YouTube video
   * @param {string} videoUrl - YouTube video URL
   */
  _showVideoModal(videoUrl) {
    // Mở video trong tab mới thay vì embed (tránh lỗi 153 khi video tắt embedding)
    window.open(videoUrl, '_blank');
  }

  /**
   * Copy public share link cho template (landing /workflows/{slug}).
   * Base URL derive từ ApiBaseConfig (strip /api/vN).
   */
  async _copyTemplateShareLink(slug) {
    const t = (k) => {
      const val = window.I18n?.t?.(k);
      return val && val !== k ? val : k;
    };
    try {
      const apiBase = window.ApiBaseConfig?.get?.() || '';
      const origin = apiBase.replace(/\/api\/v\d+\/?$/, '');
      const shareUrl = `${origin}/workflows/${slug}`;
      await navigator.clipboard.writeText(shareUrl);
      window.showNotification?.(
        t('workflow.shareLinkCopied') || `Đã copy link: ${shareUrl}`,
        'success',
        3000
      );
    } catch (e) {
      console.error('[WorkflowTemplateList] Copy share link failed:', e);
      window.showNotification?.(t('workflow.shareLinkCopyFailed') || 'Không thể copy link', 'error');
    }
  }

  _showVideoModalEmbed_DISABLED(videoUrl) {
    const t = (key, params) => {
      const val = window.I18n?.t?.(key, params);
      return val && val !== key ? val : key;
    };

    // Extract YouTube video ID from URL
    let videoId = '';
    try {
      const url = new URL(videoUrl);
      if (url.hostname.includes('youtube.com')) {
        videoId = url.searchParams.get('v') || '';
      } else if (url.hostname.includes('youtu.be')) {
        videoId = url.pathname.slice(1);
      }
    } catch (e) {
      console.error('[TobyFlow] Invalid video URL:', videoUrl, e);
      return;
    }

    if (!videoId) {
      console.error('[TobyFlow] Could not extract YouTube video ID from:', videoUrl);
      return;
    }

    const embedUrl = `https://www.youtube.com/embed/${videoId}?autoplay=1&rel=0`;

    const modalHtml = `
      <div class="wf-video-modal-overlay">
        <div class="wf-video-modal">
          <div class="wf-video-modal-header">
            <h3 class="wf-video-modal-title">${t('workflow.watchDemo') || 'Xem video demo'}</h3>
            <button class="wf-video-modal-close" title="${t('common.close') || 'Close'}">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"/>
                <line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>
          <div class="wf-video-modal-body">
            <div class="wf-video-container">
              <iframe
                src="${embedUrl}"
                frameborder="0"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                allowfullscreen
              ></iframe>
            </div>
          </div>
        </div>
      </div>
    `;

    const modalContainer = document.createElement('div');
    modalContainer.innerHTML = modalHtml;
    const modalOverlay = modalContainer.firstElementChild;
    document.body.appendChild(modalOverlay);

    const closeModal = () => {
      modalOverlay.remove();
      document.removeEventListener('keydown', escHandler);
    };

    const escHandler = (e) => {
      if (e.key === 'Escape') closeModal();
    };

    const closeBtn = modalOverlay.querySelector('.wf-video-modal-close');
    closeBtn.addEventListener('click', closeModal);
    modalOverlay.addEventListener('click', (e) => {
      if (e.target === modalOverlay) closeModal();
    });
    document.addEventListener('keydown', escHandler);
  }

  /**
   * Mở template trong workflow editor (popup window) với mode read-only.
   * UX nhất quán với shared workflow — dùng cùng editor, cùng cơ chế read-only.
   * Data template KHÔNG bị ghi đè vì:
   *   - Flag _is_template_preview → editor.isReadOnly() = true → ẩn mọi action save/run/delete
   *   - wf_id giả `tpl_preview_{id}` → backend reject mọi update (workflow không tồn tại với wf_id này)
   *   - Backend ownership check (user_id) chặn mọi modify endpoint
   *
   * @param {Object} template
   */
  async _openTemplateInEditor(template) {
    // Fetch fresh template data to get latest node positions after save
    let freshTemplate = template;
    try {
      const fetched = await this._fetchTemplateById(template.id);
      if (fetched) {
        freshTemplate = fetched;
      }
    } catch (err) {
      console.warn('[WorkflowTemplateList] Failed to fetch fresh template, using cached:', err);
    }

    const previewWorkflow = this._convertTemplateToWorkflowFormat(freshTemplate);
    // Đặt flag để editor nhận diện template preview (read-only) thay vì shared workflow
    previewWorkflow._is_template_preview = true;
    previewWorkflow._template_id = freshTemplate.id;
    previewWorkflow._template_video_url = freshTemplate.video_url || null;
    // Đổi prefix wf_id để rõ ràng (tránh nhầm với workflow thật)
    previewWorkflow.wf_id = `tpl_preview_${freshTemplate.id}`;

    console.log('[WorkflowTemplateList] Opening template in editor (read-only):', {
      template_id: freshTemplate.id,
      nodes: previewWorkflow.nodes?.length,
      edges: previewWorkflow.edges?.length,
    });

    if (window.eventBus) {
      window.eventBus.emit('workflow:open_editor', {
        mode: 'view',
        workflow: previewWorkflow,
        readOnly: true,
      });
    } else {
      console.error('[WorkflowTemplateList] window.eventBus not available — cannot open template editor');
    }
  }

  /**
   * Chuyển đổi template format sang workflow format để load vào DiagramCanvas
   * @param {Object} template - Template object từ API
   * @returns {Object} - Workflow object có thể load vào DiagramCanvas
   */
  _convertTemplateToWorkflowFormat(template) {
    const nodes = (template.nodes || []).map(node => {
      // Template có thể dùng format khác (id vs node_id, type vs node_type, position vs pos_x/pos_y)
      const refImgUrls = node.ref_img_urls || node.data?.ref_img_urls || [];
      // Convert ref_img_urls → ref_thumbnails format để canvas hiển thị được
      const refThumbnails = this._convertRefImgUrlsToThumbnails(refImgUrls);

      // Convert result_img_url (string) → result_thumbnails (object) để DiagramCanvas hiển thị
      // Ưu tiên: result_thumbnails có sẵn > convert từ result_img_url
      const existingResultThumbs = node.result_thumbnails || node.data?.result_thumbnails || {};
      const resultImgUrl = node.result_img_url || node.data?.result_img_url || '';
      const convertedResultThumbs = resultImgUrl
        ? { [`result_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`]: resultImgUrl }
        : {};
      const resultThumbnails = Object.keys(existingResultThumbs).length > 0 || Object.keys(convertedResultThumbs).length > 0
        ? { ...existingResultThumbs, ...convertedResultThumbs }
        : null;

      return {
        // Spread các field còn lại trước
        ...(node.data || {}),
        node_id: node.node_id || node.id || (window.IdGenerator ? window.IdGenerator.next('node') : `node_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`),
        node_type: node.node_type || node.type,
        node_name: node.node_name || node.data?.node_name || node.name || node.type,
        pos_x: node.pos_x ?? node.position?.x ?? 100,
        pos_y: node.pos_y ?? node.position?.y ?? 100,
        // Copy các field data khác
        prompt: node.prompt || node.data?.prompt || '',
        model: node.model || node.data?.model || '',
        ratio: node.ratio || node.data?.ratio || '1:1',
        quantity: node.quantity || node.data?.quantity || 1,
        ref_img_urls: refImgUrls,
        // Merge ref_thumbnails từ template data VÀ converted từ ref_img_urls
        ref_thumbnails: { ...(node.ref_thumbnails || node.data?.ref_thumbnails || {}), ...refThumbnails },
        // Result image - convert để diagram hiển thị
        result_thumbnails: resultThumbnails,
        enabled: node.enabled !== false,
      };
    });

    const edges = (template.edges || []).map(edge => ({
      edge_id: edge.edge_id || edge.id || (window.IdGenerator ? window.IdGenerator.next('edge') : `edge_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`),
      source_node_id: edge.source_node_id || edge.source,
      target_node_id: edge.target_node_id || edge.target,
      source_handle: edge.source_handle || edge.output_class || 'output_1',
      target_handle: edge.target_handle || edge.input_class || 'input_1',
      source_port: edge.source_port || 'default',
      target_port: edge.target_port || 'default'
    }));

    return {
      wf_id: `preview_${template.id}`,
      wf_name: template.name,
      nodes,
      edges
    };
  }

  /**
   * Chuyển đổi mảng ref_img_urls thành object ref_thumbnails
   * Dùng key format `template_ref_*` để trigger re-upload khi clone
   * @param {Array} urls - Mảng URLs
   * @returns {Object} Map key -> url
   */
  _convertRefImgUrlsToThumbnails(urls) {
    if (!Array.isArray(urls) || urls.length === 0) return {};
    const result = {};
    const timestamp = Date.now();
    urls.forEach((url, idx) => {
      const key = `template_ref_${timestamp}_${idx}`;
      result[key] = url;
    });
    return result;
  }

  /**
   * EWT-7.5: Xác nhận xóa template (admin only)
   * @param {Object} template - Template cần xóa
   * @returns {Promise<boolean>} - true nếu xóa thành công
   */
  async _confirmDeleteTemplate(template) {
    const t = (key, params) => {
      const val = window.I18n?.t?.(key, params);
      return val && val !== key ? val : key;
    };
    const dialog = window.customDialog || window.CustomDialog;

    // Kiểm tra quyền admin
    if (!window.featureGate?.canManageWorkflowTemplates()) {
      window.showNotification?.(
        t('workflow.adminRequired') || 'Bạn cần quyền admin để xóa template',
        'error'
      );
      return false;
    }

    if (!dialog) {
      const confirmed = confirm(
        t('workflow.confirmDeleteTemplate', { name: template.name }) ||
        `Bạn có chắc muốn xóa template "${template.name}"? Hành động này không thể hoàn tác.`
      );
      if (!confirmed) return false;
    } else {
      const confirmed = await dialog.confirm(
        t('workflow.confirmDeleteTemplate', { name: template.name }) ||
        `Bạn có chắc muốn xóa template "${template.name}"?`,
        {
          title: t('workflow.deleteTemplate') || 'Xóa Template',
          type: 'danger',
          confirmText: t('common.delete') || 'Xóa',
          cancelText: t('common.cancel') || 'Hủy'
        }
      );
      if (!confirmed) return false;
    }

    try {
      // Gọi API xóa template
      await this._apiCall(`admin/workflow-templates/${template.id}`, 'DELETE');

      // Hiển thị thông báo thành công
      window.showNotification?.(
        t('workflow.deleteTemplateSuccess') || 'Template deleted successfully',
        'success'
      );

      // Refresh danh sách template
      this._loadTemplates(false);

      return true;
    } catch (err) {
      console.error('[WorkflowTemplateList] Xóa template thất bại:', err);
      window.showNotification?.(
        t('workflow.deleteTemplateFailed') || 'Không thể xóa template',
        'error'
      );
      return false;
    }
  }

  /**
   * Track template usage
   * @param {number|string} templateId
   */
  async _trackTemplateUse(templateId) {
    try {
      await this._apiCall(`workflow-templates/${templateId}/use`, 'POST');
    } catch (err) {
      // Ignore tracking errors
      console.warn('[WorkflowTemplateList] Failed to track template use:', err);
    }
  }

  /**
   * EWT-13: Hiển thị modal xác nhận trước khi sử dụng template
   * @param {Object} template - Template object
   * @returns {Promise<boolean>} - true nếu user xác nhận, false nếu cancel
   */
  async _showUseTemplateConfirmation(template) {
    const t = (key, params) => {
      const val = window.I18n?.t?.(key, params);
      return val && val !== key ? val : key;
    };

    return new Promise((resolve) => {
      // Thumbnail với fallback
      const thumbnail = template.thumbnail_url || template.thumbnail || template.preview_image || '';
      const thumbnailHtml = thumbnail
        ? `<img src="${thumbnail}" class="wf-confirm-thumb-img" alt="${this._escapeHtml(template.name)}" />`
        : `<div class="wf-confirm-thumb-placeholder">
             <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
               <rect x="3" y="3" width="18" height="18" rx="2"/>
               <circle cx="8.5" cy="8.5" r="1.5"/>
               <path d="M21 15l-5-5L5 21"/>
             </svg>
           </div>`;

      // Node count
      const nodeCount = (template.nodes || []).length;

      // Modal HTML
      const modalHtml = `
        <div class="wf-confirm-modal-overlay" id="useTemplateConfirmModal">
          <div class="wf-confirm-modal">
            <div class="wf-confirm-header">
              <h3 class="wf-confirm-title">${t('workflow.useTemplateConfirmTitle') || 'Sử dụng Template'}</h3>
              <button class="wf-confirm-close-btn" data-action="cancel" title="${t('common.close') || 'Close'}">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <line x1="18" y1="6" x2="6" y2="18"></line>
                  <line x1="6" y1="6" x2="18" y2="18"></line>
                </svg>
              </button>
            </div>
            <div class="wf-confirm-body">
              <div class="wf-confirm-template-info">
                <div class="wf-confirm-thumb">${thumbnailHtml}</div>
                <div class="wf-confirm-details">
                  <h4 class="wf-confirm-name">${this._escapeHtml(template.name) || t('workflow.unnamed')}</h4>
                  ${template.description ? `<p class="wf-confirm-desc">${this._escapeHtml(template.description)}</p>` : ''}
                  <div class="wf-confirm-meta">
                    <span class="wf-confirm-nodes">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="6" cy="6" r="3"/>
                        <circle cx="18" cy="18" r="3"/>
                        <path d="M9 6h6a3 3 0 0 1 3 3v6"/>
                      </svg>
                      ${nodeCount} ${t('workflow.nodes') || 'nodes'}
                    </span>
                  </div>
                </div>
              </div>
              <div class="wf-confirm-message">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <circle cx="12" cy="12" r="10"/>
                  <line x1="12" y1="16" x2="12" y2="12"/>
                  <line x1="12" y1="8" x2="12.01" y2="8"/>
                </svg>
                <span>${t('workflow.useTemplateConfirmMessage') || 'Template sẽ được sao chép thành workflow mới trong tài khoản của bạn. Bạn có thể chỉnh sửa thoải mái mà không ảnh hưởng đến template gốc.'}</span>
              </div>
            </div>
            <div class="wf-confirm-footer">
              <button class="wf-confirm-cancel-btn" data-action="cancel">
                ${t('common.cancel') || 'Hủy'}
              </button>
              <button class="wf-confirm-use-btn" data-action="confirm">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M12 5v14"/>
                  <path d="M5 12h14"/>
                </svg>
                ${t('workflow.useTemplate') || 'Sử dụng'}
              </button>
            </div>
          </div>
        </div>
      `;

      // 2026-05-25: Defensive cleanup — remove ANY stale modal với cùng ID trước khi tạo mới.
      // Tránh duplicate ID conflict (vd race condition mở 2 lần) → getElementById trả về OLD instance
      // → addEventListener attach trên OLD (hidden) → user click NEW → no listener → "Cancel ko đc".
      document.querySelectorAll('#useTemplateConfirmModal').forEach(el => {
        // Cleanup wrapper div nếu có
        const wrapper = el.parentElement?.children.length === 1 ? el.parentElement : null;
        el.remove();
        if (wrapper && wrapper.parentElement === document.body) wrapper.remove();
      });

      // Add modal to DOM
      const modalContainer = document.createElement('div');
      modalContainer.innerHTML = modalHtml;
      document.body.appendChild(modalContainer);

      // Query trong modalContainer (đảm bảo đúng instance) thay vì document.getElementById.
      // getElementById có thể trả về OLD instance nếu ID conflict.
      const modal = modalContainer.querySelector('#useTemplateConfirmModal');

      // Handle actions
      const handleAction = (action) => {
        document.removeEventListener('keydown', handleKeyDown);
        modal?.remove();
        modalContainer?.remove();
        resolve(action === 'confirm');
      };

      // ESC key to cancel (declared trước để handleAction reference)
      const handleKeyDown = (e) => {
        if (e.key === 'Escape') {
          handleAction('cancel');
        }
      };

      if (!modal) {
        // Defensive: nếu modal null (HTML render fail) → resolve false ngay, tránh hang
        console.warn('[WorkflowTemplateList] useTemplateConfirmModal element not found after render');
        modalContainer?.remove();
        resolve(false);
        return;
      }

      // Event listeners
      modal.addEventListener('click', (e) => {
        const action = e.target.closest('[data-action]')?.dataset?.action;
        if (action) {
          handleAction(action);
          return;
        }
        // Click outside modal content = cancel
        if (e.target === modal) {
          handleAction('cancel');
        }
      });

      document.addEventListener('keydown', handleKeyDown);

      // Focus confirm button
      setTimeout(() => {
        modal?.querySelector('.wf-confirm-use-btn')?.focus();
      }, 100);
    });
  }

  /**
   * EWT-8.1: Copy template về workflow cá nhân thông qua API clone
   * Thay vì import local, gọi API backend để clone template thành workflow mới
   * @param {number|string} templateId - ID của template cần copy
   */
  async _copyTemplateToWorkflow(templateId) {
    const t = (key, params) => {
      const val = window.I18n?.t?.(key, params);
      return val && val !== key ? val : key;
    };
    const dialog = window.customDialog || window.CustomDialog;

    // Lock để tránh duplicate click
    if (this._isCopyingTemplate) {
      console.log('[WorkflowTemplateList] Copy already in progress, ignoring duplicate click');
      return;
    }

    // Rate limit protection: tối thiểu 3 giây giữa các lần clone
    const now = Date.now();
    const cooldownMs = 3000;
    if (this._lastCloneTime && (now - this._lastCloneTime) < cooldownMs) {
      const waitSec = Math.ceil((cooldownMs - (now - this._lastCloneTime)) / 1000);
      window.showNotification?.(
        t('workflow.pleaseWaitBeforeClone', { seconds: waitSec }) || `Vui lòng đợi ${waitSec} giây trước khi sao chép template tiếp theo`,
        'warning'
      );
      return;
    }

    // EWT-13: Lấy template info để hiện confirmation modal
    const template = this.templates.find(tpl => String(tpl.id) === String(templateId));
    if (!template) {
      window.showNotification?.(
        t('workflow.templateNotFound') || 'Không tìm thấy template',
        'error'
      );
      return;
    }

    // 2026-05-25: Set lock TRƯỚC khi show modal — tránh race mở duplicate confirm modal.
    // Trước fix: lock set ở line ~1971 (sau confirmation) → user click nhanh 2 lần → 2 confirm
    // modals stack với cùng ID → listener attach trên modal đầu → click cancel trên modal sau
    // không có listener → "Cancel ko đc".
    this._isCopyingTemplate = true;

    // EWT-13: Hiện confirmation modal
    let confirmed = false;
    try {
      confirmed = await this._showUseTemplateConfirmation(template);
    } catch (e) {
      this._isCopyingTemplate = false;
      throw e;
    }
    if (!confirmed) {
      console.log('[WorkflowTemplateList] User cancelled use template confirmation');
      this._isCopyingTemplate = false;
      return;
    }

    try {

      // Kiểm tra đăng nhập trước khi gọi API clone
      if (!window.authManager?.isLoggedIn()) {
        window.showNotification?.(
          t('workflow.loginRequiredToCopy') || 'Vui lòng đăng nhập để sao chép template',
          'warning'
        );
        // Hiển thị login prompt nếu có
        if (window.featureGate?.showLoginPrompt) {
          window.featureGate.showLoginPrompt(
            t('workflow.loginToCloneTemplate') || 'Login to clone this template to your workflows'
          );
        }
        return;
      }

      // Pre-check workflows_enabled — user xem template OK nhưng tạo workflow yêu cầu quyền riêng.
      // Guest → modal Login; Logged-in plan thấp → modal Upgrade.
      if (window.featureGate && !window.featureGate.canUse('workflows_enabled')) {
        const isLoggedIn = window.authManager?.isLoggedIn?.();
        const ctaText = isLoggedIn ? (t('common.upgrade') || 'Upgrade') : (t('auth.login') || 'Login');
        const titleText = isLoggedIn
          ? (t('featuregate.featureLockedTitle') || 'Tính năng bị khóa')
          : (t('featuregate.loginRequiredTitle') || 'Yêu cầu đăng nhập');
        const msgText = isLoggedIn
          ? (t('workflow.useTemplateRequiresUpgrade') || 'Tính năng tạo workflow chưa được kích hoạt cho gói của bạn. Nâng cấp để sao chép template về tài khoản.')
          : (t('workflow.useTemplateRequiresLogin') || 'Bạn cần đăng nhập để sao chép template về tài khoản của mình.');

        const ok = await dialog?.confirm(msgText, {
          title: titleText,
          type: 'warning',
          confirmText: ctaText,
          cancelText: t('common.later') || 'Later',
        });
        if (ok) {
          if (isLoggedIn) {
            if (typeof window.openUpgradeModal === 'function') {
              window.openUpgradeModal();
            } else {
              try { chrome.runtime.sendMessage({ action: 'showUpgradeModal' }); } catch (e) {}
            }
          } else {
            const loginOverlay = document.getElementById('loginOverlay');
            if (loginOverlay) loginOverlay.classList.remove('hidden');
          }
        }
        return;
      }

      // EWT-12.4: Kiểm tra premium template access trước khi clone
      const template = this.templates.find(tpl => String(tpl.id) === String(templateId));
      if (template?.is_premium && !window.featureGate?.canAccessPremiumTemplates()) {
        const shouldUpgrade = await dialog?.confirm(
          t('workflow.premiumTemplateRequired') ||
          'Bạn cần nâng cấp gói để sử dụng template premium này.',
          {
            title: t('workflow.premiumRequired') || 'Yêu cầu Premium',
            type: 'warning',
            confirmText: t('common.upgrade') || 'Upgrade',
            cancelText: t('common.later') || 'Later'
          }
        );
        if (shouldUpgrade) {
          if (typeof window.openUpgradeModal === 'function') {
            window.openUpgradeModal();
          } else {
            try { chrome.runtime.sendMessage({ action: 'showUpgradeModal' }); } catch (e) {}
          }
        }
        return;
      }

      // EWT-8.4: Kiểm tra quota workflows_max trước khi clone
      if (window.featureGate) {
        // Force refresh: backend trả usage_today = workflows()->count() động.
        // Cache local có thể stale sau khi user xóa workflow ở tab khác hoặc trước đó
        // (refresh() thường bị guard SSE skip — xem FeatureGate.refresh:205).
        try { await window.featureGate.refresh({ force: true }); } catch (e) { /* ignore, dùng cache */ }
        const quota = window.featureGate.checkQuota('workflows_max');
        if (quota.limit !== 'unlimited' && quota.limit > 0 && quota.used >= quota.limit) {
          const shouldUpgrade = await dialog?.confirm(
            t('workflow.quotaLimitReached', { limit: quota.limit, used: quota.used }) ||
            `Gói của bạn giới hạn tối đa ${quota.limit} workflow. Bạn đã có ${quota.used} workflow. Nâng cấp Premium để tạo không giới hạn.`,
            {
              title: t('workflow.quotaLimitTitle') || 'Limit reached',
              type: 'warning',
              confirmText: t('common.upgrade') || 'Upgrade',
              cancelText: t('common.later') || 'Later'
            }
          );
          if (shouldUpgrade) {
            if (typeof window.openUpgradeModal === 'function') {
              window.openUpgradeModal();
            } else {
              try { chrome.runtime.sendMessage({ action: 'showUpgradeModal' }); } catch (e) {}
            }
          }
          return;
        }
      }

      // Hiển thị loading notification
      window.showNotification?.(
        t('workflow.copyingTemplate') || 'Copying template...',
        'info',
        2000
      );

      // Gọi API clone template, gán vào project hiện tại nếu có
      const response = await window.authManager._apiCall(
        'POST',
        `workflow-templates/${templateId}/clone`,
        { project_id: window._currentProjectId || null }
      );

      if (response?.workflow) {
        const newWorkflow = response.workflow;
        console.log('[WorkflowTemplateList] Template cloned successfully:', newWorkflow.wf_id);

        // EWT-8.2: Refresh workflow list sau khi copy
        // Đợi một chút để backend sync xong
        await new Promise(resolve => setTimeout(resolve, 200));

        // Refresh workflow list
        if (window.workflowList?.loadWorkflows) {
          await window.workflowList.loadWorkflows();
        }

        // Refresh featureGate để cập nhật số lượng workflow
        if (window.featureGate) {
          window.featureGate.refresh({ force: true }).catch(e =>
            console.warn('[WorkflowTemplateList] FeatureGate refresh failed:', e)
          );
        }

        // Chuyển sang tab Workflows
        const workflowsTab = document.querySelector('[data-subtab="workflows"]');
        if (workflowsTab) {
          workflowsTab.click();
        } else if (window.eventBus) {
          // Fallback: emit event để chuyển tab
          window.eventBus.emit('workflow:subtab_changed', { subtab: 'workflows' });
        }

        // EWT-8.3: Auto-open workflow editor với workflow mới
        // Delay một chút để tab switch hoàn tất
        setTimeout(() => {
          if (window.workflowList?._openWorkflow) {
            window.workflowList._openWorkflow(newWorkflow.wf_id);
          } else if (window.eventBus) {
            // Fallback: emit event để mở editor
            window.eventBus.emit('workflow:open_editor', {
              mode: 'edit',
              workflow: newWorkflow
            });
          }
        }, 300);

        // Hiển thị thông báo thành công
        window.showNotification?.(
          t('workflow.copyTemplateSuccess') || 'Template copied successfully',
          'success'
        );

      } else {
        throw new Error(t('workflow.copyTemplateNoData') || 'Không nhận được dữ liệu workflow từ server');
      }

    } catch (err) {
      console.error('[WorkflowTemplateList] Copy template to workflow failed:', err);

      // EWT-8.4: Handle errors - phân loại lỗi cụ thể
      let errorMessage = err.message || (t('workflow.copyTemplateFailed') || 'Không thể sao chép template');

      // Xử lý các loại lỗi cụ thể
      if (err.code === 'QUOTA_EXCEEDED' || err.code === 'FEATURE_DISABLED'
          || err.message?.includes('giới hạn') || err.message?.includes('quota')
          || err.message?.includes('node/workflow') || err.message?.includes('node nhưng gói')) {
        // Lỗi vượt quota / feature locked → modal upgrade
        // Trích xuất số node từ backend message nếu có, dùng frontend i18n để format message chuẩn
        let dialogMsg = t('workflow.quotaExceededOnClone') || 'Bạn đã đạt giới hạn của gói. Nâng cấp gói để tiếp tục.';

        // Parse node count và limit từ backend message nếu có (vd: "Template có 7 node... tối đa 5 node")
        const nodeMatch = err.message?.match(/có\s+(\d+)\s+node.*tối đa\s+(\d+)/i);
        if (nodeMatch) {
          const count = parseInt(nodeMatch[1], 10);
          const limit = parseInt(nodeMatch[2], 10);
          dialogMsg = t('workflow.templateNodeQuotaExceeded', { count, limit })
            || `Template có ${count} node nhưng gói của bạn chỉ cho phép tối đa ${limit} node/workflow. Vui lòng chọn Template có ${limit} node hoặc nâng cấp lên gói Pro.`;
        }
        const shouldUpgrade = await dialog?.confirm(dialogMsg, {
          title: t('workflow.quotaLimitTitle') || 'Limit reached',
          type: 'warning',
          confirmText: t('common.upgrade') || 'Upgrade',
          cancelText: t('common.later') || 'Later'
        });
        if (shouldUpgrade) {
          if (typeof window.openUpgradeModal === 'function') {
            window.openUpgradeModal();
          } else {
            try { chrome.runtime.sendMessage({ action: 'showUpgradeModal' }); } catch (e) {}
          }
        }
        return;
      }

      if (err.httpStatus === 401 || err.code === 'UNAUTHENTICATED') {
        // Lỗi xác thực - session hết hạn
        errorMessage = t('auth.sessionExpired') || 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.';
      } else if (err.httpStatus === 403 || err.code === 'FORBIDDEN') {
        // Lỗi quyền truy cập
        errorMessage = t('workflow.copyTemplateForbidden') || 'Bạn không có quyền sao chép template này';
      } else if (err.httpStatus === 404) {
        // Template không tồn tại
        errorMessage = t('workflow.templateNotFound') || 'Template không tồn tại hoặc đã bị xóa';
      } else if (err.httpStatus >= 500) {
        // Lỗi server
        errorMessage = t('common.serverError') || 'Lỗi máy chủ. Vui lòng thử lại sau.';
      }

      // Hiển thị thông báo lỗi
      window.showNotification?.(errorMessage, 'error');

      // Log chi tiết để debug
      if (err.serverData) {
        console.error('[WorkflowTemplateList] Server error data:', err.serverData);
      }
    } finally {
      this._isCopyingTemplate = false;
      this._lastCloneTime = Date.now();
    }
  }

  /**
   * EWT-6.5: Mở template trong editor để chỉnh sửa (admin only)
   * Mở window riêng với workflow-template-editor.html
   * @param {number|string} templateId - ID của template cần chỉnh sửa
   */
  async _openTemplateForEdit(templateId) {
    const t = (key, params) => {
      const val = window.I18n?.t?.(key, params);
      return val && val !== key ? val : key;
    };

    // Kiểm tra quyền admin
    if (!window.featureGate?.canManageWorkflowTemplates()) {
      window.showNotification?.(
        t('workflow.adminRequired') || 'Bạn cần quyền admin để chỉnh sửa template',
        'error'
      );
      return;
    }

    try {
      // Hiển thị loading
      window.showNotification?.(
        t('workflow.loadingTemplate') || 'Loading template...',
        'info',
        2000
      );

      // Fetch template data từ API
      const template = await this._fetchTemplateById(templateId);

      if (!template) {
        throw new Error(t('workflow.templateNotFound') || 'Không tìm thấy template');
      }

      console.log('[WorkflowTemplateList] Mở template để chỉnh sửa:', templateId, template.name);

      // Lưu template data vào storage để window mới đọc
      await chrome.storage.local.set({ '_pendingTemplate': template });

      // Mở window riêng với template editor
      this._openTemplateEditorWindow(template.id, 'edit');

    } catch (err) {
      console.error('[WorkflowTemplateList] Lỗi khi mở template để chỉnh sửa:', err);

      let errorMessage = err.message || (t('workflow.loadTemplateFailed') || 'Không thể tải template');

      if (err.httpStatus === 401 || err.code === 'UNAUTHENTICATED') {
        errorMessage = t('auth.sessionExpired') || 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.';
      } else if (err.httpStatus === 403) {
        errorMessage = t('workflow.noPermission') || 'Bạn không có quyền chỉnh sửa template này';
      } else if (err.httpStatus === 404) {
        errorMessage = t('workflow.templateNotFound') || 'Template không tồn tại hoặc đã bị xóa';
      }

      window.showNotification?.(errorMessage, 'error');
    }
  }

  /**
   * Mở window riêng cho template editor
   * Sử dụng chrome.runtime.sendMessage để mở qua background.js
   * với smart sizing giống workflow editor (1440x900 hoặc 90% Flow window)
   * @param {string|number|null} templateId - ID của template (null nếu tạo mới)
   * @param {string} mode - 'create' hoặc 'edit'
   */
  _openTemplateEditorWindow(templateId = null, mode = 'create') {
    // Gọi background.js để mở window với smart sizing
    chrome.runtime.sendMessage({
      action: 'openTemplateEditor',
      data: {
        mode,
        templateId: templateId || null
      }
    }, (response) => {
      if (response?.ok) {
        console.log('[WorkflowTemplateList] Đã gửi yêu cầu mở template editor window');
      } else {
        console.error('[WorkflowTemplateList] Lỗi mở template editor:', response?.error);
        window.showNotification?.(
          window.I18n?.t('workflow.popupBlocked') || 'Không thể mở cửa sổ template editor.',
          'warning'
        );
      }
    });
  }

  /**
   * Fetch template đầy đủ từ API theo ID
   * @param {number|string} templateId
   * @returns {Promise<Object>}
   */
  async _fetchTemplateById(templateId) {
    const result = await this._apiCall(`workflow-templates/${templateId}`);
    // API có thể trả về { data: template } hoặc trực tiếp template object
    return result?.data || result;
  }

  /**
   * EWT-10: Tạo template mới từ đầu (admin only)
   * Mở window riêng với workflow-template-editor.html
   */
  _createNewTemplate() {
    const t = (key, params) => {
      const val = window.I18n?.t?.(key, params);
      return val && val !== key ? val : key;
    };

    // Kiểm tra quyền admin
    if (!window.featureGate?.canManageWorkflowTemplates()) {
      window.showNotification?.(
        t('workflow.adminRequired') || 'Bạn cần quyền admin để tạo template',
        'error'
      );
      return;
    }

    console.log('[WorkflowTemplateList] Tạo template mới - mở window riêng');

    // Clear pending template data (để window mở ở create mode)
    chrome.storage.local.remove('_pendingTemplate');

    // Mở window riêng
    this._openTemplateEditorWindow(null, 'create');

    window.showNotification?.(
      t('workflow.openingTemplateEditor') || 'Opening template editor...',
      'info'
    );
  }

  /**
   * Handle search with debounce (400ms)
   * @param {string} query
   */
  _handleSearch(query) {
    if (this._searchTimeout) {
      clearTimeout(this._searchTimeout);
    }

    this._searchTimeout = setTimeout(() => {
      this.searchQuery = query.trim();
      this.currentPage = 1;
      this._loadTemplates(false);
    }, 400);
  }

  /**
   * Handle category filter
   * @param {string|null} categoryId
   */
  _handleCategoryFilter(categoryId) {
    if (this.selectedCategory === categoryId) return;

    this.selectedCategory = categoryId || null;
    this.currentPage = 1;

    this._loadTemplates(false);
  }

  /**
   * EWT-12.4: Hiển thị upgrade prompt modal khi user cố truy cập premium template
   * @param {Object} template - Template premium bị khóa
   */
  async _showUpgradePrompt(template) {
    const t = (key, params) => {
      const val = window.I18n?.t?.(key, params);
      return val && val !== key ? val : key;
    };
    const dialog = window.customDialog || window.CustomDialog;
    const isLoggedIn = window.authManager?.isLoggedIn() || false;

    // Tạo message tùy theo trạng thái đăng nhập
    let message = '';
    let confirmText = '';

    if (!isLoggedIn) {
      // User chưa đăng nhập: khuyến khích đăng nhập + nâng cấp
      message = t('workflow.premiumTemplateLoginRequired', { name: template.name }) ||
        `Template "${template.name}" là template Premium.\n\nĐăng nhập và nâng cấp lên gói Premium để sử dụng template này và nhiều template độc quyền khác.`;
      confirmText = t('auth.login') || 'Login';
    } else {
      // User đã đăng nhập nhưng không có premium plan
      message = t('workflow.premiumTemplateUpgradeRequired', { name: template.name }) ||
        `Template "${template.name}" là template Premium.\n\nNâng cấp lên gói Premium để sử dụng template này và truy cập đầy đủ các tính năng cao cấp.`;
      confirmText = t('common.upgrade') || 'Upgrade';
    }

    // Hiển thị dialog xác nhận
    const confirmed = await dialog?.confirm(message, {
      title: t('workflow.premiumTemplateTitle') || 'Template Premium',
      type: 'warning',
      confirmText: confirmText,
      cancelText: t('common.later') || 'Later'
    });

    if (confirmed) {
      if (!isLoggedIn) {
        // Mở login overlay
        const loginOverlay = document.getElementById('loginOverlay');
        if (loginOverlay) {
          loginOverlay.classList.remove('hidden');
        } else {
          // Fallback: mở settings page
          chrome.runtime.sendMessage({ action: 'openSettings' });
        }
      } else {
        // Mở upgrade modal
        if (typeof window.openUpgradeModal === 'function') {
          window.openUpgradeModal();
        } else {
          try { chrome.runtime.sendMessage({ action: 'showUpgradeModal' }); } catch (e) {}
        }
      }
    }
  }

  /**
   * Get unique workflow name to avoid duplicates
   * @param {string} baseName
   * @returns {Promise<string>}
   */
  async _getUniqueName(baseName) {
    // Load existing workflows
    let existingNames = [];
    if (window.storageManager) {
      const workflows = await window.storageManager.getWorkflows();
      existingNames = (workflows || []).map(w => w.wf_name);
    } else {
      const result = await chrome.storage.local.get(['af_workflows']);
      existingNames = (result.af_workflows || []).map(w => w.wf_name);
    }

    let name = baseName;
    let counter = 1;

    while (existingNames.includes(name)) {
      name = `${baseName} (${counter})`;
      counter++;
    }

    return name;
  }

  /**
   * Destroy / cleanup
   */
  destroy() {
    if (this._searchTimeout) {
      clearTimeout(this._searchTimeout);
    }

    // Remove i18n event listener
    if (this._i18nHandler && window.eventBus) {
      window.eventBus.off('i18n:changed', this._i18nHandler);
      this._i18nHandler = null;
    }

    // EWT-10: Remove template event listeners
    if (window.eventBus) {
      if (this._templateCreatedHandler) {
        window.eventBus.off('template:created', this._templateCreatedHandler);
        this._templateCreatedHandler = null;
      }
      if (this._templateUpdatedHandler) {
        window.eventBus.off('template:updated', this._templateUpdatedHandler);
        this._templateUpdatedHandler = null;
      }
      if (this._authLoginHandler) {
        window.eventBus.off('auth:login', this._authLoginHandler);
        this._authLoginHandler = null;
      }
      if (this._authLogoutHandler) {
        window.eventBus.off('auth:logout', this._authLogoutHandler);
        this._authLogoutHandler = null;
      }
      if (this._featuregateRefreshHandler) {
        window.eventBus.off('featuregate:refreshed', this._featuregateRefreshHandler);
        this._featuregateRefreshHandler = null;
      }
    }
  }
}

// Export
window.WorkflowTemplateList = WorkflowTemplateList;
