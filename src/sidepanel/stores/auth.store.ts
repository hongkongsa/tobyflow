/**
 * Auth Store — manages authentication state
 */
import { writable, derived } from 'svelte/store';
import type { User, PlanType, Entitlements } from '@shared/types/auth.types';

export interface AuthState {
  isLoggedIn: boolean;
  user: User | null;
  token: string | null;
  refreshToken: string | null;
  entitlements: Entitlements | null;
  isLoading: boolean;
  error: string | null;
}

const DEFAULT_STATE: AuthState = {
  isLoggedIn: false,
  user: null,
  token: null,
  refreshToken: null,
  entitlements: null,
  isLoading: false,
  error: null,
};

function createAuthStore() {
  const { subscribe, set, update } = writable<AuthState>({ ...DEFAULT_STATE });

  return {
    subscribe,

    async login(email: string, password: string) {
      update(s => ({ ...s, isLoading: true, error: null }));
      try {
        const response = await chrome.runtime.sendMessage({
          type: 'AUTH_LOGIN',
          payload: { email, password },
        });
        if (response.success) {
          update(s => ({
            ...s,
            isLoggedIn: true,
            user: response.user,
            token: response.token,
            refreshToken: response.refresh_token,
            entitlements: response.entitlements,
            isLoading: false,
          }));
        } else {
          update(s => ({ ...s, error: response.error || 'Login failed', isLoading: false }));
        }
      } catch (e: unknown) {
        update(s => ({ ...s, error: e instanceof Error ? e.message : 'Network error', isLoading: false }));
      }
    },

    async logout() {
      await chrome.runtime.sendMessage({ type: 'AUTH_LOGOUT' });
      set({ ...DEFAULT_STATE });
    },

    async checkSession() {
      update(s => ({ ...s, isLoading: true }));
      try {
        const response = await chrome.runtime.sendMessage({ type: 'AUTH_CHECK' });
        if (response.success) {
          update(s => ({
            ...s,
            isLoggedIn: true,
            user: response.user,
            token: response.token,
            entitlements: response.entitlements,
            isLoading: false,
          }));
        } else {
          update(s => ({ ...s, isLoading: false }));
        }
      } catch {
        update(s => ({ ...s, isLoading: false }));
      }
    },

    setEntitlements(entitlements: Entitlements) {
      update(s => ({ ...s, entitlements }));
    },
  };
}

export const authStore = createAuthStore();
export const isLoggedIn = derived(authStore, $s => $s.isLoggedIn);
export const currentUser = derived(authStore, $s => $s.user);
export const currentPlan = derived(authStore, $s => $s.user?.plan ?? 'free' as PlanType);
