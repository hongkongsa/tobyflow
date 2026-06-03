<script lang="ts">
  import { onMount } from 'svelte';
  import { telegramStore } from '../../stores/telegram.store';

  let chatIdInput = '';
  let newCmd = '';
  let newCmdDesc = '';
  let newCmdProvider = 'flow';

  onMount(() => { telegramStore.loadConfig(); });

  function handleConnect() {
    if (!chatIdInput.trim()) return;
    telegramStore.connect(chatIdInput.trim());
  }

  function handleAddCommand() {
    if (!newCmd.trim()) return;
    telegramStore.addCommand(newCmd, newCmdDesc, newCmdProvider);
    newCmd = '';
    newCmdDesc = '';
  }
</script>

<div class="telegram-page">
  <h2>Telegram Integration</h2>

  <!-- Connection Status -->
  <div class="connection-card">
    <div class="status-row">
      <span class="status-dot" class:connected={$telegramStore.connected}></span>
      <span class="status-text">{$telegramStore.connected ? 'Connected' : 'Disconnected'}</span>
      {#if $telegramStore.botUsername}
        <span class="bot-name">@{$telegramStore.botUsername}</span>
      {/if}
    </div>

    {#if !$telegramStore.connected}
      <div class="connect-form">
        <input class="input-field" placeholder="Enter your Telegram Chat ID" bind:value={chatIdInput} />
        <button class="connect-btn" onclick={handleConnect}>Connect</button>
      </div>
      <p class="help-text">Send /start to @TobyFlowBot to get your Chat ID</p>
    {:else}
      <button class="disconnect-btn" onclick={() => telegramStore.disconnect()}>Disconnect</button>
    {/if}
  </div>

  <!-- Commands -->
  {#if $telegramStore.connected}
    <div class="commands-section">
      <h3>Commands</h3>
      <div class="command-list">
        {#each $telegramStore.commands as cmd}
          <div class="command-card">
            <div class="cmd-info">
              <span class="cmd-name">/{cmd.command}</span>
              <span class="cmd-desc">{cmd.description}</span>
              <span class="cmd-provider">{cmd.provider}</span>
            </div>
            <div class="cmd-actions">
              <button
                class="toggle-btn"
                class:enabled={cmd.enabled}
                onclick={() => telegramStore.toggleCommand(cmd.id)}
              >
                {cmd.enabled ? 'ON' : 'OFF'}
              </button>
              <button class="delete-cmd-btn" onclick={() => telegramStore.deleteCommand(cmd.id)}>×</button>
            </div>
          </div>
        {/each}
      </div>

      <!-- Add Command Form -->
      <div class="add-command-form">
        <input class="input-field" placeholder="/command" bind:value={newCmd} />
        <input class="input-field" placeholder="Description" bind:value={newCmdDesc} />
        <select class="input-field" bind:value={newCmdProvider}>
          <option value="flow">Flow</option>
          <option value="chatgpt">ChatGPT</option>
          <option value="grok">Grok</option>
        </select>
        <button class="add-btn" onclick={handleAddCommand}>Add</button>
      </div>
    </div>
  {/if}
</div>

<style>
  .telegram-page { display: flex; flex-direction: column; gap: 14px; }
  .telegram-page h2 { margin: 0; font-size: 16px; }
  .telegram-page h3 { margin: 0 0 8px; font-size: 13px; }
  .connection-card { padding: 12px; background: var(--bg-secondary, #27272a); border-radius: 8px; display: flex; flex-direction: column; gap: 8px; }
  .status-row { display: flex; align-items: center; gap: 6px; }
  .status-dot { width: 8px; height: 8px; border-radius: 50%; background: #dc2626; }
  .status-dot.connected { background: #059669; }
  .status-text { font-size: 12px; font-weight: 500; }
  .bot-name { font-size: 11px; color: var(--text-muted, #71717a); margin-left: auto; }
  .connect-form { display: flex; gap: 6px; }
  .input-field { flex: 1; padding: 7px; border: 1px solid var(--border, #2e2e33); border-radius: 5px; background: var(--bg-primary, #1a1a1e); color: var(--text-primary, #e4e4e7); font-size: 12px; }
  .connect-btn { padding: 7px 14px; border: none; border-radius: 5px; background: #059669; color: white; font-size: 12px; cursor: pointer; }
  .disconnect-btn { padding: 6px 12px; border: 1px solid #dc2626; border-radius: 5px; background: transparent; color: #dc2626; font-size: 11px; cursor: pointer; }
  .help-text { margin: 0; font-size: 10px; color: var(--text-muted, #71717a); }
  .command-list { display: flex; flex-direction: column; gap: 6px; }
  .command-card { display: flex; align-items: center; padding: 8px; background: var(--bg-tertiary, #3f3f46); border-radius: 6px; }
  .cmd-info { flex: 1; display: flex; flex-direction: column; gap: 1px; }
  .cmd-name { font-size: 12px; font-weight: 600; font-family: monospace; }
  .cmd-desc { font-size: 10px; color: var(--text-muted, #71717a); }
  .cmd-provider { font-size: 9px; color: var(--accent, #6366f1); text-transform: uppercase; }
  .cmd-actions { display: flex; gap: 4px; }
  .toggle-btn { padding: 3px 8px; border: 1px solid var(--border, #2e2e33); border-radius: 4px; background: transparent; color: var(--text-muted, #71717a); font-size: 10px; cursor: pointer; }
  .toggle-btn.enabled { background: #05966920; border-color: #059669; color: #34d399; }
  .delete-cmd-btn { width: 20px; height: 20px; border: none; border-radius: 50%; background: transparent; color: var(--text-muted, #71717a); font-size: 14px; cursor: pointer; }
  .delete-cmd-btn:hover { color: #dc2626; }
  .add-command-form { display: flex; gap: 4px; margin-top: 8px; }
  .add-btn { padding: 7px 12px; border: none; border-radius: 5px; background: var(--accent, #6366f1); color: white; font-size: 11px; cursor: pointer; }
</style>
