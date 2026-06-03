/**
 * Batch Store — manages batch job queue
 */
import { writable, derived } from 'svelte/store';
import type { ProviderKey } from '@shared/types/provider.types';

export interface BatchItem {
  id: string;
  prompt: string;
  status: 'queued' | 'submitting' | 'monitoring' | 'completed' | 'failed';
  result?: string;
  error?: string;
}

export interface BatchJob {
  id: string;
  name: string;
  items: BatchItem[];
  provider: ProviderKey;
  model: string;
  ratio: string;
  status: 'pending' | 'running' | 'paused' | 'completed' | 'cancelled' | 'failed';
  progress: number;
  createdAt: number;
}

export interface BatchState {
  jobs: BatchJob[];
  inputText: string;
  activeJobId: string | null;
}

const DEFAULT_STATE: BatchState = {
  jobs: [],
  inputText: '',
  activeJobId: null,
};

function createBatchStore() {
  const { subscribe, update } = writable<BatchState>({ ...DEFAULT_STATE });

  return {
    subscribe,

    setInputText(text: string) {
      update(s => ({ ...s, inputText: text }));
    },

    createJob(name: string, prompts: string[], provider: ProviderKey, model: string, ratio: string) {
      const job: BatchJob = {
        id: crypto.randomUUID(),
        name: name || `Batch ${new Date().toLocaleString()}`,
        items: prompts.filter(p => p.trim()).map(p => ({
          id: crypto.randomUUID(),
          prompt: p.trim(),
          status: 'queued',
        })),
        provider,
        model,
        ratio,
        status: 'pending',
        progress: 0,
        createdAt: Date.now(),
      };
      update(s => ({ ...s, jobs: [job, ...s.jobs], inputText: '' }));
      return job.id;
    },

    async startJob(jobId: string) {
      update(s => ({
        ...s,
        jobs: s.jobs.map(j => j.id === jobId ? { ...j, status: 'running' as const } : j),
      }));
      const response = await chrome.runtime.sendMessage({
        type: 'BATCH_START',
        payload: { jobId },
      });
      return response;
    },

    async pauseJob(jobId: string) {
      update(s => ({
        ...s,
        jobs: s.jobs.map(j => j.id === jobId ? { ...j, status: 'paused' as const } : j),
      }));
      await chrome.runtime.sendMessage({ type: 'BATCH_PAUSE', payload: { jobId } });
    },

    async resumeJob(jobId: string) {
      update(s => ({
        ...s,
        jobs: s.jobs.map(j => j.id === jobId ? { ...j, status: 'running' as const } : j),
      }));
      await chrome.runtime.sendMessage({ type: 'BATCH_RESUME', payload: { jobId } });
    },

    async cancelJob(jobId: string) {
      update(s => ({
        ...s,
        jobs: s.jobs.map(j => j.id === jobId ? { ...j, status: 'cancelled' as const } : j),
      }));
      await chrome.runtime.sendMessage({ type: 'BATCH_CANCEL', payload: { jobId } });
    },

    deleteJob(jobId: string) {
      update(s => ({
        ...s,
        jobs: s.jobs.filter(j => j.id !== jobId),
        activeJobId: s.activeJobId === jobId ? null : s.activeJobId,
      }));
    },

    setActiveJob(jobId: string | null) {
      update(s => ({ ...s, activeJobId: jobId }));
    },

    updateItem(jobId: string, itemId: string, status: BatchItem['status'], result?: string) {
      update(s => ({
        ...s,
        jobs: s.jobs.map(j => {
          if (j.id !== jobId) return j;
          const items = j.items.map(i =>
            i.id === itemId ? { ...i, status, result } : i
          );
          const completed = items.filter(i => i.status === 'completed' || i.status === 'failed').length;
          const progress = Math.round((completed / items.length) * 100);
          const allDone = completed === items.length;
          return {
            ...j,
            items,
            progress,
            status: allDone ? 'completed' as const : j.status,
          };
        }),
      }));
    },
  };
}

export const batchStore = createBatchStore();
export const batchJobs = derived(batchStore, $s => $s.jobs);
