/**
 * Notifications Store — manages notification list
 */
import { writable, derived } from 'svelte/store';

export interface Notification {
  id: string;
  type: 'success' | 'error' | 'info' | 'warning' | 'system';
  title: string;
  message: string;
  read: boolean;
  timestamp: number;
  action?: { label: string; url?: string };
}

export interface NotificationsState {
  notifications: Notification[];
  isLoading: boolean;
}

function createNotificationsStore() {
  const { subscribe, update } = writable<NotificationsState>({
    notifications: [],
    isLoading: false,
  });

  return {
    subscribe,

    async load() {
      update(s => ({ ...s, isLoading: true }));
      try {
        const response = await chrome.runtime.sendMessage({ type: 'NOTIFICATIONS_LIST' });
        if (response.success) {
          update(s => ({ ...s, notifications: response.notifications || [], isLoading: false }));
        } else {
          update(s => ({ ...s, isLoading: false }));
        }
      } catch {
        update(s => ({ ...s, isLoading: false }));
      }
    },

    async markRead(id: string) {
      await chrome.runtime.sendMessage({ type: 'NOTIFICATION_READ', payload: { id } });
      update(s => ({
        ...s,
        notifications: s.notifications.map(n =>
          n.id === id ? { ...n, read: true } : n
        ),
      }));
    },

    async markAllRead() {
      await chrome.runtime.sendMessage({ type: 'NOTIFICATIONS_READ_ALL' });
      update(s => ({
        ...s,
        notifications: s.notifications.map(n => ({ ...n, read: true })),
      }));
    },

    async clearAll() {
      await chrome.runtime.sendMessage({ type: 'NOTIFICATIONS_CLEAR' });
      update(s => ({ ...s, notifications: [] }));
    },

    addNotification(notif: Notification) {
      update(s => ({
        ...s,
        notifications: [notif, ...s.notifications],
      }));
    },
  };
}

export const notificationsStore = createNotificationsStore();
export const unreadCount = derived(notificationsStore, $s =>
  $s.notifications.filter(n => !n.read).length
);
