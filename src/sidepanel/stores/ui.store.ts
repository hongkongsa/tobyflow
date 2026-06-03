/**
 * UI Store — manages global UI state (tab, theme, locale, toasts)
 */
import { writable, derived } from 'svelte/store';

export type TabId = 'generate' | 'batch' | 'workflow' | 'history' | 'albums' | 'telegram' | 'notifications' | 'settings';
export type Theme = 'dark' | 'light';
export type Locale = 'vi' | 'en' | 'ja' | 'th';

export interface Toast {
  id: string;
  type: 'success' | 'error' | 'warning' | 'info';
  message: string;
  duration: number;
}

export interface UIState {
  currentTab: TabId;
  theme: Theme;
  locale: Locale;
  toasts: Toast[];
  sidebarOpen: boolean;
}

const DEFAULT_STATE: UIState = {
  currentTab: 'generate',
  theme: 'dark',
  locale: 'vi',
  toasts: [],
  sidebarOpen: false,
};

function createUIStore() {
  const { subscribe, set, update } = writable<UIState>({ ...DEFAULT_STATE });

  return {
    subscribe,

    setTab(tab: TabId) {
      update(s => ({ ...s, currentTab: tab }));
    },

    setTheme(theme: Theme) {
      update(s => ({ ...s, theme }));
      document.documentElement.setAttribute('data-theme', theme);
      chrome.storage?.local?.set({ theme });
    },

    setLocale(locale: Locale) {
      update(s => ({ ...s, locale }));
      chrome.storage?.local?.set({ locale });
    },

    toast(type: Toast['type'], message: string, duration = 3000) {
      const id = crypto.randomUUID();
      update(s => ({ ...s, toasts: [...s.toasts, { id, type, message, duration }] }));
      if (duration > 0) {
        setTimeout(() => {
          update(s => ({ ...s, toasts: s.toasts.filter(t => t.id !== id) }));
        }, duration);
      }
    },

    dismissToast(id: string) {
      update(s => ({ ...s, toasts: s.toasts.filter(t => t.id !== id) }));
    },

    async loadSettings() {
      try {
        const stored = await chrome.storage?.local?.get(['theme', 'locale', 'currentTab']);
        update(s => ({
          ...s,
          theme: stored?.theme || 'dark',
          locale: stored?.locale || 'vi',
          currentTab: stored?.currentTab || 'generate',
        }));
        document.documentElement.setAttribute('data-theme', stored?.theme || 'dark');
      } catch {
        // Fallback to defaults
      }
    },
  };
}

export const uiStore = createUIStore();
export const currentTab = derived(uiStore, $s => $s.currentTab);
export const theme = derived(uiStore, $s => $s.theme);
