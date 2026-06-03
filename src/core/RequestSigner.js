/**
 * RequestSigner — HMAC signature helper cho sidebar/content script contexts
 * (Sprint 3 follow-up, EXTENSION_ENROLLMENT_HMAC_PLAN.md Section 7.3).
 *
 * Sidebar không thể gọi trực tiếp `_buildSignatureHeaders` trong background.js
 * (different execution context). Nó đọc enrollment từ chrome.storage.local
 * trực tiếp + compute HMAC qua Web Crypto API — cùng contract với
 * background.js + backend VerifySignature middleware.
 *
 * Contract khớp 100%:
 *   message = `${ts}:${METHOD}:${path}:${body_sha256_hex}`
 *   signature = HMAC-SHA256(secret, message) → hex lowercase
 *   Headers: X-Client-Id, X-Timestamp, X-Signature
 *
 * Sử dụng:
 *   const headers = await RequestSigner.headers('GET', '/api/v1/providers/api-configs');
 *   const resp = await fetch(url, { headers: { ...baseHeaders, ...headers } });
 */
class RequestSigner {
  static ENROLLMENT_KEY = 'toby_client_enrollment';

  static _cache = null; // {client_id, secret, expires_at, device_fingerprint}

  /**
   * Read enrollment từ chrome.storage.local (cached trong memory).
   * Background.js là source of truth — sidebar chỉ đọc, không write.
   */
  static async _getEnrollment() {
    if (this._cache) return this._cache;
    try {
      const stored = await new Promise(r =>
        chrome.storage.local.get([this.ENROLLMENT_KEY], r));
      this._cache = stored[this.ENROLLMENT_KEY] || null;
      return this._cache;
    } catch (_) {
      return null;
    }
  }

  /**
   * Build signature headers cho 1 request.
   * Return {} nếu chưa enroll (background.js sẽ enroll on extension load).
   *
   * @param {string} method - 'GET' / 'POST' / ...
   * @param {string} path - URL pathname (vd '/api/v1/providers/api-configs')
   * @param {string} body - JSON string hoặc empty
   */
  static async headers(method, path, body = '') {
    const enrollment = await this._getEnrollment();
    if (!enrollment || !enrollment.secret || !enrollment.client_id) return {};

    const timestamp = Math.floor(Date.now() / 1000);
    const normalizedPath = '/' + String(path || '').replace(/^\/+/, '');
    const bodyHash = await this._sha256Hex(body || '');
    const message = `${timestamp}:${String(method || 'GET').toUpperCase()}:${normalizedPath}:${bodyHash}`;

    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(enrollment.secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const sigBytes = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
    const sig = Array.from(new Uint8Array(sigBytes))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');

    return {
      'X-Client-Id': enrollment.client_id,
      'X-Timestamp': String(timestamp),
      'X-Signature': sig,
    };
  }

  static async _sha256Hex(text) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text || ''));
    return Array.from(new Uint8Array(buf))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }
}

// Invalidate memory cache khi background.js write enrollment mới
try {
  chrome.storage?.onChanged?.addListener?.((changes, area) => {
    if (area === 'local' && changes[RequestSigner.ENROLLMENT_KEY]) {
      RequestSigner._cache = changes[RequestSigner.ENROLLMENT_KEY].newValue || null;
    }
  });
} catch (_) { /* chrome.storage không có trong test env */ }

// Expose globally cho non-module contexts (vd content scripts dùng classic loading)
if (typeof window !== 'undefined') {
  window.RequestSigner = RequestSigner;
}
