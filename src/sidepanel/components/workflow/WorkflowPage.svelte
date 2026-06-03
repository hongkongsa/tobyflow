<script lang="ts">
  import { onMount } from 'svelte';
  import { workflowStore } from '../../stores/workflow.store';

  let showCreate = false;
  let newName = '';
  let newDesc = '';

  onMount(() => { workflowStore.load(); });

  function handleCreate() {
    if (!newName.trim()) return;
    workflowStore.create(newName, newDesc);
    newName = '';
    newDesc = '';
    showCreate = false;
  }
</script>

<div class="workflow-page">
  <div class="workflow-header">
    <h2>Workflows</h2>
    <button class="new-btn" onclick={() => showCreate = !showCreate}>
      {showCreate ? '✕ Cancel' : '+ New'}
    </button>
  </div>

  {#if showCreate}
    <div class="create-form">
      <input class="input-field" placeholder="Workflow name" bind:value={newName} />
      <input class="input-field" placeholder="Description (optional)" bind:value={newDesc} />
      <button class="create-btn" onclick={handleCreate}>Create Workflow</button>
    </div>
  {/if}

  {#if $workflowStore.isLoading}
    <div class="loading">Loading workflows...</div>
  {:else if $workflowStore.workflows.length === 0}
    <div class="empty-state">
      <p>No workflows yet</p>
      <p class="hint">Create a workflow to automate multi-step generation pipelines</p>
    </div>
  {:else}
    <div class="workflow-list">
      {#each $workflowStore.workflows as wf}
        <div class="workflow-card">
          <div class="wf-info">
            <span class="wf-name">{wf.name}</span>
            <span class="wf-desc">{wf.description}</span>
            <span class="wf-meta">{wf.nodes} nodes · {wf.status}</span>
          </div>
          <div class="wf-actions">
            <button class="action-btn" onclick={() => workflowStore.openEditor(wf.id)} title="Edit">✏️</button>
            <button class="action-btn" onclick={() => workflowStore.run(wf.id)} title="Run" disabled={wf.status === 'running'}>▶️</button>
            <button class="action-btn danger" onclick={() => workflowStore.deleteWorkflow(wf.id)} title="Delete">🗑️</button>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .workflow-page { display: flex; flex-direction: column; gap: 12px; }
  .workflow-header { display: flex; justify-content: space-between; align-items: center; }
  .workflow-header h2 { margin: 0; font-size: 16px; }
  .new-btn { padding: 5px 10px; border: 1px solid var(--accent, #6366f1); border-radius: 5px; background: transparent; color: var(--accent, #6366f1); font-size: 11px; cursor: pointer; }
  .create-form { display: flex; flex-direction: column; gap: 8px; padding: 12px; background: var(--bg-secondary, #27272a); border-radius: 8px; }
  .input-field { padding: 8px; border: 1px solid var(--border, #2e2e33); border-radius: 5px; background: var(--bg-primary, #1a1a1e); color: var(--text-primary, #e4e4e7); font-size: 12px; }
  .create-btn { padding: 8px; border: none; border-radius: 5px; background: var(--accent, #6366f1); color: white; font-size: 12px; cursor: pointer; }
  .loading { text-align: center; color: var(--text-muted, #71717a); padding: 20px; font-size: 12px; }
  .empty-state { text-align: center; padding: 30px; color: var(--text-muted, #71717a); }
  .empty-state p { margin: 4px 0; }
  .hint { font-size: 11px; }
  .workflow-list { display: flex; flex-direction: column; gap: 8px; }
  .workflow-card { display: flex; align-items: center; padding: 10px; background: var(--bg-secondary, #27272a); border-radius: 8px; }
  .wf-info { flex: 1; display: flex; flex-direction: column; gap: 2px; }
  .wf-name { font-size: 13px; font-weight: 500; }
  .wf-desc { font-size: 11px; color: var(--text-muted, #71717a); }
  .wf-meta { font-size: 10px; color: var(--text-muted, #71717a); }
  .wf-actions { display: flex; gap: 4px; }
  .action-btn { width: 28px; height: 28px; border: 1px solid var(--border, #2e2e33); border-radius: 5px; background: transparent; font-size: 12px; cursor: pointer; display: flex; align-items: center; justify-content: center; }
  .action-btn:hover { background: var(--bg-tertiary, #3f3f46); }
  .action-btn.danger:hover { border-color: #dc2626; }
  .action-btn:disabled { opacity: 0.4; cursor: not-allowed; }
</style>
