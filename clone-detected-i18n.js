/**
 * clone-detected-i18n.js — Mini-i18n cho clone-detected overlay (sidebar).
 *
 * Pattern giống loading-i18n.js: hiển thị TRƯỚC khi I18n class load. Render text mặc định
 * vi/en theo chrome.storage.local.af_locale (vài ms sau khi sidebar mount).
 *
 * Trigger: app.js _showCloneDetectedOverlay() chỉ remove .hidden class. Text update do file
 * này (early) + I18n class (sau) — cả 2 đều resolve qua data-i18n attribute.
 */
(function () {
  const labels = {
    vi: {
      title: 'Extension không hợp lệ',
      desc: 'Phiên bản extension này không có quyền truy cập API Toby Flow. Vui lòng cài lại từ Chrome Web Store để tiếp tục sử dụng.',
      storeButton: 'Mở Chrome Web Store',
    },
    en: {
      title: 'Extension Not Authorized',
      desc: 'This extension version is not authorized to access Toby Flow API. Please reinstall from the Chrome Web Store to continue.',
      storeButton: 'Open Chrome Web Store',
    },
    ja: {
      title: '拡張機能が許可されていません',
      desc: 'この拡張機能のバージョンは Toby Flow API へのアクセスが許可されていません。Chrome ウェブストアから再インストールしてください。',
      storeButton: 'Chrome ウェブストアを開く',
    },
    th: {
      title: 'ส่วนขยายไม่ได้รับอนุญาต',
      desc: 'ส่วนขยายเวอร์ชันนี้ไม่ได้รับอนุญาตให้เข้าถึง API ของ Toby Flow โปรดติดตั้งใหม่จาก Chrome เว็บสโตร์',
      storeButton: 'เปิด Chrome เว็บสโตร์',
    },
  };
  try {
    chrome.storage.local.get(['af_locale'], function (r) {
      const locale = r.af_locale || 'en';
      const set = labels[locale] || labels.en;
      const titleEl = document.querySelector('.tobyflow-clone-detected-title');
      const descEl = document.querySelector('.tobyflow-clone-detected-desc');
      const btnEl = document.querySelector('.tobyflow-clone-detected-store-btn span');
      if (titleEl) titleEl.textContent = set.title;
      if (descEl) descEl.textContent = set.desc;
      if (btnEl) btnEl.textContent = set.storeButton;
    });
  } catch (e) {
    /* extension context not ready — keep default text từ HTML */
  }
})();
