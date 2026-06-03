/**
 * StyleSelectModal - Modal for selecting addon prompts/styles
 * Renders at root level to avoid overflow clipping issues
 */
class StyleSelectModal {
  static _instance = null;
  static _overlay = null;
  static _onSelect = null;
  static _addons = [];
  static _selectedId = null;

  /**
   * Show the style select modal
   * @param {Object} options
   * @param {Array} options.addons - Array of addon objects with id, name, thumbnail_url, category
   * @param {string|null} options.selectedId - Currently selected addon ID
   * @param {Function} options.onSelect - Callback when addon is selected, receives addon object or null
   */
  static show({ addons = [], selectedId = null, onSelect = () => {} }) {
    StyleSelectModal._addons = addons;
    StyleSelectModal._selectedId = selectedId;
    StyleSelectModal._onSelect = onSelect;
    StyleSelectModal._render();
    StyleSelectModal._open();
  }

  static hide() {
    if (StyleSelectModal._overlay) {
      StyleSelectModal._overlay.classList.add('hidden');
      StyleSelectModal._overlay.classList.remove('visible');
    }
  }

  static _getContainer() {
    let container = document.getElementById('styleSelectModalContainer');
    if (!container) {
      container = document.createElement('div');
      container.id = 'styleSelectModalContainer';
      document.body.appendChild(container);
    }
    return container;
  }

  static _render() {
    const container = StyleSelectModal._getContainer();
    const t = (key) => window.I18n?.t(key) || key;

    // Group addons by category
    const grouped = {};
    const uncategorized = [];

    for (const addon of StyleSelectModal._addons) {
      if (addon.category) {
        if (!grouped[addon.category]) grouped[addon.category] = [];
        grouped[addon.category].push(addon);
      } else {
        uncategorized.push(addon);
      }
    }

    const categories = Object.keys(grouped).sort();

    let itemsHtml = `
      <div class="style-modal-item none-option ${!StyleSelectModal._selectedId ? 'selected' : ''}" data-id="">
        <div class="style-modal-item-icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="15" y1="9" x2="9" y2="15"></line>
            <line x1="9" y1="9" x2="15" y2="15"></line>
          </svg>
        </div>
        <span class="style-modal-item-name">${t('gen.noStyle') || 'Không chọn phong cách'}</span>
      </div>
    `;

    // Render by category
    for (const category of categories) {
      itemsHtml += `<div class="style-modal-category">${category}</div>`;
      for (const addon of grouped[category]) {
        itemsHtml += StyleSelectModal._renderItem(addon);
      }
    }

    // Render uncategorized
    if (uncategorized.length > 0) {
      if (categories.length > 0) {
        itemsHtml += `<div class="style-modal-category">${t('gen.otherStyles') || 'Khác'}</div>`;
      }
      for (const addon of uncategorized) {
        itemsHtml += StyleSelectModal._renderItem(addon);
      }
    }

    container.innerHTML = `
      <div class="style-modal-overlay hidden" id="styleSelectModalOverlay">
        <div class="style-modal-backdrop"></div>
        <div class="style-modal-content">
          <div class="style-modal-header">
            <h3 class="style-modal-title">${t('gen.selectStyle') || 'Chọn phong cách'}</h3>
            <button type="button" class="style-modal-close" id="styleModalClose">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          </div>
          <div class="style-modal-search">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="11" cy="11" r="8"></circle>
              <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
            </svg>
            <input type="text" id="styleModalSearch" placeholder="${t('gen.styleSearch') || 'Tìm phong cách...'}" />
          </div>
          <div class="style-modal-list" id="styleModalList">
            ${itemsHtml}
          </div>
        </div>
      </div>
    `;

    StyleSelectModal._overlay = container.querySelector('#styleSelectModalOverlay');
    StyleSelectModal._bindEvents();
  }

  static _renderItem(addon) {
    const isSelected = String(addon.id) === String(StyleSelectModal._selectedId);
    const thumbHtml = addon.thumbnail_url
      ? `<img class="style-modal-item-thumb" src="${addon.thumbnail_url}" alt="${addon.name}" loading="lazy" />`
      : `<div class="style-modal-item-icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 3c.132 0 .263 0 .393 0a7.5 7.5 0 0 0 7.92 12.446a9 9 0 1 1 -8.313 -12.454z"></path>
            <path d="M17 4a2 2 0 0 0 2 2a2 2 0 0 0 -2 2a2 2 0 0 0 -2 -2a2 2 0 0 0 2 -2"></path>
          </svg>
        </div>`;

    return `
      <div class="style-modal-item ${isSelected ? 'selected' : ''}" data-id="${addon.id}">
        ${thumbHtml}
        <span class="style-modal-item-name">${addon.name || 'Không tên'}</span>
        ${isSelected ? `
          <svg class="style-modal-item-check" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <polyline points="20 6 9 17 4 12"></polyline>
          </svg>
        ` : ''}
      </div>
    `;
  }

  static _bindEvents() {
    const overlay = StyleSelectModal._overlay;
    if (!overlay) return;

    // Close button
    overlay.querySelector('#styleModalClose')?.addEventListener('click', () => {
      StyleSelectModal.hide();
    });

    // Backdrop click
    overlay.querySelector('.style-modal-backdrop')?.addEventListener('click', () => {
      StyleSelectModal.hide();
    });

    // Item selection
    overlay.querySelectorAll('.style-modal-item').forEach(item => {
      item.addEventListener('click', () => {
        const id = item.dataset.id;
        const addon = id ? StyleSelectModal._addons.find(a => String(a.id) === String(id)) : null;
        StyleSelectModal._onSelect(addon);
        StyleSelectModal.hide();
      });
    });

    // Search
    const searchInput = overlay.querySelector('#styleModalSearch');
    searchInput?.addEventListener('input', () => {
      StyleSelectModal._filterList(searchInput.value);
    });

    // Escape key
    const escHandler = (e) => {
      if (e.key === 'Escape' && overlay.classList.contains('visible')) {
        StyleSelectModal.hide();
        document.removeEventListener('keydown', escHandler);
      }
    };
    document.addEventListener('keydown', escHandler);
  }

  static _filterList(searchTerm) {
    const list = StyleSelectModal._overlay?.querySelector('#styleModalList');
    if (!list) return;

    const term = searchTerm.toLowerCase().trim();

    list.querySelectorAll('.style-modal-item').forEach(item => {
      const name = item.querySelector('.style-modal-item-name')?.textContent?.toLowerCase() || '';
      const matches = !term || name.includes(term) || item.classList.contains('none-option');
      item.style.display = matches ? '' : 'none';
    });

    // Hide empty categories
    list.querySelectorAll('.style-modal-category').forEach(cat => {
      const nextItems = [];
      let sibling = cat.nextElementSibling;
      while (sibling && !sibling.classList.contains('style-modal-category')) {
        if (sibling.classList.contains('style-modal-item')) {
          nextItems.push(sibling);
        }
        sibling = sibling.nextElementSibling;
      }
      const hasVisible = nextItems.some(item => item.style.display !== 'none');
      cat.style.display = hasVisible ? '' : 'none';
    });
  }

  static _open() {
    if (StyleSelectModal._overlay) {
      StyleSelectModal._overlay.classList.remove('hidden');
      // Trigger animation
      requestAnimationFrame(() => {
        StyleSelectModal._overlay.classList.add('visible');
      });
      // Focus search
      StyleSelectModal._overlay.querySelector('#styleModalSearch')?.focus();
    }
  }
}

// Export for use
window.StyleSelectModal = StyleSelectModal;
