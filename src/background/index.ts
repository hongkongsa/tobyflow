/**
 * Background Service Worker — Entry point
 * 
 * Responsibilities:
 * - Auth & enrollment management
 * - Request signing (HMAC-SHA256)
 * - Tab management (per-provider)
 * - SSE connection & event routing
 * - Config polling
 * - Content script injection (on-demand)
 * - Cross-context message routing
 */

// Register side panel behavior
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// On install/update
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') {
    console.log('[Background] Extension installed');
    // TODO: Initialize enrollment, open onboarding
  } else if (reason === 'update') {
    console.log('[Background] Extension updated');
    // TODO: Run migrations, re-inject content scripts
  }
});

// Message handler — route to appropriate handlers
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.action !== 'string') return false;

  // TODO: Route to specific handlers based on message.action
  console.log(`[Background] Message: ${message.action}`, { from: sender.id });

  return false;
});

// Tab removed — notify sessions
chrome.tabs.onRemoved.addListener((tabId) => {
  // TODO: Notify ChatGPTSession, GrokSession, etc.
  console.log(`[Background] Tab closed: ${tabId}`);
});

console.log('[Background] Service Worker started');
