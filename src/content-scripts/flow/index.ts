/**
 * Flow Content Script — DOM automation for Google Flow (labs.google.com/fx)
 * Handles prompt injection, tile monitoring, result extraction
 */

import { SelectorResolver } from '../shared/selector-system';

// ============ State ============
interface FlowState {
  ready: boolean;
  submitting: boolean;
  monitoring: boolean;
  tileCount: number;
  maxTiles: number;
}

const state: FlowState = {
  ready: false,
  submitting: false,
  monitoring: false,
  tileCount: 0,
  maxTiles: 8,
};

// ============ Selectors (dynamic, updated from server) ============
const selectors = new SelectorResolver('flow', {
  promptInput: 'textarea[aria-label], div[contenteditable="true"]',
  submitButton: 'button[aria-label="Create"], button[data-test-id="submit"]',
  tileContainer: '[class*="tile"], [class*="result"], [class*="gallery"]',
  tileImage: 'img[src*="generated"], img[class*="tile"]',
  tileLoading: '[class*="loading"], [class*="spinner"], [class*="pending"]',
  ratioSelect: 'button[aria-label*="ratio"], [class*="ratio"] button',
  modelSelect: '[class*="model"] select, button[aria-label*="model"]',
  errorMessage: '[class*="error"], [role="alert"]',
  uploadButton: 'button[aria-label*="upload"], input[type="file"]',
});

// ============ DOM Utilities ============
function waitForElement(selector: string, timeout = 10000): Promise<Element | null> {
  return new Promise((resolve) => {
    const existing = document.querySelector(selector);
    if (existing) return resolve(existing);

    const observer = new MutationObserver(() => {
      const el = document.querySelector(selector);
      if (el) {
        observer.disconnect();
        resolve(el);
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => { observer.disconnect(); resolve(null); }, timeout);
  });
}

function simulateTyping(element: HTMLElement, text: string, humanized = true): Promise<void> {
  return new Promise((resolve) => {
    if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
      if (humanized) {
        let i = 0;
        const type = () => {
          if (i < text.length) {
            element.value += text[i];
            element.dispatchEvent(new Event('input', { bubbles: true }));
            i++;
            setTimeout(type, 30 + Math.random() * 70);
          } else {
            resolve();
          }
        };
        element.value = '';
        type();
      } else {
        element.value = text;
        element.dispatchEvent(new Event('input', { bubbles: true }));
        resolve();
      }
    } else if (element.contentEditable === 'true') {
      // ContentEditable (Slate/ProseMirror)
      element.focus();
      element.innerHTML = '';
      if (humanized) {
        let i = 0;
        const type = () => {
          if (i < text.length) {
            document.execCommand('insertText', false, text[i]);
            i++;
            setTimeout(type, 30 + Math.random() * 70);
          } else {
            resolve();
          }
        };
        type();
      } else {
        document.execCommand('insertText', false, text);
        resolve();
      }
    } else {
      resolve();
    }
  });
}

// ============ Core Actions ============
async function checkReady(): Promise<{ ready: boolean; error?: string }> {
  const promptEl = await waitForElement(selectors.get('promptInput'), 5000);
  if (!promptEl) return { ready: false, error: 'Prompt input not found' };

  const submitEl = document.querySelector(selectors.get('submitButton'));
  if (!submitEl) return { ready: false, error: 'Submit button not found' };

  state.ready = true;
  return { ready: true };
}

async function submitPrompt(params: {
  prompt: string;
  ratio?: string;
  quantity?: number;
  model?: string;
  humanized?: boolean;
}): Promise<{ success: boolean; error?: string }> {
  if (state.submitting) return { success: false, error: 'Already submitting' };
  state.submitting = true;

  try {
    // 1. Set ratio if specified
    if (params.ratio) {
      const ratioBtn = document.querySelector(selectors.get('ratioSelect'));
      if (ratioBtn) {
        (ratioBtn as HTMLElement).click();
        await new Promise(r => setTimeout(r, 300));
        const option = [...document.querySelectorAll('button, [role="option"]')]
          .find(el => el.textContent?.includes(params.ratio!));
        if (option) (option as HTMLElement).click();
        await new Promise(r => setTimeout(r, 300));
      }
    }

    // 2. Type prompt
    const promptEl = await waitForElement(selectors.get('promptInput'), 5000);
    if (!promptEl) return { success: false, error: 'Prompt input not found' };

    await simulateTyping(promptEl as HTMLElement, params.prompt, params.humanized !== false);
    await new Promise(r => setTimeout(r, 500));

    // 3. Click submit
    const submitBtn = document.querySelector(selectors.get('submitButton'));
    if (!submitBtn) return { success: false, error: 'Submit button not found' };

    (submitBtn as HTMLElement).click();

    // 4. Start monitoring tiles
    state.monitoring = true;
    startTileMonitor();

    return { success: true };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  } finally {
    state.submitting = false;
  }
}

// ============ Tile Monitor ============
let tileObserver: MutationObserver | null = null;

function startTileMonitor() {
  if (tileObserver) tileObserver.disconnect();

  const checkTiles = () => {
    const tiles = document.querySelectorAll(selectors.get('tileImage'));
    const loadingTiles = document.querySelectorAll(selectors.get('tileLoading'));

    const newCompletedUrls: string[] = [];
    tiles.forEach(tile => {
      const img = tile as HTMLImageElement;
      if (img.src && img.complete && img.naturalWidth > 0) {
        newCompletedUrls.push(img.src);
      }
    });

    if (newCompletedUrls.length > state.tileCount) {
      const newUrls = newCompletedUrls.slice(state.tileCount);
      state.tileCount = newCompletedUrls.length;

      // Report to background
      chrome.runtime.sendMessage({
        type: 'TILE_RESULTS',
        payload: {
          urls: newUrls,
          total: newCompletedUrls.length,
          loading: loadingTiles.length,
          complete: loadingTiles.length === 0 && newCompletedUrls.length > 0,
        },
      });
    }

    // Check if all done
    if (loadingTiles.length === 0 && newCompletedUrls.length > 0) {
      state.monitoring = false;
      if (tileObserver) {
        tileObserver.disconnect();
        tileObserver = null;
      }
    }
  };

  tileObserver = new MutationObserver(checkTiles);
  tileObserver.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src', 'class'],
  });

  // Also poll periodically as backup
  const pollInterval = setInterval(() => {
    if (!state.monitoring) {
      clearInterval(pollInterval);
      return;
    }
    checkTiles();
  }, 2000);

  // Timeout after 5 minutes
  setTimeout(() => {
    if (state.monitoring) {
      state.monitoring = false;
      if (tileObserver) tileObserver.disconnect();
      clearInterval(pollInterval);
    }
  }, 300000);
}

// ============ Upload Reference Image ============
async function uploadRefImage(file: File): Promise<{ success: boolean; error?: string }> {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  if (!input) {
    // Try to find and click upload button first
    const uploadBtn = document.querySelector(selectors.get('uploadButton'));
    if (uploadBtn) (uploadBtn as HTMLElement).click();
    await new Promise(r => setTimeout(r, 500));
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    if (!fileInput) return { success: false, error: 'File input not found' };
    const dt = new DataTransfer();
    dt.items.add(file);
    fileInput.files = dt.files;
    fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    return { success: true };
  }
  const dt = new DataTransfer();
  dt.items.add(file);
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return { success: true };
}

// ============ Message Listener ============
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const { type, payload } = message;

  switch (type) {
    case 'CHECK_READY':
      checkReady().then(sendResponse);
      return true;

    case 'SUBMIT_PROMPT':
      submitPrompt(payload).then(sendResponse);
      return true;

    case 'UPLOAD_REF_IMAGE':
      // payload.fileData is base64
      fetch(payload.fileData)
        .then(r => r.blob())
        .then(blob => new File([blob], payload.fileName))
        .then(file => uploadRefImage(file))
        .then(sendResponse);
      return true;

    case 'GET_STATUS':
      sendResponse({
        ready: state.ready,
        submitting: state.submitting,
        monitoring: state.monitoring,
        tileCount: state.tileCount,
      });
      return false;

    case 'STOP_MONITORING':
      state.monitoring = false;
      if (tileObserver) tileObserver.disconnect();
      sendResponse({ success: true });
      return false;
  }
});

// ============ Init ============
async function init() {
  console.log('[TobyFlow/Flow] Content script loaded');
  // Wait for page to be ready
  await new Promise(r => setTimeout(r, 2000));
  await checkReady();
  chrome.runtime.sendMessage({ type: 'CONTENT_SCRIPT_READY', payload: { provider: 'flow' } });
}

init();
