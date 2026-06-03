/**
 * Gemini Content Script — DOM automation for gemini.google.com
 * Text-only provider (no image generation), used for text prompts
 */

import { SelectorResolver } from '../shared/selector-system';

const selectors = new SelectorResolver('gemini', {
  promptInput: 'rich-textarea .ql-editor, [contenteditable="true"], textarea',
  submitButton: 'button[aria-label="Send message"], button.send-button',
  responseContainer: '.response-container, .model-response, [class*="response"]',
  responseText: '.response-container p, .markdown-content p',
  loadingIndicator: '[class*="loading"], [class*="thinking"], .typing-indicator',
  errorMessage: '[role="alert"], [class*="error"]',
  imageResult: '.response-container img, .generated-image',
});

interface GeminiState {
  ready: boolean;
  submitting: boolean;
  monitoring: boolean;
  resultUrls: string[];
}

const state: GeminiState = {
  ready: false,
  submitting: false,
  monitoring: false,
  resultUrls: [],
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

async function typeInEditor(element: HTMLElement, text: string): Promise<void> {
  element.focus();
  // Gemini uses Quill-based rich textarea
  if (element.classList.contains('ql-editor')) {
    element.innerHTML = '';
    await new Promise(r => setTimeout(r, 100));
    for (const char of text) {
      document.execCommand('insertText', false, char);
      await new Promise(r => setTimeout(r, 20 + Math.random() * 40));
    }
  } else if (element.contentEditable === 'true') {
    element.innerHTML = '';
    await new Promise(r => setTimeout(r, 100));
    for (const char of text) {
      document.execCommand('insertText', false, char);
      await new Promise(r => setTimeout(r, 20 + Math.random() * 40));
    }
  } else if (element instanceof HTMLTextAreaElement) {
    element.value = text;
    element.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

async function checkReady(): Promise<{ ready: boolean; error?: string }> {
  const promptEl = await waitForElement(selectors.get('promptInput'), 5000);
  if (!promptEl) return { ready: false, error: 'Prompt input not found' };
  state.ready = true;
  return { ready: true };
}

async function submitPrompt(params: {
  prompt: string;
}): Promise<{ success: boolean; error?: string }> {
  if (state.submitting) return { success: false, error: 'Already submitting' };
  state.submitting = true;

  try {
    const promptEl = await waitForElement(selectors.get('promptInput'), 5000);
    if (!promptEl) return { success: false, error: 'Prompt input not found' };

    await typeInEditor(promptEl as HTMLElement, params.prompt);
    await new Promise(r => setTimeout(r, 300));

    const submitBtn = document.querySelector(selectors.get('submitButton'));
    if (!submitBtn) return { success: false, error: 'Submit button not found' };
    (submitBtn as HTMLElement).click();

    state.monitoring = true;
    state.resultUrls = [];
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
    const images = document.querySelectorAll(selectors.get('imageResult'));
    const loading = document.querySelectorAll(selectors.get('loadingIndicator'));

    const newUrls: string[] = [];
    images.forEach(img => {
      const src = (img as HTMLImageElement).src;
      if (src && !state.resultUrls.includes(src)) {
        newUrls.push(src);
        state.resultUrls.push(src);
      }
    });

    if (newUrls.length > 0) {
      chrome.runtime.sendMessage({
        type: 'TILE_RESULTS',
        payload: { urls: newUrls, total: state.resultUrls.length, loading: loading.length, complete: loading.length === 0 },
      });
    }

    if (loading.length === 0 && state.resultUrls.length > 0) {
      state.monitoring = false;
      observer.disconnect();
    }
  });

  observer.observe(document.body, { childList: true, subtree: true, attributes: true });
  setTimeout(() => { if (state.monitoring) { state.monitoring = false; observer.disconnect(); } }, 300000);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.type) {
    case 'CHECK_READY': checkReady().then(sendResponse); return true;
    case 'SUBMIT_PROMPT': submitPrompt(message.payload).then(sendResponse); return true;
    case 'GET_STATUS':
      sendResponse({ ready: state.ready, submitting: state.submitting, monitoring: state.monitoring });
      return false;
  }
});

(async () => {
  console.log('[TobyFlow/Gemini] Content script loaded');
  await new Promise(r => setTimeout(r, 3000));
  await checkReady();
  chrome.runtime.sendMessage({ type: 'CONTENT_SCRIPT_READY', payload: { provider: 'gemini' } });
})();
