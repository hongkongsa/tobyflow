/**
 * UI & Settings — Type Definitions
 */

export type TabId =
  | 'generate'
  | 'batch'
  | 'workflow'
  | 'history'
  | 'albums'
  | 'telegram'
  | 'notifications'
  | 'settings';

export type ThemeMode = 'dark' | 'light';
export type Locale = 'vi' | 'en' | 'ja' | 'th';

export interface UserSettings {
  locale: Locale;
  theme: ThemeMode;
  notifications_enabled: boolean;
  sound_enabled: boolean;
  auto_download: boolean;
  download_quality: '2k' | '4k';
  download_naming_pattern: string;
  input_timeout: number;
  retry_on_fail: boolean;
  humanized_typing: boolean;
  default_provider: string;
  default_ratio: string;
  default_model: string;
  default_quantity: number;
}

export interface ToastMessage {
  id: string;
  type: 'success' | 'error' | 'warning' | 'info';
  message: string;
  duration?: number;
  dedup_key?: string;
}

export interface DialogConfig {
  type: 'confirm' | 'prompt' | 'modal';
  title: string;
  message?: string;
  placeholder?: string;
  confirmText?: string;
  cancelText?: string;
  dangerous?: boolean;
}

export interface NotificationItem {
  id: string;
  type: 'job_complete' | 'job_failed' | 'workflow_done' | 'download_done' | 'telegram_result' | 'announcement';
  title: string;
  body: string;
  read: boolean;
  created_at: string;
  action_url?: string;
}

export interface KeyboardShortcut {
  key: string;
  action: string;
  description: string;
}
