<script lang="ts">
  import { uiStore } from '../../stores/ui.store';
  import { authStore } from '../../stores/auth.store';

  let loginEmail = '';
  let loginPassword = '';
  let loginLoading = false;

  async function handleLogin() {
    loginLoading = true;
    await authStore.login(loginEmail, loginPassword);
    loginLoading = false;
  }
</script>

<div class="settings-page">
  <h2>Settings</h2>

  <!-- Auth Section -->
  <div class="section">
    <h3>Account</h3>
    {#if $authStore.isLoggedIn}
      <div class="user-card">
        <div class="user-info">
          <span class="user-name">{$authStore.user?.name || 'User'}</span>
          <span class="user-email">{$authStore.user?.email || ''}</span>
          <span class="user-plan">{$authStore.user?.plan || 'free'}</span>
        </div>
        <button class="logout-btn" onclick={() => authStore.logout()}>Logout</button>
      </div>
    {:else}
      <div class="login-form">
        <input class="input-field" type="email" placeholder="Email" bind:value={loginEmail} />
        <input class="input-field" type="password" placeholder="Password" bind:value={loginPassword} />
        {#if $authStore.error}
          <span class="error-text">{$authStore.error}</span>
        {/if}
        <button class="login-btn" onclick={handleLogin} disabled={loginLoading}>
          {loginLoading ? 'Logging in...' : 'Login'}
        </button>
      </div>
    {/if}
  </div>

  <!-- Theme -->
  <div class="section">
    <h3>Appearance</h3>
    <div class="setting-row">
      <span class="setting-label">Theme</span>
      <div class="toggle-group">
        <button class="toggle-btn" class:active={$uiStore.theme === 'dark'} onclick={() => uiStore.setTheme('dark')}>Dark</button>
        <button class="toggle-btn" class:active={$uiStore.theme === 'light'} onclick={() => uiStore.setTheme('light')}>Light</button>
      </div>
    </div>
  </div>

  <!-- Language -->
  <div class="section">
    <h3>Language</h3>
    <div class="setting-row">
      <span class="setting-label">Locale</span>
      <select class="select-field" value={$uiStore.locale} onchange={(e) => uiStore.setLocale((e.target as HTMLSelectElement).value)}>
        <option value="vi">Tiếng Việt</option>
        <option value="en">English</option>
        <option value="ja">日本語</option>
        <option value="th">ไทย</option>
      </select>
    </div>
  </div>

  <!-- About -->
  <div class="section">
    <h3>About</h3>
    <div class="about-info">
      <span>TobyFlow v2.0.0</span>
      <span class="muted">Built with TypeScript + Svelte 5 + Vite</span>
    </div>
  </div>
</div>

<style>
  .settings-page { display: flex; flex-direction: column; gap: 16px; }
  .settings-page h2 { margin: 0; font-size: 16px; }
  .section { display: flex; flex-direction: column; gap: 8px; padding: 12px; background: var(--bg-secondary, #27272a); border-radius: 8px; }
  .section h3 { margin: 0; font-size: 12px; color: var(--text-muted, #71717a); text-transform: uppercase; }
  .user-card { display: flex; align-items: center; }
  .user-info { flex: 1; display: flex; flex-direction: column; gap: 1px; }
  .user-name { font-size: 13px; font-weight: 500; }
  .user-email { font-size: 11px; color: var(--text-muted, #71717a); }
  .user-plan { font-size: 10px; color: var(--accent, #6366f1); text-transform: uppercase; }
  .logout-btn { padding: 5px 10px; border: 1px solid #dc2626; border-radius: 4px; background: transparent; color: #dc2626; font-size: 11px; cursor: pointer; }
  .login-form { display: flex; flex-direction: column; gap: 8px; }
  .input-field { padding: 8px; border: 1px solid var(--border, #2e2e33); border-radius: 5px; background: var(--bg-primary, #1a1a1e); color: var(--text-primary, #e4e4e7); font-size: 12px; }
  .error-text { font-size: 11px; color: #fca5a5; }
  .login-btn { padding: 8px; border: none; border-radius: 5px; background: var(--accent, #6366f1); color: white; font-size: 12px; cursor: pointer; }
  .login-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .setting-row { display: flex; align-items: center; justify-content: space-between; }
  .setting-label { font-size: 12px; }
  .toggle-group { display: flex; gap: 2px; }
  .toggle-btn { padding: 4px 10px; border: 1px solid var(--border, #2e2e33); border-radius: 4px; background: transparent; color: var(--text-muted, #71717a); font-size: 11px; cursor: pointer; }
  .toggle-btn.active { background: var(--accent, #6366f1); color: white; border-color: var(--accent, #6366f1); }
  .select-field { padding: 6px 8px; border: 1px solid var(--border, #2e2e33); border-radius: 4px; background: var(--bg-primary, #1a1a1e); color: var(--text-primary, #e4e4e7); font-size: 12px; }
  .about-info { display: flex; flex-direction: column; gap: 2px; font-size: 12px; }
  .muted { color: var(--text-muted, #71717a); font-size: 10px; }
</style>
