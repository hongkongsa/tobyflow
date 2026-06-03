/**
 * Telegram Integration — Type Definitions
 */

export type TelegramCommandType = 'generate' | 'describe' | 'cancel' | 'stop';

export interface TelegramCommand {
  queue_id: string;
  command: TelegramCommandType;
  provider?: string;
  prompt?: string;
  settings?: TelegramCommandSettings;
  chat_id: string;
  message_id: number;
}

export interface TelegramCommandSettings {
  ratio?: string;
  model?: string;
  mode?: 'image' | 'video';
  quantity?: number;
  duration?: string;
  resolution?: string;
  quality?: string;
}

export interface TelegramResult {
  queue_id: string;
  status: 'completed' | 'failed' | 'cancelled';
  media_urls?: string[];
  thumbnails?: string[];
  error?: string;
  duration_ms?: number;
}

export interface TelegramConfig {
  enabled: boolean;
  bot_token?: string;
  chat_id?: string;
  default_provider: string;
  notify_on_complete: boolean;
}
