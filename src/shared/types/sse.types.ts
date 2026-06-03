/**
 * SSE & Realtime — Type Definitions
 */

export type SseTransportMode = 'mercure' | 'sse' | 'polling';

export type SseEventType =
  | 'telegram_command'
  | 'telegram_cancel'
  | 'telegram_stop'
  | 'provider_config_updated'
  | 'entitlements_changed'
  | 'config_versions_bumped'
  | 'announcement'
  | 'plan_activated';

export interface SseEvent {
  id: string;
  type: SseEventType;
  data: unknown;
  timestamp: number;
}

export interface SseConfig {
  mode: SseTransportMode;
  ticketUrl: string;
  streamUrl: string;
  pollUrl: string;
  mercureUrl?: string;
  mercureToken?: string;
}

export interface SseConnectionState {
  connected: boolean;
  mode: SseTransportMode;
  retryCount: number;
  lastEventId: string | null;
  isLeader: boolean;
}

export interface LeaderElectionMessage {
  type: 'leader_claim' | 'leader_ack' | 'leader_resign' | 'event_forward';
  tabId: string;
  timestamp: number;
  payload?: SseEvent;
}

export interface ConfigVersions {
  system_settings: number;
  providers: number;
  provider_models: number;
  node_types: number;
  validation_rules: number;
  default_settings: number;
  i18n: number;
  user_entitlements: number;
}
