/**
 * HistoryTab - Tab hiển thị lịch sử generation
 * List view với thumbnail, prompt, time, media type, favorite, re-run, delete
 */
(function() {
  'use strict';

  const ITEMS_PER_PAGE = 20;

  class HistoryTab {
    constructor(container) {
      this.container = container;
      this.currentPage = 1;
      this.totalPages = 1;
      this.filter = 'all'; // 'all' | 'favorites'
      this.searchQuery = '';
      this.isLoading = false;
      this.initialized = false;
      this._searchTimeout = null;
      this._projectNames = {}; // Cache project names cho per-item label hiển thị
      this._cachedItems = null; // Client-side cache for filter/search
    }

    async init() {
      if (this.initialized) return;
      this.initialized = true;

      // Ensure GenerationHistory is ready
      if (window.generationHistory && !window.generationHistory.isInitialized) {
        await window.generationHistory.init();
      }

      this.render();
      this.bindEvents();
      await this.loadHistory();

      if (window.eventBus) {
        // [Show all] Bỏ listen project:changed — history giờ cross-project, không cần reload khi switch project
        // Reload history khi user login (data từ server)
        window.eventBus.on('auth:login', () => this.reload());
        // Clear history khi user logout
        window.eventBus.on('auth:logout', () => {
          this._cachedItems = null;
          this.currentPage = 1;
          this.render();
        });
      }

      console.log('[TobyFlow] HistoryTab đã khởi tạo');
    }

    reload() {
      this.currentPage = 1;
      this._cachedItems = null;
      this.loadHistory();
    }

    // ─── Render ───────────────────────────────────────────────

    render() {
      const t = (key, params) => window.I18n ? window.I18n.t(key, params) : key;

      this.container.innerHTML = `
        <div class="history-tab">
          <div class="section">
            <div class="section-header">
              <label>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="12" cy="12" r="10"></circle>
                  <polyline points="12 6 12 12 16 14"></polyline>
                </svg>
                ${t('history.title')}
              </label>
              <button class="btn btn-secondary btn-sm tobyflow-refresh-btn" id="historyRefreshBtn" data-tooltip="${t('common.reload')}" data-tooltip-pos="bottom">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>
              </button>
            </div>
            <div class="history-search-row">
              <div class="history-search-wrapper">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <circle cx="11" cy="11" r="8"></circle>
                  <path d="m21 21-4.35-4.35"></path>
                </svg>
                <input type="text" id="historySearchInput" placeholder="${t('history.searchPlaceholder')}" />
                <button class="history-search-clear hidden" id="historySearchClear" data-tooltip="${t('common.clear')}">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <line x1="18" y1="6" x2="6" y2="18"></line>
                    <line x1="6" y1="6" x2="18" y2="18"></line>
                  </svg>
                </button>
              </div>
            </div>
            <div class="history-filter-tabs">
              <button class="history-filter-btn active" data-filter="all">${t('history.all')}</button>
              <button class="history-filter-btn" data-filter="favorites">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
                </svg>
                ${t('history.favorites')}
              </button>
            </div>
          </div>

          <div class="history-list section" id="historyList">
            <div class="history-loading">${t('history.loading')}</div>
          </div>

          <div class="tobyflow-load-more-row hidden" id="historyLoadMore"></div>

          <div class="history-empty hidden" id="historyEmpty">
            <div class="history-empty-icon">
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.3;">
                <circle cx="12" cy="12" r="10"></circle>
                <polyline points="12 6 12 12 16 14"></polyline>
              </svg>
            </div>
            <p class="history-empty-text">${t('history.noHistoryEmpty')}</p>
          </div>
        </div>
      `;
    }

    // ─── Render single history item ───────────────────────────

    _renderSkeletons(count = 6) {
      const items = [];
      // Match real history-item: thumb (48x48) + title line + meta line (image badge + provider badge + time)
      for (let i = 0; i < count; i++) {
        const titleW = 70 + Math.random() * 22;
        items.push(`
          <div class="history-item skeleton">
            <div class="history-item-thumb skeleton-base" style="width: 48px; height: 48px; border-radius: 6px; flex-shrink: 0;"></div>
            <div class="history-item-body" style="flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px;">
              <div class="skeleton-base" style="width: ${titleW}%; height: 13px;"></div>
              <div style="display: flex; align-items: center; gap: 6px;">
                <div class="skeleton-base" style="width: 50px; height: 16px; border-radius: 8px;"></div>
                <div class="skeleton-base" style="width: 56px; height: 16px; border-radius: 8px;"></div>
                <div class="skeleton-base" style="width: 60px; height: 10px;"></div>
              </div>
            </div>
          </div>
        `);
      }
      return items.join('');
    }

    _renderItem(record) {
      const id = record.id;
      const fullPrompt = record.prompt || '';
      const prompt = this._truncate(fullPrompt, 65);
      const timeAgo = this._formatTimeAgo(record.created_at);
      const mediaType = record.media_type || 'image';
      const isFav = record.is_favorite;
      // Provider — từ GenerationHistory.js:80,113 (fallback 'flow' khi record legacy)
      const provider = record.provider || 'flow';
      const thumbRaw = (record.result_thumbnails && record.result_thumbnails.length > 0)
        ? record.result_thumbnails[0]
        : null;
      // Handle dual format: string (URL) or object { thumbnail, type, file_name }
      const thumbSrc = (typeof thumbRaw === 'object' && thumbRaw?.thumbnail)
        ? thumbRaw.thumbnail
        : (typeof thumbRaw === 'string' ? thumbRaw : '');
      const isVideoThumb = (typeof thumbRaw === 'object' && thumbRaw?.type === 'video')
        || mediaType === 'video';

      const mediaIcon = mediaType === 'video'
        ? `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>`
        : `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>`;

      // Provider badge: icon + text — keys trùng với gen.providerXxx i18n
      const providerLabel = provider === 'chatgpt' ? 'ChatGPT' : provider === 'grok' ? 'Grok' : 'Flow';
      const providerIcon = this._renderProviderIcon(provider);

      let thumbHtml;
      if (thumbSrc) {
        if (isVideoThumb) {
          thumbHtml = `<div class="history-item-thumb"><video src="${this._escapeAttr(thumbSrc)}" muted loop autoplay playsinline></video></div>`;
        } else {
          thumbHtml = `<div class="history-item-thumb"><img src="${this._escapeAttr(thumbSrc)}" alt="" loading="lazy" /></div>`;
        }
      } else {
        thumbHtml = `<div class="history-item-thumb history-item-thumb-placeholder">${mediaIcon}</div>`;
      }

      // [Show all] Hiển thị project label cho mọi item có project_id (không còn filter)
      const isCurrent = window.ProjectHelper?.isCurrentProject(record) !== false;
      const projectLabel = record.project_id
        ? `<div class="item-project-label ${isCurrent ? 'current' : ''}">${this._escapeHtml(this._projectNames[record.project_id] || '')}</div>`
        : '';

      return `
        <div class="history-item" data-id="${id}" data-media-type="${this._escapeAttr(mediaType)}" data-provider="${this._escapeAttr(provider)}" data-ratio="${this._escapeAttr(record.ratio || '')}" data-model="${this._escapeAttr(record.model || '')}" data-quantity="${record.quantity || ''}" data-auto-download="${record.auto_download ? '1' : ''}">
          ${thumbHtml}
          <div class="history-item-body">
            <div class="history-item-prompt" title="${this._escapeAttr(fullPrompt)}" data-full-prompt="${this._escapeAttr(fullPrompt)}">${this._escapeHtml(prompt)}</div>
            <div class="history-item-meta">
              <span class="history-item-badge history-item-badge-${mediaType}">${mediaIcon} ${mediaType}</span>
              <span class="history-item-provider history-item-provider-${provider}">${providerIcon}${this._escapeHtml(providerLabel)}</span>
              <span class="history-item-time">${timeAgo}</span>
            </div>
            ${projectLabel}
          </div>
          <div class="history-item-actions">
            <button class="history-action-btn history-fav-btn ${isFav ? 'is-favorite' : ''}" data-action="favorite" data-id="${id}" data-tooltip="${isFav ? (window.I18n?.t('history.unfavorite') || 'Bỏ yêu thích') : (window.I18n?.t('history.favorite') || 'Yêu thích')}" data-tooltip-pos="left">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="${isFav ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
              </svg>
            </button>
            <button class="history-action-btn history-rerun-btn" data-action="rerun" data-id="${id}" data-tooltip="${window.I18n?.t('common.rerun') || 'Chạy lại'}" data-tooltip-pos="left">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="1 4 1 10 7 10"></polyline>
                <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path>
              </svg>
            </button>
            <button class="history-action-btn history-delete-btn" data-action="delete" data-id="${id}" data-tooltip="${window.I18n?.t('common.delete') || 'Xóa'}" data-tooltip-pos="left">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="3 6 5 6 21 6"></polyline>
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
              </svg>
            </button>
          </div>
        </div>
      `;
    }

    // ─── Load history ─────────────────────────────────────────

    async loadHistory(append = false) {
      if (this.isLoading) return;
      this.isLoading = true;

      const listEl = this.container.querySelector('#historyList');
      const loadMoreEl = this.container.querySelector('#historyLoadMore');
      const emptyEl = this.container.querySelector('#historyEmpty');

      if (!append) {
        this.currentPage = 1;
        listEl.innerHTML = this._renderSkeletons(6);
      }

      try {
        let items;
        let meta = {};
        const isFavorite = this.filter === 'favorites' ? true : null;
        const cacheKey = `${this.filter}`;

        if (!append && this._cachedItems && this._cachedFilterKey === cacheKey) {
          items = this._cachedItems;
          meta = this._cachedMeta || {};
        } else {
          const result = await window.generationHistory.getHistory(this.currentPage, ITEMS_PER_PAGE, isFavorite);
          items = result.data || [];
          meta = result.meta || {};

          if (!append) {
            this._cachedItems = items;
            this._cachedMeta = meta;
            this._cachedFilterKey = cacheKey;
          } else {
            this._cachedItems = [...(this._cachedItems || []), ...items];
            this._cachedMeta = meta;
          }
        }

        // [Show all] Filter chỉ còn search query (client-side) — không còn project filter
        const filtered = this.searchQuery
          ? items.filter(item => (item.prompt || '').toLowerCase().includes(this.searchQuery.toLowerCase()))
          : items;

        this.totalPages = meta.last_page || Math.ceil((meta.total || 0) / ITEMS_PER_PAGE) || 1;

        if (!append) {
          listEl.innerHTML = '';
        }

        if (filtered.length === 0 && !append) {
          listEl.classList.add('hidden');
          loadMoreEl.classList.add('hidden');
          emptyEl.classList.remove('hidden');
        } else {
          emptyEl.classList.add('hidden');
          listEl.classList.remove('hidden');

          // Preload project names cache (cho per-item label)
          await this._preloadProjectNames(items);

          filtered.forEach(record => {
            listEl.insertAdjacentHTML('beforeend', this._renderItem(record));
          });

          // Render load-more button (workflow-style với count "loaded / total")
          this._renderLoadMore(loadMoreEl, meta);
        }
      } catch (e) {
        console.error('[TobyFlow] Tải lịch sử thất bại:', e);
        if (!append) {
          listEl.innerHTML = `<div class="history-error">${window.I18n?.t('history.loadError') || 'Không thể tải lịch sử'}</div>`;
        }
      } finally {
        this.isLoading = false;
      }
    }

    // ─── Actions ──────────────────────────────────────────────

    async _toggleFavorite(id, element) {
      const result = await window.generationHistory.toggleFavorite(id);
      if (result) {
        this._cachedItems = null;
        const isFav = result.is_favorite;
        const btn = element.closest('.history-fav-btn');
        if (btn) {
          btn.classList.toggle('is-favorite', isFav);
          const tooltipText = isFav ? (window.I18n?.t('history.unfavorite') || 'Bỏ yêu thích') : (window.I18n?.t('history.favorite') || 'Yêu thích');
          btn.setAttribute('data-tooltip', tooltipText);
          const svg = btn.querySelector('svg');
          if (svg) svg.setAttribute('fill', isFav ? 'currentColor' : 'none');
        }
      }
    }

    async _deleteRecord(id, element) {
      const confirmed = window.customDialog
        ? await window.customDialog.confirm(window.I18n?.t('history.deleteConfirm') || 'Bạn có chắc muốn xóa bản ghi này?', { title: window.I18n?.t('history.deleteHistoryTitle') || 'Xóa lịch sử', type: 'warning', confirmText: window.I18n?.t('common.delete') || 'Xóa', cancelText: window.I18n?.t('common.cancel') || 'Hủy' })
        : confirm(window.I18n?.t('history.deleteConfirm') || 'Bạn có chắc muốn xóa bản ghi này?');

      if (!confirmed) return;

      const success = await window.generationHistory.deleteRecord(id);
      if (success) {
        this._cachedItems = null;
        const item = element.closest('.history-item');
        if (item) {
          item.style.opacity = '0';
          item.style.transform = 'translateX(20px)';
          setTimeout(() => item.remove(), 200);
        }
        window.showNotification?.(window.I18n?.t('history.recordDeleted') || 'Đã xóa bản ghi', 'success');
      }
    }

    _rerunPrompt(record) {
      // Switch to Gen tab TRƯỚC khi set provider — provider tab listener cần Gen tab active.
      const genTabBtn = document.querySelector('.tobyflow-tab[data-tab="tab-gen"]');
      if (genTabBtn) genTabBtn.click();

      // Apply provider TRƯỚC: provider switch sẽ re-render gen UI (Flow/ChatGPT/Grok có UI khác nhau).
      // Gọi sau khi provider tab UI ready (Gen tab active).
      if (record.provider) {
        const providerTab = document.querySelector(`.provider-tab[data-provider="${record.provider}"]`);
        if (providerTab && !providerTab.classList.contains('provider-tab--active')) {
          providerTab.click();
        }
      }

      // Fill prompt vào Gen tab editor (full prompt — không bị truncate)
      const promptsArea = document.getElementById('promptsArea');
      if (promptsArea) {
        promptsArea.value = record.prompt || '';
        promptsArea.dispatchEvent(new Event('input', { bubbles: true }));
      }

      // Apply media_type (Image/Video)
      if (record.media_type) {
        const genType = document.getElementById('genType');
        if (genType) {
          genType.value = record.media_type;
          genType.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }

      // Apply ratio
      if (record.ratio) {
        const aspectRatio = document.getElementById('aspectRatio');
        if (aspectRatio) {
          aspectRatio.value = record.ratio;
          aspectRatio.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }

      // Apply model (imageModel hoặc videoModel tùy media_type)
      if (record.model) {
        const isVideo = (record.media_type || '').toLowerCase() === 'video';
        const modelSelect = document.getElementById(isVideo ? 'videoModel' : 'imageModel');
        if (modelSelect) {
          modelSelect.value = record.model;
          modelSelect.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }

      // Apply quantity
      if (record.quantity && record.quantity >= 1) {
        const quantitySelect = document.getElementById('quantitySelect');
        if (quantitySelect) {
          quantitySelect.value = String(record.quantity);
          quantitySelect.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }

      // Apply auto_download
      if (record.auto_download !== undefined) {
        const autoDownloadToggle = document.getElementById('genTabAutoDownload');
        if (autoDownloadToggle) {
          autoDownloadToggle.checked = !!record.auto_download;
          autoDownloadToggle.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }

      console.log('[TobyFlow] Đã điền prompt từ lịch sử (provider:', record.provider || 'flow', ', model:', record.model || 'default', ')');
    }

    // ─── Bind events ──────────────────────────────────────────

    bindEvents() {
      this._boundHandlers = [];

      // Refresh button
      const refreshBtn = this.container.querySelector('#historyRefreshBtn');
      if (refreshBtn) {
        const h = () => this.reload();
        refreshBtn.addEventListener('click', h);
        this._boundHandlers.push({ el: refreshBtn, event: 'click', handler: h });
      }

      // Filter tabs
      this.container.querySelectorAll('.history-filter-btn').forEach(btn => {
        const h = () => {
          this.container.querySelectorAll('.history-filter-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          this.filter = btn.dataset.filter;
          this.loadHistory();
        };
        btn.addEventListener('click', h);
        this._boundHandlers.push({ el: btn, event: 'click', handler: h });
      });

      // Search
      const searchInput = this.container.querySelector('#historySearchInput');
      const searchClear = this.container.querySelector('#historySearchClear');
      if (searchInput) {
        const h = () => {
          clearTimeout(this._searchTimeout);
          if (searchClear) {
            searchClear.classList.toggle('hidden', !searchInput.value.trim());
          }
          this._searchTimeout = setTimeout(() => {
            this.searchQuery = searchInput.value.trim();
            this.loadHistory();
          }, 500);
        };
        searchInput.addEventListener('input', h);
        this._boundHandlers.push({ el: searchInput, event: 'input', handler: h });
      }
      if (searchClear) {
        const h = () => {
          if (searchInput) {
            searchInput.value = '';
            searchClear.classList.add('hidden');
          }
          this.searchQuery = '';
          this.loadHistory();
        };
        searchClear.addEventListener('click', h);
        this._boundHandlers.push({ el: searchClear, event: 'click', handler: h });
      }

      // Note: Load more button được render dynamically trong _renderLoadMore() với handler riêng
      // (tránh handler stale khi innerHTML re-render) — không bind ở đây.

      // Delegate clicks on history items
      const listEl = this.container.querySelector('#historyList');
      if (listEl) {
        const h = async (e) => {
          const actionBtn = e.target.closest('[data-action]');
          if (!actionBtn) return;

          const action = actionBtn.dataset.action;
          const id = actionBtn.dataset.id;
          const item = actionBtn.closest('.history-item');

          if (action === 'favorite') {
            await this._toggleFavorite(id, actionBtn);
          } else if (action === 'delete') {
            await this._deleteRecord(id, actionBtn);
          } else if (action === 'rerun') {
            // Lookup full record từ cache (DOM prompt bị truncate ở _renderItem:133 → mất data nếu read DOM)
            const fullRecord = (this._cachedItems || []).find(r => String(r.id) === String(id));
            if (fullRecord) {
              this._rerunPrompt(fullRecord);
            } else {
              // Fallback: extract từ data attributes (set ở _renderItem)
              const promptEl = item?.querySelector('.history-item-prompt');
              const prompt = promptEl?.dataset?.fullPrompt || promptEl?.textContent || '';
              const mediaType = item?.dataset?.mediaType || 'image';
              const ratio = item?.dataset?.ratio || '';
              const provider = item?.dataset?.provider || '';
              const model = item?.dataset?.model || '';
              const quantity = item?.dataset?.quantity ? parseInt(item.dataset.quantity, 10) : null;
              const autoDownload = item?.dataset?.autoDownload === '1';
              this._rerunPrompt({ prompt, media_type: mediaType, ratio, provider, model, quantity, auto_download: autoDownload });
            }
          }
        };
        listEl.addEventListener('click', h);
        this._boundHandlers.push({ el: listEl, event: 'click', handler: h });
      }
    }

    // ─── Project name cache (cho per-item label) ───────────────

    /**
     * [Show all] Preload project names một lần để render badge per item.
     * Không còn render select filter — chỉ cần map id → name.
     */
    async _preloadProjectNames(items) {
      if (!window.ProjectHelper) return;
      const needIds = (items || [])
        .map(r => r.project_id)
        .filter(pid => pid && !this._projectNames[pid]);
      if (needIds.length === 0) return;

      try {
        const projects = await window.ProjectHelper.getProjectList();
        for (const [pid, info] of Object.entries(projects)) {
          this._projectNames[pid] = info.name;
        }
      } catch (_) { /* silent */ }
    }

    // ─── Helpers ──────────────────────────────────────────────

    /**
     * Render load-more button (workflow-style — match WorkflowList.js:494-510).
     * Hiển thị count "loaded / total" giúp user biết còn bao nhiêu records.
     */
    _renderLoadMore(loadMoreEl, meta) {
      if (!loadMoreEl) return;

      // Count records hiện đang render trên DOM (sau project + search filter)
      const listEl = this.container.querySelector('#historyList');
      const renderedCount = listEl ? listEl.querySelectorAll('.history-item').length : 0;
      const total = meta?.total || renderedCount;

      const hasMore = this.currentPage < this.totalPages;
      if (!hasMore) {
        loadMoreEl.innerHTML = '';
        loadMoreEl.classList.add('hidden');
        return;
      }

      const loadMoreLabel = window.I18n?.t('common.loadMore') || 'Load more';
      loadMoreEl.classList.remove('hidden');
      loadMoreEl.innerHTML = `
        <button class="tobyflow-load-more-btn" id="loadMoreHistoryBtn">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
          ${loadMoreLabel}
          <span class="tobyflow-load-more-count">${renderedCount} / ${total}</span>
        </button>
      `;
      // Re-bind click — innerHTML replaced button
      const btn = loadMoreEl.querySelector('#loadMoreHistoryBtn');
      if (btn) {
        btn.addEventListener('click', () => {
          if (!this.isLoading) {
            this.currentPage++;
            this.loadHistory(true);
          }
        });
      }
    }

    /**
     * Render provider icon SVG. Match với provider-tab-icon ở sidebar.html (compact 12x12).
     */
    _renderProviderIcon(provider) {
      if (provider === 'chatgpt') {
        return `<svg class="history-item-provider-icon" width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z"/></svg>`;
      }
      if (provider === 'grok') {
        return `<svg class="history-item-provider-icon" width="12" height="12" viewBox="0 0 24 24" fill="currentColor" fill-rule="evenodd"><path d="M9.27 15.29l7.978-5.897c.391-.29.95-.177 1.137.272.98 2.369.542 5.215-1.41 7.169-1.951 1.954-4.667 2.382-7.149 1.406l-2.711 1.257c3.889 2.661 8.611 2.003 11.562-.953 2.341-2.344 3.066-5.539 2.388-8.42l.006.007c-.983-4.232.242-5.924 2.75-9.383.06-.082.12-.164.179-.248l-3.301 3.305v-.01L9.267 15.292M7.623 16.723c-2.792-2.67-2.31-6.801.071-9.184 1.761-1.763 4.647-2.483 7.166-1.425l2.705-1.25a7.808 7.808 0 00-1.829-1A8.975 8.975 0 005.984 5.83c-2.533 2.536-3.33 6.436-1.962 9.764 1.022 2.487-.653 4.246-2.34 6.022-.599.63-1.199 1.259-1.682 1.925l7.62-6.815"/></svg>`;
      }
      // Default: flow
      return `<svg class="history-item-provider-icon" width="12" height="12" viewBox="0 0 24 24"><path d="M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z" fill="#3186FF"/></svg>`;
    }

    _truncate(str, maxLen) {
      if (str.length <= maxLen) return str;
      return str.substring(0, maxLen) + '...';
    }

    _formatTimeAgo(dateStr) {
      if (!dateStr) return '';
      const now = Date.now();
      const date = new Date(dateStr).getTime();
      const diffSec = Math.floor((now - date) / 1000);

      if (diffSec < 60) return window.I18n?.t('history.justNow') || 'Vừa xong';
      if (diffSec < 3600) {
        const minutes = Math.floor(diffSec / 60);
        return window.I18n?.t('history.minutesAgo', { count: minutes }) || `${minutes} phút trước`;
      }
      if (diffSec < 86400) {
        const hours = Math.floor(diffSec / 3600);
        return window.I18n?.t('history.hoursAgo', { count: hours }) || `${hours} giờ trước`;
      }

      const diffDays = Math.floor(diffSec / 86400);
      if (diffDays === 1) return window.I18n?.t('history.yesterday') || 'Hôm qua';
      if (diffDays < 30) return window.I18n?.t('history.daysAgo', { count: diffDays }) || `${diffDays} ngày trước`;
      if (diffDays < 365) {
        const months = Math.floor(diffDays / 30);
        return window.I18n?.t('history.monthsAgo', { count: months }) || `${months} tháng trước`;
      }
      const years = Math.floor(diffDays / 365);
      return window.I18n?.t('history.yearsAgo', { count: years }) || `${years} năm trước`;
    }

    _escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text || '';
      return div.innerHTML;
    }

    _escapeAttr(text) {
      return (text || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }


    destroy() {
      this.initialized = false;
      this._cachedItems = null;
      if (this._searchTimeout) clearTimeout(this._searchTimeout);
      if (this._boundHandlers) {
        for (const { el, event, handler } of this._boundHandlers) {
          el.removeEventListener(event, handler);
        }
        this._boundHandlers = null;
      }
    }
  }

  window.HistoryTab = HistoryTab;
})();
