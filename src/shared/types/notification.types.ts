/**
 * Notification System — Type Definitions
 */

export type NotificationChannel = 'browser' | 'sound' | 'badge' | 'webhook';

export type NotificationEventType =
  | 'job_completed'
  | 'job_failed'
  | 'workflow_completed'
  | 'download_completed'
  | 'telegram_result'
  | 'announcement';

export interface NotificationConfig {
  channels: Record<NotificationChannel, boolean>;
  webhook_url?: string;
  sound_type: 'default' | 'subtle' | 'none';
}

export interface Notification {
  id: string;
  type: NotificationEventType;
  title: string;
  body: string;
  icon?: string;
  read: boolean;
  created_at: string;
  action_url?: string;
  metadata?: Record<string, unknown>;
}

export interface Announcement {
  id: string;
  title: string;
  body: string;
  type: 'info' | 'warning' | 'update' | 'promotion';
  action_url?: string;
  dismissable: boolean;
  expires_at?: string;
  created_at: string;
}
