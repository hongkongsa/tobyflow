/**
 * ServerHealthCheck - Server-Only Architecture (Phase 0)
 *
 * Extension BẮT BUỘC online. Check server connectivity trước khi init.
 * Nếu server không khả dụng → hiện overlay, block tất cả features.
 */
class ServerHealthCheck {
  static _lastCheckTime = 0;
  static _lastResult = null;
  static _checkInterval = 30000; // 30s cache
  static _timeout = 5000; // 5s timeout

  /**
   * Check server health.
   * @param {boolean} forceRefresh - bypass cache
   * @returns {Promise<boolean>} true if server is healthy
   */
  static async check(forceRefresh = false) {
    // Return cached result if recent
    if (!forceRefresh && this._lastResult !== null &&
        Date.now() - this._lastCheckTime < this._checkInterval) {
      return this._lastResult;
    }

    try {
      const apiBaseUrl = window.ApiBaseConfig.get();
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this._timeout);

      const response = await fetch(`${apiBaseUrl}/health`, {
        method: 'GET',
        signal: controller.signal,
        cache: 'no-store',
      });

      clearTimeout(timeoutId);

      this._lastResult = response.ok;
      this._lastCheckTime = Date.now();

      if (response.ok) {
        console.log('[ServerHealthCheck] Server is healthy');
      } else {
        console.warn('[ServerHealthCheck] Server returned non-OK status:', response.status);
      }

      return this._lastResult;
    } catch (err) {
      console.warn('[ServerHealthCheck] Server check failed:', err.message);
      this._lastResult = false;
      this._lastCheckTime = Date.now();
      return false;
    }
  }

  /**
   * Show offline overlay - blocks all features.
   */
  static showOfflineOverlay() {
    const overlay = document.getElementById('tobyflow-offline-overlay');
    if (overlay) {
      overlay.classList.remove('hidden');
      console.log('[ServerHealthCheck] Offline overlay shown');
    }
  }

  /**
   * Hide offline overlay.
   */
  static hideOfflineOverlay() {
    const overlay = document.getElementById('tobyflow-offline-overlay');
    if (overlay) {
      overlay.classList.add('hidden');
      console.log('[ServerHealthCheck] Offline overlay hidden');
    }
  }

  /**
   * Check and show overlay if server is down.
   * @returns {Promise<boolean>} true if server is healthy (can continue)
   */
  static async checkAndBlock() {
    const isHealthy = await this.check();
    if (!isHealthy) {
      this.showOfflineOverlay();
      return false;
    }
    this.hideOfflineOverlay();
    return true;
  }

  /**
   * Reset cached state (for retry).
   */
  static reset() {
    this._lastResult = null;
    this._lastCheckTime = 0;
  }
}

// Export
window.ServerHealthCheck = ServerHealthCheck;
