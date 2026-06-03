/**
 * Grok Content Script — DOM automation for grok.com
 * Handles TipTap editor interaction, Cloudflare bypass, tile monitoring
 */

import { SelectorResolver } from '../shared/selector-system';

const selectors = new SelectorResolver('grok', {
  promptInput: '.tiptap, div[contenteditable="true"], textarea',
  submitButton: 'button[aria-label="Send"], button[type="submit"]',
  resultImage: 'img[src*="grok"], img[alt*="generated"], [class*="image-result"] img',
  loadingIndicator: '[class*="loading"], [class*="typing"], [class*="generating"]',
  turnstileFrame: 'iframe[src*="challenges.cloudflare"]',
  turnstileCheckbox: '#cf-turnstile input[type="checkbox"]',
  modelSelector: '[class*="model-select"], button[aria-label*="model"]',
  errorMessage: '[role="alert"], [class*="error"]',
});

interface GrokState {
  ready: boolean;
  submitting: boolean;
  monitoring: boolean;
  resultImages: string[];
  turnstileDetected: boolean;
}

const state: GrokState = {
  ready: false,
  submitting: false,
  monitoring: false,
  resultImages: [],
  turnstileDetected: false,
};

async function waitForElement(selector: string, timeout = 10000): Promise<Element | null> {
  return new Promise((resolve) => {
    const existing = document.querySelector(selector);
    if (existing) return resolve(existing);
    const observer = new MutationObserver(() => {
      const el = document.querySelector(selector);
      if (el) { observer.disconnect(); resolve(el); }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => { observer.disconnect(); resolve(null); }, timeout);
  });
}

// TipTap editor typing simulation
async function typeInTipTap(element: HTMLElement, text: string): Promise<void> {
  element.focus();
  // Clear existing content
  element.innerHTML = '<p><br></p>';
  await new Promise(r => setTimeout(r, 100));

  // Simulate Input events for TipTap
  for (const char of text) {
    const inputEvent = new InputEvent('beforeinput', {
      inputType: 'insertText',
      data: char,
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    element.dispatchEvent(inputEvent);
    document.execCommand('insertText', false, char);
    await new Promise(r => setTimeout(r, 25 + Math.random() * 50));
  }
}

// Cloudflare Turnstile bypass strategies
async function handleTurnstile(): Promise<boolean> {
  const frame = document.querySelector(selectors.get('turnstileFrame')) as HTMLIFrameElement;
  if (!frame) return true; // No turnstile, proceed

  state.turnstileDetected = true;
  console.log('[TobyFlow/Grok] Turnstile detected, attempting bypass...');

  // Strategy 1: Wait for auto-solve (happens sometimes)
  await new Promise(r => setTimeout(r, 3000));
  if (!document.querySelector(selectors.get('turnstileFrame'))) return true;

  // Strategy 2: Try clicking the checkbox
  try {
    const frameDoc = frame.contentDocument;
    if (frameDoc) {
      const checkbox = frameDoc.querySelector('input[type="checkbox"]');
      if (checkbox) (checkbox as HTMLElement).click();
      await new Promise(r => setTimeout(r, 2000));
      if (!document.querySelector(selectors.get('turnstileFrame'))) return true;
    }
  } catch { /* cross-origin, expected */ }

  // Strategy 3: Reload page (force new challenge)
  // Only as last resort - notify background
  chrome.runtime.sendMessage({
    type: 'TURNSTILE_BLOCKED',
    payload: { provider: 'grok' },
  });

  return false;
}

async function checkReady(): Promise<{ ready: boolean; error?: string }> {
  const hasTurnstile = document.querySelector(selectors.get('turnstileFrame'));
  if (hasTurnstile) {
    const bypassed = await handleTurnstile();
    if (!bypassed) return { ready: false, error: 'Cloudflare Turnstile active' };
  }

  const promptEl = await waitForElement(selectors.get('promptInput'), 5000);
  if (!promptEl) return { ready: false, error: 'Prompt input not found' };

  state.ready = true;
  return { ready: true };
}

async function submitPrompt(params: {
  prompt: string;
  ratio?: string;
  model?: string;
}): Promise<{ success: boolean; error?: string }> {
  if (state.submitting) return { success: false, error: 'Already submitting' };
  state.submitting = true;

  try {
    const promptEl = await waitForElement(selectors.get('promptInput'), 5000);
    if (!promptEl) return { success: false, error: 'Prompt input not found' };

    // Grok uses TipTap editor
    await typeInTipTap(promptEl as HTMLElement, params.prompt);
    await new Promise(r => setTimeout(r, 500));

    // Submit
    const submitBtn = document.querySelector(selectors.get('submitButton'));
    if (!submitBtn) return { success: false, error: 'Submit button not found' };
    (submitBtn as HTMLElement).click();

    // Monitor results
    state.monitoring = true;
    state.resultImages = [];
    startMonitor();

    return { success: true };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  } finally {
    state.submitting = false;
  }
}

function startMonitor() {
  const observer = new MutationObserver(() => {
    const images = document.querySelectorAll(selectors.get('resultImage'));
    const loading = document.querySelectorAll(selectors.get('loadingIndicator'));

    const newUrls: string[] = [];
    images.forEach(img => {
      const src = (img as HTMLImageElement).src;
      if (src && !state.resultImages.includes(src)) {
        newUrls.push(src);
        state.resultImages.push(src);
      }
    });

    if (newUrls.length > 0) {
      chrome.runtime.sendMessage({
        type: 'TILE_RESULTS',
        payload: { urls: newUrls, total: state.resultImages.length, loading: loading.length, complete: loading.length === 0 },
      });
    }

    if (loading.length === 0 && state.resultImages.length > 0) {
      state.monitoring = false;
      observer.disconnect();
    }
  });

  observer.observe(document.body, { childList: true, subtree: true, attributes: true });
  setTimeout(() => { if (state.monitoring) { state.monitoring = false; observer.disconnect(); } }, 300000);
}

// Message listener
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.type) {
    case 'CHECK_READY': checkReady().then(sendResponse); return true;
    case 'SUBMIT_PROMPT': submitPrompt(message.payload).then(sendResponse); return true;
    case 'GET_STATUS':
      sendResponse({ ready: state.ready, submitting: state.submitting, monitoring: state.monitoring, turnstile: state.turnstileDetected });
      return false;
  }
});

// Init
(async () => {
  console.log('[TobyFlow/Grok] Content script loaded');
  await new Promise(r => setTimeout(r, 3000));
  await checkReady();
  chrome.runtime.sendMessage({ type: 'CONTENT_SCRIPT_READY', payload: { provider: 'grok' } });
})();
