<script lang="ts">
  import { onMount } from 'svelte';
  import { uiStore, type TabId } from './stores/ui.store';
  import { authStore } from './stores/auth.store';
  import { generateStore } from './stores/generate.store';
  import { batchStore } from './stores/batch.store';
  import { notificationsStore } from './stores/notifications.store';
  import GeneratePage from './components/generate/GeneratePage.svelte';
  import BatchPage from './components/batch/BatchPage.svelte';
  import WorkflowPage from './components/workflow/WorkflowPage.svelte';
  import HistoryPage from './components/history/HistoryPage.svelte';
  import AlbumsPage from './components/albums/AlbumsPage.svelte';
  import TelegramPage from './components/telegram/TelegramPage.svelte';
  import NotificationsPage from './components/notifications/NotificationsPage.svelte';
  import SettingsPage from './components/settings/SettingsPage.svelte';

  const tabs: { id: TabId; label: string; icon: string }[] = [
    { id: 'generate', label: 'Generate', icon: '🎨' },
    { id: 'batch', label: 'Batch', icon: '📦' },
    { id: 'workflow', label: 'Workflow', icon: '🔀' },
    { id: 'history', label: 'History', icon: '📋' },
    { id: 'albums', label: 'Albums', icon: '🖼️' },
    { id: 'telegram', label: 'Telegram', icon: '📱' },
    { id: 'notifications', label: 'Notifications', icon: '🔔' },
    { id: 'settings', label: 'Settings', icon: '⚙️' },
  ];

  onMount(() => {
    authStore.checkSession();
    uiStore.loadSettings();

    const listener = (message: { type: string; payload?: any }) => {
      switch (message.type) {
        case 'GENERATE_RESULT':
          if (message.payload) {
            generateStore.addResult({
              id: crypto.randomUUID(),
              url: message.payload.url,
              prompt: message.payload.prompt || '',
              provider: message.payload.provider || 'flow',
              timestamp: Date.now(),
            });
          }
          break;
        case 'GENERATE_COMPLETE':
          generateStore.setDone();
          break;
        case 'BATCH_ITEM_UPDATE':
          if (message.payload) {
            batchStore.updateItem(
              message.payload.jobId,
              message.payload.itemId,
              message.payload.status,
              message.payload.result,
            );
          }
          break;
        case 'NOTIFICATION':
          if (message.payload) {
            notificationsStore.addNotification(message.payload);
          }
          break;
      }
    };
    chrome.runtime?.onMessage?.addListener(listener);
    return () => chrome.runtime?.onMessage?.removeListener(listener);
  });
</script>

<div class="app" data-theme={$uiStore.theme}>
  <!-- Header -->
  <header class="app-header">
    <h1 class="app-title">TobyFlow</h1>
    <span class="app-version">v2.0.0</span>
    {#if $authStore.isLoggedIn}
      <span class="user-badge">{$authStore.user?.name?.[0] ?? '?'}</span>
    {/if}
  </header>

  <!-- Tab Navigation -->
  <nav class="tab-nav">
    {#each tabs as tab}
      <button
        class="tab-btn"
        class:active={$uiStore.currentTab === tab.id}
        onclick={() => uiStore.setTab(tab.id)}
        title={tab.label}
      >
        <span class="tab-icon">{tab.icon}</span>
        <span class="tab-label">{tab.label}</span>
      </button>
    {/each}
  </nav>

  <!-- Tab Content -->
  <main class="tab-content">
    {#if $uiStore.currentTab === 'generate'}
      <GeneratePage />
    {:else if $uiStore.currentTab === 'batch'}
      <BatchPage />
    {:else if $uiStore.currentTab === 'workflow'}
      <WorkflowPage />
    {:else if $uiStore.currentTab === 'history'}
      <HistoryPage />
    {:else if $uiStore.currentTab === 'albums'}
      <AlbumsPage />
    {:else if $uiStore.currentTab === 'telegram'}
      <TelegramPage />
    {:else if $uiStore.currentTab === 'notifications'}
      <NotificationsPage />
    {:else if $uiStore.currentTab === 'settings'}
      <SettingsPage />
    {/if}
  </main>

  <!-- Toast Container -->
  {#if $uiStore.toasts.length > 0}
    <div class="toast-container">
      {#each $uiStore.toasts as toast}
        <div class="toast toast-{toast.type}" role="alert" onclick={() => uiStore.dismissToast(toast.id)}>
          {toast.message}
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .app {
    display: flex;
    flex-direction: column;
    height: 100vh;
    background: var(--bg-primary, #1a1a1e);
    color: var(--text-primary, #e4e4e7);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  }

  .app[data-theme="light"] {
    --bg-primary: #ffffff;
    --bg-secondary: #f4f4f5;
    --bg-tertiary: #e4e4e7;
    --text-primary: #18181b;
    --text-muted: #71717a;
    --border: #d4d4d8;
    --accent: #6366f1;
  }

  .app-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 14px;
    border-bottom: 1px solid var(--border, #2e2e33);
  }

  .app-title {
    font-size: 15px;
    font-weight: 700;
    margin: 0;
    background: linear-gradient(135deg, #6366f1, #8b5cf6);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
  }

  .app-version {
    font-size: 10px;
    color: var(--text-muted, #71717a);
    background: var(--bg-secondary, #27272a);
    padding: 2px 5px;
    border-radius: 3px;
  }

  .user-badge {
    margin-left: auto;
    width: 24px;
    height: 24px;
    border-radius: 50%;
    background: var(--accent, #6366f1);
    color: white;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 11px;
    font-weight: 600;
  }

  .tab-nav {
    display: flex;
    overflow-x: auto;
    padding: 6px 10px;
    gap: 3px;
    border-bottom: 1px solid var(--border, #2e2e33);
    scrollbar-width: none;
  }
  .tab-nav::-webkit-scrollbar { display: none; }

  .tab-btn {
    display: flex;
    align-items: center;
    gap: 3px;
    padding: 5px 8px;
    border: none;
    border-radius: 5px;
    background: transparent;
    color: var(--text-muted, #71717a);
    font-size: 11px;
    cursor: pointer;
    white-space: nowrap;
    transition: all 0.15s;
  }

  .tab-btn:hover {
    background: var(--bg-secondary, #27272a);
    color: var(--text-primary, #e4e4e7);
  }

  .tab-btn.active {
    background: var(--accent, #6366f1);
    color: white;
  }

  .tab-icon { font-size: 12px; }
  .tab-label { font-size: 10px; font-weight: 500; }

  .tab-content {
    flex: 1;
    overflow-y: auto;
    padding: 14px;
  }

  .toast-container {
    position: fixed;
    bottom: 16px;
    left: 16px;
    right: 16px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    z-index: 1000;
  }

  .toast {
    padding: 10px 14px;
    border-radius: 8px;
    font-size: 12px;
    cursor: pointer;
    animation: slideUp 0.2s ease;
  }
  .toast-success { background: #059669; color: white; }
  .toast-error { background: #dc2626; color: white; }
  .toast-warning { background: #d97706; color: white; }
  .toast-info { background: #6366f1; color: white; }

  @keyframes slideUp {
    from { transform: translateY(10px); opacity: 0; }
    to { transform: translateY(0); opacity: 1; }
  }
</style>
