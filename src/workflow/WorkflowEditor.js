/**
 * WorkflowEditor - Modal editor cho workflow với DiagramCanvas và NodeForm
 *
 * Editor Modes:
 * - WORKFLOW_CREATE: Tạo workflow mới
 * - WORKFLOW_EDIT: Chỉnh sửa workflow đã có
 * - SHARED_PREVIEW: Xem workflow được chia sẻ (read-only)
 * - TEMPLATE_PREVIEW: Xem template (read-only)
 * - TEMPLATE_CREATE: Tạo template mới (admin)
 * - TEMPLATE_EDIT: Chỉnh sửa template (admin)
 */

// Editor Mode Enum
const EditorMode = {
  WORKFLOW_CREATE: 'workflow_create',
  WORKFLOW_EDIT: 'workflow_edit',
  SHARED_PREVIEW: 'shared_preview',
  ADMIN_PREVIEW: 'admin_preview',
  TEMPLATE_PREVIEW: 'template_preview',
  TEMPLATE_CREATE: 'template_create',
  TEMPLATE_EDIT: 'template_edit',
};

// Permission matrix for each mode
const EditorPermissions = {
  [EditorMode.WORKFLOW_CREATE]: {
    canEdit: true,
    canSave: true,
    canRun: false,      // Chưa có wf_id
    canShare: false,    // Chưa có wf_id
    canReset: false,    // Chưa có gì để reset
    canExport: false,   // Chưa có gì để export
    canDelete: false,
    showLog: false,
    showQuota: true,
    showToggle: false,  // Chưa có workflow
  },
  [EditorMode.WORKFLOW_EDIT]: {
    canEdit: true,
    canSave: true,
    canRun: true,
    canShare: true,     // Cần check featureGate
    canReset: true,
    canExport: true,
    canDelete: true,
    showLog: true,
    showQuota: true,
    showToggle: true,
  },
  [EditorMode.SHARED_PREVIEW]: {
    canEdit: false,
    canSave: false,
    canRun: false,
    canShare: false,
    canReset: false,
    canExport: true,    // Cho phép export để copy
    canDelete: false,
    showLog: false,
    showQuota: false,
    showToggle: false,
  },
  [EditorMode.ADMIN_PREVIEW]: {
    canEdit: false,
    canSave: false,
    canRun: false,
    canShare: false,
    canReset: false,
    canExport: true,    // Cho phép export để xem cấu trúc
    canDelete: false,
    showLog: true,      // Admin có thể xem log
    showQuota: false,
    showToggle: false,
  },
  [EditorMode.TEMPLATE_PREVIEW]: {
    canEdit: false,
    canSave: false,
    canRun: false,
    canShare: false,
    canReset: false,
    canExport: false,
    canDelete: false,
    showLog: false,
    showQuota: false,
    showToggle: false,
  },
  [EditorMode.TEMPLATE_CREATE]: {
    canEdit: true,
    canSave: true,
    canRun: false,      // Template không run
    canShare: false,
    canReset: false,
    canExport: false,
    canDelete: false,
    showLog: false,
    showQuota: false,   // Template không có quota
    showToggle: false,
  },
  [EditorMode.TEMPLATE_EDIT]: {
    canEdit: true,
    canSave: true,
    canRun: false,      // Template không run
    canShare: false,
    canReset: false,
    canExport: false,
    canDelete: true,
    showLog: false,
    showQuota: false,
    showToggle: false,
  },
};

class WorkflowEditor {
  static _TILE_CACHE_MAX = 100;
  static REF_LIMIT_VIDEO = 3;   // Video Ingredients: tối đa 3 ref images
  static REF_LIMIT_IMAGE = 10;  // Image: tối đa 10 ref images

  // Phase 1 — Node Reference System: Slug constants
  static RESERVED_SLUGS = [
    'all', 'none', 'self', 'this', 'null', 'undefined',
    'true', 'false', 'new', 'delete', 'default'
  ];
  // Phase 6: Migrated to server config (workflow_node_types.config.ui.supports_slug)
  // Fallback array for cold start before server config loads
  static _FALLBACK_MENTIONABLE_TYPES = ['image', 'text', 'text_extract', 'generate', 'chatgpt', 'grok', 'prompt'];
  static SLUG_MAX_LENGTH = 30;
  static SLUG_PATTERN = /^[a-z][a-z0-9_]{0,29}$/;
  // Phase 2 — Node Reference System: Max mentions limit per prompt
  static MAX_MENTIONS_PER_PROMPT = 20;

  constructor() {
    this.mode = 'create';           // Legacy: 'create' | 'edit' | 'view'
    this.editorMode = EditorMode.WORKFLOW_CREATE;  // New: EditorMode enum
    this.workflow = null;
    this.overlay = null;
    this.diagramCanvas = null;
    this.selectedNodeId = null;
    this._tileCache = new Map(); // fileId -> { thumbnail, type }
    this._hasUnsavedChanges = false;
    // Mouse position tracking for smart node placement
    this._lastMouseCanvasPos = null; // { x, y } - last known mouse position on diagram canvas
    // S2.5: Track upload keys tạo trong form editor để cleanup khi close/cancel
    this._formUploadKeys = new Set();
    // Reset guard: block node:completed/failed events during reset to prevent race condition
    this._resetInProgress = false;
    // Flag: bypass unsaved changes dialog when node is being deleted
    this._nodeBeingDeleted = false;

    // [Fix] Initialize saving state flags to prevent play button locked on first load
    this._isSaving = false;
    this._deferredSaveTimer = null;
    this._inlineSaveTimer = null; // Debounce for inline setting changes (800ms)
    this._skipDeferredSave = false;
    this._pendingSaveRequest = false;

    // v1.1 Node clipboard (Ctrl+C / Ctrl+V) — in-memory single slot, in-instance only.
    // Cross-workflow paste disabled by design (scope v1).
    this._nodeClipboard = null; // { data: {...} }

    // EWT-6: Template mode properties - cho phép admin edit workflow templates
    this.isTemplateMode = false;      // Legacy: Đang edit template hay workflow thông thường
    this.templateId = null;           // ID của template đang edit (nếu isTemplateMode = true)
    this.templateData = null;         // Metadata của template (name, category, description, etc.)

    this.bindGlobalEvents();
  }

  _tileCacheSet(key, value) {
    if (this._tileCache.has(key)) {
      this._tileCache.delete(key);
    }
    this._tileCache.set(key, value);
    if (this._tileCache.size > WorkflowEditor._TILE_CACHE_MAX) {
      const oldest = this._tileCache.keys().next().value;
      this._tileCache.delete(oldest);
    }
  }

  /**
   * 2026-05-31 Rescan Tier 2: rescan thumbnail của 1 ref bị broken.
   * Click handler từ rescan button trong _renderNodeRefPreviewInner.
   *
   * Flow:
   *  1. Disable button + show spinner state
   *  2. Activate Flow tab (nếu chưa mở)
   *  3. Call MessageBridge.getThumbnailsByIds([refId]) — probe backend/DOM
   *  4. Success: cập nhật cache + re-render preview
   *  5. Fail 2 lần: mark _permanently_broken trong cache → render warning icon
   */
  async _rescanRefThumbnail(refId, btnEl) {
    if (!refId) return;
    if (!btnEl) btnEl = this.overlay?.querySelector(`[data-ref-rescan-id="${CSS.escape(refId)}"]`);
    // Disable button + spinner state
    if (btnEl) {
      btnEl.disabled = true;
      btnEl.classList.add('ref-thumb-rescan-btn--loading');
    }
    try {
      // Activate Flow tab nếu cần
      try {
        await new Promise((resolve) => {
          chrome.runtime.sendMessage({ action: 'ensureFlowTabActive' }, () => resolve());
        });
      } catch (_) { /* non-blocking */ }
      // Probe thumbnails — MessageBridge gửi cmd 'getThumbnailsByIds' qua content script
      let scanResult = null;
      if (typeof MessageBridge !== 'undefined' && MessageBridge.getThumbnailsByIds) {
        scanResult = await MessageBridge.getThumbnailsByIds([refId]).catch(() => null);
      }
      const info = scanResult?.results?.[refId];
      if (info?.thumbnail) {
        // Success — cập nhật cache + re-render
        const existingCache = this._tileCache.get(refId);
        this._tileCacheSet(refId, {
          thumbnail: info.thumbnail,
          type: info.type || existingCache?.type || 'image',
          ...(info.file_name && { file_name: info.file_name }),
          ...(info.video_url && { video_url: info.video_url }),
        });
        // Re-render all ref previews (right sidebar + node card)
        const fileIdsInput = this.overlay?.querySelector('#nodeRefFileIds')
          || this.overlay?.querySelector('#promptNodeRefFileIds')
          || this.overlay?.querySelector('#chatgptImageRefFileIds')
          || this.overlay?.querySelector('#grokNodeRefFileIds')
          || this.overlay?.querySelector('#imageNodeRefFileIds');
        if (fileIdsInput?.value) {
          this._renderNodeRefPreview(fileIdsInput.value);
        }
        // Cũng update node card diagram
        if (this.selectedNodeId) {
          try { this._showNodeRefPreview(this.selectedNodeId, fileIdsInput?.value?.split(',').map(s => s.trim()).filter(Boolean) || []); } catch (_) {}
        }
        return;
      }
      // Fail — tăng counter, mark permanent broken sau 2 lần
      const existingCache = this._tileCache.get(refId) || {};
      const failCount = (existingCache._rescan_fail_count || 0) + 1;
      this._tileCacheSet(refId, {
        ...existingCache,
        _rescan_fail_count: failCount,
        _permanently_broken: failCount >= 2,
      });
      // Re-render để hiện warning icon nếu permanent
      const fileIdsInput = this.overlay?.querySelector('#nodeRefFileIds')
        || this.overlay?.querySelector('#promptNodeRefFileIds')
        || this.overlay?.querySelector('#chatgptImageRefFileIds')
        || this.overlay?.querySelector('#grokNodeRefFileIds')
        || this.overlay?.querySelector('#imageNodeRefFileIds');
      if (fileIdsInput?.value) {
        this._renderNodeRefPreview(fileIdsInput.value);
      }
      if (typeof window.showNotification === 'function') {
        window.showNotification(
          window.I18n?.t('workflow.thumbRescanFailed') || 'Rescan thất bại — tile có thể đã bị xóa khỏi Flow',
          failCount >= 2 ? 'error' : 'warning',
          3500
        );
      }
    } finally {
      if (btnEl) {
        btnEl.disabled = false;
        btnEl.classList.remove('ref-thumb-rescan-btn--loading');
      }
    }
  }

  /**
   * 2026-05-31 Rescan Tier 1: auto-recover broken thumbnails khi Flow tab activate
   * hoặc khi workflow editor mở. Silent batch scan — không show notification.
   * Trigger:
   *  - tab activated (Flow tab) — listen background message
   *  - workflow editor open initial mount
   *  - SSE refresh event (workflow_changed)
   */
  async _autoRescanBrokenThumbs({ force = false } = {}) {
    if (!this.overlay || !this.diagramCanvas?.editor) return;
    // Throttle 3s (giảm từ 10s) — đủ tránh spam nhưng cho phép trigger nhanh khi user
    // mở sidebar ngay sau workflow load. force=true bypass (vd user explicit click).
    const now = Date.now();
    if (!force && this._lastAutoRescanAt && (now - this._lastAutoRescanAt) < 3000) return;
    this._lastAutoRescanAt = now;
    // Collect broken IDs từ TẤT CẢ nodes có ref_file_ids
    const homeData = this.diagramCanvas.editor.drawflow?.drawflow?.Home?.data || {};
    const brokenIds = new Set();
    for (const node of Object.values(homeData)) {
      const refStr = node?.data?.ref_file_ids || '';
      if (!refStr) continue;
      const ids = refStr.split(',').map(s => s.trim()).filter(Boolean);
      for (const id of ids) {
        if (id.startsWith('upload_')) continue; // pending uploads — skip
        const cached = this._tileCache.get(id);
        if (cached?._permanently_broken) continue;
        // Broken khi: không có thumbnail VÀ không có video_url VÀ không có DOM tile.
        // Video tile chỉ có video_url cũng đủ render → không cần rescan.
        const hasRenderableCache = cached?.thumbnail || cached?.video_url;
        if (!hasRenderableCache && !document.querySelector(`[data-tile-id="${CSS.escape(id)}"]`)) {
          brokenIds.add(id);
        }
      }
    }
    if (brokenIds.size === 0) return;
    console.log('[WorkflowEditor] Auto-rescan broken thumbs:', brokenIds.size);
    if (typeof MessageBridge === 'undefined' || !MessageBridge.getThumbnailsByIds) return;
    try {
      const result = await MessageBridge.getThumbnailsByIds([...brokenIds]).catch(() => null);
      const results = result?.results || {};
      let updatedCount = 0;
      for (const [fid, info] of Object.entries(results)) {
        // 2026-05-31 fix: KHÔNG skip nếu chỉ có video_url (video tile no poster).
        // Trước: `if (!info?.thumbnail) continue` → bỏ qua video tile → user vẫn thấy broken.
        if (!info || (!info.thumbnail && !info.video_url)) continue;
        const existing = this._tileCache.get(fid) || {};
        this._tileCacheSet(fid, {
          ...existing,
          thumbnail: info.thumbnail || existing.thumbnail || '',
          type: info.type || existing.type || 'image',
          ...(info.file_name && { file_name: info.file_name }),
          ...(info.video_url && { video_url: info.video_url }),
        });
        updatedCount++;
      }
      if (updatedCount > 0) {
        console.log(`[WorkflowEditor] Auto-rescan: ${updatedCount}/${brokenIds.size} broken thumbs recovered`);
        // 2026-05-31: re-render TẤT CẢ ref preview inputs (trước chỉ first match) — workflow
        // có thể có nhiều node types open form khác nhau.
        const refInputSelectors = ['#nodeRefFileIds', '#promptNodeRefFileIds',
          '#chatgptImageRefFileIds', '#grokNodeRefFileIds', '#imageNodeRefFileIds'];
        for (const sel of refInputSelectors) {
          const inp = this.overlay?.querySelector(sel);
          if (inp?.value) {
            try { this._renderNodeRefPreview(inp.value); } catch (_) {}
          }
        }
        // Re-render all node cards trên canvas
        for (const node of Object.values(homeData)) {
          const refStr = node?.data?.ref_file_ids || '';
          if (refStr) {
            const ids = refStr.split(',').map(s => s.trim()).filter(Boolean);
            try { this._showNodeRefPreview(node.data.node_id, ids); } catch (_) {}
          }
        }
      }
    } catch (e) {
      console.warn('[WorkflowEditor] Auto-rescan failed (non-blocking):', e?.message);
    }
  }

  bindGlobalEvents() {
    // S2.5: beforeunload — cảnh báo khi đóng popup window mà có thay đổi chưa lưu hoặc upload đang chạy
    // Read-only mode KHÔNG cảnh báo (workflow không thể edit nên không có "unsaved changes")
    // "Opened to view running" mode KHÔNG cảnh báo (user mở từ sidebar để xem status, không edit)
    this._beforeUnloadHandler = (e) => {
      if (this.isReadOnly()) return;
      // Skip warning nếu editor được mở để xem workflow đang chạy (từ sidebar view button)
      // KHÔNG skip nếu user run workflow từ chính editor (có thể có unsaved changes trước khi run)
      if (this._openedToViewRunning) return;
      const activeCount = this._countActiveFormUploads();
      if (activeCount > 0 || this._hasUnsavedChanges) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', this._beforeUnloadHandler);

    if (window.eventBus) {
      // Store handler references for cleanup in _forceClose()
      this._ebHandlers = {};
      // Phase enhancement: Click select node KHÔNG auto-mở form (chỉ select highlight).
      // User click gear icon trong hover toolbar → mới mở form qua 'node:open_settings' event.
      this._ebHandlers['node:selected'] = (data) => {
        this.selectedNodeId = data.nodeId;
        // UI 2026-05-27: highlight connection của node đang select (đổi màu bright theo type).
        try { this._setNodeConnectionsSelected(data.nodeId); } catch (e) {}
        // Reset form dirty flag (đảm bảo state clean)
        try { this._missingRefWarned = false; } catch (e) {}
      };
      this._ebHandlers['node:open_settings'] = (data) => this._handleNodeSelected(data.nodeId);
      this._ebHandlers['node:unselected'] = () => this._handleNodeUnselected();
      window.eventBus.on('node:selected', this._ebHandlers['node:selected']);
      window.eventBus.on('node:unselected', this._ebHandlers['node:unselected']);
      window.eventBus.on('node:open_settings', this._ebHandlers['node:open_settings']);

      this._ebHandlers['edge:created'] = (data) => {
        this._hasUnsavedChanges = true;
        this.handleEdgeCreated(data.connection, data.sourcePort, data.targetPort);
        // Phase WK-1.5.3: refresh warning badges sau khi connection thay đổi
        try { this._scheduleRefreshNodeWarningBadges(); } catch (e) {}
        try { this._refreshAllPromptSourceBadges(); } catch (e) {}
        // Phase WK-1.2 enhancement: update data-port-empty cho UI hint
        try { this._updatePortEmptyState(); } catch (e) {}
        // Update ref_mode visibility when connection count changes
        try { this._updateRefModeVisibility(); } catch (e) {}
      };
      this._ebHandlers['edge:removed'] = (data) => {
        this._hasUnsavedChanges = true;
        this.handleEdgeRemoved(data.connection);
        try { this._scheduleRefreshNodeWarningBadges(); } catch (e) {}
        try { this._refreshAllPromptSourceBadges(); } catch (e) {}
        try { this._updatePortEmptyState(); } catch (e) {}
        // Update ref_mode visibility when connection count changes
        try { this._updateRefModeVisibility(); } catch (e) {}
      };
      this._ebHandlers['node:removed'] = (data) => {
        this._hasUnsavedChanges = true;
        this.handleNodeRemoved(data.nodeId);
        // CRITICAL: Drawflow KHÔNG cleanup connection refs trong inputs/outputs của peer nodes
        // khi xóa node → A.outputs.output_1.connections vẫn trỏ tới B (đã xóa) → port hiển thị
        // "có link" nhưng click không mở picker. Tự cleanup dead refs từ peer nodes.
        try { this._cleanupDeadConnectionRefs(data.nodeId); } catch (e) {}
        try { this._scheduleRefreshNodeWarningBadges(); } catch (e) {}
        try { this._refreshAllPromptSourceBadges(); } catch (e) {}
        try { this._updatePortEmptyState(); } catch (e) {}
      };
      this._ebHandlers['node:moved'] = () => {
        this._hasUnsavedChanges = true;
        // Re-apply connection-active class cho mọi node đang running — defensive fix nếu
        // Drawflow updateConnectionNodes có side effect làm mất class CSS.
        try { this._reapplyRunningConnections(); } catch (e) { /* ignore */ }
      };
      window.eventBus.on('edge:created', this._ebHandlers['edge:created']);
      window.eventBus.on('edge:removed', this._ebHandlers['edge:removed']);
      window.eventBus.on('node:removed', this._ebHandlers['node:removed']);
      window.eventBus.on('node:moved', this._ebHandlers['node:moved']);

      // Phase WK-1.6.3: workflow cũ load lên → DiagramCanvas tự động migrate edges
      // → mark hasUnsavedChanges để user save sẽ persist port info vào storage/backend
      this._ebHandlers['workflow:edges_migrated'] = (data) => {
        this._hasUnsavedChanges = true;
        console.log(`[WorkflowEditor] ${data?.count || 0} legacy edges migrated to typed ports`);
      };
      window.eventBus.on('workflow:edges_migrated', this._ebHandlers['workflow:edges_migrated']);

      // WK-1.7.frame-sync: DiagramCanvas connect/disconnect frame_X port →
      // node.data thay đổi → re-render dropdown form nếu đang mở form node đó.
      this._ebHandlers['node:data_changed'] = (data) => {
        this._hasUnsavedChanges = true;
        try { this._refreshFrameDropdownsForNode(data?.drawflowId, data?.changedFields); } catch (e) { /* ignore */ }
      };
      window.eventBus.on('node:data_changed', this._ebHandlers['node:data_changed']);

      // Right-click vùng trống diagram → mở context menu mirror toolbar.
      this._ebHandlers['canvas:contextmenu'] = (data) => {
        this._showCanvasContextMenu(data?.clientX || 0, data?.clientY || 0, data?.canvasX, data?.canvasY);
      };
      window.eventBus.on('canvas:contextmenu', this._ebHandlers['canvas:contextmenu']);

      // Issue 3 fix: DiagramCanvas yêu cầu persist frame sync data ngay
      // (avoid lost data khi user đóng editor mà chưa Save).
      this._ebHandlers['frame:sync_persist_request'] = async (data) => {
        try {
          // Template mode: KHÔNG persist vì workflow chưa tồn tại trong DB
          if (this.isTemplateMode) {
            this._hasUnsavedChanges = true;
            return;
          }
          const wfId = this.workflow?.wf_id;
          const nodeId = data?.nodeId;
          const frameData = data?.frameData;
          if (!wfId || !nodeId || !frameData) return;
          if (!window.storageManager?.updateNodeStatus) return;
          await window.storageManager.updateNodeStatus(wfId, nodeId, frameData);
        } catch (e) {
          console.warn('[WorkflowEditor] Failed to persist frame sync:', e?.message);
        }
      };
      window.eventBus.on('frame:sync_persist_request', this._ebHandlers['frame:sync_persist_request']);

      // Execution events - realtime node status
      this._ebHandlers['node:started'] = (data) => {
        console.log(`[WorkflowEditor] node:started event received: nodeId=${data.node?.node_id}, nodeType=${data.node?.node_type}`);
        this._syncDrawflowNodeData(data.node?.node_id, { status: 'running' });
        this._updateNodeStatusUI(data.node?.node_id, 'running');
        this._disableFormIfSelectedNode(data.node?.node_id, true);
        this._refreshResultTabIfSelected(data.node?.node_id, 'running');
        // Prompt + text_extract: clear old result preview khi re-run.
        // 2026-05-31: thêm text_extract — _clearPromptNodeResultPreview xóa cả 2 (selector
        // `.df-ai-output-container` match cả prompt và extract output).
        if (data.node?.node_type === 'prompt' || data.node?.node_type === 'text_extract') {
          this._clearPromptNodeResultPreview(data.node.node_id);
        }
      };
      window.eventBus.on('node:started', this._ebHandlers['node:started']);
      this._ebHandlers['node:submitted'] = (data) => this._updateNodeLoadingText(data.node?.node_id, window.I18n?.t('workflow.waitingForResult') || 'Waiting for results...');
      window.eventBus.on('node:submitted', this._ebHandlers['node:submitted']);
      // 2026-05-25: phase text update cho generate/chatgpt/grok (submitting → generating → downloading → uploading)
      this._ebHandlers['node:phase'] = (data) => {
        const phase = data?.phase;
        const nodeId = data?.nodeId;
        if (!phase || !nodeId) return;
        const i18nKey = `node.phase.${phase}`;
        const fallback = { submitting: 'Đang gửi prompt...', generating: 'Đang gen ảnh/video...', downloading: 'Đang tải kết quả...', uploading: 'Đang upload ảnh lên Flow...' }[phase] || 'Đang xử lý...';
        const text = window.I18n?.t(i18nKey) || fallback;
        this._updateNodeLoadingText(nodeId, text);
      };
      window.eventBus.on('node:phase', this._ebHandlers['node:phase']);
      this._ebHandlers['node:completed'] = async (data) => {
        // Guard: ignore events that arrive after workflow reset (race condition fix)
        if (this._resetInProgress) return;

        const fileIdsStr = data.result?.fileIds ? data.result.fileIds.join(',') : '';
        const nodeId = data.node?.node_id;
        console.log(`[WorkflowEditor] node:completed event: nodeId=${nodeId}, nodeType=${data.node?.node_type}, fileIds=${fileIdsStr.substring(0, 50)}`);
        const syncData = { status: 'completed', result_file_ids: fileIdsStr };
        // Sync media_type/gen_type for video detection in download
        if (data.node?.media_type) syncData.media_type = data.node.media_type;
        if (data.node?.gen_type) syncData.gen_type = data.node.gen_type;
        // Phase CG-8 — Prompt node: sync result_text vào drawflow data để
        // downstream node trong cùng session đọc được mà không cần reload từ DB.
        if (typeof data.node?.result_text === 'string') syncData.result_text = data.node.result_text;
        if (typeof data.node?.result_source === 'string') syncData.result_source = data.node.result_source;
        // Dual URL — sync result_provider_urls (ChatGPT/Grok) → Result tab hiển thị nút
        // "Tải bản gốc". Trước fix: drawflow data thiếu field này → providerCount=0 → nút ẩn.
        if (data.node?.result_provider_urls && typeof data.node.result_provider_urls === 'object'
            && Object.keys(data.node.result_provider_urls).length > 0) {
          syncData.result_provider_urls = { ...data.node.result_provider_urls };
        }
        this._syncDrawflowNodeData(nodeId, syncData);
        this._updateNodeStatusUI(nodeId, 'completed');
        this._showNodePreview(nodeId, data.result?.fileIds);
        // Bug fix: sau khi run xong, ref preview thumbnail ở bottom node card có thể mất
        // (innerHTML re-render hoặc state sync). Re-render từ ref_file_ids của node hiện tại.
        // ChatGPT/Grok/Generate đều có ref input → đảm bảo persist sau run.
        try {
          const dfNode = this.diagramCanvas?.editor?.getNodeFromId?.(this._findDrawflowId(nodeId));
          const nodeType = dfNode?.data?.node_type || dfNode?.class;
          if (['generate', 'chatgpt', 'grok'].includes(nodeType)) {
            const refIdsStr = dfNode?.data?.ref_file_ids || '';
            const refIds = refIdsStr.split(',').map((s) => s.trim()).filter(Boolean);
            if (refIds.length > 0 && typeof this._showNodeRefPreview === 'function') {
              this._showNodeRefPreview(nodeId, refIds);
            }
          }
          // Prompt node: update result preview in diagram after AI run completes.
          // 2026-05-31 fix: dùng use_ai (key mới) thay vì enhance (legacy) — sau AI Agent rename
          // node.use_ai là source of truth, data.enhance có thể stale/undefined.
          if (nodeType === 'prompt' && dfNode?.data?.use_ai) {
            this._updatePromptNodeResultPreview(nodeId, dfNode.data);
          }
          // 2026-05-31: text_extract node — render extracted text trên card (parity prompt node).
          if (nodeType === 'text_extract') {
            this._updateExtractNodeResultPreview(nodeId, dfNode.data);
          }
        } catch (e) { /* ignore */ }
        this._refreshResultTabIfSelected(nodeId, 'completed', data.result?.fileIds);
        this._disableFormIfSelectedNode(nodeId, false);
        this._updateDownloadButton();
        this._updateResetSingleNodeButton();
        this._updateHoverToolbarDownload(nodeId, data.result?.fileIds);

        // Persist thumbnails + file_names từ result (đã capture sẵn trong waitForNewTiles)
        const resultThumbs = data.result?.thumbnails || {};
        if (Object.keys(resultThumbs).length > 0) {
          const thumbMap = {};
          const fileNameMap = {};
          for (const [fid, info] of Object.entries(resultThumbs)) {
            if (info?.thumbnail) {
              const type = info.type || 'image';
              // Persist type + video_url for video detection and playback after reload (Bug 51 fix)
              thumbMap[fid] = type === 'video'
                ? { thumbnail: info.thumbnail, type: 'video', ...(info.video_url && { video_url: info.video_url }) }
                : info.thumbnail;
              this._tileCacheSet(fid, { thumbnail: info.thumbnail, type, ...(info.video_url && { video_url: info.video_url }) });
            }
            if (info?.file_name) {
              fileNameMap[fid] = info.file_name;
            }
          }
          if (Object.keys(thumbMap).length > 0) {
            this._persistNodeThumbnails(nodeId, thumbMap);
            console.log('[TobyFlow] Persisted', Object.keys(thumbMap).length, 'result thumbnails for', nodeId);
          }
          if (Object.keys(fileNameMap).length > 0) {
            this._persistNodeFileNames(nodeId, fileNameMap);
            // Also sync to drawflow data for download access
            this._syncDrawflowNodeData(nodeId, { result_file_names: { ...fileNameMap } });
            console.log('[TobyFlow] Persisted', Object.keys(fileNameMap).length, 'result file_names for', nodeId);
          }
        }
        // Also persist file_names from result.fileNames (extracted separately by WorkflowExecutor)
        const resultFileNames = data.result?.fileNames || {};
        if (Object.keys(resultFileNames).length > 0) {
          this._persistNodeFileNames(nodeId, resultFileNames);
          this._syncDrawflowNodeData(nodeId, { result_file_names: { ...resultFileNames } });
        }

        let fallbackThumbMap = null;
        if (Object.keys(resultThumbs).length === 0 && data.result?.fileIds?.length > 0 && typeof MessageBridge !== 'undefined') {
          // Fallback: scan nếu thumbnails không có sẵn trong result
          try {
            const scanResult = await MessageBridge.getThumbnailsByIds(data.result.fileIds);
            const results = scanResult?.results || {};
            const thumbMap = {};
            for (const [fid, info] of Object.entries(results)) {
              if (info?.thumbnail) {
                const type = info.type || 'image';
                // Bug 51 fix: Include video_url for video playback
                thumbMap[fid] = type === 'video'
                  ? { thumbnail: info.thumbnail, type: 'video', ...(info.video_url && { video_url: info.video_url }) }
                  : info.thumbnail;
                this._tileCacheSet(fid, { thumbnail: info.thumbnail, type, ...(info.video_url && { video_url: info.video_url }) });
              }
            }
            if (Object.keys(thumbMap).length > 0) {
              this._persistNodeThumbnails(nodeId, thumbMap);
              fallbackThumbMap = thumbMap;
              console.log('[TobyFlow] Persisted (fallback)', Object.keys(thumbMap).length, 'thumbnails for', nodeId);
            }
          } catch (e) {
            console.warn('[TobyFlow] Fallback scan thumbnails failed:', e.message);
          }
        }

        // [API SPAM FIX — Phase 1.3] Bỏ auto-save toàn workflow (`this.saveWorkflow()`) sau
        // node:completed. WorkflowExecutor `_updateNodeStatus(completed, ...)` đã PATCH node
        // với result_file_ids + result_thumbnails + result_file_names + result_provider_urls
        // qua extra param (line ~856, 1078 WorkflowExecutor.js). Backend đã có data đầy đủ.
        // Final workflow state persist qua _updateWorkflowStatus('completed') ở cuối execute().
        // Reduces ~5 PUT calls per 5-node workflow.
        //
        // EDGE CASE — fallback scan thumbnails (line ~350-368): nếu result.thumbnails empty
        // và scan tìm thấy thumbnails mới → cần PATCH delta để backend nhận. Tránh PUT toàn
        // workflow chỉ vì 1 thumbnail update.
        if (fallbackThumbMap && window.storageManager && this.workflow?.wf_id) {
          window.storageManager.updateNodeStatus(this.workflow.wf_id, nodeId, {
            result_thumbnails: fallbackThumbMap,
          }).catch((err) => console.warn('[TobyFlow] Persist fallback thumbnails failed:', err?.message));
        }
      };
      window.eventBus.on('node:completed', this._ebHandlers['node:completed']);
      this._ebHandlers['node:failed'] = (data) => {
        if (this._resetInProgress) return;
        this._syncDrawflowNodeData(data.node?.node_id, { status: 'failed', error_message: data.error?.message || '' });
        this._updateNodeStatusUI(data.node?.node_id, 'failed');
        this._refreshResultTabIfSelected(data.node?.node_id, 'failed', null, data.error?.message);
        this._disableFormIfSelectedNode(data.node?.node_id, false);
        this._updateResetSingleNodeButton();
        // [API SPAM FIX — Phase 1.3] Bỏ auto-save sau node:failed. WorkflowExecutor
        // _updateNodeStatus('failed', null, errorMessage) đã PATCH node với error_message
        // (line ~936, 1157). Auto-save trùng lặp → bỏ.
      };
      window.eventBus.on('node:failed', this._ebHandlers['node:failed']);
      this._ebHandlers['node:warning'] = (data) => {
        this._updateNodeStatusUI(data.node?.node_id, 'skipped');
        this._addLogEntry(`${data.node?.node_name}: ${data.message}`, 'warn');
      };
      window.eventBus.on('node:warning', this._ebHandlers['node:warning']);
      this._ebHandlers['execution:log'] = (data) => {
        // Chi tiết log từ executor: cài đặt, ref images, prompt, kết quả
        const nodeName = this._getNodeNameById(data.nodeId);
        const prefix = nodeName ? `${nodeName}: ` : '';
        this._addLogEntry(`${prefix}${data.message}`, data.type || 'info');
      };
      window.eventBus.on('execution:log', this._ebHandlers['execution:log']);
      // Upload xong → replace upload_xxx bằng real file IDs trong Drawflow + node form
      this._ebHandlers['node:ref_replaced'] = async (data) => {
        const { nodeId, newRefIds, refFileNames, refThumbnails } = data;
        if (!nodeId || !newRefIds) return;

        // Sync ref_file_ids + ref_file_names + ref_thumbnails vào Drawflow (để persist khi save)
        const syncData = { ref_file_ids: newRefIds };
        if (refFileNames && Object.keys(refFileNames).length > 0) {
          syncData.ref_file_names = refFileNames;
        }
        if (refThumbnails && Object.keys(refThumbnails).length > 0) {
          syncData.ref_thumbnails = refThumbnails;
        }
        this._syncDrawflowNodeData(nodeId, syncData);

        // Scan ref thumbnails trực tiếp theo file IDs (bổ sung cho refThumbnails từ executor)
        const refIds = newRefIds.split(',').map(s => s.trim()).filter(Boolean);

        // Cache thumbnails từ executor data trước (đồng bộ, không cần async scan)
        if (refThumbnails) {
          for (const [fid, thumb] of Object.entries(refThumbnails)) {
            if (thumb) this._tileCacheSet(fid, { thumbnail: thumb, type: 'image' });
          }
          this._persistRefThumbnailsMap(nodeId, refThumbnails);
        }

        // Async scan bổ sung (cập nhật thumbnail mới nhất từ DOM)
        if (refIds.length > 0 && typeof MessageBridge !== 'undefined') {
          try {
            const scanResult = await MessageBridge.getThumbnailsByIds(refIds);
            const results = scanResult?.results || {};
            const thumbMap = {};
            for (const [fid, info] of Object.entries(results)) {
              if (info?.thumbnail) {
                thumbMap[fid] = info.thumbnail;
                this._tileCacheSet(fid, { thumbnail: info.thumbnail, type: 'image' });
              }
            }
            if (Object.keys(thumbMap).length > 0) {
              this._persistRefThumbnailsMap(nodeId, thumbMap);
            }
          } catch (e) {}
        }
        // Update node form nếu đang mở node này
        if (this.selectedNodeId) {
          const selectedNode = this.diagramCanvas?.editor?.getNodeFromId(this.selectedNodeId);
          if (selectedNode?.data?.node_id === nodeId) {
            const fileIdsInput = this.overlay?.querySelector('#nodeRefFileIds');
            if (fileIdsInput) {
              fileIdsInput.value = newRefIds;
              // Re-render ref preview với IDs mới
              const containerSel = selectedNode.class === 'image' ? '#imageNodeRefPreview' : '#nodeRefImagesPreview';
              this._renderNodeRefPreview(newRefIds, containerSel);
            }
          }
        }
        // Update ref preview trên canvas
        this._showNodeRefPreview(nodeId, refIds);
      };
      window.eventBus.on('node:ref_replaced', this._ebHandlers['node:ref_replaced']);

      this._ebHandlers['execution:progress'] = (data) => this._updateProgressUI(data);
      this._ebHandlers['execution:started'] = () => this._onExecutionStarted();
      this._ebHandlers['execution:completed'] = async (data) => this._onExecutionCompleted(data);
      window.eventBus.on('execution:progress', this._ebHandlers['execution:progress']);
      window.eventBus.on('execution:started', this._ebHandlers['execution:started']);
      window.eventBus.on('execution:completed', this._ebHandlers['execution:completed']);

      this._ebHandlers['workflow:reset'] = () => {
        if (window.workflowExecutor) {
          window.workflowExecutor.isRunning = false;
          window.workflowExecutor.shouldStop = true;
          window.workflowExecutor.currentWorkflow = null;
        }
        this._syncExecutionUI();
      };
      window.eventBus.on('workflow:reset', this._ebHandlers['workflow:reset']);

      // Render preview cho node vừa copy
      this._ebHandlers['node:duplicated'] = (data) => {
        const { drawflowId, data: nodeData } = data;
        const nodeId = nodeData?.node_id;
        if (!nodeId) return;
        // Render result preview (canvas)
        const resultIds = (nodeData.result_file_ids || '').split(',').filter(Boolean);
        if (resultIds.length > 0) {
          this._showNodePreview(nodeId, resultIds);
        }
        // Render ref preview (bottom thumbnails)
        const refIds = (nodeData.ref_file_ids || '').split(',').filter(Boolean);
        if (refIds.length > 0) {
          this._showNodeRefPreview(nodeId, refIds);
        }
        // Phase WK-1.5.3: refresh warning badges sau khi duplicate
        try { this._scheduleRefreshNodeWarningBadges(); } catch (e) {}
        try { this._refreshAllPromptSourceBadges(); } catch (e) {}
        try { this._updatePortEmptyState(); } catch (e) {}
        try { this._bindInlineSettingPills(); } catch (e) {}
      };
      window.eventBus.on('node:duplicated', this._ebHandlers['node:duplicated']);

      // v1.1 Node clipboard: nhận event từ DiagramCanvas right-click "Copy node" action
      this._ebHandlers['node:copy_to_clipboard'] = (data) => {
        try { this._copyNodeToClipboard(data?.nodeId); } catch (err) {
          console.warn('[WorkflowEditor] copy node to clipboard failed:', err?.message);
        }
      };
      window.eventBus.on('node:copy_to_clipboard', this._ebHandlers['node:copy_to_clipboard']);

      // Bind gear icon + inline pills cho node mới được Drawflow tạo
      // (reliable hơn rAF sau addNode vì fires sau khi Drawflow render xong DOM)
      this._ebHandlers['node:created'] = (data) => {
        try { this._bindInlineSettingPills(); } catch (e) {}
        try { this._updatePortEmptyState(); } catch (e) {}
        // Image node fit-content size → cần re-route connections mỗi khi
        // ảnh thay đổi (replace ref, reset, image load async). ResizeObserver
        // tự fire khi node card resize → schedule connection refresh.
        try { this._attachImageNodeResizeObserver(data?.drawflowId); } catch (e) {}
      };
      window.eventBus.on('node:created', this._ebHandlers['node:created']);

      // Sync toggle from canvas to node form
      this._ebHandlers['node:toggled'] = (data) => {
        if (this.selectedNodeId === String(data.nodeId)) {
          const checkbox = this.overlay?.querySelector('#nodeEnabled');
          if (checkbox) checkbox.checked = data.enabled;
        }
      };
      window.eventBus.on('node:toggled', this._ebHandlers['node:toggled']);

      // Listen for featuregate changes to update auto_download toggle in node form + quota display
      this._ebHandlers['featuregate:refreshed'] = () => {
        this._updateNodeFeatureToggles();
        this._updateQuotaDisplay();
        // Bug 30 fix: Targeted DOM patch cho toolbar export/share lock state khi entitlements thay đổi.
        try { this._updateToolbarLockStates(); } catch (e) { /* noop */ }
        // Targeted DOM patch cho gate banner — KHÔNG re-render full form (giữ user input chưa save)
        if (this.selectedNodeId) {
          try {
            const drawflowId = (this._findDrawflowId && this._findDrawflowId(this.selectedNodeId)) || this.selectedNodeId;
            const node = this.diagramCanvas?.editor?.getNodeFromId(drawflowId);
            const type = node?.class || node?.data?.node_type;
            if (type === 'chatgpt' || type === 'prompt') {
              try { this._patchNodeFormGateBanners(type); } catch (e) { /* noop */ }
            }
          } catch (e) { /* noop */ }
        }
      };
      window.eventBus.on('featuregate:refreshed', this._ebHandlers['featuregate:refreshed']);

      // Admin update workflow node types qua /admin/workflow-node-types → re-render UI
      this._ebHandlers['node_types:refreshed'] = async (data) => {
        console.log('[WorkflowEditor] node_types:refreshed handler fire', data);
        try {
          // Force re-fetch types từ backend (SseClient đã clear cache)
          await window.NodeTemplates?.fetchFromServer?.();
          // Re-render node settings form nếu đang mở
          if (this.selectedNodeId && this.overlay && !this.overlay.classList.contains('hidden')) {
            this._handleNodeSelected(this.selectedNodeId);
          }
          // Reset node picker nếu đang mở
          this._hideNodePicker?.();
          if (window.TobyNotify?.info) {
            window.TobyNotify.info(window.I18n?.t('workflow.nodeTypesRefreshed') || 'Đã cập nhật node types');
          }
        } catch (e) {
          console.warn('[WorkflowEditor] node_types:refreshed handler error:', e?.message);
        }
      };
      window.eventBus.on('node_types:refreshed', this._ebHandlers['node_types:refreshed']);
      console.log('[WorkflowEditor] Bound node_types:refreshed listener');

      // Bug 32 fix (2026-05-19): Admin update provider ratios / download_resolutions →
      // re-render node settings form đang mở (nếu node có dropdown affected).
      // Supports: flow, chatgpt, grok
      this._ebHandlers['provider:api_config_updated'] = ({ provider, key, type, value }) => {
        console.log(`[WorkflowEditor] provider:api_config_updated received:`, { provider, key, type, value: value ? 'present' : 'empty' });
        // Only handle relevant providers
        if (!['flow', 'chatgpt', 'grok'].includes(provider)) {
          console.log(`[WorkflowEditor] provider:api_config_updated - skip provider ${provider}`);
          return;
        }
        // Only handle relevant config keys
        if (key !== 'ratios' && key !== 'download_resolutions' && key !== 'quantity_range') {
          console.log(`[WorkflowEditor] provider:api_config_updated - skip key ${key}`);
          return;
        }
        if (!this.selectedNodeId || !this.overlay) {
          console.log(`[WorkflowEditor] provider:api_config_updated - no selected node or overlay`);
          return;
        }
        if (this.overlay.classList.contains('hidden')) {
          console.log(`[WorkflowEditor] provider:api_config_updated - overlay hidden`);
          return;
        }
        console.log(`[WorkflowEditor] provider:api_config_updated - will re-render ${provider}.${key}`);
        try {
          // Re-render settings form để dropdowns + qty buttons đọc fresh PCM data
          this._handleNodeSelected(this.selectedNodeId);
        } catch (e) {
          console.warn('[WorkflowEditor] provider:api_config_updated handler error:', e?.message);
        }
      };
      window.eventBus.on('provider:api_config_updated', this._ebHandlers['provider:api_config_updated']);

      // Bug 32 fix: Admin add/remove/rename model qua /admin/provider-models →
      // re-render settings form (Download node model dropdowns).
      this._ebHandlers['provider:models_updated'] = () => {
        if (!this.selectedNodeId || !this.overlay) return;
        if (this.overlay.classList.contains('hidden')) return;
        try {
          this._handleNodeSelected(this.selectedNodeId);
        } catch (e) {
          console.warn('[WorkflowEditor] provider:models_updated handler error:', e?.message);
        }
      };
      window.eventBus.on('provider:models_updated', this._ebHandlers['provider:models_updated']);

      // Bug 41 fix (2026-05-13): Admin tweak quantity_min/max qua /admin/validation-rules →
      // re-render settings form (Flow generate quantity input + inline dropdown range).
      this._ebHandlers['validation_rules:updated'] = () => {
        if (!this.selectedNodeId || !this.overlay) return;
        if (this.overlay.classList.contains('hidden')) return;
        try {
          this._handleNodeSelected(this.selectedNodeId);
        } catch (e) {
          console.warn('[WorkflowEditor] validation_rules:updated handler error:', e?.message);
        }
      };
      window.eventBus.on('validation_rules:updated', this._ebHandlers['validation_rules:updated']);

      // Bug 42c fix (2026-05-13): Initial PCM fetch arrived sau khi right sidebar đã render
      // với stale defaults → re-render selected node để ratios/download_resolutions hiện đúng.
      this._ebHandlers['provider:api_configs_loaded'] = () => {
        if (!this.selectedNodeId || !this.overlay) return;
        if (this.overlay.classList.contains('hidden')) return;
        try {
          this._handleNodeSelected(this.selectedNodeId);
        } catch (e) {
          console.warn('[WorkflowEditor] provider:api_configs_loaded handler error:', e?.message);
        }
      };
      window.eventBus.on('provider:api_configs_loaded', this._ebHandlers['provider:api_configs_loaded']);

      // Provider metadata (name) updated via SSE → update labels in settings form + node headers
      this._ebHandlers['provider:updated'] = (data) => {
        console.log('[WorkflowEditor] provider:updated event received:', data);
        this._updateProviderLabels();
        // Re-render settings form if open (to update names)
        if (this.selectedNodeId && this.overlay && !this.overlay.classList.contains('hidden')) {
          console.log('[WorkflowEditor] Re-rendering selected node settings');
          try {
            this._handleNodeSelected(this.selectedNodeId);
          } catch (e) {
            console.warn('[WorkflowEditor] provider:updated handler error:', e?.message);
          }
        }
      };
      window.eventBus.on('provider:updated', this._ebHandlers['provider:updated']);
      window.eventBus.on('provider:meta_loaded', this._ebHandlers['provider:updated']);
      console.log('[WorkflowEditor] Bound provider:updated + provider:meta_loaded listeners');

      console.log('[WorkflowEditor] Bound provider:api_config_updated + provider:models_updated + validation_rules:updated + provider:api_configs_loaded + provider:updated listeners');
    }
  }

  /**
   * Update feature-gated toggles in currently open node form
   */
  _updateNodeFeatureToggles() {
    const canUse = window.featureGate?.canUse('auto_download') ?? false;

    // Generate/List node: auto_download toggle
    const nodeAutoDownload = this.overlay?.querySelector('#nodeAutoDownload');
    if (nodeAutoDownload) {
      const label = nodeAutoDownload.closest('.toolbar-toggle');
      if (label) {
        if (canUse) {
          nodeAutoDownload.disabled = false;
          label.classList.remove('feature-disabled');
          label.removeAttribute('title');
          (label.querySelector('.premium-crown') || label.parentElement?.querySelector('.premium-crown'))?.remove();
        } else {
          nodeAutoDownload.disabled = true;
          nodeAutoDownload.checked = false;
          label.classList.add('feature-disabled');
          label.setAttribute('title', window.I18n?.t('workflow.featureDisabled') || 'Tính năng này yêu cầu gói Premium');
          // Add crown icon
          if (typeof window._ensurePremiumCrown === 'function') {
            window._ensurePremiumCrown(label);
          }
          // Hide resolution wrappers
          this.overlay?.querySelector('#nodeDownloadResWrap')?.classList.add('hidden');
          this.overlay?.querySelector('#nodeVideoDownloadResWrap')?.classList.add('hidden');
        }
      }
    }

    // Download node: gate warning banner
    const downloadGate = this.overlay?.querySelector('#nodeDownloadGate');
    if (downloadGate) {
      downloadGate.classList.toggle('hidden', canUse);
    }

    // Telegram node: gate warning banner
    const telegramGate = this.overlay?.querySelector('#nodeTelegramGate');
    if (telegramGate) {
      const canUseTelegram = (window.featureGate?.canUse('telegram_enabled') ?? false) &&
        (window.featureGate?.canUse('telegram_workflow') ?? false);
      telegramGate.classList.toggle('hidden', canUseTelegram);
    }
  }

  /**
   * Bug 30 fix (2026-05-19): Update toolbar lock state cho share + export buttons khi
   * entitlements thay đổi (vd user upgrade plan qua admin push SSE).
   * Targeted DOM patch — KHÔNG re-render full toolbar.
   */
  _updateToolbarLockStates() {
    if (!this.overlay) return;

    // Map: button data-action → feature key + lock SVG + normal SVG
    const buttons = [
      {
        action: 'share-workflow',
        featureKey: 'workflow_share_enabled',
        normalSvg: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>',
      },
      {
        action: 'export-workflow',
        featureKey: 'workflow_export',
        normalSvg: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
      },
    ];
    const lockSvg = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--warning, #f59e0b)" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>';

    for (const { action, featureKey, normalSvg } of buttons) {
      const btn = this.overlay.querySelector(`.tobyflow-wf-tool-btn[data-action="${action}"]`);
      if (!btn) continue;
      const canUse = window.featureGate?.canUse(featureKey) ?? false;
      btn.classList.toggle('tobyflow-wf-tool-btn--locked', !canUse);
      btn.innerHTML = canUse ? normalSvg : lockSvg;
    }
  }

  /**
   * Targeted DOM patch cho gate banner trong node form (chatgpt, prompt).
   * KHÔNG re-render full form → giữ nguyên user input chưa save (textarea/input).
   * Idempotent — gọi nhiều lần OK.
   */
  _patchNodeFormGateBanners(type) {
    const formPanel = this.overlay?.querySelector('#nodeFormPanel');
    if (!formPanel || formPanel.classList.contains('hidden')) return;

    if (type === 'chatgpt') {
      const banner = formPanel.querySelector('#chatgptImageGateBanner');
      const canUseChatGPT = !!(window.featureGate?.canUse?.('chatgpt_enabled'));
      if (banner) {
        banner.classList.toggle('hidden', canUseChatGPT);
      }
      // Nếu banner chưa tồn tại nhưng giờ cần show → skip (rare case, sẽ render đúng lần mở form sau)
    }

    if (type === 'prompt') {
      // AI Agent rename (2026-05-30): canUseAiAgent() check key 'ai_agent_enabled' duy nhất.
      const canEnhance = !!(window.featureGate?.canUseAiAgent?.());
      const canChatGPT = !!(window.featureGate?.canUse?.('chatgpt_enabled'));
      const canGemini = !!(window.featureGate?.canUse?.('gemini_enabled'));

      // Toggle use_ai checkbox + label crown
      const enhanceCb = formPanel.querySelector('#promptNodeUseAi');
      const enhanceLabel = enhanceCb?.closest('label.toolbar-toggle');
      if (enhanceCb && enhanceLabel) {
        enhanceCb.disabled = !canEnhance;
        enhanceLabel.classList.toggle('feature-disabled', !canEnhance);
        if (!canEnhance) {
          enhanceLabel.setAttribute(
            'title',
            window.I18n?.t?.('workflow.featureDisabled') || 'Tính năng này yêu cầu gói Premium'
          );
        } else {
          enhanceLabel.removeAttribute('title');
        }
        // Crown badge inject/remove — 2026-05-30: crown icon + premium-only label
        const crown = enhanceLabel.querySelector('.premium-crown');
        if (!canEnhance && !crown) {
          const span = document.createElement('span');
          span.className = 'premium-crown';
          span.style.marginLeft = '6px';
          const premiumLabel = window.I18n?.t?.('workflow.useAiPremiumOnly') || 'Chỉ hoạt động với tài khoản Premium';
          span.title = premiumLabel;
          span.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="none" style="vertical-align: -2px; margin-right: 3px;"><path d="M5 16L3 7l5.5 4L12 4l3.5 7L21 7l-2 9H5zm0 2h14v2H5v-2z"/></svg>${premiumLabel}`;
          enhanceLabel.appendChild(span);
        } else if (canEnhance && crown) {
          crown.remove();
        }
      }

      // Toggle provider select options (chatgpt / gemini)
      const providerSel = formPanel.querySelector('#promptNodeProvider');
      if (providerSel) {
        const cgOpt = providerSel.querySelector('option[value="chatgpt"]');
        const gmOpt = providerSel.querySelector('option[value="gemini"]');
        if (cgOpt) {
          cgOpt.disabled = !canChatGPT;
          const cgName = window.ProviderMeta?.getName?.('chatgpt') || 'ChatGPT';
          cgOpt.textContent = canChatGPT ? cgName : `${cgName} (Pro)`;
        }
        if (gmOpt) {
          gmOpt.disabled = !canGemini;
          const gmName = window.ProviderMeta?.getName?.('gemini') || 'Gemini';
          gmOpt.textContent = canGemini ? gmName : `${gmName} (Pro)`;
        }
      }
    }
  }

  /**
   * Update provider labels throughout WorkflowEditor when ProviderMeta changes.
   * Called via SSE provider:updated event.
   */
  _updateProviderLabels() {
    const PM = window.ProviderMeta;
    if (!PM) return;

    console.log('[WorkflowEditor] _updateProviderLabels called');

    // Update provider select options in right sidebar (prompt node settings) - names only
    const providerSel = this.overlay?.querySelector('#promptNodeProvider');
    if (providerSel) {
      const cgOpt = providerSel.querySelector('option[value="chatgpt"]');
      const gmOpt = providerSel.querySelector('option[value="gemini"]');
      if (cgOpt) {
        const cgName = PM.getName('chatgpt');
        const canChatGPT = !cgOpt.disabled;
        cgOpt.textContent = canChatGPT ? cgName : `${cgName} (Pro)`;
      }
      if (gmOpt) {
        const gmName = PM.getName('gemini');
        const canGemini = !gmOpt.disabled;
        gmOpt.textContent = canGemini ? gmName : `${gmName} (Pro)`;
      }
    }

    // Update .node-brand-name in right sidebar form
    if (this.overlay) {
      const brandNames = this.overlay.querySelectorAll('.node-brand-name[data-provider]');
      console.log('[WorkflowEditor] _updateProviderLabels: found', brandNames.length, 'brand name elements');
      brandNames.forEach(el => {
        const provider = el.dataset.provider;
        if (provider) {
          const newName = PM.getName(provider);
          console.log(`[WorkflowEditor] Updating brand name ${provider}: ${el.textContent} → ${newName}`);
          el.textContent = newName;
        }
      });
    }

    // Update node headers in canvas (chatgpt/grok/prompt nodes show provider labels)
    const canvas = this.canvasContainer;
    if (canvas) {
      // ChatGPT nodes
      canvas.querySelectorAll('.workflow-node[data-type="chatgpt"] .node-header-title').forEach(el => {
        const node = el.closest('.workflow-node');
        const provider = node?.dataset?.provider || 'chatgpt';
        el.textContent = PM.getName(provider);
      });
      // Grok nodes
      canvas.querySelectorAll('.workflow-node[data-type="grok"] .node-header-title').forEach(el => {
        el.textContent = PM.getName('grok');
      });
      // Generate/Image nodes (Flow)
      canvas.querySelectorAll('.workflow-node[data-type="generate"] .node-header-title, .workflow-node[data-type="image"] .node-header-title').forEach(el => {
        el.textContent = PM.getName('flow');
      });
    }
  }

  /**
   * Check if current workflow is in read-only mode.
   * Read-only nếu:
   *   - Workflow là shared view (_is_shared_view flag)
   *   - Workflow là template preview (_is_template_preview flag hoặc _isPreview flag)
   *   - HOẶC mode = 'view' (defensive — flag có thể mất qua serialize)
   * @returns {boolean}
   */
  isReadOnly() {
    return this.workflow?._is_shared_view === true
        || this.workflow?._is_admin_view === true
        || this.workflow?._is_template_preview === true
        || this.workflow?._isPreview === true
        || this.mode === 'view'
        || this.mode === 'admin_preview';
  }

  /**
   * Check if current mode is a preview mode (shared, admin, or template preview)
   * @returns {boolean}
   */
  isPreviewMode() {
    return this.editorMode === EditorMode.SHARED_PREVIEW
        || this.editorMode === EditorMode.ADMIN_PREVIEW
        || this.editorMode === EditorMode.TEMPLATE_PREVIEW;
  }

  /**
   * Get current permissions based on editorMode
   * @returns {Object} Permission flags
   */
  getPermissions() {
    return EditorPermissions[this.editorMode] || EditorPermissions[EditorMode.WORKFLOW_CREATE];
  }

  /**
   * Check if user can edit (add/modify nodes, connections)
   * @returns {boolean}
   */
  canEdit() {
    return this.getPermissions().canEdit;
  }

  /**
   * Check if user can run workflow
   * Requires: canRun permission + featureGate check
   * @returns {boolean}
   */
  canRun() {
    if (!this.getPermissions().canRun) return false;
    // FeatureGate check: workflows_enabled
    if (window.featureGate && !window.featureGate.canUse('workflows_enabled')) return false;
    return true;
  }

  /**
   * Check if user can share workflow
   * Requires: canShare permission + featureGate check
   * @returns {boolean}
   */
  canShare() {
    if (!this.getPermissions().canShare) return false;
    // FeatureGate check: workflow_share_enabled
    if (window.featureGate && !window.featureGate.canUse('workflow_share_enabled')) return false;
    return true;
  }

  /**
   * Check if user can save workflow/template
   * Requires: canSave permission + featureGate check for workflow
   * @returns {boolean}
   */
  canSave() {
    if (!this.getPermissions().canSave) return false;
    // Template mode: check admin permission
    if (this.isTemplateMode) {
      return window.featureGate?.canManageWorkflowTemplates() === true;
    }
    // Workflow mode: check workflows_enabled
    if (window.featureGate && !window.featureGate.canUse('workflows_enabled')) return false;
    return true;
  }

  /**
   * Derive editorMode from legacy flags
   * Call this after setting mode, workflow, isTemplateMode
   */
  _syncEditorMode() {
    if (this.isTemplateMode) {
      this.editorMode = this.templateId ? EditorMode.TEMPLATE_EDIT : EditorMode.TEMPLATE_CREATE;
    } else if (this.workflow?._is_admin_view) {
      this.editorMode = EditorMode.ADMIN_PREVIEW;
    } else if (this.workflow?._is_shared_view) {
      this.editorMode = EditorMode.SHARED_PREVIEW;
    } else if (this.workflow?._is_template_preview || this.workflow?._isPreview) {
      this.editorMode = EditorMode.TEMPLATE_PREVIEW;
    } else if (this.mode === 'view' || this.mode === 'admin_preview') {
      this.editorMode = EditorMode.ADMIN_PREVIEW;
    } else if (this.mode === 'create') {
      this.editorMode = EditorMode.WORKFLOW_CREATE;
    } else {
      this.editorMode = EditorMode.WORKFLOW_EDIT;
    }
  }

  open(mode = 'create', workflow = null) {
    this.mode = mode;
    this.workflow = workflow || this.createNewWorkflow();
    this.selectedNodeId = null;

    // [Fix cloned workflow] Clear shared/preview flags khi mở workflow edit mode
    // Tránh trường hợp workflow clone từ shared vẫn còn flag _is_shared_view
    if (mode === 'edit' && this.workflow) {
      // Log flags trước khi xóa để debug
      if (this.workflow._is_shared_view || this.workflow._is_template_preview || this.workflow._isPreview) {
        console.warn('[WorkflowEditor] open() clearing read-only flags:', {
          _is_shared_view: this.workflow._is_shared_view,
          _is_template_preview: this.workflow._is_template_preview,
          _isPreview: this.workflow._isPreview
        });
      }
      delete this.workflow._is_shared_view;
      delete this.workflow._is_template_preview;
      delete this.workflow._isPreview;
    }

    // Force reset mode to 'edit' nếu workflow không phải preview
    if (mode === 'edit') {
      this.mode = 'edit'; // Ensure mode is set correctly
    }

    // EWT-6: Reset template mode properties khi mở workflow thông thường
    this.isTemplateMode = false;
    this.templateId = null;
    this.templateData = null;

    // Sync editorMode từ legacy flags
    this._syncEditorMode();

    // [Fix cloned workflow] Reset saving state flags TRƯỚC khi render/init
    // Vì render/initComponents có thể trigger _deferredThumbnailSave() qua background scan
    this._isSaving = false;
    if (this._deferredSaveTimer) {
      clearTimeout(this._deferredSaveTimer);
      this._deferredSaveTimer = null;
    }
    if (this._inlineSaveTimer) {
      clearTimeout(this._inlineSaveTimer);
      this._inlineSaveTimer = null;
    }
    // Flag để skip deferred save trong quá trình init
    this._skipDeferredSave = true;

    // [DEBUG OPEN] Log state trước render — verify label đúng
    console.log('[OPEN_DEBUG] open() about to render:', {
      mode: this.mode,
      editorMode: this.editorMode,
      isTemplateMode: this.isTemplateMode,
      wf_id: this.workflow?.wf_id,
    });

    this._hideSidebar();
    this.render();

    // [DEBUG OPEN] Verify actual button text after render
    setTimeout(() => {
      var b = this.overlay?.querySelector('#saveWorkflowBtn');
      console.log('[OPEN_DEBUG] After render — button text:', JSON.stringify(b?.textContent), 'mode:', this.mode);
    }, 100);

    this.initComponents();
    this.bindEvents();
    this._updateQuotaDisplay();
    // Reset unsaved changes flag after loading - loading existing data is not a change
    // Drawflow events (edge:created, node:moved) may fire during init, but those are from loading not user action
    this._hasUnsavedChanges = false;

    // Cho phép deferred save sau khi init xong
    this._skipDeferredSave = false;

    // v1.1 paste image feature: retry pending/failed uploads cho workflow này
    // (blob persist trong workflow_paste_blobs, không TTL)
    this._retryPendingPasteUploads().catch(err => {
      console.warn('[WorkflowEditor] retry pending paste uploads failed:', err?.message);
    });

    // Reset saving flags lần nữa sau init (phòng trường hợp có async operation set lại)
    this._isSaving = false;
    if (this._deferredSaveTimer) {
      clearTimeout(this._deferredSaveTimer);
      this._deferredSaveTimer = null;
    }
    if (this._inlineSaveTimer) {
      clearTimeout(this._inlineSaveTimer);
      this._inlineSaveTimer = null;
    }

    // Reset execution UI state — ensure play/stop/reset buttons match actual state
    this._syncExecutionUI();

    // Update play button state (remove is-saving-locked if any)
    this._updatePlayButtonState();

    // [Fix] Ensure wf-preview-mode class matches isReadOnly() state after re-render
    // Cần vì có thể reuse popup window khi chuyển từ shared preview sang edit mode
    if (this.overlay) {
      if (this.isReadOnly()) {
        this.overlay.classList.add('wf-preview-mode');
      } else {
        this.overlay.classList.remove('wf-preview-mode');
      }
    }
  }

  /**
   * EWT-6.6: Mở template trong editor để chỉnh sửa (admin only)
   * @param {Object} template - Dữ liệu template từ API
   */
  openTemplateForEdit(template) {
    if (!template || !template.id) {
      console.error('[WorkflowEditor] openTemplateForEdit: template không hợp lệ');
      return;
    }

    // Kiểm tra quyền admin
    if (!window.featureGate?.canManageWorkflowTemplates()) {
      window.showNotification?.(
        window.I18n?.t('workflow.adminRequired') || 'Bạn cần quyền admin để chỉnh sửa template',
        'error'
      );
      return;
    }

    // Set template mode
    this.isTemplateMode = true;
    this.templateId = template.id;
    this.templateData = {
      name: template.name,
      description: template.description,
      category_id: template.category_id,
      thumbnail_url: template.thumbnail_url || template.thumbnail,
      video_url: template.video_url || null,
      is_premium: template.is_premium || false,
      is_featured: template.is_featured || false,
      // Backend returns is_active, frontend uses is_published internally
      // Simplify: prefer is_active from backend, fallback to is_published, default true
      is_published: template.is_active ?? template.is_published ?? true,
      use_count: template.use_count || 0,
    };

    // Chuyển đổi template thành workflow format để hiển thị trong editor
    this.mode = 'edit';
    this.workflow = this._convertTemplateToWorkflow(template);
    this.selectedNodeId = null;

    // Sync editorMode từ legacy flags
    this._syncEditorMode();

    this._hideSidebar();
    this.render();
    this.initComponents();
    this.bindEvents();
    this._updateQuotaDisplay();
    this._hasUnsavedChanges = false;
    this._syncExecutionUI();

    console.log('[WorkflowEditor] Đã mở template để chỉnh sửa:', template.id, template.name);
  }

  /**
   * EWT-6.6: Chuyển đổi template format thành workflow format
   * @param {Object} template - Template từ API
   * @returns {Object} Workflow format
   */
  _convertTemplateToWorkflow(template) {
    const nodes = (template.nodes || []).map(node => {
      // Convert result_img_url (string) -> result_thumbnails (object) để DiagramCanvas hiển thị
      const resultImgUrl = node.result_img_url || node.data?.result_img_url || '';
      const resultThumbnails = resultImgUrl
        ? { [`result_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`]: resultImgUrl }
        : null;

      return {
        // Các field khác từ data (spread trước để các field quan trọng override sau)
        ...(node.data || {}),
        // Ưu tiên node_id trước để nhất quán với preview mode
        node_id: node.node_id || node.id || (window.IdGenerator ? window.IdGenerator.next('node') : ('node_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5))),
        node_type: node.node_type || node.type,
        node_name: node.node_name || node.data?.node_name || node.name || node.type || 'Node',
        pos_x: node.pos_x ?? node.position?.x ?? 100,
        pos_y: node.pos_y ?? node.position?.y ?? 100,
        enabled: node.enabled !== false,
        status: null,
        // Data fields
        prompt: node.prompt || node.data?.prompt || '',
        model: node.model || node.data?.model || '',
        ratio: node.ratio || node.data?.ratio || '1:1',
        quantity: node.quantity || node.data?.quantity || 1,
        // Ref images - lưu cả ref_img_urls (cho form) và ref_thumbnails (cho preview)
        ref_file_ids: '',
        ref_img_urls: (() => {
          const urls = node.ref_img_urls || node.data?.ref_img_urls || [];
          if (urls.length > 0) console.log('[WorkflowEditor] _convertTemplateToWorkflow - node has ref_img_urls:', node.id || node.node_id, urls);
          return urls;
        })(),
        ref_thumbnails: this._convertRefImgUrlsToThumbnails(node.ref_img_urls || node.data?.ref_img_urls || []),
        // Result image - lưu cả result_img_url (cho form) và result_thumbnails (cho preview)
        result_img_url: resultImgUrl,
        result_thumbnails: resultThumbnails,
      };
    });

    const edges = (template.edges || []).map(edge => ({
      // DiagramCanvas expects source_node_id / target_node_id / source_handle / target_handle
      edge_id: edge.edge_id || edge.id || (window.IdGenerator ? window.IdGenerator.next('edge') : `edge_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`),
      source_node_id: edge.source_node_id || edge.source_node || edge.source,
      target_node_id: edge.target_node_id || edge.target_node || edge.target,
      source_handle: edge.source_handle || edge.output_class || edge.sourceHandle || 'output_1',
      target_handle: edge.target_handle || edge.input_class || edge.targetHandle || 'input_1',
      source_port: edge.source_port || 'default',
      target_port: edge.target_port || 'default',
    }));

    return {
      wf_id: `template_${template.id}`,
      wf_name: template.name || 'Template',
      description: template.description || '',
      status: 'idle',
      enabled: true,
      settings: template.settings || {},
      settings_json: template.settings || {},
      nodes,
      edges,
    };
  }

  /**
   * Chuyển đổi mảng ref_img_urls thành object ref_thumbnails
   * @param {Array} urls - Mảng URLs
   * @returns {Object} Map key -> url
   */
  _convertRefImgUrlsToThumbnails(urls) {
    if (!Array.isArray(urls) || urls.length === 0) return {};
    const result = {};
    urls.forEach((url, idx) => {
      const key = `template_ref_${Date.now()}_${idx}`;
      result[key] = url;
    });
    return result;
  }

  _syncExecutionUI() {
    if (!this.overlay) return;

    // CRITICAL: KHÔNG dùng `this.workflow.status` để detect "stuck" — field này LÀ cached cũ,
    // chỉ update qua `getWorkflow()` reload. Khi execute() call _updateWorkflowStatus('running'),
    // backend lưu nhưng popup's `this.workflow.status` vẫn 'pending'/'idle'.
    // saveWorkflow() trigger _syncExecutionUI mid-execute → executor running + workflow.status cũ
    // → trigger force stop SAI → null currentWorkflow → execute() throw `Cannot read 'wf_id' of null`.
    // → Fix: chỉ trust `executor.isRunning` flag (executor tự manage qua execute()'s try/finally).
    const isRunning = window.workflowExecutor?.isRunning === true;

    const toolbarPlayBtn = this.overlay.querySelector('.tobyflow-wf-tool-btn[data-action="run-workflow"]');
    const toolbarStopBtn = this.overlay.querySelector('.tobyflow-wf-tool-btn[data-action="stop-workflow"]');
    const resetBtn = this.overlay.querySelector('#resetWorkflowInEditorBtn');
    // 2026-05-25: enabled toggle (on/off) — ẩn khi workflow đang chạy để tránh user toggle giữa execution.
    const enabledToggle = this.overlay.querySelector('#workflowEnabledToggle');

    // Read-only mode (shared/template preview): luôn ẩn play/stop/reset
    // bất kể workflow.status. Tránh logic show reset khi status=completed.
    if (this.isReadOnly()) {
      toolbarPlayBtn?.classList.add('hidden');
      toolbarStopBtn?.classList.add('hidden');
      resetBtn?.classList.add('hidden');
      this.overlay.classList.remove('wf-executing');
      return;
    }

    // EWT-6: Ẩn các nút thực thi khi đang ở template mode
    // Template chỉ để chỉnh sửa, không cần chạy
    if (this.isTemplateMode) {
      toolbarPlayBtn?.classList.add('hidden');
      toolbarStopBtn?.classList.add('hidden');
      resetBtn?.classList.add('hidden');
      this.overlay.classList.remove('wf-executing');
      return;
    }

    if (isRunning) {
      toolbarPlayBtn?.classList.add('hidden');
      toolbarStopBtn?.classList.remove('hidden');
      resetBtn?.classList.add('hidden');
      enabledToggle?.classList.add('hidden');
      this.overlay.classList.add('wf-executing');
    } else {
      // Phase: ẨN play button khi workflow chưa save (mode='create' chưa lưu lần đầu)
      // Lý do: chạy workflow chưa save → executor không có wf_id thật → fail.
      const isUnsaved = this.mode === 'create' && this._hasUnsavedChanges;
      if (isUnsaved) {
        toolbarPlayBtn?.classList.add('hidden');
      } else {
        toolbarPlayBtn?.classList.remove('hidden');
      }
      toolbarStopBtn?.classList.add('hidden');
      enabledToggle?.classList.remove('hidden');
      this.overlay.classList.remove('wf-executing');
      // Bug fix: thêm 'running' vào điều kiện hiện reset button.
      // Khi node bị stuck ở status='running' (do executor crash hoặc tab close giữa chừng)
      // nhưng executor.isRunning=false → user cần reset stuck state để chạy lại.
      const hasActivity = this.workflow?.status === 'completed' ||
        this.workflow?.status === 'failed' ||
        this.workflow?.status === 'running' ||
        (this.workflow?.nodes || []).some(n => n.status && n.status !== 'pending');
      if (resetBtn) {
        resetBtn.classList.toggle('hidden', !hasActivity);
      }
    }
    this._updatePlayButtonState();
  }

  async close() {
    // S2.5: Check uploads đang chạy → confirm trước khi đóng editor
    const activeCount = this._countActiveFormUploads();
    if (activeCount > 0) {
      const confirmed = await window.customDialog?.confirm(
        window.I18n?.t('workflow.uploadingCloseMsg', { count: activeCount }) || `Uploading ${activeCount} reference images. Closing editor will cancel the upload. Continue?`,
        { title: window.I18n?.t('workflow.uploadingTitle') || 'Images uploading', type: 'warning', confirmText: window.I18n?.t('workflow.closeAndCancel') || 'Close and cancel', cancelText: window.I18n?.t('workflow.continueUpload') || 'Continue upload' }
      );
      if (!confirmed) return;
    }
    // Check thay đổi chưa lưu
    // Skip nếu editor được mở để xem workflow đang chạy (từ sidebar, không có edits thật)
    if (this._hasUnsavedChanges && !this._openedToViewRunning) {
      const confirmed = await window.customDialog?.confirm(
        window.I18n?.t('workflow.unsavedMsg') || 'Workflow has unsaved changes. Close without saving?',
        { title: window.I18n?.t('workflow.unsavedTitle') || 'Unsaved changes', type: 'warning', confirmText: window.I18n?.t('workflow.closeWithoutSave') || 'Close without saving', cancelText: window.I18n?.t('workflow.goBack') || 'Go back' }
      );
      if (!confirmed) return;
    }
    // Cleanup all eventBus listeners registered in bindGlobalEvents()
    // (only on full close, not on re-render via _forceClose)
    if (this._ebHandlers && window.eventBus) {
      for (const [event, handler] of Object.entries(this._ebHandlers)) {
        window.eventBus.off(event, handler);
      }
      this._ebHandlers = null;
    }
    // Cleanup beforeunload listener
    if (this._beforeUnloadHandler) {
      window.removeEventListener('beforeunload', this._beforeUnloadHandler);
      this._beforeUnloadHandler = null;
    }
    // Cleanup history keyboard + event listeners
    if (this._historyKeyHandler) {
      document.removeEventListener('keydown', this._historyKeyHandler, true);
      this._historyKeyHandler = null;
    }
    if (this._historyEventHandlers && window.eventBus) {
      for (const [event, handler] of Object.entries(this._historyEventHandlers)) {
        window.eventBus.off(event, handler);
      }
      this._historyEventHandlers = null;
    }
    if (this._undoRedoDirtyTimer) {
      clearTimeout(this._undoRedoDirtyTimer);
      this._undoRedoDirtyTimer = null;
    }
    this.history?.reset();
    this._forceClose();
  }

  /**
   * Đóng editor không cần confirm (dùng nội bộ khi re-render)
   */
  _forceClose() {
    // S2.5: Cleanup upload event listeners
    if (this._uploadStartedHandler) {
      window.eventBus?.off('upload:started', this._uploadStartedHandler);
      this._uploadStartedHandler = null;
    }
    if (this._uploadCompletedHandler) {
      window.eventBus?.off('upload:completed', this._uploadCompletedHandler);
      this._uploadCompletedHandler = null;
    }
    if (this._uploadFailedHandler) {
      window.eventBus?.off('upload:failed', this._uploadFailedHandler);
      this._uploadFailedHandler = null;
    }

    // S2.5: Cancel tất cả form uploads khi đóng editor
    if (this._formUploadKeys?.size > 0) {
      if (window.ImmediateUploader) ImmediateUploader.cancelAll(this._formUploadKeys);
      this._formUploadKeys.clear();
    }

    this._clearBgScanTimers();
    this._hideNodePicker();
    this._hideCanvasContextMenu();
    this._cleanupNodeResizeObservers();
    this._hideInlineSettingDropdown?.();
    if (this._docPillBound) {
      try { document.removeEventListener('mousedown', this._docPillMouseDown, true); } catch (e) {}
      try { document.removeEventListener('click', this._docPillClick, true); } catch (e) {}
      this._docPillMouseDown = null;
      this._docPillClick = null;
      this._docPillBound = false;
    }
    // v1.1 paste image feature: cleanup document-level paste listener
    if (this._pasteHandler) {
      try { document.removeEventListener('paste', this._pasteHandler); } catch (e) {}
      this._pasteHandler = null;
    }
    // v1.1 paste image feature: cleanup workflow-wide upload listeners
    try { this._unbindWorkflowUploadListeners(); } catch (e) {}
    this._unbindKeyboardShortcuts();
    this._unbindNodeFormResize();
    // 2026-05-25: clear pending debounced warning badge refresh (tránh fire sau close)
    if (this._warningBadgesRefreshTimer) {
      clearTimeout(this._warningBadgesRefreshTimer);
      this._warningBadgesRefreshTimer = null;
    }
    if (this.overlay) {
      this.overlay.remove();
      this.overlay = null;
    }
    this.diagramCanvas = null;
    this.selectedNodeId = null;
    this._currentFormNodeType = null;
    this._showSidebar();
  }

  _hideSidebar() {
    // sidePanel mode: hide main app content, overlay takes full screen
    const flowApp = document.querySelector('.flow-app');
    if (flowApp) flowApp.style.display = 'none';
  }

  _showSidebar() {
    const flowApp = document.querySelector('.flow-app');
    if (flowApp) flowApp.style.display = '';
  }

  createNewWorkflow() {
    // Phase: workflow mới có default name kèm date d/m/y (vd: "Workflow mới - 25/4/2026")
    const now = new Date();
    const dateStr = `${now.getDate()}/${now.getMonth() + 1}/${now.getFullYear()}`;
    const baseName = window.I18n?.t('workflow.newWorkflow') || 'Workflow mới';
    return {
      // UUID + timestamp tránh collision khi 2 user/tab tạo cùng millisecond.
      wf_id: window.IdGenerator ? window.IdGenerator.next('wf') : `wf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      wf_name: `${baseName} - ${dateStr}`,
      description: '',
      status: 'idle',
      settings: {
        delay_between_nodes: 5,
        retry_on_fail: true,
        max_retries: 2,
        parallel_execution: true
      },
      settings_json: {
        delay_between_nodes: 5,
        max_retries: 2,
        timeout: 180,
        stop_on_error: false,
        parallel_execution: true
      },
      progress_total: 0,
      progress_completed: 0,
      nodes: [],
      edges: []
    };
  }

  render() {
    this._forceClose();

    this.overlay = document.createElement('div');
    // EWT-11: Thêm class wf-template-mode để CSS ẩn các UI elements không cần thiết cho template editor
    // Preview mode: thêm wf-preview-mode để ẩn hover toolbar và quick action buttons
    // Admin preview: thêm wf-admin-preview để show node form panel (nhưng readonly)
    const isAdminPreview = this.workflow?._is_admin_view === true;
    this.overlay.className = 'workflow-editor-overlay'
      + (this.isTemplateMode ? ' wf-template-mode' : '')
      + (this.isReadOnly() ? ' wf-preview-mode' : '')
      + (isAdminPreview ? ' wf-admin-preview' : '');
    this.overlay.innerHTML = `
      <div class="workflow-editor">
        <div class="workflow-editor-header">
          <div class="workflow-editor-title">
            <input type="text" id="workflowName" value="${this.escapeAttr(this.workflow.wf_name)}" placeholder="${this.isTemplateMode ? (window.I18n?.t('workflow.templateNamePlaceholder') || 'Tên template') : (window.I18n?.t('workflow.workflowNamePlaceholder') || 'Tên workflow')}" ${this.isReadOnly() ? 'readonly' : ''} />
            ${this.isTemplateMode && this.templateId ? `
            <div class="wf-template-stats">
              <span class="wf-template-stat" title="${window.I18n?.t('workflow.template.useCountTitle') || 'Số lượt sử dụng template này'}">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
                  <circle cx="9" cy="7" r="4"></circle>
                  <path d="M23 21v-2a4 4 0 0 0-3-3.87"></path>
                  <path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
                </svg>
                <span>${(this.templateData?.use_count || 0)} ${window.I18n?.t('workflow.useCount') || 'lượt dùng'}</span>
              </span>
            </div>
            ` : ''}
            ${(!this.isTemplateMode && !this.isReadOnly()) ? `<button class="wf-toggle-btn ${this.workflow.enabled !== false ? 'on' : 'off'}" id="workflowEnabledToggle" title="${this.workflow.enabled !== false ? (window.I18n?.t('workflow.enabledOn') || 'Workflow đang bật') : (window.I18n?.t('workflow.enabledOff') || 'Workflow đang tắt')}">
              <span class="wf-toggle-track"><span class="wf-toggle-thumb"></span></span>
            </button>` : ''}
          </div>
          <div class="workflow-editor-actions">
            ${(!this.isTemplateMode && !this.isReadOnly() && this.workflow?.wf_id) ? this._renderSharedUsersAvatars(this.workflow?.shares || []) : ''}
            ${!this.isTemplateMode ? `<div class="wf-quota-display" id="wfQuotaDisplay">
              <div class="wf-quota-item" id="wfQuotaRuns" title="${window.I18n?.t('workflow.runsToday') || 'Lượt chạy hôm nay'}">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
                <span class="wf-quota-label">${window.I18n?.t('workflow.quotaRuns') || 'Runs'}</span>
                <span class="wf-quota-value">--/--</span>
              </div>
              <span class="wf-quota-sep">&bull;</span>
              <div class="wf-quota-item" id="wfQuotaNodes" title="${window.I18n?.t('workflow.nodesInWorkflow') || 'Số node trong workflow'}">
                <svg width="20" height="20" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="none"><path fill="currentColor" fill-rule="evenodd" d="M4 6.25A2.25 2.25 0 016.25 4h3a2.25 2.25 0 012.25 2.25V7h3.25a.75.75 0 010 1.5H11.5v.75a2.25 2.25 0 01-2.25 2.25h-3A2.25 2.25 0 014 9.25V8.5H.75a.75.75 0 010-1.5H4v-.75zm6 0a.75.75 0 00-.75-.75h-3a.75.75 0 00-.75.75v3c0 .414.336.75.75.75h3a.75.75 0 00.75-.75v-3z" clip-rule="evenodd"></path></svg>
                <span class="wf-quota-label">${window.I18n?.t('workflow.quotaNodes') || 'Nodes'}</span>
                <span class="wf-quota-value">--/--</span>
              </div>
              <button class="wf-upgrade-link hidden" id="wfUpgradeBtn" title="${window.I18n?.t('footer.upgrade') || 'Nâng cấp'}">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M5 16L3 5L8.5 10L12 4L15.5 10L21 5L19 16H5ZM19 19C19 19.6 18.6 20 18 20H6C5.4 20 5 19.6 5 19V18H19V19Z"/></svg>
                <span>${window.I18n?.t('footer.upgrade') || 'Nâng cấp'}</span>
              </button>
            </div>` : ''}
            ${this.isTemplateMode && this.templateId && window.featureGate?.canManageWorkflowTemplates() ? `
            <button class="btn btn-secondary" id="wfCaptureDiagramBtn" style="white-space: nowrap; flex-shrink: 0;" title="${window.I18n?.t('workflow.captureDiagramTitle') || 'Chụp ảnh diagram → upload làm preview public của template'}">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
                <circle cx="12" cy="13" r="4"/>
              </svg>
              <span>${window.I18n?.t('workflow.captureDiagram') || 'Capture'}</span>
            </button>
            ` : ''}
            <button class="btn btn-secondary ${(this.mode === 'create' || this.isTemplateMode || this.isReadOnly()) ? 'hidden' : ''}" id="resetWorkflowInEditorBtn" title="${window.I18n?.t('workflow.resetBtn') || 'Reset'} workflow">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="1 4 1 10 7 10"></polyline>
                <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path>
              </svg>
              ${window.I18n?.t('workflow.resetBtn') || 'Reset'}
            </button>
            ${window.featureGate?.canManageWorkflowTemplates() && !this.isTemplateMode && this.mode !== 'create' && this.workflow?.wf_id && !this.isReadOnly() ? `
            <button class="btn btn-secondary btn-save-template" id="wfSaveAsTemplateBtn" title="${window.I18n?.t('workflow.saveAsTemplate') || 'Lưu thành Template'}">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>
                <polyline points="17 21 17 13 7 13 7 21"/>
                <polyline points="7 3 7 8 15 8"/>
              </svg>
              <span>${window.I18n?.t('workflow.saveAsTemplate') || 'Lưu Template'}</span>
            </button>
            ` : ''}
            ${window.featureGate?.canManageWorkflowTemplates() && this.workflow?._is_template_preview && this.workflow?._template_id ? `
            <button class="btn btn-secondary btn-edit-template" id="wfEditTemplateBtn" title="${window.I18n?.t('workflow.editTemplate') || 'Chỉnh sửa template'}">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
              </svg>
              <span>${window.I18n?.t('workflow.editTemplate') || 'Chỉnh sửa template'}</span>
            </button>
            ` : ''}
            ${this.workflow?._is_template_preview && this.workflow?._template_video_url ? `
            <button class="btn btn-secondary btn-video-demo" id="wfVideoBtn" data-video-url="${this.escapeHtml(this.workflow._template_video_url)}" title="${window.I18n?.t('workflow.watchDemo') || 'Xem video demo'}">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style="color: #ff0000;">
                <path d="M19.615 3.184c-3.604-.246-11.631-.245-15.23 0-3.897.266-4.356 2.62-4.385 8.816.029 6.185.484 8.549 4.385 8.816 3.6.245 11.626.246 15.23 0 3.897-.266 4.356-2.62 4.385-8.816-.029-6.185-.484-8.549-4.385-8.816zm-10.615 12.816v-8l8 3.993-8 4.007z"/>
              </svg>
              <span>${window.I18n?.t('workflow.watchDemo') || 'Xem video demo'}</span>
            </button>
            ` : ''}
            ${!this.isTemplateMode && this.mode !== 'create' && !this.isReadOnly() ? `
            <button class="btn btn-secondary ${!window.featureGate?.canUse('workflow_share_enabled') ? 'btn--locked' : ''}" id="shareWorkflowHeaderBtn" title="${window.I18n?.t('workflow.shareBtn') || 'Chia sẻ'}">
              ${!window.featureGate?.canUse('workflow_share_enabled') ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--warning, #f59e0b)" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>` : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>`}
              <span>${window.I18n?.t('workflow.shareBtn') || 'Chia sẻ'}</span>
            </button>
            ` : ''}
            <button class="btn btn-secondary" id="closeEditorBtn">${window.I18n?.t('workflow.closeBtn') || 'Close'}</button>
            ${(this.isReadOnly() && !this.workflow?._is_admin_view) ? `
            <button class="btn btn-success wf-duplicate-header-btn" id="duplicateSharedHeaderBtn" title="${
              this.workflow?._is_template_preview
                ? (window.I18n?.t('workflow.copyTemplateBtn') || 'Sao chép template')
                : (window.I18n?.t('workflow.duplicateToUse') || 'Nhân bản để sử dụng')
            }">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
              </svg>
              <span>${
                this.workflow?._is_template_preview
                  ? (window.I18n?.t('workflow.copyTemplateBtn') || 'Sao chép template')
                  : (window.I18n?.t('workflow.duplicateBtn') || 'Nhân bản')
              }</span>
            </button>
            ` : ''}
            <button class="btn btn-primary ${this.isReadOnly() ? 'hidden' : ''}" id="saveWorkflowBtn" title="${window.I18n?.t('workflow.saveShortcut') || 'Lưu (Ctrl+S)'}" data-tooltip="${window.I18n?.t('workflow.saveShortcut') || 'Lưu (Ctrl+S)'}">${this.isTemplateMode ? (this.templateId ? (window.I18n?.t('workflow.updateTemplate') || 'Cập nhật Template') : (window.I18n?.t('workflow.saveTemplateBtn') || 'Lưu Template')) : (this.mode === 'create' ? (window.I18n?.t('workflow.createBtn') || 'Tạo mới') : (window.I18n?.t('workflow.saveBtn') || 'Lưu'))}</button>
          </div>
        </div>
        <div class="workflow-editor-body">
          <div class="workflow-editor-center">
            <div class="tobyflow-wf-toolbar">
                <button class="tobyflow-wf-tool-btn ${this.isReadOnly() ? 'hidden' : ''}" data-action="add-node" title="${window.I18n?.t('workflow.addNodeShortcut') || 'Thêm node (N)'}" data-tooltip="${window.I18n?.t('workflow.addNodeShortcut') || 'Thêm node (N)'}" data-tooltip-pos="right">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                </button>
                <button class="tobyflow-wf-tool-btn ${(this.mode === 'create' || this.isTemplateMode || this.isReadOnly()) ? 'hidden' : ''}" data-action="run-workflow" title="${window.I18n?.t('workflow.runShortcut') || 'Chạy (Ctrl+Enter)'}" data-tooltip="${window.I18n?.t('workflow.runShortcut') || 'Chạy (Ctrl+Enter)'}" data-tooltip-pos="right">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                </button>
                <button class="tobyflow-wf-tool-btn hidden" data-action="stop-workflow" title="${window.I18n?.t('workflow.stopBtn') || 'Dừng'}" data-tooltip="${window.I18n?.t('workflow.stopBtn') || 'Dừng'}" data-tooltip-pos="right">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="6" width="12" height="12"/></svg>
                </button>
                <div class="tobyflow-wf-tool-divider ${this.isReadOnly() ? 'hidden' : ''}"></div>
                <button class="tobyflow-wf-tool-btn ${this.isReadOnly() ? 'hidden' : ''}" data-action="undo" id="wfUndoBtn" disabled title="${window.I18n?.t('workflow.undoShortcut') || 'Hoàn tác (Ctrl+Z)'}" data-tooltip="${window.I18n?.t('workflow.undoShortcut') || 'Hoàn tác (Ctrl+Z)'}" data-tooltip-pos="right">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-15-6.7L3 13"/></svg>
                </button>
                <button class="tobyflow-wf-tool-btn ${this.isReadOnly() ? 'hidden' : ''}" data-action="redo" id="wfRedoBtn" disabled title="${window.I18n?.t('workflow.redoShortcut') || 'Làm lại (Ctrl+Shift+Z)'}" data-tooltip="${window.I18n?.t('workflow.redoShortcut') || 'Làm lại (Ctrl+Shift+Z)'}" data-tooltip-pos="right">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 7v6h-6"/><path d="M3 17a9 9 0 0 1 15-6.7L21 13"/></svg>
                </button>
                <div class="tobyflow-wf-tool-divider"></div>
                <button class="tobyflow-wf-tool-btn ${(this.isTemplateMode || this.isReadOnly()) ? 'hidden' : ''}" data-action="toggle-log" title="${window.I18n?.t('workflow.logAndProgress') || 'Log & tiến độ'}" data-tooltip="${window.I18n?.t('workflow.logAndProgress') || 'Log & tiến độ'}" data-tooltip-pos="right">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
                </button>
                <button class="tobyflow-wf-tool-btn" data-action="fit-screen" title="${window.I18n?.t('workflow.fitScreen') || 'Vừa màn hình (F)'}" data-tooltip="${window.I18n?.t('workflow.fitScreen') || 'Vừa màn hình (F)'}" data-tooltip-pos="right">
                  <svg width="18" height="18" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" d="M64,496H184V464H64a16.019,16.019,0,0,1-16-16V328H16V448A48.054,48.054,0,0,0,64,496Z"></path><path fill="currentColor" d="M48,64A16.019,16.019,0,0,1,64,48H184V16H64A48.054,48.054,0,0,0,16,64V184H48Z"></path><path fill="currentColor" d="M448,16H328V48H448a16.019,16.019,0,0,1,16,16V184h32V64A48.054,48.054,0,0,0,448,16Z"></path><path fill="currentColor" d="M464,448a16.019,16.019,0,0,1-16,16H328v32H448a48.054,48.054,0,0,0,48-48V328H464Z"></path><path fill="currentColor" d="M400,256c0-79.4-64.6-144-144-144S112,176.6,112,256s64.6,144,144,144S400,335.4,400,256ZM256,368A112,112,0,1,1,368,256,112.127,112.127,0,0,1,256,368Z"></path></svg>
                </button>
                <button class="tobyflow-wf-tool-btn ${this.isReadOnly() ? 'hidden' : ''}" data-action="auto-layout" title="${window.I18n?.t('workflow.autoLayout') || 'Sắp xếp lại nodes'}" data-tooltip="${window.I18n?.t('workflow.autoLayout') || 'Sắp xếp lại nodes'}" data-tooltip-pos="right">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="6" height="6" rx="1"/><rect x="15" y="3" width="6" height="6" rx="1"/><rect x="3" y="15" width="6" height="6" rx="1"/><rect x="15" y="15" width="6" height="6" rx="1"/><line x1="9" y1="6" x2="15" y2="6"/><line x1="9" y1="18" x2="15" y2="18"/><line x1="6" y1="9" x2="6" y2="15"/><line x1="18" y1="9" x2="18" y2="15"/></svg>
                </button>
                <button class="tobyflow-wf-tool-btn ${this.isReadOnly() ? 'hidden' : ''}" data-action="settings" title="${this.isTemplateMode ? (window.I18n?.t('workflow.templateSettings') || 'Cài đặt template') : (window.I18n?.t('workflow.settingsWorkflow') || 'Cài đặt workflow')}" data-tooltip="${this.isTemplateMode ? (window.I18n?.t('workflow.templateSettings') || 'Cài đặt template') : (window.I18n?.t('workflow.settingsWorkflow') || 'Cài đặt workflow')}" data-tooltip-pos="right">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
                </button>
                <button class="tobyflow-wf-tool-btn ${(this.mode === 'create' || this.isTemplateMode) ? 'hidden' : ''} ${!window.featureGate?.canUse('workflow_export') ? 'tobyflow-wf-tool-btn--locked' : ''}" data-action="export-workflow" title="${window.I18n?.t('workflow.exportBtn') || 'Xuất workflow'}" data-tooltip="${window.I18n?.t('workflow.exportBtn') || 'Xuất workflow'}" data-tooltip-pos="right">
                  <span class="wf-tool-icon-wrap">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                    ${!window.featureGate?.canUse('workflow_export') ? `<svg class="wf-tool-lock-badge" width="10" height="10" viewBox="0 0 24 24" fill="var(--warning, #f59e0b)" stroke="var(--warning, #f59e0b)" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4" fill="none"></path></svg>` : ''}
                  </span>
                </button>
                <button class="tobyflow-wf-tool-btn ${(this.mode === 'create' || this.isTemplateMode || this.isReadOnly()) ? 'hidden' : ''} ${!window.featureGate?.canUse('workflow_share_enabled') ? 'tobyflow-wf-tool-btn--locked' : ''}" data-action="share-workflow" title="${window.I18n?.t('workflow.shareBtn') || 'Chia sẻ'}" data-tooltip="${window.I18n?.t('workflow.shareBtn') || 'Chia sẻ'}" data-tooltip-pos="right">
                  <span class="wf-tool-icon-wrap">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
                    ${!window.featureGate?.canUse('workflow_share_enabled') ? `<svg class="wf-tool-lock-badge" width="10" height="10" viewBox="0 0 24 24" fill="var(--warning, #f59e0b)" stroke="var(--warning, #f59e0b)" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4" fill="none"></path></svg>` : ''}
                  </span>
                </button>
              </div>
            <div id="diagramContainer" style="flex: 1; position: relative;">
              <!-- Phase WK-1.5.2: Port legend (collapsed by default) -->
              <div class="wf-port-legend collapsed" id="wfPortLegend">
                <div class="wf-port-legend-toggle" id="wfPortLegendToggle" title="${window.I18n?.t('workflow.portTypes') || 'Loại port'}">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
                </div>
                <div class="wf-port-legend-content">
                  <div class="wf-port-legend-title">${window.I18n?.t('workflow.portTypes') || 'Loại port'}</div>
                  <div class="wf-port-legend-item"><span class="wf-port-dot wf-port-dot-text"></span>Text</div>
                  <div class="wf-port-legend-item"><span class="wf-port-dot wf-port-dot-image"></span>Image</div>
                  <div class="wf-port-legend-item"><span class="wf-port-dot wf-port-dot-video"></span>Video</div>
                  <div class="wf-port-legend-item"><span class="wf-port-dot wf-port-dot-frame"></span>Frame</div>
                  <div class="wf-port-legend-item"><span class="wf-port-dot wf-port-dot-any"></span>Any</div>
                </div>
              </div>
              ${this.isReadOnly() ? `
              <div class="wf-shared-banner" id="wfSharedBanner">
                <span class="wf-shared-banner-icon">👁️</span>
                <span class="wf-shared-banner-text">${
                  this.workflow?._is_admin_view
                    ? (window.I18n?.t('workflow.adminPreviewReadOnly', { owner: this.workflow?._owner_name || this.workflow?._owner_email || 'User' }) || `Đang xem workflow của ${this.workflow?._owner_name || this.workflow?._owner_email || 'User'} (chỉ xem)`)
                    : this.workflow?._is_template_preview
                      ? (window.I18n?.t('workflow.templatePreviewReadOnly') || 'This is a template (preview). Duplicate to use.')
                      : (window.I18n?.t('workflow.sharedReadOnly') || 'This is a shared workflow (view only).')
                }</span>
                ${!this.workflow?._is_admin_view ? `
                <button class="wf-shared-banner-btn" id="wfDuplicateSharedBtn">${
                  this.workflow?._is_template_preview
                    ? (window.I18n?.t('workflow.copyTemplateBtn') || 'Sao chép template')
                    : (window.I18n?.t('workflow.duplicateToUse') || 'Duplicate để sử dụng')
                }</button>
                ` : ''}
              </div>
              ` : ''}
            </div>
            ${(!this.isTemplateMode && !this.isReadOnly()) ? `
            <div class="execution-log-panel hidden" id="executionLogPanel">
              <div class="execution-log-header">
                <span class="execution-log-title">${window.I18n?.t('workflow.executionProgress') || 'Tiến độ thực thi'}</span>
                <div class="execution-log-progress">
                  <span id="editorProgressText">0 / 0</span>
                  <div class="execution-log-progress-bar">
                    <div class="execution-log-progress-fill" id="editorProgressFill" style="width: 0%"></div>
                  </div>
                </div>
                <button class="execution-log-toggle" id="toggleLogPanelBtn" title="${window.I18n?.t('workflow.collapse') || 'Thu gọn'}">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="6 15 12 9 18 15"></polyline>
                  </svg>
                </button>
              </div>
              <div class="execution-log-body" id="executionLogBody"></div>
            </div>
            ` : ''}
          </div>
          <div class="node-form-panel hidden" id="nodeFormPanel">
            <div class="node-form-resize-handle" id="nodeFormResizeHandle" title="${window.I18n?.t('workflow.resizeHandle') || 'Kéo để thay đổi kích thước'}"></div>
            <div class="node-form-header">
              <div class="node-form-tabs" id="nodeFormTabs">
                <button class="node-form-tab active" data-tab="config">${window.I18n?.t('workflow.configTab') || 'Cấu hình'}</button>
                <button class="node-form-tab ${this.isTemplateMode ? 'hidden' : ''}" data-tab="result">${window.I18n?.t('workflow.resultTab') || 'Kết quả'}</button>
                <button class="node-form-tab hidden" data-tab="help" id="nodeFormHelpTab" title="${window.I18n?.t('workflow.helpTab') || 'Hướng dẫn'}">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                </button>
              </div>
              <div style="display: flex; align-items: center; gap: 4px;">
                <button class="node-form-close ${(this.isTemplateMode || this.isReadOnly()) ? 'hidden' : ''}" id="runSingleNodeBtn" title="${window.I18n?.t('workflow.runThisNode') || 'Chạy node này'}" style="color: var(--success, #22c55e);">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
                </button>
                <button class="node-form-close hidden" id="downloadNodeBtn" title="${window.I18n?.t('workflow.downloadResults') || 'Tải file kết quả'}" style="color: var(--primary, #cdff01);">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                </button>
                <button class="node-form-close ${(this.isTemplateMode || this.isReadOnly()) ? 'hidden' : ''}" id="resetSingleNodeBtn" title="${window.I18n?.t('workflow.resetThisNode') || 'Reset node này'}" style="color: var(--warning, #f59e0b);">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
                </button>
                <button class="node-form-close node-form-toggle-enabled ${this.isReadOnly() ? 'hidden' : ''}" id="toggleEnabledBtn" title="${window.I18n?.t('workflow.enabledToggle') || 'Bật/Tắt node'}" data-enabled="true">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/></svg>
                </button>
                <button class="node-form-close ${this.isReadOnly() ? 'hidden' : ''}" id="deleteNodeBtn" title="${window.I18n?.t('workflow.deleteNodeBtn') || 'Xóa node'}" style="color: var(--destructive, #ef4444);">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                </button>
                <button class="node-form-close" id="closeNodeFormBtn">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <line x1="18" y1="6" x2="6" y2="18"></line>
                    <line x1="6" y1="6" x2="18" y2="18"></line>
                  </svg>
                </button>
              </div>
            </div>
            <div class="node-form-body" id="nodeFormBody">
              <!-- Config tab content -->
            </div>
            <div class="node-form-body hidden" id="nodeResultBody">
              <!-- Result tab content -->
            </div>
            <div class="node-form-body hidden" id="nodeHelpBody">
              <!-- Help tab content (per-node-type guide) -->
            </div>
            <div class="node-form-footer" id="nodeFormFooter">
              <button class="btn btn-secondary btn-sm" id="closeNodeFormBtn2">${window.I18n?.t('workflow.closeBtn') || 'Close'}</button>
              <button class="btn btn-warning btn-sm hidden ${this.isReadOnly() ? 'wf-readonly-hide' : ''}" id="resetNodeFooterBtn" title="${window.I18n?.t('workflow.resetThisNode') || 'Reset node này'}">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right: 4px;"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
                Reset
              </button>
              <button class="btn btn-primary btn-sm ${this.isReadOnly() ? 'hidden' : ''}" id="saveNodeBtn">${window.I18n?.t('workflow.saveNode') || 'Lưu Node'}</button>
            </div>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(this.overlay);
  }

  renderPalette() {
    const activeTypes = ['generate', 'download', 'telegram', 'delay', 'note'];
    return activeTypes.map(type =>
      NodeTemplates.createPaletteItem(type)
    ).join('');
  }

  initComponents() {
    // Initialize DiagramCanvas
    const diagramContainer = this.overlay.querySelector('#diagramContainer');
    if (diagramContainer) {
      // EWT-11: Truyền isTemplateMode vào DiagramCanvas để ẩn các UI execution-related
      // Truyền isReadOnly để disable drag-drop và connection creation
      // Admin preview: cho phép xem chi tiết node (gear icon vẫn clickable)
      const isAdminPreview = this.workflow?._is_admin_view === true;
      this.diagramCanvas = new DiagramCanvas(diagramContainer, {
        isTemplateMode: this.isTemplateMode,
        isReadOnly: this.isReadOnly(),
        isAdminPreview: isAdminPreview
      });

      // Initialize undo/redo history (Ctrl+Z / Ctrl+Shift+Z)
      this.history = window.WorkflowHistory ? new window.WorkflowHistory(this) : null;
      this._bindHistoryEvents();

      // Load existing workflow - delay to let DOM layout + Drawflow init complete
      // Cả 'edit', 'view' (shared workflow read-only), và 'admin_preview' đều cần load nodes/edges
      if ((this.mode === 'edit' || this.mode === 'view' || this.mode === 'admin_preview') && this.workflow.nodes?.length > 0) {
        // Double rAF + timeout ensures canvas has dimensions before adding nodes
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            setTimeout(() => {
              this.diagramCanvas.loadWorkflow(this.workflow);
              this._restoreNodeStates();
              // Auto-generate slugs for mentionable nodes that don't have one (migration for old nodes)
              this._ensureSlugsForMentionableNodes();
              // 2026-05-31 Rescan Tier 1: auto-recover broken thumbnails sau khi workflow load.
              // Defer 800ms để Flow tab có thời gian render tiles (nếu vừa mở). Silent, no toast.
              setTimeout(() => { this._autoRescanBrokenThumbs?.(); }, 800);
              // Task 4.11: Cleanup stale recent mentions
              if (this.workflow?.id) {
                const allSlugs = (this.workflow.nodes || [])
                  .filter(n => this._isMentionableNodeType(n.node_type))
                  .map(n => n.slug)
                  .filter(Boolean);
                this._cleanupRecentMentions(this.workflow.id, allSlugs);
              }
              try { this._bindPortLegendToggle(); } catch (e) { /* ignore */ }
              try { this._bindEdgeHoverTooltips(); } catch (e) { /* ignore */ }
              try { this._bindEmptyPortClicks(); } catch (e) { /* ignore */ }
              try { this._bindInlineSettingPills(); } catch (e) { /* ignore */ }
              try { this._scheduleRefreshNodeWarningBadges(); } catch (e) { /* ignore */ }
              try { this._updatePortEmptyState(); } catch (e) { /* ignore */ }
              try { this._refreshAllPromptSourceBadges(); } catch (e) { /* ignore */ }
              try { this._takeInitialHistorySnapshot(); } catch (e) { /* ignore */ }
              // Force re-route TẤT CẢ connections sau khi load — port positions
              // mới (input -32px, output -5px) khác với positions Drawflow lưu
              // lúc addConnection. Multi-retry để đảm bảo CSS/layout đã settle.
              // Bug fix: Thêm delays lớn hơn (2000, 3000ms) để đợi images load xong —
              // khi images load, node size thay đổi và connections cần được update lại.
              [50, 200, 500, 1000, 2000, 3000].forEach((delay) => {
                setTimeout(() => {
                  try { this.diagramCanvas?._forceUpdateAllConnections?.(); } catch (e) {}
                }, delay);
              });
            }, 100);
          });
        });
      } else {
        // Create mode: bind ngay sau init
        setTimeout(() => {
          try { this._bindPortLegendToggle(); } catch (e) { /* ignore */ }
          try { this._bindEdgeHoverTooltips(); } catch (e) { /* ignore */ }
          try { this._bindEmptyPortClicks(); } catch (e) { /* ignore */ }
          try { this._bindInlineSettingPills(); } catch (e) { /* ignore */ }
          try { this._takeInitialHistorySnapshot(); } catch (e) { /* ignore */ }
        }, 50);
      }
    }
  }

  /**
   * Phase WK-1.5.2: Toggle port legend collapse/expand on canvas.
   */
  _bindPortLegendToggle() {
    const legend = this.overlay?.querySelector('#wfPortLegend');
    const toggle = this.overlay?.querySelector('#wfPortLegendToggle');
    if (!legend || !toggle || toggle._wfBound) return;
    toggle._wfBound = true;
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      legend.classList.toggle('collapsed');
    });
  }

  /**
   * Phase WK-1.5.4: Edge tooltip on hover — preview source/target ports.
   */
  _bindEdgeHoverTooltips() {
    const container = this.overlay?.querySelector('#diagramContainer');
    if (!container || container._wfEdgeTooltipBound) return;
    container._wfEdgeTooltipBound = true;

    let tooltip = document.getElementById('wfEdgeTooltip');
    if (!tooltip) {
      tooltip = document.createElement('div');
      tooltip.id = 'wfEdgeTooltip';
      tooltip.className = 'wf-edge-tooltip hidden';
      document.body.appendChild(tooltip);
    }

    const showTooltip = (path) => {
      const svg = path.closest('svg.connection');
      if (!svg) return;
      const cls = svg.getAttribute('class') || '';
      const inMatch = cls.match(/node_in_node-(\d+)/);
      const outMatch = cls.match(/node_out_node-(\d+)/);
      const outClsMatch = cls.match(/(output_\d+)/);
      const inClsMatch = cls.match(/(input_\d+)/);
      if (!inMatch || !outMatch) return;

      const sourceId = outMatch[1];
      const targetId = inMatch[1];
      const editor = this.diagramCanvas?.editor;
      if (!editor) return;

      let sourceNode = null, targetNode = null;
      try { sourceNode = editor.getNodeFromId(sourceId); } catch (e) { /* ignore */ }
      try { targetNode = editor.getNodeFromId(targetId); } catch (e) { /* ignore */ }
      if (!sourceNode || !targetNode) return;

      const sourcePortName = sourceNode.data?._port_map?.[outClsMatch?.[1]] || 'default';
      const targetPortName = targetNode.data?._port_map?.[inClsMatch?.[1]] || 'default';
      const sourceLabel = sourceNode.data?.node_name || sourceNode.class || 'Source';
      const targetLabel = targetNode.data?.node_name || targetNode.class || 'Target';

      tooltip.innerHTML = `
        <div class="wf-edge-tooltip-title">${this.escapeHtml(sourceLabel)}</div>
        <div class="wf-edge-tooltip-flow">
          <span class="wf-edge-tooltip-port">${this.escapeHtml(sourcePortName)}</span>
          <span>&rarr;</span>
          <span class="wf-edge-tooltip-port">${this.escapeHtml(targetPortName)}</span>
        </div>
        <div class="wf-edge-tooltip-target">${this.escapeHtml(targetLabel)}</div>
      `;
      tooltip.classList.remove('hidden');
      const rect = path.getBoundingClientRect();
      const left = rect.left + rect.width / 2;
      const top = Math.max(8, rect.top - 60);
      tooltip.style.left = `${left}px`;
      tooltip.style.top = `${top}px`;
    };

    container.addEventListener('mouseover', (e) => {
      const path = e.target.closest && e.target.closest('svg.connection .main-path, svg.connection path');
      if (!path) return;
      try { showTooltip(path); } catch (err) { /* ignore */ }
    });

    container.addEventListener('mouseout', (e) => {
      if (!e.target.closest || !e.target.closest('svg.connection')) {
        tooltip.classList.add('hidden');
      }
    });
  }

  /**
   * 2026-05-25: Debounced wrapper. Coalesce burst calls (paste workflow / multi-edit
   * trigger 10+ calls trong < 100ms → debounce 200ms last-wins → 1 lần scan).
   * Internal calls dùng wrapper này. Direct `_refreshAllNodeWarningBadges()` chỉ
   * giữ cho test/debug — production code phải qua schedule.
   */
  _scheduleRefreshNodeWarningBadges() {
    if (this._warningBadgesRefreshTimer) clearTimeout(this._warningBadgesRefreshTimer);
    this._warningBadgesRefreshTimer = setTimeout(() => {
      this._warningBadgesRefreshTimer = null;
      try { this._refreshAllNodeWarningBadges(); } catch (e) { /* ignore */ }
    }, 200);
  }

  /**
   * Phase WK-1.5.3: Quét tất cả nodes → cập nhật warning badges cho nodes có required port chưa connect.
   */
  _refreshAllNodeWarningBadges() {
    try {
      const editor = this.diagramCanvas?.editor;
      if (!editor) return;
      const data = editor.export();
      const nodes = data?.drawflow?.Home?.data || {};
      for (const [drawflowId, nodeInfo] of Object.entries(nodes)) {
        const type = nodeInfo.class;
        const ports = (typeof NodeTemplates?.getNodePorts === 'function')
          ? NodeTemplates.getNodePorts(type, nodeInfo.data) : null;
        if (!ports || !ports.in || ports.in.length === 0) {
          this._updateNodeWarningBadge(drawflowId, false);
          continue;
        }
        let hasUnfilled = false;
        ports.in.forEach((port, idx) => {
          if (!port.required) return;
          const inputClass = `input_${idx + 1}`;
          const conns = nodeInfo.inputs?.[inputClass]?.connections || [];
          if (conns.length === 0) hasUnfilled = true;
        });
        this._updateNodeWarningBadge(drawflowId, hasUnfilled);
      }
    } catch (e) { /* ignore */ }
  }

  /**
   * Re-validate edges connected vào/ra node sau khi data đổi.
   * Remove edges có port type incompatible (theo PORT_COMPAT) — vd toggle media_type Image→Video
   * khiến port out `media` chuyển từ 'image' → 'video', edge tới input 'image' của node khác
   * thành incompat → cần gỡ.
   *
   * Backward-compat: edges legacy (không có _port_map) skip validation, không gỡ.
   * Idempotent: gọi nhiều lần an toàn, chỉ gỡ edges thực sự incompat tại thời điểm gọi.
   *
   * @param {string|number} drawflowId Drawflow ID của node vừa thay đổi data
   * @returns {number} số edges đã remove
   */
  _revalidateNodeEdges(drawflowId) {
    const editor = this.diagramCanvas?.editor;
    if (!editor || !window.NodeTemplates) return 0;
    const PORT_COMPAT = window.NodeTemplates.PORT_COMPAT || {};
    const moduleKey = editor.module || 'Home';
    const moduleData = editor.drawflow?.drawflow?.[moduleKey]?.data;
    if (!moduleData || !moduleData[drawflowId]) return 0;

    let removedCount = 0;
    const allNodes = Object.values(moduleData);

    // Set suppress flag để gỡ edges KHÔNG trigger _syncFrameSourceOnDisconnect clear data
    // (giống pattern _resizeNodePorts trong DiagramCanvas)
    if (this.diagramCanvas) this.diagramCanvas._suppressFrameSyncOnResize = true;
    try {
      // Drawflow edge structure (per node):
      //   node.outputs[output_class] = { connections: [{ node: targetDfId, output: targetInputClass }] }
      //   node.inputs[input_class]   = { connections: [{ node: sourceDfId, input:  sourceOutputClass }] }
      // Để tìm edges chạm node này, scan TẤT CẢ outputs của TẤT CẢ nodes (mỗi edge có 1 entry duy nhất tại source).
      for (const node of allNodes) {
        const sourceDfId = node.id;
        for (const [outClass, outData] of Object.entries(node.outputs || {})) {
          const conns = outData?.connections || [];
          // Copy array vì có thể modify trong loop (removeSingleConnection mutates source)
          for (const conn of [...conns]) {
            const targetDfId = conn.node;
            const targetInputClass = conn.output; // Drawflow naming: trong outputs.connections, `output` field = input_class của target

            // Skip edges không liên quan node vừa đổi data
            if (String(sourceDfId) !== String(drawflowId) && String(targetDfId) !== String(drawflowId)) continue;

            const sourceNode = moduleData[sourceDfId];
            const targetNode = moduleData[targetDfId];
            if (!sourceNode || !targetNode) continue;

            // Backward-compat: legacy edge không có _port_map → skip (giống logic line 1031)
            const sourcePortName = sourceNode.data?._port_map?.[outClass];
            const targetPortName = targetNode.data?._port_map?.[targetInputClass];
            if (!sourcePortName || !targetPortName) continue;

            // Get port types từ NEW data (đã update qua updateNodeDataFromId)
            const sourceType = sourceNode.class || sourceNode.data?.node_type;
            const targetType = targetNode.class || targetNode.data?.node_type;
            // SAFETY: legacy data corrupt thiếu type → skip thay vì gỡ (tránh xoá nhầm hàng loạt edges)
            if (!sourceType || !targetType) continue;

            const sourcePorts = window.NodeTemplates.getNodePorts(sourceType, sourceNode.data || {});
            const targetPorts = window.NodeTemplates.getNodePorts(targetType, targetNode.data || {});
            const sourcePort = sourcePorts.out.find(p => p.name === sourcePortName);
            const targetPort = targetPorts.in.find(p => p.name === targetPortName);
            // Nếu port không còn (visibleWhen=false sau toggle, vd Video→Image làm frame_1/frame_2 disappear)
            // → gỡ edge này (intent: clean up edges đến ports đã ẩn)
            if (!sourcePort || !targetPort) {
              try {
                editor.removeSingleConnection(sourceDfId, targetDfId, outClass, targetInputClass);
                removedCount++;
                console.log(`[WorkflowEditor] Removed edge with missing port: ${sourcePortName} → ${targetPortName}`);
              } catch (e) {
                console.warn('[WorkflowEditor] Failed to remove edge with missing port:', e);
              }
              continue;
            }

            // Validate compat
            const compat = PORT_COMPAT[sourcePort.type] || [];
            if (!compat.includes(targetPort.type)) {
              try {
                editor.removeSingleConnection(sourceDfId, targetDfId, outClass, targetInputClass);
                removedCount++;
                console.log(`[WorkflowEditor] Removed incompatible edge: ${sourcePort.type} → ${targetPort.type} (${sourcePortName} → ${targetPortName})`);
              } catch (e) {
                console.warn('[WorkflowEditor] Failed to remove incompatible edge:', e);
              }
            }
          }
        }
      }
    } finally {
      if (this.diagramCanvas) this.diagramCanvas._suppressFrameSyncOnResize = false;
    }

    return removedCount;
  }

  /**
   * Phase WK-1.5.3: Update warning badge on node card khi có required port chưa connect.
   * @param {string|number} nodeId Drawflow node ID
   * @param {boolean} hasUnfilledRequired
   */
  _updateNodeWarningBadge(nodeId, hasUnfilledRequired) {
    const nodeEl = this.overlay?.querySelector(`#node-${nodeId} .df-node`);
    if (!nodeEl) return;
    let badge = nodeEl.querySelector('.df-node-warning-badge');
    if (hasUnfilledRequired) {
      if (!badge) {
        badge = document.createElement('div');
        badge.className = 'df-node-warning-badge';
        badge.title = window.I18n?.t('workflow.portWarning') || 'Node có port required chưa connect';
        badge.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2L2 22h20L12 2zm0 6l7 12H5l7-12zm0 4v3h-1v-3h1zm0 5v1h-1v-1h1z"/></svg>';
        nodeEl.appendChild(badge);
      }
    } else {
      if (badge) badge.remove();
    }
  }

  /**
   * Refresh prompt source inline indicator trong right sidebar form.
   * Cập nhật indicator khi connections thay đổi (edge created/removed).
   */
  _refreshAllPromptSourceBadges() {
    if (!this.selectedNodeId) return;
    try {
      const editor = this.diagramCanvas?.editor;
      const overlay = this.overlay;
      if (!editor || !overlay) return;

      const drawflowId = this._findDrawflowId
        ? this._findDrawflowId(this.selectedNodeId)
        : this.selectedNodeId;
      const node = editor.getNodeFromId(drawflowId);
      if (!node) return;

      const NODE_TYPES = ['generate', 'chatgpt', 'grok'];
      const type = node.data?.node_type || node.class;
      if (!NODE_TYPES.includes(type)) return;

      const promptSourceRow = overlay.querySelector('.prompt-source-row');
      if (!promptSourceRow) return;

      // Remove old indicators
      promptSourceRow.querySelector('.prompt-source-inline-indicator')?.remove();
      promptSourceRow.querySelector('.prompt-source-inline-warning')?.remove();

      // Check toggle state - only show indicator when using upstream
      const toggle = overlay.querySelector('#promptSourceToggle');
      if (toggle?.checked) return; // Using own prompt, no indicator needed

      // Check tất cả inputs để tìm upstream Prompt node
      let upstreamNode = null;
      const allInputKeys = Object.keys(node.inputs || {});
      for (const inputKey of allInputKeys) {
        const conns = node.inputs?.[inputKey]?.connections || [];
        for (const conn of conns) {
          const srcNode = editor.getNodeFromId(conn.node);
          const srcType = srcNode?.data?.node_type || srcNode?.class;
          if (srcType === 'prompt') {
            upstreamNode = srcNode;
            break;
          }
        }
        if (upstreamNode) break;
      }

      const promptSourceIcon = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M6.17 3.646a.5.5 0 0 1 .707 0l5.477 5.477a.5.5 0 0 1 0 .707l-1.366 1.366a4.373 4.373 0 1 1-6.184-6.184L6.17 3.646Zm.353 1.061L5.508 5.723 5.5 5.73a3.373 3.373 0 1 0 4.77 4.77l.006-.008 1.016-1.015-4.77-4.77Z" fill="currentColor"></path><path fill-rule="evenodd" clip-rule="evenodd" d="M5.354 10.646a.5.5 0 0 1 0 .707L3.02 13.688a.5.5 0 1 1-.707-.707l2.334-2.334a.5.5 0 0 1 .707 0ZM10.354 2.313a.5.5 0 0 1 0 .707L8.02 5.354a.5.5 0 0 1-.707-.708l2.334-2.333a.5.5 0 0 1 .707 0ZM13.687 5.646a.5.5 0 0 1 0 .708l-2.333 2.333a.5.5 0 1 1-.707-.707l2.333-2.334a.5.5 0 0 1 .707 0Z" fill="currentColor"></path></svg>';

      if (upstreamNode) {
        const upstreamName = upstreamNode?.data?.node_name
          || upstreamNode?.data?.prompt?.substring(0, 30)
          || 'Prompt';
        const displayName = upstreamName.length > 15 ? upstreamName.substring(0, 15) + '…' : upstreamName;
        const indicator = document.createElement('span');
        indicator.className = 'prompt-source-inline-indicator';
        indicator.title = upstreamName;
        indicator.innerHTML = `${promptSourceIcon}<span>${this.escapeHtml(displayName)}</span>`;
        promptSourceRow.appendChild(indicator);
      } else {
        const warning = document.createElement('span');
        warning.className = 'prompt-source-inline-warning';
        warning.title = window.I18n?.t('workflow.noUpstreamPrompt') || 'Chưa connect upstream Prompt node';
        warning.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
        promptSourceRow.appendChild(warning);
      }
    } catch (e) { /* ignore */ }
  }

  /** @deprecated giữ để không break gọi cũ — no-op vì banner đã chuyển sang sidebar */
  _updatePromptSourceBadge(_nodeId, _upstreamName) { /* no-op */ }

  _restoreNodeStates() {
    if (!this.workflow?.nodes) return;

    let allCompleted = true;
    let hasAny = false;

    for (const node of this.workflow.nodes) {
      hasAny = true;

      // Pre-populate _tileCache from saved thumbnails (survives reload)
      if (node.result_thumbnails && typeof node.result_thumbnails === 'object') {
        console.log(`[WorkflowEditor] Pre-populate cache for node "${node.node_name}": result_thumbnails keys=`, Object.keys(node.result_thumbnails), 'result_file_ids=', node.result_file_ids);
        for (const [fileId, thumbVal] of Object.entries(node.result_thumbnails)) {
          if (fileId && thumbVal && !this._tileCache.has(fileId)) {
            // Handle both formats: string (URL) or object { thumbnail, type, video_url }
            if (typeof thumbVal === 'object' && thumbVal.thumbnail) {
              // Bug 51 fix: Include video_url for video playback after reload
              this._tileCacheSet(fileId, {
                thumbnail: thumbVal.thumbnail,
                type: thumbVal.type || 'image',
                ...(thumbVal.video_url && { video_url: thumbVal.video_url })
              });
            } else if (typeof thumbVal === 'string') {
              this._tileCacheSet(fileId, { thumbnail: thumbVal, type: 'image' });
            }
          }
        }
      }
      // Pre-populate _tileCache from saved ref thumbnails (survives reload)
      // Chỉ lấy entries có trong ref_file_ids hiện tại (tránh stale entries)
      console.log(`[WorkflowEditor] Pre-populate ref_thumbnails for node "${node.node_name}" (${node.node_type}): ref_thumbnails keys=${Object.keys(node.ref_thumbnails || {}).join(',') || '(none)'}, ref_file_ids="${node.ref_file_ids || ''}"`);
      if (node.ref_thumbnails && typeof node.ref_thumbnails === 'object') {
        const activeRefIds = node.ref_file_ids
          ? new Set(node.ref_file_ids.split(',').map(s => s.trim()).filter(Boolean))
          : null;
        for (const [fileId, thumbVal] of Object.entries(node.ref_thumbnails)) {
          // 2026-05-27: thumbVal có thể là string (URL) hoặc object {thumbnail, type:'video', video_url}
          // 2026-05-31 fix: restore cả video_url + chấp nhận thumbnail empty cho video tile
          const isObj = thumbVal && typeof thumbVal === 'object';
          const thumbUrl = isObj ? (thumbVal.thumbnail || '') : (thumbVal || '');
          const videoUrl = isObj ? (thumbVal.video_url || '') : '';
          const refType = (isObj && thumbVal.type === 'video') ? 'video' : 'image';
          // Cache khi: có thumbnail HOẶC có video_url HOẶC là video type (cho placeholder)
          const hasAnyData = thumbUrl || videoUrl || refType === 'video';
          if (fileId && hasAnyData && !this._tileCache.has(fileId)) {
            if (!activeRefIds || activeRefIds.has(fileId)) {
              this._tileCacheSet(fileId, {
                thumbnail: thumbUrl,
                type: refType,
                ...(videoUrl && { video_url: videoUrl }),
              });
            }
          }
        }
      }
      // Restore result_file_names into _tileCache metadata (for correction lookups)
      if (node.result_file_names && typeof node.result_file_names === 'object') {
        for (const [fileId, fileName] of Object.entries(node.result_file_names)) {
          if (fileId && fileName) {
            const cached = this._tileCache.get(fileId);
            if (cached) {
              cached.file_name = fileName;
            }
          }
        }
      }
      // Restore ref_file_names into _tileCache metadata (for correction lookups) - Phase R
      // Chỉ lấy entries có trong ref_file_ids hiện tại
      if (node.ref_file_names && typeof node.ref_file_names === 'object') {
        const activeRefIds2 = node.ref_file_ids
          ? new Set(node.ref_file_ids.split(',').map(s => s.trim()).filter(Boolean))
          : null;
        for (const [fileId, fileName] of Object.entries(node.ref_file_names)) {
          if (fileId && fileName && (!activeRefIds2 || activeRefIds2.has(fileId))) {
            const cached = this._tileCache.get(fileId);
            if (cached) {
              cached.file_name = fileName;
            } else {
              // Create cache entry with file_name for correction
              this._tileCacheSet(fileId, { file_name: fileName });
            }
          }
        }
      }

      // Restore status UI (completed, failed, etc.)
      // Luôn gọi kể cả pending để clear CSS classes cũ (node-completed, node-failed) sau reset
      if (node.status) {
        this._updateNodeStatusUI(node.node_id, node.status);
      }

      if (node.status !== 'completed') {
        allCompleted = false;
      }

      // Restore previews from _tileCache only (no MessageBridge scan here).
      // Missing thumbnails will be handled by _backgroundThumbnailScan later.
      if (node.status === 'completed' && node.result_file_ids) {
        const fileIds = node.result_file_ids.split(',').map(s => s.trim()).filter(Boolean);
        const cachedIds = fileIds.filter(id => this._tileCache.has(id));
        console.log(`[WorkflowEditor] Restore preview for node "${node.node_name}": fileIds=`, fileIds, 'cached=', cachedIds.length, '/', fileIds.length);
        if (fileIds.length > 0 && cachedIds.length > 0) {
          this._directRenderNodePreview(node.node_id, fileIds);
        }
      }

      // 2026-05-31 REVERTED: bỏ _showNodeRefPreview trigger ở đây — gây regression mất
      // result preview. _directRenderNodeRefFromCache ở dưới (line ~2537) đã handle ref
      // preview render cho image refs. Video refs sẽ hiển thị placeholder play icon (chấp
      // nhận) thay vì <video> element — better than data loss.

      // Template mode hoặc template preview: hiển thị ref images từ ref_img_urls hoặc ref_thumbnails trên node diagram
      const isTemplateContext = this.isTemplateMode || this.workflow?._is_template_preview || this.workflow?._isPreview;

      // Template mode: hiển thị result từ result_img_url hoặc result_thumbnails
      if (isTemplateContext) {
        if (node.result_img_url) {
          this._renderTemplateResultOnNode(node.node_id, node.result_img_url);
        } else if (node.result_thumbnails && Object.keys(node.result_thumbnails).length > 0) {
          // result_thumbnails là object {fileId: url} hoặc {fileId: {thumbnail: url}}
          const resultUrls = Object.values(node.result_thumbnails).map(v =>
            typeof v === 'string' ? v : (v?.thumbnail || '')
          ).filter(Boolean);
          if (resultUrls.length > 0) {
            this._renderTemplateResultOnNode(node.node_id, resultUrls[0]);
          }
        }
      }
      if (isTemplateContext && (node.ref_img_urls?.length > 0 || (node.ref_thumbnails && Object.keys(node.ref_thumbnails).length > 0))) {
        const refUrls = node.ref_img_urls || Object.values(node.ref_thumbnails || {});
        if (refUrls.length > 0) {
          this._renderTemplateRefOnNode(node.node_id, refUrls);
        }
      }

      // Image node: luôn hiển thị ref image làm preview (flow image hoặc local upload)
      if (!isTemplateContext && node.node_type === 'image' && node.ref_file_ids) {
        const refIds = node.ref_file_ids.split(',').map(s => s.trim()).filter(Boolean);
        if (refIds.length > 0) {
          this._directRenderNodePreview(node.node_id, refIds);
        }
      }

      // Bug fix: trước fix chỉ 'generate' → load workflow lên, ChatGPT/Grok/Prompt có ref images
      // không hiện thumbnails ở phần dưới prompt. Mở rộng cho TẤT CẢ node accept image_ref.
      // 2026-05-31: bỏ điều kiện `cache.has(id)` — luôn call render (kể cả cache empty)
      // → render placeholder cho user thấy ref slot, auto-rescan sẽ populate cache sau.
      if (['generate', 'chatgpt', 'grok', 'prompt'].includes(node.node_type) && node.ref_file_ids) {
        const refIds = node.ref_file_ids.split(',').map(s => s.trim()).filter(Boolean);
        if (refIds.length > 0) {
          this._directRenderNodeRefFromCache(node.node_id, refIds);
        }
      }
    }

    // Nếu tất cả node đã completed → hiện Reset, ẩn Chạy
    if (hasAny && allCompleted) {
      this._showResetButton();
    }

    // Correct stale file IDs (tile IDs thay đổi sau reload Flow page)
    this._correctStaleIds();

    // Background: scan Flow for any file IDs not yet in _tileCache
    this._backgroundThumbnailScan();

    // Sync running state từ executor nếu workflow đang chạy (editor mở sau khi start)
    this._syncRunningNodeFromExecutor();
  }

  /**
   * Sync running node UI từ executor khi editor mở sau khi workflow đã bắt đầu chạy.
   * Fix bug: mở editor khi workflow đang chạy từ sidebar → node không có UI running.
   */
  _syncRunningNodeFromExecutor() {
    const executor = window.workflowExecutor;
    if (!executor?.isRunning) return;
    if (!executor.currentWorkflow?.wf_id) return;
    if (executor.currentWorkflow.wf_id !== this.workflow?.wf_id) return;

    const runningNodeId = executor.currentNode?.node_id;
    if (runningNodeId) {
      this._updateNodeStatusUI(runningNodeId, 'running');
      this._disableFormIfSelectedNode(runningNodeId, true);
    }

    // Sync overlay executing class
    this.overlay?.classList.add('wf-executing');
  }

  /**
   * Scan Flow via MessageBridge to fill _tileCache for file IDs missing thumbnails.
   * Runs after _restoreNodeStates to recover thumbnails lost during extension reload.
   * Shows loading shimmer on nodes with missing previews.
   * Renders directly from _tileCache (no nested scans) to avoid cascade API calls.
   */
  _clearBgScanTimers() {
    if (this._bgScanTimers) {
      for (const t of this._bgScanTimers) clearTimeout(t);
      this._bgScanTimers = [];
    }
  }

  _backgroundThumbnailScan(retryCount = 0) {
    if (typeof MessageBridge === 'undefined' || !this.workflow?.nodes) return;
    const maxRetries = 0;
    if (!this._bgScanTimers) this._bgScanTimers = [];

    // Collect all file IDs that need thumbnails + nodes with missing previews
    const missingIds = new Set();
    const nodesMissingPreview = [];
    for (const node of this.workflow.nodes) {
      const resultIds = (node.result_file_ids || '').split(',').filter(Boolean);
      const refIds = (node.ref_file_ids || '').split(',').filter(Boolean);
      let hasMissing = false;
      for (const id of [...resultIds, ...refIds]) {
        if (!id.startsWith('upload_') && !this._tileCache.has(id)) {
          missingIds.add(id);
          hasMissing = true;
        }
      }
      if (hasMissing) nodesMissingPreview.push(node);
    }
    if (missingIds.size === 0) {
      this._hideBackgroundScanLoading();
      return;
    }

    // Show loading shimmer on first attempt only
    if (retryCount === 0) {
      this._showBackgroundScanLoading(nodesMissingPreview);
    }

    const missingArr = [...missingIds];
    console.log('[TobyFlow] Background scan:', missingArr.length, 'missing thumbnails');
    const delay = retryCount === 0 ? 1500 : 2500;
    const timerId = setTimeout(() => {
      MessageBridge.getThumbnailsByIds(missingArr).then(result => {
        const results = result?.results || {};
        let found = 0;
        let fileNamesFound = false;
        for (const [fileId, info] of Object.entries(results)) {
          if (info?.thumbnail) {
            this._tileCacheSet(fileId, { thumbnail: info.thumbnail, type: info.type || 'image' });
            found++;
          }
          if (info?.file_name) {
            this._persistSingleFileName(fileId, info.file_name);
            fileNamesFound = true;
          }
        }

        if (found > 0) {
          console.log('[TobyFlow] Background scan found', found, '/', missingArr.length, 'thumbnails');
          this._directRenderFromCache(nodesMissingPreview);
          this._deferredThumbnailSave();
        }
        if (fileNamesFound) {
          this._deferredThumbnailSave();
        }

        const stillMissing = missingArr.filter(id => !this._tileCache.has(id));
        if (stillMissing.length > 0 && retryCount === 0) {
          console.log('[TobyFlow] Background scan: còn', stillMissing.length, 'missing, đang chuẩn bị Flow...');
          // 2026-05-25: Activate Flow tab trước khi retry scan — chỉ 1 lần per editor session.
          // Background Flow tab có thể bị browser suspend → lazy images không render → scan miss.
          const activateFlowTab = (!this._flowTabActivatedForScan)
            ? new Promise((resolve) => {
                this._flowTabActivatedForScan = true;
                try {
                  chrome.runtime.sendMessage({ action: 'ensureFlowTabActive' }, () => resolve());
                } catch (e) { resolve(); }
              })
            : Promise.resolve();
          activateFlowTab.then(() => MessageBridge.prepareFlowForScan()).then(() => {
            return MessageBridge.getThumbnailsByIds(stillMissing);
          }).then(retryResult => {
            const retryResults = retryResult?.results || {};
            let retryFound = 0;
            for (const [fileId, info] of Object.entries(retryResults)) {
              if (info?.thumbnail) {
                this._tileCacheSet(fileId, { thumbnail: info.thumbnail, type: info.type || 'image' });
                retryFound++;
              }
              if (info?.file_name) {
                this._persistSingleFileName(fileId, info.file_name);
              }
            }
            if (retryFound > 0) {
              console.log('[TobyFlow] Background scan retry found', retryFound, 'more thumbnails');
              this._directRenderFromCache(nodesMissingPreview);
              this._deferredThumbnailSave();
            }
            this._hideBackgroundScanLoading();
          }).catch(err => {
            console.warn('[TobyFlow] Background scan retry failed:', err.message);
            this._hideBackgroundScanLoading();
          });
        } else {
          this._hideBackgroundScanLoading();
          if (stillMissing.length > 0) {
            console.log('[TobyFlow] Background scan done,', stillMissing.length, 'thumbnails not found on Flow page');
          }
        }
      }).catch(err => {
        console.warn('[TobyFlow] Background thumbnail scan failed:', err.message);
        this._hideBackgroundScanLoading();
      });
    }, delay);
    this._bgScanTimers.push(timerId);
  }

  /**
   * Correct stale tile IDs bằng thumbnail URL matching.
   * Gọi sau _restoreNodeStates để cập nhật file IDs nếu Flow đã reload.
   */
  _correctStaleIds() {
    if (typeof MessageBridge === 'undefined' || !this.workflow?.nodes) return;

    // Build idToUrlMap + fileNameMap từ tất cả nodes
    const idToUrlMap = {};
    const fileNameMap = {};
    for (const node of this.workflow.nodes) {
      const allThumbs = { ...(node.result_thumbnails || {}), ...(node.ref_thumbnails || {}) };
      for (const [fileId, urlOrObj] of Object.entries(allThumbs)) {
        // result_thumbnails có thể chứa object {thumbnail, type, file_name} hoặc string URL
        const url = typeof urlOrObj === 'object' ? (urlOrObj.thumbnail || urlOrObj.url) : urlOrObj;
        if (fileId && url && typeof url === 'string' && !fileId.startsWith('upload_')) {
          idToUrlMap[fileId] = url;
        }
      }
      // Collect file_names for Tầng 1 matching (both result AND ref)
      const allFileNames = { ...(node.result_file_names || {}), ...(node.ref_file_names || {}) };
      for (const [fileId, fn] of Object.entries(allFileNames)) {
        if (fileId && fn && !fileId.startsWith('upload_')) {
          fileNameMap[fileId] = fn;
        }
      }
    }
    if (Object.keys(idToUrlMap).length === 0 && Object.keys(fileNameMap).length === 0) return;

    // Bug 46 fix: Ensure Flow tiles are loaded BEFORE correction to avoid correcting
    // new valid IDs to old stale IDs (khi tile mới chưa lazy-load vào DOM)
    const doCorrection = () => {
      MessageBridge.correctStaleFileIds(idToUrlMap, fileNameMap).then(result => {
      const corrections = result?.corrections || {};
      const crossProjectIds = result?.crossProjectIds || [];

      // Mark cross-project IDs in cache (for warning display)
      if (crossProjectIds.length > 0) {
        console.log('[TobyFlow] Cross-project detected:', crossProjectIds.length, 'IDs');
        if (!this._crossProjectRefIds) this._crossProjectRefIds = [];
        this._crossProjectRefIds.push(...crossProjectIds);
        // Mark in _tileCache
        for (const id of crossProjectIds) {
          if (this._tileCache.has(id)) {
            const cached = this._tileCache.get(id);
            cached._crossProject = true;
            this._tileCacheSet(id, cached);
          } else {
            this._tileCacheSet(id, { _crossProject: true });
          }
        }

        // Trigger re-render of affected nodes in DiagramCanvas
        this._updateCrossProjectNodePreviews(crossProjectIds);
      }

      if (Object.keys(corrections).length === 0 && crossProjectIds.length === 0) return;

      console.log('[TobyFlow] Corrected', Object.keys(corrections).length, 'stale tile IDs');

      // Update node data
      for (const node of this.workflow.nodes) {
        let changed = false;

        // Correct result_file_ids
        if (node.result_file_ids) {
          const ids = node.result_file_ids.split(',').map(s => s.trim()).filter(Boolean);
          const corrected = ids.map(id => corrections[id] || id);
          const newStr = corrected.join(',');
          if (newStr !== node.result_file_ids) {
            node.result_file_ids = newStr;
            this._syncDrawflowNodeData(node.node_id, { result_file_ids: newStr });
            changed = true;
          }
        }

        // Correct ref_file_ids
        if (node.ref_file_ids) {
          const ids = node.ref_file_ids.split(',').map(s => s.trim()).filter(Boolean);
          const corrected = ids.map(id => corrections[id] || id);
          const newStr = corrected.join(',');
          if (newStr !== node.ref_file_ids) {
            node.ref_file_ids = newStr;
            this._syncDrawflowNodeData(node.node_id, { ref_file_ids: newStr });
            changed = true;
          }
        }

        // Update thumbnail keys
        if (node.result_thumbnails) {
          const updated = {};
          for (const [oldId, url] of Object.entries(node.result_thumbnails)) {
            updated[corrections[oldId] || oldId] = url;
          }
          node.result_thumbnails = updated;
        }
        if (node.ref_thumbnails) {
          const updated = {};
          for (const [oldId, url] of Object.entries(node.ref_thumbnails)) {
            updated[corrections[oldId] || oldId] = url;
          }
          node.ref_thumbnails = updated;
        }

        // Update result_file_names keys
        if (node.result_file_names) {
          const updated = {};
          for (const [oldId, fn] of Object.entries(node.result_file_names)) {
            updated[corrections[oldId] || oldId] = fn;
          }
          node.result_file_names = updated;
        }
        // Update ref_file_names keys - Phase R
        if (node.ref_file_names) {
          const updated = {};
          for (const [oldId, fn] of Object.entries(node.ref_file_names)) {
            updated[corrections[oldId] || oldId] = fn;
          }
          node.ref_file_names = updated;
        }

        // Update _tileCache keys
        for (const [oldId, newId] of Object.entries(corrections)) {
          if (this._tileCache.has(oldId)) {
            const cached = this._tileCache.get(oldId);
            this._tileCache.delete(oldId);
            this._tileCacheSet(newId, cached);
          }
        }
      }

      // Auto-save corrected IDs
      this._deferredThumbnailSave();
      }).catch(err => {
        console.warn('[TobyFlow] correctStaleIds failed:', err.message);
      });
    };

    // Ensure tiles are loaded before correction (prepareFlowForScan calls ensureFlowTilesLoaded)
    if (MessageBridge.prepareFlowForScan) {
      MessageBridge.prepareFlowForScan().then(() => {
        doCorrection();
      }).catch(() => {
        // Fallback: run correction anyway if prepare fails
        doCorrection();
      });
    } else {
      doCorrection();
    }
  }

  /**
   * Show loading shimmer on node previews that are missing thumbnails
   */
  _showBackgroundScanLoading(nodes) {
    if (!this.overlay) return;
    for (const node of nodes) {
      // Skip pending nodes without results - chưa run và chưa có gì để load
      // Ngoại lệ:
      // - Image node: ref_file_ids là preview chính, cần load
      // - Node có result_file_ids: có kết quả cần load preview
      const isImageNode = node.node_type === 'image';
      const hasResults = (node.result_file_ids || '').trim().length > 0;
      if (node.status === 'pending' && !isImageNode && !hasResults) continue;

      const drawflowId = this._findDrawflowId(node.node_id);
      if (!drawflowId) continue;
      const nodeEl = this.overlay.querySelector(`#node-${drawflowId}`);
      const previewEl = nodeEl?.querySelector('.df-node-preview');
      if (!previewEl) continue;
      const hasContent = previewEl.querySelector('img, video');
      if (hasContent) continue;
      previewEl.classList.remove('hidden');
      previewEl.innerHTML = `
        <div class="df-node-loading-shimmer">
          <span class="df-node-loading-text">${window.I18n?.t('workflow.loadingImages') || 'Loading images...'}</span>
        </div>`;
    }
  }

  /**
   * Update node previews to show cross-project warning for affected IDs
   */
  _updateCrossProjectNodePreviews(crossProjectIds) {
    if (!crossProjectIds?.length || !this.workflow?.nodes) return;

    const crossSet = new Set(crossProjectIds);

    for (const node of this.workflow.nodes) {
      // Check ref_file_ids
      const refIds = (node.ref_file_ids || '').split(',').filter(Boolean);
      const hasRefCross = refIds.some(id => crossSet.has(id));

      // Check result_file_ids
      const resultIds = (node.result_file_ids || '').split(',').filter(Boolean);
      const hasResultCross = resultIds.some(id => crossSet.has(id));

      if (!hasRefCross && !hasResultCross) continue;

      const drawflowId = this._findDrawflowId(node.node_id);
      if (!drawflowId) continue;

      // Update DiagramCanvas node preview to show warning
      const nodeEl = this.overlay?.querySelector(`#node-${drawflowId}`);
      const previewEl = nodeEl?.querySelector('.df-node-preview');
      if (previewEl) {
        previewEl.classList.add('df-node-cross-project');
        const existing = previewEl.querySelector('.cross-project-badge');
        if (!existing) {
          previewEl.insertAdjacentHTML('beforeend', `
            <div class="cross-project-badge" title="${window.I18n?.t('workflow.crossProjectImage') || 'Image from another project'}" style="position:absolute;top:4px;right:4px;background:var(--destructive,#dc2626);color:#fff;font-size:8px;padding:2px 4px;border-radius:3px;z-index:10;">
              ${window.I18n?.t('workflow.wrongProject') || 'Sai project'}
            </div>`);
        }
      }

      console.log(`[TobyFlow] Cross-project warning added to node ${node.node_id}: ref=${hasRefCross}, result=${hasResultCross}`);
    }
  }

  /**
   * Hide loading shimmer after background scan completes
   */
  _hideBackgroundScanLoading() {
    if (!this.overlay) return;
    this.overlay.querySelectorAll('.df-node-loading-shimmer').forEach(el => {
      const previewEl = el.closest('.df-node-preview');
      if (previewEl && !previewEl.querySelector('img, video')) {
        previewEl.innerHTML = `<div class="df-node-preview-placeholder">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.3"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
        </div>`;
      }
    });
  }

  /**
   * Render node previews directly from _tileCache (no MessageBridge scan, no retry).
   * Used by _backgroundThumbnailScan to avoid nested scan cascades.
   */
  _directRenderFromCache(nodes) {
    for (const node of nodes) {
      // Result preview for completed nodes
      if (node.status === 'completed' && node.result_file_ids) {
        const fileIds = node.result_file_ids.split(',').filter(Boolean);
        if (fileIds.some(id => this._tileCache.has(id))) {
          this._directRenderNodePreview(node.node_id, fileIds);
        }
      }
      // Template mode: result_img_url (ảnh preview mẫu)
      // Template mode hoặc template preview (Option A: _isPreview, Option B: _is_template_preview)
      const isTemplateCtx = this.isTemplateMode || this.workflow?._is_template_preview || this.workflow?._isPreview;
      if (isTemplateCtx && node.result_img_url) {
        this._renderTemplateResultOnNode(node.node_id, node.result_img_url);
      }
      // Template mode/preview: ref images từ ref_img_urls
      if (isTemplateCtx && (node.ref_img_urls?.length > 0 || (node.ref_thumbnails && Object.keys(node.ref_thumbnails).length > 0))) {
        const refUrls = node.ref_img_urls || Object.values(node.ref_thumbnails || {});
        if (refUrls.length > 0) {
          this._renderTemplateRefOnNode(node.node_id, refUrls);
        }
      }
      // Image node: ref images as main preview (normal mode only)
      if (!isTemplateCtx && node.node_type === 'image' && node.ref_file_ids) {
        const refIds = node.ref_file_ids.split(',').filter(Boolean);
        if (refIds.some(id => this._tileCache.has(id))) {
          this._directRenderNodePreview(node.node_id, refIds);
        }
      }
      // Generate/ChatGPT/Grok/Prompt node: ref image thumbnails at bottom of node card.
      // Bug fix: thêm 'prompt' (enhance mode có ref images) + 'chatgpt' alias.
      if (['generate', 'chatgpt', 'grok', 'prompt'].includes(node.node_type) && node.ref_file_ids) {
        const refIds = node.ref_file_ids.split(',').filter(Boolean);
        if (refIds.some(id => this._tileCache.has(id))) {
          this._directRenderNodeRefFromCache(node.node_id, refIds);
        }
      }
    }
  }

  /**
   * Render main node preview directly from _tileCache (no scan, no retry)
   */
  _directRenderNodePreview(nodeId, fileIds) {
    const drawflowId = this._findDrawflowId(nodeId);
    if (!drawflowId) return;
    const nodeEl = this.overlay?.querySelector(`#node-${drawflowId}`);
    const previewContainer = nodeEl?.querySelector('.df-node-preview');
    if (!previewContainer) return;

    const isImageNode = nodeEl.querySelector('.df-node[data-node-type="image"]') !== null;
    previewContainer.classList.toggle('image-ref', isImageNode);
    // 2026-05-25: Image node default ratio-9-16 (portrait) khi chưa có ref.
    // Có ref → bỏ class default để ảnh tự fit theo kích thước thực tế (object-fit: contain).
    if (isImageNode) {
      const hasRefs = Array.isArray(fileIds) && fileIds.length > 0;
      previewContainer.classList.toggle('ratio-9-16', !hasRefs);
    }
    previewContainer._nodeId = nodeId;
    // Render directly — _renderNodePreviewInner uses _tileCache which is already populated
    this._renderNodePreviewInner(previewContainer, [...new Set(fileIds)], 5); // attempt=5 disables retry
  }

  /**
   * Render ref thumbnails at bottom of generate nodes from _tileCache
   */
  _directRenderNodeRefFromCache(nodeId, refIds) {
    const drawflowId = this._findDrawflowId(nodeId);
    if (!drawflowId) return;
    const nodeEl = this.overlay?.querySelector(`#node-${drawflowId}`);
    let refContainer = nodeEl?.querySelector('.df-node-ref-preview');

    if (!refContainer && refIds.length > 0) {
      const body = nodeEl?.querySelector('.df-node-body');
      if (!body) return;
      refContainer = document.createElement('div');
      refContainer.className = 'df-node-ref-preview';
      refContainer.setAttribute('data-ref-preview', '');
      body.appendChild(refContainer);
    }
    if (!refContainer) return;

    refContainer.innerHTML = '';
    for (const tileId of [...new Set(refIds)].slice(0, 6)) {
      const cached = this._tileCache.get(tileId);
      // 2026-05-31 v5: detect video CHỈ qua type='video' hoặc file extension.
      // BỎ getMediaUrlRedirect URL pattern — Flow dùng cùng URL cho image + video → ambiguous!
      const cachedThumb = cached?.thumbnail || '';
      const isVideo = cached?.type === 'video' ||
        /\.(mp4|webm|mov|m4v)$/i.test(cached?.file_name || '');
      const videoUrl = cached?.video_url || '';
      const useVideo = isVideo && !!videoUrl;
      const useImg = !useVideo && cachedThumb;
      // 2026-05-31 v4: bỏ `continue` skip — ALWAYS render something cho mỗi ref ID.
      // Trước: cache empty → skip → user thấy fewer thumbnails hơn ref_file_ids count.
      const thumb = document.createElement('div');
      thumb.className = 'df-ref-thumb';
      if (useImg) {
        const img = document.createElement('img');
        img.src = cachedThumb;
        img.alt = 'ref';
        // Reactive video detect: nếu URL trả mp4 bytes → <img> fail → swap sang <video>.
        // Flow URL `getMediaUrlRedirect` không phân biệt image/video qua URL pattern.
        img.addEventListener('error', () => {
          const video = document.createElement('video');
          video.src = cachedThumb;
          video.muted = true; video.playsInline = true; video.preload = 'metadata';
          video.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block;background:#0c1320;';
          video.addEventListener('loadedmetadata', () => { try { video.currentTime = 0.1; } catch (_) {} }, { once: true });
          img.parentNode?.replaceChild(video, img);
          // Heal cache để render sau dùng <video> trực tiếp
          this._tileCacheSet(tileId, { ...(this._tileCache.get(tileId) || {}), type: 'video', video_url: cachedThumb });
        }, { once: true });
        thumb.appendChild(img);
      } else if (useVideo) {
        thumb.innerHTML = `<video src="${videoUrl}" muted playsinline preload="metadata" style="width:100%;height:100%;object-fit:cover;display:block;background:#0c1320;"></video>`;
        const vEl = thumb.querySelector('video');
        if (vEl) vEl.addEventListener('loadedmetadata', () => { try { vEl.currentTime = 0.1; } catch (_) {} }, { once: true });
      } else if (isVideo) {
        // Video tile thiếu URL → play icon placeholder
        thumb.innerHTML = '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:rgba(99,102,241,0.10);color:var(--primary,#6366f1);"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M8 5v14l11-7z"/></svg></div>';
      } else {
        // Image ref thiếu cache (mới load workflow, chưa scan) → image broken icon placeholder
        // Auto-rescan sẽ populate cache sau, lúc đó render lại.
        thumb.innerHTML = '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:rgba(245,158,11,0.06);color:var(--muted-foreground);" title="' + this.escapeAttr(tileId.substring(0, 12)) + '"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg></div>';
      }
      refContainer.appendChild(thumb);
    }
  }

  /**
   * Render template result preview image trên node trong diagram
   * Dùng cho template mode khi node có result_img_url (ảnh mẫu kết quả)
   * @param {string} nodeId - Node ID
   * @param {string} resultImgUrl - URL của ảnh kết quả mẫu
   */
  _renderTemplateResultOnNode(nodeId, resultImgUrl) {
    if (!resultImgUrl) return;

    const drawflowId = this._findDrawflowId(nodeId);
    if (!drawflowId) return;

    const nodeEl = this.overlay?.querySelector(`#node-${drawflowId}`);
    const previewContainer = nodeEl?.querySelector('.df-node-preview');
    if (!previewContainer) return;

    previewContainer.innerHTML = '';
    previewContainer.classList.remove('hidden', 'multi-result');
    previewContainer.classList.add('template-result-preview');

    const thumb = document.createElement('div');
    thumb.className = 'df-preview-thumb';
    // 2026-05-25: Template result image cũng clickable mở media viewer
    thumb.dataset.mediaType = 'image';
    thumb.dataset.mediaSrc = resultImgUrl;

    const img = document.createElement('img');
    img.src = resultImgUrl;
    img.alt = 'template result';
    img.onerror = () => {
      previewContainer.classList.add('hidden');
    };

    thumb.appendChild(img);
    this._attachThumbZoom(thumb);
    previewContainer.appendChild(thumb);
  }

  /**
   * Clear template result preview trên node (khi user xóa ảnh mẫu)
   * Restore placeholder thay vì ẩn hoàn toàn
   * @param {string} nodeId - Node ID
   */
  _clearTemplateResultOnNode(nodeId) {
    const drawflowId = this._findDrawflowId(nodeId);
    if (!drawflowId) return;

    const nodeEl = this.overlay?.querySelector(`#node-${drawflowId}`);
    const previewContainer = nodeEl?.querySelector('.df-node-preview');
    if (!previewContainer) return;

    // Restore placeholder thay vì xóa hoàn toàn
    previewContainer.innerHTML = `
      <div class="df-node-preview-placeholder">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.3">
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
          <circle cx="8.5" cy="8.5" r="1.5"/>
          <polyline points="21 15 16 10 5 21"/>
        </svg>
      </div>`;
    previewContainer.classList.remove('hidden', 'template-result-preview', 'template-ref-preview', 'multi-result', 'image-ref');
  }

  /**
   * Render ref images (URLs) trên node diagram cho template mode
   * - Image node: render vào .df-node-preview (main preview)
   * - Generate/ChatGPT/Grok/Prompt nodes: render vào .df-node-ref-preview (thumbnails dưới cùng)
   * @param {string} nodeId - Node ID
   * @param {string[]} refUrls - Mảng URLs ảnh tham chiếu
   */
  _renderTemplateRefOnNode(nodeId, refUrls, retryCount = 0) {
    if (!refUrls || refUrls.length === 0) return;

    const drawflowId = this._findDrawflowId(nodeId);

    // Retry if drawflowId not found yet (DOM may not be ready)
    if (!drawflowId) {
      if (retryCount < 5) {
        setTimeout(() => this._renderTemplateRefOnNode(nodeId, refUrls, retryCount + 1), 100 * (retryCount + 1));
      }
      return;
    }

    const nodeEl = this.overlay?.querySelector(`#node-${drawflowId}`);
    if (!nodeEl) {
      if (retryCount < 5) {
        setTimeout(() => this._renderTemplateRefOnNode(nodeId, refUrls, retryCount + 1), 100 * (retryCount + 1));
      }
      return;
    }

    // Detect node type
    const node = this.diagramCanvas?.editor?.getNodeFromId(drawflowId);
    const nodeType = node?.data?.node_type || node?.class;
    const isImageNode = nodeType === 'image';

    if (isImageNode) {
      // Image node: render vào .df-node-preview (main preview)
      const previewContainer = nodeEl.querySelector('.df-node-preview');
      if (!previewContainer) return;

      previewContainer.innerHTML = '';
      previewContainer.classList.remove('hidden', 'template-result-preview');
      previewContainer.classList.add('template-ref-preview', 'image-ref');
      previewContainer.classList.toggle('multi-result', refUrls.length > 1);

      refUrls.forEach((url, index) => {
        if (!url) return;
        const thumb = document.createElement('div');
        thumb.className = 'df-preview-thumb';
        // 2026-05-25: Template ref image clickable mở media viewer
        thumb.dataset.mediaType = 'image';
        thumb.dataset.mediaSrc = url;
        const img = document.createElement('img');
        img.src = url;
        img.alt = `ref image ${index + 1}`;
        thumb.appendChild(img);
        this._attachThumbZoom(thumb);
        previewContainer.appendChild(thumb);
      });
    } else {
      // Generate/ChatGPT/Grok/Prompt nodes: render vào .df-node-ref-preview (thumbnails dưới cùng)
      let refContainer = nodeEl.querySelector('.df-node-ref-preview');

      if (!refContainer && refUrls.length > 0) {
        const body = nodeEl.querySelector('.df-node-body');
        if (!body) return;
        refContainer = document.createElement('div');
        refContainer.className = 'df-node-ref-preview';
        refContainer.setAttribute('data-ref-preview', '');
        body.appendChild(refContainer);
      }
      if (!refContainer) return;

      refContainer.innerHTML = '';
      refUrls.slice(0, 6).forEach((url, index) => {
        if (!url) return;
        const thumb = document.createElement('div');
        thumb.className = 'df-ref-thumb';
        const img = document.createElement('img');
        img.src = url;
        img.alt = `ref ${index + 1}`;
        thumb.appendChild(img);
        refContainer.appendChild(thumb);
      });
    }
  }

  _showResetButton() {
    if (!this.overlay) return;
    if (this.isReadOnly()) return; // Không show reset ở read-only
    const resetBtn = this.overlay.querySelector('#resetWorkflowInEditorBtn');
    const toolbarPlayBtn = this.overlay.querySelector('.tobyflow-wf-tool-btn[data-action="run-workflow"]');
    resetBtn?.classList.remove('hidden');
    toolbarPlayBtn?.classList.add('hidden');
  }

  _showRunButton() {
    if (!this.overlay) return;
    if (this.isReadOnly()) return; // Không show play ở read-only
    const resetBtn = this.overlay.querySelector('#resetWorkflowInEditorBtn');
    const toolbarPlayBtn = this.overlay.querySelector('.tobyflow-wf-tool-btn[data-action="run-workflow"]');
    resetBtn?.classList.add('hidden');
    toolbarPlayBtn?.classList.remove('hidden');
  }

  /**
   * Update play button visibility based on saving status.
   * Lock (mờ + not-allowed) khi: _isSaving OR _deferredSaveTimer pending.
   * Lý do: trước fix ẩn nút (display:none) → các button khác dịch lên → click undo xong
   * vị trí redo trở thành undo → user click trúng undo lần 2. Giữ button visible + lock.
   *
   * Class `is-saving-locked` riêng biệt với `.hidden` (logic Run/Stop toggle) →
   * tránh đè state khi save xong (Run vẫn hidden vì đang Stop, hoặc ngược lại).
   */
  _updatePlayButtonState() {
    if (!this.overlay) return;
    const runSingleNodeBtn = this.overlay.querySelector('#runSingleNodeBtn');
    const toolbarRunBtn = this.overlay.querySelector('.tobyflow-wf-tool-btn[data-action="run-workflow"]');

    const hasPendingSave = this._isSaving || this._deferredSaveTimer !== null;

    if (runSingleNodeBtn) {
      runSingleNodeBtn.disabled = hasPendingSave;
      runSingleNodeBtn.classList.toggle('is-saving-locked', hasPendingSave);
    }
    if (toolbarRunBtn) {
      toolbarRunBtn.disabled = hasPendingSave;
      toolbarRunBtn.classList.toggle('is-saving-locked', hasPendingSave);
    }
  }

  /**
   * Update quota display showing runs used/limit and nodes used/limit
   */
  async _updateQuotaDisplay() {
    if (!this.overlay) return;

    // EWT-6: Ẩn quota display khi ở template mode (không liên quan đến user quota)
    const quotaDisplay = this.overlay.querySelector('#wfQuotaDisplay');
    if (this.isTemplateMode && quotaDisplay) {
      quotaDisplay.classList.add('hidden');
      return;
    } else if (quotaDisplay) {
      quotaDisplay.classList.remove('hidden');
    }

    const runsEl = this.overlay.querySelector('#wfQuotaRuns .wf-quota-value');
    const nodesEl = this.overlay.querySelector('#wfQuotaNodes .wf-quota-value');

    // Get workflows_run_max quota
    if (window.featureGate && runsEl) {
      try {
        const runQuota = await this._safeCheckQuotaAsync('workflows_run_max');
        const isUnlimited = runQuota.limit === 'unlimited';
        const limitHtml = isUnlimited ? '<span class="wf-quota-unlimited">&infin;</span>' : runQuota.limit;
        runsEl.innerHTML = `${runQuota.used}/${limitHtml}`;
        // Add warning class if near limit
        const runsItem = this.overlay.querySelector('#wfQuotaRuns');
        if (!isUnlimited && runQuota.used >= runQuota.limit) {
          runsItem?.classList.add('wf-quota-exhausted');
          runsItem?.classList.remove('wf-quota-warning');
        } else if (!isUnlimited && runQuota.used >= runQuota.limit * 0.8) {
          runsItem?.classList.add('wf-quota-warning');
          runsItem?.classList.remove('wf-quota-exhausted');
        } else {
          runsItem?.classList.remove('wf-quota-warning', 'wf-quota-exhausted');
        }
      } catch (e) {
        console.warn('[WorkflowEditor] Failed to get run quota:', e.message);
      }
    }

    // Get workflows_nodes_max quota (current workflow node count vs limit)
    if (window.featureGate && nodesEl) {
      try {
        const nodeQuota = await this._safeCheckQuotaAsync('workflows_nodes_max');
        const currentNodes = this.workflow?.nodes?.length || 0;
        const isUnlimited = nodeQuota.limit === 'unlimited';
        const limitHtml = isUnlimited ? '<span class="wf-quota-unlimited">&infin;</span>' : nodeQuota.limit;
        nodesEl.innerHTML = `${currentNodes}/${limitHtml}`;
        // Add warning class if near limit
        const nodesItem = this.overlay.querySelector('#wfQuotaNodes');
        if (!isUnlimited && currentNodes >= nodeQuota.limit) {
          nodesItem?.classList.add('wf-quota-exhausted');
          nodesItem?.classList.remove('wf-quota-warning');
        } else if (!isUnlimited && currentNodes >= nodeQuota.limit * 0.8) {
          nodesItem?.classList.add('wf-quota-warning');
          nodesItem?.classList.remove('wf-quota-exhausted');
        } else {
          nodesItem?.classList.remove('wf-quota-warning', 'wf-quota-exhausted');
        }
      } catch (e) {
        console.warn('[WorkflowEditor] Failed to get node quota:', e.message);
      }
    }

    // Upgrade button — chỉ hiện cho free/trial user. CSS body.hide-upgrade-ui đã xử lý
    // riêng case admin tắt setting 'Hiển thị các gợi ý nâng cấp' (sidebar.css rule).
    const upgradeBtn = this.overlay.querySelector('#wfUpgradeBtn');
    if (upgradeBtn) {
      const isFree = !!(window.featureGate?.isFreePlan?.());
      upgradeBtn.classList.toggle('hidden', !isFree);
    }
  }

  bindEvents() {
    if (!this.overlay) return;

    // Close buttons
    const closeBtn = this.overlay.querySelector('#closeEditorBtn');
    closeBtn?.addEventListener('click', () => this.close());

    // Save workflow hoặc update template (EWT-6.2) hoặc tạo template mới (EWT-10)
    const saveBtn = this.overlay.querySelector('#saveWorkflowBtn');
    saveBtn?.addEventListener('click', () => {
      if (this.isTemplateMode) {
        if (this.templateId) {
          // Cập nhật template đã tồn tại
          this._updateTemplate();
        } else {
          // Tạo template mới
          this._createTemplate();
        }
      } else {
        this.saveWorkflow();
      }
    });

    // Upgrade button — gửi message đến sidebar mở upgrade modal (popup window không có
    // window.openUpgradeModal trực tiếp, phải relay qua background → sidePanel).
    const upgradeBtn = this.overlay.querySelector('#wfUpgradeBtn');
    upgradeBtn?.addEventListener('click', () => {
      try { chrome.runtime.sendMessage({ action: 'showUpgradeModal' }); } catch (_) {}
    });

    // Save as Template button (admin only) - EWT-5.1
    const saveAsTemplateBtn = this.overlay.querySelector('#wfSaveAsTemplateBtn');
    saveAsTemplateBtn?.addEventListener('click', () => this._saveAsTemplate());

    // Capture diagram (template edit mode, admin only) — chụp ảnh canvas → upload làm diagram_url
    const captureDiagramBtn = this.overlay.querySelector('#wfCaptureDiagramBtn');
    console.log('[WorkflowEditor] Bind capture btn:', !!captureDiagramBtn, 'isTemplateMode:', this.isTemplateMode, 'templateId:', this.templateId);
    captureDiagramBtn?.addEventListener('click', () => {
      console.log('[WorkflowEditor] Capture btn CLICKED');
      this._captureDiagramAndUpload();
    });

    // Edit Template button (admin only, chỉ hiện trong template preview readonly mode)
    const editTemplateBtn = this.overlay.querySelector('#wfEditTemplateBtn');
    editTemplateBtn?.addEventListener('click', () => this._editTemplateFromPreview());

    // Video Demo button (hiển thị khi template có video_url)
    const videoBtn = this.overlay.querySelector('#wfVideoBtn');
    videoBtn?.addEventListener('click', () => {
      const videoUrl = videoBtn.dataset.videoUrl;
      if (videoUrl) {
        this._showVideoModal(videoUrl);
      }
    });

    // Share button in header
    const shareHeaderBtn = this.overlay.querySelector('#shareWorkflowHeaderBtn');
    shareHeaderBtn?.addEventListener('click', () => this._shareWorkflow());

    // Sync header name → workflow object (và templateData nếu trong template mode)
    const nameInput = this.overlay.querySelector('#workflowName');
    nameInput?.addEventListener('input', () => {
      // Read-only mode: không cho phép edit name
      if (this.isReadOnly()) return;
      this.workflow.wf_name = nameInput.value || this.workflow.wf_name;
      // EWT-14: Đồng bộ với templateData nếu đang ở template mode
      if (this.isTemplateMode && this.templateData) {
        this.templateData.name = nameInput.value || this.templateData.name;
      }
    });

    // Workflow enabled toggle
    const enabledToggle = this.overlay.querySelector('#workflowEnabledToggle');
    enabledToggle?.addEventListener('click', () => {
      if (this.isReadOnly()) return; // Defensive: read-only không cho toggle
      this.workflow.enabled = this.workflow.enabled === false ? true : false;
      enabledToggle.classList.toggle('on', this.workflow.enabled !== false);
      enabledToggle.classList.toggle('off', this.workflow.enabled === false);
      enabledToggle.title = this.workflow.enabled !== false ? (window.I18n?.t('workflow.workflowOn') || 'Workflow đang bật') : (window.I18n?.t('workflow.workflowOff') || 'Workflow đang tắt');
    });

    // Node form close
    const closeFormBtn = this.overlay.querySelector('#closeNodeFormBtn');
    closeFormBtn?.addEventListener('click', () => this.hideNodeForm());

    // Save node
    const saveNodeBtn = this.overlay.querySelector('#saveNodeBtn');
    saveNodeBtn?.addEventListener('click', () => this.saveNode());

    // Close form (footer button)
    const closeFormBtn2 = this.overlay.querySelector('#closeNodeFormBtn2');
    closeFormBtn2?.addEventListener('click', () => this.hideNodeForm());

    // Node form tabs
    const nodeFormTabs = this.overlay.querySelector('#nodeFormTabs');
    nodeFormTabs?.addEventListener('click', (e) => {
      const tab = e.target.closest('.node-form-tab');
      if (!tab) return;
      const tabName = tab.dataset.tab;
      nodeFormTabs.querySelectorAll('.node-form-tab').forEach(t => t.classList.toggle('active', t === tab));
      const configBody = this.overlay.querySelector('#nodeFormBody');
      const resultBody = this.overlay.querySelector('#nodeResultBody');
      const footer = this.overlay.querySelector('#nodeFormFooter');
      const helpBody = this.overlay.querySelector('#nodeHelpBody');
      // Hide all tabs first
      configBody?.classList.add('hidden');
      resultBody?.classList.add('hidden');
      helpBody?.classList.add('hidden');
      footer?.classList.add('hidden');
      // Show selected tab
      if (tabName === 'config') {
        configBody?.classList.remove('hidden');
        footer?.classList.remove('hidden');
      } else if (tabName === 'help') {
        helpBody?.classList.remove('hidden');
      } else {
        resultBody?.classList.remove('hidden');
      }
    });

    // Run/Stop single node
    const runSingleNodeBtn = this.overlay.querySelector('#runSingleNodeBtn');
    runSingleNodeBtn?.addEventListener('click', () => {
      if (window.workflowExecutor?.isRunning) {
        window.workflowExecutor.stop();
      } else if (this.selectedNodeId) {
        this._runSingleNode(this.selectedNodeId);
      }
    });

    // Download node result files
    const downloadNodeBtn = this.overlay.querySelector('#downloadNodeBtn');
    downloadNodeBtn?.addEventListener('click', () => this._downloadNodeFiles());

    // Reset single node (header button)
    const resetSingleNodeBtn = this.overlay.querySelector('#resetSingleNodeBtn');
    resetSingleNodeBtn?.addEventListener('click', () => {
      if (this.selectedNodeId) this._resetSingleNode(this.selectedNodeId);
    });

    // Reset single node (footer button)
    const resetNodeFooterBtn = this.overlay.querySelector('#resetNodeFooterBtn');
    resetNodeFooterBtn?.addEventListener('click', () => {
      if (this.selectedNodeId) this._resetSingleNode(this.selectedNodeId);
    });

    // Delete node
    const deleteNodeBtn = this.overlay.querySelector('#deleteNodeBtn');
    deleteNodeBtn?.addEventListener('click', () => this.deleteNode());

    // Phase: toggle enabled (icon button trong node-form-header)
    const toggleEnabledBtn = this.overlay.querySelector('#toggleEnabledBtn');
    toggleEnabledBtn?.addEventListener('click', () => {
      if (this.isReadOnly()) return; // Read-only — không cho phép modify enable state
      const checkbox = this.overlay?.querySelector('#nodeEnabled');
      if (!checkbox) return;
      checkbox.checked = !checkbox.checked;
      this._syncEnabledToggleVisual();
    });

    // Node form panel resize handle
    this._bindNodeFormResize();

    // Duplicate banner button — phân biệt template preview vs shared workflow
    const duplicateSharedBtn = this.overlay.querySelector('#wfDuplicateSharedBtn');
    duplicateSharedBtn?.addEventListener('click', () => this._handleReadOnlyDuplicate());

    // Duplicate HEADER button (read-only mode)
    const duplicateHeaderBtn = this.overlay.querySelector('#duplicateSharedHeaderBtn');
    duplicateHeaderBtn?.addEventListener('click', () => this._handleReadOnlyDuplicate());

    // Run/Stop workflow in editor
    const toggleLogBtn = this.overlay.querySelector('#toggleLogPanelBtn');

    const resetInEditorBtn = this.overlay.querySelector('#resetWorkflowInEditorBtn');

    resetInEditorBtn?.addEventListener('click', () => this._resetWorkflowFromEditor());
    toggleLogBtn?.addEventListener('click', () => {
      const body = this.overlay?.querySelector('#executionLogBody');
      body?.classList.toggle('collapsed');
      const icon = toggleLogBtn.querySelector('svg');
      if (icon) {
        const isCollapsed = body?.classList.contains('collapsed');
        icon.innerHTML = isCollapsed
          ? '<polyline points="6 9 12 15 18 9"></polyline>'
          : '<polyline points="6 15 12 9 18 15"></polyline>';
      }
    });

    // Node run button (event delegation on diagram container)
    const diagramContainer = this.overlay.querySelector('#diagramContainer');

    // 2026-05-27: Chỉ NÚT zoom (giữa thumb) mở media viewer; phần thumb ngoài nút vẫn drag node.
    // mousedown trên nút → stop để KHÔNG trigger Drawflow drag. Ngoài nút → bỏ qua (cho drag).
    diagramContainer?.addEventListener('mousedown', (e) => {
      if (!e.target?.closest?.('.df-preview-zoom')) return;
      e.stopPropagation();
    }, true);  // capture phase — chặn trước khi Drawflow drag handler nhận
    diagramContainer?.addEventListener('click', (e) => {
      const zoom = e.target?.closest?.('.df-preview-zoom');
      if (!zoom) return;
      const thumb = zoom.closest('.df-preview-thumb[data-media-src]');
      if (!thumb || thumb.classList.contains('df-preview-thumb--uploading') ||
          thumb.classList.contains('df-preview-thumb--upload-failed')) return;
      e.stopPropagation();
      this._showMediaViewer({
        src: thumb.dataset.mediaSrc,
        type: thumb.dataset.mediaType,
        poster: thumb.dataset.mediaPoster,
      });
    });

    diagramContainer?.addEventListener('click', (e) => {
      const runBtn = e.target.closest('.df-node-run-btn');
      if (!runBtn) return;
      e.stopPropagation();

      // Không cho chạy node nếu workflow chưa được save
      if (this.mode === 'create') {
        window.customDialog?.alert(window.I18n?.t('workflow.saveBeforeRun') || 'Vui lòng lưu workflow trước khi chạy node.', { type: 'warning' });
        return;
      }

      // Find the drawflow node ID
      const drawflowNode = runBtn.closest('.drawflow-node');
      if (!drawflowNode) return;
      const drawflowId = drawflowNode.id?.replace('node-', '');
      if (!drawflowId) return;

      // Get node data from drawflow
      const nodeData = this.diagramCanvas?.editor?.getNodeFromId(drawflowId);
      if (!nodeData?.data?.node_id) return;

      // Check node có đủ dữ liệu để chạy
      // Bug fix: Ưu tiên node.data.node_type (original) over node.class (có thể bị corrupt)
      const nodeTypeVal = nodeData?.data?.node_type || nodeData?.class || 'generate';
      if (['generate', 'chatgpt', 'grok'].includes(nodeTypeVal)) {
        const promptCheck = this._checkNodeHasPrompt(drawflowId, nodeData);
        if (!promptCheck.ok) {
          window.customDialog?.alert(promptCheck.message, { type: 'warning' });
          return;
        }
      }

      this._runSingleNode(drawflowId);
    });

    // Track mouse position on diagram canvas for smart node placement
    // When user presses 'N' or clicks toolbar add-node, node spawns near mouse instead of center
    // IMPORTANT: Convert pixel coords → canvas coords (accounting for zoom/pan)
    diagramContainer?.addEventListener('mousemove', (e) => {
      const rect = diagramContainer.getBoundingClientRect();
      const pixelX = e.clientX - rect.left;
      const pixelY = e.clientY - rect.top;
      // Convert to canvas coords: world = (pixel - pan) / zoom
      const editor = this.diagramCanvas?.editor;
      const zoom = editor?.zoom || 1;
      const panX = editor?.canvas_x || 0;
      const panY = editor?.canvas_y || 0;
      this._lastMouseCanvasPos = {
        x: (pixelX - panX) / zoom,
        y: (pixelY - panY) / zoom,
      };
    });
    diagramContainer?.addEventListener('mouseleave', () => {
      // Clear position when mouse leaves canvas - fallback to center
      this._lastMouseCanvasPos = null;
    });

    // UI 2026-05-27: Đóng node form khi click RA NGOÀI .diagram-canvas (bổ sung cho .drawflow
    // empty-click ở DiagramCanvas) — click header/vùng trống cũng đóng. Giữ mở khi click sidebar,
    // trong canvas (node-select/empty đã handle), hoặc controls nổi (toolbar/zoom/legend).
    // Popup (img picker, inline dropdown) render ở document.body → không bubble tới overlay → an toàn.
    this.overlay.addEventListener('click', (e) => {
      const formPanel = this.overlay?.querySelector('#nodeFormPanel');
      if (!formPanel || formPanel.classList.contains('hidden')) return;
      const t = e.target;
      if (!t || typeof t.closest !== 'function') return;
      // Bug fix 2026-05-27: bỏ qua nếu target đã bị DETACH khỏi DOM trong lúc click (vd chọn item
      // mention autocomplete → hideDropdown() xóa innerHTML → item detached → closest() trả null →
      // tưởng nhầm "click ngoài" → đóng form + modal not-saved oan). Element detached → không phải
      // click ngoài thật sự.
      if (!t.isConnected) return;
      // Giữ mở khi click: sidebar (đang thao tác), node (select / mở settings node khác), connection/
      // port (tương tác canvas). MỌI vùng khác (canvas trống, header, toolbar, zoom, legend) → đóng.
      if (t.closest('#nodeFormPanel, .drawflow-node, .connection, .point')) return;
      this._handleNodeUnselected();
    });

    // Left toolbar actions — delegate to _dispatchToolbarAction (cũng dùng cho
    // canvas right-click context menu).
    const toolbar = this.overlay.querySelector('.tobyflow-wf-toolbar');
    toolbar?.addEventListener('click', (e) => {
      const btn = e.target.closest('.tobyflow-wf-tool-btn');
      if (!btn) return;
      this._dispatchToolbarAction(btn.dataset.action);
    });

    // Branch event from hover toolbar / context menu — tạo node mới + auto-connect.
    //
    // Logic dùng portContext flow (giống empty output port click):
    //   1. Build portContext cho first output port của source node (vd 'media' cho generate)
    //   2. Picker hiển thị filter theo port compat (chỉ types accept input tương thích)
    //   3. _calculateSpawnPosition đọc canvas coords (đã trừ zoom/pan) → vị trí chuẩn gần parent
    //   4. _autoConnectFromPortContext connect đúng port type (không cứng output_1 → input_1)
    //
    // Trước fix: posX/posY là pixel container coords nhưng `addNode(type, posX, posY)` expect
    // canvas coords → khi zoom ≠ 1 → node spawn xa parent (ví dụ zoom 0.5 → node cách 2x).
    window.eventBus?.on('node:branch', (data) => {
      if (!this.diagramCanvas) return;
      const editor = this.diagramCanvas.editor;
      const node = editor?.getNodeFromId(data.sourceNodeId);
      const containerEl = this.overlay?.querySelector('#diagramContainer');
      const nodeEl = this.overlay?.querySelector(`#node-${data.sourceNodeId}`);
      if (!node || !containerEl || !nodeEl) return;

      // Resolve first output port của source — cần để build portContext
      // Bug fix: Ưu tiên node.data.node_type (original) over node.class (có thể bị corrupt)
      const sourceType = node.data?.node_type || node.class;
      const sourcePorts = window.NodeTemplates?.getNodePorts?.(sourceType, node.data || {})
        || { in: [], out: [] };
      const firstOut = sourcePorts.out?.[0];
      if (!firstOut) {
        // Source không có output (vd note node) → không thể branch
        window.showNotification?.(
          window.I18n?.t('workflow.cannotBranchNoOutput') || 'Node này không có output để tạo nhánh',
          'warning', 2000
        );
        return;
      }

      const containerRect = containerEl.getBoundingClientRect();
      const nodeRect = nodeEl.getBoundingClientRect();
      // Picker UI position (pixel coords): bên phải node, gap 20px
      const posX = (nodeRect.right - containerRect.left) + 20;
      const posY = (nodeRect.top - containerRect.top);

      // Build portContext giống như click empty output port → spawn position chuẩn + auto-connect đúng
      const portContext = {
        side: 'out',
        portType: firstOut.type,
        portName: firstOut.name,
        portLabel: firstOut.label || firstOut.name,
        portIndex: 1,
        sourceNodeDrawflowId: data.sourceNodeId,
      };
      this._showNodePicker(posX, posY, null, portContext);
    });

    // Reset single node từ hover toolbar / context menu
    window.eventBus?.on('node:reset_single', (data) => {
      if (!data?.nodeId) return;
      this._resetSingleNode(data.nodeId);
    });

    // Force stop từ context menu node (right-click) — dừng thực thi đang chạy (single node hoặc workflow).
    window.eventBus?.on('node:force_stop', () => {
      this._forceStopExecution();
    });

    // Run single node from hover toolbar
    window.eventBus?.on('node:run_single', (data) => {
      if (!data.nodeId) return;
      const drawflowId = data.nodeId;
      const nodeData = this.diagramCanvas?.editor?.getNodeFromId(drawflowId);
      if (!nodeData?.data?.node_id) return;
      // Bug fix: Ưu tiên node.data.node_type (original) over node.class (có thể bị corrupt)
      const nodeType = nodeData?.data?.node_type || nodeData?.class || 'generate';
      if (['generate', 'chatgpt', 'grok'].includes(nodeType)) {
        const promptCheck = this._checkNodeHasPrompt(drawflowId, nodeData);
        if (!promptCheck.ok) {
          window.customDialog?.alert(promptCheck.message, { type: 'warning' });
          return;
        }
      }
      if (this.mode === 'create') {
        window.customDialog?.alert(window.I18n?.t('workflow.saveBeforeRun') || 'Vui lòng lưu workflow trước khi chạy node.', { type: 'warning' });
        return;
      }
      this._runSingleNode(drawflowId);
    });

    // Download node files from hover toolbar.
    // Option A (2026-05-26): gộp về _downloadNodeFiles (đường chuẩn) thay vì handler riêng cũ.
    // Handler cũ chỉ gọi downloadTileMedia(4 args) → bỏ qua download_resolution/videoResolution
    // của node + fail âm thầm với chatgpt/grok (synthetic ID không có tile Flow). _downloadNodeFiles
    // xử lý đúng: resolution theo node config, video res, và tải bản gốc provider cho chatgpt/grok.
    // Auto-pick source: có result_provider_urls (chatgpt/grok) → 'original'; else (Flow gen) → 'flow'.
    window.eventBus?.on('node:download', (data) => {
      if (!data.nodeId) return;
      // source='original' tự fallback sang Flow khi không có URL gốc khả dụng → robust mọi
      // node type: chatgpt/grok ưu tiên bản gốc (hoặc Flow tile bridged nếu URL hết hạn),
      // gen Flow → rơi thẳng xuống Flow modal. Không cần đoán source theo provider URL.
      this._downloadNodeFiles({ source: 'original', nodeId: data.nodeId });
    });

    // Keyboard shortcuts
    this._bindKeyboardShortcuts();

    // v1.1 paste image feature + palette drag/drop. Trước fix: method
    // `setupPaletteDragDrop` declare nhưng không gọi → paste/drop handlers
    // không bound → Cmd+V không hoạt động trong workflow editor.
    this.setupPaletteDragDrop();

    // v1.1 paste image feature: workflow-wide upload listeners để update node
    // diagram preview (spinner / replace tempId / failed indicator) khi paste
    // image upload completes. KHÔNG depend form open — form-specific listeners
    // ở `_attachFormUploadListeners` chỉ trigger khi user mở node form.
    this._bindWorkflowUploadListeners();
  }

  /**
   * v1.1 paste image feature: listen workflow-wide upload events để re-render
   * node diagram preview thumbnails khi upload start/complete/fail.
   */
  _bindWorkflowUploadListeners() {
    if (this._workflowUploadListenersBound) return;
    this._workflowUploadListenersBound = true;
    this._failedPasteUploadKeys = this._failedPasteUploadKeys || new Set();

    this._wfUploadStartedHandler = (data) => {
      if (!data?.key) return;
      // Spinner sẽ apply trong _renderNodePreviewInner → trigger re-render
      this._refreshNodesContainingKey(data.key);
    };
    this._wfUploadCompletedHandler = (data) => {
      if (!data?.key) return;
      this._failedPasteUploadKeys?.delete(data.key);
      try {
        if (data.tile_id) this._syncUploadKeyToAllNodes(data);
      } catch (err) {
        console.warn('[WorkflowEditor] sync upload key failed:', err?.message);
      }
      // Re-render với tile_id mới (key cũ đã được replace bởi _syncUploadKeyToAllNodes)
      this._refreshNodesContainingKey(data.tile_id || data.key);
      // 2026-05-25 Option B auto-save: sau khi tempId → real tile_id sync, persist
      // workflow để diagram state khớp backend (tránh "show in diagram nhưng chưa save" mismatch).
      // _deferredThumbnailSave có debounce 2s + skip nếu workflow running.
      try { this._deferredThumbnailSave?.(); } catch (e) { /* ignore */ }
    };
    this._wfUploadFailedHandler = (data) => {
      if (!data?.key) return;
      this._failedPasteUploadKeys?.add(data.key);
      this._refreshNodesContainingKey(data.key);
    };

    window.eventBus?.on('upload:started', this._wfUploadStartedHandler);
    window.eventBus?.on('upload:completed', this._wfUploadCompletedHandler);
    window.eventBus?.on('upload:failed', this._wfUploadFailedHandler);
  }

  /**
   * 2026-05-25 Option B: Live-sync form upload tempId vào Drawflow node.data.
   * Khi user upload ref image qua form picker → tempId emit `upload:started` →
   * inject tempId vào node.data.ref_file_ids + ref_thumbnails (placeholder) ngay →
   * diagram render với spinner thumbnail (existing _renderNodePreviewInner detect
   * `upload_xxx` prefix). Sau khi upload completed, `_syncUploadKeyToAllNodes`
   * replaces tempId với real tile_id + `_deferredThumbnailSave` persist backend.
   */
  _syncFormUploadToDrawflowNode(uploadKey) {
    if (!uploadKey || !uploadKey.startsWith('upload_')) return;
    // Chỉ sync nếu key thuộc form đang mở (tránh sync upload từ context khác)
    if (!this._formUploadKeys?.has(uploadKey)) return;
    if (!this._formNodeId || !this.diagramCanvas?.editor) return;

    const drawflowId = String(this._formNodeId);
    const node = this.diagramCanvas.editor.getNodeFromId(drawflowId);
    if (!node?.data) return;

    // Skip nếu key đã có trong ref_file_ids (idempotent)
    const currentIds = (node.data.ref_file_ids || '').split(',').map(s => s.trim()).filter(Boolean);
    if (currentIds.includes(uploadKey)) return;

    // Get thumbnail từ _tileCache (caller đã set qua _tileCacheSet) hoặc pendingUploadFiles
    const cached = this._tileCache.get(uploadKey);
    const thumbnail = cached?.thumbnail
      || window.pendingUploadFiles?.get(uploadKey)?.thumbnail
      || '';
    const fileName = cached?.file_name
      || window.pendingUploadFiles?.get(uploadKey)?.name
      || '';

    // Build new data — append tempId
    const newRefIds = [...currentIds, uploadKey].join(', ');
    const newRefThumbs = { ...(node.data.ref_thumbnails || {}), [uploadKey]: thumbnail };
    const newRefNames = fileName
      ? { ...(node.data.ref_file_names || {}), [uploadKey]: fileName }
      : node.data.ref_file_names;
    const newData = {
      ...node.data,
      ref_file_ids: newRefIds,
      ref_thumbnails: newRefThumbs,
      ...(fileName ? { ref_file_names: newRefNames } : {}),
    };

    try {
      this.diagramCanvas.editor.updateNodeDataFromId(drawflowId, newData);
    } catch (err) {
      console.warn('[WorkflowEditor] _syncFormUploadToDrawflowNode updateNodeData failed:', err?.message);
      return;
    }

    // Trigger diagram re-render (spinner thumbnail từ upload_ prefix detection)
    const nodeId = node.data.node_id || drawflowId;
    try {
      this._refreshNodesContainingKey(uploadKey);
    } catch (e) { /* ignore */ }
  }

  _unbindWorkflowUploadListeners() {
    if (!this._workflowUploadListenersBound) return;
    window.eventBus?.off('upload:started', this._wfUploadStartedHandler);
    window.eventBus?.off('upload:completed', this._wfUploadCompletedHandler);
    window.eventBus?.off('upload:failed', this._wfUploadFailedHandler);
    this._workflowUploadListenersBound = false;
  }

  /**
   * Re-render node diagram preview cho mọi node có ref_file_ids chứa key.
   * Dùng sau upload start/complete/fail để update spinner / replace tempId / show error.
   */
  _refreshNodesContainingKey(key) {
    if (!key || !this.diagramCanvas?.editor) return;
    try {
      const editor = this.diagramCanvas.editor;
      // Đọc trực tiếp từ live state — KHÔNG export() (deep clone, có thể stale nếu
      // call site khác đang mutate). Live read: editor.drawflow.drawflow.Home.data
      const homeData = editor.drawflow?.drawflow?.Home?.data || {};
      for (const [drawflowId, nodeInfo] of Object.entries(homeData)) {
        const nodeData = nodeInfo?.data;
        const refRaw = nodeData?.ref_file_ids;
        if (typeof refRaw !== 'string' || !refRaw) continue;
        const ids = refRaw.split(',').map(s => s.trim()).filter(Boolean);
        if (!ids.includes(key)) continue;

        const nodeId = nodeData?.node_id || drawflowId;
        const nodeType = nodeData?.node_type || nodeInfo?.class;

        try {
          if (nodeType === 'image') {
            // Image node: ref_file_ids hiển thị TRONG main preview (.df-node-preview)
            this._directRenderNodePreview(nodeId, ids);
          } else if (['generate', 'chatgpt', 'grok', 'prompt'].includes(nodeType)) {
            // Generate/ChatGPT/Grok/Prompt: ref ở bottom (.df-node-ref-preview)
            this._directRenderNodeRefFromCache(nodeId, ids);
          }
        } catch (innerErr) {
          console.warn('[WorkflowEditor] refresh node preview failed:', innerErr?.message);
        }
      }
    } catch (err) {
      console.warn('[WorkflowEditor] refreshNodesContainingKey failed:', err?.message);
    }
  }

  /**
   * v1.1 Node clipboard: copy selected node data → `_nodeClipboard` slot.
   * Single-node, in-memory only (lost when editor closes). Cross-workflow disabled.
   */
  _copyNodeToClipboard(nodeId) {
    if (!nodeId || !this.diagramCanvas?.editor) return false;
    const node = this.diagramCanvas.editor.getNodeFromId(nodeId);
    const data = node?.data;
    if (!data) return false;
    // Refuse copy cho start node (giống logic context menu)
    if (data.node_type === 'start') return false;

    // Clone data — getNodeFromId trả về deep clone, nhưng explicit clone để an toàn
    // và strip execution state (status/result) — paste node fresh giống duplicate.
    const cloned = JSON.parse(JSON.stringify(data));
    delete cloned.status;
    delete cloned.result_file_ids;
    delete cloned.result_file_names;
    delete cloned.result_thumbnails;
    delete cloned.result_text;
    delete cloned.error_message;
    // 2026-05-25: Normalize required defaults trên clipboard data — tránh propagate
    // empty video_input_type/grok_mode/use_fallback_prefix khi paste sau này.
    try { window.NodeTemplates?.normalizeNodeData?.(cloned); } catch (_) {}

    this._nodeClipboard = { data: cloned, copiedAt: Date.now() };

    const label = data.node_name || data.node_type || 'node';
    const msg = window.I18n?.t?.('workflow.nodeClipboard.copied', { name: label })
      || `Đã copy node "${label}"`;
    window.showNotification?.(msg, 'success', 1500);
    return true;
  }

  /**
   * v1.1 Node clipboard: paste node tại vị trí cursor (hoặc center fallback).
   * Uniquify name + slug để không trùng nodes hiện có.
   */
  _pasteNodeFromClipboard() {
    if (!this._nodeClipboard?.data || !this.diagramCanvas) return false;
    if (this.isReadOnly()) return false;

    const src = this._nodeClipboard.data;
    const nodeType = src.node_type;
    if (!nodeType) return false;

    // Build new data — clone + uniquify name/slug. Generate new node_id (unique).
    const newData = JSON.parse(JSON.stringify(src));
    // 2026-05-25: Normalize defaults defensive (clipboard data có thể đã normalize lúc copy,
    // nhưng cross-session paste hoặc cross-context có thể skip → normalize lại an toàn).
    try { window.NodeTemplates?.normalizeNodeData?.(newData); } catch (_) {}
    newData.node_id = window.IdGenerator
      ? window.IdGenerator.next('node')
      : `node_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;

    // Uniquify node_name dùng cùng pattern với palette drop / paste image
    newData.node_name = this._generateUniqueNodeName(nodeType);

    // Uniquify slug — preserve original semantic meaning (parity với `duplicateNode`).
    // Nếu source có slug user-defined (vd "my_main_prompt") → uniquify suffix → "my_main_prompt_2".
    // Nếu source không có slug → generate từ node_name mới.
    if (this._isMentionableNodeType(nodeType)) {
      if (src.slug) {
        const existingSlugs = this._getExistingSlugs();
        newData.slug = this._ensureUniqueSlug(src.slug, existingSlugs);
      } else {
        newData.slug = this._generateSlug(newData.node_name);
      }
      newData.slug_auto = true; // match `duplicateNode` behavior — force auto flag
    } else {
      delete newData.slug;
      delete newData.slug_auto;
    }

    // Bug fix (catalog 2026-05-20): paste single-node KHÔNG copy edges → new node KHÔNG có
    // upstream Prompt/Text. Nếu source có `prompt_source='upstream_node'` (vì connected upstream),
    // pasted node sẽ orphan: runtime đọc upstream rỗng → submit empty prompt → fail.
    // Fix: reset về 'textbox' (default an toàn) — user có thể connect upstream sau, hoặc edit
    // prompt textbox đã copy. Edge:created handler tự auto-switch lại 'upstream_node' nếu cần.
    if (newData.prompt_source === 'upstream_node') {
      newData.prompt_source = 'textbox';
    }

    // Position: mouse cursor → fallback center (parity với N=add node shortcut)
    const rect = this.overlay?.querySelector('#diagramContainer')?.getBoundingClientRect();
    const fallbackX = rect ? rect.width / 2 : 200;
    const fallbackY = rect ? rect.height / 2 : 200;
    const posX = this._lastMouseCanvasPos?.x ?? fallbackX;
    const posY = this._lastMouseCanvasPos?.y ?? fallbackY;

    const drawflowId = this.diagramCanvas.addNode(nodeType, posX, posY, newData);
    if (!drawflowId) return false; // quota fail / addNode rejected

    this._hasUnsavedChanges = true;
    try { this._scheduleRefreshNodeWarningBadges(); } catch (_) {}
    requestAnimationFrame(() => {
      try { this._updatePortEmptyState(); } catch (_) {}
      try { this._bindInlineSettingPills(); } catch (_) {}
    });

    return true;
  }

  setupPaletteDragDrop() {
    const paletteItems = this.overlay.querySelectorAll('.node-palette-item');
    const diagramContainer = this.overlay.querySelector('#diagramContainer');

    paletteItems.forEach(item => {
      // Phase: block drag cho coming-soon nodes
      item.addEventListener('dragstart', (e) => {
        if (item.dataset.disabled === 'true') {
          e.preventDefault();
          if (typeof window.showNotification === 'function') {
            window.showNotification(
              window.I18n?.t('workflow.comingSoonHint') || 'Node này sắp ra mắt — chưa khả dụng',
              'info'
            );
          }
          return;
        }
        e.dataTransfer.setData('nodeType', item.dataset.nodeType);
      });
      // Click vào disabled cũng show toast
      item.addEventListener('click', (e) => {
        if (item.dataset.disabled === 'true') {
          e.preventDefault();
          if (typeof window.showNotification === 'function') {
            window.showNotification(
              window.I18n?.t('workflow.comingSoonHint') || 'Node này sắp ra mắt — chưa khả dụng',
              'info'
            );
          }
        }
      });
    });

    if (diagramContainer) {
      diagramContainer.addEventListener('dragover', (e) => {
        e.preventDefault();
      });

      diagramContainer.addEventListener('drop', async (e) => {
        e.preventDefault();

        // v1.1 paste image feature: detect image file drop từ desktop TRƯỚC
        // KHÔNG override existing palette drop (image check fail → fall-through nodeType)
        const droppedFiles = Array.from(e.dataTransfer?.files || []);
        const imageFiles = droppedFiles.filter(f => f.type?.startsWith('image/'));
        if (imageFiles.length > 0) {
          const rect = diagramContainer.getBoundingClientRect();
          const dropX = e.clientX - rect.left;
          const dropY = e.clientY - rect.top;
          await this._handlePastedImages(imageFiles, dropX, dropY);
          return;
        }

        // Existing palette nodeType drop (unchanged)
        const nodeType = e.dataTransfer.getData('nodeType');
        if (nodeType && this.diagramCanvas) {
          const rect = diagramContainer.getBoundingClientRect();
          const posX = e.clientX - rect.left;
          const posY = e.clientY - rect.top;

          // Đọc user defaults từ af_settings để áp dụng vào node mới
          const afSettings = await new Promise(resolve => {
            chrome.storage.local.get(['af_settings'], r => resolve(r.af_settings || {}));
          });

          const nodeName = this._generateUniqueNodeName(nodeType);
          // Phase 1 — Node Reference System: Auto-generate slug for mentionable nodes
          const nodeData = {
            ...NodeTemplates.getDefaults(nodeType, afSettings),
            node_name: nodeName,
            node_type: nodeType
          };
          if (this._isMentionableNodeType(nodeType)) {
            nodeData.slug = this._generateSlug(nodeName);
            nodeData.slug_auto = true;
          }
          const nodeId = this.diagramCanvas.addNode(nodeType, posX, posY, nodeData);
          if (nodeId) {
            this._hasUnsavedChanges = true;
            // Phase WK-1.5.3: refresh warning badges sau khi thêm node mới
            try { this._scheduleRefreshNodeWarningBadges(); } catch (err) {}
            // Phase enhancement: update data-port-empty cho empty-click handler
            requestAnimationFrame(() => {
              try { this._updatePortEmptyState(); } catch (err) {}
              try { this._bindInlineSettingPills(); } catch (err) {}
            });
          }

          // Node added to canvas
        }
      });

      // v1.1 paste image feature: Cmd+V trong canvas → auto-add image node
      this._bindCanvasPasteHandler(diagramContainer);
    }
  }

  /**
   * v1.1 paste image feature: listen Cmd+V trong canvas.
   * Skip nếu user đang focus input/textarea (default text paste OK).
   * Image clipboard → _handlePastedImages([files], centerX, centerY).
   */
  _bindCanvasPasteHandler(diagramContainer) {
    if (!diagramContainer || diagramContainer._pasteHandlerBound) return;
    diagramContainer._pasteHandlerBound = true;

    // Bind on document để bắt được paste khi canvas focused (canvas không phải focusable element by default)
    // Filter trong handler để chỉ react khi diagramContainer visible + active
    const handler = async (e) => {
      // Bỏ qua nếu workflow editor đang ẩn/đóng
      if (!this.overlay || this.overlay.style.display === 'none') return;
      // Skip nếu đang focus input/textarea/contenteditable → để default text paste OK
      const tgt = e.target;
      if (tgt?.matches?.('input, textarea, [contenteditable="true"], select')) return;

      // v1.1 Node clipboard ưu tiên hơn paste image. Ctrl+V keydown handler đã
      // preventDefault + paste node — nhưng vẫn check ở đây cho trường hợp
      // browser fires paste event mà không qua keydown (mobile / context menu).
      if (this._nodeClipboard?.data) {
        e.preventDefault();
        this._pasteNodeFromClipboard();
        return;
      }

      const items = Array.from(e.clipboardData?.items || []);
      const imageItems = items.filter(it => it.type?.startsWith('image/') && it.kind === 'file');
      if (imageItems.length === 0) return; // No image → để default paste behavior

      e.preventDefault();
      const files = imageItems.map(it => it.getAsFile()).filter(Boolean);
      if (files.length === 0) return;

      // Position: center of visible canvas viewport
      const rect = diagramContainer.getBoundingClientRect();
      const centerX = rect.width / 2;
      const centerY = rect.height / 2;
      await this._handlePastedImages(files, centerX, centerY);
    };

    document.addEventListener('paste', handler);
    // Track listener cho cleanup khi editor closed (xem destroy/onClose flow)
    this._pasteHandler = handler;
  }

  /**
   * v1.1 paste image feature: orchestrator tạo image nodes từ paste/drop files.
   * - Validate quota (delegated to DiagramCanvas.addNode built-in check)
   * - Persist blob vào IndexedDB workflow_paste_blobs (no TTL)
   * - Generate tempId upload_xxx
   * - Add image node với ref_file_ids = tempId, thumbnail dataURL, fileName
   * - Trigger background upload via ImmediateUploader
   * - Position offset 50px stacked diagonal cho multi-paste
   *
   * @param {File[]} files - Image files from clipboard hoặc dataTransfer
   * @param {number} basePosX - Starting position X (cursor cho drop, center cho paste)
   * @param {number} basePosY - Starting position Y
   */
  async _handlePastedImages(files, basePosX, basePosY) {
    if (!Array.isArray(files) || files.length === 0 || !this.diagramCanvas) return;

    // Template editor: BLOCK paste image — Flow CDN URL signature TTL gây ảnh missing
    // sau vài ngày khi user clone template. Admin nên dùng admin Template Settings
    // (server storage URL permanent) để thêm ref images cho template.
    if (this.isTemplateMode) {
      window.showNotification?.(
        window.I18n?.t?.('workflow.pasteImageBlockedTemplate')
          || 'Template không hỗ trợ paste ảnh trực tiếp. Dùng admin Template Settings → Ref Images URL để thêm ảnh permanent.',
        'warning', 4000
      );
      return;
    }

    // Read user defaults (parity với palette drop pattern)
    const afSettings = await new Promise(resolve => {
      chrome.storage.local.get(['af_settings'], r => resolve(r.af_settings || {}));
    });

    const workflowId = this.workflow?.wf_id || null;
    const MAX_SIZE_BYTES = 20 * 1024 * 1024; // 20MB warn threshold
    const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp'];
    const SUPPORTED_HINT = 'PNG, JPG, WEBP, GIF, BMP';

    let added = 0;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (!file) continue;

      // Format check — HEIC/AVIF/etc not supported by canvas/Flow
      const mimeType = file.type || '';
      if (!ALLOWED_TYPES.includes(mimeType)) {
        const fileLabel = file.name || `image #${i + 1}`;
        const msg = (window.I18n?.t?.('workflow.pasteImage.formatUnsupported', { name: fileLabel, formats: SUPPORTED_HINT }))
          || `Định dạng "${fileLabel}" không hỗ trợ. Dùng ${SUPPORTED_HINT}.`;
        window.showNotification?.(msg, 'warning');
        continue;
      }

      // Size warn (nhưng vẫn cho phép upload)
      if (file.size > MAX_SIZE_BYTES) {
        const sizeMB = (file.size / 1024 / 1024).toFixed(1);
        const msg = (window.I18n?.t?.('workflow.pasteImage.fileLarge', { name: file.name, size: sizeMB }))
          || `Ảnh "${file.name}" lớn (${sizeMB}MB) — có thể upload chậm.`;
        window.showNotification?.(msg, 'info');
      }

      // Read file as data URL for thumbnail preview
      let dataUrl;
      try {
        dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(reader.error || new Error('FileReader failed'));
          reader.readAsDataURL(file);
        });
      } catch (err) {
        console.warn('[Paste] FileReader failed for', file.name, err?.message);
        window.showNotification?.(
          (window.I18n?.t?.('workflow.pasteImage.readFailed', { name: file.name }))
            || `Không đọc được ảnh "${file.name}".`,
          'error'
        );
        continue;
      }

      // Generate tempId (existing pattern in extension)
      const tempId = 'upload_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      const fileName = file.name || `pasted-${Date.now()}.png`;

      // Persist blob vào IndexedDB (NO TTL) — bulletproof vs 2h pending_uploads TTL
      try {
        await window.PendingUploadStore?.savePasteBlob?.({
          id: tempId,
          blob: file,
          fileName,
          mimeType,
          size_bytes: file.size,
          workflow_id: workflowId,
        });
      } catch (err) {
        console.warn('[Paste] savePasteBlob failed (continuing with memory-only):', err?.message);
      }

      // Register vào MediaRegistry (thumbnail + fileName cache)
      try {
        window.MediaRegistry?.set?.(tempId, dataUrl, fileName);
      } catch (err) {
        console.warn('[Paste] MediaRegistry.set failed:', err?.message);
      }

      // Populate window.pendingUploadFiles để `_renderNodePreviewInner` fallback
      // (line ~11890) tìm được thumbnail khi render node diagram preview.
      try {
        if (!window.pendingUploadFiles) window.pendingUploadFiles = new Map();
        window.pendingUploadFiles.set(tempId, {
          file,
          thumbnail: dataUrl,
          name: fileName,
          timestamp: Date.now(),
        });
      } catch (err) {
        console.warn('[Paste] pendingUploadFiles.set failed:', err?.message);
      }

      // Populate _tileCache để _renderNodePreviewInner tìm thấy ngay khi node render.
      try {
        this._tileCacheSet?.(tempId, {
          thumbnail: dataUrl,
          file_name: fileName,
          type: 'image',
        });
      } catch (err) {
        console.warn('[Paste] _tileCacheSet failed:', err?.message);
      }

      // Position offset 50px stacked diagonal cho multi-paste (added counter để skip failed entries)
      const posX = basePosX + (added * 50);
      const posY = basePosY + (added * 50);

      // Build node data — image node với ref_file_ids = tempId
      const nodeName = this._generateUniqueNodeName('image');
      const nodeData = {
        ...NodeTemplates.getDefaults('image', afSettings),
        node_name: nodeName,
        node_type: 'image',
        ref_file_ids: tempId,
        ref_thumbnails: { [tempId]: dataUrl },
        ref_file_names: { [tempId]: fileName },
      };
      if (this._isMentionableNodeType('image')) {
        nodeData.slug = this._generateSlug(nodeName);
        nodeData.slug_auto = true;
      }

      // addNode tự check quota (built-in). null trả về nếu quota fail → show upgrade modal automatically
      const nodeId = this.diagramCanvas.addNode('image', posX, posY, nodeData);
      if (!nodeId) {
        // Quota fail → addNode đã show upgrade dialog. Abort remaining.
        // Cleanup tempId đã lưu (avoid orphan blob trong IndexedDB)
        try { await window.PendingUploadStore?.deletePasteBlob?.(tempId); } catch (_) {}
        try { window.MediaRegistry?.delete?.(tempId); } catch (_) {}
        break;
      }

      this._hasUnsavedChanges = true;
      added++;

      // Trigger background upload TRƯỚC khi render preview để spinner detect được
      // `ImmediateUploader.isUploading(tempId) === true`. upload() set marker sync
      // (line 102 ImmediateUploader) ngay khi gọi, dù await ensureFlowTabReady async.
      try {
        window.ImmediateUploader?.upload?.(file, null, { key: tempId, name: fileName })
          .then(async (result) => {
            if (result?.success && result?.file_name) {
              // Mark uploaded trong persistent store (schedule cleanup 3 ngày)
              await window.PendingUploadStore?.markPasteBlobUploaded?.(tempId, result.file_name);
            } else if (result && !result.pending) {
              await window.PendingUploadStore?.markPasteBlobFailed?.(tempId, result.error || 'unknown');
            }
          })
          .catch(async (err) => {
            await window.PendingUploadStore?.markPasteBlobFailed?.(tempId, err?.message);
          });
      } catch (err) {
        console.warn('[Paste] ImmediateUploader.upload threw:', err?.message);
      }

      // Render preview NGAY sau upload start (placeholder SVG → dataURL thumb với
      // spinner overlay). Drawflow `addNode` chỉ render placeholder; thumb thực tế
      // render qua `_directRenderNodePreview`. Phải gọi SAU `upload()` để
      // `isUploading(tempId)` đã `true` → spinner class apply.
      try {
        this._directRenderNodePreview(nodeData.node_id || nodeId, [tempId]);
      } catch (err) {
        console.warn('[Paste] initial preview render failed:', err?.message);
      }
    }

    if (added > 0) {
      // Refresh UI sau khi thêm nodes (parity với palette drop)
      try { this._scheduleRefreshNodeWarningBadges(); } catch (err) {}
      requestAnimationFrame(() => {
        try { this._updatePortEmptyState(); } catch (err) {}
        try { this._bindInlineSettingPills(); } catch (err) {}
      });

      // Toast summary nếu multi-paste
      if (files.length > 1) {
        const msg = (window.I18n?.t?.('workflow.pasteImage.addedMulti', { count: added, total: files.length }))
          || `Đã thêm ${added}/${files.length} ảnh vào workflow.`;
        window.showNotification?.(msg, 'success');
      }
    }
  }

  /**
   * v1.1 paste image feature: retry uploads cho paste blobs còn pending/failed.
   * Gọi khi workflow editor open — handle case browser restart hoặc upload fail trước đó.
   * Chỉ retry blobs có tempId còn xuất hiện trong workflow nodes (avoid orphan retries).
   */
  async _retryPendingPasteUploads() {
    const workflowId = this.workflow?.wf_id;
    if (!workflowId || !window.PendingUploadStore?.getPendingPasteBlobs) return;

    const pending = await window.PendingUploadStore.getPendingPasteBlobs(workflowId);
    if (!pending || pending.length === 0) return;

    // Build set tempId đang dùng trong workflow (qua ref_file_ids của các nodes)
    const usedTempIds = new Set();
    const nodes = this.workflow?.nodes || [];
    for (const node of nodes) {
      const refIds = node?.data?.ref_file_ids;
      if (typeof refIds === 'string' && refIds.includes('upload_')) {
        refIds.split(',').map(s => s.trim()).filter(s => s.startsWith('upload_')).forEach(id => usedTempIds.add(id));
      }
    }

    let retried = 0;
    for (const entry of pending) {
      if (!usedTempIds.has(entry.id)) {
        // Orphan blob — node đã bị xóa nhưng blob còn → cleanup
        try { await window.PendingUploadStore.deletePasteBlob(entry.id); } catch (_) {}
        continue;
      }

      // Skip nếu retry quá nhiều lần (>5 attempts) → user phải manual remove/re-add
      if ((entry.upload_attempts || 0) >= 5) continue;

      // Re-register MediaRegistry (RAM cache có thể đã evict sau browser restart)
      if (entry.blob) {
        try {
          const dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(entry.blob);
          });
          window.MediaRegistry?.set?.(entry.id, dataUrl, entry.fileName);
        } catch (_) { /* thumbnail re-gen fail không block retry upload */ }

        // Retry upload (background)
        window.ImmediateUploader?.upload?.(entry.blob, null, { key: entry.id, name: entry.fileName })
          .then(async (result) => {
            if (result?.success && result?.file_name) {
              await window.PendingUploadStore?.markPasteBlobUploaded?.(entry.id, result.file_name);
            } else if (result && !result.pending) {
              await window.PendingUploadStore?.markPasteBlobFailed?.(entry.id, result.error || 'unknown');
            }
          })
          .catch(async (err) => {
            await window.PendingUploadStore?.markPasteBlobFailed?.(entry.id, err?.message);
          });
        retried++;
      }
    }

    if (retried > 0) {
      console.log(`[WorkflowEditor] Retried ${retried} pending paste uploads for workflow ${workflowId}`);
    }
  }

  /**
   * Lấy danh sách nodes đang kết nối input vào node hiện tại
   */
  _getConnectedSourceNodes(nodeId) {
    if (!this.diagramCanvas?.editor) return [];

    const exportData = this.diagramCanvas.editor.export();
    const homeData = exportData.drawflow?.Home?.data || {};
    const sources = [];

    Object.entries(homeData).forEach(([id, nodeData]) => {
      Object.values(nodeData.outputs || {}).forEach(output => {
        (output.connections || []).forEach(conn => {
          if (String(conn.node) === String(nodeId)) {
            sources.push({
              drawflowId: id,
              node_id: nodeData.data?.node_id || `node_${id}`,
              node_name: nodeData.data?.node_name || nodeData.class || `Node ${id}`,
              input_handle: conn.output // input_1, input_2...
            });
          }
        });
      });
    });

    return sources;
  }

  /**
   * Phase CG-8: Render radio "Prompt source" cho generate/chatgpt/grok.
   * Cho phép user chọn dùng prompt từ textbox (default) hay từ upstream Prompt node.
   * @param {Object} data - Node data
   * @param {string} nodeId - Drawflow node ID
   * @returns {string} HTML
   */
  _renderPromptSourceRadio(data, nodeId) {
    // Tìm upstream Prompt node từ tất cả input connections
    let upstreamPromptNode = null;
    let hasUpstreamConnection = false;
    if (this.diagramCanvas?.editor && nodeId) {
      try {
        // nodeId có thể là drawflow ID (số) hoặc custom node_id (string).
        // Thử getNodeFromId trước, nếu không có thì dùng _findDrawflowId.
        let node = this.diagramCanvas.editor.getNodeFromId(nodeId);
        if (!node && this._findDrawflowId) {
          const dfId = this._findDrawflowId(nodeId);
          if (dfId) node = this.diagramCanvas.editor.getNodeFromId(dfId);
        }
        if (node) {
          // Check tất cả inputs để tìm upstream text-source node (prompt/text/text_extract)
          const allInputKeys = Object.keys(node.inputs || {});
          for (const inputKey of allInputKeys) {
            const conns = node.inputs?.[inputKey]?.connections || [];
            for (const conn of conns) {
              const srcNode = this.diagramCanvas.editor.getNodeFromId(conn.node);
              const srcType = srcNode?.data?.node_type || srcNode?.class;
              // 2026-05-31: thêm text_extract — node output text feed downstream prompt.
              if (['prompt', 'text', 'text_extract'].includes(srcType)) {
                upstreamPromptNode = srcNode;
                hasUpstreamConnection = true;
                break;
              }
            }
            if (upstreamPromptNode) break;
          }
        }
      } catch (e) { /* ignore */ }
    }
    // Auto-detect prompt_source từ connections nếu chưa được set
    let promptSource = data.prompt_source;
    if (promptSource === undefined || promptSource === null) {
      promptSource = hasUpstreamConnection ? 'upstream_node' : 'textbox';
    }
    const useOwnPrompt = promptSource === 'textbox';
    const upstreamName = upstreamPromptNode?.data?.node_name || upstreamPromptNode?.data?.prompt?.substring(0, 30) || '';
    const promptSourceIcon = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M6.17 3.646a.5.5 0 0 1 .707 0l5.477 5.477a.5.5 0 0 1 0 .707l-1.366 1.366a4.373 4.373 0 1 1-6.184-6.184L6.17 3.646Zm.353 1.061L5.508 5.723 5.5 5.73a3.373 3.373 0 1 0 4.77 4.77l.006-.008 1.016-1.015-4.77-4.77Z" fill="currentColor"></path><path fill-rule="evenodd" clip-rule="evenodd" d="M5.354 10.646a.5.5 0 0 1 0 .707L3.02 13.688a.5.5 0 1 1-.707-.707l2.334-2.334a.5.5 0 0 1 .707 0ZM10.354 2.313a.5.5 0 0 1 0 .707L8.02 5.354a.5.5 0 0 1-.707-.708l2.334-2.333a.5.5 0 0 1 .707 0ZM13.687 5.646a.5.5 0 0 1 0 .708l-2.333 2.333a.5.5 0 1 1-.707-.707l2.333-2.334a.5.5 0 0 1 .707 0Z" fill="currentColor"></path></svg>';

    // Inline indicator hiển thị bên phải toggle khi đang dùng upstream Prompt
    const inlineIndicator = !useOwnPrompt && upstreamPromptNode
      ? `<span class="prompt-source-inline-indicator" title="${this.escapeAttr(upstreamName)}">
          ${promptSourceIcon}
          <span>${this.escapeHtml(upstreamName.length > 15 ? upstreamName.substring(0, 15) + '…' : upstreamName)}</span>
        </span>`
      : (!useOwnPrompt
        ? `<span class="prompt-source-inline-warning" title="${window.I18n?.t('workflow.noUpstreamPrompt') || 'Chưa connect upstream Prompt node'}">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
          </span>`
        : '');

    return `
      <div class="form-group prompt-source-group">
        <div class="prompt-source-row">
          <label class="toolbar-toggle" for="promptSourceToggle">
            <input type="checkbox" id="promptSourceToggle" ${useOwnPrompt ? 'checked' : ''} class="prompt-source-toggle" />
            <span class="toggle-track"><span class="toggle-thumb"></span></span>
            <span class="toggle-label">${window.I18n?.t('workflow.promptSourceOwn') || 'Sử dụng Prompt riêng'}</span>
          </label>
          ${inlineIndicator}
        </div>
      </div>`;
  }

  /**
   * AI Agent rename + i18n (2026-05-30) — Help tab content cho prompt node, localized.
   * Render đúng locale user qua I18n.t key. Fallback VI (default tổ chức).
   * @param {Object} icons - { icoPencil, icoSpark, icoWarn, icoFilm, mentionGuide }
   * @returns {string} HTML
   */
  _getPromptHelpHtml(icons) {
    const { icoPencil, icoSpark, icoWarn, icoFilm, mentionGuide } = icons;
    const t = (key, fallback) => window.I18n?.t?.(key) || fallback;

    // Section 1: Overview + features list
    const title = t('node.promptHelp.title', 'AI Agent Node');
    const overview = t('node.promptHelp.overview',
      'Node trung gian text — viết prompt + tùy chọn <strong>Use AI</strong> qua ChatGPT/Gemini để xử lý multi-purpose (enhance prompt, analyze ảnh, compose, summarize, translate, brainstorm).');
    const featPrompt = t('node.promptHelp.featPrompt',
      '<strong>Prompt text</strong>: prompt gốc. Có thể dùng <code>@mention</code> tham chiếu node khác (xem Mention section).');
    const featToggle = t('node.promptHelp.featToggle', '<strong>Use AI toggle</strong>:');
    const featOff = t('node.promptHelp.featOff',
      '<strong>OFF (Plain mode)</strong>: pass-through text giống Text node → downstream nhận text gốc (đã resolve @mention nếu prompt_mode=\'mention\').');
    const featOn = t('node.promptHelp.featOn',
      '<strong>ON (AI mode)</strong>: submit lên ChatGPT/Gemini → AI process → downstream nhận result.');
    const featProvider = t('node.promptHelp.featProvider',
      '<strong>Provider</strong> (khi Use AI ON): <code>ChatGPT</code> (default) hoặc <code>Gemini</code> (Google — phân tích image refs tốt + multimodal).');
    const featTimeout = t('node.promptHelp.featTimeout',
      '<strong>Timeout</strong>: 30-180s, mặc định 60s. Timeout → fallback plain text (auto) hoặc fail workflow (tùy <code>ai_fallback</code>).');
    const featRef = t('node.promptHelp.featRef',
      '<strong>Ref images</strong> (khi Use AI ON): upload ảnh để AI analyze + tạo prompt từ visual (vd "Mô tả ảnh này thành prompt sản phẩm").');
    const featDelete = t('node.promptHelp.featDelete',
      '<strong>Delete after AI run</strong>: tự xoá conversation trên ChatGPT/Gemini sau khi run — tránh history rác.');
    const noteMention = t('node.promptHelp.noteMention',
      '<strong>Mention resolve cho AI Agent</strong>: <code>@chu_de</code> sẽ được resolve thành nội dung node tương ứng trước khi submit lên LLM — đồng bộ với Generate/ChatGPT/Grok nodes.');
    const noteRequire = t('node.promptHelp.noteRequire',
      '<em>Yêu cầu Use AI</em>: feature gate <code>ai_agent_enabled</code> ON (gói trả phí). Free plan tự fallback plain + notification.');

    // Section 2: Common workflow pattern with Text Extract
    const section2Title = t('node.promptHelp.section2Title', 'Workflow phổ biến với AI Agent + Text Extract');
    const section2Intro = t('node.promptHelp.section2Intro', 'Tạo nhiều prompts cùng lúc từ 1 chủ đề:');
    const section2Code = t('node.promptHelp.section2Code', `[Text: chủ đề]
  ↓
[AI Agent — Use AI ON]
"Tạo 5 prompt tạo ảnh storyboard cho chủ đề @text.
Format CHÍNH XÁC:
[image_prompt_1]: &lt;nội dung 1&gt;
[image_prompt_2]: &lt;nội dung 2&gt;
...
[image_prompt_5]: &lt;nội dung 5&gt;"
  ↓
[Text Extract] x 5 (mỗi cái marker=image_prompt_N)
  ↓
[Flow Generate] x 5 (mỗi node nhận 1 prompt)`);
    const section2Why = t('node.promptHelp.section2Why',
      '<strong>Lý do dùng Text Extract</strong>: 1 AI call thay vì 5-6 (tiết kiệm token + thời gian).');

    return `
      <div class="help-section">
        <h4>${icoPencil}<span>${title}</span></h4>
        <p>${overview}</p>
        <ol>
          <li>${featPrompt}</li>
          <li>${featToggle}
            <ul>
              <li>${featOff}</li>
              <li>${featOn}</li>
            </ul>
          </li>
          <li>${featProvider}</li>
          <li>${featTimeout}</li>
          <li>${featRef}</li>
          <li>${featDelete}</li>
        </ol>
        <p>${icoSpark}${noteMention}</p>
        <p>${icoWarn}${noteRequire}</p>
      </div>
      ${mentionGuide}
      <div class="help-section">
        <h4>${icoFilm}<span>${section2Title}</span></h4>
        <p>${section2Intro}</p>
        <pre>${section2Code}</pre>
        <p>${section2Why}</p>
      </div>
    `;
  }

  /**
   * Phase WK-1.5.1: Hint nhỏ thay UI radio prompt_source — explain typed port "text".
   * Chỉ áp dụng cho generate/chatgpt/grok.
   * @returns {string} HTML
   */
  _renderUpstreamPromptHint() {
    const hintText = window.I18n?.t('workflow.upstreamPromptHint') ||
      'Prompt từ upstream Prompt node (kéo edge vào port "text" để dùng).';
    return `
      <div class="form-group" style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--muted-foreground);padding:6px 0;">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink:0;">
          <circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line>
        </svg>
        <span>${hintText}</span>
      </div>`;
  }

  /**
   * Render provider status indicator + open button cho ChatGPT/Grok nodes
   * @param {string} provider - 'chatgpt' | 'grok'
   * @returns {string} HTML
   */
  _renderProviderLoginReminder(provider) {
    const providerLabel = window.ProviderMeta?.getName?.(provider) || provider;
    const openText = window.I18n?.t('workflow.openProvider') || 'Open';
    const notReadyText = `${openText} ${providerLabel}`;
    const readyText = window.I18n?.t('workflow.providerReady') || 'Ready';
    const tooltipNotReady = window.I18n?.t('workflow.providerNotReady', { provider: providerLabel }) || `${providerLabel} chưa sẵn sàng`;
    const tooltipReady = window.I18n?.t('workflow.providerReadyTooltip', { provider: providerLabel }) || `${providerLabel} đã sẵn sàng`;
    return `
      <button type="button" class="provider-reminder-btn" data-action="openProvider" data-provider="${provider}"
        data-tooltip-ready="${tooltipReady}"
        data-tooltip-not-ready="${tooltipNotReady}">
        <span class="provider-status-dot"></span>
        <span class="provider-btn-text" data-ready-text="${readyText}" data-not-ready-text="${notReadyText}">${notReadyText}</span>
        <span class="provider-status-tooltip"></span>
      </button>`;
  }

  /**
   * Check and update provider status indicator in brand header or prompt node
   * @param {string} provider - 'chatgpt' | 'grok' | 'gemini'
   */
  async _updateProviderStatusIndicator(provider) {
    // For ChatGPT/Grok brand header: target the button directly
    const buttons = this.overlay?.querySelectorAll(`.provider-reminder-btn[data-provider="${provider}"]`);
    // For Prompt node: target the span indicators
    const indicators = this.overlay?.querySelectorAll(`.provider-status-indicator[data-provider="${provider}"]`);

    if (!buttons?.length && !indicators?.length) return;

    try {
      let isReady = false;
      if (provider === 'chatgpt') {
        if (window.ChatGPTSession?.ensureReady) {
          // [Bug 62 fix 2026-05-24] silent: true cho tooltip status check
          const result = await window.ChatGPTSession.ensureReady({ createIfMissing: false, activate: false, silent: true }).catch(() => ({ ready: false }));
          isReady = result?.ready === true;
        }
      } else if (provider === 'grok') {
        if (window.GrokSession?.ensureReady) {
          // [Bug 62 fix 2026-05-24] silent: true cho tooltip status check
          const result = await window.GrokSession.ensureReady({ createIfMissing: false, activate: false, silent: true }).catch(() => ({ ready: false }));
          isReady = result?.ready === true;
        }
      } else if (provider === 'gemini') {
        if (window.GeminiSession?.ensureReady) {
          const result = await window.GeminiSession.ensureReady({ createIfMissing: false, activate: false }).catch(() => ({ ready: false }));
          isReady = result?.ready === true;
        }
      }

      const providerLabel = window.ProviderMeta?.getName?.(provider) || provider;
      const title = isReady
        ? (window.I18n?.t('workflow.providerReady') || 'Ready')
        : (window.I18n?.t('workflow.providerNotReady', { provider: providerLabel }) || `${providerLabel} not ready`);

      // Update brand header buttons (ChatGPT/Grok nodes)
      buttons?.forEach(btn => {
        btn.classList.toggle('ready', isReady);
        btn.classList.toggle('not-ready', !isReady);
        btn.title = title;
        const textEl = btn.querySelector('.provider-btn-text');
        if (textEl) {
          textEl.textContent = isReady ? textEl.dataset.readyText : textEl.dataset.notReadyText;
        }
        const tooltipEl = btn.querySelector('.provider-status-tooltip');
        if (tooltipEl) {
          tooltipEl.textContent = isReady ? btn.dataset.tooltipReady : btn.dataset.tooltipNotReady;
        }
      });

      // Update Prompt node indicators
      indicators?.forEach(indicator => {
        indicator.classList.toggle('ready', isReady);
        indicator.classList.toggle('not-ready', !isReady);
        indicator.title = title;
      });
    } catch (e) {
      buttons?.forEach(btn => {
        btn.classList.remove('ready');
        btn.classList.add('not-ready');
      });
      indicators?.forEach(indicator => {
        indicator.classList.remove('ready');
        indicator.classList.add('not-ready');
      });
    }
  }

  /**
   * Poll provider status until ready or max attempts reached
   * @param {string} provider - 'chatgpt' | 'grok' | 'gemini'
   * @param {number} maxAttempts - Maximum number of polling attempts
   * @param {number} interval - Interval between polls in ms
   */
  async _pollProviderStatus(provider, maxAttempts = 15, interval = 2000) {
    // Clear any existing poll for this provider
    if (this._providerPollTimers?.[provider]) {
      clearTimeout(this._providerPollTimers[provider]);
    }
    if (!this._providerPollTimers) this._providerPollTimers = {};

    let attempts = 0;
    const poll = async () => {
      // Guard: stop polling if form panel is hidden or overlay is gone
      const formPanel = this.overlay?.querySelector('#nodeFormPanel');
      if (!formPanel || formPanel.classList.contains('hidden')) {
        console.log(`[WorkflowEditor] ${provider} polling stopped - form closed`);
        delete this._providerPollTimers[provider];
        return;
      }

      attempts++;
      await this._updateProviderStatusIndicator(provider);

      // Check if now ready
      const btn = this.overlay?.querySelector(`.provider-reminder-btn[data-provider="${provider}"]`);
      const isReady = btn?.classList.contains('ready');

      if (isReady) {
        console.log(`[WorkflowEditor] ${provider} is now ready after ${attempts} attempts`);
        delete this._providerPollTimers[provider];
        return;
      }

      if (attempts < maxAttempts) {
        this._providerPollTimers[provider] = setTimeout(poll, interval);
      } else {
        console.log(`[WorkflowEditor] ${provider} polling stopped after ${maxAttempts} attempts`);
        delete this._providerPollTimers[provider];
      }
    };

    // Start polling
    poll();
  }

  /**
   * Count incoming connections for a node
   * @param {string|number} drawflowId - Drawflow internal ID
   * @returns {number} Number of incoming connections
   */
  _getIncomingConnectionCount(drawflowId) {
    if (!this.diagramCanvas?.editor || !drawflowId) return 0;
    try {
      const node = this.diagramCanvas.editor.getNodeFromId(drawflowId);
      if (!node?.inputs) return 0;
      let count = 0;
      for (const inputKey of Object.keys(node.inputs)) {
        count += node.inputs[inputKey]?.connections?.length || 0;
      }
      return count;
    } catch (e) {
      return 0;
    }
  }

  /**
   * DEPRECATED: UI dropdowns đã bỏ, mode auto-detect từ prompt.
   * Giữ function để không break existing callers.
   */
  _updateRefModeVisibility() {
    // No-op: prompt_mode/ref_mode auto-detect từ prompt content khi save
  }

  /**
   * EWT-9.2: Render ref images field cho template mode
   * Khi isTemplateMode = true, hiển thị UI upload ảnh lên server thay vì chọn từ Flow
   * @param {Object} data - Node data
   * @param {string} previewId - ID của container preview (VD: 'imageNodeRefPreview')
   * @param {string} inputId - ID của hidden input (VD: 'nodeRefFileIds')
   * @param {string} btnId - ID của nút thêm ảnh (VD: 'imageNodePickBtn')
   * @param {number} maxImages - Số lượng ảnh tối đa (mặc định 10)
   * @returns {string} HTML string
   */
  _renderRefImagesFieldForTemplate(data, previewId, inputId, btnId, maxImages = 10) {
    const refImgUrls = data.ref_img_urls || [];
    console.log('[WorkflowEditor] _renderRefImagesFieldForTemplate - data.ref_img_urls:', refImgUrls);
    const refImgUrlsJson = JSON.stringify(refImgUrls);
    const maxLabel = maxImages < 10 ? ` (${window.I18n?.t('workflow.maxImages', { max: maxImages }) || `tối đa ${maxImages}`})` : '';

    return `
      <div class="form-group template-ref-images-group" id="${previewId}Group">
        <label>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align: -1px; margin-right: 4px;">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
            <circle cx="8.5" cy="8.5" r="1.5"></circle>
            <polyline points="21 15 16 10 5 21"></polyline>
          </svg>
          ${window.I18n?.t('workflow.refImages') || 'Reference images'}${maxLabel}
          <span class="template-mode-badge" title="${window.I18n?.t('workflow.templateModeHint') || 'Editing template - images will be uploaded to server'}">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="17 8 12 3 7 8"/>
              <line x1="12" y1="3" x2="12" y2="15"/>
            </svg>
            Server
          </span>
        </label>
        <div class="template-ref-images-grid" id="${previewId}">
          <!-- Preview images được render bởi JS -->
        </div>
        <button class="node-ref-btn template-ref-add-btn" id="${btnId}" type="button">
          <svg class="node-ref-btn__icon ref-btn-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15 8h.01"></path><path d="M12.5 21h-6.5a3 3 0 0 1 -3 -3v-12a3 3 0 0 1 3 -3h12a3 3 0 0 1 3 3v6.5"></path><path d="M3 16l5 -5c.928 -.893 2.072 -.893 3 0l3.5 3.5"></path><path d="M14 14l1 -1c.679 -.653 1.473 -.829 2.214 -.526"></path><path d="M19 22v-6"></path><path d="M22 19l-3 -3l-3 3"></path></svg>
          <span class="node-ref-btn__text">${window.I18n?.t('workflow.addRefImage') || 'Thêm ảnh'}</span>
        </button>
        <!-- Hidden input lưu ref_img_urls (array JSON) cho template mode -->
        <input type="hidden" id="${inputId}" value="${this.escapeAttr(refImgUrlsJson)}" data-template-mode="true" />
      </div>`;
  }

  /**
   * EWT-9.5: Render preview ảnh tham chiếu cho template mode (từ URLs)
   * @param {string[]} urls - Mảng URLs ảnh
   * @param {string} containerSelector - Selector của container preview
   */
  _renderTemplateRefImagesPreview(urls, containerSelector) {
    const container = this.overlay?.querySelector(containerSelector);
    if (!container) return;

    if (!urls || urls.length === 0) {
      container.innerHTML = `
        <div class="template-ref-empty">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
            <circle cx="8.5" cy="8.5" r="1.5"></circle>
            <polyline points="21 15 16 10 5 21"></polyline>
          </svg>
          <span>${window.I18n?.t('workflow.noRefImages') || 'Chưa có ảnh tham chiếu'}</span>
        </div>`;
      return;
    }

    container.innerHTML = urls.map((url, index) => `
      <div class="template-ref-thumb" data-ref-url="${this.escapeAttr(url)}" data-index="${index}">
        <img src="${this.escapeAttr(url)}" alt="Ảnh tham chiếu ${index + 1}" loading="lazy" />
        <button class="template-ref-thumb-remove" type="button" title="${window.I18n?.t('workflow.removeThisImage') || 'Xóa ảnh này'}">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      </div>
    `).join('');
  }

  /**
   * EWT-9.3 & EWT-9.4: Bind events cho ref images trong template mode
   * @param {string} btnId - ID của nút thêm ảnh
   * @param {string} inputId - ID của hidden input chứa URLs
   * @param {string} previewId - ID của container preview
   * @param {number} maxImages - Số lượng ảnh tối đa
   */
  _bindTemplateRefImagesEvents(btnId, inputId, previewId, maxImages = 10) {
    const addBtn = this.overlay?.querySelector(`#${btnId}`);
    const hiddenInput = this.overlay?.querySelector(`#${inputId}`);
    const previewContainer = this.overlay?.querySelector(`#${previewId}`);

    if (!addBtn || !hiddenInput) return;

    // Parse URLs từ hidden input
    const getUrls = () => {
      try {
        return JSON.parse(hiddenInput.value || '[]');
      } catch (e) {
        return [];
      }
    };

    // Save URLs vào hidden input
    const saveUrls = (urls) => {
      hiddenInput.value = JSON.stringify(urls);
      // Đánh dấu nếu user đã xóa hết ảnh (để _applyNodeFormData biết)
      if (urls.length === 0) {
        hiddenInput.dataset.cleared = 'true';
      } else {
        delete hiddenInput.dataset.cleared;
      }
      this._renderTemplateRefImagesPreview(urls, `#${previewId}`);
    };

    // Click thêm ảnh → mở WorkflowMediaModal
    addBtn.addEventListener('click', () => {
      const currentUrls = getUrls();
      const remaining = maxImages - currentUrls.length;

      if (remaining <= 0) {
        window.customDialog?.alert(
          window.I18n?.t('workflow.maxRefImagesReached', { max: maxImages }) || `Reached limit of ${maxImages} reference images.`,
          { title: window.I18n?.t('workflow.limitReached') || 'Limit reached', type: 'warning' }
        );
        return;
      }

      // EWT-9.3: Mở WorkflowMediaModal
      if (typeof WorkflowMediaModal !== 'undefined') {
        const currentUrls = getUrls();
        WorkflowMediaModal.show({
          type: 'ref_image',
          multiple: true,
          preselected: currentUrls,
          onSelect: (urls) => {
            // urls đã bao gồm preselected, không cần merge với currentUrls
            const selectedUrls = Array.isArray(urls) ? urls : [urls];
            // Giới hạn số lượng
            saveUrls(selectedUrls.slice(0, maxImages));
            this._hasUnsavedChanges = true;
          }
        });
      } else {
        console.error('[WorkflowEditor] WorkflowMediaModal không tồn tại');
      }
    });

    // EWT-9.6: Click xóa ảnh (event delegation)
    if (previewContainer && !previewContainer._templateRefDelegated) {
      previewContainer._templateRefDelegated = true;
      previewContainer.addEventListener('click', (e) => {
        const removeBtn = e.target.closest('.template-ref-thumb-remove');
        if (!removeBtn) return;

        e.stopPropagation();
        e.preventDefault();

        const thumb = removeBtn.closest('.template-ref-thumb');
        const urlToRemove = thumb?.dataset.refUrl;

        if (urlToRemove) {
          const currentUrls = getUrls();
          const filteredUrls = currentUrls.filter(u => u !== urlToRemove);
          saveUrls(filteredUrls);
          this._hasUnsavedChanges = true;
        }
      });
    }

    // Render preview ban đầu
    const initialUrls = getUrls();
    console.log('[WorkflowEditor] _bindTemplateRefImagesEvents - initialUrls:', initialUrls, 'previewId:', previewId);
    this._renderTemplateRefImagesPreview(initialUrls, `#${previewId}`);
  }

  /**
   * EWT-12.1: Render field result image cho template mode
   * Cho phép admin upload ảnh kết quả mẫu cho node
   * @param {Object} data - Node data
   * @param {string} previewId - ID của container preview
   * @param {string} inputId - ID của hidden input chứa URL
   * @param {string} btnId - ID của nút chọn ảnh
   */
  _renderResultImageFieldForTemplate(data, previewId, inputId, btnId) {
    const resultImgUrl = data.result_img_url || '';

    return `
      <div class="form-group template-result-image-group" id="${previewId}Group">
        <label>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align: -1px; margin-right: 4px;">
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
            <polyline points="22 4 12 14.01 9 11.01"/>
          </svg>
          ${window.I18n?.t('workflow.resultPreviewImage') || 'Sample result image'}
          <span class="template-mode-badge optional-badge" title="${window.I18n?.t('workflow.resultPreviewHint') || 'Sample result image for user preview'}">
            ${window.I18n?.t('common.optional') || 'Tùy chọn'}
          </span>
        </label>
        <div class="template-result-image-preview" id="${previewId}">
          <!-- Preview image được render bởi JS -->
        </div>
        <button class="node-ref-btn template-result-select-btn" id="${btnId}" type="button">
          <svg class="node-ref-btn__icon ref-btn-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15 8h.01"></path><path d="M12.5 21h-6.5a3 3 0 0 1 -3 -3v-12a3 3 0 0 1 3 -3h12a3 3 0 0 1 3 3v6.5"></path><path d="M3 16l5 -5c.928 -.893 2.072 -.893 3 0l3.5 3.5"></path><path d="M14 14l1 -1c.679 -.653 1.473 -.829 2.214 -.526"></path><path d="M19 22v-6"></path><path d="M22 19l-3 -3l-3 3"></path></svg>
          <span class="node-ref-btn__text">${window.I18n?.t('workflow.selectResultImage') || 'Chọn ảnh kết quả'}</span>
        </button>
        <input type="hidden" id="${inputId}" value="${this.escapeAttr(resultImgUrl)}" data-template-mode="true" />
      </div>`;
  }

  /**
   * EWT-12.2: Render preview ảnh kết quả mẫu cho template mode
   * @param {string} url - URL ảnh kết quả
   * @param {string} containerSelector - Selector của container preview
   * @param {string} ratio - Ratio của node (16:9, 4:3, 1:1, 3:4, 9:16, story, portrait, square, landscape, widescreen)
   */
  _renderTemplateResultImagePreview(url, containerSelector, ratio = '16:9') {
    const container = this.overlay?.querySelector(containerSelector);
    if (!container) return;

    // Map ratio to CSS class
    const ratioClass = this._getRatioClass(ratio);

    if (!url) {
      container.innerHTML = `
        <div class="template-result-empty">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
            <polyline points="22 4 12 14.01 9 11.01"/>
          </svg>
          <span>${window.I18n?.t('workflow.noResultImage') || 'Chưa có ảnh kết quả mẫu'}</span>
        </div>`;
      return;
    }

    container.innerHTML = `
      <div class="template-result-thumb ${ratioClass}" data-result-url="${this.escapeAttr(url)}" data-ratio="${this.escapeAttr(ratio)}">
        <img src="${this.escapeAttr(url)}" alt="${window.I18n?.t('workflow.resultPreviewImage') || 'Sample result image'}" loading="lazy" />
        <button class="template-result-thumb-remove" type="button" title="${window.I18n?.t('workflow.removeResultImage') || 'Xóa ảnh kết quả'}">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      </div>`;
  }

  /**
   * Get CSS class for ratio
   */
  _getRatioClass(ratio) {
    const ratioMap = {
      '16:9': 'ratio-16-9',
      '4:3': 'ratio-4-3',
      '1:1': 'ratio-1-1',
      '3:4': 'ratio-3-4',
      '9:16': 'ratio-9-16',
      'widescreen': 'ratio-16-9',
      'landscape': 'ratio-4-3',
      'square': 'ratio-1-1',
      'portrait': 'ratio-3-4',
      'story': 'ratio-9-16',
      'Ngang': 'ratio-16-9',
      'Dọc': 'ratio-9-16'
    };
    return ratioMap[ratio] || 'ratio-16-9';
  }

  /**
   * EWT-12.3: Bind events cho result image trong template mode
   * @param {string} btnId - ID của nút chọn ảnh
   * @param {string} inputId - ID của hidden input chứa URL
   * @param {string} previewId - ID của container preview
   * @param {string} ratioSelector - Selector của ratio input (optional)
   */
  _bindTemplateResultImageEvents(btnId, inputId, previewId, ratioSelector = null) {
    const selectBtn = this.overlay?.querySelector(`#${btnId}`);
    const hiddenInput = this.overlay?.querySelector(`#${inputId}`);
    const previewContainer = this.overlay?.querySelector(`#${previewId}`);

    if (!selectBtn || !hiddenInput) return;

    // Helper to get current ratio
    const getCurrentRatio = () => {
      if (ratioSelector) {
        const ratioEl = this.overlay?.querySelector(ratioSelector);
        // Handle both select and active pill
        if (ratioEl?.tagName === 'SELECT') {
          return ratioEl.value || '16:9';
        } else if (ratioEl) {
          const activePill = ratioEl.querySelector('.ratio-pill.active');
          return activePill?.dataset?.ratio || '16:9';
        }
      }
      return '16:9';
    };

    // Click chọn ảnh → mở WorkflowMediaModal
    selectBtn.addEventListener('click', () => {
      if (typeof WorkflowMediaModal !== 'undefined') {
        const currentUrl = hiddenInput.value || '';
        WorkflowMediaModal.show({
          type: 'result_image',
          multiple: false,
          preselected: currentUrl ? [currentUrl] : [],
          onSelect: (url) => {
            const resultUrl = Array.isArray(url) ? url[0] : url;
            hiddenInput.value = resultUrl || '';
            this._renderTemplateResultImagePreview(resultUrl, `#${previewId}`, getCurrentRatio());
            this._hasUnsavedChanges = true;
          }
        });
      } else {
        console.error('[WorkflowEditor] WorkflowMediaModal không tồn tại');
      }
    });

    // Click xóa ảnh (event delegation)
    if (previewContainer && !previewContainer._templateResultDelegated) {
      previewContainer._templateResultDelegated = true;
      previewContainer.addEventListener('click', (e) => {
        const removeBtn = e.target.closest('.template-result-thumb-remove');
        if (!removeBtn) return;

        e.stopPropagation();
        e.preventDefault();

        hiddenInput.value = '';
        hiddenInput.dataset.cleared = 'true';
        this._renderTemplateResultImagePreview('', `#${previewId}`, getCurrentRatio());
        this._hasUnsavedChanges = true;
      });
    }

    // Listen for ratio changes to update preview
    if (ratioSelector) {
      const ratioEl = this.overlay?.querySelector(ratioSelector);
      if (ratioEl?.tagName === 'SELECT') {
        ratioEl.addEventListener('change', () => {
          const url = hiddenInput.value;
          if (url) {
            this._renderTemplateResultImagePreview(url, `#${previewId}`, getCurrentRatio());
          }
        });
      } else if (ratioEl) {
        // For ratio pills container, use event delegation
        ratioEl.addEventListener('click', (e) => {
          const pill = e.target.closest('.ratio-pill');
          if (pill) {
            setTimeout(() => {
              const url = hiddenInput.value;
              if (url) {
                this._renderTemplateResultImagePreview(url, `#${previewId}`, getCurrentRatio());
              }
            }, 50);
          }
        });
      }
    }

    // Render preview ban đầu
    this._renderTemplateResultImagePreview(hiddenInput.value, `#${previewId}`, getCurrentRatio());
  }

  /**
   * Render form HTML theo node type
   */
  _renderNodeFormByType(nodeType, data, nodeId) {
    const nameField = `
      <div class="form-group">
        <label for="nodeName">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align: -1px; margin-right: 4px;"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"></path><line x1="7" y1="7" x2="7.01" y2="7"></line></svg>
          ${window.I18n?.t('workflow.nodeName') || 'Tên Node'}
        </label>
        <div class="input-group">
          <input type="text" id="nodeName" value="${this.escapeAttr(data.node_name || nodeType)}" />
        </div>
      </div>`;
    // Phase 1 — Node Reference System: Slug field for mentionable nodes (inline edit design)
    const slugValue = data.slug || '';
    const slugPlaceholder = this._normalizeToSlug(data.node_name || nodeType);
    const slugIsAuto = data.slug_auto !== false;
    const slugDisplayValue = slugValue || slugPlaceholder;
    const slugStateClass = slugIsAuto ? 'slug-auto' : 'slug-manual';
    const slugField = this._isMentionableNodeType(nodeType) ? `
      <div class="form-group form-group-slug">
        <div class="slug-inline-wrapper">
          <span class="slug-label">${window.I18n?.t('workflow.nodeSlug') || 'Slug'}:</span>
          <div class="slug-inline-display ${slugStateClass}" id="slugInlineDisplay" title="${window.I18n?.t('workflow.clickToEditSlug') || 'Click to edit'}">
            <span class="slug-at">@</span><span class="slug-value">${this.escapeHtml(slugDisplayValue)}</span>
            <svg class="slug-edit-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
          </div>
          <div class="slug-inline-edit hidden" id="slugInlineEdit">
            <span class="slug-input-prefix">@</span>
            <input type="text" id="nodeSlug" value="${this.escapeAttr(slugValue)}" placeholder="${this.escapeAttr(slugPlaceholder)}" maxlength="${WorkflowEditor.SLUG_MAX_LENGTH}" pattern="[a-z][a-z0-9_]*" />
            <button type="button" class="slug-confirm-btn" id="slugConfirmBtn" title="${window.I18n?.t('common.confirm') || 'Confirm'}">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
            </button>
          </div>
          <input type="hidden" id="nodeSlugAuto" value="${slugIsAuto ? 'true' : 'false'}" />
        </div>
        <p class="form-error hidden" id="slugError"></p>
      </div>` : '';
    // Phase: enabled toggle moved to node-form-header (icon button) — keep hidden input
    // để save logic + sync trạng thái khi save/load form data.
    const enabledField = `
      <input type="checkbox" id="nodeEnabled" ${data.enabled !== false ? 'checked' : ''} style="display:none;" />`;

    if (nodeType === 'note') {
      return `${nameField}
        <div class="form-group">
          <label for="nodeNoteText">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align: -1px; margin-right: 4px;"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><line x1="10" y1="9" x2="8" y2="9"></line></svg>
            ${window.I18n?.t('workflow.noteNodeLabel') || 'Ghi chú'}
          </label>
          <textarea id="nodeNoteText" style="height: 120px;" placeholder="${window.I18n?.t('workflow.notePlaceholder') || 'Nhập ghi chú...'}">${this.escapeHtml(data.note_text || '')}</textarea>
        </div>`;
    }
    if (nodeType === 'delay') {
      return `${nameField}
        <div class="form-group">
          <label for="nodeDelaySeconds">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align: -1px; margin-right: 4px;"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
            ${window.I18n?.t('workflow.delaySeconds') || 'Thời gian chờ (giây)'}
          </label>
          <div class="input-group">
            <input type="number" id="nodeDelaySeconds" min="1" max="300" value="${data.delay_seconds || 3}" />
          </div>
        </div>
        ${enabledField}`;
    }
    if (nodeType === 'image') {
      // EWT-9.1: Kiểm tra template mode hoặc template preview để render UI phù hợp
      const isTemplateCtx = this.isTemplateMode || this.workflow?._is_template_preview || this.workflow?._isPreview;
      if (isTemplateCtx) {
        // Template mode/preview: hiển thị ref images từ URLs
        const refField = this._renderRefImagesFieldForTemplate(data, 'imageNodeRefPreview', 'imageNodeRefImgUrls', 'imageNodePickBtn', 10);
        return `${nameField}${slugField}${refField}${enabledField}`;
      }
      // Normal mode: chọn ảnh từ Flow
      return `${nameField}${slugField}
        <div class="form-group" id="nodeRefImagesGroup">
          <label>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align: -1px; margin-right: 4px;"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>
            ${window.I18n?.t('workflow.refImages') || 'Reference images'}
          </label>
          <button class="node-ref-btn" id="imageNodePickBtn">
            <svg class="node-ref-btn__icon ref-btn-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15 8h.01"></path><path d="M12.5 21h-6.5a3 3 0 0 1 -3 -3v-12a3 3 0 0 1 3 -3h12a3 3 0 0 1 3 3v6.5"></path><path d="M3 16l5 -5c.928 -.893 2.072 -.893 3 0l3.5 3.5"></path><path d="M14 14l1 -1c.679 -.653 1.473 -.829 2.214 -.526"></path><path d="M19 22v-6"></path><path d="M22 19l-3 -3l-3 3"></path></svg>
            <span class="node-ref-btn__text">${window.I18n?.t('workflow.selectRefImages') || 'Select / Upload image'}</span>
          </button>
          <div class="ref-images-preview" id="imageNodeRefPreview"></div>
          <input type="hidden" id="nodeRefFileIds" value="${this.escapeAttr(data.ref_file_ids || '')}" />
        </div>
        ${enabledField}`;
    }
    // Phase 1 — Node Reference System: Text node form
    if (nodeType === 'text') {
      const textContent = data.prompt || data.note_text || '';
      return `${nameField}${slugField}
        <div class="form-group">
          <label for="textNodeContent">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align: -1px; margin-right: 4px;"><polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/></svg>
            ${window.I18n?.t('workflow.textContent') || 'Nội dung Text'}
          </label>
          <textarea id="textNodeContent" style="height: 150px;" placeholder="${window.I18n?.t('workflow.textNodePlaceholder') || 'VD: cinematic lighting, 8k UHD, professional photography'}">${this.escapeHtml(textContent)}</textarea>
          <p style="font-size: 11px; color: var(--muted-foreground); margin-top: 4px;">${window.I18n?.t('workflow.textNodeHint') || 'Dùng @slug trong prompt của node khác để chèn nội dung này.'}</p>
        </div>
        ${enabledField}`;
    }

    // Text Extract Node (2026-05-29): form 6 fields cho regex/JSON parse config
    if (nodeType === 'text_extract') {
      const mode = data.extract_mode || 'marker';
      const marker = data.extract_marker || '';
      const customRegex = data.extract_regex || '';
      const strict = data.extract_strict === true;
      const multiMatch = data.extract_multi_match || 'first';
      const onFail = data.extract_on_fail || 'skip_downstream';
      const isRegexMode = mode === 'regex';
      return `${nameField}${slugField}
        <div class="form-group">
          <label for="nodeExtractMode">${window.I18n?.t('workflow.extractMode') || 'Mode'}</label>
          <div class="input-group select-group compact-select">
            <select id="nodeExtractMode">
              <option value="marker" ${mode === 'marker' ? 'selected' : ''}>${window.I18n?.t('workflow.extractModeMarker') || 'Marker [name]'}</option>
              <option value="json" ${mode === 'json' ? 'selected' : ''}>${window.I18n?.t('workflow.extractModeJson') || 'JSON key'}</option>
              <option value="regex" ${mode === 'regex' ? 'selected' : ''}>${window.I18n?.t('workflow.extractModeRegex') || 'Custom regex'}</option>
            </select>
            <svg class="select-arrow" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg>
          </div>
        </div>

        <div class="form-group ${isRegexMode ? 'hidden' : ''}" id="nodeExtractMarkerGroup">
          <label for="nodeExtractMarker">${window.I18n?.t('workflow.extractMarker') || 'Tên marker / JSON key'}</label>
          <input id="nodeExtractMarker" type="text" placeholder="image_prompt_1" value="${this.escapeAttr(marker)}" />
          <p style="font-size: 11px; color: var(--muted-foreground); margin-top: 6px; line-height: 1.4;">${window.I18n?.t('workflow.extractMarkerHint') || 'Auto match [name]:value (marker mode) hoặc JSON {"name": "value"} (json mode)'}</p>
        </div>

        <div class="form-group ${isRegexMode ? '' : 'hidden'}" id="nodeExtractRegexGroup">
          <label for="nodeExtractRegex">${window.I18n?.t('workflow.extractRegex') || 'Custom regex pattern'}</label>
          <input id="nodeExtractRegex" type="text" placeholder="\\[image_prompt_(\\d+)\\]:?\\s*(.+?)(?=\\[|$)" value="${this.escapeAttr(customRegex)}" />
          <p style="font-size: 11px; color: var(--muted-foreground); margin-top: 6px; line-height: 1.4;">${window.I18n?.t('workflow.extractRegexHint') || 'Group 1 (hoặc group cuối) = text output. Flags gi auto.'}</p>
        </div>

        <div class="form-group">
          <div style="display:flex;align-items:center;gap:10px;cursor:pointer;" id="nodeExtractStrictWrap">
            <label class="toggle-switch-compact" style="margin:0;">
              <input type="checkbox" id="nodeExtractStrict" ${strict ? 'checked' : ''}>
              <span class="toggle-slider-compact"></span>
            </label>
            <label for="nodeExtractStrict" style="font-size:12px;color:var(--foreground);cursor:pointer;margin:0;">
              ${window.I18n?.t('workflow.extractStrict') || 'Strict mode (case-sensitive)'}
            </label>
          </div>
        </div>

        <div class="form-group form-grid-2col">
          <div>
            <label for="nodeExtractMultiMatch">${window.I18n?.t('workflow.extractMultiMatch') || 'Nhiều match'}</label>
            <div class="input-group select-group compact-select">
              <select id="nodeExtractMultiMatch">
                <option value="first" ${multiMatch === 'first' ? 'selected' : ''}>${window.I18n?.t('common.first') || 'First'}</option>
                <option value="last" ${multiMatch === 'last' ? 'selected' : ''}>${window.I18n?.t('common.last') || 'Last'}</option>
                <option value="concat" ${multiMatch === 'concat' ? 'selected' : ''}>${window.I18n?.t('workflow.extractConcat') || 'Concat all'}</option>
                <option value="error" ${multiMatch === 'error' ? 'selected' : ''}>${window.I18n?.t('common.error') || 'Error'}</option>
              </select>
              <svg class="select-arrow" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg>
            </div>
          </div>
          <div>
            <label for="nodeExtractOnFail">${window.I18n?.t('workflow.extractOnFail') || 'Khi extract fail'}</label>
            <div class="input-group select-group compact-select">
              <select id="nodeExtractOnFail">
                <option value="empty" ${onFail === 'empty' ? 'selected' : ''}>${window.I18n?.t('workflow.extractFailEmpty') || 'Pass text rỗng'}</option>
                <option value="skip_downstream" ${onFail === 'skip_downstream' ? 'selected' : ''}>${window.I18n?.t('workflow.extractFailSkip') || 'Skip downstream'}</option>
                <option value="fail_workflow" ${onFail === 'fail_workflow' ? 'selected' : ''}>${window.I18n?.t('workflow.extractFailWorkflow') || 'Fail workflow'}</option>
              </select>
              <svg class="select-arrow" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg>
            </div>
          </div>
        </div>
        ${enabledField}`;
    }
    if (nodeType === 'download') {
      const folderName = data.download_folder || '';
      const fileTemplate = data.download_file_template || '';
      const downloadRes = data.download_resolution || '1k';
      // Bug 39 fix (2026-05-19): Download node nhận input từ upstream — có thể image
      // hoặc video. Runtime (WorkflowExecutor:3237-3240) auto-detect upstream type +
      // pick `video_download_resolution` cho video, `download_resolution` cho image.
      // Trước fix UI chỉ render 1 dropdown image → user không chọn được video resolution
      // → runtime luôn fallback '720p' (không thể 1080p/4K).
      const videoDownloadRes = data.video_download_resolution || '720p';
      const collectAll = data.download_collect_all === true || data.download_collect_all === '1' || data.download_collect_all === 1;
      const canUseDownload = window.featureGate?.canUse('auto_download') ?? false;
      return `${nameField}
        <div class="form-group">
          <p style="font-size: 12px; color: var(--muted-foreground);">${window.I18n?.t('workflow.downloadNodeDesc') || 'Tải xuống kết quả từ node trước đó'}</p>
        </div>
        <div class="form-group node-download-gate${canUseDownload ? ' hidden' : ''}" id="nodeDownloadGate">
          <div style="display: flex; align-items: center; gap: 6px; padding: 8px 10px; background: rgba(234, 179, 8, 0.08); border: 1px solid rgba(234, 179, 8, 0.25); border-radius: 6px;">
            <svg class="node-download-crown" width="14" height="14" viewBox="0 0 24 24" fill="#eab308"><path d="M5 16L3 5L8.5 10L12 4L15.5 10L21 5L19 16H5ZM19 19C19 19.6 18.6 20 18 20H6C5.4 20 5 19.6 5 19V18H19V19Z"></path></svg>
            <span style="font-size: 12px; color: var(--muted-foreground);">${window.I18n?.t('workflow.downloadGateMsg') || 'Tính năng tải xuống yêu cầu gói Premium. Nâng cấp để sử dụng.'} <a href="#" class="node-download-upgrade-link" style="color: #eab308; text-decoration: underline;">${window.I18n?.t('common.upgrade') || 'Upgrade'}</a></span>
          </div>
        </div>
        <div class="form-group">
          <label>${window.I18n?.t('workflow.downloadNodeResolution') || 'Image resolution'}</label>
          <p style="font-size: 11px; color: var(--muted-foreground); margin-top: -2px; margin-bottom: 6px;">${window.I18n?.t('workflow.downloadNodeImageResHint') || 'Chỉ áp dụng cho ảnh Flow (1K/2K/4K). ChatGPT/Grok dùng CDN trực tiếp, không có menu resolution.'}</p>
          <div class="input-group select-group compact-select">
            <select id="downloadResolution">
              ${(window.ProviderConfigManager?.getDownloadResolutionsSync('flow', 'image') || [
                { value: '1k', label: '1K' },
                { value: '2k', label: '2K' },
                { value: '4k', label: '4K (Ultra)' },
              ]).map(r => `<option value="${r.value}" ${downloadRes === r.value ? 'selected' : ''}>${r.label || r.menu_label || r.value}</option>`).join('')}
            </select>
            <svg class="select-arrow" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg>
          </div>
        </div>
        <div class="form-group">
          <label>${window.I18n?.t('workflow.downloadNodeVideoResolution') || 'Video resolution'}</label>
          <p style="font-size: 11px; color: var(--muted-foreground); margin-top: -2px; margin-bottom: 6px;">${window.I18n?.t('workflow.downloadNodeVideoResHint') || 'Chỉ áp dụng cho video Flow (720p/1080p/4K). Grok video tải trực tiếp từ CDN, không có menu resolution.'}</p>
          <div class="input-group select-group compact-select">
            <select id="downloadVideoResolution">
              ${(window.ProviderConfigManager?.getDownloadResolutionsSync('flow', 'video') || [
                { value: '720p', label: '720p' },
                { value: '1080p', label: '1080p' },
                { value: '4k', label: '4K (Ultra)' },
              ]).map(r => `<option value="${r.value}" ${videoDownloadRes === r.value ? 'selected' : ''}>${r.label || r.menu_label || r.value}</option>`).join('')}
            </select>
            <svg class="select-arrow" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg>
          </div>
        </div>
        <div class="form-group">
          <div class="node-collect-toggle">
            <label class="toggle-switch-compact">
              <input type="checkbox" id="downloadCollectAll" ${collectAll ? 'checked' : ''}>
              <span class="toggle-slider-compact"></span>
            </label>
            <div class="node-collect-info">
              <span class="node-collect-label">${window.I18n?.t('workflow.collectAll') || 'Thu thập toàn bộ'}</span>
              <span class="node-collect-desc">${window.I18n?.t('workflow.collectAllDesc') || 'Lấy file từ tất cả nodes'}</span>
            </div>
          </div>
        </div>
        <div class="form-group">
          <label>${window.I18n?.t('workflow.folderName') || 'Tên thư mục'}</label>
          <input type="text" id="downloadFolder" class="form-input" value="${folderName}" placeholder="${window.I18n?.t('workflow.leaveEmpty') || 'Leave empty = default'}">
          <p style="font-size: 11px; color: var(--muted-foreground); margin-top: 4px;">${window.I18n?.t('workflow.folderVars') || 'Biến: {workflow}, {date}, {time}'}</p>
        </div>
        <div class="form-group">
          <label>${window.I18n?.t('workflow.fileName') || 'Tên file'}</label>
          <input type="text" id="downloadFileTemplate" class="form-input" value="${fileTemplate}" placeholder="${window.I18n?.t('workflow.leaveEmpty') || 'Leave empty = default'}">
          <p style="font-size: 11px; color: var(--muted-foreground); margin-top: 4px;">${window.I18n?.t('workflow.fileVars') || 'Biến: {prompt}, {node}, {index}, {date}, {time}'}</p>
        </div>
        ${enabledField}`;
    }
    if (nodeType === 'telegram') {
      const chatId = data.telegram_chat_id || '';
      const telegramMsg = data.telegram_message || '';
      const sendMode = data.telegram_send_mode || 'single';
      const canUseTelegram = (window.featureGate?.canUse('telegram_enabled') ?? false) &&
        (window.featureGate?.canUse('telegram_workflow') ?? false);
      return `${nameField}
        <div class="form-group">
          <p style="font-size: 12px; color: var(--muted-foreground);">${window.I18n?.t('workflow.telegramNodeDesc') || 'Gửi ảnh kết quả từ các node nguồn qua Telegram.'}</p>
        </div>
        <div class="form-group node-telegram-gate${canUseTelegram ? ' hidden' : ''}" id="nodeTelegramGate">
          <div style="display: flex; align-items: center; gap: 6px; padding: 8px 10px; background: rgba(234, 179, 8, 0.08); border: 1px solid rgba(234, 179, 8, 0.25); border-radius: 6px;">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="#eab308"><path d="M5 16L3 5L8.5 10L12 4L15.5 10L21 5L19 16H5ZM19 19C19 19.6 18.6 20 18 20H6C5.4 20 5 19.6 5 19V18H19V19Z"></path></svg>
            <span style="font-size: 12px; color: var(--muted-foreground);">${window.I18n?.t('workflow.telegramGateMsg') || 'Tính năng Telegram yêu cầu gói Premium. Nâng cấp để sử dụng.'} <a href="#" class="node-telegram-upgrade-link" style="color: #eab308; text-decoration: underline;">${window.I18n?.t('common.upgrade') || 'Upgrade'}</a></span>
          </div>
        </div>
        <div class="form-group">
          <label>${window.I18n?.t('workflow.telegramChatId') || 'Chat ID'}</label>
          <input type="text" id="telegramChatId" class="form-input" value="${chatId}" placeholder="${window.I18n?.t('workflow.telegramChatIdPlaceholder') || 'E.g.: 123456789'}">
          <p style="font-size: 11px; color: var(--muted-foreground); margin-top: 4px;" id="telegramLinkStatus">${window.I18n?.t('workflow.checkingLink') || 'Checking link...'}</p>
        </div>
        <div class="form-group">
          <label>${window.I18n?.t('workflow.telegramSendMode') || 'Send images'}</label>
          <div class="input-group select-group compact-select">
            <select id="telegramSendMode">
              <option value="single" ${sendMode === 'single' ? 'selected' : ''}>${window.I18n?.t('workflow.telegramSendSingle') || 'Individual (multiple messages)'}</option>
              <option value="group" ${sendMode === 'group' ? 'selected' : ''}>${window.I18n?.t('workflow.telegramSendGroup') || 'Group (1 message)'}</option>
            </select>
            <svg class="select-arrow" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg>
          </div>
        </div>
        <div class="form-group">
          <label>${window.I18n?.t('workflow.telegramCaption') || 'Caption'}</label>
          <textarea id="telegramMessage" class="form-input" rows="2" placeholder="${window.I18n?.t('workflow.telegramCaptionPlaceholder') || 'E.g.: Workflow results...'}">${telegramMsg}</textarea>
        </div>
        ${enabledField}`;
    }
    // === AI AGENT NODE (Phase CG-8 + AI Agent rename 2026-05-30) ===
    // Form: textarea prompt + toggle Use AI + (conditional) provider dropdown + timeout
    if (nodeType === 'prompt') {
      const promptText = data.prompt || '';
      const enhance = !!data.use_ai;   // var name `enhance` giữ vì template HTML below dùng nhiều
      const provider = data.provider || 'chatgpt';
      const timeoutSec = data.timeout_sec || 60;
      // Feature gates — canUseAiAgent() check key 'ai_agent_enabled' duy nhất.
      const canEnhance = !!(window.featureGate?.canUseAiAgent?.());
      const canChatGPT = !!(window.featureGate?.canUse('chatgpt_enabled'));
      const canGemini = !!(window.featureGate?.canUse('gemini_enabled'));
      // Provider names from ProviderMeta
      const chatgptName = window.ProviderMeta?.getName?.('chatgpt') || 'ChatGPT';
      const geminiName = window.ProviderMeta?.getName?.('gemini') || 'Gemini';
      const providerName = provider === 'chatgpt' ? chatgptName : geminiName;
      // SVG lock icon (thay cho emoji 🔒)
      // AI Agent 2026-05-30: Crown icon thay lock — user-friendly hơn (premium thay vì "khóa").
      const crownIconSvg = `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="none" style="vertical-align: -2px; margin-right: 3px;"><path d="M5 16L3 7l5.5 4L12 4l3.5 7L21 7l-2 9H5zm0 2h14v2H5v-2z"/></svg>`;
      // Provider section hidden by default khi enhance OFF
      const providerHiddenClass = enhance ? '' : ' hidden';
      return `${nameField}${slugField}
        <div class="form-group">
          <label for="promptNodeText">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align: -1px; margin-right: 4px;"><path d="M12 3l2.39 5.26L20 10l-4.5 4.13L17 20l-5-3-5 3 1.5-5.87L4 10l5.61-1.74L12 3z"/></svg>
            ${window.I18n?.t('workflow.promptText') || 'Nội dung Prompt'}
          </label>
          <div class="prompt-mention-wrapper">
            <textarea id="promptNodeText" placeholder="${window.I18n?.t('workflow.promptNodePlaceholder') || 'VD: A cute cat playing with yarn, cinematic lighting'}">${this.escapeHtml(promptText)}</textarea>
          </div>
          <details class="mention-mode-advanced">
            <summary>${window.I18n?.t('workflow.mentionModeAdvanced') || 'Mention Mode (Advanced)'}</summary>
            <div class="mention-mode-row">
              <div class="mention-mode-group">
                <label class="mention-mode-label">${window.I18n?.t('workflow.promptMode') || 'Prompt'}</label>
                <select id="promptNodePromptMode" class="mention-mode-select">
                  <option value="auto" selected>${window.I18n?.t('workflow.modeAuto') || 'Auto'}</option>
                  <option value="all">${window.I18n?.t('workflow.modeAll') || 'All'}</option>
                  <option value="mention">${window.I18n?.t('workflow.modeMention') || 'Mention'}</option>
                </select>
              </div>
              <div class="mention-mode-group">
                <label class="mention-mode-label">${window.I18n?.t('workflow.refMode') || 'Ref'}</label>
                <select id="promptNodeRefMode" class="mention-mode-select">
                  <option value="auto" selected>${window.I18n?.t('workflow.modeAuto') || 'Auto'}</option>
                  <option value="all">${window.I18n?.t('workflow.modeAll') || 'All'}</option>
                  <option value="mention">${window.I18n?.t('workflow.modeMention') || 'Mention'}</option>
                </select>
              </div>
            </div>
          </details>
        </div>
        <div class="form-group">
          <label class="toolbar-toggle${!canEnhance ? ' feature-disabled' : ''}" for="promptNodeUseAi" ${!canEnhance ? `title="${window.I18n?.t('workflow.featureDisabled') || 'Tính năng này yêu cầu gói Premium'}"` : ''}>
            <input type="checkbox" id="promptNodeUseAi" ${enhance ? 'checked' : ''} ${!canEnhance ? 'disabled' : ''} />
            <span class="toggle-track"><span class="toggle-thumb"></span></span>
            <span class="toggle-label">${window.I18n?.t('workflow.useAi') || 'Dùng AI'}</span>
            ${!canEnhance ? `<span class="premium-crown" style="margin-left:6px;" title="${window.I18n?.t('workflow.useAiPremiumOnly') || 'Chỉ hoạt động với tài khoản Premium'}">${crownIconSvg}${window.I18n?.t('workflow.useAiPremiumOnly') || 'Chỉ hoạt động với tài khoản Premium'}</span>` : ''}
          </label>
          <p style="font-size: 11px; color: var(--muted-foreground); margin-top: 4px;">${enhance
            ? (window.I18n?.t('workflow.useAiOnHint') || 'Submit text qua AI (ChatGPT/Gemini) — enhance prompt, analyze, compose, translate, summarize.')
            : (window.I18n?.t('workflow.useAiOffHint') || 'Output = text nguyên văn (không gọi AI, không tốn quota).')}</p>
        </div>
        <!-- AI Agent 2026-05-30: Provider + Timeout 2-col grid layout. Provider status button vẫn ở header
             trên Provider col. Hints + warning render full-width dưới grid. -->
        <div class="form-group prompt-node-provider-section${providerHiddenClass}" id="promptNodeProviderSection">
          <div class="prompt-provider-timeout-row">
            <div class="prompt-provider-col">
              <div class="prompt-provider-header">
                <label for="promptNodeProvider">${window.I18n?.t('workflow.provider') || 'Provider'}</label>
                <button type="button" class="provider-reminder-btn prompt-provider-btn" id="promptProviderStatusBtn" data-provider="${provider}" title="${window.I18n?.t('workflow.checkingStatus') || 'Checking...'}">
                  <span class="provider-status-dot"></span>
                  <span class="provider-btn-text" data-ready-text="${window.I18n?.t('workflow.providerReady') || 'Ready'}" data-not-ready-text="${window.I18n?.t('workflow.openProvider') || 'Open'} ${providerName}">${window.I18n?.t('workflow.openProvider') || 'Open'} ${providerName}</span>
                </button>
              </div>
              <div class="input-group select-group compact-select">
                <select id="promptNodeProvider">
                  <option value="chatgpt" ${provider === 'chatgpt' ? 'selected' : ''} ${!canChatGPT ? 'disabled' : ''}>${chatgptName}${!canChatGPT ? ' (Pro)' : ''}</option>
                  <option value="gemini" ${provider === 'gemini' ? 'selected' : ''} ${!canGemini ? 'disabled' : ''}>${geminiName}${!canGemini ? ' (Pro)' : ''}</option>
                </select>
                <svg class="select-arrow" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg>
              </div>
            </div>
            <div class="prompt-timeout-col" id="promptNodeTimeoutSection">
              <label for="promptNodeTimeout">${window.I18n?.t('workflow.promptTimeout') || 'Timeout'}</label>
              <div class="input-group">
                <input type="number" id="promptNodeTimeout" min="10" max="600" value="${timeoutSec}" />
                <span style="font-size: 11px; color: var(--muted-foreground); margin-left: 8px; margin-right: 10px;">s</span>
              </div>
            </div>
          </div>
          <p style="font-size: 11px; color: var(--warning); margin-top: 6px;">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align: -2px; margin-right: 2px;"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>
            ${window.I18n?.t('workflow.promptProviderHint') || 'Khuyên dùng ChatGPT. Gemini có thể trả ảnh thay vì text.'}
            <span style="margin-left:8px; color: var(--muted-foreground);">·</span>
            <span style="color: var(--muted-foreground);">${window.I18n?.t('workflow.promptTimeoutHint') || 'Thời gian chờ AI phản hồi (tăng nếu prompt dài)'}</span>
          </p>
        </div>
        ${(this.isTemplateMode || this.workflow?._is_template_preview || this.workflow?._isPreview)
          // EWT-9.1: Template mode/preview - hiển thị ref images từ URLs
          ? `<div class="form-group prompt-node-provider-section${providerHiddenClass}" id="promptNodeRefsGroup">
              ${this._renderRefImagesFieldForTemplate(data, 'promptNodeRefPreview', 'promptNodeRefImgUrls', 'promptNodePickBtn', 4)}
              <p style="font-size: 11px; color: var(--muted-foreground); margin-top: 4px;">${window.I18n?.t('workflow.promptRefHint') || 'Images sent with prompt to LLM for image context understanding.'}</p>
            </div>`
          // Normal mode - chọn ảnh từ Flow
          : `<div class="form-group prompt-node-provider-section${providerHiddenClass}" id="promptNodeRefsGroup">
          <label>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align: -1px; margin-right: 4px;"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>
            ${window.I18n?.t('workflow.promptRefImages') || 'Reference images (max 4)'}
          </label>
          <button class="node-ref-btn" id="promptNodePickBtn" type="button">
            <svg class="node-ref-btn__icon ref-btn-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15 8h.01"></path><path d="M12.5 21h-6.5a3 3 0 0 1 -3 -3v-12a3 3 0 0 1 3 -3h12a3 3 0 0 1 3 3v6.5"></path><path d="M3 16l5 -5c.928 -.893 2.072 -.893 3 0l3.5 3.5"></path><path d="M14 14l1 -1c.679 -.653 1.473 -.829 2.214 -.526"></path><path d="M19 22v-6"></path><path d="M22 19l-3 -3l-3 3"></path></svg>
            <span class="node-ref-btn__text">${window.I18n?.t('workflow.selectRefImages') || 'Select / Upload image'}</span>
          </button>
          <div class="ref-images-preview" id="promptNodeRefPreview"></div>
          <input type="hidden" id="promptNodeRefFileIds" value="${this.escapeAttr(data.ref_file_ids || '')}" />
          <p style="font-size: 11px; color: var(--muted-foreground); margin-top: 4px;">${window.I18n?.t('workflow.promptRefHint') || 'Images sent with prompt to LLM for image context understanding.'}</p>
        </div>`}
        <!-- 2026-05-31 UX: Cài đặt nâng cao đặt SAU ref images section (theo user request) —
             để fields chính (provider/timeout/ref) lên trên, advanced collapsible cuối. -->
        <details class="mention-mode-advanced prompt-advanced-settings prompt-node-provider-section${providerHiddenClass}" id="promptNodeAdvancedSection">
          <summary>${window.I18n?.t('workflow.promptAdvancedSettings') || 'Cài đặt nâng cao'}</summary>
          <div class="form-group" id="promptNodeFallbackSection">
            <label class="toolbar-toggle" for="promptNodeFallback">
              <input type="checkbox" id="promptNodeFallback" ${data.ai_fallback !== false ? 'checked' : ''} />
              <span class="toggle-track"><span class="toggle-thumb"></span></span>
              <span class="toggle-label">${window.I18n?.t('workflow.aiFallback') || 'Fallback plain text nếu AI lỗi'}</span>
            </label>
            <p style="font-size: 11px; color: var(--muted-foreground); margin-top: 4px;">${window.I18n?.t('workflow.aiFallbackHint') || 'Tự động dùng text nguyên văn nếu AI không phản hồi (timeout/lỗi).'}</p>
          </div>
          <div class="form-group" id="promptNodeDeleteAfterSection">
            <label class="toolbar-toggle" for="promptNodeDeleteAfter">
              <input type="checkbox" id="promptNodeDeleteAfter" ${data.ai_delete_after_run !== false ? 'checked' : ''} />
              <span class="toggle-track"><span class="toggle-thumb"></span></span>
              <span class="toggle-label">${window.I18n?.t('workflow.aiDeleteAfterRun') || 'Xoá conversation sau khi AI run'}</span>
            </label>
            <p style="font-size: 11px; color: var(--muted-foreground); margin-top: 4px;">${window.I18n?.t('workflow.aiDeleteAfterRunHint') || 'Tự động xoá conversation trên ChatGPT/Gemini sau khi nhận kết quả → giữ chat history sạch. Chỉ chạy khi AI run thành công.'}</p>
          </div>
        </details>
        ${enabledField}`;
    }

    // === CHATGPT NODE ===
    if (nodeType === 'chatgpt') {
      const cgPrompt = data.prompt || '';
      const cgRatio = data.ratio || 'story';
      const cgUseFallback = data.use_fallback_prefix || 'auto';
      const cgTimeout = data.timeout_ms || 120000;
      const cgAutoDownload = !!data.auto_download;
      const canUseChatGPT = (window.featureGate?.canUse('chatgpt_enabled') ?? false);
      // Bug 35 fix (2026-05-19): Đọc từ ChatGPTAdapter.capabilities (PCM-backed getter).
      // Admin tweak ratios qua /admin/providers/chatgpt/api-configs → SSE → adapter trả fresh.
      // Fallback inline 5 ratios khi adapter chưa load.
      const _cgAdapter = window.ProviderRegistry?.get?.('chatgpt');
      const _cgSupportedRatios = _cgAdapter?.capabilities?.supportedRatios
        || ['story', 'portrait', 'square', 'landscape', 'widescreen'];
      const _cgRatioUiMap = _cgAdapter?.capabilities?.ratioUiMap
        || { story: '9:16', portrait: '3:4', square: '1:1', landscape: '4:3', widescreen: '16:9' };
      const cgRatioOptions = _cgSupportedRatios.map(key => ({ key, label: _cgRatioUiMap[key] || key }));
      // SVG icon cho mỗi ratio (rectangle với aspect ratio tương ứng — vertical / horizontal / square)
      const cgRatioIcons = {
        story:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="3" width="6" height="18" rx="1.2"/></svg>',
        portrait:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="7" y="4" width="10" height="16" rx="1.2"/></svg>',
        square:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="5" width="14" height="14" rx="1.2"/></svg>',
        landscape:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="7" width="16" height="10" rx="1.2"/></svg>',
        widescreen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="9" width="18" height="6" rx="1.2"/></svg>'
      };
      const cgRatioPills = cgRatioOptions.map(opt => `
        <button type="button" class="ratio-pill chatgpt-ratio-pill${opt.key === cgRatio ? ' active' : ''}" data-ratio="${opt.key}" title="${opt.label}">${cgRatioIcons[opt.key] || ''}<span>${opt.label}</span></button>
      `).join('');
      const cgPromptSourceHtml = this._renderPromptSourceRadio(data, nodeId);
      const cgLockIconSvg = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink:0;"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`;
      const chatgptBrandHeader = `
        <div class="node-brand-header node-brand-header--chatgpt">
          <svg class="node-brand-logo" width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z"/></svg>
          <span class="node-brand-name" data-provider="chatgpt">${window.ProviderMeta?.getName?.('chatgpt') || 'ChatGPT'}</span>
          ${this._renderProviderLoginReminder('chatgpt')}
        </div>`;
      return `${chatgptBrandHeader}${nameField}${slugField}
        ${cgPromptSourceHtml}
        ${!canUseChatGPT ? `
        <div class="form-group node-chatgpt-gate" id="nodeChatGPTGate">
          <div style="padding:10px 12px;background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.3);border-radius:6px;display:flex;align-items:center;gap:8px;color:#f59e0b;font-size:12px;">
            ${cgLockIconSvg}
            <span>${window.I18n?.t('workflow.chatgptImageLockedHint') || 'ChatGPT Image yêu cầu gói Pro. Node có thể chỉnh nhưng KHÔNG chạy được.'} <a href="#" class="node-chatgpt-upgrade-link" style="color:#f59e0b;text-decoration:underline;">${window.I18n?.t('common.upgrade') || 'Upgrade'}</a></span>
          </div>
        </div>` : ''}
        <div class="form-group" id="chatgptNodePromptGroup">
          <label for="chatgptNodePrompt">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align: -1px; margin-right: 4px;"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
            ${window.I18n?.t('workflow.prompt') || 'Prompt'}
          </label>
          <div class="prompt-mention-wrapper">
            <textarea id="chatgptNodePrompt" placeholder="${window.I18n?.t('workflow.chatgptPromptPlaceholder') || 'VD: A cute cat playing in the garden...'}">${this.escapeHtml(cgPrompt)}</textarea>
          </div>
          <details class="mention-mode-advanced">
            <summary>${window.I18n?.t('workflow.mentionModeAdvanced') || 'Mention Mode (Advanced)'}</summary>
            <div class="mention-mode-row">
              <div class="mention-mode-group">
                <label class="mention-mode-label">${window.I18n?.t('workflow.promptMode') || 'Prompt'}</label>
                <select id="chatgptPromptMode" class="mention-mode-select">
                  <option value="auto" selected>${window.I18n?.t('workflow.modeAuto') || 'Auto'}</option>
                  <option value="all">${window.I18n?.t('workflow.modeAll') || 'All'}</option>
                  <option value="mention">${window.I18n?.t('workflow.modeMention') || 'Mention'}</option>
                </select>
              </div>
              <div class="mention-mode-group">
                <label class="mention-mode-label">${window.I18n?.t('workflow.refMode') || 'Ref'}</label>
                <select id="chatgptRefMode" class="mention-mode-select">
                  <option value="auto" selected>${window.I18n?.t('workflow.modeAuto') || 'Auto'}</option>
                  <option value="all">${window.I18n?.t('workflow.modeAll') || 'All'}</option>
                  <option value="mention">${window.I18n?.t('workflow.modeMention') || 'Mention'}</option>
                </select>
              </div>
            </div>
          </details>
        </div>
        <div class="form-group">
          <div class="node-form-mode-toggle" role="tablist" aria-label="${window.I18n?.t('workflow.modeLabel') || 'Chế độ'}">
            <button type="button" class="node-form-mode-btn active" data-mode="image" data-tooltip="${window.I18n?.t('workflow.genTypeImage') || 'Image'}" aria-label="${window.I18n?.t('workflow.genTypeImage') || 'Image'}" aria-selected="true" role="tab">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
            </button>
          </div>
        </div>
        <div class="form-group">
          <label>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align: -1px; margin-right: 4px;"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="9" y1="3" x2="9" y2="21"></line></svg>
            ${window.I18n?.t('workflow.imageRatio') || 'Tỷ lệ ảnh'}
          </label>
          <div class="ratio-pills-container" id="chatgptImageRatioPills">
            ${cgRatioPills}
          </div>
          <input type="hidden" id="chatgptImageRatio" value="${this.escapeAttr(cgRatio)}" />
        </div>
        ${(this.isTemplateMode || this.workflow?._is_template_preview || this.workflow?._isPreview)
          // EWT-9.1: Template mode/preview - hiển thị ref images từ URLs
          ? `<div class="form-group" id="chatgptImageRefImagesGroup">
              ${this._renderRefImagesFieldForTemplate(data, 'chatgptImageRefPreview', 'chatgptImageRefImgUrls', 'chatgptImageNodePickBtn', 4)}
            </div>
            ${this._renderResultImageFieldForTemplate(data, 'chatgptResultPreview', 'chatgptResultImgUrl', 'chatgptResultPickBtn')}`
          // Normal mode - chọn ảnh từ Flow
          : `<div class="form-group" id="chatgptImageRefImagesGroup">
          <label>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align: -1px; margin-right: 4px;"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>
            ${window.I18n?.t('workflow.refImages') || 'Reference images'} <span style="font-size: 11px; color: var(--muted-foreground); font-weight: normal;">(${window.I18n?.t('workflow.chatgptRefMax') || 'max 4'})</span>
          </label>
          <button class="node-ref-btn" id="chatgptImageNodePickBtn">
            <svg class="node-ref-btn__icon ref-btn-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15 8h.01"></path><path d="M12.5 21h-6.5a3 3 0 0 1 -3 -3v-12a3 3 0 0 1 3 -3h12a3 3 0 0 1 3 3v6.5"></path><path d="M3 16l5 -5c.928 -.893 2.072 -.893 3 0l3.5 3.5"></path><path d="M14 14l1 -1c.679 -.653 1.473 -.829 2.214 -.526"></path><path d="M19 22v-6"></path><path d="M22 19l-3 -3l-3 3"></path></svg>
            <span class="node-ref-btn__text">${window.I18n?.t('workflow.selectRefImages') || 'Select / Upload image'}</span>
          </button>
          <div class="ref-images-preview" id="chatgptImageRefPreview"></div>
          <input type="hidden" id="chatgptImageRefFileIds" value="${this.escapeAttr(data.ref_file_ids || '')}" />
        </div>`}
        <div class="form-group">
          <label for="chatgptNodeModel">${window.I18n?.t('node.modelPill') || 'Model'}</label>
          <div class="input-group select-group compact-select">
            <select id="chatgptNodeModel">
              ${(window.ModelRegistry?.safeGetModelsSync('chatgpt', 'image') || [{ value: 'Instant', name: 'Instant' }, { value: 'Thinking', name: 'Thinking' }]).map(m => `<option value="${this.escapeAttr(m.value || m.name)}" ${(data.model || 'Instant') === (m.value || m.name) ? 'selected' : ''}>${this.escapeHtml(m.name || m.value)}</option>`).join('')}
            </select>
            <svg class="select-arrow" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg>
          </div>
        </div>
        <details class="node-form-advanced">
          <summary>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align: -1px; margin-right: 4px;"><path d="M12 8v4M12 16h.01"></path><circle cx="12" cy="12" r="10"></circle></svg>
            <span>${window.I18n?.t('workflow.advancedSettings') || 'Advanced settings'}</span>
            <svg class="chevron-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg>
          </summary>
          <p class="advanced-hint">${window.I18n?.t('workflow.advancedHint') || 'These rarely need adjustment. Only change when facing errors/timeout.'}</p>
          <div class="form-group">
            <label for="chatgptImageMode">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align: -1px; margin-right: 4px;"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
              ${window.I18n?.t('workflow.chatgptMode') || 'Generation mode'}
            </label>
            <div class="input-group select-group compact-select">
              <select id="chatgptImageMode">
                <option value="auto" ${cgUseFallback === 'auto' ? 'selected' : ''}>${window.I18n?.t('workflow.chatgptModeAuto') || 'Auto (try image mode → fallback)'}</option>
                <option value="always" ${cgUseFallback === 'always' ? 'selected' : ''}>${window.I18n?.t('workflow.chatgptModeAlways') || 'Always use prefix'}</option>
                <option value="never" ${cgUseFallback === 'never' ? 'selected' : ''}>${window.I18n?.t('workflow.chatgptModeNever') || 'Never use prefix'}</option>
              </select>
              <svg class="select-arrow" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg>
            </div>
            <p class="form-field-hint">${window.I18n?.t('workflow.chatgptModeHint') || 'Auto: Try image mode (with ratio) → fallback prefix on fail. Always: Always use "Generate an image of:" prefix. Never: Force image mode (fail = error).'}</p>
          </div>
          <div class="form-group">
            <label for="chatgptImageTimeout">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align: -1px; margin-right: 4px;"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
              ${window.I18n?.t('workflow.chatgptTimeout') || 'Timeout (ms)'}
            </label>
            <div class="input-group">
              <input type="number" id="chatgptImageTimeout" min="30000" max="600000" step="10000" value="${cgTimeout}" />
            </div>
            <p class="form-field-hint">${window.I18n?.t('workflow.chatgptTimeoutHint') || 'Max wait time for ChatGPT to return image (default 120000ms = 2 min). Increase if TIMEOUT errors occur.'}</p>
          </div>
        </details>
        <div class="form-group">
          <div class="auto-download-row">
            <label class="toolbar-toggle${!window.featureGate?.canUse('auto_download') ? ' feature-disabled' : ''}" for="chatgptImageAutoDownload" ${!window.featureGate?.canUse('auto_download') ? `title="${window.I18n?.t('workflow.featureDisabled') || 'Tính năng này yêu cầu gói Premium'}"` : ''}>
              <input type="checkbox" id="chatgptImageAutoDownload" ${cgAutoDownload ? 'checked' : ''} ${!window.featureGate?.canUse('auto_download') ? 'disabled' : ''} />
              <span class="toggle-track"><span class="toggle-thumb"></span></span>
              <span class="toggle-label">${window.I18n?.t('workflow.autoDownload') || 'Tự động tải'}</span>
            </label>
            ${!window.featureGate?.canUse('auto_download') ? window.featureGate.renderCrownSpan('auto_download') : ''}
          </div>
        </div>
        ${enabledField}`;
    }

    // === GROK NODE (Phase G-6) ===
    if (nodeType === 'grok') {
      const grokPrompt = data.prompt || '';
      const grokRatio = data.ratio || 'widescreen';
      const grokMode = data.grok_mode || 'image';
      const grokDuration = data.grok_duration || '6s';
      const grokResolution = data.grok_resolution || '720p';
      // Image quality (Grok update 2026-04): 'speed' | 'quality'
      const grokImageQuality = data.grok_image_quality || 'speed';
      const grokTimeout = data.timeout_ms || 180000;
      const grokAutoDownload = !!data.auto_download;
      const canUseGrok = (window.featureGate?.canUse('grok_enabled') ?? false);

      // Bug 35 fix (2026-05-19): Đọc từ GrokAdapter.capabilities (PCM-backed getter).
      // Admin tweak ratios qua /admin/providers/grok/api-configs → SSE → adapter trả fresh.
      // Grok ratios: 2:3 / 3:2 / 1:1 / 9:16 / 16:9 (KHÔNG dùng 3:4/4:3 như ChatGPT).
      const _grokAdapter = window.ProviderRegistry?.get?.('grok');
      const _grokSupportedRatios = _grokAdapter?.capabilities?.supportedRatios
        || ['story', 'portrait', 'square', 'landscape', 'widescreen'];
      const _grokRatioUiMap = _grokAdapter?.capabilities?.ratioUiMap
        || { story: '9:16', portrait: '2:3', square: '1:1', landscape: '3:2', widescreen: '16:9' };
      const grokRatioOptions = _grokSupportedRatios.map(key => ({ key, label: _grokRatioUiMap[key] || key }));
      const grokRatioIcons = {
        story:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="3" width="6" height="18" rx="1.2"/></svg>',
        portrait:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="7" y="4" width="10" height="16" rx="1.2"/></svg>',
        square:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="5" width="14" height="14" rx="1.2"/></svg>',
        landscape:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="7" width="16" height="10" rx="1.2"/></svg>',
        widescreen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="9" width="18" height="6" rx="1.2"/></svg>'
      };
      const grokRatioPills = grokRatioOptions.map(opt => `
        <button type="button" class="ratio-pill grok-ratio-pill${opt.key === grokRatio ? ' active' : ''}" data-ratio="${opt.key}" title="${opt.label}">${grokRatioIcons[opt.key] || ''}<span>${opt.label}</span></button>
      `).join('');
      const grokLockIconSvg = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink:0;"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`;
      const grokPromptSourceHtml = this._renderPromptSourceRadio(data, nodeId);
      const grokBrandHeader = `
        <div class="node-brand-header node-brand-header--grok">
          <svg class="node-brand-logo" width="20" height="20" viewBox="0 0 24 24" fill="currentColor" fill-rule="evenodd"><path d="M9.27 15.29l7.978-5.897c.391-.29.95-.177 1.137.272.98 2.369.542 5.215-1.41 7.169-1.951 1.954-4.667 2.382-7.149 1.406l-2.711 1.257c3.889 2.661 8.611 2.003 11.562-.953 2.341-2.344 3.066-5.539 2.388-8.42l.006.007c-.983-4.232.242-5.924 2.75-9.383.06-.082.12-.164.179-.248l-3.301 3.305v-.01L9.267 15.292M7.623 16.723c-2.792-2.67-2.31-6.801.071-9.184 1.761-1.763 4.647-2.483 7.166-1.425l2.705-1.25a7.808 7.808 0 00-1.829-1A8.975 8.975 0 005.984 5.83c-2.533 2.536-3.33 6.436-1.962 9.764 1.022 2.487-.653 4.246-2.34 6.022-.599.63-1.199 1.259-1.682 1.925l7.62-6.815"/></svg>
          <span class="node-brand-name" data-provider="grok">${window.ProviderMeta?.getName?.('grok') || 'Grok'}</span>
          ${this._renderProviderLoginReminder('grok')}
        </div>`;

      return `${grokBrandHeader}${nameField}${slugField}
        ${grokPromptSourceHtml}
        ${!canUseGrok ? `
        <div class="form-group node-grok-gate" id="nodeGrokGate">
          <div style="padding:10px 12px;background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.3);border-radius:6px;display:flex;align-items:center;gap:8px;color:#f59e0b;font-size:12px;">
            ${grokLockIconSvg}
            <span>${window.I18n?.t('workflow.grokLockedHint') || 'Grok yêu cầu gói Pro. Node có thể chỉnh nhưng KHÔNG chạy được.'} <a href="#" class="node-grok-upgrade-link" style="color:#f59e0b;text-decoration:underline;">${window.I18n?.t('common.upgrade') || 'Upgrade'}</a></span>
          </div>
        </div>` : ''}
        <div class="form-group" id="grokNodePromptGroup">
          <label for="grokNodePrompt">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align: -1px; margin-right: 4px;"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
            ${window.I18n?.t('workflow.promptText') || 'Nội dung Prompt'}
          </label>
          <div class="prompt-mention-wrapper">
            <textarea id="grokNodePrompt" placeholder="${window.I18n?.t('workflow.grokNodePlaceholder') || 'VD: A futuristic robot with neon lights, cinematic'}">${this.escapeHtml(grokPrompt)}</textarea>
          </div>
          <details class="mention-mode-advanced">
            <summary>${window.I18n?.t('workflow.mentionModeAdvanced') || 'Mention Mode (Advanced)'}</summary>
            <div class="mention-mode-row">
              <div class="mention-mode-group">
                <label class="mention-mode-label">${window.I18n?.t('workflow.promptMode') || 'Prompt'}</label>
                <select id="grokPromptMode" class="mention-mode-select">
                  <option value="auto" selected>${window.I18n?.t('workflow.modeAuto') || 'Auto'}</option>
                  <option value="all">${window.I18n?.t('workflow.modeAll') || 'All'}</option>
                  <option value="mention">${window.I18n?.t('workflow.modeMention') || 'Mention'}</option>
                </select>
              </div>
              <div class="mention-mode-group">
                <label class="mention-mode-label">${window.I18n?.t('workflow.refMode') || 'Ref'}</label>
                <select id="grokRefMode" class="mention-mode-select">
                  <option value="auto" selected>${window.I18n?.t('workflow.modeAuto') || 'Auto'}</option>
                  <option value="all">${window.I18n?.t('workflow.modeAll') || 'All'}</option>
                  <option value="mention">${window.I18n?.t('workflow.modeMention') || 'Mention'}</option>
                </select>
              </div>
            </div>
          </details>
        </div>
        <div class="form-group">
          <label>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align: -1px; margin-right: 4px;"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>
            ${window.I18n?.t('workflow.grokMode') || 'Chế độ'}
          </label>
          <div class="node-form-mode-toggle" id="grokNodeModeToggle" role="tablist" aria-label="Grok mode">
            <button type="button" class="node-form-mode-btn${grokMode === 'image' ? ' active' : ''}" data-mode="image" data-tooltip="${window.I18n?.t('workflow.grokModeImage') || 'Tạo ảnh'}" aria-label="${window.I18n?.t('workflow.grokModeImage') || 'Image'}" role="tab">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
            </button>
            <button type="button" class="node-form-mode-btn${grokMode === 'video' ? ' active' : ''}" data-mode="video" data-tooltip="${window.I18n?.t('workflow.grokModeVideo') || 'Tạo video'}" aria-label="${window.I18n?.t('workflow.grokModeVideo') || 'Video'}" role="tab">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m22 8-6 4 6 4V8Z"/><rect x="2" y="6" width="14" height="12" rx="2" ry="2"/></svg>
            </button>
            <input type="hidden" id="grokNodeMode" value="${this.escapeAttr(grokMode)}" />
          </div>
        </div>
        <div class="form-group">
          <label>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align: -1px; margin-right: 4px;"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="9" y1="3" x2="9" y2="21"></line></svg>
            ${window.I18n?.t('workflow.grokRatio') || 'Tỷ lệ'}
          </label>
          <div class="ratio-pills-container" id="grokRatioPills">${grokRatioPills}</div>
          <input type="hidden" id="grokNodeRatio" value="${this.escapeAttr(grokRatio)}" />
        </div>
        <div class="grok-video-row" id="grokVideoOnlyRow" style="${grokMode === 'video' ? '' : 'display:none;'}">
          <div class="form-group grok-video-only" id="grokDurationGroup">
            <label for="grokNodeDuration">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align: -1px; margin-right: 4px;"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
              ${window.I18n?.t('workflow.grokDuration') || 'Thời lượng'}
            </label>
            <div class="input-group select-group compact-select">
              <select id="grokNodeDuration">
                <option value="6s" ${grokDuration === '6s' ? 'selected' : ''}>6s</option>
                <option value="10s" ${grokDuration === '10s' ? 'selected' : ''}>10s</option>
              </select>
              <svg class="select-arrow" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg>
            </div>
          </div>
          <div class="form-group grok-video-only" id="grokResolutionGroup">
            <label for="grokNodeResolution">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align: -1px; margin-right: 4px;"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
              ${window.I18n?.t('workflow.grokResolution') || 'Resolution'}
            </label>
            <div class="input-group select-group compact-select">
              <select id="grokNodeResolution">
                <option value="480p" ${grokResolution === '480p' ? 'selected' : ''}>480p</option>
                <option value="720p" ${grokResolution === '720p' ? 'selected' : ''}>720p</option>
              </select>
              <svg class="select-arrow" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg>
            </div>
          </div>
        </div>
        <!-- Grok image quality (Grok update 2026-04) — chỉ hiện khi mode=image -->
        <div class="grok-image-row" id="grokImageOnlyRow" style="${grokMode === 'image' ? '' : 'display:none;'}">
          <div class="form-group grok-image-only" id="grokImageQualityGroup">
            <label for="grokNodeImageQuality">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align: -1px; margin-right: 4px;"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
              ${window.I18n?.t('workflow.grokImageQuality') || 'Chất lượng ảnh'}
            </label>
            <div class="input-group select-group compact-select">
              <select id="grokNodeImageQuality">
                <option value="speed" ${grokImageQuality === 'speed' ? 'selected' : ''}>${window.I18n?.t('workflow.grokImageQualitySpeed') || 'Speed'}</option>
                <option value="quality" ${grokImageQuality === 'quality' ? 'selected' : ''}>${window.I18n?.t('workflow.grokImageQualityQuality') || 'Quality'}</option>
              </select>
              <svg class="select-arrow" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg>
            </div>
          </div>
        </div>
        ${(this.isTemplateMode || this.workflow?._is_template_preview || this.workflow?._isPreview)
          // EWT-9.1: Template mode/preview - hiển thị ref images từ URLs
          ? `<div class="form-group" id="grokNodeRefImagesGroup">
              ${this._renderRefImagesFieldForTemplate(data, 'grokNodeRefPreview', 'grokNodeRefImgUrls', 'grokNodePickBtn', 4)}
            </div>
            ${this._renderResultImageFieldForTemplate(data, 'grokNodeResultPreview', 'grokNodeResultImgUrl', 'grokNodeResultPickBtn')}`
          // Normal mode - chọn ảnh từ Flow
          : `<div class="form-group" id="grokNodeRefImagesGroup">
          <label>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align: -1px; margin-right: 4px;"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>
            ${window.I18n?.t('workflow.refImagesMax4') || 'Reference images (max 4)'}
          </label>
          <button class="node-ref-btn" id="grokNodePickBtn" type="button">
            <svg class="node-ref-btn__icon ref-btn-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15 8h.01"></path><path d="M12.5 21h-6.5a3 3 0 0 1 -3 -3v-12a3 3 0 0 1 3 -3h12a3 3 0 0 1 3 3v6.5"></path><path d="M3 16l5 -5c.928 -.893 2.072 -.893 3 0l3.5 3.5"></path><path d="M14 14l1 -1c.679 -.653 1.473 -.829 2.214 -.526"></path><path d="M19 22v-6"></path><path d="M22 19l-3 -3l-3 3"></path></svg>
            <span class="node-ref-btn__text">${window.I18n?.t('workflow.selectRefImages') || 'Select / Upload image'}</span>
          </button>
          <div class="ref-images-preview" id="grokNodeRefPreview"></div>
          <input type="hidden" id="grokNodeRefFileIds" value="${this.escapeAttr(data.ref_file_ids || '')}" />
        </div>`}
        <div class="form-group">
          <div class="auto-download-row">
            <label class="toolbar-toggle${!window.featureGate?.canUse('auto_download') ? ' feature-disabled' : ''}" for="grokNodeAutoDownload" ${!window.featureGate?.canUse('auto_download') ? `title="${window.I18n?.t('workflow.featureDisabled') || 'Tính năng này yêu cầu gói Premium'}"` : ''}>
              <input type="checkbox" id="grokNodeAutoDownload" ${grokAutoDownload ? 'checked' : ''} ${!window.featureGate?.canUse('auto_download') ? 'disabled' : ''} />
              <span class="toggle-track"><span class="toggle-thumb"></span></span>
              <span class="toggle-label">${window.I18n?.t('workflow.autoDownload') || 'Tự động tải'}</span>
            </label>
            ${!window.featureGate?.canUse('auto_download') ? window.featureGate.renderCrownSpan('auto_download') : ''}
          </div>
        </div>
        <details class="node-form-advanced">
          <summary>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align: -1px; margin-right: 4px;"><path d="M12 8v4M12 16h.01"></path><circle cx="12" cy="12" r="10"></circle></svg>
            <span>${window.I18n?.t('workflow.advancedSettings') || 'Advanced settings'}</span>
            <svg class="chevron-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg>
          </summary>
          <div class="form-group">
            <label for="grokNodeTimeout">${window.I18n?.t('workflow.timeoutMs') || 'Timeout (ms)'}</label>
            <input type="number" id="grokNodeTimeout" min="30000" max="600000" step="1000" value="${grokTimeout}" />
          </div>
        </details>
        ${enabledField}`;
    }

    // === GENERATE NODE (default) ===
    const connectedNodes = this._getConnectedSourceNodes(nodeId);
    const nodeOptions = connectedNodes.map(cn =>
      `<option value="${this.escapeAttr(cn.node_id)}">${this.escapeHtml(cn.node_name)}</option>`
    ).join('');
    const canUseGenerate = (window.featureGate?.canUse('gen_enabled') ?? false);
    const genLockIconSvg = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink:0;"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`;
    const genPromptSourceHtml = this._renderPromptSourceRadio(data, nodeId);
    const googleBrandHeader = `
      <div class="node-brand-header node-brand-header--google">
        <svg class="node-brand-logo" width="20" height="20" viewBox="0 0 24 24"><path d="M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z" fill="#3186FF"/><path d="M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z" fill="url(#node-flow-grad-0)"/><path d="M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z" fill="url(#node-flow-grad-1)"/><path d="M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z" fill="url(#node-flow-grad-2)"/><defs><linearGradient gradientUnits="userSpaceOnUse" id="node-flow-grad-0" x1="7" x2="11" y1="15.5" y2="12"><stop stop-color="#08B962"/><stop offset="1" stop-color="#08B962" stop-opacity="0"/></linearGradient><linearGradient gradientUnits="userSpaceOnUse" id="node-flow-grad-1" x1="8" x2="11.5" y1="5.5" y2="11"><stop stop-color="#F94543"/><stop offset="1" stop-color="#F94543" stop-opacity="0"/></linearGradient><linearGradient gradientUnits="userSpaceOnUse" id="node-flow-grad-2" x1="3.5" x2="17.5" y1="13.5" y2="12"><stop stop-color="#FABC12"/><stop offset=".46" stop-color="#FABC12" stop-opacity="0"/></linearGradient></defs></svg>
        <span class="node-brand-name" data-provider="flow">${window.ProviderMeta?.getName?.('flow') || 'Google Flow'}</span>
      </div>`;
    return `${googleBrandHeader}${nameField}${slugField}
      ${genPromptSourceHtml}
      ${!canUseGenerate ? `
      <div class="form-group node-generate-gate" id="nodeGenerateGate">
        <div style="padding:10px 12px;background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.3);border-radius:6px;display:flex;align-items:center;gap:8px;color:#f59e0b;font-size:12px;">
          ${genLockIconSvg}
          <span>${window.I18n?.t('workflow.generateLockedHint') || 'Google Flow yêu cầu gói phù hợp. Node có thể chỉnh nhưng KHÔNG chạy được.'} <a href="#" class="node-generate-upgrade-link" style="color:#f59e0b;text-decoration:underline;">${window.I18n?.t('common.upgrade') || 'Upgrade'}</a></span>
        </div>
      </div>` : ''}
      <div class="form-group" id="nodePromptGroup">
        <label for="nodePrompt">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align: -1px; margin-right: 4px;"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
          ${window.I18n?.t('workflow.prompt') || 'Prompt'}
        </label>
        <div class="prompt-mention-wrapper">
          <textarea id="nodePrompt">${this.escapeHtml(data.prompt || '')}</textarea>
        </div>
        <details class="mention-mode-advanced">
          <summary>${window.I18n?.t('workflow.mentionModeAdvanced') || 'Mention Mode (Advanced)'}</summary>
          <div class="mention-mode-row">
            <div class="mention-mode-group">
              <label class="mention-mode-label">${window.I18n?.t('workflow.promptMode') || 'Prompt'}</label>
              <select id="nodePromptMode" class="mention-mode-select">
                <option value="auto" selected>${window.I18n?.t('workflow.modeAuto') || 'Auto'}</option>
                <option value="all">${window.I18n?.t('workflow.modeAll') || 'All'}</option>
                <option value="mention">${window.I18n?.t('workflow.modeMention') || 'Mention'}</option>
              </select>
            </div>
            <div class="mention-mode-group">
              <label class="mention-mode-label">${window.I18n?.t('workflow.refMode') || 'Ref'}</label>
              <select id="nodeRefMode" class="mention-mode-select">
                <option value="auto" selected>${window.I18n?.t('workflow.modeAuto') || 'Auto'}</option>
                <option value="all">${window.I18n?.t('workflow.modeAll') || 'All'}</option>
                <option value="mention">${window.I18n?.t('workflow.modeMention') || 'Mention'}</option>
              </select>
            </div>
          </div>
        </details>
      </div>
      <div class="section-header" style="margin-top: 4px; margin-bottom: 4px;"><label><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align: -1px; margin-right: 4px;"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>${window.I18n?.t('settings.title') || 'Cài đặt'}</label></div>
      <div class="form-group">
        <div class="node-form-mode-toggle" id="nodeMediaTypeToggle" role="tablist" aria-label="${window.I18n?.t('workflow.modeLabel') || 'Chế độ'}">
          <button type="button" class="node-form-mode-btn${(data.media_type || 'Image') === 'Image' ? ' active' : ''}" data-mode="Image" data-tooltip="${window.I18n?.t('workflow.genTypeImage') || 'Image'}" aria-label="${window.I18n?.t('workflow.genTypeImage') || 'Image'}" role="tab">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
          </button>
          <button type="button" class="node-form-mode-btn${data.media_type === 'Video' ? ' active' : ''}" data-mode="Video" data-tooltip="${window.I18n?.t('workflow.genTypeVideo') || 'Video'}" aria-label="${window.I18n?.t('workflow.genTypeVideo') || 'Video'}" role="tab">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m22 8-6 4 6 4V8Z"/><rect x="2" y="6" width="14" height="12" rx="2" ry="2"/></svg>
          </button>
          <input type="hidden" id="nodeMediaType" value="${this.escapeAttr(data.media_type || 'Image')}" />
        </div>
      </div>
      <div class="gen-compact-bar" id="nodeGenCompactBar" data-gen-mode="${data.media_type === 'Video' ? 'video' : 'image'}">
        <div class="gen-compact-item" id="nodeImageModelGroup">
          <div class="input-group select-group compact-select">
            <select id="nodeModel">
              ${(window.ModelRegistry?.safeGetModelsSync('flow', 'image') || []).map(m => `<option value="${this.escapeAttr(m.value)}" ${data.model === m.value ? 'selected' : ''}>${this.escapeHtml(m.name)}</option>`).join('')}
            </select>
            <svg class="select-arrow" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg>
          </div>
        </div>
        <div class="gen-compact-item hidden" id="nodeVideoModelGroup">
          <div class="input-group select-group compact-select">
            <select id="nodeVideoModel">
              ${(window.ModelRegistry?.safeGetModelsSync('flow', 'video') || []).map(m => `<option value="${this.escapeAttr(m.value)}" ${data.model === m.value ? 'selected' : ''}>${this.escapeHtml(m.name.replace(/^Veo 3\.1 - /, 'Veo 3.1 '))}</option>`).join('')}
            </select>
            <svg class="select-arrow" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg>
          </div>
        </div>
        <!-- Flow Voice Selector — đặt NGAY BÊN PHẢI video model select để user dễ thấy
             (KHÔNG nằm sau wrap-break, không xuống dòng dưới như duration/ratio). -->
        <div class="gen-compact-item hidden" id="nodeVoicePickerGroup">
          <button type="button" class="voice-picker-trigger" id="nodeVoiceTrigger" data-i18n-title="voice.pickerTitle" title="Choose voice">
            <span class="voice-picker-trigger-thumb-svg" id="nodeVoiceTriggerThumb">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path>
                <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
                <line x1="12" y1="19" x2="12" y2="23"></line>
                <line x1="8" y1="23" x2="16" y2="23"></line>
              </svg>
            </span>
            <span class="voice-picker-label" id="nodeVoiceLabel" data-i18n="voice.random">Random voice</span>
            <svg class="voice-picker-arrow" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg>
          </button>
          <input type="hidden" id="nodeVoiceSlug" value="${this.escapeAttr(data.voice_slug || '')}" />
          <input type="hidden" id="nodeVoiceSearchValue" value="${this.escapeAttr(data.voice_search_value || '')}" />
        </div>
        <!-- Wrap break — active khi data-gen-mode="video": tất cả setting SAU Model+Voice xuống dòng. -->
        <div class="gen-compact-break gen-compact-break--video" aria-hidden="true"></div>
        <div class="gen-compact-item hidden" id="nodeVideoInputTypeGroup">
          <div class="input-group select-group compact-select">
            ${(() => {
              // 2026-05-31 fix: bug user switch Image→Video → UI hiển thị 'Frames' dù user setting
              // defaultVideoInputType='Ingredients'. Trước fix: nếu data.video_input_type empty →
              // không có selected attribute → browser pick first option 'Frames'.
              // Sau fix: compute effectiveVideoInputType từ data → settings default → 'Frames'.
              // Model không support Frames → force 'Ingredients' (unchanged).
              const supportsFrames = window.ProviderRegistry?.get?.('flow')?.supportsFrames?.(data.model) !== false;
              let effective = data.video_input_type || '';
              if (!effective) {
                if (!supportsFrames) {
                  effective = 'Ingredients';
                } else {
                  const settingDefault = window.storageSettings?.get?.('defaultVideoInputType');
                  effective = (settingDefault === 'Ingredients' || settingDefault === 'Frames')
                    ? settingDefault : 'Frames';
                }
              }
              return `
            <select id="nodeVideoInputType" data-effective-default="${this.escapeAttr(effective)}">
              ${supportsFrames ? `<option value="Frames" ${effective === 'Frames' ? 'selected' : ''}>Frames</option>` : ''}
              <option value="Ingredients" ${effective === 'Ingredients' ? 'selected' : ''}>Ingredients</option>
            </select>`;
            })()}
            <svg class="select-arrow" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg>
          </div>
        </div>
        <div class="gen-compact-item hidden" id="nodeVideoDurationGroup">
          <div class="input-group select-group compact-select">
            <select id="nodeVideoDuration" title="${window.I18n?.t('workflow.videoDuration') || 'Thời lượng video'}">
              ${(() => {
                const currentModel = data.model || '';
                let tier = 'default';
                try {
                  const models = window.ModelRegistry?.safeGetModelsSync?.('flow', 'video') || [];
                  const modelObj = models.find(m => m.value === currentModel || m.name === currentModel);
                  if (modelObj?.config?.duration_tier) tier = modelObj.config.duration_tier;
                } catch (_) {}
                const durations = window.ProviderConfigManager?.safeGetVideoDurationsSync?.('flow', tier) || ['4s', '6s', '8s'];
                const currentDuration = data.video_duration || '6s';
                return durations.map(d => `<option value="${d}" ${currentDuration === d ? 'selected' : ''}>${d}</option>`).join('');
              })()}
            </select>
            <svg class="select-arrow" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg>
          </div>
        </div>
        <div class="gen-compact-item">
          <div class="input-group select-group compact-select">
            <select id="nodeRatio">
              ${(() => {
                // Bug 40 fix (2026-05-19): Source from PCM (admin tweak realtime via SSE).
                // Flow generate ratios — Image: 5 ratios, Video: 2 ratios (Google constraint).
                const _genIsVideo = data.media_type === 'Video';
                const _genRatios = (window.ProviderConfigManager?.safeGetRatiosSync?.('flow', _genIsVideo ? 'video' : 'image'))
                  || (_genIsVideo ? ['16:9', '9:16'] : ['16:9', '4:3', '1:1', '3:4', '9:16']);
                const _genRatioIcon = (v) => {
                  const s = String(v || '').trim();
                  if (s === '16:9') return '▬';
                  if (s === '4:3' || s === '3:2') return '▭';
                  if (s === '1:1') return '□';
                  if (s === '3:4' || s === '2:3') return '▯';
                  if (s === '9:16') return '▮';
                  return '◇';
                };
                // Legacy VN labels backward-compat: 'Ngang'→16:9, 'Dọc'→9:16
                const _genCurrentRatio = data.ratio === 'Ngang' ? '16:9'
                  : data.ratio === 'Dọc' ? '9:16'
                  : (data.ratio || '16:9');
                return _genRatios.map(r => {
                  const v = typeof r === 'string' ? r : r.value;
                  return `<option value="${v}" ${_genCurrentRatio === v ? 'selected' : ''}>${_genRatioIcon(v)} ${v}</option>`;
                }).join('');
              })()}
            </select>
            <svg class="select-arrow" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg>
          </div>
        </div>
        <div class="gen-compact-item">
          <div class="input-group compact-qty">
            <button class="compact-qty-btn" id="nodeQtyMinus" type="button">-</button>
            <input type="number" id="nodeQuantity" min="${window.ProviderConfigManager?.safeGetQuantityRangeSync?.('flow')?.min ?? 1}" max="${window.ProviderConfigManager?.safeGetQuantityRangeSync?.('flow')?.max ?? 4}" value="${data.quantity || 1}" />
            <button class="compact-qty-btn" id="nodeQtyPlus" type="button">+</button>
          </div>
        </div>
      </div>
      ${this.isTemplateMode
        ? this._renderRefImagesFieldForTemplate(data, 'generateNodeRefPreview', 'generateNodeRefImgUrls', 'generateNodePickBtn', 10)
        : `<div class="form-group" id="nodeRefImagesGroup">
        <label>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align: -1px; margin-right: 4px;"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>
          ${window.I18n?.t('workflow.refImages') || 'Reference images'}
        </label>
        <button class="node-ref-btn" id="nodeOpenImagePickerBtn">
          <svg class="node-ref-btn__icon ref-btn-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15 8h.01"></path><path d="M12.5 21h-6.5a3 3 0 0 1 -3 -3v-12a3 3 0 0 1 3 -3h12a3 3 0 0 1 3 3v6.5"></path><path d="M3 16l5 -5c.928 -.893 2.072 -.893 3 0l3.5 3.5"></path><path d="M14 14l1 -1c.679 -.653 1.473 -.829 2.214 -.526"></path><path d="M19 22v-6"></path><path d="M22 19l-3 -3l-3 3"></path></svg>
          <span class="node-ref-btn__text">${window.I18n?.t('workflow.selectRefImages') || 'Select / Upload image'}</span>
        </button>
        <div class="ref-images-preview" id="nodeRefImagesPreview"></div>
        <input type="hidden" id="nodeRefFileIds" value="${this.escapeAttr(data.ref_file_ids || '')}" />
      </div>`}
      <div class="form-group hidden" id="nodeFrameConfigGroup">
        <div class="frame-config">
          <div class="frame-slot" id="nodeFrame1Slot">
            <div class="frame-slot-header">
              <svg class="frame-slot-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
              <span class="frame-slot-label">Start</span>
            </div>
            <div class="frame-slot-body">
              <select id="frame1Source" class="frame-source-select">
                <option value="">-- ${window.I18n?.t('workflow.selectSource') || 'Chọn nguồn'} --</option><option value="manual">${window.I18n?.t('workflow.selectManual') || 'Chọn ảnh thủ công'}</option>${nodeOptions}
              </select>
              <div class="frame-manual hidden" id="frame1Manual">
                <div class="frame-slot-body-inner" id="frame1Body">
                  <div class="frame-dropzone" id="frame1PickBtn">
                    <svg class="frame-dropzone-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"></rect><line x1="12" y1="8" x2="12" y2="16"></line><line x1="8" y1="12" x2="16" y2="12"></line></svg>
                    <span class="frame-dropzone-text">${window.I18n?.t('gen.addFrame') || 'Add'}</span>
                  </div>
                </div>
                <input type="hidden" id="frame1FileId" value="${this.escapeAttr(data.frame_1_file_id || '')}" />
              </div>
              <div class="frame-node-info hidden" id="frame1NodeInfo"><span class="frame-node-badge">${window.I18n?.t('workflow.useOutputFromNode') || 'Sử dụng output từ node đã chọn'}</span></div>
            </div>
          </div>
          <div class="frame-slot" id="nodeFrame2Slot">
            <div class="frame-slot-header">
              <svg class="frame-slot-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"></rect></svg>
              <span class="frame-slot-label">End</span>
            </div>
            <div class="frame-slot-body">
              <select id="frame2Source" class="frame-source-select">
                <option value="">-- ${window.I18n?.t('workflow.selectSource') || 'Chọn nguồn'} --</option><option value="manual">${window.I18n?.t('workflow.selectManual') || 'Chọn ảnh thủ công'}</option>${nodeOptions}
              </select>
              <div class="frame-manual hidden" id="frame2Manual">
                <div class="frame-slot-body-inner" id="frame2Body">
                  <div class="frame-dropzone" id="frame2PickBtn">
                    <svg class="frame-dropzone-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"></rect><line x1="12" y1="8" x2="12" y2="16"></line><line x1="8" y1="12" x2="16" y2="12"></line></svg>
                    <span class="frame-dropzone-text">${window.I18n?.t('gen.addFrame') || 'Add'}</span>
                  </div>
                </div>
                <input type="hidden" id="frame2FileId" value="${this.escapeAttr(data.frame_2_file_id || '')}" />
              </div>
              <div class="frame-node-info hidden" id="frame2NodeInfo"><span class="frame-node-badge">${window.I18n?.t('workflow.useOutputFromNode') || 'Sử dụng output từ node đã chọn'}</span></div>
            </div>
          </div>
        </div>
      </div>
      ${enabledField}
      <div class="form-group">
        <div class="auto-download-row">
          <label class="toolbar-toggle${!window.featureGate?.canUse('auto_download') ? ' feature-disabled' : ''}" for="nodeAutoDownload" ${!window.featureGate?.canUse('auto_download') ? `title="${window.I18n?.t('workflow.featureDisabled') || 'Tính năng này yêu cầu gói Premium'}"` : ''}>
            <input type="checkbox" id="nodeAutoDownload" ${data.auto_download ? 'checked' : ''} ${!window.featureGate?.canUse('auto_download') ? 'disabled' : ''} />
            <span class="toggle-track"><span class="toggle-thumb"></span></span>
            <span class="toggle-label">${window.I18n?.t('workflow.autoDownload') || 'Tự động tải'}</span>
          </label>
          ${!window.featureGate?.canUse('auto_download') ? window.featureGate.renderCrownSpan('auto_download') : ''}
          <span class="dl-res-select-wrap${!data.auto_download || data.media_type === 'Video' ? ' hidden' : ''}" id="nodeDownloadResWrap">
            <svg class="dl-res-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>
            <select id="nodeDownloadResolution" class="pill-select pill-select-sm" title="${window.I18n?.t('workflow.downloadResolution') || 'Chất lượng ảnh'}">
              ${(window.ProviderConfigManager?.getDownloadResolutionsSync('flow', 'image') || [
                { value: '1k', label: '1K' },
                { value: '2k', label: '2K (Pro)' },
                { value: '4k', label: '4K (Ultra)' },
              ]).map(r => `<option value="${r.value}"${data.download_resolution === r.value ? ' selected' : ''}>${r.label || r.menu_label || r.value}</option>`).join('')}
            </select>
          </span>
          <span class="dl-res-select-wrap${!data.auto_download || data.media_type !== 'Video' ? ' hidden' : ''}" id="nodeVideoDownloadResWrap">
            <svg class="dl-res-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="23 7 16 12 23 17 23 7"></polygon><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect></svg>
            <select id="nodeVideoDownloadResolution" class="pill-select pill-select-sm" title="${window.I18n?.t('workflow.videoDownloadResolution') || 'Chất lượng video'}">
              ${(window.ProviderConfigManager?.getDownloadResolutionsSync('flow', 'video') || [
                { value: '720p', label: '720p' },
                { value: '1080p', label: '1080p' },
                { value: '4k', label: '4K (Ultra)' },
              ]).map(r => `<option value="${r.value}"${data.video_download_resolution === r.value ? ' selected' : ''}>${r.label || r.menu_label || r.value}</option>`).join('')}
            </select>
          </span>
        </div>
      </div>
      ${this.isTemplateMode ? this._renderResultImageFieldForTemplate(data, 'generateResultPreview', 'generateResultImgUrl', 'generateResultPickBtn') : ''}`;
  }

  /**
   * Map ratio string (đa định dạng cross-provider) → CSS class cho aspect-ratio.
   * Hỗ trợ:
   *   - Flow VN: 'Dọc', 'Ngang', 'Vuông'
   *   - Numeric: '9:16', '3:4', '1:1', '4:3', '16:9', '2:3', '3:2'
   *   - ChatGPT/Grok keys: 'story', 'portrait', 'square', 'landscape', 'widescreen'
   * Fallback: 'ratio-1-1' (square — an toàn nếu ratio undefined).
   */
  _resolveRatioClass(ratio) {
    const r = String(ratio || '').trim().toLowerCase();
    if (r === '9:16' || r === 'dọc' || r === 'doc' || r === 'story') return 'ratio-9-16';
    if (r === '3:4' || r === 'portrait') return 'ratio-3-4';
    if (r === '2:3') return 'ratio-2-3';
    if (r === '1:1' || r === 'vuông' || r === 'vuong' || r === 'square') return 'ratio-1-1';
    if (r === '4:3' || r === 'landscape') return 'ratio-4-3';
    if (r === '3:2') return 'ratio-3-2';
    if (r === '16:9' || r === 'ngang' || r === 'widescreen') return 'ratio-16-9';
    return 'ratio-1-1';
  }

  /**
   * Render tab "Hướng dẫn" cho node (2026-05-30) — guide trực quan per-node-type.
   * Cover: generate / chatgpt / grok / prompt / text_extract.
   * Đặc biệt nhấn mạnh: mention mode (@slug) + Text Extract prompt template.
   */
  _renderNodeHelpTab(nodeType) {
    // SVG icon helpers — KHÔNG dùng emoji
    const icoPin = '<svg class="help-ico" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"/></svg>';
    const icoPalette = '<svg class="help-ico" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.555C21.965 6.012 17.461 2 12 2z"/></svg>';
    const icoChat = '<svg class="help-ico" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
    const icoSpark = '<svg class="help-ico" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/></svg>';
    const icoPencil = '<svg class="help-ico" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>';
    const icoFilm = '<svg class="help-ico" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"/><line x1="7" y1="2" x2="7" y2="22"/><line x1="17" y1="2" x2="17" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="2" y1="7" x2="7" y2="7"/><line x1="2" y1="17" x2="7" y2="17"/><line x1="17" y1="17" x2="22" y2="17"/><line x1="17" y1="7" x2="22" y2="7"/></svg>';
    const icoScissors = '<svg class="help-ico" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="20" y1="4" x2="8.12" y2="15.88"/><line x1="14.47" y1="14.48" x2="20" y2="20"/><line x1="8.12" y1="8.12" x2="12" y2="12"/></svg>';
    const icoList = '<svg class="help-ico" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>';
    const icoCog = '<svg class="help-ico" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';
    const icoLamp = '<svg class="help-ico" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/></svg>';
    const icoLink = '<svg class="help-ico" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>';
    const icoWarn = '<svg class="help-ico" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--warning,#f59e0b)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';

    // Common section: @mention guide (apply cho generate/chatgpt/grok/prompt)
    const mentionGuide = `
      <div class="help-section">
        <h4>${icoPin}<span>@mention (tham chiếu node khác)</span></h4>
        <p>Dùng <code>@slug_node</code> trong prompt để chèn output của node khác. Mention CHỈ hoạt động khi node đó đã được nối dây edge (gốc → node hiện tại).</p>
        <p><strong>Prompt mode — 3 lựa chọn:</strong></p>
        <ul>
          <li><strong><code>auto</code></strong> (mặc định): Tự detect khi save — nếu prompt CÓ <code>@xxx</code> → behave như <code>mention</code>, nếu không có → behave như <code>all</code>.</li>
          <li><strong><code>all</code></strong>: GIỮ NGUYÊN prompt, KHÔNG substitute <code>@slug</code> (LLM thấy literal text "@chu_de"). Vẫn concat text từ upstream port "text" nếu có nối dây.</li>
          <li><strong><code>mention</code></strong>: SUBSTITUTE <code>@text_slug</code> / <code>@prompt_slug</code> bằng nội dung node tương ứng trước khi gửi LLM. Đồng thời strip <code>@image_*</code> / <code>@gen_*</code> literal (ảnh xử lý qua ref_mode).</li>
        </ul>
        <p><strong>Ref mode — 3 lựa chọn (ảnh tham chiếu):</strong></p>
        <ul>
          <li><strong><code>auto</code></strong>: Tự detect khi save (đồng bộ với prompt_mode auto detect).</li>
          <li><strong><code>all</code></strong>: Dùng TẤT CẢ ref images từ upstream + node hiện tại.</li>
          <li><strong><code>mention</code></strong>: CHỈ dùng ref images của nodes được <code>@mention</code> trong prompt.</li>
        </ul>
        <p><strong>Ví dụ — <code>auto</code> + có mention:</strong></p>
        <pre>Text node "chu_de" = "ChatGPT"
Prompt: "Hãy phân tích @chu_de và đề xuất 3 use case"
→ Submit LLM: "Hãy phân tích ChatGPT và đề xuất 3 use case"</pre>
        <p>${icoWarn}<em>Chỉ work nếu Text node có <strong>nối edge</strong> tới node hiện tại. Mention KHÔNG tự tìm node trong workflow nếu chưa nối dây.</em></p>
      </div>
    `;

    let body = '';
    if (nodeType === 'generate') {
      body = `
        <div class="help-section">
          <h4>${icoPalette}<span>Flow - Generate (ảnh/video)</span></h4>
          <p>Submit prompt đến Google Flow, gen ảnh hoặc video qua tab labs.google/fx/tools/flow.</p>
          <ol>
            <li><strong>Media Type</strong>: Image / Video.</li>
            <li><strong>Model</strong>: Image (Nano Banana Pro/2) hoặc Video (Veo 3.1 Fast/Lite/Quality, Omni Flash). Mỗi model có config riêng (duration_tier, max_ref_images, supports_voice).</li>
            <li><strong>Voice</strong> (chỉ video models có audio: Veo 3.1, Omni Flash): chọn giọng đọc cho video — picker ngay bên phải video model select. Click → modal full-screen + search + custom voice.</li>
            <li><strong>Ratio</strong>: Image 5 ratios (16:9, 4:3, 1:1, 3:4, 9:16). Video 2 ratios (16:9, 9:16 — Google constraint).</li>
            <li><strong>Duration</strong> (video): 4s/6s/8s (Veo) hoặc 4s/6s/8s/10s (Omni Flash). Một số combo bị ép cố định (vd Veo Lite + Ingredients + ref → bắt buộc 8s).</li>
            <li><strong>Prompt</strong>: nhập text mô tả. Có thể dùng <code>@mention</code> để chèn output node khác.</li>
            <li><strong>Video Input Type</strong> (video): <code>Frames</code> (cần frame_1 + frame_2 ảnh đầu/cuối nối qua port) hoặc <code>Ingredients</code> (dùng ref_images bag).</li>
            <li><strong>Ref images</strong>: cap theo model — Nano Banana 7-10, Veo 3-5, Omni 7. Vượt cap → strip + báo warning.</li>
            <li><strong>Quantity</strong>: số ảnh gen mỗi lần 1-4 (Image only). Video luôn = 1.</li>
            <li><strong>Auto-download</strong>: tự tải kết quả về máy (yêu cầu feature gate <code>auto_download</code>).</li>
          </ol>
          <p>${icoWarn}<em>Veo 3.1 Quality + Ingredients</em>: model KHÔNG support ref images → ref bị strip automatic + banner warn trong picker.</p>
        </div>
        ${mentionGuide}
        <div class="help-section">
          <h4>${icoLink}<span>Kết hợp với Text Extract</span></h4>
          <p>Nếu prompt từ <strong>Prompt enhance node</strong> trả về nhiều prompts, dùng <strong>Text Extract</strong> trung gian để tách từng prompt → mỗi Generate node nhận 1 prompt riêng. Tiết kiệm AI call (1 enhance thay vì N).</p>
        </div>
      `;
    } else if (nodeType === 'chatgpt') {
      body = `
        <div class="help-section">
          <h4>${icoChat}<span>ChatGPT - Image Generate</span></h4>
          <p>Submit prompt đến ChatGPT (tab chatgpt.com), dùng image generation tool built-in (DALL-E / GPT image).</p>
          <ol>
            <li><strong>Model</strong>: <code>Instant</code> (GPT-5.5 nhanh, default) hoặc <code>Thinking</code> (suy luận sâu, chậm hơn, chất lượng cao).</li>
            <li><strong>Ratio</strong>: <code>story</code> (9:16) / <code>portrait</code> (3:4) / <code>square</code> (1:1) / <code>landscape</code> (4:3) / <code>widescreen</code> (16:9).</li>
            <li><strong>Prompt</strong>: tiếng Việt hoặc Anh đều OK. Có thể dùng <code>@mention</code> tham chiếu upstream nodes.</li>
            <li><strong>Ref images</strong>: nối từ Image node hoặc paste — ChatGPT analyze + gen variant (cap 10 ảnh per turn).</li>
            <li><strong>Use fallback prefix</strong>: <code>auto</code> (default — prepend "create image:" khi cần) / <code>always</code> / <code>never</code>.</li>
            <li><strong>Auto-close tab</strong>: cấu hình qua <code>/admin/default-settings</code> — tự đóng tab ChatGPT sau khi gen xong.</li>
          </ol>
          <p>${icoWarn}<em>Yêu cầu</em>: tab ChatGPT đang mở + đã login. Nếu chưa login → workflow pause + hiện modal "Cần login ChatGPT".</p>
          <p>${icoWarn}<em>Quota</em>: trừ cả <code>chatgpt_run_max</code> + <code>workflows_run_max</code>. Free plan giới hạn vài lần/ngày.</p>
        </div>
        ${mentionGuide}
      `;
    } else if (nodeType === 'grok') {
      body = `
        <div class="help-section">
          <h4>${icoSpark}<span>Grok - Image/Video Generate</span></h4>
          <p>Submit prompt đến Grok Imagine (grok.com/imagine), gen ảnh/video bằng Aurora model.</p>
          <ol>
            <li><strong>Mode</strong>: <code>Image</code> (Aurora image gen) hoặc <code>Video</code> (yêu cầu Grok Premium subscription).</li>
            <li><strong>Ratio</strong>: 5 ratios (story 9:16 / portrait 2:3 / square 1:1 / landscape 3:2 / widescreen 16:9).</li>
            <li><strong>Duration</strong> (video only): <code>6s</code> / <code>10s</code>.</li>
            <li><strong>Resolution</strong> (video only): <code>480p</code> / <code>720p</code>.</li>
            <li><strong>Image quality</strong> (image only): <code>Speed</code> (vài giây) / <code>Quality</code> (chậm hơn, kết quả tốt hơn).</li>
            <li><strong>Ref images</strong>: cap 5 ảnh — Grok dùng làm context (cả Image + Video).</li>
            <li><strong>Auto-close tab</strong>: tự đóng tab Grok sau khi gen (config /admin/default-settings).</li>
          </ol>
          <p>${icoWarn}<em>Yêu cầu video mode</em>: <strong>Grok Premium</strong> ($30/tháng). Nếu không có → modal "Premium required" hiển thị.</p>
          <p>${icoWarn}<em>Age verification</em>: Grok hỏi tuổi cho user mới — extension auto chọn 1990. Phải > 18 mới truy cập Imagine.</p>
          <p>${icoWarn}<em>Cloudflare challenge</em>: thỉnh thoảng Grok hiện Turnstile verification — user cần click thủ công, extension chờ xong tự tiếp tục.</p>
        </div>
        ${mentionGuide}
      `;
    } else if (nodeType === 'prompt') {
      // AI Agent rename + i18n (2026-05-30) — helper trả về HTML localized theo locale user.
      // Default fallback: VI. Locales en/ja/th có version translation riêng.
      body = this._getPromptHelpHtml({ icoPencil, icoSpark, icoWarn, icoFilm, mentionGuide });
    } else if (nodeType === 'text_extract') {
      body = `
        <div class="help-section">
          <h4>${icoScissors}<span>Text Extract Node</span></h4>
          <p>Tách 1 phần text từ upstream output theo marker / JSON key / regex.</p>
          <p><strong>KHÔNG call AI</strong> — pure regex/JSON parse, instant.</p>
        </div>

        <div class="help-section">
          <h4>${icoList}<span>3 chế độ</span></h4>
          <p><strong>1. Marker mode (recommend)</strong>: match <code>[name]: value</code>.</p>
          <pre>Upstream: "[image_prompt_1]: A red apple
[image_prompt_2]: A blue sky"

marker = image_prompt_1
→ Output: "A red apple"</pre>

          <p><strong>2. JSON mode</strong>: parse JSON + lookup key.</p>
          <pre>Upstream: {"img1": "red apple", "img2": "blue sky"}

marker = img1
→ Output: "red apple"</pre>

          <p><strong>3. Regex mode</strong>: custom pattern, group 1 = output.</p>
        </div>

        <div class="help-section">
          <h4>${icoCog}<span>Config quan trọng</span></h4>
          <ul>
            <li><strong>Strict mode</strong>: ON = exact match. OFF (default) = case-insensitive + tolerant whitespace/dash.</li>
            <li><strong>Multi-match</strong>: nếu marker xuất hiện 2+ lần — chọn First / Last / Concat / Error.</li>
            <li><strong>On fail</strong>:
              <ul>
                <li><code>skip_downstream</code> (default): nodes phía sau bị bỏ qua, workflow vẫn chạy tiếp.</li>
                <li><code>empty</code>: pass text rỗng — downstream tự fail nếu cần text.</li>
                <li><code>fail_workflow</code>: fail toàn workflow ngay.</li>
              </ul>
            </li>
          </ul>
        </div>

        <div class="help-section">
          <h4>${icoFilm}<span>Cách prompt Prompt node TRƯỚC để output đúng format</span></h4>
          <p><strong>Mẫu Prompt enhance khuyên dùng:</strong></p>
          <pre>Hãy research chủ đề @text_slug và tạo:
- 5 prompt tạo ảnh storyboard nội dung nối tiếp
- 5 prompt tạo video từ ảnh storyboard

QUAN TRỌNG — FORMAT CHÍNH XÁC:
[image_prompt_1]: &lt;nội dung ảnh 1&gt;
[image_prompt_2]: &lt;nội dung ảnh 2&gt;
[image_prompt_3]: &lt;nội dung ảnh 3&gt;
[image_prompt_4]: &lt;nội dung ảnh 4&gt;
[image_prompt_5]: &lt;nội dung ảnh 5&gt;
[video_prompt_1]: &lt;video từ ảnh 1&gt;
[video_prompt_2]: &lt;video từ ảnh 2&gt;
...
[video_prompt_5]: &lt;video từ ảnh 5&gt;

QUY TẮC:
- Mỗi prompt 1 đoạn, KHÔNG dùng markdown ** hoặc backtick.
- KHÔNG ghi gì ngoài 10 dòng trên.
- Ảnh storyboard có ghi rõ "Frame N" trên ảnh.</pre>
          <p>Sau đó tạo 10 node Text Extract: marker = <code>image_prompt_1</code>, <code>image_prompt_2</code>, ..., <code>video_prompt_5</code>.</p>
        </div>

        <div class="help-section">
          <h4>${icoLamp}<span>Tips</span></h4>
          <ul>
            <li>Để AI luôn output format đúng → instruct rõ "FORMAT CHÍNH XÁC" + "KHÔNG dùng markdown".</li>
            <li>Nếu Text Extract fail → mở tab <strong>Kết quả</strong> upstream để xem text raw → điều chỉnh prompt template.</li>
            <li>Test marker bằng regex tester online (vd regex101) trước khi save workflow lớn.</li>
          </ul>
        </div>
      `;
    }
    return `<div class="node-help-content" style="padding: 12px 14px; font-size: 13px; line-height: 1.5; color: var(--foreground);">
      <style>
        .node-help-content h4 { font-size: 13px; font-weight: 600; margin: 8px 0 6px 0; color: var(--foreground); display: flex; align-items: center; gap: 6px; }
        .node-help-content h4 .help-ico { flex-shrink: 0; color: var(--primary, #cdff01); }
        .node-help-content .help-section { margin-bottom: 14px; padding-bottom: 10px; border-bottom: 1px solid var(--border, #1e3050); }
        .node-help-content .help-section:last-child { border-bottom: none; }
        .node-help-content p { margin: 4px 0; color: var(--muted-foreground, #999); }
        .node-help-content p .help-ico { vertical-align: -2px; margin-right: 4px; }
        .node-help-content ul, .node-help-content ol { margin: 4px 0 6px 18px; padding: 0; color: var(--muted-foreground, #999); }
        .node-help-content li { margin: 3px 0; }
        .node-help-content code { background: var(--surface, #1e1e1e); padding: 1px 5px; border-radius: 3px; font-size: 11px; color: var(--primary, #cdff01); font-family: monospace; }
        .node-help-content pre { background: var(--surface, #1e1e1e); padding: 8px; border-radius: 4px; font-size: 11px; line-height: 1.5; overflow-x: auto; color: var(--foreground); white-space: pre-wrap; word-wrap: break-word; margin: 6px 0; }
        .node-help-content strong { color: var(--foreground); }
        .node-help-content em { color: var(--muted-foreground, #999); }
      </style>
      ${body}
    </div>`;
  }

  /**
   * Render tab "Kết quả" cho node
   */
  _renderNodeResultTab(data) {
    const status = data.status || 'pending';
    const fileIds = (data.result_file_ids || '').split(',').map(s => s.trim()).filter(Boolean);
    const errorMsg = data.error_message || '';

    const statusLabels = {
      pending: window.I18n?.t('workflow.statusPending') || 'Pending',
      running: window.I18n?.t('workflow.statusRunning') || 'Running',
      completed: window.I18n?.t('workflow.statusCompleted') || 'Completed',
      failed: window.I18n?.t('workflow.statusFailed') || 'Failed',
      skipped: window.I18n?.t('workflow.statusSkipped') || 'Skipped'
    };
    const statusColors = {
      pending: 'var(--muted-foreground)',
      running: 'var(--warning)',
      completed: 'var(--success)',
      failed: 'var(--destructive)',
      skipped: 'var(--muted-foreground)'
    };

    let html = `
      <div class="form-group">
        <label>${window.I18n?.t('workflow.status') || 'Trạng thái'}</label>
        <div style="display: flex; align-items: center; gap: 8px; padding: 6px 0;">
          <span style="width: 8px; height: 8px; border-radius: 50%; background: ${statusColors[status] || statusColors.pending}; flex-shrink: 0;"></span>
          <span style="font-size: 13px; color: ${statusColors[status] || statusColors.pending}; font-weight: 500;">
            ${statusLabels[status] || status}
          </span>
        </div>
      </div>`;

    if (status === 'completed' && fileIds.length > 0) {
      const ratio = data.ratio || '';
      // Map đầy đủ 5 aspect ratio cross-provider (Flow VN / numeric / ChatGPT / Grok keys).
      // Helper static `_resolveRatioClass` trả CSS class 'ratio-9-16' / 'ratio-3-4' / 'ratio-1-1' / 'ratio-4-3' / 'ratio-16-9'.
      // Trước fix: chỉ 2 class (ratio-portrait/landscape) → Grok keys 'story/widescreen' miss → default 1:1 SAI.
      const ratioClass = this._resolveRatioClass(ratio);
      const galleryClass = fileIds.length === 1 ? 'single-result' : '';

      // Dual URL — badge "Original" cho tile có provider URL gốc (Grok/ChatGPT) → user biết
      // download sẽ lấy chất lượng 100% provider thay vì Flow re-encoded.
      const providerUrls = data.result_provider_urls || {};
      const providerCount = fileIds.filter(id => providerUrls[id]?.url).length;

      const renderThumb = (id) => {
        const provider = providerUrls[id]?.provider || '';
        const hasOrig = !!providerUrls[id]?.url;
        const badgeHtml = hasOrig
          ? `<span class="result-thumb-original-badge" data-provider="${provider}" title="${window.I18n?.t('workflow.downloadOriginal') || 'Download original'} (${provider})">${provider.toUpperCase()}</span>`
          : '';
        return `<div class="node-result-thumb ${ratioClass}${hasOrig ? ' has-provider-url' : ''}" data-file-id="${this.escapeAttr(id)}" data-provider="${provider}"><div class="tobyflow-loading-spinner" style="width:16px;height:16px;"></div>${badgeHtml}</div>`;
      };

      // 2 button download riêng — user chọn explicit source thay vì auto-route:
      //   - Original: chỉ download tiles có provider URL gốc (Grok/ChatGPT chất lượng 100%)
      //   - Flow: download qua Flow tile (re-encoded, có chọn 1k/2k cho image, 720p/1080p cho video)
      // Original button chỉ hiện khi có >=1 tile có provider URL.
      const downloadIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';
      const flowDlLabel = window.I18n?.t('workflow.downloadViaFlow', { count: fileIds.length }) || `Download ${fileIds.length} files via Flow`;
      const origDlLabel = window.I18n?.t('workflow.downloadOriginalCount', { count: providerCount }) || `Download original (${providerCount})`;
      const origDlTitle = window.I18n?.t('workflow.downloadOriginalTitle') || '100% provider quality, no re-encode';
      const flowDlTitle = window.I18n?.t('workflow.downloadViaFlowTitle') || 'Download via Google Flow (choose 1k/2k/720p/1080p)';
      const origBtnHtml = providerCount > 0
        ? `<button class="node-result-download-btn node-result-download-btn--original" id="resultDownloadOriginalBtn" title="${origDlTitle}">
            ${downloadIcon}<span>${origDlLabel}</span>
          </button>`
        : '';

      html += `
        <div class="form-group">
          <label>${window.I18n?.t('workflow.resultCount', { count: fileIds.length }) || `Results (${fileIds.length} files)`}</label>
          <div class="node-result-gallery ${galleryClass}" id="nodeResultGallery">
            ${fileIds.map(id => renderThumb(id)).join('')}
          </div>
          <div class="node-result-download-actions">
            ${origBtnHtml}
            <button class="node-result-download-btn" id="resultDownloadFlowBtn" title="${flowDlTitle}">
              ${downloadIcon}<span>${flowDlLabel}</span>
            </button>
          </div>
        </div>`;
    } else if (status === 'pending') {
      html += `
        <div class="form-group">
          <p style="font-size: 12px; color: var(--muted-foreground); font-style: italic;">${window.I18n?.t('workflow.nodeNotRun') || 'Node chưa được chạy.'}</p>
        </div>`;
    } else if (status === 'running') {
      html += `
        <div class="form-group">
          <div style="display: flex; align-items: center; gap: 8px; padding: 8px 0;">
            <div class="tobyflow-loading-spinner" style="width:16px;height:16px;"></div>
            <span style="font-size: 12px; color: var(--warning);">${window.I18n?.t('workflow.processing') || 'Processing...'}</span>
          </div>
        </div>`;
    }

    if (status === 'failed' && errorMsg) {
      html += `
        <div class="form-group">
          <label>${window.I18n?.t('workflow.errorLog') || 'Log lỗi'}</label>
          <div style="font-size: 12px; color: var(--destructive); background: hsla(0, 84%, 60%, 0.08); padding: 8px 10px; border-radius: 6px; border: 1px solid hsla(0, 84%, 60%, 0.2); white-space: pre-wrap; max-height: 120px; overflow-y: auto;">
            ${this.escapeHtml(errorMsg)}
          </div>
        </div>`;
    }

    // 2026-05-31 fix: hiển thị result_text cho cả prompt + text_extract nodes (đều output text).
    // Trước fix: chỉ check 'prompt' → text_extract run xong, result_text persist OK nhưng KHÔNG
    // hiển thị trên Result tab → user click Run không thấy kết quả gì.
    const TEXT_RESULT_NODE_TYPES = ['prompt', 'text_extract'];
    // 2026-05-31 defensive: normalize whitespace tại display (cleanup leading + trailing per line,
    // collapse 3+ newlines → 2). Mirror logic WorkflowExecutor._normalizeExtractedText — old
    // result_text stored trước normalize fix sẽ hiển thị clean. CSS .prompt-result-text có
    // white-space:pre-wrap nên leading whitespace/blank lines SẼ show nếu không clean.
    const _normalizeDisplay = (txt) => (typeof txt === 'string' ? txt : '')
      .replace(/\r\n/g, '\n')
      .replace(/ /g, ' ')           // NBSP → space
      .replace(/[​-‍﻿]/g, '')         // zero-width chars
      .split('\n').map(l => l.trim()).join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    const displayResultText = _normalizeDisplay(data.result_text);
    if (displayResultText && TEXT_RESULT_NODE_TYPES.includes(data.node_type)) {
      const sourceLabel = data.result_source === 'plain_fallback'
        ? (window.I18n?.t('workflow.promptSourceFallback') || 'Plain text (fallback)')
        : data.result_source === 'plain'
          ? (window.I18n?.t('workflow.promptSourcePlain') || 'Plain text')
          : data.result_source === 'chatgpt'
            ? (window.ProviderMeta?.getName?.('chatgpt') || 'ChatGPT')
            : data.result_source === 'gemini'
              ? (window.ProviderMeta?.getName?.('gemini') || 'Gemini')
              : data.result_source === 'extract'
                ? (window.I18n?.t('workflow.extractResultSource') || 'Text Extract')
                : (data.result_source || 'Unknown');
      const sourceClass = data.result_source === 'plain_fallback' ? 'warning' : 'success';
      const labelText = data.node_type === 'text_extract'
        ? (window.I18n?.t('workflow.extractResult') || 'Text trích xuất')
        : (window.I18n?.t('workflow.promptResult') || 'Prompt kết quả');
      html += `
        <div class="form-group">
          <label class="prompt-result-label">
            ${labelText}
            <span class="prompt-result-source-badge ${sourceClass}">${sourceLabel}</span>
          </label>
          <div id="promptResultText" class="prompt-result-text">${this.escapeHtml(displayResultText)}</div>
          <button class="copy-prompt-result-btn">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
            <span class="copy-btn-text">${window.I18n?.t('common.copy') || 'Copy'}</span>
          </button>
        </div>`;
    }

    // Load thumbnails + bind 2 download buttons (Original vs Flow) after render
    if (status === 'completed' && fileIds.length > 0) {
      requestAnimationFrame(() => {
        this._loadResultGalleryThumbnails(fileIds, data.result_file_names);
        const origBtn = this.overlay?.querySelector('#resultDownloadOriginalBtn');
        origBtn?.addEventListener('click', () => this._downloadNodeFiles({ source: 'original' }));
        const flowBtn = this.overlay?.querySelector('#resultDownloadFlowBtn');
        flowBtn?.addEventListener('click', () => this._downloadNodeFiles({ source: 'flow' }));
        // Per-item click-to-download (like TaskModal)
        this._bindResultItemDownloads(fileIds, data);
      });
    }

    // Bind copy button cho prompt + text_extract result text (parity với render condition trên).
    if (displayResultText && TEXT_RESULT_NODE_TYPES.includes(data.node_type)) {
      requestAnimationFrame(() => {
        const copyBtn = this.overlay?.querySelector('.copy-prompt-result-btn');
        copyBtn?.addEventListener('click', async () => {
          try {
            // Copy normalized text (consistent với display) — old data trước normalize fix
            // sẽ copy bản clean thay vì raw whitespace.
            await navigator.clipboard.writeText(displayResultText);
            // Visual feedback - change button text và style
            const btnText = copyBtn.querySelector('.copy-btn-text');
            const originalText = btnText?.textContent;
            if (btnText) {
              btnText.textContent = window.I18n?.t('common.copied') || 'Copied!';
              copyBtn.classList.add('copied');
            }
            // Reset sau 1.5s
            setTimeout(() => {
              if (btnText) {
                btnText.textContent = originalText;
                copyBtn.classList.remove('copied');
              }
            }, 1500);
          } catch (e) {
            console.error('[WorkflowEditor] Copy prompt result failed:', e);
          }
        });
      });
    }

    return html;
  }

  _loadResultGalleryThumbnails(fileIds, resultFileNames = null) {
    const gallery = this.overlay?.querySelector('#nodeResultGallery');
    if (!gallery) return;

    const thumbEls = gallery.querySelectorAll('.node-result-thumb');

    // Cross-project warning icon SVG
    const crossProjectIconSvg = `
      <svg class="cross-project-icon" style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);color:var(--destructive,#dc2626);opacity:0.7;z-index:1;" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
        <line x1="12" y1="9" x2="12" y2="13"></line>
        <line x1="12" y1="17" x2="12.01" y2="17"></line>
      </svg>`;
    const mismatchLabel = '<div style="position:absolute;bottom:0;left:0;right:0;background:var(--destructive,#dc2626);color:#fff;font-size:6px;text-align:center;line-height:1.4;border-radius:0 0 6px 6px;z-index:5;">Sai project</div>';

    for (let i = 0; i < fileIds.length && i < thumbEls.length; i++) {
      const tileId = fileIds[i];
      const thumbEl = thumbEls[i];
      let mediaSrc = '';
      let isVideo = false;
      let isCrossProject = false;
      const expectedFileName = resultFileNames?.[tileId] || null;

      // Try DOM
      const tile = document.querySelector(`[data-tile-id="${tileId}"]`);
      if (tile) {
        const domFileName = this._extractFileNameFromTile(tile);

        // Cross-project check: compare DOM file_name with expected
        if (expectedFileName && domFileName && domFileName !== expectedFileName) {
          console.warn(`[WorkflowEditor] Cross-project result collision: tile_id=${tileId}, expected=${expectedFileName}, actual=${domFileName}`);
          isCrossProject = true;
        }

        if (!isCrossProject) {
          // Ưu tiên <video> trước (video tiles có cả <img> ref lẫn <video> result)
          const videoEl = tile.querySelector('video');
          if (videoEl?.src) {
            mediaSrc = videoEl.src;
            isVideo = true;
          } else {
            const imgEl = tile.querySelector('img');
            if (imgEl?.src) {
              mediaSrc = imgEl.src;
              isVideo = false;
            }
          }
        }
      }

      // Fallback to cache (check cross-project)
      // Bug 51 fix: Track video_url separately for video playback
      let videoUrl = null;
      if (!mediaSrc && this._tileCache.has(tileId)) {
        const cached = this._tileCache.get(tileId);

        // Cross-project check: compare cached file_name with expected
        if (expectedFileName && cached?.file_name && cached.file_name !== expectedFileName) {
          console.warn(`[WorkflowEditor] Cross-project result collision (cached): tile_id=${tileId}, expected=${expectedFileName}, cached=${cached.file_name}`);
          isCrossProject = true;
        }

        if (!isCrossProject) {
          mediaSrc = cached.thumbnail;
          isVideo = cached.type === 'video';
          videoUrl = cached.video_url || null;
        }
      }

      // Render based on cross-project status
      if (isCrossProject) {
        thumbEl.classList.add('node-result-thumb-cross-project');
        thumbEl.style.borderColor = 'var(--destructive,#dc2626)';
        thumbEl.innerHTML = crossProjectIconSvg + mismatchLabel;
      } else if (mediaSrc) {
        // Bug 51 fix: Use video_url for video playback, fallback to mediaSrc (thumbnail)
        thumbEl.innerHTML = isVideo
          ? `<video src="${videoUrl || mediaSrc}" muted loop autoplay playsinline style="width:100%;height:100%;object-fit:cover;border-radius:6px;"></video>`
          : `<img src="${mediaSrc}" alt="result" style="width:100%;height:100%;object-fit:cover;border-radius:6px;">`;
      } else {
        thumbEl.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.3"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`;
      }
    }

    // If no DOM tiles found, try MessageBridge with targeted lookup
    const hasAny = Array.from(thumbEls).some(el => el.querySelector('img, video'));
    if (!hasAny && typeof MessageBridge !== 'undefined') {
      const missingIds = fileIds.filter(id => !this._tileCache.has(id) && !id.startsWith('upload_'));
      if (missingIds.length > 0) {
        MessageBridge.getThumbnailsByIds(missingIds).then(result => {
          const results = result?.results || {};
          for (const [fid, info] of Object.entries(results)) {
            if (info?.thumbnail) {
              // Bug 51 fix: Include video_url for video playback
              this._tileCacheSet(fid, { thumbnail: info.thumbnail, type: info.type || 'image', file_name: info.file_name, ...(info.video_url && { video_url: info.video_url }) });
            }
          }
          // Re-render thumbnails with cross-project check
          for (let i = 0; i < fileIds.length && i < thumbEls.length; i++) {
            const tileId = fileIds[i];
            const cached = this._tileCache.get(tileId);
            const expectedFileName = resultFileNames?.[tileId] || null;

            if (cached) {
              // Cross-project check for MessageBridge results
              const isCrossProject = expectedFileName && cached.file_name && cached.file_name !== expectedFileName;

              if (isCrossProject) {
                console.warn(`[WorkflowEditor] Cross-project result collision (MessageBridge): tile_id=${tileId}, expected=${expectedFileName}, actual=${cached.file_name}`);
                thumbEls[i].classList.add('node-result-thumb-cross-project');
                thumbEls[i].style.borderColor = 'var(--destructive,#dc2626)';
                thumbEls[i].innerHTML = crossProjectIconSvg + mismatchLabel;
              } else {
                const isVid = cached.type === 'video';
                // Bug 51 fix: Use video_url for video playback
                const vidSrc = cached.video_url || cached.thumbnail;
                thumbEls[i].innerHTML = isVid
                  ? `<video src="${vidSrc}" muted loop autoplay playsinline style="width:100%;height:100%;object-fit:cover;border-radius:6px;"></video>`
                  : `<img src="${cached.thumbnail}" alt="result" style="width:100%;height:100%;object-fit:cover;border-radius:6px;">`;
              }
            }
          }
        }).catch(() => {});
      }
    }
  }

  /**
   * Bind per-item click-to-download on result thumbnails (like TaskModal)
   */
  _bindResultItemDownloads(fileIds, data) {
    const gallery = this.overlay?.querySelector('#nodeResultGallery');
    if (!gallery) return;
    const fileNames = data.result_file_names || {};
    const isVideoNode = data.media_type === 'Video' || data.gen_type === 'Video';
    const label = data.prompt || data.node_name || 'flow';

    const thumbEls = gallery.querySelectorAll('.node-result-thumb');
    for (let i = 0; i < fileIds.length && i < thumbEls.length; i++) {
      const fileId = fileIds[i];
      const thumbEl = thumbEls[i];
      thumbEl.style.cursor = 'pointer';
      thumbEl.title = window.I18n?.t('workflow.clickToDownload') || 'Click để tải';
      thumbEl.addEventListener('click', () => {
        const fileName = fileNames[fileId] || null;
        const isVideo = isVideoNode || this._isTileVideo(fileId);
        if (typeof DownloadHelper !== 'undefined') {
          DownloadHelper.showModal({
            tileId: fileId,
            fileName: fileName,
            promptText: label,
            index: i + 1,
            mediaType: isVideo ? 'video' : 'image'
          });
        } else if (typeof MessageBridge !== 'undefined') {
          const resolution = isVideo
            ? (data.video_download_resolution || '720p')
            : (data.download_resolution || '1k');
          MessageBridge.downloadTileMedia(fileId, label, this.workflow?.wf_name || null, fileName, resolution);
        }
      });
    }
  }

  _refreshResultTabIfSelected(nodeId, status, fileIds, errorMsg) {
    if (!this.selectedNodeId || !nodeId) return;
    const drawflowId = this._findDrawflowId(nodeId);
    if (String(drawflowId) !== String(this.selectedNodeId)) return;
    const resultBody = this.overlay?.querySelector('#nodeResultBody');
    if (!resultBody) return;

    // Get ratio from drawflow node data for proper preview sizing
    const nodeData = this.diagramCanvas?.editor?.getNodeFromId(drawflowId);
    const ratio = nodeData?.data?.ratio || '';

    // Update in-memory workflow node data
    if (this.workflow?.nodes) {
      const wfNode = this.workflow.nodes.find(n => n.node_id === nodeId);
      if (wfNode) {
        wfNode.status = status;
        if (fileIds) wfNode.result_file_ids = fileIds.join(',');
        if (errorMsg) wfNode.error_message = errorMsg;
      }
    }

    const dfData = nodeData?.data || {};
    const data = {
      ...dfData,
      status,
      ratio,
      result_file_ids: fileIds ? fileIds.join(',') : '',
      error_message: errorMsg || ''
    };
    resultBody.innerHTML = this._renderNodeResultTab(data);
  }

  /**
   * Mở upgrade modal cross-context. Sidebar context có window.openUpgradeModal sẵn;
   * popup window context (workflow-editor.html) thì gửi message đến background.js để
   * relay tới sidePanel (handler 'openUpgradeModal' → broadcast 'showUpgradeModal').
   */
  /**
   * Safe wrapper cho featureGate.checkQuotaAsync — popup window context có thể fail
   * khi token expired (refresh() throws). Fallback sang sync checkQuota (cached) để không
   * bị silent click play.
   */
  async _safeCheckQuotaAsync(featureKey) {
    if (!window.featureGate) return { allowed: true, limit: 'unknown', used: 0, remaining: 'unknown' };
    try {
      return await window.featureGate.checkQuotaAsync(featureKey);
    } catch (err) {
      console.warn('[WorkflowEditor] checkQuotaAsync(' + featureKey + ') failed — fallback sync cached:', err?.message);
      try {
        return window.featureGate.checkQuota(featureKey);
      } catch (e2) {
        // Last resort: cho phép run, server-side ExecutionGate sẽ enforce thật.
        return { allowed: true, limit: 'unknown', used: 0, remaining: 'unknown' };
      }
    }
  }

  _openUpgradeModal() {
    if (typeof window.openUpgradeModal === 'function') {
      window.openUpgradeModal();
      return;
    }
    try {
      chrome.runtime?.sendMessage?.({ action: 'openUpgradeModal' }, () => { void chrome.runtime.lastError; });
    } catch (e) { /* noop */ }
  }

  /**
   * Flow Voice Selector — show/hide voice picker theo media_type + model.config.supports_voice.
   * Reset value khi switch sang model không support voice.
   */
  _applyNodeVoicePickerVisibility() {
    const group = this.overlay?.querySelector('#nodeVoicePickerGroup');
    if (!group) return;

    const mediaType = this.overlay?.querySelector('#nodeMediaType')?.value || 'Image';
    if (mediaType !== 'Video') {
      group.classList.add('hidden');
      return;
    }

    const modelValue = this.overlay?.querySelector('#nodeVideoModel')?.value || '';
    const modelObj = window.ModelRegistry?.findModel?.('flow', modelValue);
    const supportsVoice = !!(modelObj?.config?.supports_voice === true);

    if (supportsVoice) {
      group.classList.remove('hidden');
    } else {
      group.classList.add('hidden');
      // Reset voice fields khi model không support
      const slugInput = this.overlay?.querySelector('#nodeVoiceSlug');
      const searchInput = this.overlay?.querySelector('#nodeVoiceSearchValue');
      if (slugInput?.value || searchInput?.value) {
        if (slugInput) slugInput.value = '';
        if (searchInput) searchInput.value = '';
        if (this._nodeVoicePicker) this._nodeVoicePicker._updateTrigger();
      }
    }
  }

  /**
   * Lazy init VoicePicker cho node form. Cleanup old picker khi switch node.
   * Uses VoiceSelectModal (full-screen overlay) thay vì inline popup.
   */
  _initNodeVoicePicker(data) {
    if (this._nodeVoicePicker) {
      try { this._nodeVoicePicker.destroy(); } catch (_) {}
      this._nodeVoicePicker = null;
    }

    if (!window.VoicePicker) return;

    const triggerEl = this.overlay?.querySelector('#nodeVoiceTrigger');
    if (!triggerEl) return;

    this._nodeVoicePicker = new window.VoicePicker({
      triggerEl,
      thumbEl: this.overlay?.querySelector('#nodeVoiceTriggerThumb'),
      labelEl: this.overlay?.querySelector('#nodeVoiceLabel'),
      hiddenSelectEl: this.overlay?.querySelector('#nodeVoiceSlug'),
      providerSlug: 'flow',
      getSelected: () => this.overlay?.querySelector('#nodeVoiceSlug')?.value || '',
      onChange: (slug, voiceObj) => {
        const slugInput = this.overlay?.querySelector('#nodeVoiceSlug');
        const searchInput = this.overlay?.querySelector('#nodeVoiceSearchValue');
        if (slugInput) slugInput.value = slug || '';
        if (searchInput) searchInput.value = voiceObj?.search_value || '';
      },
    });
    this._nodeVoicePicker.init();

    this._applyNodeVoicePickerVisibility();
  }

  /**
   * Bind form events theo node type
   */
  _bindNodeFormEvents(nodeType, data, nodeId) {
    // Text Extract Node (2026-05-29): toggle marker vs regex input group khi mode đổi.
    if (nodeType === 'text_extract') {
      const modeSelect = this.overlay?.querySelector('#nodeExtractMode');
      const markerGroup = this.overlay?.querySelector('#nodeExtractMarkerGroup');
      const regexGroup = this.overlay?.querySelector('#nodeExtractRegexGroup');
      if (modeSelect && markerGroup && regexGroup) {
        modeSelect.addEventListener('change', () => {
          const isRegex = modeSelect.value === 'regex';
          regexGroup.classList.toggle('hidden', !isRegex);
          markerGroup.classList.toggle('hidden', isRegex);
        });
      }
    }

    // Phase 1 — Node Reference System: Slug inline edit handlers
    const slugInlineDisplay = this.overlay?.querySelector('#slugInlineDisplay');
    const slugInlineEdit = this.overlay?.querySelector('#slugInlineEdit');
    const slugInput = this.overlay?.querySelector('#nodeSlug');
    const slugConfirmBtn = this.overlay?.querySelector('#slugConfirmBtn');
    const slugAutoInput = this.overlay?.querySelector('#nodeSlugAuto');
    const slugError = this.overlay?.querySelector('#slugError');

    if (slugInlineDisplay && slugInlineEdit && slugInput) {
      const showEditMode = () => {
        if (this.isReadOnly()) return;
        slugInlineDisplay.classList.add('hidden');
        slugInlineEdit.classList.remove('hidden');
        slugInput.focus();
        slugInput.select();
      };

      const hideEditMode = () => {
        slugInlineEdit.classList.add('hidden');
        slugInlineDisplay.classList.remove('hidden');
      };

      const confirmSlug = () => {
        const newSlug = (slugInput.value || '').trim().toLowerCase();
        const placeholder = slugInput.placeholder || '';
        const displayValue = newSlug || placeholder;

        if (newSlug) {
          const validation = this._validateSlug(newSlug, nodeId);
          if (!validation.valid) {
            if (slugError) {
              slugError.textContent = validation.error;
              slugError.classList.remove('hidden');
            }
            slugInput.focus();
            return;
          }
        }

        if (slugError) slugError.classList.add('hidden');
        const slugValueEl = slugInlineDisplay.querySelector('.slug-value');
        if (slugValueEl) slugValueEl.textContent = displayValue;
        const isManual = !!newSlug && newSlug !== placeholder;
        slugInlineDisplay.classList.toggle('slug-auto', !isManual);
        slugInlineDisplay.classList.toggle('slug-manual', isManual);
        if (slugAutoInput) slugAutoInput.value = isManual ? 'false' : 'true';
        hideEditMode();
        this._hasUnsavedChanges = true;
      };

      slugInlineDisplay.addEventListener('click', showEditMode);
      slugConfirmBtn?.addEventListener('click', confirmSlug);
      slugInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          confirmSlug();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          if (slugError) slugError.classList.add('hidden');
          hideEditMode();
        }
      });
      slugInput.addEventListener('input', () => {
        const val = slugInput.value || '';
        // 2026-05-28: strip leading digit/underscore live — regex backend yêu cầu bắt đầu bằng [a-z].
        // Trước: chỉ filter non-alphanum → user nhập "1abc" → input giữ "1abc" → confirmSlug
        // validate reject NHƯNG user khó hiểu. Live filter prevent state invalid ngay từ keystroke.
        slugInput.value = val.toLowerCase().replace(/[^a-z0-9_]/g, '').replace(/^[0-9_]+/, '');
      });
    }

    // Provider login reminder button (ChatGPT/Grok nodes)
    const providerReminderBtn = this.overlay?.querySelector('.provider-reminder-btn[data-action="openProvider"]');
    if (providerReminderBtn) {
      providerReminderBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        // Skip if already ready
        if (providerReminderBtn.classList.contains('ready')) return;
        const provider = providerReminderBtn.dataset.provider;
        chrome.runtime.sendMessage({ action: 'openProviderTab', provider, focusWindow: false }, (resp) => {
          if (resp?.ok) {
            console.log(`[WorkflowEditor] Opened/activated ${provider} tab:`, resp.tabId, resp.existing ? '(existing)' : '(new)');
            // Poll status until ready or max attempts reached (30s)
            this._pollProviderStatus(provider, 15, 2000);
          }
        });
      });
    }

    // Download node: chỉ bind upgrade link
    if (nodeType === 'download') {
      const upgradeLink = this.overlay?.querySelector('.node-download-upgrade-link');
      if (upgradeLink) {
        upgradeLink.addEventListener('click', (e) => {
          e.preventDefault();
          this._openUpgradeModal();
        });
      }
      return;
    }
    if (nodeType === 'telegram') {
      // Bind upgrade link
      const telegramUpgradeLink = this.overlay?.querySelector('.node-telegram-upgrade-link');
      if (telegramUpgradeLink) {
        telegramUpgradeLink.addEventListener('click', (e) => {
          e.preventDefault();
          this._openUpgradeModal();
        });
      }
      // Auto-fill telegram chat_id from TelegramLink
      const linkStatusEl = this.overlay?.querySelector('#telegramLinkStatus');
      const chatIdInput = this.overlay?.querySelector('#telegramChatId');
      if (linkStatusEl && window.authManager?.isLoggedIn()) {
        window.authManager._apiCall('GET', 'telegram/link/status').then(resp => {
          const respData = resp?.data || resp;
          if (respData?.linked && respData?.telegram_chat_id) {
            if (linkStatusEl) {
              linkStatusEl.textContent = `${window.I18n?.t('workflow.telegramLinked') || 'Linked'}: @${respData.telegram_username || respData.telegram_chat_id}`;
              linkStatusEl.style.color = '#22c55e';
            }
            if (chatIdInput && !chatIdInput.value) {
              chatIdInput.value = respData.telegram_chat_id;
            }
          } else {
            if (linkStatusEl) {
              linkStatusEl.innerHTML = `${window.I18n?.t('workflow.telegramNotLinked') || 'Chưa liên kết Telegram'}. <a href="#" style="color: var(--primary);">${window.I18n?.t('workflow.openSettings') || 'Mở Settings'}</a>`;
              linkStatusEl.style.color = '#f59e0b';
            }
            const settingsLink = linkStatusEl?.querySelector('a');
            if (settingsLink) {
              settingsLink.addEventListener('click', (e) => {
                e.preventDefault();
                chrome.runtime.sendMessage({ action: 'openSettings' });
              });
            }
          }
        }).catch(() => {
          if (linkStatusEl) {
            linkStatusEl.textContent = window.I18n?.t('workflow.telegramCheckFailed') || 'Không thể kiểm tra liên kết';
            linkStatusEl.style.color = 'var(--muted-foreground)';
          }
        });
      } else if (linkStatusEl) {
        linkStatusEl.textContent = window.I18n?.t('workflow.telegramLoginToLink') || 'Login to link Telegram';
        linkStatusEl.style.color = 'var(--muted-foreground)';
      }
      return;
    }
    if (nodeType === 'note' || nodeType === 'delay') return;

    // === PHASE 2 — MENTION AUTOCOMPLETE (moved here to run before type-specific early returns) ===
    if (this._canUseMentions(nodeType)) {
      const promptTextareaId = nodeType === 'chatgpt' ? '#chatgptNodePrompt'
        : nodeType === 'grok' ? '#grokNodePrompt'
        : nodeType === 'prompt' ? '#promptNodeText'
        : '#nodePrompt';
      const promptTextarea = this.overlay?.querySelector(promptTextareaId);
      if (promptTextarea) {
        this._bindMentionAutocomplete(promptTextarea, nodeId);
      }
    }

    // === PROMPT SOURCE TOGGLE (Phase CG-8) — generate / chatgpt / grok ===
    if (['generate', 'chatgpt', 'grok'].includes(nodeType)) {
      const toggle = this.overlay?.querySelector('#promptSourceToggle');
      if (toggle) {
        // Ẩn cả form-group prompt (label + textarea) khi dùng upstream_node
        const promptGroupId =
          (nodeType === 'chatgpt') ? '#chatgptNodePromptGroup'
          : nodeType === 'generate' ? '#nodePromptGroup'
          : nodeType === 'grok' ? '#grokNodePromptGroup'
          : null;
        const promptGroup = promptGroupId ? this.overlay?.querySelector(promptGroupId) : null;

        const updateState = () => {
          const useOwnPrompt = toggle.checked;
          if (promptGroup) {
            promptGroup.classList.toggle('hidden', !useOwnPrompt);
          }
          // Update inline indicator visibility
          try { this._refreshAllPromptSourceBadges(); } catch (e) {}
        };
        toggle.addEventListener('change', updateState);
        updateState();
      }
    }

    // === AI AGENT NODE (Phase CG-8 + AI Agent rename 2026-05-30) ===
    if (nodeType === 'prompt') {
      // Toggle Use AI ON/OFF → show/hide provider+timeout sections
      const enhanceToggle = this.overlay?.querySelector('#promptNodeUseAi');
      const providerSections = this.overlay?.querySelectorAll('.prompt-node-provider-section');
      // Provider status button for Prompt node
      const providerSelect = this.overlay?.querySelector('#promptNodeProvider');
      const providerStatusBtn = this.overlay?.querySelector('#promptProviderStatusBtn');

      const applyEnhanceVisibility = () => {
        const isOn = !!enhanceToggle?.checked;
        if (providerSections) {
          providerSections.forEach((sec) => {
            sec.classList.toggle('hidden', !isOn);
          });
        }
        // Update provider status when enhance is toggled ON
        if (isOn && providerSelect) {
          this._updateProviderStatusIndicator(providerSelect.value || 'chatgpt');
        }
      };
      enhanceToggle?.addEventListener('change', applyEnhanceVisibility);

      const updatePromptProviderButton = () => {
        if (!providerStatusBtn || !providerSelect) return;
        const prov = providerSelect.value || 'chatgpt';
        const provLabel = window.ProviderMeta?.getName?.(prov) || (prov === 'chatgpt' ? 'ChatGPT' : 'Gemini');
        const openText = window.I18n?.t('workflow.openProvider') || 'Open';
        const readyText = window.I18n?.t('workflow.providerReady') || 'Ready';
        providerStatusBtn.dataset.provider = prov;
        const textEl = providerStatusBtn.querySelector('.provider-btn-text');
        if (textEl) {
          textEl.dataset.notReadyText = `${openText} ${provLabel}`;
          textEl.dataset.readyText = readyText;
        }
        // Check status for the new provider
        this._updateProviderStatusIndicator(prov);
      };

      providerSelect?.addEventListener('change', updatePromptProviderButton);

      // Click handler for provider status button
      providerStatusBtn?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (providerStatusBtn.classList.contains('ready')) return;
        const prov = providerStatusBtn.dataset.provider || 'chatgpt';
        chrome.runtime.sendMessage({ action: 'openProviderTab', provider: prov, focusWindow: false }, (resp) => {
          if (resp?.ok) {
            console.log(`[WorkflowEditor] Opened/activated ${prov} tab for Prompt node:`, resp.tabId);
            this._pollProviderStatus(prov, 15, 2000);
          }
        });
      });

      // Initial provider status check if enhance is ON
      if (enhanceToggle?.checked) {
        const initialProv = providerSelect?.value || 'chatgpt';
        this._updateProviderStatusIndicator(initialProv);
      }

      // Phase CG-8 ext: Ref images picker cho Prompt node (max 4, chỉ enhance=ON)
      // EWT-9.1: Kiểm tra template mode để bind events phù hợp
      if (this.isTemplateMode) {
        // Template mode: bind WorkflowMediaModal
        this._bindTemplateRefImagesEvents('promptNodePickBtn', 'promptNodeRefImgUrls', 'promptNodeRefPreview', 4);
      } else {
        // Normal mode: bind imagePickerModal
        const promptPickBtn = this.overlay?.querySelector('#promptNodePickBtn');
        promptPickBtn?.addEventListener('click', () => {
          const fileIdInput = this.overlay?.querySelector('#promptNodeRefFileIds');
          const existingIds = (fileIdInput?.value || '').split(',').map(s => s.trim()).filter(Boolean);
          if (!window.imagePickerModal) return;
          window.imagePickerModal.open({
            existingFileIds: existingIds,
            mediaFilter: 'image',
            // Prompt node là pass-through ref images cho downstream — giới hạn tổng quát 4
            maxSelections: 4,
            onConfirm: async (images) => {
              const flowImages = images.filter(img => img.source === 'flow' || img.source === 'existing');
              const uploadImages = images.filter(img => img.source === 'upload' && img.file);
              const newIds = flowImages.map(img => img.fileId).filter(Boolean);
              for (const img of flowImages) {
                if (img.fileId && img.thumbnail) {
                  this._tileCacheSet(img.fileId, { thumbnail: img.thumbnail, file_name: img.file_name || '', type: img.type || 'image' });
                }
              }
              const albumImages = images.filter(img => img.source === 'album');
              for (const img of albumImages) {
                try {
                  const prepared = await ImagePickerModal.prepareAlbumImageForRef(img);
                  if (!prepared) continue;
                  const key = prepared.key;
                  this._tileCacheSet(key, { thumbnail: img.thumbnail, file_name: prepared.file_name || '', type: 'image' });
                  newIds.push(key);
                  if (key.startsWith('upload_')) {
                    const pendingFile = window.pendingUploadFiles?.get(key)?.file;
                    if (pendingFile && window.ImmediateUploader) {
                      ImmediateUploader.upload(pendingFile, img.thumbnail, { key }).catch(e => console.error('[WorkflowEditor] Prompt upload failed:', key, e));
                    }
                    this._formUploadKeys?.add(key);
                  }
                } catch (err) {
                  console.error('[WorkflowEditor] Lỗi chuẩn bị ảnh album (prompt):', err);
                }
              }
              if (uploadImages.length > 0) {
                if (!window.pendingUploadFiles) window.pendingUploadFiles = new Map();
                for (const img of uploadImages) {
                  const key = img.fileId || `upload_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
                  window.pendingUploadFiles.set(key, { file: img.file, thumbnail: img.thumbnail });
                  this._tileCacheSet(key, { thumbnail: img.thumbnail, file_name: '', type: 'image' });
                  if (window.ImmediateUploader) {
                    ImmediateUploader.upload(img.file, img.thumbnail, { key }).catch(e => console.error('[WorkflowEditor] Prompt image upload failed:', key, e));
                  } else if (window.PendingUploadStore) {
                    PendingUploadStore.saveLightweight(key, { thumbnail: img.thumbnail, fileName: img.file.name, fileSize: img.file.size, fileType: img.file.type });
                  }
                  newIds.push(key);
                  this._formUploadKeys?.add(key);
                }
              }
              const mergedIds = [...new Set([...existingIds, ...newIds])].slice(0, 4);
              const fileIdsInput = this.overlay?.querySelector('#promptNodeRefFileIds');
              if (fileIdsInput) fileIdsInput.value = mergedIds.join(', ');
              this._renderNodeRefPreview(fileIdsInput?.value || '', '#promptNodeRefPreview');
              this._updateFormButtonState();
            }
          });
        });
        // Render existing ref previews (normal mode)
        if (data.ref_file_ids) {
          this._renderNodeRefPreview(data.ref_file_ids, { containerSelector: '#promptNodeRefPreview', refFileNames: data.ref_file_names });
        }
      }
      return;
    }


    // T-1.6: Auto-download toggle → show/hide resolution select based on media type
    const nodeAutoDownload = this.overlay?.querySelector('#nodeAutoDownload');
    const nodeDownloadResWrap = this.overlay?.querySelector('#nodeDownloadResWrap');
    const nodeVideoDownloadResWrap = this.overlay?.querySelector('#nodeVideoDownloadResWrap');
    const nodeMediaType = this.overlay?.querySelector('#nodeMediaType');
    const updateNodeDownloadResolutionVisibility = () => {
      const isAutoDownload = nodeAutoDownload?.checked;
      const isVideo = nodeMediaType?.value === 'Video';
      if (nodeDownloadResWrap) {
        nodeDownloadResWrap.classList.toggle('hidden', !isAutoDownload || isVideo);
      }
      if (nodeVideoDownloadResWrap) {
        nodeVideoDownloadResWrap.classList.toggle('hidden', !isAutoDownload || !isVideo);
      }
    };
    nodeAutoDownload?.addEventListener('change', updateNodeDownloadResolutionVisibility);
    nodeMediaType?.addEventListener('change', updateNodeDownloadResolutionVisibility);
    if (nodeType === 'chatgpt') {
      // Bind upgrade link (gate banner khi chatgpt_enabled=false)
      const cgUpgradeLink = this.overlay?.querySelector('.node-chatgpt-upgrade-link');
      if (cgUpgradeLink) {
        cgUpgradeLink.addEventListener('click', (e) => {
          e.preventDefault();
          this._openUpgradeModal();
        });
      }
      // Bind ratio pills (story/portrait/square/landscape/widescreen)
      const cgRatioPillsContainer = this.overlay?.querySelector('#chatgptImageRatioPills');
      const cgRatioInput = this.overlay?.querySelector('#chatgptImageRatio');
      if (cgRatioPillsContainer && cgRatioInput) {
        cgRatioPillsContainer.querySelectorAll('.chatgpt-ratio-pill').forEach(pill => {
          pill.addEventListener('click', (e) => {
            e.preventDefault();
            const val = pill.dataset.ratio;
            if (!val) return;
            cgRatioInput.value = val;
            cgRatioPillsContainer.querySelectorAll('.chatgpt-ratio-pill').forEach(p => p.classList.remove('active'));
            pill.classList.add('active');
          });
        });
      }
      // Bind image picker (max 4 ref images)
      // EWT-9.1: Kiểm tra template mode để bind events phù hợp
      if (this.isTemplateMode) {
        // Template mode: bind WorkflowMediaModal
        this._bindTemplateRefImagesEvents('chatgptImageNodePickBtn', 'chatgptImageRefImgUrls', 'chatgptImageRefPreview', 4);
        // EWT-12: Bind result image events cho template mode (with ratio selector for ChatGPT pills)
        this._bindTemplateResultImageEvents('chatgptResultPickBtn', 'chatgptResultImgUrl', 'chatgptResultPreview', '#chatgptImageRatioPills');
      } else {
        // Normal mode: bind imagePickerModal
        const cgPickBtn = this.overlay?.querySelector('#chatgptImageNodePickBtn');
        cgPickBtn?.addEventListener('click', () => {
          const fileIdInput = this.overlay?.querySelector('#chatgptImageRefFileIds');
          const existingIds = (fileIdInput?.value || '').split(',').map(s => s.trim()).filter(Boolean);
          if (window.imagePickerModal) {
            window.imagePickerModal.open({
              existingFileIds: existingIds,
              mediaFilter: 'image',
              maxSelections: ImagePickerModal.resolveMaxSelections({ provider: 'chatgpt', mode: 'image' }) || 4,
              onConfirm: async (images) => {
                const flowImages = images.filter(img => img.source === 'flow' || img.source === 'existing');
                const uploadImages = images.filter(img => img.source === 'upload' && img.file);
                const newIds = flowImages.map(img => img.fileId).filter(Boolean);
                // Cache thumbnail cho Flow images
                for (const img of flowImages) {
                  if (img.fileId && img.thumbnail) {
                    this._tileCacheSet(img.fileId, { thumbnail: img.thumbnail, file_name: img.file_name || '', type: img.type || 'image' });
                  }
                }
                // Xử lý ảnh album (ALIVE/STALE)
                const albumImages = images.filter(img => img.source === 'album');
                for (const img of albumImages) {
                  try {
                    const prepared = await ImagePickerModal.prepareAlbumImageForRef(img);
                    if (!prepared) continue;
                    const key = prepared.key;
                    this._tileCacheSet(key, {
                      thumbnail: img.thumbnail,
                      file_name: prepared.file_name || '',
                      type: 'image'
                    });
                    newIds.push(key);
                    if (key.startsWith('upload_')) {
                      const pendingFile = window.pendingUploadFiles?.get(key)?.file;
                      if (pendingFile && window.ImmediateUploader) {
                        ImmediateUploader.upload(pendingFile, img.thumbnail, { key }).catch(e => console.error('[WorkflowEditor] ChatGPT upload failed:', key, e));
                      }
                      this._formUploadKeys?.add(key);
                    }
                  } catch (err) {
                    console.error('[WorkflowEditor] Lỗi chuẩn bị ảnh album (chatgpt):', err);
                  }
                }
                if (uploadImages.length > 0) {
                  if (!window.pendingUploadFiles) window.pendingUploadFiles = new Map();
                  for (const img of uploadImages) {
                    const key = img.fileId || `upload_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
                    window.pendingUploadFiles.set(key, { file: img.file, thumbnail: img.thumbnail });
                    this._tileCacheSet(key, { thumbnail: img.thumbnail, file_name: '', type: 'image' });
                    if (window.ImmediateUploader) {
                      ImmediateUploader.upload(img.file, img.thumbnail, { key }).catch(e => console.error('[WorkflowEditor] ChatGPT image upload failed:', key, e));
                    } else if (window.PendingUploadStore) {
                      PendingUploadStore.saveLightweight(key, { thumbnail: img.thumbnail, fileName: img.file.name, fileSize: img.file.size, fileType: img.file.type });
                    }
                    newIds.push(key);
                    this._formUploadKeys?.add(key);
                  }
                }
                // Cap theo max_ref_images (admin api_config) thay vì hardcode 4. Giữ ref MỚI NHẤT
                // (slice từ cuối) → ảnh user vừa thêm được dùng, không bị kẹt ref cũ.
                const cgRefLimit = this._getNodeRefLimit('#chatgptImageRefPreview') || 4;
                const cgMerged = [...new Set([...existingIds, ...newIds])];
                const mergedIds = cgMerged.length > cgRefLimit ? cgMerged.slice(-cgRefLimit) : cgMerged;
                if (cgMerged.length > cgRefLimit) {
                  console.log(`[WorkflowEditor] ChatGPT ref vượt giới hạn (${cgMerged.length}/${cgRefLimit}), giữ ${cgRefLimit} ảnh mới nhất`);
                }
                const fileIdsInput = this.overlay?.querySelector('#chatgptImageRefFileIds');
                if (fileIdsInput) fileIdsInput.value = mergedIds.join(', ');
                this._renderNodeRefPreview(fileIdsInput?.value || '', '#chatgptImageRefPreview');
                this._updateFormButtonState();
              }
            });
          }
        });
        // Render existing ref previews (normal mode)
        if (data.ref_file_ids) this._renderNodeRefPreview(data.ref_file_ids, { containerSelector: '#chatgptImageRefPreview', refFileNames: data.ref_file_names });
      }
      return;
    }
    if (nodeType === 'grok') {
      // Phase G-6: Bind upgrade link
      const grokUpgradeLink = this.overlay?.querySelector('.node-grok-upgrade-link');
      if (grokUpgradeLink) {
        grokUpgradeLink.addEventListener('click', (e) => {
          e.preventDefault();
          this._openUpgradeModal();
        });
      }
      // Mode toggle (icon button — mirror gen-type-toggle pattern) → show/hide video-only / image-only fields
      const grokModeInput = this.overlay?.querySelector('#grokNodeMode');
      const grokModeToggle = this.overlay?.querySelector('#grokNodeModeToggle');
      const grokVideoOnlyRow = this.overlay?.querySelector('#grokVideoOnlyRow');
      const grokImageOnlyRow = this.overlay?.querySelector('#grokImageOnlyRow');
      const updateGrokModeVisibility = () => {
        const isVideo = grokModeInput?.value === 'video';
        if (grokVideoOnlyRow) grokVideoOnlyRow.style.display = isVideo ? '' : 'none';
        // Image quality (Speed/Quality) chỉ áp dụng khi mode=image
        if (grokImageOnlyRow) grokImageOnlyRow.style.display = isVideo ? 'none' : '';
      };
      if (grokModeToggle && grokModeInput) {
        grokModeToggle.querySelectorAll('.node-form-mode-btn').forEach(btn => {
          btn.addEventListener('click', (e) => {
            e.preventDefault();
            const mode = btn.dataset.mode;
            if (!mode || grokModeInput.value === mode) return;
            grokModeInput.value = mode;
            grokModeToggle.querySelectorAll('.node-form-mode-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            updateGrokModeVisibility();
            // Post-audit fix: re-render ref preview để update ref-thumb-exceeded grayscale
            // theo grok_mode mới (Grok video có thể có limit khác image).
            try {
              const grokRefInput = this.overlay?.querySelector('#grokNodeRefFileIds');
              if (grokRefInput?.value) {
                this._renderNodeRefPreview(grokRefInput.value, '#grokNodeRefPreview');
              }
            } catch (_) {}

            // Bug 44 fix (2026-05-13): Persist grok_mode vào node.data ngay khi đổi —
            // tránh data stale → output port type='image' nhưng UI hiển thị Video mode →
            // user kéo edge video→image input ko bị reject.
            try {
              const drawflowId = this.selectedNodeId;
              const editor = this.diagramCanvas?.editor;
              if (drawflowId && editor && window.NodeTemplates?.getNodePorts) {
                const node = editor.getNodeFromId(drawflowId);
                if (node) {
                  const updated = { ...(node.data || {}), grok_mode: mode };
                  const nodeType = updated.node_type || node.class || 'grok';
                  const newPorts = window.NodeTemplates.getNodePorts(nodeType, updated);
                  const portMap = {};
                  (newPorts.in || []).forEach((p, idx) => { portMap[`input_${idx + 1}`] = p.name; });
                  (newPorts.out || []).forEach((p, idx) => { portMap[`output_${idx + 1}`] = p.name; });
                  updated._port_map = portMap;
                  editor.updateNodeDataFromId(drawflowId, updated);
                  if (this.diagramCanvas?._resizeNodePorts) {
                    this.diagramCanvas._resizeNodePorts(drawflowId, newPorts);
                  }
                  if (this.diagramCanvas?._injectPortAttributes) {
                    requestAnimationFrame(() => this.diagramCanvas._injectPortAttributes(drawflowId, newPorts));
                  }
                  const removedCount = this._revalidateNodeEdges(drawflowId);
                  if (removedCount > 0) {
                    const msg = window.I18n?.t('workflow.edgesRemovedOnTypeChange', { count: removedCount })
                      || `Đã gỡ ${removedCount} kết nối không tương thích sau khi đổi grok mode`;
                    if (typeof window.showNotification === 'function') {
                      window.showNotification(msg, 'warning', 2500);
                    }
                    try { this.diagramCanvas?._recolorAllEdges?.(); } catch (e) {}
                  }
                }
              }
            } catch (e) {
              console.warn('[WorkflowEditor] Sync grok_mode to node data failed:', e?.message);
            }
          });
        });
      }
      updateGrokModeVisibility();

      // Ratio pills (story/portrait/square/landscape/widescreen)
      const grokRatioPillsContainer = this.overlay?.querySelector('#grokRatioPills');
      const grokRatioInput = this.overlay?.querySelector('#grokNodeRatio');
      if (grokRatioPillsContainer && grokRatioInput) {
        grokRatioPillsContainer.querySelectorAll('.grok-ratio-pill').forEach(pill => {
          pill.addEventListener('click', (e) => {
            e.preventDefault();
            const val = pill.dataset.ratio;
            if (!val) return;
            grokRatioInput.value = val;
            grokRatioPillsContainer.querySelectorAll('.grok-ratio-pill').forEach(p => p.classList.remove('active'));
            pill.classList.add('active');
          });
        });
      }

      // Image picker (max 4 ref images) — mirror chatgpt pattern
      // EWT-9.1: Kiểm tra template mode để bind events phù hợp
      if (this.isTemplateMode) {
        // Template mode: bind WorkflowMediaModal
        this._bindTemplateRefImagesEvents('grokNodePickBtn', 'grokNodeRefImgUrls', 'grokNodeRefPreview', 4);
        // EWT-12: Bind result image events cho template mode (with ratio selector for Grok pills)
        this._bindTemplateResultImageEvents('grokNodeResultPickBtn', 'grokNodeResultImgUrl', 'grokNodeResultPreview', '#grokRatioPills');
      } else {
        // Normal mode: bind imagePickerModal
        const grokPickBtn = this.overlay?.querySelector('#grokNodePickBtn');
        grokPickBtn?.addEventListener('click', () => {
          const fileIdInput = this.overlay?.querySelector('#grokNodeRefFileIds');
          const existingIds = (fileIdInput?.value || '').split(',').map(s => s.trim()).filter(Boolean);
          if (window.imagePickerModal) {
            const grokMode = (data?.grok_mode || data?.mode || 'image').toLowerCase();
            window.imagePickerModal.open({
              existingFileIds: existingIds,
              mediaFilter: 'image',
              maxSelections: ImagePickerModal.resolveMaxSelections({ provider: 'grok', mode: grokMode }) || 4,
              onConfirm: async (images) => {
                const flowImages = images.filter(img => img.source === 'flow' || img.source === 'existing');
                const uploadImages = images.filter(img => img.source === 'upload' && img.file);
                const newIds = flowImages.map(img => img.fileId).filter(Boolean);
                for (const img of flowImages) {
                  if (img.fileId && img.thumbnail) {
                    this._tileCacheSet(img.fileId, { thumbnail: img.thumbnail, file_name: img.file_name || '', type: img.type || 'image' });
                  }
                }
                const albumImages = images.filter(img => img.source === 'album');
                for (const img of albumImages) {
                  try {
                    const prepared = await ImagePickerModal.prepareAlbumImageForRef(img);
                    if (!prepared) continue;
                    const key = prepared.key;
                    this._tileCacheSet(key, { thumbnail: img.thumbnail, file_name: prepared.file_name || '', type: 'image' });
                    newIds.push(key);
                    if (key.startsWith('upload_')) {
                      const pendingFile = window.pendingUploadFiles?.get(key)?.file;
                      if (pendingFile && window.ImmediateUploader) {
                        ImmediateUploader.upload(pendingFile, img.thumbnail, { key }).catch(e => console.error('[WorkflowEditor] Grok upload failed:', key, e));
                      }
                      this._formUploadKeys?.add(key);
                    }
                  } catch (err) {
                    console.error('[WorkflowEditor] Lỗi chuẩn bị ảnh album (grok):', err);
                  }
                }
                if (uploadImages.length > 0) {
                  if (!window.pendingUploadFiles) window.pendingUploadFiles = new Map();
                  for (const img of uploadImages) {
                    const key = img.fileId || `upload_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
                    window.pendingUploadFiles.set(key, { file: img.file, thumbnail: img.thumbnail });
                    this._tileCacheSet(key, { thumbnail: img.thumbnail, file_name: '', type: 'image' });
                    if (window.ImmediateUploader) {
                      ImmediateUploader.upload(img.file, img.thumbnail, { key }).catch(e => console.error('[WorkflowEditor] Grok image upload failed:', key, e));
                    } else if (window.PendingUploadStore) {
                      PendingUploadStore.saveLightweight(key, { thumbnail: img.thumbnail, fileName: img.file.name, fileSize: img.file.size, fileType: img.file.type });
                    }
                    newIds.push(key);
                    this._formUploadKeys?.add(key);
                  }
                }
                const mergedIds = [...new Set([...existingIds, ...newIds])].slice(0, 4);
                const fileIdsInput = this.overlay?.querySelector('#grokNodeRefFileIds');
                if (fileIdsInput) fileIdsInput.value = mergedIds.join(', ');
                this._renderNodeRefPreview(fileIdsInput?.value || '', '#grokNodeRefPreview');
                this._updateFormButtonState();
              }
            });
          }
        });
        // Render existing ref previews (normal mode)
        if (data.ref_file_ids) this._renderNodeRefPreview(data.ref_file_ids, { containerSelector: '#grokNodeRefPreview', refFileNames: data.ref_file_names });
      }
      return;
    }
    if (nodeType === 'image') {
      // EWT-9.1: Kiểm tra template mode để bind events phù hợp
      if (this.isTemplateMode) {
        // Template mode: bind WorkflowMediaModal
        this._bindTemplateRefImagesEvents('imageNodePickBtn', 'imageNodeRefImgUrls', 'imageNodeRefPreview', 10);
      } else {
        // Normal mode: bind imagePickerModal
        // Render existing ref previews
        if (data.ref_file_ids) this._renderNodeRefPreview(data.ref_file_ids, { containerSelector: '#imageNodeRefPreview', refFileNames: data.ref_file_names });
        // Pick button
        const pickBtn = this.overlay?.querySelector('#imageNodePickBtn');
        pickBtn?.addEventListener('click', () => {
          const fileIdInput = this.overlay?.querySelector('#nodeRefFileIds');
          const existingIds = (fileIdInput?.value || '').split(',').filter(Boolean);
          if (window.imagePickerModal) {
            window.imagePickerModal.open({
              existingFileIds: existingIds,
              mediaFilter: 'image',
              // Image node: Flow image bag → 10 ref images max
              maxSelections: ImagePickerModal.resolveMaxSelections({ provider: 'flow', mode: 'image' }) || 10,
              onConfirm: async (images) => {
                const existingFileIds = (fileIdInput?.value || '').split(',').map(s => s.trim()).filter(Boolean);
                const flowImages = images.filter(img => img.source === 'flow' || img.source === 'existing');
                const uploadImages = images.filter(img => img.source === 'upload' && img.file);
                const newIds = flowImages.map(img => img.fileId).filter(Boolean);
                // Cache thumbnail cho Flow images
                for (const img of flowImages) {
                  if (img.fileId && img.thumbnail) {
                    this._tileCacheSet(img.fileId, { thumbnail: img.thumbnail, file_name: img.file_name || '', type: img.type || 'image' });
                  }
                }
                // Xử lý ảnh album (ALIVE/STALE)
                const albumImages = images.filter(img => img.source === 'album');
                for (const img of albumImages) {
                  try {
                    const prepared = await ImagePickerModal.prepareAlbumImageForRef(img);
                    if (!prepared) continue;
                    const key = prepared.key;
                    this._tileCacheSet(key, {
                      thumbnail: img.thumbnail,
                      file_name: prepared.file_name || '',
                      type: 'image'
                    });
                    newIds.push(key);
                    // STALE: fire ImmediateUploader
                    if (key.startsWith('upload_')) {
                      const pendingFile = window.pendingUploadFiles?.get(key)?.file;
                      if (pendingFile && window.ImmediateUploader) {
                        ImmediateUploader.upload(pendingFile, img.thumbnail, { key }).catch(e => console.error('[WorkflowEditor] Upload failed:', key, e));
                      }
                      this._formUploadKeys?.add(key);
                    }
                  } catch (err) {
                    console.error('[WorkflowEditor] Lỗi chuẩn bị ảnh album (image node):', err);
                  }
                }
                if (uploadImages.length > 0) {
                  if (!window.pendingUploadFiles) window.pendingUploadFiles = new Map();
                  for (const img of uploadImages) {
                    const key = img.fileId || `upload_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
                    // Set memory ngay lập tức
                    window.pendingUploadFiles.set(key, { file: img.file, thumbnail: img.thumbnail });
                    // Cache thumbnail vào _tileCache
                    this._tileCacheSet(key, { thumbnail: img.thumbnail, file_name: '', type: 'image' });
                    // S2: Upload ngay nếu Flow tab mở, hoặc lưu lightweight pending
                    if (window.ImmediateUploader) {
                      ImmediateUploader.upload(img.file, img.thumbnail, { key }).catch(e => console.error('[WorkflowEditor] Image node upload failed:', key, e));
                    } else if (window.PendingUploadStore) {
                      PendingUploadStore.saveLightweight(key, { thumbnail: img.thumbnail, fileName: img.file.name, fileSize: img.file.size, fileType: img.file.type });
                    }
                    newIds.push(key);
                    this._formUploadKeys?.add(key);
                  }
                }
                const mergedIds = [...new Set([...existingFileIds, ...newIds])];
                if (fileIdInput) fileIdInput.value = mergedIds.join(', ');
                this._renderNodeRefPreview(fileIdInput?.value || '', '#imageNodeRefPreview');
                this._updateFormButtonState();
              }
            });
          }
        });
      }
      return;
    }
    // Quantity +/- buttons — range từ provider_configs.flow.api_config.quantity_range
    const nodeQtyInput = this.overlay?.querySelector('#nodeQuantity');
    const _qRange = window.ProviderConfigManager?.safeGetQuantityRangeSync?.('flow');
    const _qMinBtn = _qRange?.min ?? 1;
    const _qMaxBtn = _qRange?.max ?? 4;
    this.overlay?.querySelector('#nodeQtyMinus')?.addEventListener('click', () => {
      const val = parseInt(nodeQtyInput?.value) || _qMinBtn;
      if (val > _qMinBtn && nodeQtyInput) nodeQtyInput.value = val - 1;
    });
    this.overlay?.querySelector('#nodeQtyPlus')?.addEventListener('click', () => {
      const val = parseInt(nodeQtyInput?.value) || _qMinBtn;
      if (val < _qMaxBtn && nodeQtyInput) nodeQtyInput.value = val + 1;
    });

    const pickerBtn = this.overlay?.querySelector('#nodeOpenImagePickerBtn');
    pickerBtn?.addEventListener('click', () => {
      // EWT-12: Template mode dùng WorkflowMediaModal (upload lên server)
      if (this.isTemplateMode && typeof WorkflowMediaModal !== 'undefined') {
        // Lấy preselected URLs từ cache dựa trên existing fileIds
        const existingIdsStr = this.overlay?.querySelector('#nodeRefFileIds')?.value || '';
        const existingIds = existingIdsStr.split(',').filter(Boolean);
        const preselectedUrls = existingIds
          .map(id => this._tileCache.get(id)?.thumbnail)
          .filter(Boolean);
        WorkflowMediaModal.show({
          type: 'ref_image',
          multiple: true,
          preselected: preselectedUrls,
          onSelect: (urls) => {
            // urls đã bao gồm preselected, thay thế hoàn toàn (không merge)
            const selectedUrls = Array.isArray(urls) ? urls : [urls];
            const fileIdsInput = this.overlay?.querySelector('#nodeRefFileIds');
            if (fileIdsInput) {
              // Tạo keys mới cho tất cả URLs được chọn (thay thế existing)
              const timestamp = Date.now();
              const keys = selectedUrls.map((url, idx) => `upload_import_${timestamp}_${idx}_${Math.random().toString(36).substr(2, 5)}`);
              // Cache thumbnails
              keys.forEach((key, idx) => {
                this._tileCacheSet(key, { thumbnail: selectedUrls[idx], file_name: '', type: 'image' });
              });
              // Thay thế hoàn toàn (không merge với existing)
              fileIdsInput.value = keys.join(',');
              this._renderNodeRefPreview(fileIdsInput.value);
              this._hasUnsavedChanges = true;
            }
          }
        });
        return;
      }
      // Normal mode: dùng imagePickerModal (chọn từ Flow)
      const existingIds = (this.overlay?.querySelector('#nodeRefFileIds')?.value || '').split(',').filter(Boolean);
      if (window.imagePickerModal) {
        // Bug 2026-05-28: ĐỌC LIVE VALUES TỪ DOM thay vì `data?.*` snapshot (stale từ lúc mở form).
        // Trước fix: user switch select Omni Flash nhưng data.model vẫn là model cũ → picker dùng cap cũ.
        const mediaTypeLive = this.overlay?.querySelector('#nodeMediaType')?.value || data?.media_type || 'Image';
        const videoInputTypeLive = this.overlay?.querySelector('#nodeVideoInputType')?.value || data?.video_input_type || '';
        const isVideo = String(mediaTypeLive).toLowerCase() === 'video';
        const isFrames = isVideo && String(videoInputTypeLive).toLowerCase() === 'frames';
        const modelLive = isVideo
          ? (this.overlay?.querySelector('#nodeVideoModel')?.value || data?.model || '')
          : (this.overlay?.querySelector('#nodeImageModel')?.value || data?.model || '');
        const _wfeDuration = isVideo ? (this.overlay?.querySelector('#nodeVideoDuration')?.value || undefined) : undefined;
        const _wfeCaps = ImagePickerModal.resolveCapsMulti({
          provider: 'flow',
          mode: isVideo ? 'video' : 'image',
          isFrames,
          modelValue: modelLive,
          duration: _wfeDuration,
        });
        const _wfeMaxRef = _wfeCaps.image;
        // 0 = model không hỗ trợ ref → giữ 0 (block); null/positive → fallback 10.
        const _wfeFinalMax = _wfeMaxRef === 0 ? 0 : (_wfeMaxRef || 10);
        // existingFileTypes: lookup type từ _tileCache cho mỗi ref ID hiện có →
        // modal pre-select biết video vs image → multi-cap count đúng khi mở lại.
        const _wfeExistingTypes = {};
        for (const id of existingIds) {
          const cached = this._tileCache.get(id);
          if (cached?.type === 'video') _wfeExistingTypes[id] = 'video';
        }
        window.imagePickerModal.open({
          existingFileIds: existingIds,
          existingFileTypes: _wfeExistingTypes,
          mediaFilter: 'image',
          // 2026-05-27: model Flow có supports_ref_video (vd Omni Flash) → cho phép chọn + upload video.
          allowVideo: window.ProviderRegistry?.get?.('flow')?.supportsRefVideo?.(modelLive) === true,
          maxSelections: _wfeCaps.total ?? _wfeFinalMax,
          maxImageSelections: _wfeFinalMax,
          maxVideoSelections: _wfeCaps.video,
          maxTotalSelections: _wfeCaps.total,
          noRefSupportContext: _wfeMaxRef === 0 ? {
            provider: 'flow',
            modelValue: modelLive,
            mediaType: isVideo ? 'video' : 'image',
            inputType: isVideo ? (isFrames ? 'Frames' : 'Ingredients') : undefined,
            duration: _wfeDuration,
          } : null,
          onConfirm: (images) => this.handleNodeImagePickerConfirm(images)
        });
      }
    });
    if (data.ref_file_ids) this._renderNodeRefPreview(data.ref_file_ids, { refFileNames: data.ref_file_names });
    if (nodeType === 'generate') {
      // Bind upgrade link (gate banner khi gen_enabled=false)
      const genUpgradeLink = this.overlay?.querySelector('.node-generate-upgrade-link');
      if (genUpgradeLink) {
        genUpgradeLink.addEventListener('click', (e) => {
          e.preventDefault();
          this._openUpgradeModal();
        });
      }
      this._bindFrameSourceEvents(1, data);
      this._bindFrameSourceEvents(2, data);
      const f1Select = this.overlay?.querySelector('#frame1Source');
      const f2Select = this.overlay?.querySelector('#frame2Source');
      if (f1Select && data.frame_1_source) { f1Select.value = data.frame_1_source; f1Select.dispatchEvent(new Event('change')); }
      if (f2Select && data.frame_2_source) { f2Select.value = data.frame_2_source; f2Select.dispatchEvent(new Event('change')); }
      if (data.frame_1_file_id) this._renderFramePreview(1, data.frame_1_file_id);
      if (data.frame_2_file_id) this._renderFramePreview(2, data.frame_2_file_id);
      const nodeMediaType = this.overlay?.querySelector('#nodeMediaType');
      const nodeMediaTypeToggle = this.overlay?.querySelector('#nodeMediaTypeToggle');
      const nodeImageModelGroup = this.overlay?.querySelector('#nodeImageModelGroup');
      const nodeVideoModelGroup = this.overlay?.querySelector('#nodeVideoModelGroup');
      const nodeVideoInputTypeGroup = this.overlay?.querySelector('#nodeVideoInputTypeGroup');
      const nodeVideoDurationGroup = this.overlay?.querySelector('#nodeVideoDurationGroup');
      const nodeRefImagesGroup = this.overlay?.querySelector('#nodeRefImagesGroup');
      const nodeFrameConfigGroup = this.overlay?.querySelector('#nodeFrameConfigGroup');
      const nodeVideoInputType = this.overlay?.querySelector('#nodeVideoInputType');
      const nodeVideoModel = this.overlay?.querySelector('#nodeVideoModel');
      const nodeVideoDuration = this.overlay?.querySelector('#nodeVideoDuration');
      // Mode toggle (icon button — mirror Grok pattern). Dispatch 'change' trên hidden input
      // để các handler hiện hữu (#nodeMediaType change) tiếp tục hoạt động.
      if (nodeMediaTypeToggle && nodeMediaType) {
        nodeMediaTypeToggle.querySelectorAll('.node-form-mode-btn').forEach(btn => {
          btn.addEventListener('click', (e) => {
            e.preventDefault();
            const mode = btn.dataset.mode;
            if (!mode || nodeMediaType.value === mode) return;
            nodeMediaType.value = mode;
            nodeMediaTypeToggle.querySelectorAll('.node-form-mode-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            nodeMediaType.dispatchEvent(new Event('change', { bubbles: true }));
          });
        });
      }
      const updateNodeMediaUI = () => {
        const isVideo = nodeMediaType?.value === 'Video';
        const isFrames = nodeVideoInputType?.value === 'Frames';
        nodeImageModelGroup?.classList.toggle('hidden', isVideo);
        nodeVideoModelGroup?.classList.toggle('hidden', !isVideo);
        nodeVideoInputTypeGroup?.classList.toggle('hidden', !isVideo);
        nodeVideoDurationGroup?.classList.toggle('hidden', !isVideo);
        // Flow Voice picker — chỉ video + model.config.supports_voice
        try { this._applyNodeVoicePickerVisibility(); } catch (_) {}
        // 2026-05-22: toggle wrap break — Video mode break trước Ratio (đồng bộ GenTab/TaskModal).
        const compactBar = this.overlay?.querySelector('#nodeGenCompactBar');
        if (compactBar) compactBar.dataset.genMode = isVideo ? 'video' : 'image';
        if (isVideo && isFrames) { nodeRefImagesGroup?.classList.add('hidden'); nodeFrameConfigGroup?.classList.remove('hidden'); }
        else if (isVideo) { nodeRefImagesGroup?.classList.remove('hidden'); nodeFrameConfigGroup?.classList.add('hidden'); }
        else { nodeRefImagesGroup?.classList.remove('hidden'); nodeFrameConfigGroup?.classList.add('hidden'); }
      };
      // 2026-05-28: Strip refs vượt cap khi model/mode/inputType/duration đổi.
      // Reuse ImagePickerModal.resolveMaxSelections (single source of truth cap logic).
      // Vd switch Veo Lite (cap=3) → Veo Quality (cap=0) → bỏ refs + toast warn.
      const enforceRefCap = () => {
        const fileIdsInput = this.overlay?.querySelector('#nodeRefFileIds');
        if (!fileIdsInput) return;
        const currentIds = String(fileIdsInput.value || '').split(',').map(s => s.trim()).filter(Boolean);
        if (currentIds.length === 0) return;

        const isVid = (nodeMediaType?.value === 'Video');
        const isFr = isVid && (nodeVideoInputType?.value === 'Frames');
        const modelValue = isVid
          ? (nodeVideoModel?.value || '')
          : (this.overlay?.querySelector('#nodeImageModel')?.value || '');
        const duration = isVid ? (nodeVideoDuration?.value || undefined) : undefined;

        let cap;
        try {
          cap = window.ImagePickerModal?.resolveMaxSelections?.({
            provider: 'flow',
            mode: isVid ? 'video' : 'image',
            isFrames: isFr,
            modelValue,
            duration,
          });
        } catch (_) { return; }

        if (cap === null || cap === undefined) return; // unlimited
        if (currentIds.length <= cap) return;            // chưa vượt cap

        const kept = cap > 0 ? currentIds.slice(0, cap) : [];
        const dropped = currentIds.length - kept.length;
        fileIdsInput.value = kept.join(',');

        // Trim parallel thumbnails map (nếu có)
        const thumbsInput = this.overlay?.querySelector('#nodeRefThumbnails');
        if (thumbsInput?.value) {
          try {
            const map = JSON.parse(thumbsInput.value);
            const newMap = {};
            kept.forEach(id => { if (map[id]) newMap[id] = map[id]; });
            thumbsInput.value = Object.keys(newMap).length ? JSON.stringify(newMap) : '';
          } catch (_) {}
        }

        try { this._renderNodeRefPreview(fileIdsInput.value); } catch (_) {}

        const msg = window.I18n?.t?.('workflow.refCapStrippedOnModelSwitch', {
          model: modelValue || '—', cap, dropped,
        }) || `Model "${modelValue}" chỉ hỗ trợ ${cap} ref — đã bỏ ${dropped} ảnh.`;
        if (typeof window.showNotification === 'function') {
          window.showNotification(msg, 'warning', 4000);
        }
      };

      // Update video duration options when video model changes (tier may differ)
      const updateNodeVideoDurationOptions = () => {
        if (!nodeVideoDuration) return;
        const currentModel = nodeVideoModel?.value || '';
        let tier = 'default';
        try {
          const models = window.ModelRegistry?.safeGetModelsSync?.('flow', 'video') || [];
          const modelObj = models.find(m => m.value === currentModel || m.name === currentModel);
          if (modelObj?.config?.duration_tier) tier = modelObj.config.duration_tier;
        } catch (_) {}
        const durations = window.ProviderConfigManager?.safeGetVideoDurationsSync?.('flow', tier) || [];
        if (durations.length === 0) return;
        const prevValue = nodeVideoDuration.value;
        nodeVideoDuration.innerHTML = durations.map(d => `<option value="${d}">${d}</option>`).join('');
        if (prevValue && durations.includes(prevValue)) {
          nodeVideoDuration.value = prevValue;
        } else {
          const defaultIdx = durations.indexOf('6s');
          nodeVideoDuration.value = defaultIdx >= 0 ? durations[defaultIdx] : durations[0];
        }
      };
      nodeVideoModel?.addEventListener('change', () => {
        updateNodeVideoDurationOptions();
        // Flow Voice picker visibility re-apply theo model mới
        try { this._applyNodeVoicePickerVisibility(); } catch (_) {}
        // 2026-05-28: strip refs vượt cap mới trước khi re-render preview
        enforceRefCap();
        const fileIdsInput = this.overlay?.querySelector('#nodeRefFileIds');
        if (fileIdsInput?.value) this._renderNodeRefPreview(fileIdsInput.value);
      });
      // nodeVideoDuration đã declare ở scope ngoài (line ~6248) — re-use binding
      nodeVideoDuration?.addEventListener('change', () => {
        // 2026-05-22: duration change → ref support có thể đổi (vd Lite/Fast strict 4s/6s block).
        enforceRefCap();
        const fileIdsInput = this.overlay?.querySelector('#nodeRefFileIds');
        if (fileIdsInput?.value) this._renderNodeRefPreview(fileIdsInput.value);
      });
      nodeMediaType?.addEventListener('change', () => {
        // 2026-05-31 fix: Image→Video switch — apply user setting defaultVideoInputType
        // (vd 'Ingredients') nếu nodeVideoInputType chưa được user explicit chọn.
        // Heuristic: nếu data.video_input_type vẫn empty → user chưa chọn → apply default.
        // Tránh override nếu user đã explicit set Frames trước đó.
        if (nodeMediaType.value === 'Video' && nodeVideoInputType) {
          const currentNodeData = this.diagramCanvas?.editor?.getNodeFromId(this.selectedNodeId)?.data;
          const userHasExplicitChoice = !!(currentNodeData?.video_input_type);
          if (!userHasExplicitChoice) {
            const effectiveDefault = nodeVideoInputType.dataset.effectiveDefault
              || window.storageSettings?.get?.('defaultVideoInputType')
              || 'Frames';
            // Match validity: nếu effective='Frames' mà option 'Frames' không tồn tại (supportsFrames=false)
            // → fallback Ingredients. Browser tự skip non-existent option khi assign.
            const hasFramesOption = !!nodeVideoInputType.querySelector('option[value="Frames"]');
            const targetValue = (effectiveDefault === 'Frames' && !hasFramesOption) ? 'Ingredients' : effectiveDefault;
            if (nodeVideoInputType.value !== targetValue) {
              nodeVideoInputType.value = targetValue;
            }
          }
        }
        updateNodeMediaUI();
        this._updateNodeRatioOptions();
        // 2026-05-28: strip refs vượt cap mới (Image ↔ Video → cap đổi)
        enforceRefCap();
        // Re-render ref previews to update exceeded grayscale
        const fileIdsInput = this.overlay?.querySelector('#nodeRefFileIds');
        if (fileIdsInput?.value) this._renderNodeRefPreview(fileIdsInput.value);

        // Bug 44 fix (2026-05-13): Persist media_type vào node.data NGAY khi đổi —
        // không đợi user click "Save Node". Trước fix: data.media_type vẫn 'Image' →
        // output port type='image' → user kéo edge video → image input ko bị reject
        // (vì port type chưa chuyển thành 'video'). Cũng resize ports + revalidate edges.
        try {
          const drawflowId = this.selectedNodeId;
          const editor = this.diagramCanvas?.editor;
          if (drawflowId && editor && window.NodeTemplates?.getNodePorts) {
            const node = editor.getNodeFromId(drawflowId);
            if (node) {
              const newMediaType = nodeMediaType.value;
              if ((node.data?.media_type || 'Image') !== newMediaType) {
                const updated = { ...(node.data || {}), media_type: newMediaType };
                // Update _port_map theo ports mới
                const nodeType = updated.node_type || node.class || 'generate';
                const newPorts = window.NodeTemplates.getNodePorts(nodeType, updated);
                const portMap = {};
                (newPorts.in || []).forEach((p, idx) => { portMap[`input_${idx + 1}`] = p.name; });
                (newPorts.out || []).forEach((p, idx) => { portMap[`output_${idx + 1}`] = p.name; });
                updated._port_map = portMap;
                editor.updateNodeDataFromId(drawflowId, updated);
                // Resize port count (Video+Frames thêm 2 frame ports)
                if (this.diagramCanvas?._resizeNodePorts) {
                  this.diagramCanvas._resizeNodePorts(drawflowId, newPorts);
                }
                if (this.diagramCanvas?._injectPortAttributes) {
                  requestAnimationFrame(() => this.diagramCanvas._injectPortAttributes(drawflowId, newPorts));
                }
                // Revalidate edges — gỡ edges video → image (incompat)
                const removedCount = this._revalidateNodeEdges(drawflowId);
                if (removedCount > 0) {
                  const msg = window.I18n?.t('workflow.edgesRemovedOnTypeChange', { count: removedCount })
                    || `Đã gỡ ${removedCount} kết nối không tương thích sau khi đổi loại media`;
                  if (typeof window.showNotification === 'function') {
                    window.showNotification(msg, 'warning', 2500);
                  }
                  try { this.diagramCanvas?._recolorAllEdges?.(); } catch (e) {}
                }
              }
            }
          }
        } catch (e) {
          console.warn('[WorkflowEditor] Sync media_type to node data failed:', e?.message);
        }
      });
      nodeVideoInputType?.addEventListener('change', () => {
        updateNodeMediaUI();
        // 2026-05-28: Ingredients ↔ Frames → cap đổi (Frames thường dùng image cap; Veo Quality
        // Ingredients=0 nhưng Frames có thể support).
        enforceRefCap();
        const fileIdsInput = this.overlay?.querySelector('#nodeRefFileIds');
        if (fileIdsInput?.value) this._renderNodeRefPreview(fileIdsInput.value);
      });
      updateNodeMediaUI();
      this._updateNodeRatioOptions();
      // EWT-12: Bind result image & ref images events cho template mode (generate node)
      if (this.isTemplateMode) {
        this._bindTemplateResultImageEvents('generateResultPickBtn', 'generateResultImgUrl', 'generateResultPreview', '#nodeRatio');
        this._bindTemplateRefImagesEvents('generateNodePickBtn', 'generateNodeRefImgUrls', 'generateNodeRefPreview', 4);
      }
    }

    // Ratio change → update node preview aspect ratio on canvas
    const nodeRatioSelect = this.overlay?.querySelector('#nodeRatio');
    if (nodeRatioSelect && this.selectedNodeId) {
      nodeRatioSelect.addEventListener('change', () => {
        const drawflowId = this.selectedNodeId;
        const nodeEl = this.overlay?.querySelector(`#node-${drawflowId}`);
        const previewEl = nodeEl?.querySelector('.df-node-preview');
        if (previewEl) {
          const isPortrait = ['9:16', '3:4', 'Dọc'].includes(nodeRatioSelect.value);
          const isLandscape = ['16:9', '4:3', 'Ngang'].includes(nodeRatioSelect.value);
          previewEl.classList.toggle('ratio-portrait', isPortrait);
          previewEl.classList.toggle('ratio-landscape', isLandscape);
        }
      });
    }

  }

  // Dirty check helpers
  _captureFormSnapshot() {
    if (!this.overlay) return null;
    const fields = ['nodeName', 'nodePrompt', 'nodeMediaType', 'nodeModel', 'nodeVideoModel',
      'nodeRatio', 'nodeQuantity', 'nodeVideoInputType', 'nodeRefFileIds',
      'frame1Source', 'frame1FileId', 'frame2Source', 'frame2FileId', 'nodeEnabled', 'nodeAutoDownload',
      'nodeNoteText', 'nodeDelaySeconds',
      'anglePresetId', 'angleRotation', 'angleTilt', 'angleZoom',
      'downloadFolder', 'downloadFileTemplate', 'downloadResolution', 'downloadVideoResolution', 'downloadCollectAll',
      'chatgptNodePrompt', 'chatgptImageRatio', 'chatgptImageRefFileIds', 'chatgptImageMode',
      'chatgptImageTimeout', 'chatgptImageAutoDownload',
      'grokNodePrompt', 'grokNodeMode', 'grokNodeRatio', 'grokNodeDuration', 'grokNodeResolution',
      'grokNodeImageQuality',
      'grokNodeRefFileIds', 'grokNodeAutoDownload', 'grokNodeTimeout',
      // AI Agent node (Phase CG-8 + rename 2026-05-30) — thiếu trước fix → dirty check không detect toggle
      // → _isFormDirty=false → click save không trigger confirm + có thể stuck.
      // Audit fix 2026-05-30: thêm promptNodeFallback + promptNodeDeleteAfter — 2 toggles này
      // user có thể change nhưng KHÔNG được snapshot → dirty check miss.
      'promptNodeText', 'promptNodeUseAi', 'promptNodeProvider', 'promptNodeTimeout',
      'promptNodeFallback', 'promptNodeDeleteAfter', 'promptNodeRefFileIds'];
    const snapshot = {};
    fields.forEach(id => {
      const el = this.overlay.querySelector(`#${id}`);
      if (!el) return;
      snapshot[id] = el.type === 'checkbox' ? el.checked : el.value;
    });
    return snapshot;
  }

  _isFormDirty() {
    if (!this._formSnapshot) return false;
    const current = this._captureFormSnapshot();
    if (!current) return false;
    return Object.keys(this._formSnapshot).some(k => this._formSnapshot[k] !== current[k]);
  }

  async _handleNodeSelected(nodeId) {
    if (this._dialogPending) return;

    // Check uploads đang chạy TRƯỚC dirty check
    const activeUploads = this._countActiveFormUploads();
    if (activeUploads > 0 && this.selectedNodeId) {
      this._dialogPending = true;
      try {
        await new Promise(r => setTimeout(r, 50));
        const ok = await window.customDialog?.confirm(
          window.I18n?.t('workflow.uploadSwitchNodeWarn', { count: activeUploads }) || `Uploading ${activeUploads} reference images. Switching node will cancel upload and lose unsaved data.`,
          { title: window.I18n?.t('workflow.uploadInProgress') || 'Images uploading', type: 'warning', confirmText: window.I18n?.t('workflow.switchAndCancel') || 'Switch and cancel', cancelText: window.I18n?.t('workflow.continueUpload') || 'Continue upload' }
        );
        if (!ok) {
          this._reselectNode(this.selectedNodeId);
          return;
        }
      } finally {
        this._dialogPending = false;
      }
      await this.hideNodeForm({ skipUploadCheck: true });
      this.showNodeForm(nodeId);
      return;
    }

    // Bug fix: Dùng _formNodeId (node có form đang mở) thay vì selectedNodeId (có thể đã là node mới)
    // Khi user click node B rồi click gear, selectedNodeId = B nhưng form vẫn là của node A
    const formOpenNodeId = this._formNodeId || this.selectedNodeId;
    if (formOpenNodeId && this._isFormDirty()) {
      this._dialogPending = true;
      try {
        await new Promise(r => setTimeout(r, 50));
        const ok = await window.customDialog.confirm(
          window.I18n?.t('workflow.unsavedChanges') || 'Form node đang có thay đổi chưa lưu. Bạn muốn bỏ thay đổi?',
          { title: window.I18n?.t('workflow.notSaved') || 'Chưa lưu', confirmText: window.I18n?.t('workflow.discardChanges') || 'Bỏ thay đổi', cancelText: window.I18n?.t('common.back') || 'Quay lại' }
        );
        if (!ok) {
          // Reselect node CŨ (node có form đang mở), không phải node mới
          this._reselectNode(formOpenNodeId);
          return;
        }
      } finally {
        this._dialogPending = false;
      }
    }
    this.showNodeForm(nodeId);
  }

  async _handleNodeUnselected() {
    // UI 2026-05-27: bỏ highlight connection khi không còn node nào được select.
    try { this._setNodeConnectionsSelected(null); } catch (e) {}
    if (this._dialogPending) return;

    // Dùng _formNodeId để đảm bảo consistency với node có form đang mở
    const formOpenNodeId = this._formNodeId || this.selectedNodeId;

    // Check if node still exists - if deleted, bypass dialog and just close form
    if (formOpenNodeId) {
      const nodeExists = this.diagramCanvas?.editor?.getNodeFromId(formOpenNodeId);
      if (!nodeExists) {
        // Node was deleted, just close form without dialog
        this._formUploadKeys?.clear();
        await this.hideNodeForm({ skipUploadCheck: true });
        return;
      }
    }

    // Check uploads đang chạy TRƯỚC dirty check — ưu tiên cảnh báo upload
    const activeUploads = this._countActiveFormUploads();
    if (activeUploads > 0 && formOpenNodeId) {
      this._dialogPending = true;
      try {
        await new Promise(r => setTimeout(r, 50));
        const ok = await window.customDialog?.confirm(
          window.I18n?.t('workflow.uploadCloseFormWarn', { count: activeUploads }) || `Uploading ${activeUploads} reference images. Closing form will cancel upload and lose unsaved data.`,
          { title: window.I18n?.t('workflow.uploadInProgress') || 'Images uploading', type: 'warning', confirmText: window.I18n?.t('workflow.closeAndCancel') || 'Close and cancel', cancelText: window.I18n?.t('workflow.continueUpload') || 'Continue upload' }
        );
        if (!ok) {
          this._reselectNode(formOpenNodeId);
          return;
        }
      } finally {
        this._dialogPending = false;
      }
      // User confirmed close — skip hideNodeForm's upload check (đã confirm rồi)
      await this.hideNodeForm({ skipUploadCheck: true });
      return;
    }

    if (formOpenNodeId && this._isFormDirty()) {
      this._dialogPending = true;
      try {
        await new Promise(r => setTimeout(r, 50));
        const ok = await window.customDialog.confirm(
          window.I18n?.t('workflow.unsavedChanges') || 'Form node đang có thay đổi chưa lưu. Bạn muốn bỏ thay đổi?',
          { title: window.I18n?.t('workflow.notSaved') || 'Chưa lưu', confirmText: window.I18n?.t('workflow.discardChanges') || 'Bỏ thay đổi', cancelText: window.I18n?.t('common.back') || 'Quay lại' }
        );
        if (!ok) {
          this._reselectNode(formOpenNodeId);
          return;
        }
      } finally {
        this._dialogPending = false;
      }
    }
    await this.hideNodeForm();
  }

  _reselectNode(nodeId) {
    if (!this.diagramCanvas?.editor || !nodeId) return;
    try {
      const editor = this.diagramCanvas.editor;

      // Force-cancel any in-progress Drawflow drag by dispatching a synthetic mouseup
      const canvas = this.overlay?.querySelector('#drawflowCanvas');
      if (canvas) {
        canvas.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      }

      // Reset Drawflow internal drag state
      editor.drag = false;
      editor.drag_point = false;
      editor.editor_selected = false;
      editor.node_selected = null;
      editor.ele_selected = null;

      canvas?.querySelectorAll('.drawflow-node.selected').forEach(el => el.classList.remove('selected'));
      const nodeEl = canvas?.querySelector(`#node-${nodeId}`);
      if (nodeEl) {
        nodeEl.classList.add('selected');
        editor.node_selected = nodeEl;
      }
    } catch (e) {
      console.warn('[TobyFlow] Re-select node failed:', e);
    }
  }

  /**
   * Phase: Sync visual của toggle enabled icon button trong node-form-header
   * theo state của #nodeEnabled checkbox (hidden input).
   */
  _syncEnabledToggleVisual() {
    const btn = this.overlay?.querySelector('#toggleEnabledBtn');
    const checkbox = this.overlay?.querySelector('#nodeEnabled');
    if (!btn || !checkbox) return;
    const enabled = !!checkbox.checked;
    btn.dataset.enabled = enabled ? 'true' : 'false';
    btn.classList.toggle('node-form-toggle-enabled--on', enabled);
    btn.classList.toggle('node-form-toggle-enabled--off', !enabled);
    btn.title = enabled
      ? (window.I18n?.t('workflow.disableNode') || 'Tắt node')
      : (window.I18n?.t('workflow.enableNode') || 'Bật node');
  }

  showNodeForm(nodeId) {
    // Template preview: ẩn sidebar hoàn toàn để user tò mò → clone workflow
    if (this.workflow?._is_template_preview) {
      return;
    }

    this.selectedNodeId = nodeId;
    this._missingRefWarned = false;

    // 2026-05-31 Rescan Tier 1 enhancement: trigger auto-rescan khi user mở node sidebar.
    // force=true bypass throttle 3s — user intent rõ ràng (click setting node), worth
    // immediate fresh scan. _autoRescanBrokenThumbs có internal early return khi không có
    // broken refs nên cost gần như zero khi không cần rescan.
    setTimeout(() => { this._autoRescanBrokenThumbs?.({ force: true }); }, 200);
    // Reset stale upload tracking từ session trước (vd ref refresh trong workflow run
    // có thể để stale key trong _formUploadKeys → _countActiveFormUploads sai → save
    // button stuck disabled). Clear trước khi mở form mới.
    if (this._formUploadKeys?.size > 0) {
      this._formUploadKeys.clear();
    }
    const panel = this.overlay?.querySelector('#nodeFormPanel');
    const body = this.overlay?.querySelector('#nodeFormBody');
    const resultBody = this.overlay?.querySelector('#nodeResultBody');

    if (panel && body && this.diagramCanvas?.editor) {
      const node = this.diagramCanvas.editor.getNodeFromId(nodeId);
      if (!node) return;

      const data = node.data || {};
      // Bug fix: Ưu tiên data.node_type (original) over node.class (có thể bị corrupt)
      const nodeType = data.node_type || node.class || 'generate';

      // Store node type for upload handlers (they need correct container selector)
      this._currentFormNodeType = nodeType;
      // Track which node has form open (for syncing data before run/save)
      this._formNodeId = nodeId;

      // Type-specific form rendering
      body.innerHTML = this._renderNodeFormByType(nodeType, data, nodeId);

      // Render result tab
      if (resultBody) resultBody.innerHTML = this._renderNodeResultTab(data);

      // Render help tab (only for supported node types)
      const helpBody = this.overlay.querySelector('#nodeHelpBody');
      const helpTab = this.overlay.querySelector('#nodeFormHelpTab');
      const HELP_SUPPORTED_TYPES = ['generate', 'chatgpt', 'grok', 'prompt', 'text_extract'];
      if (HELP_SUPPORTED_TYPES.includes(nodeType)) {
        if (helpBody) helpBody.innerHTML = this._renderNodeHelpTab(nodeType);
        helpTab?.classList.remove('hidden');
      } else {
        helpTab?.classList.add('hidden');
      }

      // Reset to config tab
      const tabs = this.overlay.querySelectorAll('.node-form-tab');
      tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === 'config'));
      body.classList.remove('hidden');
      resultBody?.classList.add('hidden');
      helpBody?.classList.add('hidden');
      this.overlay.querySelector('#nodeFormFooter')?.classList.remove('hidden');

      panel.classList.remove('hidden');

      // [Admin/Shared preview] Disable all form inputs when read-only
      if (this.isReadOnly()) {
        panel.classList.add('wf-form-readonly');
        // Disable all inputs in body
        body.querySelectorAll('input, select, textarea').forEach(el => {
          el.disabled = true;
          el.setAttribute('readonly', 'readonly');
        });
        // Disable ALL buttons in panel (including header buttons) except close
        panel.querySelectorAll('button').forEach(btn => {
          if (btn.id !== 'closeNodeFormBtn') {
            btn.disabled = true;
          }
        });
      } else {
        panel.classList.remove('wf-form-readonly');
      }

      // Phase: sync visual của toggle enabled icon button trong node-form-header
      this._syncEnabledToggleVisual();

      // Render prompt source banner ở đầu form khi port "text" có upstream connection
      try { this._refreshAllPromptSourceBadges(); } catch (e) {}

      // --- Bind events based on node type ---
      this._bindNodeFormEvents(nodeType, data, nodeId);

      // Update provider status indicator for ChatGPT/Grok nodes
      if (nodeType === 'chatgpt' || nodeType === 'grok') {
        this._updateProviderStatusIndicator(nodeType);
      }

      // Flow Voice Selector — init voice picker cho flow_generate node (lazy init)
      if (nodeType === 'flow_generate' || nodeType === 'generate') {
        try { this._initNodeVoicePicker(data); } catch (e) { console.warn('[WorkflowEditor] voice picker init failed', e); }
      }

      // Track form edits to warn on unsaved changes (beforeunload)
      // Using { once: true } so it only fires once — first edit sets the flag
      body.addEventListener('input', () => { this._hasUnsavedChanges = true; }, { once: true });
      body.addEventListener('change', () => { this._hasUnsavedChanges = true; }, { once: true });

      // S2.5: Listen for upload events trong node form
      if (this._uploadStartedHandler) {
        window.eventBus?.off('upload:started', this._uploadStartedHandler);
      }
      this._uploadStartedHandler = (uploadData) => {
        const fileIdsInput = this.overlay?.querySelector('#nodeRefFileIds');
        if (fileIdsInput?.value) this._renderNodeRefPreview(fileIdsInput.value, this._getRefPreviewSelector());
        this._updateFormButtonState();
        // 2026-05-25 Option B: live-sync tempId vào Drawflow node.data → diagram
        // hiện loading thumbnail ngay (parity với paste image UX). Auto-save sau khi
        // upload completed (xem `_wfUploadCompletedHandler`).
        if (uploadData?.key) {
          try { this._syncFormUploadToDrawflowNode(uploadData.key); } catch (e) { /* ignore */ }
        }
      };
      window.eventBus?.on('upload:started', this._uploadStartedHandler);

      if (this._uploadCompletedHandler) {
        window.eventBus?.off('upload:completed', this._uploadCompletedHandler);
      }
      this._uploadCompletedHandler = (uploadData) => {
        const containerSel = this._getRefPreviewSelector();
        if (!uploadData?.key || !uploadData?.tile_id) {
          // Vẫn re-render để xóa CSS uploading (isUploading đã false)
          const fileIdsInput = this.overlay?.querySelector('#nodeRefFileIds');
          if (fileIdsInput?.value) this._renderNodeRefPreview(fileIdsInput.value, containerSel);
          this._updateFormButtonState();
          return;
        }
        // Bug fix: LUÔN sync node data trong Drawflow editor VÀ DOM input.
        // Trước fix: user switch form → _formUploadKeys cleared → upload xong nhưng không sync
        // → node.data vẫn giữ upload_xxx key → Local badge vẫn hiện.
        try {
          this._syncUploadKeyToAllNodes(uploadData);
        } catch (err) {
          console.error('[WorkflowEditor] _syncUploadKeyToAllNodes error:', err);
        }
        // LUÔN sync DOM input nếu form đang mở và input chứa upload key
        try {
          this._syncUploadKeyToTileId(uploadData);
        } catch (err) {
          console.error('[WorkflowEditor] _syncUploadKeyToTileId error:', err);
        }
        // Fallback: Sync DOM input từ Drawflow data nếu form đang mở
        // (đảm bảo DOM và Drawflow data đồng bộ)
        if (this._formNodeId && this.diagramCanvas?.editor) {
          const nodeObj = this.diagramCanvas.editor.getNodeFromId(this._formNodeId);
          const drawflowRefIds = nodeObj?.data?.ref_file_ids;
          const inputMap = {
            '#nodeRefImagesPreview': '#nodeRefFileIds',
            '#chatgptImageRefPreview': '#chatgptImageRefFileIds',
            '#grokNodeRefPreview': '#grokNodeRefFileIds',
            '#promptNodeRefPreview': '#promptNodeRefFileIds',
            '#imageNodeRefPreview': '#nodeRefFileIds',
          };
          const inputSelector = inputMap[containerSel] || '#nodeRefFileIds';
          const fileIdsInput = this.overlay?.querySelector(inputSelector);

          // Bug fix: Chỉ sync nếu Drawflow có ref_file_ids và chứa tile_id mới
          // Nếu Drawflow vẫn chưa có data (node mới, chưa save) → KHÔNG ghi đè DOM input
          if (fileIdsInput && drawflowRefIds && drawflowRefIds.includes(uploadData.tile_id)) {
            fileIdsInput.value = drawflowRefIds;
            this._renderNodeRefPreview(drawflowRefIds, containerSel);
          } else if (fileIdsInput?.value) {
            // Re-render với DOM input hiện tại thay vì ghi đè
            this._renderNodeRefPreview(fileIdsInput.value, containerSel);
          }
        }
        this._updateFormButtonState();
      };
      window.eventBus?.on('upload:completed', this._uploadCompletedHandler);

      if (this._uploadFailedHandler) {
        window.eventBus?.off('upload:failed', this._uploadFailedHandler);
      }
      this._uploadFailedHandler = (uploadData) => {
        console.log('[WorkflowEditor] upload:failed received:', uploadData?.key?.substring(0, 15), 'tracked:', this._formUploadKeys?.has(uploadData?.key));
        // Luôn re-render để xóa CSS uploading (isUploading đã false sau finally block)
        const fileIdsInput = this.overlay?.querySelector('#nodeRefFileIds');
        if (fileIdsInput?.value) this._renderNodeRefPreview(fileIdsInput.value, this._getRefPreviewSelector());
        // Re-render frame previews nếu upload key là frame
        for (const fNum of [1, 2]) {
          const frameInput = this.overlay?.querySelector(`#frame${fNum}FileId`);
          const fid = frameInput?.value?.trim();
          if (fid && fid.startsWith('upload_')) {
            this._renderFramePreview(fNum, fid);
          }
        }
        this._updateFormButtonState();
      };
      window.eventBus?.on('upload:failed', this._uploadFailedHandler);

      // Capture initial form snapshot for dirty check
      this._formSnapshot = this._captureFormSnapshot();

      // Reset header buttons visibility (undo hidden state from previous node)
      this.overlay.querySelector('#deleteNodeBtn')?.classList.remove('hidden');

      // Run button: only show if node has content AND has been saved
      // Bug fix: Grok/ChatGPT/Generate có upstream Prompt node qua port `text` →
      // node.prompt rỗng vẫn run được (runtime override từ upstream).
      let hasContent;
      if (nodeType === 'delay') hasContent = data.enabled !== false;
      else if (['note', 'image'].includes(nodeType)) hasContent = false;
      else {
        const hasOwnPrompt = !!(data.prompt && data.prompt.trim());
        if (hasOwnPrompt) {
          hasContent = true;
        } else {
          // Check upstream Prompt node qua port text/default
          const edges = this.workflow?.edges || [];
          const inputEdges = edges.filter((e) => e.target_node_id === data.node_id);
          hasContent = inputEdges.some((e) => {
            if (e.target_port && e.target_port !== 'text' && e.target_port !== 'default') return false;
            const src = this.workflow?.nodes?.find((n) => n.node_id === e.source_node_id);
            return src?.node_type === 'prompt';
          });
        }
      }
      const isNodeSaved = !!(data.node_id && this.workflow?.nodes?.some(n => n.node_id === data.node_id));
      const canRunNode = hasContent && isNodeSaved;
      const runBtn = this.overlay.querySelector('#runSingleNodeBtn');
      if (runBtn) {
        runBtn.classList.toggle('hidden', !canRunNode);
      }

      // Disable form if this node or workflow is currently running
      const isNodeRunning = data.status === 'running';
      const isWfRunning = window.workflowExecutor?.isRunning;
      if (isNodeRunning || isWfRunning) {
        this._setNodeFormDisabled(true);
      }

      // If node or workflow is running, hide run, reset & delete buttons
      if (isNodeRunning || isWfRunning) {
        this.overlay.querySelector('#runSingleNodeBtn')?.classList.add('hidden');
        this.overlay.querySelector('#resetSingleNodeBtn')?.classList.add('hidden');
        this.overlay.querySelector('#deleteNodeBtn')?.classList.add('hidden');
      }
      if (isNodeRunning) {
        tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === 'result'));
        body.classList.add('hidden');
        resultBody?.classList.remove('hidden');
        this.overlay.querySelector('#nodeFormFooter')?.classList.add('hidden');
      }

      // Show/hide download button based on result files
      this._updateDownloadButton();

      // Show/hide reset single node button (show when node has results or non-pending status)
      this._updateResetSingleNodeButton();

      // Force re-eval save button state — đảm bảo enabled khi không còn upload active
      // (defensive: tránh stale state từ session trước khi user open form sau run).
      this._updateFormButtonState();

      // Show ref_mode group only when >= 2 incoming sources connected
      this._updateRefModeVisibility();
    }
  }

  /**
   * Bind events cho frame source selector (frame 1 hoặc 2)
   */
  _bindFrameSourceEvents(frameNum, data) {
    const select = this.overlay?.querySelector(`#frame${frameNum}Source`);
    const manualDiv = this.overlay?.querySelector(`#frame${frameNum}Manual`);
    const nodeInfoDiv = this.overlay?.querySelector(`#frame${frameNum}NodeInfo`);
    const pickBtn = this.overlay?.querySelector(`#frame${frameNum}PickBtn`);

    select?.addEventListener('change', () => {
      const val = select.value;
      if (val === 'manual') {
        manualDiv?.classList.remove('hidden');
        nodeInfoDiv?.classList.add('hidden');
      } else if (val) {
        manualDiv?.classList.add('hidden');
        nodeInfoDiv?.classList.remove('hidden');
      } else {
        manualDiv?.classList.add('hidden');
        nodeInfoDiv?.classList.add('hidden');
      }
      // WK-1.7.frame-sync: form dropdown change → sync edge vào port frame_X
      // Dùng flag _suppressFrameSyncEdge để tránh loop khi change event do edge sync programmatic dispatch
      if (!select._suppressFrameSyncEdge) {
        try { this._syncEdgeFromFrameDropdown(frameNum, val); } catch (e) {
          console.warn('[WorkflowEditor] frame dropdown → edge sync failed:', e);
        }
      }
    });

    pickBtn?.addEventListener('click', () => this._openNodeFramePicker(frameNum));
  }

  /**
   * WK-1.7.frame-sync: dropdown frame_X_source thay đổi → đồng bộ edge vào port frame_X.
   * - newValue = node_id (uuid): xóa edge cũ, tạo edge mới từ port `media` của node đó.
   * - newValue = 'manual' hoặc '': xóa edge cũ (giữ frame_X_file_id để user dùng).
   */
  _syncEdgeFromFrameDropdown(frameNum, newValue) {
    const editor = this.diagramCanvas?.editor;
    if (!editor || !this.selectedNodeId) return;
    const targetDrawflowId = this.selectedNodeId;
    const targetNode = editor.getNodeFromId(targetDrawflowId);
    if (!targetNode) return;

    const targetPortName = `frame_${frameNum}`;
    const portMap = targetNode.data?._port_map || {};
    const inputClassEntry = Object.entries(portMap).find(
      ([k, v]) => v === targetPortName && k.startsWith('input_')
    );
    if (!inputClassEntry) return; // port không tồn tại (không phải Video+Frames mode)
    const inputClass = inputClassEntry[0];

    const sourceField = `frame_${frameNum}_source`;
    const fileIdField = `frame_${frameNum}_file_id`;
    const isNodeId = newValue && newValue !== 'manual' && newValue !== '';

    // Cập nhật node.data TRƯỚC khi thao tác edge → connectionCreated handler sẽ thấy
    // frame_X_source đã match → KHÔNG fire confirm dialog (đã xử lý từ dropdown).
    const currentData = targetNode.data || {};
    const newData = { ...currentData };
    if (isNodeId) {
      newData[sourceField] = newValue;
      newData[fileIdField] = ''; // edge override manual file
    } else if (newValue === 'manual') {
      newData[sourceField] = 'manual';
      // KHÔNG clear fileIdField — user có thể đã upload trước đó
    } else {
      newData[sourceField] = '';
      // KHÔNG clear fileIdField (giữ làm backup)
    }
    try {
      editor.updateNodeDataFromId(targetDrawflowId, newData);
    } catch (e) { /* ignore */ }

    // Đồng bộ hidden input để form save đọc đúng giá trị
    const fileIdInput = this.overlay?.querySelector(`#frame${frameNum}FileId`);
    if (fileIdInput) fileIdInput.value = newData[fileIdField] || '';

    // Xóa edge hiện tại vào port frame_X (nếu có)
    const existingConns = targetNode.inputs?.[inputClass]?.connections || [];
    for (const conn of existingConns.slice()) {
      try {
        // conn = { node: source_drawflow_id, input: output_class }
        editor.removeSingleConnection(conn.node, targetDrawflowId, conn.input, inputClass);
      } catch (e) { /* ignore */ }
    }

    // Nếu không pick node_id → dừng (manual hoặc rỗng đều không cần edge)
    if (!isNodeId) return;

    // Tạo edge mới từ port `media` của source node
    const sourceDrawflowId = this._findDrawflowId(newValue);
    if (!sourceDrawflowId) {
      console.warn('[WorkflowEditor] _syncEdgeFromFrameDropdown: source node not found:', newValue);
      return;
    }
    const sourceNode = editor.getNodeFromId(sourceDrawflowId);
    if (!sourceNode) return;

    // Tìm output port có name = 'media' (hoặc fallback output đầu tiên cho legacy nodes)
    const sourcePortMap = sourceNode.data?._port_map || {};
    let outputClass = Object.entries(sourcePortMap).find(
      ([k, v]) => v === 'media' && k.startsWith('output_')
    )?.[0];
    if (!outputClass) {
      // Fallback: pick output_1 (port đầu tiên) cho legacy nodes
      const firstOutput = Object.keys(sourceNode.outputs || {})[0];
      outputClass = firstOutput || 'output_1';
    }

    try {
      editor.addConnection(sourceDrawflowId, targetDrawflowId, outputClass, inputClass);
    } catch (e) {
      console.warn('[WorkflowEditor] addConnection failed:', e);
    }
  }

  /**
   * WK-1.7.frame-sync: Re-render dropdown frame_X_source khi DiagramCanvas đã update
   * node.data từ edge connect/disconnect. Chỉ apply nếu form đang mở cho node đó.
   */
  _refreshFrameDropdownsForNode(drawflowId, changedFields) {
    if (!drawflowId || !this.overlay) return;
    if (String(this.selectedNodeId) !== String(drawflowId)) return;
    const formPanel = this.overlay.querySelector('#nodeFormPanel');
    if (!formPanel || formPanel.classList.contains('hidden')) return;

    const node = this.diagramCanvas?.editor?.getNodeFromId(drawflowId);
    if (!node?.data) return;
    const data = node.data;

    const fields = Array.isArray(changedFields) ? changedFields : ['frame_1_source', 'frame_2_source', 'frame_1_file_id', 'frame_2_file_id'];
    [1, 2].forEach((n) => {
      const sourceField = `frame_${n}_source`;
      const fileIdField = `frame_${n}_file_id`;
      if (!fields.includes(sourceField) && !fields.includes(fileIdField)) return;

      const select = this.overlay.querySelector(`#frame${n}Source`);
      if (select && select.value !== (data[sourceField] || '')) {
        // Suppress edge sync để tránh loop (data đã do canvas sync set)
        select._suppressFrameSyncEdge = true;
        try {
          select.value = data[sourceField] || '';
          select.dispatchEvent(new Event('change'));
        } finally {
          select._suppressFrameSyncEdge = false;
        }
      }
      const fileIdInput = this.overlay.querySelector(`#frame${n}FileId`);
      if (fileIdInput && fileIdInput.value !== (data[fileIdField] || '')) {
        fileIdInput.value = data[fileIdField] || '';
        // Re-render preview thumbnail (clear nếu file_id rỗng)
        this._renderFramePreview(n, data[fileIdField] || '', '');
      }
    });
  }

  _openNodeFramePicker(frameNum) {
    const fileIdInput = this.overlay?.querySelector(`#frame${frameNum}FileId`);
    const existingIds = (fileIdInput?.value || '').split(',').filter(Boolean);
    if (window.imagePickerModal) {
      window.imagePickerModal.open({
        existingFileIds: existingIds,
        singleSelect: true,
        mediaFilter: 'image',
        onConfirm: async (images) => {
          if (images.length > 0) {
            const img = images[0];
            if (img.source === 'upload' && img.file) {
              const key = img.fileId || `upload_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
              if (!window.pendingUploadFiles) window.pendingUploadFiles = new Map();
              window.pendingUploadFiles.set(key, { file: img.file, thumbnail: img.thumbnail });
              this._tileCacheSet(key, { thumbnail: img.thumbnail, file_name: '', type: 'image' });
              if (window.ImmediateUploader) {
                ImmediateUploader.upload(img.file, img.thumbnail, { key }).catch(e => console.error('[WorkflowEditor] Frame upload failed:', key, e));
              } else if (window.PendingUploadStore) {
                PendingUploadStore.saveLightweight(key, { thumbnail: img.thumbnail, fileName: img.file.name, fileSize: img.file.size, fileType: img.file.type });
              }
              img.fileId = key;
              this._formUploadKeys?.add(key);
            } else if (img.source === 'album' && window.ImagePickerModal?.prepareAlbumImageForRef) {
              // Album image: xử lý qua prepareAlbumImageForRef
              try {
                const prepared = await window.ImagePickerModal.prepareAlbumImageForRef(img);
                if (prepared) {
                  const key = prepared.key;

                  // Cache thumbnail
                  let thumb = img.thumbnail;
                  if (img.thumbnail_url) {
                    thumb = img.thumbnail_url;
                  } else if (img.album_image_id && window.ImageStore) {
                    try {
                      const blobUrl = await window.ImageStore.getThumbnail(img.album_image_id);
                      if (blobUrl) thumb = blobUrl;
                    } catch (e) { /* ignore */ }
                  }
                  this._tileCacheSet(key, { thumbnail: thumb, file_name: prepared.file_name || '', type: 'image' });

                  // Upload ngay nếu là STALE image
                  if (key.startsWith('upload_')) {
                    const pendingFile = window.pendingUploadFiles?.get(key)?.file;
                    if (pendingFile && window.ImmediateUploader) {
                      ImmediateUploader.upload(pendingFile, img.thumbnail, { key }).catch(e => console.error('[WorkflowEditor] Frame album upload failed:', key, e));
                    }
                    this._formUploadKeys?.add(key);
                  }

                  img.fileId = key;
                  img.thumbnail = thumb;
                }
              } catch (err) {
                console.error('[WorkflowEditor] Lỗi chuẩn bị ảnh album cho frame:', err);
              }
            } else if (img.fileId && img.thumbnail) {
              this._tileCacheSet(img.fileId, { thumbnail: img.thumbnail, file_name: img.file_name || '', type: img.type || 'image' });
            }
            if (fileIdInput) fileIdInput.value = img.fileId || '';
            this._renderFramePreview(frameNum, img.fileId, img.thumbnail);
          }
        }
      });
    }
  }

  _renderFramePreview(frameNum, fileId, thumbnail) {
    const body = this.overlay?.querySelector(`#frame${frameNum}Body`);
    const fileIdInput = this.overlay?.querySelector(`#frame${frameNum}FileId`);
    const slot = this.overlay?.querySelector(`#nodeFrame${frameNum}Slot`);
    if (!body) return;

    if (!fileId) {
      slot?.classList.remove('has-image');
      body.innerHTML = `
        <div class="frame-dropzone" id="frame${frameNum}PickBtn">
          <svg class="frame-dropzone-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"></rect><line x1="12" y1="8" x2="12" y2="16"></line><line x1="8" y1="12" x2="16" y2="12"></line></svg>
          <span class="frame-dropzone-text">${window.I18n?.t('gen.addFrame') || 'Add'}</span>
        </div>
      `;
      // Re-bind click on dropzone
      const dropzone = body.querySelector('.frame-dropzone');
      if (dropzone) {
        dropzone.addEventListener('click', () => this._openNodeFramePicker(frameNum));
      }
      return;
    }

    // Tìm thumbnail từ cache hoặc pending
    if (!thumbnail) {
      const cached = this._tileCache.get(fileId);
      if (cached?.thumbnail) {
        thumbnail = cached.thumbnail;
      } else {
        const pending = window.pendingUploadFiles?.get(fileId);
        if (pending?.thumbnail) {
          thumbnail = pending.thumbnail;
        }
      }
    }

    const isPending = fileId.startsWith('upload_');
    const isUploading = isPending && window.ImmediateUploader?.isUploading(fileId);

    slot?.classList.add('has-image');
    body.innerHTML = `
      <div class="frame-thumb-wrap ${isUploading ? 'uploading' : ''}" data-file-id="${this.escapeAttr(fileId)}">
        ${thumbnail ? `<img src="${thumbnail}" alt="Frame ${frameNum}" />` : `<div class="frame-thumb-fallback">${fileId.substring(0, 12)}</div>`}
        <div class="ref-thumb-remove" title="${window.I18n?.t('common.delete') || 'Xóa'}"
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </div>
      </div>
    `;

    // Bind remove button
    body.querySelector('.ref-thumb-remove')?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (isPending && window.ImmediateUploader) {
        ImmediateUploader.cancel(fileId);
      }
      this._formUploadKeys?.delete(fileId);
      if (fileIdInput) fileIdInput.value = '';
      this._renderFramePreview(frameNum, '', '');
    });

    // Click thumbnail to re-pick
    const thumbWrap = body.querySelector('.frame-thumb-wrap');
    if (thumbWrap && !isUploading) {
      thumbWrap.addEventListener('click', (e) => {
        if (e.target.closest('.ref-thumb-remove')) return;
        this._openNodeFramePicker(frameNum);
      });
    }
  }

  async handleNodeImagePickerConfirm(images) {
    const fileIdsInput = this.overlay?.querySelector('#nodeRefFileIds');
    if (!fileIdsInput) return;

    const existingIds = fileIdsInput.value.split(',').map(s => s.trim()).filter(Boolean);

    // Tách ảnh Flow (đã có tile ID) và ảnh upload (cache file, chờ run mới upload)
    const flowImages = images.filter(img => img.source === 'flow' || img.source === 'existing');
    const uploadImages = images.filter(img => img.source === 'upload' && img.file);

    const newIds = flowImages.map(img => img.fileId).filter(Boolean);

    // Cache thumbnail cho Flow images vào _tileCache.
    // 2026-05-31: video tile có thể KHÔNG có thumbnail (no poster) nhưng có video_url →
    // vẫn cache để render layer dùng <video> element. Trước: skip nếu !thumbnail → mất tile.
    console.log('[WorkflowEditor] handleNodeImagePickerConfirm: caching', flowImages.length, 'flow images', flowImages.map(i => ({ id: i.fileId, type: i.type, hasThumb: !!i.thumbnail, hasVideoUrl: !!i.video_url })));
    for (const img of flowImages) {
      if (!img.fileId) continue;
      if (!img.thumbnail && !img.video_url) {
        console.warn('[WorkflowEditor] SKIP cache for', img.fileId, '- no thumbnail or video_url');
        continue;
      }
      this._tileCacheSet(img.fileId, {
        thumbnail: img.thumbnail || '',
        file_name: img.file_name || '',
        type: img.type || 'image',
        ...(img.video_url && { video_url: img.video_url }),
      });
    }

    // Xử lý ảnh album (ALIVE/STALE)
    const albumImages = images.filter(img => img.source === 'album');
    if (albumImages.length > 0) {
      for (const img of albumImages) {
        try {
          const prepared = await ImagePickerModal.prepareAlbumImageForRef(img);
          if (!prepared) continue;
          const key = prepared.key;
          // Cache thumbnail vào _tileCache
          this._tileCacheSet(key, {
            thumbnail: img.thumbnail,
            file_name: prepared.file_name || '',
            type: 'image'
          });
          newIds.push(key);
          // STALE: fire ImmediateUploader
          if (key.startsWith('upload_')) {
            const pendingFile = window.pendingUploadFiles?.get(key)?.file;
            if (pendingFile && window.ImmediateUploader) {
              ImmediateUploader.upload(pendingFile, img.thumbnail, { key }).catch(e => console.error('[WorkflowEditor] Upload failed:', key, e));
            }
            this._formUploadKeys?.add(key);
          }
        } catch (err) {
          console.error('[WorkflowEditor] Lỗi chuẩn bị ảnh album:', err);
        }
      }
    }

    // Cache ảnh upload local (IndexedDB + memory)
    if (uploadImages.length > 0) {
      if (!window.pendingUploadFiles) window.pendingUploadFiles = new Map();
      for (const img of uploadImages) {
        const key = img.fileId || `upload_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
        // Set memory ngay lập tức
        window.pendingUploadFiles.set(key, { file: img.file, thumbnail: img.thumbnail });
        // Cache thumbnail vào _tileCache (persistent qua upload lifecycle)
        this._tileCacheSet(key, { thumbnail: img.thumbnail, file_name: '', type: 'image' });
        // S2: Upload ngay nếu Flow tab mở, hoặc lưu lightweight pending
        if (window.ImmediateUploader) {
          ImmediateUploader.upload(img.file, img.thumbnail, { key }).catch(e => console.error('[WorkflowEditor] Generate node ref upload failed:', key, e));
        } else if (window.PendingUploadStore) {
          PendingUploadStore.saveLightweight(key, { thumbnail: img.thumbnail, fileName: img.file.name, fileSize: img.file.size, fileType: img.file.type });
        }
        newIds.push(key);
        this._formUploadKeys?.add(key);
      }
    }

    const mergedIds = [...new Set([...existingIds, ...newIds])];
    fileIdsInput.value = mergedIds.join(', ');

    this._renderNodeRefPreview(fileIdsInput.value, this._getRefPreviewSelector());

    // 2026-05-31 REVERTED: bỏ _syncDrawflowNodeData + _showNodeRefPreview ở đây vì gây
    // regression — updateNodeDataFromId trigger node re-render → mất result_thumbnail DOM,
    // mất các refs hiện có (regenerate from cache state nhưng cache stale). Node card sẽ
    // update khi user save node form qua flow chuẩn.
  }

  /**
   * Update ratio options based on media type
   * Bug 42d fix (2026-05-13): Source from PCM (admin tweak realtime via SSE) thay vì hardcoded.
   * Trước fix: hàm này override `<select id="nodeRatio">` template với hardcoded 5/2 options →
   * mọi update từ admin (thêm/xóa ratio) bị wipe sau khi user đổi media_type.
   */
  _updateNodeRatioOptions() {
    const ratioSelect = this.overlay?.querySelector('#nodeRatio');
    const mediaTypeSelect = this.overlay?.querySelector('#nodeMediaType');
    if (!ratioSelect) return;

    const isVideo = mediaTypeSelect?.value === 'Video';
    const currentValue = ratioSelect.value;

    // Source of truth: ProviderConfigManager.getRatiosSync('flow', mode) — admin tweakable.
    const mode = isVideo ? 'video' : 'image';
    const fallback = isVideo ? ['16:9', '9:16'] : ['16:9', '4:3', '1:1', '3:4', '9:16'];
    const ratios = (window.ProviderConfigManager?.safeGetRatiosSync?.('flow', mode)) || fallback;

    const _icon = (v) => {
      const s = String(v || '').trim();
      if (s === '16:9') return '▬';
      if (s === '4:3' || s === '3:2') return '▭';
      if (s === '1:1') return '□';
      if (s === '3:4' || s === '2:3') return '▯';
      if (s === '9:16') return '▮';
      return '◇';
    };

    const options = ratios.map(r => {
      const value = typeof r === 'string' ? r : r.value;
      return { value, label: `${_icon(value)} ${value}` };
    });
    ratioSelect.innerHTML = options.map(opt =>
      `<option value="${opt.value}">${opt.label}</option>`
    ).join('');

    // Restore value if valid, else fallback to default ratio from settings
    const validValues = options.map(o => o.value);
    if (validValues.includes(currentValue)) {
      ratioSelect.value = currentValue;
    } else {
      // Fallback to default ratio from settings
      chrome.storage.local.get(['af_settings'], (res) => {
        const settings = res.af_settings || {};

        // Ưu tiên key numeric mới (Settings popup), fallback legacy VN key
        const vnToNumeric = { 'Dọc': '9:16', 'Ngang': '16:9', 'Vuông': '1:1' };
        const legacyRatio = vnToNumeric[settings.defaultRatio] || settings.defaultRatio;
        const userDefault = isVideo
          ? (settings.defaultVideoRatio || legacyRatio)
          : (settings.defaultImageRatio || legacyRatio);

        // Cap về validValues nếu user setting không tương thích
        const defaultRatio = validValues.includes(userDefault) ? userDefault : '16:9';
        ratioSelect.value = defaultRatio;
      });
    }
  }

  /**
   * Render ref image preview thumbnails
   * @param {string} refFileIds - Comma-separated tile IDs
   * @param {string|number|object} containerSelectorOrOptions - Container selector, retry count, or options object
   * @param {number} retryCount - Retry count for missing thumbnails
   *
   * Options object: { containerSelector, retryCount, refFileNames }
   */
  _renderNodeRefPreview(refFileIds, containerSelectorOrOptions = '#nodeRefImagesPreview', retryCount = 0) {
    // Parse arguments - support multiple call patterns
    let containerSelector = '#nodeRefImagesPreview';
    let refFileNames = null;

    if (typeof containerSelectorOrOptions === 'number') {
      // Old pattern: _renderNodeRefPreview(fileIds, retryCount)
      retryCount = containerSelectorOrOptions;
    } else if (typeof containerSelectorOrOptions === 'object' && containerSelectorOrOptions !== null) {
      // New pattern: _renderNodeRefPreview(fileIds, { containerSelector, retryCount, refFileNames })
      containerSelector = containerSelectorOrOptions.containerSelector || '#nodeRefImagesPreview';
      retryCount = containerSelectorOrOptions.retryCount || 0;
      refFileNames = containerSelectorOrOptions.refFileNames || null;
    } else if (typeof containerSelectorOrOptions === 'string') {
      containerSelector = containerSelectorOrOptions;
    }

    const previewEl = this.overlay?.querySelector(containerSelector);
    // Bug fix: trước hardcode '#nodeRefFileIds' → ChatGPT/Grok/Prompt node dùng ID khác
    // (#chatgptImageRefFileIds, #grokNodeRefFileIds, #promptNodeRefFileIds) → fileIdsInput=null
    // → click remove ref_img silent no-op. Map theo containerSelector để resolve đúng input.
    const fileIdsInputMap = {
      '#nodeRefImagesPreview': '#nodeRefFileIds',
      '#chatgptImageRefPreview': '#chatgptImageRefFileIds',
      '#grokNodeRefPreview': '#grokNodeRefFileIds',
      '#promptNodeRefPreview': '#promptNodeRefFileIds',
      '#imageNodeRefPreview': '#nodeRefFileIds',
    };
    const fileIdsInputSelector = fileIdsInputMap[containerSelector] || '#nodeRefFileIds';
    const fileIdsInput = this.overlay?.querySelector(fileIdsInputSelector);
    if (!previewEl) return;

    const ids = (refFileIds || '').split(',').map(s => s.trim()).filter(Boolean);
    if (ids.length === 0) {
      previewEl.innerHTML = '';
      return;
    }

    // Check if we need remote scan for cross-project validation
    // ALWAYS fetch from content script if:
    // 1. Tiles not in local DOM (popup window can't access Flow DOM directly)
    // 2. Cached entries without file_name (need file_name for cross-project validation)
    // 3. No ref_file_names in workflow (old workflow - need to get current file_names for comparison)
    const hasRefFileNames = refFileNames && Object.keys(refFileNames).length > 0;
    const needsRemoteScan = ids.some(id => {
      if (id.startsWith('upload_')) return false;
      const cached = this._tileCache.get(id);
      // Need remote if: no cache, or cache has no file_name, or workflow has no ref_file_names (old workflow)
      if (!cached || !cached.file_name || !hasRefFileNames) return true;
      return false;
    });

    if (needsRemoteScan && typeof MessageBridge !== 'undefined' && retryCount === 0) {
      // Fetch ALL non-upload ids to get current file_names/thumbnails from Flow DOM
      const remoteIds = ids.filter(id => !id.startsWith('upload_'));

      // Render ngay với cache hiện tại (tránh gradient sweep kẹt khi chờ MessageBridge)
      this._renderNodeRefPreviewInner(ids, previewEl, fileIdsInput, 0, containerSelector, refFileNames);

      // Save OLD cache state BEFORE MessageBridge updates it (for comparison)
      const oldCacheState = {};
      for (const id of remoteIds) {
        const cached = this._tileCache.get(id);
        if (cached) {
          oldCacheState[id] = { ...cached };
        }
      }

      MessageBridge.getThumbnailsByIds(remoteIds).then(result => {
        const results = result?.results || {};

        // Detect cross-project by comparing old cache vs new results
        // CHỈ check cross-project khi workflow ĐÃ có ref_file_names (baseline từ lần save trước)
        // Workflow mới hoặc ảnh vừa upload chưa có file_name → skip để tránh false positive
        const crossProjectIds = [];
        for (const [fid, info] of Object.entries(results)) {
          const oldCache = oldCacheState[fid];

          // Cross-project detection: CHỈ dùng file_name (UUID, persistent, chính xác)
          // KHÔNG dùng thumbnail URL (khác params giữa upload result vs DOM → false positive)
          let isCrossProject = false;
          if (oldCache && hasRefFileNames) {
            const oldFileName = oldCache.file_name;
            const newFileName = info?.file_name;

            // Flag khi CẢ HAI đều có file_name và KHÁC nhau
            if (oldFileName && newFileName && oldFileName !== newFileName) {
              console.warn(`[WorkflowEditor] Cross-project collision: ${fid}, old=${oldFileName}, new=${newFileName}`);
              crossProjectIds.push(fid);
              isCrossProject = true;
            }
            // HOẶC khi có oldFileName (saved) nhưng DOM scan trả về tile KHÔNG có file_name
            // → tile có thể đang processing hoặc là tile sai → KHÔNG ghi đè
            else if (oldFileName && !newFileName) {
              console.warn(`[WorkflowEditor] Suspicious tile: ${fid}, saved=${oldFileName}, DOM has no file_name`);
              isCrossProject = true;
            }
          }

          // CRITICAL: Khi cross-project detected, KHÔNG ghi đè cache
          // Giữ thumbnail cũ (đúng) từ ref_thumbnails đã save
          if (isCrossProject) {
            const cached = this._tileCache.get(fid);
            if (cached) {
              cached._crossProject = true;
              this._tileCacheSet(fid, cached);
            } else {
              this._tileCacheSet(fid, { _crossProject: true });
            }
          } else {
            // 2026-05-31 fix: PRESERVE existing cache fields nếu info từ MessageBridge thiếu data.
            // Bug: MessageBridge return `info = {}` khi tile không trong Flow DOM → overwrite cache
            // với thumbnail=undefined → wipe data từ handleNodeImagePickerConfirm vừa pick → render broken.
            // Fix: merge với existing cache, chỉ overwrite field nào info có giá trị.
            const existing = this._tileCache.get(fid) || {};
            this._tileCacheSet(fid, {
              ...existing,
              ...(info?.thumbnail && { thumbnail: info.thumbnail }),
              ...(info?.type && { type: info.type }),
              ...(info?.file_name && { file_name: info.file_name }),
              ...(info?.video_url && { video_url: info.video_url }),
              _crossProject: false,
            });
          }
        }

        // Store cross-project IDs for render
        this._crossProjectRefIds = crossProjectIds;
        this._renderNodeRefPreviewInner(ids, previewEl, fileIdsInput, 0, containerSelector, refFileNames);
      }).catch((err) => {
        console.warn('[WorkflowEditor] MessageBridge error:', err);
        this._renderNodeRefPreviewInner(ids, previewEl, fileIdsInput, 0, containerSelector, refFileNames);
      });
      return;
    }

    this._renderNodeRefPreviewInner(ids, previewEl, fileIdsInput, retryCount, containerSelector, refFileNames);
  }

  /**
   * Extract file_name (UUID) from tile's redirect URL
   * Same logic as content.js extractFileName() for consistency
   * @param {Element} tile - Tile element
   * @returns {string|null} file_name UUID or null
   */
  _extractFileNameFromTile(tile) {
    if (!tile) return null;
    const _p = window._getMediaUrlPattern?.() || 'getMediaUrlRedirect';
    const candidates = [
      ...tile.querySelectorAll(`img[src*="${_p}"]`),
      ...tile.querySelectorAll(`a[href*="${_p}"]`),
      ...tile.querySelectorAll(`[src*="${_p}"]`)
    ];
    if (candidates.length === 0) {
      const img = tile.querySelector('img');
      if (img?.src?.includes(_p)) candidates.push(img);
    }

    for (const el of candidates) {
      const url = el.src || el.href;
      if (!url) continue;
      const fileName = this._extractFileNameFromUrl(url);
      if (fileName) return fileName;
    }
    return null;
  }

  /**
   * 2026-05-31: Detect tile loại video (URL Flow `?name=UUID` không có extension nên
   * filename-based regex fail). Check presence của `<video>` element trong tile DOM
   * (xem data/dom/flow-video-tile-file-dom.md). Cached.type='video' từ ImagePickerModal
   * cũng là source khác — caller check cả 2.
   */
  _isVideoTile(tile) {
    return !!(tile && tile.querySelector && tile.querySelector('video'));
  }

  _extractFileNameFromUrl(url) {
    const _p = window._getMediaUrlPattern?.() || 'getMediaUrlRedirect';
    if (!url || !url.includes(_p)) return null;
    try {
      const urlObj = new URL(url, window.location.origin);
      // Pattern 1: ?name=UUID (simple)
      const name = urlObj.searchParams.get('name');
      if (name && /^[a-f0-9-]{8,}$/i.test(name)) return name;
      // Pattern 2: tRPC ?input={"json":{"name":"UUID"}} or ?input={"0":{"json":{"name":"UUID"}}}
      const input = urlObj.searchParams.get('input');
      if (input) {
        const parsed = JSON.parse(decodeURIComponent(input));
        const json = parsed?.json || parsed?.['0']?.json || parsed;
        if (json?.name && /^[a-f0-9-]{8,}$/i.test(json.name)) return json.name;
      }
    } catch (e) { /* ignore parsing errors */ }
    return null;
  }

  /**
   * Map containerSelector → provider slug.
   * Post-audit fix: phân biệt node type để dùng đúng provider capability.
   */
  _resolveNodeProvider(containerSelector) {
    const map = {
      '#chatgptImageRefPreview': 'chatgpt',
      '#grokNodeRefPreview': 'grok',
      '#promptNodeRefPreview': 'flow',     // prompt node là Flow pass-through
      '#imageNodeRefPreview': 'flow',
      '#nodeRefImagesPreview': 'flow',     // generate node default
    };
    return map[containerSelector] || 'flow';
  }

  _getNodeRefLimit(containerSelector = '#nodeRefImagesPreview') {
    const mediaType = this.overlay?.querySelector('#nodeMediaType')?.value || 'Image';
    const videoInputType = this.overlay?.querySelector('#nodeVideoInputType')?.value || 'Frames';
    const isVideo = mediaType === 'Video';
    const isFrames = isVideo && videoInputType === 'Frames';

    // Post-audit fix: resolve theo provider của node thay vì luôn Flow.
    const provider = this._resolveNodeProvider(containerSelector);
    let resolvedMode = isVideo ? 'video' : 'image';
    if (provider === 'grok') {
      // Grok node có toggle riêng grok_mode (image/video)
      const grokMode = this.overlay?.querySelector('#grokNodeMode')?.value;
      if (grokMode) resolvedMode = grokMode.toLowerCase();
    }

    // 2026-05-22: pass modelValue + duration để detect rule conditional (vd Lite/Fast + duration<8s).
    const _wnrModelValue = this.overlay?.querySelector('#nodeVideoModel')?.value
      || this.overlay?.querySelector('#nodeImageModel')?.value
      || '';
    const _wnrDuration = this.overlay?.querySelector('#nodeVideoDuration')?.value || undefined;
    const resolved = (typeof ImagePickerModal !== 'undefined' && ImagePickerModal.resolveMaxSelections)
      ? ImagePickerModal.resolveMaxSelections({ provider, mode: resolvedMode, isFrames, modelValue: _wnrModelValue, duration: _wnrDuration })
      : null;
    // 0 = model không hỗ trợ ref → return 0 (caller hiển thị "0/0" disable picker hint).
    if (resolved === 0) return 0;
    if (typeof resolved === 'number' && resolved > 0) return resolved;

    // Post-audit fix: fallback PER-PROVIDER thay vì luôn Flow constants.
    // Bug trước: ProviderRegistry chưa bootstrap → resolved=null → fallback Flow 10 →
    // ChatGPT/Grok 5 ref images < 10 → isExceeded=false → KHÔNG có ref-thumb-exceeded class.
    if (provider === 'chatgpt' || provider === 'grok' || provider === 'gemini') {
      return 4; // ChatGPT/Grok/Gemini: 4 ref images max (match adapter capabilities)
    }
    // Flow fallback (legacy constants)
    if (isVideo && !isFrames) return WorkflowEditor.REF_LIMIT_VIDEO;
    return WorkflowEditor.REF_LIMIT_IMAGE;
  }

  _truncateRefFileIds(fileIdsStr, containerSelector) {
    if (!fileIdsStr) return fileIdsStr;
    const refLimit = this._getNodeRefLimit(containerSelector);
    const ids = fileIdsStr.split(',').map(s => s.trim()).filter(Boolean);
    if (ids.length > refLimit) {
      // Giữ MỚI NHẤT (slice cuối) — ảnh user vừa thêm thắng, không kẹt ref cũ.
      console.log(`[WorkflowEditor] Ref images vượt giới hạn (${ids.length}/${refLimit}), giữ ${refLimit} ảnh mới nhất`);
      return ids.slice(-refLimit).join(', ');
    }
    return fileIdsStr;
  }

  _renderNodeRefPreviewInner(ids, previewEl, fileIdsInput, retryCount, containerSelector, refFileNames = null) {
    let hasMissing = false;
    let crossProjectMismatch = false;
    const refLimit = this._getNodeRefLimit(containerSelector);

    previewEl.innerHTML = ids.map((id, index) => {
      let thumbSrc = '';
      let isMismatch = false;
      const isPending = id.startsWith('upload_');
      const pending = window.pendingUploadFiles?.get(id);
      const expectedFileName = refFileNames?.[id] || null;
      const cached = this._tileCache.get(id);

      // Skip cross-project check for import keys — they're pending uploads from CDN, not cross-project refs
      const isImportKey = id.startsWith('upload_import_');
      const isCrossProjectFromBridge = !isImportKey && (this._crossProjectRefIds?.includes(id) || cached?._crossProject);

      if (pending?.thumbnail) {
        thumbSrc = pending.thumbnail;
      } else if (isImportKey) {
        // Import keys: get thumbnail from cache (populated from ref_thumbnails during import)
        // Skip DOM check and cross-project validation — these are pending uploads from CDN
        thumbSrc = cached?.thumbnail;
      } else if (isCrossProjectFromBridge) {
        // Already detected as cross-project by MessageBridge thumbnail/file_name comparison
        console.warn(`[WorkflowEditor] Cross-project from bridge check: ${id}`);
        isMismatch = true;
        crossProjectMismatch = true;
        // Still show the NEW thumbnail (from current project) but with warning
        thumbSrc = cached?.thumbnail;
      } else {
        // Check DOM (won't find anything in popup, but keep for sidebar context).
        // 2026-05-31 v3: pattern parity với _loadResultGalleryThumbnails — ưu tiên <video>
        // trước (video tile có thể có cả <img> + <video>, lấy video src để render <video>
        // element thay vì placeholder static).
        const tiles = document.querySelectorAll(`[data-tile-id="${id}"]`);
        let domFileName = null;
        let domThumbSrc = null;
        let domIsVideo = false;
        let domVideoSrc = null;

        for (const tile of tiles) {
          domFileName = this._extractFileNameFromTile(tile);
          // Check <video> FIRST — Flow video tile có src direct dùng được trong <video>
          const videoEl = tile.querySelector('video');
          if (videoEl?.src) {
            domVideoSrc = videoEl.src;
            domIsVideo = true;
            break;
          }
          const imgEl = tile.querySelector('img');
          if (imgEl?.src) {
            domThumbSrc = imgEl.src;
            domIsVideo = false;
            break;
          }
          // Fallback: tile có <video> element không src → đánh marker để render placeholder
          if (this._isVideoTile(tile)) {
            domIsVideo = true;
          }
        }
        // Cập nhật cache type='video' + video_url để lần render sau (workflow reload) có sẵn signal
        if (domIsVideo && cached && (cached.type !== 'video' || (domVideoSrc && !cached.video_url))) {
          this._tileCacheSet(id, { ...cached, type: 'video', ...(domVideoSrc && { video_url: domVideoSrc }) });
        }

        // Cross-project detection for new workflows with ref_file_names
        // Skip for import keys — they're pending uploads from CDN, not cross-project refs
        if (expectedFileName && !isImportKey) {
          if (domFileName && domFileName !== expectedFileName) {
            console.warn(`[WorkflowEditor] Cross-project collision (expected): tile_id=${id}, expected=${expectedFileName}, actual=${domFileName}`);
            isMismatch = true;
            crossProjectMismatch = true;
          } else if (cached?.file_name && cached.file_name !== expectedFileName) {
            console.warn(`[WorkflowEditor] Cross-project collision (cached): tile_id=${id}, expected=${expectedFileName}, cached=${cached.file_name}`);
            isMismatch = true;
            crossProjectMismatch = true;
          }
        }

        // Use DOM thumbnail if available and not mismatch, else fallback to cache
        if (!isMismatch) {
          if (domThumbSrc) {
            thumbSrc = domThumbSrc;
          } else if (cached?.thumbnail) {
            thumbSrc = cached.thumbnail;
          }
        } else {
          // Show NEW thumbnail with warning
          thumbSrc = cached?.thumbnail;
        }
      }

      if ((!thumbSrc && !isPending) || isMismatch) hasMissing = true;

      // Show warning indicator for cross-project mismatch
      // S2.5: Check upload trạng thái
      const isUploading = isPending && window.ImmediateUploader?.isUploading(id);
      const isExceeded = index >= refLimit;

      // Border color theo state:
      //   - mismatch (cross-project): destructive (đỏ)
      //   - uploading: primary brand (đồng bộ với spinner uploading)
      //   - pending import key: primary blue
      //   - pending local (chưa upload): warning amber
      //   - default: border subtle
      const borderColor = isMismatch
        ? 'var(--destructive,#dc2626)'
        : (isUploading
            ? 'var(--primary,#ccff00)'
            : (isPending
                ? (isImportKey ? 'var(--primary,#3b82f6)' : 'var(--warning,#f59e0b)')
                : 'var(--border,#1e3050)'));
      const mismatchLabel = isMismatch ? '<div style="position:absolute;bottom:0;left:0;right:0;background:var(--destructive,#dc2626);color:#fff;font-size:6px;text-align:center;line-height:1.4;border-radius:0 0 6px 6px;z-index:5;">Sai project</div>' : '';

      // Cross-project: show gradient sweep animation with warning icon (don't show cached thumbnail)
      const crossProjectIcon = isMismatch ? `
        <svg class="cross-project-icon" style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);color:var(--destructive,#dc2626);opacity:0.7;z-index:1;" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
          <line x1="12" y1="9" x2="12" y2="13"></line>
          <line x1="12" y1="17" x2="12.01" y2="17"></line>
        </svg>` : '';

      const exceededTitle = isExceeded ? ` title="${window.I18n?.t('workflow.refExceededTitle', { limit: refLimit }) || `Vượt giới hạn (tối đa ${refLimit} ảnh) — sẽ không được gửi kèm prompt`}"` : '';
      const uploadingLabel = window.I18n?.t('workflow.uploading') || 'Uploading';
      const uploadingDataAttr = isUploading ? ` data-upload-label="${this.escapeAttr(uploadingLabel)}" title="${this.escapeAttr(uploadingLabel + '...')}"` : '';
      // 2026-05-31 v4: detect video tile — KHÔNG còn yêu cầu !thumbSrc (trước: nếu cache có
      // thumbnail = Flow API video URL → isVideoFile=false → render <img> broken).
      // 3 signals video (any match → video tile):
      //   1. file_name có extension .mp4/.webm/.mov/.m4v
      //   2. cached.type === 'video' (ImagePickerModal/scan set khi pick từ Flow)
      //   3. DOM tile có <video> element (workflow loaded từ DB)
      const fileName = expectedFileName || cached?.file_name || '';
      // 2026-05-31 v5: detect video CHỈ qua type='video' / extension / DOM <video> element.
      // BỎ thumbIsVideoUrl detect — Flow `getMediaUrlRedirect` URL dùng chung image + video → ambiguous!
      const isVideoTile = (
        /\.(mp4|webm|mov|m4v)$/i.test(fileName) ||
        cached?.type === 'video' ||
        (typeof domIsVideo !== 'undefined' && domIsVideo)
      );
      // Best video URL nguồn: DOM <video src> > cached.video_url
      const videoSrcForRender = (typeof domVideoSrc !== 'undefined' && domVideoSrc)
        || cached?.video_url
        || '';
      // useVideoElement: chỉ render <video> nếu là video tile + có URL hợp lệ.
      const useVideoElement = isVideoTile && !!videoSrcForRender;
      // useImgElement: image tile có thumbnail. Bao gồm video tile có poster image.
      const useImgElement = !useVideoElement && thumbSrc;
      const videoMediaHtml = useVideoElement
        ? `<video src="${videoSrcForRender}" muted loop autoplay playsinline style="width:100%;height:100%;object-fit:cover;display:block;"></video>`
        : (isVideoTile
          ? `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:rgba(99,102,241,0.08);color:var(--primary,#6366f1);">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                <path d="M8 5v14l11-7z"/>
              </svg>
            </div>`
          : '');
      // 2026-05-31 Rescan Tier 2: broken state — chỉ khi KHÔNG render được gì (no img, no video).
      const isBroken = !useImgElement && !useVideoElement && !isVideoTile && !isPending && !isMismatch;
      const isPermanentlyBroken = isBroken && cached?._permanently_broken;
      const brokenContent = isBroken ? (isPermanentlyBroken ? `
        <div class="ref-thumb-broken" title="${this.escapeAttr(window.I18n?.t('workflow.thumbDeletedWarning') || 'Tile đã bị xóa khỏi Flow')}">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--destructive,#dc2626)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
          <span class="ref-thumb-broken-id">${id.substring(0, 8)}</span>
        </div>` : `
        <div class="ref-thumb-broken">
          <svg class="ref-thumb-broken-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
          <span class="ref-thumb-broken-id">${id.substring(0, 8)}</span>
          <button class="ref-thumb-rescan-btn" data-ref-rescan-id="${this.escapeAttr(id)}" title="${this.escapeAttr(window.I18n?.t('workflow.thumbBrokenRescan') || 'Rescan từ Flow')}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
          </button>
        </div>`) : '';
      return `
        <div class="ref-thumb ${isPending ? 'ref-thumb-pending' : ''} ${isUploading ? 'ref-thumb-uploading' : ''} ${isMismatch ? 'ref-thumb-cross-project' : ''} ${isExceeded ? 'ref-thumb-exceeded' : ''}" data-ref-id="${this.escapeAttr(id)}"${uploadingDataAttr}${exceededTitle}>
          <div style="width:100%;height:100%;border-radius:6px;overflow:hidden;border:2px solid ${borderColor};position:relative;">
            ${isMismatch ? '' : (useVideoElement ? videoMediaHtml : (useImgElement ? `<img src="${thumbSrc}" alt="ref" style="width:100%;height:100%;object-fit:cover;display:block;" />` : (isVideoTile ? videoMediaHtml : brokenContent)))}
            ${crossProjectIcon}
            ${isPending ? `<div class="ref-thumb-badge" style="position:absolute;bottom:0;left:0;right:0;background:${isImportKey ? 'var(--primary,#3b82f6)' : 'var(--warning,#f59e0b)'};color:#000;font-size:7px;text-align:center;line-height:1.4;border-radius:0 0 4px 4px;z-index:5;">${isImportKey ? 'Import' : 'Local'}</div>` : ''}
            ${mismatchLabel}
          </div>
          <button class="ref-thumb-remove" title="${window.I18n?.t('workflow.removeThisImage') || 'Xóa ảnh này'}" style="position:absolute;top:-4px;right:-4px;width:18px;height:18px;border-radius:50%;background:var(--destructive,#dc2626);color:#fff;display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:12px;line-height:1;z-index:10;border:none;padding:0;">×</button>
        </div>`;
    }).join('');

    // 2026-05-31 Rescan Tier 2: bind click handler cho rescan buttons (sau khi innerHTML set)
    previewEl.querySelectorAll('[data-ref-rescan-id]').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const refId = btn.dataset.refRescanId;
        if (!refId) return;
        await this._rescanRefThumbnail(refId, btn);
      });
    });

    // Reactive video detect: <img> load fail = URL trả mp4 bytes (video tile) →
    // swap sang <video> + heal cache để render sau dùng <video> trực tiếp.
    previewEl.querySelectorAll('.ref-thumb img').forEach(img => {
      if (img._errBound) return;
      img._errBound = true;
      img.addEventListener('error', () => {
        const refThumb = img.closest('[data-ref-id]');
        const tileId = refThumb?.dataset.refId;
        const url = img.src;
        if (!tileId || !url) return;
        const video = document.createElement('video');
        video.src = url;
        video.muted = true; video.playsInline = true; video.preload = 'metadata';
        video.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block;background:#0c1320;';
        video.addEventListener('loadedmetadata', () => { try { video.currentTime = 0.1; } catch (_) {} }, { once: true });
        img.parentNode?.replaceChild(video, img);
        this._tileCacheSet(tileId, { ...(this._tileCache.get(tileId) || {}), type: 'video', video_url: url });
      }, { once: true });
    });

    // Retry nếu tile chưa có thumbnail (vừa upload xong)
    if (hasMissing && retryCount < 3) {
      setTimeout(() => {
        const currentValue = fileIdsInput?.value || '';
        if (currentValue) this._renderNodeRefPreview(currentValue, { containerSelector, retryCount: retryCount + 1, refFileNames });
      }, 1500);
    } else if (hasMissing && retryCount >= 3 && !this._missingRefWarned && !this.isReadOnly()) {
      // Skip warning cho admin preview / shared preview - chỉ xem, không cần cảnh báo
      this._missingRefWarned = true;
      const missingCount = ids.filter(id => {
        if (id.startsWith('upload_')) return false;
        if (this._tileCache.has(id)) return false;
        const tiles = document.querySelectorAll(`[data-tile-id="${id}"]`);
        return tiles.length === 0;
      }).length;

      if (crossProjectMismatch && !this._crossProjectWarned) {
        this._crossProjectWarned = true;
        window.customDialog?.alert(
          window.I18n?.t('workflow.crossProjectRefDetected') || 'Phát hiện ảnh tham chiếu từ project khác. Tile ID trùng nhưng file khác. Hãy chọn lại ảnh từ project hiện tại.',
          { title: window.I18n?.t('workflow.wrongProject') || 'Sai project', type: 'error' }
        );
      } else if (missingCount > 0) {
        window.customDialog?.alert(
          window.I18n?.t('workflow.missingRefImages', { count: missingCount }) || `${missingCount} reference images not found on Flow. Images may have been deleted or session changed. Check and reselect if needed.`,
          { title: window.I18n?.t('workflow.missingRefTitle') || 'Missing reference images', type: 'warning' }
        );
      }
    }

    // Event delegation: bind 1 lần duy nhất trên container, không bị mất khi retry re-render
    if (!previewEl._refRemoveDelegated) {
      previewEl._refRemoveDelegated = true;
      previewEl.addEventListener('click', (e) => {
        const removeBtn = e.target.closest('.ref-thumb-remove');
        if (!removeBtn) return;
        e.stopPropagation();
        e.preventDefault();
        const thumb = removeBtn.closest('.ref-thumb');
        const removeId = thumb?.dataset.refId;
        if (removeId && fileIdsInput) {
          const currentIds = fileIdsInput.value.split(',').map(s => s.trim()).filter(Boolean);
          const filtered = currentIds.filter(id => id !== removeId);
          fileIdsInput.value = filtered.join(', ');
          if (removeId.startsWith('upload_')) {
            if (window.ImmediateUploader) ImmediateUploader.cancel(removeId);
            else window.pendingUploadFiles?.delete(removeId);
            this._formUploadKeys?.delete(removeId);
          }
          this._renderNodeRefPreview(fileIdsInput.value, containerSelector);
        }
      });
    }
  }

  /**
   * S2.5: Sync upload_xxx key → real tile_id sau khi ImmediateUploader upload xong
   * @param {Object} data - {key, tile_id, file_name, thumbnail_url}
   */
  _syncUploadKeyToTileId(data) {
    const { key, tile_id, file_name, thumbnail_url } = data;

    // Bug fix: Trước đây chỉ check #nodeRefFileIds (generate node) → ChatGPT/Grok/Prompt
    // node có riêng input ID (#chatgptImageRefFileIds, #grokNodeRefFileIds, #promptNodeRefFileIds)
    // → upload xong nhưng input value vẫn chứa upload_xxx key → ref preview render gradient sweep forever.
    // Sửa: scan TẤT CẢ ref input candidates, update bất kỳ input nào chứa upload key.
    const refInputSelectors = [
      '#nodeRefFileIds',
      '#chatgptImageRefFileIds',
      '#grokNodeRefFileIds',
      '#promptNodeRefFileIds',
    ];
    let fileIdsInput = null;
    for (const sel of refInputSelectors) {
      const inp = this.overlay?.querySelector(sel);
      if (!inp) continue;
      const ids = inp.value.split(',').map(s => s.trim()).filter(Boolean);
      const idx = ids.indexOf(key);
      if (idx !== -1) {
        ids[idx] = tile_id;
        inp.value = ids.join(', ');
        fileIdsInput = inp;
      }
    }
    // Remove from tracking
    this._formUploadKeys.delete(key);
    // Transfer thumbnail cache: upload_key → tile_id (giống GenTab pattern)
    const oldCache = this._tileCache.get(key);
    if (oldCache) {
      this._tileCacheSet(tile_id, oldCache);
      this._tileCache.delete(key);
    }
    // Override bằng thumbnail_url từ Flow nếu có
    if (thumbnail_url) {
      this._tileCacheSet(tile_id, { thumbnail: thumbnail_url, file_name: file_name || '', type: 'image' });
    }
    // Đảm bảo file_name được cập nhật
    if (file_name) {
      const cached = this._tileCache.get(tile_id);
      if (cached) cached.file_name = file_name;
    }
    // Cleanup pendingUploadFiles
    window.pendingUploadFiles?.delete(key);
    // Cleanup ImmediateUploader results (tránh memory leak)
    if (window.ImmediateUploader) {
      ImmediateUploader._results.delete(key);
      ImmediateUploader._fileRefs.delete(key);
    }
    // Cache trong TileCache
    if (window.TileCache) {
      if (file_name) window.TileCache.set(file_name, tile_id);
      if (thumbnail_url) window.TileCache.set(thumbnail_url, tile_id);
    }
    // Sync frame file ID inputs nếu upload key match
    for (const fNum of [1, 2]) {
      const frameInput = this.overlay?.querySelector(`#frame${fNum}FileId`);
      if (frameInput && frameInput.value === key) {
        frameInput.value = tile_id;
        const thumb = thumbnail_url || this._tileCache.get(tile_id)?.thumbnail || '';
        this._renderFramePreview(fNum, tile_id, thumb);
      }
    }
    // CRITICAL: Update node.data.ref_file_ids trong Drawflow editor (không chỉ DOM input)
    // Trước fix: chỉ update DOM input → node.data vẫn giữ upload_xxx key → re-render
    // hoặc save node sẽ dùng lại key cũ → Local badge vẫn hiện sau upload xong.
    // Bug fix: Dùng _formNodeId (node có form đang mở) thay vì _currentEditNodeId (không tồn tại).
    if (this._formNodeId && this.diagramCanvas?.editor) {
      const drawflowId = this._formNodeId;
      const nodeObj = this.diagramCanvas.editor.getNodeFromId(drawflowId);
      if (nodeObj?.data?.ref_file_ids) {
        const dataIds = nodeObj.data.ref_file_ids.split(',').map(s => s.trim()).filter(Boolean);
        const dataIdx = dataIds.indexOf(key);
        if (dataIdx !== -1) {
          dataIds[dataIdx] = tile_id;
          nodeObj.data.ref_file_ids = dataIds.join(', ');
        }
      }
    }

    // Re-render node ref preview (dùng đúng container cho node type hiện tại)
    this._renderNodeRefPreview(fileIdsInput?.value || '', this._getRefPreviewSelector());

    // CRITICAL: Re-persist ref_file_names vào node data sau khi ImmediateUploader hoàn thành
    // Nếu không, file_names từ upload mới sẽ bị mất khi save workflow
    if (this._formNodeId && this.diagramCanvas?.editor) {
      const drawflowId = this._formNodeId;
      const nodeObj = this.diagramCanvas.editor.getNodeFromId(drawflowId);
      if (nodeObj?.data) {
        this._persistRefThumbnails(drawflowId, nodeObj.data);
        this._deferredThumbnailSave();
      }
    }

    console.log(`[WorkflowEditor] Synced upload key → tile_id: ${key.substring(0, 15)}... → ${tile_id.substring(0, 15)}...`);
  }

  /**
   * Sync upload_xxx → tile_id cho TẤT CẢ nodes trong workflow (không phụ thuộc form state).
   * Bug fix: Trước đây chỉ sync khi form đang mở và key trong _formUploadKeys.
   * Nếu user switch form trước khi upload xong → _formUploadKeys cleared → không sync.
   * @param {Object} data - {key, tile_id, file_name, thumbnail_url}
   */
  _syncUploadKeyToAllNodes(data) {
    const { key, tile_id, file_name, thumbnail_url } = data;
    if (!key || !tile_id || !this.diagramCanvas?.editor) return;

    // CRITICAL: Drawflow's `getNodeFromId` AND `export()` ĐỀU return DEEP CLONE
    // (JSON.parse(JSON.stringify(...))). Mutation trực tiếp KHÔNG persist vào live state.
    // Phải dùng `editor.updateNodeDataFromId(drawflowId, newData)` để persist.
    // Trước fix: paste image upload xong nhưng node data vẫn giữ upload_xxx →
    // node loading mãi vì preview re-render đọc state cũ + ref preview vẫn label Local.
    const editor = this.diagramCanvas.editor;
    const homeData = editor.drawflow?.drawflow?.Home?.data || {};
    let updatedCount = 0;

    for (const [drawflowId, nodeInfo] of Object.entries(homeData)) {
      const currentData = nodeInfo?.data;
      if (!currentData?.ref_file_ids) continue;

      const ids = currentData.ref_file_ids.split(',').map(s => s.trim()).filter(Boolean);
      const idx = ids.indexOf(key);
      if (idx === -1) continue;

      // Build new data (shallow clone + replace key)
      ids[idx] = tile_id;
      const newRefIds = ids.join(', ');

      const newRefThumbnails = { ...(currentData.ref_thumbnails || {}) };
      // Giữ thumbnail dataURL local nếu server không trả thumbnail_url
      const existingThumb = newRefThumbnails[key];
      newRefThumbnails[tile_id] = thumbnail_url || existingThumb;
      delete newRefThumbnails[key];

      const newRefFileNames = { ...(currentData.ref_file_names || {}) };
      if (file_name) {
        newRefFileNames[tile_id] = file_name;
      } else if (newRefFileNames[key]) {
        newRefFileNames[tile_id] = newRefFileNames[key];
      }
      delete newRefFileNames[key];

      const newData = {
        ...currentData,
        ref_file_ids: newRefIds,
        ref_thumbnails: newRefThumbnails,
        ref_file_names: newRefFileNames,
      };

      // Persist qua Drawflow API (mutate live state)
      try {
        editor.updateNodeDataFromId(drawflowId, newData);
      } catch (err) {
        console.warn('[WorkflowEditor] updateNodeDataFromId failed:', err?.message);
        continue;
      }

      // Update _tileCache
      this._tileCacheSet(tile_id, {
        thumbnail: thumbnail_url || this._tileCache.get(key)?.thumbnail || existingThumb || '',
        file_name: file_name || this._tileCache.get(key)?.file_name || '',
        type: 'image'
      });

      updatedCount++;
      console.log(`[WorkflowEditor] _syncUploadKeyToAllNodes: updated node ${drawflowId}, key=${key.substring(0, 15)}... → tile_id=${tile_id.substring(0, 15)}...`);
    }

    // Cleanup old key from caches
    if (updatedCount > 0) {
      this._tileCache.delete(key);
      window.pendingUploadFiles?.delete(key);
      if (window.ImmediateUploader) {
        ImmediateUploader._results?.delete(key);
        ImmediateUploader._fileRefs?.delete(key);
      }
    }
  }

  /**
   * Trả về container selector cho ref preview dựa trên node type hiện tại.
   * Mỗi provider có riêng container ID:
   *   - generate (default) / image  → #nodeRefImagesPreview / #imageNodeRefPreview
   *   - chatgpt                      → #chatgptImageRefPreview
   *   - grok                         → #grokNodeRefPreview
   *   - prompt                       → #promptNodeRefPreview
   */
  _getRefPreviewSelector() {
    const t = this._currentFormNodeType;
    if (t === 'image') return '#imageNodeRefPreview';
    if (t === 'chatgpt') return '#chatgptImageRefPreview';
    if (t === 'grok') return '#grokNodeRefPreview';
    if (t === 'prompt') return '#promptNodeRefPreview';
    return '#nodeRefImagesPreview';
  }

  /**
   * Check nếu có upload đang chạy trong form
   * @returns {number} Số lượng uploads đang active
   */
  _countActiveFormUploads() {
    if (!this._formUploadKeys?.size || !window.ImmediateUploader) return 0;
    let count = 0;
    for (const key of this._formUploadKeys) {
      if (ImmediateUploader.isUploading(key)) count++;
    }
    return count;
  }

  /**
   * Disable/enable nút Lưu và Đóng khi đang upload ảnh
   */
  _updateFormButtonState() {
    // Read-only mode: keep all buttons disabled
    if (this.isReadOnly()) return;

    const isUploading = this._countActiveFormUploads() > 0;
    const saveBtn = this.overlay?.querySelector('#saveNodeBtn');
    const closeBtn = this.overlay?.querySelector('#closeNodeFormBtn2');
    if (saveBtn) {
      saveBtn.disabled = isUploading;
      saveBtn.title = isUploading ? (window.I18n?.t('workflow.uploadingRefImages') || 'Uploading reference images...') : '';
      saveBtn.textContent = isUploading
        ? (window.I18n?.t('workflow.uploading') || 'Uploading...')
        : (window.I18n?.t('workflow.saveNode') || 'Lưu Node');
    }
    if (closeBtn) {
      closeBtn.disabled = isUploading;
      closeBtn.title = isUploading ? (window.I18n?.t('workflow.uploadingRefImages') || 'Uploading reference images...') : '';
    }
  }

  async hideNodeForm({ skipUploadCheck = false } = {}) {
    // S2.5: Check uploads đang chạy → confirm trước khi đóng
    if (!skipUploadCheck) {
      const activeCount = this._countActiveFormUploads();
      if (activeCount > 0) {
        const confirmed = await window.customDialog?.confirm(
          window.I18n?.t('workflow.uploadCloseConfirm', { count: activeCount }) || `Uploading ${activeCount} reference images. Closing form will cancel upload. Continue?`,
          { title: window.I18n?.t('workflow.uploadInProgress') || 'Images uploading', type: 'warning', confirmText: window.I18n?.t('workflow.closeAndCancel') || 'Close and cancel', cancelText: window.I18n?.t('workflow.continueUpload') || 'Continue upload' }
        );
        if (!confirmed) return;
      }
    }

    // S2.5: Cleanup upload event listeners
    if (this._uploadStartedHandler) {
      window.eventBus?.off('upload:started', this._uploadStartedHandler);
      this._uploadStartedHandler = null;
    }
    if (this._uploadCompletedHandler) {
      window.eventBus?.off('upload:completed', this._uploadCompletedHandler);
      this._uploadCompletedHandler = null;
    }
    if (this._uploadFailedHandler) {
      window.eventBus?.off('upload:failed', this._uploadFailedHandler);
      this._uploadFailedHandler = null;
    }

    // Clear provider polling timers
    if (this._providerPollTimers) {
      for (const provider of Object.keys(this._providerPollTimers)) {
        clearTimeout(this._providerPollTimers[provider]);
      }
      this._providerPollTimers = {};
    }

    // S2.5: Cancel uploads chưa được lưu khi đóng form
    if (this._formUploadKeys?.size > 0) {
      // Lấy IDs đang trong form — nếu đã save thì không cancel
      const formInput = this.overlay?.querySelector('#nodeRefFileIds');
      const savedIds = new Set((formInput?.value || '').split(',').map(s => s.trim()).filter(Boolean));
      for (const key of this._formUploadKeys) {
        if (!savedIds.has(key)) {
          // Key không còn trong form (đã bị remove) — cancel
          if (window.ImmediateUploader) ImmediateUploader.cancel(key);
          else window.pendingUploadFiles?.delete(key);
        }
      }
      this._formUploadKeys.clear();
    }

    const panel = this.overlay?.querySelector('#nodeFormPanel');

    // Apply form data trước khi đóng để tránh mất changes
    // (vd user chỉnh resolution rồi đóng form → changes bị mất nếu không apply)
    // CHỈ apply nếu form panel đang visible - tránh overwrite inline pill changes
    // khi user chỉ click ra ngoài mà không mở form
    // Bug fix: KHÔNG apply trong read-only mode (template preview) - không có gì cần save
    // Bug fix 2: Dùng _formNodeId (node có form đang mở) thay vì selectedNodeId (node được select cuối)
    // Bug fix 3: KHÔNG apply khi node đang bị xóa (node không còn trong Drawflow)
    const applyToNodeId = this._formNodeId || this.selectedNodeId;
    if (applyToNodeId && panel && !panel.classList.contains('hidden') && !this.isReadOnly() && !this._nodeBeingDeleted) {
      // Verify node still exists before applying
      const dfId = this._findDrawflowId(applyToNodeId);
      // Bug fix 2026-05-27: CHỈ apply (→ re-render node → rescan thumbnail) khi form THỰC SỰ đổi.
      // Trước: apply mỗi lần đóng → node gen/chatgpt/grok re-render + rescan thumbnail vô ích dù
      // user không sửa gì (chỉ mở rồi đóng).
      if (dfId && this.diagramCanvas?.editor?.getNodeFromId(dfId) && this._isFormDirty()) {
        this._applyNodeFormData(applyToNodeId);
      }
    }
    if (panel) {
      panel.classList.add('hidden');
    }
    this.selectedNodeId = null;
    this._formSnapshot = null;
    this._currentFormNodeType = null;
    this._formNodeId = null;
  }

  /**
   * Apply node form data to Drawflow (without closing form or saving workflow)
   * @param {string} [targetNodeId] - Optional: apply to specific node instead of selectedNodeId
   */
  _applyNodeFormData(targetNodeId = null) {
    const nodeId = targetNodeId || this.selectedNodeId;
    if (!nodeId || !this.diagramCanvas) return;

    const node = this.diagramCanvas.editor.getNodeFromId(nodeId);
    if (!node) return;
    // Bug fix: Ưu tiên node.data?.node_type (original từ backend) over node.class.
    // node.class có thể bị corrupt thành 'generate' do loadWorkflow fallback khi node_type missing.
    // Điều này gây cascade bug: node download → type 'generate' → tên "Flow - Tạo ảnh/video".
    const nodeType = node.data?.node_type || node.class || 'generate';

    // Empty input → giữ tên cũ, fallback display name từ NodeTemplates (vd "Grok"),
    // last resort = nodeType. Trước fix: '' → save rỗng → exportWorkflow fallback `node.class`
    // (lowercase 'grok') → user thấy node đổi tên thành 'grok'.
    const inputName = (this.overlay?.querySelector('#nodeName')?.value || '').trim();
    const fallbackName = node.data?.node_name
      || (window.NodeTemplates?.types?.[nodeType]?.name)
      || nodeType;
    const data = {
      node_name: inputName || fallbackName,
      // Bug fix: Luôn persist node_type để tránh mất type khi node.data.node_type bị undefined
      // (workflows cũ hoặc data corruption). Điều này đảm bảo render/export dùng đúng type.
      node_type: nodeType
    };

    // Phase 1 — Node Reference System: Slug collection for mentionable nodes
    // Task 4.12: Track slug changes for Find & Replace dialog
    let pendingSlugChange = null;
    if (this._isMentionableNodeType(nodeType)) {
      const slugInput = this.overlay?.querySelector('#nodeSlug');
      const slugAutoInput = this.overlay?.querySelector('#nodeSlugAuto');
      if (slugInput) {
        const newSlug = (slugInput.value || '').trim();
        const oldSlug = node.data?.slug || '';
        const wasSlugAuto = node.data?.slug_auto !== false;
        // Validate slug
        const validation = this._validateSlug(newSlug, nodeId);
        if (!validation.valid) {
          console.warn(`[WorkflowEditor] Invalid slug "${newSlug}":`, validation.error);
        } else if (newSlug) {
          data.slug = newSlug;
          // User edited slug manually → set slug_auto=false
          data.slug_auto = newSlug === oldSlug && wasSlugAuto;
          // Task 4.12: Track slug change
          if (oldSlug && newSlug !== oldSlug) {
            pendingSlugChange = { oldSlug, newSlug, nodeId };
          }
        } else if (wasSlugAuto && data.node_name !== node.data?.node_name) {
          // Name changed + slug_auto=true → regenerate slug
          const regeneratedSlug = this._generateSlug(data.node_name, nodeId);
          data.slug = regeneratedSlug;
          data.slug_auto = true;
          // Task 4.12: Track slug change for auto-regenerated slugs too
          if (oldSlug && regeneratedSlug !== oldSlug) {
            pendingSlugChange = { oldSlug, newSlug: regeneratedSlug, nodeId };
          }
        } else {
          // Keep existing slug
          data.slug = oldSlug;
          data.slug_auto = wasSlugAuto;
        }
      }
    }

    // Type-specific data collection
    if (nodeType === 'note') {
      data.note_text = this.overlay?.querySelector('#nodeNoteText')?.value || '';
    } else if (nodeType === 'delay') {
      data.delay_seconds = parseInt(this.overlay?.querySelector('#nodeDelaySeconds')?.value) || 3;
      data.enabled = this.overlay?.querySelector('#nodeEnabled')?.checked !== false;
    } else if (nodeType === 'image') {
      // EWT-9.4: Lưu ref_img_urls cho template mode, ref_file_ids cho normal mode
      if (this.isTemplateMode) {
        const refImgUrlsInput = this.overlay?.querySelector('#imageNodeRefImgUrls');
        // Bug fix: Chỉ update nếu input tồn tại VÀ có items, nếu rỗng thì giữ nguyên từ node.data
        // Trừ khi user đã xóa hết (dataset.cleared = true)
        if (refImgUrlsInput !== null) {
          try {
            const parsedUrls = JSON.parse(refImgUrlsInput.value || '[]');
            if (parsedUrls.length > 0) {
              data.ref_img_urls = parsedUrls;
              data.ref_thumbnails = this._convertRefImgUrlsToThumbnails(parsedUrls);
            } else if (refImgUrlsInput.dataset.cleared === 'true') {
              data.ref_img_urls = [];
              data.ref_thumbnails = {};
            }
            // Nếu rỗng và chưa cleared → giữ nguyên node.data (không ghi đè)
          } catch (e) { /* ignore parse error */ }
        }
      } else {
        // Bug fix: Chỉ update nếu input tồn tại
        const imageRefInput = this.overlay?.querySelector('#nodeRefFileIds');
        if (imageRefInput !== null) {
          data.ref_file_ids = this._truncateRefFileIds(imageRefInput.value || '', '#imageNodeRefPreview');
        }
      }
      data.enabled = this.overlay?.querySelector('#nodeEnabled')?.checked !== false;
    } else if (nodeType === 'text') {
      // Phase 1 — Node Reference System: Text node data collection
      data.prompt = this.overlay?.querySelector('#textNodeContent')?.value || '';
      data.enabled = this.overlay?.querySelector('#nodeEnabled')?.checked !== false;
    } else if (nodeType === 'text_extract') {
      // Text Extract Node (2026-05-29): collect 6 extract_* fields
      data.extract_mode = this.overlay?.querySelector('#nodeExtractMode')?.value || 'marker';
      data.extract_marker = this.overlay?.querySelector('#nodeExtractMarker')?.value?.trim() || '';
      data.extract_regex = this.overlay?.querySelector('#nodeExtractRegex')?.value || '';
      data.extract_strict = this.overlay?.querySelector('#nodeExtractStrict')?.checked === true;
      data.extract_multi_match = this.overlay?.querySelector('#nodeExtractMultiMatch')?.value || 'first';
      data.extract_on_fail = this.overlay?.querySelector('#nodeExtractOnFail')?.value || 'skip_downstream';
      data.enabled = this.overlay?.querySelector('#nodeEnabled')?.checked !== false;
    } else if (nodeType === 'download') {
      data.enabled = this.overlay?.querySelector('#nodeEnabled')?.checked !== false;
      data.download_folder = this.overlay?.querySelector('#downloadFolder')?.value || '';
      data.download_file_template = this.overlay?.querySelector('#downloadFileTemplate')?.value || '';
      data.download_resolution = this.overlay?.querySelector('#downloadResolution')?.value || '1k';
      // Bug 39 fix (2026-05-19): Save video_download_resolution để runtime
      // (WorkflowExecutor.js detect upstream video) pick đúng resolution thay vì luôn '720p'.
      data.video_download_resolution = this.overlay?.querySelector('#downloadVideoResolution')?.value || '720p';
      data.download_collect_all = this.overlay?.querySelector('#downloadCollectAll')?.checked || false;
    } else if (nodeType === 'telegram') {
      data.enabled = this.overlay?.querySelector('#nodeEnabled')?.checked !== false;
      const chatIdInput = this.overlay?.querySelector('#telegramChatId');
      data.telegram_chat_id = chatIdInput?.value?.trim() || '';
      data.telegram_send_mode = this.overlay?.querySelector('#telegramSendMode')?.value || 'single';
      data.telegram_message = this.overlay?.querySelector('#telegramMessage')?.value?.trim() || '';
      console.log('[WorkflowEditor] Telegram node save - chatIdInput:', chatIdInput, 'value:', chatIdInput?.value, 'data.telegram_chat_id:', data.telegram_chat_id);
    } else if (nodeType === 'prompt') {
      // AI Agent node (Phase CG-8 + rename 2026-05-30): text + use_ai toggle + provider + timeout
      data.prompt = this.overlay?.querySelector('#promptNodeText')?.value || '';
      data.use_ai = this.overlay?.querySelector('#promptNodeUseAi')?.checked || false;
      data.provider = this.overlay?.querySelector('#promptNodeProvider')?.value || 'chatgpt';
      data.timeout_sec = parseInt(this.overlay?.querySelector('#promptNodeTimeout')?.value, 10) || 60;
      // Fallback option: tự động dùng plain text nếu AI fail (default: true)
      data.ai_fallback = this.overlay?.querySelector('#promptNodeFallback')?.checked !== false;
      // ai_delete_after_run — xóa conversation sau AI run success (default: false)
      data.ai_delete_after_run = this.overlay?.querySelector('#promptNodeDeleteAfter')?.checked || false;
      // EWT-9.4: Lưu ref_img_urls cho template mode, ref_file_ids cho normal mode
      if (this.isTemplateMode) {
        const refImgUrlsInput = this.overlay?.querySelector('#promptNodeRefImgUrls');
        // Bug fix: Chỉ update nếu có items, nếu rỗng thì giữ nguyên trừ khi cleared
        if (refImgUrlsInput !== null) {
          try {
            const parsedUrls = JSON.parse(refImgUrlsInput.value || '[]');
            if (parsedUrls.length > 0) {
              data.ref_img_urls = parsedUrls;
              data.ref_thumbnails = this._convertRefImgUrlsToThumbnails(parsedUrls);
            } else if (refImgUrlsInput.dataset.cleared === 'true') {
              data.ref_img_urls = [];
              data.ref_thumbnails = {};
            }
          } catch (e) { /* ignore */ }
        }
      } else {
        // Phase CG-8 ext: persist ref_file_ids cho prompt node (chỉ dùng khi enhance=ON)
        const promptRefInput = this.overlay?.querySelector('#promptNodeRefFileIds');
        if (promptRefInput !== null) {
          data.ref_file_ids = this._truncateRefFileIds(promptRefInput.value || '', '#promptNodeRefPreview');
        }
      }
      data.max_ref_images = 4;
      data.enabled = this.overlay?.querySelector('#nodeEnabled')?.checked !== false;
      // Mention mode: override nếu user chọn, auto-detect nếu 'auto'
      const promptModeOverride = this.overlay?.querySelector('#promptNodePromptMode')?.value;
      const refModeOverride = this.overlay?.querySelector('#promptNodeRefMode')?.value;
      const promptText = data.prompt || '';
      const hasMentions = this._parseMentions(promptText).length > 0;
      const autoMode = hasMentions ? 'mention' : 'all';
      data.prompt_mode = (promptModeOverride && promptModeOverride !== 'auto') ? promptModeOverride : autoMode;
      data.ref_mode = (refModeOverride && refModeOverride !== 'auto') ? refModeOverride : autoMode;
    } else if (nodeType === 'chatgpt') {
      // Phase CG-8: persist prompt_source (toggle: checked = textbox, unchecked = upstream_node)
      // Bug fix: Chỉ update nếu toggle element tồn tại, giữ nguyên giá trị cũ nếu không
      const psToggleCg = this.overlay?.querySelector('#promptSourceToggle');
      if (psToggleCg !== null) {
        data.prompt_source = psToggleCg.checked ? 'textbox' : 'upstream_node';
      }
      data.prompt = this.overlay?.querySelector('#chatgptNodePrompt')?.value || '';
      // Preserve existing ratio if form element is empty/missing
      const chatgptRatioEl = this.overlay?.querySelector('#chatgptImageRatio');
      data.ratio = chatgptRatioEl?.value || node.data?.ratio || 'story';
      // Model (Instant/Thinking — GPT-5.5). Preserve existing nếu form element thiếu.
      const chatgptModelEl = this.overlay?.querySelector('#chatgptNodeModel');
      data.model = chatgptModelEl?.value || node.data?.model || 'Instant';
      // EWT-9.4: Lưu ref_img_urls cho template mode, ref_file_ids cho normal mode
      if (this.isTemplateMode) {
        const refImgUrlsInput = this.overlay?.querySelector('#chatgptImageRefImgUrls');
        // Bug fix: Chỉ update nếu có items, nếu rỗng thì giữ nguyên trừ khi cleared
        if (refImgUrlsInput !== null) {
          try {
            const parsedUrls = JSON.parse(refImgUrlsInput.value || '[]');
            if (parsedUrls.length > 0) {
              data.ref_img_urls = parsedUrls;
              data.ref_thumbnails = this._convertRefImgUrlsToThumbnails(parsedUrls);
            } else if (refImgUrlsInput.dataset.cleared === 'true') {
              data.ref_img_urls = [];
              data.ref_thumbnails = {};
            }
          } catch (e) { /* ignore */ }
        }
        // EWT-12: Lưu result_img_url cho template mode
        // Bug fix: Chỉ update nếu input tồn tại VÀ có value, nếu rỗng thì giữ nguyên từ node.data
        // Trừ khi user đã xóa ảnh (dataset.cleared = true)
        const chatgptResultInput = this.overlay?.querySelector('#chatgptResultImgUrl');
        if (chatgptResultInput !== null) {
          if (chatgptResultInput.value) {
            data.result_img_url = chatgptResultInput.value;
          } else if (chatgptResultInput.dataset.cleared === 'true') {
            data.result_img_url = '';
          }
          // Nếu rỗng và chưa cleared → giữ nguyên node.data.result_img_url (không ghi đè)
        }
        // Convert to result_thumbnails để DiagramCanvas hiển thị ngay
        if (data.result_img_url) {
          data.result_thumbnails = { ...data.result_thumbnails, [`result_${Date.now()}`]: data.result_img_url };
        }
      } else {
        const chatgptRefInput = this.overlay?.querySelector('#chatgptImageRefFileIds');
        if (chatgptRefInput !== null) {
          data.ref_file_ids = this._truncateRefFileIds(chatgptRefInput.value || '', '#chatgptImageRefPreview');
        }
      }
      data.use_fallback_prefix = this.overlay?.querySelector('#chatgptImageMode')?.value || 'auto';
      data.timeout_ms = parseInt(this.overlay?.querySelector('#chatgptImageTimeout')?.value) || 120000;
      data.auto_download = this.overlay?.querySelector('#chatgptImageAutoDownload')?.checked || false;
      data.max_ref_images = 4;
      data.enabled = this.overlay?.querySelector('#nodeEnabled')?.checked !== false;
      // Mention mode: override nếu user chọn, auto-detect nếu 'auto'
      const cgPromptModeOverride = this.overlay?.querySelector('#chatgptPromptMode')?.value;
      const cgRefModeOverride = this.overlay?.querySelector('#chatgptRefMode')?.value;
      const cgPromptText = data.prompt || '';
      const cgHasMentions = this._parseMentions(cgPromptText).length > 0;
      const cgAutoMode = cgHasMentions ? 'mention' : 'all';
      data.prompt_mode = (cgPromptModeOverride && cgPromptModeOverride !== 'auto') ? cgPromptModeOverride : cgAutoMode;
      data.ref_mode = (cgRefModeOverride && cgRefModeOverride !== 'auto') ? cgRefModeOverride : cgAutoMode;
    } else if (nodeType === 'grok') {
      // Phase G-6: Grok Image/Video node
      // Bug fix: persist prompt_source giống các node khác (ChatGPT/Generate)
      // Toggle: checked = textbox (sử dụng prompt riêng), unchecked = upstream_node
      // Bug fix: Chỉ update nếu toggle element tồn tại, giữ nguyên giá trị cũ nếu không
      const psToggleGrok = this.overlay?.querySelector('#promptSourceToggle');
      if (psToggleGrok !== null) {
        data.prompt_source = psToggleGrok.checked ? 'textbox' : 'upstream_node';
      }
      data.prompt = this.overlay?.querySelector('#grokNodePrompt')?.value || '';
      data.grok_mode = this.overlay?.querySelector('#grokNodeMode')?.value || 'image';
      // Preserve existing ratio if form element is empty/missing
      const grokRatioInputEl = this.overlay?.querySelector('#grokNodeRatio');
      data.ratio = grokRatioInputEl?.value || node.data?.ratio || 'widescreen';
      data.grok_duration = this.overlay?.querySelector('#grokNodeDuration')?.value || '6s';
      data.grok_resolution = this.overlay?.querySelector('#grokNodeResolution')?.value || '720p';
      // Image quality (Grok update 2026-04) — chỉ relevant khi grok_mode=image
      data.grok_image_quality = this.overlay?.querySelector('#grokNodeImageQuality')?.value || 'speed';
      // EWT-9.4: Lưu ref_img_urls cho template mode, ref_file_ids cho normal mode
      if (this.isTemplateMode) {
        const refImgUrlsInput = this.overlay?.querySelector('#grokNodeRefImgUrls');
        // Bug fix: Chỉ update nếu có items, nếu rỗng thì giữ nguyên trừ khi cleared
        if (refImgUrlsInput !== null) {
          try {
            const parsedUrls = JSON.parse(refImgUrlsInput.value || '[]');
            if (parsedUrls.length > 0) {
              data.ref_img_urls = parsedUrls;
              data.ref_thumbnails = this._convertRefImgUrlsToThumbnails(parsedUrls);
            } else if (refImgUrlsInput.dataset.cleared === 'true') {
              data.ref_img_urls = [];
              data.ref_thumbnails = {};
            }
          } catch (e) { /* ignore */ }
        }
        // EWT-12: Lưu result_img_url cho template mode
        // Bug fix: Chỉ update nếu input tồn tại VÀ có value, nếu rỗng thì giữ nguyên từ node.data
        const grokResultInput = this.overlay?.querySelector('#grokNodeResultImgUrl');
        if (grokResultInput !== null) {
          if (grokResultInput.value) {
            data.result_img_url = grokResultInput.value;
          } else if (grokResultInput.dataset.cleared === 'true') {
            data.result_img_url = '';
          }
        }
        // Convert to result_thumbnails để DiagramCanvas hiển thị ngay
        if (data.result_img_url) {
          data.result_thumbnails = { ...data.result_thumbnails, [`result_${Date.now()}`]: data.result_img_url };
        }
      } else {
        const grokRefInput = this.overlay?.querySelector('#grokNodeRefFileIds');
        if (grokRefInput !== null) {
          data.ref_file_ids = this._truncateRefFileIds(grokRefInput.value || '', '#grokNodeRefPreview');
        }
      }
      data.auto_download = !!this.overlay?.querySelector('#grokNodeAutoDownload')?.checked;
      data.timeout_ms = parseInt(this.overlay?.querySelector('#grokNodeTimeout')?.value, 10) || 180000;
      data.max_ref_images = 4;
      data.enabled = this.overlay?.querySelector('#nodeEnabled')?.checked !== false;
      // Mention mode: override nếu user chọn, auto-detect nếu 'auto'
      const grokPromptModeOverride = this.overlay?.querySelector('#grokPromptMode')?.value;
      const grokRefModeOverride = this.overlay?.querySelector('#grokRefMode')?.value;
      const grokPromptText = data.prompt || '';
      const grokHasMentions = this._parseMentions(grokPromptText).length > 0;
      const grokAutoMode = grokHasMentions ? 'mention' : 'all';
      data.prompt_mode = (grokPromptModeOverride && grokPromptModeOverride !== 'auto') ? grokPromptModeOverride : grokAutoMode;
      data.ref_mode = (grokRefModeOverride && grokRefModeOverride !== 'auto') ? grokRefModeOverride : grokAutoMode;
    } else {
      // Generate node
      // Phase CG-8: persist prompt_source (toggle: checked = textbox, unchecked = upstream_node)
      // Bug fix: Chỉ update nếu toggle element tồn tại, giữ nguyên giá trị cũ nếu không
      const psToggleGen = this.overlay?.querySelector('#promptSourceToggle');
      if (psToggleGen !== null) {
        data.prompt_source = psToggleGen.checked ? 'textbox' : 'upstream_node';
      }
      const mediaType = this.overlay?.querySelector('#nodeMediaType')?.value || 'Image';
      const videoInputType = mediaType === 'Video'
        ? (this.overlay?.querySelector('#nodeVideoInputType')?.value || 'Frames')
        : '';
      data.prompt = this.overlay?.querySelector('#nodePrompt')?.value || '';
      data.media_type = mediaType;
      // Strict Server-Only: ModelRegistry server-driven, cache miss → null (UI dropdown empty).
      data.model = mediaType === 'Video'
        ? (this.overlay?.querySelector('#nodeVideoModel')?.value || window.ModelRegistry?.safeGetDefault('flow', 'video') || null)
        : (this.overlay?.querySelector('#nodeModel')?.value || window.ModelRegistry?.safeGetDefault('flow', 'image') || null);
      if (!data.model) console.debug('[Tier3] WorkflowEditor save: model resolve null (UI empty + cache miss)');
      // Preserve existing ratio if form element is empty/missing
      const ratioInputEl = this.overlay?.querySelector('#nodeRatio');
      data.ratio = ratioInputEl?.value || node.data?.ratio || '16:9';
      data.quantity = parseInt(this.overlay?.querySelector('#nodeQuantity')?.value) || 1;
      data.video_input_type = videoInputType;
      // Flow video duration (Omni Flash: 10s support)
      if (mediaType === 'Video') {
        data.video_duration = this.overlay?.querySelector('#nodeVideoDuration')?.value || '6s';
      }
      // Flow Voice Selector — chỉ persist khi model.config.supports_voice = true
      const voiceSlugInput = this.overlay?.querySelector('#nodeVoiceSlug');
      const voiceSearchInput = this.overlay?.querySelector('#nodeVoiceSearchValue');
      if (mediaType === 'Video') {
        const modelObj = window.ModelRegistry?.findModel?.('flow', data.model);
        if (modelObj?.config?.supports_voice === true) {
          data.voice_slug = voiceSlugInput?.value || null;
          data.voice_search_value = voiceSearchInput?.value || null;
        } else {
          data.voice_slug = null;
          data.voice_search_value = null;
        }
      } else {
        data.voice_slug = null;
        data.voice_search_value = null;
      }
      // EWT-9.4: Lưu ref_img_urls cho template mode, ref_file_ids cho normal mode
      if (this.isTemplateMode) {
        const refImgUrlsInput = this.overlay?.querySelector('#generateNodeRefImgUrls');
        if (refImgUrlsInput !== null) {
          try {
            const parsedUrls = JSON.parse(refImgUrlsInput.value || '[]');
            if (parsedUrls.length > 0) {
              data.ref_img_urls = parsedUrls;
              data.ref_thumbnails = this._convertRefImgUrlsToThumbnails(parsedUrls);
            } else if (refImgUrlsInput.dataset.cleared === 'true') {
              data.ref_img_urls = [];
              data.ref_thumbnails = {};
            }
          } catch (e) { /* ignore */ }
        }
      } else {
        const genRefInput = this.overlay?.querySelector('#nodeRefFileIds');
        if (genRefInput !== null) {
          data.ref_file_ids = this._truncateRefFileIds(genRefInput.value || '', '#nodeRefImagesPreview');
        }
      }
      // EWT-12: Lưu result_img_url cho template mode
      // Bug fix: Chỉ update nếu input tồn tại VÀ có value, nếu rỗng thì giữ nguyên từ node.data
      // Trừ khi user đã xóa ảnh (dataset.cleared = true)
      if (this.isTemplateMode) {
        const resultInput = this.overlay?.querySelector('#generateResultImgUrl');
        if (resultInput !== null) {
          if (resultInput.value) {
            data.result_img_url = resultInput.value;
          } else if (resultInput.dataset.cleared === 'true') {
            data.result_img_url = '';
          }
          // Nếu rỗng và chưa cleared → giữ nguyên node.data.result_img_url (không ghi đè)
        }
        // Convert to result_thumbnails để DiagramCanvas hiển thị ngay
        if (data.result_img_url) {
          data.result_thumbnails = { [`result_${Date.now()}`]: data.result_img_url };
        }
      }
      data.enabled = this.overlay?.querySelector('#nodeEnabled')?.checked !== false;
      data.auto_download = this.overlay?.querySelector('#nodeAutoDownload')?.checked || false;
      data.download_resolution = this.overlay?.querySelector('#nodeDownloadResolution')?.value || '1k';
      data.video_download_resolution = this.overlay?.querySelector('#nodeVideoDownloadResolution')?.value || '720p';
      // Mention mode: override nếu user chọn, auto-detect nếu 'auto'
      const genPromptModeOverride = this.overlay?.querySelector('#nodePromptMode')?.value;
      const genRefModeOverride = this.overlay?.querySelector('#nodeRefMode')?.value;
      const genPromptText = data.prompt || '';
      const genHasMentions = this._parseMentions(genPromptText).length > 0;
      const genAutoMode = genHasMentions ? 'mention' : 'all';
      data.prompt_mode = (genPromptModeOverride && genPromptModeOverride !== 'auto') ? genPromptModeOverride : genAutoMode;
      data.ref_mode = (genRefModeOverride && genRefModeOverride !== 'auto') ? genRefModeOverride : genAutoMode;
      if (mediaType === 'Video' && videoInputType === 'Frames') {
        data.frame_1_source = this.overlay?.querySelector('#frame1Source')?.value || '';
        data.frame_1_file_id = this.overlay?.querySelector('#frame1FileId')?.value || '';
        data.frame_2_source = this.overlay?.querySelector('#frame2Source')?.value || '';
        data.frame_2_file_id = this.overlay?.querySelector('#frame2FileId')?.value || '';
        // Capture cross-project metadata từ _tileCache (set bởi _openNodeFramePicker khi pick frame mới)
        // Pattern tương tự ref_thumbnails + ref_file_names cho ref images.
        [1, 2].forEach(n => {
          const fid = data[`frame_${n}_file_id`];
          if (!fid) return;
          const cached = this._tileCache?.get(fid);
          if (cached?.thumbnail) data[`frame_${n}_thumbnail`] = cached.thumbnail;
          if (cached?.file_name) data[`frame_${n}_file_name`] = cached.file_name;
        });
      }
    }

    // Bug fix: Sync ref_thumbnails/ref_file_names với ref_file_ids.
    // Khi user xóa ref image, ref_file_ids thay đổi nhưng ref_thumbnails/ref_file_names
    // không được sync → WorkflowExecutor Smart Clone reconstruct ref_file_ids từ orphan metadata.
    // DiagramCanvas.exportWorkflow đã fix để không export orphan metadata, nhưng trong memory
    // node.data vẫn có metadata cũ → nếu run workflow ngay (không reload từ storage) sẽ dùng ref cũ.
    if (typeof data.ref_file_ids === 'string' && !this.isTemplateMode) {
      const currentRefIds = new Set(
        (data.ref_file_ids || '').split(',').map(s => s.trim()).filter(Boolean)
      );
      // Sync ref_thumbnails/ref_file_names theo ref_file_ids hiện tại.
      // Bug fix 2026-05-26: picker + port nguồn CHỈ ghi _tileCache, KHÔNG ghi node.data.ref_thumbnails
      // → trước đây thumbnails không được persist → reload mất ảnh + prompt-node resolve fail
      // (_resolveRefImagesForLLM không tìm thấy URL). Giờ build từ active ref IDs: ưu tiên node.data,
      // fallback _tileCache. Vẫn clear orphan (key không còn trong ref_file_ids bị loại).
      const hadThumbs = !!node.data?.ref_thumbnails;
      const hadNames = !!node.data?.ref_file_names;
      const syncedThumbs = {};
      const syncedNames = {};
      for (const key of currentRefIds) {
        const fromData = node.data?.ref_thumbnails?.[key];
        const tc = this._tileCache?.get(key);
        // thumbnail có thể là string hoặc object {thumbnail, type}
        const thumb = (fromData && typeof fromData === 'object' ? fromData.thumbnail : fromData) || tc?.thumbnail;
        // 2026-05-27: preserve video type qua reload → ref video persist dạng object {thumbnail, type:'video'}
        // để has_ref_video detect được sau khi mở lại workflow (force duration 10s).
        const isVid = (fromData && typeof fromData === 'object' && fromData.type === 'video') || tc?.type === 'video';
        if (thumb) syncedThumbs[key] = isVid ? { thumbnail: thumb, type: 'video' } : thumb;
        const nm = node.data?.ref_file_names?.[key] || tc?.file_name;
        if (nm) syncedNames[key] = nm;
      }
      // Set khi có metadata cũ (để clear orphan) HOẶC có data mới (để persist).
      if (hadThumbs || Object.keys(syncedThumbs).length > 0) data.ref_thumbnails = syncedThumbs;
      if (hadNames || Object.keys(syncedNames).length > 0) data.ref_file_names = syncedNames;
    }

    this._formSnapshot = null;
    this._hasUnsavedChanges = true;
    // Apply form data to Drawflow node
    // updateNodeData() regenerates DOM from template → destroys dynamic previews
    // Bug fix: dùng nodeId (có thể là targetNodeId) thay vì this.selectedNodeId
    this.diagramCanvas.updateNodeData(nodeId, data);

    // Restore previews that were destroyed by updateNodeData DOM regeneration
    this._restoreNodePreviewAfterUpdate(nodeId, nodeType);

    // Update connections khi node size thay đổi (vd: thêm/xóa preview image làm height thay đổi)
    try {
      const drawflowId = this._findDrawflowId(nodeId) || nodeId;
      this.diagramCanvas?.editor?.updateConnectionNodes?.(`node-${drawflowId}`);
    } catch (e) { /* ignore */ }

    // Task 4.12: Check for slug change and offer Find & Replace
    if (pendingSlugChange) {
      const { oldSlug, newSlug, nodeId: changedNodeId } = pendingSlugChange;
      const references = this._findSlugReferences(oldSlug, changedNodeId);
      if (references.length > 0) {
        // Show dialog async (don't block form save)
        this._showFindReplaceDialog(oldSlug, newSlug, references).then(choice => {
          if (choice === 'update') {
            const updated = this._replaceSlugInAllNodes(oldSlug, newSlug);
            console.log(`[WorkflowEditor] Updated ${updated} node(s): @${oldSlug} → @${newSlug}`);
          }
          // 'skip' does nothing - keep new slug but old references will be broken
        });
      }
    }
  }

  /**
   * Re-render node previews after updateNodeData() replaces DOM.
   * updateNodeData → NodeTemplates.createNodeHTML → element.innerHTML = html
   * This destroys dynamic preview thumbnails rendered by _renderNodePreviewInner.
   * Uses _skipDeferredSave flag to avoid triggering another save cycle.
   */
  _restoreNodePreviewAfterUpdate(nodeId, nodeType) {
    const drawflowId = this._findDrawflowId(nodeId) || nodeId;
    const node = this.diagramCanvas?.editor?.getNodeFromId(drawflowId);
    if (!node?.data) return;
    const data = node.data;

    // Restore status dot (updateNodeData regenerates template HTML → status dot loses class)
    if (data.status) {
      this._updateNodeStatusUI(data.node_id || nodeId, data.status);
    }

    // Re-inject corner gear button — element.innerHTML = html xóa nút gear đã append
    try { this._ensureNodeCornerGears(); } catch (e) {}

    // Skip deferred save to avoid infinite save loop
    this._skipDeferredSave = true;

    try {
      // Result preview for completed nodes
      if (data.status === 'completed' && data.result_file_ids) {
        const fileIds = data.result_file_ids.split(',').map(s => s.trim()).filter(Boolean);
        if (fileIds.length > 0 && fileIds.some(id => this._tileCache.has(id))) {
          this._directRenderNodePreview(data.node_id || nodeId, fileIds);
        }
      }

      // Template mode hoặc template preview: render/clear result_img_url preview
      const isTemplateCtx = this.isTemplateMode || this.workflow?._is_template_preview || this.workflow?._isPreview;
      if (isTemplateCtx) {
        if (data.result_img_url) {
          // Có ảnh → render
          this._renderTemplateResultOnNode(data.node_id || nodeId, data.result_img_url);
        } else if (data.result_img_url === '') {
          // User đã xóa ảnh (empty string) → clear preview
          this._clearTemplateResultOnNode(data.node_id || nodeId);
        }
        // Nếu undefined → giữ nguyên placeholder từ NodeTemplates (không làm gì)

        // Template mode/preview: render ref images từ ref_img_urls
        if (data.ref_img_urls?.length > 0 || (data.ref_thumbnails && Object.keys(data.ref_thumbnails).length > 0)) {
          const refUrls = data.ref_img_urls || Object.values(data.ref_thumbnails || {});
          if (refUrls.length > 0) {
            this._renderTemplateRefOnNode(data.node_id || nodeId, refUrls);
          }
        }
      }

      // Image node: ref images as main preview (normal mode only)
      if (!isTemplateCtx && nodeType === 'image' && data.ref_file_ids) {
        const refIds = data.ref_file_ids.split(',').map(s => s.trim()).filter(Boolean);
        if (refIds.length > 0) {
          this._directRenderNodePreview(data.node_id || nodeId, refIds);
        }
      }

      // Ref thumbnail at bottom of node card — render ngay sau apply form data.
      // Bug fix: trước chỉ 'generate' → ChatGPT/Grok/Prompt save ref images xong nhưng
      // footer node trên canvas KHÔNG hiện thumbnails (trống dưới prompt). Phải refresh khi
      // user edit ref qua form panel cho TẤT CẢ types accept image_ref.
      if (['generate', 'chatgpt', 'grok', 'prompt'].includes(nodeType) && data.ref_file_ids) {
        const refIds = data.ref_file_ids.split(',').map(s => s.trim()).filter(Boolean);
        if (refIds.length > 0 && refIds.some(id => this._tileCache.has(id))) {
          this._directRenderNodeRefFromCache(data.node_id || nodeId, refIds);
        }
      }
    } finally {
      this._skipDeferredSave = false;
    }
    // Task 5.1: Emit để undo history schedule snapshot (debounced 400ms)
    // Bug fix: Use nodeId param instead of this.selectedNodeId for correct tracking
    try { window.eventBus?.emit('node:data_changed', { nodeId }); } catch (e) {}
  }

  async saveNode() {
    // Read-only mode: không cho phép save
    if (this.isReadOnly()) return;

    try {
      // Capture node info before hiding form
      const savedNodeId = this.selectedNodeId;
      const node = savedNodeId ? this.diagramCanvas?.editor?.getNodeFromId(savedNodeId) : null;
      // Bug fix: Ưu tiên node.data.node_type (original) over node.class (có thể bị corrupt)
      const nodeType = node?.data?.node_type || node?.class || 'generate';

      // Snapshot port count BEFORE apply để detect dynamic visibility change (Issue #71-1)
      const oldPortsBefore = (typeof window.NodeTemplates?.getNodePorts === 'function')
        ? window.NodeTemplates.getNodePorts(nodeType, node?.data || {})
        : { in: [], out: [] };
      const oldInCount = (oldPortsBefore.in || []).length;
      const oldOutCount = (oldPortsBefore.out || []).length;

      // Save node data and update canvas
      this._applyNodeFormData();
      // S2.5: Uploads đã được lưu vào node — không cancel khi đóng form
      this._formUploadKeys?.clear();
      await this.hideNodeForm();

      // Auto-save workflow to persist node changes
      // Template mode: KHÔNG auto-save vì workflow chưa tồn tại trong DB, chỉ cập nhật Drawflow data
      if (!this.isTemplateMode) {
        // Wait for any concurrent save to finish
        if (this._isSaving) {
          const waitStart = Date.now();
          while (this._isSaving && Date.now() - waitStart < 5000) {
            await new Promise(r => setTimeout(r, 100));
          }
        }
        await this.saveWorkflow();
      } else {
        // Template mode: đánh dấu có thay đổi để user biết cần nhấn Save để lưu template
        this._hasUnsavedChanges = true;
        console.log('[WorkflowEditor] saveNode() - Template mode: skipped saveWorkflow(), marked unsaved');
      }

      // Re-fetch node data after save (updateNodeData may replace data reference)
      const updatedNode = savedNodeId ? this.diagramCanvas?.editor?.getNodeFromId(savedNodeId) : null;
      const nodeData = updatedNode?.data || node?.data;

      // Issue #71-1 (HIGH) RESOLVED: Dynamic visibility — auto resize port count runtime
      // qua Drawflow API addNodeInput/removeNodeInput, không cần re-create node.
      try {
        const newPorts = (typeof window.NodeTemplates?.getNodePorts === 'function')
          ? window.NodeTemplates.getNodePorts(nodeType, nodeData || {})
          : { in: [], out: [] };
        if (savedNodeId && this.diagramCanvas?._resizeNodePorts) {
          this.diagramCanvas._resizeNodePorts(savedNodeId, newPorts);
        }
        // Re-inject port attrs (data-port-type/required mới nhất)
        if (this.diagramCanvas?._injectPortAttributes && savedNodeId) {
          requestAnimationFrame(() => {
            this.diagramCanvas._injectPortAttributes(savedNodeId, newPorts);
            try { this._updatePortEmptyState(); } catch (e) {}
            try { this._scheduleRefreshNodeWarningBadges(); } catch (e) {}
        try { this._refreshAllPromptSourceBadges(); } catch (e) {}
          });
        }

        // Re-validate edges sau khi save form — user có thể đổi mediaType từ form, cần gỡ edges incompat.
        // Idempotent + state-driven: chỉ gỡ edges thực sự incompat tại thời điểm gọi.
        if (savedNodeId) {
          try {
            const removedCount = this._revalidateNodeEdges(savedNodeId);
            if (removedCount > 0) {
              const msg = window.I18n?.t('workflow.edgesRemovedOnTypeChange', { count: removedCount })
                || `Đã gỡ ${removedCount} kết nối không tương thích sau khi đổi loại media`;
              if (typeof window.showNotification === 'function') {
                window.showNotification(msg, 'warning', 2500);
              }
              try { this.diagramCanvas?._recolorAllEdges?.(); } catch (e) {}
            }
          } catch (e) {
            console.warn('[WorkflowEditor] Re-validate edges in saveNode failed:', e);
          }
        }

        // Connection paths phải recompute sau khi save form: ratio đổi → preview area resize,
        // mediaType=Video+Frames → thêm 2 frame ports, prompt enhance toggle → image_ref port hiện/ẩn.
        // Tất cả đều thay đổi tọa độ port DOM → edges bị lệch nếu không update.
        // Defer 2 frames cho CSS aspect-ratio + reflow settle (cùng pattern với inline pill change).
        try {
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              try { this.diagramCanvas?._forceUpdateAllConnections?.(); } catch (e) {}
            });
          });
        } catch (e) {}
      } catch (e) {
        console.warn('[WorkflowEditor] Port resize failed:', e.message);
      }

      // Update image node preview on canvas after save
      if (nodeType === 'image' && nodeData) {
        if (this.isTemplateMode) {
          // Template mode: render từ ref_img_urls hoặc ref_thumbnails
          const refUrls = nodeData.ref_img_urls || Object.values(nodeData.ref_thumbnails || {});
          if (refUrls.length > 0) {
            this._showNodeRefPreviewFromUrls(nodeData.node_id, refUrls);
          } else {
            this._clearNodeRefPreview(nodeData.node_id);
          }
        } else {
          // Normal mode: render từ ref_file_ids
          const refIds = (nodeData.ref_file_ids || '').split(',').map(s => s.trim()).filter(Boolean);
          if (refIds.length > 0) {
            this._showNodePreview(nodeData.node_id, refIds);
          } else {
            this._clearNodePreview(nodeData.node_id);
          }
        }
      }

      // Update ref image thumbnails cho các node accept image_ref input.
      // Bug fix: trước fix chỉ 'generate' → ChatGPT/Grok add ref images không hiện preview
      // trên node card diagram. Giờ apply cho TẤT CẢ node types có image_ref input port.
      // Bug fix 2: Template mode dùng ref_img_urls/ref_thumbnails thay vì ref_file_ids
      if (['generate', 'chatgpt', 'grok'].includes(nodeType) && nodeData) {
        if (this.isTemplateMode) {
          // Template mode: render từ ref_img_urls hoặc ref_thumbnails
          const refUrls = nodeData.ref_img_urls || Object.values(nodeData.ref_thumbnails || {});
          if (refUrls.length > 0) {
            this._showNodeRefPreviewFromUrls(nodeData.node_id, refUrls);
          } else {
            this._clearNodeRefPreview(nodeData.node_id);
          }
        } else {
          // Normal mode: render từ ref_file_ids
          const refIds = (nodeData.ref_file_ids || '').split(',').map(s => s.trim()).filter(Boolean);
          this._showNodeRefPreview(nodeData.node_id, refIds);
        }
      }

      // Persist ref image thumbnails for all node types that have ref_file_ids
      if (nodeData?.ref_file_ids && savedNodeId) {
        this._persistRefThumbnails(savedNodeId, nodeData);
        // Deferred save to persist ref_thumbnails (set after initial saveWorkflow)
        this._deferredThumbnailSave();
      }

      // Fire-and-forget: proactive cache ref image blobs cho node vua save
      if (nodeData?.ref_file_ids) {
        this._cacheNodeRefImageBlobs(nodeData).catch(() => {});
      }
    } catch (error) {
      console.error('[TobyFlow] saveNode failed:', error);

      // Quota error modal already shown by ApiStorage._handleQuotaError
      if (error.code !== 'QUOTA_EXCEEDED' && !error.message?.includes('giới hạn')) {
        window.customDialog?.alert((window.I18n?.t('workflow.saveNodeError') || 'Lỗi khi lưu node') + ': ' + error.message, { type: 'error' });
      }
    }
  }

  async deleteNode() {
    if (!this.selectedNodeId || !this.diagramCanvas) return;
    if (this.isReadOnly()) return;

    const ok = await window.customDialog.confirm(window.I18n?.t('workflow.deleteNodeConfirm') || 'Bạn có chắc muốn xóa node này?', { title: window.I18n?.t('workflow.deleteNode') || 'Xóa node' });
    if (ok) {
      this.diagramCanvas.removeNode(this.selectedNodeId);
      // Xóa node → force close form (không cần confirm upload)
      this._formUploadKeys?.clear();
      await this.hideNodeForm();
    }
  }

  handleEdgeCreated(connection, sourcePort, targetPort) {
    // Phase WK-1.3.5: cache port names theo cặp (output_id, output_class, input_id, input_class)
    // exportWorkflow đọc cache này để gắn source_port/target_port vào edge data khi save
    if (!this._edgePortCache) this._edgePortCache = new Map();
    if (connection && sourcePort && targetPort) {
      const key = `${connection.output_id}:${connection.output_class}->${connection.input_id}:${connection.input_class}`;
      this._edgePortCache.set(key, { sourcePort, targetPort });
    }

    // Bug fix 2026-05-20: auto-switch prompt_source='textbox' → 'upstream_node' khi user
    // connect Prompt/Text node vào port "text" của generate/chatgpt/grok node với textbox rỗng.
    // Trước fix: prompt_source giữ default 'textbox' → save persist stale → runtime
    // submit empty prompt → Flow redirect homepage / ChatGPT silent. Fix gốc tại UI để
    // KHÔNG tạo stale data, các layer downstream (runtime/bulk-save/migration) là safety net.
    try {
      if (!connection || !targetPort || (targetPort !== 'text' && targetPort !== 'default')) return;
      const editor = this.diagramCanvas?.editor;
      if (!editor) return;
      const targetNode = editor.getNodeFromId(connection.input_id);
      const sourceNode = editor.getNodeFromId(connection.output_id);
      if (!targetNode?.data || !sourceNode?.data) return;
      const targetType = targetNode.data.node_type || targetNode.class;
      const sourceType = sourceNode.data.node_type || sourceNode.class;
      if (!['generate', 'chatgpt', 'grok'].includes(targetType)) return;
      // 2026-05-31: thêm text_extract làm valid upstream — node này output text result cho
      // downstream gen/chatgpt/grok dùng làm prompt (parity với prompt/text nodes).
      if (!['prompt', 'text', 'text_extract'].includes(sourceType)) return;
      if (targetNode.data.prompt_source !== 'textbox') return;
      if ((targetNode.data.prompt || '').trim()) return;
      // Skip nếu form đang mở cho chính target node — tránh phá state user đang edit
      if (this.selectedNodeId && String(this.selectedNodeId) === String(connection.input_id)) {
        console.warn(`[WorkflowEditor] Skip auto-switch prompt_source: form đang mở cho node "${targetNode.data.node_name}" (user tắt toggle "Use own prompt" thủ công nếu muốn)`);
        return;
      }
      // All conditions match → switch
      editor.updateNodeDataFromId(connection.input_id, {
        ...targetNode.data,
        prompt_source: 'upstream_node',
      });
      console.log(`[WorkflowEditor] Auto-switch prompt_source: 'textbox' → 'upstream_node' cho node "${targetNode.data.node_name}" (connected Prompt/Text vào port text)`);
    } catch (e) {
      console.warn('[WorkflowEditor] Auto-switch prompt_source failed:', e?.message);
    }
  }

  handleEdgeRemoved(connection) {
    if (this._edgePortCache && connection) {
      const key = `${connection.output_id}:${connection.output_class}->${connection.input_id}:${connection.input_class}`;
      this._edgePortCache.delete(key);
    }
  }

  handleNodeRemoved(nodeId) {
    if (String(this.selectedNodeId) === String(nodeId)) {
      // Node bị xóa → force close form (bypass unsaved changes dialog)
      // Note: _handleNodeUnselected may have already closed the form if it fired first
      this._formUploadKeys?.clear();
      this.hideNodeForm({ skipUploadCheck: true });
    }
  }

  /**
   * Sync server-side mutations từ bulk-save response về lại editor.
   *
   * Backend có thể mutate các fields (rename slug, heal prompt_source, clear garbage).
   * Generic whitelist patch + cập nhật UI affected:
   *   - drawflow node data (editor.updateNodeDataFromId)
   *   - local nodes array (cho saveWorkflow lần sau dùng đúng)
   *   - form đang mở (toggle/input DOM nếu node bị patch là node đang select)
   *   - mention chips trong downstream prompts (regex replace @old_slug → @new_slug)
   *   - badges + inline pills (re-render)
   *   - Toast user
   *
   * @param {object} _saveResult Response từ saveWorkflowFull (đã unwrap data)
   * @param {array} nodes Local nodes array (sẽ được patch in-place)
   */
  _syncServerNodesIntoEditor(_saveResult, nodes) {
    const serverNodes = Array.isArray(_saveResult?.nodes) ? _saveResult.nodes : [];
    if (serverNodes.length === 0 || !this.diagramCanvas?.editor) return;

    // Fields server có thể mutate (generic whitelist — dùng hasOwnProperty để
    // phân biệt explicit null vs missing field)
    const SERVER_MUTABLE_FIELDS = [
      'slug', 'slug_auto', 'prompt_source',
      'prompt_mode', 'ref_mode',
      'video_duration', 'delay_seconds',
      'provider', // cross-field validate có thể fix
    ];

    const editor = this.diagramCanvas.editor;
    const moduleData = editor.drawflow?.drawflow?.Home?.data || {};
    const renamed = [];           // slug rename history (cho mention chips update)
    const promptSourceFixed = [];
    const otherFieldsFixed = [];

    for (const srv of serverNodes) {
      if (!srv?.node_id) continue;
      const localNode = nodes.find(n => n.node_id === srv.node_id);
      if (!localNode) continue;

      const patches = {};
      for (const field of SERVER_MUTABLE_FIELDS) {
        if (!Object.prototype.hasOwnProperty.call(srv, field)) continue;
        // Strict equality fail false-positive cho cosmetic mismatch:
        //  - extension export `video_duration: ''` vs server DB `null`
        //  - `delay_seconds: undefined` vs `0`
        // Dùng _valuesEquivalent để bỏ qua trường hợp empty/null/undefined coi như nhau.
        if (this._valuesEquivalent(localNode[field], srv[field])) continue;

        // Track special diffs cho toast + mention update
        if (field === 'slug' && srv.slug) {
          renamed.push({ name: localNode.node_name, from: localNode.slug, to: srv.slug });
        } else if (field === 'prompt_source' && srv.prompt_source) {
          promptSourceFixed.push({ name: localNode.node_name, from: localNode.prompt_source, to: srv.prompt_source });
        } else if (field !== 'slug_auto') {
          otherFieldsFixed.push({ name: localNode.node_name, field, from: localNode[field], to: srv[field] });
        }

        // Apply patch
        patches[field] = srv[field];
        localNode[field] = srv[field];
      }

      if (Object.keys(patches).length === 0) continue;

      // Update drawflow data
      for (const [drawflowId, dfNode] of Object.entries(moduleData)) {
        if (dfNode?.data?.node_id === srv.node_id) {
          editor.updateNodeDataFromId(drawflowId, { ...dfNode.data, ...patches });

          // Form đang mở cho node này → update DOM trực tiếp (tránh phá state user đang edit)
          if (this.selectedNodeId && String(this.selectedNodeId) === String(drawflowId)) {
            this._syncFormDomAfterServerPatch(patches);
          }
          break;
        }
      }
    }

    // === Update mention chips downstream nếu slug đổi ===
    // Server rename `foo` → `foo_2` → các node downstream có prompt chứa @foo cần update thành @foo_2.
    // Strategy: extension-side regex replace để extension cũ cũng hưởng lợi (server không phải lo).
    if (renamed.length > 0) {
      this._updateMentionChipsAfterSlugRename(renamed, nodes);
    }

    // === Refresh node card UI + badges sau khi có thay đổi ===
    if (renamed.length > 0 || promptSourceFixed.length > 0 || otherFieldsFixed.length > 0) {
      try { this._scheduleRefreshNodeWarningBadges?.(); } catch (e) {}
      try { this._refreshAllPromptSourceBadges?.(); } catch (e) {}
      try { this._bindInlineSettingPills?.(); } catch (e) {}
      try { this._updatePortEmptyState?.(); } catch (e) {}
    }

    // === Toast cho user ===
    if (renamed.length > 0) {
      console.warn('[WorkflowEditor] Server-side slug rename detected:', renamed);
      const summary = renamed.map(r => `"${r.from}" → "${r.to}"`).join(', ');
      const msg = (window.I18n?.t('workflow.slugAutoRenamed') || 'Slug bị trùng đã được tự đổi:') + ' ' + summary;
      window.NotificationModal?.show?.({ type: 'info', message: msg, duration: 6000 });
    }
    if (promptSourceFixed.length > 0) {
      console.warn('[WorkflowEditor] Server auto-heal prompt_source:', promptSourceFixed);
      const names = promptSourceFixed.map(p => `"${p.name}"`).join(', ');
      const msg = (window.I18n?.t('workflow.promptSourceAutoHealed') || 'Đã tự chuyển sang dùng prompt từ upstream cho:') + ' ' + names;
      window.NotificationModal?.show?.({ type: 'info', message: msg, duration: 6000 });
    }
    if (otherFieldsFixed.length > 0) {
      console.warn('[WorkflowEditor] Server-side other field cleanup:', otherFieldsFixed);
    }
  }

  /**
   * So sánh 2 giá trị có "tương đương" về mặt logic không.
   * Tránh false-positive khi sync ngược: extension exports `''` cho field optional,
   * server normalize `null` → strict `===` báo khác → patch không cần thiết.
   *
   * Coi tương đương:
   *  - null === undefined === '' === [] === {} (all empty)
   *  - 0 === '0' (numeric)
   *  - true === 1 (boolean coerce)
   */
  _valuesEquivalent(a, b) {
    // Strict equal — trường hợp đơn giản nhất
    if (a === b) return true;
    // Cả 2 đều "empty" coi như nhau (null, undefined, '', 0)
    const isEmpty = (v) => v === null || v === undefined || v === '' || v === 0 || v === false;
    if (isEmpty(a) && isEmpty(b)) return true;
    // Loose equal cho number/string coercion (vd "5" == 5)
    /* eslint-disable eqeqeq */
    if (a == b) return true;
    /* eslint-enable eqeqeq */
    return false;
  }

  /**
   * Update DOM của form đang mở khi server patch fields của node đó.
   * Avoid full re-render để giữ state user đang edit (uploads, scrolling, ...).
   */
  _syncFormDomAfterServerPatch(patches) {
    try {
      if (Object.prototype.hasOwnProperty.call(patches, 'prompt_source')) {
        const toggle = this.overlay?.querySelector('#promptSourceToggle');
        if (toggle) toggle.checked = patches.prompt_source === 'textbox';
      }
      if (Object.prototype.hasOwnProperty.call(patches, 'slug')) {
        const slugInput = this.overlay?.querySelector('#nodeSlug');
        if (slugInput) slugInput.value = patches.slug;
      }
      // Các fields khác (prompt_mode, ref_mode, video_duration) thường ít khi server mutate
      // → khi nào trigger thì xử lý — hiện tại skip.
    } catch (e) {
      console.warn('[WorkflowEditor] _syncFormDomAfterServerPatch failed:', e?.message);
    }
  }

  /**
   * Update mention chips trong downstream nodes khi server rename slug.
   *
   * Regex replace `@old_slug` → `@new_slug` trong prompt của các node có mention.
   * Patch cả local nodes array, drawflow data, và DOM textarea (nếu form đang mở).
   *
   * @param {Array<{name, from, to}>} renamedList List slug đã đổi
   * @param {Array} nodes Local nodes array (mutate)
   */
  _updateMentionChipsAfterSlugRename(renamedList, nodes) {
    if (!Array.isArray(renamedList) || renamedList.length === 0) return;
    const editor = this.diagramCanvas?.editor;
    if (!editor) return;
    const moduleData = editor.drawflow?.drawflow?.Home?.data || {};

    let updatedCount = 0;
    for (const { from, to } of renamedList) {
      if (!from || !to || from === to) continue;
      // Escape regex special chars trong slug (slug pattern là [a-z][a-z0-9_]* nên không có special, nhưng safe)
      const escapedSlug = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Match `@slug` với word boundary để không nhầm với @foo_bar khi rename @foo
      const mentionRegex = new RegExp(`@${escapedSlug}(?![a-z0-9_])`, 'g');

      for (const localNode of nodes) {
        if (!localNode || typeof localNode.prompt !== 'string') continue;
        if (!mentionRegex.test(localNode.prompt)) continue;
        const newPrompt = localNode.prompt.replace(mentionRegex, `@${to}`);
        if (newPrompt === localNode.prompt) continue;
        localNode.prompt = newPrompt;
        updatedCount++;

        // Update drawflow data
        for (const [drawflowId, dfNode] of Object.entries(moduleData)) {
          if (dfNode?.data?.node_id === localNode.node_id) {
            editor.updateNodeDataFromId(drawflowId, { ...dfNode.data, prompt: newPrompt });
            // Update DOM textarea nếu form đang mở cho node này
            if (this.selectedNodeId && String(this.selectedNodeId) === String(drawflowId)) {
              // Form prompt textarea IDs khác nhau tùy node type (verified với code thực tế):
              // generate: #nodePrompt, chatgpt: #chatgptNodePrompt, grok: #grokNodePrompt, prompt: #promptNodeText
              const promptTextarea = this.overlay?.querySelector('#nodePrompt')
                || this.overlay?.querySelector('#chatgptNodePrompt')
                || this.overlay?.querySelector('#grokNodePrompt')
                || this.overlay?.querySelector('#promptNodeText');
              if (promptTextarea && promptTextarea.value !== newPrompt) {
                promptTextarea.value = newPrompt;
              }
            }
            break;
          }
        }
      }
    }

    if (updatedCount > 0) {
      console.warn(`[WorkflowEditor] Updated ${updatedCount} mention occurrences sau khi server rename slug`);
    }
  }

  // Phase 3 cleanup: _isChatGPTOnlyWorkflow() helper đã removed.
  // Workflow giờ luôn gắn với Flow project (Phase 1 migration).

  async saveWorkflow(opts = {}) {
    if (!this.diagramCanvas) return false;
    // [Audit Bug 8 fix 2026-06-22] opts.snapshot = { nodes, edges, wfName } captured khi queue.
    // Khi follow-up save fire qua setTimeout, dùng snapshot này thay vì re-read DOM (tránh lost edit).
    const _snapshot = opts.snapshot || null;

    // Read-only mode: không cho phép save
    if (this.isReadOnly()) {
      console.log('[WorkflowEditor] saveWorkflow() blocked - read-only mode');
      return false;
    }

    // Template mode: không gọi saveWorkflow() - dùng _updateTemplate() hoặc _createTemplate() thay thế
    if (this.isTemplateMode) {
      console.log('[WorkflowEditor] saveWorkflow() skipped in template mode');
      return false;
    }

    // Block save khi workflow đang chạy (local hoặc cross-context)
    // Tránh race condition giữa save và executor update status
    if (window.workflowExecutor?.isRunning) {
      // 2026-05-31: silently skip save khi workflow đang chạy. Trước có toast warning
      // "Không thể lưu..." nhưng user feedback: misleading (tưởng có lỗi). Workflow
      // executor đã tự sync node state khi done → user KHÔNG cần biết save bị skip.
      // Giữ console.log cho dev debug.
      console.log('[WorkflowEditor] saveWorkflow() silently skipped - workflow executing');
      return false;
    }

    // Option A3 — Version-aware grandfather logic cho workflows_nodes_max.
    // Cho phép legacy workflow over-quota EDIT/GIẢM nodes, chỉ block khi TĂNG count
    // vượt limit. Đồng bộ với backend grandfather logic.
    //
    // Logic:
    //   - newCount > limit AND newCount > existingCount → reject (đang TĂNG)
    //   - newCount > limit AND newCount <= existingCount → allow (giữ nguyên/giảm)
    //   - newCount <= limit → allow
    if (window.featureGate) {
      try {
        const exportedNodes = this.diagramCanvas.exportWorkflow().nodes || [];
        const newCount = exportedNodes.length;
        const existingCount = (this.workflow?.nodes || []).length;
        const nodeQuota = window.featureGate.checkQuota('workflows_nodes_max');
        const limit = nodeQuota?.limit;

        if (limit !== 'unlimited' && limit !== '-1' && limit > 0 && newCount > limit) {
          // Grandfather: cho phép nếu đang giữ nguyên hoặc giảm count
          if (newCount > existingCount) {
            const dialog = window.customDialog || window.CustomDialog;
            const isLegacy = existingCount > limit;
            const message = isLegacy
              ? (window.I18n?.t('workflow.nodeQuotaCannotAdd', { existing: existingCount, limit })
                || `Workflow đang có ${existingCount} node (vượt giới hạn ${limit} của gói). Bạn có thể chỉnh sửa hoặc xóa bớt, nhưng KHÔNG thể thêm node mới. Nâng cấp gói để mở rộng.`)
              : (window.I18n?.t('workflow.nodeQuotaExceeded', { count: newCount, limit })
                || `Workflow has ${newCount} nodes but current plan limits to ${limit}. Please delete nodes or upgrade.`);
            const confirmed = await dialog?.confirm(message, {
              title: window.I18n?.t('workflow.limitReached') || 'Node limit exceeded',
              type: 'warning',
              confirmText: window.I18n?.t('common.upgrade') || 'Upgrade',
              cancelText: window.I18n?.t('common.later') || 'Later',
            });
            if (confirmed) {
              chrome.runtime.sendMessage({ action: 'openSettings' });
            }
            return;
          }
          // Grandfather case: log info để dev biết save đang allow legacy
          console.info('[WorkflowEditor] Grandfather save: legacy workflow over-quota (' +
            newCount + '/' + limit + '), allow vì không tăng count (existing=' + existingCount + ')');
        }
      } catch (e) {
        console.warn('[WorkflowEditor] Quota check error (non-fatal):', e.message);
      }
    }

    // Check workflow limit (only on create mode)
    // Luôn fetch async từ server để có entitlements mới nhất theo user plan
    if (this.mode === 'create' && window.featureGate) {
      const canCreate = await window.featureGate.canCreateWorkflowAsync();
      if (!canCreate) {
        const isLoggedIn = window.authManager?.isLoggedIn();
        if (!isLoggedIn) {
          window.featureGate.showLoginPrompt(
            window.I18n?.t('workflow.requireLoginToCreate') || 'Tạo workflow yêu cầu đăng nhập'
          );
        } else {
          const quota = window.featureGate.checkQuota('workflows_max');
          console.log('[TobyFlow] Workflow quota exceeded:', quota);
          const dialog = window.customDialog || window.CustomDialog;
          const confirmed = await dialog?.confirm(
            window.I18n?.t('workflow.quotaExceeded', { limit: quota.limit, used: quota.used }) || `Your plan limits to ${quota.limit} workflows. You have ${quota.used}. Upgrade Premium for unlimited.`,
            { title: window.I18n?.t('workflow.limitReached') || 'Limit reached', type: 'warning', confirmText: window.I18n?.t('common.upgrade') || 'Upgrade', cancelText: window.I18n?.t('common.later') || 'Later' }
          );
          if (confirmed) {
            chrome.runtime.sendMessage({ action: 'openSettings' });
          }
        }
        return;
      }
    }

    // Prevent concurrent saves — queue instead of silent skip
    // Bug fix: Trước đây `return` ngay → caller không biết save bị skip → status không persist
    // [Audit Bug 8 fix 2026-06-22] Snapshot DOM state ngay trước khi queue → follow-up save
    // không re-read DOM (tránh lost edit nếu user navigate away sau khi click Save lần 2).
    if (this._isSaving) {
      this._pendingSaveRequest = true;
      // Snapshot toàn bộ workflow data tại thời điểm này. Follow-up save sẽ dùng snapshot này
      // thay vì re-read DOM. Mỗi click Save mới sẽ overwrite snapshot trước (latest wins).
      try {
        const { nodes, edges } = this.diagramCanvas?.exportWorkflow?.() || { nodes: [], edges: [] };
        const wfName = this.overlay?.querySelector('#workflowName')?.value?.trim() || '';
        this._pendingSaveSnapshot = { nodes, edges, wfName, capturedAt: Date.now() };
      } catch (_) { /* snapshot best-effort, follow-up sẽ fallback re-read DOM */ }
      console.log('[WorkflowEditor] saveWorkflow() queued — another save in progress (snapshot captured)');
      return false; // Return false - caller should wait or retry
    }
    this._isSaving = true;
    this._pendingSaveRequest = false;

    // CRITICAL: Pre-try block phải nằm trong try/finally — bug fix `_isSaving stuck`.
    // Trước fix: code 5645-5672 (apply form, querySelector DOM, set disabled, innerHTML)
    // chạy NGOÀI try/catch. Nếu BẤT KỲ throw nào (vd `_applyNodeFormData` exception, DOM
    // null ref, innerHTML XSS error) → finally KHÔNG chạy → `_isSaving=true` stuck forever
    // → mọi save tiếp theo `if (this._isSaving) return;` ngắt → save button + play button
    // disabled mãi mãi cho đến reload extension.
    let saveBtn, resetBtn, closeBtn, deleteNodeBtn, saveBtnOrigText;
    try {
      // CRITICAL: Chỉ apply form data khi sidebar form ĐANG MỞ.
      // Drawflow set selectedNodeId khi user chỉ click highlight node (chưa mở form).
      // Nếu apply form data trong trường hợp này → đọc form fields rỗng/stale →
      // GHI ĐÈ quick-edit pill changes vừa update vào Drawflow data.
      // SKIP khi inline save đang chạy — inline handler đã update node data trực tiếp,
      // apply form data có thể ghi đè với data cũ từ sidebar form của node khác.
      if (this.selectedNodeId && !this._inlineSaveInProgress) {
        const formPanel = this.overlay?.querySelector('#nodeFormPanel');
        const isPanelOpen = formPanel && !formPanel.classList.contains('hidden');
        if (isPanelOpen) {
          this._applyNodeFormData();
        }
      }

      saveBtn = this.overlay?.querySelector('#saveWorkflowBtn');
      resetBtn = this.overlay?.querySelector('#resetWorkflowInEditorBtn');
      closeBtn = this.overlay?.querySelector('#closeEditorBtn');
      saveBtnOrigText = saveBtn?.textContent;
      deleteNodeBtn = this.overlay?.querySelector('#deleteNodeBtn');

      // Disable save, reset, close, run, delete buttons & show loading
      if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.innerHTML = `<span class="tobyflow-loading-spinner" style="width:14px;height:14px;border-width:2px;display:inline-block;vertical-align:-2px;margin-right:4px;"></span>${window.I18n?.t('common.saving') || 'Saving...'}`;
      }
      if (resetBtn) resetBtn.disabled = true;
      if (closeBtn) closeBtn.disabled = true;
      if (deleteNodeBtn) deleteNodeBtn.disabled = true;
      // Disable play buttons via centralized method (also checks deferred save state)
      this._updatePlayButtonState();
      // [Audit Bug 8 fix 2026-06-22] Use snapshot nếu có (queued follow-up), else read DOM hiện tại.
      const workflowName = _snapshot?.wfName ?? this.overlay?.querySelector('#workflowName')?.value?.trim();
      const { nodes, edges } = _snapshot
        ? { nodes: _snapshot.nodes, edges: _snapshot.edges }
        : this.diagramCanvas.exportWorkflow();

      // Debug: log ChatGPT node data before save
      const chatgptNodes = nodes.filter(n => n.node_type === 'chatgpt');
      if (chatgptNodes.length > 0) {
        console.log('[WorkflowEditor] saveWorkflow - ChatGPT nodes data:', chatgptNodes.map(n => ({
          node_id: n.node_id,
          status: n.status,
          result_file_ids: n.result_file_ids?.substring(0, 50),
          has_result_thumbnails: !!(n.result_thumbnails && Object.keys(n.result_thumbnails).length > 0),
        })));
      }

      // Build workflow metadata (without nodes/edges - they're saved separately)
      const { nodes: _n, edges: _e, ...workflowBase } = (this.workflow || {});
      // Phase 1 (Flow-centric model): MỌI workflow gắn với Flow project.
      // - Edit: preserve project_id cũ (kể cả null cho legacy items chưa migrate)
      // - Create: gán current project. Nếu null (extension chưa truy cập Flow tab) →
      //   _showProjectSelectOverlay() đã enforce ở app.js init flow → user không thể save
      //   workflow ở state này. Save fallback null là defensive.
      // Bỏ heuristic _isChatGPTOnlyWorkflow → ChatGPT-only workflow cũng gắn project,
      // do auto-download path build từ workflow.wf_name + Flow output folder context.
      const preservedProjectId = workflowBase.project_id !== undefined
        ? workflowBase.project_id
        : (window._currentProjectId || null);
      // Auto-migrate: workflow legacy (project_id=null) → khi user save lại trên project
      // hiện tại → gán project_id current để thoát "Legacy" group.
      const isLegacyShared = preservedProjectId === null;
      const computedProjectId = isLegacyShared
        ? (window._currentProjectId || null)  // migrate khi có current project
        : preservedProjectId;
      const workflowData = {
        ...workflowBase,
        wf_name: workflowName || (window.I18n?.t('workflow.untitled') || 'Workflow không tên'),
        progress_total: nodes.length,
        project_id: computedProjectId,
        platform: 'flow',
      };
      if (!window.storageManager) {
        console.error('[TobyFlow] storageManager chưa khởi tạo');
        window.customDialog?.alert(window.I18n?.t('workflow.storageNotReady') || 'Lỗi: Storage chưa sẵn sàng. Hãy thử lại.', { type: 'error' });
        return;
      }

      // Empty-nodes guard: nếu save với 0 nodes mà cached workflow đã có nodes
      // → có thể là race bug (load chưa xong) hoặc user clear all chủ ý.
      // Show modal yêu cầu user xác nhận. Nếu confirm → set flag `confirmed_clear: true`
      // để backend cho phép wipe. Race bug → user không confirm → backend reject 422 → bảo vệ data.
      const cachedNodeCount = (this.workflow?.nodes?.length) || 0;
      if (nodes.length === 0 && cachedNodeCount > 0 && this.mode === 'edit') {
        const I = window.I18n;
        const confirmed = await window.customDialog?.confirm(
          I?.t('workflow.confirmClearAllMsg', { count: cachedNodeCount })
            || `Bạn sắp xóa hết ${cachedNodeCount} nodes hiện có trên server. Hành động này không thể hoàn tác. Tiếp tục?`,
          {
            title: I?.t('workflow.confirmClearAllTitle') || 'Xác nhận xóa hết nodes',
            type: 'warning',
            confirmText: I?.t('workflow.confirmClearAllConfirm') || 'Xóa hết',
            cancelText: I?.t('common.cancel') || 'Hủy',
          }
        );
        if (!confirmed) {
          // User hủy → abort save, giữ state hiện tại
          this._isSaving = false;
          this._pendingSaveRequest = false;
          // Re-enable buttons
          if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = saveBtnOrigText || 'Save'; }
          if (resetBtn) resetBtn.disabled = false;
          if (closeBtn) closeBtn.disabled = false;
          if (deleteNodeBtn) deleteNodeBtn.disabled = false;
          this._updatePlayButtonState();
          return;
        }
        // User confirm → đính flag để backend cho phép wipe
        workflowData.confirmed_clear = true;
        console.log('[WorkflowEditor] User confirmed clear all nodes (was', cachedNodeCount, 'nodes)');
      }

      // Strip base64 data URLs từ node thumbnails trước khi save
      // AND replace upload_xxx keys với real tile_ids từ ImmediateUploader
      const cleanNodes = nodes.map(n => {
        const cleaned = { ...n };
        // Replace upload_xxx in ref_file_ids (STRING) with real tile_ids
        if (cleaned.ref_file_ids && typeof cleaned.ref_file_ids === 'string') {
          const ids = cleaned.ref_file_ids.split(',').map(s => s.trim()).filter(Boolean);
          const fixedIds = ids.map(id => {
            if (id.startsWith('upload_')) {
              const realTileId = window.ImmediateUploader?.getResult?.(id);
              if (realTileId && typeof realTileId === 'string' && !realTileId.startsWith('upload_')) {
                console.log('[TobyFlow] saveWorkflow: replaced upload key', id, '->', realTileId);
                return realTileId;
              }
            }
            return id;
          });
          cleaned.ref_file_ids = fixedIds.join(', ');
        }
        // Also fix ref_thumbnails keys (OBJECT)
        if (cleaned.ref_thumbnails && typeof cleaned.ref_thumbnails === 'object') {
          const fixedThumbs = {};
          for (const [k, v] of Object.entries(cleaned.ref_thumbnails)) {
            if (k.startsWith('upload_')) {
              const realTileId = window.ImmediateUploader?.getResult?.(k);
              if (realTileId && typeof realTileId === 'string' && !realTileId.startsWith('upload_')) {
                fixedThumbs[realTileId] = v;
              } else {
                fixedThumbs[k] = v;
              }
            } else {
              fixedThumbs[k] = v;
            }
          }
          cleaned.ref_thumbnails = fixedThumbs;
        }
        for (const field of ['ref_thumbnails', 'result_thumbnails']) {
          if (cleaned[field] && typeof cleaned[field] === 'object') {
            const trimmed = {};
            for (const [k, v] of Object.entries(cleaned[field])) {
              if (typeof v === 'string' && v.startsWith('data:') && v.length > 500) continue;
              if (typeof v === 'object' && v?.thumbnail?.startsWith?.('data:') && v.thumbnail.length > 500) {
                trimmed[k] = { ...v, thumbnail: '' };
              } else {
                trimmed[k] = v;
              }
            }
            cleaned[field] = Object.keys(trimmed).length > 0 ? trimmed : null;
          }
        }
        return cleaned;
      });
      // [DEBUG SAVE] Log save start
      console.log('[SAVE_DEBUG] >>> Calling saveWorkflowFull', {
        wf_id: workflowData.wf_id,
        mode_before: this.mode,
        editorMode_before: this.editorMode,
        nodes_count: cleanNodes.length,
        edges_count: edges.length,
      });

      const _saveResult = await window.storageManager.saveWorkflowFull(workflowData, cleanNodes, edges);

      // [DEBUG SAVE] Log server response shape
      console.log('[SAVE_DEBUG] <<< Server response received', {
        wf_id: _saveResult?.wf_id || '(missing)',
        nodes_returned: Array.isArray(_saveResult?.nodes) ? _saveResult.nodes.length : 'NOT ARRAY',
        edges_returned: Array.isArray(_saveResult?.edges) ? _saveResult.edges.length : 'NOT ARRAY',
        has_data: !!_saveResult,
        keys: _saveResult ? Object.keys(_saveResult).slice(0, 10) : [],
      });

      // Sync server-side mutations back vào editor (backend auto-rename duplicate slug
      // + auto-heal stale prompt_source + cross-field cleanup trong BulkSaveWorkflowRequest
      // → response chứa data đã sửa). Generic whitelist patch để future-proof khi backend
      // mutate thêm fields.
      try {
        this._syncServerNodesIntoEditor(_saveResult, nodes);
      } catch (e) {
        console.warn('[WorkflowEditor] Sync server response failed:', e?.message);
      }

      // Update this.workflow reference to match saved data (preserve nodes/edges for background scan)
      this.workflow = { ...workflowData, wf_name: workflowName || (window.I18n?.t('workflow.untitled') || 'Workflow không tên'), nodes, edges };

      // Show save success toast
      this._showSaveToast();
      this._hasUnsavedChanges = false;
      // Phase: sync UI để hiển thị/ẩn play button đúng trạng thái save
      this._syncExecutionUI();

      // Emit event to update workflow list in extension sidebar
      window.eventBus?.emit('storage:workflow_saved', { wfId: workflowData.wf_id });
      // Notify other contexts (popup editor window ↔ sidePanel)
      try {
        chrome.runtime.sendMessage({ action: 'workflowSaved', wfId: workflowData.wf_id });
      } catch (e) {}

      // Fire-and-forget: cache ref image blobs cho tat ca nodes
      const allNodeData = this._getAllNodeData?.() || [];
      for (const nd of allNodeData) {
        if (nd.ref_file_ids) this._cacheNodeRefImageBlobs(nd).catch(() => {});
      }

      // After first save, switch to edit mode and show play/stop buttons
      if (this.mode === 'create') {
        // [DEBUG SAVE] Log mode switch
        console.log('[SAVE_DEBUG] === Switching mode: create → edit', {
          wf_id: workflowData.wf_id,
          editorMode_before: this.editorMode,
          editorMode_after: 'workflow_edit',
          canRun_before: this.canRun(),
        });
        this.mode = 'edit';
        // Bug fix CRITICAL: ALSO update editorMode → getPermissions() returns WORKFLOW_EDIT perms.
        // Trước fix: chỉ set this.mode='edit', editorMode vẫn WORKFLOW_CREATE → canRun=false →
        // click Run button bị block silent (chỉ console gọi _runWorkflowFromEditor() direct mới chạy).
        this.editorMode = EditorMode.WORKFLOW_EDIT;
        console.log('[SAVE_DEBUG] === Mode switched, canRun now:', this.canRun());
        // Update editingWorkflowId in background.js (was null when opened in create mode)
        try { chrome.runtime.sendMessage({ action: 'updateEditingWorkflowId', wfId: workflowData.wf_id }); } catch (e) {}
        // Trial gate: ghi nhận tạo workflow (chỉ cho not-logged-in users)
        // IMPORTANT: Must await to ensure usage is recorded before next action
        if (window.featureGate && !window.authManager?.isLoggedIn()) {
          await window.featureGate.recordWorkflowCreated();
        }
        // Refresh featureGate to update workflow count for next create
        if (window.featureGate) {
          window.featureGate.refresh({ force: true }).catch(e => console.warn('[WorkflowEditor] FeatureGate refresh failed:', e));
        }
        // Show toolbar play and export buttons (were hidden in create mode)
        this.overlay?.querySelector('.tobyflow-wf-tool-btn[data-action="run-workflow"]')?.classList.remove('hidden');
        this.overlay?.querySelector('.tobyflow-wf-tool-btn[data-action="export-workflow"]')?.classList.remove('hidden');
        // Show reset button (was hidden in create mode)
        this.overlay?.querySelector('#resetWorkflowInEditorBtn')?.classList.remove('hidden');

        // Show "Save as Template" button nếu admin (was hidden vì chưa có workflowId)
        if (window.featureGate?.canManageWorkflowTemplates() && !this.isTemplateMode) {
          const closeBtn = this.overlay?.querySelector('#closeEditorBtn');
          if (closeBtn && !this.overlay?.querySelector('#wfSaveAsTemplateBtn')) {
            const saveAsBtn = document.createElement('button');
            saveAsBtn.className = 'btn btn-secondary btn-save-template';
            saveAsBtn.id = 'wfSaveAsTemplateBtn';
            saveAsBtn.title = window.I18n?.t('workflow.saveAsTemplate') || 'Lưu thành Template';
            saveAsBtn.innerHTML = `
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>
                <polyline points="17 21 17 13 7 13 7 21"/>
                <polyline points="7 3 7 8 15 8"/>
              </svg>
              <span>${window.I18n?.t('workflow.saveAsTemplate') || 'Lưu thành'}</span>
            `;
            saveAsBtn.addEventListener('click', () => this._saveAsTemplate());
            closeBtn.parentNode.insertBefore(saveAsBtn, closeBtn);
          }
        }
      }
      return true; // Save succeeded
    } catch (error) {
      console.error('[TobyFlow] Save FAILED:', error);

      // Quota error modal already shown by ApiStorage._handleQuotaError
      if (error.code === 'QUOTA_EXCEEDED' || error.message?.includes('giới hạn')) {
        return false;
      }

      // REQUIRES_LOGIN error - show login prompt (defensive, normally caught by canCreateWorkflowAsync)
      if (error.message === 'REQUIRES_LOGIN') {
        window.featureGate?.showLoginPrompt(
          window.I18n?.t('workflow.requireLoginToCreate') || 'Tạo workflow yêu cầu đăng nhập'
        );
        return false;
      }

      window.customDialog?.alert((window.I18n?.t('workflow.saveWorkflowError') || 'Không thể lưu workflow') + ': ' + error.message, { type: 'error' });
      return false; // Save failed
    } finally {
      this._isSaving = false;
      // Re-enable buttons
      if (saveBtn) {
        saveBtn.disabled = false;
        // Sau khi save create mode thành công, đổi button text thành "Lưu"
        // Nếu đang ở edit mode (bao gồm vừa chuyển từ create), dùng text "Lưu"
        const newBtnText = this.mode === 'edit'
          ? (window.I18n?.t('workflow.saveBtn') || 'Lưu')
          : (saveBtnOrigText || (window.I18n?.t('common.save') || 'Lưu'));
        saveBtn.textContent = newBtnText;
      }
      if (resetBtn) resetBtn.disabled = false;
      if (closeBtn) closeBtn.disabled = false;
      if (deleteNodeBtn) deleteNodeBtn.disabled = false;
      // Re-enable play buttons via centralized method (checks if deferred save still pending)
      this._updatePlayButtonState();

      // Process pending save request (queued while this save was running)
      // Bug fix: Trước đây saveWorkflow() return ngay khi _isSaving=true → changes bị mất
      // [Audit Bug 8 fix 2026-06-22] Pass snapshot (đã capture lúc queue) vào saveWorkflow
      // để tránh re-read DOM khi follow-up fire (DOM có thể đã change nếu user click sang node khác).
      if (this._pendingSaveRequest) {
        this._pendingSaveRequest = false;
        const snapshot = this._pendingSaveSnapshot;
        this._pendingSaveSnapshot = null;
        console.log('[WorkflowEditor] Processing queued save request' + (snapshot ? ' (using snapshot)' : ''));
        // Use setTimeout to avoid stack overflow và cho UI update
        setTimeout(() => this.saveWorkflow({ snapshot }).catch(e => console.warn('[WorkflowEditor] Queued save failed:', e)), 50);
      }
    }
  }

  // === Save as Template Methods (EWT-5) ===

  /**
   * Mở modal lưu workflow thành template (admin only)
   * EWT-5.1: Chỉ hiển thị cho admin users
   */
  /**
   * Capture diagram canvas → upload PNG làm preview public template.
   * Chỉ admin + template_edit mode. File cũ tự xóa qua diagram_path ở backend.
   */
  /**
   * Inline toast cho capture flow — không phụ thuộc window.showNotification
   * (template editor window không load app.js).
   */
  _showCaptureToast(message, type = 'info', sticky = false) {
    let toast = document.getElementById('tobyflow-capture-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'tobyflow-capture-toast';
      toast.style.cssText = `
        position: fixed; top: 20px; right: 20px; z-index: 999999;
        padding: 12px 18px; border-radius: 10px; font-size: 14px; font-weight: 500;
        color: #fff; box-shadow: 0 8px 24px rgba(0,0,0,0.3);
        display: flex; align-items: center; gap: 10px;
        max-width: 360px; transition: opacity 0.2s, transform 0.2s;
      `;
      document.body.appendChild(toast);
    }
    const colors = {
      info: 'background: linear-gradient(135deg, #6366f1, #4f46e5);',
      success: 'background: linear-gradient(135deg, #10b981, #059669);',
      error: 'background: linear-gradient(135deg, #ef4444, #dc2626);',
    };
    const icons = {
      info: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
      success: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>',
      error: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
    };
    const spinnerIcon = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="animation: spin 1s linear infinite"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>';
    toast.style.cssText += colors[type] || colors.info;
    toast.innerHTML = `${type === 'info' && sticky ? spinnerIcon : icons[type]}<span>${message}</span>`;

    if (!document.getElementById('tobyflow-capture-toast-style')) {
      const s = document.createElement('style');
      s.id = 'tobyflow-capture-toast-style';
      s.textContent = '@keyframes spin{to{transform:rotate(360deg)}}';
      document.head.appendChild(s);
    }

    if (!sticky) {
      clearTimeout(toast._timer);
      toast._timer = setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(-10px)';
        setTimeout(() => toast.remove(), 250);
      }, 3000);
    }
    return toast;
  }

  _hideCaptureToast() {
    const toast = document.getElementById('tobyflow-capture-toast');
    if (toast) {
      clearTimeout(toast._timer);
      toast.remove();
    }
  }

  /**
   * Update button state cho capture flow (loading / idle).
   */
  _setCaptureBtnLoading(loading) {
    const btn = this.overlay?.querySelector('#wfCaptureDiagramBtn');
    if (!btn) return;
    if (loading) {
      btn._originalHtml = btn.innerHTML;
      btn.disabled = true;
      btn.style.opacity = '0.7';
      btn.style.cursor = 'wait';
      btn.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="animation: spin 1s linear infinite">
          <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
        </svg>
        <span>Đang chụp...</span>
      `;
    } else {
      btn.disabled = false;
      btn.style.opacity = '';
      btn.style.cursor = '';
      if (btn._originalHtml) {
        btn.innerHTML = btn._originalHtml;
        btn._originalHtml = null;
      }
    }
  }

  async _captureDiagramAndUpload() {
    console.log('[WorkflowEditor] _captureDiagramAndUpload clicked', {
      isTemplateMode: this.isTemplateMode,
      templateId: this.templateId,
      isAdmin: window.featureGate?.canManageWorkflowTemplates(),
      hasHtml2canvas: typeof html2canvas,
    });
    if (!window.featureGate?.canManageWorkflowTemplates()) {
      console.warn('[WorkflowEditor] Capture blocked: not admin');
      window.showNotification?.(window.I18n?.t('workflow.adminRequired') || 'Cần quyền admin', 'error');
      return;
    }
    if (!this.templateId) {
      console.warn('[WorkflowEditor] Capture blocked: no templateId');
      window.showNotification?.('Chưa có templateId', 'error');
      return;
    }
    if (typeof html2canvas !== 'function') {
      console.error('[WorkflowEditor] Capture blocked: html2canvas not loaded. Check sidebar.html includes <script src="lib/html2canvas.min.js">');
      window.showNotification?.('html2canvas chưa load — kiểm tra console', 'error');
      return;
    }

    const captureBtn = this.overlay?.querySelector('#wfCaptureDiagramBtn');
    const targetEl = this.overlay?.querySelector('.diagram-container') || this.overlay?.querySelector('.diagram-canvas');
    console.log('[WorkflowEditor] Capture target:', targetEl);
    if (!targetEl) {
      console.warn('[WorkflowEditor] Capture blocked: diagram container not found');
      window.showNotification?.('Không tìm thấy diagram container', 'error');
      return;
    }

    // Hide control overlays (zoom controls, recenter, brand zone) trước khi capture để ảnh sạch.
    const hiddenEls = Array.from(targetEl.querySelectorAll(
      '.canvas-controls, .diagram-recenter-btn, .canvas-brand-zone, .workflow-progress, .df-select-box'
    ));
    const prevVisibility = hiddenEls.map(el => el.style.visibility);
    hiddenEls.forEach(el => (el.style.visibility = 'hidden'));

    // Inject styles + sửa SVG attrs TRỰC TIẾP trên live DOM (onclone không đáng tin cho html2canvas
    // với SVG transform). Restore trong finally. User có thể thấy flash 1-2 frame.
    const tempStyle = document.createElement('style');
    tempStyle.id = 'tobyflow-capture-temp-style';
    tempStyle.textContent = `
      /* Match diagram-container bg solid + bỏ dot grid (cleaner capture, không có pattern) */
      .diagram-container {
        background: #111111 !important;
        background-image: none !important;
      }
      /* Connections — broader selector + thicker stroke */
      svg.connection, [class*="connection"] svg, .drawflow svg {
        overflow: visible !important;
        shape-rendering: geometricPrecision !important;
      }
      svg.connection path,
      .drawflow svg path.main-path,
      .drawflow .connection path,
      [class*="connection"] path {
        fill: none !important;
        stroke: #818cf8 !important;
        stroke-width: 7px !important;
        stroke-linecap: round !important;
        stroke-linejoin: round !important;
        stroke-dasharray: none !important;
        stroke-miterlimit: 10 !important;
        vector-effect: non-scaling-stroke !important;
        opacity: 1 !important;
      }
      .drawflow .point, .drawflow .point.selected {
        fill: #818cf8 !important;
        stroke: #ffffff !important;
        stroke-width: 2px !important;
      }
      /* Brighten port circles (12px) — light bg + visible border để contrast với node */
      .drawflow .drawflow-node .input,
      .drawflow .drawflow-node .output {
        background: #d4d4d8 !important;
        border: 2px solid #ffffff !important;
        box-shadow: 0 0 0 1px rgba(0,0,0,0.3) !important;
      }
      /* Typed ports giữ màu theo type nhưng brightening */
      .drawflow .drawflow-node[data-port-type="image"] .input,
      .drawflow .drawflow-node[data-port-type="image"] .output,
      .drawflow .drawflow-node .input[data-port-type="image"],
      .drawflow .drawflow-node .output[data-port-type="image"] { background: #60a5fa !important; }
      .drawflow .drawflow-node[data-port-type="video"] .input,
      .drawflow .drawflow-node[data-port-type="video"] .output,
      .drawflow .drawflow-node .input[data-port-type="video"],
      .drawflow .drawflow-node .output[data-port-type="video"] { background: #c084fc !important; }
      .drawflow .drawflow-node[data-port-type="text"] .input,
      .drawflow .drawflow-node[data-port-type="text"] .output,
      .drawflow .drawflow-node .input[data-port-type="text"],
      .drawflow .drawflow-node .output[data-port-type="text"] { background: #4ade80 !important; }
      .df-port-icon { opacity: 1 !important; visibility: visible !important; }
      .df-port-icon img, .df-port-icon svg {
        width: 18px !important; height: 18px !important;
        display: block !important; opacity: 1 !important;
      }
    `;
    document.head.appendChild(tempStyle);

    // Convert SVG port icons → IMG data URL (html2canvas render <img> tin cậy hơn inline SVG nhỏ
    // trong absolute positioned + transformed parent). Trước khi serialize, replace currentColor → #fff.
    const svgReplacements = [];
    const allSvgs = targetEl.querySelectorAll('.df-port-icon svg');
    for (const svg of allSvgs) {
      try {
        // Clone để mutate fill/stroke không động vào DOM thật
        const clone = svg.cloneNode(true);
        clone.setAttribute('width', '18');
        clone.setAttribute('height', '18');
        clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
        clone.querySelectorAll('[fill="currentColor"]').forEach(el => el.setAttribute('fill', '#ffffff'));
        clone.querySelectorAll('[stroke="currentColor"]').forEach(el => el.setAttribute('stroke', '#ffffff'));
        // Default stroke = #fff nếu element không có stroke attr (inherit qua CSS color)
        if (!clone.getAttribute('stroke') && !clone.getAttribute('fill')) {
          clone.setAttribute('stroke', '#ffffff');
        }

        const svgStr = new XMLSerializer().serializeToString(clone);
        const dataUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgStr);

        // Wait for img to load (sync rendering trong capture)
        const img = await new Promise((resolve) => {
          const i = new Image();
          i.width = 18;
          i.height = 18;
          i.style.width = '18px';
          i.style.height = '18px';
          i.style.display = 'block';
          i.onload = () => resolve(i);
          i.onerror = () => resolve(i); // resolve even on error để không hang
          i.src = dataUrl;
        });

        const parent = svg.parentNode;
        parent.replaceChild(img, svg);
        svgReplacements.push({ img, svg, parent });
      } catch (err) {
        console.warn('[WorkflowEditor] SVG → IMG convert failed for one icon:', err);
      }
    }
    console.log(`[WorkflowEditor] Replaced ${svgReplacements.length}/${allSvgs.length} port SVGs with IMG for capture`);

    // Đợi 2 frames để browser load images + apply styles
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

    this._setCaptureBtnLoading(true);
    this._showCaptureToast('Đang chụp diagram, vui lòng chờ...', 'info', true);

    const t0 = performance.now();
    try {
      // Đợi 2 frames để diagram (SVG connections) flush layout ổn định trước capture.
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

      // Tính bbox thực tế của nodes + connections để CROP.
      const containerRect = targetEl.getBoundingClientRect();
      const nodeEls = targetEl.querySelectorAll('.drawflow-node');
      const connEls = targetEl.querySelectorAll('.connection, svg.connection');

      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      const collect = (el) => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return;
        minX = Math.min(minX, r.left);
        minY = Math.min(minY, r.top);
        maxX = Math.max(maxX, r.right);
        maxY = Math.max(maxY, r.bottom);
      };
      nodeEls.forEach(collect);
      connEls.forEach(collect);

      const PADDING = 24; // padding gọn hơn để giảm khoảng trắng dư
      const cropOptions = {};
      if (isFinite(minX)) {
        const x = Math.max(0, Math.floor(minX - containerRect.left - PADDING));
        const y = Math.max(0, Math.floor(minY - containerRect.top - PADDING));
        const w = Math.min(containerRect.width - x, Math.ceil(maxX - minX + 2 * PADDING));
        const h = Math.min(containerRect.height - y, Math.ceil(maxY - minY + 2 * PADDING));
        cropOptions.x = x;
        cropOptions.y = y;
        cropOptions.width = w;
        cropOptions.height = h;
        cropOptions.windowWidth = containerRect.width;
        cropOptions.windowHeight = containerRect.height;
        console.log('[WorkflowEditor] Crop bbox:', cropOptions, 'from', nodeEls.length, 'nodes +', connEls.length, 'connections');
      } else {
        console.warn('[WorkflowEditor] No nodes found, capture full container');
      }

      console.log('[WorkflowEditor] Step 1/4: html2canvas() rendering...', { w: targetEl.offsetWidth, h: targetEl.offsetHeight });

      // Default rendering — live DOM đã được patch sẵn (tempStyle + svg attrs).
      // backgroundColor match exact với .diagram-container (#111111) để vùng html2canvas-painted
      // ngoài container không lệch tone (tránh "dải đen khác màu" ở dưới ảnh).
      const canvas = await html2canvas(targetEl, {
        backgroundColor: '#111111',
        scale: 2,
        useCORS: true,
        allowTaint: false,
        logging: false,
        ...cropOptions,
      });
      console.log(`[WorkflowEditor] Step 1/4 done in ${Math.round(performance.now() - t0)}ms`, { canvasW: canvas.width, canvasH: canvas.height });

      console.log('[WorkflowEditor] Step 2/4: canvas → blob');
      const t1 = performance.now();
      const blob = await new Promise((resolve, reject) => {
        canvas.toBlob(b => (b ? resolve(b) : reject(new Error('toBlob null'))), 'image/png', 0.95);
      });
      console.log(`[WorkflowEditor] Step 2/4 done in ${Math.round(performance.now() - t1)}ms`, { blobSize: blob.size });

      console.log('[WorkflowEditor] Step 3/4: blob → base64');
      const t2 = performance.now();
      const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1]);
        reader.onerror = () => reject(new Error('FileReader failed'));
        reader.readAsDataURL(blob);
      });
      console.log(`[WorkflowEditor] Step 3/4 done in ${Math.round(performance.now() - t2)}ms`, { base64Len: base64.length });

      console.log('[WorkflowEditor] Step 4/4: upload via background.js');
      const t3 = performance.now();
      const response = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({
          action: 'apiRequest',
          method: 'POST',
          endpoint: `admin/workflow-templates/${this.templateId}/diagram`,
          token: window.authManager?.token,
          isFormData: true,
          formDataFields: {
            file: {
              name: `diagram_${Date.now()}.png`,
              type: 'image/png',
              base64,
            },
          },
        }, resp => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          console.log('[WorkflowEditor] Upload response:', resp);
          if (resp?.success) resolve(resp.data);
          else reject(new Error(resp?.error?.message || 'Upload failed'));
        });
      });
      console.log(`[WorkflowEditor] Step 4/4 done in ${Math.round(performance.now() - t3)}ms`, { response });

      if (this.templateData) {
        this.templateData.diagram_url = response?.diagram_url || this.templateData.diagram_url;
      }
      const totalMs = Math.round(performance.now() - t0);
      this._showCaptureToast(`Capture hoàn tất (${totalMs}ms)`, 'success');
    } catch (e) {
      console.error('[WorkflowEditor] Capture diagram failed:', e);
      this._showCaptureToast('Capture thất bại: ' + e.message, 'error');
    } finally {
      hiddenEls.forEach((el, i) => (el.style.visibility = prevVisibility[i] || ''));
      // Restore live DOM: replace IMG → original SVG + remove temp style
      const tempStyleEl = document.getElementById('tobyflow-capture-temp-style');
      if (tempStyleEl) tempStyleEl.remove();
      if (typeof svgReplacements !== 'undefined') {
        svgReplacements.forEach(({ img, svg, parent }) => {
          try {
            if (img.parentNode === parent) parent.replaceChild(svg, img);
          } catch (e) { /* ignore */ }
        });
      }
      this._setCaptureBtnLoading(false);
    }
  }

  async _saveAsTemplate() {
    // Kiểm tra quyền admin
    if (!window.featureGate?.canManageWorkflowTemplates()) {
      window.showNotification?.(
        window.I18n?.t('workflow.adminRequired') || 'Bạn cần quyền admin để lưu template',
        'error'
      );
      return;
    }

    // Kiểm tra SaveTemplateModal đã load chưa
    if (!window.SaveTemplateModal) {
      console.error('[WorkflowEditor] SaveTemplateModal chưa được load');
      window.showNotification?.(
        window.I18n?.t('workflow.saveTemplateModuleNotReady') || 'Module SaveTemplateModal chưa sẵn sàng',
        'error'
      );
      return;
    }

    // Lấy dữ liệu workflow hiện tại từ Drawflow live state
    if (!this.diagramCanvas) {
      window.showNotification?.(
        window.I18n?.t('workflow.noWorkflowData') || 'Không có dữ liệu workflow',
        'error'
      );
      return;
    }

    try {
      // Export nodes và edges từ Drawflow
      const { nodes, edges } = this.diagramCanvas.exportWorkflow();
      const workflowName = this.overlay?.querySelector('#workflowName')?.value?.trim() || this.workflow?.wf_name || 'Workflow Template';

      // Tạo workflow data object để truyền vào SaveTemplateModal
      const workflowData = {
        wf_name: workflowName,
        description: this.workflow?.description || '',
        nodes: nodes,
        edges: edges,
        settings: this.workflow?.settings || {}
      };

      // Mở modal SaveTemplateModal
      const result = await window.SaveTemplateModal.show(workflowData);

      if (result?.success) {
        console.log('[WorkflowEditor] Template đã được lưu:', result.template);
        // Success notification đã hiển thị trong SaveTemplateModal
      }
    } catch (error) {
      console.error('[WorkflowEditor] Lỗi khi lưu template:', error);
      window.showNotification?.(
        (window.I18n?.t('workflow.cannotSaveTemplate') || 'Không thể lưu template') + ': ' + error.message,
        'error'
      );
    }
  }

  /**
   * EWT-6.3: Cập nhật template đã tồn tại lên server
   * Gọi PUT /admin/workflow-templates/{id}
   */
  async _updateTemplate() {
    if (!this.isTemplateMode || !this.templateId) {
      console.error('[WorkflowEditor] _updateTemplate: không ở template mode');
      return;
    }

    if (!this.diagramCanvas) {
      console.error('[WorkflowEditor] _updateTemplate: diagramCanvas chưa khởi tạo');
      return;
    }

    // Kiểm tra quyền admin
    if (!window.featureGate?.canManageWorkflowTemplates()) {
      window.showNotification?.(
        window.I18n?.t('workflow.adminRequired') || 'Bạn cần quyền admin để cập nhật template',
        'error'
      );
      return;
    }

    // Prevent concurrent saves — queue instead of silent skip (consistency với saveWorkflow)
    if (this._isSaving) {
      this._pendingSaveRequest = true;
      console.log('[WorkflowEditor] _updateTemplate() queued — another save in progress');
      return;
    }
    this._isSaving = true;
    this._pendingSaveRequest = false;

    let saveBtn, resetBtn, closeBtn, saveBtnOrigText;
    try {
      // Apply form data nếu đang mở (skip khi inline save đang chạy)
      if (this.selectedNodeId && !this._inlineSaveInProgress) {
        const formPanel = this.overlay?.querySelector('#nodeFormPanel');
        const isPanelOpen = formPanel && !formPanel.classList.contains('hidden');
        if (isPanelOpen) {
          this._applyNodeFormData();
        }
      }

      saveBtn = this.overlay?.querySelector('#saveWorkflowBtn');
      resetBtn = this.overlay?.querySelector('#resetWorkflowInEditorBtn');
      closeBtn = this.overlay?.querySelector('#closeEditorBtn');
      saveBtnOrigText = saveBtn?.textContent;

      // Disable buttons & show loading
      if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.innerHTML = `<span class="tobyflow-loading-spinner" style="width:14px;height:14px;border-width:2px;display:inline-block;vertical-align:-2px;margin-right:4px;"></span>${window.I18n?.t('common.saving') || 'Saving...'}`;
      }
      if (resetBtn) resetBtn.disabled = true;
      if (closeBtn) closeBtn.disabled = true;

      // Lấy dữ liệu từ editor
      const templateName = this.overlay?.querySelector('#workflowName')?.value?.trim() || this.templateData?.name || 'Template';
      const { nodes, edges } = this.diagramCanvas.exportWorkflow();

      // Chuyển đổi nodes sang template format
      const templateNodes = this._convertNodesToTemplateFormat(nodes);
      const templateEdges = this._convertEdgesToTemplateFormat(edges);

      // Build template data để gửi lên server
      const templatePayload = {
        name: templateName,
        description: this.templateData?.description || '',
        category_id: this.templateData?.category_id || null,
        thumbnail_url: this.templateData?.thumbnail_url || null,
        video_url: this.templateData?.video_url || null,
        is_premium: this.templateData?.is_premium || false,
        is_featured: this.templateData?.is_featured || false,
        // Backend uses is_active (not is_published)
        is_active: this.templateData?.is_published !== false,
        nodes: templateNodes,
        edges: templateEdges,
        settings: this.workflow?.settings || {},
      };

      console.log('[WorkflowEditor] Đang cập nhật template:', this.templateId, templatePayload);

      // Gọi API cập nhật template
      const response = await window.authManager._apiCall(
        'PUT',
        `admin/workflow-templates/${this.templateId}`,
        templatePayload
      );

      console.log('[WorkflowEditor] Template đã cập nhật thành công:', response);

      // Cập nhật local state nếu server trả về data mới
      if (response?.template) {
        this.templateData = {
          ...this.templateData,
          name: response.template.name,
          description: response.template.description,
        };
      }

      // Hiển thị thông báo thành công trong editor overlay
      const successMsg = window.I18n?.t('workflow.templateUpdated') || 'Template updated successfully';
      this._showEditorToast(successMsg, 'success');
      console.log('[WorkflowEditor] ✓ Template updated:', this.templateId);

      this._hasUnsavedChanges = false;

      // Emit event để refresh template list nếu cần
      if (window.eventBus) {
        window.eventBus.emit('template:updated', { templateId: this.templateId });
      }
      // Relay to sidebar (popup has separate eventBus instance)
      try {
        chrome.runtime.sendMessage({ action: 'templateUpdated', templateId: this.templateId });
      } catch (e) { /* ignore */ }

    } catch (error) {
      console.error('[WorkflowEditor] Cập nhật template thất bại:', error);

      let errorMessage = error.message || (window.I18n?.t('workflow.updateTemplateFailed') || 'Không thể cập nhật template');

      // Xử lý các loại lỗi cụ thể
      if (error.httpStatus === 401 || error.code === 'UNAUTHENTICATED') {
        errorMessage = window.I18n?.t('auth.sessionExpired') || 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.';
      } else if (error.httpStatus === 403) {
        errorMessage = window.I18n?.t('workflow.noPermission') || 'Bạn không có quyền cập nhật template này';
      } else if (error.httpStatus === 404) {
        errorMessage = window.I18n?.t('workflow.templateNotFound') || 'Template không tồn tại hoặc đã bị xóa';
      } else if (error.httpStatus >= 500) {
        errorMessage = window.I18n?.t('common.serverError') || 'Lỗi máy chủ. Vui lòng thử lại sau.';
      }

      this._showEditorToast(errorMessage, 'error');

    } finally {
      this._isSaving = false;
      // Re-enable buttons
      if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.textContent = saveBtnOrigText || (window.I18n?.t('workflow.updateTemplate') || 'Cập nhật Template');
      }
      if (resetBtn) resetBtn.disabled = false;
      if (closeBtn) closeBtn.disabled = false;

      // Process pending save request (consistency với saveWorkflow)
      if (this._pendingSaveRequest) {
        this._pendingSaveRequest = false;
        console.log('[WorkflowEditor] Processing queued template update');
        setTimeout(() => this._updateTemplate().catch(e => console.warn('[WorkflowEditor] Queued template update failed:', e)), 50);
      }
    }
  }

  /**
   * EWT-10: Tạo template mới (khi isTemplateMode=true và templateId=null)
   * Mở SaveTemplateModal để nhập metadata và lưu lên server
   */
  async _createTemplate() {
    // Kiểm tra quyền admin
    if (!window.featureGate?.canManageWorkflowTemplates()) {
      window.showNotification?.(
        window.I18n?.t('workflow.adminRequired') || 'Bạn cần quyền admin để tạo template',
        'error'
      );
      return;
    }

    // Kiểm tra SaveTemplateModal đã load chưa
    if (!window.SaveTemplateModal) {
      console.error('[WorkflowEditor] SaveTemplateModal chưa được load');
      window.showNotification?.(
        window.I18n?.t('workflow.saveTemplateModuleNotReady') || 'Module SaveTemplateModal chưa sẵn sàng',
        'error'
      );
      return;
    }

    // Kiểm tra diagramCanvas
    if (!this.diagramCanvas) {
      window.showNotification?.(
        window.I18n?.t('workflow.noWorkflowData') || 'Không có dữ liệu workflow',
        'error'
      );
      return;
    }

    try {
      // Export nodes và edges từ Drawflow
      const { nodes, edges } = this.diagramCanvas.exportWorkflow();

      // Kiểm tra có nodes không
      if (!nodes || nodes.length === 0) {
        window.showNotification?.(
          window.I18n?.t('workflow.templateNeedsNodes') || 'Template cần có ít nhất một node',
          'warning'
        );
        return;
      }

      const templateName = this.overlay?.querySelector('#workflowName')?.value?.trim() ||
                           this.templateData?.name ||
                           (window.I18n?.t('workflow.newTemplateName') || 'Template mới');

      // Tạo workflow data object để truyền vào SaveTemplateModal
      const workflowData = {
        wf_name: templateName,
        description: this.templateData?.description || '',
        nodes: nodes,
        edges: edges,
        settings: this.workflow?.settings || {}
      };

      console.log('[WorkflowEditor] Mở SaveTemplateModal để tạo template mới:', workflowData);

      // Mở modal SaveTemplateModal
      const result = await window.SaveTemplateModal.show(workflowData);

      if (result?.success && result?.template) {
        console.log('[WorkflowEditor] Template đã được tạo:', result.template);

        // Cập nhật state để chuyển sang edit mode cho template đã tạo
        this.templateId = result.template.id;
        this.templateData = {
          name: result.template.name,
          description: result.template.description || '',
          category_id: result.template.category_id,
          thumbnail_url: result.template.thumbnail_url || result.template.thumbnail,
          video_url: result.template.video_url || null,
          is_premium: result.template.is_premium || false,
          is_featured: result.template.is_featured || false,
          // Backend returns is_active, frontend uses is_published internally
          is_published: (result.template.is_active !== undefined ? result.template.is_active : result.template.is_published) !== false,
        };

        // Cập nhật UI
        this._hasUnsavedChanges = false;

        // Re-render header để cập nhật button text từ "Lưu Template" → "Cập nhật Template"
        const saveBtn = this.overlay?.querySelector('#saveWorkflowBtn');
        if (saveBtn) {
          saveBtn.textContent = window.I18n?.t('workflow.updateTemplate') || 'Cập nhật Template';
        }

        // Emit event để refresh template list
        if (window.eventBus) {
          window.eventBus.emit('template:created', { templateId: this.templateId });
        }
        // Relay to sidebar (popup has separate eventBus instance)
        try {
          chrome.runtime.sendMessage({ action: 'templateCreated', templateId: this.templateId });
        } catch (e) { /* ignore */ }
      }
    } catch (error) {
      console.error('[WorkflowEditor] Lỗi khi tạo template:', error);
      window.showNotification?.(
        (window.I18n?.t('workflow.createTemplateFailed') || 'Không thể tạo template') + ': ' + error.message,
        'error'
      );
    }
  }

  /**
   * Chuyển đổi nodes từ workflow format sang template format
   * Đồng bộ với SaveTemplateModal._extractNodeData để đảm bảo không mất dữ liệu
   * @param {Array} nodes - Nodes từ DiagramCanvas
   * @returns {Array} Template nodes
   */
  _convertNodesToTemplateFormat(nodes) {
    return nodes.map(node => {
      // Ưu tiên ref_img_urls có sẵn (template mode lưu trực tiếp), fallback sang convert từ ref_thumbnails
      let refImgUrls = [];
      if (Array.isArray(node.ref_img_urls) && node.ref_img_urls.length > 0) {
        refImgUrls = node.ref_img_urls;
        console.log('[WorkflowEditor] _convertNodesToTemplateFormat - node has ref_img_urls:', node.node_id, refImgUrls);
      } else if (node.ref_thumbnails && typeof node.ref_thumbnails === 'object') {
        for (const [key, value] of Object.entries(node.ref_thumbnails)) {
          const url = typeof value === 'string' ? value : value?.thumbnail;
          if (url && !url.startsWith('data:')) {
            refImgUrls.push(url);
          }
        }
      }

      // Build data object với tất cả fields cần thiết (sync với SaveTemplateModal._extractNodeData)
      const data = {
        // Core fields
        node_name: node.node_name || '',
        label: node.node_name || node.node_type || '',
        prompt: node.prompt || '',
        model: node.model || '',
        ratio: node.ratio || '1:1',
        quantity: node.quantity || 1,
        enabled: node.enabled !== false,
        media_type: node.media_type || 'Image',
        gen_type: node.gen_type || 'flow',
        // Ref images
        ref_img_urls: refImgUrls,
        // EWT-12: Template result preview image
        result_img_url: node.result_img_url || '',
      };

      // Copy các field bổ sung nếu có giá trị (sync với SaveTemplateModal._extractNodeData)
      const copyFields = [
        // Core settings
        'auto_download', 'retry_on_fail', 'style_weight', 'quality',
        'negative_prompt', 'seed', 'cfg_scale', 'steps',
        'video_duration', 'video_fps', 'aspect_ratio',
        'system_prompt', 'temperature', 'max_tokens',
        // Phase 1 — Node Reference System: slug + mention modes
        'slug', 'slug_auto', 'prompt_mode', 'ref_mode',
        // Ref file names
        'ref_file_names',
        // Angle preset fields
        'angle_preset_id', 'angle_preset_name', 'angle_preset_json',
        'angle_rotation', 'angle_tilt', 'angle_zoom', 'angle_ratio', 'angle_built_prompt',
        // Download settings
        'download_resolution', 'video_download_resolution', 'download_folder',
        'download_file_template', 'download_collect_all', 'delay_seconds', 'note_text',
        // Telegram settings
        'telegram_chat_id', 'telegram_send_mode', 'telegram_message', 'telegram_caption',
        // Provider settings (ChatGPT/Grok)
        'provider', 'prompt_source', 'multi_prompt', 'enhance', 'enhance_model',
        'timeout_sec', 'timeout_ms', 'use_fallback_prefix', 'max_ref_images',
        // Grok specific
        'grok_mode', 'grok_duration', 'grok_resolution', 'grok_image_quality',
        // Video specific
        'video_input_type', 'frame_1_source', 'frame_1_file_name', 'frame_1_thumbnail',
        'frame_2_source', 'frame_2_file_name', 'frame_2_thumbnail',
        // Prompts JSON (for multi-prompt nodes)
        'prompts_json'
      ];

      copyFields.forEach(field => {
        if (node[field] !== undefined) {
          data[field] = node[field];
        }
      });

      return {
        id: node.node_id,
        type: node.node_type,
        name: node.node_name || node.node_type,
        position: {
          x: node.pos_x || 100,
          y: node.pos_y || 100,
        },
        enabled: node.enabled !== false,
        data,
      };
    });
  }

  /**
   * Chuyển đổi edges từ workflow format sang template format
   * @param {Array} edges - Edges từ DiagramCanvas
   * @returns {Array} Template edges
   */
  _convertEdgesToTemplateFormat(edges) {
    return edges
      .map(edge => ({
        // Backend requires edge id
        id: edge.edge_id || (window.IdGenerator ? window.IdGenerator.next('edge') : `edge_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`),
        // Backend expects source/target for node IDs
        source: edge.source_node_id || edge.source_node || edge.source,
        target: edge.target_node_id || edge.target_node || edge.target,
        // Backend expects sourceHandle/targetHandle (camelCase), NOT output_class/input_class
        sourceHandle: edge.source_handle || edge.output_class || 'output_1',
        targetHandle: edge.target_handle || edge.input_class || 'input_1',
        // GAP BUG #3 FIX: Backend also expects sourcePort/targetPort (human-readable port names)
        // These are used in cloneToWorkflow to populate Edge.source_port/target_port columns
        sourcePort: edge.source_port || null,
        targetPort: edge.target_port || null,
        // Include data_type for edge typing
        dataType: edge.data_type || 'image',
      }))
      .filter(edge => edge.source && edge.target); // Filter out invalid edges
  }

  // === Export Workflow Methods ===

  /**
   * Export workflow as JSON file.
   * Path live Drawflow — đọc nodes/edges từ DiagramCanvas in-memory state.
   * Logic format chia sẻ với WorkflowList.exportWorkflow qua WorkflowExportHelper.
   */
  async exportWorkflow() {
    // Feature gate check — show upgrade dialog (consistent với _shareWorkflow pattern).
    // Bug 30 fix (2026-05-19): trước fix dùng toast "Premium" — UX không cho user
    // path nâng cấp. Sau fix: dùng showModuleBlockedDialog để hiện upgrade button.
    if (window.featureGate && !window.featureGate.canUse('workflow_export')) {
      if (typeof window.featureGate.showModuleBlockedDialog === 'function') {
        window.featureGate.showModuleBlockedDialog('workflow_export');
      } else {
        const label = window.featureGate.getCrownLabel?.('workflow_export') || 'Premium';
        window.showNotification?.(
          window.I18n?.t('workflow.exportLocked') || `Export workflow: ${label}`,
          'warning'
        );
      }
      return;
    }

    if (!this.workflow || !this.diagramCanvas) {
      const dialog = window.customDialog || window.CustomDialog;
      dialog?.alert(window.I18n?.t('workflow.noWorkflowToExport') || 'Chưa có workflow để xuất', { type: 'warning' });
      return;
    }

    try {
      // Get current workflow data từ Drawflow live state
      const { nodes, edges } = this.diagramCanvas.exportWorkflow();
      const workflowName = this.overlay?.querySelector('#workflowName')?.value?.trim() || this.workflow.wf_name;

      // Build + download via shared helper (đồng nhất với WorkflowList.exportWorkflow path)
      const exportData = window.WorkflowExportHelper.buildExportData(
        workflowName,
        this.workflow.description,
        this.workflow,
        nodes,
        edges
      );
      const filename = window.WorkflowExportHelper.buildExportFilename(workflowName);
      window.WorkflowExportHelper.downloadJson(exportData, filename);

      console.log('[TobyFlow] Workflow exported:', filename);
    } catch (error) {
      console.error('[TobyFlow] Export failed:', error);
      const dialog = window.customDialog || window.CustomDialog;
      dialog?.alert((window.I18n?.t('workflow.exportFailed') || 'Xuất workflow thất bại') + ': ' + error.message, { type: 'error' });
    }
  }

  // _buildExportData, _convertNodesToExport, _buildExportFilename, _downloadJson đã chuyển sang
  // src/shared/WorkflowExportHelper.js — shared với WorkflowList.exportWorkflow để tránh logic skew.

  /**
   * Mở modal chia sẻ workflow.
   * Chỉ cho phép khi workflow đã được save và không phải read-only.
   */
  _shareWorkflow() {
    if (this.isReadOnly()) {
      console.log('[WorkflowEditor] _shareWorkflow() blocked - read-only mode');
      return;
    }
    if (!this.workflow?.wf_id) {
      window.customDialog?.alert(
        window.I18n?.t('workflow.saveBeforeShare') || 'Vui lòng lưu workflow trước khi chia sẻ.',
        { type: 'warning' }
      );
      return;
    }
    // Check feature gate
    if (window.featureGate && !window.featureGate.canUse('workflow_share_enabled')) {
      window.featureGate.showModuleBlockedDialog('workflow_share');
      return;
    }
    // Gọi ShareWorkflowModal nếu có
    if (window.ShareWorkflowModal?.show) {
      window.ShareWorkflowModal.show(this.workflow.wf_id);
    } else {
      console.warn('[WorkflowEditor] ShareWorkflowModal not found');
      window.customDialog?.alert(
        window.I18n?.t('workflow.shareNotAvailable') || 'Chức năng chia sẻ chưa sẵn sàng.',
        { type: 'info' }
      );
    }
  }

  /**
   * Hiển thị modal xem video YouTube demo
   * @param {string} videoUrl - URL video YouTube
   */
  _showVideoModal(videoUrl) {
    // Mở video trong tab mới thay vì embed (tránh lỗi 153 khi video tắt embedding)
    window.open(videoUrl, '_blank');
  }

  /**
   * 2026-05-27: Gắn nút zoom (giữa thumb) — hover hiện, click mở media viewer.
   * Phần thumb ngoài nút vẫn drag node được (chỉ nút có pointer-events). Idempotent.
   * @param {HTMLElement} thumb - .df-preview-thumb element (đã set data-media-src)
   */
  _attachThumbZoom(thumb) {
    if (!thumb || thumb.querySelector('.df-preview-zoom')) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'df-preview-zoom nodrag';
    btn.title = window.I18n?.t('workflow.viewMedia') || 'Xem';
    btn.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line><line x1="11" y1="8" x2="11" y2="14"></line><line x1="8" y1="11" x2="14" y2="11"></line></svg>';
    thumb.appendChild(btn);
  }

  /**
   * 2026-05-25: Media viewer modal — hiển thị image/video full screen khi user click thumb.
   * Video có controls (play/pause/sound/seek) + autoplay với sound (user-initiated).
   * Image hiển thị fit screen với max constraints.
   *
   * @param {Object} opts
   * @param {string} opts.src - URL của media (image src hoặc video stream URL)
   * @param {string} opts.type - 'image' | 'video'
   * @param {string} [opts.poster] - Poster thumbnail URL cho video (optional)
   */
  _showMediaViewer({ src, type, poster } = {}) {
    if (!src) return;

    // Cleanup any existing viewer (defensive — tránh duplicate khi user click nhanh)
    document.querySelectorAll('.wf-media-viewer-overlay').forEach(el => el.remove());

    const overlay = document.createElement('div');
    overlay.className = 'wf-media-viewer-overlay';

    let mediaEl;
    if (type === 'video') {
      mediaEl = document.createElement('video');
      mediaEl.src = src;
      mediaEl.controls = true;
      mediaEl.autoplay = true;
      mediaEl.playsInline = true;
      // KHÔNG muted — user expects sound khi click vào video result
      mediaEl.muted = false;
      if (poster) mediaEl.poster = poster;
    } else {
      mediaEl = document.createElement('img');
      mediaEl.src = src;
      mediaEl.alt = 'preview';
    }
    mediaEl.className = 'wf-media-viewer-content';

    const closeBtn = document.createElement('button');
    closeBtn.className = 'wf-media-viewer-close';
    closeBtn.setAttribute('aria-label', window.I18n?.t?.('common.close') || 'Close');
    closeBtn.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

    overlay.appendChild(mediaEl);
    overlay.appendChild(closeBtn);
    document.body.appendChild(overlay);

    // Cleanup function — unbind listeners + remove DOM
    const cleanup = () => {
      try {
        // Pause video trước khi remove để tránh sound playing trong background
        if (mediaEl.tagName === 'VIDEO') {
          mediaEl.pause();
          mediaEl.src = '';
        }
      } catch (_) {}
      document.removeEventListener('keydown', escHandler);
      overlay.remove();
    };

    // ESC key đóng
    const escHandler = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        cleanup();
      }
    };
    document.addEventListener('keydown', escHandler);

    // Click overlay (outside media) đóng
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) cleanup();
    });
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      cleanup();
    });

    // Prevent click on media element from bubbling to overlay (đóng modal)
    mediaEl.addEventListener('click', (e) => e.stopPropagation());
  }

  /**
   * Mở admin template editor để chỉnh sửa template (admin only).
   * Đóng preview window hiện tại + uỷ quyền cho WorkflowTemplateList ở sidebar
   * mở admin template editor (workflow-template-editor.html).
   */
  _editTemplateFromPreview() {
    const tplId = this.workflow?._template_id;
    if (!tplId) return;

    if (window.workflowTemplateList?._openTemplateForEdit) {
      // Sidebar context — gọi trực tiếp
      try { this._forceClose(); } catch (e) {}
      window.workflowTemplateList._openTemplateForEdit(tplId);
    } else {
      // Popup window context — gửi message tới sidebar VÀ ĐỢI ack rồi mới đóng window.
      // Race: nếu window.close() chạy trước khi message deliver → sidebar không nhận → action mất.
      this._sendMessageThenClose({ action: 'editWorkflowTemplate', templateId: tplId });
    }
  }

  /**
   * Đóng popup window nếu đang chạy trong popup, ngược lại đóng overlay.
   * Tránh trường hợp overlay bị xóa nhưng popup window vẫn mở → màn hình trống đen.
   */
  _closePopupWindowOrOverlay() {
    const isPopup = !!(window.location?.pathname?.endsWith('workflow-editor.html'));
    if (isPopup) {
      try { window.close(); } catch (e) {}
    } else {
      try { this._forceClose(); } catch (e) {}
    }
  }

  /**
   * Send message qua chrome.runtime.sendMessage, ĐỢI callback (ack) rồi mới đóng window.
   * Tránh race: window.close() chạy trước khi MV3 service worker deliver message → mất action.
   * Có timeout 1s phòng SW không response, fallback close ngay.
   */
  _sendMessageThenClose(payload) {
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      this._closePopupWindowOrOverlay();
    };
    try {
      chrome.runtime.sendMessage(payload, () => {
        // Ignore lastError; chỉ cần callback fire = message đã được deliver/handle
        close();
      });
      // Fallback: nếu callback không fire trong 1s thì close anyway
      setTimeout(close, 1000);
    } catch (e) {
      console.warn('[WorkflowEditor] sendMessage failed:', e?.message);
      close();
    }
  }

  /**
   * Router cho action duplicate ở read-only mode.
   * - Template preview → clone template qua WorkflowTemplateList._copyTemplateToWorkflow
   * - Shared workflow  → cloneFromShared
   */
  _handleReadOnlyDuplicate() {
    if (this.workflow?._is_template_preview && this.workflow._template_id) {
      // Clone template — uỷ quyền cho WorkflowTemplateList nếu có (sidebar context)
      const tplId = this.workflow._template_id;
      if (window.workflowTemplateList?._copyTemplateToWorkflow) {
        // Đóng editor preview trước rồi clone (sidebar)
        this._forceClose();
        window.workflowTemplateList._copyTemplateToWorkflow(tplId);
      } else {
        // Popup window context — gửi message rồi đợi ack mới đóng (tránh race deliver fail)
        this._sendMessageThenClose({
          action: 'cloneWorkflowTemplate',
          templateId: tplId,
        });
      }
      return;
    }

    // Shared workflow → clone
    return this.cloneFromShared();
  }

  /**
   * Clone workflow từ shared view về thành workflow riêng của user.
   * POST /v1/shared-workflows/{wf_id}/clone
   */
  async cloneFromShared() {
    if (!this.workflow?.wf_id) {
      console.error('[WorkflowEditor] cloneFromShared: no wf_id');
      return;
    }

    try {
      const baseUrl = window.ApiBaseConfig.get();
      const token = await window.authManager?.getToken?.();
      if (!token) {
        window.customDialog?.alert(
          window.I18n?.t('workflow.loginRequired') || 'Vui lòng đăng nhập để sử dụng tính năng này.',
          { type: 'warning' }
        );
        return;
      }

      const response = await fetch(`${baseUrl}/shared-workflows/${this.workflow.wf_id}/clone`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-Extension-Id': chrome.runtime.id,
        }
      });

      const json = await response.json().catch(() => ({}));

      if (!response.ok) {
        // Backend trả shape: { success: false, error: { code, message, data } }
        const errCode = json?.error?.code || json?.code;
        const errMsg = json?.error?.message || json?.message || `HTTP ${response.status}`;
        const errData = json?.error?.data || json?.data || {};

        // QUOTA_EXCEEDED, FEATURE_DISABLED → show modal có nút Upgrade
        if (errCode === 'QUOTA_EXCEEDED' || errCode === 'FEATURE_DISABLED') {
          const upgrade = await window.customDialog?.confirm(errMsg, {
            title: window.I18n?.t('workflow.quotaReached') || 'Limit reached',
            type: 'warning',
            confirmText: window.I18n?.t('common.upgrade') || 'Upgrade',
            cancelText: window.I18n?.t('common.later') || 'Later',
          });
          if (upgrade) {
            // Workflow editor mở trong popup window — openUpgradeModal chỉ có ở sidebar parent.
            // Fallback: gửi message tới sidebar (app.js:5843 handle 'showUpgradeModal').
            if (typeof window.openUpgradeModal === 'function') {
              window.openUpgradeModal();
            } else {
              try {
                chrome.runtime.sendMessage({ action: 'showUpgradeModal' });
              } catch (e) {
                console.warn('[WorkflowEditor] Cannot open upgrade modal:', e);
              }
            }
          }
          return;
        }

        // Lỗi khác — alert đơn giản với message từ backend
        window.customDialog?.alert(errMsg, { type: 'error' });
        return;
      }

      const data = json.data || json;
      const newWorkflow = data.workflow || data;

      // Hiển thị thông báo thành công
      window.showNotification?.(
        window.I18n?.t('workflow.duplicateSuccess') || 'Workflow duplicated successfully!',
        'success'
      );

      // Sidebar context: refresh workflow list + mở workflow mới ngay tại sidebar editor.
      // Popup window context: gửi message để sidebar refresh + mở workflow, rồi đóng popup.
      const isPopup = !!(window.location?.pathname?.endsWith('workflow-editor.html'));
      if (isPopup) {
        // Notify sidebar to refresh and open new workflow
        try {
          chrome.runtime.sendMessage({
            action: 'workflowClonedFromShared',
            workflow: newWorkflow,
          });
        } catch (e) { /* ignore */ }
        try { window.close(); } catch (e) {}
      } else {
        this._forceClose();
        if (window.workflowEditor && newWorkflow.wf_id) {
          if (window.workflowList?.loadWorkflows) {
            await window.workflowList.loadWorkflows();
          }
          // Refresh featureGate để update quota
          if (window.featureGate) {
            window.featureGate.refresh({ force: true }).catch(e => console.warn('[WorkflowEditor] FeatureGate refresh failed:', e));
          }
          window.workflowEditor.open('edit', newWorkflow);
        }
      }

      console.log('[WorkflowEditor] Duplicated shared workflow:', newWorkflow.wf_id);
    } catch (error) {
      console.error('[WorkflowEditor] Duplicate from shared failed:', error);
      window.customDialog?.alert(
        (window.I18n?.t('workflow.duplicateFailed') || 'Không thể tạo bản sao workflow') + ': ' + error.message,
        { type: 'error' }
      );
    }
  }

  // === Execution UI Methods ===

  async _runSingleNode(drawflowId) {
    // EWT-6: Template mode không hỗ trợ execution
    if (this.isTemplateMode) return;
    // Read-only mode: không cho phép run
    if (this.isReadOnly()) return;
    if (!this.workflow?.wf_id || !drawflowId) return;

    // Resolve actual node_id from Drawflow internal ID
    const node = this.diagramCanvas?.editor?.getNodeFromId(drawflowId);
    const actualNodeId = node?.data?.node_id;
    if (!actualNodeId) {
      console.error('[TobyFlow] Cannot resolve node_id from drawflow ID:', drawflowId);
      return;
    }

    // Check run limit for workflow (applies to both anonymous and logged-in users)
    if (window.featureGate) {
      const quota = await this._safeCheckQuotaAsync('workflows_run_max');
      console.log('[WorkflowEditor] _runSingleNode workflows_run_max quota check:', quota);
      if (!quota.allowed) {
        const isLoggedIn = window.authManager?.isLoggedIn();
        if (isLoggedIn) {
          const limitText = quota.limit === 'unlimited' ? (window.I18n?.t('common.unlimited') || 'Unlimited') : `${quota.limit} ${window.I18n?.t('workflow.runsPerDay') || 'runs/day'}`;
          const shouldUpgrade = await window.customDialog?.confirm(
            window.I18n?.t('workflow.quotaExhaustedToday', { limit: limitText, used: quota.used }) || `Workflow runs exhausted today.\n\nLimit: ${limitText}\nUsed: ${quota.used} runs\n\nUpgrade to increase limit.`,
            { title: window.I18n?.t('workflow.noMoreRuns') || 'Workflow runs exhausted', confirmText: window.I18n?.t('common.upgrade') || 'Upgrade', cancelText: window.I18n?.t('common.later') || 'Later' }
          );
          if (shouldUpgrade) {
            this._openUpgradeModal();
          }
        } else {
          window.featureGate.showLoginPrompt(window.I18n?.t('workflow.trialRunLimit') || 'Bạn đã sử dụng hết lượt chạy workflow trong bản dùng thử.');
        }
        return;
      }

      // GP-6.3 / GP-6.4: Check global quota warning/exhausted
      const quotaCheck = window.featureGate.checkGlobalQuotaWarning('Workflow');
      if (quotaCheck.exhausted) {
        return; // Dialog đã hiển thị bởi FeatureGate
      }
    }

    if (window.workflowExecutor?.isRunning) {
      const forceStop = await window.customDialog.confirm(
        window.I18n?.t('workflow.anotherRunningForceStop') ||
        'Có workflow đang chạy trong context này. Bạn có muốn force stop để chạy workflow mới?',
        {
          type: 'warning',
          title: window.I18n?.t('workflow.anotherRunningTitle') || 'Workflow đang chạy',
          confirmText: window.I18n?.t('workflow.forceStop') || 'Force Stop',
          cancelText: window.I18n?.t('common.cancel') || 'Hủy'
        }
      );
      if (forceStop) {
        window.workflowExecutor.shouldStop = true;
        window.workflowExecutor.isRunning = false;
        await window.WorkflowExecutor?.clearCrossContextRunning?.();
        console.log('[WorkflowEditor] Force stopped local running workflow');
      } else {
        this._isRunPending = false;
        return;
      }
    }

    // Cross-context check: verify no workflow is running in sidebar/other popup.
    // Gap 2 fix: dùng helper TTL-aware (auto-clear nếu flag stale >30 phút).
    try {
      const running = await window.WorkflowExecutor?.getCrossContextRunning?.();
      if (running?.wf_id) {
        const runningName = running.wf_name || 'Workflow';
        const forceStop = await window.customDialog.confirm(
          window.I18n?.t('workflow.anotherRunningCrossContextForceStop', { name: runningName }) ||
          `"${runningName}" đang chạy ở cửa sổ khác. Bạn có muốn force stop để chạy workflow mới?`,
          {
            type: 'warning',
            title: window.I18n?.t('workflow.anotherRunningTitle') || 'Workflow đang chạy',
            confirmText: window.I18n?.t('workflow.forceStop') || 'Force Stop',
            cancelText: window.I18n?.t('common.cancel') || 'Hủy'
          }
        );
        if (forceStop) {
          await window.WorkflowExecutor?.clearCrossContextRunning?.();
          console.log('[WorkflowEditor] Force stopped cross-context running workflow:', runningName);
        } else {
          return;
        }
      }
    } catch (e) {
      console.warn('[WorkflowEditor] Cross-context running check failed:', e.message);
    }

    // Check ref_file_ids exist on Flow before running
    const refBefore = node?.data?.ref_file_ids;
    const missingCheck = await this._checkRefFilesExist([node?.data]);
    if (missingCheck) {
      await window.customDialog.alert(missingCheck, { type: 'warning', title: window.I18n?.t('workflow.missingRefTitle') || 'Thiếu ảnh tham chiếu' });
      return;
    }

    // Bug fix: Sync data của node có form đang mở TRƯỚC KHI save workflow.
    // Case: user mở form Image Node, thay đổi ảnh, click vào Google Flow Node (chỉ select),
    // rồi click Run. Form vẫn hiển thị content của Image Node, nhưng selectedNodeId = Google Flow.
    // Nếu không sync data của Image Node, ảnh cũ sẽ được save và sử dụng.
    const formPanel = this.overlay?.querySelector('#nodeFormPanel');
    const isFormOpen = formPanel && !formPanel.classList.contains('hidden');
    if (isFormOpen && this._formNodeId) {
      // Sync data cho node có form đang mở (có thể khác với node đang run)
      const formNode = this.diagramCanvas?.editor?.getNodeFromId(this._formNodeId);
      if (formNode) {
        // Sync reuploaded ref_file_ids vào DOM form input (tránh _applyNodeFormData overwrite)
        if (String(this._formNodeId) === String(drawflowId)) {
          if (node?.data?.ref_file_ids && node.data.ref_file_ids !== refBefore) {
            const refInput = this.overlay?.querySelector('#nodeRefFileIds');
            if (refInput) refInput.value = node.data.ref_file_ids;
          }
        }
        this._applyNodeFormData(this._formNodeId);
      }
    }
    // Ẩn node form panel để không che canvas (force — đang chạy node)
    this._formUploadKeys?.clear();
    await this.hideNodeForm();

    // Wait for any concurrent save to finish before starting our save
    if (this._isSaving) {
      const waitStart = Date.now();
      while (this._isSaving && Date.now() - waitStart < 5000) {
        await new Promise(r => setTimeout(r, 100));
      }
    }

    // Save workflow trước
    await this.saveWorkflow();

    // Verify the node exists in saved workflow before executing
    if (!this.workflow?.nodes?.find(n => n.node_id === actualNodeId)) {
      console.error('[TobyFlow] Node not found in saved workflow after save:', actualNodeId);
      const errLogPanel = this.overlay?.querySelector('#executionLogPanel');
      errLogPanel?.classList.remove('hidden');
      this._addLogEntry(window.I18n?.t('workflow.nodeNotFoundAfterSave') || 'Lỗi: Không tìm thấy node sau khi lưu. Hãy lưu workflow và thử lại.', 'error');
      return;
    }

    // Preflight check for single node — show modal with provider status
    const nodeData = this.workflow?.nodes?.find(n => n.node_id === actualNodeId);
    if (nodeData) {
      const preflight = await this._preflightCheck([nodeData]);
      if (!preflight.ready && preflight.skipped) {
        return;
      }
    }

    // Hiện log panel
    const logPanel = this.overlay?.querySelector('#executionLogPanel');
    logPanel?.classList.remove('hidden');

    this._addLogEntry(window.I18n?.t('workflow.rerunningNode') || 'Chạy lại node...', 'info');

    // Reset node status về pending trước khi chạy (soft-fail ok)
    try {
      if (window.storageManager) {
        await window.storageManager.updateNodeStatus(this.workflow.wf_id, actualNodeId, { status: 'pending', result_file_ids: '' });
      }
    } catch (e) {
      console.warn('[TobyFlow] Reset node status failed (non-critical):', e.message);
    }

    // Set flag to record usage AFTER node completes successfully
    if (window.featureGate) {
      window.featureGate.setPendingWorkflowRun();
    }

    // Ensure Flow tab is active before execution (popup windows need this)
    try {
      await new Promise(resolve => {
        chrome.runtime.sendMessage({ action: 'ensureFlowTabActive' }, () => resolve());
      });
    } catch (e) {
      console.warn('[WorkflowEditor] ensureFlowTabActive failed:', e.message);
    }

    // Execute single node
    try {
      await window.workflowExecutor.executeSingleNode(this.workflow.wf_id, actualNodeId);
    } catch (error) {
      this._addLogEntry(window.I18n?.t('workflow.errorPrefix', { message: error.message }) || `Lỗi: ${error.message}`, 'error');
    }
  }

  /**
   * Pre-flight check: Kiểm tra các provider tabs đã sẵn sàng chưa trước khi run workflow.
   * Tự động activate tab và poll status nếu chưa ready.
   * @param {Array} nodes - Array of node data
   * @returns {Promise<{ready: boolean, providers: Object}>}
   */
  async _preflightCheck(nodes) {
    const I = window.I18n;
    const PM = window.ProviderMeta;
    const providerLabels = {
      flow: PM?.getName?.('flow') || 'Flow',
      chatgpt: PM?.getName?.('chatgpt') || 'ChatGPT',
      grok: PM?.getName?.('grok') || 'Grok',
      gemini: PM?.getName?.('gemini') || 'Gemini',
    };

    // Extract unique providers từ enabled nodes
    const providersUsed = new Set();
    for (const node of nodes) {
      if (node.enabled === false) continue;
      const nodeType = node.node_type || node.class;
      if (nodeType === 'image' || nodeType === 'generate') {
        providersUsed.add('flow');
      } else if (nodeType === 'chatgpt') {
        // [Bug 65 fix v2 2026-05-24] Schema flat top-level — `node.provider` (KHÔNG nested data)
        providersUsed.add(node.provider || 'chatgpt');
      } else if (nodeType === 'grok') {
        providersUsed.add('grok');
      } else if (nodeType === 'prompt' && node.use_ai === true) {
        // AI Agent rename (2026-05-30): schema flat top-level — KHÔNG có nested `node.data`.
        // Verified runtime: node.use_ai (boolean) + node.provider ('chatgpt'|'gemini').
        providersUsed.add(node.provider || 'chatgpt');
      }
    }
    console.log('[WorkflowEditor] _preflightCheck: providers used:', [...providersUsed]);

    if (providersUsed.size === 0) {
      console.log('[WorkflowEditor] _preflightCheck: no providers, returning ready');
      return { ready: true, providers: {} };
    }

    // Helper: check provider status
    const checkProviderStatus = async (provider) => {
      try {
        if (provider === 'flow') {
          const resp = await new Promise(resolve => {
            chrome.runtime.sendMessage({ action: 'checkFlowTabOpen' }, r => resolve(r));
          });
          return { ready: !!resp?.isOpen, tabId: resp?.tabId };
        } else if (provider === 'chatgpt') {
          // Use ensureReady with createIfMissing=false to just check status
          // [Bug 62 fix 2026-05-24] silent: true skip emit chatgpt:login_required event — status check
          // UI hiển thị trực tiếp, KHÔNG cần dialog "Mở tab" pop spam.
          if (!window.ChatGPTSession?.ensureReady) return { ready: false };
          const result = await window.ChatGPTSession.ensureReady({ createIfMissing: false, activate: false, silent: true }).catch(() => ({ ready: false }));
          return { ready: result?.ready === true, tabId: result?.tabId, error: result?.error };
        } else if (provider === 'grok') {
          // [Bug 62 fix 2026-05-24] silent: true cho preflight status check
          if (!window.GrokSession?.ensureReady) return { ready: false };
          const result = await window.GrokSession.ensureReady({ createIfMissing: false, activate: false, silent: true }).catch(() => ({ ready: false }));
          return { ready: result?.ready === true, tabId: result?.tabId, error: result?.error };
        } else if (provider === 'gemini') {
          if (!window.GeminiSession?.ensureReady) return { ready: false };
          const result = await window.GeminiSession.ensureReady({ createIfMissing: false, activate: false }).catch(() => ({ ready: false }));
          return { ready: result?.ready === true, tabId: result?.tabId, error: result?.error };
        }
        return { ready: false };
      } catch (err) {
        return { ready: false, error: err.message };
      }
    };

    // Initial check
    const providerStatus = {};
    for (const provider of providersUsed) {
      providerStatus[provider] = await checkProviderStatus(provider);
    }
    console.log('[WorkflowEditor] _preflightCheck: initial status:', providerStatus);

    // Check not ready providers (for activation attempt)
    const notReady = Object.entries(providerStatus).filter(([_, v]) => !v.ready);
    // [UX Improvement] Always show modal to let user confirm before running
    // (user yêu cầu giữ modal để xem provider status trước khi confirm).
    // Bug "modal stuck" đã fix riêng qua: cleanup `style.display='none'` ngay +
    // idempotent flag `done` ngăn double-click trigger execute 2 lần.
    console.log('[WorkflowEditor] _preflightCheck: not ready providers:', notReady.map(([p]) => p));

    // Try to activate tabs for not-ready providers (fire-and-forget)
    console.log('[WorkflowEditor] _preflightCheck: activating providers:', notReady.map(([p]) => p));
    for (const [provider] of notReady) {
      if (provider === 'flow') {
        // Flow: try to activate existing tab or open new one
        chrome.runtime.sendMessage({ action: 'ensureFlowTabActive' }).catch(() => {});
      } else if (provider === 'chatgpt' && window.ChatGPTSession?.ensureReady) {
        window.ChatGPTSession.ensureReady().catch(() => {});
      } else if (provider === 'grok' && window.GrokSession?.ensureReady) {
        window.GrokSession.ensureReady().catch(() => {});
      } else if (provider === 'gemini' && window.GeminiSession?.ensureReady) {
        window.GeminiSession.ensureReady().catch(() => {});
      }
    }

    // Show modal with real-time status polling
    console.log('[WorkflowEditor] _preflightCheck: showing provider status modal');
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'confirm-run-overlay';
      overlay.innerHTML = `
        <div class="confirm-run-modal" style="min-width: 320px;">
          <div class="confirm-run-header">
            <span class="confirm-run-title">${I?.t('workflow.preflightTitle') || 'AI Provider Status'}</span>
          </div>
          <div class="confirm-run-body">
            <div class="confirm-run-provider-status" id="wfPreflightStatus"></div>
          </div>
          <div class="confirm-run-footer">
            <button class="btn btn-secondary" id="wfPreflightCancel">${I?.t('common.cancel') || 'Hủy'}</button>
            <button class="btn btn-primary" id="wfPreflightRun">${I?.t('workflow.preflightContinue') || 'Chạy'}</button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);
      setTimeout(() => overlay.classList.add('visible'), 10);

      const statusEl = overlay.querySelector('#wfPreflightStatus');
      let pollTimer = null;
      let allReady = false;

      const renderStatus = () => {
        let html = '';
        // [Bug 66 fix 2026-05-24] Phân biệt states: ready / not_logged_in / cloudflare / no_tab / checking
        const iconCheck = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>';
        const iconSpin = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="spin"><circle cx="12" cy="12" r="10"></circle><path d="M12 6v6l4 2"></path></svg>';
        const iconWarn = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
        for (const provider of providersUsed) {
          const st = providerStatus[provider];
          const label = providerLabels[provider] || provider;
          let iconSvg = iconSpin;
          let statusText = I?.t('common.checking') || 'Checking...';
          let badgeClass = 'is-checking';
          if (st?.ready) {
            iconSvg = iconCheck;
            statusText = I?.t('common.ready') || 'Ready';
            badgeClass = 'is-ready';
          } else if (st && st.ready === false) {
            iconSvg = iconWarn;
            badgeClass = 'is-warning';
            if (st.error === 'NOT_LOGGED_IN') {
              statusText = I?.t('gen.providerStatusLogin') || 'Chưa đăng nhập';
            } else if (st.error === 'NO_TAB' || st.error === 'EDITOR_NOT_FOUND') {
              statusText = I?.t('workflow.providerNoTab') || 'Chưa mở tab';
            } else if (st.cloudflareChallenge || st.error === 'CLOUDFLARE') {
              statusText = I?.t('gen.providerStatusCloudflare') || 'Chờ Cloudflare...';
            } else {
              statusText = I?.t('gen.providerStatusLogin') || 'Chưa sẵn sàng';
            }
          }
          html += `<div class="confirm-run-provider-badge ${badgeClass}">
            <span class="badge-provider">${iconSvg} ${label}</span>
            <span class="badge-status">${statusText}</span>
          </div>`;
        }
        statusEl.innerHTML = html;

        // Check if all ready now
        allReady = [...providersUsed].every(p => providerStatus[p]?.ready);

        // Update button text based on ready state
        const runBtn = overlay.querySelector('#wfPreflightRun');
        if (runBtn) {
          runBtn.textContent = allReady
            ? (I?.t('common.run') || 'Run')
            : (I?.t('workflow.runAnyway') || 'Run Anyway');
        }
      };

      // K.8 (2026-05-29): idempotent guard chặn double-click race.
      // CSS .confirm-run-overlay không có transition/.visible style → cleanup
      // remove('visible') no-op → modal visual stuck 200ms → user click button
      // lần 2 trong window này. Flag `done` ngăn cleanup chạy 2 lần + ngăn
      // duplicate resolve.
      let done = false;

      const pollStatus = async () => {
        for (const provider of providersUsed) {
          if (!providerStatus[provider]?.ready) {
            providerStatus[provider] = await checkProviderStatus(provider);
          }
        }
        renderStatus();

        // 2026-05-31 fix: BỎ K.8 auto-resolve. Trước: khi tất cả providers ready (poll detect)
        // → modal tự đóng + tự resolve(ready) → user bị "tự click Run" không kịp xác nhận.
        // User bug report: "modal reconfirm xuất hiện, chưa click run đã tự click tự chạy luôn".
        // Sau fix: chỉ stop polling khi all ready để tiết kiệm CPU, GIỮ modal — đợi user click
        // "Run" thực sự. Icon ✅ next to provider name đã đủ visual feedback.
        if (allReady && pollTimer) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
      };

      renderStatus();
      pollTimer = setInterval(pollStatus, 2000);

      const cleanup = () => {
        if (pollTimer) clearInterval(pollTimer);
        // K.8: hide ngay bằng inline style (CSS .visible chưa khai báo style → remove no-op).
        overlay.classList.remove('visible');
        overlay.style.display = 'none';
        setTimeout(() => overlay.remove(), 200);
      };

      overlay.querySelector('#wfPreflightCancel').addEventListener('click', () => {
        if (done) return;
        done = true;
        console.log('[WorkflowEditor] _preflightCheck: user cancelled');
        cleanup();
        resolve({ ready: false, providers: providerStatus, skipped: true });
      });

      overlay.querySelector('#wfPreflightRun').addEventListener('click', (e) => {
        if (done) return;
        done = true;
        // Disable button + visual feedback ngăn double-click.
        e.currentTarget.disabled = true;
        e.currentTarget.style.opacity = '0.5';
        console.log('[WorkflowEditor] _preflightCheck: user clicked Run');
        cleanup();
        resolve({ ready: true, providers: providerStatus });
      });
    });
  }

  async _runWorkflowFromEditor() {
    // EWT-6: Template mode không hỗ trợ execution
    if (this.isTemplateMode) return;
    // Read-only mode: không cho phép run
    if (this.isReadOnly()) return;
    if (!this.workflow?.wf_id) return;
    // Guard: prevent duplicate concurrent runs
    if (this._isRunPending) {
      console.log('[WorkflowEditor] _runWorkflowFromEditor skipped - already pending');
      return;
    }
    this._isRunPending = true;

    // Check run limit for workflow (applies to both anonymous and logged-in users)
    if (window.featureGate) {
      const quota = await this._safeCheckQuotaAsync('workflows_run_max');
      console.log('[WorkflowEditor] workflows_run_max quota check:', quota);
      if (!quota.allowed) {
        const isLoggedIn = window.authManager?.isLoggedIn();
        if (isLoggedIn) {
          const limitText = quota.limit === 'unlimited' ? (window.I18n?.t('common.unlimited') || 'Unlimited') : `${quota.limit} ${window.I18n?.t('workflow.runsPerDay') || 'runs/day'}`;
          const shouldUpgrade = await window.customDialog?.confirm(
            window.I18n?.t('workflow.quotaExhaustedToday', { limit: limitText, used: quota.used }) || `Workflow runs exhausted today.\n\nLimit: ${limitText}\nUsed: ${quota.used} runs\n\nUpgrade to increase limit.`,
            { title: window.I18n?.t('workflow.noMoreRuns') || 'Workflow runs exhausted', confirmText: window.I18n?.t('common.upgrade') || 'Upgrade', cancelText: window.I18n?.t('common.later') || 'Later' }
          );
          if (shouldUpgrade) {
            this._openUpgradeModal();
          }
        } else {
          window.featureGate.showLoginPrompt(window.I18n?.t('workflow.trialRunLimit') || 'Bạn đã sử dụng hết lượt chạy workflow trong bản dùng thử.');
        }
        this._isRunPending = false;
        return;
      }

      // GP-6.3 / GP-6.4: Check global quota warning/exhausted
      const quotaCheck = window.featureGate.checkGlobalQuotaWarning('Workflow');
      if (quotaCheck.exhausted) {
        this._isRunPending = false;
        return; // Dialog đã hiển thị bởi FeatureGate
      }
    }

    if (window.workflowExecutor?.isRunning) {
      const forceStop = await window.customDialog.confirm(
        window.I18n?.t('workflow.anotherRunningForceStop') ||
        'Có workflow đang chạy trong context này. Bạn có muốn force stop để chạy workflow mới?',
        {
          type: 'warning',
          title: window.I18n?.t('workflow.anotherRunningTitle') || 'Workflow đang chạy',
          confirmText: window.I18n?.t('workflow.forceStop') || 'Force Stop',
          cancelText: window.I18n?.t('common.cancel') || 'Hủy'
        }
      );
      if (forceStop) {
        window.workflowExecutor.shouldStop = true;
        window.workflowExecutor.isRunning = false;
        await window.WorkflowExecutor?.clearCrossContextRunning?.();
        console.log('[WorkflowEditor] Force stopped local running workflow');
      } else {
        this._isRunPending = false;
        return;
      }
    }

    // Cross-context check: verify no workflow is running in sidebar/other popup.
    // Gap 2 fix: dùng helper TTL-aware (auto-clear nếu flag stale >30 phút).
    try {
      const running = await window.WorkflowExecutor?.getCrossContextRunning?.();
      if (running?.wf_id) {
        const runningName = running.wf_name || 'Workflow';
        const forceStop = await window.customDialog.confirm(
          window.I18n?.t('workflow.anotherRunningCrossContextForceStop', { name: runningName }) ||
          `"${runningName}" đang chạy ở cửa sổ khác. Bạn có muốn force stop để chạy workflow mới?`,
          {
            type: 'warning',
            title: window.I18n?.t('workflow.anotherRunningTitle') || 'Workflow đang chạy',
            confirmText: window.I18n?.t('workflow.forceStop') || 'Force Stop',
            cancelText: window.I18n?.t('common.cancel') || 'Hủy'
          }
        );
        if (forceStop) {
          await window.WorkflowExecutor?.clearCrossContextRunning?.();
          console.log('[WorkflowEditor] Force stopped cross-context running workflow:', runningName);
        } else {
          this._isRunPending = false;
          return;
        }
      }
    } catch (e) {
      console.warn('[WorkflowEditor] Cross-context running check failed:', e.message);
    }

    // Check if workflow has completed nodes → ask resume or rerun (consistent with sidebar)
    // Fetch fresh data from storage to avoid stale check (workflow may have been run/reset from other context)
    let hasCompletedNodes = false;
    try {
      const freshWorkflow = await window.storageManager?.getWorkflow(this.workflow.wf_id);
      hasCompletedNodes = (freshWorkflow?.nodes || []).some(n => n.status === 'completed');
    } catch (e) {
      // Fallback to local data if storage fetch fails
      hasCompletedNodes = (this.workflow?.nodes || []).some(n => n.status === 'completed');
    }
    if (hasCompletedNodes) {
      // K.17 (2026-05-29): 3-button modal (Continue / Re-run / Cancel) thay vì 2-button confirm.
      // User cần option Cancel để đóng modal mà KHÔNG reset hoặc continue (vd: click Run nhầm).
      const continueText = window.I18n?.t('common.continue') || 'Tiếp tục';
      const rerunText = window.I18n?.t('workflow.rerun') || 'Chạy lại';
      const cancelText = window.I18n?.t('common.cancel') || 'Hủy';
      const choice = await new Promise(resolve => {
        window.customDialog.alert(
          window.I18n?.t('workflow.resumeOrRerun', { name: this.workflow.wf_name }) ||
          `Workflow "${this.workflow.wf_name}" có node đã hoàn thành.\nBấm "Tiếp tục" để chạy từ node chưa xong, "Chạy lại" để reset, hoặc "Hủy" để đóng.`,
          {
            title: window.I18n?.t('workflow.resumeOrRerunTitle') || 'Tiếp tục hay chạy lại?',
            type: 'warning',
            buttons: [
              { label: cancelText, primary: false, action: () => resolve('cancel') },
              { label: rerunText, primary: false, action: () => resolve('rerun') },
              { label: continueText, primary: true, action: () => resolve('continue') },
            ],
          }
        );
      });
      if (choice === 'cancel') {
        // User abort — không reset, không continue
        this._isRunPending = false;
        return;
      }
      if (choice === 'rerun') {
        // Rerun from beginning → reset workflow
        await this._resetWorkflowFromEditor();
        // Don't continue - user will need to click Run again after reset
        this._isRunPending = false;
        return;
      }
      // choice === 'continue' → fallthrough chạy từ node chưa xong
    }

    // Check for empty workflow (no executable nodes)
    const allNodeData = this._getAllNodeData();
    const executableNodes = allNodeData.filter(n => n.node_type !== 'start' && n.node_type !== 'note');
    if (executableNodes.length === 0) {
      window.customDialog?.alert(
        window.I18n?.t('workflow.noExecutableNodes') || 'Workflow chưa có node nào để chạy.',
        { type: 'warning', title: window.I18n?.t('workflow.cannotRun') || 'Không thể chạy' }
      );
      this._isRunPending = false;
      return;
    }

    // Pre-flight check: kiểm tra provider tabs sẵn sàng
    console.log('[WorkflowEditor] _runWorkflowFromEditor: starting preflight check...');
    const preflight = await this._preflightCheck(allNodeData);
    console.log('[WorkflowEditor] _runWorkflowFromEditor: preflight result:', preflight);
    if (!preflight.ready) {
      console.log('[WorkflowEditor] _runWorkflowFromEditor aborted - preflight check failed or user cancelled');
      this._isRunPending = false;
      return;
    }

    // Phase 4 Task 4.2: Pre-execution mention validation
    const mentionValidation = this._validateAllMentions(allNodeData);
    if (mentionValidation.errors.length > 0) {
      const errorList = mentionValidation.errors.map(e => `• ${e.nodeName}: ${e.message}`).join('\n');
      await window.customDialog.alert(
        `${window.I18n?.t('workflow.mentionValidationFailed') || 'Mention validation failed'}:\n\n${errorList}`,
        { type: 'error', title: window.I18n?.t('workflow.cannotRun') || 'Không thể chạy' }
      );
      this._isRunPending = false;
      return;
    }
    if (mentionValidation.warnings.length > 0) {
      const warningList = mentionValidation.warnings.map(w => `• ${w.nodeName}: ${w.message}`).join('\n');
      const continueAnyway = await window.customDialog.confirm(
        `${window.I18n?.t('workflow.mentionWarnings') || 'Có cảnh báo về mentions'}:\n\n${warningList}\n\n${window.I18n?.t('workflow.continueAnyway') || 'Vẫn tiếp tục?'}`,
        { type: 'warning', title: window.I18n?.t('workflow.mentionWarningTitle') || 'Cảnh báo Mention', confirmText: window.I18n?.t('workflow.runAnyway') || 'Vẫn chạy' }
      );
      if (!continueAnyway) {
        this._isRunPending = false;
        return;
      }
    }

    // Check ref_file_ids exist on Flow before running
    const missingCheck = await this._checkRefFilesExist(allNodeData);
    if (missingCheck) {
      await window.customDialog.alert(missingCheck, { type: 'warning', title: window.I18n?.t('workflow.missingRefTitle') || 'Thiếu ảnh tham chiếu' });
      this._isRunPending = false;
      return;
    }

    // Ẩn node form panel (force — đang chạy workflow)
    this._formUploadKeys?.clear();
    await this.hideNodeForm();

    // Wait for any concurrent save to finish before starting our save
    if (this._isSaving) {
      const waitStart = Date.now();
      while (this._isSaving && Date.now() - waitStart < 5000) {
        await new Promise(r => setTimeout(r, 100));
      }
    }

    // Save workflow before running - MUST succeed before execution
    console.log('[WorkflowEditor] _runWorkflowFromEditor: saving workflow...');
    const saveSuccess = await this.saveWorkflow();
    console.log('[WorkflowEditor] _runWorkflowFromEditor: save result:', saveSuccess);
    if (!saveSuccess) {
      console.log('[WorkflowEditor] _runWorkflowFromEditor aborted - save failed');
      this._isRunPending = false;
      return;
    }

    // Set flag to record trial run AFTER workflow completes successfully
    if (window.featureGate) {
      window.featureGate.setPendingWorkflowRun();
    }

    // Check xem workflow có node sử dụng Flow provider không
    // Flow nodes: generate, download, image, telegram, delay
    const flowNodeTypes = ['generate', 'download', 'image', 'telegram', 'delay'];
    const hasFlowNodes = (this.workflow?.nodes || []).some(n =>
      flowNodeTypes.includes(n.node_type || n.type)
    );

    // Ensure Flow tab is active before execution (popup windows need this)
    // Chỉ cần khi có Flow nodes
    if (hasFlowNodes) {
      try {
        await new Promise(resolve => {
          chrome.runtime.sendMessage({ action: 'ensureFlowTabActive' }, () => resolve());
        });
      } catch (e) {
        console.warn('[WorkflowEditor] ensureFlowTabActive failed:', e.message);
      }
    }

    // Start execution (resume: skip completed nodes)
    console.log('[WorkflowEditor] _runWorkflowFromEditor: calling workflowExecutor.execute...', this.workflow.wf_id);
    this._addLogEntry(window.I18n?.t('workflow.startingWorkflow') || 'Bắt đầu chạy workflow...', 'info');
    // Reset pending flag - execution started
    this._isRunPending = false;
    // Gap 1 fix: execute() giờ throw CROSS_CONTEXT_RUNNING nếu lose race với context khác
    // (cũ chỉ silent overwrite flag → 2 contexts chạy song song). Catch để alert user.
    window.workflowExecutor.execute(this.workflow.wf_id).catch((err) => {
      if (err?.code === 'CROSS_CONTEXT_RUNNING') {
        window.customDialog?.alert(err.message, { type: 'warning' });
      } else {
        console.error('[WorkflowEditor] execute() failed:', err);
        this._addLogEntry((window.I18n?.t('workflow.errorPrefix', { message: err.message }) || `Lỗi: ${err.message}`), 'error');
      }
    });
  }

  async _resetWorkflowFromEditor() {
    // EWT-6: Template mode không hỗ trợ execution/reset
    if (this.isTemplateMode) return;
    // Read-only mode: không cho phép reset
    if (this.isReadOnly()) return;
    if (!this.workflow?.wf_id) return;

    // Check if any workflow is running (local or cross-context).
    // Gap 2 fix: dùng helper TTL-aware (auto-clear nếu flag stale >30 phút).
    const isLocalRunning = window.workflowExecutor?.isRunning;
    let isCrossContextRunning = false;
    try {
      const running = await window.WorkflowExecutor?.getCrossContextRunning?.();
      isCrossContextRunning = !!running?.wf_id;
    } catch (e) { /* ignore */ }

    if (isLocalRunning || isCrossContextRunning) {
      const forceReset = await window.customDialog.confirm(
        window.I18n?.t('workflow.forceResetConfirm') || 'Workflow đang chạy. Force stop và reset?',
        { type: 'warning', confirmText: 'Force Reset', cancelText: window.I18n?.t('common.cancel') || 'Hủy' }
      );
      if (!forceReset) return;
      try {
        // Use stop() with broadcast to notify all contexts
        if (window.workflowExecutor?.stop) {
          window.workflowExecutor.stop(true); // broadcast = true
        } else {
          // Fallback if executor not available
          window.workflowExecutor.shouldStop = true;
          window.workflowExecutor.isRunning = false;
        }
        // Clear cross-context running flag
        chrome.storage.local.remove('af_running_workflow');
        window.MessageBridge?.stopExecution?.().catch(() => {});
      } catch (e) { /* ignore */ }
      this.overlay?.classList.remove('wf-executing');
      const toolbarStopBtn = this.overlay?.querySelector('.tobyflow-wf-tool-btn[data-action="stop-workflow"]');
      toolbarStopBtn?.classList.add('hidden');
    }

    const confirmed = await window.customDialog.confirm(
      window.I18n?.t('workflow.resetConfirm') || 'Reset workflow sẽ xóa toàn bộ kết quả và trạng thái của các node. Bạn có chắc chắn?',
      { type: 'warning', confirmText: 'Reset', cancelText: window.I18n?.t('common.cancel') || 'Hủy' }
    );
    if (!confirmed) return;

    // Set reset guard — block stale node:completed/failed events during reset
    this._resetInProgress = true;

    try {
      // Cancel deferred save timer to prevent stale data re-persistence
      if (this._deferredSaveTimer) {
        clearTimeout(this._deferredSaveTimer);
        this._deferredSaveTimer = null;
        this._updatePlayButtonState();
      }

      // Force close node form to avoid stale data save
      await this.hideNodeForm({ skipUploadCheck: true });

      await window.workflowExecutor.reset(this.workflow.wf_id);

      // Clear _tileCache entries từ result (giữ lại ref thumbnails)
      this._clearResultTileCache();

      // Cancel background thumbnail scans that could re-populate cache
      this._clearBgScanTimers();

      // Reload canvas để reset UI status + clear previews
      const reloaded = await window.storageManager.getWorkflow(this.workflow.wf_id);
      if (reloaded) {
        this.workflow = reloaded;
        this.workflow.status = 'idle'; // Memory-only flag (UI hiện Run button)

        // CRITICAL: KHÔNG gọi saveWorkflowFull(status='idle') — backend đã có state đúng sau reset.
        // Bug cũ: save lại làm overwrite post-reset state khi 'idle' không khớp validation,
        // hoặc race condition giữa Drawflow data export và backend reset state.

        // Sync Drawflow internal data với reset state TRƯỚC khi loadWorkflow để đảm bảo:
        // - Click Play ngay sau Reset → exportWorkflow đọc Drawflow data đã pending
        // - Tránh saveWorkflow() trước Play overwrite post-reset state với stale 'completed'
        const editor = this.diagramCanvas?.editor;
        if (editor) {
          const homeData = editor.drawflow?.drawflow?.Home?.data || {};
          for (const [drawflowId, dfNode] of Object.entries(homeData)) {
            if (!dfNode?.data) continue;
            dfNode.data.status = 'pending';
            dfNode.data.result_file_ids = '';
            dfNode.data.result_thumbnails = null;
            dfNode.data.result_file_names = null;
            dfNode.data.error_message = '';
            dfNode.data.executed_at = null;
            // 2026-05-31: prompt + text_extract đều có result_text output cần clear khi reset.
            if (dfNode.data.node_type === 'prompt' || dfNode.data.node_type === 'text_extract') {
              dfNode.data.result_text = '';
              dfNode.data.result_source = '';
            }
            try { editor.updateNodeDataFromId(drawflowId, dfNode.data); } catch (e) {}
          }
        }

        this.diagramCanvas?.loadWorkflow(reloaded);
        // Restore ref image previews (ref_file_ids vẫn còn sau reset)
        this._restoreNodeStates();
      }

      // Hiện lại nút Chạy
      this._showRunButton();
      this._addLogEntry(window.I18n?.t('workflow.resetSuccess') || 'Workflow đã được reset.', 'info');

      // Emit events to update list
      window.eventBus?.emit('storage:workflow_saved', { wfId: this.workflow.wf_id });
      try {
        chrome.runtime.sendMessage({ action: 'workflowSaved', wfId: this.workflow.wf_id });
      } catch (e) {}
    } finally {
      this._resetInProgress = false;
      // Defensive: đảm bảo save button + reset button enabled lại sau reset.
      // Trước fix: nếu user click Save rồi click Reset trong race window → _isSaving có thể stuck → button disabled.
      this._isSaving = false;
      const saveBtn = this.overlay?.querySelector('#saveWorkflowBtn');
      const resetBtn = this.overlay?.querySelector('#resetWorkflowInEditorBtn');
      if (saveBtn) {
        saveBtn.disabled = false;
        if (saveBtn.innerHTML.includes('tobyflow-loading-spinner')) {
          // Restore button text based on mode
          if (this.isTemplateMode) {
            saveBtn.textContent = this.templateId
              ? (window.I18n?.t('workflow.updateTemplate') || 'Cập nhật Template')
              : (window.I18n?.t('workflow.saveTemplateBtn') || 'Lưu Template');
          } else {
            saveBtn.textContent = this.mode === 'create'
              ? (window.I18n?.t('workflow.createBtn') || 'Tạo mới')
              : (window.I18n?.t('workflow.saveBtn') || 'Lưu');
          }
        }
      }
      if (resetBtn) resetBtn.disabled = false;
      this._updatePlayButtonState();
    }
  }

  /**
   * Clear _tileCache entries that came from node results (keep ref image entries)
   */
  _clearResultTileCache() {
    if (!this.workflow?.nodes) return;
    const refIds = new Set();
    for (const node of this.workflow.nodes) {
      if (node.ref_file_ids) {
        node.ref_file_ids.split(',').map(s => s.trim()).filter(Boolean).forEach(id => refIds.add(id));
      }
    }
    // Remove entries not in any ref_file_ids
    for (const [key] of this._tileCache) {
      if (!refIds.has(key)) {
        this._tileCache.delete(key);
      }
    }
  }

  _updateNodeStatusUI(nodeId, status) {
    if (!this.overlay || !nodeId) return;

    // Find drawflow node ID from node_id
    const drawflowId = this._findDrawflowId(nodeId);
    if (!drawflowId) {
      console.warn(`[WorkflowEditor] _updateNodeStatusUI: drawflowId not found for nodeId=${nodeId}`);
      return;
    }

    const nodeEl = this.overlay.querySelector(`#node-${drawflowId}`);
    if (!nodeEl) {
      console.warn(`[WorkflowEditor] _updateNodeStatusUI: nodeEl not found for drawflowId=${drawflowId}`);
      return;
    }

    // Debug log for node status update
    const nodeType = nodeEl.querySelector('.df-node')?.dataset?.nodeType || 'unknown';
    console.log(`[WorkflowEditor] _updateNodeStatusUI: nodeId=${nodeId}, status=${status}, nodeType=${nodeType}, drawflowId=${drawflowId}`);

    // Update status dot
    const statusDot = nodeEl.querySelector('.df-node-status');
    if (statusDot) {
      statusDot.className = `df-node-status ${status}`;
    }

    // Add/remove running highlight on the whole node
    nodeEl.classList.remove('node-running', 'node-completed', 'node-failed', 'node-skipped');
    // Remove loading overlay nếu có
    const existingLoader = nodeEl.querySelector('.df-node-loading');
    if (existingLoader) {
      existingLoader.remove();
      // Bug fix 2026-05-30: Loader removal đổi node height → connection lines lệch port.
      // Schedule refresh để Drawflow recompute edge paths sau next paint.
      this._scheduleConnectionRefresh?.();
    }

    // Toggle connection active animation (dashed flow) trên outbound edges từ node này
    // → user thấy data "đang truyền" sang downstream nodes (matching screenshot).
    this._setNodeConnectionsActive(drawflowId, status === 'running');

    if (status === 'running') {
      nodeEl.classList.add('node-running');
      // Image node: GIỮ NGUYÊN ref preview — KHÔNG replace bằng shimmer, KHÔNG
      // append loading pill. Tín hiệu running thuần qua:
      //   1. Glow border node-running + pulse (background)
      //   2. CSS gradient overlay ::after lên .df-node-preview (foreground sweep)
      //      → user thấy ảnh ref vẫn rõ + lớp gradient "đang xử lý" chạy ngang.
      const isImageNode = nodeEl.querySelector('.df-node[data-node-type="image"]') !== null;
      if (isImageNode) {
        // Skip mọi loading UI replace — CSS .node-running .df-node-preview::after
        // tự render gradient overlay (xem workflow.css). KHÔNG cần thêm DOM.
      } else {
        // Other node types (generate/prompt/download/grok/chatgpt/etc.): replace preview với shimmer
        const previewEl = nodeEl.querySelector('.df-node-preview');
        if (previewEl) {
          // Lock height TRƯỚC khi swap placeholder/thumbs → shimmer.
          // Tránh node co lại trong transition (shimmer chưa fill aspect-ratio class height).
          this._lockPreviewHeight?.(previewEl);
          previewEl.classList.remove('hidden', 'image-ref');
          previewEl.innerHTML = `
            <div class="df-node-loading-shimmer">
              <span class="df-node-loading-text">${window.I18n?.t('workflow.processing') || 'Processing...'}</span>
            </div>`;
          // Bug fix 2026-05-27: shimmer (không có height nội tại) → aspect-ratio class áp lại → box có
          // thể resize so với thumbnail cũ (ratio khác) → edges lệch. Reposition connections sau resize.
          this._scheduleConnectionRefresh?.();
        } else {
          // Fallback: append loading pill cuối node body
          const loader = document.createElement('div');
          loader.className = 'df-node-loading';
          loader.innerHTML = `
            <div class="df-node-loading-spinner"></div>
            <span class="df-node-loading-text">${window.I18n?.t('workflow.processing') || 'Processing...'}</span>
          `;
          const contentNode = nodeEl.querySelector('.drawflow_content_node');
          if (contentNode) {
            contentNode.appendChild(loader);
            // Bug fix 2026-05-30: append loader làm node cao hơn → port out shift xuống → connection lệch.
            // Schedule refresh sau next paint để Drawflow recompute edge paths.
            this._scheduleConnectionRefresh?.();
          }
        }
      }
    } else if (status === 'completed') {
      nodeEl.classList.add('node-completed');
    } else if (status === 'failed') {
      nodeEl.classList.add('node-failed');
    } else if (status === 'skipped') {
      nodeEl.classList.add('node-skipped');
    } else if (status === 'pending') {
      // Clear result preview khi reset (giữ ref preview)
      const previewEl = nodeEl.querySelector('.df-node-preview');
      if (previewEl && !previewEl.classList.contains('image-ref')) {
        // Restore placeholder SVG (giống NodeTemplates gốc)
        previewEl.innerHTML = `<div class="df-node-preview-placeholder">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.3"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>
        </div>`;
        previewEl.classList.remove('hidden');
      }
    }

    // Log
    // Log chi tiết đã emit qua execution:log từ WorkflowExecutor
  }

  /**
   * Toggle `.connection-active` class on tất cả INCOMING connections vào node `drawflowId`.
   * Drawflow generates SVG với class pattern: `connection node_in_node-<targetId> node_out_node-<sourceId>`.
   * Animate incoming edges = "đang truyền data vào node running" (đúng logic execution flow:
   * upstream node đã completed → data đang chảy đến node hiện tại đang xử lý).
   * Outbound edges KHÔNG animate vì chưa có output (chỉ active khi downstream nhận data sau).
   */
  _setNodeConnectionsActive(drawflowId, active) {
    if (!this.overlay || !drawflowId) return;
    try {
      const selector = `svg.connection.node_in_node-${drawflowId}`;
      const connections = this.overlay.querySelectorAll(selector);
      connections.forEach((conn) => {
        conn.classList.toggle('connection-active', active);
      });
    } catch (e) {
      console.warn('[WorkflowEditor] _setNodeConnectionsActive error:', e?.message);
    }
  }

  /**
   * UI 2026-05-27: highlight (đổi màu bright) TẤT CẢ connection chạm tới node đang select
   * (cả incoming `node_in` lẫn outgoing `node_out`). Clear selection cũ trước khi set mới.
   * Class `conn-node-selected` — tách biệt với `.selected` (click chọn edge) và
   * `.connection-active` (running). Truyền `drawflowId=null` để chỉ clear.
   */
  _setNodeConnectionsSelected(drawflowId) {
    if (!this.overlay) return;
    try {
      // Clear highlight cũ
      this.overlay.querySelectorAll('svg.connection.conn-node-selected')
        .forEach((conn) => conn.classList.remove('conn-node-selected'));
      if (!drawflowId) return;
      this.overlay
        .querySelectorAll(`svg.connection.node_in_node-${drawflowId}, svg.connection.node_out_node-${drawflowId}`)
        .forEach((conn) => conn.classList.add('conn-node-selected'));
    } catch (e) {
      console.warn('[WorkflowEditor] _setNodeConnectionsSelected error:', e?.message);
    }
  }

  /**
   * Defensive helper — re-scan tất cả nodes đang `.node-running` và đảm bảo incoming
   * connections của chúng có class `.connection-active`. Gọi từ `node:moved` event
   * để chống mất animation khi user drag node trong lúc workflow đang chạy.
   * Idempotent — gọi nhiều lần không gây side effect.
   */
  _reapplyRunningConnections() {
    if (!this.overlay) return;
    // Clear all active classes trước, rồi re-apply theo node-running hiện tại
    // (tránh stale class trên connection nếu node đã unstaged khỏi running).
    this.overlay.querySelectorAll('svg.connection.connection-active')
      .forEach((conn) => conn.classList.remove('connection-active'));
    const runningNodes = this.overlay.querySelectorAll('.drawflow-node.node-running');
    runningNodes.forEach((nodeEl) => {
      const drawflowId = nodeEl.id?.replace('node-', '');
      if (drawflowId) this._setNodeConnectionsActive(drawflowId, true);
    });
  }

  _updateNodeLoadingText(nodeId, text) {
    if (!this.overlay || !nodeId) return;
    const drawflowId = this._findDrawflowId(nodeId);
    if (!drawflowId) return;
    const nodeEl = this.overlay.querySelector(`#node-${drawflowId}`);
    const loadingText = nodeEl?.querySelector('.df-node-loading-text');
    if (loadingText) loadingText.textContent = text;
  }

  /**
   * 2026-05-30: Update AI Output section trong prompt node sau AI run complete.
   * Drawflow.updateNodeDataFromId() update internal data nhưng KHÔNG re-render HTML template
   * → AI Output container trong template (NodeTemplates) chỉ render lúc tạo node.
   * Function này manually update/create AI Output container DOM với fresh result_text.
   *
   * REPLACE legacy `.df-node-prompt-result` element bằng `.df-ai-output-container` mới.
   */
  _updatePromptNodeResultPreview(nodeId, data) {
    if (!this.overlay || !nodeId) return;
    const drawflowId = this._findDrawflowId(nodeId);
    if (!drawflowId) return;

    const resultText = data?.result_text || '';
    const promptText = data?.prompt || '';
    const provider = data?.provider || 'chatgpt';
    const useAi = !!data?.use_ai;
    // Skip nếu no result OR result same prompt (plain mode) OR use_ai OFF.
    const shouldShow = useAi && resultText && resultText.trim() !== promptText.trim();

    const nodeEl = this.overlay.querySelector(`#node-${drawflowId}`);
    const nodeBody = nodeEl?.querySelector('.df-node-body');
    if (!nodeBody) return;

    // Cleanup legacy element nếu render cũ còn tồn tại
    const legacyEl = nodeBody.querySelector('.df-node-prompt-result');
    if (legacyEl) legacyEl.remove();

    let aiOutputEl = nodeBody.querySelector('.df-ai-output-container');

    if (!shouldShow) {
      // Remove AI Output section nếu condition KHÔNG match (vd plain mode hoặc empty)
      if (aiOutputEl) {
        aiOutputEl.remove();
        this._scheduleConnectionRefresh();
      }
      return;
    }

    const providerLabel = provider === 'gemini' ? 'Gemini' : 'ChatGPT';
    const aiOutputLabel = window.I18n?.t?.('node.aiOutputLabel') || 'AI Output';
    const formatted = window.NodeTemplates?.formatPromptWithMentions
      ? window.NodeTemplates.formatPromptWithMentions(resultText)
      : this.escapeHtml(resultText);

    if (!aiOutputEl) {
      // CREATE new container — match template structure (NodeTemplates.js line ~530)
      aiOutputEl = document.createElement('div');
      aiOutputEl.className = 'df-ai-output-container nodrag';
      aiOutputEl.innerHTML = `
        <div class="df-ai-output-label">
          <svg class="df-ai-output-icon" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 2l2 7h7l-5.5 4 2 7L12 16l-5.5 4 2-7L3 9h7z"/>
          </svg>
          <span class="df-ai-output-label-text">${this.escapeHtml(aiOutputLabel)}</span>
          <span class="df-ai-output-provider">${this.escapeHtml(providerLabel)}</span>
        </div>
        <div class="df-ai-output-text"></div>
      `;
      // Insert BEFORE settings bar (template order: AI Output → settings bar → ref preview)
      const settingsBar = nodeBody.querySelector('.df-node-settings-bar');
      if (settingsBar) {
        nodeBody.insertBefore(aiOutputEl, settingsBar);
      } else {
        nodeBody.appendChild(aiOutputEl);
      }
    } else {
      // UPDATE provider label nếu đã có (vd user đổi provider giữa runs)
      const providerEl = aiOutputEl.querySelector('.df-ai-output-provider');
      if (providerEl) providerEl.textContent = providerLabel;
    }

    // Update text content (innerHTML để support @mention formatting)
    const textEl = aiOutputEl.querySelector('.df-ai-output-text');
    if (textEl) textEl.innerHTML = formatted;

    this._scheduleConnectionRefresh();
  }

  /**
   * 2026-05-31: Update extracted text section trên text_extract node sau khi run.
   * Mirror pattern _updatePromptNodeResultPreview nhưng không có provider label (text_extract
   * pure regex/JSON, không gọi AI). Selector data-extract-output để phân biệt với prompt AI.
   */
  _updateExtractNodeResultPreview(nodeId, data) {
    if (!this.overlay || !nodeId) return;
    const drawflowId = this._findDrawflowId(nodeId);
    if (!drawflowId) return;

    const resultText = (data?.result_text || '').trim();
    const nodeEl = this.overlay.querySelector(`#node-${drawflowId}`);
    const nodeBody = nodeEl?.querySelector('.df-node-body');
    if (!nodeBody) return;

    let outputEl = nodeBody.querySelector('[data-extract-output]');

    if (!resultText) {
      // Remove section khi không có result (vd reset node hoặc extract fail)
      if (outputEl) {
        outputEl.remove();
        this._scheduleConnectionRefresh();
      }
      return;
    }

    const outputLabel = window.I18n?.t?.('node.extractOutputLabel') || 'Extracted';

    if (!outputEl) {
      // CREATE — match template structure (NodeTemplates.js text_extract block)
      outputEl = document.createElement('div');
      outputEl.className = 'df-ai-output-container nodrag';
      outputEl.setAttribute('data-extract-output', '');
      outputEl.innerHTML = `
        <div class="df-ai-output-label">
          <svg class="df-ai-output-icon" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><rect x="7" y="8" width="10" height="8" rx="1"/>
          </svg>
          <span class="df-ai-output-label-text">${this.escapeHtml(outputLabel)}</span>
        </div>
        <div class="df-ai-output-text"></div>
      `;
      nodeBody.appendChild(outputEl);
    }

    const textEl = outputEl.querySelector('.df-ai-output-text');
    if (textEl) textEl.textContent = resultText;

    this._scheduleConnectionRefresh();
  }

  /**
   * Clear AI Output section + result data (when re-running or resetting).
   */
  _clearPromptNodeResultPreview(nodeId) {
    if (!this.overlay || !nodeId) return;
    const drawflowId = this._findDrawflowId(nodeId);
    if (drawflowId) {
      const nodeEl = this.overlay.querySelector(`#node-${drawflowId}`);
      // Remove cả legacy element + new AI Output container
      const legacyEl = nodeEl?.querySelector('.df-node-prompt-result');
      if (legacyEl) legacyEl.remove();
      const aiOutputEl = nodeEl?.querySelector('.df-ai-output-container');
      if (aiOutputEl) aiOutputEl.remove();
      if (legacyEl || aiOutputEl) this._scheduleConnectionRefresh();
    }
    // Clear from drawflow data
    this._syncDrawflowNodeData(nodeId, { result_text: '', result_source: '' });
  }

  /**
   * Schedule connection paths re-render sau khi DOM của node card thay đổi kích thước
   * (preview area resize do ratio đổi, ref preview append/remove, port count đổi).
   * Defer 2 rAF cho CSS aspect-ratio + reflow settle. Throttle để gộp nhiều caller cùng frame.
   */
  _scheduleConnectionRefresh() {
    if (this._connectionRefreshScheduled) return;
    this._connectionRefreshScheduled = true;
    try {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          this._connectionRefreshScheduled = false;
          try { this.diagramCanvas?._forceUpdateAllConnections?.(); } catch (e) {}
        });
      });
    } catch (e) { this._connectionRefreshScheduled = false; }
  }

  /**
   * Attach ResizeObserver vào image node card → tự re-route connections mỗi khi
   * node thay đổi kích thước (image load, replace ref, reset, CSS transition).
   * Tránh stale SVG paths khi node fit-content shrink/grow.
   *
   * Drawflow positioning dùng port DOM rect → khi node resize, port positions
   * thay đổi nhưng connections KHÔNG tự update. Phải gọi updateConnectionNodes
   * (qua _scheduleConnectionRefresh) để re-compute paths.
   *
   * Idempotent: KHÔNG attach lần 2 nếu đã có observer trên element.
   */
  _attachImageNodeResizeObserver(drawflowId) {
    if (!drawflowId || typeof ResizeObserver === 'undefined') return;
    const nodeEl = this.overlay?.querySelector(`#node-${drawflowId}`);
    if (!nodeEl) return;
    // 2026-05-28: observe MỌI node có preview media co giãn (image + generate/chatgpt/grok) — node
    // resize khi: image/VIDEO result load, ref render, reset, đổi ratio. Trước: chỉ image node →
    // generate/grok/chatgpt gen xong (đặc biệt VIDEO) box resize nhưng connection KHÔNG re-route →
    // link lệch port. Node khác (delay/note/download/prompt/text) size cố định → skip.
    const nodeType = nodeEl.querySelector('.df-node')?.dataset?.nodeType;
    if (!['image', 'generate', 'chatgpt', 'grok'].includes(nodeType)) return;
    if (nodeEl._imgResizeObserver) return; // đã attach

    if (!this._nodeResizeObservers) this._nodeResizeObservers = new Set();
    const observer = new ResizeObserver(() => {
      this._scheduleConnectionRefresh();
    });
    observer.observe(nodeEl);
    nodeEl._imgResizeObserver = observer;
    this._nodeResizeObservers.add(observer);
  }

  /**
   * Cleanup tất cả ResizeObservers (gọi trong _forceClose để tránh leak khi reload editor).
   */
  _cleanupNodeResizeObservers() {
    if (!this._nodeResizeObservers) return;
    for (const obs of this._nodeResizeObservers) {
      try { obs.disconnect(); } catch (e) {}
    }
    this._nodeResizeObservers.clear();
  }

  _clearNodePreview(nodeId) {
    if (!this.overlay || !nodeId) return;
    const drawflowId = this._findDrawflowId(nodeId);
    if (!drawflowId) return;
    const nodeEl = this.overlay.querySelector(`#node-${drawflowId}`);
    const previewContainer = nodeEl?.querySelector('.df-node-preview');
    if (!previewContainer) return;

    // Bug fix: Image source node — `ref_file_ids` là SOURCE DATA của node (user upload),
    // không phải result. Reset node chỉ xóa result_*, giữ ref_* để node "image" tiếp tục
    // serve ảnh source cho downstream. Trước fix: reset xóa ref preview → user phải re-upload.
    const dfNode = this.diagramCanvas?.editor?.getNodeFromId?.(drawflowId);
    const nodeType = dfNode?.data?.node_type || dfNode?.class;
    const refFileIds = dfNode?.data?.ref_file_ids;
    if (nodeType === 'image' && refFileIds) {
      const ids = String(refFileIds).split(',').map((s) => s.trim()).filter(Boolean);
      if (ids.length > 0) {
        // Re-render preview từ ref_file_ids (giữ ảnh source)
        this._showNodePreview(nodeId, ids);
        return;
      }
    }

    // Bug fix 2026-05-27: reset từ result grid (multi-result) làm mất/đè class ratio → placeholder
    // sai khung tỷ lệ (vd node 9:16 nhưng placeholder hiển thị rộng). Xóa class result + restore
    // class ratio theo data.ratio (đồng bộ cgRatioClass/genRatioClass của NodeTemplates).
    previewContainer.classList.remove('image-ref', 'hidden', 'multi-result',
      'ratio-9-16', 'ratio-3-4', 'ratio-2-3', 'ratio-1-1', 'ratio-4-3', 'ratio-3-2', 'ratio-16-9');
    const nodeRatio = dfNode?.data?.ratio;
    if (nodeRatio) {
      const rc = this._resolveRatioClass(nodeRatio);
      if (rc) previewContainer.classList.add(rc);
    }
    // Restore placeholder SVG cho MỌI node type khác (đồng bộ với NodeTemplates default render).
    previewContainer.innerHTML = `<div class="df-node-preview-placeholder">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.3"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
    </div>`;
    this._scheduleConnectionRefresh();
  }

  _showNodePreview(nodeId, fileIds) {
    if (!this.overlay || !nodeId || !fileIds?.length) return;

    const drawflowId = this._findDrawflowId(nodeId);
    if (!drawflowId) return;

    const nodeEl = this.overlay.querySelector(`#node-${drawflowId}`);
    const previewContainer = nodeEl?.querySelector('.df-node-preview');
    if (!previewContainer) return;

    // Image node: hiển thị ảnh đúng ratio (contain thay vì cover)
    const isImageNode = nodeEl.querySelector('.df-node[data-node-type="image"]') !== null;
    previewContainer.classList.toggle('image-ref', isImageNode);

    // Dedup file IDs
    const uniqueIds = [...new Set(fileIds)];

    // Cancel retry trước đó nếu có
    if (previewContainer._retryTimer) {
      clearTimeout(previewContainer._retryTimer);
      previewContainer._retryTimer = null;
    }

    // Tag container with nodeId for thumbnail persistence
    previewContainer._nodeId = nodeId;

    // Retry vài lần vì tiles có thể chưa render xong media
    this._renderNodePreviewWithRetry(previewContainer, uniqueIds, 0);

    // Preview area class change (image-ref toggles aspect-ratio) + image load → height có thể đổi
    this._scheduleConnectionRefresh();
  }

  /**
   * Render ref image thumbnails ở dưới cùng của generate nodes
   * Includes cross-project validation using ref_file_names
   */
  _showNodeRefPreview(nodeId, refIds) {
    if (!this.overlay || !nodeId) return;
    const drawflowId = this._findDrawflowId(nodeId);
    if (!drawflowId) return;
    const nodeEl = this.overlay.querySelector(`#node-${drawflowId}`);
    let refContainer = nodeEl?.querySelector('.df-node-ref-preview');

    // Get ref_file_names from node data for cross-project validation
    const nodeData = this.diagramCanvas?.editor?.getNodeFromId(drawflowId)?.data;
    const refFileNames = nodeData?.ref_file_names || null;

    // Tạo container nếu chưa có
    if (!refContainer && refIds?.length > 0) {
      const body = nodeEl?.querySelector('.df-node-body');
      if (!body) return;
      refContainer = document.createElement('div');
      refContainer.className = 'df-node-ref-preview';
      refContainer.setAttribute('data-ref-preview', '');
      body.appendChild(refContainer);
    }
    if (!refContainer) return;

    if (!refIds || refIds.length === 0) {
      refContainer.remove();
      this._scheduleConnectionRefresh();
      return;
    }

    refContainer.innerHTML = '';
    const uniqueIds = [...new Set(refIds)];

    // Append/show ref preview row → node card height tăng → connections cần update
    this._scheduleConnectionRefresh();

    const renderThumbs = () => {
      refContainer.innerHTML = '';
      for (const tileId of uniqueIds.slice(0, 6)) {
        let mediaSrc = '';
        let isMismatch = false;
        const expectedFileName = refFileNames?.[tileId] || null;
        const cached = this._tileCache.get(tileId);

        // ALWAYS check DOM first to detect cross-project collision.
        // 2026-05-31 v3: ưu tiên <video> trước (parity với _loadResultGalleryThumbnails)
        // để có domVideoSrc → render <video> element thay vì placeholder static.
        const tile = document.querySelector(`[data-tile-id="${tileId}"]`);
        let domFileName = null;
        let domThumbSrc = null;
        let domIsVideo = false;
        let domVideoSrc = null;

        if (tile) {
          domFileName = this._extractFileNameFromTile(tile);
          // Check <video> trước
          const videoEl = tile.querySelector('video');
          if (videoEl?.src) {
            domVideoSrc = videoEl.src;
            domIsVideo = true;
          } else {
            const img = tile.querySelector('img');
            if (img?.src) domThumbSrc = img.src;
            if (!domThumbSrc && this._isVideoTile(tile)) {
              domIsVideo = true;
            }
          }
          // Update cache với type + video_url để render lần sau (reload workflow) có signal
          if (domIsVideo && cached && (cached.type !== 'video' || (domVideoSrc && !cached.video_url))) {
            this._tileCacheSet(tileId, { ...cached, type: 'video', ...(domVideoSrc && { video_url: domVideoSrc }) });
          }
        }

        // Cross-project detection (same logic as edit panel):
        // 1. If we have expectedFileName (new workflow) → validate against it
        // 2. If no expectedFileName but have cached file_name → compare with DOM file_name
        if (expectedFileName) {
          if (domFileName && domFileName !== expectedFileName) {
            console.warn(`[WorkflowEditor] Canvas cross-project collision (expected): tile_id=${tileId}, expected=${expectedFileName}, actual=${domFileName}`);
            isMismatch = true;
          } else if (cached?.file_name && cached.file_name !== expectedFileName) {
            isMismatch = true;
          }
        } else if (domFileName && cached?.file_name && domFileName !== cached.file_name) {
          // Old workflow: compare DOM vs cache
          console.warn(`[WorkflowEditor] Canvas cross-project collision (cache vs DOM): tile_id=${tileId}, cached=${cached.file_name}, dom=${domFileName}`);
          isMismatch = true;
        } else if (domFileName && cached?.thumbnail && !cached?.file_name) {
          // Update cache with current file_name
          this._tileCacheSet(tileId, { ...cached, file_name: domFileName });
        }

        // Use DOM thumbnail if available and not mismatch
        if (!isMismatch) {
          if (domThumbSrc) {
            mediaSrc = domThumbSrc;
          } else if (cached?.thumbnail) {
            mediaSrc = cached.thumbnail;
          }
        }

        if (!mediaSrc && window.pendingUploadFiles?.has(tileId)) {
          const pending = window.pendingUploadFiles.get(tileId);
          if (pending?.thumbnail) mediaSrc = pending.thumbnail;
        }
        if (!mediaSrc && window._uploadedThumbnailCache?.has(tileId)) {
          mediaSrc = window._uploadedThumbnailCache.get(tileId);
        }
        // 2026-05-31 v7: detect video CHỈ qua type='video' / extension / DOM <video> element.
        // BỎ mediaSrcIsVideoUrl — Flow `getMediaUrlRedirect` URL dùng chung image + video → ambiguous!
        const isVideoCandidate = (
          cached?.type === 'video' ||
          /\.(mp4|webm|mov|m4v)$/i.test(cached?.file_name || domFileName || '') ||
          domIsVideo
        );
        const videoUrl = domVideoSrc || cached?.video_url || '';
        const useVideo = isVideoCandidate && !!videoUrl;
        const useImg = !useVideo && mediaSrc;
        // KHÔNG còn `continue` skip — luôn render placeholder để user thấy ref slot.

        const thumb = document.createElement('div');
        thumb.className = 'df-ref-thumb';
        if (isMismatch) {
          thumb.classList.add('df-ref-thumb-mismatch');
          thumb.style.cssText = 'border:2px solid var(--destructive,#dc2626);position:relative;';
          thumb.title = window.I18n?.t('workflow.crossProjectNeedReselect') || 'Image from another project - please reselect';
        }
        if (isMismatch) {
          thumb.innerHTML = '<span style="font-size:8px;color:var(--destructive);">X</span>';
        } else if (useImg) {
          const img = document.createElement('img');
          img.src = mediaSrc;
          img.alt = 'ref';
          // Reactive: nếu URL trả mp4 bytes → <img> fail → swap sang <video> + heal cache.
          img.addEventListener('error', () => {
            const video = document.createElement('video');
            video.src = mediaSrc;
            video.muted = true; video.playsInline = true; video.preload = 'metadata';
            video.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block;background:#0c1320;';
            video.addEventListener('loadedmetadata', () => { try { video.currentTime = 0.1; } catch (_) {} }, { once: true });
            img.parentNode?.replaceChild(video, img);
            this._tileCacheSet(tileId, { ...(this._tileCache.get(tileId) || {}), type: 'video', video_url: mediaSrc });
          }, { once: true });
          thumb.appendChild(img);
        } else if (useVideo) {
          // Video URL hợp lệ → render <video> (preload metadata để show first frame stable)
          thumb.innerHTML = `<video src="${videoUrl}" muted playsinline preload="metadata" style="width:100%;height:100%;object-fit:cover;display:block;background:#0c1320;"></video>`;
          // Seek to first frame on metadata load
          const vEl = thumb.querySelector('video');
          if (vEl) vEl.addEventListener('loadedmetadata', () => { try { vEl.currentTime = 0.1; } catch (_) {} }, { once: true });
        } else if (isVideoCandidate) {
          // Video tile thiếu URL → placeholder play icon
          thumb.innerHTML = '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:rgba(99,102,241,0.10);color:var(--primary,#6366f1);" title="Video"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M8 5v14l11-7z"/></svg></div>';
        } else {
          // Image ref thiếu thumbnail → placeholder broken-image icon
          thumb.innerHTML = `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:rgba(245,158,11,0.06);color:var(--muted-foreground);" title="${this.escapeAttr(tileId.substring(0, 12))}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg></div>`;
        }
        refContainer.appendChild(thumb);
      }
      if (uniqueIds.length > 6) {
        const more = document.createElement('div');
        more.className = 'df-ref-thumb';
        more.style.cssText = 'display:flex;align-items:center;justify-content:center;font-size:11px;color:var(--muted-foreground)';
        more.textContent = `+${uniqueIds.length - 6}`;
        refContainer.appendChild(more);
      }
    };

    // Try render, if no DOM tiles fetch trực tiếp theo file IDs
    const hasDom = uniqueIds.some(id => document.querySelector(`[data-tile-id="${id}"]`));
    const allCached = uniqueIds.every(id => this._tileCache.has(id) || window.pendingUploadFiles?.has(id) || window._uploadedThumbnailCache?.has(id));
    if (!hasDom && !allCached && typeof MessageBridge !== 'undefined') {
      const uncachedIds = uniqueIds.filter(id => !this._tileCache.has(id) && !window.pendingUploadFiles?.has(id) && !window._uploadedThumbnailCache?.has(id));
      // Show gradient sweep loading for each ref
      refContainer.innerHTML = uncachedIds.slice(0, 6).map(() =>
        '<div class="df-ref-thumb"><div class="df-ref-shimmer"></div></div>'
      ).join('');
      MessageBridge.getThumbnailsByIds(uncachedIds).then(result => {
        for (const [fid, info] of Object.entries(result?.results || {})) {
          if (!info?.thumbnail) continue;
          // Cross-project safety: validate file_name before overwriting cache
          const existingCache = this._tileCache.get(fid);
          const savedFn = existingCache?.file_name;
          const newFn = info?.file_name;
          if (savedFn && newFn && savedFn !== newFn) {
            console.warn(`[WorkflowEditor] Ref preview: cross-project skip ${fid}`);
            continue; // Giữ cache cũ
          }
          // Bug 51 fix: Include video_url for video playback
          this._tileCacheSet(fid, { thumbnail: info.thumbnail, type: info.type || 'image', ...(newFn && { file_name: newFn }), ...(info.video_url && { video_url: info.video_url }) });
        }
        renderThumbs();
      }).catch(() => renderThumbs());
    } else {
      renderThumbs();
    }
  }

  /**
   * Show ref image preview từ URLs (cho template mode)
   * Không cần lookup từ tile cache, render trực tiếp từ URLs
   */
  _showNodeRefPreviewFromUrls(nodeId, refUrls) {
    if (!this.overlay || !nodeId || !refUrls?.length) return;
    const drawflowId = this._findDrawflowId(nodeId);
    if (!drawflowId) return;
    const nodeEl = this.overlay.querySelector(`#node-${drawflowId}`);
    let refContainer = nodeEl?.querySelector('.df-node-ref-preview');

    // Tạo container nếu chưa có
    if (!refContainer) {
      const body = nodeEl?.querySelector('.df-node-body');
      if (!body) return;
      refContainer = document.createElement('div');
      refContainer.className = 'df-node-ref-preview';
      refContainer.setAttribute('data-ref-preview', '');
      body.appendChild(refContainer);
    }

    refContainer.innerHTML = '';
    const uniqueUrls = [...new Set(refUrls)].filter(Boolean);

    for (const url of uniqueUrls.slice(0, 6)) {
      const thumb = document.createElement('div');
      thumb.className = 'df-ref-thumb';
      const img = document.createElement('img');
      img.src = url;
      img.alt = 'ref';
      img.onerror = () => { thumb.innerHTML = '<span style="font-size:8px;color:var(--destructive);">!</span>'; };
      thumb.appendChild(img);
      refContainer.appendChild(thumb);
    }

    if (uniqueUrls.length > 6) {
      const more = document.createElement('div');
      more.className = 'df-ref-thumb';
      more.style.cssText = 'display:flex;align-items:center;justify-content:center;font-size:11px;color:var(--muted-foreground)';
      more.textContent = `+${uniqueUrls.length - 6}`;
      refContainer.appendChild(more);
    }

    this._scheduleConnectionRefresh();
  }

  /**
   * Clear ref image preview cho node
   */
  _clearNodeRefPreview(nodeId) {
    if (!this.overlay || !nodeId) return;
    const drawflowId = this._findDrawflowId(nodeId);
    if (!drawflowId) return;
    const nodeEl = this.overlay.querySelector(`#node-${drawflowId}`);
    const refContainer = nodeEl?.querySelector('.df-node-ref-preview');
    if (refContainer) {
      refContainer.remove();
      this._scheduleConnectionRefresh();
    }
  }

  /**
   * Show toast notification trong editor overlay
   * Fallback khi window.showNotification không khả dụng
   */
  _showEditorToast(message, type = 'success', duration = 3000) {
    if (!this.overlay) return;

    // Remove existing toast
    const existing = this.overlay.querySelector('.wf-editor-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = `wf-editor-toast wf-editor-toast--${type}`;
    toast.innerHTML = `<span>${message}</span>`;
    toast.style.cssText = `
      position: fixed;
      bottom: 20px;
      left: 50%;
      transform: translateX(-50%);
      padding: 10px 20px;
      border-radius: 8px;
      background: ${type === 'success' ? 'var(--success, #22c55e)' : type === 'error' ? 'var(--destructive, #ef4444)' : 'var(--primary, #3b82f6)'};
      color: white;
      font-size: 14px;
      z-index: 100000;
      animation: wf-toast-in 0.3s ease;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    `;

    this.overlay.appendChild(toast);

    setTimeout(() => {
      toast.style.animation = 'wf-toast-out 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }

  /**
   * Lock preview container height BEFORE clearing innerHTML để tránh node bị collapse
   * trong transition placeholder/shimmer → thumb (khi <img> chưa load, .df-preview-thumb
   * override aspect-ratio → height=auto → ~0 → node co lại → image load → expand lại).
   * Caller phải gọi _unlockPreviewHeight() sau khi media đã load (hoặc khi cần re-render).
   */
  _lockPreviewHeight(previewContainer) {
    if (!previewContainer) return;
    const h = previewContainer.offsetHeight;
    if (h > 0) {
      previewContainer.style.minHeight = `${h}px`;
    }
  }
  _unlockPreviewHeight(previewContainer) {
    if (!previewContainer) return;
    previewContainer.style.minHeight = '';
  }
  /**
   * Sau khi inject thumbs có <img>/<video>, đợi tất cả load xong rồi release lock height.
   * Nếu media đã cached (complete=true) → release ngay.
   */
  _releaseLockWhenMediaReady(previewContainer) {
    if (!previewContainer) return;
    const mediaEls = previewContainer.querySelectorAll('img, video');
    if (mediaEls.length === 0) {
      this._unlockPreviewHeight(previewContainer);
      return;
    }
    let pending = mediaEls.length;
    const release = () => {
      pending--;
      if (pending <= 0) {
        // requestAnimationFrame để browser flush layout với image natural size TRƯỚC khi unlock
        // → tránh frame flash khi minHeight=0 nhưng image chưa render dimension xong.
        requestAnimationFrame(() => this._unlockPreviewHeight(previewContainer));
      }
    };
    mediaEls.forEach(el => {
      const isComplete = el.tagName === 'IMG'
        ? el.complete && el.naturalHeight > 0
        : (el.readyState >= 1); // HAVE_METADATA cho video
      if (isComplete) {
        release();
      } else {
        const onDone = () => {
          el.removeEventListener('load', onDone);
          el.removeEventListener('error', onDone);
          el.removeEventListener('loadedmetadata', onDone);
          release();
        };
        el.addEventListener('load', onDone, { once: true });
        el.addEventListener('error', onDone, { once: true });
        el.addEventListener('loadedmetadata', onDone, { once: true });
      }
    });
    // Safety timeout 5s — nếu media stuck loading, release để tránh node lock vĩnh viễn.
    setTimeout(() => {
      if (pending > 0) {
        pending = 0;
        this._unlockPreviewHeight(previewContainer);
      }
    }, 5000);
  }

  _renderNodePreviewWithRetry(previewContainer, fileIds, attempt) {
    const maxAttempts = 5;
    const delay = 1000;

    // In standalone window, tiles aren't in DOM — fetch trực tiếp theo file IDs
    const hasDomTiles = fileIds.some(id => document.querySelector(`[data-tile-id="${id}"]`));
    const allCached = !hasDomTiles && fileIds.every(id => this._tileCache.has(id) || window.pendingUploadFiles?.has(id) || window._uploadedThumbnailCache?.has(id));
    if (!hasDomTiles && !allCached && typeof MessageBridge !== 'undefined') {
      const uncachedIds = fileIds.filter(id => !this._tileCache.has(id) && !window.pendingUploadFiles?.has(id) && !window._uploadedThumbnailCache?.has(id));
      // Show loading shimmer while fetching
      if (!previewContainer.querySelector('img, video')) {
        // Lock height trước khi swap placeholder/thumbs → shimmer (giữ node size)
        this._lockPreviewHeight(previewContainer);
        previewContainer.classList.remove('hidden');
        previewContainer.innerHTML = `<div class="df-node-loading-shimmer"><span class="df-node-loading-text">${window.I18n?.t('workflow.loadingImages') || 'Loading images...'}</span></div>`;
      }
      MessageBridge.getThumbnailsByIds(uncachedIds).then(result => {
        const results = result?.results || {};
        for (const [fid, info] of Object.entries(results)) {
          if (!info?.thumbnail) continue;
          // Cross-project safety: validate file_name before overwriting cache
          const existingCache = this._tileCache.get(fid);
          const savedFn = existingCache?.file_name;
          const newFn = info?.file_name;
          if (savedFn && newFn && savedFn !== newFn) {
            console.warn(`[WorkflowEditor] Result preview: cross-project skip ${fid}`);
            continue;
          }
          // Bug 51 fix: Include video_url for video playback
          this._tileCacheSet(fid, { thumbnail: info.thumbnail, type: info.type || 'image', ...(newFn && { file_name: newFn }), ...(info.video_url && { video_url: info.video_url }) });
        }
        this._renderNodePreviewInner(previewContainer, fileIds, attempt);
      }).catch(() => {
        this._renderNodePreviewInner(previewContainer, fileIds, attempt);
      });
      return;
    }

    this._renderNodePreviewInner(previewContainer, fileIds, attempt);
  }

  _renderNodePreviewInner(previewContainer, fileIds, attempt) {
    const maxAttempts = 5;
    const delay = 1000;

    // Lock height TRƯỚC clear → tránh node collapse trong transition.
    // (Khi clear innerHTML + chèn .df-preview-thumb → CSS :has() bỏ aspect-ratio →
    // height=auto → ~0 cho đến khi <img> load → node co rồi expand lại.)
    this._lockPreviewHeight(previewContainer);

    previewContainer.innerHTML = '';
    previewContainer.classList.remove('hidden');
    // Single result: full-size display; multiple: grid thumbnails
    previewContainer.classList.toggle('multi-result', fileIds.length > 1);

    let foundCount = 0;
    let lastThumb = null; // ref tới thumb cuối — gắn overlay "+N" khi tổng > 6 ảnh
    const foundThumbs = {}; // fileId -> thumbnailUrl (for persistence)

    // Hiển thị tối đa 6 ảnh (2 hàng × 3). Ảnh thứ 6 sẽ có overlay "+N" nếu còn dư.
    for (const tileId of fileIds.slice(0, 6)) {
      let mediaSrc = '';
      let isVideo = false;

      // Try DOM first — ưu tiên <video> trước (video tiles có cả <img> ref lẫn <video> result)
      const tile = document.querySelector(`[data-tile-id="${tileId}"]`);
      if (tile) {
        const videoEl = tile.querySelector('video');
        if (videoEl?.src) {
          mediaSrc = videoEl.src;
          isVideo = true;
        } else {
          const imgEl = tile.querySelector('img');
          if (imgEl?.src) {
            mediaSrc = imgEl.src;
            isVideo = false;
          }
        }
      }

      // Fallback to cache — track video_url separately (Bug 51 fix)
      let videoUrl = null;
      if (!mediaSrc && this._tileCache.has(tileId)) {
        const cached = this._tileCache.get(tileId);
        mediaSrc = cached.thumbnail;
        isVideo = cached.type === 'video';
        videoUrl = cached.video_url || null;
      }

      // Fallback to pendingUploadFiles (local uploads chưa gửi lên Flow)
      if (!mediaSrc && window.pendingUploadFiles?.has(tileId)) {
        const pending = window.pendingUploadFiles.get(tileId);
        if (pending?.thumbnail) mediaSrc = pending.thumbnail;
      }

      // Fallback to uploaded thumbnail cache (thumbnail transferred after upload_xxx → fe_xxx)
      if (!mediaSrc && window._uploadedThumbnailCache?.has(tileId)) {
        mediaSrc = window._uploadedThumbnailCache.get(tileId);
      }

      if (!mediaSrc) continue;

      foundCount++;
      // 2026-05-25: persist FULL metadata cho video tiles (type + video_url) — không chỉ URL string.
      // Trước fix: foundThumbs[id] = URL → next load cache type='image' (fallback) → render <img> thay vì <video>
      // → user thấy ảnh tĩnh thay vì video play → onerror chưa fire (img URL hợp lệ) → ko rescan.
      // Sau fix: video tiles save dạng {thumbnail, type:'video', video_url} → next load render đúng video.
      foundThumbs[tileId] = isVideo
        ? { thumbnail: mediaSrc, type: 'video', ...(videoUrl && { video_url: videoUrl }) }
        : mediaSrc;
      const thumb = document.createElement('div');
      thumb.className = 'df-preview-thumb';
      // 2026-05-25: Metadata cho click → mở media viewer modal (event delegation handler).
      thumb.dataset.mediaType = isVideo ? 'video' : 'image';
      thumb.dataset.mediaSrc = isVideo ? (videoUrl || mediaSrc) : mediaSrc;
      if (isVideo && mediaSrc && videoUrl && videoUrl !== mediaSrc) {
        thumb.dataset.mediaPoster = mediaSrc;
      }

      // v1.1 paste image feature: spinner overlay khi tileId là tempId đang upload.
      // ImmediateUploader._uploading có entry khi upload chạy → isUploading=true.
      // Khi upload xong, eventBus.emit('upload:completed') sẽ trigger re-render
      // node preview (xem `_bindWorkflowUploadListeners`) → spinner biến mất + thay
      // ID upload_xxx → flow_xxx.
      if (typeof tileId === 'string' && tileId.startsWith('upload_')) {
        if (window.ImmediateUploader?.isUploading?.(tileId)) {
          thumb.classList.add('df-preview-thumb--uploading');
        } else if (this._failedPasteUploadKeys?.has(tileId)) {
          thumb.classList.add('df-preview-thumb--upload-failed');
        }
      }

      if (isVideo) {
        const vid = document.createElement('video');
        // Bug 51 fix: Use video_url for playback, fallback to mediaSrc (thumbnail) if not available
        vid.src = videoUrl || mediaSrc;
        vid.muted = true;
        vid.loop = true;
        vid.autoplay = true;
        vid.playsInline = true;
        // 2026-05-25: video element cũng cần onerror để trigger CDN rescan khi expired
        // (mirror logic <img> bên dưới). Trước fix: video silent fail → preview blank,
        // user nghĩ "ko scan". Sau fix: video error → activate Flow tab → rescan URL mới.
        vid.onerror = () => {
          if (previewContainer._expiredRefreshed) return;
          previewContainer._expiredRefreshed = true;
          this._tileCache.delete(tileId);
          this._refreshExpiredNodeThumbnail(previewContainer, fileIds);
        };
        // Thêm poster fallback (thumbnail) khi video chưa load — UX tốt hơn blank
        if (videoUrl && mediaSrc && videoUrl !== mediaSrc) {
          vid.poster = mediaSrc;
        }
        // Bug fix 2026-05-28: video load → kích thước box đổi (aspect video) → port di chuyển.
        // Reposition connections (mirror img.onload bên dưới). Trước: video chỉ có onerror → node
        // gen video xong, box resize nhưng link KHÔNG correct lại port (lệch). loadedmetadata = đã
        // biết dimensions; loadeddata = frame đầu render.
        vid.onloadedmetadata = () => { this._scheduleConnectionRefresh(); };
        vid.onloadeddata = () => { this._scheduleConnectionRefresh(); };
        thumb.appendChild(vid);
      } else {
        const img = document.createElement('img');
        img.src = mediaSrc;
        img.alt = 'result';
        // Detect expired thumbnail URL → re-scan Flow (max 1 lần per preview)
        img.onerror = () => {
          if (previewContainer._expiredRefreshed) return;
          previewContainer._expiredRefreshed = true;
          this._tileCache.delete(tileId);
          this._refreshExpiredNodeThumbnail(previewContainer, fileIds);
        };
        // Image load → node size có thể đổi (image node fit content). Schedule
        // connection refresh để Drawflow re-route SVG paths → port end-points
        // không bị lệch (đặc biệt image node ratio portrait/landscape khác nhau).
        img.onload = () => {
          this._scheduleConnectionRefresh();
        };
        thumb.appendChild(img);
      }

      this._attachThumbZoom(thumb);
      previewContainer.appendChild(thumb);
      lastThumb = thumb;
    }

    // Overlay "+N" gắn TRỰC TIẾP lên ảnh thứ 6 (thumb cuối) khi tổng > 6 ảnh —
    // thay vì box rỗng riêng. Đẹp + gọn hơn: vẫn thấy ảnh thứ 6 mờ dưới badge "+N".
    if (fileIds.length > 6 && lastThumb) {
      const moreOverlay = document.createElement('div');
      moreOverlay.className = 'df-preview-more-overlay';
      moreOverlay.textContent = `+${fileIds.length - 6}`;
      lastThumb.appendChild(moreOverlay);
    }

    // Persist thumbnail URLs into Drawflow node data for restore after reload
    if (foundCount > 0 && previewContainer._nodeId) {
      this._persistNodeThumbnails(previewContainer._nodeId, foundThumbs);
      // Sync rendered preview HTML back into Drawflow internal data
      this._syncNodeHTMLToDrawflow(previewContainer._nodeId);
      // Deferred auto-save: thumbnails were persisted AFTER the initial saveWorkflow()
      this._deferredThumbnailSave();
    }

    // Retry nếu chưa tìm thấy media nào (tiles chưa render xong)
    if (foundCount === 0 && attempt < maxAttempts) {
      previewContainer._retryTimer = setTimeout(() => {
        previewContainer._retryTimer = null;
        this._renderNodePreviewWithRetry(previewContainer, fileIds, attempt + 1);
      }, delay);
    } else {
      // Release lock height khi tất cả media đã load (hoặc nếu foundCount=0 + hết retry).
      this._releaseLockWhenMediaReady(previewContainer);
    }
  }

  /**
   * Persist thumbnail URLs into Drawflow node data for restore after reload
   */
  _persistNodeThumbnails(nodeId, thumbMap) {
    if (!nodeId || !thumbMap || Object.keys(thumbMap).length === 0) return;
    const drawflowId = this._findDrawflowId(nodeId);
    if (!drawflowId) return;
    const node = this.diagramCanvas?.editor?.getNodeFromId(drawflowId);
    if (!node?.data) return;
    // Merge with existing thumbnails
    const existing = node.data.result_thumbnails || {};
    node.data.result_thumbnails = { ...existing, ...thumbMap };
    this.diagramCanvas.editor.updateNodeDataFromId(drawflowId, node.data);
  }

  /**
   * Persist file_names (persistent UUIDs from getMediaUrlRedirect) into Drawflow node data
   */
  _persistNodeFileNames(nodeId, fileNameMap) {
    if (!nodeId || !fileNameMap || Object.keys(fileNameMap).length === 0) return;
    const drawflowId = this._findDrawflowId(nodeId);
    if (!drawflowId) return;
    const node = this.diagramCanvas?.editor?.getNodeFromId(drawflowId);
    if (!node?.data) return;
    const existing = node.data.result_file_names || {};
    node.data.result_file_names = { ...existing, ...fileNameMap };
    this.diagramCanvas.editor.updateNodeDataFromId(drawflowId, node.data);
  }

  /**
   * Persist single file_name vào Drawflow node data (dùng bởi _backgroundThumbnailScan)
   */
  _persistSingleFileName(fileId, fileName) {
    if (!fileId || !fileName || !this.workflow?.nodes) return;
    for (const node of this.workflow.nodes) {
      const resultIds = (node.result_file_ids || '').split(',').filter(Boolean);
      if (resultIds.includes(fileId)) {
        this._persistNodeFileNames(node.node_id, { [fileId]: fileName });
        return;
      }
    }
  }

  /**
   * Persist ref thumbnail URLs into Drawflow node data (separate from result thumbnails)
   */
  _persistRefThumbnailsMap(nodeId, thumbMap) {
    if (!nodeId || !thumbMap || Object.keys(thumbMap).length === 0) return;
    const drawflowId = this._findDrawflowId(nodeId);
    if (!drawflowId) return;
    const node = this.diagramCanvas?.editor?.getNodeFromId(drawflowId);
    if (!node?.data) return;
    const existing = node.data.ref_thumbnails || {};
    node.data.ref_thumbnails = { ...existing, ...thumbMap };
    this.diagramCanvas.editor.updateNodeDataFromId(drawflowId, node.data);
  }

  /**
   * Deferred auto-save: thumbnails are persisted async (after Flow scan),
   * so the initial saveWorkflow() in node:completed handler may miss them.
   * Debounce 2s to batch multiple thumbnail persists into one save.
   */
  _deferredThumbnailSave() {
    if (this._skipDeferredSave) return;
    // Template mode: KHÔNG deferred save vì workflow chưa tồn tại trong DB
    if (this.isTemplateMode) {
      this._hasUnsavedChanges = true;
      return;
    }
    if (this._deferredSaveTimer) clearTimeout(this._deferredSaveTimer);
    this._deferredSaveTimer = setTimeout(() => {
      this._deferredSaveTimer = null;
      this.saveWorkflow()
        .catch(err => console.warn('[TobyFlow] Deferred thumbnail save failed:', err))
        .finally(() => this._updatePlayButtonState());
    }, 2000);
    // Disable play button while deferred save is pending
    this._updatePlayButtonState();
  }

  /**
   * Persist ref image thumbnails AND file_names (UUIDs) into node data so they survive browser reload
   * Phase R fix: ref_file_names enables 5-tier correction for ref images (same as result images)
   */
  _persistRefThumbnails(drawflowId, nodeData) {
    if (!nodeData?.ref_file_ids || !this.diagramCanvas?.editor) return;
    const refIds = nodeData.ref_file_ids.split(',').map(s => s.trim()).filter(Boolean);
    if (refIds.length === 0) return;

    const thumbMap = {};
    const fileNameMap = {}; // NEW: capture UUIDs for 5-tier correction

    for (const fileId of refIds) {
      // Try DOM tiles — Flow phân biệt video/image qua ELEMENT (<video> vs <img>),
      // URL `getMediaUrlRedirect` giống nhau cả 2. Check <video> TRƯỚC để detect type.
      const tile = document.querySelector(`[data-tile-id="${fileId}"]`);
      if (tile) {
        const video = tile.querySelector('video');
        const img = tile.querySelector('img');
        if (video?.src) {
          // Video tile → save object {thumbnail, type:'video', video_url} cho reload restore
          thumbMap[fileId] = {
            thumbnail: video.poster || img?.src || video.src,
            type: 'video',
            video_url: video.src,
          };
        } else if (img?.src) {
          thumbMap[fileId] = img.src; // Image: plain URL (backward compat)
        }
      }
      // Try _tileCache (may have file_name + type + video_url từ scan trước)
      if (this._tileCache.has(fileId)) {
        const cached = this._tileCache.get(fileId);
        if (!thumbMap[fileId]) {
          if (cached.type === 'video' && (cached.thumbnail || cached.video_url)) {
            thumbMap[fileId] = {
              thumbnail: cached.thumbnail || '',
              type: 'video',
              ...(cached.video_url && { video_url: cached.video_url }),
            };
          } else if (cached.thumbnail) {
            thumbMap[fileId] = cached.thumbnail;
          }
        }
        if (cached.file_name) fileNameMap[fileId] = cached.file_name;
      }
      // Try pendingUploadFiles
      if (window.pendingUploadFiles?.has(fileId)) {
        const pending = window.pendingUploadFiles.get(fileId);
        if (pending?.thumbnail && !thumbMap[fileId]) thumbMap[fileId] = pending.thumbnail;
      }
      // Try uploaded thumbnail cache (after upload_xxx → fe_xxx conversion)
      if (window._uploadedThumbnailCache?.has(fileId) && !thumbMap[fileId]) {
        thumbMap[fileId] = window._uploadedThumbnailCache.get(fileId);
      }
    }

    const node = this.diagramCanvas.editor.getNodeFromId(drawflowId);
    if (!node?.data) return;

    // Persist thumbnails — REPLACE (chỉ giữ entries khớp ref_file_ids hiện tại)
    // Merge old entries CHỈ cho IDs vẫn còn trong refIds, xóa stale entries
    const refIdSet = new Set(refIds);
    const cleanedThumbs = {};
    const cleanedFileNames = {};
    // Keep existing entries CHỈ cho IDs còn trong ref_file_ids
    for (const [id, url] of Object.entries(node.data.ref_thumbnails || {})) {
      if (refIdSet.has(id)) cleanedThumbs[id] = url;
    }
    for (const [id, fn] of Object.entries(node.data.ref_file_names || {})) {
      if (refIdSet.has(id)) cleanedFileNames[id] = fn;
    }
    // Override with new data
    node.data.ref_thumbnails = { ...cleanedThumbs, ...thumbMap };
    node.data.ref_file_names = { ...cleanedFileNames, ...fileNameMap };

    this.diagramCanvas.editor.updateNodeDataFromId(drawflowId, node.data);

    // Also cache for current session — preserve type/video_url khi value là object
    for (const [fid, val] of Object.entries(thumbMap)) {
      if (this._tileCache.has(fid)) continue;
      if (val && typeof val === 'object') {
        this._tileCacheSet(fid, {
          thumbnail: val.thumbnail || '',
          type: val.type || 'image',
          ...(val.video_url && { video_url: val.video_url }),
        });
      } else {
        this._tileCacheSet(fid, { thumbnail: val, type: 'image' });
      }
    }

    // Async: scan for file_names via MessageBridge if not already cached
    this._scanRefFileNames(refIds, drawflowId);
  }

  /**
   * Scan ref images for file_names (UUIDs) via MessageBridge
   * This enables Tầng 1 correction (file_name → new tile_id)
   */
  async _scanRefFileNames(refIds, drawflowId) {
    if (!refIds?.length || !drawflowId) return;
    const idsToScan = refIds.filter(id => {
      if (id.startsWith('upload_')) return false;
      const cached = this._tileCache.get(id);
      return !cached?.file_name; // Only scan if file_name not cached
    });
    if (idsToScan.length === 0) return;

    try {
      if (typeof MessageBridge === 'undefined') return;
      const scanResult = await MessageBridge.getThumbnailsByIds(idsToScan);
      const results = scanResult?.results || {};
      const fileNameMap = {};

      for (const [fid, info] of Object.entries(results)) {
        if (info?.file_name) {
          fileNameMap[fid] = info.file_name;
          // Update cache
          const cached = this._tileCache.get(fid) || {};
          this._tileCacheSet(fid, { ...cached, file_name: info.file_name });
        }
      }

      if (Object.keys(fileNameMap).length > 0) {
        this._persistRefFileNames(drawflowId, fileNameMap);
        this._deferredThumbnailSave();
      }
    } catch (e) {
      console.warn('[TobyFlow] _scanRefFileNames error:', e);
    }
  }

  /**
   * Persist ref_file_names (UUIDs) into Drawflow node data
   */
  _persistRefFileNames(drawflowId, fileNameMap) {
    if (!drawflowId || !fileNameMap || Object.keys(fileNameMap).length === 0) return;
    const node = this.diagramCanvas?.editor?.getNodeFromId(drawflowId);
    if (!node?.data) return;
    node.data.ref_file_names = { ...(node.data.ref_file_names || {}), ...fileNameMap };
    this.diagramCanvas.editor.updateNodeDataFromId(drawflowId, node.data);
  }

  /**
   * Proactive blob caching cho workflow nodes — fetch ref image blobs
   * và cache vào PendingUploadStore để reuploadMissingFiles Tầng 1-2
   * có thể recover khi image bị xóa khỏi Flow.
   * Fire-and-forget, không block UI.
   */
  async _cacheNodeRefImageBlobs(nodeData) {
    if (!window.PendingUploadStore || !nodeData?.ref_file_ids) return;
    const refIds = (nodeData.ref_file_ids || '').split(',').map(s => s.trim()).filter(Boolean);
    if (refIds.length === 0) return;

    const thumbs = nodeData.ref_thumbnails || {};
    for (const id of refIds) {
      // Skip nếu đã có trong uploadedFileCache (đã cache từ upload gần đây)
      if (window.uploadedFileCache?.has(id)) continue;
      // Skip upload_ keys (chưa upload xong)
      if (id.startsWith('upload_')) continue;

      const thumbUrl = thumbs[id] || this._tileCache?.get(id)?.thumbnail || window.MediaRegistry?.getThumb(id);
      if (!thumbUrl || typeof thumbUrl !== 'string' || !thumbUrl.startsWith('http')) continue;

      try {
        const fetchUrl = thumbUrl.includes('lh3.') || thumbUrl.includes('googleusercontent.com')
          ? thumbUrl.split('=')[0]
          : thumbUrl;

        let resp;
        const _mp = window._getMediaUrlPattern?.() || 'getMediaUrlRedirect';
        if (fetchUrl.includes(_mp)) {
          resp = await window.MessageBridge?.sendToContentScript('fetchImageAsBase64', { url: fetchUrl });
          if (!resp?.success) {
            resp = await new Promise((resolve, reject) => {
              chrome.runtime.sendMessage({ action: 'fetchBlob', url: fetchUrl, expectImage: true }, (r) => {
                if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
                resolve(r);
              });
            });
          }
        } else {
          resp = await new Promise((resolve, reject) => {
            chrome.runtime.sendMessage({ action: 'fetchBlob', url: fetchUrl, expectImage: true }, (r) => {
              if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
              resolve(r);
            });
          });
        }

        if (resp?.success && resp.base64) {
          const binary = atob(resp.base64);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          const contentType = resp.contentType || 'image/png';
          const blob = new Blob([bytes], { type: contentType });
          const file = new File([blob], `ref_${id.substring(0, 8)}.png`, { type: contentType });
          await PendingUploadStore.cacheUploaded(id, file);
          console.log(`[TobyFlow] Proactive cached blob cho ref ${id.substring(0, 8)}`);
        }
      } catch (e) {
        // Không block — fire-and-forget
        console.warn(`[TobyFlow] Failed to cache blob cho ref ${id.substring(0, 8)}:`, e.message);
      }
    }
  }

  /**
   * Sync current DOM of a node back into Drawflow's internal HTML
   * so that the visual state persists without needing to reload the editor
   */
  _syncNodeHTMLToDrawflow(nodeId) {
    if (!nodeId || !this.diagramCanvas?.editor) return;
    const drawflowId = this._findDrawflowId(nodeId);
    if (!drawflowId) return;
    const nodeEl = this.overlay?.querySelector(`#node-${drawflowId} .drawflow_content_node`);
    if (!nodeEl) return;
    const homeData = this.diagramCanvas.editor.drawflow?.drawflow?.Home?.data;
    if (homeData?.[drawflowId]) {
      homeData[drawflowId].html = nodeEl.innerHTML;
    }
  }

  /**
   * Re-scan Flow khi thumbnail URL expired (onerror)
   * Debounce để gộp nhiều expired thành 1 lần scan
   */
  /**
   * Refresh thumbnails khi img.onerror fires (CDN URL expired — signature TTL).
   * Flow:
   *   1. Activate Flow tab (browser focus) → background tab có thể bị suspend lazy images
   *   2. prepareFlowForScan → ensureFlowTilesLoaded trên content script
   *   3. getThumbnailsByIds → fetch URL mới (signature fresh)
   *   4. Re-render preview với URLs mới
   * Debounce 500ms để gộp multiple img.onerror cùng node.
   */
  _refreshExpiredNodeThumbnail(previewContainer, fileIds) {
    if (this._expiredNodeTimer) clearTimeout(this._expiredNodeTimer);
    this._expiredNodeTimer = setTimeout(async () => {
      if (typeof MessageBridge === 'undefined') return;
      const expiredIds = fileIds.filter(id => !id.startsWith('upload_'));
      if (expiredIds.length === 0) return;

      try {
        // 1. Activate Flow tab — chỉ thực hiện 1 lần per editor session (tránh steal focus liên tục)
        if (!this._flowTabActivatedForScan) {
          this._flowTabActivatedForScan = true;
          try {
            await new Promise((resolve) => {
              chrome.runtime.sendMessage({ action: 'ensureFlowTabActive' }, () => resolve());
            });
          } catch (e) { /* best-effort */ }
        }
        // 2. Ensure tiles loaded trên Flow DOM
        if (MessageBridge.prepareFlowForScan) {
          await MessageBridge.prepareFlowForScan().catch(() => {});
        }
        // 3. Rescan thumbnails
        const result = await MessageBridge.getThumbnailsByIds(expiredIds);
        const results = result?.results || {};
        let refreshed = 0;
        for (const [fid, info] of Object.entries(results)) {
          if (info?.thumbnail) {
            // 2026-05-25: preserve video_url để video element render đúng src (không fallback về thumbnail).
            // Trước fix: drop video_url → cache type='video' nhưng videoUrl=null → vid.src = thumbnail (image URL)
            // → video không play được → render blank.
            this._tileCacheSet(fid, {
              thumbnail: info.thumbnail,
              type: info.type || 'image',
              ...(info.video_url && { video_url: info.video_url }),
              ...(info.file_name && { file_name: info.file_name }),
            });
            refreshed++;
          }
        }
        if (refreshed > 0) {
          console.log('[WorkflowEditor] Refreshed', refreshed, 'expired thumbnails via Flow tab activation');
          // 4. Re-render preview với URLs mới
          this._renderNodePreviewInner(previewContainer, fileIds, 0);
          // Persist thumbnails về backend để lần sau load không expire
          this._deferredThumbnailSave?.();
        }
      } catch (err) {
        console.warn('[WorkflowEditor] _refreshExpiredNodeThumbnail failed:', err?.message);
      }
    }, 500);
  }

  /**
   * Sync execution status/results back into Drawflow node data
   * so that showNodeForm reads up-to-date data
   */
  _syncDrawflowNodeData(nodeId, updates) {
    if (!nodeId || !this.diagramCanvas?.editor) {
      console.warn(`[WorkflowEditor] _syncDrawflowNodeData: early return - nodeId=${nodeId}, editor=${!!this.diagramCanvas?.editor}`);
      return;
    }
    const drawflowId = this._findDrawflowId(nodeId);
    if (!drawflowId) {
      console.warn(`[WorkflowEditor] _syncDrawflowNodeData: drawflowId not found for nodeId=${nodeId}`);
      return;
    }
    const node = this.diagramCanvas.editor.getNodeFromId(drawflowId);
    if (!node?.data) {
      console.warn(`[WorkflowEditor] _syncDrawflowNodeData: node.data not found for drawflowId=${drawflowId}`);
      return;
    }
    console.log(`[WorkflowEditor] _syncDrawflowNodeData: nodeId=${nodeId}, updates=`, Object.keys(updates));
    Object.assign(node.data, updates);
    this.diagramCanvas.editor.updateNodeDataFromId(drawflowId, node.data);
  }

  /**
   * Show/hide download button in hover toolbar for a node
   */
  _updateHoverToolbarDownload(nodeId, fileIds) {
    if (!nodeId || !fileIds?.length) return;
    const drawflowId = this._findDrawflowId(nodeId);
    if (!drawflowId) return;
    const nodeEl = this.overlay?.querySelector(`#node-${drawflowId}`);
    if (!nodeEl) return;
    // Add download button to hover toolbar if not present
    const toolbar = nodeEl.querySelector('.df-hover-toolbar');
    if (!toolbar || toolbar.querySelector('[data-action="download-node"]')) return;
    const dlBtn = document.createElement('button');
    dlBtn.className = 'df-hover-btn';
    dlBtn.dataset.action = 'download-node';
    const dlLabel = window.I18n?.t('workflow.downloadResults') || 'Tải kết quả';
    dlBtn.title = dlLabel;
    dlBtn.dataset.tooltip = dlLabel;
    dlBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;
    // Insert before delete button
    const deleteBtn = toolbar.querySelector('[data-action="delete-node"]');
    if (deleteBtn) {
      toolbar.insertBefore(dlBtn, deleteBtn);
    } else {
      toolbar.appendChild(dlBtn);
    }
  }

  _findDrawflowId(nodeId) {
    if (!this.diagramCanvas?.editor) return null;
    if (!nodeId) return null;
    const homeData = this.diagramCanvas.editor.drawflow?.drawflow?.Home?.data || {};

    // If nodeId is already a drawflowId (exists as key), return it directly
    const nodeIdStr = String(nodeId);
    if (homeData[nodeIdStr]) return nodeIdStr;

    // Otherwise search by node_id field
    for (const [id, node] of Object.entries(homeData)) {
      if (node.data?.node_id === nodeId) return id;
    }
    return null;
  }

  /**
   * Check node có prompt để chạy không.
   * Nếu có upstream Prompt node connected thì ok (executor sẽ lấy prompt từ đó).
   * Nếu không có upstream thì check prompt trong node data.
   * @returns {{ ok: boolean, message?: string }}
   */
  _checkNodeHasPrompt(drawflowId, nodeData) {
    const data = nodeData?.data || {};
    const nodeName = data.node_name || 'Node';

    // 2026-05-31 fix: bug "Node X has no prompt" khi gen/chatgpt/grok có upstream là text_extract
    // (hoặc text). Trước fix: chỉ chấp nhận upstream type='prompt' → text_extract/text bị skip
    // → validation report no prompt dù chain hợp lệ (text_extract output = prompt source).
    //
    // Text-producing nodes (đều có thể serve as prompt source qua mention/auto-detect):
    //   - prompt (AI Agent): result_text từ ChatGPT/Gemini hoặc plain
    //   - text: static text content
    //   - text_extract: regex/JSON parse output từ upstream text
    //   - chatgpt/grok: result_text (AI response) — đôi khi user output text rồi feed gen
    const TEXT_SOURCE_TYPES = ['prompt', 'text', 'text_extract', 'chatgpt', 'grok'];
    let hasUpstreamTextSource = false;
    const node = this.diagramCanvas?.editor?.getNodeFromId(drawflowId);
    if (node) {
      const allInputKeys = Object.keys(node.inputs || {});
      for (const inputKey of allInputKeys) {
        const conns = node.inputs?.[inputKey]?.connections || [];
        for (const conn of conns) {
          const srcNode = this.diagramCanvas.editor.getNodeFromId(conn.node);
          const srcType = srcNode?.data?.node_type || srcNode?.class;
          if (TEXT_SOURCE_TYPES.includes(srcType)) {
            hasUpstreamTextSource = true;
            break;
          }
        }
        if (hasUpstreamTextSource) break;
      }
    }

    // Có upstream text source thì ok (executor sẽ resolve text từ upstream)
    if (hasUpstreamTextSource) {
      return { ok: true };
    }

    // Không có upstream: check prompt trong node data
    const prompt = data.prompt;
    if (!prompt || !prompt.trim()) {
      const msg = window.I18n?.t('workflow.nodeNoPrompt', { name: nodeName })
        || `Node "${nodeName}" chưa có prompt.`;
      return { ok: false, message: msg };
    }
    return { ok: true };
  }

  _getNodeNameById(nodeId) {
    if (!nodeId) return '';
    const drawflowId = this._findDrawflowId(nodeId);
    if (!drawflowId) return '';
    const nodeEl = this.overlay?.querySelector(`#node-${drawflowId}`);
    return nodeEl?.querySelector('.df-node-title')?.textContent || '';
  }

  _getAllNodeData() {
    if (!this.diagramCanvas?.editor) return [];
    const homeData = this.diagramCanvas.editor.drawflow?.drawflow?.Home?.data || {};
    return Object.values(homeData).map(n => n.data).filter(Boolean);
  }

  async _checkRefFilesExist(nodeDataList) {
    if (!nodeDataList?.length || typeof MessageBridge === 'undefined') return null;

    // Collect all ref_file_ids from enabled nodes
    const nodesWithRefs = [];
    for (const data of nodeDataList) {
      if (!data || data.enabled === false) continue;
      const refStr = data.ref_file_ids || '';
      if (!refStr) continue;
      const ids = refStr.split(',').map(s => s.trim()).filter(s => s && !s.startsWith('upload_'));
      if (ids.length > 0) {
        nodesWithRefs.push({ data, ids });
      }
    }

    if (nodesWithRefs.length === 0) return null;

    const allRefIds = [];
    const nodeNames = {};
    for (const { data, ids } of nodesWithRefs) {
      for (const id of ids) {
        allRefIds.push(id);
        nodeNames[id] = data.node_name || data.node_type || '';
      }
    }

    try {
      const result = await MessageBridge.checkTilesExist([...new Set(allRefIds)]);
      const missing = result?.missing || [];
      if (missing.length === 0) return null;

      // Thử reupload missing files trước khi báo lỗi
      // (giống logic Tier 5 trong WorkflowExecutor)
      if (typeof window.reuploadMissingFiles === 'function') {
        console.log(`[WorkflowEditor] ${missing.length} ref(s) missing, attempting reupload...`);

        for (const { data } of nodesWithRefs) {
          const refStr = data.ref_file_ids || '';
          if (!refStr) continue;

          // Build thumbnail map trực tiếp từ node data — không phụ thuộc GenTab
          const thumbMap = data.ref_thumbnails || {};
          console.log('[WorkflowEditor] ref_thumbnails for reupload:', JSON.stringify(thumbMap));

          // CRITICAL: Truyền file_names map để reuploadMissingFiles có thể check file_name trước (tránh reupload không cần thiết)
          const fileNamesMap = data.ref_file_names || {};

          const oldIds = refStr.split(',').map(s => s.trim()).filter(Boolean);
          const updated = await window.reuploadMissingFiles(refStr, thumbMap, null, fileNamesMap);
          const updatedIds = (updated || '').split(',').map(s => s.trim()).filter(Boolean);
          console.log('[WorkflowEditor] reuploadMissingFiles result:', updated, 'updatedIds:', updatedIds, 'changed:', updated !== refStr);
          if (updated !== refStr && updatedIds.length > 0) {
            console.log(`[WorkflowEditor] Reupload success for node "${data.node_name || data.node_type}": ${updated.substring(0, 60)}...`);
            data.ref_file_ids = updated;

            // Cập nhật ref_thumbnails + ref_file_names + _tileCache với NEW data
            const newIds = updated.split(',').map(s => s.trim()).filter(Boolean);
            if (!data.ref_thumbnails) data.ref_thumbnails = {};
            if (!data.ref_file_names) data.ref_file_names = {};
            for (let i = 0; i < oldIds.length && i < newIds.length; i++) {
              if (oldIds[i] !== newIds[i]) {
                // Transfer old thumbnails/file_names sang new key
                if (data.ref_thumbnails[oldIds[i]]) {
                  data.ref_thumbnails[newIds[i]] = data.ref_thumbnails[oldIds[i]];
                  delete data.ref_thumbnails[oldIds[i]];
                }
                if (data.ref_file_names?.[oldIds[i]]) {
                  data.ref_file_names[newIds[i]] = data.ref_file_names[oldIds[i]];
                  delete data.ref_file_names[oldIds[i]];
                }
                // Cập nhật với NEW data từ reupload tileDetails hoặc GenTab fallback
                const reupDetails = window._lastReuploadTileDetails || {};
                const newThumb = reupDetails[newIds[i]]?.thumbnailUrl || MediaRegistry.getThumb(newIds[i]);
                if (newThumb) {
                  data.ref_thumbnails[newIds[i]] = newThumb;
                  const newFnForCache = reupDetails[newIds[i]]?.file_name || MediaRegistry.getFileName(newIds[i]) || null;
                  this._tileCacheSet(newIds[i], {
                    thumbnail: newThumb,
                    file_name: newFnForCache,
                    type: 'image',
                    _crossProject: false
                  });
                }
                const newFn = reupDetails[newIds[i]]?.file_name || MediaRegistry.getFileName(newIds[i]);
                if (newFn) data.ref_file_names[newIds[i]] = newFn;
              }
            }
          }
        }

        // Check lại sau reupload
        const updatedAllIds = [];
        for (const { data } of nodesWithRefs) {
          const ids = (data.ref_file_ids || '').split(',').map(s => s.trim()).filter(s => s && !s.startsWith('upload_'));
          for (const id of ids) {
            updatedAllIds.push(id);
            // Cập nhật nodeNames cho IDs mới
            if (!nodeNames[id]) nodeNames[id] = data.node_name || data.node_type || '';
          }
        }

        if (updatedAllIds.length > 0) {
          const recheck = await MessageBridge.checkTilesExist([...new Set(updatedAllIds)]);
          const stillMissing = recheck?.missing || [];
          if (stillMissing.length === 0) {
            console.log('[WorkflowEditor] All missing refs reuploaded successfully');
            return null; // Reupload thành công, cho phép chạy
          }

          // Vẫn còn missing sau reupload → báo lỗi
          const missingNodes = [...new Set(stillMissing.map(id => nodeNames[id]).filter(Boolean))];
          const nodeInfo = missingNodes.length > 0 ? ` (${missingNodes.join(', ')})` : '';
          return window.I18n?.t('workflow.refNotExist', { count: stillMissing.length, nodes: nodeInfo }) || `${stillMissing.length} ảnh tham chiếu không còn tồn tại trên Google Flow${nodeInfo}. Vui lòng kiểm tra và cập nhật lại ảnh.`;
        }

        return null;
      }

      // Không có reuploadMissingFiles → báo lỗi như cũ
      const missingNodes = [...new Set(missing.map(id => nodeNames[id]).filter(Boolean))];
      const nodeInfo = missingNodes.length > 0 ? ` (${missingNodes.join(', ')})` : '';
      return window.I18n?.t('workflow.refNotExist', { count: missing.length, nodes: nodeInfo }) || `${missing.length} ảnh tham chiếu không còn tồn tại trên Google Flow${nodeInfo}. Vui lòng kiểm tra và cập nhật lại ảnh.`;
    } catch (e) {
      console.warn('[TobyFlow] Check tiles exist failed:', e.message);
      return null;
    }
  }

  _updateProgressUI(data) {
    if (!this.overlay) return;
    const { total, completed } = data;
    const text = this.overlay.querySelector('#editorProgressText');
    const fill = this.overlay.querySelector('#editorProgressFill');
    if (text) text.textContent = `${completed} / ${total}`;
    if (fill) fill.style.width = `${total > 0 ? (completed / total) * 100 : 0}%`;

    // Also update DiagramCanvas progress
    this.diagramCanvas?.showProgress(completed, total);
  }

  _onExecutionStarted() {
    if (!this.overlay) return;

    // Add executing class để disable node palette và các nút copy/branch
    this.overlay.classList.add('wf-executing');

    const resetBtn = this.overlay.querySelector('#resetWorkflowInEditorBtn');
    const logPanel = this.overlay.querySelector('#executionLogPanel');

    resetBtn?.classList.add('hidden');
    // Phase: Default ẨN log panel khi workflow chạy — user click toggle button để mở khi cần xem.
    // Trước đây auto-show → chiếm không gian editor không cần thiết.
    logPanel?.classList.add('hidden');

    // Toggle toolbar play/stop buttons
    const toolbarPlayBtn = this.overlay.querySelector('.tobyflow-wf-tool-btn[data-action="run-workflow"]');
    const toolbarStopBtn = this.overlay.querySelector('.tobyflow-wf-tool-btn[data-action="stop-workflow"]');
    toolbarPlayBtn?.classList.add('hidden');
    toolbarStopBtn?.classList.remove('hidden');

    // Hide run & delete node buttons in sidebar during execution
    this.overlay.querySelector('#runSingleNodeBtn')?.classList.add('hidden');
    this.overlay.querySelector('#deleteNodeBtn')?.classList.add('hidden');

    // Hide hover toolbar run buttons on all nodes
    this.overlay.querySelectorAll('.df-hover-btn[data-action="run-node"]').forEach(b => b.classList.add('hidden'));
    this.overlay.querySelectorAll('.df-hover-btn[data-action="delete-node"]').forEach(b => b.classList.add('hidden'));

    // Disable save button during execution to prevent race conditions
    const saveBtn = this.overlay.querySelector('#saveWorkflowBtn');
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.classList.add('is-executing-locked');
    }

    // Clear old log
    const logBody = this.overlay.querySelector('#executionLogBody');
    if (logBody) logBody.innerHTML = '';

    // Disable node form inputs during execution (viewable but not editable)
    this._setNodeFormDisabled(true);

    // Notify other extension contexts
    try { chrome.runtime.sendMessage({ action: 'executionStatusUpdate', status: 'started' }); } catch(e) {}
  }

  async _onExecutionCompleted(data) {
    if (!this.overlay) return;

    // Remove executing class để enable node palette và các nút copy/branch
    this.overlay.classList.remove('wf-executing');

    this.diagramCanvas?.hideProgress();

    // Clear tất cả connection-active animations — đảm bảo không còn flowing dashed
    // sau khi execution end (kể cả khi stop abrupt, workflow error trước final status).
    try {
      this.overlay.querySelectorAll('svg.connection.connection-active')
        .forEach((conn) => conn.classList.remove('connection-active'));
    } catch (e) { /* ignore */ }

    if (data?.singleNode) {
      // Single node execution: always show Run button
      if (data?.error) {
        this._addLogEntry(window.I18n?.t('workflow.errorPrefix', { message: data.error.message }) || `Lỗi: ${data.error.message}`, 'error');
      } else {
        // Record usage for single node execution (success case)
        if (window.featureGate) {
          await window.featureGate.recordPendingWorkflowRun();
        }
      }
      this._showRunButton();
    } else if (data?.error) {
      this._addLogEntry(window.I18n?.t('workflow.errorPrefix', { message: data.error.message }) || `Lỗi: ${data.error.message}`, 'error');
      // Error: hiện cả Play + Reset (user có thể retry hoặc reset)
      this._showRunButton();
      this.overlay.querySelector('#resetWorkflowInEditorBtn')?.classList.remove('hidden');
    } else if (data?.stopped) {
      this._addLogEntry(window.I18n?.t('workflow.workflowStopped') || 'Workflow đã bị dừng.', 'warn');
      this._checkAndToggleRunResetButton();
    } else {
      // Record trial run usage AFTER workflow completes successfully
      if (window.featureGate) {
        await window.featureGate.recordPendingWorkflowRun();
      }
      this._addLogEntry(window.I18n?.t('workflow.workflowCompleted') || 'Workflow hoàn thành!', 'success');
      this._showResetButton();
    }

    // Re-enable node form inputs after execution
    this._setNodeFormDisabled(false);

    // Show run & delete node buttons again
    this.overlay.querySelector('#runSingleNodeBtn')?.classList.remove('hidden');
    this.overlay.querySelector('#deleteNodeBtn')?.classList.remove('hidden');
    this._updateResetSingleNodeButton();

    // Show hover toolbar run & delete buttons on all nodes
    this.overlay.querySelectorAll('.df-hover-btn[data-action="run-node"]').forEach(b => b.classList.remove('hidden'));
    this.overlay.querySelectorAll('.df-hover-btn[data-action="delete-node"]').forEach(b => b.classList.remove('hidden'));

    // Toggle toolbar play/stop buttons
    const toolbarPlayBtn = this.overlay.querySelector('.tobyflow-wf-tool-btn[data-action="run-workflow"]');
    const toolbarStopBtn = this.overlay.querySelector('.tobyflow-wf-tool-btn[data-action="stop-workflow"]');
    toolbarPlayBtn?.classList.remove('hidden');
    toolbarStopBtn?.classList.add('hidden');

    // Re-enable save button after execution
    const saveBtn = this.overlay.querySelector('#saveWorkflowBtn');
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.classList.remove('is-executing-locked');
    }

    // Update quota display after execution
    this._updateQuotaDisplay();

    // Notify other extension contexts
    try { chrome.runtime.sendMessage({ action: 'executionStatusUpdate', status: 'completed' }); } catch(e) {}
  }

  _setNodeFormDisabled(disabled) {
    const body = this.overlay?.querySelector('#nodeFormBody');
    const footer = this.overlay?.querySelector('#nodeFormFooter');
    if (!body && !footer) return;
    // Only disable form body inputs + footer, NOT header buttons or tab buttons
    const containers = [body, footer].filter(Boolean);
    containers.forEach(c => {
      c.querySelectorAll('input, select, textarea, button').forEach(el => {
        if (disabled) {
          el.dataset.wasDisabled = el.disabled;
          el.disabled = true;
        } else {
          el.disabled = el.dataset.wasDisabled === 'true';
          delete el.dataset.wasDisabled;
        }
      });
    });
  }

  /**
   * Disable/enable form khi node đang running được chọn
   */
  _disableFormIfSelectedNode(nodeId, disabled) {
    if (!this.selectedNodeId || !nodeId) return;
    const drawflowId = this._findDrawflowId(nodeId);
    if (String(drawflowId) !== String(this.selectedNodeId)) return;
    this._setNodeFormDisabled(disabled);
  }

  /**
   * Force stop thực thi (workflow đầy đủ HOẶC single node) — đồng bộ với ExecutionTracker._handleStop.
   * Bug fix 2026-05-27: stop() graceful chờ submitted node → single-node gen không dừng từ toolbar.
   * Force: cancel TẤT CẢ token + gửi stopExecution VÔ ĐIỀU KIỆN (break Flow waitForNewTiles) +
   * isRunning=false + clear cross-context. Sau đó reset UI toolbar về idle (phòng executor await stuck).
   */
  _forceStopExecution() {
    const exec = window.workflowExecutor;
    // K.14 (2026-05-29): Capture wfId TRƯỚC khi reset exec state — sau line `exec.isRunning=false`
    // currentWorkflow có thể bị clear → mất context cho broadcast cross-context.
    const stopWfId = exec?.currentWorkflow?.wf_id || this.workflow?.wf_id || null;
    try {
      // Graceful parts trước (PromptQueue stopJob, per-token cancel, Grok abort) khi isRunning còn true.
      if (exec?.isRunning) { try { exec.stop(); } catch (_) {} }
      // Force parts.
      if (exec) {
        exec.shouldStop = true;
        exec.isRunning = false;
      }
      window.ExecutionGate?.cancelAll?.().catch?.(() => {});
      window.MessageBridge?.stopExecution?.().catch?.(() => {}); // vô điều kiện → break content script wait
      window.WorkflowExecutor?.clearCrossContextRunning?.();
      window.eventBus?.emit('execution:force_stopped');
      // K.14 (2026-05-29): ALWAYS broadcast cross-context execution:stop (regardless of isRunning).
      // Bug: trước fix chỉ rely on `exec.stop()` để broadcast (line 2267 WorkflowExecutor). Nếu
      // race condition khiến `exec.isRunning=false` khi click stop → skip exec.stop() → KHÔNG
      // broadcast → sidebar không update card running state.
      if (stopWfId) {
        try {
          chrome.runtime.sendMessage({
            action: 'workflowExecutionEvent',
            event: 'execution:stop',
            data: { wf_id: stopWfId },
          }).catch(() => {});
        } catch (_) { /* ignore */ }
      }
    } catch (e) {
      console.warn('[WorkflowEditor] _forceStopExecution error:', e?.message);
    }
    // Reset toolbar UI về idle (nếu executor await stuck → finally chưa chạy kịp).
    try {
      this.overlay?.querySelector('.tobyflow-wf-tool-btn[data-action="run-workflow"]')?.classList.remove('hidden');
      this.overlay?.querySelector('.tobyflow-wf-tool-btn[data-action="stop-workflow"]')?.classList.add('hidden');
      this.overlay?.querySelector('#runSingleNodeBtn')?.classList.remove('hidden');
      this.overlay?.querySelectorAll('.df-hover-btn[data-action="run-node"]').forEach(b => b.classList.remove('hidden'));
      this._setRunSingleNodeButton('run');
      this._addLogEntry?.(window.I18n?.t('workflow.forceStopped') || 'Đã dừng thực thi (force stop).', 'warn');
    } catch (_) { /* noop */ }
  }

  _setRunSingleNodeButton(mode) {
    const btn = this.overlay?.querySelector('#runSingleNodeBtn');
    if (!btn) return;
    if (mode === 'stop') {
      btn.title = window.I18n?.t('common.stop') || 'Dừng';
      btn.style.color = 'var(--destructive, #ef4444)';
      btn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="6" width="12" height="12"></rect></svg>`;
    } else {
      btn.title = window.I18n?.t('workflow.runThisNode') || 'Chạy node này';
      btn.style.color = 'var(--success, #22c55e)';
      btn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>`;
    }
  }

  /**
   * Download node files. User chọn source explicit qua 2 button:
   *   - source='original': chỉ download tiles có provider URL gốc (Grok/ChatGPT chất lượng 100%)
   *   - source='flow': download qua Flow tile (DownloadHelper modal cho single, loop cho multi)
   * Fallback: tile original fail (URL expired) → tự fallback Flow path trong `_downloadProviderTile`.
   */
  async _downloadNodeFiles({ source = 'original', nodeId = null } = {}) {
    // nodeId optional — hover toolbar truyền node cụ thể (không cần selected); form panel
    // không truyền → fallback selectedNodeId (node đang mở).
    const targetNodeId = nodeId || this.selectedNodeId;
    if (!targetNodeId || !this.diagramCanvas?.editor) return;
    const dfNode = this.diagramCanvas.editor.getNodeFromId(targetNodeId);
    const data = dfNode?.data;
    if (!data?.result_file_ids) return;
    const fileIds = data.result_file_ids.split(',').map(s => s.trim()).filter(Boolean);
    if (fileIds.length === 0) return;
    const label = data.prompt || data.node_name || 'flow';
    const fileNames = data.result_file_names || {};
    const providerUrls = data.result_provider_urls || {};

    // Detect video node → dùng video resolution
    const isVideo = data.media_type === 'Video' || data.gen_type === 'Video'
      || this._isNodeVideoFromCache(fileIds);
    const resolution = isVideo
      ? (data.video_download_resolution || '720p')
      : (data.download_resolution || '1k');

    if (source === 'original') {
      // Tải tiles có provider URL gốc (chatgpt/grok — chất lượng 100%, không re-encode).
      const providerTiles = fileIds.filter(id => providerUrls[id]?.url);
      if (providerTiles.length > 0) {
        const providers = [...new Set(providerTiles.map(id => providerUrls[id]?.provider).filter(Boolean))];
        const providerLabel = providers.join('/').toUpperCase();
        window.showNotification?.(`Đang tải ${providerTiles.length} bản gốc từ ${providerLabel}...`, 'info', 2000);
        console.log('[TobyFlow] Manual download (Original) — tiles:', providerTiles.length, providers);

        for (const fileId of providerTiles) {
          try {
            await this._downloadProviderTile(fileId, providerUrls[fileId], label, fileIds.indexOf(fileId) + 1, data, fileNames[fileId]);
          } catch (e) {
            console.warn('[TobyFlow] Provider download failed:', fileId, e);
          }
        }
        return;
      }
      // 2026-05-26 FIX (chatgpt "click không thấy download"): không có URL gốc provider khả dụng
      // (URL chưa lưu / hết hạn TTL / key lệch sau correct) → KHÔNG return im lặng nữa mà FALLBACK
      // xuống Flow tile download bên dưới. Ảnh chatgpt/grok đã bridge sang Flow tile → tải được
      // qua Flow menu. Trước fix: return → người dùng bấm không thấy gì.
      console.log('[TobyFlow] Manual download: no usable provider original → fallback Flow tile download');
    }

    // source='flow' HOẶC original-fallback — download qua Flow context menu / modal.
    window.showNotification?.(`Đang tải ${fileIds.length} file qua Google Flow...`, 'info', 2000);
    console.log('[TobyFlow] Manual download (Flow) — tiles:', fileIds.length);

    const wfName = this.workflow?.wf_name || null;

    // Single Flow file → show DownloadHelper modal cho user chọn resolution
    if (fileIds.length === 1 && typeof DownloadHelper !== 'undefined') {
      const fileId = fileIds[0];
      const fileName = fileNames[fileId] || null;
      const mediaType = isVideo || this._isTileVideo(fileId) ? 'video' : 'image';
      DownloadHelper.showModal({
        tileId: fileId,
        fileName: fileName,
        promptText: label,
        taskName: wfName,
        mediaType: mediaType
      });
      return;
    }

    // Nhiều Flow files → batch modal cho user chọn resolution 1 lần (áp cho tất cả).
    // 2026-05-26: manual download KHÔNG dựa download_resolution (chỉ tồn tại khi auto_download
    // bật) → LUÔN hỏi user qua modal, giống result tab single-file. Trước fix: loop dùng
    // download_resolution (unset → 1k) → không hỏi user.
    if (typeof DownloadHelper !== 'undefined' && DownloadHelper.showBatchModal) {
      DownloadHelper.showBatchModal({
        tileIds: fileIds,
        fileNames,
        promptText: label,
        taskName: wfName,
        mediaType: isVideo ? 'video' : 'image',
      });
      return;
    }

    // Fallback (DownloadHelper chưa load): tải theo resolution node config / global default
    for (const fileId of fileIds) {
      try {
        const fileName = fileNames[fileId] || null;
        if (typeof MessageBridge !== 'undefined') {
          await MessageBridge.downloadTileMedia(fileId, label, wfName, fileName, resolution);
        } else if (typeof downloadTileMedia === 'function') {
          await downloadTileMedia(fileId, label, wfName, fileName, resolution);
        }
      } catch (e) {
        console.warn('[TobyFlow] Download failed:', fileId, e);
      }
    }
  }

  /**
   * Tải tile từ URL provider gốc (Grok/ChatGPT) — chất lượng 100%, không re-encode.
   * 2026-05-26: tải TRỰC TIẾP CDN URL qua chrome.downloads — KHÔNG fetch qua tab provider.
   * Lý do: chrome.downloads.download bỏ qua CORS + tự dùng cookie jar / signed URL → KHÔNG
   * cần tab grok/chatgpt mở (tab_id lưu kèm bị stale sau reload — chính là lý do grok video
   * không tải được). Đặc biệt grok video = synthetic id (không có tile Flow) → đây là đường
   * tải DUY NHẤT. (Cũ: fetch qua tab → base64 → blob → vì dùng fetch() bị CORS nên phải chạy
   * trong tab; chrome.downloads không bị CORS nên bỏ được hết.)
   */
  async _downloadProviderTile(fileId, providerData, promptText, index, nodeData, fileName) {
    const { url, provider, media_type } = providerData;
    if (!url) {
      console.warn('[TobyFlow] _downloadProviderTile: missing url', { fileId, provider });
      return;
    }
    const ext = media_type === 'video' ? 'mp4' : 'png';

    try {
      // Build filename theo template settings (giống auto-download).
      // Single source of truth qua DownloadHelper.getSettings().
      const _dlSet = await window.DownloadHelper.getSettings();
      const folder = _dlSet.folder;
      const template = _dlSet.template;

      let filename = window.GenTab?._buildChatGPTFilename?.(
        template,
        window._currentProjectName || 'flow',
        promptText || '',
        1, index, '',
        this.workflow?.wf_name || null,
        folder
      ) || `${folder}/${(this.workflow?.wf_name || 'workflow').replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 30)}/${provider}-${Date.now()}-${index}.${ext}`;
      if (ext !== 'png' && filename.endsWith('.png')) {
        filename = filename.replace(/\.png$/i, `.${ext}`);
      }

      // Tải thẳng CDN URL — chrome.downloads tự xử lý cookie/signed URL, không cần tab.
      const dlResp = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: 'chromeDownload', url, filename }, (r) => resolve(r));
      });

      if (!dlResp?.success) {
        console.warn(`[TobyFlow] ${provider} direct download fail:`, dlResp?.error);
      } else {
        console.log(`[TobyFlow] ${provider} direct download OK:`, filename);
      }
    } catch (err) {
      console.error('[TobyFlow] _downloadProviderTile exception:', err);
    }
  }

  /** Check if any fileId in cache is video */
  _isNodeVideoFromCache(fileIds) {
    for (const fid of fileIds) {
      if (this._tileCache.has(fid) && this._tileCache.get(fid).type === 'video') return true;
    }
    return false;
  }

  /** Check single tile is video from cache */
  _isTileVideo(fileId) {
    return this._tileCache.has(fileId) && this._tileCache.get(fileId).type === 'video';
  }

  _updateDownloadButton() {
    const btn = this.overlay?.querySelector('#downloadNodeBtn');
    if (!btn) return;
    if (!this.selectedNodeId || !this.diagramCanvas?.editor) { btn.classList.add('hidden'); return; }
    // Get data from drawflow node (selectedNodeId is drawflow numeric ID)
    const dfNode = this.diagramCanvas.editor.getNodeFromId(this.selectedNodeId);
    const fileIds = (dfNode?.data?.result_file_ids || '').split(',').filter(Boolean);
    btn.classList.toggle('hidden', fileIds.length === 0);
  }

  _updateResetSingleNodeButton() {
    const headerBtn = this.overlay?.querySelector('#resetSingleNodeBtn');
    const footerBtn = this.overlay?.querySelector('#resetNodeFooterBtn');

    const hideAll = () => {
      headerBtn?.classList.add('hidden');
      footerBtn?.classList.add('hidden');
    };

    if (!this.selectedNodeId || !this.diagramCanvas?.editor) { hideAll(); return; }

    // Get data from Drawflow node (selectedNodeId is Drawflow numeric ID)
    const dfNode = this.diagramCanvas.editor.getNodeFromId(this.selectedNodeId);
    if (!dfNode?.data) { hideAll(); return; }

    const data = dfNode.data;
    const hasResults = (data.result_file_ids || '').split(',').filter(Boolean).length > 0;
    const hasResultText = !!data.result_text;
    const isNonPending = data.status && data.status !== 'pending';
    // Bug fix: cho phép reset BẤT KỂ executor running. Lý do:
    //   - Node prompt running mà gặp lỗi → status vẫn 'running' (callback failed không fire) → user
    //     không reset được vì button bị ẩn → workflow stuck mãi.
    //   - Reset chỉ clear data của node, không stop workflow. Nếu workflow vẫn chạy node khác,
    //     reset tiếp tục an toàn (next iteration sẽ thấy status='pending' và execute lại nếu cần).
    // Reset bị block CHỈ khi node hoàn toàn pending + chưa có kết quả gì (không có gì để reset).
    const shouldHide = !hasResults && !hasResultText && !isNonPending;
    headerBtn?.classList.toggle('hidden', shouldHide);
    footerBtn?.classList.toggle('hidden', shouldHide);
  }

  async _resetSingleNode(drawflowId) {
    // Template mode: không cho reset vì workflow chưa tồn tại trong DB
    if (this.isTemplateMode) return;
    // Read-only mode: không cho phép reset
    if (this.isReadOnly()) return;
    if (!this.workflow?.wf_id || !drawflowId || !this.diagramCanvas?.editor) return;

    // Get node data from Drawflow (drawflowId is numeric Drawflow ID)
    const dfNode = this.diagramCanvas.editor.getNodeFromId(drawflowId);
    if (!dfNode?.data) return;

    const actualNodeId = dfNode.data.node_id;
    const nodeName = dfNode.data.node_name || dfNode.data.node_type || 'Node';

    // Find node in workflow.nodes using actual node_id (UUID)
    const node = this.workflow.nodes?.find(n => String(n.node_id) === String(actualNodeId));

    // Bug fix: bỏ block executor.isRunning. Nếu node đang chạy thực sự + workflow vẫn active
    // → confirm dialog cảnh báo cho user biết. Reset vẫn proceed vì stuck state cần lối thoát.
    const isRunningNow = window.workflowExecutor?.isRunning;
    const confirmMsg = isRunningNow
      ? (window.I18n?.t('workflow.resetNodeWhileRunningConfirm', { name: nodeName })
        || `Workflow đang chạy. Reset "${nodeName}" sẽ xóa kết quả + trạng thái node này (tiếp tục các node khác). Tiếp tục?`)
      : (window.I18n?.t('workflow.resetNodeConfirm', { name: nodeName })
        || `Reset "${nodeName}" sẽ xóa kết quả và trạng thái của node này. Bạn có chắc chắn?`);
    const confirmed = await window.customDialog.confirm(confirmMsg, {
      type: 'warning',
      confirmText: 'Reset',
      cancelText: window.I18n?.t('common.cancel') || 'Hủy',
    });
    if (!confirmed) return;

    // Cancel deferred save timer
    if (this._deferredSaveTimer) {
      clearTimeout(this._deferredSaveTimer);
      this._deferredSaveTimer = null;
      this._updatePlayButtonState();
    }

    // Clear result entries from _tileCache BEFORE clearing node data
    const oldResultIds = (dfNode.data.result_file_ids || '').split(',').filter(Boolean);
    for (const id of oldResultIds) {
      this._tileCache.delete(id);
    }

    // Clear Drawflow node data
    dfNode.data.status = 'pending';
    dfNode.data.result_file_ids = '';
    dfNode.data.result_thumbnails = null;
    dfNode.data.result_file_names = null;
    dfNode.data.error_message = '';
    dfNode.data.executed_at = null;
    // 2026-05-31: prompt + text_extract đều có result_text output cần clear khi reset.
    if (dfNode.data.node_type === 'prompt' || dfNode.data.node_type === 'text_extract') {
      dfNode.data.result_text = '';
      dfNode.data.result_source = '';
      // Clear _extract_failed flag — re-run sau reset sẽ tự set lại nếu cần
      delete dfNode.data._extract_failed;
      delete dfNode.data._extract_reason;
    }

    // CRITICAL: Commit changes to Drawflow internal state
    // Without this, exportWorkflow() will export stale data (status still 'completed')
    this.diagramCanvas.editor.updateNodeDataFromId(drawflowId, dfNode.data);

    // Also update workflow.nodes if found
    if (node) {
      node.status = 'pending';
      node.result_file_ids = '';
      node.result_thumbnails = null;
      node.result_file_names = null;
      node.error_message = '';
      node.executed_at = null;
      if (node.node_type === 'prompt' || node.node_type === 'text_extract') {
        node.result_text = '';
        node.result_source = '';
        delete node._extract_failed;
        delete node._extract_reason;
      }
    }

    // Update node status UI on canvas
    this._updateNodeStatusUI(actualNodeId, 'pending');

    // Clear node preview on canvas
    this._clearNodePreview(actualNodeId);

    // 2026-05-31: prompt + text_extract — remove result preview (helper xử lý cả 2 selectors).
    if (dfNode.data.node_type === 'prompt' || dfNode.data.node_type === 'text_extract') {
      this._clearPromptNodeResultPreview(actualNodeId);
    }

    // Wait for any concurrent save to finish before starting our save
    if (this._isSaving) {
      const waitStart = Date.now();
      while (this._isSaving && Date.now() - waitStart < 5000) {
        await new Promise(r => setTimeout(r, 100));
      }
    }

    // Save workflow
    await this.saveWorkflow();

    // Refresh result tab if this node's form is open (compare Drawflow IDs)
    if (String(this.selectedNodeId) === String(drawflowId)) {
      const resultBody = this.overlay?.querySelector('#nodeResultBody');
      if (resultBody) {
        resultBody.innerHTML = this._renderNodeResultTab(dfNode.data);
      }
      this._updateDownloadButton();
      this._updateResetSingleNodeButton();
    }

    // Check if workflow needs run/reset button toggle
    this._checkAndToggleRunResetButton();

    this._addLogEntry(window.I18n?.t('workflow.nodeResetSuccess', { name: nodeName }) || `Node "${nodeName}" đã được reset.`, 'info');
    window.eventBus?.emit('storage:workflow_saved', { wfId: this.workflow.wf_id });
    try { chrome.runtime.sendMessage({ action: 'workflowSaved', wfId: this.workflow.wf_id }); } catch (e) {}

    // Defensive: đảm bảo save/reset button enabled lại sau single node reset.
    this._isSaving = false;
    const saveBtnAfter = this.overlay?.querySelector('#saveWorkflowBtn');
    const resetBtnAfter = this.overlay?.querySelector('#resetWorkflowInEditorBtn');
    if (saveBtnAfter) saveBtnAfter.disabled = false;
    if (resetBtnAfter) resetBtnAfter.disabled = false;
    this._updatePlayButtonState();
  }

  async _checkAndToggleRunResetButton() {
    const fullWorkflow = await window.storageManager?.getWorkflow(this.workflow?.wf_id);
    const nodes = fullWorkflow?.nodes || [];
    const allCompleted = nodes.length > 0 && nodes.every(n => n.status === 'completed');
    if (allCompleted) {
      this._showResetButton();
    } else {
      this._showRunButton();
    }
  }

  _addLogEntry(message, type = 'info') {
    const logBody = this.overlay?.querySelector('#executionLogBody');
    if (!logBody) return;

    const entry = document.createElement('div');
    entry.className = `execution-log-entry log-${type}`;
    const time = window.I18n?.formatTime?.(new Date()) || new Date().toLocaleTimeString();
    entry.innerHTML = `<span class="log-time">${time}</span> <span class="log-msg">${this.escapeHtml(message)}</span>`;
    logBody.appendChild(entry);
    logBody.scrollTop = logBody.scrollHeight;
  }

  _showSaveToast() {
    // Remove existing toast
    this.overlay?.querySelector('.save-toast')?.remove();

    const toast = document.createElement('div');
    toast.className = 'save-toast';
    toast.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
        <polyline points="22 4 12 14.01 9 11.01"></polyline>
      </svg>
      <span>Workflow saved</span>
    `;
    this.overlay?.appendChild(toast);

    // Auto remove after animation
    setTimeout(() => toast.remove(), 2500);
  }

  // === Node Picker Popup ===

  /**
   * Phase WK-1.2 enhancement: Hỗ trợ portContext để filter compatible nodes khi click empty port.
   *   portContext = { side: 'in'|'out', portType: 'image'|'text'|..., sourceNodeDrawflowId, portName }
   * Khi side='in' (click input port empty) → suggest nodes có output type tương thích.
   * Khi side='out' (click output port empty) → suggest nodes có input type tương thích.
   */
  async _showNodePicker(posX, posY, sourceNodeId = null, portContext = null) {
    this._hideNodePicker();

    // Fetch server node types (cached, TTL 5 phút)
    await NodeTemplates.fetchFromServer();
    const nodeTypes = NodeTemplates.getMergedTypes();

    // Hiển thị tất cả node từ merged types (server + local).
    // BUG FIX: Trước đây filter `!!NodeTemplates.types[typeKey]` → loại bỏ server-only types.
    // Permission check (lock/crown badge) dựa hoàn toàn vào feature gates client-side,
    // không cần server required_plan (redundant với feature gate system).
    const isAllowedNode = ([_typeKey, _cfg]) => true;

    // Phase WK-1.2: filter theo port compatibility nếu có portContext
    const PORT_COMPAT = window.NodeTemplates?.PORT_COMPAT || {};
    const isCompatibleNode = ([typeKey, cfg]) => {
      if (!portContext) return true;
      const ports = window.NodeTemplates?.getNodePorts?.(typeKey, {}) || { in: [], out: [] };
      if (portContext.side === 'in') {
        // Terminal sinks (telegram) — không gợi ý làm upstream.
        // Bug 27 fix: đọc từ `ui.terminal_sink` (backend convention) + fallback root
        // `terminalSink` cho backward-compat với template/cache cũ.
        if (cfg?.ui?.terminal_sink || cfg?.terminalSink) return false;
        // Empty input port → cần upstream node có output tương thích
        return (ports.out || []).some(p => (PORT_COMPAT[p.type] || []).includes(portContext.portType));
      }
      if (portContext.side === 'out') {
        // Empty output port → cần downstream node có input tương thích
        return (ports.in || []).some(p => (PORT_COMPAT[portContext.portType] || []).includes(p.type));
      }
      return true;
    };

    const picker = document.createElement('div');
    picker.className = 'tobyflow-node-picker';
    const closeBtnHtml = `<button type="button" class="tobyflow-node-picker-close" title="${window.I18n?.t('workflow.kbdClose') || 'Close'}" aria-label="${window.I18n?.t('workflow.kbdClose') || 'Close'}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>`;
    const headerHtml = portContext ? `
      <div class="tobyflow-node-picker-context-hint">
        <span class="tobyflow-node-picker-context-text">${window.I18n?.t('workflow.suggestForPort') || 'Gợi ý cho port'} <span class="tobyflow-node-picker-port-tag" data-port-type="${portContext.portType}">${this.escapeHtml(portContext.portLabel || portContext.portName)}</span></span>
        ${closeBtnHtml}
      </div>
    ` : `<div class="tobyflow-node-picker-context-hint tobyflow-node-picker-context-hint--no-text">${closeBtnHtml}</div>`;
    picker.innerHTML = `
      ${headerHtml}
      <div class="tobyflow-node-picker-search">
        <input type="text" placeholder="${window.I18n?.t('workflow.searchNode') || 'Tìm node...'}" class="tobyflow-node-picker-input" autofocus>
      </div>
      <div class="tobyflow-node-picker-list">
        ${Object.entries(nodeTypes)
          .filter(([key]) => !['transform', 'condition', 'merge', 'output'].includes(key))
          .filter(isAllowedNode)
          .filter(isCompatibleNode)
          .sort(([, a], [, b]) => (a.sortOrder ?? 999) - (b.sortOrder ?? 999))
          .map(([key, config]) => {
            const isGenerateLocked = key === 'generate' && !(window.featureGate?.canUse('gen_enabled') ?? false);
            const isTelegramLocked = key === 'telegram' && (
              !(window.featureGate?.canUse('telegram_enabled') ?? false) ||
              !(window.featureGate?.canUse('telegram_workflow') ?? false)
            );
            const isChatGPTLocked = key === 'chatgpt' && !(window.featureGate?.canUse('chatgpt_enabled') ?? false);
            const isPromptLocked = key === 'prompt' && !(window.featureGate?.canUse('prompt_node_enabled') ?? false);
            const isGrokLocked = key === 'grok' && !(window.featureGate?.canUse('grok_enabled') ?? false);
            const isLocked = isGenerateLocked || isTelegramLocked || isChatGPTLocked || isPromptLocked || isGrokLocked;
            const premiumBadge = isLocked
              ? ' <svg width="12" height="12" viewBox="0 0 24 24" fill="#eab308" style="margin-left:4px;vertical-align:middle;"><path d="M5 16L3 5L8.5 10L12 4L15.5 10L21 5L19 16H5ZM19 19C19 19.6 18.6 20 18 20H6C5.4 20 5 19.6 5 19V18H19V19Z"></path></svg>'
              : '';
            // Icon lookup: server config.icon (string key) → NodeTemplates.icons[key], fallback type key
            const iconKey = config.icon || key;
            const iconSvg = NodeTemplates.icons[iconKey] || NodeTemplates.icons[key] || NodeTemplates.icons.generate;
            return `
            <button class="tobyflow-node-picker-item ${config.comingSoon ? 'tobyflow-node-picker-disabled' : ''}" data-type="${key}" ${config.comingSoon ? 'disabled' : ''}>
              <div class="df-node-icon ${config.color}">${iconSvg}</div>
              <div class="tobyflow-node-picker-info">
                <div class="tobyflow-node-picker-name">${config.name}${premiumBadge}${config.comingSoon ? ` <span style="font-size:10px;color:var(--warning,#f59e0b);margin-left:4px;">(${window.I18n?.t('workflow.comingSoon') || 'Sắp ra mắt'})</span>` : ''}</div>
                <div class="tobyflow-node-picker-desc">${config.description}</div>
              </div>
            </button>
          `;}).join('')}
      </div>
      <div class="tobyflow-node-picker-footer">
        <kbd>&#8593;&#8595;</kbd> ${window.I18n?.t('workflow.kbdMove') || 'Move'} &nbsp; <kbd>Enter</kbd> ${window.I18n?.t('workflow.kbdSelect') || 'Select'} &nbsp; <kbd>Esc</kbd> ${window.I18n?.t('workflow.kbdClose') || 'Close'}
      </div>
    `;

    picker.style.left = `${posX}px`;
    picker.style.top = `${posY}px`;

    const diagramContainer = this.overlay?.querySelector('#diagramContainer');
    if (diagramContainer) {
      diagramContainer.appendChild(picker);
    } else {
      this.overlay?.appendChild(picker);
    }
    this._nodePicker = picker;
    this._nodePickerSource = sourceNodeId;

    // Clamp picker vào trong container — tránh tràn ra ngoài viewport
    requestAnimationFrame(() => {
      if (!this._nodePicker || !diagramContainer) return;
      const pRect = picker.getBoundingClientRect();
      const cRect = diagramContainer.getBoundingClientRect();
      const PADDING = 8;
      let nx = posX, ny = posY;
      if (pRect.right > cRect.right - PADDING) {
        nx = Math.max(PADDING, posX - (pRect.right - cRect.right) - PADDING);
      }
      if (pRect.bottom > cRect.bottom - PADDING) {
        ny = Math.max(PADDING, posY - (pRect.bottom - cRect.bottom) - PADDING);
      }
      if (pRect.left < cRect.left + PADDING) nx = PADDING;
      if (pRect.top < cRect.top + PADDING) ny = PADDING;
      if (nx !== posX) picker.style.left = `${nx}px`;
      if (ny !== posY) picker.style.top = `${ny}px`;
    });

    const input = picker.querySelector('.tobyflow-node-picker-input');
    setTimeout(() => input?.focus(), 50);

    // Filter on type
    input?.addEventListener('input', () => {
      const query = input.value.toLowerCase();
      picker.querySelectorAll('.tobyflow-node-picker-item').forEach(item => {
        const name = item.querySelector('.tobyflow-node-picker-name')?.textContent.toLowerCase() || '';
        const desc = item.querySelector('.tobyflow-node-picker-desc')?.textContent.toLowerCase() || '';
        item.style.display = (name.includes(query) || desc.includes(query)) ? 'flex' : 'none';
      });
      selectedIdx = 0;
      highlight();
    });

    // Close button (X) ở header → đóng picker
    picker.querySelector('.tobyflow-node-picker-close')?.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      this._hideNodePicker();
    });

    // Select item
    picker.addEventListener('click', async (e) => {
      const item = e.target.closest('.tobyflow-node-picker-item');
      if (!item) return;
      const type = item.dataset.type;

      // Smart placement: nếu tạo từ empty port → đặt new node ở vị trí hợp lý
      // theo flow direction (input → trái, output → phải) thay vì tại vị trí picker.
      let spawnX = posX, spawnY = posY;
      if (portContext) {
        const smart = this._calculateSpawnPosition(portContext, type);
        if (smart) { spawnX = smart.x; spawnY = smart.y; }
      }
      const newNodeId = await this._createNodeFromPicker(type, spawnX, spawnY, sourceNodeId);
      // Phase WK-1.2: Nếu mở từ port empty → auto-connect node mới với port đó
      if (portContext && newNodeId && this.diagramCanvas?.editor) {
        try { this._autoConnectFromPortContext(newNodeId, type, portContext); }
        catch (err) { console.warn('[WorkflowEditor] Auto-connect failed:', err.message); }
      }
      this._hideNodePicker();
    });

    // Keyboard nav
    let selectedIdx = 0;
    const items = () => [...picker.querySelectorAll('.tobyflow-node-picker-item:not([style*="display: none"])')];
    const highlight = () => {
      items().forEach((it, i) => it.classList.toggle('selected', i === selectedIdx));
    };

    input?.addEventListener('keydown', (e) => {
      const visibleItems = items();
      if (e.key === 'ArrowDown') { e.preventDefault(); selectedIdx = Math.min(selectedIdx + 1, visibleItems.length - 1); highlight(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); selectedIdx = Math.max(selectedIdx - 1, 0); highlight(); }
      else if (e.key === 'Enter') { e.preventDefault(); const item = visibleItems[selectedIdx]; if (item) item.click(); }
      else if (e.key === 'Escape') { e.preventDefault(); this._hideNodePicker(); }
    });

    // Close picker on outside click — capture phase để chạy TRƯỚC port click handler
    // Identity check: chỉ đóng nếu picker đang xét vẫn là current (tránh đóng nhầm picker mới)
    // Skip khi click vào empty port khác — để port handler tự mở picker mới (tránh flicker)
    const myPicker = picker;
    const outsideHandler = (e) => {
      if (this._nodePicker !== myPicker || !myPicker.isConnected) {
        document.removeEventListener('mousedown', outsideHandler, true);
        return;
      }
      if (myPicker.contains(e.target)) return;
      // Click vào empty port khác → để port handler xử lý (sẽ tự mở picker mới)
      const portEl = e.target.closest?.('.drawflow .input[data-port-type], .drawflow .output[data-port-type]');
      if (portEl && this._isPortEmpty?.(portEl)) {
        document.removeEventListener('mousedown', outsideHandler, true);
        // KHÔNG hide ngay — port handler sẽ gọi _hideNodePicker trong _showNodePicker
        return;
      }
      this._hideNodePicker();
      document.removeEventListener('mousedown', outsideHandler, true);
    };
    setTimeout(() => document.addEventListener('mousedown', outsideHandler, true), 50);
  }

  /**
   * Phase WK-1.2 enhancement: Auto-connect new node với port đã trigger picker.
   * portContext = { side, portType, portName, sourceNodeDrawflowId }
   * - side='in' → new node có output tương thích với portType → connect new.output → existing.input
   * - side='out' → new node có input tương thích → connect existing.output → new.input
   */
  /**
   * Auto-layout: sắp xếp lại tất cả node theo BFS levels từ start node (hoặc roots không có upstream).
   * Cùng level (depth) → cùng cột. Khoảng cách 380px ngang × 240px dọc, đảm bảo connection rõ.
   */
  _autoLayoutNodes() {
    const editor = this.diagramCanvas?.editor;
    if (!editor) return;
    const exportData = editor.export();
    const nodes = exportData?.drawflow?.Home?.data || {};
    const ids = Object.keys(nodes);
    if (ids.length === 0) return;

    // Build adjacency: parents[id] = set của upstream node ids
    const parents = {};
    const children = {};
    ids.forEach(id => { parents[id] = new Set(); children[id] = new Set(); });
    for (const [id, n] of Object.entries(nodes)) {
      const inputs = n.inputs || {};
      for (const inp of Object.values(inputs)) {
        for (const c of (inp.connections || [])) {
          const src = String(c.node);
          parents[id].add(src);
          if (children[src]) children[src].add(id);
        }
      }
    }

    // Roots: node không có parent (in-degree = 0). Ưu tiên type='start' nếu có.
    const roots = ids.filter(id => parents[id].size === 0);
    if (roots.length === 0) {
      // Có cycle hoặc tất cả nodes có parent → fallback: dùng node có ít parent nhất
      roots.push(ids[0]);
    }

    // BFS để gán depth (level) cho mỗi node
    const depth = {};
    const queue = [];
    roots.forEach(r => { depth[r] = 0; queue.push(r); });
    while (queue.length > 0) {
      const cur = queue.shift();
      for (const ch of children[cur]) {
        const newDepth = depth[cur] + 1;
        if (depth[ch] === undefined || newDepth > depth[ch]) {
          depth[ch] = newDepth;
          queue.push(ch);
        }
      }
    }
    // Nodes không reach từ roots (orphan) → gán depth = 0
    ids.forEach(id => { if (depth[id] === undefined) depth[id] = 0; });

    // Group theo depth
    const levels = {};
    for (const id of ids) {
      const d = depth[id];
      if (!levels[d]) levels[d] = [];
      levels[d].push(id);
    }

    // Layout: x = depth * STEP_X + START_X. Y dùng cumulative offset theo offsetHeight thực tế
    // của mỗi node để tránh overlap khi có node cao (image/prompt với preview lớn).
    const START_X = 80;
    const START_Y = 80;
    const STEP_X = 480;  // node width ~340 + gap 140 cho connection lines rõ ràng
    const VERT_GAP = 100; // khoảng cách dọc lớn hơn để lines không chồng chéo
    const FALLBACK_HEIGHT = 220;

    // Pre-compute node heights để tính toán Y position chính xác hơn
    const nodeHeights = {};
    ids.forEach(id => {
      const el = document.getElementById(`node-${id}`);
      nodeHeights[id] = el?.offsetHeight || FALLBACK_HEIGHT;
    });

    // Two-pass layout: pass 1 đặt vị trí sơ bộ, pass 2 căn chỉnh theo connections
    // Pass 1: Sort nodes trong mỗi level theo weighted avg của parent + child Y positions
    const tempPositions = {};

    Object.entries(levels).forEach(([d, levelIds]) => {
      const dNum = parseInt(d, 10);

      // Sort nodes theo avg Y của cả parents VÀ children (nếu có) để minimize crossings
      levelIds.sort((a, b) => {
        const getWeightedY = (nodeId) => {
          const parentIds = [...parents[nodeId]];
          const childIds = [...children[nodeId]];
          let totalWeight = 0;
          let weightedSum = 0;

          // Parents có weight cao hơn (flow từ trái sang phải)
          for (const pid of parentIds) {
            const py = tempPositions[pid]?.y ?? nodes[pid]?.pos_y ?? 0;
            weightedSum += py * 2;
            totalWeight += 2;
          }
          // Children có weight thấp hơn nhưng vẫn tính
          for (const cid of childIds) {
            const cy = nodes[cid]?.pos_y ?? 0;
            weightedSum += cy;
            totalWeight += 1;
          }

          return totalWeight > 0 ? weightedSum / totalWeight : parseInt(nodeId, 10) * 100;
        };

        return getWeightedY(a) - getWeightedY(b);
      });

      const x = START_X + dNum * STEP_X;
      let cursorY = START_Y;

      levelIds.forEach((id) => {
        tempPositions[id] = { x, y: cursorY };
        cursorY += nodeHeights[id] + VERT_GAP;
      });
    });

    // Pass 2: Điều chỉnh Y để căn giữa với parent connections (giảm đường chéo dài)
    Object.entries(levels).forEach(([d, levelIds]) => {
      const dNum = parseInt(d, 10);
      if (dNum === 0) return; // Level 0 (roots) giữ nguyên

      levelIds.forEach((id) => {
        const parentIds = [...parents[id]];
        if (parentIds.length === 0) return;

        // Tính trung bình Y của các parent nodes
        let parentYSum = 0;
        parentIds.forEach(pid => {
          const ph = nodeHeights[pid] || FALLBACK_HEIGHT;
          parentYSum += (tempPositions[pid]?.y ?? 0) + ph / 2; // center of parent
        });
        const avgParentCenterY = parentYSum / parentIds.length;

        // Điều chỉnh Y của node này để center gần với avg parent center
        // Nhưng không được overlap với nodes khác trong cùng level
        const currentY = tempPositions[id].y;
        const nodeH = nodeHeights[id];
        const targetY = avgParentCenterY - nodeH / 2;

        // Chỉ shift nếu không gây overlap và không đi quá xa
        const maxShift = VERT_GAP * 0.6;
        const shift = Math.max(-maxShift, Math.min(maxShift, targetY - currentY));
        tempPositions[id].y = currentY + shift;
      });
    });

    // Pass 3: Resolve overlaps trong mỗi level (sort by Y rồi đảm bảo min gap)
    Object.entries(levels).forEach(([d, levelIds]) => {
      // Sort by current Y position
      levelIds.sort((a, b) => tempPositions[a].y - tempPositions[b].y);

      // Ensure minimum gap between consecutive nodes
      const minGap = VERT_GAP * 0.5;
      for (let i = 1; i < levelIds.length; i++) {
        const prevId = levelIds[i - 1];
        const currId = levelIds[i];
        const prevBottom = tempPositions[prevId].y + nodeHeights[prevId];
        const currTop = tempPositions[currId].y;
        if (currTop < prevBottom + minGap) {
          tempPositions[currId].y = prevBottom + minGap;
        }
      }
    });

    // Apply final positions
    ids.forEach(id => {
      const pos = tempPositions[id];
      if (pos) this._moveNodeTo(id, pos.x, pos.y);
    });

    // Smart zoom sau khi sắp xếp xong (defer để DOM update offsetWidth)
    requestAnimationFrame(() => {
      try { this.diagramCanvas?.fitToScreen?.(); } catch (e) {}
    });

    // Toast
    if (typeof window.showNotification === 'function') {
      window.showNotification(
        window.I18n?.t('workflow.autoLayoutDone') || 'Nodes rearranged by flow',
        'success', 1500
      );
    }
    this._hasUnsavedChanges = true;
  }

  /**
   * Di chuyển 1 node tới (x, y) trong canvas coords + update Drawflow data + redraw connections.
   */
  _moveNodeTo(drawflowId, x, y) {
    const editor = this.diagramCanvas?.editor;
    if (!editor) return;
    const moduleData = editor.drawflow?.drawflow?.Home?.data;
    if (!moduleData || !moduleData[drawflowId]) return;
    moduleData[drawflowId].pos_x = x;
    moduleData[drawflowId].pos_y = y;
    const nodeEl = document.getElementById(`node-${drawflowId}`);
    if (nodeEl) {
      nodeEl.style.top = `${y}px`;
      nodeEl.style.left = `${x}px`;
    }
    try { editor.updateConnectionNodes(`node-${drawflowId}`); } catch (e) {}
  }

  /**
   * Smart placement cho new node tạo từ empty port.
   * - portContext.side === 'in'  → new node ở BÊN TRÁI existing (sẽ feed vào input)
   * - portContext.side === 'out' → new node ở BÊN PHẢI existing
   * Y-align với existing, dồn xuống khi có overlap với node khác.
   * @returns {{x, y}|null} canvas coords cho Drawflow.addNode
   */
  _calculateSpawnPosition(portContext, _newType) {
    const editor = this.diagramCanvas?.editor;
    if (!editor || !portContext?.sourceNodeDrawflowId) return null;

    const existing = editor.getNodeFromId(portContext.sourceNodeDrawflowId);
    if (!existing) return null;

    const existingX = existing.pos_x || 0;
    const existingY = existing.pos_y || 0;

    // Lấy width thực tế từ DOM (offsetWidth = un-transformed CSS px, đúng cho canvas coord)
    const nodeEl = this.overlay?.querySelector(`#node-${portContext.sourceNodeDrawflowId}`);
    const existingWidth = nodeEl?.offsetWidth || 340;

    const NEW_NODE_WIDTH = 340;  // ~min-width của card
    const HORIZ_GAP = 60;
    const VERT_GAP = 40;
    const ESTIMATED_HEIGHT = 200;

    // Vị trí ngang theo direction
    let targetX;
    if (portContext.side === 'in') {
      // New node ở bên TRÁI: existing.left - newWidth - gap
      targetX = existingX - NEW_NODE_WIDTH - HORIZ_GAP;
    } else {
      // New node ở bên PHẢI: existing.right + gap
      targetX = existingX + existingWidth + HORIZ_GAP;
    }
    let targetY = existingY;

    // Tránh overlap: scan các node hiện có trong khoảng X target
    const exportData = editor.export();
    const allNodes = exportData?.drawflow?.Home?.data || {};
    const collides = (x, y) => Object.entries(allNodes).some(([id, n]) => {
      if (id == portContext.sourceNodeDrawflowId) return false;
      const nx = n.pos_x || 0;
      const ny = n.pos_y || 0;
      const overlapX = Math.abs(nx - x) < (NEW_NODE_WIDTH - 20);
      const overlapY = Math.abs(ny - y) < (ESTIMATED_HEIGHT + VERT_GAP);
      return overlapX && overlapY;
    });

    // Try lần lượt: targetY → targetY+220 → targetY-220 → targetY+440 → ...
    let attempts = 0;
    while (collides(targetX, targetY) && attempts < 6) {
      attempts++;
      const dir = attempts % 2 === 1 ? 1 : -1;
      const step = Math.ceil(attempts / 2) * (ESTIMATED_HEIGHT + VERT_GAP);
      targetY = existingY + dir * step;
    }
    return { x: targetX, y: targetY };
  }

  _autoConnectFromPortContext(newNodeDrawflowId, newType, portContext) {
    const editor = this.diagramCanvas?.editor;
    if (!editor || !newNodeDrawflowId || !portContext) return;
    const PORT_COMPAT = window.NodeTemplates?.PORT_COMPAT || {};
    const newPorts = window.NodeTemplates?.getNodePorts?.(newType, {}) || { in: [], out: [] };

    if (portContext.side === 'in') {
      // Existing node là target. New node phải provide output.
      const matchingOut = (newPorts.out || []).find(p => (PORT_COMPAT[p.type] || []).includes(portContext.portType));
      if (!matchingOut) return;
      const newOutIdx = newPorts.out.indexOf(matchingOut) + 1;
      // portContext.portIndex = input index của existing node
      try {
        editor.addConnection(
          newNodeDrawflowId,
          portContext.sourceNodeDrawflowId,
          `output_${newOutIdx}`,
          `input_${portContext.portIndex}`
        );
      } catch (e) { console.warn('[WorkflowEditor] addConnection in failed:', e.message); }
    } else if (portContext.side === 'out') {
      // Existing node là source. New node phải accept input.
      const matchingIn = (newPorts.in || []).find(p => (PORT_COMPAT[portContext.portType] || []).includes(p.type));
      if (!matchingIn) return;
      const newInIdx = newPorts.in.indexOf(matchingIn) + 1;
      try {
        editor.addConnection(
          portContext.sourceNodeDrawflowId,
          newNodeDrawflowId,
          `output_${portContext.portIndex}`,
          `input_${newInIdx}`
        );
      } catch (e) { console.warn('[WorkflowEditor] addConnection out failed:', e.message); }
    }
  }

  /**
   * Phase enhancement: Bind click trên inline editable pill (.df-node-tag-editable) → mở mini dropdown
   * → user chọn value → update node data + re-render card + auto saveWorkflow.
   */
  /**
   * 2026-05-25 click-to-edit inline prompt UX.
   * - Default view mode: read-only text + pencil edit icon
   * - Click edit icon → switch to edit mode (textarea focus)
   * - Blur textarea → save + back to view mode + "Đã lưu" badge 1.5s
   * - Esc → cancel (revert + back to view)
   * - mousedown.stopPropagation → tránh Drawflow trigger node drag
   * - 2-way sync với form panel textarea nếu đang mở
   */
  _bindInlinePromptEdit() {
    if (!this.overlay) return;
    if (this.isReadOnly()) return;
    const containers = this.overlay.querySelectorAll('.df-inline-prompt-container');
    containers.forEach((container) => {
      if (container._inlinePromptBound) return;
      container._inlinePromptBound = true;

      const editBtn = container.querySelector('.df-inline-prompt-edit-btn');
      const viewEl = container.querySelector('.df-inline-prompt-view');
      const textEl = container.querySelector('.df-inline-prompt-text');
      const ta = container.querySelector('.df-inline-prompt-edit');
      if (!ta || !editBtn || !viewEl || !textEl) return;

      // Stop Drawflow drag/dblclick trên cả container
      const stopProp = (e) => e.stopPropagation();
      [editBtn, viewEl, ta].forEach((el) => {
        el.addEventListener('mousedown', stopProp);
        el.addEventListener('dblclick', stopProp);
      });

      // Auto-resize textarea
      const autoResize = () => {
        ta.style.height = 'auto';
        ta.style.height = Math.min(Math.max(ta.scrollHeight, 60), 160) + 'px';
      };

      // Enter edit mode
      const enterEditMode = () => {
        container.dataset.mode = 'edit';
        container.dataset.saved = 'false'; // hide saved badge nếu visible
        ta.value = this._getCurrentPromptForNode(container);
        autoResize();
        // Focus + place cursor at end
        setTimeout(() => {
          ta.focus();
          ta.setSelectionRange(ta.value.length, ta.value.length);
        }, 0);
      };

      // Exit edit mode + save
      const exitEditMode = (save = true) => {
        if (container.dataset.mode !== 'edit') return;
        container.dataset.mode = 'view';
        if (save) {
          const changed = this._savePromptInline(ta, container);
          if (changed) {
            // Update view text + show saved badge
            this._refreshPromptViewText(container, ta.value);
            this._flashSavedBadge(container);
          }
        }
      };

      editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        enterEditMode();
      });

      // Click vào view text cũng enter edit (UX shortcut)
      viewEl.addEventListener('click', (e) => {
        // Tránh trigger nếu click vào edit btn (đã handle riêng)
        if (e.target.closest('.df-inline-prompt-edit-btn')) return;
        e.stopPropagation();
        enterEditMode();
      });

      // Textarea events
      ta.addEventListener('input', autoResize);
      ta.addEventListener('blur', () => exitEditMode(true));
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          ta.value = this._getCurrentPromptForNode(container); // revert
          exitEditMode(false);
        } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
          // Save + exit edit
          e.preventDefault();
          ta.blur();
        }
      });
    });
  }

  /**
   * Get current prompt value từ node data (live state) cho container.
   */
  _getCurrentPromptForNode(container) {
    const nodeEl = container.closest('.drawflow-node');
    if (!nodeEl) return '';
    const drawflowId = nodeEl.id?.replace('node-', '');
    const node = this.diagramCanvas?.editor?.getNodeFromId(drawflowId);
    return node?.data?.prompt || '';
  }

  /**
   * Update view text element sau save (sync UI với Drawflow state).
   */
  _refreshPromptViewText(container, value) {
    const textEl = container.querySelector('.df-inline-prompt-text');
    if (!textEl) return;
    const trimmed = (value || '').trim();
    const placeholder = window.I18n?.t?.('node.promptPlaceholder') || 'Nhập prompt...';
    if (trimmed) {
      textEl.textContent = value;
      textEl.classList.remove('df-inline-prompt-empty');
    } else {
      textEl.textContent = placeholder;
      textEl.classList.add('df-inline-prompt-empty');
    }
  }

  /**
   * Flash "Đã lưu" badge 1.5s sau save success.
   */
  _flashSavedBadge(container) {
    // Set text tại runtime (không bake render-time để locale switch không bị stale).
    const textEl = container.querySelector('.df-inline-prompt-saved-text');
    if (textEl) {
      const fallback = { en: 'Saved', th: 'บันทึกแล้ว', ja: '保存しました' }[window.I18n?.getLocale?.()] || 'Đã lưu';
      textEl.textContent = window.I18n?.t?.('common.saved') || fallback;
    }
    container.dataset.saved = 'true';
    if (container._savedTimer) clearTimeout(container._savedTimer);
    container._savedTimer = setTimeout(() => {
      container.dataset.saved = 'false';
      container._savedTimer = null;
    }, 1500);
  }

  /**
   * Save inline prompt text vào Drawflow data + sync form panel nếu đang mở.
   * @returns {boolean} true nếu data thực sự thay đổi (UI có thể flash saved badge)
   */
  _savePromptInline(ta) {
    if (!ta || !this.diagramCanvas?.editor) return false;
    const nodeEl = ta.closest('.drawflow-node');
    if (!nodeEl) return false;
    const drawflowId = nodeEl.id?.replace('node-', '');
    if (!drawflowId) return false;
    const node = this.diagramCanvas.editor.getNodeFromId(drawflowId);
    if (!node?.data) return false;
    const newPrompt = ta.value;
    if ((node.data.prompt || '') === newPrompt) return false; // no change

    // updateNodeDataFromId persist live state (getNodeFromId trả deep clone)
    const newData = { ...node.data, prompt: newPrompt };
    try {
      this.diagramCanvas.editor.updateNodeDataFromId(drawflowId, newData);
    } catch (err) {
      console.warn('[WorkflowEditor] inline prompt save failed:', err?.message);
      return false;
    }
    this._hasUnsavedChanges = true;

    // Sync form panel textarea nếu form đang mở cho node này (2-way binding)
    if (this.selectedNodeId) {
      const selectedDrawflowId = this._findDrawflowId(this.selectedNodeId);
      if (String(selectedDrawflowId) === String(drawflowId)) {
        const formTa = this.overlay?.querySelector('#promptNodeText, #nodePrompt');
        if (formTa && formTa.value !== newPrompt) {
          formTa.value = newPrompt;
        }
      }
    }
    return true;
  }

  _bindInlineSettingPills() {
    // 2-tier binding: (1) document capture (fires sớm nhất, robust) + (2) direct binding per pill.
    // Document handler đảm bảo click LUÔN reach _showInlineSettingDropdown bất kể Drawflow consume.
    const overlay = this.overlay;
    if (!overlay) return;

    // Bind inline prompt edit textarea (prompt nodes only)
    try { this._bindInlinePromptEdit(); } catch (e) { /* ignore */ }

    // Inject gear icon bottom-right cho TẤT CẢ node types
    this._ensureNodeCornerGears();

    // Tier 1: Document-level capture (one-time, idempotent)
    if (!this._docPillBound) {
      this._docPillBound = true;
      const docMouseDown = (e) => {
        const target = e.target?.closest?.('.df-node-tag-editable, .df-node-settings-btn, .df-node-corner-gear');
        if (!target) return;
        if (!this.overlay?.contains(target)) return;
        e.stopPropagation();
      };
      const docClick = (e) => {
        const gear = e.target?.closest?.('.df-node-settings-btn, .df-node-corner-gear');
        if (gear && this.overlay?.contains(gear)) {
          e.stopPropagation();
          e.preventDefault();
          // Preview mode: chặn click settings (trừ admin preview - cho phép xem read-only)
          if (this.isReadOnly() && !this.workflow?._is_admin_view) return;
          const nodeEl = gear.closest('.drawflow-node');
          const drawflowId = nodeEl?.id?.replace('node-', '');
          if (drawflowId && window.eventBus) {
            window.eventBus.emit('node:open_settings', { nodeId: drawflowId });
          }
          return;
        }
        const pill = e.target?.closest?.('.df-node-tag-editable');
        if (!pill || !this.overlay?.contains(pill)) return;
        e.stopPropagation();
        e.preventDefault();
        // Preview mode: chặn click inline setting pill
        if (this.isReadOnly()) return;
        const setting = pill.dataset?.setting;
        const nodeEl = pill.closest('.drawflow-node');
        const drawflowId = nodeEl?.id?.replace('node-', '');
        if (!drawflowId || !setting) return;
        try {
          this._showInlineSettingDropdown(pill, drawflowId, setting);
        } catch (err) {
          console.error('[WorkflowEditor] Inline pill dropdown failed:', err);
        }
      };
      this._docPillMouseDown = docMouseDown;
      this._docPillClick = docClick;
      document.addEventListener('mousedown', docMouseDown, true);
      document.addEventListener('click', docClick, true);
    }

    // Tier 2 đã bỏ — chỉ dùng document handler (Tier 1) để tránh double-fire khiến
    // dropdown bị tạo 2 lần liên tiếp + outside handler stale đóng nhầm dropdown mới.
    // Document capture đã catch click trước khi Drawflow consume → reliable.
  }

  /**
   * Inject 1 gear icon ở bottom-right corner cho mỗi node card (idempotent).
   * Chạy sau mỗi render để đảm bảo tất cả node types đều có gear consistent UX.
   */
  _ensureNodeCornerGears() {
    if (!this.overlay) return;
    const nodeRoots = this.overlay.querySelectorAll('.drawflow-node .df-node');
    const title = window.I18n?.t('node.settings') || 'Cài đặt';
    const gearSVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';
    nodeRoots.forEach((nodeEl) => {
      if (nodeEl.querySelector('.df-node-corner-gear')) return;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'df-node-corner-gear';
      btn.setAttribute('data-action', 'settings-node');
      // Custom CSS tooltip via ::after pseudo-element + native title fallback (a11y)
      btn.setAttribute('data-tooltip', title);
      btn.title = title;
      btn.innerHTML = gearSVG;
      // UI 2026-05-27: gắn gear vào cuối settings-bar (bên phải hàng pills) nếu có; else corner node.
      const bar = nodeEl.querySelector('.df-node-settings-bar');
      (bar || nodeEl).appendChild(btn);
    });
  }

  _showInlineSettingDropdown(anchorEl, drawflowId, setting) {
    this._hideInlineSettingDropdown();

    const editor = this.diagramCanvas?.editor;
    const node = editor?.getNodeFromId(drawflowId);
    if (!node) return;
    const data = node.data || {};

    // Options đồng bộ với right sidebar form (single source of truth từ sidebar select).
    // KHÔNG hardcode khác — phải match đúng field render trong _renderNodeFormByType.
    const isVideo = data.media_type === 'Video';
    // Quantity range từ provider_configs.flow.api_config.quantity_range (admin tweak qua
    // /admin/providers/flow → SSE provider:api_config_updated → cache invalidate).
    const _qRange = window.ProviderConfigManager?.safeGetQuantityRangeSync?.('flow');
    const _qMin = _qRange?.min ?? 1;
    const _qMax = _qRange?.max ?? 4;
     const _qty = [];
     for (let i = _qMin; i <= _qMax; i++) _qty.push({ value: i, label: `${i}x` });
    const optionsMap = {
      quantity: _qty,
      mediaType: [
        { value: 'Image', label: window.I18n?.t('workflow.genTypeImage') || 'Image' },
        { value: 'Video', label: window.I18n?.t('workflow.genTypeVideo') || 'Video' },
      ],
      // Bug 40 fix (2026-05-19): Source from PCM (admin tweak realtime via SSE).
      // Generate ratio: Image hỗ trợ 5 ratios, Video chỉ 16:9 và 9:16 (Google Flow constraint).
      ratio: (() => {
        const _rIcon = (v) => {
          const s = String(v || '').trim();
          if (s === '16:9') return '▬';
          if (s === '4:3' || s === '3:2') return '▭';
          if (s === '1:1') return '□';
          if (s === '3:4' || s === '2:3') return '▯';
          if (s === '9:16') return '▮';
          return '◇';
        };
        const _flowRatios = (window.ProviderConfigManager?.safeGetRatiosSync?.('flow', isVideo ? 'video' : 'image'))
          || (isVideo ? ['16:9', '9:16'] : ['16:9', '4:3', '1:1', '3:4', '9:16']);
        return _flowRatios.map(r => {
          const v = typeof r === 'string' ? r : r.value;
          return { value: v, label: `${_rIcon(v)} ${v}` };
        });
      })(),
      // Generate model: dynamic theo media_type — sync với #nodeModel / #nodeVideoModel
      // Group C: Fetch từ ModelRegistry (server-driven) thay vì hardcode.
      // Pattern label rút gọn "Veo 3.1 - Fast" → "Veo 3.1 Fast" (UI display).
      model: (window.ModelRegistry?.getModelsSync('flow', isVideo ? 'video' : 'image') || []).map(m => ({
        value: m.value,
        label: m.name.replace(/^Veo 3\.1 - /, 'Veo 3.1 '),
      })),
      // Video duration (chỉ video mode) — tier từ model config
      videoDuration: (() => {
        if (!isVideo) return [];
        const currentModel = data.model || '';
        let tier = 'default';
        try {
          const models = window.ModelRegistry?.safeGetModelsSync?.('flow', 'video') || [];
          const modelObj = models.find(m => m.value === currentModel || m.name === currentModel);
          if (modelObj?.config?.duration_tier) tier = modelObj.config.duration_tier;
        } catch (_) {}
        const durations = window.ProviderConfigManager?.safeGetVideoDurationsSync?.('flow', tier) || ['4s', '6s', '8s'];
        return durations.map(d => ({ value: d, label: d }));
      })(),
      // Bug 40 fix (2026-05-19): ChatGPT ratio inline dropdown — source from
      // ChatGPTAdapter.capabilities (PCM-backed getter). Admin tweak ratios qua
      // /admin/providers/chatgpt/api-configs → SSE → adapter trả fresh.
      chatgptRatio: (() => {
        const _cgIcon = (v) => {
          const s = String(v || '').trim();
          if (s === '16:9') return '▬';
          if (s === '4:3' || s === '3:2') return '▭';
          if (s === '1:1') return '□';
          if (s === '3:4' || s === '2:3') return '▯';
          if (s === '9:16') return '▮';
          return '◇';
        };
        const _cap = (s) => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
        const _adapter = window.ProviderRegistry?.get?.('chatgpt');
        const _supportedRatios = _adapter?.capabilities?.supportedRatios
          || ['story', 'portrait', 'square', 'landscape', 'widescreen'];
        const _uiMap = _adapter?.capabilities?.ratioUiMap
          || { story: '9:16', portrait: '3:4', square: '1:1', landscape: '4:3', widescreen: '16:9' };
        return _supportedRatios.map(key => ({
          value: key,
          label: `${_cgIcon(_uiMap[key])} ${_uiMap[key] || key} — ${_cap(key)}`,
        }));
      })(),
      // ChatGPT_image mode: sync với #chatgptImageMode (use_fallback_prefix)
      chatgptMode: [
        { value: 'auto',   label: 'Auto — Image mode → fallback' },
        { value: 'always', label: 'Always — Luôn dùng prefix' },
        { value: 'never',  label: 'Never — Bắt buộc image mode' },
      ],
      // ChatGPT model (Instant/Thinking — GPT-5.5) từ ModelRegistry('chatgpt','image')
      chatgptModel: (() => {
        const models = window.ModelRegistry?.safeGetModelsSync?.('chatgpt', 'image') || [];
        if (models.length > 0) return models.map(m => ({ value: m.value || m.name, label: m.name || m.value }));
        return [{ value: 'Instant', label: 'Instant' }, { value: 'Thinking', label: 'Thinking' }];
      })(),
      // Grok mode: sync với #grokNodeMode (image | video)
      grokMode: [
        { value: 'image', label: window.I18n?.t('grok.modeImage') || 'Image' },
        { value: 'video', label: window.I18n?.t('grok.modeVideo') || 'Video' },
      ],
      // Bug 40 fix (2026-05-19): Grok ratio inline dropdown — source from
      // GrokAdapter.capabilities (PCM-backed getter). Grok ratios: 2:3/3:2/1:1/9:16/16:9.
      grokRatio: (() => {
        const _grIcon = (v) => {
          const s = String(v || '').trim();
          if (s === '16:9') return '▬';
          if (s === '4:3' || s === '3:2') return '▭';
          if (s === '1:1') return '□';
          if (s === '3:4' || s === '2:3') return '▯';
          if (s === '9:16') return '▮';
          return '◇';
        };
        const _cap = (s) => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
        const _adapter = window.ProviderRegistry?.get?.('grok');
        const _supportedRatios = _adapter?.capabilities?.supportedRatios
          || ['story', 'portrait', 'square', 'landscape', 'widescreen'];
        const _uiMap = _adapter?.capabilities?.ratioUiMap
          || { story: '9:16', portrait: '2:3', square: '1:1', landscape: '3:2', widescreen: '16:9' };
        return _supportedRatios.map(key => ({
          value: key,
          label: `${_grIcon(_uiMap[key])} ${_uiMap[key] || key} — ${_cap(key)}`,
        }));
      })(),
      // Grok video duration (chỉ video mode)
      grokDuration: [
        { value: '6s',  label: '6s' },
        { value: '10s', label: '10s' },
      ],
      // Grok video resolution (chỉ video mode)
      grokResolution: [
        { value: '480p', label: '480p' },
        { value: '720p', label: '720p' },
      ],
      // Grok image quality (Grok update 2026-04, chỉ image mode): Speed (Nhanh) / Quality (Chậm hơn nhưng đẹp hơn)
      grokImageQuality: [
        { value: 'speed',   label: window.I18n?.t('workflow.grokImageQualitySpeed')   || 'Speed' },
        { value: 'quality', label: window.I18n?.t('workflow.grokImageQualityQuality') || 'Quality' },
      ],
      // Grok KHÔNG hỗ trợ quantity → không có grokQuantity entry
    };
    const options = optionsMap[setting];
    if (!options) return;

    // Map setting key → data field name
    const fieldMap = {
      quantity: 'quantity',
      mediaType: 'media_type',
      ratio: 'ratio',
      model: 'model',
      videoDuration: 'video_duration',
      chatgptRatio: 'ratio',
      chatgptMode: 'use_fallback_prefix',
      chatgptModel: 'model',
      grokMode: 'grok_mode',
      grokRatio: 'ratio',
      grokDuration: 'grok_duration',
      grokResolution: 'grok_resolution',
      grokImageQuality: 'grok_image_quality',
    };
    const dataField = fieldMap[setting];
    // Bug fix: fallback chain đồng bộ với NodeTemplates getter (line 593: grokMode = data.grok_mode || data.mode).
    // Trước fix: legacy node chỉ có data.mode → pill hiện đúng (qua fallback) nhưng dropdown đọc
    // data.grok_mode = undefined → không match option nào → KHÔNG có check icon ở current mode.
    // Cùng pattern cho chatgptMode (use_fallback_prefix có thể có legacy fallback).
    let currentValue = data[dataField];
    if (setting === 'grokMode' && !currentValue) currentValue = data.mode;
    if (setting === 'chatgptMode' && !currentValue) currentValue = 'auto';
    if (setting === 'mediaType' && !currentValue) currentValue = 'Image';
    if (setting === 'ratio' && !currentValue) currentValue = '16:9';
    if (setting === 'grokRatio' && !currentValue) currentValue = 'widescreen';
    if (setting === 'chatgptRatio' && !currentValue) currentValue = 'story';
    if (setting === 'chatgptModel' && !currentValue) currentValue = 'Instant';
    if (setting === 'videoDuration' && !currentValue) currentValue = '6s';
    if (setting === 'grokDuration' && !currentValue) currentValue = '6s';
    if (setting === 'grokResolution' && !currentValue) currentValue = '720p';
    if (setting === 'grokImageQuality' && !currentValue) currentValue = 'speed';
    if (setting === 'quantity' && !currentValue) currentValue = 1;

    // Build dropdown
    const dropdown = document.createElement('div');
    dropdown.className = 'df-node-inline-dropdown';
    dropdown.innerHTML = options.map(opt => {
      const isActive = String(opt.value) === String(currentValue || '');
      return `
        <div class="df-node-inline-dropdown-item ${isActive ? 'active' : ''}" data-value="${this.escapeAttr(String(opt.value))}">
          <span class="check"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg></span>
          <span>${this.escapeHtml(opt.label)}</span>
        </div>
      `;
    }).join('');

    // Position near anchor
    const rect = anchorEl.getBoundingClientRect();
    dropdown.style.left = `${rect.left}px`;
    dropdown.style.top = `${rect.bottom + 4}px`;
    document.body.appendChild(dropdown);
    this._inlineDropdown = dropdown;

    // Bind item click
    dropdown.addEventListener('click', async (e) => {
      const item = e.target.closest('.df-node-inline-dropdown-item');
      if (!item) return;
      let newValue = item.dataset.value;
      // Coerce types
      if (setting === 'quantity') newValue = parseInt(newValue, 10) || 1;

      // Skip nếu value không đổi (tiết kiệm save call)
      const currentNorm = String(data[dataField] ?? '');
      const newNorm = String(newValue ?? '');
      if (currentNorm === newNorm) {
        this._hideInlineSettingDropdown();
        return;
      }

      // Loading state: disable interactions + spinner overlay trên node đang save
      const wrapperEl = this.overlay?.querySelector(`#node-${drawflowId}`);
      wrapperEl?.classList.add('df-node-saving');
      // Đóng dropdown ngay để user thấy progress trên card
      this._hideInlineSettingDropdown();

      // Flag để saveWorkflow() skip _applyNodeFormData() — tránh race condition
      // khi sidebar form của node khác đang mở
      this._inlineSaveInProgress = true;

      try {
        // Update node data + smart cascade khi đổi mediaType
        const updated = { ...data, [dataField]: newValue };

        // Cascade: đổi Image ↔ Video → CHỈ reset model nếu hiện tại không tương thích.
        // Tôn trọng deliberate choice của user (vd: chọn Veo 3.1 - Quality → giữ nguyên).
        // Strict Server-Only: model lists từ ModelRegistry, ratios từ PCM. Cache miss → empty array.
        if (setting === 'mediaType') {
          const VIDEO_MODELS = window.ModelRegistry?.getValuesList('flow', 'video') || [];
          const IMAGE_MODELS = window.ModelRegistry?.getValuesList('flow', 'image') || [];
          if (!VIDEO_MODELS.length) console.debug('[Tier3] WorkflowEditor mediaType cascade: flow.video model list empty');
          if (!IMAGE_MODELS.length) console.debug('[Tier3] WorkflowEditor mediaType cascade: flow.image model list empty');
          const rawVideoRatios = window.ProviderConfigManager?.safeGetRatiosSync('flow', 'video') || [];
          const VIDEO_RATIOS = rawVideoRatios.map(r => typeof r === 'string' ? r : (r.value || r));

          if (newValue === 'Video') {
            if (!VIDEO_MODELS.includes(updated.model)) {
              updated.model = window.ModelRegistry?.safeGetDefault('flow', 'video') || null;
            }
            if (!updated.video_input_type) {
              // 2026-05-29: đọc default từ StorageSettings (admin tune qua /admin/default-settings)
              const settingDefault = window.storageSettings?.get?.('defaultVideoInputType');
              updated.video_input_type = (settingDefault === 'Ingredients' || settingDefault === 'Frames')
                ? settingDefault : 'Frames';
            }
            if (!updated.video_duration) updated.video_duration = '6s';
            if (VIDEO_RATIOS.length && !VIDEO_RATIOS.includes(updated.ratio)) {
              updated.ratio = VIDEO_RATIOS[0];
            }
          } else if (newValue === 'Image') {
            if (!IMAGE_MODELS.includes(updated.model)) {
              updated.model = window.ModelRegistry?.safeGetDefault('flow', 'image') || null;
            }
            delete updated.video_input_type;
          }
        }

        editor.updateNodeDataFromId(drawflowId, updated);

        // Resize port count nếu setting ảnh hưởng visibility (mediaType, video_input_type, grokMode)
        // Image: 2 in (image_ref, text), 1 out. Video+Frames: thêm frame_1, frame_2 inputs.
        // grokMode: count không đổi nhưng port type out chuyển image ↔ video → cần re-inject attributes.
        // Bug fix: Ưu tiên updated.node_type (data) over node.class (có thể bị corrupt)
        const nodeType = updated.node_type || node.class || 'generate';
        if ((setting === 'mediaType' || setting === 'videoInputType' || setting === 'grokMode')
            && this.diagramCanvas?._resizeNodePorts
            && window.NodeTemplates?.getNodePorts) {
          const newPorts = window.NodeTemplates.getNodePorts(nodeType, updated);
          this.diagramCanvas._resizeNodePorts(drawflowId, newPorts);
        }

        // Re-validate edges sau khi data đổi — đặc biệt khi toggle mediaType/grokMode làm port out
        // chuyển type (image ↔ video) → edges tới input incompat phải gỡ.
        // Idempotent: chỉ gỡ edges thực sự incompat, edges legacy (không _port_map) skip.
        if (setting === 'mediaType' || setting === 'grokMode') {
          try {
            const removedCount = this._revalidateNodeEdges(drawflowId);
            if (removedCount > 0) {
              const msg = window.I18n?.t('workflow.edgesRemovedOnTypeChange', { count: removedCount })
                || `Đã gỡ ${removedCount} kết nối không tương thích sau khi đổi loại media`;
              if (typeof window.showNotification === 'function') {
                window.showNotification(msg, 'warning', 2500);
              }
              // Re-color edges (vì có thể edge cũ giữ màu cũ; helper tự skip nếu null)
              try { this.diagramCanvas?._recolorAllEdges?.(); } catch (e) {}
            }
          } catch (e) {
            console.warn('[WorkflowEditor] Re-validate edges failed:', e);
          }
        }

        // Re-render node HTML để pill hiển thị value mới
        const nodeEl = this.overlay?.querySelector(`#node-${drawflowId} .drawflow_content_node`);
        if (nodeEl && window.NodeTemplates) {
          nodeEl.innerHTML = window.NodeTemplates.createNodeHTML(nodeType, updated);
          // Re-inject port attributes (giữ Drawflow drag work)
          if (this.diagramCanvas?._injectPortAttributes) {
            const ports = window.NodeTemplates.getNodePorts(nodeType, updated);
            requestAnimationFrame(() => this.diagramCanvas._injectPortAttributes(drawflowId, ports));
          }
          // Re-bind pill click handlers vì innerHTML rebuild xóa hết listeners cũ
          try { this._bindInlineSettingPills(); } catch (e) {}
          // Refresh warning badges + port empty state sau khi port count thay đổi
          try { this._scheduleRefreshNodeWarningBadges(); } catch (e) {}
          try { this._updatePortEmptyState(); } catch (e) {}

          // Connection paths phải recompute sau khi card layout đổi (vd ratio 9:16 ↔ 16:9 → preview area
          // height đổi → port positions đổi). Defer 2 frames cho DOM settle (CSS aspect-ratio + reflow).
          try {
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                try { this.diagramCanvas?._forceUpdateAllConnections?.(); } catch (e) {}
              });
            });
          } catch (e) {}

          // CRITICAL: innerHTML rebuild reset preview placeholder → MẤT thumbnails đã render.
          // Re-render result + ref previews bằng node_id (logic node) thay vì drawflowId.
          const logicNodeId = updated.node_id;
          if (logicNodeId) {
            // Normal mode: result_file_ids, ref_file_ids
            const resultIds = (updated.result_file_ids || '').split(',').map(s => s.trim()).filter(Boolean);
            if (resultIds.length > 0 && typeof this._showNodePreview === 'function') {
              try { this._showNodePreview(logicNodeId, resultIds); } catch (e) {}
            }
            const refIds = (updated.ref_file_ids || '').split(',').map(s => s.trim()).filter(Boolean);
            if (refIds.length > 0 && typeof this._showNodeRefPreview === 'function') {
              try { this._showNodeRefPreview(logicNodeId, refIds); } catch (e) {}
            }

            // Template mode: result_img_url, ref_img_urls (URLs thay vì file IDs)
            const isTemplateCtx = this.isTemplateMode || this.workflow?._is_template_preview || this.workflow?._isPreview;
            if (isTemplateCtx) {
              if (updated.result_img_url && typeof this._renderTemplateResultOnNode === 'function') {
                try { this._renderTemplateResultOnNode(logicNodeId, updated.result_img_url); } catch (e) {}
              }
              const refUrls = updated.ref_img_urls || Object.values(updated.ref_thumbnails || {});
              if (refUrls?.length > 0 && typeof this._renderTemplateRefOnNode === 'function') {
                try { this._renderTemplateRefOnNode(logicNodeId, refUrls); } catch (e) {}
              }
            }
          }
        }

        // Chỉ re-render sidebar form nếu panel đang THỰC SỰ mở cho node này.
        // KHÔNG dùng selectedNodeId làm proxy vì Drawflow set nó khi user chỉ click highlight node
        // (chưa mở form). Quick-edit không nên auto-mở sidebar — phá UX.
        const formPanel = this.overlay?.querySelector('#nodeFormPanel');
        const isPanelOpen = formPanel && !formPanel.classList.contains('hidden');
        if (isPanelOpen && String(this.selectedNodeId) === String(drawflowId)) {
          try { this.showNodeForm(drawflowId); } catch (e) {}
        }

        // Auto-save workflow với debounce (800ms) — tránh 429 khi user thay đổi nhanh nhiều settings
        this._hasUnsavedChanges = true;
        // Template mode: KHÔNG auto-save vì workflow chưa tồn tại trong DB
        if (!this.isTemplateMode) {
          // Debounce: cancel pending save, schedule new one after 800ms
          if (this._inlineSaveTimer) clearTimeout(this._inlineSaveTimer);
          this._inlineSaveTimer = setTimeout(async () => {
            this._inlineSaveTimer = null;
            // Wait for any concurrent save to finish
            if (this._isSaving) {
              const waitStart = Date.now();
              while (this._isSaving && Date.now() - waitStart < 5000) {
                await new Promise(r => setTimeout(r, 100));
              }
            }
            try {
              await this.saveWorkflow();
              if (typeof window.showNotification === 'function') {
                window.showNotification(
                  window.I18n?.t('workflow.settingSaved') || 'Setting saved',
                  'success', 1500
                );
              }
            } catch (e) {
              console.error('[WorkflowEditor] Debounced inline save failed:', e);
              if (typeof window.showNotification === 'function') {
                window.showNotification(
                  (window.I18n?.t('workflow.settingSaveFailed') || 'Save failed: ') + e.message,
                  'error'
                );
              }
            }
          }, 800);
        } else {
          // Template mode: chỉ show notification là có thay đổi chưa lưu
          if (typeof window.showNotification === 'function') {
            window.showNotification(
              window.I18n?.t('workflow.templateSettingsChanged') || 'Updated. Press Save to save to database.',
              'info', 2000
            );
          }
        }
      } catch (err) {
        console.error('[WorkflowEditor] Inline setting save failed:', err);
        if (typeof window.showNotification === 'function') {
          window.showNotification(
            (window.I18n?.t('workflow.settingSaveFailed') || 'Lỗi lưu cài đặt: ') + err.message,
            'error'
          );
        }
      } finally {
        // Reset flag — inline save hoàn tất
        this._inlineSaveInProgress = false;
        // Always remove loading class, kể cả khi error — re-query vì wrapperEl có thể stale
        const w = this.overlay?.querySelector(`#node-${drawflowId}`);
        w?.classList.remove('df-node-saving');
      }
    });

    // Close on outside click — Self-cleanup nếu dropdown KHÔNG còn là current
    // (tránh handler stale từ dropdown cũ đóng nhầm dropdown mới khi mở liên tục)
    setTimeout(() => {
      const outsideHandler = (ev) => {
        // Dropdown này không còn active → tự cleanup, không can thiệp dropdown mới
        if (this._inlineDropdown !== dropdown || !dropdown.isConnected) {
          document.removeEventListener('mousedown', outsideHandler);
          return;
        }
        if (!dropdown.contains(ev.target)) {
          this._hideInlineSettingDropdown();
          document.removeEventListener('mousedown', outsideHandler);
        }
      };
      document.addEventListener('mousedown', outsideHandler);
    }, 50);
  }

  _hideInlineSettingDropdown() {
    if (this._inlineDropdown) {
      this._inlineDropdown.remove();
      this._inlineDropdown = null;
    }
  }

  /**
   * Phase WK-1.2 enhancement: Bind click trên empty Drawflow native ports → mở node picker
   * với filter theo port type tương thích. Auto-connect sau khi user chọn node.
   */
  _bindEmptyPortClicks() {
    const container = this.overlay?.querySelector('#diagramContainer');
    if (!container || container._wfEmptyPortBound) return;
    container._wfEmptyPortBound = true;

    // Bug 2 fix: dùng mousedown thay vì click vì Drawflow drag bind mousedown.
    // Nếu không có drag motion → cancel tại mouseup → trigger picker.
    let pressedPortEl = null;
    let pressedAt = null;
    let pressedX = 0, pressedY = 0;

    // Helper: trigger picker từ empty port element.
    // Tách reusable để dùng cho cả mouseup pattern + click fallback.
    const triggerPicker = (portEl, container) => {
      const side = portEl.getAttribute('data-port-side') || (portEl.classList.contains('input') ? 'in' : 'out');
      const portType = portEl.getAttribute('data-port-type');
      const portName = portEl.getAttribute('data-port-name');
      const portLabel = portEl.getAttribute('data-port-label') || portName;

      const nodeEl = portEl.closest('.drawflow-node');
      const drawflowId = nodeEl?.id?.replace('node-', '') || null;
      const classNames = portEl.className.split(/\s+/);
      const portClass = classNames.find(c => /^(input|output)_\d+$/.test(c));
      const portIndex = portClass ? parseInt(portClass.split('_')[1], 10) : 1;
      if (!drawflowId || !portType) return false;

      const rect = portEl.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      const offsetX = side === 'in' ? -280 : 30;
      const posX = rect.left - containerRect.left + offsetX;
      const posY = rect.top - containerRect.top;

      this._showNodePicker(posX, posY, null, {
        side, portType, portName, portLabel, portIndex,
        sourceNodeDrawflowId: drawflowId,
      });
      return true;
    };

    container.addEventListener('mousedown', (e) => {
      const portEl = e.target.closest('.drawflow .input[data-port-type], .drawflow .output[data-port-type]');
      if (!portEl) {
        pressedPortEl = null;
        return;
      }
      // Check empty trực tiếp từ Drawflow node data (không phụ thuộc data-port-empty attribute)
      if (this._isPortEmpty(portEl) === false) {
        pressedPortEl = null;
        return; // Port có connection → để Drawflow xử lý drag
      }
      pressedPortEl = portEl;
      pressedAt = Date.now();
      pressedX = e.clientX;
      pressedY = e.clientY;
    }, true);

    container.addEventListener('mouseup', (e) => {
      if (!pressedPortEl) return;
      const dx = Math.abs(e.clientX - pressedX);
      const dy = Math.abs(e.clientY - pressedY);
      const dt = Date.now() - pressedAt;
      const portEl = pressedPortEl;
      pressedPortEl = null;
      // Drag detected (>8px movement) → để Drawflow xử lý connection
      // Threshold 8px để tránh false positive khi user click thường có jitter pixel
      if (dx > 8 || dy > 8) return;
      if (dt > 500) return; // long press không phải click

      // Bug fix (port click vs Drawflow drag): Khi user mousedown trên empty OUTPUT port,
      // Drawflow đã start `drawConnection` (vẽ ghost link từ port). Giờ mouseup không có movement
      // → cần cancel ghost link để picker hiển thị độc lập, tránh user thấy 2 UI cùng lúc.
      const editor = this.diagramCanvas?.editor;
      if (editor?.connection && editor.connection_ele) {
        try { editor.connection_ele.remove(); } catch (er) {}
        editor.connection_ele = null;
        editor.connection = false;
        editor.ele_selected = null;
      }

      const ok = triggerPicker(portEl, container);
      if (ok) {
        e.stopPropagation();
        e.preventDefault();
      }
    }, true);

    // Fallback: click event (bubble phase). Bắt trường hợp mouseup capture missed
    // (vd Drawflow stop propagation trước capture, hoặc port DOM bị re-render giữa down/up).
    container.addEventListener('click', (e) => {
      // Skip nếu mousedown handler đã trigger (pressedPortEl đã clear)
      const portEl = e.target.closest('.drawflow .input[data-port-type], .drawflow .output[data-port-type]');
      if (!portEl) return;
      if (!this._isPortEmpty(portEl)) return;
      // Skip nếu picker vừa mới được mở (trong 100ms qua) — tránh open 2 lần
      if (this._lastPickerOpenAt && Date.now() - this._lastPickerOpenAt < 200) return;
      const editor = this.diagramCanvas?.editor;
      if (editor?.connection && editor.connection_ele) {
        try { editor.connection_ele.remove(); } catch (er) {}
        editor.connection_ele = null;
        editor.connection = false;
        editor.ele_selected = null;
      }
      const ok = triggerPicker(portEl, container);
      if (ok) {
        this._lastPickerOpenAt = Date.now();
        e.stopPropagation();
        e.preventDefault();
      }
    }, true);
  }

  /**
   * Phase enhancement: check port có connection không qua Drawflow node data.
   *
   * CRITICAL FIX: Drawflow `removeNodeId(B)` chỉ xóa SVG path + entry of B trong data,
   * KHÔNG cleanup connection refs trong `inputs/outputs[port].connections` của peer nodes.
   * → A.outputs.output_1.connections vẫn chứa dead ref tới B → port hiển thị "có link" nhưng
   * thực tế B đã không tồn tại → picker không mở khi user click.
   *
   * Filter dead refs (target node không còn trong editor) trước khi check empty.
   */
  _isPortEmpty(portEl) {
    if (!portEl) return false;
    const editor = this.diagramCanvas?.editor;
    const nodeEl = portEl.closest('.drawflow-node');
    const drawflowId = nodeEl?.id?.replace('node-', '');
    if (!editor || !drawflowId) return true;
    const node = editor.getNodeFromId(drawflowId);
    if (!node) return true;
    const classNames = portEl.className.split(/\s+/);
    const portClass = classNames.find(c => /^(input|output)_\d+$/.test(c));
    if (!portClass) return true;
    const isInput = portEl.classList.contains('input');
    const portData = isInput ? node.inputs?.[portClass] : node.outputs?.[portClass];
    const rawConns = portData?.connections || [];
    // Filter dead refs: connection trỏ tới node không tồn tại
    const liveConns = rawConns.filter(c => {
      const targetId = c.node;
      if (!targetId) return false;
      try {
        const targetNode = editor.getNodeFromId(targetId);
        return !!targetNode;
      } catch (e) {
        return false;
      }
    });
    return liveConns.length === 0;
  }

  /**
   * Cleanup dead connection refs trong inputs/outputs của ALL remaining nodes
   * sau khi 1 node bị xóa.
   *
   * Drawflow `removeNodeId(B)` chỉ xóa SVG paths + entry of B, KHÔNG xóa references
   * trong `inputs[input_X].connections` / `outputs[output_X].connections` của peer nodes.
   * → A.outputs.output_1.connections vẫn = [{node: B, output: 'input_1'}] dù B không tồn tại.
   *
   * Pass 1 lần qua all nodes, filter ra connections trỏ tới deletedNodeId.
   * Idempotent + safe để gọi nhiều lần.
   */
  _cleanupDeadConnectionRefs(deletedNodeId) {
    const editor = this.diagramCanvas?.editor;
    if (!editor || !deletedNodeId) return;
    const data = editor.drawflow?.drawflow?.Home?.data;
    if (!data) return;
    const targetId = String(deletedNodeId);
    for (const [_id, node] of Object.entries(data)) {
      // Outputs (point tới input của other nodes)
      const outputs = node.outputs || {};
      for (const port of Object.values(outputs)) {
        if (Array.isArray(port.connections)) {
          port.connections = port.connections.filter(c => String(c.node) !== targetId);
        }
      }
      // Inputs (point từ output của other nodes)
      const inputs = node.inputs || {};
      for (const port of Object.values(inputs)) {
        if (Array.isArray(port.connections)) {
          port.connections = port.connections.filter(c => String(c.node) !== targetId);
        }
      }
    }
  }

  /**
   * Phase WK-1.2 enhancement: Update data-port-empty cho mỗi port theo connection state.
   * Gọi sau load + connection created/removed.
   */
  _updatePortEmptyState() {
    const editor = this.diagramCanvas?.editor;
    if (!editor) return;
    try {
      const data = editor.export();
      const nodes = data?.drawflow?.Home?.data || {};
      for (const [drawflowId, nodeInfo] of Object.entries(nodes)) {
        const inputs = nodeInfo.inputs || {};
        const outputs = nodeInfo.outputs || {};
        for (const [inputClass, inputData] of Object.entries(inputs)) {
          const portEl = document.querySelector(`#node-${drawflowId} .input.${inputClass}[data-port-type]`);
          if (portEl) {
            const isEmpty = !(inputData.connections || []).length;
            portEl.setAttribute('data-port-empty', isEmpty ? 'true' : 'false');
          }
        }
        for (const [outputClass, outputData] of Object.entries(outputs)) {
          const portEl = document.querySelector(`#node-${drawflowId} .output.${outputClass}[data-port-type]`);
          if (portEl) {
            const isEmpty = !(outputData.connections || []).length;
            portEl.setAttribute('data-port-empty', isEmpty ? 'true' : 'false');
          }
        }
      }
    } catch (e) { /* swallow */ }
  }

  _hideNodePicker() {
    if (this._nodePicker) {
      this._nodePicker.remove();
      this._nodePicker = null;
      this._nodePickerSource = null;
    }
  }

  /**
   * Tạo node mới từ NodePicker.
   *
   * Auto-connect được xử lý qua portContext flow (`_autoConnectFromPortContext`) —
   * KHÔNG còn fallback `addConnection(sourceId, newId, 'output_1', 'input_1')` cứng
   * (cũ: ghép sai port khi source có nhiều outputs hoặc port type khác).
   *
   * sourceNodeId param giữ lại cho backward-compat (legacy callers) — log warning nếu truyền
   * vì giờ nên dùng portContext + _autoConnectFromPortContext.
   */
  async _createNodeFromPicker(type, posX, posY, sourceNodeId) {
    if (!this.diagramCanvas) return null;

    // Đọc user settings từ storage để áp dụng default model/ratio cho node mới
    const afSettings = await new Promise(resolve => {
      chrome.storage.local.get(['af_settings'], r => resolve(r.af_settings || {}));
    });

    const nodeName = this._generateUniqueNodeName(type);
    const nodeData = {
      ...NodeTemplates.getDefaults(type, afSettings),
      node_name: nodeName,
      node_type: type
    };
    // Phase 1 — Node Reference System: Auto-generate slug for mentionable nodes
    if (this._isMentionableNodeType(type)) {
      nodeData.slug = this._generateSlug(nodeName);
      nodeData.slug_auto = true;
    }
    const newId = this.diagramCanvas.addNode(type, posX, posY, nodeData);
    if (newId) {
      this._hasUnsavedChanges = true;
      // Refresh UI sau khi thêm node
      requestAnimationFrame(() => {
        try { this._scheduleRefreshNodeWarningBadges(); } catch (err) {}
        try { this._updatePortEmptyState(); } catch (err) {}
        try { this._bindInlineSettingPills(); } catch (err) {}
      });
    }
    if (sourceNodeId && newId) {
      console.warn('[WorkflowEditor] _createNodeFromPicker received sourceNodeId — auto-connect handled via portContext flow now');
    }
    return newId;
  }

  // === Node Form Panel Resize ===

  _bindNodeFormResize() {
    const handle = this.overlay?.querySelector('#nodeFormResizeHandle');
    const panel = this.overlay?.querySelector('#nodeFormPanel');
    if (!handle || !panel) return;

    let startX = 0;
    let startWidth = 0;
    let isDragging = false;

    const onMouseDown = (e) => {
      e.preventDefault();
      isDragging = true;
      startX = e.clientX;
      startWidth = panel.offsetWidth;
      handle.classList.add('dragging');
      document.body.style.cursor = 'ew-resize';
      document.body.style.userSelect = 'none';
    };

    const onMouseMove = (e) => {
      if (!isDragging) return;
      // Panel ở bên phải, kéo sang trái = tăng width
      const delta = startX - e.clientX;
      let newWidth = startWidth + delta;
      // Clamp trong min/max
      newWidth = Math.max(260, Math.min(500, newWidth));
      panel.style.width = newWidth + 'px';
    };

    const onMouseUp = () => {
      if (!isDragging) return;
      isDragging = false;
      handle.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      // Save width to storage for persistence
      const currentWidth = panel.offsetWidth;
      chrome.storage?.local?.set({ nodeFormPanelWidth: currentWidth });
    };

    handle.addEventListener('mousedown', onMouseDown);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);

    // Store refs for cleanup
    this._resizeHandlers = { handle, onMouseDown, onMouseMove, onMouseUp };

    // Restore saved width
    chrome.storage?.local?.get(['nodeFormPanelWidth'], (res) => {
      if (res.nodeFormPanelWidth && panel) {
        const savedWidth = Math.max(260, Math.min(500, res.nodeFormPanelWidth));
        panel.style.width = savedWidth + 'px';
      }
    });
  }

  _unbindNodeFormResize() {
    if (this._resizeHandlers) {
      const { handle, onMouseDown, onMouseMove, onMouseUp } = this._resizeHandlers;
      handle?.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      this._resizeHandlers = null;
    }
  }

  // === Keyboard Shortcuts ===

  _bindKeyboardShortcuts() {
    this._keyHandler = (e) => {
      if (!this.overlay) return;

      // Ctrl+S / Cmd+S → save workflow. Catch BEFORE input/textarea exemption →
      // user có thể save dù đang focus inline prompt textarea / form input.
      // Always preventDefault → tránh browser "Save Page As" dialog.
      // Debounce 800ms để coalesce spam Ctrl+S liên tiếp (mỗi save trigger ~1s+ API
      // call → user spam Ctrl+S sẽ stack save calls + race condition).
      const isModS = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && !e.shiftKey && !e.altKey;
      if (isModS) {
        e.preventDefault();
        e.stopPropagation();
        if (this.isReadOnly()) return; // read-only: chỉ block browser dialog
        this._triggerSaveWorkflowDebounced();
        return;
      }

      // Don't capture if typing in input/textarea
      if (e.target.matches('input, textarea, [contenteditable]')) {
        // But allow Escape in node picker input
        if (e.key === 'Escape' && this._nodePicker) {
          this._hideNodePicker();
          return;
        }
        return;
      }

      if (e.key === 'Escape') {
        if (this._nodePicker) {
          this._hideNodePicker();
        } else if (this.selectedNodeId) {
          this.hideNodeForm();
        } else {
          this.close();
        }
        return;
      }
      // Read-only mode: chỉ cho phép Escape (đã handle ở trên) + F (fit screen — không modify)
      // Block tất cả shortcut có thể modify workflow.
      const readOnly = this.isReadOnly();

      if ((e.key === 'n' || e.key === 'N') && !readOnly) {
        e.preventDefault();
        // Smart placement: spawn node near mouse position instead of center
        const rect = this.overlay.querySelector('#diagramContainer')?.getBoundingClientRect();
        const fallbackX = rect ? rect.width / 2 : 200;
        const fallbackY = rect ? rect.height / 2 : 200;
        const posX = this._lastMouseCanvasPos?.x ?? fallbackX;
        const posY = this._lastMouseCanvasPos?.y ?? fallbackY;
        this._showNodePicker(posX, posY);
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && !readOnly) {
        if (this.selectedNodeId) {
          // Cancel active uploads trước khi xóa node
          if (this._formUploadKeys?.size > 0 && window.ImmediateUploader) {
            for (const key of this._formUploadKeys) {
              ImmediateUploader.cancel(key);
            }
          }
          this.diagramCanvas?.removeNode(this.selectedNodeId);
          this._formUploadKeys?.clear();
          this.hideNodeForm();
        }
      }
      if (e.key === 'f' || e.key === 'F') {
        // Fit to screen — không modify workflow → cho phép cả ở read-only
        e.preventDefault();
        this.diagramCanvas?.fitToScreen?.();
      }
      if (e.ctrlKey && e.key === 'Enter' && !readOnly) {
        e.preventDefault();
        this._runWorkflowFromEditor();
      }
      // Ctrl+S đã handle ở đầu keyHandler (catch cả khi focus input/textarea).

      // v1.1 Node clipboard: Ctrl+C / Cmd+C copy selected node
      const isMod = e.metaKey || e.ctrlKey;
      const lowerKey = e.key.toLowerCase();

      // [Bug fix 2026-05-31] Skip node-clipboard shortcuts (Ctrl+C/D/V) khi focus đang ở
      // trong right sidebar form panel — user đang edit settings, KHÔNG muốn intercept
      // native copy/paste text. Đặc biệt với Ctrl+C: user click vào label/help text trong
      // form rồi select → focus rơi vào span/div (không match guard input/textarea ở trên)
      // → trigger copy node sai mong đợi. Cũng skip khi có text selection trong document
      // (user đang highlight text muốn copy).
      const formPanel = this.overlay?.querySelector('#nodeFormPanel');
      const focusInForm = formPanel && !formPanel.classList.contains('hidden') && formPanel.contains(e.target);
      const hasTextSelection = (() => {
        try {
          const sel = window.getSelection?.();
          return sel && sel.toString().length > 0;
        } catch (_) { return false; }
      })();

      if (isMod && lowerKey === 'c' && !readOnly && !e.shiftKey && !e.altKey) {
        // Skip copy-node nếu user đang edit form HOẶC đang select text — để native copy fire
        if (focusInForm || hasTextSelection) return;
        if (this.selectedNodeId) {
          e.preventDefault();
          this._copyNodeToClipboard(this.selectedNodeId);
        }
      }
      // v1.1 Ctrl+D / Cmd+D duplicate selected node (parity với menu shortcut ⌘D)
      if (isMod && lowerKey === 'd' && !readOnly && !e.shiftKey && !e.altKey) {
        // Skip nếu focus trong form — browser default Ctrl+D (bookmark) ít quan trọng,
        // nhưng tránh duplicate node bất ngờ khi user đang focus settings panel.
        if (focusInForm) return;
        if (this.selectedNodeId) {
          e.preventDefault();
          const drawflowId = this._findDrawflowId(this.selectedNodeId);
          if (drawflowId) {
            const newId = this.diagramCanvas?.duplicateNode?.(drawflowId);
            if (newId) {
              const newNode = this.diagramCanvas?.editor?.getNodeFromId(newId);
              if (newNode?.data) {
                window.eventBus?.emit('node:duplicated', { drawflowId: newId, data: newNode.data, sourceDrawflowId: drawflowId });
              }
              this._hasUnsavedChanges = true;
            }
          }
        }
      }
      // v1.1 Ctrl+V / Cmd+V paste node (ưu tiên hơn paste image clipboard).
      // Paste image vẫn hoạt động qua `_bindCanvasPasteHandler` (paste event) khi
      // _nodeClipboard rỗng — handler đó tự check.
      if (isMod && lowerKey === 'v' && !readOnly && !e.shiftKey && !e.altKey) {
        // Skip paste-node nếu focus trong form — user đang paste text vào textarea/input
        if (focusInForm) return;
        if (this._nodeClipboard?.data) {
          e.preventDefault();
          this._pasteNodeFromClipboard();
        }
      }
    };
    document.addEventListener('keydown', this._keyHandler);
  }

  /**
   * Ctrl+S save workflow với debounce + concurrency guard.
   * - Trailing debounce 800ms: spam Ctrl+S liên tiếp chỉ trigger 1 save sau lần cuối
   * - Concurrency lock: nếu save đang chạy, skip + retry sau khi xong (set flag pending)
   * - Show toast feedback sau save success/fail
   */
  _triggerSaveWorkflowDebounced() {
    // Concurrency: nếu save đang chạy, mark pending → retry sau khi xong
    if (this._isSaving) {
      this._ctrlSPending = true;
      return;
    }
    // Trailing debounce: spam chỉ trigger save 800ms sau lần cuối
    if (this._ctrlSDebounceTimer) clearTimeout(this._ctrlSDebounceTimer);
    this._ctrlSDebounceTimer = setTimeout(async () => {
      this._ctrlSDebounceTimer = null;
      try {
        let saved = false;
        if (this.isTemplateMode) {
          if (this.templateId) await this._updateTemplate?.();
          else await this._createTemplate?.();
          saved = true; // template path: assume saved (helpers handle errors)
        } else {
          saved = await this.saveWorkflow();
        }
        if (saved) {
          window.showNotification?.(
            window.I18n?.t?.('workflow.saveSuccess') || 'Đã lưu workflow',
            'success', 1500
          );
        }
      } catch (err) {
        console.warn('[WorkflowEditor] Ctrl+S save failed:', err?.message);
      } finally {
        // Process pending save nếu user nhấn Ctrl+S thêm trong khi save chạy
        if (this._ctrlSPending) {
          this._ctrlSPending = false;
          setTimeout(() => this._triggerSaveWorkflowDebounced(), 100);
        }
      }
    }, 800);
  }

  _unbindKeyboardShortcuts() {
    // Clear pending Ctrl+S debounce timer khi editor close
    if (this._ctrlSDebounceTimer) {
      clearTimeout(this._ctrlSDebounceTimer);
      this._ctrlSDebounceTimer = null;
    }
    this._ctrlSPending = false;
    if (this._keyHandler) {
      document.removeEventListener('keydown', this._keyHandler);
      this._keyHandler = null;
    }
  }

  _showWorkflowSettings() {
    if (!this.workflow) return;

    // EWT-6: Trong template mode, hiển thị Template Settings Modal thay vì Workflow Settings
    if (this.isTemplateMode) {
      this._showTemplateSettingsModal();
      return;
    }

    const settings = this.workflow.settings_json || this.workflow.settings || {};
    const dialog = document.createElement('div');
    dialog.className = 'tobyflow-wf-settings-overlay';
    dialog.innerHTML = `
      <div class="tobyflow-wf-settings-dialog">
        <div class="tobyflow-wf-settings-header">
          <h3>${window.I18n?.t('workflow.settings') || 'Workflow Settings'}</h3>
          <button class="tobyflow-wf-settings-close" title="${window.I18n?.t('common.close') || 'Close'}">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <div class="tobyflow-wf-settings-body">
          <div class="tobyflow-wf-settings-group">
            <label>${window.I18n?.t('workflow.workflowName') || 'Tên workflow'}</label>
            <input type="text" id="wfSettingsName" value="${this.escapeAttr(this.workflow.wf_name || '')}" placeholder="${window.I18n?.t('workflow.workflowName') || 'Tên workflow'}">
          </div>
          <div class="tobyflow-wf-settings-group">
            <label>${window.I18n?.t('workflow.description') || 'Mô tả'}</label>
            <textarea id="wfSettingsDesc" rows="2" placeholder="${window.I18n?.t('workflow.shortDescription') || 'Mô tả ngắn'}">${this.escapeHtml(this.workflow.description || '')}</textarea>
          </div>
          <div class="tobyflow-wf-settings-divider">${window.I18n?.t('workflow.execution') || 'Thực thi'}</div>
          <div class="tobyflow-wf-settings-group tobyflow-wf-settings-row">
            <label>${window.I18n?.t('workflow.delayBetweenNodes') || 'Chờ giữa các node'}</label>
            <div class="tobyflow-wf-settings-input-group">
              <input type="number" id="wfSettingsDelay" value="${settings.delay_between_nodes || 3}" min="1" max="60"> <span>${window.I18n?.t('workflow.seconds') || 'giây'}</span>
            </div>
          </div>
          <div class="tobyflow-wf-settings-group tobyflow-wf-settings-row">
            <label>${window.I18n?.t('workflow.retryOnError') || 'Thử lại khi lỗi'}</label>
            <div class="tobyflow-wf-settings-input-group">
              <input type="number" id="wfSettingsRetry" value="${settings.max_retries || 2}" min="0" max="5"> <span>${window.I18n?.t('workflow.times') || 'lần'}</span>
            </div>
          </div>
          <div class="tobyflow-wf-settings-group tobyflow-wf-settings-row">
            <label>${window.I18n?.t('workflow.timeoutPerNode') || 'Timeout mỗi node'}</label>
            <div class="tobyflow-wf-settings-input-group">
              <input type="number" id="wfSettingsTimeout" value="${settings.timeout || 180}" min="30" max="600"> <span>${window.I18n?.t('workflow.seconds') || 'giây'}</span>
            </div>
          </div>
          <div class="tobyflow-wf-settings-group">
            <label class="toolbar-toggle" for="wfSettingsParallel">
              <input type="checkbox" id="wfSettingsParallel" ${settings.parallel_execution ? 'checked' : ''} />
              <span class="toggle-track"><span class="toggle-thumb"></span></span>
              <span class="toggle-label">${window.I18n?.t('workflow.parallelExecution') || 'Chạy song song nodes cùng level'}</span>
            </label>
          </div>
          <div class="tobyflow-wf-settings-group">
            <label class="toolbar-toggle" for="wfSettingsStopOnError">
              <input type="checkbox" id="wfSettingsStopOnError" ${settings.stop_on_error ? 'checked' : ''} />
              <span class="toggle-track"><span class="toggle-thumb"></span></span>
              <span class="toggle-label">${window.I18n?.t('workflow.stopOnError') || 'Dừng khi lỗi'}</span>
            </label>
          </div>
        </div>
        <div class="tobyflow-wf-settings-footer">
          <button class="btn btn-secondary" id="wfSettingsCancel">${window.I18n?.t('common.cancel') || 'Hủy'}</button>
          <button class="btn btn-primary" id="wfSettingsSave">${window.I18n?.t('workflow.saveSettings') || 'Lưu cài đặt'}</button>
        </div>
      </div>
    `;

    this.overlay.appendChild(dialog);

    // Check retry_on_fail feature - disable input nếu không có quyền
    chrome.storage.local.get('af_entitlements', (result) => {
      const entitlements = result.af_entitlements?.entitlements || {};
      const retryFeature = entitlements.retry_on_fail;
      const canUseRetry = retryFeature?.value === '1' || retryFeature?.value === 1;
      const retryInput = dialog.querySelector('#wfSettingsRetry');
      if (retryInput && !canUseRetry) {
        retryInput.disabled = true;
        retryInput.value = '0';
        retryInput.title = window.I18n?.t('workflow.retryUpgradeRequired') || 'Nâng cấp tài khoản để sử dụng tính năng thử lại';
        const group = retryInput.closest('.tobyflow-wf-settings-group');
        group?.classList.add('feature-disabled');
        // Add crown icon inside label (inline with text, stays next to label in flex row)
        if (group && !group.querySelector('.premium-crown')) {
          const crown = document.createElement('span');
          crown.className = 'premium-crown';
          crown.innerHTML = window.featureGate?.renderCrownHTML?.('retry_on_fail')
            || '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M5 16L3 5L8.5 10L12 4L15.5 10L21 5L19 16H5ZM19 19C19 19.6 18.6 20 18 20H6C5.4 20 5 19.6 5 19V18H19V19Z"></path></svg> Premium';
          const lbl = window.featureGate?.getCrownLabel?.('retry_on_fail');
          if (lbl) crown.title = lbl;
          const label = group.querySelector('label');
          if (label) {
            label.appendChild(crown);
          } else {
            group.appendChild(crown);
          }
        }
      }
    });

    dialog.querySelector('.tobyflow-wf-settings-close')?.addEventListener('click', () => dialog.remove());
    dialog.querySelector('#wfSettingsCancel')?.addEventListener('click', () => dialog.remove());
    dialog.querySelector('#wfSettingsSave')?.addEventListener('click', async () => {
      this.workflow.wf_name = dialog.querySelector('#wfSettingsName')?.value || this.workflow.wf_name;
      this.workflow.description = dialog.querySelector('#wfSettingsDesc')?.value || '';
      this.workflow.settings_json = {
        delay_between_nodes: parseInt(dialog.querySelector('#wfSettingsDelay')?.value) || 3,
        max_retries: parseInt(dialog.querySelector('#wfSettingsRetry')?.value) || 2,
        timeout: parseInt(dialog.querySelector('#wfSettingsTimeout')?.value) || 180,
        stop_on_error: dialog.querySelector('#wfSettingsStopOnError')?.checked || false,
        parallel_execution: dialog.querySelector('#wfSettingsParallel')?.checked || false
      };
      // Update header name input
      const nameInput = this.overlay?.querySelector('#workflowName');
      if (nameInput) nameInput.value = this.workflow.wf_name;
      dialog.remove();
      // Save workflow to storage (including settings changes)
      await this.saveWorkflow();
    });

    // Click outside to close
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog) dialog.remove();
    });
  }

  /**
   * EWT-6: Hiển thị Template Settings Modal
   * Cho phép chỉnh sửa metadata của template: name, description, thumbnail, category, premium, featured
   */
  async _showTemplateSettingsModal() {
    if (!this.templateData) {
      this.templateData = {
        name: this.workflow?.wf_name || '',
        description: this.workflow?.description || '',
        category_id: null,
        thumbnail_url: null,
        video_url: null,
        is_premium: false,
        is_featured: false,
        is_published: true, // Default to published for new templates
      };
    }

    const t = (key, fallback) => {
      const val = window.I18n?.t?.(key);
      return val && val !== key ? val : (fallback || key);
    };

    // Fetch categories từ API
    let categories = [];
    try {
      const response = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({
          action: 'apiRequest',
          method: 'GET',
          endpoint: 'workflow-templates/categories'
        }, (resp) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (resp?.success && resp?.data) {
            resolve(resp.data);
          } else {
            reject(new Error(resp?.error?.message || 'Không lấy được danh mục'));
          }
        });
      });
      categories = response.categories || response || [];
    } catch (err) {
      console.warn('[WorkflowEditor] Lỗi fetch categories:', err.message);
    }

    // Build category options
    const categoryOptions = categories.map(cat =>
      `<option value="${cat.id}" ${this.templateData.category_id == cat.id ? 'selected' : ''}>${this.escapeHtml(cat.name)}</option>`
    ).join('');

    const dialog = document.createElement('div');
    dialog.className = 'tobyflow-wf-settings-overlay template-settings-modal';
    dialog.innerHTML = `
      <div class="tobyflow-wf-settings-dialog">
        <div class="tobyflow-wf-settings-header">
          <h3>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right: 8px; vertical-align: -3px;">
              <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>
              <polyline points="17 21 17 13 7 13 7 21"/>
              <polyline points="7 3 7 8 15 8"/>
            </svg>
            ${t('workflow.templateSettings', 'Cài đặt Template')}
          </h3>
          <button class="tobyflow-wf-settings-close" title="${t('common.close', 'Đóng')}">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <div class="tobyflow-wf-settings-body">
          <!-- Tên template -->
          <div class="tobyflow-wf-settings-group">
            <label for="tplSettingsName">${t('workflow.saveTemplate.nameLabel', 'Tên Template')} <span class="required">*</span></label>
            <input type="text" id="tplSettingsName" value="${this.escapeAttr(this.templateData.name || '')}" placeholder="${t('workflow.saveTemplate.namePlaceholder', 'Nhập tên template...')}" maxlength="100" />
          </div>

          <!-- Mô tả -->
          <div class="tobyflow-wf-settings-group">
            <label for="tplSettingsDesc">${t('workflow.saveTemplate.descriptionLabel', 'Mô tả')}</label>
            <textarea id="tplSettingsDesc" rows="3" placeholder="${t('workflow.saveTemplate.descriptionPlaceholder', 'Mô tả ngắn về template này...')}" maxlength="500">${this.escapeHtml(this.templateData.description || '')}</textarea>
          </div>

          <!-- Danh mục -->
          <div class="tobyflow-wf-settings-group">
            <label for="tplSettingsCategory">${t('workflow.saveTemplate.categoryLabel', 'Danh mục')}</label>
            <select id="tplSettingsCategory">
              <option value="">${t('workflow.saveTemplate.selectCategory', '-- Chọn danh mục --')}</option>
              ${categoryOptions}
            </select>
          </div>

          <!-- Thumbnail -->
          <div class="tobyflow-wf-settings-group">
            <label>${t('workflow.saveTemplate.thumbnailLabel', 'Ảnh Thumbnail')}</label>
            <div class="save-template-thumbnail-picker" id="tplSettingsThumbnailPicker">
              <div class="thumbnail-preview ${this.templateData.thumbnail_url ? 'has-image' : ''}" id="tplSettingsThumbnailPreview">
                ${this.templateData.thumbnail_url
                  ? `<img src="${this.escapeAttr(this.templateData.thumbnail_url)}" alt="Thumbnail" />`
                  : `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                      <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                      <circle cx="8.5" cy="8.5" r="1.5"/>
                      <polyline points="21 15 16 10 5 21"/>
                    </svg>
                    <span>${t('workflow.saveTemplate.clickToSelect', 'Click để chọn ảnh')}</span>`
                }
              </div>
              <button type="button" class="thumbnail-remove ${this.templateData.thumbnail_url ? '' : 'hidden'}" id="tplSettingsThumbnailRemove" title="${t('workflow.saveTemplate.removeThumbnail', 'Xóa ảnh')}">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <line x1="18" y1="6" x2="6" y2="18"></line>
                  <line x1="6" y1="6" x2="18" y2="18"></line>
                </svg>
              </button>
            </div>
            <span class="tobyflow-wf-settings-hint">${t('workflow.saveTemplate.thumbnailSizeHint', 'Khuyến nghị: 640×360px hoặc 1280×720px (tỉ lệ 16:9)')}</span>
          </div>

          <!-- Video Demo URL -->
          <div class="tobyflow-wf-settings-group">
            <label for="tplSettingsVideoUrl">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style="color: #ff0000; vertical-align: middle; margin-right: 4px;">
                <path d="M19.615 3.184c-3.604-.246-11.631-.245-15.23 0-3.897.266-4.356 2.62-4.385 8.816.029 6.185.484 8.549 4.385 8.816 3.6.245 11.626.246 15.23 0 3.897-.266 4.356-2.62 4.385-8.816-.029-6.185-.484-8.549-4.385-8.816zm-10.615 12.816v-8l8 3.993-8 4.007z"/>
              </svg>
              ${t('workflow.saveTemplate.videoUrlLabel', 'Video Demo (YouTube)')}
            </label>
            <input type="url" id="tplSettingsVideoUrl" value="${this.escapeAttr(this.templateData.video_url || '')}" placeholder="${t('workflow.saveTemplate.videoUrlPlaceholder', 'https://www.youtube.com/watch?v=...')}" maxlength="500" />
            <span class="tobyflow-wf-settings-hint">${t('workflow.saveTemplate.videoUrlHint', 'Link video YouTube demo template')}</span>
          </div>

          <div class="tobyflow-wf-settings-divider">${t('workflow.templateOptions', 'Tùy chọn')}</div>

          <!-- Premium toggle -->
          <div class="tobyflow-wf-settings-group">
            <label class="toolbar-toggle" for="tplSettingsPremium">
              <input type="checkbox" id="tplSettingsPremium" ${this.templateData.is_premium ? 'checked' : ''} />
              <span class="toggle-track"><span class="toggle-thumb"></span></span>
              <span class="toggle-label">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style="margin-right: 4px; vertical-align: -2px;">
                  <path d="M5 16L3 5L8.5 10L12 4L15.5 10L21 5L19 16H5ZM19 19C19 19.6 18.6 20 18 20H6C5.4 20 5 19.6 5 19V18H19V19Z"/>
                </svg>
                ${t('workflow.saveTemplate.premiumTemplate', 'Premium Template')}
              </span>
            </label>
          </div>

          <!-- Featured toggle -->
          <div class="tobyflow-wf-settings-group">
            <label class="toolbar-toggle" for="tplSettingsFeatured">
              <input type="checkbox" id="tplSettingsFeatured" ${this.templateData.is_featured ? 'checked' : ''} />
              <span class="toggle-track"><span class="toggle-thumb"></span></span>
              <span class="toggle-label">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right: 4px; vertical-align: -2px;">
                  <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
                </svg>
                ${t('workflow.saveTemplate.featured', 'Featured (Nổi bật)')}
              </span>
            </label>
          </div>

          <!-- Published toggle -->
          <div class="tobyflow-wf-settings-group">
            <label class="toolbar-toggle" for="tplSettingsPublished">
              <input type="checkbox" id="tplSettingsPublished" ${this.templateData.is_published ? 'checked' : ''} />
              <span class="toggle-track"><span class="toggle-thumb"></span></span>
              <span class="toggle-label">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right: 4px; vertical-align: -2px;">
                  <circle cx="12" cy="12" r="10"></circle>
                  <polyline points="12 6 12 12 16 14"></polyline>
                </svg>
                ${t('workflow.templatePublished', 'Xuất bản (Công khai)')}
              </span>
            </label>
          </div>

          <!-- Error display -->
          <div class="save-template-error hidden" id="tplSettingsError">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"/>
              <line x1="12" y1="8" x2="12" y2="12"/>
              <line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            <span id="tplSettingsErrorText"></span>
          </div>
        </div>
        <div class="tobyflow-wf-settings-footer">
          <button class="btn btn-secondary" id="tplSettingsCancel">${t('common.cancel', 'Hủy')}</button>
          <button class="btn btn-primary" id="tplSettingsSave">${t('workflow.saveSettings', 'Lưu cài đặt')}</button>
        </div>
      </div>
    `;

    this.overlay.appendChild(dialog);

    // Store selected thumbnail URL
    let selectedThumbnail = this.templateData.thumbnail_url || null;

    // Close handlers
    dialog.querySelector('.tobyflow-wf-settings-close')?.addEventListener('click', () => dialog.remove());
    dialog.querySelector('#tplSettingsCancel')?.addEventListener('click', () => dialog.remove());

    // Thumbnail picker
    const thumbnailPicker = dialog.querySelector('#tplSettingsThumbnailPicker');
    const thumbnailPreview = dialog.querySelector('#tplSettingsThumbnailPreview');
    const thumbnailRemove = dialog.querySelector('#tplSettingsThumbnailRemove');

    thumbnailPicker?.addEventListener('click', (e) => {
      if (e.target.closest('.thumbnail-remove')) return;

      if (window.WorkflowMediaModal) {
        window.WorkflowMediaModal.show({
          type: 'thumbnail',
          multiple: false,
          preselected: selectedThumbnail ? [selectedThumbnail] : [],
          onSelect: (url) => {
            selectedThumbnail = url;
            thumbnailPreview.innerHTML = `<img src="${this.escapeAttr(url)}" alt="Thumbnail" />`;
            thumbnailPreview.classList.add('has-image');
            thumbnailRemove?.classList.remove('hidden');
          }
        });
      } else {
        console.warn('[WorkflowEditor] WorkflowMediaModal chưa sẵn sàng');
      }
    });

    thumbnailRemove?.addEventListener('click', (e) => {
      e.stopPropagation();
      selectedThumbnail = null;
      const clickToSelectText = t('workflow.saveTemplate.clickToSelect', 'Click để chọn ảnh');
      thumbnailPreview.innerHTML = `
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
          <circle cx="8.5" cy="8.5" r="1.5"/>
          <polyline points="21 15 16 10 5 21"/>
        </svg>
        <span>${clickToSelectText}</span>
      `;
      thumbnailPreview.classList.remove('has-image');
      thumbnailRemove?.classList.add('hidden');
    });

    // Save handler
    dialog.querySelector('#tplSettingsSave')?.addEventListener('click', async () => {
      const nameInput = dialog.querySelector('#tplSettingsName');
      const name = nameInput?.value?.trim();

      // Validate
      if (!name) {
        const errorEl = dialog.querySelector('#tplSettingsError');
        const errorText = dialog.querySelector('#tplSettingsErrorText');
        if (errorEl && errorText) {
          errorText.textContent = t('workflow.saveTemplate.nameRequired', 'Vui lòng nhập tên template');
          errorEl.classList.remove('hidden');
          setTimeout(() => errorEl.classList.add('hidden'), 5000);
        }
        nameInput?.focus();
        return;
      }

      // Update templateData
      this.templateData.name = name;
      this.templateData.description = dialog.querySelector('#tplSettingsDesc')?.value?.trim() || '';
      const categoryVal = dialog.querySelector('#tplSettingsCategory')?.value;
      this.templateData.category_id = categoryVal ? parseInt(categoryVal, 10) : null;
      this.templateData.thumbnail_url = selectedThumbnail;
      console.log('[WorkflowEditor] Template settings saved - thumbnail_url:', selectedThumbnail);
      this.templateData.video_url = dialog.querySelector('#tplSettingsVideoUrl')?.value?.trim() || null;
      this.templateData.is_premium = dialog.querySelector('#tplSettingsPremium')?.checked || false;
      this.templateData.is_featured = dialog.querySelector('#tplSettingsFeatured')?.checked || false;
      this.templateData.is_published = dialog.querySelector('#tplSettingsPublished')?.checked || false;

      // Update workflow name to sync with template name
      this.workflow.wf_name = name;
      this.workflow.description = this.templateData.description;

      // Update header name input
      const headerNameInput = this.overlay?.querySelector('#workflowName');
      if (headerNameInput) headerNameInput.value = name;

      this._hasUnsavedChanges = true;
      dialog.remove();

      // Notification cho biết cần nhấn Save để lưu vào database
      window.showNotification?.(t('workflow.templateSettingsChanged', 'Đã cập nhật. Nhấn Save để lưu vào database.'), 'info');
    });

    // Click outside to close
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog) dialog.remove();
    });

    // Focus name input
    requestAnimationFrame(() => {
      dialog.querySelector('#tplSettingsName')?.focus();
    });
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text || '';
    return div.innerHTML;
  }

  escapeAttr(text) {
    return (text || '').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ===========================================================================
  // Node naming: unique name generation
  // ===========================================================================

  /**
   * Generate unique node name with sequence number.
   * E.g., "Generate", "Generate 2", "Generate 3" based on existing nodes.
   */
  _generateUniqueNodeName(nodeType) {
    const baseName = NodeTemplates.getType(nodeType)?.name || nodeType;
    if (!this.diagramCanvas?.editor) return baseName;

    const exportData = this.diagramCanvas.editor.export();
    const homeData = exportData?.drawflow?.Home?.data || {};

    // Count nodes of same type
    let maxNum = 0;
    Object.values(homeData).forEach(nodeData => {
      if (nodeData.data?.node_type !== nodeType) return;
      const name = nodeData.data?.node_name || '';
      // Check if name matches "BaseName" or "BaseName N"
      if (name === baseName) {
        maxNum = Math.max(maxNum, 1);
      } else {
        const match = name.match(new RegExp(`^${this._escapeRegex(baseName)}\\s+(\\d+)$`));
        if (match) maxNum = Math.max(maxNum, parseInt(match[1], 10));
      }
    });

    // First node = "BaseName", subsequent = "BaseName 2", "BaseName 3", ...
    return maxNum === 0 ? baseName : `${baseName} ${maxNum + 1}`;
  }

  _escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // ===========================================================================
  // Phase 1 — Node Reference System: Slug helper methods
  // ===========================================================================

  /**
   * Generate slug from node name (Vietnamese-safe normalization).
   * @param {string} name - Node name
   * @returns {string} Normalized slug (lowercase, alphanumeric + underscore)
   */
  _normalizeToSlug(name) {
    if (!name) return 'node';
    let slug = name.normalize('NFD').replace(/[̀-ͯ]/g, '');
    slug = slug.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    slug = slug.replace(/^[0-9_]+/, '');
    if (!slug) return 'node';
    return slug.substring(0, 25);
  }

  /**
   * Get all existing slugs in current workflow.
   * @param {string|null} excludeNodeId - Exclude this node's slug (for edit validation)
   * @returns {string[]} Array of existing slugs
   */
  _getExistingSlugs(excludeNodeId = null) {
    if (!this.diagramCanvas?.editor) return [];
    const exportData = this.diagramCanvas.editor.export();
    const homeData = exportData?.drawflow?.Home?.data || {};
    const slugs = [];
    Object.entries(homeData).forEach(([id, nodeData]) => {
      if (excludeNodeId && String(id) === String(excludeNodeId)) return;
      const slug = nodeData.data?.slug;
      if (slug) slugs.push(slug);
    });
    return slugs;
  }

  /**
   * Ensure slug is unique within workflow (append _1, _2, ... if needed).
   * @param {string} baseSlug - Base slug to check
   * @param {string[]} existingSlugs - Array of existing slugs
   * @returns {string} Unique slug
   */
  _ensureUniqueSlug(baseSlug, existingSlugs) {
    if (!existingSlugs.includes(baseSlug)) return baseSlug;
    let counter = 1;
    let candidate = `${baseSlug}_${counter}`;
    while (existingSlugs.includes(candidate)) {
      counter++;
      candidate = `${baseSlug}_${counter}`;
    }
    return candidate;
  }

  /**
   * Generate a unique slug for a new node.
   * @param {string} name - Node name
   * @param {string|null} excludeNodeId - Exclude this node when checking uniqueness
   * @returns {string} Unique slug
   */
  _generateSlug(name, excludeNodeId = null) {
    let slug = this._normalizeToSlug(name);
    if (WorkflowEditor.RESERVED_SLUGS.includes(slug)) {
      slug = 'node_' + slug;
    }
    const existingSlugs = this._getExistingSlugs(excludeNodeId);
    return this._ensureUniqueSlug(slug, existingSlugs);
  }

  /**
   * Auto-generate slugs for mentionable nodes that don't have one.
   * Called after loadWorkflow to migrate old nodes created before slug system.
   */
  _ensureSlugsForMentionableNodes() {
    const editor = this.diagramCanvas?.editor;
    if (!editor) return;

    const moduleData = editor.drawflow?.drawflow?.Home?.data;
    if (!moduleData) return;

    let updated = false;
    for (const [drawflowId, node] of Object.entries(moduleData)) {
      if (!node?.data) continue;
      const nodeType = node.data.node_type || node.class;

      // Only process mentionable nodes without slugs
      if (!this._isMentionableNodeType(nodeType)) continue;
      if (node.data.slug) continue; // Already has slug

      // Generate slug from node name
      const nodeName = node.data.node_name || nodeType;
      const newSlug = this._generateSlug(nodeName, drawflowId);

      // Update node data
      node.data.slug = newSlug;
      node.data.slug_auto = true;
      updated = true;
      console.log(`[WorkflowEditor] Auto-generated slug "${newSlug}" for node "${nodeName}" (${nodeType})`);
    }

    if (updated) {
      this._hasUnsavedChanges = true;
    }
  }

  /**
   * Validate slug format and uniqueness.
   * @param {string} slug - Slug to validate
   * @param {string|null} excludeNodeId - Exclude this node (for edit validation)
   * @returns {{valid: boolean, error: string|null}}
   */
  _validateSlug(slug, excludeNodeId = null) {
    if (!slug) return { valid: true, error: null };
    if (slug.length > WorkflowEditor.SLUG_MAX_LENGTH) {
      return { valid: false, error: window.I18n?.t('workflow.slugTooLong') || `Slug tối đa ${WorkflowEditor.SLUG_MAX_LENGTH} ký tự` };
    }
    if (!WorkflowEditor.SLUG_PATTERN.test(slug)) {
      return { valid: false, error: window.I18n?.t('workflow.slugInvalidFormat') || 'Slug chỉ chứa a-z, 0-9, _ và bắt đầu bằng chữ cái' };
    }
    if (WorkflowEditor.RESERVED_SLUGS.includes(slug)) {
      return { valid: false, error: window.I18n?.t('workflow.slugReserved') || `"${slug}" là từ khóa không thể dùng làm slug` };
    }
    const existingSlugs = this._getExistingSlugs(excludeNodeId);
    if (existingSlugs.includes(slug)) {
      return { valid: false, error: window.I18n?.t('workflow.slugDuplicate') || `Slug "${slug}" đã tồn tại trong workflow` };
    }
    return { valid: true, error: null };
  }

  /**
   * Check if a node type can have a slug (mentionable).
   * Phase 6: Reads from server config (workflow_node_types.config.ui.supports_slug)
   * @param {string} nodeType - Node type
   * @returns {boolean}
   */
  _isMentionableNodeType(nodeType) {
    const typeConfig = NodeTemplates.getType(nodeType);
    if (typeConfig?.ui?.supports_slug !== undefined) {
      return typeConfig.ui.supports_slug === true;
    }
    // Fallback for cold start
    return WorkflowEditor._FALLBACK_MENTIONABLE_TYPES.includes(nodeType);
  }

  // ========== PHASE 2 — NODE REFERENCE SYSTEM: @MENTION HELPERS ==========

  // Phase 6: Migrated to server config (workflow_node_types.config.ui.supports_mentions)
  // Fallback array for cold start before server config loads
  static _FALLBACK_CAN_USE_MENTIONS = ['generate', 'chatgpt', 'grok', 'prompt'];

  /**
   * Check if a node type can use @mentions in its prompt.
   * Phase 6: Reads from server config (workflow_node_types.config.ui.supports_mentions)
   * @param {string} nodeType - Node type
   * @returns {boolean}
   */
  _canUseMentions(nodeType) {
    const typeConfig = NodeTemplates.getType(nodeType);
    if (typeConfig?.ui?.supports_mentions !== undefined) {
      return typeConfig.ui.supports_mentions === true;
    }
    // Fallback for cold start
    return WorkflowEditor._FALLBACK_CAN_USE_MENTIONS.includes(nodeType);
  }

  /**
   * Parse @mentions từ prompt text.
   * @param {string} prompt - Prompt text với @mentions
   * @returns {string[]} Array of unique mentioned slugs
   */
  _parseMentions(prompt) {
    if (!prompt || typeof prompt !== 'string') return [];
    const mentionRegex = /@([a-z][a-z0-9_]{0,29})(?![a-z0-9@._-])/g;
    const mentions = [];
    let match;
    while ((match = mentionRegex.exec(prompt)) !== null) {
      mentions.push(match[1]);
    }
    return [...new Set(mentions)];
  }

  /**
   * Get danh sách nodes có thể mention từ một node.
   * Dùng cho autocomplete dropdown.
   *
   * @param {string} currentNodeId - ID của node đang edit prompt
   * @returns {Array} Sorted list of mentionable nodes với metadata
   */
  _getAvailableMentionSlugs(currentNodeId) {
    const result = [];
    const editor = this.diagramCanvas?.editor;
    if (!editor) return result;

    const allNodes = [];
    const edgesList = [];

    try {
      const moduleData = editor.drawflow?.drawflow?.Home?.data;
      if (!moduleData) return result;

      for (const [drawflowId, node] of Object.entries(moduleData)) {
        if (!node?.data) continue;
        const idStr = String(drawflowId);
        allNodes.push({
          drawflowId: idStr,
          nodeId: node.data.node_id || idStr,
          nodeType: node.data.node_type || node.class,
          slug: node.data.slug,
          name: node.data.node_name || node.class,
          thumbnail: node.data.ref_thumbnails
            ? Object.values(node.data.ref_thumbnails)[0]
            : (node.data.result_thumbnails ? Object.values(node.data.result_thumbnails)[0] : null),
          outputs: node.outputs || {}
        });

        for (const [outputKey, outputData] of Object.entries(node.outputs || {})) {
          for (const conn of outputData.connections || []) {
            edgesList.push({
              source: idStr,
              target: String(conn.node)
            });
          }
        }
      }
    } catch (e) {
      console.warn('[WorkflowEditor] _getAvailableMentionSlugs error:', e.message);
      return result;
    }

    // Ensure currentNodeId is string for comparison
    // 2026-05-31: currentNodeId có thể là drawflowId (numeric) HOẶC node_id UUID tùy caller.
    // Edges store source/target as drawflowId. Nếu caller pass node_id UUID → resolve về drawflowId.
    let currentDrawflowId = String(currentNodeId);
    if (currentDrawflowId.startsWith('node_')) {
      // UUID passed — find drawflowId via node_id lookup
      const matchedNode = allNodes.find(n => n.nodeId === currentNodeId);
      if (matchedNode) {
        currentDrawflowId = matchedNode.drawflowId;
      } else {
        console.warn(`[Mention] currentNodeId="${currentNodeId}" không tìm thấy drawflowId → filter sẽ skip toàn bộ. Caller phải pass drawflowId.`);
      }
    }
    const connectedNodeIds = new Set();
    const traverseUpstream = (nodeId) => {
      const incomingEdges = edgesList.filter(e => e.target === nodeId);
      for (const edge of incomingEdges) {
        if (!connectedNodeIds.has(edge.source)) {
          connectedNodeIds.add(edge.source);
          traverseUpstream(edge.source);
        }
      }
    };
    traverseUpstream(currentDrawflowId);
    console.log(`[Mention] currentDrawflowId="${currentDrawflowId}" upstream connected: ${[...connectedNodeIds].join(',') || '(none)'} | total nodes: ${allNodes.length} | edges: ${edgesList.length}`);

    const imageNodeTypes = ['image', 'generate', 'chatgpt', 'grok'];
    // 2026-05-31: thêm text_extract — output text result mentionable downstream
    // (cùng pattern fix các nơi khác). Trước fix: autocomplete dropdown không hiện
    // text_extract slugs khi user gõ @ trong prompt downstream.
    const textNodeTypes = ['text', 'prompt', 'text_extract'];

    for (const node of allNodes) {
      if (node.drawflowId === currentDrawflowId) continue;
      if (!node.slug) continue;
      // Only show upstream (connected) nodes - skip downstream and unconnected
      if (!connectedNodeIds.has(node.drawflowId)) continue;

      const isImageProducer = imageNodeTypes.includes(node.nodeType);
      const isTextProducer = textNodeTypes.includes(node.nodeType);
      if (!isImageProducer && !isTextProducer) continue;

      result.push({
        slug: node.slug,
        name: node.name || node.nodeType,
        nodeType: node.nodeType,
        drawflowId: node.drawflowId,
        nodeId: node.nodeId,
        connected: true, // Always true since we filter upstream only
        thumbnail: isImageProducer ? node.thumbnail : null,
        category: isImageProducer ? 'image' : 'text'
      });
    }

    // Sort by category (image first) then name
    result.sort((a, b) => {
      if (a.category !== b.category) return a.category === 'image' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    return result;
  }

  /**
   * Validate all @mentions trong prompt.
   * @param {string} prompt - Prompt text
   * @param {string} currentNodeId - Current node ID
   * @returns {{valid: boolean, errors: string[], warnings: string[]}}
   */
  _validatePromptMentions(prompt, currentNodeId) {
    const errors = [];
    const warnings = [];
    const mentions = this._parseMentions(prompt);

    if (mentions.length === 0) {
      return { valid: true, errors, warnings };
    }

    // Task 2.9: Max mentions limit validation
    const maxMentions = WorkflowEditor.MAX_MENTIONS_PER_PROMPT;
    if (mentions.length > maxMentions) {
      errors.push(window.I18n?.t('workflow.tooManyMentions', { count: mentions.length, max: maxMentions })
        || `Quá nhiều @mentions (${mentions.length}/${maxMentions})`);
    }

    const availableSlugs = this._getAvailableMentionSlugs(currentNodeId);
    const slugSet = new Set(availableSlugs.map(s => s.slug));
    const imageSlugSet = new Set(availableSlugs.filter(s => s.category === 'image').map(s => s.slug));

    for (const slug of mentions) {
      if (!slugSet.has(slug)) {
        errors.push(window.I18n?.t('workflow.mentionNotFound', { slug }) || `@${slug} không tồn tại trong workflow`);
      }
    }

    const hasImageMention = mentions.some(slug => imageSlugSet.has(slug));
    if (!hasImageMention) {
      warnings.push(window.I18n?.t('workflow.noImageMention') || 'Không có @image nào trong prompt. ref_mode=mention sẽ không có reference images.');
    }

    return { valid: errors.length === 0, errors, warnings };
  }

  // ========== TASK 4.11 — RECENT @MENTIONS ==========

  /**
   * Load recent mentions from chrome.storage.local.
   * @param {string} workflowId - Workflow ID
   * @returns {Promise<string[]>} Array of recent slug strings
   */
  async _loadRecentMentions(workflowId) {
    if (!workflowId) return [];
    try {
      const data = await chrome.storage.local.get('recent_mention_slugs');
      const allRecent = data.recent_mention_slugs || {};
      return Array.isArray(allRecent[workflowId]) ? allRecent[workflowId] : [];
    } catch (e) {
      console.warn('[WorkflowEditor] Failed to load recent mentions:', e.message);
      return [];
    }
  }

  /**
   * Save a slug to recent mentions (most recent first, max 10).
   * @param {string} workflowId - Workflow ID
   * @param {string} slug - Slug to add to recent
   */
  async _saveRecentMention(workflowId, slug) {
    if (!workflowId || !slug) return;
    try {
      const data = await chrome.storage.local.get('recent_mention_slugs');
      const allRecent = data.recent_mention_slugs || {};
      let recent = Array.isArray(allRecent[workflowId]) ? allRecent[workflowId] : [];
      // Remove if already exists, add to front
      recent = recent.filter(s => s !== slug);
      recent.unshift(slug);
      // Max 10 items
      if (recent.length > 10) recent = recent.slice(0, 10);
      allRecent[workflowId] = recent;
      await chrome.storage.local.set({ recent_mention_slugs: allRecent });
    } catch (e) {
      console.warn('[WorkflowEditor] Failed to save recent mention:', e.message);
    }
  }

  /**
   * Remove deleted slugs from recent mentions.
   * Call on workflow load to clean up stale entries.
   * @param {string} workflowId - Workflow ID
   * @param {string[]} validSlugs - Array of currently valid slugs
   */
  async _cleanupRecentMentions(workflowId, validSlugs) {
    if (!workflowId) return;
    try {
      const data = await chrome.storage.local.get('recent_mention_slugs');
      const allRecent = data.recent_mention_slugs || {};
      let recent = Array.isArray(allRecent[workflowId]) ? allRecent[workflowId] : [];
      const validSet = new Set(validSlugs);
      const cleaned = recent.filter(s => validSet.has(s));
      if (cleaned.length !== recent.length) {
        allRecent[workflowId] = cleaned;
        await chrome.storage.local.set({ recent_mention_slugs: allRecent });
      }
    } catch (e) {
      console.warn('[WorkflowEditor] Failed to cleanup recent mentions:', e.message);
    }
  }

  // ========== TASK 4.12 — FIND & REPLACE @SLUG ==========

  /**
   * Find all nodes that reference a given slug in their prompts.
   * @param {string} slug - The slug to search for
   * @param {string} excludeNodeId - Node ID to exclude (the slug's own node)
   * @returns {Array} References: [{ nodeId, nodeName, nodeType, prompt }]
   */
  _findSlugReferences(slug, excludeNodeId = null) {
    const references = [];
    if (!slug || !this.diagramCanvas) return references;

    const allNodeData = this._getAllNodeData();
    const mentionPattern = new RegExp(`@${slug}(?![a-z0-9_])`, 'g');

    for (const node of allNodeData) {
      if (node.node_id === excludeNodeId) continue;
      const prompt = node.prompt || '';
      if (mentionPattern.test(prompt)) {
        references.push({
          nodeId: node.node_id,
          nodeName: node.node_name || node.node_type || node.node_id,
          nodeType: node.node_type,
          prompt: prompt
        });
        mentionPattern.lastIndex = 0; // Reset regex state
      }
    }
    return references;
  }

  /**
   * Replace all occurrences of @oldSlug with @newSlug in all node prompts.
   * @param {string} oldSlug - Original slug
   * @param {string} newSlug - New slug
   * @returns {number} Number of nodes updated
   */
  _replaceSlugInAllNodes(oldSlug, newSlug) {
    if (!oldSlug || !newSlug || !this.diagramCanvas) return 0;

    const allNodeData = this._getAllNodeData();
    const mentionPattern = new RegExp(`@${oldSlug}(?![a-z0-9_])`, 'g');
    let updatedCount = 0;

    for (const node of allNodeData) {
      const prompt = node.prompt || '';
      if (mentionPattern.test(prompt)) {
        mentionPattern.lastIndex = 0;
        const newPrompt = prompt.replace(mentionPattern, `@${newSlug}`);
        // Update node data in Drawflow
        this.diagramCanvas.updateNodeData(node.node_id, { prompt: newPrompt });
        updatedCount++;
      }
    }

    if (updatedCount > 0) {
      this._hasUnsavedChanges = true;
    }
    return updatedCount;
  }

  /**
   * Show Find & Replace dialog when a slug is renamed.
   * @param {string} oldSlug - Original slug
   * @param {string} newSlug - New slug
   * @param {Array} references - Nodes referencing oldSlug
   * @returns {Promise<'update'|'skip'>} User choice
   */
  async _showFindReplaceDialog(oldSlug, newSlug, references) {
    const nodeList = references.map(r =>
      `• ${this.escapeHtml(r.nodeName)} (${r.nodeType}): "${this.escapeHtml(r.prompt.substring(0, 50))}${r.prompt.length > 50 ? '...' : ''}"`
    ).join('<br>');

    const slugUsedMsg = window.I18n?.t('workflow.slugUsedInNodes', { oldSlug, count: references.length })
      || `Slug "@${oldSlug}" được dùng trong ${references.length} node(s):`;
    const replaceMsg = window.I18n?.t('workflow.replaceAllQuestion', { oldSlug, newSlug })
      || `Đổi tất cả "@${oldSlug}" → "@${newSlug}"?`;

    const message = `
      <div style="text-align: left; font-size: 13px;">
        <p style="margin-bottom: 12px;">${slugUsedMsg}</p>
        <div style="max-height: 150px; overflow-y: auto; padding: 8px; background: var(--muted); border-radius: 6px; margin-bottom: 12px; font-size: 12px; line-height: 1.6;">
          ${nodeList}
        </div>
        <p>${replaceMsg}</p>
      </div>
    `;

    const result = await window.customDialog?.confirm(message, {
      title: window.I18n?.t('workflow.updateReferences') || 'Update References?',
      type: 'info',
      confirmText: window.I18n?.t('workflow.updateAll') || 'Update All',
      cancelText: window.I18n?.t('workflow.skipUpdate') || 'Skip'
    });

    return result === true ? 'update' : 'skip';
  }

  // ========== TASK 4.8 — PREVIEW RESOLVED PROMPT PANEL ==========

  /**
   * Create preview panel toggle button and panel for prompt textarea.
   * @param {HTMLTextAreaElement} textarea - Prompt textarea element
   * @param {string} nodeId - Current node ID
   */
  _createPreviewPanel(textarea, nodeId) {
    if (!textarea?.parentElement) return null;

    const wrapper = textarea.parentElement;
    // Check if panel already exists
    let panel = wrapper.querySelector('.mention-preview-panel');
    if (panel) return panel;

    // Create inner container for textarea + toggle (for proper absolute positioning)
    let textareaContainer = wrapper.querySelector('.prompt-textarea-inner');
    if (!textareaContainer) {
      textareaContainer = document.createElement('div');
      textareaContainer.className = 'prompt-textarea-inner';
      // Move textarea into the inner container
      wrapper.insertBefore(textareaContainer, textarea);
      textareaContainer.appendChild(textarea);
    }

    // Create toggle button container (positioned inside textarea area)
    const toggleContainer = document.createElement('div');
    toggleContainer.className = 'mention-preview-toggle';
    toggleContainer.innerHTML = `
      <button type="button" class="mention-preview-btn" title="${window.I18n?.t('workflow.previewResolvedPrompt') || 'Preview resolved prompt'}">
        <svg class="mention-preview-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>
        <span class="mention-preview-label">${window.I18n?.t('workflow.preview') || 'Preview'}</span>
      </button>
    `;

    // Create panel (outside textarea container, flows below)
    panel = document.createElement('div');
    panel.className = 'mention-preview-panel hidden';
    panel.innerHTML = `
      <div class="mention-preview-header">
        <span class="mention-preview-title">
          <svg class="mention-preview-header-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"></path><rect x="8" y="2" width="8" height="4" rx="1" ry="1"></rect></svg>
          ${window.I18n?.t('workflow.resolvedPrompt') || 'Resolved Prompt'}
        </span>
        <button type="button" class="mention-preview-close" title="Close">×</button>
      </div>
      <div class="mention-preview-content">
        <div class="mention-preview-prompt"></div>
        <div class="mention-preview-refs">
          <div class="mention-preview-refs-label">
            <svg class="mention-preview-refs-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>
            ${window.I18n?.t('workflow.refImages') || 'Ref Images'}:
          </div>
          <div class="mention-preview-refs-grid"></div>
        </div>
      </div>
    `;

    // Toggle goes inside textarea container (absolute positioned)
    textareaContainer.appendChild(toggleContainer);
    // Panel goes after textarea container in wrapper (normal flow)
    wrapper.appendChild(panel);

    // Bind toggle button
    const toggleBtn = toggleContainer.querySelector('.mention-preview-btn');
    toggleBtn.addEventListener('click', () => {
      const isHidden = panel.classList.toggle('hidden');
      toggleBtn.classList.toggle('active', !isHidden);
      if (!isHidden) {
        this._updatePreviewPanel(textarea, nodeId);
      }
    });

    // Bind close button
    panel.querySelector('.mention-preview-close').addEventListener('click', () => {
      panel.classList.add('hidden');
      toggleBtn.classList.remove('active');
    });

    return panel;
  }

  /**
   * Update preview panel with resolved prompt.
   * @param {HTMLTextAreaElement} textarea - Prompt textarea element
   * @param {string} nodeId - Current node ID
   */
  _updatePreviewPanel(textarea, nodeId) {
    // Panel is in .prompt-mention-wrapper (parent of .prompt-textarea-inner which contains textarea)
    const wrapper = textarea?.parentElement?.parentElement;
    const panel = wrapper?.querySelector('.mention-preview-panel');
    if (!panel || panel.classList.contains('hidden')) return;

    const prompt = textarea.value || '';
    const mentions = this._parseMentions(prompt);
    const availableSlugs = this._getAvailableMentionSlugs(nodeId);
    const slugMap = new Map(availableSlugs.map(s => [s.slug, s]));

    // Resolve prompt: replace @slug with [slug] or (pending) or (invalid)
    let resolvedPrompt = prompt;
    const refImages = [];

    for (const slug of mentions) {
      const info = slugMap.get(slug);
      const pattern = new RegExp(`@${slug}(?![a-z0-9_])`, 'g');

      if (!info) {
        resolvedPrompt = resolvedPrompt.replace(pattern, `<span class="mention-preview-invalid">@${slug}</span>`);
      } else if (info.category === 'text') {
        resolvedPrompt = resolvedPrompt.replace(pattern, `<span class="mention-preview-text">[@${slug}]</span>`);
      } else {
        if (info.thumbnail) {
          resolvedPrompt = resolvedPrompt.replace(pattern, `<span class="mention-preview-image">[@${slug}]</span>`);
          refImages.push({ slug, thumbnail: info.thumbnail, name: info.name });
        } else {
          resolvedPrompt = resolvedPrompt.replace(pattern, `<span class="mention-preview-pending">[@${slug}] (pending)</span>`);
        }
      }
    }

    // Escape remaining HTML but preserve our spans
    const tempDiv = document.createElement('div');
    tempDiv.textContent = resolvedPrompt;
    let escapedPrompt = tempDiv.innerHTML;
    // Restore our span tags
    escapedPrompt = escapedPrompt
      .replace(/&lt;span class="mention-preview-/g, '<span class="mention-preview-')
      .replace(/&lt;\/span&gt;/g, '</span>')
      .replace(/"&gt;/g, '">');

    // Update DOM
    const promptEl = panel.querySelector('.mention-preview-prompt');
    const refsGrid = panel.querySelector('.mention-preview-refs-grid');
    const refsSection = panel.querySelector('.mention-preview-refs');

    if (promptEl) {
      promptEl.innerHTML = escapedPrompt || `<span class="mention-preview-empty">${window.I18n?.t('workflow.emptyPrompt') || '(empty prompt)'}</span>`;
    }

    if (refsGrid && refsSection) {
      if (refImages.length > 0) {
        refsSection.classList.remove('hidden');
        refsGrid.innerHTML = refImages.map(img => `
          <div class="mention-preview-ref-item" title="@${this.escapeAttr(img.slug)} — ${this.escapeAttr(img.name)}">
            <img src="${this.escapeAttr(img.thumbnail)}" alt="@${this.escapeAttr(img.slug)}" />
            <span class="mention-preview-ref-label">@${this.escapeHtml(img.slug)}</span>
          </div>
        `).join('');
      } else {
        refsSection.classList.add('hidden');
        refsGrid.innerHTML = '';
      }
    }
  }

  /**
   * Bind mention autocomplete cho prompt textarea.
   * Hiển thị dropdown khi user gõ @ và filter theo ký tự tiếp theo.
   *
   * @param {HTMLTextAreaElement} textarea - Prompt textarea element
   * @param {string} nodeId - Current node ID (drawflow ID)
   */
  _bindMentionAutocomplete(textarea, nodeId) {
    if (!textarea) return;

    let dropdown = null;
    let activeIndex = -1;
    let currentQuery = '';
    let filteredSlugs = [];

    const createDropdown = () => {
      if (dropdown) return dropdown;
      dropdown = document.createElement('div');
      dropdown.className = 'mention-autocomplete';
      dropdown.style.display = 'none';
      textarea.parentElement.style.position = 'relative';
      textarea.parentElement.appendChild(dropdown);
      return dropdown;
    };

    const hideDropdown = () => {
      if (dropdown) {
        dropdown.style.display = 'none';
        dropdown.innerHTML = '';
      }
      activeIndex = -1;
      currentQuery = '';
      filteredSlugs = [];
    };

    // Task 4.11: Render single item helper
    const renderItem = (item, idx) => {
      const thumbHtml = item.thumbnail
        ? `<div class="mention-autocomplete-thumb" style="background-image: url('${this.escapeAttr(item.thumbnail)}')"></div>`
        : item.category === 'text'
          ? `<div class="mention-autocomplete-thumb text-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg></div>`
          : `<div class="mention-autocomplete-thumb image-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg></div>`;

      return `
        <div class="mention-autocomplete-item${idx === activeIndex ? ' active' : ''}" data-index="${idx}" data-slug="${this.escapeAttr(item.slug)}">
          ${thumbHtml}
          <div class="mention-autocomplete-info">
            <div class="mention-autocomplete-slug">${this.escapeHtml(item.slug)}</div>
            <div class="mention-autocomplete-meta">
              <span class="mention-autocomplete-type">${item.nodeType}</span>
              <span class="mention-autocomplete-name">${this.escapeHtml(item.name)}</span>
            </div>
          </div>
        </div>
      `;
    };

    const renderDropdown = async (slugs, query) => {
      const dd = createDropdown();
      filteredSlugs = slugs;

      if (slugs.length === 0) {
        dd.innerHTML = `<div class="mention-autocomplete-empty">${window.I18n?.t('workflow.noMentionMatch') || 'Không tìm thấy node phù hợp'}</div>`;
        dd.style.display = 'block';
        return;
      }

      let html = '';

      // Task 4.11: Show "Recent" section when query is empty
      if (!query && this.workflow?.id) {
        try {
          const recentSlugs = await this._loadRecentMentions(this.workflow.id);
          if (recentSlugs.length > 0) {
            const slugSet = new Set(slugs.map(s => s.slug));
            const validRecentSlugs = recentSlugs.filter(s => slugSet.has(s));
            if (validRecentSlugs.length > 0) {
              html += `<div class="mention-autocomplete-section">
                <div class="mention-autocomplete-section-header"><svg class="mention-section-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg> ${window.I18n?.t('workflow.recentMentions') || 'Recent'}</div>
                <div class="mention-autocomplete-section-items">
                  ${validRecentSlugs.slice(0, 5).map(rs => `<span class="mention-autocomplete-recent" data-slug="${this.escapeAttr(rs)}">@${this.escapeHtml(rs)}</span>`).join('')}
                </div>
              </div>`;
              html += `<div class="mention-autocomplete-divider"></div>`;
              html += `<div class="mention-autocomplete-section-header"><svg class="mention-section-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg> ${window.I18n?.t('workflow.allNodes') || 'All nodes'}</div>`;
            }
          }
        } catch (e) {
          // Ignore recent mentions errors
        }
      }

      html += slugs.map((item, idx) => renderItem(item, idx)).join('');
      dd.innerHTML = html;
      dd.style.display = 'block';

      // Position dropdown below cursor line - avoid overlapping text
      const textareaRect = textarea.getBoundingClientRect();
      const parentRect = textarea.parentElement.getBoundingClientRect();
      const lineHeight = parseInt(getComputedStyle(textarea).lineHeight) || 20;
      const paddingTop = parseInt(getComputedStyle(textarea).paddingTop) || 0;
      const cursorPos = this._getTextareaCursorPosition(textarea);

      // Calculate dropdown position relative to parent
      const dropdownTop = paddingTop + cursorPos.top + lineHeight + 8;
      const dropdownLeft = Math.max(8, Math.min(cursorPos.left, textareaRect.width - 300));

      dd.style.top = `${dropdownTop}px`;
      dd.style.left = `${dropdownLeft}px`;

      // Ensure dropdown doesn't overflow below textarea - if so, position above cursor
      requestAnimationFrame(() => {
        const ddRect = dd.getBoundingClientRect();
        const textareaBottom = textareaRect.bottom;
        if (ddRect.bottom > textareaBottom + 100) {
          // Position above cursor instead
          const aboveTop = paddingTop + cursorPos.top - dd.offsetHeight - 8;
          if (aboveTop > 0) {
            dd.style.top = `${aboveTop}px`;
          }
        }
      });
    };

    const selectItem = (index) => {
      if (index < 0 || index >= filteredSlugs.length) return;
      const item = filteredSlugs[index];

      // Replace @query với @slug
      const text = textarea.value;
      const cursorPos = textarea.selectionStart;
      const beforeCursor = text.substring(0, cursorPos);
      const afterCursor = text.substring(cursorPos);

      // Tìm vị trí @ trước cursor
      const atMatch = beforeCursor.match(/@([a-z0-9_]*)$/i);
      if (atMatch) {
        const atPos = beforeCursor.lastIndexOf('@');
        const newText = beforeCursor.substring(0, atPos) + '@' + item.slug + ' ' + afterCursor;
        textarea.value = newText;
        textarea.selectionStart = textarea.selectionEnd = atPos + item.slug.length + 2;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));

        // Task 4.11: Save to recent mentions
        if (this.workflow?.id) {
          this._saveRecentMention(this.workflow.id, item.slug);
        }
      }

      hideDropdown();
      textarea.focus();
    };

    // Task 4.11: Handle click on recent mention chip
    const handleRecentClick = (slug) => {
      const text = textarea.value;
      const cursorPos = textarea.selectionStart;
      const beforeCursor = text.substring(0, cursorPos);
      const afterCursor = text.substring(cursorPos);

      const atMatch = beforeCursor.match(/@([a-z0-9_]*)$/i);
      if (atMatch) {
        const atPos = beforeCursor.lastIndexOf('@');
        const newText = beforeCursor.substring(0, atPos) + '@' + slug + ' ' + afterCursor;
        textarea.value = newText;
        textarea.selectionStart = textarea.selectionEnd = atPos + slug.length + 2;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));

        if (this.workflow?.id) {
          this._saveRecentMention(this.workflow.id, slug);
        }
      }

      hideDropdown();
      textarea.focus();
    };

    // Click handler cho dropdown items
    const handleDropdownClick = (e) => {
      // Task 4.11: Handle recent mention chip click
      const recentChip = e.target.closest('.mention-autocomplete-recent');
      if (recentChip) {
        const slug = recentChip.dataset.slug;
        if (slug) handleRecentClick(slug);
        return;
      }

      const item = e.target.closest('.mention-autocomplete-item');
      if (item) {
        const index = parseInt(item.dataset.index, 10);
        selectItem(index);
      }
    };

    // Create mention chips preview container
    const chipsPreview = this._createMentionChipsPreview(textarea, nodeId);

    // Task 4.8: Create preview panel
    const previewPanel = this._createPreviewPanel(textarea, nodeId);

    // Task 4.8: Debounced preview panel update
    let previewDebounceTimer = null;
    const debouncedPreviewUpdate = () => {
      if (previewDebounceTimer) clearTimeout(previewDebounceTimer);
      previewDebounceTimer = setTimeout(() => {
        this._updatePreviewPanel(textarea, nodeId);
      }, 300);
    };

    // Input handler để detect @ và filter
    const handleInput = () => {
      const text = textarea.value;
      const cursorPos = textarea.selectionStart;
      const beforeCursor = text.substring(0, cursorPos);

      // Check nếu đang gõ @mention
      const atMatch = beforeCursor.match(/@([a-z0-9_]*)$/i);

      if (atMatch) {
        currentQuery = atMatch[1].toLowerCase();
        const allSlugs = this._getAvailableMentionSlugs(nodeId);

        // Filter theo query
        const filtered = currentQuery
          ? allSlugs.filter(s => s.slug.includes(currentQuery) || s.name.toLowerCase().includes(currentQuery))
          : allSlugs;

        activeIndex = filtered.length > 0 ? 0 : -1;
        renderDropdown(filtered, currentQuery);
      } else {
        hideDropdown();
      }

      // Update chips preview
      this._updateMentionChipsPreview(textarea, nodeId);

      // Phase 4 Task 4.1: Update visual indicators on canvas
      this._updateMentionedNodesIndicator(text);

      // Task 4.8: Update preview panel (debounced)
      debouncedPreviewUpdate();
    };

    // Task 5.6: Insert all connected @slugs helper
    const insertAllConnectedSlugs = () => {
      const allSlugs = this._getAvailableMentionSlugs(nodeId);
      const connectedSlugs = allSlugs.filter(s => s.connected);
      if (connectedSlugs.length === 0) {
        console.log('[WorkflowEditor] No connected nodes with slugs to insert');
        return;
      }

      const mentionText = connectedSlugs.map(s => `@${s.slug}`).join(' ') + ' ';
      const cursorPos = textarea.selectionStart;
      const text = textarea.value;
      const newText = text.substring(0, cursorPos) + mentionText + text.substring(cursorPos);
      textarea.value = newText;
      textarea.selectionStart = textarea.selectionEnd = cursorPos + mentionText.length;
      textarea.dispatchEvent(new Event('input', { bubbles: true }));

      // Save to recent
      if (this.workflow?.id) {
        for (const s of connectedSlugs) {
          this._saveRecentMention(this.workflow.id, s.slug);
        }
      }

      console.log(`[WorkflowEditor] Inserted ${connectedSlugs.length} connected @mentions`);
    };

    // Keydown handler cho navigation — Task 5.2: Enhanced keyboard shortcuts
    const handleKeydown = (e) => {
      // Task 5.6: Ctrl+Shift+M → Insert all connected @slugs
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'm') {
        e.preventDefault();
        insertAllConnectedSlugs();
        hideDropdown();
        return;
      }

      if (!dropdown || dropdown.style.display === 'none') return;

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          activeIndex = Math.min(activeIndex + 1, filteredSlugs.length - 1);
          renderDropdown(filteredSlugs, currentQuery);
          break;

        case 'ArrowUp':
          e.preventDefault();
          activeIndex = Math.max(activeIndex - 1, 0);
          renderDropdown(filteredSlugs, currentQuery);
          break;

        case 'Tab':
          if (e.shiftKey) {
            // Shift+Tab: Navigate backwards
            e.preventDefault();
            activeIndex = Math.max(activeIndex - 1, 0);
            renderDropdown(filteredSlugs, currentQuery);
          } else if (activeIndex >= 0 && filteredSlugs.length > 0) {
            // Tab: Select item if available
            e.preventDefault();
            selectItem(activeIndex);
          }
          // else: Let Tab behave normally (move focus)
          break;

        case 'Enter':
          if (activeIndex >= 0) {
            e.preventDefault();
            selectItem(activeIndex);
          }
          break;

        case 'Escape':
          e.preventDefault();
          hideDropdown();
          break;
      }
    };

    // Blur handler để ẩn dropdown
    const handleBlur = (e) => {
      // Delay để cho phép click vào dropdown
      setTimeout(() => {
        if (!dropdown?.contains(document.activeElement)) {
          hideDropdown();
        }
      }, 150);
    };

    // Bind events
    textarea.addEventListener('input', handleInput);
    textarea.addEventListener('keydown', handleKeydown);
    textarea.addEventListener('blur', handleBlur);

    // Cleanup khi form đóng (sẽ được gọi bởi hideNodeForm)
    textarea._mentionAutocomplete = {
      cleanup: () => {
        textarea.removeEventListener('input', handleInput);
        textarea.removeEventListener('keydown', handleKeydown);
        textarea.removeEventListener('blur', handleBlur);
        if (dropdown) {
          dropdown.removeEventListener('click', handleDropdownClick);
          dropdown.remove();
        }
        if (chipsPreview) {
          chipsPreview.remove();
        }
        // Phase 4 Task 4.1: Clear indicators when form closes
        this._clearMentionedNodesIndicator();
      }
    };

    // Bind click handler cho dropdown
    createDropdown().addEventListener('click', handleDropdownClick);

    // Initial chips preview update (show existing mentions)
    this._updateMentionChipsPreview(textarea, nodeId);

    // Phase 4 Task 4.1: Initial indicator update
    this._updateMentionedNodesIndicator(textarea.value);
  }

  /**
   * Helper: Get cursor position trong textarea (approximate).
   * Dùng để position autocomplete dropdown.
   */
  _getTextareaCursorPosition(textarea) {
    const text = textarea.value.substring(0, textarea.selectionStart);
    const lines = text.split('\n');
    const currentLine = lines.length;
    const currentCol = lines[lines.length - 1].length;

    const style = getComputedStyle(textarea);
    const lineHeight = parseInt(style.lineHeight) || 20;
    const fontSize = parseInt(style.fontSize) || 14;
    const charWidth = fontSize * 0.6; // Better approximate for monospace-ish fonts

    // Account for scroll position
    const topPos = (currentLine - 1) * lineHeight - textarea.scrollTop;

    return {
      top: Math.max(0, topPos),
      left: Math.min(currentCol * charWidth, textarea.clientWidth - 100)
    };
  }

  /**
   * Phase 2.6 — Create mention chips preview container.
   * Shows parsed mentions as clickable chips below textarea.
   */
  _createMentionChipsPreview(textarea, nodeId) {
    if (!textarea?.parentElement) return null;

    let preview = textarea.parentElement.querySelector('.mention-chips-preview');
    if (!preview) {
      preview = document.createElement('div');
      preview.className = 'mention-chips-preview';
      textarea.parentElement.appendChild(preview);
    }

    // Bind click handler for chips
    preview.addEventListener('click', (e) => {
      const chip = e.target.closest('.mention-chips-preview-chip');
      if (!chip) return;

      const slug = chip.dataset.slug;
      const isRemove = e.target.closest('.mention-chips-preview-remove');

      if (isRemove) {
        // Remove mention from textarea
        this._removeMentionFromTextarea(textarea, slug);
        this._updateMentionChipsPreview(textarea, nodeId);
      } else {
        // Highlight source node on canvas
        this._highlightMentionedNode(slug);
      }
    });

    return preview;
  }

  /**
   * Phase 2.6 — Update mention chips preview based on textarea content.
   */
  _updateMentionChipsPreview(textarea, nodeId) {
    const preview = textarea?.parentElement?.querySelector('.mention-chips-preview');
    if (!preview) return;

    const text = textarea.value || '';
    const mentions = this._parseMentions(text);

    if (mentions.length === 0) {
      preview.innerHTML = '';
      return;
    }

    const availableSlugs = this._getAvailableMentionSlugs(nodeId);
    const slugMap = new Map(availableSlugs.map(s => [s.slug, s]));

    const chipsHtml = mentions.map(slug => {
      const info = slugMap.get(slug);
      const isValid = !!info;
      const isTextType = info?.category === 'text';

      let typeClass = isValid ? (isTextType ? 'text-type' : '') : 'invalid';
      let thumbHtml = '';

      if (isValid && info.thumbnail) {
        thumbHtml = `<img class="mention-chips-preview-thumb" src="${this.escapeAttr(info.thumbnail)}" alt="">`;
      } else if (isValid && isTextType) {
        thumbHtml = `<span class="mention-chips-preview-icon"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line></svg></span>`;
      } else if (isValid) {
        thumbHtml = `<span class="mention-chips-preview-icon"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg></span>`;
      } else {
        thumbHtml = `<span class="mention-chips-preview-icon"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg></span>`;
      }

      return `
        <span class="mention-chips-preview-chip ${typeClass}" data-slug="${this.escapeAttr(slug)}" title="${isValid ? this.escapeAttr(info.name || slug) : (window.I18n?.t('workflow.mentionNotFound') || 'Node không tồn tại')}">
          ${thumbHtml}
          <span class="mention-chips-preview-slug">${this.escapeHtml(slug)}</span>
          <button type="button" class="mention-chips-preview-remove" title="${window.I18n?.t('workflow.removeMention') || 'Xóa mention'}">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </span>
      `;
    }).join('');

    preview.innerHTML = chipsHtml;
  }

  /**
   * Phase 2.6 — Remove a mention from textarea text.
   */
  _removeMentionFromTextarea(textarea, slug) {
    if (!textarea || !slug) return;

    const text = textarea.value;
    // Replace @slug with empty, also remove extra space if any
    const regex = new RegExp(`@${slug}(?![a-z0-9_])\\s?`, 'gi');
    textarea.value = text.replace(regex, '').replace(/\s{2,}/g, ' ').trim();
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  }

  /**
   * Phase 2.7 — Highlight mentioned node on canvas (click to select).
   */
  _highlightMentionedNode(slug) {
    if (!slug || !this.workflow?.nodes) return;

    const node = this.workflow.nodes.find(n => n.slug === slug);
    if (!node?.node_id) return;

    // Find drawflow node ID
    const dfId = this._findDrawflowId(node.node_id);
    if (!dfId) return;

    // Emit select event to highlight on canvas
    if (window.eventBus) {
      window.eventBus.emit('node:selected', { nodeId: dfId });
    }

    // Also scroll to node if possible
    if (this.diagramCanvas?.scrollToNode) {
      this.diagramCanvas.scrollToNode(dfId);
    }
  }

  /**
   * Phase 4 Task 4.1 — Update visual indicators for all mentioned nodes.
   * Adds .being-mentioned class to canvas nodes that are @mentioned in current prompt.
   */
  _updateMentionedNodesIndicator(prompt) {
    // Clear all existing indicators
    const container = this.diagramCanvas?.container || document.querySelector('.drawflow');
    if (!container) return;

    container.querySelectorAll('.drawflow-node.being-mentioned').forEach(el => {
      el.classList.remove('being-mentioned');
    });

    // Parse mentions from prompt
    const mentions = this._parseMentions(prompt);
    if (!mentions.length || !this.workflow?.nodes) return;

    // Find nodes by slug and add indicator
    for (const slug of mentions) {
      const node = this.workflow.nodes.find(n => n.slug === slug);
      if (!node?.node_id) continue;

      const dfId = this._findDrawflowId(node.node_id);
      if (!dfId) continue;

      const nodeEl = container.querySelector(`#node-${dfId}`);
      if (nodeEl) {
        nodeEl.classList.add('being-mentioned');
      }
    }
  }

  /**
   * Phase 4 Task 4.1 — Clear all mention indicators.
   */
  _clearMentionedNodesIndicator() {
    const container = this.diagramCanvas?.container || document.querySelector('.drawflow');
    if (!container) return;

    container.querySelectorAll('.drawflow-node.being-mentioned').forEach(el => {
      el.classList.remove('being-mentioned');
    });
  }

  /**
   * Phase 4 Task 4.2 — Validate all mentions across all nodes before execution.
   * Checks for missing @slugs and ref_mode=mention without image mentions.
   * @param {Array} nodes - All node data
   * @returns {{errors: Array, warnings: Array}}
   */
  _validateAllMentions(nodes) {
    const errors = [];
    const warnings = [];

    if (!nodes || !Array.isArray(nodes)) return { errors, warnings };

    const slugSet = new Set(nodes.filter(n => n.slug).map(n => n.slug));
    const imageNodeTypes = ['image', 'generate', 'chatgpt', 'grok'];
    const imageSlugSet = new Set(nodes.filter(n => n.slug && imageNodeTypes.includes(n.node_type)).map(n => n.slug));

    for (const node of nodes) {
      // Phase 6: Use server config via _canUseMentions
      if (!this._canUseMentions(node.node_type)) continue;
      if (node.enabled === false) continue;

      const prompt = node.prompt || '';
      const mentions = this._parseMentions(prompt);

      if (mentions.length === 0) continue;

      // Task 4.2: Check for missing @slugs
      for (const slug of mentions) {
        if (!slugSet.has(slug)) {
          errors.push({
            nodeId: node.node_id,
            nodeName: node.node_name || node.node_id,
            type: 'missing_mention',
            message: window.I18n?.t('workflow.mentionNotFoundError', { slug }) || `@${slug} không tồn tại`
          });
        }
      }

      // Task 4.3: Warning for ref_mode=mention but no image @mentions.
      // 2026-05-31: BỎ warning preflight — quá nhiều false positive.
      // Lý do:
      //   - Node với prompt_source='upstream_node': prompt resolve runtime → @image có thể xuất hiện
      //   - Node với prompt rỗng + ref_file_ids đã picked: ref vẫn dùng được dù ref_mode='mention'
      //   - User báo: ref_mode='all' trong JSON nhưng warning vẫn fire → data drift / stale check
      // Runtime check ở WorkflowExecutor line 586 đã handle warning chính xác hơn (sau khi
      // prompt được resolve full). Preflight chỉ giữ ERROR validation (missing slug).

      // Check max mentions
      const maxMentions = WorkflowEditor.MAX_MENTIONS_PER_PROMPT;
      if (mentions.length > maxMentions) {
        warnings.push({
          nodeId: node.node_id,
          nodeName: node.node_name || node.node_id,
          type: 'too_many_mentions',
          message: window.I18n?.t('workflow.tooManyMentionsWarning', { count: mentions.length, max: maxMentions }) || `Quá nhiều mentions (${mentions.length}/${maxMentions})`
        });
      }
    }

    return { errors, warnings };
  }

  /**
   * Render avatars của users được share workflow
   * Hiển thị tối đa 3 avatars, nếu >3 thì thêm (+N) avatar
   * @param {Array} shares - Danh sách share records với recipient info
   * @returns {string} HTML avatars hoặc empty string
   */
  _renderSharedUsersAvatars(shares) {
    if (!shares || shares.length === 0) return '';

    const acceptedShares = shares.filter(s => s.status === 'accepted' && s.recipient);
    if (acceptedShares.length === 0) return '';

    const maxShow = 3;
    const displayShares = acceptedShares.slice(0, maxShow);
    const extraCount = acceptedShares.length - maxShow;

    let avatarsHtml = displayShares.map(share => {
      const name = share.recipient.name || share.recipient.email || 'User';
      const initial = name.charAt(0).toUpperCase();
      const email = share.recipient.email || '';
      const tooltip = `${this.escapeHtml(name)}${email ? ` (${this.escapeHtml(email)})` : ''}`;
      return `<span class="wf-share-avatar" title="${tooltip}" data-tooltip="${tooltip}">${initial}</span>`;
    }).join('');

    if (extraCount > 0) {
      const moreLabel = window.I18n?.t('workflow.share.moreUsers', { count: extraCount }) || `+${extraCount} người khác`;
      avatarsHtml += `<span class="wf-share-avatar wf-share-avatar-more" title="${this.escapeAttr(moreLabel)}">+${extraCount}</span>`;
    }

    return `
      <div class="wf-share-avatars wf-share-avatars--editor" title="${window.I18n?.t('workflow.share.manageTitle') || 'Quản lý chia sẻ'}">
        <span class="wf-share-label">${window.I18n?.t('workflow.share.label') || 'Shared'}</span>
        <div class="wf-share-avatar-stack">${avatarsHtml}</div>
      </div>`;
  }

  // ========== UNDO / REDO HISTORY ==========

  /**
   * Bind keyboard + eventBus listeners cho undo system.
   * Listeners đồng bộ với DiagramCanvas events (snapshot mỗi action).
   */
  _bindHistoryEvents() {
    if (!this.history) return;

    // Keyboard: Ctrl/Cmd+Z = undo, Ctrl/Cmd+Shift+Z hoặc Ctrl+Y = redo
    this._historyKeyHandler = (e) => {
      // Skip nếu đang nhập trong text field (cho phép native undo)
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      // Skip nếu workflow editor không mở
      if (!this.overlay || this.overlay.classList.contains('hidden')) return;

      const isMod = e.metaKey || e.ctrlKey;
      if (!isMod) return;
      const key = e.key.toLowerCase();
      if (key === 'z' && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        this._handleUndo();
      } else if ((key === 'z' && e.shiftKey) || key === 'y') {
        e.preventDefault();
        e.stopPropagation();
        this._handleRedo();
      }
    };
    document.addEventListener('keydown', this._historyKeyHandler, true);

    // Discrete actions (snapshot ngay)
    const discreteEvents = [
      'node:created', 'node:removed', 'node:duplicated',
      'edge:created', 'edge:removed', 'workflow:edges_migrated',
      'node:toggled',
    ];
    this._historyEventHandlers = {};
    discreteEvents.forEach(evt => {
      const h = () => {
        this.history?.takeSnapshot(evt);
        this._updateUndoRedoButtons();
      };
      this._historyEventHandlers[evt] = h;
      window.eventBus?.on(evt, h);
    });

    // Continuous actions (debounced 400ms)
    const debouncedEvents = ['node:moved', 'node:data_changed'];
    debouncedEvents.forEach(evt => {
      const h = () => {
        this.history?.scheduleSnapshot(evt, 400);
        // Update buttons sau debounce delay (ưu tiên responsiveness — defer tới sau snapshot fire)
        setTimeout(() => this._updateUndoRedoButtons(), 450);
      };
      this._historyEventHandlers[evt] = h;
      window.eventBus?.on(evt, h);
    });
  }

  /**
   * Dispatch toolbar action — dùng chung cho left toolbar click + canvas right-click menu.
   * @param {string} action — vd 'add-node', 'run-workflow', 'undo', 'redo', ...
   * @param {Object} [opts] — { canvasX, canvasY } cho add-node spawn position
   */
  _dispatchToolbarAction(action, opts = {}) {
    // Guard: Check permissions before executing actions
    const perms = this.getPermissions();

    if (action === 'add-node') {
      if (!perms.canEdit) return; // Guard: read-only mode
      // Smart placement priority:
      //   1. opts.canvasX/Y (explicit from right-click context menu)
      //   2. _lastMouseCanvasPos (tracked from user's mouse on canvas)
      //   3. Center of diagram (fallback)
      const rect = this.overlay.querySelector('#diagramContainer')?.getBoundingClientRect();
      const fallbackX = rect ? rect.width / 2 : 200;
      const fallbackY = rect ? rect.height / 2 : 200;
      const posX = opts.canvasX ?? this._lastMouseCanvasPos?.x ?? fallbackX;
      const posY = opts.canvasY ?? this._lastMouseCanvasPos?.y ?? fallbackY;
      this._showNodePicker(posX, posY);
    } else if (action === 'run-workflow') {
      if (!this.canRun()) return; // Guard: permission + featureGate
      this._runWorkflowFromEditor();
    } else if (action === 'stop-workflow') {
      // Force stop (mirror ExecutionTracker._handleStop). Bug fix 2026-05-27: trước đây gọi
      // workflowExecutor.stop() = graceful → khi single-node ĐÃ submit (hasSubmittedNodes) thì
      // KHÔNG gửi stopExecution → Flow content script vẫn chờ tile → "stop không tác dụng".
      this._forceStopExecution();
    } else if (action === 'toggle-log') {
      if (!perms.showLog) return; // Guard: template mode
      const logPanel = this.overlay?.querySelector('#executionLogPanel');
      if (logPanel) logPanel.classList.toggle('hidden');
    } else if (action === 'fit-screen') {
      this.diagramCanvas?.fitToScreen?.();
    } else if (action === 'auto-layout') {
      if (!perms.canEdit) return; // Guard: read-only mode
      this._autoLayoutNodes();
    } else if (action === 'settings') {
      if (!perms.canEdit) return; // Guard: read-only mode
      this._showWorkflowSettings();
    } else if (action === 'export-workflow') {
      if (!perms.canExport) return; // Guard: mode check
      this.exportWorkflow();
    } else if (action === 'share-workflow') {
      if (!this.canShare()) return; // Guard: permission + featureGate
      this._shareWorkflow();
    } else if (action === 'undo') {
      if (!perms.canEdit) return; // Guard: read-only mode
      this._handleUndo();
    } else if (action === 'redo') {
      if (!perms.canEdit) return; // Guard: read-only mode
      this._handleRedo();
    } else if (action === 'paste-image') {
      if (!perms.canEdit) return; // Guard: read-only mode
      this._pasteImageFromClipboard(opts).catch(err => {
        console.warn('[WorkflowEditor] pasteImageFromClipboard failed:', err?.message);
      });
    } else if (action === 'paste-node') {
      if (!perms.canEdit) return; // Guard: read-only mode
      // v1.1 Node clipboard: paste tại right-click coord (opts.canvasX/Y) — fallback
      // cursor pos / center handled trong `_pasteNodeFromClipboard` via _lastMouseCanvasPos.
      if (opts.canvasX != null && opts.canvasY != null) {
        // Override _lastMouseCanvasPos tạm thời để paste tại right-click position
        const prevPos = this._lastMouseCanvasPos;
        this._lastMouseCanvasPos = { x: opts.canvasX, y: opts.canvasY };
        try { this._pasteNodeFromClipboard(); } finally { this._lastMouseCanvasPos = prevPos; }
      } else {
        this._pasteNodeFromClipboard();
      }
    }
  }

  /**
   * v1.1 paste image feature: đọc clipboard qua Clipboard API (cần `clipboardRead`
   * permission + user gesture). Gọi từ context menu — Ctrl+V trực tiếp vẫn dùng
   * paste handler ở `_bindCanvasPasteHandler`.
   */
  async _pasteImageFromClipboard(opts = {}) {
    if (!navigator.clipboard?.read) {
      window.showNotification?.(
        window.I18n?.t?.('workflow.pasteImage.clipboardUnavailable')
          || 'Browser không hỗ trợ Clipboard API — dùng Ctrl+V trực tiếp.',
        'warning'
      );
      return;
    }
    let items;
    try {
      items = await navigator.clipboard.read();
    } catch (err) {
      window.showNotification?.(
        window.I18n?.t?.('workflow.pasteImage.clipboardDenied')
          || 'Không thể đọc clipboard — dùng Ctrl+V trực tiếp.',
        'warning'
      );
      return;
    }

    const files = [];
    for (const item of items) {
      const imageType = item.types?.find(t => t.startsWith('image/'));
      if (!imageType) continue;
      try {
        const blob = await item.getType(imageType);
        const ext = imageType.split('/')[1] || 'png';
        const file = new File([blob], `pasted-${Date.now()}.${ext}`, { type: imageType });
        files.push(file);
      } catch (err) {
        console.warn('[WorkflowEditor] clipboard getType failed:', err?.message);
      }
    }

    if (files.length === 0) {
      window.showNotification?.(
        window.I18n?.t?.('workflow.pasteImage.noImageInClipboard')
          || 'Clipboard không có ảnh. Copy ảnh trước rồi thử lại.',
        'info'
      );
      return;
    }

    // Position: ưu tiên context menu coord, fallback center viewport
    const rect = this.overlay?.querySelector('#diagramContainer')?.getBoundingClientRect();
    const fallbackX = rect ? rect.width / 2 : 200;
    const fallbackY = rect ? rect.height / 2 : 200;
    const posX = opts.canvasX ?? this._lastMouseCanvasPos?.x ?? fallbackX;
    const posY = opts.canvasY ?? this._lastMouseCanvasPos?.y ?? fallbackY;
    await this._handlePastedImages(files, posX, posY);
  }

  /**
   * Show right-click context menu trên vùng trống diagram.
   * Items mirror left toolbar (add-node, run, undo, redo, fit-screen, ...).
   * Trước khi execute action: đóng node form (với unsaved/upload check).
   */
  _showCanvasContextMenu(clientX, clientY, canvasX, canvasY) {
    // Preview mode: không cho right-click menu
    if (this.isReadOnly()) {
      return;
    }

    this._hideCanvasContextMenu();
    // Store canvas coords for add-node action
    this._contextMenuCanvasPos = (canvasX != null && canvasY != null) ? { x: canvasX, y: canvasY } : null;

    // Async probe clipboard cho image (right-click = user gesture → clipboard.read OK).
    // Fire-and-forget: render menu ngay (không await), inject paste-image sau nếu có image.
    // Tránh delay menu open + tránh permission prompt mỗi lần right-click.
    this._probeClipboardForImage();

    const t = (key, fallback) => window.I18n?.t?.(key) || fallback;
    const isCreate = this.mode === 'create';
    const isRunning = !!window.workflowExecutor?.isRunning;
    const isTemplate = this.isTemplateMode;
    // Items đồng bộ với toolbar: ẩn run/stop/export theo mode, ẩn execution items trong template mode
    const items = [
      { action: 'add-node', label: t('workflow.addNodeShortcut', 'Thêm node (N)'), iconSvg: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>' },
      // v1.1 Node clipboard: Paste node — chỉ hiện khi clipboard có data
      this._nodeClipboard?.data ? { action: 'paste-node', label: t('workflow.pasteNodeMenu', 'Dán node (Ctrl+V)'), iconSvg: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>' } : null,
      // v1.1 paste image: chỉ hiện khi `_clipboardHasImage = true` (set bởi `_probeClipboardForImage`).
      // Fast-path: nếu cache TTL còn (probe gần đây) → render sync; else show ban đầu = no, inject sau khi probe done.
      // Template mode: ẩn paste-image (Flow CDN URL signature TTL → ảnh missing sau vài ngày).
      // Admin dùng admin Template Settings cho ref images permanent.
      (this._clipboardHasImage && !this.isTemplateMode) ? { action: 'paste-image', label: t('workflow.pasteImageMenu', 'Dán ảnh (Ctrl+V)'), iconSvg: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>' } : null,
      // Ẩn run/stop trong template mode
      (isCreate || isTemplate) ? null : (isRunning
        ? { action: 'stop-workflow', label: t('workflow.stopBtn', 'Dừng'), iconSvg: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="6" width="12" height="12"/></svg>' }
        : { action: 'run-workflow', label: t('workflow.runShortcut', 'Chạy (Ctrl+Enter)'), iconSvg: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>' }
      ),
      { divider: true },
      { action: 'undo', label: t('workflow.undoShortcut', 'Hoàn tác (Ctrl+Z)'), iconSvg: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-15-6.7L3 13"/></svg>', disabled: !this.history?.canUndo?.() },
      { action: 'redo', label: t('workflow.redoShortcut', 'Làm lại (Ctrl+Shift+Z)'), iconSvg: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 7v6h-6"/><path d="M3 17a9 9 0 0 1 15-6.7L21 13"/></svg>', disabled: !this.history?.canRedo?.() },
      { divider: true },
      // Ẩn toggle-log trong template mode
      isTemplate ? null : { action: 'toggle-log', label: t('workflow.logAndProgress', 'Log & tiến độ'), iconSvg: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>' },
      { action: 'fit-screen', label: t('workflow.fitScreen', 'Vừa màn hình (F)'), iconSvg: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>' },
      { action: 'auto-layout', label: t('workflow.autoLayout', 'Sắp xếp lại nodes'), iconSvg: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="6" height="6" rx="1"/><rect x="15" y="3" width="6" height="6" rx="1"/><rect x="3" y="15" width="6" height="6" rx="1"/><rect x="15" y="15" width="6" height="6" rx="1"/><line x1="9" y1="6" x2="15" y2="6"/><line x1="9" y1="18" x2="15" y2="18"/><line x1="6" y1="9" x2="6" y2="15"/><line x1="18" y1="9" x2="18" y2="15"/></svg>' },
      { divider: true },
      // Settings label thay đổi theo mode
      { action: 'settings', label: isTemplate ? t('workflow.templateSettings', 'Cài đặt template') : t('workflow.settingsWorkflow', 'Cài đặt workflow'), iconSvg: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>' },
      // Ẩn export/share trong template mode. Lock badge khi feature bị lock.
      (isCreate || isTemplate) ? null : {
        action: 'export-workflow',
        label: t('workflow.exportBtn', 'Xuất workflow'),
        iconSvg: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
        locked: !window.featureGate?.canUse('workflow_export')
      },
      (isCreate || isTemplate || this.isReadOnly()) ? null : {
        action: 'share-workflow',
        label: t('workflow.shareBtn', 'Chia sẻ'),
        iconSvg: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>',
        locked: !window.featureGate?.canUse('workflow_share_enabled')
      },
    ].filter(Boolean);

    const menu = document.createElement('div');
    menu.className = 'df-canvas-context-menu';
    const lockBadgeSvg = '<svg class="wf-ctx-lock-badge" width="9" height="9" viewBox="0 0 24 24" fill="var(--warning, #f59e0b)" stroke="var(--warning, #f59e0b)" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4" fill="none"></path></svg>';
    menu.innerHTML = items.map(item => {
      if (item.divider) return '<div class="df-canvas-context-divider"></div>';
      const disabledAttr = item.disabled ? ' disabled' : '';
      const disabledClass = item.disabled ? ' df-canvas-context-item--disabled' : '';
      const lockedClass = item.locked ? ' df-canvas-context-item--locked' : '';
      const iconWithBadge = item.locked ? `${item.iconSvg}${lockBadgeSvg}` : item.iconSvg;
      return `<button type="button" class="df-canvas-context-item${disabledClass}${lockedClass}" data-action="${item.action}"${disabledAttr}>
        <span class="df-canvas-context-icon">${iconWithBadge}</span>
        <span class="df-canvas-context-label">${item.label}</span>
      </button>`;
    }).join('');

    // Position — clamp trong viewport
    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    const maxX = window.innerWidth - rect.width - 8;
    const maxY = window.innerHeight - rect.height - 8;
    menu.style.left = `${Math.max(8, Math.min(clientX, maxX))}px`;
    menu.style.top = `${Math.max(8, Math.min(clientY, maxY))}px`;
    this._canvasContextMenu = menu;

    // Click handler — đóng form (với unsaved/upload check) → execute action
    menu.addEventListener('click', async (e) => {
      const btn = e.target.closest('.df-canvas-context-item');
      if (!btn || btn.disabled) return;
      const action = btn.dataset.action;
      this._hideCanvasContextMenu();

      // Đóng node form nếu đang mở (kiểm tra unsaved + upload)
      if (this.selectedNodeId) {
        await this._handleNodeUnselected();
        // Nếu user cancel dialog → form vẫn mở → KHÔNG execute action (tránh mất context)
        if (this.selectedNodeId) return;
      }
      // Pass canvas coords cho add-node / paste-image / paste-node (placement tại right-click position)
      const opts = (action === 'add-node' || action === 'paste-image' || action === 'paste-node') && this._contextMenuCanvasPos
        ? { canvasX: this._contextMenuCanvasPos.x, canvasY: this._contextMenuCanvasPos.y }
        : {};
      this._dispatchToolbarAction(action, opts);
    });

    // Click ngoài menu → đóng. setTimeout để bỏ qua right-click event hiện tại.
    setTimeout(() => {
      const closeOnOutsideClick = (e) => {
        if (!menu.contains(e.target)) {
          this._hideCanvasContextMenu();
          document.removeEventListener('click', closeOnOutsideClick, true);
          document.removeEventListener('contextmenu', closeOnOutsideClick, true);
        }
      };
      document.addEventListener('click', closeOnOutsideClick, true);
      document.addEventListener('contextmenu', closeOnOutsideClick, true);
      this._canvasContextMenuCloseHandler = closeOnOutsideClick;
    }, 0);
  }

  _hideCanvasContextMenu() {
    if (this._canvasContextMenu) {
      this._canvasContextMenu.remove();
      this._canvasContextMenu = null;
    }
    if (this._canvasContextMenuCloseHandler) {
      document.removeEventListener('click', this._canvasContextMenuCloseHandler, true);
      document.removeEventListener('contextmenu', this._canvasContextMenuCloseHandler, true);
      this._canvasContextMenuCloseHandler = null;
    }
    this._contextMenuCanvasPos = null;
  }

  /**
   * Probe clipboard cho image content. Right-click = user gesture → clipboard.read OK.
   * Fire-and-forget: update `this._clipboardHasImage` + inject paste-image vào menu hiện tại
   * nếu found. Tránh delay menu open (probe ~10-50ms).
   */
  async _probeClipboardForImage() {
    if (!navigator.clipboard?.read) {
      this._clipboardHasImage = false;
      return;
    }
    let hasImage = false;
    try {
      const items = await navigator.clipboard.read();
      hasImage = items.some(item => item.types?.some(t => t.startsWith('image/')));
    } catch (err) {
      // Permission denied / no clipboard access → giả định không có image (tránh false positive)
      hasImage = false;
    }
    this._clipboardHasImage = hasImage;

    // Template mode: skip inject — paste image bị block (xem `_handlePastedImages` guard).
    if (this.isTemplateMode) return;

    // Inject paste-image menu item nếu probe finished AFTER menu rendered (race common case).
    // Menu vẫn open + chưa có paste-image → tìm vị trí sau paste-node (hoặc sau add-node) → insert.
    if (hasImage && this._canvasContextMenu && !this._canvasContextMenu.querySelector('[data-action="paste-image"]')) {
      try { this._injectPasteImageMenuItem(); } catch (e) { /* ignore */ }
    }
  }

  /**
   * Dynamically inject paste-image menu item vào canvas context menu hiện tại
   * (sau khi async clipboard probe xác định có image).
   */
  _injectPasteImageMenuItem() {
    const menu = this._canvasContextMenu;
    if (!menu) return;
    const t = (key, fallback) => window.I18n?.t?.(key) || fallback;
    const label = t('workflow.pasteImageMenu', 'Dán ảnh (Ctrl+V)');
    const html = `<button type="button" class="df-canvas-context-item" data-action="paste-image">
      <span class="df-canvas-context-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg></span>
      <span class="df-canvas-context-label">${label}</span>
    </button>`;
    // Insert sau paste-node nếu có, else sau add-node
    const refItem = menu.querySelector('[data-action="paste-node"]')
      || menu.querySelector('[data-action="add-node"]');
    const wrapper = document.createElement('div');
    wrapper.innerHTML = html;
    const newBtn = wrapper.firstElementChild;
    if (refItem && refItem.nextSibling) {
      refItem.parentNode.insertBefore(newBtn, refItem.nextSibling);
    } else if (refItem) {
      refItem.parentNode.appendChild(newBtn);
    } else {
      menu.insertBefore(newBtn, menu.firstChild);
    }
  }

  /**
   * Handle Ctrl+Z — restore previous snapshot.
   */
  _handleUndo() {
    if (!this.history) return;
    // Read-only mode: không cho undo
    if (this.isReadOnly()) return;
    if (!this.history.canUndo()) {
      window.showNotification?.(
        window.I18n?.t('workflow.undoEmpty') || 'Không có thao tác để hoàn tác',
        'info', 1500
      );
      return;
    }
    const restored = this.history.undo();
    if (restored) {
      window.showNotification?.(
        window.I18n?.t('workflow.undone') || 'Undone',
        'success', 1200
      );
      this._updateUndoRedoButtons();
    }
  }

  /**
   * Handle Ctrl+Shift+Z / Ctrl+Y — restore next snapshot.
   */
  _handleRedo() {
    if (!this.history) return;
    // Read-only mode: không cho redo
    if (this.isReadOnly()) return;
    if (!this.history.canRedo()) {
      window.showNotification?.(
        window.I18n?.t('workflow.redoEmpty') || 'Nothing to redo',
        'info', 1500
      );
      return;
    }
    const restored = this.history.redo();
    if (restored) {
      window.showNotification?.(
        window.I18n?.t('workflow.redone') || 'Redone',
        'success', 1200
      );
      this._updateUndoRedoButtons();
    }
  }

  /**
   * Update enabled/disabled state cho undo/redo buttons trong toolbar.
   * Gọi sau mỗi snapshot / undo / redo.
   */
  _updateUndoRedoButtons() {
    if (!this.overlay) return;
    const undoBtn = this.overlay.querySelector('#wfUndoBtn');
    const redoBtn = this.overlay.querySelector('#wfRedoBtn');
    if (undoBtn) {
      const canUndo = this.history?.canUndo();
      undoBtn.disabled = !canUndo;
      undoBtn.classList.toggle('tobyflow-wf-tool-btn--disabled', !canUndo);
    }
    if (redoBtn) {
      const canRedo = this.history?.canRedo();
      redoBtn.disabled = !canRedo;
      redoBtn.classList.toggle('tobyflow-wf-tool-btn--disabled', !canRedo);
    }
  }

  /**
   * Restore workflow từ snapshot data (called by WorkflowHistory).
   * Re-load nodes + edges qua DiagramCanvas + sync this.workflow state.
   */
  _restoreFromHistorySnapshot(snapshot) {
    if (!this.diagramCanvas || !snapshot) return;
    // Snapshot có format giống exportWorkflow output: { nodes, edges, settings, ... }
    const tempWorkflow = {
      ...this.workflow,
      ...snapshot,
      wf_id: this.workflow?.wf_id, // Preserve wf_id
      nodes: snapshot.nodes || [],
      edges: snapshot.edges || [],
    };
    this.workflow = tempWorkflow;

    // Reload diagram
    try {
      this.diagramCanvas.loadWorkflow(tempWorkflow);
    } catch (e) {
      console.error('[WorkflowEditor] Restore loadWorkflow failed:', e);
      return;
    }

    // Re-bind UI hooks sau load (defer 1 frame để DOM ready)
    requestAnimationFrame(() => {
      try { this._restoreNodeStates(); } catch (e) {}
      try { this._scheduleRefreshNodeWarningBadges(); } catch (e) {}
      try { this._updatePortEmptyState(); } catch (e) {}
      try { this._bindEdgeHoverTooltips(); } catch (e) {}
    });

    // Mark dirty với debounce 1500ms — collapse multiple undo/redo liên tiếp.
    // Lý do: user thường undo nhiều bước rồi redo lại để so sánh, không nên
    // mark dirty + flash save button mỗi lần. Sau 1.5s idle mới flag dirty.
    if (this._undoRedoDirtyTimer) clearTimeout(this._undoRedoDirtyTimer);
    this._undoRedoDirtyTimer = setTimeout(() => {
      this._hasUnsavedChanges = true;
      this._undoRedoDirtyTimer = null;
    }, 1500);
  }

  /**
   * Take initial snapshot khi workflow load xong (baseline cho undo).
   * Gọi sau diagramCanvas.loadWorkflow.
   */
  _takeInitialHistorySnapshot() {
    if (!this.history) return;
    // Defer 2 frames + 100ms để Drawflow finalize DOM + post-load events
    // (workflow:edges_migrated, edge:created qua Drawflow re-render) settle.
    // Reset stack TRƯỚC khi push baseline → loại bỏ snapshot rác phát sinh
    // trong load flow → vừa mở workflow KHÔNG thể undo (đúng UX expected).
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setTimeout(() => {
          this.history.reset();
          this.history.takeSnapshot('initial');
          this._updateUndoRedoButtons();
        }, 100);
      });
    });
  }
}

// Export
window.WorkflowEditor = WorkflowEditor;
