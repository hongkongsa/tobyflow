/**
 * SelectorResolver — Dynamic selector resolution system
 * 
 * All DOM queries go through this class. Selectors are fetched from
 * the backend and cached in chrome.storage.local with 30s TTL.
 * 
 * NEVER hardcode selectors — the backend pushes updates via SSE
 * when providers change their DOM structure.
 */

import type { ProviderKey } from '@shared/types';

interface SelectorConfig {
  selectors: string[];
  attribute?: string;
  text_match?: string;
}

type SelectorMap = Record<string, SelectorConfig>;

const CACHE_TTL = 30_000; // 30 seconds
const WAIT_MAX_MS = 10_000; // 10s max wait for config
const WAIT_INTERVAL_MS = 200; // Poll interval

export class SelectorResolver {
  private provider: ProviderKey;
  private cache: SelectorMap | null = null;
  private cacheTime = 0;
  private ready = false;

  constructor(provider: ProviderKey) {
    this.provider = provider;
    this.listenForUpdates();
  }

  /**
   * Wait for selector config to be available (boot sequence)
   */
  async waitForConfig(): Promise<boolean> {
    const startTime = Date.now();

    while (Date.now() - startTime < WAIT_MAX_MS) {
      const config = await this.loadFromStorage();
      if (config) {
        this.cache = config;
        this.cacheTime = Date.now();
        this.ready = true;
        return true;
      }
      await new Promise((r) => setTimeout(r, WAIT_INTERVAL_MS));
    }

    return false;
  }

  /**
   * Query a single element using dynamic selector
   */
  query(key: string, scope: Element | Document = document): Element | null {
    const config = this.getConfig(key);
    if (!config?.selectors?.length) return null;

    for (const selector of config.selectors) {
      try {
        const el = scope.querySelector(selector);
        if (el) {
          // Optional text_match filter
          if (config.text_match) {
            const text = (el.textContent || '').toLowerCase();
            if (!text.includes(config.text_match.toLowerCase())) continue;
          }
          return el;
        }
      } catch {
        continue;
      }
    }
    return null;
  }

  /**
   * Query all matching elements
   */
  queryAll(key: string, scope: Element | Document = document): Element[] {
    const config = this.getConfig(key);
    if (!config?.selectors?.length) return [];

    for (const selector of config.selectors) {
      try {
        const els = Array.from(scope.querySelectorAll(selector));
        if (els.length > 0) {
          if (config.text_match) {
            return els.filter((el) =>
              (el.textContent || '').toLowerCase().includes(config.text_match!.toLowerCase())
            );
          }
          return els;
        }
      } catch {
        continue;
      }
    }
    return [];
  }

  /**
   * Get attribute value from a queried element
   */
  queryAttribute(key: string, scope: Element | Document = document): string | null {
    const config = this.getConfig(key);
    const el = this.query(key, scope);
    if (!el || !config?.attribute) return null;
    return el.getAttribute(config.attribute);
  }

  get isReady(): boolean {
    return this.ready;
  }

  private getConfig(key: string): SelectorConfig | null {
    // Refresh cache if expired
    if (!this.cache || Date.now() - this.cacheTime > CACHE_TTL) {
      this.refreshCache();
    }
    return this.cache?.[key] ?? null;
  }

  private async refreshCache(): Promise<void> {
    const config = await this.loadFromStorage();
    if (config) {
      this.cache = config;
      this.cacheTime = Date.now();
    }
  }

  private async loadFromStorage(): Promise<SelectorMap | null> {
    return new Promise((resolve) => {
      chrome.storage.local.get(['toby_provider_configs'], (result) => {
        const configs = result.toby_provider_configs;
        const providerConfig = configs?.[this.provider]?.selectors;
        resolve(providerConfig || null);
      });
    });
  }

  private listenForUpdates(): void {
    chrome.storage.onChanged.addListener((changes) => {
      if (changes.toby_provider_configs) {
        // Invalidate cache — next query will re-read
        this.cache = null;
        this.cacheTime = 0;
      }
    });
  }
}
