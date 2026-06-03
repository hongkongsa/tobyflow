/**
 * History Store — manages execution history records
 */
import { writable, derived } from 'svelte/store';
import type { ProviderKey } from '@shared/types/provider.types';

export interface HistoryRecord {
  id: string;
  prompt: string;
  provider: ProviderKey;
  model: string;
  status: 'success' | 'failed' | 'partial';
  results: string[];
  created_at: string;
  source: 'manual' | 'batch' | 'workflow' | 'telegram';
}

export interface HistoryState {
  records: HistoryRecord[];
  isLoading: boolean;
  page: number;
  hasMore: boolean;
  filter: {
    provider: ProviderKey | 'all';
    status: string;
    source: string;
    search: string;
  };
}

const DEFAULT_STATE: HistoryState = {
  records: [],
  isLoading: false,
  page: 1,
  hasMore: true,
  filter: { provider: 'all', status: 'all', source: 'all', search: '' },
};

function createHistoryStore() {
  const { subscribe, update } = writable<HistoryState>({ ...DEFAULT_STATE });

  return {
    subscribe,

    setFilter(key: keyof HistoryState['filter'], value: string) {
      update(s => ({ ...s, filter: { ...s.filter, [key]: value }, records: [], page: 1, hasMore: true }));
    },

    async load() {
      update(s => ({ ...s, isLoading: true }));
      try {
        const response = await chrome.runtime.sendMessage({
          type: 'HISTORY_GET',
          payload: { page: 1, limit: 20 },
        });
        if (response.success) {
          update(s => ({
            ...s,
            records: response.records || [],
            hasMore: (response.records?.length || 0) >= 20,
            page: 1,
            isLoading: false,
          }));
        } else {
          update(s => ({ ...s, isLoading: false }));
        }
      } catch {
        update(s => ({ ...s, isLoading: false }));
      }
    },

    async loadMore() {
      let state: HistoryState | undefined;
      const unsub = subscribe(s => { state = s; });
      unsub();
      if (!state || !state.hasMore || state.isLoading) return;

      update(s => ({ ...s, isLoading: true }));
      try {
        const response = await chrome.runtime.sendMessage({
          type: 'HISTORY_GET',
          payload: { page: state.page + 1, limit: 20 },
        });
        if (response.success) {
          update(s => ({
            ...s,
            records: [...s.records, ...(response.records || [])],
            hasMore: (response.records?.length || 0) >= 20,
            page: s.page + 1,
            isLoading: false,
          }));
        } else {
          update(s => ({ ...s, isLoading: false }));
        }
      } catch {
        update(s => ({ ...s, isLoading: false }));
      }
    },

    async deleteRecord(id: string) {
      await chrome.runtime.sendMessage({ type: 'HISTORY_DELETE', payload: { id } });
      update(s => ({ ...s, records: s.records.filter(r => r.id !== id) }));
    },

    async clearAll() {
      await chrome.runtime.sendMessage({ type: 'HISTORY_CLEAR' });
      update(s => ({ ...s, records: [] }));
    },
  };
}

export const historyStore = createHistoryStore();
export const historyRecords = derived(historyStore, $s => $s.records);
