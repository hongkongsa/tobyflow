/**
 * I18n - Internationalization System
 * Supports: vi (Vietnamese - default), en (English), th (Thai), ja (Japanese)
 */
class I18n {
  static _translations = {};
  static _currentLocale = 'vi';
  static _fallbackLocale = 'vi';
  static _initialized = false;

  static SUPPORTED_LOCALES = [
    { code: 'vi', name: 'Tiếng Việt', flag: 'VI' },
    { code: 'en', name: 'English', flag: 'EN' },
    { code: 'th', name: 'ไทย', flag: 'TH' },
    { code: 'ja', name: '日本語', flag: 'JA' }
  ];

  /**
   * Initialize i18n system
   */
  static async init(defaultLocale = null) {
    if (this._initialized) return;

    // Priority: param → storage (af_locale / af_settings.language) → server default → 'vi'
    const savedLocale = await this._getSavedLocale();

    let serverDefaultLocale = null;
    if (!defaultLocale && !savedLocale) {
      serverDefaultLocale = await this._fetchServerDefaultLocale();
    }

    this._currentLocale = defaultLocale || savedLocale || serverDefaultLocale || 'vi';

    if (!savedLocale) {
      this._persistLocale(this._currentLocale);
    }

    await this._loadTranslations();
    this._initialized = true;

    const source = defaultLocale ? 'param' : savedLocale ? 'storage' : serverDefaultLocale ? 'server' : 'fallback';
    console.log('[I18n] Initialized:', this._currentLocale, `(${source})`);
  }

  /**
   * Post-audit fix: fetch admin default locale từ /api/v1/default-settings.
   * Timeout 2s để không block UI nếu backend slow.
   */
  static async _fetchServerDefaultLocale() {
    try {
      const baseUrl = window.ApiBaseConfig.get();
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2000);
      // Anti-clone: X-Extension-Id để pass VerifyExtensionId middleware khi toggle ON
      const headers = {};
      try { if (chrome?.runtime?.id) headers['X-Extension-Id'] = chrome.runtime.id; } catch (_) {}
      // Sprint 3 HMAC: ký để pass VerifySignature enforce mode (đồng bộ background.js)
      try { Object.assign(headers, await (window.RequestSigner?.headers?.('GET', new URL(`${baseUrl}/default-settings`).pathname, '') || {})); } catch (_) {}
      const resp = await fetch(`${baseUrl}/default-settings`, {
        cache: 'no-store',
        signal: controller.signal,
        headers,
      });
      clearTimeout(timeoutId);
      if (!resp.ok) return null;
      const json = await resp.json();
      const lang = json?.data?.language;
      if (lang && this.SUPPORTED_LOCALES.some(l => l.code === lang)) {
        return lang;
      }
      return null;
    } catch (e) {
      console.warn('[I18n] Server default locale fetch failed:', e.message);
      return null;
    }
  }

  static _persistLocale(locale) {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage?.local) {
        chrome.storage.local.set({ af_locale: locale });
      } else {
        localStorage.setItem('af_locale', locale);
      }
    } catch (e) { /* ignore */ }
  }

  static async _getSavedLocale() {
    return new Promise(resolve => {
      if (typeof chrome !== 'undefined' && chrome.storage?.local) {
        // Post-audit fix: đọc cả 2 keys với priority:
        //   1. af_locale  — explicit user choice (modal language picker)
        //   2. af_settings.language — admin default (synced từ /api/v1/default-settings)
        //   3. null → caller fallback hardcoded 'vi'
        // Trước fix: chỉ đọc af_locale → anonymous user thấy 'vi' dù admin set default_language='en'.
        chrome.storage.local.get(['af_locale', 'af_settings'], result => {
          const explicit = result.af_locale;
          const fromSettings = result.af_settings?.language;
          resolve(explicit || fromSettings || null);
        });
      } else {
        const explicit = localStorage.getItem('af_locale');
        let fromSettings = null;
        try {
          const raw = localStorage.getItem('af_settings');
          if (raw) fromSettings = JSON.parse(raw).language;
        } catch (_) { /* ignore */ }
        resolve(explicit || fromSettings || null);
      }
    });
  }

  static _detectBrowserLocale() {
    const browserLang = navigator.language?.split('-')[0] || 'vi';
    const supported = this.SUPPORTED_LOCALES.map(l => l.code);
    return supported.includes(browserLang) ? browserLang : 'vi';
  }

  static async _loadTranslations() {
    // Server-only: No local i18n files (src/i18n/*.js kept for authoring only)

    // Step 1: Apply cached translations from chrome.storage (instant if available)
    try {
      const cached = await this._readStorageCache(this._currentLocale);
      if (cached?.data) {
        this._mergeTranslations(this._currentLocale, cached.data);
      }
    } catch (_) { /* ignore */ }

    // Step 2: Fetch from server — BLOCKING if cache empty, background refresh otherwise
    const hasCache = Object.keys(this._translations[this._currentLocale] || {}).length > 0;
    if (!hasCache) {
      await this._fetchServerTranslations(this._currentLocale);
    } else {
      this._fetchServerTranslations(this._currentLocale).catch(() => {});
    }
  }

  /**
   * (Group E) Fetch translations từ server cho 1 locale.
   * Merge vào in-memory `_translations` + cache vào chrome.storage.
   */
  static async _fetchServerTranslations(locale) {
    try {
      const baseUrl = window.ApiBaseConfig.get();
      // Anti-clone: X-Extension-Id để pass VerifyExtensionId middleware khi toggle ON
      const headers = {};
      try { if (chrome?.runtime?.id) headers['X-Extension-Id'] = chrome.runtime.id; } catch (_) {}
      // Sprint 3 HMAC: ký để pass VerifySignature enforce mode (đồng bộ background.js)
      try { Object.assign(headers, await (window.RequestSigner?.headers?.('GET', new URL(`${baseUrl}/i18n/${locale}`).pathname, '') || {})); } catch (_) {}
      const resp = await fetch(`${baseUrl}/i18n/${locale}`, { cache: 'no-store', headers });
      if (!resp.ok) return;

      const json = await resp.json();
      if (!json.success || !json.data) return;

      this._mergeTranslations(locale, json.data);
      await this._writeStorageCache(locale, {
        version: json.version,
        data: json.data,
        fetchedAt: Date.now(),
      });

      if (window.eventBus) {
        window.eventBus.emit('i18n:reloaded', { locale });
      }
    } catch (e) {
      console.warn(`[I18n] Fetch ${locale} failed:`, e.message);
    }
  }

  /**
   * (Group E) Merge flat key→value map vào nested _translations[locale].
   * VD: { "workflow.title": "Workflow" } → this._translations[locale].workflow.title = "Workflow"
   */
  static _mergeTranslations(locale, flatKeyValueMap) {
    if (!this._translations[locale]) this._translations[locale] = {};
    for (const [key, value] of Object.entries(flatKeyValueMap)) {
      this._setNestedValue(this._translations[locale], key, value);
    }
  }

  /** Set nested object value bằng dot-notation key */
  static _setNestedValue(obj, key, value) {
    const parts = key.split('.');
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = value;
  }

  // (Group E) chrome.storage cache helpers
  static async _readStorageCache(locale) {
    return new Promise(resolve => {
      if (typeof chrome === 'undefined' || !chrome.storage?.local) {
        resolve(null);
        return;
      }
      chrome.storage.local.get([`toby_i18n_${locale}`], res => {
        resolve(res[`toby_i18n_${locale}`] || null);
      });
    });
  }

  static async _writeStorageCache(locale, payload) {
    return new Promise(resolve => {
      if (typeof chrome === 'undefined' || !chrome.storage?.local) {
        resolve();
        return;
      }
      chrome.storage.local.set({ [`toby_i18n_${locale}`]: payload }, resolve);
    });
  }

  static getLocale() {
    return this._currentLocale;
  }

  static getSupportedLocales() {
    return this.SUPPORTED_LOCALES;
  }

  static async setLocale(locale, emitEvent = true) {
    if (!this.SUPPORTED_LOCALES.some(l => l.code === locale)) {
      console.warn('[I18n] Unsupported locale:', locale);
      return;
    }

    const previousLocale = this._currentLocale;
    this._currentLocale = locale;

    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      chrome.storage.local.set({ af_locale: locale });
    } else {
      localStorage.setItem('af_locale', locale);
    }

    console.log('[I18n] Locale changed to:', locale);

    // 2026-05-25 BUG FIX: server-only i18n — locale mới chưa có translations trong memory.
    // Trước fix: chỉ flip _currentLocale flag + emit event → UI re-render với
    // `_translations[newLocale]=undefined` → t() return undefined → user thấy fallback strings
    // (English hardcoded) → user phải đóng extension reload để init() fetch translations.
    // Sau fix: load translations cho locale mới (cache hit instant, else fetch ~500ms blocking)
    // → emit i18n:changed SAU khi data ready → UI re-render thấy đúng strings.
    if (previousLocale !== locale) {
      try {
        await this._loadTranslations();
      } catch (e) {
        console.warn('[I18n] Failed to load translations for', locale, ':', e?.message);
      }
    }

    if (emitEvent && window.eventBus) {
      window.eventBus.emit('i18n:changed', { locale });
    }
  }

  static t(key, params = {}) {
    // Guard: nếu translations chưa load, return undefined để fallback hoạt động
    if (!this._translations || Object.keys(this._translations).length === 0) {
      return undefined;
    }

    let translation = this._getNestedValue(this._translations[this._currentLocale], key);

    if (translation === undefined && this._currentLocale !== this._fallbackLocale) {
      translation = this._getNestedValue(this._translations[this._fallbackLocale], key);
    }

    if (translation === undefined) {
      // Bug fix 2026-05-25: trước fix return `key` literal (truthy) → callers dùng
      // pattern `t(key) || fallback` không bao giờ fallback vì `"common.saved"` truthy →
      // user thấy raw key trong UI khi backend chưa seed key mới.
      // Now return undefined → `|| fallback` works. Dev miss-key vẫn track qua console.warn.
      if (!this._missingKeyWarned) this._missingKeyWarned = new Set();
      if (!this._missingKeyWarned.has(key)) {
        this._missingKeyWarned.add(key);
        console.debug(`[I18n] Missing key: "${key}" (locale=${this._currentLocale}, fallback=${this._fallbackLocale}) — using caller fallback`);
      }
      return undefined;
    }

    if (params && typeof translation === 'string') {
      Object.keys(params).forEach(param => {
        translation = translation.replace(new RegExp(`\\{${param}\\}`, 'g'), params[param]);
      });
    }

    return translation;
  }

  static _getNestedValue(obj, key) {
    if (!obj || !key) return undefined;
    return key.split('.').reduce((o, k) => (o || {})[k], obj);
  }

  static scopedT(scope) {
    return (key, params) => this.t(`${scope}.${key}`, params);
  }

  static applyTranslations(container = document) {
    container.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.getAttribute('data-i18n');
      const paramsStr = el.getAttribute('data-i18n-params');
      let params = {};
      if (paramsStr) { try { params = JSON.parse(paramsStr); } catch(e) { params = {}; } }
      el.textContent = this.t(key, params);
    });

    container.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
      el.placeholder = this.t(el.getAttribute('data-i18n-placeholder'));
    });

    container.querySelectorAll('[data-i18n-title]').forEach(el => {
      const key = el.getAttribute('data-i18n-title');
      const text = this.t(key) || key;
      // Tab menu: skip tooltip — text label đã hiển thị inline, KHÔNG cần tooltip thêm
      const isTabButton = el.hasAttribute('data-tab') || el.classList.contains('tobyflow-tab');
      if (!isTabButton) {
        el.setAttribute('data-tooltip', text);
      } else {
        // Vẫn xóa data-tooltip nếu set trước đó (idempotent khi i18n re-apply)
        if (el.hasAttribute('data-tooltip')) el.removeAttribute('data-tooltip');
      }
      if (!el.hasAttribute('aria-label')) {
        el.setAttribute('aria-label', text);
      }
      // Xóa native title (đã set bởi static HTML) để tránh duplicate tooltip
      if (el.hasAttribute('title')) el.removeAttribute('title');
    });

    container.querySelectorAll('[data-i18n-value]').forEach(el => {
      const key = el.getAttribute('data-i18n-value');
      el.value = this.t(key) || key;
    });

    container.querySelectorAll('[data-i18n-aria]').forEach(el => {
      const key = el.getAttribute('data-i18n-aria');
      el.setAttribute('aria-label', this.t(key) || key);
    });

    container.querySelectorAll('[data-i18n-html]').forEach(el => {
      const key = el.getAttribute('data-i18n-html');
      const paramsStr = el.getAttribute('data-i18n-params');
      let params2 = {};
      if (paramsStr) { try { params2 = JSON.parse(paramsStr); } catch(e) { params2 = {}; } }
      el.innerHTML = this.t(key, params2) || key;
    });

    container.querySelectorAll('[data-i18n-tooltip]').forEach(el => {
      const key = el.getAttribute('data-i18n-tooltip');
      el.setAttribute('data-tooltip', this.t(key) || key);
    });
  }

  static formatDate(date, options = {}) {
    const d = date instanceof Date ? date : new Date(date);
    const locale = this.getLocaleCode();
    return new Intl.DateTimeFormat(locale, { day: '2-digit', month: '2-digit', year: 'numeric', ...options }).format(d);
  }

  static formatTime(date, options = {}) {
    const d = date instanceof Date ? date : new Date(date);
    const locale = this.getLocaleCode();
    return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit', ...options }).format(d);
  }

  static formatDateTime(date, options = {}) {
    const d = date instanceof Date ? date : new Date(date);
    const locale = this.getLocaleCode();
    return new Intl.DateTimeFormat(locale, {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', ...options
    }).format(d);
  }

  static getLocaleCode() {
    const localeMap = { vi: 'vi-VN', en: 'en-US', th: 'th-TH', ja: 'ja-JP' };
    return localeMap[this._currentLocale] || 'en-US';
  }

  static formatNumber(number, options = {}) {
    return new Intl.NumberFormat(this.getLocaleCode(), options).format(number);
  }

  static formatCurrency(amount, currency = null) {
    const currencyMap = { vi: 'VND', en: 'USD', th: 'THB', ja: 'JPY' };
    const curr = currency || currencyMap[this._currentLocale] || 'VND';
    return new Intl.NumberFormat(this.getLocaleCode(), {
      style: 'currency', currency: curr,
      minimumFractionDigits: curr === 'VND' || curr === 'JPY' ? 0 : 2
    }).format(amount);
  }

  static getCurrentLocaleInfo() {
    return this.SUPPORTED_LOCALES.find(l => l.code === this._currentLocale) || this.SUPPORTED_LOCALES[0];
  }

  /**
   * Initiative 3 (Group B prep): Invalidate cached translations cho 1 locale.
   * Clear in-memory + storage cache → next loadTranslations() sẽ re-fetch từ server.
   *
   * Group E (i18n dynamic loading) sẽ implement server fetch trong _loadTranslations.
   * Tạm thời (Group B): method này chỉ clear cache; behavior thực tế phụ thuộc loader version.
   *
   * @param {string} locale — 'vi' | 'en' | 'th' | 'ja' (hoặc null để clear all)
   */
  static invalidate(locale = null) {
    if (locale) {
      delete this._translations[locale];
      // Clear storage cache key (sẽ dùng khi Group E implement dynamic load)
      try {
        chrome.storage?.local?.remove([`toby_i18n_${locale}`]);
      } catch (_) { /* ignore */ }
      console.log(`[I18n] Invalidated locale: ${locale}`);
    } else {
      this._translations = {};
      try {
        chrome.storage?.local?.get(null, items => {
          const keysToRemove = Object.keys(items || {}).filter(k => k.startsWith('toby_i18n_'));
          if (keysToRemove.length > 0) chrome.storage.local.remove(keysToRemove);
        });
      } catch (_) { /* ignore */ }
      console.log('[I18n] Invalidated all locales');
    }
  }

  /**
   * Initiative 3 (Group B prep): Force reload translations.
   * Re-run _loadTranslations() + emit 'i18n:reloaded' để UI re-render.
   *
   * Group E sẽ extend _loadTranslations để fetch từ /api/v1/i18n/{locale}.
   * Tạm thời (Group B): chỉ re-assign từ window.I18N_VI/EN/... inline data.
   */
  static async reload() {
    await this._loadTranslations();
    if (window.eventBus) {
      window.eventBus.emit('i18n:reloaded', { locale: this._currentLocale });
    }
    console.log('[I18n] Reloaded translations for locale:', this._currentLocale);
  }

  /**
   * [Phase 5 Polish 5 2026-05-24] Getter — return cached version từ storage cache.
   */
  static async getLocaleVersion(locale) {
    const cached = await this._readStorageCache(locale);
    return cached?.version ?? null;
  }

  /**
   * [Phase 5 2026-05-24] Called by ConfigVersionPoller khi locale version mismatch.
   * Input: localeVersionMap {vi: 567, en: 543, th: 234, ja: 198}
   * Mismatch CURRENT locale → re-fetch + invalidate + emit reloaded.
   * Other locales: skip (lazy update khi user switch locale).
   */
  static async _updateFromVersion(localeVersionMap) {
    if (!localeVersionMap || typeof localeVersionMap !== 'object') return;

    const currentLocale = this._currentLocale;
    const remoteVersion = localeVersionMap[currentLocale];
    if (remoteVersion === undefined || remoteVersion === null) return;

    const cachedVersion = await this.getLocaleVersion(currentLocale);
    if (cachedVersion === remoteVersion) return; // No-op (Polish 3 defensive)

    console.log(`[I18n] Version mismatch ${currentLocale}: ${cachedVersion} → ${remoteVersion}`);
    // Re-fetch current locale (server response.version sẽ persist via _fetchServerTranslations)
    await this._fetchServerTranslations(currentLocale);
    // _fetchServerTranslations đã emit i18n:reloaded — không cần emit lại
  }
}

window.I18n = I18n;
