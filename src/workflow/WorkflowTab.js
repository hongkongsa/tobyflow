/**
 * WorkflowTab - Controller chính cho Tab 4: Toby Flow
 */
class WorkflowTab {
  constructor(container) {
    this.container = container;
    this.workflowList = null;
    this.workflowTemplateList = null;
    this.isInitialized = false;
    this._currentSubtab = 'templates';
  }

  async init() {
    if (this.isInitialized) return;

    console.log('[WorkflowTab] Initializing...');

    // Initialize storage if needed
    if (window.storageManager && !window.storageManager.storage) {
      await window.storageManager.init();
    }

    // Render sub-tabs UI
    this._renderSubtabs();

    // Create WorkflowList component
    const workflowContent = this.container.querySelector('[data-content="workflows"]');
    const listSection = workflowContent || this.container.querySelector('#workflowListSection') || this.container;
    this.workflowList = new WorkflowList(listSection);

    // Bind sub-tab events
    this._bindSubtabEvents();

    // Listen for events
    if (window.eventBus) {
      window.eventBus.on('workflow:open_editor', (data) => {
        this.openEditor(data.mode, data.workflow);
      });

      // Listen for workflow run
      window.eventBus.on('workflow:run', (data) => {
        this.runWorkflow(data.workflow);
      });

      // Listen for execution events to update UI.
      // [API SPAM FIX — Phase 3.1] Dùng _debouncedLoadWorkflows (1s coalesce) để tránh
      // cascade: 5-node workflow trigger execution:progress × 5 + node:completed × 5 +
      // execution:completed × 1 = 11 events → trước fix gọi loadWorkflows 11 lần →
      // sau fix coalesce thành 1 call sau 1s.
      window.eventBus.on('execution:started', () => {
        this.workflowList?._debouncedLoadWorkflows?.() || this.workflowList?.loadWorkflows();
      });
      window.eventBus.on('execution:progress', () => {
        this.workflowList?._debouncedLoadWorkflows?.() || this.workflowList?.loadWorkflows();
      });
      window.eventBus.on('execution:completed', async (data) => {
        // Record trial run usage AFTER workflow completes successfully (not error/stopped)
        if (!data?.error && !data?.stopped && window.featureGate) {
          await window.featureGate.recordPendingWorkflowRun();
        }
        this.workflowList?._debouncedLoadWorkflows?.() || this.workflowList?.loadWorkflows();
      });

      // Listen for workflow reset (can come from popup editor)
      window.eventBus.on('workflow:reset', () => {
        this.workflowList?._debouncedLoadWorkflows?.() || this.workflowList?.loadWorkflows();
      });

      // Re-apply feature gate khi entitlements được load/refresh
      window.eventBus.on('featuregate:refreshed', () => {
        this._applySubtabFeatureGate(this._currentSubtab);
      });

      // Listen for node completed to update list immediately
      window.eventBus.on('node:completed', () => {
        this.workflowList?._debouncedLoadWorkflows?.() || this.workflowList?.loadWorkflows();
      });

      // Listen for subtab switch (e.g., from template import)
      window.eventBus.on('workflow:subtab_changed', (data) => {
        const subtab = data?.subtab;
        if (subtab && subtab !== this._currentSubtab) {
          this._switchSubtab(subtab);
        }
      });

      // Listen for workflow imported (refresh list)
      window.eventBus.on('workflow:imported', () => {
        this.workflowList?.loadWorkflows();
      });
    }

    // Module-blocked-overlay được quản lý bởi app.js refreshModuleOverlays()

    // Auto-switch to 'workflows' subtab if user has existing workflows
    // Otherwise load templates subtab by default
    try {
      const hasWorkflows = await this._checkUserHasWorkflows();
      if (hasWorkflows) {
        console.log('[WorkflowTab] User has workflows, auto-switching to workflows subtab');
        this._switchSubtab('workflows');
      } else {
        // Load templates subtab by default (since templates is now the default active subtab)
        this._loadWorkflowTemplateList();
      }
    } catch (e) {
      console.warn('[WorkflowTab] Error checking workflows, defaulting to templates:', e?.message);
      this._loadWorkflowTemplateList();
    }

    this.isInitialized = true;
    console.log('[WorkflowTab] Initialized');
  }

  /**
   * Check if user has any existing workflows
   * @returns {Promise<boolean>}
   */
  async _checkUserHasWorkflows() {
    try {
      if (window.storageManager?.getWorkflows) {
        const result = await window.storageManager.getWorkflows({ limit: 1 });
        const workflows = result?.data || result || [];
        return workflows.length > 0;
      }
      return false;
    } catch (e) {
      console.warn('[WorkflowTab] _checkUserHasWorkflows error:', e?.message);
      return false;
    }
  }

  openEditor(mode = 'create', workflow = null) {
    // Open workflow editor in a separate window, truyền project context
    console.log('[WorkflowTab] openEditor called, mode:', mode, 'wfId:', workflow?.wf_id);
    chrome.runtime.sendMessage({
      action: 'openWorkflowEditor',
      data: {
        mode,
        workflow,
        projectId: window._currentProjectId || null,
        projectName: window._currentProjectName || null
      }
    }, (response) => {
      console.log('[WorkflowTab] openWorkflowEditor response:', response);
    });
  }

  async runWorkflow(workflow) {
    if (!workflow?.wf_id) return;

    // Check run limit for workflow (applies to both anonymous and logged-in users)
    if (window.featureGate) {
      const quota = await window.featureGate.checkQuotaAsync('workflows_run_max');
      if (!quota.allowed) {
        const isLoggedIn = window.authManager?.isLoggedIn();
        if (isLoggedIn) {
          const limitText = quota.limit === 'unlimited' ? (window.I18n?.t('common.unlimited') || 'Unlimited') : `${quota.limit} ${window.I18n?.t('workflow.runsPerDay') || 'runs/day'}`;
          const shouldUpgrade = await window.customDialog?.confirm(
            window.I18n?.t('workflow.runQuotaExhausted', { limitText, used: quota.used }) || `Workflow runs exhausted today.\n\nLimit: ${limitText}\nUsed: ${quota.used} runs\n\nUpgrade plan to increase limit.`,
            { title: window.I18n?.t('workflow.runQuotaTitle') || 'Workflow runs exhausted', confirmText: window.I18n?.t('common.upgrade') || 'Upgrade', cancelText: window.I18n?.t('common.later') || 'Later' }
          );
          if (shouldUpgrade) {
            if (typeof window.openUpgradeModal === 'function') {
              window.openUpgradeModal();
            }
          }
        } else {
          window.featureGate.showLoginPrompt(window.I18n?.t('workflow.trialRunExhausted') || 'You have used all workflow runs in trial.');
        }
        return;
      }

      // GP-6.3 / GP-6.4: Check global quota warning/exhausted
      const quotaCheck = window.featureGate.checkGlobalQuotaWarning('Workflow');
      if (quotaCheck.exhausted) {
        return; // Dialog đã hiển thị bởi FeatureGate
      }
    }

    // Check if already running (local executor)
    if (window.workflowExecutor?.isRunning) {
      window.customDialog.alert(window.I18n?.t('workflow.alreadyRunning') || 'Another workflow is currently running. Please wait or stop it first.', { type: 'warning' });
      return;
    }

    // Cross-context check: verify no workflow is running in popup editor.
    // Gap 2 fix: dùng helper TTL-aware (auto-clear nếu flag stale >30 phút).
    try {
      const running = await window.WorkflowExecutor?.getCrossContextRunning?.();
      if (running?.wf_id) {
        const runningName = running.wf_name || 'Workflow';
        window.customDialog.alert(
          window.I18n?.t('workflow.anotherRunningCrossContext', { name: runningName }) ||
          `"${runningName}" đang chạy ở cửa sổ khác. Vui lòng đợi hoặc dừng trước.`,
          { type: 'warning' }
        );
        return;
      }
    } catch (e) {
      console.warn('[WorkflowTab] Cross-context running check failed:', e.message);
    }

    // Kiểm tra có node nào đã completed chưa → hỏi resume hay chạy lại
    const fullWorkflow = await window.storageManager?.getWorkflow(workflow.wf_id);
    const hasCompleted = fullWorkflow?.nodes?.some(n => n.status === 'completed');

    if (hasCompleted) {
      const choice = await window.customDialog.confirm(
        window.I18n?.t('workflow.resumeOrRerun', { name: workflow.wf_name }) || `Workflow "${workflow.wf_name}" có node đã hoàn thành.\nBấm "Tiếp tục" để chạy từ node chưa xong, hoặc "Chạy lại" để reset.`,
        { title: window.I18n?.t('workflow.resumeOrRerunTitle') || 'Tiếp tục hay chạy lại?', confirmText: window.I18n?.t('common.continue') || 'Tiếp tục', cancelText: window.I18n?.t('workflow.rerun') || 'Chạy lại' }
      );
      if (!choice) {
        // Chạy lại từ đầu → reset
        await window.workflowExecutor.reset(workflow.wf_id);
      }
    }

    console.log('[WorkflowTab] Running workflow:', workflow.wf_id);

    // Set flag to record trial run AFTER workflow completes successfully
    if (window.featureGate) {
      window.featureGate.setPendingWorkflowRun();
    }

    try {
      const result = await window.workflowExecutor.execute(workflow.wf_id);
      // [Audit Bug 9 follow-up 2026-06-22] execute() return false khi pre-flight fail
      // (gate denied, plan fetch fail, ExecutionGate abort). Cần show toast để casual user
      // thấy ngay vì error chỉ ở log panel — không có alert.
      if (result === false) {
        console.warn('[WorkflowTab] Workflow execution aborted before start');
        const msg = window.I18n?.t('workflow.executionAborted')
          || 'Không thể khởi chạy workflow. Vui lòng kiểm tra log để biết chi tiết.';
        if (window.showNotification) {
          window.showNotification(msg, 'error');
        }
      }
    } catch (error) {
      console.error('[WorkflowTab] Workflow execution failed:', error);
      window.customDialog.alert((window.I18n?.t('workflow.executionError') || 'Lỗi khi chạy workflow') + ': ' + error.message, { type: 'error' });
    }
  }

  stopWorkflow() {
    if (window.workflowExecutor?.isRunning) {
      window.workflowExecutor.stop();
    }
  }

  destroy() {
    this.isInitialized = false;
  }

  /**
   * Render sub-tabs UI (Workflows / Templates)
   */
  _renderSubtabs() {
    const t = (key) => window.I18n?.t(key) || key;

    // Check if sub-tabs already exist
    if (this.container.querySelector('.tobyflow-workflow-subtabs')) {
      return;
    }

    // Get existing workflowListSection from DOM
    const existingSection = this.container.querySelector('#workflowListSection');

    // Create sub-tabs HTML (with icons matching prompts-subtab style)
    const subtabsHtml = `
      <div class="tobyflow-workflow-subtabs">
        <button class="tobyflow-workflow-subtab active" data-subtab="templates">
          <svg width="18" height="18" fill="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" data-testid="center-icon"><path d="M4.918 6.763c0-.943.764-1.707 1.707-1.707h2.463c.943 0 1.707.764 1.707 1.707v2.463c0 .943-.764 1.707-1.707 1.707H6.625a1.707 1.707 0 0 1-1.707-1.707zm1.708-.244a.244.244 0 0 0-.244.244v2.463c0 .135.109.244.244.244h2.463a.244.244 0 0 0 .244-.244V6.763a.244.244 0 0 0-.244-.244zm0 6.547c-.943 0-1.707.764-1.707 1.707v2.463c0 .943.764 1.707 1.707 1.707h2.463c.943 0 1.707-.764 1.707-1.707v-2.463c0-.943-.764-1.707-1.707-1.707zm-.244 1.708c0-.135.109-.244.244-.244h2.463c.135 0 .244.109.244.244v2.463a.244.244 0 0 1-.244.244H6.626a.244.244 0 0 1-.244-.244zm6.276-8.487c0-.404.328-.732.732-.732h4.878a.732.732 0 0 1 0 1.464H13.39a.73.73 0 0 1-.732-.732m.732 7.279a.732.732 0 0 0 0 1.464h4.878a.732.732 0 0 0 0-1.464zm-.732-3.864c0-.404.328-.732.732-.732h4.878a.732.732 0 0 1 0 1.464H13.39a.73.73 0 0 1-.732-.732m.732 7.279a.732.732 0 0 0 0 1.464h4.878a.732.732 0 0 0 0-1.464z"></path><path d="M2.004 6.634A4.634 4.634 0 0 1 6.638 2H17.37a4.634 4.634 0 0 1 4.634 4.634v10.732A4.634 4.634 0 0 1 17.37 22H6.638a4.634 4.634 0 0 1-4.634-4.634zm4.634-3.171a3.17 3.17 0 0 0-3.171 3.171v10.732a3.17 3.17 0 0 0 3.17 3.171H17.37a3.17 3.17 0 0 0 3.17-3.171V6.634a3.17 3.17 0 0 0-3.17-3.171z"></path></svg>
          <span>${t('workflow.subtabTemplates')}</span>
        </button>
        <button class="tobyflow-workflow-subtab" data-subtab="workflows">
          <svg fill="currentColor" width="14" height="14" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M7.5,15.5h-5a1,1,0,0,0-1,1v5a1,1,0,0,0,1,1h5a1,1,0,0,0,1-1V20H12a1,1,0,0,0,0-2H8.5V16.5A1,1,0,0,0,7.5,15.5Zm-1,5h-3v-3h3ZM4,8.858V13a1,1,0,0,0,2,0V8.858a4,4,0,1,0-2,0ZM5,3A2,2,0,1,1,3,5,2,2,0,0,1,5,3ZM20,15.142V12a1,1,0,0,0-2,0v3.142a4,4,0,1,0,2,0ZM19,21a2,2,0,1,1,2-2A2,2,0,0,1,19,21ZM16.5,8.5h5a1,1,0,0,0,1-1v-5a1,1,0,0,0-1-1h-5a1,1,0,0,0-1,1V4H12a1,1,0,0,0,0,2h3.5V7.5A1,1,0,0,0,16.5,8.5Zm1-5h3v3h-3Z"></path></svg>
          <span>${t('workflow.subtabWorkflows')}</span>
        </button>
        <button class="tobyflow-workflow-subtab" data-subtab="shared">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/>
            <polyline points="16 6 12 2 8 6"/>
            <line x1="12" y1="2" x2="12" y2="15"/>
          </svg>
          <span>${t('workflow.subtabShared')}</span>
          <span class="tobyflow-workflow-subtab-badge" data-shared-count style="display: none;">0</span>
        </button>
      </div>
      <div class="tobyflow-workflow-content" data-content="templates" style="display: flex; flex-direction: column; flex: 1; min-height: 0; overflow: hidden;">
        <!-- WorkflowTemplateList content - lazy loaded -->
      </div>
      <div class="tobyflow-workflow-content" data-content="workflows" style="display: none; flex-direction: column; flex: 1; min-height: 0; overflow: hidden;">
        <!-- WorkflowList content will be moved here -->
      </div>
      <div class="tobyflow-workflow-content" data-content="shared" style="display: none; flex-direction: column; flex: 1; min-height: 0; overflow: hidden;">
        <!-- Shared workflows list — render bởi WorkflowList.renderSharedTab() -->
      </div>
    `;

    // Insert at the beginning of the container
    this.container.insertAdjacentHTML('afterbegin', subtabsHtml);

    // Move existing workflowListSection into the workflows content container
    if (existingSection) {
      const workflowsContent = this.container.querySelector('[data-content="workflows"]');
      if (workflowsContent) {
        workflowsContent.appendChild(existingSection);
      }
    }
  }

  /**
   * Bind click events for sub-tab buttons
   */
  _bindSubtabEvents() {
    const subtabBtns = this.container.querySelectorAll('.tobyflow-workflow-subtab');
    subtabBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const subtab = btn.dataset.subtab;
        if (!subtab) return;

        if (subtab === this._currentSubtab) {
          // Click on current tab → refresh data only
          this._refreshCurrentSubtab(subtab);
        } else {
          // Click on different tab → switch tab (which also loads data)
          this._switchSubtab(subtab);
        }
      });
    });
  }

  /**
   * Refresh data của current subtab khi click lại vào tab đang active
   * @param {string} subtab - 'workflows', 'templates', or 'shared'
   */
  _refreshCurrentSubtab(subtab) {
    console.log('[WorkflowTab] Refreshing current subtab:', subtab);

    // Check feature gate trước khi refresh
    const blocked = this._applySubtabFeatureGate(subtab);
    if (blocked) return;

    if (subtab === 'workflows') {
      // 2026-05-25: Dùng _debouncedLoadWorkflows để coalesce rapid tab switch.
      // Trước fix: user toggle templates/workflows nhanh → mỗi switch fire loadWorkflows ngay → 4-5 API call dư thừa.
      // Sau fix: 1s debounce coalesce thành 1 call sau khi user dừng switch.
      (this.workflowList?._debouncedLoadWorkflows?.() || this.workflowList?.loadWorkflows?.());
    } else if (subtab === 'templates') {
      this.workflowTemplateList?.loadTemplates?.();
    } else if (subtab === 'shared') {
      this.workflowList?.loadSharedWorkflows?.();
    }
  }

  /**
   * Switch between Workflows and Templates sub-tabs
   * @param {string} subtab - 'workflows' or 'templates'
   */
  _switchSubtab(subtab) {
    console.log('[WorkflowTab] Switching to subtab:', subtab);

    // Toggle active class on buttons
    const subtabBtns = this.container.querySelectorAll('.tobyflow-workflow-subtab');
    subtabBtns.forEach(btn => {
      btn.classList.toggle('active', btn.dataset.subtab === subtab);
    });

    // Toggle display on content containers
    const contentPanes = this.container.querySelectorAll('.tobyflow-workflow-content');
    contentPanes.forEach(pane => {
      const isActive = pane.dataset.content === subtab;
      pane.style.display = isActive ? 'flex' : 'none';
      if (isActive) {
        pane.style.flexDirection = 'column';
        pane.style.flex = '1';
        pane.style.minHeight = '0';
        pane.style.overflow = 'hidden';
      }
    });

    this._currentSubtab = subtab;

    // Emit event for other components to react
    if (window.eventBus) {
      window.eventBus.emit('workflow:subtab_changed', { subtab });
    }

    // Apply feature gate cho sub-tab — render overlay nếu user không có quyền.
    // Nếu blocked → KHÔNG load data (tránh gọi API thừa).
    const blocked = this._applySubtabFeatureGate(subtab);
    if (blocked) return;

    // Reload data của tab tương ứng mỗi lần switch để đảm bảo data mới nhất
    if (subtab === 'workflows') {
      this.workflowList?.loadWorkflows?.();
    } else if (subtab === 'templates') {
      // Lazy load lần đầu, sau đó reload mỗi lần switch
      if (!this.workflowTemplateList) {
        this._loadWorkflowTemplateList();
      } else {
        this.workflowTemplateList._loadTemplates?.(false);
      }
    } else if (subtab === 'shared') {
      const sharedContent = this.container.querySelector('[data-content="shared"]');
      if (sharedContent && this.workflowList) {
        // Show skeleton while loading
        this.workflowList.showSharedLoadingSkeleton(sharedContent);
        this.workflowList.loadSharedWorkflows().then(() => {
          this.workflowList.renderSharedTab(sharedContent);
        });
      }
    }
  }

  /**
   * Render overlay block tab nếu user không có quyền sub-tab tương ứng.
   * Map:
   *   - tab "workflows" + "shared" → workflows_enabled
   *   - tab "templates" → workflow_templates_enabled
   *
   * Guest → overlay với button Login.
   * Logged-in plan thấp → overlay với button Upgrade.
   *
   * @param {string} subtab
   * @returns {boolean} true nếu đã render overlay (sub-tab bị block)
   */
  _applySubtabFeatureGate(subtab) {
    const featureKey = (subtab === 'templates')
      ? 'workflow_templates_enabled'
      : 'workflows_enabled';
    const fg = window.featureGate;
    const pane = this.container.querySelector(`[data-content="${subtab}"]`);
    if (!pane) return false;

    // Xóa overlay cũ nếu có
    const oldOverlay = pane.querySelector('.wf-subtab-blocked-overlay');
    if (oldOverlay) oldOverlay.remove();

    if (!fg || fg.canUse(featureKey)) {
      pane.classList.remove('wf-subtab-blocked');
      return false; // allowed
    }

    // Render overlay
    const isLoggedIn = !!window.authManager?.isLoggedIn?.();
    const t = (key, fallback) => window.I18n?.t(key) || fallback;

    const moduleNameMap = {
      workflows_enabled: t('workflow.title', 'Workflow'),
      workflow_templates_enabled: t('workflow.subtabTemplates', 'Templates'),
    };
    const moduleName = moduleNameMap[featureKey] || 'Tính năng';

    const title = isLoggedIn
      ? t('featuregate.featureLockedTitle', 'Tính năng bị khóa')
      : t('featuregate.loginRequiredTitle', 'Yêu cầu đăng nhập');

    const message = isLoggedIn
      ? t('featuregate.featureLockedPaid', `Gói hiện tại của bạn không bao gồm ${moduleName}. Vui lòng nâng cấp để sử dụng.`)
          .replace('{module}', moduleName)
      : t('featuregate.loginRequiredFeature', `Tính năng ${moduleName} yêu cầu đăng nhập.`)
          .replace('{module}', moduleName);

    const ctaLabel = isLoggedIn
      ? t('common.upgrade', 'Nâng cấp')
      : t('auth.login', 'Đăng nhập');

    pane.classList.add('wf-subtab-blocked');
    const ctaBtnClass = isLoggedIn ? 'wf-subtab-blocked-cta wf-subtab-blocked-cta--upgrade' : 'wf-subtab-blocked-cta';
    const overlayHtml = `
      <div class="wf-subtab-blocked-overlay">
        <div class="wf-subtab-blocked-card">
          <svg class="wf-subtab-blocked-icon" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
            <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
          </svg>
          <h3 class="wf-subtab-blocked-title">${this._escapeHtml(title)}</h3>
          <p class="wf-subtab-blocked-msg">${this._escapeHtml(message)}</p>
          <button class="${ctaBtnClass}" data-action="${isLoggedIn ? 'upgrade' : 'login'}">
            ${this._escapeHtml(ctaLabel)}
          </button>
        </div>
      </div>
    `;
    pane.insertAdjacentHTML('afterbegin', overlayHtml);

    // Bind CTA click
    const ctaBtn = pane.querySelector('.wf-subtab-blocked-cta');
    ctaBtn?.addEventListener('click', () => {
      if (isLoggedIn) {
        if (typeof window.openUpgradeModal === 'function') {
          window.openUpgradeModal();
        } else {
          try { chrome.runtime.sendMessage({ action: 'showUpgradeModal' }); } catch (e) {}
        }
      } else {
        const loginOverlay = document.getElementById('loginOverlay');
        if (loginOverlay) loginOverlay.classList.remove('hidden');
      }
    });

    return true; // blocked
  }

  _escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = String(str ?? '');
    return div.innerHTML;
  }

  /**
   * Lazy load WorkflowTemplateList component
   */
  _loadWorkflowTemplateList() {
    const templatesContent = this.container.querySelector('[data-content="templates"]');
    if (!templatesContent) return;

    // Check if WorkflowTemplateList class exists (sẽ được implement sau)
    if (typeof window.WorkflowTemplateList === 'function') {
      this.workflowTemplateList = new window.WorkflowTemplateList(templatesContent);
      window.workflowTemplateList = this.workflowTemplateList;
      console.log('[WorkflowTab] WorkflowTemplateList loaded');
    } else {
      // Placeholder message when WorkflowTemplateList is not yet implemented
      templatesContent.innerHTML = `
        <div class="workflow-empty-state">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="3" width="7" height="7" rx="1"/>
            <rect x="14" y="3" width="7" height="7" rx="1"/>
            <rect x="3" y="14" width="7" height="7" rx="1"/>
            <rect x="14" y="14" width="7" height="7" rx="1"/>
          </svg>
          <p>${window.I18n?.t('workflow.templatesComingSoon') || 'Workflow Templates sẽ sớm ra mắt'}</p>
        </div>
      `;
    }
  }
}

// Export
window.WorkflowTab = WorkflowTab;
