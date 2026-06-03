/**
 * ChatGPT Content Script — DOM automation for chatgpt.com
 * Handles prompt injection, image mode, tile monitoring
 */

import { SelectorResolver } from '../shared/selector-system';

const selectors = new SelectorResolver('chatgpt', {
  promptInput: '#prompt-textarea, textarea[data-id="root"]',
  submitButton: 'button[data-testid="send-button"], button[aria-label="Send"]',
  imageMode: 'button[aria-label*="image"], [data-testid="image-gen"]',
  modelSelector: 'button[aria-label*="model"], [data-testid="model-selector"]',
  resultImage: 'img[alt*="Generated"], div[data-testid="image-result"] img',
  loadingIndicator: '[class*="thinking"], [class*="loading"], [data-testid="loading"]',
  ratioDropdown: '[aria-label*="aspect"], [data-testid="aspect-ratio"]',
  errorToast: '[role="alert"], [class*="error-toast"]',
  turnstileFrame: 'iframe[src*="challenges.cloudflare"]',
});

interface ChatGPTState {
  ready: boolean;
  submitting: boolean;
  monitoring: boolean;
  resultImages: string[];
}

const state: ChatGPTState = {
  ready: false,
  submitting: false,
  monitoring: false,
  resultImages: [],
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

async function simulateTyping(element: HTMLElement, text: string): Promise<void> {
  element.focus();
  // ChatGPT uses ProseMirror/contenteditable
  if (element.contentEditable === 'true' || element.querySelector('[contenteditable]')) {
    const editable = element.querySelector('[contenteditable="true"]') || element;
    (editable as HTMLElement).focus();
    // Clear existing
    (editable as HTMLElement).innerHTML = '<p></p>';
    await new Promise(r => setTimeout(r, 100));
    // Type character by character
    for (const char of text) {
      document.execCommand('insertText', false, char);
      await new Promise(r => setTimeout(r, 20 + Math.random() * 40));
    }
  } else if (element instanceof HTMLTextAreaElement) {
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype, 'value'
    )?.set;
    nativeInputValueSetter?.call(element, text);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

async function checkReady(): Promise<{ ready: boolean; error?: string }> {
  // Check for Cloudflare challenge
  const turnstile = document.querySelector(selectors.get('turnstileFrame'));
  if (turnstile) {
    return { ready: false, error: 'Cloudflare challenge active' };
  }

  const promptEl = await waitForElement(selectors.get('promptInput'), 5000);
  if (!promptEl) return { ready: false, error: 'Prompt input not found' };

  state.ready = true;
  return { ready: true };
}

async function enableImageMode(): Promise<boolean> {
  const imgBtn = document.querySelector(selectors.get('imageMode'));
  if (imgBtn) {
    (imgBtn as HTMLElement).click();
    await new Promise(r => setTimeout(r, 500));
    return true;
  }
  return false;
}

async function submitPrompt(params: {
  prompt: string;
  ratio?: string;
  model?: string;
}): Promise<{ success: boolean; error?: string }> {
  if (state.submitting) return { success: false, error: 'Already submitting' };
  state.submitting = true;

  try {
    // Enable image mode
    await enableImageMode();

    // Type prompt
    const promptEl = await waitForElement(selectors.get('promptInput'), 5000);
    if (!promptEl) return { success: false, error: 'Prompt input not found' };

    await simulateTyping(promptEl as HTMLElement, params.prompt);
    await new Promise(r => setTimeout(r, 300));

    // Click submit
    const submitBtn = document.querySelector(selectors.get('submitButton'));
    if (!submitBtn) return { success: false, error: 'Submit button not found' };
    (submitBtn as HTMLElement).click();

    // Start monitoring
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

    const urls: string[] = [];
    images.forEach(img => {
      const src = (img as HTMLImageElement).src;
      if (src && !state.resultImages.includes(src)) {
        urls.push(src);
        state.resultImages.push(src);
      }
    });

    if (urls.length > 0) {
      chrome.runtime.sendMessage({
        type: 'TILE_RESULTS',
        payload: { urls, total: state.resultImages.length, loading: loading.length, complete: loading.length === 0 },
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
      sendResponse({ ready: state.ready, submitting: state.submitting, monitoring: state.monitoring });
      return false;
  }
});

// Init
(async () => {
  console.log('[TobyFlow/ChatGPT] Content script loaded');
  await new Promise(r => setTimeout(r, 3000));
  await checkReady();
  chrome.runtime.sendMessage({ type: 'CONTENT_SCRIPT_READY', payload: { provider: 'chatgpt' } });
})();
