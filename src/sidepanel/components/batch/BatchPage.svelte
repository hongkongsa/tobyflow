<script lang="ts">
  import { batchStore } from '../../stores/batch.store';
  import { generateStore } from '../../stores/generate.store';

  let showCreateForm = false;
  let jobName = '';

  function createBatch() {
    const prompts = $batchStore.inputText.split('\n').filter(p => p.trim());
    if (prompts.length === 0) return;
    batchStore.createJob(jobName, prompts, $generateStore.provider, $generateStore.model, $generateStore.ratio);
    jobName = '';
    showCreateForm = false;
  }

  function getStatusColor(status: string) {
    const colors: Record<string, string> = {
      pending: '#71717a', running: '#6366f1', paused: '#d97706',
      completed: '#059669', cancelled: '#dc2626', failed: '#dc2626',
    };
    return colors[status] || '#71717a';
  }
</script>

<div class="batch-page">
  <div class="batch-header">
    <h2>Batch Queue</h2>
    <button class="new-batch-btn" onclick={() => showCreateForm = !showCreateForm}>
      {showCreateForm ? '✕ Cancel' : '+ New Batch'}
    </button>
  </div>

  {#if showCreateForm}
    <div class="create-form">
      <input class="input-field" placeholder="Batch name (optional)" bind:value={jobName} />
      <textarea
        class="prompt-textarea"
        placeholder="Enter prompts (one per line)..."
        value={$batchStore.inputText}
        oninput={(e) => batchStore.setInputText((e.target as HTMLTextAreaElement).value)}
        rows="6"
      ></textarea>
      <div class="form-footer">
        <span class="prompt-count">
          {$batchStore.inputText.split('\n').filter(p => p.trim()).length} prompts
        </span>
        <button class="create-btn" onclick={createBatch}>Create & Queue</button>
      </div>
    </div>
  {/if}

  <!-- Job List -->
  <div class="job-list">
    {#if $batchStore.jobs.length === 0}
      <div class="empty-state">
        <p>No batch jobs yet</p>
        <p class="hint">Create a batch to process multiple prompts automatically</p>
      </div>
    {:else}
      {#each $batchStore.jobs as job}
        <div class="job-card" onclick={() => batchStore.setActiveJob(job.id === $batchStore.activeJobId ? null : job.id)}>
          <div class="job-header">
            <span class="job-status" style="color: {getStatusColor(job.status)}">{job.status}</span>
            <span class="job-name">{job.name}</span>
            <span class="job-items">{job.items.length} items</span>
          </div>
          <div class="job-progress">
            <div class="progress-bar">
              <div class="progress-fill" style="width: {job.progress}%"></div>
            </div>
            <span class="progress-text">{job.progress}%</span>
          </div>
          <!-- Controls -->
          <div class="job-controls">
            {#if job.status === 'pending'}
              <button class="ctrl-btn start" onclick={(e) => { e.stopPropagation(); batchStore.startJob(job.id); }}>▶ Start</button>
            {:else if job.status === 'running'}
              <button class="ctrl-btn pause" onclick={(e) => { e.stopPropagation(); batchStore.pauseJob(job.id); }}>⏸ Pause</button>
              <button class="ctrl-btn cancel" onclick={(e) => { e.stopPropagation(); batchStore.cancelJob(job.id); }}>⊘ Stop</button>
            {:else if job.status === 'paused'}
              <button class="ctrl-btn start" onclick={(e) => { e.stopPropagation(); batchStore.resumeJob(job.id); }}>▶ Resume</button>
              <button class="ctrl-btn cancel" onclick={(e) => { e.stopPropagation(); batchStore.cancelJob(job.id); }}>⊘ Stop</button>
            {/if}
            {#if job.status === 'completed' || job.status === 'cancelled' || job.status === 'failed'}
              <button class="ctrl-btn delete" onclick={(e) => { e.stopPropagation(); batchStore.deleteJob(job.id); }}>🗑 Delete</button>
            {/if}
          </div>

          <!-- Expanded items -->
          {#if $batchStore.activeJobId === job.id}
            <div class="job-items-list">
              {#each job.items as item}
                <div class="item-row" class:completed={item.status === 'completed'} class:failed={item.status === 'failed'}>
                  <span class="item-status-dot" style="background: {getStatusColor(item.status)}"></span>
                  <span class="item-prompt">{item.prompt}</span>
                </div>
              {/each}
            </div>
          {/if}
        </div>
      {/each}
    {/if}
  </div>
</div>

<style>
  .batch-page { display: flex; flex-direction: column; gap: 12px; }
  .batch-header { display: flex; justify-content: space-between; align-items: center; }
  .batch-header h2 { margin: 0; font-size: 16px; }
  .new-batch-btn { padding: 5px 10px; border: 1px solid var(--accent, #6366f1); border-radius: 5px; background: transparent; color: var(--accent, #6366f1); font-size: 11px; cursor: pointer; }
  .create-form { display: flex; flex-direction: column; gap: 8px; padding: 12px; background: var(--bg-secondary, #27272a); border-radius: 8px; }
  .input-field { padding: 8px; border: 1px solid var(--border, #2e2e33); border-radius: 5px; background: var(--bg-primary, #1a1a1e); color: var(--text-primary, #e4e4e7); font-size: 12px; }
  .prompt-textarea { padding: 8px; border: 1px solid var(--border, #2e2e33); border-radius: 5px; background: var(--bg-primary, #1a1a1e); color: var(--text-primary, #e4e4e7); font-size: 12px; resize: vertical; font-family: inherit; }
  .form-footer { display: flex; justify-content: space-between; align-items: center; }
  .prompt-count { font-size: 11px; color: var(--text-muted, #71717a); }
  .create-btn { padding: 7px 14px; border: none; border-radius: 5px; background: var(--accent, #6366f1); color: white; font-size: 12px; cursor: pointer; }
  .job-list { display: flex; flex-direction: column; gap: 8px; }
  .empty-state { text-align: center; padding: 30px; color: var(--text-muted, #71717a); }
  .empty-state p { margin: 4px 0; }
  .hint { font-size: 11px; }
  .job-card { padding: 10px; background: var(--bg-secondary, #27272a); border-radius: 8px; cursor: pointer; transition: background 0.15s; }
  .job-card:hover { background: var(--bg-tertiary, #3f3f46); }
  .job-header { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
  .job-status { font-size: 10px; font-weight: 600; text-transform: uppercase; }
  .job-name { flex: 1; font-size: 12px; font-weight: 500; }
  .job-items { font-size: 10px; color: var(--text-muted, #71717a); }
  .job-progress { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
  .progress-bar { flex: 1; height: 3px; background: var(--bg-tertiary, #3f3f46); border-radius: 2px; overflow: hidden; }
  .progress-fill { height: 100%; background: var(--accent, #6366f1); transition: width 0.3s; }
  .progress-text { font-size: 10px; color: var(--text-muted, #71717a); }
  .job-controls { display: flex; gap: 4px; }
  .ctrl-btn { padding: 3px 8px; border: 1px solid var(--border, #2e2e33); border-radius: 4px; background: transparent; color: var(--text-primary, #e4e4e7); font-size: 10px; cursor: pointer; }
  .ctrl-btn.start { border-color: #059669; color: #059669; }
  .ctrl-btn.pause { border-color: #d97706; color: #d97706; }
  .ctrl-btn.cancel { border-color: #dc2626; color: #dc2626; }
  .ctrl-btn.delete { border-color: #dc2626; color: #dc2626; }
  .job-items-list { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--border, #2e2e33); display: flex; flex-direction: column; gap: 3px; }
  .item-row { display: flex; align-items: center; gap: 6px; font-size: 11px; padding: 3px 0; }
  .item-status-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
  .item-prompt { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .item-row.completed { opacity: 0.6; }
  .item-row.failed { color: #fca5a5; }
</style>
