/**
 * ProviderMeta - Cache provider metadata từ backend
 *
 * Cung cấp:
 * - getName(slug) → "ChatGPT" | "Grok" | ...
 * - getIcon(slug) → SVG string | fallback hardcoded
 * - getStatus(slug) → "active" | "maintenance" | "disabled" | ...
 * - isActive(slug) → boolean
 * - getAll() → sorted array
 *
 * SSE listener: provider_updated → update cache + emit event
 *
 * NOTE: Tách biệt với ProviderRegistry (adapter registry) ở providers/ProviderRegistry.js
 */
class ProviderMeta {
  static _cache = null;
  static _cacheTime = 0;
  static _cacheTtl = 300000; // 5 minutes
  static _initialized = false;

  // Fallback icons (current hardcoded SVGs) - used when backend has no icon
  static _FALLBACK_ICONS = {
    flow: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"></polygon><polyline points="2 17 12 22 22 17"></polyline><polyline points="2 12 12 17 22 12"></polyline></svg>`,
    chatgpt: `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z"/></svg>`,
    grok: `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M13.324 3.848L11 6.172V3H2v18h9v-7.172l2.324 2.324 1.414-1.414L12 12l2.738-2.738-1.414-1.414zM4 19V5h5v5.172l-2.324-2.324-1.414 1.414L8 12l-2.738 2.738 1.414 1.414L9 13.828V19H4zM22 3h-7v7h7V3zm-2 5h-3V5h3v3zm-5 6h7v7h-7v-7zm2 5h3v-3h-3v3z"/></svg>`,
    gemini: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3c.132 0 .263 0 .393 0a7.5 7.5 0 0 0 7.92 12.446a9 9 0 1 1 -8.313-12.454z"/><path d="M17 4a2 2 0 0 0 2 2a2 2 0 0 0 -2 2a2 2 0 0 0 -2 -2a2 2 0 0 0 2 -2"/><path d="M19 11h2m-1 -1v2"/></svg>`,
  };

  // Fallback names
  static _FALLBACK_NAMES = {
    flow: 'Flow',
    chatgpt: 'ChatGPT',
    grok: 'Grok',
    gemini: 'Gemini',
  };

  // Fallback order
  static _FALLBACK_ORDER = {
    flow: 1,
    chatgpt: 2,
    grok: 3,
    gemini: 4,
  };

  /**
   * Fetch providers từ server, cache locally
   */
  static async fetch() {
    // Check cache
    if (this._cache && Date.now() - this._cacheTime < this._cacheTtl) {
      return this._cache;
    }

    try {
      const baseUrl = window.ApiBaseConfig?.get?.();
      if (!baseUrl) throw new Error('ApiBaseConfig not available');

      const signedHeaders = window.RequestSigner ? await window.RequestSigner.headers('GET', '/api/v1/providers', '') : {};
      // Anti-clone: X-Extension-Id để pass VerifyExtensionId middleware khi toggle ON
      try { if (chrome?.runtime?.id) signedHeaders['X-Extension-Id'] = chrome.runtime.id; } catch (_) {}
      const resp = await fetch(`${baseUrl}/providers`, {
        headers: signedHeaders,
        cache: 'no-store', // Always fetch fresh data, bypass browser cache
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

      const json = await resp.json();
      this._cache = json.data || [];
      this._cacheTime = Date.now();

      // Also save to chrome.storage for instant access on next load
      chrome.storage.local.set({ toby_providers: this._cache });

      console.log('[ProviderMeta] Fetched', this._cache.length, 'providers');
      // Emit event so UI components can update
      window.eventBus?.emit('provider:meta_loaded', { providers: this._cache });
      return this._cache;
    } catch (e) {
      console.warn('[ProviderMeta] Fetch failed:', e.message);
      // Fallback to chrome.storage
      try {
        const stored = await chrome.storage.local.get('toby_providers');
        if (stored.toby_providers?.length) {
          this._cache = stored.toby_providers;
          return this._cache;
        }
      } catch (_) {}
      return [];
    }
  }

  /**
   * Get provider by slug (sync - from cache only)
   */
  static getSync(slug) {
    return this._cache?.find(p => p.slug === slug) || null;
  }

  /**
   * Get provider name
   */
  static getName(slug) {
    const fromCache = this.getSync(slug)?.name;
    const result = fromCache || this._FALLBACK_NAMES[slug] || slug;
    if (!fromCache) {
      console.log(`[ProviderMeta] getName(${slug}): cache miss, using fallback "${result}"`);
    }
    return result;
  }

  /**
   * Get provider icon (SVG string)
   * Returns backend icon if starts with '<svg', otherwise fallback
   */
  static getIcon(slug) {
    const provider = this.getSync(slug);
    const icon = provider?.icon;
    // Check if icon is SVG markup
    if (icon && (icon.trim().startsWith('<svg') || icon.trim().startsWith('<?xml'))) {
      return icon;
    }
    // Fallback to hardcoded
    return this._FALLBACK_ICONS[slug] || '';
  }

  /**
   * Check if server has a valid custom icon (not empty/fallback)
   */
  static hasServerIcon(slug) {
    const provider = this.getSync(slug);
    const icon = provider?.icon;
    return !!(icon && (icon.trim().startsWith('<svg') || icon.trim().startsWith('<?xml')));
  }

  /**
   * Get provider status
   */
  static getStatus(slug) {
    return this.getSync(slug)?.status || 'active';
  }

  /**
   * Check if provider is active
   */
  static isActive(slug) {
    const status = this.getStatus(slug);
    return status === 'active';
  }

  /**
   * Get provider base URL
   */
  static getBaseUrl(slug) {
    return this.getSync(slug)?.base_url || '';
  }

  /**
   * Get all providers (sorted by sort_order)
   */
  static getAll() {
    if (!this._cache?.length) {
      // Return fallback structure
      return Object.keys(this._FALLBACK_NAMES).map(slug => ({
        slug,
        name: this._FALLBACK_NAMES[slug],
        status: 'active',
        sort_order: this._FALLBACK_ORDER[slug],
      })).sort((a, b) => a.sort_order - b.sort_order);
    }
    return [...this._cache].sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  }

  /**
   * Get active providers only
   */
  static getActiveProviders() {
    return this.getAll().filter(p => p.status === 'active');
  }

  /**
   * Get active provider slugs
   */
  static getActiveSlugs() {
    return this.getActiveProviders().map(p => p.slug);
  }

  /**
   * Invalidate cache (force refetch)
   */
  static invalidate() {
    this._cache = null;
    this._cacheTime = 0;
  }

  /**
   * Handle SSE update - invalidate cache + refetch từ server
   * Pattern từ ModelRegistry: không trust SSE payload, refetch để đảm bảo data mới nhất
   */
  static async handleSseUpdate(data) {
    if (!data?.provider) return;

    console.log('[ProviderMeta] SSE handleSseUpdate called:', {
      provider: data.provider,
      ssePayload: data,
    });

    // Invalidate cache - force refetch
    this._cache = null;
    this._cacheTime = 0;

    // Refetch từ server để lấy data mới nhất
    try {
      await this.fetch();
      console.log('[ProviderMeta] Refetch complete, new cache:', this._cache?.map(p => `${p.slug}:${p.name}`));
    } catch (err) {
      console.warn('[ProviderMeta] Refetch failed:', err.message);
    }
    // NOTE: Event emission moved to SseClient to avoid duplicate events
    // and ensure consistent behavior across all contexts (sidebar + workflow-editor)
  }

  /**
   * Initialize - fetch + bind SSE listener
   */
  static async init() {
    if (this._initialized) return;

    // Load from storage first (instant) - for fast initial render
    try {
      const stored = await chrome.storage.local.get('toby_providers');
      if (stored.toby_providers?.length) {
        this._cache = stored.toby_providers;
        console.log('[ProviderMeta] Loaded from storage:', this._cache.length, 'providers');
        // Emit event for fast UI update with cached data
        window.eventBus?.emit('provider:meta_loaded', { providers: this._cache, source: 'storage' });
      }
    } catch (_) {}

    // Force fetch fresh from server (ignore cache TTL on init)
    this._cacheTime = 0; // Reset cache time to force fresh fetch
    this.fetch().catch(() => {});

    // SSE listener - MUST be called after eventBus is created
    if (window.eventBus) {
      window.eventBus.on('sse:provider_updated', (data) => {
        this.handleSseUpdate(data);
      });
      console.log('[ProviderMeta] SSE listener bound to sse:provider_updated');
    } else {
      console.warn('[ProviderMeta] eventBus not available, SSE listener NOT bound!');
    }

    this._initialized = true;
    console.log('[ProviderMeta] Initialized');
  }
}

window.ProviderMeta = ProviderMeta;
