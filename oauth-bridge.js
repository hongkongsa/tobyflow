/**
 * OAuth Bridge Content Script
 * Inject vào trang OAuth success để forward token đến extension background.js
 *
 * Flow:
 * 1. OAuthSuccess.vue gọi window.postMessage({ source: 'tobyflow-oauth-success', token })
 * 2. Content script này nhận postMessage
 * 3. Forward đến background.js qua chrome.runtime.sendMessage({ action: 'oauth:success', token })
 */

(function() {
  'use strict';

  // Chỉ chạy trên trang OAuth success
  if (!window.location.pathname.includes('/auth/google/success')) {
    return;
  }

  console.log('[TobyFlow] OAuth bridge loaded');

  // Track xem đã forward token chưa để tránh duplicate
  let tokenForwarded = false;

  // Lắng nghe postMessage từ page
  window.addEventListener('message', (event) => {
    // Kiểm tra source
    if (event.source !== window) return;
    if (!event.data || event.data.source !== 'tobyflow-oauth-success') return;

    const { token, linked } = event.data;

    if (token && !tokenForwarded) {
      tokenForwarded = true;
      // Login flow: forward token đến background.js
      console.log('[TobyFlow] OAuth bridge: forwarding token to background via postMessage');
      chrome.runtime.sendMessage({
        action: 'oauth:success',
        token: token,
      }, (response) => {
        if (chrome.runtime.lastError) {
          console.error('[TobyFlow] OAuth bridge error:', chrome.runtime.lastError.message);
          // Reset để fallback có thể thử lại
          tokenForwarded = false;
        } else {
          console.log('[TobyFlow] OAuth bridge: token forwarded successfully');
        }
      });
    } else if (linked) {
      // Link flow: thông báo extension đã link thành công
      console.log('[TobyFlow] OAuth bridge: forwarding link success to background');
      chrome.runtime.sendMessage({
        action: 'oauth:linked',
        linked: true,
      }, (response) => {
        if (chrome.runtime.lastError) {
          console.error('[TobyFlow] OAuth bridge error:', chrome.runtime.lastError.message);
        } else {
          console.log('[TobyFlow] OAuth bridge: link success forwarded');
        }
      });
    }
  });

  // Fallback 1: Đọc token trực tiếp từ URL query string (đáng tin cậy nhất)
  function checkUrlToken() {
    if (tokenForwarded) return;

    const urlParams = new URLSearchParams(window.location.search);
    const urlToken = urlParams.get('token');

    if (urlToken) {
      tokenForwarded = true;
      console.log('[TobyFlow] OAuth bridge: found token in URL query string, forwarding');
      chrome.runtime.sendMessage({
        action: 'oauth:success',
        token: urlToken,
      }, (response) => {
        if (chrome.runtime.lastError) {
          console.error('[TobyFlow] OAuth bridge URL fallback error:', chrome.runtime.lastError.message);
          tokenForwarded = false;
        } else {
          console.log('[TobyFlow] OAuth bridge: URL token forwarded successfully');
        }
      });
      return true;
    }
    return false;
  }

  // Thử URL fallback NGAY LẬP TỨC (không cần chờ Vue mount)
  if (checkUrlToken()) {
    console.log('[TobyFlow] OAuth bridge: token sent via URL fallback');
  }

  // Fallback 2: poll meta tag nhiều lần nếu URL và postMessage đều miss
  // Vue onMounted có thể chạy trước content script load, nên cần retry
  let metaCheckAttempts = 0;
  const maxMetaAttempts = 10;

  function checkMetaTag() {
    if (tokenForwarded) return;
    metaCheckAttempts++;

    const meta = document.querySelector('meta[name="tobyflow-auth-token"]');
    if (meta && meta.content) {
      tokenForwarded = true;
      console.log('[TobyFlow] OAuth bridge: found token in meta tag (attempt ' + metaCheckAttempts + '), forwarding');
      chrome.runtime.sendMessage({
        action: 'oauth:success',
        token: meta.content,
      }, (response) => {
        if (chrome.runtime.lastError) {
          console.error('[TobyFlow] OAuth bridge meta fallback error:', chrome.runtime.lastError.message);
          // Reset để có thể thử lại
          tokenForwarded = false;
        } else {
          console.log('[TobyFlow] OAuth bridge: meta fallback token forwarded successfully');
        }
      });
    } else if (metaCheckAttempts < maxMetaAttempts) {
      // Retry sau 300ms
      setTimeout(checkMetaTag, 300);
    } else {
      // Final fallback: thử URL lần nữa (có thể URL params bị parse muộn)
      if (!checkUrlToken()) {
        console.warn('[TobyFlow] OAuth bridge: no token found after all attempts');
      }
    }
  }

  // Bắt đầu check meta tag sau 200ms, sau đó retry mỗi 300ms
  // Tổng thời gian: 200 + 300*9 = 2900ms
  setTimeout(checkMetaTag, 200);
})();
