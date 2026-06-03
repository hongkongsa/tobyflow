/**
 * UserPromptsManager - Quản lý prompt/snippet của người dùng
 * Lưu, tổ chức theo category, hỗ trợ biến {{variable}}
 */
(function() {
  'use strict';

  class UserPromptsManager {
    constructor() {
      this.prompts = [];
      this.isInitialized = false;
      // Pagination state
      this._currentPage = 1;
      this._lastPage = 1;
      this._total = 0;
      this._pageSize = 20;
      this._loading = false;
    }

    async init() {
      if (this.isInitialized) return;
      this.isInitialized = true;
      await this.loadPrompts();
      console.log('[TobyFlow] UserPromptsManager đã sẵn sàng');
    }

    // ─── Load prompts ─────────────────────────────────────────

    async loadPrompts(append = false) {
      if (this._loading) return;
      this._loading = true;

      if (!window.authManager?.isLoggedIn()) {
        await this._loadLocal();
        this._loading = false;
        return;
      }

      try {
        const page = append ? this._currentPage + 1 : 1;
        const response = await window.authManager._apiCall('GET', `prompts?page=${page}&per_page=${this._pageSize}`);

        const newPrompts = response.data || [];
        if (append) {
          this.prompts = [...this.prompts, ...newPrompts];
        } else {
          this.prompts = newPrompts;
        }

        // Update pagination state
        this._currentPage = response.meta?.current_page || page;
        this._lastPage = response.meta?.last_page || 1;
        this._total = response.meta?.total || this.prompts.length;
      } catch (e) {
        console.warn('[TobyFlow] Tải snippets thất bại:', e.message);
        if (!append) {
          await this._loadLocal();
        }
      } finally {
        this._loading = false;
      }
    }

    hasMore() {
      return this._currentPage < this._lastPage;
    }

    getPaginationInfo() {
      return {
        currentPage: this._currentPage,
        lastPage: this._lastPage,
        total: this._total,
        loaded: this.prompts.length
      };
    }

    // ─── CRUD ─────────────────────────────────────────────────

    async savePrompt(promptData) {
      const payload = {
        title: promptData.title || '',
        content: promptData.content || '',
        category: promptData.category || '',
        tags: promptData.tags || [],
        variables: promptData.variables || this.extractVariables(promptData.content || '')
      };

      if (!window.authManager?.isLoggedIn()) {
        payload.id = `local_${Date.now()}`;
        payload.created_at = new Date().toISOString();
        this.prompts.push(payload);
        await this._saveLocal();
        return payload;
      }

      try {
        const response = await window.authManager._apiCall('POST', 'prompts', payload);
        const saved = response.data || response;
        this.prompts.push(saved);
        console.log('[TobyFlow] Đã lưu snippet:', saved.title);
        // snippets_max.usage_today thay đổi — backend đã notify nhưng force refresh phòng SSE chậm
        if (window.featureGate) {
          window.featureGate.refresh({ force: true }).catch(() => {});
        }
        return saved;
      } catch (e) {
        console.warn('[TobyFlow] Lưu snippet thất bại:', e.message);
        // CRITICAL: Re-throw quota/permission errors - không fallback local
        if (window.QuotaErrorHandler?.isQuotaError(e) || e.code === 'FORBIDDEN' || e.status === 403) {
          throw e;
        }
        // Chỉ fallback local cho network errors hoặc transient failures
        payload.id = `local_${Date.now()}`;
        payload.created_at = new Date().toISOString();
        this.prompts.push(payload);
        await this._saveLocal();
        return payload;
      }
    }

    async updatePrompt(id, promptData) {
      const payload = {
        title: promptData.title || '',
        content: promptData.content || '',
        category: promptData.category || '',
        tags: promptData.tags || [],
        variables: promptData.variables || this.extractVariables(promptData.content || '')
      };

      // Local record
      const idStr = String(id);
      if (idStr.startsWith('local_') || !window.authManager?.isLoggedIn()) {
        const idx = this.prompts.findIndex(p => String(p.id) === idStr);
        if (idx !== -1) {
          this.prompts[idx] = { ...this.prompts[idx], ...payload };
          await this._saveLocal();
          return this.prompts[idx];
        }
        return null;
      }

      try {
        const response = await window.authManager._apiCall('PUT', `prompts/${id}`, payload);
        const updated = response.data || response;
        const idx = this.prompts.findIndex(p => String(p.id) === idStr);
        if (idx !== -1) this.prompts[idx] = updated;
        console.log('[TobyFlow] Đã cập nhật snippet:', updated.title);
        return updated;
      } catch (e) {
        console.warn('[TobyFlow] Cập nhật snippet thất bại:', e.message);
        return null;
      }
    }

    async deletePrompt(id) {
      // Local record
      const idStr = String(id);
      if (idStr.startsWith('local_') || !window.authManager?.isLoggedIn()) {
        this.prompts = this.prompts.filter(p => String(p.id) !== idStr);
        await this._saveLocal();
        return true;
      }

      try {
        await window.authManager._apiCall('DELETE', `prompts/${id}`);
        this.prompts = this.prompts.filter(p => String(p.id) !== idStr);
        console.log('[TobyFlow] Đã xóa snippet:', id);
        // snippets_max.usage_today giảm — force refresh để UI quota update ngay
        if (window.featureGate) {
          window.featureGate.refresh({ force: true }).catch(() => {});
        }
        return true;
      } catch (e) {
        console.warn('[TobyFlow] Xóa snippet thất bại:', e.message);
        return false;
      }
    }

    // ─── Query ────────────────────────────────────────────────

    getPrompts(category = null) {
      if (!category) return this.prompts;
      return this.prompts.filter(p => p.category === category);
    }

    getCategories() {
      return [...new Set(this.prompts.map(p => p.category).filter(Boolean))];
    }

    getById(id) {
      return this.prompts.find(p => String(p.id) === String(id)) || null;
    }

    // ─── Variable support ─────────────────────────────────────

    extractVariables(content) {
      const matches = content.match(/\{\{(\w+)\}\}/g);
      if (!matches) return [];
      return [...new Set(matches.map(m => m.replace(/[{}]/g, '')))];
    }

    fillVariables(content, values) {
      let result = content;
      for (const [key, value] of Object.entries(values)) {
        result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
      }
      return result;
    }

    // ─── Local storage ────────────────────────────────────────

    async _loadLocal() {
      try {
        const result = await new Promise(r => chrome.storage.local.get(['af_user_prompts'], r));
        this.prompts = result.af_user_prompts || [];
      } catch (e) {
        console.error('[TobyFlow] Đọc local snippets thất bại:', e.message);
        this.prompts = [];
      }
    }

    async _saveLocal() {
      try {
        await new Promise(r => chrome.storage.local.set({ af_user_prompts: this.prompts }, r));
      } catch (e) {
        console.error('[TobyFlow] Lưu local snippets thất bại:', e.message);
      }
    }
  }

  window.userPromptsManager = new UserPromptsManager();
  window.UserPromptsManager = UserPromptsManager;
})();
