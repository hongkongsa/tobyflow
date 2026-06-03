/**
 * ApiBaseConfig — single source of truth for API base URL.
 *
 * Phase 6 Bug N.3 (2026-06-03): Centralize localhost:3000 fallback từ 12+ files
 * vào 1 const default. Đối thủ clone .crx → chỉ thấy domain ở 1 nơi (đã public anyway).
 *
 * Priority chain:
 *   1. window.authManager?.apiBaseUrl  (runtime — set sau khi AuthManager init)
 *   2. ApiBaseConfig.DEFAULT            (bootstrap default — cần để fetch /health, /entitlements
 *                                        trước khi AuthManager load)
 *
 * Usage:
 *   const url = window.ApiBaseConfig.get();
 *   fetch(`${url}/health`);
 */
class ApiBaseConfig {
  /**
   * Default API base URL.
   * Đây là bootstrap config — extension cần biết server URL để fetch initial data.
   * Tương đương Plan section 1.4 "4 base URLs public knowledge anyway".
   */
  static DEFAULT = 'http://localhost:3000/api/v1';

  /**
   * Get current API base URL.
   * @returns {string}
   */
  static get() {
    return window.authManager?.apiBaseUrl || this.DEFAULT;
  }

  /**
   * Get web base URL (strip /api/vX suffix).
   * Dùng cho links sang website (vd: /guide, /tip).
   * @returns {string}
   */
  static getWebBase() {
    return this.get().replace(/\/api\/v\d+\/?$/, '');
  }
}

window.ApiBaseConfig = ApiBaseConfig;
