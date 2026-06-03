/**
 * QueuePanel - UI panel hiển thị và quản lý batch queue
 * Drag-to-reorder, play/pause/stop controls, progress display
 */

(function() {
  'use strict';

  class QueuePanel {
    constructor(container) {
      this.container = container;
      this._dragState = null;
      this._boundHandlers = {};
      this.init();
    }

    init() {
      this.render();
      this.bindEvents();
    }

    render() {
      this.container.innerHTML = this._template();
      this._listEl = this.container.querySelector('.tobyflow-queue-list');
      this._emptyEl = this.container.querySelector('.tobyflow-queue-empty');
      this._progressEl = this.container.querySelector('.tobyflow-queue-progress');
      this._progressText = this.container.querySelector('.tobyflow-queue-progress-text');
      this._progressBar = this.container.querySelector('.tobyflow-queue-progress-bar-fill');
      this._updateList();
    }

    _template() {
      return `
        <div class="tobyflow-queue-panel">
          <div class="tobyflow-queue-header">
            <div class="tobyflow-queue-header-title">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="8" y1="6" x2="21" y2="6"></line>
                <line x1="8" y1="12" x2="21" y2="12"></line>
                <line x1="8" y1="18" x2="21" y2="18"></line>
                <line x1="3" y1="6" x2="3.01" y2="6"></line>
                <line x1="3" y1="12" x2="3.01" y2="12"></line>
                <line x1="3" y1="18" x2="3.01" y2="18"></line>
              </svg>
              <span>${window.I18n?.t('queue.title') || 'Hàng đợi'}</span>
            </div>
            <div class="tobyflow-queue-controls">
              <button class="tobyflow-queue-ctrl-btn" id="queuePlayPauseBtn" title="${window.I18n?.t('queue.playPause') || 'Chạy / Tạm dừng'}">
                <svg class="tobyflow-queue-icon-play" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                  <polygon points="5 3 19 12 5 21 5 3"></polygon>
                </svg>
                <svg class="tobyflow-queue-icon-pause hidden" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                  <rect x="6" y="4" width="4" height="16"></rect>
                  <rect x="14" y="4" width="4" height="16"></rect>
                </svg>
              </button>
              <button class="tobyflow-queue-ctrl-btn" id="queueStopBtn" title="${window.I18n?.t('common.stop') || 'Dừng'}">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                  <rect x="4" y="4" width="16" height="16" rx="2"></rect>
                </svg>
              </button>
              <button class="tobyflow-queue-ctrl-btn" id="queueClearBtn" title="${window.I18n?.t('queue.clearAll') || 'Xóa tất cả'}">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="3 6 5 6 21 6"></polyline>
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                </svg>
              </button>
            </div>
          </div>
          <div class="tobyflow-queue-progress hidden">
            <span class="tobyflow-queue-progress-text"></span>
            <div class="tobyflow-queue-progress-bar">
              <div class="tobyflow-queue-progress-bar-fill" style="width: 0%"></div>
            </div>
          </div>
          <div class="tobyflow-queue-list"></div>
          <div class="tobyflow-queue-empty">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="opacity: 0.3">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
              <line x1="9" y1="9" x2="15" y2="15"></line>
              <line x1="15" y1="9" x2="9" y2="15"></line>
            </svg>
            <span>${window.I18n?.t('queue.empty') || 'Chưa có tác vụ nào trong hàng đợi'}</span>
          </div>
        </div>
      `;
    }

    bindEvents() {
      const playPauseBtn = this.container.querySelector('#queuePlayPauseBtn');
      const stopBtn = this.container.querySelector('#queueStopBtn');
      const clearBtn = this.container.querySelector('#queueClearBtn');

      if (playPauseBtn) {
        playPauseBtn.addEventListener('click', () => this._handlePlayPause());
      }
      if (stopBtn) {
        stopBtn.addEventListener('click', () => {
          if (window.batchQueue) window.batchQueue.stop();
        });
      }
      if (clearBtn) {
        clearBtn.addEventListener('click', () => {
          if (window.batchQueue) window.batchQueue.clear();
        });
      }

      // Listen queue events
      this._boundHandlers.onChange = () => this._updateList();
      this._boundHandlers.onStarted = () => this._updateControls(true, false);
      this._boundHandlers.onPaused = () => this._updateControls(true, true);
      this._boundHandlers.onResumed = () => this._updateControls(true, false);
      this._boundHandlers.onStopped = () => this._updateControls(false, false);
      this._boundHandlers.onComplete = () => this._updateControls(false, false);
      this._boundHandlers.onItemComplete = (data) => this._updateProgress(data);

      window.eventBus.on('queue:changed', this._boundHandlers.onChange);
      window.eventBus.on('queue:started', this._boundHandlers.onStarted);
      window.eventBus.on('queue:paused', this._boundHandlers.onPaused);
      window.eventBus.on('queue:resumed', this._boundHandlers.onResumed);
      window.eventBus.on('queue:stopped', this._boundHandlers.onStopped);
      window.eventBus.on('queue:complete', this._boundHandlers.onComplete);
      window.eventBus.on('queue:item-complete', this._boundHandlers.onItemComplete);
    }

    _handlePlayPause() {
      if (!window.batchQueue) return;
      const bq = window.batchQueue;

      if (!bq.isRunning) {
        bq.start();
      } else if (bq.isPaused) {
        bq.resume();
      } else {
        bq.pause();
      }
    }

    _updateControls(isRunning, isPaused) {
      const playIcon = this.container.querySelector('.tobyflow-queue-icon-play');
      const pauseIcon = this.container.querySelector('.tobyflow-queue-icon-pause');

      if (isRunning && !isPaused) {
        playIcon.classList.add('hidden');
        pauseIcon.classList.remove('hidden');
      } else {
        playIcon.classList.remove('hidden');
        pauseIcon.classList.add('hidden');
      }

      if (!isRunning) {
        this._progressEl.classList.add('hidden');
      }
    }

    _updateProgress(data) {
      if (!data) return;
      this._progressEl.classList.remove('hidden');
      const completed = data.completed || 0;
      const total = data.total || 1;
      this._progressText.textContent = window.I18n?.t('queue.running', { completed, total }) || `Đang chạy ${completed}/${total}`;
      const pct = Math.round((completed / total) * 100);
      this._progressBar.style.width = pct + '%';
    }

    _updateList() {
      if (!window.batchQueue) return;
      const queue = window.batchQueue.queue;

      if (queue.length === 0) {
        this._listEl.classList.add('hidden');
        this._emptyEl.classList.remove('hidden');
        this._progressEl.classList.add('hidden');
        return;
      }

      this._listEl.classList.remove('hidden');
      this._emptyEl.classList.add('hidden');

      // Update progress if running
      if (window.batchQueue.isRunning) {
        const status = window.batchQueue.getStatus();
        this._updateProgress({ completed: status.completed, total: status.total });
      }

      this._listEl.innerHTML = queue.map((item, index) => `
        <div class="tobyflow-queue-item ${item.status === 'running' ? 'tobyflow-queue-item--running' : ''} ${item.status === 'completed' ? 'tobyflow-queue-item--completed' : ''} ${item.status === 'failed' ? 'tobyflow-queue-item--failed' : ''}"
             data-index="${index}" draggable="true">
          <div class="tobyflow-queue-item__drag">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" stroke="none">
              <circle cx="9" cy="5" r="2"></circle><circle cx="15" cy="5" r="2"></circle>
              <circle cx="9" cy="12" r="2"></circle><circle cx="15" cy="12" r="2"></circle>
              <circle cx="9" cy="19" r="2"></circle><circle cx="15" cy="19" r="2"></circle>
            </svg>
          </div>
          <div class="tobyflow-queue-item__icon">
            ${this._getTypeIcon(item.type)}
          </div>
          <div class="tobyflow-queue-item__info">
            <span class="tobyflow-queue-item__name">${this._escapeHtml(item.name)}</span>
            ${item.priority > 0 ? `<span class="tobyflow-queue-item__priority">P${item.priority}</span>` : ''}
          </div>
          <div class="tobyflow-queue-item__status">
            ${this._getStatusIcon(item.status)}
          </div>
          <button class="tobyflow-queue-item__delete" data-delete-index="${index}" title="${window.I18n?.t('common.delete') || 'Xóa'}">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>
      `).join('');

      // Bind delete buttons
      this._listEl.querySelectorAll('.tobyflow-queue-item__delete').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const idx = parseInt(btn.dataset.deleteIndex);
          if (window.batchQueue) window.batchQueue.remove(idx);
        });
      });

      // Bind drag events
      this._bindDragEvents();
    }

    _bindDragEvents() {
      const items = this._listEl.querySelectorAll('.tobyflow-queue-item');
      items.forEach(item => {
        item.addEventListener('dragstart', (e) => {
          this._dragState = { fromIndex: parseInt(item.dataset.index) };
          item.classList.add('tobyflow-queue-item--dragging');
          e.dataTransfer.effectAllowed = 'move';
        });

        item.addEventListener('dragover', (e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          item.classList.add('tobyflow-queue-item--drag-over');
        });

        item.addEventListener('dragleave', () => {
          item.classList.remove('tobyflow-queue-item--drag-over');
        });

        item.addEventListener('drop', (e) => {
          e.preventDefault();
          item.classList.remove('tobyflow-queue-item--drag-over');
          if (this._dragState) {
            const toIndex = parseInt(item.dataset.index);
            if (window.batchQueue) {
              window.batchQueue.reorder(this._dragState.fromIndex, toIndex);
            }
          }
        });

        item.addEventListener('dragend', () => {
          item.classList.remove('tobyflow-queue-item--dragging');
          this._dragState = null;
        });
      });
    }

    _getTypeIcon(type) {
      switch (type) {
        case 'prompt':
          return '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a3 3 0 0 0 -3 3v12a3 3 0 0 0 3 3"></path><path d="M6 3a3 3 0 0 1 3 3v12a3 3 0 0 1 -3 3"></path><path d="M13 7h7a1 1 0 0 1 1 1v8a1 1 0 0 1 -1 1h-7"></path><path d="M5 7h-1a1 1 0 0 0 -1 1v8a1 1 0 0 0 1 1h1"></path><path d="M17 12h.01"></path><path d="M13 12h.01"></path></svg>';
        case 'task':
          return '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 11l3 3L22 4"></path><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path></svg>';
        case 'workflow':
          return '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="18" r="3"></circle><circle cx="6" cy="6" r="3"></circle><path d="M13 6h3a2 2 0 0 1 2 2v7"></path><path d="M6 9v12"></path></svg>';
        default:
          return '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle></svg>';
      }
    }

    _getStatusIcon(status) {
      switch (status) {
        case 'running':
          return '<span class="tobyflow-queue-item__spinner"></span>';
        case 'completed':
          return '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--success)" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>';
        case 'failed':
          return '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--destructive)" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>';
        default:
          return '';
      }
    }

    _escapeHtml(str) {
      const div = document.createElement('div');
      div.textContent = str;
      return div.innerHTML;
    }

    destroy() {
      // Cleanup event listeners
      if (this._boundHandlers.onChange) {
        window.eventBus.off('queue:changed', this._boundHandlers.onChange);
        window.eventBus.off('queue:started', this._boundHandlers.onStarted);
        window.eventBus.off('queue:paused', this._boundHandlers.onPaused);
        window.eventBus.off('queue:resumed', this._boundHandlers.onResumed);
        window.eventBus.off('queue:stopped', this._boundHandlers.onStopped);
        window.eventBus.off('queue:complete', this._boundHandlers.onComplete);
        window.eventBus.off('queue:item-complete', this._boundHandlers.onItemComplete);
      }
      this.container.innerHTML = '';
    }
  }

  window.QueuePanel = QueuePanel;
})();
