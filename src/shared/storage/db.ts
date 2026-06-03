/**
 * Database — Dexie.js schema for IndexedDB storage
 */

import Dexie, { type EntityTable } from 'dexie';

export interface Album {
  id: string;
  name: string;
  photo_count: number;
  created_at: string;
  updated_at: string;
}

export interface Photo {
  id: string;
  album_id: string;
  file_name: string;
  thumbnail_url: string;
  thumbnail_blob?: Blob;
  created_at: string;
}

export interface WorkflowRecord {
  id: string;
  name: string;
  description?: string;
  data: string; // JSON serialized workflow
  created_at: string;
  updated_at: string;
}

export interface ExecutionRecord {
  id: string;
  workflow_id?: string;
  type: 'generate' | 'batch' | 'workflow' | 'telegram';
  provider: string;
  prompt?: string;
  status: 'success' | 'failed';
  result_count: number;
  duration_ms: number;
  created_at: string;
}

export interface PendingUpload {
  id: string;
  thumbnail_blob: Blob;
  file_name: string;
  file_size: number;
  file_type: string;
  name: string;
  created_at: string;
}

const db = new Dexie('TobyFlowDB') as Dexie & {
  albums: EntityTable<Album, 'id'>;
  photos: EntityTable<Photo, 'id'>;
  workflows: EntityTable<WorkflowRecord, 'id'>;
  executions: EntityTable<ExecutionRecord, 'id'>;
  pendingUploads: EntityTable<PendingUpload, 'id'>;
};

db.version(1).stores({
  albums: 'id, name, created_at',
  photos: 'id, album_id, file_name, created_at',
  workflows: 'id, name, updated_at',
  executions: 'id, workflow_id, type, provider, status, created_at',
  pendingUploads: 'id, created_at',
});

export { db };
