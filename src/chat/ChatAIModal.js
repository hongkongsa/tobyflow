/**
 * ChatAIModal - Modal gửi prompt + ảnh đến ChatGPT / Gemini
 * Phase X: Chat AI Integration
 */
(function() {
  'use strict';

  class ChatAIModal {

    // ─── State ──────────────────────────────────────────────
    static _state = {
      model: 'chatgpt',   // 'chatgpt' | 'gemini'
      text: '',
      images: [],          // [{ blob, blobUrl, thumbnail, name, type, source }]
      sending: false
    };

    static _overlay = null;
    static _MAX_IMAGES = 5;

    // ─── Public API ─────────────────────────────────────────

    static open() {
      // Đóng modal cũ nếu đang mở
      if (ChatAIModal._overlay) {
        ChatAIModal.close();
      }
      ChatAIModal._state = {
        model: 'chatgpt',
        text: '',
        images: [],
        sending: false
      };
      ChatAIModal._render();
      ChatAIModal._bindEvents();
    }

    static close() {
      ChatAIModal._cleanup();
      if (ChatAIModal._overlay) {
        ChatAIModal._overlay.remove();
        ChatAIModal._overlay = null;
      }
    }

    // ─── Render ─────────────────────────────────────────────

    static _render() {
      const overlay = document.createElement('div');
      overlay.className = 'chat-ai-overlay';

      const t = (key, fallback) => window.I18n?.t(key) || fallback;
      overlay.innerHTML = `
        <div class="chat-ai-modal">
          <!-- Textarea area -->
          <div class="chat-ai-input-area">
            <textarea class="chat-ai-textarea" placeholder="${t('chatAI.placeholder', 'Nhập nội dung chat...')}" rows="1"></textarea>
          </div>

          <!-- Toolbar -->
          <div class="chat-ai-toolbar">
            <div class="chat-ai-toolbar-left">
              <!-- Add image button -->
              <button class="chat-ai-img-btn" title="${t('chatAI.addImage', 'Thêm ảnh')}">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <line x1="12" y1="5" x2="12" y2="19"></line>
                  <line x1="5" y1="12" x2="19" y2="12"></line>
                </svg>
              </button>
              <!-- Image thumbnails (inline with add button) -->
              <div class="chat-ai-images-list"></div>
            </div>

            <div class="chat-ai-toolbar-right">
              <!-- Model selector -->
              <select class="chat-ai-model-select">
                <option value="chatgpt">ChatGPT</option>
                <option value="gemini">Gemini</option>
              </select>

              <!-- Send button -->
              <button class="chat-ai-send-btn" disabled title="${t('chatAI.sendShortcut', 'Gửi (Ctrl+Enter)')}">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
                </svg>
              </button>
            </div>
          </div>
        </div>
      `;

      document.body.appendChild(overlay);
      ChatAIModal._overlay = overlay;

      // Focus vào textarea
      const textarea = overlay.querySelector('.chat-ai-textarea');
      if (textarea) {
        setTimeout(() => textarea.focus(), 100);
      }
    }

    // ─── Events ─────────────────────────────────────────────

    static _bindEvents() {
      const overlay = ChatAIModal._overlay;
      if (!overlay) return;

      // Đóng khi click overlay backdrop
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
          ChatAIModal.close();
        }
      });

      // Close button
      const closeBtn = overlay.querySelector('.chat-ai-close-btn');
      if (closeBtn) {
        closeBtn.addEventListener('click', () => ChatAIModal.close());
      }

      // Textarea input + auto-resize
      const textarea = overlay.querySelector('.chat-ai-textarea');
      if (textarea) {
        textarea.addEventListener('input', () => {
          ChatAIModal._state.text = textarea.value;
          ChatAIModal._updateSendBtn();
          ChatAIModal._autoResizeTextarea(textarea);
        });
        // Ctrl+Enter / Cmd+Enter gửi
        textarea.addEventListener('keydown', (e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault();
            ChatAIModal._onSend();
          }
        });
      }

      // Model select
      const modelSelect = overlay.querySelector('.chat-ai-model-select');
      if (modelSelect) {
        modelSelect.addEventListener('change', () => {
          ChatAIModal._state.model = modelSelect.value;
        });
      }

      // Chọn ảnh button
      const imgBtn = overlay.querySelector('.chat-ai-img-btn');
      if (imgBtn) {
        imgBtn.addEventListener('click', () => ChatAIModal._onSelectImage());
      }

      // Send button
      const sendBtn = overlay.querySelector('.chat-ai-send-btn');
      if (sendBtn) {
        sendBtn.addEventListener('click', () => ChatAIModal._onSend());
      }

      // Escape key đóng modal
      ChatAIModal._escHandler = (e) => {
        if (e.key === 'Escape') {
          ChatAIModal.close();
        }
      };
      document.addEventListener('keydown', ChatAIModal._escHandler);
    }

    // ─── Image Selection ────────────────────────────────────

    static _onSelectImage() {
      if (ChatAIModal._state.images.length >= ChatAIModal._MAX_IMAGES) {
        return;
      }

      // Dùng ImagePickerModal nếu có (chọn từ Flow + upload)
      if (window.ImagePickerModal || window.imagePickerModal) {
        const picker = window.imagePickerModal || new ImagePickerModal();
        picker.open({
          singleSelect: false,
          existingFileIds: [],
          onConfirm: (selected) => {
            if (!selected || !selected.length) return;
            ChatAIModal._addImagesFromPicker(selected);
          }
        });
        return;
      }

      // Fallback: file input
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.multiple = true;
      input.style.display = 'none';
      document.body.appendChild(input);

      input.addEventListener('change', () => {
        const files = Array.from(input.files || []);
        files.forEach(file => {
          if (ChatAIModal._state.images.length >= ChatAIModal._MAX_IMAGES) return;
          const blobUrl = URL.createObjectURL(file);
          ChatAIModal._state.images.push({
            blob: file,
            blobUrl: blobUrl,
            thumbnail: blobUrl,
            name: file.name,
            type: file.type,
            source: 'local'
          });
        });
        ChatAIModal._renderImages();
        input.remove();
      });

      input.click();
    }

    static _addImagesFromPicker(selected) {
      for (const img of selected) {
        if (ChatAIModal._state.images.length >= ChatAIModal._MAX_IMAGES) break;

        // ImagePickerModal trả về { fileId, thumbnail, source, blob? }
        const entry = {
          blob: img.blob || null,
          blobUrl: img.thumbnail || '',
          thumbnail: img.thumbnail || '',
          name: img.fileId || img.name || 'image',
          type: img.type || 'image/png',
          source: img.source || 'flow'
        };

        // Nếu là ảnh từ Flow (chỉ có thumbnail URL, không có blob) → fetch blob
        if (!entry.blob && entry.thumbnail) {
          ChatAIModal._fetchBlobFromUrl(entry.thumbnail).then(blob => {
            if (blob) {
              entry.blob = blob;
              entry.type = blob.type || 'image/png';
            }
          }).catch(() => {});
        }

        ChatAIModal._state.images.push(entry);
      }
      ChatAIModal._renderImages();
    }

    static async _fetchBlobFromUrl(url) {
      try {
        const resp = await fetch(url);
        if (resp.ok) return await resp.blob();
      } catch (e) {
        console.warn('[ChatAIModal] Không thể tải ảnh:', e.message);
      }
      return null;
    }

    static _onRemoveImage(index) {
      const removed = ChatAIModal._state.images.splice(index, 1);
      if (removed[0] && removed[0].blobUrl && removed[0].source === 'local') {
        URL.revokeObjectURL(removed[0].blobUrl);
      }
      ChatAIModal._renderImages();
    }

    // ─── Render Images ──────────────────────────────────────

    static _renderImages() {
      const overlay = ChatAIModal._overlay;
      if (!overlay) return;

      const list = overlay.querySelector('.chat-ai-images-list');
      const images = ChatAIModal._state.images;

      if (!list) return;

      if (images.length === 0) {
        list.innerHTML = '';
        return;
      }

      list.innerHTML = images.map((img, i) => `
        <div class="chat-ai-thumb" data-index="${i}">
          <img src="${img.thumbnail || img.blobUrl}" alt="${img.name || ''}" />
          <button class="chat-ai-thumb-remove" data-index="${i}" title="${window.I18n?.t('chatAI.removeImage') || 'X\u00F3a \u1EA3nh'}">
            <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>
      `).join('');

      // Bind remove buttons
      list.querySelectorAll('.chat-ai-thumb-remove').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const idx = parseInt(btn.dataset.index, 10);
          ChatAIModal._onRemoveImage(idx);
        });
      });
    }

    // ─── Send ───────────────────────────────────────────────

    static async _onSend() {
      const state = ChatAIModal._state;
      if (!state.text.trim() || state.sending) return;

      state.sending = true;
      ChatAIModal._updateSendBtn();

      try {
        // Chuyển blob sang base64
        const imagesBase64 = [];
        for (const img of state.images) {
          if (img.blob) {
            const base64 = await ChatAIModal._blobToBase64(img.blob);
            imagesBase64.push({
              base64: base64,
              name: img.name || 'image',
              type: img.type || 'image/png'
            });
          }
        }

        // UA-3.4: Theo doi gui chat AI
        window.UsageSync?.trackEvent('chat_send', { model: state.model });

        // Gửi đến background
        chrome.runtime.sendMessage({
          action: 'chatAI:send',
          model: state.model,
          text: state.text.trim(),
          images: imagesBase64
        }, (resp) => {
          if (chrome.runtime.lastError) {
            console.error('[ChatAIModal] Runtime error:', chrome.runtime.lastError.message);
            state.sending = false;
            ChatAIModal._updateSendBtn();
            ChatAIModal._showErrorDialog(window.I18n?.t('chatAI.errorConnection') || 'Lỗi kết nối', chrome.runtime.lastError.message);
            return;
          }
          if (resp?.success) {
            ChatAIModal.close();
          } else {
            console.error('[ChatAIModal] Lỗi gửi:', resp?.error);
            state.sending = false;
            ChatAIModal._updateSendBtn();
            // Hiển thị dialog thông báo lỗi
            ChatAIModal._showErrorDialog(window.I18n?.t('chatAI.errorSendFailed') || 'Không thể gửi', resp?.error);
          }
        });
      } catch (err) {
        console.error('[ChatAIModal] Lỗi:', err.message);
        state.sending = false;
        ChatAIModal._updateSendBtn();
        ChatAIModal._showErrorDialog(window.I18n?.t('exec.error') || 'Lỗi', err.message);
      }
    }

    static _blobToBase64(blob) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          // Strip data URL prefix: "data:image/png;base64,"
          const result = reader.result;
          const base64 = result.split(',')[1] || result;
          resolve(base64);
        };
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    }

    // ─── UI Helpers ─────────────────────────────────────────

    static _updateSendBtn() {
      const overlay = ChatAIModal._overlay;
      if (!overlay) return;

      const btn = overlay.querySelector('.chat-ai-send-btn');
      if (!btn) return;

      const state = ChatAIModal._state;
      const canSend = state.text.trim().length > 0 && !state.sending;
      btn.disabled = !canSend;

      if (state.sending) {
        btn.innerHTML = '<span class="chat-ai-spinner"></span>';
      } else {
        // Restore send arrow icon
        btn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>`;
      }
    }

    static _autoResizeTextarea(textarea) {
      textarea.style.height = 'auto';
      const maxHeight = 6 * 20; // 6 rows * ~20px line-height
      textarea.style.height = Math.min(textarea.scrollHeight, maxHeight) + 'px';
    }

    static _showErrorDialog(title, errorMsg) {
      const state = ChatAIModal._state;
      const modelName = state.model === 'chatgpt' ? 'ChatGPT' : 'Gemini';

      // Check if error indicates user not logged in
      const isLoginRequired = errorMsg && (
        errorMsg.includes('không tìm thấy') ||
        errorMsg.includes('Không tìm thấy') ||
        errorMsg.includes('not found') ||
        errorMsg.includes('Timeout')
      );

      let message = errorMsg || window.I18n?.t('chatAI.errorUnknown') || 'Đã xảy ra lỗi không xác định.';

      if (isLoginRequired) {
        message = window.I18n?.t('chatAI.errorInteraction', { model: modelName }) || `Không thể tương tác với ${modelName}.\n\nVui lòng kiểm tra:\n• Đã đăng nhập vào ${modelName}\n• Trang ${modelName} đã tải xong\n• Thử tải lại trang và gửi lại`;
      }

      // Use CustomDialog if available, otherwise alert
      if (window.customDialog) {
        window.customDialog.alert(title, message);
      } else {
        alert(`${title}\n\n${message}`);
      }
    }

    // ─── Cleanup ────────────────────────────────────────────

    static _cleanup() {
      // Revoke tất cả blob URLs từ local uploads
      for (const img of ChatAIModal._state.images) {
        if (img.blobUrl && img.source === 'local') {
          URL.revokeObjectURL(img.blobUrl);
        }
      }
      ChatAIModal._state.images = [];
      ChatAIModal._state.text = '';
      ChatAIModal._state.sending = false;

      // Remove escape handler
      if (ChatAIModal._escHandler) {
        document.removeEventListener('keydown', ChatAIModal._escHandler);
        ChatAIModal._escHandler = null;
      }
    }
  }

  window.ChatAIModal = ChatAIModal;
})();
