<script lang="ts">
  // TODO: Import stores, components, i18n
  let currentTab = $state('generate');
  
  const tabs = [
    { id: 'generate', label: 'Generate', icon: '🎨' },
    { id: 'batch', label: 'Batch', icon: '📦' },
    { id: 'workflow', label: 'Workflow', icon: '🔀' },
    { id: 'history', label: 'History', icon: '📋' },
    { id: 'albums', label: 'Albums', icon: '🖼️' },
    { id: 'telegram', label: 'Telegram', icon: '📱' },
    { id: 'notifications', label: 'Notifications', icon: '🔔' },
    { id: 'settings', label: 'Settings', icon: '⚙️' },
  ];
</script>

<div class="app" data-theme="dark">
  <!-- Header -->
  <header class="app-header">
    <h1 class="app-title">TobyFlow</h1>
    <span class="app-version">v2.0.0</span>
  </header>

  <!-- Tab Navigation -->
  <nav class="tab-nav">
    {#each tabs as tab}
      <button
        class="tab-btn"
        class:active={currentTab === tab.id}
        onclick={() => currentTab = tab.id}
        title={tab.label}
      >
        <span class="tab-icon">{tab.icon}</span>
        <span class="tab-label">{tab.label}</span>
      </button>
    {/each}
  </nav>

  <!-- Tab Content -->
  <main class="tab-content">
    {#if currentTab === 'generate'}
      <div class="page">
        <h2>Generate</h2>
        <p>Multi-provider image/video generation</p>
        <!-- TODO: GeneratePage component -->
      </div>
    {:else if currentTab === 'batch'}
      <div class="page">
        <h2>Batch Queue</h2>
        <p>Bulk prompt processing</p>
      </div>
    {:else if currentTab === 'workflow'}
      <div class="page">
        <h2>Workflows</h2>
        <p>Visual node-based automation</p>
      </div>
    {:else if currentTab === 'history'}
      <div class="page">
        <h2>History</h2>
        <p>Execution history & stats</p>
      </div>
    {:else if currentTab === 'settings'}
      <div class="page">
        <h2>Settings</h2>
        <p>Configuration & preferences</p>
      </div>
    {:else}
      <div class="page">
        <h2>{tabs.find(t => t.id === currentTab)?.label}</h2>
        <p>Coming soon...</p>
      </div>
    {/if}
  </main>
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

  .app-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border, #2e2e33);
  }

  .app-title {
    font-size: 16px;
    font-weight: 600;
    margin: 0;
  }

  .app-version {
    font-size: 11px;
    color: var(--text-muted, #71717a);
    background: var(--bg-secondary, #27272a);
    padding: 2px 6px;
    border-radius: 4px;
  }

  .tab-nav {
    display: flex;
    overflow-x: auto;
    padding: 8px 12px;
    gap: 4px;
    border-bottom: 1px solid var(--border, #2e2e33);
  }

  .tab-btn {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 6px 10px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--text-muted, #71717a);
    font-size: 12px;
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

  .tab-icon {
    font-size: 14px;
  }

  .tab-label {
    font-size: 11px;
  }

  .tab-content {
    flex: 1;
    overflow-y: auto;
    padding: 16px;
  }

  .page h2 {
    font-size: 18px;
    margin: 0 0 8px 0;
  }

  .page p {
    color: var(--text-muted, #71717a);
    font-size: 13px;
    margin: 0;
  }
</style>
