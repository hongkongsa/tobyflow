/**
 * Storage System — Type Definitions
 */

export type StorageMode = 'local' | 'api';

export interface StorageManager {
  mode: StorageMode;
  init(): Promise<void>;
  switchToApi(): Promise<void>;
  switchToLocal(): void;
}

export interface Album {
  id: string;
  name: string;
  photo_count: number;
  cover_thumbnail?: string;
  created_at: string;
  updated_at: string;
}

export interface Photo {
  id: string;
  album_id: string;
  file_name: string;
  thumbnail_blob?: Blob;
  medium_blob?: Blob;
  original_url?: string;
  width?: number;
  height?: number;
  size_bytes?: number;
  created_at: string;
}

export interface PendingUpload {
  id: string;
  key: string;
  thumbnail_blob: Blob;
  file_name: string;
  provider: string;
  upload_status: 'pending' | 'uploading' | 'uploaded' | 'failed';
  tile_id?: string;
  created_at: string;
}

export interface ExecutionRecord {
  id: string;
  type: 'generate' | 'batch' | 'workflow' | 'telegram' | 'angles' | 'effects';
  provider: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  prompt?: string;
  settings?: Record<string, unknown>;
  result_media_urls?: string[];
  result_thumbnails?: string[];
  duration_ms?: number;
  error?: string;
  workflow_id?: string;
  batch_job_id?: string;
  created_at: string;
  completed_at?: string;
}

export interface WorkflowRecord {
  id: string;
  name: string;
  description?: string;
  data: string; // JSON serialized workflow graph
  thumbnail?: string;
  run_count: number;
  last_run_at?: string;
  created_at: string;
  updated_at: string;
}

export interface UploadedCache {
  key: string;
  file_name: string;
  thumbnail_url: string;
  tile_id: string;
  provider: string;
  uploaded_at: string;
}

export interface WorkflowPasteBlob {
  id: string;
  workflow_id: string;
  blob: Blob;
  upload_status: 'pending' | 'uploaded';
  created_at: string;
}

// chrome.storage.local keys
export interface ChromeStorageKeys {
  af_auth: { token: string; user: object } | null;
  af_enrollment: { client_id: string; secret: string; expires_at: string } | null;
  af_tasks: object[];
  af_workflows: object[];
  af_settings: Record<string, unknown>;
  af_user_prompts: object[];
  af_running_workflow: string | null;
  af_heartbeat: number | null;
  toby_device_fp: string;
  toby_api_base: string;
  toby_clone_detected: boolean;
  toby_device_banned: boolean;
  toby_entitlements_cache: object | null;
  toby_provider_configs_cache: object | null;
  toby_selector_config_flow: object | null;
  toby_selector_config_chatgpt: object | null;
  toby_selector_config_grok: object | null;
  toby_selector_config_gemini: object | null;
}
