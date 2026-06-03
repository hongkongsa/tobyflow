/**
 * TobyFlow Service Worker — Background Script
 * Handles messaging, API calls, auth state, SSE, and provider coordination
 */

import { API_BASE_URL as API_BASE } from '@shared/config/api';

// ============ State ============
interface AppState {
  token: string | null;
  refreshToken: string | null;
  user: {
    id: string;
    email: string;
    name: string;
    plan: string;
  } | null;
  entitlements: {
    plan: string;
    features: Record<string, boolean>;
    limits: Record<string, number>;
    expires_at: string;
  } | null;
  settings: Record<string, unknown>;
  sseConnected: boolean;
  activeExecutions: Map<string, { provider: string; status: string }>;
}

const state: AppState = {
  token: null,
  refreshToken: null,
  user: null,
  entitlements: null,
  settings: {},
  sseConnected: false,
  activeExecutions: new Map(),
};

// ============ API Client ============
async function apiRequest(endpoint: string, options: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> ?? {}),
  };
  if (state.token) {
    headers['Authorization'] = `Bearer ${state.token}`;
  }
  return fetch(`${API_BASE}${endpoint}`, { ...options, headers });
}

async function apiGet(endpoint: string) {
  const res = await apiRequest(endpoint);
  return res.json();
}

async function apiPost(endpoint: string, body: unknown) {
  const res = await apiRequest(endpoint, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return res.json();
}

// ============ Auth Handlers ============
async function handleLogin(payload: { email: string; password: string }) {
  try {
    const data = await apiPost('/auth/login', payload);
    if (data.token) {
      state.token = data.token;
      state.refreshToken = data.refresh_token;
      state.user = data.user;
      // Fetch entitlements
      const ent = await apiGet('/auth/entitlements');
      state.entitlements = ent;
      // Save to storage
      await chrome.storage.local.set({
        auth_token: data.token,
        refresh_token: data.refresh_token,
        user: data.user,
        entitlements: ent,
      });
      return { success: true, token: data.token, refresh_token: data.refresh_token, user: data.user, entitlements: ent };
    }
    return { success: false, error: data.error || 'Login failed' };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}

async function handleLogout() {
  state.token = null;
  state.refreshToken = null;
  state.user = null;
  state.entitlements = null;
  await chrome.storage.local.remove(['auth_token', 'refresh_token', 'user', 'entitlements']);
  return { success: true };
}

async function handleAuthCheck() {
  try {
    const stored = await chrome.storage.local.get(['auth_token', 'refresh_token', 'user', 'entitlements']);
    if (stored.auth_token) {
      state.token = stored.auth_token;
      state.refreshToken = stored.refresh_token;
      state.user = stored.user;
      state.entitlements = stored.entitlements;
      return { success: true, token: stored.auth_token, user: stored.user, entitlements: stored.entitlements };
    }
  } catch { /* */ }
  return { success: false };
}

// ============ Generate Handlers ============
async function handleGenerateSubmit(payload: {
  prompt: string;
  provider: string;
  model: string;
  mode: string;
  ratio: string;
  quantity: number;
  refImages: { id: string; name: string }[];
}) {
  try {
    // Request execution token
    const gate = await apiPost('/execution/request', {
      action: `${payload.provider === 'flow' ? 'generate' : payload.provider + '_run'}`,
      count: payload.quantity,
      owner: 'user',
      label: payload.prompt.slice(0, 50),
    });

    if (!gate.allowed) {
      return { success: false, error: gate.reason || 'Execution not allowed' };
    }

    // Submit to provider via content script
    const tabs = await chrome.tabs.query({ url: getProviderUrl(payload.provider) });
    if (tabs.length === 0) {
      // Open provider tab
      const tab = await chrome.tabs.create({ url: getProviderUrl(payload.provider), active: false });
      // Wait for tab to load, then inject
      return { success: true, pending: true, tabId: tab.id, executionToken: gate.token };
    }

    // Send to existing tab
    const targetTab = tabs[0];
    await chrome.tabs.sendMessage(targetTab.id!, {
      type: 'SUBMIT_PROMPT',
      payload: {
        ...payload,
        executionToken: gate.token,
      },
    });

    return { success: true, tabId: targetTab.id, executionToken: gate.token };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}

function getProviderUrl(provider: string): string {
  switch (provider) {
    case 'flow': return 'https://labs.google.com/fx/zh/*';
    case 'chatgpt': return 'https://chatgpt.com/*';
    case 'grok': return 'https://grok.com/*';
    case 'gemini': return 'https://gemini.google.com/*';
    default: return '';
  }
}

// ============ Batch Handlers ============
const batchQueues = new Map<string, {
  items: Array<{ id: string; prompt: string; status: string }>;
  current: number;
  paused: boolean;
  provider: string;
  model: string;
  ratio: string;
}>();

async function handleBatchStart(payload: {
  jobId: string;
  items: Array<{ id: string; prompt: string }>;
  provider: string;
  model: string;
  ratio: string;
}) {
  batchQueues.set(payload.jobId, {
    items: payload.items.map(i => ({ ...i, status: 'queued' })),
    current: 0,
    paused: false,
    provider: payload.provider,
    model: payload.model,
    ratio: payload.ratio,
  });
  processBatchQueue(payload.jobId);
  return { success: true };
}

async function processBatchQueue(jobId: string) {
  const queue = batchQueues.get(jobId);
  if (!queue || queue.paused) return;

  while (queue.current < queue.items.length && !queue.paused) {
    const item = queue.items[queue.current];
    item.status = 'submitting';

    // Notify sidepanel
    broadcastToSidepanel({
      type: 'BATCH_ITEM_UPDATE',
      payload: { jobId, itemId: item.id, status: 'submitting' },
    });

    try {
      await handleGenerateSubmit({
        prompt: item.prompt,
        provider: queue.provider,
        model: queue.model,
        mode: 'image',
        ratio: queue.ratio,
        quantity: 1,
        refImages: [],
      });
      item.status = 'monitoring';
      broadcastToSidepanel({
        type: 'BATCH_ITEM_UPDATE',
        payload: { jobId, itemId: item.id, status: 'monitoring' },
      });
    } catch {
      item.status = 'failed';
      broadcastToSidepanel({
        type: 'BATCH_ITEM_UPDATE',
        payload: { jobId, itemId: item.id, status: 'failed' },
      });
    }

    queue.current++;
    // Delay between items
    await new Promise(r => setTimeout(r, 2000));
  }
}

// ============ Workflow Handlers ============
async function handleWorkflowList() {
  try {
    const data = await apiGet('/workflows');
    return { success: true, workflows: data.workflows ?? [] };
  } catch {
    return { success: true, workflows: [] };
  }
}

async function handleWorkflowCreate(payload: { name: string; description: string }) {
  try {
    const data = await apiPost('/workflows', payload);
    return { success: true, workflow: data };
  } catch {
    return { success: false };
  }
}

// ============ History Handlers ============
async function handleHistoryGet(payload: { page: number; limit: number }) {
  try {
    const data = await apiGet(`/history?page=${payload.page}&limit=${payload.limit}`);
    return { success: true, records: data.records ?? [], has_more: data.has_more ?? false };
  } catch {
    return { success: true, records: [], has_more: false };
  }
}

// ============ Albums Handlers ============
async function handleAlbumsList() {
  try {
    const data = await apiGet('/albums');
    return { success: true, albums: data.albums ?? [] };
  } catch {
    return { success: true, albums: [] };
  }
}

async function handleAlbumsPhotos(payload: { albumId: string }) {
  try {
    const data = await apiGet(`/albums/${payload.albumId}/photos`);
    return { success: true, photos: data.photos ?? [] };
  } catch {
    return { success: true, photos: [] };
  }
}

async function handleAlbumsCreate(payload: { name: string }) {
  try {
    const data = await apiPost('/albums', { name: payload.name });
    return { success: true, album: data };
  } catch {
    return { success: false };
  }
}

// ============ Settings Handlers ============
async function handleSettingsGet() {
  try {
    const stored = await chrome.storage.local.get('settings');
    return { success: true, settings: stored.settings ?? {} };
  } catch {
    return { success: true, settings: {} };
  }
}

async function handleSettingsUpdate(payload: Record<string, unknown>) {
  try {
    const stored = await chrome.storage.local.get('settings');
    const settings = { ...(stored.settings ?? {}), ...payload };
    await chrome.storage.local.set({ settings });
    return { success: true };
  } catch {
    return { success: false };
  }
}

// ============ Telegram Handlers ============
async function handleTelegramConfig() {
  try {
    const data = await apiGet('/telegram/config');
    return { success: true, ...data };
  } catch {
    return { success: true, status: 'disconnected', commands: [], bot_username: '', chat_id: '' };
  }
}

// ============ Notifications Handlers ============
async function handleNotificationsList() {
  try {
    const stored = await chrome.storage.local.get('notifications');
    return { success: true, notifications: stored.notifications ?? [] };
  } catch {
    return { success: true, notifications: [] };
  }
}

// ============ SSE Connection ============
let sseConnection: EventSource | null = null;

function connectSSE() {
  if (!state.token || sseConnection) return;

  const url = `${API_BASE}/sse/connect?token=${state.token}`;
  sseConnection = new EventSource(url);

  sseConnection.onopen = () => {
    state.sseConnected = true;
    console.log('[TobyFlow] SSE connected');
  };

  sseConnection.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      handleSSEEvent(data);
    } catch { /* */ }
  };

  sseConnection.onerror = () => {
    state.sseConnected = false;
    sseConnection?.close();
    sseConnection = null;
    // Reconnect after delay
    setTimeout(connectSSE, 5000);
  };
}

function handleSSEEvent(data: { type: string; payload: unknown }) {
  switch (data.type) {
    case 'config_update':
      // Refresh entitlements
      apiGet('/auth/entitlements').then(ent => {
        state.entitlements = ent;
        broadcastToSidepanel({ type: 'ENTITLEMENTS_UPDATE', payload: ent });
      });
      break;
    case 'telegram_command':
      broadcastToSidepanel({ type: 'TELEGRAM_COMMAND', payload: data.payload });
      break;
    case 'notification':
      broadcastToSidepanel({ type: 'NOTIFICATION_NEW', payload: data.payload });
      break;
  }
}

// ============ Utilities ============
function broadcastToSidepanel(message: { type: string; payload?: unknown }) {
  chrome.runtime.sendMessage(message).catch(() => {
    // Sidepanel might not be open
  });
}

// ============ Message Router ============
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const { type, payload } = message;

  const handlers: Record<string, (p: unknown) => Promise<unknown>> = {
    'AUTH_LOGIN': (p) => handleLogin(p as { email: string; password: string }),
    'AUTH_LOGOUT': () => handleLogout(),
    'AUTH_CHECK': () => handleAuthCheck(),
    'GENERATE_SUBMIT': (p) => handleGenerateSubmit(p as Parameters<typeof handleGenerateSubmit>[0]),
    'BATCH_START': (p) => handleBatchStart(p as Parameters<typeof handleBatchStart>[0]),
    'BATCH_PAUSE': (p) => {
      const q = batchQueues.get((p as { jobId: string }).jobId);
      if (q) q.paused = true;
      return Promise.resolve({ success: true });
    },
    'BATCH_RESUME': (p) => {
      const q = batchQueues.get((p as { jobId: string }).jobId);
      if (q) { q.paused = false; processBatchQueue((p as { jobId: string }).jobId); }
      return Promise.resolve({ success: true });
    },
    'BATCH_CANCEL': (p) => {
      batchQueues.delete((p as { jobId: string }).jobId);
      return Promise.resolve({ success: true });
    },
    'WORKFLOW_LIST': () => handleWorkflowList(),
    'WORKFLOW_CREATE': (p) => handleWorkflowCreate(p as { name: string; description: string }),
    'WORKFLOW_RUN': (p) => apiPost('/workflows/run', p).then(() => ({ success: true })),
    'WORKFLOW_DELETE': (p) => apiPost('/workflows/delete', p).then(() => ({ success: true })),
    'WORKFLOW_OPEN_EDITOR': (p) => {
      const id = (p as { id: string }).id;
      chrome.windows.create({
        url: chrome.runtime.getURL(`src/editor-popup/index.html?id=${id}`),
        type: 'popup',
        width: 900,
        height: 600,
      });
      return Promise.resolve({ success: true });
    },
    'HISTORY_GET': (p) => handleHistoryGet(p as { page: number; limit: number }),
    'HISTORY_DELETE': (p) => apiPost('/history/delete', p).then(() => ({ success: true })),
    'HISTORY_CLEAR': () => apiPost('/history/clear', {}).then(() => ({ success: true })),
    'ALBUMS_LIST': () => handleAlbumsList(),
    'ALBUMS_PHOTOS': (p) => handleAlbumsPhotos(p as { albumId: string }),
    'ALBUMS_CREATE': (p) => handleAlbumsCreate(p as { name: string }),
    'ALBUMS_DELETE': (p) => apiPost('/albums/delete', p).then(() => ({ success: true })),
    'PHOTOS_DOWNLOAD': (p) => apiPost('/photos/download', p).then(() => ({ success: true })),
    'PHOTOS_DELETE': (p) => apiPost('/photos/delete', p).then(() => ({ success: true })),
    'SETTINGS_GET': () => handleSettingsGet(),
    'SETTINGS_UPDATE': (p) => handleSettingsUpdate(p as Record<string, unknown>),
    'TELEGRAM_CONFIG': () => handleTelegramConfig(),
    'TELEGRAM_CONNECT': (p) => apiPost('/telegram/connect', p).then(() => ({ success: true })),
    'TELEGRAM_DISCONNECT': () => apiPost('/telegram/disconnect', {}).then(() => ({ success: true })),
    'TELEGRAM_ADD_COMMAND': (p) => apiPost('/telegram/commands', p),
    'TELEGRAM_TOGGLE_COMMAND': (p) => apiPost('/telegram/commands/toggle', p).then(() => ({ success: true })),
    'TELEGRAM_DELETE_COMMAND': (p) => apiPost('/telegram/commands/delete', p).then(() => ({ success: true })),
    'NOTIFICATIONS_LIST': () => handleNotificationsList(),
    'NOTIFICATION_READ': (p) => {
      chrome.storage.local.get('notifications').then(stored => {
        const notifs = (stored.notifications ?? []) as Array<{ id: string; read: boolean }>;
        const n = notifs.find(n => n.id === (p as { id: string }).id);
        if (n) n.read = true;
        chrome.storage.local.set({ notifications: notifs });
      });
      return Promise.resolve({ success: true });
    },
    'NOTIFICATIONS_READ_ALL': () => {
      chrome.storage.local.get('notifications').then(stored => {
        const notifs = (stored.notifications ?? []) as Array<{ read: boolean }>;
        notifs.forEach(n => n.read = true);
        chrome.storage.local.set({ notifications: notifs });
      });
      return Promise.resolve({ success: true });
    },
    'NOTIFICATIONS_CLEAR': () => {
      chrome.storage.local.set({ notifications: [] });
      return Promise.resolve({ success: true });
    },
  };

  const handler = handlers[type];
  if (handler) {
    handler(payload).then(sendResponse).catch(err => {
      sendResponse({ success: false, error: err.message });
    });
    return true; // async response
  }

  return false;
});

// ============ SidePanel Behavior ============
chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {});

// ============ Extension Install ============
chrome.runtime.onInstalled.addListener(async (details) => {
  console.log(`[TobyFlow] Installed: ${details.reason}`);
  // Check for existing auth
  await handleAuthCheck();
  // Connect SSE if logged in
  if (state.token) {
    connectSSE();
  }
});

// ============ Startup ============
chrome.runtime.onStartup.addListener(async () => {
  await handleAuthCheck();
  if (state.token) connectSSE();
});

// ============ Tab Management for Providers ============
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  const url = tab.url ?? '';

  // Inject content scripts based on URL
  if (url.includes('labs.google.com/fx')) {
    chrome.scripting.executeScript({ target: { tabId }, files: ['src/content-scripts/flow/index.js'] }).catch(() => {});
  } else if (url.includes('chatgpt.com')) {
    chrome.scripting.executeScript({ target: { tabId }, files: ['src/content-scripts/chatgpt/index.js'] }).catch(() => {});
  } else if (url.includes('grok.com')) {
    chrome.scripting.executeScript({ target: { tabId }, files: ['src/content-scripts/grok/index.js'] }).catch(() => {});
  } else if (url.includes('gemini.google.com')) {
    chrome.scripting.executeScript({ target: { tabId }, files: ['src/content-scripts/gemini/index.js'] }).catch(() => {});
  }
});

console.log('[TobyFlow] Service Worker initialized');
