/**
 * ProviderRegistry — Factory and routing for provider adapters
 */

import type { ProviderKey, SubmitParams, SubmitResult } from '@shared/types';
import { BaseProvider } from './base.adapter';

class ProviderRegistryImpl {
  private providers = new Map<ProviderKey, BaseProvider>();

  register(provider: BaseProvider): void {
    this.providers.set(provider.key, provider);
  }

  get(key: ProviderKey): BaseProvider {
    const provider = this.providers.get(key);
    if (!provider) {
      throw new Error(`Provider '${key}' not registered`);
    }
    return provider;
  }

  has(key: ProviderKey): boolean {
    return this.providers.has(key);
  }

  getAll(): BaseProvider[] {
    return Array.from(this.providers.values());
  }

  getEnabled(): Promise<BaseProvider[]> {
    return Promise.all(
      this.getAll().map(async (p) => ({ provider: p, enabled: await p.isEnabled() }))
    ).then((results) => results.filter((r) => r.enabled).map((r) => r.provider));
  }

  /**
   * Route a submit request to the appropriate provider
   * Handles: FeatureGate check → ExecutionGate → TabLock → submit
   */
  async route(key: ProviderKey, params: SubmitParams): Promise<SubmitResult> {
    const provider = this.get(key);

    // Check if provider is enabled
    const enabled = await provider.isEnabled();
    if (!enabled) {
      return {
        success: false,
        mediaUrls: [],
        thumbnails: {},
        tileIds: [],
        error: {
          code: 'UNKNOWN',
          message: `Provider '${key}' is not enabled for your plan`,
          provider: key,
          retryable: false,
        },
      };
    }

    // Ensure ready
    const readyResult = await provider.ensureReady();
    if (!readyResult.ready) {
      return {
        success: false,
        mediaUrls: [],
        thumbnails: {},
        tileIds: [],
        error: {
          code: 'SESSION_EXPIRED',
          message: readyResult.error || 'Provider not ready',
          provider: key,
          retryable: true,
        },
      };
    }

    // Submit
    return provider.submit(params);
  }
}

export const ProviderRegistry = new ProviderRegistryImpl();
