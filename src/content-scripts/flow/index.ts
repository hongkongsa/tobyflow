/**
 * Content Script — Google Flow (labs.google / aitestkitchen.withgoogle.com)
 * 
 * Responsibilities:
 * - Submit prompts to Flow's Slate editor
 * - Monitor tile generation (success/failed/processing)
 * - Download completed tiles
 * - Upload reference images
 * - Retry failed tiles (3-tier system)
 * - Show execution blocker overlay
 */

import { SelectorResolver } from '../shared/selector-system';

// Re-injection guard
if ((self as any).__tobyflow_flow_loaded__) {
  console.log('[Flow] Already loaded, skipping re-injection');
} else {
  (self as any).__tobyflow_flow_loaded__ = true;
  initFlowContentScript();
}

async function initFlowContentScript(): Promise<void> {
  const resolver = new SelectorResolver('flow');

  // Wait for selector config from server
  const ready = await resolver.waitForConfig();
  if (!ready) {
    showConfigErrorOverlay();
    return;
  }

  console.log('[Flow] Content script initialized, selectors ready');

  // Listen for messages from background/sidepanel
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    handleMessage(message, resolver, sendResponse);
    return true; // async response
  });
}

function handleMessage(
  message: any,
  resolver: SelectorResolver,
  sendResponse: (response: any) => void
): void {
  switch (message.action) {
    case 'flow:submit':
      handleSubmit(message, resolver).then(sendResponse);
      break;
    case 'flow:scanTiles':
      handleScanTiles(resolver).then(sendResponse);
      break;
    case 'flow:detectTileStatus':
      handleDetectTileStatus(message, resolver).then(sendResponse);
      break;
    case 'flow:download':
      handleDownload(message, resolver).then(sendResponse);
      break;
    case 'flow:uploadRef':
      handleUploadRef(message, resolver).then(sendResponse);
      break;
    default:
      sendResponse({ error: `Unknown action: ${message.action}` });
  }
}

async function handleSubmit(
  message: any,
  resolver: SelectorResolver
): Promise<{ success: boolean; error?: string }> {
  try {
    const editor = resolver.query('slate_editor');
    if (!editor) {
      return { success: false, error: 'Editor not found' };
    }

    // TODO: Implement Slate editor interaction
    // 1. Clear editor
    // 2. Insert text
    // 3. Click submit button

    return { success: true };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

async function handleScanTiles(
  resolver: SelectorResolver
): Promise<{ tiles: string[] }> {
  const tileElements = resolver.queryAll('tile_container');
  const tileIds = tileElements
    .map((el) => el.getAttribute('data-tile-id'))
    .filter(Boolean) as string[];
  return { tiles: tileIds };
}

async function handleDetectTileStatus(
  message: any,
  resolver: SelectorResolver
): Promise<{ status: 'success' | 'failed' | 'processing' | 'unknown' }> {
  // TODO: Implement tile status detection
  // 1. Check success: media element with valid src
  // 2. Check processing: % marker text
  // 3. Check failed: warning icon visible
  return { status: 'unknown' };
}

async function handleDownload(
  message: any,
  resolver: SelectorResolver
): Promise<{ success: boolean; error?: string }> {
  // TODO: Implement download via context menu
  return { success: false, error: 'Not implemented' };
}

async function handleUploadRef(
  message: any,
  resolver: SelectorResolver
): Promise<{ success: boolean; tile_id?: string; error?: string }> {
  // TODO: Implement ref image upload
  return { success: false, error: 'Not implemented' };
}

function showConfigErrorOverlay(): void {
  // TODO: Show "Internet connection lost" overlay with retry button
  console.error('[Flow] Failed to load selector config');
}
