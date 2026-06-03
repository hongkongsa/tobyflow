<script lang="ts">
  import { onMount } from 'svelte';
  import { notificationsStore, unreadCount } from '../../stores/notifications.store';

  onMount(() => { notificationsStore.load(); });

  function formatTime(ts: number) {
    const diff = Date.now() - ts;
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return new Date(ts).toLocaleDateString();
  }

  function getTypeIcon(type: string) {
    const icons: Record<string, string> = {
      success: '✅', error: '❌', info: 'ℹ️', warning: '⚠️', system: '🔔',
    };
    return icons[type] || '📌';
  }
</script>

<div class="notifications-page">
  <div class="notif-header">
    <h2>Notifications</h2>
    {#if $unreadCount > 0}
      <span class="unread-badge">{$unreadCount}</span>
    {/if}
    <div class="notif-actions">
      <button class="action-btn" onclick={() => notificationsStore.markAllRead()}>Mark All Read</button>
      <button class="action-btn danger" onclick={() => notificationsStore.clearAll()}>Clear</button>
    </div>
  </div>

  {#if $notificationsStore.isLoading}
    <div class="loading">Loading...</div>
  {:else if $notificationsStore.notifications.length === 0}
    <div class="empty-state">
      <p>No notifications</p>
      <p class="hint">You'll see updates about your generations here</p>
    </div>
  {:else}
    <div class="notification-list">
      {#each $notificationsStore.notifications as notif}
        <div
          class="notif-card"
          class:unread={!notif.read}
          onclick={() => notificationsStore.markRead(notif.id)}
        >
          <span class="notif-icon">{getTypeIcon(notif.type)}</span>
          <div class="notif-content">
            <span class="notif-title">{notif.title}</span>
            <span class="notif-message">{notif.message}</span>
            <span class="notif-time">{formatTime(notif.timestamp)}</span>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .notifications-page { display: flex; flex-direction: column; gap: 12px; }
  .notif-header { display: flex; align-items: center; gap: 8px; }
  .notif-header h2 { margin: 0; font-size: 16px; }
  .unread-badge { padding: 1px 6px; background: #dc2626; color: white; border-radius: 10px; font-size: 10px; font-weight: 600; }
  .notif-actions { margin-left: auto; display: flex; gap: 4px; }
  .action-btn { padding: 4px 8px; border: 1px solid var(--border, #2e2e33); border-radius: 4px; background: transparent; color: var(--text-muted, #71717a); font-size: 10px; cursor: pointer; }
  .action-btn.danger { border-color: #dc2626; color: #dc2626; }
  .loading { text-align: center; color: var(--text-muted, #71717a); padding: 20px; font-size: 12px; }
  .empty-state { text-align: center; padding: 30px; color: var(--text-muted, #71717a); }
  .empty-state p { margin: 4px 0; }
  .hint { font-size: 11px; }
  .notification-list { display: flex; flex-direction: column; gap: 4px; }
  .notif-card { display: flex; gap: 8px; padding: 10px; background: var(--bg-secondary, #27272a); border-radius: 8px; cursor: pointer; transition: background 0.15s; }
  .notif-card:hover { background: var(--bg-tertiary, #3f3f46); }
  .notif-card.unread { border-left: 3px solid var(--accent, #6366f1); }
  .notif-icon { font-size: 14px; }
  .notif-content { flex: 1; display: flex; flex-direction: column; gap: 2px; }
  .notif-title { font-size: 12px; font-weight: 500; }
  .notif-message { font-size: 11px; color: var(--text-muted, #71717a); }
  .notif-time { font-size: 9px; color: var(--text-muted, #71717a); }
</style>
