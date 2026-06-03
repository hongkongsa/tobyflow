/**
 * SystemConfig — Centralized timeout/configuration values
 * Values sourced from backend with hardcoded fallbacks
 */

export interface SystemTimeouts {
  api_timeout_ms: number;
  image_timeout_ms: number;
  sse_max_delay_ms: number;
  tile_settle_base_ms: number;
  tile_settle_per_tile_ms: number;
  selector_wait_max_ms: number;
  selector_cache_ttl_ms: number;
  execution_blocker_timeout_ms: number;
  heartbeat_interval_ms: number;
  heartbeat_stale_ttl_ms: number;
  entitlements_cache_ttl_ms: number;
  config_poll_connected_ms: number;
  config_poll_disconnected_ms: number;
  tile_status_cache_ttl_ms: number;
  tile_dom_cache_ttl_ms: number;
  macro_delay_ratio: number;
  input_timeout_default_ms: number;
}

const DEFAULT_TIMEOUTS: SystemTimeouts = {
  api_timeout_ms: 30_000,
  image_timeout_ms: 120_000,
  sse_max_delay_ms: 30_000,
  tile_settle_base_ms: 3_000,
  tile_settle_per_tile_ms: 500,
  selector_wait_max_ms: 10_000,
  selector_cache_ttl_ms: 30_000,
  execution_blocker_timeout_ms: 40_000,
  heartbeat_interval_ms: 60_000,
  heartbeat_stale_ttl_ms: 300_000,
  entitlements_cache_ttl_ms: 1_800_000,
  config_poll_connected_ms: 1_800_000,
  config_poll_disconnected_ms: 300_000,
  tile_status_cache_ttl_ms: 1_500,
  tile_dom_cache_ttl_ms: 250,
  macro_delay_ratio: 0.7,
  input_timeout_default_ms: 1_200,
};

export class SystemConfig {
  private timeouts: SystemTimeouts = { ...DEFAULT_TIMEOUTS };
  private loaded = false;

  getTimeout<K extends keyof SystemTimeouts>(key: K): SystemTimeouts[K] {
    return this.timeouts[key];
  }

  async loadFromServer(): Promise<void> {
    // TODO: Fetch from /settings/defaults → merge with defaults
    this.loaded = true;
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  update(partial: Partial<SystemTimeouts>): void {
    Object.assign(this.timeouts, partial);
  }
}

export const systemConfig = new SystemConfig();
