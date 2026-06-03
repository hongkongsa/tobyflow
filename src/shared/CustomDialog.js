/**
 * CustomDialog - Thay thế alert/confirm mặc định bằng UI đẹp hơn
 * Singleton, dùng chung cho toàn extension
 */
(function() {
  'use strict';

  class CustomDialog {
    constructor() {
      this._overlay = null;
    }

    /**
     * Hiển thị thông báo (thay alert)
     * @param {string} message
     * @param {Object} options - { title, type: 'info'|'warning'|'error'|'success', html: boolean, buttons: array }
     * @returns {Promise<void>}
     */
    alert(message, options = {}) {
      const { title = (window.I18n?.t('dialog.notification') || 'Thông báo'), type = 'info', html = false, buttons: customButtons } = options;
      return new Promise(resolve => {
        const defaultButtons = [
          { label: 'OK', primary: true, action: () => resolve() }
        ];
        this._show({
          title,
          message,
          type,
          html,
          buttons: customButtons || defaultButtons
        });
      });
    }

    /**
     * Hỏi xác nhận (thay confirm)
     * @param {string} message
     * @param {Object} options - { title, type, confirmText, cancelText }
     * @returns {Promise<boolean>}
     */
    confirm(message, options = {}) {
      const {
        title = (window.I18n?.t('dialog.confirm') || 'Xác nhận'),
        type = 'warning',
        confirmText = (window.I18n?.t('common.confirm') || 'Xác nhận'),
        cancelText = (window.I18n?.t('common.cancel') || 'Hủy')
      } = options;
      return new Promise(resolve => {
        this._show({
          title,
          message,
          type,
          buttons: [
            { label: cancelText, primary: false, action: () => resolve(false) },
            { label: confirmText, primary: true, action: () => resolve(true) }
          ]
        });
      });
    }

    /**
     * Xác nhận xóa - hiển thị tên item và confirm buttons
     * @param {string} message - Thông báo chính
     * @param {Object} options - { title, itemName, confirmText, cancelText }
     * @returns {Promise<boolean>}
     */
    confirmDangerous(message, options = {}) {
      const {
        title = (window.I18n?.t('dialog.confirmDangerous') || 'Xác nhận xóa'),
        itemName = '',
        confirmText = (window.I18n?.t('common.delete') || 'Xóa'),
        cancelText = (window.I18n?.t('common.cancel') || 'Hủy')
      } = options;

      return new Promise(resolve => {
        this._close();

        this._overlay = document.createElement('div');
        this._overlay.className = 'cdialog-overlay';
        this._overlay.innerHTML = `
          <div class="cdialog-box cdialog-compact">
            <div class="cdialog-header">
              <div class="cdialog-icon cdialog-error">${this._getIcon('error')}</div>
              <div class="cdialog-title">${this._escapeHtml(title)}</div>
            </div>
            <div class="cdialog-body">
              ${itemName ? `<div class="cdialog-item-name">${this._escapeHtml(itemName)}</div>` : ''}
              <div class="cdialog-message">${this._escapeHtml(message)}</div>
            </div>
            <div class="cdialog-footer">
              <button class="cdialog-btn cdialog-btn-secondary" data-action="cancel">
                ${this._escapeHtml(cancelText)}
              </button>
              <button class="cdialog-btn cdialog-btn-danger" data-action="confirm">
                ${this._escapeHtml(confirmText)}
              </button>
            </div>
          </div>
        `;

        const confirmBtn = this._overlay.querySelector('[data-action="confirm"]');
        const cancelBtn = this._overlay.querySelector('[data-action="cancel"]');

        confirmBtn.addEventListener('click', () => {
          this._close();
          resolve(true);
        });

        cancelBtn.addEventListener('click', () => {
          this._close();
          resolve(false);
        });

        this._escHandler = (e) => {
          if (e.key === 'Escape') {
            this._close();
            resolve(false);
          } else if (e.key === 'Enter') {
            this._close();
            resolve(true);
          }
        };
        document.addEventListener('keydown', this._escHandler);

        ['mousedown', 'mouseup', 'pointerdown', 'pointerup'].forEach(evt => {
          this._overlay.addEventListener(evt, (e) => e.stopPropagation());
        });

        document.body.appendChild(this._overlay);
        confirmBtn.focus();
      });
    }

    /**
     * Nhập liệu (thay prompt)
     * @param {string} message
     * @param {Object} options - { title, placeholder, confirmText, cancelText, defaultValue }
     * @returns {Promise<string|null>}
     */
    prompt(message, options = {}) {
      const {
        title = (window.I18n?.t('dialog.input') || 'Nhập liệu'),
        placeholder = '',
        confirmText = (window.I18n?.t('common.ok') || 'OK'),
        cancelText = (window.I18n?.t('common.cancel') || 'Hủy'),
        defaultValue = ''
      } = options;

      return new Promise(resolve => {
        this._showPrompt({
          title,
          message,
          placeholder,
          defaultValue,
          buttons: [
            { label: cancelText, primary: false, action: () => resolve(null) },
            { label: confirmText, primary: true, action: (val) => resolve(val) }
          ]
        });
      });
    }

    _showPrompt({ title, message, placeholder, defaultValue, buttons }) {
      this._close();

      this._overlay = document.createElement('div');
      this._overlay.className = 'cdialog-overlay';
      this._overlay.innerHTML = `
        <div class="cdialog-box">
          <div class="cdialog-header">
            <div class="cdialog-icon cdialog-info">${this._getIcon('info')}</div>
            <div class="cdialog-title">${this._escapeHtml(title)}</div>
          </div>
          <div class="cdialog-body">
            <div style="margin-bottom: 12px;">${this._escapeHtml(message)}</div>
            <input type="text" class="cdialog-input" placeholder="${this._escapeHtml(placeholder)}" value="${this._escapeHtml(defaultValue)}">
          </div>
          <div class="cdialog-footer">
            ${buttons.map((btn, i) => `
              <button class="cdialog-btn ${btn.primary ? 'cdialog-btn-primary' : 'cdialog-btn-secondary'}" data-idx="${i}">
                ${this._escapeHtml(btn.label)}
              </button>
            `).join('')}
          </div>
        </div>
      `;

      const input = this._overlay.querySelector('.cdialog-input');

      // Bind button clicks
      this._overlay.querySelectorAll('.cdialog-btn').forEach(btnEl => {
        btnEl.addEventListener('click', () => {
          const idx = parseInt(btnEl.dataset.idx);
          const val = input.value.trim();
          this._close();
          buttons[idx]?.action(val);
        });
      });

      // Enter = submit, ESC = cancel
      this._escHandler = (e) => {
        if (e.key === 'Escape') {
          this._close();
          const cancelBtn = buttons.find(b => !b.primary);
          cancelBtn?.action(null);
        } else if (e.key === 'Enter') {
          this._close();
          const confirmBtn = buttons.find(b => b.primary);
          confirmBtn?.action(input.value.trim());
        }
      };
      document.addEventListener('keydown', this._escHandler);

      // Chặn mouse events
      ['mousedown', 'mouseup', 'pointerdown', 'pointerup'].forEach(evt => {
        this._overlay.addEventListener(evt, (e) => e.stopPropagation());
      });

      document.body.appendChild(this._overlay);

      // Focus input
      setTimeout(() => {
        input.focus();
        input.select();
      }, 10);
    }

    _getIcon(type) {
      switch (type) {
        case 'warning':
          return `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"></path>
            <line x1="12" y1="9" x2="12" y2="13"></line>
            <line x1="12" y1="17" x2="12.01" y2="17"></line>
          </svg>`;
        case 'error':
          return `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="15" y1="9" x2="9" y2="15"></line>
            <line x1="9" y1="9" x2="15" y2="15"></line>
          </svg>`;
        case 'success':
          return `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
            <polyline points="22 4 12 14.01 9 11.01"></polyline>
          </svg>`;
        default: // info
          return `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="12" y1="16" x2="12" y2="12"></line>
            <line x1="12" y1="8" x2="12.01" y2="8"></line>
          </svg>`;
      }
    }

    _show({ title, message, type, buttons, html = false }) {
      this._close();

      this._overlay = document.createElement('div');
      this._overlay.className = 'cdialog-overlay';
      const messageContent = html ? message : this._escapeHtml(message);
      this._overlay.innerHTML = `
        <div class="cdialog-box">
          <div class="cdialog-header">
            <div class="cdialog-icon cdialog-${type}">${this._getIcon(type)}</div>
            <div class="cdialog-title">${this._escapeHtml(title)}</div>
          </div>
          <div class="cdialog-body">${messageContent}</div>
          <div class="cdialog-footer">
            ${buttons.map((btn, i) => `
              <button class="cdialog-btn ${btn.primary ? 'cdialog-btn-primary' : 'cdialog-btn-secondary'}" data-idx="${i}">
                ${this._escapeHtml(btn.label)}
              </button>
            `).join('')}
          </div>
        </div>
      `;

      // Bind button clicks
      this._overlay.querySelectorAll('.cdialog-btn').forEach(btnEl => {
        btnEl.addEventListener('click', (e) => {
          e.stopPropagation();
          e.preventDefault();
          const idx = parseInt(btnEl.dataset.idx);
          const action = buttons[idx]?.action;
          this._close();
          action?.();
        });
      });

      // ESC = last (cancel) button
      this._escHandler = (e) => {
        if (e.key === 'Escape') {
          this._close();
          const cancelBtn = buttons.find(b => !b.primary) || buttons[buttons.length - 1];
          cancelBtn?.action();
        }
      };
      document.addEventListener('keydown', this._escHandler);

      // Chặn tất cả mouse events không leak xuống layers bên dưới (Drawflow, etc.)
      ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'click'].forEach(evt => {
        this._overlay.addEventListener(evt, (e) => e.stopPropagation());
      });

      // Click vào overlay background (không phải dialog box) = cancel
      this._overlay.addEventListener('click', (e) => {
        if (e.target === this._overlay) {
          this._close();
          const cancelBtn = buttons.find(b => !b.primary) || buttons[buttons.length - 1];
          cancelBtn?.action();
        }
      });

      document.body.appendChild(this._overlay);

      // Focus primary button
      const primaryBtn = this._overlay.querySelector('.cdialog-btn-primary');
      primaryBtn?.focus();
    }

    _close() {
      if (this._overlay) {
        // Đảm bảo xóa khỏi DOM ngay cả khi đã bị detach
        if (this._overlay.parentNode) {
          this._overlay.parentNode.removeChild(this._overlay);
        } else {
          this._overlay.remove();
        }
        this._overlay = null;
      }
      if (this._escHandler) {
        document.removeEventListener('keydown', this._escHandler);
        this._escHandler = null;
      }
    }

    _escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text || '';
      return div.innerHTML;
    }
  }

  window.CustomDialog = CustomDialog;
  window.customDialog = new CustomDialog();
})();
