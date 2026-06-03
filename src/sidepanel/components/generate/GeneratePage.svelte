<script lang="ts">
  import { generateStore } from '../../stores/generate.store';
  import type { ProviderKey } from '@shared/types/provider.types';

  const providers: { id: ProviderKey; name: string; icon: string }[] = [
    { id: 'flow', name: 'Flow', icon: '🌊' },
    { id: 'chatgpt', name: 'ChatGPT', icon: '🤖' },
    { id: 'grok', name: 'Grok', icon: '⚡' },
    { id: 'gemini', name: 'Gemini', icon: '💎' },
  ];

  const ratios = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'];
  const quantities = [1, 2, 4, 8];

  function handleGenerate() {
    generateStore.generate();
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      handleGenerate();
    }
  }

  function handleFileSelect(e: Event) {
    const input = e.target as HTMLInputElement;
    if (!input.files) return;
    for (const file of input.files) {
      generateStore.addRefImage(file);
    }
    input.value = '';
  }
</script>

<div class="generate-page">
  <!-- Provider Selector -->
  <div class="provider-bar">
    {#each providers as p}
      <button
        class="provider-btn"
        class:active={$generateStore.provider === p.id}
        onclick={() => generateStore.setProvider(p.id)}
        title={p.name}
      >
        <span class="provider-icon">{p.icon}</span>
        <span class="provider-name">{p.name}</span>
      </button>
    {/each}
  </div>

  <!-- Prompt Input -->
  <div class="prompt-section">
    <textarea
      class="prompt-input"
      placeholder="Describe what you want to generate... (Ctrl+Enter to submit)"
      value={$generateStore.prompt}
      oninput={(e) => generateStore.setPrompt((e.target as HTMLTextAreaElement).value)}
      onkeydown={handleKeyDown}
      disabled={$generateStore.status === 'submitting' || $generateStore.status === 'monitoring'}
    ></textarea>
  </div>

  <!-- Settings Row -->
  <div class="settings-row">
    <!-- Ratio -->
    <div class="setting-group">
      <span class="setting-label">Ratio</span>
      <div class="ratio-options">
        {#each ratios as r}
          <button
            class="option-btn"
            class:active={$generateStore.ratio === r}
            onclick={() => generateStore.setRatio(r)}
          >{r}</button>
        {/each}
      </div>
    </div>

    <!-- Quantity -->
    <div class="setting-group">
      <span class="setting-label">Quantity</span>
      <div class="quantity-options">
        {#each quantities as q}
          <button
            class="option-btn"
            class:active={$generateStore.quantity === q}
            onclick={() => generateStore.setQuantity(q)}
          >{q}</button>
        {/each}
      </div>
    </div>
  </div>

  <!-- Reference Images -->
  {#if $generateStore.refImages.length > 0}
    <div class="ref-images">
      <span class="setting-label">References</span>
      <div class="ref-grid">
        {#each $generateStore.refImages as ref}
          <div class="ref-thumb">
            <img src={ref.preview} alt={ref.name} />
            <button class="ref-remove" onclick={() => generateStore.removeRefImage(ref.id)}>×</button>
          </div>
        {/each}
      </div>
    </div>
  {/if}

  <!-- Action Row -->
  <div class="action-row">
    <label class="upload-btn">
      📎 Ref
      <input type="file" accept="image/*" multiple onchange={handleFileSelect} hidden />
    </label>
    <button
      class="generate-btn"
      onclick={handleGenerate}
      disabled={!$generateStore.prompt.trim() || $generateStore.status === 'submitting' || $generateStore.status === 'monitoring'}
    >
      {#if $generateStore.status === 'submitting'}
        Submitting...
      {:else if $generateStore.status === 'monitoring'}
        Generating...
      {:else}
        Generate
      {/if}
    </button>
  </div>

  <!-- Progress -->
  {#if $generateStore.status === 'monitoring' || $generateStore.status === 'done'}
    <div class="progress-section">
      <div class="progress-bar">
        <div class="progress-fill" style="width: {$generateStore.progress}%"></div>
      </div>
      <span class="progress-text">{Math.round($generateStore.progress)}%</span>
    </div>
  {/if}

  <!-- Error -->
  {#if $generateStore.error}
    <div class="error-msg">{$generateStore.error}</div>
  {/if}

  <!-- Results Grid -->
  {#if $generateStore.results.length > 0}
    <div class="results-section">
      <div class="results-header">
        <h3>Results ({$generateStore.results.length})</h3>
        <button class="clear-btn" onclick={() => generateStore.clearResults()}>Clear</button>
      </div>
      <div class="results-grid">
        {#each $generateStore.results as result}
          <div class="result-card">
            <img src={result.url} alt={result.prompt} loading="lazy" />
          </div>
        {/each}
      </div>
    </div>
  {/if}
</div>

<style>
  .generate-page { display: flex; flex-direction: column; gap: 12px; }

  .provider-bar { display: flex; gap: 4px; flex-wrap: wrap; }
  .provider-btn {
    display: flex; align-items: center; gap: 4px;
    padding: 6px 10px; border: 1px solid var(--border, #2e2e33);
    border-radius: 6px; background: var(--bg-secondary, #27272a);
    color: var(--text-muted, #71717a); font-size: 11px; cursor: pointer;
    transition: all 0.15s;
  }
  .provider-btn:hover { border-color: var(--accent, #6366f1); color: var(--text-primary, #e4e4e7); }
  .provider-btn.active { background: var(--accent, #6366f1); color: white; border-color: var(--accent, #6366f1); }
  .provider-icon { font-size: 14px; }
  .provider-name { font-weight: 500; }

  .prompt-input {
    width: 100%; min-height: 80px; padding: 10px;
    border: 1px solid var(--border, #2e2e33); border-radius: 8px;
    background: var(--bg-secondary, #27272a); color: var(--text-primary, #e4e4e7);
    font-size: 13px; resize: vertical; font-family: inherit;
  }
  .prompt-input:focus { outline: none; border-color: var(--accent, #6366f1); }
  .prompt-input:disabled { opacity: 0.6; }

  .settings-row { display: flex; gap: 12px; flex-wrap: wrap; }
  .setting-group { display: flex; flex-direction: column; gap: 4px; }
  .setting-label { font-size: 10px; color: var(--text-muted, #71717a); font-weight: 600; text-transform: uppercase; }
  .ratio-options, .quantity-options { display: flex; gap: 3px; flex-wrap: wrap; }
  .option-btn {
    padding: 3px 7px; border: 1px solid var(--border, #2e2e33);
    border-radius: 4px; background: transparent;
    color: var(--text-muted, #71717a); font-size: 10px; cursor: pointer;
  }
  .option-btn:hover { border-color: var(--accent, #6366f1); }
  .option-btn.active { background: var(--accent, #6366f1); color: white; border-color: var(--accent, #6366f1); }

  .ref-images { display: flex; flex-direction: column; gap: 6px; }
  .ref-grid { display: flex; gap: 6px; flex-wrap: wrap; }
  .ref-thumb { position: relative; width: 48px; height: 48px; border-radius: 6px; overflow: hidden; }
  .ref-thumb img { width: 100%; height: 100%; object-fit: cover; }
  .ref-remove {
    position: absolute; top: 1px; right: 1px;
    width: 16px; height: 16px; border: none; border-radius: 50%;
    background: rgba(0,0,0,0.7); color: white; font-size: 10px;
    cursor: pointer; display: flex; align-items: center; justify-content: center;
  }

  .action-row { display: flex; gap: 8px; align-items: center; }
  .upload-btn {
    padding: 7px 12px; border: 1px solid var(--border, #2e2e33);
    border-radius: 6px; font-size: 11px; cursor: pointer;
    color: var(--text-muted, #71717a); background: var(--bg-secondary, #27272a);
  }
  .generate-btn {
    flex: 1; padding: 10px; border: none; border-radius: 8px;
    background: linear-gradient(135deg, #6366f1, #8b5cf6);
    color: white; font-size: 13px; font-weight: 600; cursor: pointer;
    transition: opacity 0.15s;
  }
  .generate-btn:hover { opacity: 0.9; }
  .generate-btn:disabled { opacity: 0.5; cursor: not-allowed; }

  .progress-section { display: flex; align-items: center; gap: 8px; }
  .progress-bar { flex: 1; height: 4px; background: var(--bg-tertiary, #3f3f46); border-radius: 2px; overflow: hidden; }
  .progress-fill { height: 100%; background: var(--accent, #6366f1); transition: width 0.3s; }
  .progress-text { font-size: 11px; color: var(--text-muted, #71717a); }

  .error-msg { padding: 8px 12px; background: #dc262620; border: 1px solid #dc2626; border-radius: 6px; color: #fca5a5; font-size: 12px; }

  .results-section { display: flex; flex-direction: column; gap: 8px; }
  .results-header { display: flex; justify-content: space-between; align-items: center; }
  .results-header h3 { margin: 0; font-size: 13px; }
  .clear-btn { border: none; background: none; color: var(--text-muted, #71717a); font-size: 11px; cursor: pointer; }
  .results-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
  .result-card { border-radius: 8px; overflow: hidden; aspect-ratio: 1; background: var(--bg-secondary, #27272a); }
  .result-card img { width: 100%; height: 100%; object-fit: cover; }
</style>
