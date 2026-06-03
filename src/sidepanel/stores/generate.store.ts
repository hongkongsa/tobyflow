/**
 * Generate Store — manages generation state
 */
import { writable, derived } from 'svelte/store';
import type { ProviderKey } from '@shared/types/provider.types';

export interface GenerateResult {
  id: string;
  url: string;
  prompt: string;
  provider: ProviderKey;
  timestamp: number;
}

export interface GenerateState {
  prompt: string;
  provider: ProviderKey;
  model: string;
  mode: 'image' | 'text';
  ratio: string;
  quantity: number;
  status: 'idle' | 'submitting' | 'monitoring' | 'done' | 'error';
  progress: number;
  results: GenerateResult[];
  refImages: { id: string; name: string; preview: string }[];
  error: string | null;
}

const DEFAULT_STATE: GenerateState = {
  prompt: '',
  provider: 'flow',
  model: 'imagen-4-ultra',
  mode: 'image',
  ratio: '1:1',
  quantity: 4,
  status: 'idle',
  progress: 0,
  results: [],
  refImages: [],
  error: null,
};

function createGenerateStore() {
  const { subscribe, set, update } = writable<GenerateState>({ ...DEFAULT_STATE });

  return {
    subscribe,

    setPrompt(prompt: string) { update(s => ({ ...s, prompt })); },
    setProvider(provider: ProviderKey) { update(s => ({ ...s, provider })); },
    setModel(model: string) { update(s => ({ ...s, model })); },
    setMode(mode: 'image' | 'text') { update(s => ({ ...s, mode })); },
    setRatio(ratio: string) { update(s => ({ ...s, ratio })); },
    setQuantity(quantity: number) { update(s => ({ ...s, quantity })); },

    addRefImage(file: File) {
      const id = crypto.randomUUID();
      const preview = URL.createObjectURL(file);
      update(s => ({ ...s, refImages: [...s.refImages, { id, name: file.name, preview }] }));
    },

    removeRefImage(id: string) {
      update(s => ({ ...s, refImages: s.refImages.filter(r => r.id !== id) }));
    },

    async generate() {
      let currentState: GenerateState | undefined;
      const unsub = subscribe(s => { currentState = s; });
      unsub();
      if (!currentState || !currentState.prompt.trim()) return;

      update(s => ({ ...s, status: 'submitting', error: null, progress: 0 }));
      try {
        const response = await chrome.runtime.sendMessage({
          type: 'GENERATE_SUBMIT',
          payload: {
            prompt: currentState.prompt,
            provider: currentState.provider,
            model: currentState.model,
            mode: currentState.mode,
            ratio: currentState.ratio,
            quantity: currentState.quantity,
            refImages: currentState.refImages.map(r => ({ id: r.id, name: r.name })),
          },
        });
        if (response.success) {
          update(s => ({ ...s, status: 'monitoring' }));
        } else {
          update(s => ({ ...s, status: 'error', error: response.error || 'Submit failed' }));
        }
      } catch (e: unknown) {
        update(s => ({ ...s, status: 'error', error: e instanceof Error ? e.message : 'Network error' }));
      }
    },

    addResult(result: GenerateResult) {
      update(s => ({
        ...s,
        results: [result, ...s.results],
        progress: Math.min(100, s.progress + (100 / s.quantity)),
      }));
    },

    setDone() {
      update(s => ({ ...s, status: 'done', progress: 100 }));
    },

    reset() {
      update(s => ({ ...s, status: 'idle', progress: 0, error: null }));
    },

    clearResults() {
      update(s => ({ ...s, results: [] }));
    },
  };
}

export const generateStore = createGenerateStore();
export const generateStatus = derived(generateStore, $s => $s.status);
export const generateResults = derived(generateStore, $s => $s.results);
