/**
 * Batch Queue — Type Definitions
 */

export type JobState = 'queued' | 'running' | 'paused' | 'completed' | 'stopped' | 'failed';
export type QueueItemState = 'pending' | 'submitting' | 'submitted' | 'monitoring' | 'completed' | 'failed' | 'skipped';

export interface BatchJob {
  id: string;
  name?: string;
  items: BatchItem[];
  settings: BatchSettings;
  state: JobState;
  stats: BatchStats;
  created_at: string;
  started_at?: string;
  completed_at?: string;
}

export interface BatchItem {
  id: string;
  prompt: string;
  state: QueueItemState;
  tile_ids?: string[];
  media_urls?: string[];
  error?: string;
  retry_count: number;
  started_at?: string;
  completed_at?: string;
}

export interface BatchSettings {
  provider: string;
  ratio?: string;
  model?: string;
  mode?: 'image' | 'video';
  quantity: number;
  delay_between_ms: number;
  auto_download: boolean;
  retry_on_fail: boolean;
  max_retries: number;
}

export interface BatchStats {
  total: number;
  completed: number;
  failed: number;
  pending: number;
  running: number;
  skipped: number;
  total_media: number;
  duration_ms: number;
}
