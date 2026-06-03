/**
 * Workflow Types — Workflow engine, nodes, and execution state
 */

import type { ProviderKey, GenerationMode } from './provider.types';

export interface Workflow {
  id: string;
  name: string;
  description?: string;
  nodes: WorkflowNode[];
  connections: WorkflowConnection[];
  created_at: string;
  updated_at: string;
}

export interface WorkflowNode {
  id: string;
  type: NodeType;
  position: { x: number; y: number };
  data: NodeData;
}

export type NodeType = 'generate' | 'chatgpt' | 'grok' | 'gemini' | 'prompt' | 'image' | 'download';

export interface NodeData {
  label: string;
  prompt?: string;
  provider?: ProviderKey;
  mode?: GenerationMode;
  ratio?: string;
  quantity?: number;
  model?: string;
  refImages?: string[]; // file IDs or @mentions
  autoDownload?: boolean;
  resolution?: string;
}

export interface WorkflowConnection {
  id: string;
  source: string; // node ID
  target: string; // node ID
  sourcePort: string;
  targetPort: string;
}

export type ExecutionState =
  | 'idle'
  | 'preparing'
  | 'executing'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'stopped';

export type NodeExecutionState =
  | 'pending'
  | 'running'
  | 'submitting'
  | 'monitoring'
  | 'downloading'
  | 'completed'
  | 'failed'
  | 'skipped';

export interface WorkflowExecution {
  id: string;
  workflow_id: string;
  state: ExecutionState;
  current_node_id: string | null;
  node_states: Record<string, NodeExecutionState>;
  node_results: Record<string, NodeResult>;
  started_at: string;
  completed_at?: string;
  error?: string;
}

export interface NodeResult {
  tileIds: string[];
  mediaUrls: string[];
  thumbnails: Record<string, string>;
  prompt?: string;
  duration_ms: number;
}

export interface BatchJob {
  id: string;
  name: string;
  state: 'queued' | 'running' | 'paused' | 'completed' | 'stopped';
  items: BatchItem[];
  settings: BatchSettings;
  created_at: string;
  completed_at?: string;
  stats: BatchStats;
}

export interface BatchItem {
  id: string;
  prompt: string;
  state: 'pending' | 'submitting' | 'submitted' | 'monitoring' | 'completed' | 'failed' | 'cancelled';
  tileIds: string[];
  error?: string;
}

export interface BatchSettings {
  provider: ProviderKey;
  ratio: string;
  quantity: number;
  model?: string;
  mode: GenerationMode;
  autoDownload: boolean;
  downloadResolution?: string;
  delayBetweenPrompts: number;
}

export interface BatchStats {
  total: number;
  completed: number;
  failed: number;
  pending: number;
}
