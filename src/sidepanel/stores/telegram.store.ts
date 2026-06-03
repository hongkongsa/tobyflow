/**
 * Telegram Store — manages Telegram bot integration
 */
import { writable } from 'svelte/store';

export interface TelegramCommand {
  id: string;
  command: string;
  description: string;
  provider: string;
  enabled: boolean;
}

export interface TelegramState {
  connected: boolean;
  chatId: string;
  botUsername: string;
  commands: TelegramCommand[];
  isLoading: boolean;
}

function createTelegramStore() {
  const { subscribe, update } = writable<TelegramState>({
    connected: false,
    chatId: '',
    botUsername: '',
    commands: [],
    isLoading: false,
  });

  return {
    subscribe,

    async loadConfig() {
      update(s => ({ ...s, isLoading: true }));
      try {
        const response = await chrome.runtime.sendMessage({ type: 'TELEGRAM_CONFIG' });
        if (response.success) {
          update(s => ({
            ...s,
            connected: response.connected || false,
            chatId: response.chat_id || '',
            botUsername: response.bot_username || '',
            commands: response.commands || [],
            isLoading: false,
          }));
        } else {
          update(s => ({ ...s, isLoading: false }));
        }
      } catch {
        update(s => ({ ...s, isLoading: false }));
      }
    },

    async connect(chatId: string) {
      const response = await chrome.runtime.sendMessage({
        type: 'TELEGRAM_CONNECT',
        payload: { chat_id: chatId },
      });
      if (response.success) {
        update(s => ({ ...s, connected: true, chatId }));
      }
      return response;
    },

    async disconnect() {
      await chrome.runtime.sendMessage({ type: 'TELEGRAM_DISCONNECT' });
      update(s => ({ ...s, connected: false, chatId: '' }));
    },

    async addCommand(command: string, description: string, provider: string) {
      const response = await chrome.runtime.sendMessage({
        type: 'TELEGRAM_ADD_COMMAND',
        payload: { command, description, provider },
      });
      if (response.success && response.command) {
        update(s => ({ ...s, commands: [...s.commands, response.command] }));
      }
    },

    async toggleCommand(commandId: string) {
      update(s => ({
        ...s,
        commands: s.commands.map(c =>
          c.id === commandId ? { ...c, enabled: !c.enabled } : c
        ),
      }));
      await chrome.runtime.sendMessage({
        type: 'TELEGRAM_TOGGLE_COMMAND',
        payload: { commandId },
      });
    },

    async deleteCommand(commandId: string) {
      await chrome.runtime.sendMessage({
        type: 'TELEGRAM_DELETE_COMMAND',
        payload: { commandId },
      });
      update(s => ({ ...s, commands: s.commands.filter(c => c.id !== commandId) }));
    },
  };
}

export const telegramStore = createTelegramStore();
