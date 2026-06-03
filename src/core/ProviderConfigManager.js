/**
 * ProviderConfigManager — Fetch + cache provider configs (DOM selectors) từ backend.
 *
 * Features:
 * - Fetch selectors từ API (cache 1h)
 * - Listen SSE push để update ngay lập tức
 * - Fallback chain support
 * - Hard-coded defaults khi offline
 */
class ProviderConfigManager {
  static _CACHE_KEY = 'toby_provider_configs';
  static _API_CONFIGS_CACHE_KEY = 'toby_provider_api_configs';
  static _CACHE_TTL_MS = 4 * 60 * 60 * 1000; // [Phase 5 2026-05-24] 4h — ConfigVersionPoller detect per-provider config_version mismatch
  static _GRACE_PERIOD_MS = 24 * 60 * 60 * 1000; // 24h - Phase 3: offline grace period
  static _cache = null;
  static _fetchPromise = null;

  // Phase 3 Test: Enable verbose logging
  static _DEBUG = true;

  // Initiative 4 (rev6): API configs cache riêng (ratios per mode, download_resolutions, error_patterns, ...)
  // Persist vào chrome.storage._API_CONFIGS_CACHE_KEY để content.js đọc được.
  static _apiConfigsCache = null;
  static _apiConfigsFetchPromise = null;

  // Phase 3: Server-Only — _DEFAULT_BASE_URLS and _DEFAULT_URLS REMOVED
  // URL data comes from server via /api/v1/providers/api-configs

  // Phase 3: Minimal bootstrap URLs - chỉ giữ base + tabQuery để extension có thể:
  // 1. Connect tới server (base URL)
  // 2. Detect provider tabs (tabQuery pattern)
  // Các URLs chi tiết (createUrl, localeBase, cdnPatterns) lấy từ server.
  static _BOOTSTRAP_URLS = {
    flow: { base: 'https://labs.google/fx/tools/flow', tabQuery: 'https://labs.google/fx/*' },
    chatgpt: { base: 'https://chatgpt.com', tabQuery: '*://chatgpt.com/*' },
    grok: { base: 'https://grok.com', tabQuery: '*://grok.com/*' },
    gemini: { base: 'https://gemini.google.com', tabQuery: '*://gemini.google.com/*' },
  };

  // Phase 3: Server-Only — all _DEFAULT_* REMOVED (ratios, download_resolutions, max_ref_images, etc.)
  // Data comes from server via /api/v1/providers/api-configs

  // Phase 3: Server-Only — _DEFAULT_RATIO_ARIA_LABELS and _DEFAULTS (DOM selectors) REMOVED
  // DOM selector data comes from server via /api/v1/providers/dom-selectors

  /**
   * Phase 3: Server-Only — lấy selector config cho 1 key.
   * @returns {Object} { selectors: [], text_match?, attribute?, icon_text?, button_text? }
   * @throws {ConfigRequiredError} nếu không có data
   */
  static async get(provider, key) {
    const data = await this.fetch();
    const providerData = data?.[provider];

    if (!providerData) {
      if (window.ConfigRequiredError) {
        throw new window.ConfigRequiredError(`selector_${provider}`, 'provider_not_found');
      }
      return null;
    }

    const selectors = providerData.selectors || {};
    const config = selectors[key];

    if (!config) {
      // Selector không tồn tại - có thể là optional key
      return null;
    }

    return {
      selectors: config.selectors || [],
      text_match: config.text_match || null,
      attribute: config.attribute || null,
      icon_text: config.icon_text || null,
      button_text: config.button_text || null,
    };
  }

  /**
   * Phase 3: Server-Only — lấy array selectors cho 1 key.
   */
  static async getSelectors(provider, key) {
    const config = await this.get(provider, key);
    return config?.selectors || [];
  }

  /**
   * Phase 3: Server-Only — lấy tất cả selectors của 1 provider.
   * @throws {ConfigRequiredError} nếu không có data
   */
  static async getProvider(provider) {
    const data = await this.fetch();
    const remote = data?.[provider];

    if (!remote) {
      if (window.ConfigRequiredError) {
        throw new window.ConfigRequiredError(`provider_${provider}`, 'provider_not_found');
      }
      return {
        name: provider,
        status: 'unknown',
        base_url: null,
        config_version: 0,
        selectors: {},
      };
    }

    return {
      name: remote.name || provider,
      status: remote.status || 'active',
      base_url: remote.base_url || null,
      config_version: remote.config_version || 1,
      selectors: remote.selectors || {},
    };
  }

  /**
   * Initiative 7: Get base URL của 1 provider.
   * Replace 10+ vị trí hardcode 'https://labs.google/fx/*' trong app.js.
   * @returns {Promise<string>}
   */
  static async getBaseUrl(providerSlug) {
    const data = await this.fetch();
    const remote = data?.[providerSlug];
    // Phase 3: Server-Only — fallback to _BOOTSTRAP_URLS minimal
    return remote?.base_url || this._BOOTSTRAP_URLS[providerSlug]?.base || '';
  }

  /**
   * SYNC version — return từ cache nếu có, fallback _BOOTSTRAP_URLS.
   * Dùng cho hot path không thể await.
   */
  static getBaseUrlSync(providerSlug) {
    if (this._cache?.data?.[providerSlug]?.base_url) {
      return this._cache.data[providerSlug].base_url;
    }
    // Phase 3: Server-Only — minimal bootstrap only
    return this._BOOTSTRAP_URLS[providerSlug]?.base || '';
  }

  // ============ Rev10: Centralized URL helpers ============

  /**
   * Get tab query pattern để tìm tabs đã mở.
   * Phase 3: Server first → _BOOTSTRAP_URLS (minimal)
   * @param {string} slug — 'flow' | 'chatgpt' | 'grok' | 'gemini'
   * @returns {string} Pattern cho chrome.tabs.query (vd: '*://chatgpt.com/*')
   */
  static getTabQuery(slug) {
    // 1. Server cache (api_configs.urls.tab_query)
    const serverUrl = this._apiConfigsCache?.data?.[slug]?.configs?.urls?.tab_query;
    if (serverUrl) return serverUrl;
    // 2. _BOOTSTRAP_URLS (minimal bootstrap for offline check)
    return this._BOOTSTRAP_URLS[slug]?.tabQuery || '';
  }

  /**
   * Get all tab query patterns (array) — dùng khi provider có nhiều domain.
   * Phase 3: Server first → derive từ getTabQuery
   * @param {string} slug
   * @returns {string[]} Array patterns
   */
  static getTabQueryPatterns(slug) {
    // 1. Server cache
    const serverPatterns = this._apiConfigsCache?.data?.[slug]?.configs?.urls?.tab_query_patterns;
    if (Array.isArray(serverPatterns) && serverPatterns.length > 0) return serverPatterns;
    // 2. Derive từ getTabQuery (which falls back to _BOOTSTRAP_URLS)
    return [this.getTabQuery(slug)].filter(Boolean);
  }

  /**
   * Get URL để tạo tab mới.
   * Phase 3: Server first → _BOOTSTRAP_URLS (minimal)
   * @param {string} slug
   * @returns {string}
   */
  static getCreateUrl(slug) {
    // 1. Server cache
    const serverUrl = this._apiConfigsCache?.data?.[slug]?.configs?.urls?.create_url;
    if (serverUrl) return serverUrl;
    // 2. _BOOTSTRAP_URLS base (minimal)
    return this._BOOTSTRAP_URLS[slug]?.base || this.getBaseUrlSync(slug);
  }

  /**
   * Get specific URL của provider.
   * Phase 3: Server-Only — only server data, no fallback for non-bootstrap keys
   * @param {string} slug
   * @param {string} key — 'imagine', 'saved', 'app', 'localeBase', etc.
   * @returns {string|null}
   */
  static getProviderUrl(slug, key) {
    // Server cache (snake_case key: locale_base, cdn_patterns)
    const snakeKey = key.replace(/([A-Z])/g, '_$1').toLowerCase();
    const serverUrl = this._apiConfigsCache?.data?.[slug]?.configs?.urls?.[snakeKey];
    if (serverUrl) return serverUrl;
    // Phase 3: Server-Only — no fallback for specific URLs
    return null;
  }

  /**
   * Check URL có thuộc provider không (match any tabQueryPatterns).
   * @param {string} url
   * @param {string} slug
   * @returns {boolean}
   */
  static isProviderUrl(url, slug) {
    if (!url || !slug) return false;
    const patterns = this.getTabQueryPatterns(slug);
    return patterns.some(pattern => {
      // Convert chrome pattern to regex
      const regex = new RegExp('^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
      return regex.test(url);
    });
  }

  /**
   * Check URL có chứa CDN pattern của provider không (Grok CDN check).
   * Phase 3: Server-Only — only server data
   * @param {string} url
   * @param {string} slug
   * @returns {boolean}
   */
  static isCdnUrl(url, slug) {
    if (!url || !slug) return false;
    // Server cache only
    const serverPatterns = this._apiConfigsCache?.data?.[slug]?.configs?.urls?.cdn_patterns;
    if (Array.isArray(serverPatterns) && serverPatterns.length > 0) {
      return serverPatterns.some(pattern => url.includes(pattern));
    }
    // Phase 3: No fallback — return false if no server data
    return false;
  }

  /**
   * Get all provider slugs.
   * @returns {string[]}
   */
  static getProviderSlugs() {
    // Merge server + bootstrap slugs
    const serverSlugs = Object.keys(this._apiConfigsCache?.data || {});
    const bootstrapSlugs = Object.keys(this._BOOTSTRAP_URLS);
    return [...new Set([...serverSlugs, ...bootstrapSlugs])];
  }

  // ============ End Rev10 URL helpers ============

  /**
   * Initiative 4 (rev6 fix): Get ratios của 1 provider per mode.
   * Fetch từ /api/v1/providers/api-configs (KHÔNG dùng cache của /dom-selectors).
   *
   * @param {string} providerSlug — 'flow' | 'chatgpt' | 'grok' | 'gemini'
   * @param {string} mode — 'image' | 'video'
   * @returns {Promise<Array>} List ratios:
   *   - Flow: ["1:1", "9:16", "16:9", ...] (string only)
   *   - ChatGPT/Grok: [{ ui_name: "story", value: "9:16" }, ...] (object với UI mapping)
   */
  /**
   * Phase 3: Server-Only — async version, throws if no data.
   */
  static async getRatios(providerSlug, mode) {
    const apiConfigs = await this._fetchApiConfigs();
    const ratios = apiConfigs?.[providerSlug]?.configs?.ratios?.[mode];
    if (ratios && ratios.length > 0) return ratios;
    // Server-Only: throw instead of fallback
    if (window.ConfigRequiredError) {
      throw new window.ConfigRequiredError(`ratios_${providerSlug}_${mode}`, 'data_missing');
    }
    return []; // Fallback if ConfigRequiredError not loaded
  }

  /**
   * Phase 3: Server-Only — sync version, throws if cache empty.
   */
  static getRatiosSync(providerSlug, mode) {
    // Check cache exists
    if (!this._apiConfigsCache?.data) {
      // Trigger background fetch
      this._fetchApiConfigs().catch(() => {});
      if (window.ConfigRequiredError) {
        throw new window.ConfigRequiredError(`ratios_${providerSlug}_${mode}`, 'cache_empty');
      }
      return []; // Fallback if ConfigRequiredError not loaded
    }
    const ratios = this._apiConfigsCache.data[providerSlug]?.configs?.ratios?.[mode];
    if (ratios && ratios.length > 0) return ratios;
    // Server-Only: throw instead of fallback
    if (window.ConfigRequiredError) {
      throw new window.ConfigRequiredError(`ratios_${providerSlug}_${mode}`, 'data_missing');
    }
    return []; // Fallback if ConfigRequiredError not loaded
  }

  /**
   * Get download resolutions config (Flow only — ChatGPT/Grok không có menu resolution).
   *
   * @param {string} providerSlug — 'flow'
   * @param {string|null} mode — 'image' | 'video' | null (trả full config)
   * @returns {Array|Object|null}
   *   - mode='image': [{value, label, menu_label, pixel_width}, ...]
   *   - mode='video': [{value, label, menu_label}, ...]
   *   - mode=null: { image, video, image_fallback_chain, video_fallback_chain }
   */
  /**
   * Phase 3: Server-Only — throws if cache empty.
   */
  static getDownloadResolutionsSync(providerSlug, mode = null) {
    // Check cache exists
    if (!this._apiConfigsCache?.data) {
      this._fetchApiConfigs().catch(() => {});
      if (window.ConfigRequiredError) {
        throw new window.ConfigRequiredError(`download_resolutions_${providerSlug}`, 'cache_empty');
      }
      return mode === null ? null : [];
    }
    const cfg = this._apiConfigsCache.data[providerSlug]?.configs?.download_resolutions;
    if (!cfg) {
      // Flow-only feature, other providers may not have it - return empty instead of throw
      return mode === null ? null : [];
    }
    if (mode === null) return cfg;
    return Array.isArray(cfg[mode]) ? cfg[mode] : [];
  }

  /**
   * Get fallback chain (theo thứ tự ưu tiên khi menu item aria-disabled).
   * @param {string} providerSlug — 'flow'
   * @param {string} mode — 'image' | 'video'
   * @returns {string[]} — vd ['4K', '2K', '1K']
   */
  static getDownloadFallbackChainSync(providerSlug, mode) {
    const cfg = this.getDownloadResolutionsSync(providerSlug, null);
    if (!cfg) return [];
    const key = `${mode}_fallback_chain`;
    return Array.isArray(cfg[key]) ? cfg[key] : [];
  }

  /**
   * Get pixel_width cho resolution (image only — dùng cho applyResolutionToUrl).
   * @returns {number|null}
   */
  static getDownloadPixelWidthSync(providerSlug, resolution) {
    const list = this.getDownloadResolutionsSync(providerSlug, 'image');
    const found = list.find(r => r.value === resolution);
    return found?.pixel_width || null;
  }

  /**
   * Get menu_label theo resolution + mode.
   * @returns {string|null} — vd '1K' / '720p' / '4K'
   */
  static getDownloadMenuLabelSync(providerSlug, mode, resolution) {
    const list = this.getDownloadResolutionsSync(providerSlug, mode);
    const found = list.find(r => r.value === resolution);
    return found?.menu_label || null;
  }

  // ============ Phase J: Provider Capabilities Methods ============

  /**
   * Phase 3: Server-Only — throws if cache empty.
   * @param {string} slug — 'flow' | 'chatgpt' | 'grok' | 'gemini'
   * @param {string} mode — 'image' | 'video' | 'video_ingredients'
   * @returns {number}
   */
  static getMaxRefImagesSync(slug, mode = 'image') {
    // Check cache exists
    if (!this._apiConfigsCache?.data) {
      this._fetchApiConfigs().catch(() => {});
      if (window.ConfigRequiredError) {
        throw new window.ConfigRequiredError(`max_ref_images_${slug}`, 'cache_empty');
      }
      return 0;
    }
    const cfg = this._apiConfigsCache.data[slug]?.configs?.max_ref_images;
    if (!cfg) {
      if (window.ConfigRequiredError) {
        throw new window.ConfigRequiredError(`max_ref_images_${slug}`, 'data_missing');
      }
      return 0;
    }
    // Flow special: video_ingredients mode
    if (slug === 'flow' && mode === 'video_ingredients') {
      return cfg.video_ingredients ?? cfg.image ?? 0;
    }
    // Grok: video mode
    if (slug === 'grok' && mode === 'video') {
      return cfg.video ?? cfg.image ?? 0;
    }
    return cfg.image ?? cfg[mode] ?? 0;
  }

  static async getMaxRefImages(slug, mode = 'image') {
    await this._fetchApiConfigs();
    return this.getMaxRefImagesSync(slug, mode);
  }

  /**
   * Phase 3: Server-Only — throws if cache empty.
   * @param {string} slug
   * @returns {object} { ratio, quantity, video, ref_image, auto_download, humanized, image_mode }
   */
  static getSupportsSync(slug) {
    // Check cache exists
    if (!this._apiConfigsCache?.data) {
      this._fetchApiConfigs().catch(() => {});
      if (window.ConfigRequiredError) {
        throw new window.ConfigRequiredError(`supports_${slug}`, 'cache_empty');
      }
      return {};
    }
    const cfg = this._apiConfigsCache.data[slug]?.configs?.supports;
    if (!cfg) {
      if (window.ConfigRequiredError) {
        throw new window.ConfigRequiredError(`supports_${slug}`, 'data_missing');
      }
      return {};
    }
    return cfg;
  }

  static async getSupports(slug) {
    await this._fetchApiConfigs();
    return this.getSupportsSync(slug);
  }

  /**
   * Phase 3: Server-Only — Grok only, throws if cache empty.
   * @param {string} slug
   * @returns {string[]} — ['6s', '10s']
   */
  static getSupportedDurationsSync(slug) {
    if (!this._apiConfigsCache?.data) {
      this._fetchApiConfigs().catch(() => {});
      if (window.ConfigRequiredError) {
        throw new window.ConfigRequiredError(`supported_durations_${slug}`, 'cache_empty');
      }
      return [];
    }
    const cfg = this._apiConfigsCache.data[slug]?.configs?.supported_durations;
    return Array.isArray(cfg) ? cfg : [];
  }

  /**
   * Phase 3: Server-Only — Grok only, throws if cache empty.
   * @param {string} slug
   * @returns {string[]} — ['480p', '720p']
   */
  static getSupportedResolutionsSync(slug) {
    if (!this._apiConfigsCache?.data) {
      this._fetchApiConfigs().catch(() => {});
      if (window.ConfigRequiredError) {
        throw new window.ConfigRequiredError(`supported_resolutions_${slug}`, 'cache_empty');
      }
      return [];
    }
    const cfg = this._apiConfigsCache.data[slug]?.configs?.supported_resolutions;
    return Array.isArray(cfg) ? cfg : [];
  }

  /**
   * Phase 3: Server-Only — Grok only, throws if cache empty.
   * @param {string} slug
   * @returns {string[]} — ['speed', 'quality']
   */
  static getSupportedImageQualitiesSync(slug) {
    if (!this._apiConfigsCache?.data) {
      this._fetchApiConfigs().catch(() => {});
      if (window.ConfigRequiredError) {
        throw new window.ConfigRequiredError(`supported_image_qualities_${slug}`, 'cache_empty');
      }
      return [];
    }
    const cfg = this._apiConfigsCache.data[slug]?.configs?.supported_image_qualities;
    return Array.isArray(cfg) ? cfg : [];
  }

  /**
   * Flow video durations by tier. Tier từ model.config.duration_tier.
   * @param {string} slug — provider slug ('flow')
   * @param {string} tier — 'default' | 'advanced' | 'fixed' (future use)
   * @returns {string[]} — default=['4s', '6s', '8s'], advanced=['4s', '6s', '8s', '10s'], fixed=['8s']
   */
  static getVideoDurationsSync(slug, tier = 'default') {
    if (!this._apiConfigsCache?.data) {
      this._fetchApiConfigs().catch(() => {});
      if (window.ConfigRequiredError) {
        throw new window.ConfigRequiredError(`video_durations_${slug}`, 'cache_empty');
      }
      return [];
    }
    const cfg = this._apiConfigsCache.data[slug]?.configs?.video_durations;
    if (!cfg || typeof cfg !== 'object') return [];
    return Array.isArray(cfg[tier]) ? cfg[tier] : (Array.isArray(cfg.default) ? cfg.default : []);
  }

  /**
   * Safe version of getVideoDurationsSync.
   */
  static safeGetVideoDurationsSync(slug, tier = 'default') {
    try {
      return this.getVideoDurationsSync(slug, tier);
    } catch (err) {
      if (window.ConfigRequiredError?.is?.(err)) {
        console.warn(`[PCM] safeGetVideoDurationsSync: ${err.message}`);
        return [];
      }
      throw err;
    }
  }

  /**
   * Phase 3: Server-Only — derive từ ratios, throws if cache empty.
   * @param {string} slug
   * @returns {object} { story: '9:16', portrait: '3:4', ... }
   */
  static getRatioUiMapSync(slug) {
    // 1. Check legacy key (backward compat)
    if (this._apiConfigsCache?.data?.[slug]?.configs?.ratio_ui_map) {
      const legacy = this._apiConfigsCache.data[slug].configs.ratio_ui_map;
      if (Object.keys(legacy).length > 0) return legacy;
    }

    // 2. Derive từ ratios (will throw if cache empty)
    const ratios = this.getRatiosSync(slug, 'image');
    if (Array.isArray(ratios) && ratios.length > 0 && ratios[0]?.ui_name) {
      return ratios.reduce((acc, r) => {
        acc[r.ui_name] = r.value;
        return acc;
      }, {});
    }

    // 3. No ui_name in ratios - return empty (not all providers have this)
    return {};
  }

  /**
   * Phase 3: Server-Only — derive từ ratios, throws if cache empty.
   * @param {string} slug
   * @returns {object} { story: 'Story 9:16', ... }
   */
  static getRatioAriaLabelsSync(slug) {
    // 1. Check legacy key (backward compat)
    if (this._apiConfigsCache?.data?.[slug]?.configs?.ratio_aria_labels) {
      const legacy = this._apiConfigsCache.data[slug].configs.ratio_aria_labels;
      if (Object.keys(legacy).length > 0) return legacy;
    }

    // 2. Derive từ ratios (will throw if cache empty)
    const ratios = this.getRatiosSync(slug, 'image');
    if (Array.isArray(ratios) && ratios.length > 0 && ratios[0]?.ui_name) {
      return ratios.reduce((acc, r) => {
        const label = r.ui_name.charAt(0).toUpperCase() + r.ui_name.slice(1);
        acc[r.ui_name] = `${label} ${r.value}`;
        return acc;
      }, {});
    }

    // 3. No ui_name in ratios - return empty (not all providers have this)
    return {};
  }

  // ============ End Phase J Methods ============

  // ───────────────────────────────────────────────────────────────────────
  // Phase 3: SAFE GETTERS (catch ConfigRequiredError, return fallback)
  // Use these in UI components for graceful degradation
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Safe version of getRatiosSync - returns empty array if data unavailable.
   * Use in UI templates where throwing would crash rendering.
   */
  static safeGetRatiosSync(providerSlug, mode) {
    try {
      const result = this.getRatiosSync(providerSlug, mode);
      if (this._DEBUG) console.log(`[PCM] safeGetRatiosSync(${providerSlug}, ${mode}) ✓`, result?.length, 'items');
      return result;
    } catch (err) {
      if (window.ConfigRequiredError?.is?.(err)) {
        if (this._DEBUG) console.log(`[PCM] safeGetRatiosSync(${providerSlug}, ${mode}) → [] (caught ConfigRequiredError)`);
        return [];
      }
      throw err;
    }
  }

  /**
   * Safe version of getErrorPatternsSync - returns empty array if unavailable.
   */
  static safeGetErrorPatternsSync(providerSlug) {
    try {
      const result = this.getErrorPatternsSync(providerSlug);
      if (this._DEBUG) console.log(`[PCM] safeGetErrorPatternsSync(${providerSlug}) ✓`, result?.length, 'patterns');
      return result;
    } catch (err) {
      if (window.ConfigRequiredError?.is?.(err)) {
        if (this._DEBUG) console.log(`[PCM] safeGetErrorPatternsSync(${providerSlug}) → [] (caught ConfigRequiredError)`);
        return [];
      }
      throw err;
    }
  }

  /**
   * Safe version of getDownloadResolutionsSync - returns empty array if unavailable.
   */
  static safeGetDownloadResolutionsSync(providerSlug) {
    try {
      const result = this.getDownloadResolutionsSync(providerSlug);
      if (this._DEBUG) console.log(`[PCM] safeGetDownloadResolutionsSync(${providerSlug}) ✓`, result?.length, 'resolutions');
      return result;
    } catch (err) {
      if (window.ConfigRequiredError?.is?.(err)) {
        if (this._DEBUG) console.log(`[PCM] safeGetDownloadResolutionsSync(${providerSlug}) → [] (caught ConfigRequiredError)`);
        return [];
      }
      throw err;
    }
  }

  /**
   * Safe version of getRatioUiMapSync - returns empty object if unavailable.
   */
  static safeGetRatioUiMapSync(slug) {
    try {
      return this.getRatioUiMapSync(slug);
    } catch (err) {
      if (window.ConfigRequiredError?.is?.(err)) {
        return {};
      }
      throw err;
    }
  }

  /**
   * Safe version of getRatioAriaLabelsSync - returns empty object if unavailable.
   */
  static safeGetRatioAriaLabelsSync(slug) {
    try {
      return this.getRatioAriaLabelsSync(slug);
    } catch (err) {
      if (window.ConfigRequiredError?.is?.(err)) {
        return {};
      }
      throw err;
    }
  }

  /**
   * Safe version of getSupportsSync - returns empty object if unavailable.
   */
  static safeGetSupportsSync(slug) {
    try {
      return this.getSupportsSync(slug);
    } catch (err) {
      if (window.ConfigRequiredError?.is?.(err)) {
        console.warn(`[PCM] safeGetSupportsSync: ${err.message}`);
        return {};
      }
      throw err;
    }
  }

  /**
   * Safe version of getMaxRefImagesSync - returns null if unavailable.
   */
  static safeGetMaxRefImagesSync(slug, mode) {
    try {
      return this.getMaxRefImagesSync(slug, mode);
    } catch (err) {
      if (window.ConfigRequiredError?.is?.(err)) {
        return null;
      }
      throw err;
    }
  }

  /**
   * Get quantity_range config (min/max) cho provider — Flow only hiện tại.
   * Format value: {min: 1, max: 4}
   * @param {string} slug
   * @returns {{min:number,max:number}|null}
   */
  static getQuantityRangeSync(slug) {
    const data = this._apiConfigsCache?.data?.[slug]?.configs?.quantity_range;
    if (data && typeof data.min === 'number' && typeof data.max === 'number') {
      return { min: data.min, max: data.max };
    }
    return null;
  }

  /**
   * Safe version of getQuantityRangeSync - returns null if unavailable.
   * Caller fallback to inline default (vd {min:1, max:4}).
   */
  static safeGetQuantityRangeSync(slug) {
    try {
      return this.getQuantityRangeSync(slug);
    } catch (err) {
      if (window.ConfigRequiredError?.is?.(err)) {
        return null;
      }
      throw err;
    }
  }

  // ============ End Phase 3 Safe Getters ============

  /**
   * Internal: fetch /providers/api-configs với cache riêng (TTL 1h).
   * Separate khỏi /dom-selectors vì 2 endpoint khác nhau.
   */
  static async _fetchApiConfigs() {
    if (this._apiConfigsCache && Date.now() < this._apiConfigsCache.expiresAt) {
      return this._apiConfigsCache.data;
    }
    if (this._apiConfigsFetchPromise) return this._apiConfigsFetchPromise;

    this._apiConfigsFetchPromise = this._doFetchApiConfigs();
    try {
      return await this._apiConfigsFetchPromise;
    } finally {
      this._apiConfigsFetchPromise = null;
    }
  }

  static async _doFetchApiConfigs() {
    try {
      // PERF FIX (2026-05-17): Đọc chrome.storage cache TRƯỚC khi HTTP fetch — background.js
      // `_fetchApiConfigs()` ở `onInstalled`/`onStartup` đã preload vào storage. Trước fix,
      // sidebar mở → in-memory cache empty → HTTP fetch lại (duplicate background fetch).
      // Mirror pattern `_doFetch()` của dom-selectors (line 728).
      const cached = await this._readApiConfigsCache();
      if (cached && cached.data && Date.now() < (cached.expiresAt || 0)) {
        this._apiConfigsCache = cached;
        console.log('[ProviderConfigManager] api-configs warm from chrome.storage (background preload), SKIP HTTP fetch');
        if (window.eventBus) {
          window.eventBus.emit('provider:api_configs_loaded', { data: cached.data });
        }
        return cached.data;
      }

      const baseUrl = await this._getApiBaseUrl();
      // Bug 42 fix (2026-05-13): Backend trả Cache-Control: public, max-age=3600 →
      // browser HTTP cache giữ stale response 1h. Force fresh network call qua cache:'no-store'
      // (extension đã có in-memory + chrome.storage cache TTL riêng, không cần HTTP cache).
      // Timeout 8s — tránh sidebar đứng hình trên mạng chậm.
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);
      const apiConfigUrl = `${baseUrl}/api/v1/providers/api-configs`;
      // Sprint 3: HMAC signature từ RequestSigner (đồng bộ format với background.js)
      const sigHeaders = (typeof RequestSigner !== 'undefined')
        ? await RequestSigner.headers('GET', new URL(apiConfigUrl).pathname, '')
        : {};
      let resp;
      try {
        resp = await fetch(apiConfigUrl, {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            'X-Extension-Id': chrome.runtime.id,
            ...sigHeaders,
          },
          cache: 'no-store',
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeoutId);
      }
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const json = await resp.json();
      if (json.success && json.data) {
        this._apiConfigsCache = {
          data: json.data,
          expiresAt: Date.now() + this._CACHE_TTL_MS,
          fetchedAt: Date.now(),
        };
        // Persist vào chrome.storage để content.js đọc được (download_resolutions, ratios, error_patterns).
        this._writeApiConfigsCache(this._apiConfigsCache);
        // Bug 42c fix (2026-05-13): Emit event sau initial fetch để UI components đã render
        // trước khi cache warm có thể re-render với fresh data (e.g. right sidebar Flow ratio
        // dropdown render trước khi _fetchApiConfigs() resolve → stale options).
        if (window.eventBus) {
          window.eventBus.emit('provider:api_configs_loaded', { data: json.data });
        }
        return json.data;
      }
      throw new Error('Invalid response');
    } catch (e) {
      console.warn('[ProviderConfigManager] api-configs fetch failed:', e.message);
      // Fallback: hydrate từ storage cache (nếu có) khi network fail
      const cached = await this._readApiConfigsCache();
      if (cached?.data) {
        this._apiConfigsCache = cached;
        return cached.data;
      }
      return {};
    }
  }

  /**
   * Fetch từ API với cache
   */
  static async fetch() {
    if (this._cache && Date.now() < this._cache.expiresAt) {
      return this._cache.data;
    }

    if (this._fetchPromise) return this._fetchPromise;

    this._fetchPromise = this._doFetch();
    try {
      const data = await this._fetchPromise;
      return data;
    } finally {
      this._fetchPromise = null;
    }
  }

  static async _doFetch() {
    try {
      const cached = await this._readCache();
      if (cached && Date.now() < cached.expiresAt) {
        this._cache = cached;
        return cached.data;
      }

      const baseUrl = await this._getApiBaseUrl();
      // Bug 42 fix: cache:'no-store' để bypass HTTP cache (extension tự manage cache).
      // Timeout 8s — tránh sidebar đứng hình trên mạng chậm.
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);
      const domSelectorsUrl = `${baseUrl}/api/v1/providers/dom-selectors`;
      // Sprint 3: HMAC signature từ RequestSigner (đồng bộ format với background.js)
      const sigHeaders = (typeof RequestSigner !== 'undefined')
        ? await RequestSigner.headers('GET', new URL(domSelectorsUrl).pathname, '')
        : {};
      let resp;
      try {
        resp = await fetch(domSelectorsUrl, {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            'X-Extension-Id': chrome.runtime.id,
            ...sigHeaders,
          },
          cache: 'no-store',
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeoutId);
      }

      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const json = await resp.json();

      if (json.success && json.data) {
        const cacheData = {
          data: json.data,
          expiresAt: Date.now() + this._CACHE_TTL_MS,
          fetchedAt: Date.now(),
        };
        this._cache = cacheData;
        await this._writeCache(cacheData);
        return json.data;
      }

      throw new Error('Invalid response');
    } catch (e) {
      console.warn('[ProviderConfigManager] Fetch failed, using cache/defaults:', e.message);

      const staleCache = await this._readCache();
      if (staleCache?.data) {
        this._cache = { ...staleCache, expiresAt: Date.now() + 5 * 60 * 1000 };
        return staleCache.data;
      }

      return {};
    }
  }

  /**
   * Force refresh cache
   */
  static async refresh() {
    this._cache = null;
    await this._clearCache();
    return this.fetch();
  }

  /**
   * [Phase 5 2026-05-24] Called by ConfigVersionPoller khi version mismatch.
   * Input: providersVersionMap {flow: 158, chatgpt: 89, grok: 124, gemini: 67}
   * Diff per-provider với cached _cache.data[provider].config_version → fetch nếu ANY mismatch.
   * Force refresh BOTH dom-selectors + api-configs (2 endpoint riêng).
   */
  static async _updateFromVersion(providersVersionMap) {
    if (!providersVersionMap || typeof providersVersionMap !== 'object') return;

    let anyMismatch = false;
    for (const [provider, remoteVersion] of Object.entries(providersVersionMap)) {
      const cachedVersion = this._cache?.data?.[provider]?.config_version;
      if (cachedVersion !== remoteVersion) {
        anyMismatch = true;
        console.log(`[ProviderConfigManager] ${provider} version mismatch: ${cachedVersion} → ${remoteVersion}`);
      }
    }

    if (!anyMismatch) return; // No-op (Polish 3 defensive)

    // Force refresh CẢ 2 cache (dom-selectors + api-configs)
    this._cache = null;
    this._apiConfigsCache = null;
    await this._clearCache().catch(() => {});
    // Fetch parallel
    await Promise.all([
      this.fetch().catch(e => console.warn('[ProviderConfigManager] dom-selectors refresh failed:', e.message)),
      this._fetchApiConfigs().catch(e => console.warn('[ProviderConfigManager] api-configs refresh failed:', e.message)),
    ]);
    // Emit để UI re-render (mirror handleSseUpdate emit pattern)
    if (window.eventBus) {
      window.eventBus.emit('provider:updated', { source: 'version_poller' });
      window.eventBus.emit('provider:api_configs_loaded', { source: 'version_poller', data: this._apiConfigsCache?.data || {} });
    }
  }

  /**
   * Phase 3: Fetch config với mandatory check.
   * @param {string} configType - 'dom_selectors' | 'api_configs'
   * @throws {ConfigRequiredError} nếu server unavailable và cache expired (> 24h)
   */
  static async fetchMandatory(configType) {
    const ConfigRequiredError = window.ConfigRequiredError;

    // 1. Try server first
    try {
      let data;
      if (configType === 'api_configs') {
        data = await this._fetchApiConfigs();
      } else {
        data = await this._doFetch();
      }

      if (data && Object.keys(data).length > 0) {
        return data;
      }
    } catch (e) {
      console.warn(`[PCM] fetchMandatory server fail for ${configType}:`, e.message);
    }

    // 2. Try cache with grace period
    const cacheKey = configType === 'api_configs' ? this._API_CONFIGS_CACHE_KEY : this._CACHE_KEY;
    const cached = configType === 'api_configs'
      ? await this._readApiConfigsCache()
      : await this._readCache();

    if (cached?.data) {
      const cacheAge = Date.now() - (cached.fetchedAt || cached.expiresAt - this._CACHE_TTL_MS || 0);

      // Within grace period (24h) - use cache
      if (cacheAge < this._GRACE_PERIOD_MS) {
        console.log(`[PCM] Using cached ${configType} (age: ${Math.round(cacheAge / 1000 / 60)}m)`);

        // Update in-memory cache
        if (configType === 'api_configs') {
          this._apiConfigsCache = cached;
        } else {
          this._cache = cached;
        }

        return cached.data;
      }

      // Expired but still return with warning
      console.warn(`[PCM] Cache expired for ${configType}, grace period exceeded`);
    }

    // 3. No data available - throw error
    if (ConfigRequiredError) {
      throw new ConfigRequiredError(configType, 'server_unavailable_cache_expired');
    }

    // Fallback if ConfigRequiredError not loaded (shouldn't happen)
    console.error(`[PCM] CRITICAL: No data for ${configType}, ConfigRequiredError not available`);
    return configType === 'api_configs' ? this._apiConfigsCache?.data || {} : this._cache?.data || {};
  }

  /**
   * Background fetch (fire-and-forget)
   */
  static fetchInBackground() {
    this.fetch().catch(() => {});
  }

  /**
   * Handle SSE push update
   */
  static handleSseUpdate(data) {
    const { type, provider } = data;

    if (type === 'dom_selector_updated') {
      const { key, value, config_version } = data;
      console.log(`[ProviderConfigManager] SSE selector update: ${provider}.${key}`, value);

      if (this._cache?.data?.[provider]) {
        if (!this._cache.data[provider].selectors) {
          this._cache.data[provider].selectors = {};
        }
        // Store full value object (selectors, attribute, text_match, icon_text, button_text)
        this._cache.data[provider].selectors[key] = value;
        this._cache.data[provider].config_version = config_version;
        this._writeCache(this._cache);
      }

      if (window.eventBus) {
        window.eventBus.emit('provider:selector_updated', { provider, key, value });
      }

      // Notify content scripts via background broadcast
      if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
        chrome.runtime.sendMessage({ action: 'providerConfigUpdated', data }).catch(() => {});
      }
    }

    if (type === 'provider_status_changed') {
      const { status, name } = data;
      console.log(`[ProviderConfigManager] SSE status change: ${provider} → ${status}`);

      if (this._cache?.data?.[provider]) {
        this._cache.data[provider].status = status;
        this._writeCache(this._cache);
      }

      if (window.eventBus) {
        window.eventBus.emit('provider:status_changed', { provider, status, name });
      }

      if (status === 'disabled' || status === 'maintenance') {
        this._notifyProviderUnavailable(provider, status, name);
      }
    }

    if (type === 'api_config_updated' || type === 'api_config_created' || type === 'api_config_deleted') {
      const key = data.key;
      const value = data.value;
      const configVersion = data.config_version;
      console.log(`[ProviderConfigManager] SSE api_config ${type}: ${provider}.${key}`);

      // Race fix (Bug 19): nếu payload có value đầy đủ, update cache in-place
      // → consumer listener đọc fresh data ngay. Tránh emit trước khi async refetch xong.
      const hasCache = !!this._apiConfigsCache?.data?.[provider];
      const hasValue = value !== undefined && value !== null;

      if (hasCache && hasValue) {
        // Optimistic update — cache in-memory + persist storage để content.js đọc được
        if (!this._apiConfigsCache.data[provider].configs) {
          this._apiConfigsCache.data[provider].configs = {};
        }
        if (type === 'api_config_deleted') {
          delete this._apiConfigsCache.data[provider].configs[key];
        } else {
          this._apiConfigsCache.data[provider].configs[key] = value;
        }
        if (configVersion) this._apiConfigsCache.data[provider].config_version = configVersion;
        this._apiConfigsCache.fetchedAt = Date.now();
        // Persist để content.js + popup windows sync
        this._writeApiConfigsCache(this._apiConfigsCache);
        if (window.eventBus) {
          window.eventBus.emit('provider:api_config_updated', { provider, key, type, value });
        }
        // Notify content scripts qua background broadcast (giống dom_selector_updated)
        if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
          chrome.runtime.sendMessage({ action: 'providerApiConfigUpdated', data }).catch(() => {});
        }
      } else {
        // No cache hoặc thiếu value → invalidate + refetch + emit SAU khi fetch xong
        this._apiConfigsCache = null;
        this._apiConfigsFetchPromise = null;
        this._fetchApiConfigs().then(() => {
          if (window.eventBus) {
            window.eventBus.emit('provider:api_config_updated', { provider, key, type, value });
          }
        }).catch(() => {
          // Emit kể cả khi fetch fail (consumer dùng fallback)
          if (window.eventBus) {
            window.eventBus.emit('provider:api_config_updated', { provider, key, type, value });
          }
        });
      }
    }
  }

  static _notifyProviderUnavailable(provider, status, name) {
    const messages = {
      disabled: `${name} đã bị tắt tạm thời.`,
      maintenance: `${name} đang bảo trì. Vui lòng thử lại sau.`,
    };

    if (window.TobyNotify) {
      window.TobyNotify.warning(messages[status] || `${name} không khả dụng.`);
    }
  }

  /**
   * Report selector failure (throttled)
   */
  static _recentFailures = new Map();

  static reportFailure(provider, key, triedSelectors) {
    const throttleKey = `sel_fail_${provider}_${key}`;
    if (this._recentFailures.has(throttleKey)) return;

    this._recentFailures.set(throttleKey, Date.now());
    setTimeout(() => this._recentFailures.delete(throttleKey), 5 * 60 * 1000);

    this._getApiBaseUrl().then(async (baseUrl) => {
      const url = `${baseUrl}/api/v1/analytics/selector-failure`;
      // Build body ONCE — signature hash phải khớp chính xác body gửi đi
      const bodyStr = JSON.stringify({
        provider,
        key,
        tried_selectors: triedSelectors,
        page_url: location?.hostname + location?.pathname,
        timestamp: new Date().toISOString(),
      });
      const headers = {
        'Content-Type': 'application/json',
        'X-Extension-Id': chrome.runtime.id,
      };
      // Sprint 3 HMAC: ký kèm body hash để pass VerifySignature enforce mode (POST)
      try { Object.assign(headers, await (window.RequestSigner?.headers?.('POST', new URL(url).pathname, bodyStr) || {})); } catch (_) {}
      fetch(url, { method: 'POST', headers, body: bodyStr }).catch(() => {});
    });
  }

  // Storage helpers
  static async _readCache() {
    return new Promise(resolve => {
      if (typeof chrome !== 'undefined' && chrome.storage?.local) {
        chrome.storage.local.get([this._CACHE_KEY], res => {
          resolve(res[this._CACHE_KEY] || null);
        });
      } else {
        try {
          const cached = localStorage.getItem(this._CACHE_KEY);
          resolve(cached ? JSON.parse(cached) : null);
        } catch {
          resolve(null);
        }
      }
    });
  }

  static async _writeCache(data) {
    return new Promise(resolve => {
      if (typeof chrome !== 'undefined' && chrome.storage?.local) {
        chrome.storage.local.set({ [this._CACHE_KEY]: data }, resolve);
      } else {
        try {
          localStorage.setItem(this._CACHE_KEY, JSON.stringify(data));
        } catch {}
        resolve();
      }
    });
  }

  static async _clearCache() {
    return new Promise(resolve => {
      if (typeof chrome !== 'undefined' && chrome.storage?.local) {
        chrome.storage.local.remove([this._CACHE_KEY], resolve);
      } else {
        try {
          localStorage.removeItem(this._CACHE_KEY);
        } catch {}
        resolve();
      }
    });
  }

  // ─── API configs persistence (cho content.js access) ────────────────────
  static async _readApiConfigsCache() {
    return new Promise(resolve => {
      if (typeof chrome !== 'undefined' && chrome.storage?.local) {
        chrome.storage.local.get([this._API_CONFIGS_CACHE_KEY], res => {
          resolve(res[this._API_CONFIGS_CACHE_KEY] || null);
        });
      } else {
        try {
          const cached = localStorage.getItem(this._API_CONFIGS_CACHE_KEY);
          resolve(cached ? JSON.parse(cached) : null);
        } catch {
          resolve(null);
        }
      }
    });
  }

  static async _writeApiConfigsCache(data) {
    return new Promise(resolve => {
      if (typeof chrome !== 'undefined' && chrome.storage?.local) {
        chrome.storage.local.set({ [this._API_CONFIGS_CACHE_KEY]: data }, resolve);
      } else {
        try {
          localStorage.setItem(this._API_CONFIGS_CACHE_KEY, JSON.stringify(data));
        } catch {}
        resolve();
      }
    });
  }

  static async _getApiBaseUrl() {
    // Strict Server-Only: ApiBaseConfig là single source of truth (DEFAULT đã có).
    return new Promise(resolve => {
      const webBase = window.ApiBaseConfig?.getWebBase?.();
      if (!webBase) console.debug('[Tier3] ProviderConfigManager._getApiBaseUrl: ApiBaseConfig not loaded');
      if (typeof chrome !== 'undefined' && chrome.storage?.local) {
        chrome.storage.local.get(['af_api_url'], res => {
          resolve(res.af_api_url || webBase);
        });
      } else {
        resolve(webBase);
      }
    });
  }
}

// Export for different contexts
if (typeof window !== 'undefined') {
  window.ProviderConfigManager = ProviderConfigManager;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = ProviderConfigManager;
}
