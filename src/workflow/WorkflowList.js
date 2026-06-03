/**
 * WorkflowList - Hiển thị danh sách workflows
 */
class WorkflowList {
  constructor(container) {
    this.container = container;
    this.workflows = [];
    this._opening = false;
    this._editingWfId = null;
    this._filterProjectId = null; // Y-2: null = show all
    this._projectNames = {};
    this._searchQuery = ''; // Search query
    this.isRunningAll = false;
    this.shouldStopAll = false;
    this._pendingWfIds = new Set(); // Track workflows queued to run
    this._stoppedWfIds = new Set(); // Track recently stopped workflows để force status='pending' khi re-render
    // Server-side pagination
    this._pageSize = 20;
    this._currentPage = 1;
    this._lastPage = 1;
    this._total = 0;
    this._loading = false;
    this._loadPending = false; // Queue reload request while loading
    this._loadDebounceTimer = null; // Debounce timer for rapid events
    this._sharedWorkflows = []; // Workflows được chia sẻ với user
    this._isCloningWorkflow = false; // Lock để tránh duplicate click khi clone
    this._isDuplicatingShared = false; // Lock để tránh duplicate click khi duplicate từ shared

    this.init();
  }

  async init() {
    // Load _stoppedWfIds từ storage (survive page refresh)
    try {
      const stored = await chrome.storage.local.get('af_stopped_wfids');
      if (stored.af_stopped_wfids?.length) {
        this._stoppedWfIds = new Set(stored.af_stopped_wfids);
        console.log('[WorkflowList] Restored _stoppedWfIds from storage:', this._stoppedWfIds.size);
      }
    } catch (e) { /* ignore */ }

    await this.loadWorkflows();
    await this.loadSharedWorkflows();
    this.bindGlobalEvents();
    this._bindToolbarEvents();
    // [Audit Bug 7 fix 2026-06-22] Replay execution events queued by background while sidepanel closed.
    this._replayQueuedExecutionEvents();
  }

  /**
   * [Audit Bug 7 fix 2026-06-22] Đọc + dispatch execution events backup từ chrome.storage.session
   * (do background.js queue khi sidepanel chưa mở). Drain queue sau replay.
   * Acceptable lag: events ≤ 50, dispatch trong cùng tick → UI catch-up gần như instant.
   */
  async _replayQueuedExecutionEvents() {
    try {
      const sessionStore = chrome.storage?.session;
      if (!sessionStore) return; // Service worker context cũ hoặc browser không support
      const res = await new Promise(resolve => sessionStore.get(['af_execution_event_queue'], resolve));
      const queue = Array.isArray(res?.af_execution_event_queue) ? res.af_execution_event_queue : [];
      if (queue.length === 0) return;
      console.log(`[WorkflowList] Replaying ${queue.length} queued execution events`);
      for (const msg of queue) {
        if (msg?.event && window.eventBus) {
          try { window.eventBus.emit(msg.event, msg.data || {}); } catch (_) { /* skip */ }
        }
      }
      // Drain queue sau replay
      await new Promise(resolve => sessionStore.remove(['af_execution_event_queue'], resolve));
    } catch (e) {
      console.warn('[WorkflowList] Replay queue failed:', e.message);
    }
  }

  bindGlobalEvents() {
    if (window.eventBus) {
      // [API SPAM FIX — Phase 6] Single workflow update thay vì reload all list.
      // Events có wfId → chỉ update workflow đó. Events không có wfId → fallback debounced reload.
      window.eventBus.on('storage:workflow_saved', (data) => {
        const wfId = data?.wfId || data?.wf_id || data?.workflow?.wf_id;
        this._lastSaveTime = Date.now();
        if (wfId) {
          this._debouncedUpdateSingleWorkflow(wfId);
        } else {
          this._debouncedLoadWorkflows();
        }
      });
      window.eventBus.on('storage:workflow_full_saved', (data) => {
        const wfId = data?.wfId || data?.wf_id || data?.workflow?.wf_id;
        this._lastSaveTime = Date.now();
        if (wfId) {
          this._debouncedUpdateSingleWorkflow(wfId);
        } else {
          this._debouncedLoadWorkflows();
        }
      });
      // 2026-05-25: Fix delete không refresh list.
      // Trước fix: chỉ gọi _debouncedLoadWorkflows() → bị block bởi cooldown logic
      // (line 1065: BLOCKED loadWorkflows khi _executionCooldown=true + _lastUpdatedWfId).
      // User vừa run workflow Y → delete workflow X → reload bị block → X vẫn hiển thị.
      // Sau fix: optimistic removal local + clear stale refs + force re-render ngay.
      window.eventBus.on('storage:workflow_deleted', (data) => {
        const wfId = data?.wfId;
        if (wfId && Array.isArray(this.workflows)) {
          // Optimistic: remove deleted workflow khỏi local list
          this.workflows = this.workflows.filter(w => w.wf_id !== wfId);
          // Clear stale refs để cooldown logic không trigger single-update cho workflow đã xóa
          if (this._lastUpdatedWfId === wfId) this._lastUpdatedWfId = null;
          this._stoppedWfIds?.delete(wfId);
          // Re-render ngay với data đã filter
          try { this.render(); } catch (e) { /* ignore */ }
        }
        // Trigger reload để sync pagination + fresh count (sẽ skip nếu cooldown active, OK vì local đã update)
        this._debouncedLoadWorkflows();
      });
      window.eventBus.on('workflow:status_updated', (data) => {
        const wfId = data?.wfId || data?.wf_id || data?.workflow?.wf_id;
        if (wfId) {
          this._debouncedUpdateSingleWorkflow(wfId);
        } else {
          this._debouncedLoadWorkflows();
        }
      });
      // K.14 (2026-05-29): Sidebar self emit `workflow:reset` (line 3029) sau khi user click
      // reset card. Runtime listener (line 308) skip self-message (`_originSidebar=true`) →
      // sidebar không tự update card via cross-context path. CẦN listener local riêng để
      // update card color/status sau reset.
      window.eventBus.on('workflow:reset', (data) => {
        const wfId = data?.workflowId || data?.wfId || data?.wf_id;
        if (!wfId) return;
        // Reset card running state về idle + reload single workflow để fetch fresh status='pending'.
        this._updateCardRunningState(wfId, false, 'pending');
        this._debouncedUpdateSingleWorkflow(wfId);
      });
      // [API SPAM FIX — Phase 6] Track running workflow để các events không có wfId có thể dùng
      window.eventBus.on('execution:started', (data) => {
        const wfId = data?.workflow?.wf_id || data?.wfId;
        console.log('[WorkflowList] execution:started received:', wfId, data);
        if (wfId) {
          this._lastUpdatedWfId = wfId;
          // Clear stopped flag khi workflow chạy lại
          this._stoppedWfIds?.delete(wfId);
          // Update card to running state
          this._updateCardRunningState(wfId, true);
        }
      });
      window.eventBus.on('execution:completed', (data) => {
        // Fallback to _lastUpdatedWfId nếu event không có wfId (broadcast từ popup)
        const wfId = data?.workflow?.wf_id || data?.wfId || this._lastUpdatedWfId;
        console.log('[WorkflowList] execution:completed received:', wfId);
        // Final update cho workflow vừa xong
        if (wfId) {
          this._updateCardRunningState(wfId, false, data?.stopped ? 'pending' : (data?.error ? 'failed' : 'completed'));
          this._debouncedUpdateSingleWorkflow(wfId);
        }
        // Cooldown: skip full reload trong 5s sau execution (nhiều events cùng fire)
        this._executionCooldown = true;
        setTimeout(() => {
          this._executionCooldown = false;
          // Check nếu có pending load request (từ workflowEditorClosed trong cooldown)
          if (this._pendingLoadAfterCooldown) {
            this._pendingLoadAfterCooldown = false;
            console.log('[WorkflowList] Cooldown ended, executing pending loadWorkflows');
            this.loadWorkflows();
          }
        }, 5000);
        // Clear tracking sau 2s (cho phép các events trễ vẫn dùng được)
        setTimeout(() => { this._lastUpdatedWfId = null; }, 2000);
      });
      // [API SPAM FIX — Phase 6] Listen progress để update progress bar (không cần API call)
      window.eventBus.on('execution:progress', (data) => {
        if (!this._lastUpdatedWfId) return;
        const { total, completed } = data;
        console.log('[WorkflowList] execution:progress:', completed, '/', total);
        if (total > 0) {
          const percent = Math.round((completed / total) * 100);
          this._updateCardProgress(this._lastUpdatedWfId, percent);
        }
      });
      // SSE listener để refresh khi share được chấp nhận
      window.eventBus.on('workflow:share_accepted', () => this.loadSharedWorkflows());
      // Recipient từ chối share → sharer cần re-load shared list (clear pending state)
      window.eventBus.on('workflow:share_rejected', () => {
        try { this.loadSharedWorkflows(); } catch (_) {}
        if (window.TobyNotify?.info) {
          window.TobyNotify.info(window.I18n?.t('workflow.shareRejected') || 'Người nhận đã từ chối share');
        }
      });
      // Sharer revoke access → recipient mất quyền, refresh shared list
      window.eventBus.on('workflow:share_revoked', () => {
        try { this.loadSharedWorkflows(); } catch (_) {}
        if (window.TobyNotify?.warning) {
          window.TobyNotify.warning(window.I18n?.t('workflow.shareRevoked') || 'Quyền share đã bị thu hồi');
        }
      });
      // Handler khi user accept share từ NotificationModal và đã clone workflow
      window.eventBus.on('workflow:shared_accepted', async (data) => {
        if (data?.copied && data?.workflow?.wf_id) {
          await this.loadWorkflows();
          // Switch to My Workflows tab
          const workflowsTab = document.querySelector('[data-subtab="workflows"]');
          if (workflowsTab) workflowsTab.click();
          // Auto-open the cloned workflow
          setTimeout(() => {
            if (this._openWorkflow) {
              this._openWorkflow(data.workflow.wf_id);
            }
          }, 300);
        } else {
          // Only accepted without copy - refresh shared list
          this.loadSharedWorkflows();
        }
      });
    }

    // Detect workflow data changes from other contexts (popup editor window).
    // [API SPAM FIX — Phase 6] Nếu có workflow đang chạy (tracked via _lastUpdatedWfId),
    // chỉ update workflow đó. Nếu không, full refresh (vd: user edit trong editor khác).
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === 'local' && (changes.af_workflows || changes.af_nodes)) {
        // Nếu đang có workflow execution, single update
        if (this._lastUpdatedWfId && window.workflowExecutor?.isRunning) {
          this._debouncedUpdateSingleWorkflow(this._lastUpdatedWfId);
        } else {
          this._debouncedLoadWorkflows();
        }
      }
    });

    // U-4.3: Re-render khi chuyển project
    if (window.eventBus) {
      // Bug fix 2026-05-28: switch project → list PHẢI follow sang project mới. Trước: chỉ
      // loadWorkflows() re-fetch all nhưng _filterProjectId (filter hiển thị) KHÔNG đổi → list
      // giữ nguyên view cũ → "không refresh". Fix: set _filterProjectId theo project vừa switch
      // → render ngay (view đổi tức thì dù executor-guard chặn loadWorkflows) + refresh data nền.
      window.eventBus.on('project:changed', (data) => {
        if (data && data.projectId !== undefined) {
          this._filterProjectId = data.projectId || null;
          try { this.renderWorkflowList(); } catch (_) {}
        }
        this.loadWorkflows();
      });
      // Reload workflows khi user login (data từ server)
      window.eventBus.on('auth:login', () => this.loadWorkflows());
      // CRITICAL: auth:login fire TRƯỚC switchToApi() → loadWorkflows chạy trong
      // local mode (đã wipe sau reinstall) → empty. Listen mode_changed để reload
      // KHI storage thực sự switch sang api → fetch từ server.
      window.eventBus.on('storage:mode_changed', (data) => {
        if (data?.mode === 'api') this.loadWorkflows();
      });
      // Re-render khi đổi ngôn ngữ (chỉ gọi render() một lần vì renderWorkflowList đã gọi render)
      window.eventBus.on('i18n:changed', () => {
        this.renderWorkflowList();
        // Cũng re-render shared tab nếu đang hiển thị
        const sharedTabContent = document.querySelector('[data-content="shared"]');
        if (sharedTabContent && !sharedTabContent.classList.contains('hidden')) {
          this.renderSharedTab(sharedTabContent);
        }
      });
      // Reload shared workflows khi user login (data từ server cho user mới)
      window.eventBus.on('auth:login', () => this.loadSharedWorkflows());
      // Clear shared workflows khi user logout
      window.eventBus.on('auth:logout', () => {
        this._sharedWorkflows = [];
        this._updateSharedTabBadge();
        const sharedTabContent = document.querySelector('[data-content="shared"]');
        if (sharedTabContent) this.renderSharedTab(sharedTabContent);
      });
    }

    // Listen for execution status updates and editor close from other contexts.
    // [API SPAM FIX — Phase 6] Single workflow update khi có wfId, fallback reload khi không có.
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg.action === 'executionStatusUpdate') {
        const wfId = msg.wfId || msg.workflowId;
        if (wfId) {
          this._debouncedUpdateSingleWorkflow(wfId);
        } else {
          this._debouncedLoadWorkflows();
        }
      }
      if (msg.action === 'workflowSaved') {
        const wfId = msg.wfId || msg.workflowId;
        this._lastSaveTime = Date.now();
        if (wfId) {
          this._debouncedUpdateSingleWorkflow(wfId);
        } else {
          this._debouncedLoadWorkflows();
        }
      }
      if (msg.action === 'workflowEditorClosed') {
        // 2026-05-25 BUG FIX: User mở menu 3-chấm + click share trong window 1s sau editor close
        // → _debouncedLoadWorkflows render replace innerHTML → share-btn listener mất →
        // click share không hiện modal. Document-level close-dropdown listener still active →
        // close menu silently → user thấy "ko response".
        // Fix: single-workflow update đủ sync data (status/updated_at). Skip full reload.
        const wfIdToUpdate = this._editingWfId || msg.wfId || this._lastUpdatedWfId;
        this._editingWfId = null;
        const recentSave = this._lastSaveTime && (Date.now() - this._lastSaveTime) < 2000;
        if (recentSave) {
          console.log('[WorkflowList] Skip editor close refresh — recent save already handled');
          return;
        }
        // Single-workflow update (no innerHTML replace → preserves dropdown listeners)
        if (wfIdToUpdate) {
          this._debouncedUpdateSingleWorkflow(wfIdToUpdate);
        }
        // Nếu đang trong cooldown, schedule load sau khi cooldown hết (legacy fallback)
        if (this._executionCooldown) {
          console.log('[WorkflowList] workflowEditorClosed during cooldown, scheduling load after cooldown');
          this._pendingLoadAfterCooldown = true;
        }
      }
      // Handle workflow execution events relayed from popup editor window
      if (msg.action === 'workflowExecutionEvent') {
        const { event, data } = msg;
        // Anti-loopback 1: skip nếu message có tag `_originSidebar` (do chính sidebar gửi đi,
        // bounce-back về self → tránh double reload). Popup editor không gắn tag này.
        if (msg._originSidebar) {
          return;
        }
        // Anti-loopback 2: skip nếu message do background relay (gắn `_bg_relayed: true`).
        // Bug fix 2026-05-25: Chrome auto-broadcast `chrome.runtime.sendMessage` tới mọi
        // extension context → sidebar đã nhận BẢN GỐC từ sender (popup). Background re-send
        // chỉ để probe receiver (promise resolve/reject), nhưng vô tình duplicate event
        // → listener fire 2 lần. Tag `_bg_relayed` để skip duplicate.
        if (msg._bg_relayed) {
          return;
        }
        // Emit to local eventBus for WorkflowTab listeners
        if (window.eventBus) {
          window.eventBus.emit(event, data);
        }
        // Handle remote stop from other context
        if (event === 'execution:stop') {
          console.log('[WorkflowList] Remote stop received, data:', data);
          if (window.workflowExecutor) {
            window.workflowExecutor.handleRemoteStop?.();
          }
          // Update card UI ngay lập tức
          const stopWfId = data?.wf_id || data?.workflow?.wf_id || this._lastUpdatedWfId;
          if (stopWfId) {
            this._updateCardRunningState(stopWfId, false, 'pending');
          }
        }
        // [API SPAM FIX — Phase 6] Extract wfId từ event data và single update
        if (['execution:started', 'execution:completed', 'workflow:reset', 'node:completed', 'execution:stop'].includes(event)) {
          const wfId = data?.workflow?.wf_id || data?.workflowId || data?.wfId;
          if (wfId) {
            this._debouncedUpdateSingleWorkflow(wfId);
          } else if (this._lastUpdatedWfId) {
            // Fallback: dùng wfId từ event gần nhất
            this._debouncedUpdateSingleWorkflow(this._lastUpdatedWfId);
          } else {
            this._debouncedLoadWorkflows();
          }
        }
      }
    });
  }

  /**
   * [API SPAM FIX — Phase 3.1] Debounce loadWorkflows 1s — coalesce nhiều listener
   * cùng react execution:completed / workflowSaved / executionStatusUpdate.
   * Tránh cascade gây 429 từ backend.
   */
  _debouncedLoadWorkflows() {
    // [API SPAM FIX — Phase 6] Skip full reload khi workflow đang chạy hoặc vừa xong
    // Chỉ single update cho workflow đang/vừa chạy, tránh giật UI và API spam
    if ((window.workflowExecutor?.isRunning || this._executionCooldown) && this._lastUpdatedWfId) {
      console.log('[WorkflowList] Skip loadWorkflows - executor running or cooldown, use single update instead');
      // CRITICAL: Clear pending timer để tránh fire sau khi executor xong
      if (this._loadCoalesceTimer) {
        clearTimeout(this._loadCoalesceTimer);
        this._loadCoalesceTimer = null;
      }
      this._debouncedUpdateSingleWorkflow(this._lastUpdatedWfId);
      return;
    }

    if (this._loadCoalesceTimer) clearTimeout(this._loadCoalesceTimer);
    this._loadCoalesceTimer = setTimeout(() => {
      this._loadCoalesceTimer = null;
      // Double check: executor có thể đã bắt đầu chạy hoặc đang cooldown
      if ((window.workflowExecutor?.isRunning || this._executionCooldown) && this._lastUpdatedWfId) {
        console.log('[WorkflowList] Skip loadWorkflows in timer - executor running or cooldown');
        return;
      }
      this.loadWorkflows();
    }, 1000);
  }

  /**
   * [API SPAM FIX — Phase 6] Update chỉ 1 workflow trong list thay vì reload all.
   * Giảm đáng kể API calls khi workflow đang chạy (mỗi node save → chỉ 1 GET thay vì GET all).
   * Ưu tiên: executor data > partialData > fetch từ server
   * @param {string} wfId - Workflow ID cần update
   * @param {object} [partialData] - Optional partial data để merge (nếu đã có sẵn, skip fetch)
   */
  async _updateSingleWorkflowInList(wfId, partialData = null) {
    if (!wfId) return;

    try {
      let updatedWorkflow = partialData;

      // Ưu tiên 1: Lấy status từ executor đang chạy (không cần API call)
      // CRITICAL: Chỉ dùng 'running' nếu executor thực sự đang chạy và chưa bị stop
      if (window.workflowExecutor?.currentWorkflow?.wf_id === wfId &&
          window.workflowExecutor.isRunning && !window.workflowExecutor.shouldStop) {
        const execWf = window.workflowExecutor.currentWorkflow;
        updatedWorkflow = {
          wf_id: wfId,
          status: execWf.status || 'running',
          // Có thể thêm progress nếu executor track
        };
      }

      // Nếu không có partialData, fetch từ server
      if (!updatedWorkflow) {
        updatedWorkflow = await window.storageManager?.getWorkflow(wfId);
      }

      if (!updatedWorkflow) return;

      // CRITICAL: Nếu executor đã stop nhưng server vẫn trả 'running', override thành 'pending'
      // Tránh race condition khi server chưa kịp cập nhật status sau khi user stop
      if (window.workflowExecutor?.shouldStop &&
          window.workflowExecutor?.currentWorkflow?.wf_id === wfId &&
          updatedWorkflow.status === 'running') {
        updatedWorkflow.status = 'pending';
      }

      // Tìm và update trong array
      const index = this.workflows.findIndex(w => w.wf_id === wfId);
      if (index >= 0) {
        // Merge data mới vào workflow hiện tại (giữ lại fields không có trong response)
        this.workflows[index] = { ...this.workflows[index], ...updatedWorkflow };
        // Re-render chỉ card này
        this._rerenderSingleWorkflowCard(wfId);
      } else if (updatedWorkflow.wf_id) {
        // Workflow mới tạo chưa có trong list → unshift + render lại để hiển thị
        this.workflows.unshift(updatedWorkflow);
        this.renderWorkflowList();
      }
    } catch (e) {
      console.warn('[WorkflowList] _updateSingleWorkflowInList failed:', wfId, e.message);
    }
  }

  /**
   * Update in-place 1 workflow card trong DOM (không replace toàn bộ để giữ event bindings).
   * Chỉ update các elements thay đổi: status badge, progress, timestamps.
   * @param {string} wfId
   */
  _rerenderSingleWorkflowCard(wfId) {
    const workflow = this.workflows.find(w => w.wf_id === wfId);
    if (!workflow) return;

    const card = this.container.querySelector(`.workflow-card[data-wf-id="${wfId}"]`);
    if (!card) return;

    // Update status class trên card (không có prefix "status-", CSS dùng .workflow-card.completed etc.)
    card.classList.remove('pending', 'running', 'completed', 'failed', 'paused', 'idle');
    if (workflow.status) {
      card.classList.add(workflow.status);
    }

    // [Editor close sync] Toggle .editing class theo _editingWfId hiện tại.
    // Bug: editor đóng → _editingWfId=null nhưng card vẫn giữ class 'editing'
    // → CSS border lime + "Editing" text persist dù workflow đã exit edit mode.
    const isEditing = this._editingWfId === wfId;
    card.classList.toggle('editing', isEditing);

    // [Editor close sync] Update meta text "X nodes" / "X nodes - Editing" / "X nodes - Y%"
    const metaEl = card.querySelector('.workflow-card-meta');
    if (metaEl) {
      const nodeCount = workflow.progress_total || 0;
      const completedCount = workflow.progress_completed || 0;
      const progress = nodeCount > 0 ? Math.round((completedCount / nodeCount) * 100) : 0;
      const isRunning = workflow.status === 'running' && !this._stoppedWfIds?.has(wfId);
      // Preserve leading SVG icon (firstChild), chỉ thay text content sau SVG
      const svg = metaEl.querySelector('svg');
      const metaText = `${nodeCount} nodes${isRunning ? ` - ${progress}%` : ''}${isEditing ? ' - Editing' : ''}`;
      metaEl.innerHTML = '';
      if (svg) metaEl.appendChild(svg);
      metaEl.appendChild(document.createTextNode(metaText));
    }

    // Update status badge (selector đúng: .workflow-card-status)
    const statusBadge = card.querySelector('.workflow-card-status');
    if (statusBadge && workflow.status) {
      const statusLabel = WorkflowList._renderStatusLabel(workflow.status);
      statusBadge.setAttribute('data-tooltip', statusLabel);
      statusBadge.setAttribute('aria-label', statusLabel);
      statusBadge.innerHTML = WorkflowList._renderStatusIcon(workflow.status);
      statusBadge.className = `workflow-card-status ${workflow.status}`;
    }

    // Update progress bar nếu có
    const progressBarFill = card.querySelector('.workflow-card-progress-bar-fill') ||
                            card.querySelector('.workflow-card-inline-progress-bar');
    const progressBarContainer = card.querySelector('.workflow-card-progress-bar') ||
                                  card.querySelector('.workflow-card-inline-progress');
    if (workflow.status === 'running' && workflow.progress !== undefined) {
      if (progressBarFill) {
        progressBarFill.style.width = `${workflow.progress}%`;
      }
      if (progressBarContainer) {
        progressBarContainer.classList.remove('hidden');
        progressBarContainer.style.display = '';
      }
    } else {
      if (progressBarContainer) progressBarContainer.classList.add('hidden');
    }

    // Update Run/Stop button visibility
    const runBtn = card.querySelector('.run-btn');
    const stopBtn = card.querySelector('.stop-btn');
    const runningBtns = card.querySelector('.wf-running-buttons');
    const dropdownMenu = card.querySelector('.tobyflow-dot-menu');
    const toggleBtn = card.querySelector('.wf-toggle-btn');
    if (workflow.status === 'running') {
      runBtn?.classList.add('hidden');
      stopBtn?.classList.remove('hidden');
      if (runningBtns) runningBtns.style.display = 'flex';
      if (dropdownMenu) dropdownMenu.style.display = 'none';
      if (toggleBtn) toggleBtn.style.display = 'none';
    } else {
      runBtn?.classList.remove('hidden');
      stopBtn?.classList.add('hidden');
      if (runningBtns) runningBtns.style.display = 'none';
      if (dropdownMenu) dropdownMenu.style.display = '';
      if (toggleBtn) toggleBtn.style.display = '';
    }

    // [Editor save sync] Update wf_name (user đổi tên trên editor → sidebar reflect ngay)
    const nameEl = card.querySelector('.workflow-card-name');
    if (nameEl) {
      const displayName = workflow.wf_name || (window.I18n?.t('workflow.unnamed') || 'Workflow không tên');
      if (nameEl.textContent !== displayName) {
        nameEl.textContent = displayName;
      }
    }

    // [Editor save sync] Update enabled toggle (class on/off + title + parent wf-disabled)
    const isEnabled = workflow.enabled !== false;
    if (toggleBtn) {
      const wantClass = isEnabled ? 'on' : 'off';
      const dropClass = isEnabled ? 'off' : 'on';
      if (!toggleBtn.classList.contains(wantClass)) {
        toggleBtn.classList.remove(dropClass);
        toggleBtn.classList.add(wantClass);
        toggleBtn.title = isEnabled
          ? (window.I18n?.t('workflow.disableWorkflow') || 'Tắt workflow')
          : (window.I18n?.t('workflow.enableWorkflow') || 'Bật workflow');
      }
    }
    card.classList.toggle('wf-disabled', !isEnabled);

    // [Editor save sync] Update updated_at relative time (chỉ thay text bên trong svg+text container)
    const lastEditEl = card.querySelector('.workflow-card-last-edit');
    if (lastEditEl && workflow.updated_at) {
      const timeText = this._formatRelativeTime(workflow.updated_at);
      // Last text node trong element = relative time (sau SVG)
      const lastNode = lastEditEl.lastChild;
      if (lastNode && lastNode.nodeType === Node.TEXT_NODE && lastNode.textContent !== timeText) {
        lastNode.textContent = timeText;
      }
    }
  }

  /**
   * Bind event listeners cho single workflow card.
   * Dùng khi cần rebind events sau khi innerHTML bị thay đổi.
   * @param {HTMLElement} card - Card element
   */
  _bindSingleCardEvents(card) {
    if (!card) return;
    const wfId = card.dataset.wfId;
    if (!wfId) return;

    const listContainer = this.container.querySelector('.workflow-list');

    // Toggle enabled
    const toggleBtn = card.querySelector('.wf-toggle-btn');
    if (toggleBtn && !toggleBtn._bound) {
      toggleBtn._bound = true;
      toggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const wf = this.workflows.find(w => w.wf_id === wfId);
        const isAdminView = wf?._is_admin_view || (wf?.user?.id && wf.user.id !== window.authManager?.user?.id);
        if (isAdminView) return;
        this.toggleWorkflowEnabled(wfId);
      });
    }

    // 3-dot menu
    const dotMenu = card.querySelector('.tobyflow-dot-menu');
    if (dotMenu) {
      const menuBtn = dotMenu.querySelector('.tobyflow-dot-menu-btn');
      const dropdown = dotMenu.querySelector('.tobyflow-dropdown-menu');
      if (menuBtn && !menuBtn._bound) {
        menuBtn._bound = true;
        menuBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          console.log('[WorkflowList] Menu button clicked:', wfId, 'dropdown:', dropdown, 'wasHidden:', dropdown?.classList.contains('hidden'));
          const wasHidden = dropdown?.classList.contains('hidden');
          this._closeAllDropdowns(listContainer);
          if (dropdown && wasHidden) {
            dropdown.classList.remove('hidden');
            this._positionDropdown(menuBtn, dropdown);
            setTimeout(() => {
              document.addEventListener('click', () => this._closeAllDropdowns(listContainer), { once: true });
            }, 0);
          }
        });
      }
    }

    // Edit button
    const editBtn = card.querySelector('.edit-btn');
    if (editBtn && !editBtn._bound) {
      editBtn._bound = true;
      editBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        this._closeAllDropdowns(listContainer);
        const wf = this.workflows.find(w => w.wf_id === wfId);
        const isAdminView = wf?._is_admin_view || (wf?.user?.id && wf.user.id !== window.authManager?.user?.id);
        if (wf && !isAdminView && window.ProjectHelper && !window.ProjectHelper.isCurrentProject(wf)) {
          const action = await window.ProjectHelper.showCrossProjectWarning(wf, 'workflow');
          if (action === 'switch') window.ProjectHelper.navigateToProject(wf.project_id);
          return;
        }
        this._openWorkflow(wfId, card);
      });
    }

    // Copy/Clone button
    const copyBtn = card.querySelector('.copy-btn');
    if (copyBtn && !copyBtn._bound) {
      copyBtn._bound = true;
      copyBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._closeAllDropdowns(listContainer);
        this.cloneWorkflow(wfId);
      });
    }

    // Run button
    const runBtn = card.querySelector('.run-btn');
    if (runBtn && !runBtn._bound) {
      runBtn._bound = true;
      runBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        this._closeAllDropdowns(listContainer);
        const wf = this.workflows.find(w => w.wf_id === wfId);
        const isAdminView = wf?._is_admin_view || (wf?.user?.id && wf.user.id !== window.authManager?.user?.id);
        if (wf && !isAdminView && window.ProjectHelper && !window.ProjectHelper.isCurrentProject(wf)) {
          const action = await window.ProjectHelper.showCrossProjectWarning(wf, 'workflow');
          if (action === 'switch') window.ProjectHelper.navigateToProject(wf.project_id);
          return;
        }
        this.runWorkflow(wfId);
      });
    }

    // Stop button
    const stopBtn = card.querySelector('.stop-btn');
    if (stopBtn && !stopBtn._bound) {
      stopBtn._bound = true;
      stopBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const wf = this.workflows.find(w => w.wf_id === wfId);
        const isAdminView = wf?._is_admin_view || (wf?.user?.id && wf.user.id !== window.authManager?.user?.id);
        if (isAdminView) return;
        this.stopWorkflow(wfId);
      });
    }

    // Reset button
    const resetBtn = card.querySelector('.reset-btn');
    if (resetBtn && !resetBtn._bound) {
      resetBtn._bound = true;
      resetBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._closeAllDropdowns(listContainer);
        const wf = this.workflows.find(w => w.wf_id === wfId);
        const isAdminView = wf?._is_admin_view || (wf?.user?.id && wf.user.id !== window.authManager?.user?.id);
        if (isAdminView) return;
        this.resetWorkflow(wfId);
      });
    }

    // Export button
    const exportBtn = card.querySelector('.export-btn');
    if (exportBtn && !exportBtn._bound) {
      exportBtn._bound = true;
      exportBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._closeAllDropdowns(listContainer);
        this.exportWorkflow(wfId);
      });
    }

    // Delete button
    const deleteBtn = card.querySelector('.delete-btn');
    if (deleteBtn && !deleteBtn._bound) {
      deleteBtn._bound = true;
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._closeAllDropdowns(listContainer);
        this.deleteWorkflow(wfId);
      });
    }
  }

  /**
   * Helper: Get localized status text
   */
  _getStatusText(status) {
    const statusMap = {
      pending: window.I18n?.t('workflow.statusPending') || 'Pending',
      running: window.I18n?.t('workflow.statusRunning') || 'Running',
      completed: window.I18n?.t('workflow.statusCompleted') || 'Completed',
      failed: window.I18n?.t('workflow.statusFailed') || 'Failed',
      paused: window.I18n?.t('workflow.statusPaused') || 'Paused'
    };
    return statusMap[status] || status;
  }

  /**
   * [API SPAM FIX — Phase 6] Update card progress bar (không cần API call)
   * @param {string} wfId
   * @param {number} percent - 0-100
   */
  _updateCardProgress(wfId, percent) {
    console.log('[WorkflowList] _updateCardProgress:', wfId, percent + '%');
    const card = this.container.querySelector(`.workflow-card[data-wf-id="${wfId}"]`);
    if (!card) {
      console.warn('[WorkflowList] Card not found for progress update:', wfId);
      return;
    }

    // Update bottom progress bar
    let progressContainer = card.querySelector('.workflow-card-progress');
    if (!progressContainer) {
      progressContainer = document.createElement('div');
      progressContainer.className = 'workflow-card-progress';
      progressContainer.innerHTML = `
        <div class="workflow-card-progress-bar">
          <div class="workflow-card-progress-bar-fill" style="width: 0%"></div>
        </div>
      `;
      card.appendChild(progressContainer);
    }
    const progressBarFill = progressContainer.querySelector('.workflow-card-progress-bar-fill');
    if (progressBarFill) {
      progressBarFill.style.width = `${percent}%`;
    }
    progressContainer.classList.remove('hidden');

    // Update inline progress bar (bên cạnh tên workflow)
    let inlineProgress = card.querySelector('.workflow-card-inline-progress');
    if (!inlineProgress) {
      const nameRow = card.querySelector('.workflow-card-name-row');
      if (nameRow) {
        inlineProgress = document.createElement('span');
        inlineProgress.className = 'workflow-card-inline-progress indeterminate';
        inlineProgress.innerHTML = `<span class="workflow-card-inline-progress-bar" style="width: 0%"></span>`;
        nameRow.appendChild(inlineProgress);
      }
    }
    const inlineProgressBar = inlineProgress?.querySelector('.workflow-card-inline-progress-bar');
    if (inlineProgressBar) {
      inlineProgressBar.style.width = `${percent}%`;
    }
    // Switch to determinate mode when progress > 0
    if (inlineProgress && percent > 0) {
      inlineProgress.classList.remove('indeterminate');
    }
    if (inlineProgress) inlineProgress.style.display = '';

    // Update meta text "X nodes - Y%" (giống template khi isRunning)
    const metaEl = card.querySelector('.workflow-card-meta');
    if (metaEl) {
      // Extract node count từ text hiện tại (format: "X nodes" hoặc "X nodes - Y%")
      const currentText = metaEl.textContent || '';
      const nodeMatch = currentText.match(/^(\d+)\s*nodes?/);
      if (nodeMatch) {
        const nodeCount = nodeMatch[1];
        metaEl.innerHTML = `<svg class="workflow-card-node-icon" width="12" height="12" viewBox="0 0 16 16" fill="none"><path fill-rule="evenodd" clip-rule="evenodd" d="M6.17 3.646a.5.5 0 0 1 .707 0l5.477 5.477a.5.5 0 0 1 0 .707l-1.366 1.366a4.373 4.373 0 1 1-6.184-6.184L6.17 3.646Zm.353 1.061L5.508 5.723 5.5 5.73a3.373 3.373 0 1 0 4.77 4.77l.006-.008 1.016-1.015-4.77-4.77Z" fill="currentColor"/><path fill-rule="evenodd" clip-rule="evenodd" d="M5.354 10.646a.5.5 0 0 1 0 .707L3.02 13.688a.5.5 0 1 1-.707-.707l2.334-2.334a.5.5 0 0 1 .707 0ZM10.354 2.313a.5.5 0 0 1 0 .707L8.02 5.354a.5.5 0 0 1-.707-.708l2.334-2.333a.5.5 0 0 1 .707 0ZM13.687 5.646a.5.5 0 0 1 0 .708l-2.333 2.333a.5.5 0 1 1-.707-.707l2.333-2.334a.5.5 0 0 1 .707 0Z" fill="currentColor"/></svg>${nodeCount} nodes - ${percent}%`;
      }
    }
  }

  /**
   * [API SPAM FIX — Phase 6] Update card running/completed state (không cần API call)
   * @param {string} wfId
   * @param {boolean} isRunning
   * @param {string} [finalStatus] - 'completed', 'failed', etc. (khi isRunning=false)
   */
  _updateCardRunningState(wfId, isRunning, finalStatus = null) {
    const card = this.container.querySelector(`.workflow-card[data-wf-id="${wfId}"]`);
    if (!card) {
      // Workflow card không có trong DOM hiện tại (vd: workflow ở trang khác trong pagination).
      // Defer update qua `_debouncedUpdateSingleWorkflow` — sẽ fetch lại workflow data + tự
      // re-render card nếu visible. Log lite (debug only) thay vì warn vì đây là kịch bản hợp lệ.
      if (this._verboseLog) console.debug('[WorkflowList] Card not in DOM (likely off-page), defer update:', wfId);
      this._debouncedUpdateSingleWorkflow?.(wfId);
      return;
    }
    if (this._verboseLog) console.debug('[WorkflowList] _updateCardRunningState:', wfId, isRunning, finalStatus);

    // Update status class trên card (không có prefix "status-", CSS dùng .workflow-card.completed etc.)
    card.classList.remove('pending', 'running', 'completed', 'failed', 'paused', 'idle');
    const newStatus = isRunning ? 'running' : (finalStatus || 'pending');
    card.classList.add(newStatus);

    // Update status badge (selector đúng: .workflow-card-status)
    const statusBadge = card.querySelector('.workflow-card-status');
    if (statusBadge) {
      const statusLabel = WorkflowList._renderStatusLabel(newStatus);
      statusBadge.setAttribute('data-tooltip', statusLabel);
      statusBadge.setAttribute('aria-label', statusLabel);
      statusBadge.innerHTML = WorkflowList._renderStatusIcon(newStatus);
      statusBadge.className = `workflow-card-status ${newStatus}`;
    }

    // Run/Stop buttons: dropdown-based cho non-running, direct buttons cho running
    const dropdownMenu = card.querySelector('.tobyflow-dot-menu');
    const runBtn = card.querySelector('.run-btn');
    const stopBtn = card.querySelector('.stop-btn');

    const actionsDiv = card.querySelector('.workflow-card-actions');

    if (isRunning) {
      // Hide dropdown menu
      if (dropdownMenu) dropdownMenu.style.display = 'none';
      runBtn?.classList.add('hidden');

      // Tạo running buttons container nếu chưa có (giống template khi isRunning=true)
      let runningBtns = card.querySelector('.wf-running-buttons');
      console.log('[WorkflowList] _updateCardRunningState runningBtns exists:', !!runningBtns, 'actionsDiv:', !!actionsDiv);
      if (!runningBtns && actionsDiv) {
        console.log('[WorkflowList] Creating new .wf-running-buttons for', wfId);
        runningBtns = document.createElement('div');
        runningBtns.className = 'wf-running-buttons';
        runningBtns.style.display = 'flex';
        runningBtns.style.gap = '4px';
        runningBtns.innerHTML = `
          <button class="btn btn-secondary btn-sm edit-btn" title="${window.I18n?.t('workflow.viewStatus') || 'Xem trạng thái'}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
              <circle cx="12" cy="12" r="3"></circle>
            </svg>
          </button>
          <button class="btn btn-secondary btn-sm btn-warning stop-btn" title="${window.I18n?.t('common.stop') || 'Dừng'}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="6" y="6" width="12" height="12"></rect>
            </svg>
          </button>
          <button class="btn btn-secondary btn-sm reset-btn" title="Force Reset" style="color: var(--destructive, #ef4444);">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path><path d="M3 3v5h5"></path>
            </svg>
          </button>
        `;
        actionsDiv.appendChild(runningBtns);

        // Bind click handlers cho dynamically created buttons
        const newEditBtn = runningBtns.querySelector('.edit-btn');
        newEditBtn?.addEventListener('click', async (e) => {
          e.stopPropagation();
          console.log('[WorkflowList] Running edit-btn clicked:', wfId);
          const wf = this.workflows.find(w => w.wf_id === wfId);
          const isAdminView = wf?._is_admin_view || (wf?.user?.id && wf.user.id !== window.authManager?.user?.id);
          if (wf && !isAdminView && window.ProjectHelper && !window.ProjectHelper.isCurrentProject(wf)) {
            const action = await window.ProjectHelper.showCrossProjectWarning(wf, 'workflow');
            if (action === 'switch') window.ProjectHelper.navigateToProject(wf.project_id);
            return;
          }
          this._openWorkflow(wfId, card);
        });

        const newStopBtn = runningBtns.querySelector('.stop-btn');
        newStopBtn?.addEventListener('click', (e) => {
          e.stopPropagation();
          const wf = this.workflows.find(w => w.wf_id === wfId);
          const isAdminView = wf?._is_admin_view || (wf?.user?.id && wf.user.id !== window.authManager?.user?.id);
          if (isAdminView) return;
          this.stopWorkflow(wfId);
        });

        const newResetBtn = runningBtns.querySelector('.reset-btn');
        newResetBtn?.addEventListener('click', (e) => {
          e.stopPropagation();
          const wf = this.workflows.find(w => w.wf_id === wfId);
          const isAdminView = wf?._is_admin_view || (wf?.user?.id && wf.user.id !== window.authManager?.user?.id);
          if (isAdminView) return;
          this.resetWorkflow(wfId);
        });
      } else if (runningBtns) {
        // CRITICAL FIX: Rebind events cho existing running buttons
        // (có thể bị mất event handlers sau khi restore prevHtml trong _openWorkflow)
        console.log('[WorkflowList] Rebinding events for existing .wf-running-buttons', wfId);
        const existingEditBtn = runningBtns.querySelector('.edit-btn');
        if (existingEditBtn && !existingEditBtn._bound) {
          existingEditBtn._bound = true;
          existingEditBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            console.log('[WorkflowList] Running edit-btn clicked (rebound):', wfId);
            const wf = this.workflows.find(w => w.wf_id === wfId);
            const isAdminView = wf?._is_admin_view || (wf?.user?.id && wf.user.id !== window.authManager?.user?.id);
            if (wf && !isAdminView && window.ProjectHelper && !window.ProjectHelper.isCurrentProject(wf)) {
              const action = await window.ProjectHelper.showCrossProjectWarning(wf, 'workflow');
              if (action === 'switch') window.ProjectHelper.navigateToProject(wf.project_id);
              return;
            }
            this._openWorkflow(wfId, card);
          });
        }
        const existingStopBtn = runningBtns.querySelector('.stop-btn');
        if (existingStopBtn && !existingStopBtn._bound) {
          existingStopBtn._bound = true;
          existingStopBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const wf = this.workflows.find(w => w.wf_id === wfId);
            const isAdminView = wf?._is_admin_view || (wf?.user?.id && wf.user.id !== window.authManager?.user?.id);
            if (isAdminView) return;
            this.stopWorkflow(wfId);
          });
        }
        const existingResetBtn = runningBtns.querySelector('.reset-btn');
        if (existingResetBtn && !existingResetBtn._bound) {
          existingResetBtn._bound = true;
          existingResetBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const wf = this.workflows.find(w => w.wf_id === wfId);
            const isAdminView = wf?._is_admin_view || (wf?.user?.id && wf.user.id !== window.authManager?.user?.id);
            if (isAdminView) return;
            this.resetWorkflow(wfId);
          });
        }
      }
      if (runningBtns) runningBtns.style.display = 'flex';

      // Hide toggle button khi running
      const toggleBtn = card.querySelector('.wf-toggle-btn');
      if (toggleBtn) toggleBtn.style.display = 'none';

      // Hide standalone stop button nếu có (tránh duplicate)
      if (stopBtn && !stopBtn.closest('.wf-running-buttons')) {
        stopBtn.classList.add('hidden');
      }

      // Inject bottom progress bar nếu chưa có
      let progressContainer = card.querySelector('.workflow-card-progress');
      if (!progressContainer) {
        progressContainer = document.createElement('div');
        progressContainer.className = 'workflow-card-progress';
        progressContainer.innerHTML = `
          <div class="workflow-card-progress-bar">
            <div class="workflow-card-progress-bar-fill" style="width: 0%"></div>
          </div>
        `;
        card.appendChild(progressContainer);
      }
      progressContainer.classList.remove('hidden');

      // Inject inline progress bar (bên cạnh tên workflow) nếu chưa có
      let inlineProgress = card.querySelector('.workflow-card-inline-progress');
      if (!inlineProgress) {
        const nameRow = card.querySelector('.workflow-card-name-row');
        if (nameRow) {
          inlineProgress = document.createElement('span');
          inlineProgress.className = 'workflow-card-inline-progress indeterminate';
          inlineProgress.innerHTML = `<span class="workflow-card-inline-progress-bar" style="width: 0%"></span>`;
          nameRow.appendChild(inlineProgress);
        }
      } else {
        // Reset to indeterminate when workflow starts running
        inlineProgress.classList.add('indeterminate');
      }
      if (inlineProgress) inlineProgress.style.display = '';
    } else {
      // Hide running buttons container
      const runningBtns = card.querySelector('.wf-running-buttons');
      if (runningBtns) runningBtns.style.display = 'none';

      // Restore dropdown menu
      if (dropdownMenu) dropdownMenu.style.display = '';
      runBtn?.classList.remove('hidden');
      if (stopBtn && !stopBtn.closest('.wf-running-buttons')) {
        stopBtn.classList.add('hidden');
      }

      // Restore toggle button khi không running
      const toggleBtn = card.querySelector('.wf-toggle-btn');
      if (toggleBtn) toggleBtn.style.display = '';

      // Hide progress bars when done
      const progressContainer = card.querySelector('.workflow-card-progress');
      if (progressContainer) progressContainer.classList.add('hidden');
      const inlineProgress = card.querySelector('.workflow-card-inline-progress');
      if (inlineProgress) inlineProgress.style.display = 'none';

      // Restore meta text (bỏ "- Y%")
      const metaEl = card.querySelector('.workflow-card-meta');
      if (metaEl) {
        const currentText = metaEl.textContent || '';
        const nodeMatch = currentText.match(/^(\d+)\s*nodes?/);
        if (nodeMatch) {
          const nodeCount = nodeMatch[1];
          metaEl.innerHTML = `<svg class="workflow-card-node-icon" width="12" height="12" viewBox="0 0 16 16" fill="none"><path fill-rule="evenodd" clip-rule="evenodd" d="M6.17 3.646a.5.5 0 0 1 .707 0l5.477 5.477a.5.5 0 0 1 0 .707l-1.366 1.366a4.373 4.373 0 1 1-6.184-6.184L6.17 3.646Zm.353 1.061L5.508 5.723 5.5 5.73a3.373 3.373 0 1 0 4.77 4.77l.006-.008 1.016-1.015-4.77-4.77Z" fill="currentColor"/><path fill-rule="evenodd" clip-rule="evenodd" d="M5.354 10.646a.5.5 0 0 1 0 .707L3.02 13.688a.5.5 0 1 1-.707-.707l2.334-2.334a.5.5 0 0 1 .707 0ZM10.354 2.313a.5.5 0 0 1 0 .707L8.02 5.354a.5.5 0 0 1-.707-.708l2.334-2.333a.5.5 0 0 1 .707 0ZM13.687 5.646a.5.5 0 0 1 0 .708l-2.333 2.333a.5.5 0 1 1-.707-.707l2.333-2.334a.5.5 0 0 1 .707 0Z" fill="currentColor"/></svg>${nodeCount} nodes`;
        }
      }
    }
  }

  /**
   * Debounced update single workflow - coalesce multiple updates cho cùng wfId
   * @param {string} wfId
   */
  _debouncedUpdateSingleWorkflow(wfId) {
    if (!wfId) return;
    console.log('[WorkflowList] _debouncedUpdateSingleWorkflow called:', wfId);
    // Track running workflow để các event không có wfId có thể dùng
    this._lastUpdatedWfId = wfId;

    const key = `_updateTimer_${wfId}`;
    if (this[key]) clearTimeout(this[key]);
    this[key] = setTimeout(() => {
      this[key] = null;
      this._updateSingleWorkflowInList(wfId);
    }, 500);
  }

  _bindToolbarEvents() {
    // Search toggle
    const searchToggle = this.container.querySelector('#wfSearchToggle');
    const searchRow = this.container.querySelector('#wfSearchRow');
    const searchInput = this.container.querySelector('#wfSearchInput');
    const searchClose = this.container.querySelector('#wfSearchClose');

    if (searchToggle && searchRow) {
      searchToggle.addEventListener('click', () => {
        const isHidden = searchRow.classList.contains('hidden');
        searchRow.classList.toggle('hidden');
        if (isHidden && searchInput) {
          searchInput.focus();
        }
      });
    }

    if (searchClose && searchRow) {
      searchClose.addEventListener('click', () => {
        searchRow.classList.add('hidden');
        if (searchInput) {
          searchInput.value = '';
        }
        this._searchQuery = '';
        this._currentPage = 1; // reset pagination
        this.render();
      });
    }

    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        this._searchQuery = e.target.value.toLowerCase();
        this._currentPage = 1; // reset pagination
        this.render();
      });
    }

    // Create workflow handler
    // Luôn fetch async từ server để có entitlements mới nhất theo user plan
    const handleCreate = async () => {
      if (window.featureGate) {
        const canCreate = await window.featureGate.canCreateWorkflowAsync();
        if (!canCreate) {
          const isLoggedIn = window.authManager?.isLoggedIn();
          if (!isLoggedIn) {
            window.featureGate.showLoginPrompt(
              window.I18n?.t('workflow.requireLoginToCreate') || 'Tạo workflow yêu cầu đăng nhập'
            );
          } else {
            const quota = window.featureGate.checkQuota('workflows_max');
            console.log('[WorkflowList] Workflow quota exceeded:', quota);
            const shouldUpgrade = await window.customDialog?.confirm(
              window.I18n?.t('workflow.quotaLimitReached', { limit: quota.limit, used: quota.used }) || `Gói của bạn giới hạn tối đa ${quota.limit} workflow. Bạn đã có ${quota.used} workflow. Nâng cấp Premium để tạo không giới hạn.`,
              { title: window.I18n?.t('workflow.quotaLimitTitle') || 'Limit reached', type: 'warning', confirmText: window.I18n?.t('common.upgrade') || 'Upgrade', cancelText: window.I18n?.t('common.later') || 'Later' }
            );
            if (shouldUpgrade && typeof window.openUpgradeModal === 'function') {
              window.openUpgradeModal();
            }
          }
          return;
        }
      }
      if (window.eventBus) window.eventBus.emit('workflow:open_editor', { mode: 'create' });
    };

    // Create buttons
    const createBtn = this.container.querySelector('#createWorkflowBtn');
    const createFirstBtn = this.container.querySelector('#createFirstWorkflowBtn');
    createBtn?.addEventListener('click', handleCreate);
    createFirstBtn?.addEventListener('click', handleCreate);

    // Refresh button
    const refreshBtn = this.container.querySelector('#refreshWorkflowsBtn');
    refreshBtn?.addEventListener('click', () => {
      // 2026-05-25: User-initiated refresh — force show loading + force render
      // để user thấy feedback rõ ràng (kể cả khi data unchanged).
      this.loadWorkflows(false, { forceShowLoading: true, forceRender: true });
    });

    // Run All button
    const runAllBtn = this.container.querySelector('#runAllWorkflowsBtn');
    runAllBtn?.addEventListener('click', () => {
      if (this.isRunningAll) {
        this.stopAllWorkflows();
      } else {
        this.runAllWorkflows();
      }
    });

    // Import button
    const importBtn = this.container.querySelector('#importWorkflowBtn');
    importBtn?.addEventListener('click', () => this._handleImportClick());
  }

  async loadWorkflows(append = false, options = {}) {
    // 2026-05-25: options.forceShowLoading — manual refresh button passes true để show
    // skeleton ngay (kể cả khi data có thể unchanged).
    // options.forceRender — bypass signature-skip → user thấy refresh feedback rõ.
    const { forceShowLoading = false, forceRender = false } = options;

    // [API SPAM FIX — Phase 6] Block full reload khi workflow đang chạy hoặc vừa xong (cooldown)
    // Tránh giật UI và API spam - chỉ cho phép single update
    if ((window.workflowExecutor?.isRunning || this._executionCooldown) && this._lastUpdatedWfId && !append) {
      console.log('[WorkflowList] BLOCKED loadWorkflows - executor running or cooldown');
      return;
    }

    // Debounce: if already loading, queue a reload after current finishes
    if (this._loading) {
      this._loadPending = true;
      return;
    }
    // Debounce rapid calls (e.g., multiple events firing in quick succession)
    if (this._loadDebounceTimer) {
      clearTimeout(this._loadDebounceTimer);
    }
    this._loadDebounceTimer = setTimeout(() => {
      this._loadDebounceTimer = null;
    }, 100);

    this._loading = true;
    this._loadPending = false;

    try {
      // 2026-05-25: Show skeleton ở 2 case:
      //   1. Initial load (chưa render lần nào — `_lastRenderSignature` empty)
      //   2. forceShowLoading = true (user manual refresh — cần feedback rõ)
      // Trước fix: showLoading chạy mọi lần → 2nd call (event-driven) replace list với skeleton →
      // signature-skip render → skeleton stuck forever.
      if (!append) {
        if (!this._lastRenderSignature || forceShowLoading) this.showLoading();
        this._currentPage = 1;
      }

      // CRITICAL: Defensive guard — nếu user đã login mà storage vẫn ở local mode
      if (window.authManager?.isLoggedIn() && window.storageManager?.getMode?.() === 'local') {
        try { await window.storageManager.switchToApi(); }
        catch (e) { console.warn('[WorkflowList] switchToApi failed:', e.message); }
      }

      if (window.storageManager) {
        const page = append ? this._currentPage + 1 : 1;
        const result = await window.storageManager.getWorkflows({
          page,
          per_page: this._pageSize,
          platform: 'flow'
        });

        const newWorkflows = (result.data || []).filter(w => !w.platform || w.platform === 'flow');

        if (append) {
          this.workflows = [...this.workflows, ...newWorkflows];
        } else {
          this.workflows = newWorkflows;
        }

        // Update pagination state
        this._currentPage = result.meta?.current_page || page;
        this._lastPage = result.meta?.last_page || 1;
        this._total = result.meta?.total || this.workflows.length;

        // 2026-05-25: Signature-based render skip — tránh DOM thrash + log spam khi nhiều events
        // (login/OAuth/tab switch/SSE) trigger loadWorkflows liên tiếp với cùng data.
        // Signature gồm: total + per-workflow (id, name, updated_at, status). Đủ bắt change thực sự
        // mà skip noise. Skip render KHÔNG ảnh hưởng pagination state (đã update bên trên).
        const newSignature = `${this._total}:${this._currentPage}/${this._lastPage}:` +
          this.workflows.map(w => `${w.wf_id}|${w.name || w.wf_name}|${w.updated_at || ''}|${w.status || ''}`).join(',');
        // 2026-05-25: forceRender bypass signature-skip — manual refresh button.
        // Đảm bảo user click refresh thấy list re-render (kể cả data unchanged).
        if (!append && !forceRender && this._lastRenderSignature === newSignature) {
          // Same data → skip render + log. Cập nhật _lastLoadTime để track tần suất nếu cần debug.
          this._lastLoadTime = Date.now();
        } else {
          this._lastRenderSignature = newSignature;
          console.log('[WorkflowList] Loaded page', this._currentPage, '/', this._lastPage, '- total:', this._total);
          await this._cacheProjectNames();
          // Query which workflow is being edited
          try {
            const resp = await chrome.runtime.sendMessage({ action: 'getEditingWorkflowId' });
            this._editingWfId = resp?.editingWorkflowId || null;
          } catch (e) {
            this._editingWfId = null;
          }
          this.renderWorkflowList();
        }
      }
    } catch (error) {
      // [API SPAM FIX — Phase 2.1] 429 → giữ data cũ + show banner + auto-retry sau cooldown.
      // Tránh xóa danh sách khiến user thấy empty UI khi backend rate limit.
      if (error?.code === 'RATE_LIMITED' || error?.httpStatus === 429) {
        const retryAfter = Number(error.retryAfter) || 60;
        console.warn('[WorkflowList] Rate limited, giữ data cũ, retry sau', retryAfter, 's');
        this._showRateLimitBanner(retryAfter);
        // Vẫn render data cũ (không xóa)
        this.renderWorkflowList();
      } else {
        console.error('[WorkflowList] Load failed:', error);
        this.showError(window.I18n?.t('workflow.loadFailed') || 'Không thể tải danh sách workflows');
      }
    } finally {
      this._loading = false;
      // Process pending reload request (queued while this load was running)
      if (this._loadPending) {
        this._loadPending = false;
        setTimeout(() => this.loadWorkflows(), 50);
      }
    }
  }

  /**
   * [API SPAM FIX — Phase 2.1] Hiển thị banner cảnh báo rate-limited + auto-retry sau cooldown.
   * Banner countdown realtime giúp user biết khi nào tự reload.
   * @param {number} retryAfter - Cooldown seconds
   */
  _showRateLimitBanner(retryAfter) {
    let banner = this.container.querySelector('.wf-rate-limit-banner');
    if (!banner) {
      banner = document.createElement('div');
      banner.className = 'wf-rate-limit-banner';
      // Insert ngay sau toolbar (đầu danh sách)
      const listSection = this.container.querySelector('#workflowListSection') || this.container;
      listSection.prepend(banner);
    }
    banner.style.display = 'flex';

    const clockIcon = `<svg class="wf-rate-limit-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`;
    const tBase = window.I18n?.t?.('workflow.rateLimitedBanner') || 'Gói của bạn đang bị giới hạn. Tự động thử lại sau {seconds}s...';
    let remaining = retryAfter;
    const update = () => {
      const text = tBase.replace('{seconds}', `<span class="wf-rate-limit-countdown">${remaining}</span>`);
      banner.innerHTML = `${clockIcon}<span class="wf-rate-limit-text">${text}</span>`;
    };
    update();

    // Clear timer cũ nếu có
    if (this._rateLimitTimer) clearInterval(this._rateLimitTimer);
    if (this._rateLimitRetryTimer) clearTimeout(this._rateLimitRetryTimer);

    this._rateLimitTimer = setInterval(() => {
      remaining--;
      if (remaining <= 0) {
        clearInterval(this._rateLimitTimer);
        this._rateLimitTimer = null;
        banner.style.display = 'none';
      } else {
        update();
      }
    }, 1000);

    // Auto-retry sau cooldown
    this._rateLimitRetryTimer = setTimeout(() => {
      this._rateLimitRetryTimer = null;
      this.loadWorkflows();
    }, retryAfter * 1000);
  }

  /**
   * Load workflows được chia sẻ với user hiện tại
   * GET /v1/workflows/shared-with-me
   */
  async loadSharedWorkflows() {
    // Chỉ load khi user đã đăng nhập
    if (!window.authManager?.isLoggedIn()) {
      this._sharedWorkflows = [];
      return;
    }

    try {
      const baseUrl = window.ApiBaseConfig.get();
      const token = await window.authManager.getToken();

      const response = await fetch(`${baseUrl}/workflows/shared-with-me`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-Extension-Id': chrome.runtime.id,
        }
      });

      if (!response.ok) {
        // Silent fail for 404 (feature not deployed yet)
        this._sharedWorkflows = [];
        return;
      }

      const json = await response.json();

      // Parse defensive — handle cả 3 shape có thể có:
      //   1. { success, data: { workflows: [flat_wf] } }              ← shape mới (BE đã update)
      //   2. { success, data: [share_record_with_nested_workflow] }   ← shape cũ
      //   3. [flat_wf]                                                  ← shape rất cũ (legacy)
      let items = [];
      if (Array.isArray(json)) {
        items = json;
      } else if (Array.isArray(json?.data?.workflows)) {
        items = json.data.workflows;
      } else if (Array.isArray(json?.workflows)) {
        items = json.workflows;
      } else if (Array.isArray(json?.data)) {
        items = json.data;
      }

      this._sharedWorkflows = items.map(item => {
        // Nếu là share record (có nested workflow) → flatten
        const wf = item.workflow || item;
        return {
          ...wf,
          _is_shared_view: true,
          _share_id: item._share_id || item.id,
          sharer_name: item._sharer_name || item.sharer?.name || item.sharer_name,
          sharer_email: item._sharer_email || item.sharer?.email,
          shared_at: item._shared_at || item.accepted_at || item.shared_at,
        };
      });

      if (this._sharedWorkflows.length > 0) {
        console.log('[WorkflowList] Loaded', this._sharedWorkflows.length, 'shared workflows');
      }
      // Update badge count + nếu user đang ở tab "Shared" → re-render content
      this._updateSharedTabBadge();
      const rootContainer = this.container.closest('#tab-workflow') || document;
      const sharedContent = rootContainer.querySelector('[data-content="shared"]');
      if (sharedContent && sharedContent.style.display !== 'none') {
        this.renderSharedTab(sharedContent);
      }
    } catch (error) {
      console.warn('[WorkflowList] loadSharedWorkflows failed:', error.message);
      this._sharedWorkflows = [];
      this._updateSharedTabBadge();
    }
  }

  async render() {
    const listContainer = this.container.querySelector('#workflowList');
    const emptyState = this.container.querySelector('#workflowEmptyState');

    // Update Run All button visibility (event listener bound once in _bindToolbarEvents)
    const runAllBtn = this.container.querySelector('#runAllWorkflowsBtn');
    if (runAllBtn) {
      runAllBtn.classList.toggle('hidden', this.workflows.length === 0);
    }

    if (!listContainer) return;

    // Inline project select in toolbar
    const inlineSelect = this.container.querySelector('#wfProjectSelectInline');

    // Y-2: Apply project filter
    let displayWorkflows = this.workflows;
    if (this._filterProjectId) {
      if (this._filterProjectId === '__legacy__') {
        displayWorkflows = this.workflows.filter(w => !w.project_id);
      } else {
        displayWorkflows = this.workflows.filter(w => w.project_id === this._filterProjectId);
      }
    }

    // Apply search filter (search by name or ID)
    if (this._searchQuery) {
      displayWorkflows = displayWorkflows.filter(w =>
        w.wf_name?.toLowerCase().includes(this._searchQuery) ||
        w.wf_id?.toLowerCase().includes(this._searchQuery)
      );
    }

    if (this.workflows.length === 0) {
      listContainer.innerHTML = '';
      listContainer.classList.add('hidden');
      if (inlineSelect) inlineSelect.classList.add('hidden');
      emptyState?.classList.remove('hidden');
      return;
    }

    if (displayWorkflows.length === 0) {
      listContainer.innerHTML = this._searchQuery
        ? `<div class="workflow-empty-state"><p>${window.I18n?.t('workflow.notFound') || 'Không tìm thấy workflow'}</p></div>`
        : '';
      listContainer.classList.toggle('hidden', !this._searchQuery);
      if (!this._searchQuery) emptyState?.classList.remove('hidden');
      // Still show filter so user can switch back
      await this._renderProjectFilter();
      return;
    }

    emptyState?.classList.add('hidden');
    listContainer.classList.remove('hidden');

    // Phase 2: Migration banner — đếm legacy items (project_id=null) trong toàn bộ list
    // (không chỉ visible page) để show prompt ngay nếu user có legacy items.
    // Admin mode: chỉ đếm workflows của chính mình (không phải của users khác)
    const currentUserId = window.authManager?.user?.id;
    const legacyWorkflows = this.workflows.filter(w => {
      if (w.project_id) return false; // Đã có project
      // Nếu workflow có user info (admin mode) → chỉ đếm của mình
      if (w.user?.id && currentUserId) return w.user.id === currentUserId;
      return true; // User thường (không có user field) → đếm hết
    });
    const migrationBanner = window.ProjectHelper?.renderMigrationBanner?.(legacyWorkflows.length, 'workflow') || '';

    // Server-side pagination — hiển thị tất cả workflows đã load
    const visibleWorkflows = displayWorkflows;
    const hasMore = this._currentPage < this._lastPage;
    const remaining = this._total - this.workflows.length;

    // Y-2: If showing all and ProjectHelper available, group by project
    if (!this._filterProjectId && window.ProjectHelper) {
      const grouped = await window.ProjectHelper.sortByProjectGroup(visibleWorkflows, window._currentProjectId);
      let html = migrationBanner;
      for (const entry of grouped) {
        if (entry.type === 'header') {
          html += window.ProjectHelper.renderGroupHeader(entry.projectName, entry.count, entry.isCurrent);
        } else {
          html += this.renderWorkflowCard(entry.item);
        }
      }
      listContainer.innerHTML = html;
    } else {
      // Specific filter or no ProjectHelper — normal sort
      const sorted = [...visibleWorkflows].sort((a, b) => {
        if (a.sort_order !== undefined && b.sort_order !== undefined) {
          return a.sort_order - b.sort_order;
        }
        const tsA = parseInt((a.wf_id || '').replace('wf_', '')) || 0;
        const tsB = parseInt((b.wf_id || '').replace('wf_', '')) || 0;
        return tsA - tsB;
      });
      listContainer.innerHTML = migrationBanner + sorted.map(wf => this.renderWorkflowCard(wf)).join('');
    }

    // Bind migration banner click (Gán / Bỏ qua)
    listContainer.querySelector('.legacy-migrate-banner[data-type="workflow"]')?.addEventListener('click', async (e) => {
      const btn = e.target.closest('.legacy-migrate-btn');
      if (!btn) return;
      const action = btn.dataset.action;
      if (action === 'skip') {
        sessionStorage.setItem('legacy_migrate_workflow_dismissed', '1');
        this.render();
      } else if (action === 'assign') {
        const count = await window.ProjectHelper.migrateLegacyItems(legacyWorkflows, 'workflow');
        if (count > 0) {
          window.showNotification?.(
            (window.I18n?.t('project.migrateSuccess', { count }) || `Đã gán ${count} item vào project hiện tại`),
            'success', 2500
          );
          await this.loadWorkflows();
        }
      }
    });

    // Append load-more button nếu còn pages chưa load
    if (hasMore) {
      const loadMoreLabel = window.I18n?.t('common.loadMore') || 'Tải thêm';
      listContainer.insertAdjacentHTML('beforeend', `
        <div class="tobyflow-load-more-row">
          <button class="tobyflow-load-more-btn" id="wfLoadMoreBtn">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
            ${loadMoreLabel}
            <span class="tobyflow-load-more-count">${this.workflows.length} / ${this._total}</span>
          </button>
        </div>
      `);
      listContainer.querySelector('#wfLoadMoreBtn')?.addEventListener('click', () => {
        if (!this._loading) {
          this.loadWorkflows(true); // Load next page from server
        }
      });
    }

    // Y-2: Render project filter toolbar
    await this._renderProjectFilter();

    // Bind card events
    listContainer.querySelectorAll('.workflow-card').forEach(card => {
      const wfId = card.dataset.wfId;

      // Toggle enabled (skip for admin view)
      const toggleBtn = card.querySelector('.wf-toggle-btn');
      if (toggleBtn) {
        toggleBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const wf = this.workflows.find(w => w.wf_id === wfId);
          const isAdminView = wf?._is_admin_view || (wf?.user?.id && wf.user.id !== window.authManager?.user?.id);
          if (isAdminView) return;
          this.toggleWorkflowEnabled(wfId);
        });
      }

      // 3-dot menu
      const dotMenu = card.querySelector('.tobyflow-dot-menu');
      if (dotMenu) {
        const menuBtn = dotMenu.querySelector('.tobyflow-dot-menu-btn');
        const dropdown = dotMenu.querySelector('.tobyflow-dropdown-menu');
        menuBtn?.addEventListener('click', (e) => {
          e.stopPropagation();
          console.log('[WorkflowList] Menu button clicked:', wfId, 'dropdown:', dropdown, 'wasHidden:', dropdown?.classList.contains('hidden'));
          const wasHidden = dropdown?.classList.contains('hidden');
          this._closeAllDropdowns(listContainer);
          if (dropdown && wasHidden) {
            dropdown.classList.remove('hidden');
            this._positionDropdown(menuBtn, dropdown);
            // Close on outside click
            setTimeout(() => {
              document.addEventListener('click', () => this._closeAllDropdowns(listContainer), { once: true });
            }, 0);
          }
        });
      }

      // Y-4: Edit button with cross-project guard (skip for admin view)
      const editBtn = card.querySelector('.edit-btn');
      editBtn?.addEventListener('click', async (e) => {
        e.stopPropagation();
        this._closeAllDropdowns(listContainer);
        const wf = this.workflows.find(w => w.wf_id === wfId);
        // Skip cross-project warning for admin view (viewing other user's workflows)
        const isAdminView = wf?._is_admin_view || (wf?.user?.id && wf.user.id !== window.authManager?.user?.id);
        if (wf && !isAdminView && window.ProjectHelper && !window.ProjectHelper.isCurrentProject(wf)) {
          const action = await window.ProjectHelper.showCrossProjectWarning(wf, 'workflow');
          if (action === 'switch') window.ProjectHelper.navigateToProject(wf.project_id);
          return;
        }
        this._openWorkflow(wfId, card);
      });

      // Copy/Clone button
      const copyBtn = card.querySelector('.copy-btn');
      copyBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        this._closeAllDropdowns(listContainer);
        this.cloneWorkflow(wfId);
      });

      // Y-4: Run button with cross-project guard (skip for admin view)
      const runBtn = card.querySelector('.run-btn');
      runBtn?.addEventListener('click', async (e) => {
        e.stopPropagation();
        this._closeAllDropdowns(listContainer);
        const wf = this.workflows.find(w => w.wf_id === wfId);
        // Skip cross-project warning for admin view (viewing other user's workflows)
        const isAdminView = wf?._is_admin_view || (wf?.user?.id && wf.user.id !== window.authManager?.user?.id);
        if (wf && !isAdminView && window.ProjectHelper && !window.ProjectHelper.isCurrentProject(wf)) {
          const action = await window.ProjectHelper.showCrossProjectWarning(wf, 'workflow');
          if (action === 'switch') window.ProjectHelper.navigateToProject(wf.project_id);
          return;
        }
        this.runWorkflow(wfId);
      });

      // Stop button (skip for admin view)
      const stopBtn = card.querySelector('.stop-btn');
      stopBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        const wf = this.workflows.find(w => w.wf_id === wfId);
        const isAdminView = wf?._is_admin_view || (wf?.user?.id && wf.user.id !== window.authManager?.user?.id);
        if (isAdminView) return;
        this.stopWorkflow(wfId);
      });

      // Reset button (skip for admin view)
      const resetBtn = card.querySelector('.reset-btn');
      resetBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        this._closeAllDropdowns(listContainer);
        const wf = this.workflows.find(w => w.wf_id === wfId);
        const isAdminView = wf?._is_admin_view || (wf?.user?.id && wf.user.id !== window.authManager?.user?.id);
        if (isAdminView) return;
        this.resetWorkflow(wfId);
      });

      // Export button
      const exportBtn = card.querySelector('.export-btn');
      exportBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        this._closeAllDropdowns(listContainer);
        this.exportWorkflow(wfId);
      });

      // Delete button
      const deleteBtn = card.querySelector('.delete-btn');
      deleteBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        this._closeAllDropdowns(listContainer);
        this.deleteWorkflow(wfId);
      });
    });

    // Close dropdowns handled per-menu-open (in menuBtn click handler)

    // Bind share button cho owned workflows
    listContainer.querySelectorAll('.share-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const wfId = btn.closest('.workflow-card')?.dataset.wfId;
        if (wfId) {
          this._closeAllDropdowns(listContainer);
          this.handleShare(wfId);
        }
      });
    });
  }

  /**
   * Render lại workflow list. Shared workflows hiện ở tab riêng (Shared with me) —
   * KHÔNG render section trong tab Workflows nữa.
   */
  renderWorkflowList() {
    this.render();
    // Update badge count cho tab Shared
    this._updateSharedTabBadge();
  }

  /**
   * Cập nhật badge số lượng trên tab "Shared with me"
   */
  _updateSharedTabBadge() {
    // Search trong root container của WorkflowTab (parent của #workflowList)
    const rootContainer = this.container.closest('#tab-workflow') || document;
    const badge = rootContainer.querySelector('[data-shared-count]');
    if (!badge) return;
    const count = this._sharedWorkflows?.length || 0;
    if (count > 0) {
      badge.textContent = count;
      badge.style.display = '';
    } else {
      badge.style.display = 'none';
    }
  }

  /**
   * Render full shared workflows list trong tab "Shared with me".
   * Style giống workflow list của user (card full width).
   * @param {HTMLElement} container - Tab content container ([data-content="shared"])
   */
  renderSharedTab(container) {
    if (!container) return;
    const t = (key, params) => window.I18n?.t(key, params) || key;
    this._updateSharedTabBadge();

    if (!this._sharedWorkflows || this._sharedWorkflows.length === 0) {
      container.innerHTML = `
        <div class="workflow-empty-state">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/>
            <polyline points="16 6 12 2 8 6"/>
            <line x1="12" y1="2" x2="12" y2="15"/>
          </svg>
          <p>${t('workflow.sharedEmpty', 'Chưa có workflow nào được chia sẻ với bạn')}</p>
        </div>
      `;
      return;
    }

    // Render danh sách full width — dùng same `_renderSharedWorkflowCard` đã có
    const cards = this._sharedWorkflows.map(wf => this._renderSharedWorkflowCard(wf)).join('');
    container.innerHTML = `
      <div class="workflow-list-container" style="overflow-y: auto; flex: 1; padding: 8px;">
        <div class="workflow-list">${cards}</div>
      </div>
    `;

    // Bind events cho cards
    const listEl = container.querySelector('.workflow-list');
    if (listEl) this._bindSharedCardEvents(listEl);
  }

  /**
   * @deprecated — section "Được chia sẻ với tôi" đã chuyển sang tab riêng.
   * Giữ lại để không break callers cũ; logic chuyển sang renderSharedTab().
   */
  _renderSharedSection() {
    // No-op: shared workflows giờ render ở tab riêng qua renderSharedTab()
    this._updateSharedTabBadge();
    return;

    /* eslint-disable no-unreachable */
    const listContainer = this.container.querySelector('#workflowList');
    if (!listContainer) return;
    const existingSection = listContainer.querySelector('.shared-workflows-section');
    if (existingSection) existingSection.remove();
    if (!this._sharedWorkflows || this._sharedWorkflows.length === 0) return;

    const t = (key, params) => window.I18n?.t(key, params) || key;

    // Build shared section HTML
    const sectionHtml = `
      <div class="shared-workflows-section">
        <div class="shared-workflows-header">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="22 12 16 12 14 15 10 15 8 12 2 12"></polyline>
            <path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"></path>
          </svg>
          <span>${t('workflow.sharedWithMe') || 'Shared with me'}</span>
          <span class="shared-workflows-count">(${this._sharedWorkflows.length})</span>
        </div>
        <div class="shared-workflows-list">
          ${this._sharedWorkflows.map(wf => this._renderSharedWorkflowCard(wf)).join('')}
        </div>
      </div>
    `;

    listContainer.insertAdjacentHTML('beforeend', sectionHtml);

    // Bind events cho shared cards
    this._bindSharedCardEvents(listContainer);
  }

  /**
   * Render card cho shared workflow
   */
  _renderSharedWorkflowCard(workflow) {
    // Shared workflow → chỉ status icon hiển thị 'completed', card parent giữ neutral
    // (KHÔNG thêm class 'completed' vào .workflow-card để tránh styling completed cho cả card)
    const statusClass = 'completed';
    const nodeCount = workflow.nodes?.length ?? workflow.nodes_count ?? 0;
    const sharerName = workflow.sharer_name || workflow.shared_by_name || 'Người dùng';
    const sharedTime = this._formatSharedTime(workflow.shared_at);

    return `
      <div class="workflow-card" data-wf-id="${workflow.wf_id}" data-shared="true">
        <div style="display: flex; align-items: center; flex: 1; min-width: 0; gap: 10px;">
          <span class="workflow-card-status ${statusClass}" data-tooltip="${WorkflowList._renderStatusLabel(statusClass)}">${WorkflowList._renderStatusIcon(statusClass)}</span>
          <div class="workflow-card-info">
            <div class="workflow-card-name-row">
              <span class="workflow-card-name">${this.escapeHtml(workflow.wf_name || (window.I18n?.t('workflow.unnamed') || 'Workflow không tên'))}</span>
            </div>
            <div class="workflow-card-meta">
              ${nodeCount} nodes · ${window.I18n?.t('workflow.fromSharer', { name: this.escapeHtml(sharerName) }) || `Từ ${this.escapeHtml(sharerName)}`}
            </div>
            ${sharedTime ? `<div class="workflow-card-meta" style="opacity: 0.7; font-size: 11px;">${window.I18n?.t('workflow.acceptedAt', 'Đã nhận')} ${sharedTime}</div>` : ''}
          </div>
        </div>
        <div class="workflow-card-actions">
          <button class="btn btn-secondary btn-sm view-shared-quick-btn" title="${window.I18n?.t('workflow.view') || 'Xem'}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
              <circle cx="12" cy="12" r="3"></circle>
            </svg>
          </button>
          <div class="tobyflow-dot-menu" data-wf-id="${workflow.wf_id}">
            <button class="btn btn-secondary btn-sm tobyflow-dot-menu-btn" title="Menu">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="5" r="1"></circle>
                <circle cx="12" cy="12" r="1"></circle>
                <circle cx="12" cy="19" r="1"></circle>
              </svg>
            </button>
            <div class="tobyflow-dropdown-menu hidden">
              <button class="tobyflow-dropdown-item view-shared-btn">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
                  <circle cx="12" cy="12" r="3"></circle>
                </svg>
                ${window.I18n?.t('workflow.view') || 'Xem'}
              </button>
              <button class="tobyflow-dropdown-item duplicate-shared-btn">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                </svg>
                ${window.I18n?.t('workflow.useWorkflow') || 'Use Workflow'}
              </button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  /**
   * Bind events cho shared workflow cards
   */
  _bindSharedCardEvents(listContainer) {
    // Class `.shared-workflow-card` đã bỏ khỏi markup (card render giống workflow thường).
    // Dùng selector `.workflow-card[data-shared="true"]` để target đúng shared cards.
    const sharedCards = listContainer.querySelectorAll('.workflow-card[data-shared="true"]');

    sharedCards.forEach(card => {
      const wfId = card.dataset.wfId;

      // 3-dot menu
      const dotMenu = card.querySelector('.tobyflow-dot-menu');
      if (dotMenu) {
        const menuBtn = dotMenu.querySelector('.tobyflow-dot-menu-btn');
        const dropdown = dotMenu.querySelector('.tobyflow-dropdown-menu');
        menuBtn?.addEventListener('click', (e) => {
          e.stopPropagation();
          const wasHidden = dropdown?.classList.contains('hidden');
          this._closeAllDropdowns(listContainer);
          if (dropdown && wasHidden) {
            dropdown.classList.remove('hidden');
            this._positionDropdown(menuBtn, dropdown);
            setTimeout(() => {
              document.addEventListener('click', () => this._closeAllDropdowns(listContainer), { once: true });
            }, 0);
          }
        });
      }

      // View button (in dropdown)
      const viewBtn = card.querySelector('.view-shared-btn');
      viewBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        this._closeAllDropdowns(listContainer);
        this._viewSharedWorkflow(wfId);
      });

      // Quick view button (icon bên trái menu 3 chấm)
      const viewQuickBtn = card.querySelector('.view-shared-quick-btn');
      viewQuickBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        this._closeAllDropdowns(listContainer);
        this._viewSharedWorkflow(wfId);
      });

      // Duplicate button
      const duplicateBtn = card.querySelector('.duplicate-shared-btn');
      duplicateBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        this._closeAllDropdowns(listContainer);
        this.handleDuplicateFromShared(wfId);
      });
    });
  }

  /**
   * View shared workflow (read-only)
   */
  async _viewSharedWorkflow(wfId) {
    const workflow = this._sharedWorkflows.find(w => w.wf_id === wfId);
    if (!workflow) return;

    // Open in read-only mode
    if (window.eventBus) {
      window.eventBus.emit('workflow:open_editor', { mode: 'view', workflow, readOnly: true });
    }
  }

  async _reorderWorkflows(fromId, toId, listContainer) {
    // Get current visual order from DOM
    const cards = [...listContainer.querySelectorAll('.workflow-card')];
    const orderedIds = cards.map(c => c.dataset.wfId);
    const fromIdx = orderedIds.indexOf(fromId);
    const toIdx = orderedIds.indexOf(toId);
    if (fromIdx === -1 || toIdx === -1) return;

    // Move item
    orderedIds.splice(fromIdx, 1);
    orderedIds.splice(toIdx, 0, fromId);

    // Update sort_order on workflows and save
    for (let i = 0; i < orderedIds.length; i++) {
      const wf = this.workflows.find(w => w.wf_id === orderedIds[i]);
      if (wf) wf.sort_order = i;
    }

    if (window.storageManager) {
      try {
        for (const wf of this.workflows) {
          await window.storageManager.saveWorkflow(wf);
        }
      } catch (e) {
        console.error('[WorkflowList] Reorder save failed:', e);
      }
    }

    this.render();
  }

  renderWorkflowCard(workflow) {
    // Force status='pending' nếu workflow vừa được stop (tránh server data stale)
    const isInStoppedSet = this._stoppedWfIds?.has(workflow.wf_id);
    if (isInStoppedSet) {
      console.log('[WorkflowList] renderWorkflowCard: forcing pending for stopped workflow:', workflow.wf_id);
    }
    const statusClass = isInStoppedSet ? 'pending' : (workflow.status || 'idle');
    const nodeCount = workflow.progress_total || 0;
    const completedCount = workflow.progress_completed || 0;
    const progress = nodeCount > 0 ? Math.round((completedCount / nodeCount) * 100) : 0;
    const isEditing = this._editingWfId === workflow.wf_id;
    const isRunning = workflow.status === 'running' && !this._stoppedWfIds?.has(workflow.wf_id);
    const isEnabled = workflow.enabled !== false;
    const canDelete = !isRunning && !isEditing;

    // Y-2: Project label
    const isCurrent = window.ProjectHelper?.isCurrentProject(workflow) !== false;
    const projectLabel = workflow.project_id && !this._filterProjectId
      ? (window.ProjectHelper?.renderProjectLabel(workflow.project_id, this._projectNames[workflow.project_id] || '', isCurrent) || '')
      : '';
    const crossProjectClass = !isCurrent ? 'cross-project' : '';

    // [Admin mode] Hiển thị owner khi workflow thuộc user khác
    // Check bằng user_id (luôn có) hoặc user.id (chỉ admin mode mới load)
    const currentUserId = window.authManager?.user?.id;
    const workflowOwnerId = workflow.user_id || workflow.user?.id;
    const isAdminViewing = !!(workflowOwnerId && currentUserId && workflowOwnerId !== currentUserId);
    const ownerHtml = isAdminViewing && workflow.user
      ? `<div class="workflow-card-owner" title="${window.I18n?.t('workflow.owner') || 'Chủ sở hữu'}: ${this.escapeHtml(workflow.user.email || '')}"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>${this.escapeHtml(workflow.user.name || workflow.user.email || 'User ' + workflow.user.id)}</div>`
      : (isAdminViewing ? `<div class="workflow-card-owner"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>User #${workflowOwnerId}</div>` : '');

    // Last run time / Last edit time
    const lastRunHtml = workflow.last_run_at
      ? `<div class="workflow-card-last-run" title="${window.I18n?.t('workflow.lastRun') || 'Lần chạy gần nhất'}"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>${this._formatRelativeTime(workflow.last_run_at)}</div>`
      : '';
    const lastEditHtml = workflow.updated_at
      ? `<div class="workflow-card-last-edit" title="${window.I18n?.t('workflow.lastEdit') || 'Chỉnh sửa gần nhất'}"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><g fill="currentColor"><path d="M9.624 2.34a10.5 10.5 0 0 1 7.195.518A10.46 10.46 0 0 1 21.982 7.9a10.5 10.5 0 0 1 .697 7.172c-.62 2.402-2.08 4.5-4.1 5.935a10.48 10.48 0 0 1-6.963 1.891 10.52 10.52 0 0 1-6.533-3.039 1 1 0 0 1 1.414-1.414 8.52 8.52 0 0 0 5.288 2.46 8.48 8.48 0 0 0 5.636-1.528 8.52 8.52 0 0 0 3.321-4.805 8.5 8.5 0 0 0-.564-5.807v-.002A8.46 8.46 0 0 0 16 4.684a8.5 8.5 0 0 0-5.825-.422A8.53 8.53 0 0 0 5.45 7.699h-.001a8.6 8.6 0 0 0-1.377 3.66l.51-.61a1 1 0 0 1 1.535 1.282l-2.18 2.61a1 1 0 0 1-1.536-.001l-2.17-2.61a1 1 0 0 1 1.537-1.28l.318.383a10.6 10.6 0 0 1 1.703-4.548v-.002A10.53 10.53 0 0 1 9.625 2.34"></path><path d="M12 8.401a1 1 0 0 1 1 1v3.55l2.535 1.606a1 1 0 0 1-1.07 1.689l-3-1.9a1 1 0 0 1-.465-.845V9.4a1 1 0 0 1 1-1"></path></g></svg>${this._formatRelativeTime(workflow.updated_at)}</div>`
      : '';

    const isPending = this._pendingWfIds?.has(workflow.wf_id) && !isRunning;
    const runningClass = isRunning ? 'running' : (isPending ? 'pending' : '');

    // Shared users avatars (nếu có)
    const sharesHtml = this._renderSharedUsersAvatars(workflow.shares || []);

    return `
      <div class="workflow-card ${statusClass} ${runningClass} ${isEditing ? 'editing' : ''} ${!isEnabled ? 'wf-disabled' : ''} ${crossProjectClass}" data-wf-id="${workflow.wf_id}">
        <span class="workflow-card-status ${statusClass}" data-tooltip="${WorkflowList._renderStatusLabel(statusClass)}" aria-label="${WorkflowList._renderStatusLabel(statusClass)}">${WorkflowList._renderStatusIcon(statusClass)}</span>
        <div style="display: flex; align-items: center; flex: 1; min-width: 0;">
          <div class="workflow-card-info">
            <div class="workflow-card-name-row">
              <span class="workflow-card-name">${this.escapeHtml(workflow.wf_name || (window.I18n?.t('workflow.unnamed') || 'Workflow không tên'))}</span>
              ${isRunning ? `<span class="workflow-card-inline-progress"><span class="workflow-card-inline-progress-bar" style="width: ${progress}%"></span></span>` : ''}
            </div>
            <div class="workflow-card-meta">
              <svg class="workflow-card-node-icon" width="12" height="12" viewBox="0 0 16 16" fill="none"><path fill-rule="evenodd" clip-rule="evenodd" d="M6.17 3.646a.5.5 0 0 1 .707 0l5.477 5.477a.5.5 0 0 1 0 .707l-1.366 1.366a4.373 4.373 0 1 1-6.184-6.184L6.17 3.646Zm.353 1.061L5.508 5.723 5.5 5.73a3.373 3.373 0 1 0 4.77 4.77l.006-.008 1.016-1.015-4.77-4.77Z" fill="currentColor"/><path fill-rule="evenodd" clip-rule="evenodd" d="M5.354 10.646a.5.5 0 0 1 0 .707L3.02 13.688a.5.5 0 1 1-.707-.707l2.334-2.334a.5.5 0 0 1 .707 0ZM10.354 2.313a.5.5 0 0 1 0 .707L8.02 5.354a.5.5 0 0 1-.707-.708l2.334-2.333a.5.5 0 0 1 .707 0ZM13.687 5.646a.5.5 0 0 1 0 .708l-2.333 2.333a.5.5 0 1 1-.707-.707l2.333-2.334a.5.5 0 0 1 .707 0Z" fill="currentColor"/></svg>
              ${nodeCount} nodes${isRunning ? ` - ${progress}%` : ''}${isEditing ? ' - Editing' : ''}
            </div>
            ${ownerHtml}
            <div class="workflow-card-time-row">
              ${lastRunHtml || lastEditHtml}
              ${sharesHtml}
            </div>
          </div>
        </div>
        <div class="workflow-card-actions">
          ${!isAdminViewing ? `
          <button class="wf-toggle-btn ${isEnabled ? 'on' : 'off'}" title="${isEnabled ? (window.I18n?.t('workflow.disableWorkflow') || 'Tắt workflow') : (window.I18n?.t('workflow.enableWorkflow') || 'Bật workflow')}">
            <span class="wf-toggle-track"><span class="wf-toggle-thumb"></span></span>
          </button>
          ` : ''}
          ${isRunning ? `
            <button class="btn btn-secondary btn-sm edit-btn" title="${window.I18n?.t('workflow.viewStatus') || 'Xem trạng thái'}">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
                <circle cx="12" cy="12" r="3"></circle>
              </svg>
            </button>
            ${!isAdminViewing ? `
            <button class="btn btn-secondary btn-sm btn-warning stop-btn" title="${window.I18n?.t('common.stop') || 'Dừng'}">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="6" y="6" width="12" height="12"></rect>
              </svg>
            </button>
            <button class="btn btn-secondary btn-sm reset-btn" title="Force Reset" style="color: var(--destructive, #ef4444);">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path><path d="M3 3v5h5"></path>
              </svg>
            </button>
            ` : ''}
          ` : `
            <div class="tobyflow-dot-menu" data-wf-id="${workflow.wf_id}">
              <button class="btn btn-secondary btn-sm tobyflow-dot-menu-btn" title="Menu">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <circle cx="12" cy="5" r="1"></circle>
                  <circle cx="12" cy="12" r="1"></circle>
                  <circle cx="12" cy="19" r="1"></circle>
                </svg>
              </button>
              <div class="tobyflow-dropdown-menu hidden">
                <button class="tobyflow-dropdown-item edit-btn">
                  ${isAdminViewing
                    ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>
                       ${window.I18n?.t('common.view') || 'View'}`
                    : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
                       ${window.I18n?.t('common.edit') || 'Edit'}`
                  }
                </button>
                ${!isAdminViewing && nodeCount > 0 && isEnabled ? `
                <button class="tobyflow-dropdown-item run-btn">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
                  ${window.I18n?.t('common.run') || 'Run'}
                </button>
                ` : ''}
                ${!isAdminViewing ? `
                <button class="tobyflow-dropdown-item reset-btn">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path><path d="M3 3v5h5"></path></svg>
                  ${window.I18n?.t('common.reset') || 'Reset'}
                </button>
                ` : ''}
                ${!isAdminViewing && window.authManager?.isLoggedIn() && !workflow._is_shared_view ? `
                <button class="tobyflow-dropdown-item share-btn ${!window.featureGate?.canUse('workflow_share_enabled') ? 'tobyflow-dropdown-item--locked' : ''}">
                  <span class="wf-dropdown-icon-wrap">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"></circle><circle cx="6" cy="12" r="3"></circle><circle cx="18" cy="19" r="3"></circle><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"></line><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"></line></svg>
                    ${!window.featureGate?.canUse('workflow_share_enabled') ? `<svg class="wf-dropdown-lock-badge" width="9" height="9" viewBox="0 0 24 24" fill="var(--warning, #f59e0b)" stroke="var(--warning, #f59e0b)" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4" fill="none"></path></svg>` : ''}
                  </span>
                  ${window.I18n?.t('common.share') || 'Share'}
                </button>
                ` : ''}
                ${!isAdminViewing ? `
                <button class="tobyflow-dropdown-item copy-btn">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                  ${window.I18n?.t('workflow.duplicate') || 'Duplicate'}
                </button>
                ` : ''}
                <button class="tobyflow-dropdown-item export-btn ${!window.featureGate?.canUse('workflow_export') ? 'tobyflow-dropdown-item--locked' : ''}">
                  <span class="wf-dropdown-icon-wrap">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>
                    ${!window.featureGate?.canUse('workflow_export') ? `<svg class="wf-dropdown-lock-badge" width="9" height="9" viewBox="0 0 24 24" fill="var(--warning, #f59e0b)" stroke="var(--warning, #f59e0b)" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4" fill="none"></path></svg>` : ''}
                  </span>
                  ${window.I18n?.t('common.export') || 'Export'}
                </button>
                ${!isAdminViewing ? `
                <button class="tobyflow-dropdown-item delete-btn tobyflow-dropdown-danger" ${!canDelete ? 'disabled' : ''}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                  ${window.I18n?.t('common.delete') || 'Delete'}
                </button>
                ` : ''}
              </div>
            </div>
          `}
        </div>
        ${isRunning ? `
          <div class="workflow-card-progress">
            <div class="workflow-card-progress-bar">
              <div class="workflow-card-progress-bar-fill" style="width: ${progress}%"></div>
            </div>
          </div>
        ` : ''}
      </div>
    `;
  }

  async _openWorkflow(wfId, cardEl) {
    console.log('[WorkflowList] _openWorkflow called:', wfId, 'already opening:', this._opening);
    if (this._opening) {
      console.log('[WorkflowList] _openWorkflow BLOCKED - already opening');
      return;
    }
    this._opening = true;

    // Show loading spinner on card
    if (cardEl) {
      cardEl.classList.add('opening');
      const actionsEl = cardEl.querySelector('.workflow-card-actions');
      if (actionsEl) {
        actionsEl.dataset.prevHtml = actionsEl.innerHTML;
        actionsEl.innerHTML = `<div class="tobyflow-loading-spinner" style="width:18px;height:18px;"></div>`;
      }
    }

    try {
      let workflow = this.workflows.find(w => w.wf_id === wfId);
      const listWorkflow = workflow; // Keep reference to list data
      console.log('[WorkflowList] StorageManager mode:', window.storageManager?.getMode());

      // Check if this is admin viewing another user's workflow BEFORE fetching
      const currentUserId = window.authManager?.user?.id;
      const workflowOwnerId = workflow?.user_id || workflow?.user?.id;
      const isAdminViewFromList = !!(workflowOwnerId && currentUserId && workflowOwnerId !== currentUserId);
      console.log('[WorkflowList] Admin view check from list:', { workflowOwnerId, currentUserId, isAdminViewFromList });

      if (window.storageManager) {
        try {
          const freshWorkflow = await window.storageManager.getWorkflow(wfId);
          if (freshWorkflow) {
            workflow = freshWorkflow;
            console.log('[WorkflowList] Got fresh workflow from API, nodes:', workflow?.nodes?.length, '_is_admin_view:', workflow?._is_admin_view);
          }
        } catch (fetchErr) {
          console.warn('[WorkflowList] Failed to fetch workflow:', fetchErr.message);
          // Use list data as fallback
        }
      }
      console.log('[WorkflowList] Opening workflow:', workflow?.wf_name, 'nodes:', workflow?.nodes?.map(n => ({ id: n.node_id, name: n.node_name, pos_x: n.pos_x, pos_y: n.pos_y })));

      if (window.eventBus) {
        // Check admin view: explicit flag from API OR user_id mismatch
        const isAdminView = workflow?._is_admin_view || isAdminViewFromList;
        const mode = isAdminView ? 'admin_preview' : 'edit';
        console.log('[WorkflowList] Opening editor with mode:', mode, 'isAdminView:', isAdminView);
        window.eventBus.emit('workflow:open_editor', { mode, workflow });
      }
    } catch (e) {
      console.error('[WorkflowList] Failed to load workflow:', e);
    } finally {
      // Re-enable after short delay (window creation takes a moment)
      setTimeout(() => {
        console.log('[WorkflowList] _openWorkflow finally block executing for', wfId);
        this._opening = false;
        if (cardEl) {
          cardEl.classList.remove('opening');
          const actionsEl = cardEl.querySelector('.workflow-card-actions');
          console.log('[WorkflowList] Finally: actionsEl exists:', !!actionsEl, 'prevHtml exists:', !!actionsEl?.dataset.prevHtml);

          if (actionsEl?.dataset.prevHtml) {
            // Luôn restore prevHtml để có structure đúng (dropdown menu, buttons)
            actionsEl.innerHTML = actionsEl.dataset.prevHtml;
            delete actionsEl.dataset.prevHtml;

            // CRITICAL: Luôn rebind events cho dropdown menu (innerHTML replace xóa hết listeners)
            // Cần bind ngay cả khi workflow running vì khi complete sẽ show lại dropdown
            this._bindSingleCardEvents(cardEl);

            // Check nếu workflow đang running → trigger update để set đúng UI state
            const isWorkflowRunning = window.workflowExecutor?.isRunning &&
                                       window.workflowExecutor?.currentWorkflow?.wf_id === wfId;
            console.log('[WorkflowList] Finally: isWorkflowRunning:', isWorkflowRunning,
              'executor.isRunning:', window.workflowExecutor?.isRunning,
              'currentWorkflow.wf_id:', window.workflowExecutor?.currentWorkflow?.wf_id,
              'target wfId:', wfId);
            if (isWorkflowRunning) {
              this._updateCardRunningState(wfId, true);
            }
          }
        } else {
          console.log('[WorkflowList] Finally: cardEl is null/undefined');
        }
        // loadWorkflows có thể bị block do cooldown, nhưng events đã được rebind ở trên
        this.loadWorkflows();
      }, 1500);
    }
  }

  async toggleWorkflowEnabled(wfId) {
    const wf = this.workflows.find(w => w.wf_id === wfId);
    if (!wf) return;
    wf.enabled = wf.enabled === false ? true : false;
    // Update UI immediately regardless of save result
    this.render();
    try {
      if (window.storageManager) await window.storageManager.saveWorkflow(wf);
    } catch (e) {
      console.error('[WorkflowList] Toggle enabled failed:', e);
    }
  }

  /**
   * Pre-flight check: Kiểm tra các provider tabs đã sẵn sàng chưa trước khi run workflow.
   * @param {Object} workflow - Workflow object với nodes
   * @returns {Promise<{ready: boolean, providers: Object}>}
   */
  async _preflightCheck(workflow) {
    const I = window.I18n;
    const nodes = workflow.nodes || [];
    // [Bug 67 fix 2026-05-24] Đồng nhất provider name với WorkflowEditor — dùng ProviderMeta
    // (server config "Google Flow"/"ChatGPT"/"Grok"/"Gemini") thay vì hardcode "Flow".
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
        // AI Agent rename (2026-05-30): schema flat top-level — `node.use_ai` + `node.provider`.
        providersUsed.add(node.provider || 'chatgpt');
      }
    }
    console.log('[WorkflowList] _preflightCheck: providers used:', [...providersUsed]);

    if (providersUsed.size === 0) {
      console.log('[WorkflowList] _preflightCheck: no providers, returning ready');
      return { ready: true, providers: {} };
    }

    // Helper: check provider status (with actual login verification)
    const checkProviderStatus = async (provider) => {
      try {
        if (provider === 'flow') {
          const resp = await new Promise(resolve => {
            chrome.runtime.sendMessage({ action: 'checkFlowTabOpen' }, r => resolve(r));
          });
          return { ready: !!resp?.isOpen, tabId: resp?.tabId };
        } else if (provider === 'chatgpt') {
          // Use ensureReady with createIfMissing=false to just check status
          // [Bug 62 fix 2026-05-24] silent: true cho checkProviderStatus — UI hiển thị status, KHÔNG cần dialog
          if (!window.ChatGPTSession?.ensureReady) return { ready: false };
          const result = await window.ChatGPTSession.ensureReady({ createIfMissing: false, activate: false, silent: true }).catch(() => ({ ready: false }));
          return { ready: result?.ready === true, tabId: result?.tabId, error: result?.error };
        } else if (provider === 'grok') {
          // [Bug 62 fix 2026-05-24] silent: true cho checkProviderStatus — UI hiển thị status, KHÔNG cần dialog
          if (!window.GrokSession?.ensureReady) return { ready: false };
          const result = await window.GrokSession.ensureReady({ createIfMissing: false, activate: false, silent: true }).catch(() => ({ ready: false }));
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
    console.log('[WorkflowList] _preflightCheck: initial status:', providerStatus);

    // Check not ready providers (for activation attempt)
    const notReady = Object.entries(providerStatus).filter(([_, v]) => !v.ready);
    // [UX Improvement] Always show modal to let user confirm before running
    // (user yêu cầu giữ modal để xem provider status trước khi confirm).
    console.log('[WorkflowList] _preflightCheck: not ready providers:', notReady.map(([p]) => p));

    // Try to activate tabs for not-ready providers (fire-and-forget)
    console.log('[WorkflowList] _preflightCheck: activating providers:', notReady.map(([p]) => p));
    for (const [provider] of notReady) {
      if (provider === 'flow') {
        // Flow: try to activate existing tab or open new one
        chrome.runtime.sendMessage({ action: 'ensureFlowTabActive' }).catch(() => {});
      } else if (provider === 'chatgpt' && window.ChatGPTSession?.ensureReady) {
        window.ChatGPTSession.ensureReady().catch(() => {});
      } else if (provider === 'grok' && window.GrokSession?.ensureReady) {
        window.GrokSession.ensureReady().catch(() => {});
      }
    }

    // Show modal with real-time status polling (same as WorkflowEditor)
    console.log('[WorkflowList] _preflightCheck: showing provider status modal');
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'confirm-run-overlay';
      overlay.innerHTML = `
        <div class="confirm-run-modal" style="min-width: 320px;">
          <div class="confirm-run-header">
            <span class="confirm-run-title">${I?.t('workflow.preflightTitle') || 'AI Provider Status'}</span>
          </div>
          <div class="confirm-run-body">
            <div class="confirm-run-provider-status" id="wfListPreflightStatus"></div>
          </div>
          <div class="confirm-run-footer">
            <button class="btn btn-secondary" id="wfListPreflightCancel">${I?.t('common.cancel') || 'Hủy'}</button>
            <button class="btn btn-primary" id="wfListPreflightRun">${I?.t('workflow.preflightContinue') || 'Chạy'}</button>
          </div>
        </div>
      `;
      // Append to sidebar container or document body
      const container = this.container?.closest('.tobyflow-sidebar') || document.body;
      container.appendChild(overlay);
      setTimeout(() => overlay.classList.add('visible'), 10);

      const statusEl = overlay.querySelector('#wfListPreflightStatus');
      let pollTimer = null;
      let allReady = false;

      const renderStatus = () => {
        let html = '';
        // [Bug 66 fix 2026-05-24] Trước: chỉ 2 states (Ready/Checking) → khi NOT_LOGGED_IN kẹt "Checking".
        // Sau: phân biệt ready / not_logged_in / cloudflare / no_tab / initial checking (chưa response).
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
            // Has response, not ready — show specific error reason
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
          // st undefined → keep initial Checking (chưa response từ background)
          html += `<div class="confirm-run-provider-badge ${badgeClass}">
            <span class="badge-provider">${iconSvg} ${label}</span>
            <span class="badge-status">${statusText}</span>
          </div>`;
        }
        statusEl.innerHTML = html;

        // Check if all ready now
        allReady = [...providersUsed].every(p => providerStatus[p]?.ready);

        // Update button text based on ready state
        const runBtn = overlay.querySelector('#wfListPreflightRun');
        if (runBtn) {
          runBtn.textContent = allReady
            ? (I?.t('common.run') || 'Run')
            : (I?.t('workflow.runAnyway') || 'Run Anyway');
        }
      };

      // K.8: idempotent guard chặn double-click race (same fix WorkflowEditor).
      let done = false;

      const pollStatus = async () => {
        for (const provider of providersUsed) {
          if (!providerStatus[provider]?.ready) {
            providerStatus[provider] = await checkProviderStatus(provider);
          }
        }
        renderStatus();

        if (allReady && pollTimer) {
          clearInterval(pollTimer);
          pollTimer = null;
          if (!done) {
            done = true;
            cleanup();
            resolve({ ready: true, providers: providerStatus });
          }
        }
      };

      renderStatus();
      pollTimer = setInterval(pollStatus, 2000);

      const cleanup = () => {
        if (pollTimer) clearInterval(pollTimer);
        overlay.classList.remove('visible');
        overlay.style.display = 'none';
        setTimeout(() => overlay.remove(), 200);
      };

      overlay.querySelector('#wfListPreflightCancel').addEventListener('click', () => {
        if (done) return;
        done = true;
        console.log('[WorkflowList] _preflightCheck: user cancelled');
        cleanup();
        resolve({ ready: false, providers: providerStatus, skipped: true });
      });

      overlay.querySelector('#wfListPreflightRun').addEventListener('click', (e) => {
        if (done) return;
        done = true;
        e.currentTarget.disabled = true;
        e.currentTarget.style.opacity = '0.5';
        console.log('[WorkflowList] _preflightCheck: user clicked Run');
        cleanup();
        resolve({ ready: true, providers: providerStatus });
      });
    });
  }

  async runWorkflow(wfId) {
    // [API SPAM FIX — Phase 6] Track wfId sớm để skip loadWorkflows trong khi chạy
    this._lastUpdatedWfId = wfId;

    // Load workflow đầy đủ với nodes/edges (this.workflows chỉ có metadata, không có nodes)
    // Cần nodes để lấy telegram_chat_id và các field khác
    const workflow = await window.storageManager?.getWorkflow(wfId);
    if (!workflow) return;

    // Debug: log nodes enabled status
    console.log('[WorkflowList] runWorkflow nodes enabled status:', workflow.nodes?.map(n => ({
      node_id: n.node_id,
      node_name: n.node_name,
      node_type: n.node_type,
      enabled: n.enabled
    })));

    // Pre-flight check: kiểm tra provider tabs sẵn sàng
    const preflight = await this._preflightCheck(workflow);
    if (!preflight.ready) {
      console.log('[WorkflowList] runWorkflow aborted - preflight check failed or user cancelled');
      return;
    }

    if (window.eventBus) {
      window.eventBus.emit('workflow:run', { workflow });
    }
  }

  async runAllWorkflows() {
    if (this.workflows.length === 0) return;

    // Check run limit for workflow (applies to both anonymous and logged-in users)
    if (window.featureGate) {
      const quota = await window.featureGate.checkQuotaAsync('workflows_run_max');
      if (!quota.allowed) {
        const isLoggedIn = window.authManager?.isLoggedIn();
        if (isLoggedIn) {
          const limitText = quota.limit === 'unlimited' ? (window.I18n?.t('common.unlimited') || 'Không giới hạn') : `${quota.limit} ${window.I18n?.t('workflow.runsPerDay') || 'lượt/ngày'}`;
          const shouldUpgrade = await window.customDialog?.confirm(
            window.I18n?.t('workflow.runQuotaExhausted', { limitText, used: quota.used }) || `Đã hết lượt sử dụng Workflow hôm nay.\n\nGiới hạn: ${limitText}\nĐã dùng: ${quota.used} lượt\n\nNâng cấp gói để tăng giới hạn.`,
            { title: window.I18n?.t('workflow.runQuotaTitle') || 'Workflow runs exhausted', confirmText: window.I18n?.t('common.upgrade') || 'Upgrade', cancelText: window.I18n?.t('common.later') || 'Later' }
          );
          if (shouldUpgrade && typeof window.openUpgradeModal === 'function') {
            window.openUpgradeModal();
          }
        } else {
          window.featureGate.showLoginPrompt(window.I18n?.t('workflow.trialRunExhausted') || 'Bạn đã sử dụng hết lượt chạy workflow trong bản dùng thử.');
        }
        return;
      }
    }

    // Y-4: Filter: enabled + not completed + current project only
    const runnableWorkflows = this.workflows.filter(wf =>
      wf.enabled !== false &&
      wf.status !== 'completed' &&
      (!window.ProjectHelper || window.ProjectHelper.isCurrentProject(wf))
    );
    const disabledCount = this.workflows.filter(wf => wf.enabled === false).length;
    const doneCount = this.workflows.filter(wf => wf.enabled !== false && wf.status === 'completed').length;

    if (runnableWorkflows.length === 0) {
      await window.customDialog.alert(
        window.I18n?.t('workflow.noRunnableWorkflows') || 'Không có workflow nào để chạy. Kiểm tra lại trạng thái bật/tắt và đã hoàn thành.',
        { title: window.I18n?.t('workflow.noRunnableTitle') || 'Không có workflow để chạy' }
      );
      return;
    }

    let message = window.I18n?.t('workflow.runAllConfirm', { count: runnableWorkflows.length }) || `Chạy tuần tự ${runnableWorkflows.length} workflows?`;
    const notes = [];
    if (disabledCount > 0) notes.push(window.I18n?.t('workflow.disabledSkipped', { count: disabledCount }) || `${disabledCount} workflow đang tắt sẽ bị bỏ qua`);
    if (doneCount > 0) notes.push(window.I18n?.t('workflow.completedSkipped', { count: doneCount }) || `${doneCount} workflow đã hoàn thành sẽ bị bỏ qua. Cần reset trước nếu muốn chạy lại`);
    if (notes.length > 0) message += '\n\n' + notes.join('. ') + '.';

    const ok = await window.customDialog.confirm(message, { title: window.I18n?.t('workflow.runAll') || 'Chạy tất cả' });
    if (!ok) return;

    // Set flag to record trial run AFTER workflow completes successfully
    if (window.featureGate) {
      window.featureGate.setPendingWorkflowRun();
    }

    // Set running state + update button to Stop
    this.shouldStopAll = false;
    this._setRunAllButtonRunning();
    this._showBatchProgress(runnableWorkflows.length);

    // Mark all runnable workflows as pending (yellow border, dimmed)
    this._pendingWfIds = new Set(runnableWorkflows.map(w => w.wf_id));
    this.render();

    let current = 0;
    for (const workflow of runnableWorkflows) {
      if (this.shouldStopAll || window.workflowExecutor?.shouldStop) break;

      current++;
      // Remove from pending as it starts running (workflow executor sets status='running')
      this._pendingWfIds.delete(workflow.wf_id);
      this._updateBatchProgress(current, runnableWorkflows.length);

      try {
        if (window.workflowExecutor) {
          await window.workflowExecutor.execute(workflow.wf_id);
        }
      } catch (error) {
        console.error('[WorkflowList] Run all - workflow failed:', workflow.wf_id, error);
      }
    }

    // Reset button and hide progress bar
    this._resetRunAllButton();
  }

  async stopWorkflow(wfId) {
    console.log('[WorkflowList] stopWorkflow called:', wfId, 'isRunning:', window.workflowExecutor?.isRunning);

    // Track stopped workflow để force status='pending' khi re-render
    // Persist to storage để survive page refresh
    this._stoppedWfIds.add(wfId);
    console.log('[WorkflowList] Added to _stoppedWfIds:', wfId, 'set size:', this._stoppedWfIds.size);
    try {
      chrome.storage.local.set({ af_stopped_wfids: [...this._stoppedWfIds] });
    } catch (e) { /* ignore */ }
    // Clear sau 30s (đủ để server sync + user thấy)
    setTimeout(() => {
      this._stoppedWfIds.delete(wfId);
      console.log('[WorkflowList] Removed from _stoppedWfIds:', wfId);
      try {
        chrome.storage.local.set({ af_stopped_wfids: [...this._stoppedWfIds] });
      } catch (e) { /* ignore */ }
    }, 30000);

    // Update UI ngay lập tức
    this._updateCardRunningState(wfId, false, 'pending');

    if (window.workflowExecutor?.isRunning) {
      // Local executor đang chạy → stop trực tiếp
      console.log('[WorkflowList] Stopping local executor');
      window.workflowExecutor.stop();

      // Force timeout: nếu sau 3s vẫn running → force kill
      setTimeout(() => {
        if (window.workflowExecutor?.isRunning) {
          console.warn('[WorkflowList] Force stopping stuck workflow');
          window.workflowExecutor.shouldStop = true;
          window.workflowExecutor.isRunning = false;
          window.MessageBridge?.stopExecution?.().catch(() => {});
          if (window.ExecutionLock) ExecutionLock.forceRelease();
          this.loadWorkflows();
        }
      }, 3000);
    } else {
      // Local executor không chạy → có thể workflow đang chạy ở context khác (popup)
      // Hoặc workflow có status='running' stale từ lần chạy trước (crash/extension reload)
      console.log('[WorkflowList] Broadcasting stop to other contexts');
      try {
        chrome.runtime.sendMessage({
          action: 'workflowExecutionEvent',
          event: 'execution:stop',
          data: { wf_id: wfId }
        });
      } catch (e) {
        console.warn('[WorkflowList] Broadcast stop failed:', e.message);
      }
      // Also try MessageBridge stopExecution
      window.MessageBridge?.stopExecution?.().catch(() => {});

      // FIX: Update server status về 'pending' cho workflow không chạy locally
      // Handles case: server có status='running' stale từ crash/extension reload
      if (window.storageManager) {
        console.log('[WorkflowList] Updating stale workflow status to pending:', wfId);
        window.storageManager.saveWorkflow({
          wf_id: wfId,
          status: 'pending',
          updated_at: new Date().toISOString()
        }).catch(e => console.warn('[WorkflowList] Failed to update workflow status:', e.message));
      }
    }
  }

  // ─── Run All Button State Methods ────────────────────────

  _setRunAllButtonRunning() {
    const btn = this.container.querySelector('#runAllWorkflowsBtn');
    if (!btn) return;
    this.isRunningAll = true;
    btn.classList.add('btn-stop');
    btn.title = window.I18n?.t('workflow.stopAll') || 'Dừng tất cả';
    btn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="6" y="6" width="12" height="12"></rect>
      </svg>
      <span>${window.I18n?.t('workflow.stop') || 'Dừng'}</span>
    `;
  }

  _resetRunAllButton() {
    const btn = this.container.querySelector('#runAllWorkflowsBtn');
    if (!btn) return;
    this.isRunningAll = false;
    this.shouldStopAll = false;
    this._pendingWfIds.clear();
    btn.classList.remove('btn-stop');
    btn.disabled = false;
    btn.title = window.I18n?.t('workflow.runAll') || 'Chạy tất cả';
    btn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polygon points="5 3 19 12 5 21 5 3"></polygon>
      </svg>
      <span>${window.I18n?.t('workflow.runAll') || 'Chạy tất cả'}</span>
    `;
    // Hide progress bar
    this._hideBatchProgress();
  }

  stopAllWorkflows() {
    this.shouldStopAll = true;
    this._pendingWfIds.clear();
    // Stop current workflow execution
    if (window.workflowExecutor?.isRunning) {
      window.workflowExecutor.stop();
    }
    // Update button to "Stopping..."
    const btn = this.container.querySelector('#runAllWorkflowsBtn');
    if (btn) {
      btn.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="6" y="6" width="12" height="12"></rect>
        </svg>
        <span>${window.I18n?.t('workflow.stopping') || 'Stopping...'}</span>
      `;
      btn.disabled = true;
    }
  }

  // ─── Progress Bar Methods ────────────────────────────────

  _showBatchProgress(total) {
    const progressEl = this.container.querySelector('#wfBatchProgress');
    if (!progressEl) return;
    progressEl.classList.remove('hidden');
    this._batchTotal = total;
    this._batchCurrent = 0;
    this._updateBatchProgress(0, total);
  }

  _updateBatchProgress(current, total) {
    const labelEl = this.container.querySelector('#wfBatchProgressLabel');
    const countEl = this.container.querySelector('#wfBatchProgressCount');
    const fillEl = this.container.querySelector('#wfBatchProgressFill');

    if (labelEl) {
      labelEl.textContent = window.I18n?.t('workflow.runningWorkflows') || 'Running workflows...';
    }
    if (countEl) {
      countEl.textContent = `${current}/${total}`;
    }
    if (fillEl) {
      const percent = total > 0 ? (current / total) * 100 : 0;
      fillEl.style.width = `${percent}%`;
    }
  }

  _hideBatchProgress() {
    const progressEl = this.container.querySelector('#wfBatchProgress');
    if (progressEl) {
      progressEl.classList.add('hidden');
    }
  }

  _closeAllDropdowns(container) {
    container?.querySelectorAll('.tobyflow-dropdown-menu').forEach(d => {
      d.classList.add('hidden');
    });
  }

  _positionDropdown(triggerEl, dropdown) {
    const rect = triggerEl.getBoundingClientRect();
    const dropdownHeight = dropdown.offsetHeight || 150;
    const dropdownWidth = dropdown.offsetWidth || 140;
    const viewportHeight = window.innerHeight;
    const viewportWidth = window.innerWidth;

    // Horizontal: right-align with trigger, but ensure it fits in viewport
    const rightEdge = viewportWidth - rect.right;
    if (rect.right - dropdownWidth < 4) {
      // Not enough space on left, align to left edge
      dropdown.style.left = '4px';
      dropdown.style.right = 'auto';
    } else {
      dropdown.style.right = Math.max(4, rightEdge) + 'px';
      dropdown.style.left = 'auto';
    }

    // Vertical: prefer upward; if not enough space, open downward
    if (rect.top > dropdownHeight + 8) {
      dropdown.style.bottom = (viewportHeight - rect.top + 4) + 'px';
      dropdown.style.top = 'auto';
    } else {
      dropdown.style.top = (rect.bottom + 4) + 'px';
      dropdown.style.bottom = 'auto';
    }
  }

  async cloneWorkflow(wfId) {
    // Lock để tránh duplicate click
    if (this._isCloningWorkflow) {
      console.log('[WorkflowList] Clone already in progress, ignoring duplicate click');
      return;
    }

    try {
      this._isCloningWorkflow = true;

      if (!window.storageManager) return;

      // Check quota (async để đảm bảo data mới nhất từ server theo user plan)
      if (window.featureGate) {
        const canCreate = await window.featureGate.canCreateWorkflowAsync();
        if (!canCreate) {
          const isLoggedIn = window.authManager?.isLoggedIn();
          if (!isLoggedIn) {
            window.featureGate.showLoginPrompt(
              window.I18n?.t('workflow.requireLoginToClone') || 'Nhân bản workflow yêu cầu đăng nhập'
            );
          } else {
            const quota = window.featureGate.checkQuota('workflows_max');
            const shouldUpgrade = await window.customDialog?.confirm(
              window.I18n?.t('workflow.cloneQuotaExhausted', { limit: quota.limit, used: quota.used }) || `Gói của bạn giới hạn tối đa ${quota.limit} workflow. Bạn đã có ${quota.used} workflow. Nâng cấp Premium để nhân bản không giới hạn.`,
              { title: window.I18n?.t('workflow.quotaReached') || 'Limit reached', type: 'warning', confirmText: window.I18n?.t('common.upgrade') || 'Upgrade', cancelText: window.I18n?.t('common.later') || 'Later' }
            );
            if (shouldUpgrade && typeof window.openUpgradeModal === 'function') {
              window.openUpgradeModal();
            }
          }
          return;
        }
      }

      window.showNotification?.(window.I18n?.t('workflow.duplicating') || 'Duplicating workflow...', 'success', 1500);

      const workflow = await window.storageManager.getWorkflow(wfId);
      if (!workflow) return;

      // Y-5: Cross-project safe clone
      const isCurrent = window.ProjectHelper?.isCurrentProject(workflow) !== false;

      if (!isCurrent && window.ProjectHelper) {
        const confirmed = await window.ProjectHelper.showCloneConfirmation('workflow');
        if (!confirmed) return;

        // Use ProjectHelper for cross-project clone (resets media)
        const result = window.ProjectHelper.cloneWorkflowCrossProject(workflow, workflow.nodes || [], workflow.edges || []);
        result.workflow.sort_order = this.workflows.length || 0;
        // Uniquify wf_name vs current project workflows (page hiện tại — limitation paginated)
        result.workflow.wf_name = window.ProjectHelper.uniquifyName(
          result.workflow.wf_name,
          this.workflows.map(w => w.wf_name)
        );
        await window.storageManager.saveWorkflowFull(result.workflow, result.nodes, result.edges);
      } else {
        // Same project clone — existing logic
        // UUID + timestamp tránh collision khi clone+create cùng millisecond.
        const newWfId = window.IdGenerator ? window.IdGenerator.next('wf') : `wf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const nodeIdMap = {};

        // Clone nodes with new IDs.
        // Reset toàn bộ result/runtime fields — kết quả thuộc workflow gốc, clone phải start fresh.
        // Status 'pending' đồng nhất với DiagramCanvas.exportWorkflow default.
        const newNodes = (workflow.nodes || []).map((node, i) => {
          const newNodeId = window.IdGenerator ? window.IdGenerator.next('node') : `node_${Date.now()}_${i}`;
          nodeIdMap[node.node_id] = newNodeId;
          return {
            ...node,
            node_id: newNodeId,
            wf_id: newWfId,
            status: 'pending',
            result_file_ids: '',
            result_thumbnails: {},
            result_file_names: {},
            result_provider_urls: {},
            result_text: '',
            result_source: null,
            error_message: '',
            executed_at: null
          };
        });

        // Remap frame source node IDs sang new node IDs
        for (const cloned of newNodes) {
          if (cloned.frame_1_source && cloned.frame_1_source !== 'manual' && cloned.frame_1_source !== '') {
            cloned.frame_1_source = nodeIdMap[cloned.frame_1_source] || cloned.frame_1_source;
          }
          if (cloned.frame_2_source && cloned.frame_2_source !== 'manual' && cloned.frame_2_source !== '') {
            cloned.frame_2_source = nodeIdMap[cloned.frame_2_source] || cloned.frame_2_source;
          }
        }

        // Clone edges with remapped node IDs
        const newEdges = (workflow.edges || []).map(edge => ({
          ...edge,
          edge_id: window.IdGenerator ? window.IdGenerator.next('edge') : `edge_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
          wf_id: newWfId,
          source_node_id: nodeIdMap[edge.source_node_id] || edge.source_node_id,
          target_node_id: nodeIdMap[edge.target_node_id] || edge.target_node_id
        }));

        // Uniquify vs current page workflows (limitation: paginated — không catch trùng cross-page)
        const baseName = (workflow.wf_name || 'Workflow') + ' ' + (window.I18n?.t('project.copySuffix') || '(copy)');
        const uniqueName = window.ProjectHelper?.uniquifyName(baseName, this.workflows.map(w => w.wf_name)) || baseName;
        const newWorkflow = {
          ...workflow,
          wf_id: newWfId,
          wf_name: uniqueName,
          status: 'idle',
          progress_completed: 0,
          progress_total: 0,
          current_node_id: null,
          sort_order: (this.workflows.length || 0)
        };
        delete newWorkflow.nodes;
        delete newWorkflow.edges;

        await window.storageManager.saveWorkflowFull(newWorkflow, newNodes, newEdges);
      }
      // Record usage for anonymous users (server không track)
      if (window.featureGate && !window.authManager?.isLoggedIn()) {
        await window.featureGate.recordWorkflowCreated();
      }
      // Refresh featureGate to update workflow count
      if (window.featureGate) {
        window.featureGate.refresh({ force: true }).catch(e => console.warn('[WorkflowList] FeatureGate refresh failed:', e));
      }
      await this.loadWorkflows();
      window.showNotification?.(window.I18n?.t('workflow.duplicateSuccess') || 'Workflow đã nhân bản', 'success');
    } catch (e) {
      console.error('[WorkflowList] Clone failed:', e);

      // Check if it's a quota error - ApiStorage already shows modal, just log
      if (e.code === 'QUOTA_EXCEEDED' || e.message?.includes('giới hạn')) {
        // Quota error modal already shown by ApiStorage._handleQuotaError
        return;
      }

      // REQUIRES_LOGIN error - show login prompt (defensive, normally caught by canCreateWorkflowAsync)
      if (e.message === 'REQUIRES_LOGIN') {
        window.featureGate?.showLoginPrompt(
          window.I18n?.t('workflow.requireLoginToClone') || 'Nhân bản workflow yêu cầu đăng nhập'
        );
        return;
      }

      window.customDialog?.alert((window.I18n?.t('workflow.duplicateFailed') || 'Không thể nhân bản workflow') + ': ' + e.message, { type: 'error' });
    } finally {
      this._isCloningWorkflow = false;
    }
  }

  // Render project filter as inline select in toolbar
  async _renderProjectFilter() {
    const select = this.container.querySelector('#wfProjectSelectInline');
    if (!select) return;

    // Get unique project IDs from workflows
    const projectIds = new Set();
    const counts = {};
    for (const w of this.workflows) {
      const pid = w.project_id || '__legacy__';
      projectIds.add(pid);
      counts[pid] = (counts[pid] || 0) + 1;
    }

    // Hide when no workflows
    if (this.workflows.length === 0) {
      select.classList.add('hidden');
      return;
    }

    select.classList.remove('hidden');

    const projects = await window.ProjectHelper?.getProjectList() || {};

    // Build options
    const t = (key, params) => window.I18n ? window.I18n.t(key, params) : key;
    let options = `<option value="">${t('project.filterAll', { count: this.workflows.length })}</option>`;

    // Current project first
    if (window._currentProjectId && projectIds.has(window._currentProjectId)) {
      const name = projects[window._currentProjectId]?.name || window._currentProjectName || t('project.current');
      const count = counts[window._currentProjectId] || 0;
      options += `<option value="${window._currentProjectId}" ${this._filterProjectId === window._currentProjectId ? 'selected' : ''}>${this.escapeHtml(name)} (${count})</option>`;
    }

    // Other projects
    for (const pid of projectIds) {
      if (pid === window._currentProjectId || pid === '__legacy__') continue;
      const name = projects[pid]?.name || pid.substring(0, 8);
      const count = counts[pid] || 0;
      options += `<option value="${pid}" ${this._filterProjectId === pid ? 'selected' : ''}>${this.escapeHtml(name)} (${count})</option>`;
    }

    // Legacy items
    if (counts['__legacy__']) {
      options += `<option value="__legacy__" ${this._filterProjectId === '__legacy__' ? 'selected' : ''}>${t('project.legacy')} (${counts['__legacy__']})</option>`;
    }

    select.innerHTML = options;

    // Bind change listener (idempotent — only bind once via flag)
    if (!select._wfListBound) {
      select._wfListBound = true;
      select.addEventListener('change', (e) => {
        this._filterProjectId = e.target.value || null;
        this._currentPage = 1; // reset pagination
        this.render();
      });
    }
  }

  // Y-2: Cache project names for labels
  async _cacheProjectNames() {
    // Collect unique project_ids từ workflows
    const workflowProjectIds = this.workflows
      .map(w => w.project_id)
      .filter(pid => pid);

    // Ensure project names available (fetch từ API nếu missing)
    if (workflowProjectIds.length > 0 && window.ProjectHelper?.ensureProjectNames) {
      await window.ProjectHelper.ensureProjectNames(workflowProjectIds);
    }

    const projects = await window.ProjectHelper?.getProjectList() || {};
    this._projectNames = {};
    for (const [pid, info] of Object.entries(projects)) {
      this._projectNames[pid] = info.name;
    }
  }

  // Format relative time for last run
  _formatRelativeTime(timestamp) {
    if (!timestamp) return '';
    const date = new Date(timestamp);
    const now = new Date();
    const diff = now - date;
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (seconds < 60) return window.I18n?.t('common.justNow') || 'Vừa xong';
    if (minutes < 60) return window.I18n?.t('albums.minutesAgo', { count: minutes }) || `${minutes} phút trước`;
    if (hours < 24) return window.I18n?.t('albums.hoursAgo', { count: hours }) || `${hours} giờ trước`;
    if (days < 7) return window.I18n?.t('albums.daysAgo', { count: days }) || `${days} ngày trước`;
    const localeMap = { vi: 'vi-VN', en: 'en-US', th: 'th-TH', ja: 'ja-JP' };
    const locale = localeMap[window.I18n?.getLocale?.()] || 'vi-VN';
    return date.toLocaleDateString(locale);
  }

  _showToast(message, duration = 2000) {
    let toast = document.querySelector('.tobyflow-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'tobyflow-toast';
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => toast.classList.remove('show'), duration);
  }

  async deleteWorkflow(wfId) {
    const wf = this.workflows.find(w => w.wf_id === wfId);
    const wfName = wf?.name || wf?.wf_name || 'Workflow';

    const ok = await window.customDialog.confirmDangerous(
      window.I18n?.t('workflow.deleteConfirmShort') || 'Xóa vĩnh viễn workflow này?',
      {
        title: window.I18n?.t('workflow.delete') || 'Xóa workflow',
        itemName: wfName
      }
    );
    if (!ok) return;

    try {
      if (window.storageManager) {
        await window.storageManager.deleteWorkflow(wfId);
      }
      // v1.1 paste image feature: cascade delete pasted blobs cho workflow này
      try {
        await window.PendingUploadStore?.deletePasteBlobsForWorkflow?.(wfId);
      } catch (e) { /* ignore */ }
      window.showNotification?.(window.I18n?.t('workflow.deleteSuccess') || 'Workflow đã xóa', 'success');
      // Refresh featureGate to update workflow count
      if (window.featureGate) {
        window.featureGate.refresh({ force: true }).catch(e => console.warn('[WorkflowList] FeatureGate refresh failed:', e));
      }
      // Gap 3 fix: notify popup editor đang mở wf_id này → editor đóng + warn user.
      // Trước đây editor không biết → user save sẽ tạo lại / 404 confusing.
      try {
        chrome.runtime.sendMessage({ action: 'workflowDeleted', wfId });
      } catch (e) { /* ignore */ }
    } catch (error) {
      console.error('[WorkflowList] Delete failed:', error);
      window.showNotification?.(window.I18n?.t('workflow.deleteFailed') || 'Không thể xóa workflow', 'error');
    }
  }

  async resetWorkflow(wfId) {
    const wf = this.workflows.find(w => w.wf_id === wfId);
    if (!wf) return;

    // Force stop executor nếu đang running
    if (window.workflowExecutor?.isRunning) {
      const forceOk = await window.customDialog.confirm(
        'Workflow đang chạy. Force stop và reset?',
        { title: 'Force Reset', type: 'warning', confirmText: 'Force Reset', cancelText: window.I18n?.t('common.cancel') || 'Hủy' }
      );
      if (!forceOk) return;
      try {
        window.workflowExecutor.shouldStop = true;
        window.workflowExecutor.isRunning = false;
        window.MessageBridge?.stopExecution?.().catch(() => {});
        if (window.ExecutionLock) ExecutionLock.forceRelease();
      } catch (e) { /* ignore */ }
    } else {
      const ok = await window.customDialog.confirm(
        window.I18n?.t('workflow.resetConfirm') || 'Reset workflow này? Trạng thái và kết quả sẽ bị xóa.',
        { title: window.I18n?.t('workflow.reset') || 'Reset workflow' }
      );
      if (!ok) return;
    }

    try {
      if (window.storageManager) {
        await window.storageManager.resetWorkflow(wfId);
      }
      // Local eventBus emit → WorkflowTab listener → `_debouncedLoadWorkflows()` (1s coalesced reload)
      window.eventBus?.emit('workflow:reset', { workflowId: wfId });
      chrome.storage.local.remove('af_running_workflow');
      try {
        // Cross-context broadcast (popup editor cùng wf cần biết để refresh). Tag
        // `_originSidebar: true` để chính sidebar runtime handler skip → tránh self-loopback
        // gây double reload (Path C → Path B duplicate).
        chrome.runtime.sendMessage({
          action: 'workflowExecutionEvent',
          event: 'workflow:reset',
          data: { workflowId: wfId },
          _originSidebar: true,
        });
      } catch (e) { /* ignore */ }
      window.showNotification?.(window.I18n?.t('workflow.resetSuccess') || 'Workflow đã reset', 'success');
      // Bỏ `this.loadWorkflows()` immediate — redundant với Path B (eventBus → debounced reload).
      // Trước fix: reset → 2 reload (immediate + debounced 1s).
    } catch (error) {
      console.error('[WorkflowList] Reset failed:', error);
      window.showNotification?.(window.I18n?.t('workflow.resetFailed') || 'Không thể reset workflow', 'error');
    }
  }

  /**
   * Export workflow to JSON file
   */
  async exportWorkflow(wfId) {
    // Feature gate check
    if (!window.featureGate?.canUse('workflow_export')) {
      const label = window.featureGate?.getCrownLabel?.('workflow_export') || 'Premium';
      window.showNotification?.(
        window.I18n?.t('workflow.exportLocked') || `Export workflow: ${label}`,
        'warning'
      );
      return;
    }

    try {
      // Load workflow with nodes từ storage (path khác WorkflowEditor.exportWorkflow đọc Drawflow live)
      let workflow = this.workflows.find(w => w.wf_id === wfId);
      if (window.storageManager) {
        workflow = await window.storageManager.getWorkflow(wfId) || workflow;
      }

      if (!workflow) {
        window.showNotification?.(window.I18n?.t('workflow.noWorkflowToExport') || 'Không tìm thấy workflow', 'error');
        return;
      }

      // Build + download via shared helper (đồng nhất với WorkflowEditor.exportWorkflow path)
      const exportData = window.WorkflowExportHelper.buildExportData(
        workflow.wf_name,
        workflow.description,
        workflow,
        workflow.nodes || [],
        workflow.edges || []
      );
      const filename = window.WorkflowExportHelper.buildExportFilename(workflow.wf_name);
      window.WorkflowExportHelper.downloadJson(exportData, filename);

      window.showNotification?.(window.I18n?.t('workflow.exportSuccess') || 'Workflow đã xuất thành công', 'success');
      console.log('[WorkflowList] Workflow exported:', filename);
    } catch (error) {
      console.error('[WorkflowList] Export failed:', error);
      window.showNotification?.(window.I18n?.t('workflow.exportFailed') || 'Xuất workflow thất bại', 'error');
    }
  }


  showLoading() {
    const listContainer = this.container.querySelector('#workflowList');
    if (listContainer) {
      listContainer.innerHTML = this._renderSkeletons(4);
    }
  }

  _renderSkeletons(count = 4) {
    const skeletons = [];
    // Match real workflow card: [○] status + name (line 1) + nodes meta (line 2) + date (line 3) + toggle + ⋮
    for (let i = 0; i < count; i++) {
      skeletons.push(`
        <div class="workflow-card skeleton">
          <span class="skeleton-status skeleton-circle skeleton-base"></span>
          <div class="skeleton-info">
            <div class="skeleton-text" style="width: ${55 + Math.random() * 30}%; height: 14px;"></div>
            <div class="skeleton-text short" style="width: ${22 + Math.random() * 12}%; height: 11px;"></div>
            <div class="skeleton-text xs" style="width: ${18 + Math.random() * 10}%; height: 10px;"></div>
          </div>
          <div class="skeleton-actions">
            <div class="skeleton-btn skeleton-base" style="width: 32px; height: 18px; border-radius: 10px;"></div>
            <div class="skeleton-btn skeleton-base" style="width: 18px; height: 18px;"></div>
          </div>
        </div>
      `);
    }
    return skeletons.join('');
  }

  showSharedLoadingSkeleton(container) {
    if (!container) return;
    container.innerHTML = `
      <div class="workflow-list-container" style="overflow-y: auto; flex: 1; padding: 8px;">
        <div class="workflow-list">${this._renderSkeletons(3)}</div>
      </div>
    `;
  }

  showError(message) {
    const listContainer = this.container.querySelector('#workflowList');
    if (listContainer) {
      listContainer.innerHTML = `
        <div class="empty-state">
          <p style="color: var(--destructive);">${message}</p>
        </div>
      `;
    }
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text || '';
    return div.innerHTML;
  }

  // ===== IMPORT WORKFLOW FROM FILE (WT-15.1-15.6) =====

  /**
   * WT-15.2: File picker
   */
  _handleImportClick() {
    // Feature gate check
    if (!window.featureGate?.canUse('workflow_import')) {
      const label = window.featureGate?.getCrownLabel?.('workflow_import') || 'Premium';
      window.showNotification?.(
        window.I18n?.t('workflow.importLocked') || `Import workflow: ${label}`,
        'warning'
      );
      return;
    }

    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = (e) => {
      const file = e.target.files?.[0];
      if (file) {
        this._processImportFile(file);
      }
    };
    input.click();
  }

  /**
   * WT-15.3: Validate JSON structure
   */
  _validateImportData(data) {
    const errors = [];
    const t = (key, params) => window.I18n?.t(key, params) || key;

    // Version check
    if (data.version !== '1.0') {
      errors.push(t('workflow.importVersionNotSupported') || 'Phiên bản không hỗ trợ');
    }

    // Type check
    if (data.type !== 'workflow') {
      errors.push(t('workflow.importTypeInvalid') || 'Loại file không đúng');
    }

    // Workflow object
    if (!data.workflow) {
      errors.push(t('workflow.importMissingData') || 'Thiếu dữ liệu workflow');
      return { valid: false, errors };
    }

    // Name
    if (!data.workflow.name || data.workflow.name.length > 100) {
      errors.push(t('workflow.importNameInvalid') || 'Tên workflow không hợp lệ');
    }

    // Nodes array
    if (!Array.isArray(data.workflow.nodes)) {
      errors.push(t('workflow.importMissingNodes') || 'Thiếu danh sách nodes');
    } else {
      // Bug fix: whitelist trước thiếu các node types mới (Phase CG/G/WK-1).
      // → User export workflow có ChatGPT/Grok/Prompt → import bị reject "type không hợp lệ".
      // Bao gồm cả legacy types (transform/condition/merge/output) để import workflow cũ.
      const validTypes = [
        'start', 'generate', 'download', 'delay', 'telegram',
        'note', 'image',
        // Phase 1 — Node Reference System
        'text',
        // Text Extract node (2026-05-29)
        'text_extract',
        // Phase CG (ChatGPT)
        'chatgpt',
        // Phase G (Grok)
        'grok',
        // Phase CG-8 (Prompt enhance)
        'prompt',
        // Legacy (workflow cũ)
        'transform', 'condition', 'merge', 'output',
      ];
      data.workflow.nodes.forEach((node, i) => {
        if (!node.node_id || !node.node_type) {
          errors.push(t('workflow.importNodeMissingIdType', { index: i + 1 }) || `Node ${i + 1} thiếu id hoặc type`);
        }
        if (node.node_type && !validTypes.includes(node.node_type)) {
          errors.push(t('workflow.importNodeTypeInvalid', { index: i + 1, type: node.node_type }) || `Node ${i + 1} có type không hợp lệ: ${node.node_type}`);
        }
      });
    }

    // Edges array
    if (!Array.isArray(data.workflow.edges)) {
      errors.push(t('workflow.importMissingEdges') || 'Thiếu danh sách edges');
    } else if (Array.isArray(data.workflow.nodes)) {
      // Orphan edge check — edge phải tham chiếu node_id tồn tại trong nodes.
      // Drawflow.addConnection fail silently nếu node ID không có → workflow load mất connection.
      const nodeIds = new Set(data.workflow.nodes.map(n => n.node_id).filter(Boolean));
      data.workflow.edges.forEach((edge, i) => {
        const srcId = edge.source_node_id || edge.source_node;
        const tgtId = edge.target_node_id || edge.target_node;
        if (srcId && !nodeIds.has(srcId)) {
          errors.push(t('workflow.importEdgeOrphan', { index: i + 1, side: 'source', id: srcId })
            || `Edge ${i + 1}: source node "${srcId}" không tồn tại`);
        }
        if (tgtId && !nodeIds.has(tgtId)) {
          errors.push(t('workflow.importEdgeOrphan', { index: i + 1, side: 'target', id: tgtId })
            || `Edge ${i + 1}: target node "${tgtId}" không tồn tại`);
        }
      });
    }

    // Bug fix: Quota check workflows_nodes_max — chống bypass qua import JSON.
    // User edit JSON manually thêm nodes vượt quota → trước fix: import OK + save OK.
    // Giờ: reject với UI dialog rõ ràng + suggest upgrade.
    if (Array.isArray(data.workflow.nodes) && window.featureGate) {
      try {
        const quota = window.featureGate.checkQuota('workflows_nodes_max');
        const limit = quota?.limit;
        if (limit !== 'unlimited' && limit !== '-1' && limit > 0 && data.workflow.nodes.length > limit) {
          errors.push(
            t('workflow.importNodeQuotaExceeded', { count: data.workflow.nodes.length, limit })
            || `Gói của bạn giới hạn tối đa ${limit} nodes/workflow.\n\nWorkflow import: ${data.workflow.nodes.length} nodes\nGiới hạn gói: ${limit} nodes\n\nNâng cấp Premium để import workflow này.`
          );
        }
      } catch (e) { /* graceful: skip nếu featureGate chưa ready */ }
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * WT-15.4: Convert URLs → trigger re-upload
   */
  _convertImportedNodes(nodes) {
    const nodeIdMap = {};

    const result = nodes.map(node => {
      const converted = { ...node };

      // Generate new node_id để tránh conflict
      const newNodeId = window.IdGenerator ? window.IdGenerator.next('node') : ('node_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9));
      nodeIdMap[node.node_id] = newNodeId;
      converted.node_id = newNodeId;

      // Convert ref_images array → ref_thumbnails format (triggers re-upload)
      console.log('[Import] Node:', node.node_id, 'ref_images:', node.ref_images);

      if (node.ref_images && node.ref_images.length > 0) {
        const importKeys = [];
        converted.ref_thumbnails = {};
        converted.ref_file_names = {};

        node.ref_images.forEach((img, idx) => {
          // Include random suffix to avoid key collision between nodes processed in same millisecond
          const key = `upload_import_${Date.now()}_${idx}_${Math.random().toString(36).substr(2, 5)}`;
          importKeys.push(key);
          // 2026-05-31: preserve type + video_url cho video tiles (export mới có 2 fields này)
          // → restore object format {thumbnail, type:'video', video_url} cho ref_thumbnails →
          // _restoreNodeStates đọc đúng → render <video> thay <img> broken.
          const hasVideoMeta = img.type === 'video' || img.video_url;
          if (hasVideoMeta) {
            converted.ref_thumbnails[key] = {
              thumbnail: img.thumbnail || img.url || '',
              type: img.type || 'video',
              ...(img.video_url && { video_url: img.video_url }),
            };
          } else {
            converted.ref_thumbnails[key] = img.thumbnail || img.url;
          }
          if (img.file_name) {
            converted.ref_file_names[key] = img.file_name;
          }
          console.log('[Import] Created key:', key, 'thumbnail:', converted.ref_thumbnails[key]);
        });

        // CRITICAL: ref_file_ids phải chứa các keys để editor biết hiển thị thumbnails nào
        converted.ref_file_ids = importKeys.join(', ');
        console.log('[Import] Final ref_file_ids:', converted.ref_file_ids);
        console.log('[Import] Final ref_thumbnails:', converted.ref_thumbnails);
      }

      // Frame metadata: prefer flat format (current export — frame_X_file_name + frame_X_thumbnail),
      // fallback nested (legacy/admin templates — node.frame_X.thumbnail/file_name).
      // ALWAYS reset frame_X_file_id (tile_id session-specific từ project export → cross-project leak).
      // Defensive: reset bất kể JSON có frame data hay không, bao gồm cả edge case JSON sửa thủ công.
      [1, 2].forEach(n => {
        if (node[`frame_${n}_file_id`]) converted[`frame_${n}_file_id`] = '';
        const flatFileName = node[`frame_${n}_file_name`];
        const flatThumbnail = node[`frame_${n}_thumbnail`];
        const nested = node[`frame_${n}`];
        if (flatFileName) converted[`frame_${n}_file_name`] = flatFileName;
        else if (nested?.file_name) converted[`frame_${n}_file_name`] = nested.file_name;
        if (flatThumbnail) converted[`frame_${n}_thumbnail`] = flatThumbnail;
        else if (nested?.thumbnail) converted[`frame_${n}_thumbnail`] = nested.thumbnail;
      });

      return { converted, nodeIdMap };
    }).reduce((acc, { converted, nodeIdMap: map }) => {
      acc.nodes.push(converted);
      Object.assign(acc.nodeIdMap, map);
      return acc;
    }, { nodes: [], nodeIdMap: {} });

    // Pass 2: remap frame_X_source upstream node IDs sang new IDs.
    // 'manual'/'' giữ nguyên — chỉ remap khi source là old node_id của upstream node.
    // Pattern đồng bộ với clone (ProjectHelper.cloneWorkflowCrossProject + WorkflowList.cloneWorkflow).
    for (const cloned of result.nodes) {
      if (cloned.frame_1_source && cloned.frame_1_source !== 'manual' && cloned.frame_1_source !== '') {
        cloned.frame_1_source = result.nodeIdMap[cloned.frame_1_source] || cloned.frame_1_source;
      }
      if (cloned.frame_2_source && cloned.frame_2_source !== 'manual' && cloned.frame_2_source !== '') {
        cloned.frame_2_source = result.nodeIdMap[cloned.frame_2_source] || cloned.frame_2_source;
      }
    }
    return result;
  }

  /**
   * WT-15.6: Handle duplicate names
   */
  _getUniqueName(baseName) {
    const existing = this.workflows.map(w => w.wf_name);
    let name = baseName;
    let counter = 1;

    while (existing.includes(name)) {
      name = `${baseName} (${counter})`;
      counter++;
    }

    return name;
  }

  /**
   * WT-15.5: Save imported workflow
   */
  async _saveImportedWorkflow(importData) {
    const t = (key, params) => window.I18n?.t(key, params) || key;

    // Convert nodes and build new ID mapping
    const { nodes: convertedNodes, nodeIdMap } = this._convertImportedNodes(importData.workflow.nodes);

    // AI Agent rename (2026-05-30) + missing-defaults heal: import JSON có thể là v1.1.5 export
    // chỉ có legacy fields (enhance) hoặc missing required defaults (video_input_type, etc).
    // Fire normalize cho từng node trước khi save → backfill use_ai/ai_fallback/ai_delete_after_run
    // (1-way migrate legacy→new) + safe defaults cho missing video_input_type/grok_mode/use_fallback_prefix.
    // Backend WorkflowDataHealer cũng heal lần 2, nhưng client heal sớm tránh round-trip lỗi.
    convertedNodes.forEach(n => {
      try { window.NodeTemplates?.normalizeNodeData?.(n); } catch (_) { /* ignore */ }
    });

    // Convert edges with remapped node IDs (support both old and new format)
    const convertedEdges = (importData.workflow.edges || []).map(e => {
      // Support both old format (source_node) and new format (source_node_id)
      const oldSourceId = e.source_node_id || e.source_node;
      const oldTargetId = e.target_node_id || e.target_node;

      // 2026-05-31: smart data_type — infer từ source node nếu file cũ không có,
      // text/prompt/text_extract → 'text', còn lại → 'image'.
      let inferredDataType = e.data_type;
      if (!inferredDataType) {
        const srcNode = importData.workflow.nodes?.find(n => n.node_id === oldSourceId);
        const srcType = srcNode?.node_type;
        inferredDataType = ['text', 'text_extract', 'prompt'].includes(srcType) ? 'text' : 'image';
      }
      return {
        edge_id: window.IdGenerator ? window.IdGenerator.next('edge') : ('edge_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5)),
        source_node_id: nodeIdMap[oldSourceId] || oldSourceId,
        source_handle: e.source_handle || e.source_output || 'output_1',
        // Phase WK-1 typed multi-port — bug fix: preserve source_port + target_port từ file.
        // Nếu file export cũ (no port info) → null → DiagramCanvas auto-infer port[0] sang.
        source_port: e.source_port || null,
        target_node_id: nodeIdMap[oldTargetId] || oldTargetId,
        target_handle: e.target_handle || e.target_input || 'input_1',
        target_port: e.target_port || null,
        data_type: inferredDataType
      };
    });

    console.log('[WorkflowList] Converted edges:', convertedEdges.length, convertedEdges.slice(0, 2));

    // Map settings JSON keys → workflow storage field names.
    // Bug fix: export ghi 'parallel' nhưng storage dùng 'parallel_execution' (xem
    // WorkflowEditor.js:756 + WorkflowExecutor.js:233). Spread thẳng sẽ mất giá trị.
    const importedSettings = importData.workflow.settings || {};
    const mappedSettings = {};
    if ('parallel' in importedSettings) mappedSettings.parallel_execution = importedSettings.parallel;
    if ('parallel_execution' in importedSettings) mappedSettings.parallel_execution = importedSettings.parallel_execution;
    if ('quantity' in importedSettings) mappedSettings.quantity = importedSettings.quantity;
    if ('delay_between_nodes' in importedSettings) mappedSettings.delay_between_nodes = importedSettings.delay_between_nodes;
    if ('timeout_per_node' in importedSettings) mappedSettings.timeout_per_node = importedSettings.timeout_per_node;
    if ('retry_on_error' in importedSettings) mappedSettings.retry_on_error = importedSettings.retry_on_error;
    if ('stop_on_error' in importedSettings) mappedSettings.stop_on_error = importedSettings.stop_on_error;

    const workflow = {
      // UUID + timestamp tránh collision khi rapid import.
      wf_id: window.IdGenerator ? window.IdGenerator.next('wf') : ('wf_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)),
      wf_name: this._getUniqueName(importData.workflow.name),
      wf_description: importData.workflow.description || '',
      ...mappedSettings,
      project_id: window._currentProjectId || null,
      status: 'idle',
      enabled: true,
      progress_completed: 0,
      progress_total: convertedNodes.length,
      current_node_id: null,
      sort_order: this.workflows.length || 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    // Add wf_id to nodes and edges.
    // Reset đầy đủ result/runtime fields — JSON file có thể chứa data của workflow đã chạy.
    // GIỮ result_provider_urls (intentional design line 6055-6057 — TTL ngắn cho re-download).
    // Status 'pending' đồng nhất với DiagramCanvas init + clone pattern.
    const nodesWithWfId = convertedNodes.map(n => ({
      ...n,
      wf_id: workflow.wf_id,
      status: 'pending',
      result_file_ids: '',
      result_thumbnails: {},
      result_file_names: {},
      result_text: '',
      result_source: null,
      error_message: '',
      executed_at: null
    }));

    const edgesWithWfId = convertedEdges.map(e => ({
      ...e,
      wf_id: workflow.wf_id
    }));

    // Save using existing storage pattern
    if (window.storageManager) {
      await window.storageManager.saveWorkflowFull(workflow, nodesWithWfId, edgesWithWfId);
    }

    return workflow;
  }

  /**
   * Full import flow (WT-15.1-15.6)
   */
  async _processImportFile(file) {
    const t = (key, params) => window.I18n?.t(key, params) || key;
    const dialog = window.customDialog || window.CustomDialog;

    try {
      // 1. Read file
      const text = await file.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch (parseErr) {
        dialog?.alert(t('workflow.importFileError') || 'Lỗi đọc file: File JSON không hợp lệ', { type: 'error' });
        return;
      }

      // 2. Validate
      const validation = this._validateImportData(data);
      if (!validation.valid) {
        // Check if error is quota-related (node limit exceeded)
        const isQuotaError = validation.errors.some(err =>
          err.includes('node') && (err.includes('giới hạn') || err.includes('limit') || err.includes('quota'))
        );

        if (isQuotaError) {
          // Show upgrade dialog for quota errors
          const shouldUpgrade = await dialog?.confirm(
            validation.errors.join('\n'),
            {
              title: t('workflow.importQuotaTitle') || 'Vượt giới hạn gói',
              type: 'warning',
              confirmText: t('common.upgrade') || 'Nâng cấp',
              cancelText: t('common.cancel') || 'Hủy'
            }
          );
          if (shouldUpgrade && typeof window.openUpgradeModal === 'function') {
            window.openUpgradeModal();
          }
        } else {
          // Show regular error dialog for other validation errors
          dialog?.alert(
            validation.errors.join('\n'),
            {
              title: t('workflow.importErrorTitle') || 'Không thể import',
              type: 'error'
            }
          );
        }
        return;
      }

      // 3. Check quota (async để đảm bảo data mới nhất từ server theo user plan)
      if (window.featureGate) {
        const canCreate = await window.featureGate.canCreateWorkflowAsync();
        if (!canCreate) {
          const isLoggedIn = window.authManager?.isLoggedIn();
          if (!isLoggedIn) {
            window.featureGate.showLoginPrompt(
              t('workflow.requireLoginToImport') || 'Import workflow yêu cầu đăng nhập'
            );
          } else {
            const quota = window.featureGate.checkQuota('workflows_max');
            const shouldUpgrade = await dialog?.confirm(
              t('workflow.quotaLimitReached', { limit: quota.limit, used: quota.used }) ||
              `Gói của bạn giới hạn tối đa ${quota.limit} workflow. Bạn đã có ${quota.used} workflow. Nâng cấp Premium để tạo không giới hạn.`,
              {
                title: t('workflow.quotaLimitTitle') || 'Limit reached',
                type: 'warning',
                confirmText: t('common.upgrade') || 'Nâng cấp',
                cancelText: t('common.later') || 'Later'
              }
            );
            if (shouldUpgrade && typeof window.openUpgradeModal === 'function') {
              window.openUpgradeModal();
            }
          }
          return;
        }
      }

      // 4. Debug log import data
      this._debugImportData(data);

      // 5. Save
      const workflow = await this._saveImportedWorkflow(data);
      if (!workflow || !workflow.wf_id) {
        throw new Error('Không thể lưu workflow - dữ liệu không hợp lệ');
      }
      console.log('[WorkflowList] Workflow saved:', workflow.wf_id, workflow.wf_name);

      // 6. Record usage for anonymous users (server không track)
      if (window.featureGate && !window.authManager?.isLoggedIn()) {
        await window.featureGate.recordWorkflowCreated();
      }

      // 7. Refresh featureGate to update workflow count
      if (window.featureGate) {
        window.featureGate.refresh({ force: true }).catch(e => console.warn('[WorkflowList] FeatureGate refresh failed:', e));
      }

      // 8. Refresh list
      await this.loadWorkflows();

      // 8. Show success
      dialog?.alert(
        t('workflow.importSuccess', { name: workflow.wf_name }) || `Đã nhập workflow "${workflow.wf_name}"`,
        { type: 'success' }
      );

      // 9. Emit event
      window.eventBus?.emit('workflow:imported', { workflowId: workflow.wf_id });

    } catch (err) {
      console.error('[WorkflowList] Import error:', err);

      // Check if it's a quota error - ApiStorage already shows modal
      if (err.code === 'QUOTA_EXCEEDED' || err.message?.includes('giới hạn')) {
        return;
      }

      // REQUIRES_LOGIN error - show login prompt (defensive, normally caught by canCreateWorkflowAsync)
      if (err.message === 'REQUIRES_LOGIN') {
        window.featureGate?.showLoginPrompt(
          t('workflow.requireLoginToImport') || 'Import workflow yêu cầu đăng nhập'
        );
        return;
      }

      dialog?.alert(
        (t('workflow.importFileError') || 'Lỗi import workflow') + ':\n' + (err.message || 'Lỗi không xác định'),
        { type: 'error', title: t('common.error') || 'Lỗi' }
      );
    }
  }

  /**
   * Debug: Log import data structure
   */
  _debugImportData(data) {
    console.log('[WorkflowList] Import data structure:', {
      version: data.version,
      type: data.type,
      hasWorkflow: !!data.workflow,
      workflowName: data.workflow?.name,
      nodesCount: data.workflow?.nodes?.length || 0,
      edgesCount: data.workflow?.edges?.length || 0,
      edgesSample: data.workflow?.edges?.slice(0, 2)
    });
  }

  /**
   * Trả SVG icon theo status: idle/running/completed/error.
   * Running icon có class .status-icon-spin → CSS spin đồng bộ với gen-running-spin.
   */
  static _renderStatusIcon(status) {
    const s = status || 'idle';
    const stroke = 'fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"';
    if (s === 'running') {
      return `<svg class="status-icon-spin" width="14" height="14" viewBox="0 0 24 24" ${stroke}><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>`;
    }
    if (s === 'completed') {
      return `<svg width="14" height="14" viewBox="0 0 24 24" ${stroke}><polyline points="20 6 9 17 4 12"></polyline></svg>`;
    }
    if (s === 'error' || s === 'failed') {
      return `<svg width="14" height="14" viewBox="0 0 24 24" ${stroke}><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;
    }
    return `<svg width="14" height="14" viewBox="0 0 24 24" ${stroke}><circle cx="12" cy="12" r="9"></circle></svg>`;
  }

  /** Trả localized label cho tooltip status. Dùng namespace workflow.* */
  static _renderStatusLabel(status) {
    const I = window.I18n;
    const s = status || 'idle';
    if (s === 'running') return I?.t('workflow.statusRunning') || 'Running';
    if (s === 'completed') return I?.t('workflow.statusCompleted') || 'Hoàn thành';
    if (s === 'error' || s === 'failed') return I?.t('workflow.statusFailed') || 'Failed';
    if (s === 'pending') return I?.t('workflow.statusPending') || 'Pending';
    // idle: dùng common.idle hoặc fallback
    return I?.t('workflow.statusIdle') || I?.t('workflow.statusPending') || 'Ready';
  }

  /**
   * Render avatars của users được share workflow
   * @param {Array} shares - Danh sách share records với recipient info
   * @returns {string} HTML avatars
   */
  _renderSharedUsersAvatars(shares) {
    if (!shares || shares.length === 0) return '';

    // Chỉ lấy shares đã accepted và có recipient
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
      avatarsHtml += `<span class="wf-share-avatar wf-share-avatar-more" title="+${extraCount} người khác">+${extraCount}</span>`;
    }

    return `<div class="wf-share-avatars">${avatarsHtml}</div>`;
  }

  // ===== SHARE WORKFLOW METHODS =====

  /**
   * Mở modal chia sẻ workflow
   * @param {string} wfId - ID của workflow cần chia sẻ
   */
  handleShare(wfId) {
    const workflow = this.workflows.find(w => w.wf_id === wfId);
    if (!workflow) {
      console.error('[WorkflowList] Workflow not found for sharing:', wfId);
      return;
    }

    // Chỉ cho phép chia sẻ workflow user sở hữu
    if (workflow._is_shared_view) {
      window.showNotification?.(
        window.I18n?.t('workflow.cannotShareShared') || 'Không thể chia sẻ workflow được chia sẻ với bạn',
        'warning'
      );
      return;
    }

    // Check feature gate
    if (window.featureGate && !window.featureGate.canUse('workflow_share_enabled')) {
      window.featureGate.showModuleBlockedDialog('workflow_share');
      return;
    }

    // Mở ShareWorkflowModal
    if (window.ShareWorkflowModal) {
      window.ShareWorkflowModal.show(wfId);
    } else {
      console.error('[WorkflowList] ShareWorkflowModal not available');
      window.showNotification?.(
        window.I18n?.t('workflow.shareModalNotAvailable') || 'Chức năng chia sẻ chưa sẵn sàng',
        'error'
      );
    }
  }

  /**
   * Clone workflow từ shared workflow về tài khoản của mình
   * POST /v1/shared-workflows/{wf_id}/clone
   * @param {string} wfId - ID của shared workflow cần clone
   */
  async handleDuplicateFromShared(wfId) {
    // Lock để tránh duplicate click
    if (this._isDuplicatingShared) {
      console.log('[WorkflowList] Duplicate from shared already in progress, ignoring duplicate click');
      return;
    }

    const workflow = this._sharedWorkflows.find(w => w.wf_id === wfId);
    if (!workflow) {
      console.error('[WorkflowList] Shared workflow not found:', wfId);
      return;
    }

    this._isDuplicatingShared = true;

    try {
      // Yêu cầu đăng nhập (function này gọi API cần auth token)
      if (!window.authManager?.isLoggedIn()) {
        window.featureGate?.showLoginPrompt(
          window.I18n?.t('workflow.requireLoginToClone') || 'Nhân bản workflow yêu cầu đăng nhập'
        );
        return;
      }

      // Check quota (async để đảm bảo data mới nhất từ server)
      if (window.featureGate) {
        const canCreate = await window.featureGate.canCreateWorkflowAsync();
        if (!canCreate) {
          const quota = window.featureGate.checkQuota('workflows_max');
          const shouldUpgrade = await window.customDialog?.confirm(
            window.I18n?.t('workflow.cloneQuotaExhausted', { limit: quota.limit, used: quota.used }) ||
              `Gói của bạn giới hạn tối đa ${quota.limit} workflow. Bạn đã có ${quota.used} workflow. Nâng cấp Premium để nhân bản không giới hạn.`,
            {
              title: window.I18n?.t('workflow.quotaReached') || 'Limit reached',
              type: 'warning',
              confirmText: window.I18n?.t('common.upgrade') || 'Upgrade',
              cancelText: window.I18n?.t('common.later') || 'Later'
            }
          );
          if (shouldUpgrade) {
            if (typeof window.openUpgradeModal === 'function') {
              window.openUpgradeModal();
            } else {
              try { chrome.runtime.sendMessage({ action: 'showUpgradeModal' }); } catch (e) {}
            }
          }
          return;
        }
      }

      window.showNotification?.(
        window.I18n?.t('workflow.duplicatingShared') || 'Saving workflow...',
        'success',
        2000
      );

      const baseUrl = window.ApiBaseConfig.get();
      const token = await window.authManager.getToken();

      const response = await fetch(`${baseUrl}/shared-workflows/${wfId}/clone`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-Extension-Id': chrome.runtime.id,
        }
      });

      const json = await response.json().catch(() => ({}));

      if (!response.ok) {
        // Backend trả: { success: false, error: { code, message, data } }
        const errCode = json?.error?.code || json?.code;
        const errMsg = json?.error?.message || json?.message || `HTTP ${response.status}`;

        // QUOTA_EXCEEDED, FEATURE_DISABLED → modal có nút Upgrade
        if (errCode === 'QUOTA_EXCEEDED' || errCode === 'FEATURE_DISABLED') {
          const shouldUpgrade = await window.customDialog?.confirm(errMsg, {
            title: window.I18n?.t('workflow.quotaReached') || 'Limit reached',
            type: 'warning',
            confirmText: window.I18n?.t('common.upgrade') || 'Upgrade',
            cancelText: window.I18n?.t('common.later') || 'Later',
          });
          if (shouldUpgrade && typeof window.openUpgradeModal === 'function') {
            window.openUpgradeModal();
          }
          return;
        }

        // Lỗi khác — toast
        window.showNotification?.(
          (window.I18n?.t('workflow.duplicateSharedFailed') || 'Không thể nhân bản workflow') + ': ' + errMsg,
          'error'
        );
        return;
      }

      const data = json.data || json;
      console.log('[WorkflowList] Duplicated shared workflow:', data);

      window.showNotification?.(
        window.I18n?.t('workflow.duplicateSharedSuccess') || 'Workflow duplicated successfully',
        'success'
      );

      // Refresh danh sách workflows
      await this.loadWorkflows();

      // Refresh featureGate để update quota
      if (window.featureGate) {
        window.featureGate.refresh({ force: true }).catch(e => console.warn('[WorkflowList] FeatureGate refresh failed:', e));
      }

      // Switch to My Workflows tab
      const workflowsTab = document.querySelector('[data-subtab="workflows"]');
      if (workflowsTab) {
        workflowsTab.click();
      }

      // Auto-open the newly cloned workflow
      const newWorkflow = data.workflow || data;
      if (newWorkflow?.wf_id) {
        setTimeout(() => {
          if (this._openWorkflow) {
            this._openWorkflow(newWorkflow.wf_id);
          } else if (window.eventBus) {
            window.eventBus.emit('workflow:open_editor', { mode: 'edit', workflow: newWorkflow });
          }
        }, 300);
      }

    } catch (error) {
      console.error('[WorkflowList] Duplicate from shared failed:', error);
      window.showNotification?.(
        (window.I18n?.t('workflow.duplicateSharedFailed') || 'Không thể nhân bản workflow') + ': ' + error.message,
        'error'
      );
    } finally {
      this._isDuplicatingShared = false;
    }
  }

  /**
   * Format thời gian shared thành relative time
   * @param {string} dateStr - ISO date string
   * @returns {string} Formatted time string
   */
  _formatSharedTime(dateStr) {
    if (!dateStr) return '';

    const normalized = (typeof dateStr === 'string' && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(dateStr))
      ? dateStr.replace(' ', 'T') + 'Z'
      : dateStr;
    const date = new Date(normalized);
    const now = new Date();
    const diffMs = now - date;
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHour = Math.floor(diffMin / 60);
    const diffDay = Math.floor(diffHour / 24);

    const t = (key, fallback) => window.I18n?.t(key) || fallback;

    if (diffSec < 60) {
      return t('notification.time.justNow', 'Vừa xong');
    } else if (diffMin < 60) {
      return `${diffMin} ${t('notification.time.minutesAgo', 'phút trước')}`;
    } else if (diffHour < 24) {
      return `${diffHour} ${t('notification.time.hoursAgo', 'giờ trước')}`;
    } else if (diffDay < 7) {
      return `${diffDay} ${t('notification.time.daysAgo', 'ngày trước')}`;
    } else {
      const day = date.getDate().toString().padStart(2, '0');
      const month = (date.getMonth() + 1).toString().padStart(2, '0');
      const year = date.getFullYear();
      return `${day}/${month}/${year}`;
    }
  }
}

// Export
window.WorkflowList = WorkflowList;
