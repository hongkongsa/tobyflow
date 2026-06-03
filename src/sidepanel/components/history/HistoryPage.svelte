<script lang="ts">
  import { onMount } from 'svelte';
  import { historyStore } from '../../stores/history.store';

  onMount(() => { historyStore.load(); });

  function formatDate(dateStr: string) {
    return new Date(dateStr).toLocaleString();
  }
</script>

<div class="history-page">
  <div class="history-header">
    <h2>History</h2>
    {#if $historyStore.records.length > 0}
      <button class="clear-btn" onclick={() => historyStore.clearAll()}>Clear All</button>
    {/if}
  </div>

  <!-- Filters -->
  <div class="filters">
    <select class="filter-select" value={$historyStore.filter.provider} onchange={(e) => historyStore.setFilter('provider', (e.target as HTMLSelectElement).value)}>
      <option value="all">All Providers</option>
      <option value="flow">Flow</option>
      <option value="chatgpt">ChatGPT</option>
      <option value="grok">Grok</option>
      <option value="gemini">Gemini</option>
    </select>
    <select class="filter-select" value={$historyStore.filter.status} onchange={(e) => historyStore.setFilter('status', (e.target as HTMLSelectElement).value)}>
      <option value="all">All Status</option>
      <option value="success">Success</option>
      <option value="failed">Failed</option>
    </select>
    <input
      class="search-input"
      placeholder="Search prompts..."
      value={$historyStore.filter.search}
      oninput={(e) => historyStore.setFilter('search', (e.target as HTMLInputElement).value)}
    />
  </div>

  <!-- Records -->
  {#if $historyStore.isLoading && $historyStore.records.length === 0}
    <div class="loading">Loading history...</div>
  {:else if $historyStore.records.length === 0}
    <div class="empty-state">
      <p>No execution history</p>
      <p class="hint">Generated images will appear here</p>
    </div>
  {:else}
    <div class="records-list">
      {#each $historyStore.records as record}
        <div class="record-card">
          <div class="record-header">
            <span class="record-provider">{record.provider}</span>
            <span class="record-status" class:success={record.status === 'success'} class:failed={record.status === 'failed'}>
              {record.status}
            </span>
            <span class="record-date">{formatDate(record.created_at)}</span>
            <button class="delete-btn" onclick={() => historyStore.deleteRecord(record.id)}>×</button>
          </div>
          <p class="record-prompt">{record.prompt}</p>
          {#if record.results.length > 0}
            <div class="record-results">
              {#each record.results as url}
                <img src={url} alt="result" loading="lazy" />
              {/each}
            </div>
          {/if}
        </div>
      {/each}
    </div>
    {#if $historyStore.hasMore}
      <button class="load-more" onclick={() => historyStore.loadMore()} disabled={$historyStore.isLoading}>
        {$historyStore.isLoading ? 'Loading...' : 'Load More'}
      </button>
    {/if}
  {/if}
</div>

<style>
  .history-page { display: flex; flex-direction: column; gap: 12px; }
  .history-header { display: flex; justify-content: space-between; align-items: center; }
  .history-header h2 { margin: 0; font-size: 16px; }
  .clear-btn { padding: 4px 8px; border: 1px solid #dc2626; border-radius: 4px; background: transparent; color: #dc2626; font-size: 10px; cursor: pointer; }
  .filters { display: flex; gap: 6px; flex-wrap: wrap; }
  .filter-select { padding: 5px 8px; border: 1px solid var(--border, #2e2e33); border-radius: 4px; background: var(--bg-secondary, #27272a); color: var(--text-primary, #e4e4e7); font-size: 11px; }
  .search-input { flex: 1; min-width: 100px; padding: 5px 8px; border: 1px solid var(--border, #2e2e33); border-radius: 4px; background: var(--bg-secondary, #27272a); color: var(--text-primary, #e4e4e7); font-size: 11px; }
  .loading { text-align: center; color: var(--text-muted, #71717a); padding: 20px; font-size: 12px; }
  .empty-state { text-align: center; padding: 30px; color: var(--text-muted, #71717a); }
  .empty-state p { margin: 4px 0; }
  .hint { font-size: 11px; }
  .records-list { display: flex; flex-direction: column; gap: 8px; }
  .record-card { padding: 10px; background: var(--bg-secondary, #27272a); border-radius: 8px; }
  .record-header { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
  .record-provider { font-size: 10px; font-weight: 600; text-transform: uppercase; color: var(--accent, #6366f1); }
  .record-status { font-size: 10px; padding: 1px 5px; border-radius: 3px; }
  .record-status.success { background: #05966920; color: #34d399; }
  .record-status.failed { background: #dc262620; color: #fca5a5; }
  .record-date { flex: 1; font-size: 10px; color: var(--text-muted, #71717a); text-align: right; }
  .delete-btn { width: 18px; height: 18px; border: none; border-radius: 50%; background: transparent; color: var(--text-muted, #71717a); font-size: 14px; cursor: pointer; display: flex; align-items: center; justify-content: center; }
  .delete-btn:hover { color: #dc2626; }
  .record-prompt { margin: 0; font-size: 12px; color: var(--text-primary, #e4e4e7); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .record-results { display: flex; gap: 4px; margin-top: 6px; overflow-x: auto; }
  .record-results img { width: 48px; height: 48px; border-radius: 4px; object-fit: cover; }
  .load-more { padding: 8px; border: 1px solid var(--border, #2e2e33); border-radius: 5px; background: transparent; color: var(--text-primary, #e4e4e7); font-size: 12px; cursor: pointer; }
  .load-more:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
