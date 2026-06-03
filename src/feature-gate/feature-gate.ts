/**
 * FeatureGate — Server-driven feature flags & quota system
 * 
 * Equivalent to: src/core/FeatureGate.js (2,048 lines)
 * 
 * Sources (3):
 * 1. SSE push (entitlements_changed event)
 * 2. ConfigVersionPoller (delta fetch)
 * 3. Periodic refresh (30min cache TTL)
 */

import type { PlanType, Entitlements, FeatureFlags, PlanLimits } from '@shared/types';

export type FeatureKey =
  | 'gen_enabled' | 'gen_run_max'
  | 'chatgpt_enabled' | 'chatgpt_run_max'
  | 'grok_enabled' | 'grok_run_max'
  | 'tasks_enabled' | 'tasks_max' | 'tasks_run_max'
  | 'workflows_enabled' | 'workflows_max' | 'workflows_run_max' | 'workflows_nodes_max'
  | 'workflow_share_enabled' | 'workflow_import' | 'workflow_export'
  | 'angles_enabled' | 'angles_run_max'
  | 'effects_enabled' | 'effects_run_max'
  | 'auto_download' | 'retry_on_fail' | 'ref_images'
  | 'prompt_templates_enabled' | 'workflow_templates_enabled'
  | 'history_enabled' | 'snippets_max';

export interface QuotaCheck {
  allowed: boolean;
  remaining: number;
  limit: number;
  used: number;
}

const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

export class FeatureGate {
  private entitlements: Entitlements | null = null;
  private cacheTime = 0;
  private localUsage: Record<string, number> = {};

  async init(): Promise<void> {
    // Load from chrome.storage.local cache first
    // Then fetch from server if stale
    await this.refresh();
  }

  async refresh(): Promise<void> {
    // TODO: GET /entitlements → update cache
    this.cacheTime = Date.now();
  }

  canUse(featureKey: string): boolean {
    if (!this.entitlements) return false;
    const flags = this.entitlements.features as Record<string, boolean>;
    return flags[featureKey] ?? false;
  }

  checkQuota(quotaKey: string): QuotaCheck {
    if (!this.entitlements) {
      return { allowed: false, remaining: 0, limit: 0, used: 0 };
    }
    const limits = this.entitlements.limits as Record<string, number>;
    const limit = limits[quotaKey] ?? 0;
    if (limit === -1) {
      // Unlimited
      return { allowed: true, remaining: Infinity, limit: -1, used: 0 };
    }
    const used = this.localUsage[quotaKey] ?? 0;
    const remaining = Math.max(0, limit - used);
    return { allowed: remaining > 0, remaining, limit, used };
  }

  incrementUsage(quotaKey: string): void {
    this.localUsage[quotaKey] = (this.localUsage[quotaKey] ?? 0) + 1;
  }

  isCacheStale(): boolean {
    return Date.now() - this.cacheTime > CACHE_TTL_MS;
  }

  updateEntitlements(entitlements: Entitlements): void {
    this.entitlements = entitlements;
    this.cacheTime = Date.now();
  }

  getPlan(): PlanType | null {
    return this.entitlements?.plan ?? null;
  }
}

export const featureGate = new FeatureGate();
