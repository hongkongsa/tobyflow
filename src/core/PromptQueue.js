/**
 * PromptQueue — Bộ điều phối hàng đợi thống nhất
 * Singleton quản lý Jobs + QueueItems + 2 Executors (Editor, Tile)
 * Download đi qua cùng serial queue với submit (Unified Queue Architecture)
 * Cho phép nhiều nguồn (GenTab, Tasks, Workflow, Angles, Telegram) xen kẽ prompts
 * trong cùng 1 pipeline mà không block nhau
 */
class PromptQueue {
  static _instance = null;

  /** Lấy instance singleton */
  static getInstance() {
    if (!this._instance) {
      this._instance = new PromptQueue();
    }
    return this._instance;
  }

  /** Kiểm tra Pipeline Queue có được bật không */
  static isEnabled() {
    // Check feature gate trước — nếu không có quyền, luôn trả về false
    if (window.featureGate && !window.featureGate.canUse('pipeline_queue_enabled')) {
      return false;
    }
    const settings = window.storageSettings?.getSettings?.();
    return settings?.queueEnabled === true || settings?.queueEnabled === '1' || settings?.queueEnabled === 1;
  }

  constructor() {
    this._jobs = new Map();         // jobId → Job
    this._itemQueue = [];           // QueueItem[] — hàng đợi chính, sắp xếp theo priority
    this._isRunning = false;
    this._startedAt = null;

    // Per-task serialize queue cho _persistTaskResult (tránh race condition read-modify-write)
    this._persistQueues = new Map(); // taskId → Promise chain

    // Unified download queue — cùng serial pipeline với submit
    this._downloadQueue = [];       // [{ tileId, fileName, promptText, jobId, flowFileId, resolution }]
    this._downloadedTileIds = new Set();  // Dedup: tiles đã download
    this._downloadCompletedCount = 0;
    this._downloadHistory = [];          // Completed/failed download records (cho UI)
    this._currentDownloadItem = null;    // Download đang chạy (cho UI)

    // 2 executors (download đi qua EditorExecutor serial queue)
    this._editorExecutor = new EditorExecutor();
    this._tileMonitor = new TileMonitor();

    // Kết nối executors
    this._editorExecutor.setup({
      queue: this,
      onItemSubmitted: (item) => this._onItemSubmitted(item),
      onItemCompleted: (item) => this._onItemCompleted(item),
      onRunLoopFinished: () => this._onRunLoopFinished(),
      hasActiveMonitoring: () => this._tileMonitor.activeCount > 0,
    });

    this._tileMonitor.setup({
      queue: this,
      onItemCompleted: (item) => this._onItemCompleted(item),
      onTilesReady: (item, tileIds) => this._onTilesReady(item, tileIds),
    });

    // Lắng nghe event dừng toàn bộ
    window.eventBus?.on('queue:stop_all', () => this.stopAll());

    // Lắng nghe per-job control từ FloatingTracker (qua background.js relay)
    window.eventBus?.on('queue:stop_job', (data) => this.stopJob(data.jobId));
    window.eventBus?.on('queue:pause_job', (data) => this.pauseJob(data.jobId));
    window.eventBus?.on('queue:resume_job', (data) => this.resumeJob(data.jobId));

    // Phase FAR-4 (Rate-limit toast listener) đã REMOVED — xem comment content.js cuối file.
    // Recovery rate-limit dựa vào FAR-2 consecutive fail tracker + FAR-5 exponential backoff.

    // Auto-reload counter: đếm số prompts đã submit, reload Flow tab sau N prompts
    this._reloadPromptCounter = 0;
    // Suppress auto-reload khi multi-step callers (workflow, angles) đang chạy
    // Workflow submit nodes tuần tự → giữa các nodes queue rỗng nhưng workflow chưa xong
    this._reloadSuppressCount = 0;
    // Dedup force reload (TileMonitor Tier 2): nếu nhiều monitor cùng trigger,
    // chỉ thực thi 1 reload — các monitor khác await cùng promise
    this._forceReloadPromise = null;

    // Throttle emit event để tránh UI jank
    this._lastEmitTime = 0;
    this._emitScheduled = false;

    // Throttle broadcast để giảm số lần gửi đến contexts khác
    this._broadcastThrottleTimer = null;
    this._pendingSnapshot = null;
  }

  // ================================================================
  // API CHO CALLERS
  // ================================================================

  /**
   * Gửi 1 job mới vào pipeline
   * @param {Object} request - Thông tin job
   * @param {string} request.owner - 'prompts' | 'task' | 'workflow' | 'angles' | 'telegram'
   * @param {string} request.label - Tên hiển thị (VD: "Auto Gen", "Task: Tạo ảnh SP")
   * @param {string[]} request.prompts - Danh sách prompt texts
   * @param {Object} request.settings - { genType, ratio, model, isFrames, quantity }
   * @param {string[]} [request.refFileIds] - Ref images cho tất cả prompts
   * @param {string} [request.refImageMode] - 'all' | 'mention' | 'sequential' | 'none'
   * @param {Array} [request.mentionData] - @mention data per prompt
   * @param {Array} [request.refFileIdsPerPrompt] - Ref images riêng cho từng prompt
   * @param {boolean} [request.autoDownload] - Override auto-download (undefined = đọc từ DOM toggle)
   * @returns {Promise<{completed: number, failed: number, stopped: boolean}>}
   */
  async submitJob(request) {
    const { owner, label, prompts, settings, refFileIds, refFileNames, refImageMode,
            mentionData, refFileIdsPerPrompt, autoDownload, taskId, downloadResolution,
            videoDownloadResolution, sequentialMode, voice } = request;

    // Sequential mode flag được lưu per-job (không global) để tránh conflict
    // khi multiple jobs từ GenTab/Task/Workflow submit đồng thời với mode khác nhau.
    // EditorExecutor sẽ đọc từ job.sequentialMode thay vì PromptQueue._sequentialMode.
    const jobSequentialMode = sequentialMode !== undefined ? !!sequentialMode : false;

    // ExecutionGate: reuse token từ caller nếu đã pass, không request lại
    const ownerActionMap = { prompts: 'generate', task: 'task_run', workflow: 'workflow_run', angles: 'angles_run', effects: 'effects_run' };
    let executionToken = request._executionToken || null;
    if (!executionToken && window.ExecutionGate) {
      try {
        const action = ownerActionMap[owner] || 'generate';
        const gate = await ExecutionGate.request(action, prompts.length, { owner, label });
        if (!gate.allowed) {
          // Hien dialog thong bao cho user (tru Telegram — khong co UI)
          if (owner !== 'telegram') {
            const moduleNames = { prompts: 'Generate', task: 'Task', workflow: 'Workflow', angles: 'Angles', effects: 'Effects' };
            ExecutionGate.showDeniedDialog(gate, moduleNames[owner] || '');
          }
          return { completed: 0, failed: prompts.length, stopped: false, reason: gate.reason };
        }
        executionToken = gate.token;
      } catch (e) {
        if (window.QuotaErrorHandler?.isQuotaError(e)) {
          console.warn('[PromptQueue] ExecutionGate denied:', e.code || e.reason);
          if (owner !== 'telegram') {
            const moduleNames = { prompts: 'Generate', task: 'Task', workflow: 'Workflow', angles: 'Angles', effects: 'Effects' };
            window.QuotaErrorHandler.showDialog(e, moduleNames[owner] || '');
          }
          return { completed: 0, failed: prompts.length, stopped: false, reason: e.code || e.reason };
        }
        console.warn('[PromptQueue] ExecutionGate request failed, proceeding:', e.message);
      }
    }

    // CRITICAL: Ensure Flow tab active để tránh Chrome throttle inactive tabs
    // Throttle làm DOM không update → detectTileStatus() trả sai → retry vô ích
    await this._ensureFlowTabActive();

    // Xóa jobs cũ đã hoàn thành/dừng trước khi thêm job mới (tránh append history)
    this._clearCompletedJobs();

    // Clear retry tracking trong content.js khi job mới bắt đầu
    // Ngăn tiles từ job cũ bị skip retry trong job mới
    MessageBridge.sendToContentScript('pq:clearRetryTracking').catch(() => {});

    const job = new Job({
      owner,
      label,
    });
    job._executionToken = executionToken;
    job.settings = settings ? { ...settings } : null;
    job.totalExpected = prompts.length;
    job.sequentialMode = jobSequentialMode;  // Per-job sequential mode
    // Cache autoDownload lúc submit — cho phép caller override, fallback đọc từ DOM toggle
    // Workflow/Angles có node Download riêng nên truyền autoDownload: false
    job._autoDownload = autoDownload !== undefined ? autoDownload : this._readAutoDownload();
    this._jobs.set(job.id, job);

    // Tạo QueueItems từ danh sách prompts
    for (let i = 0; i < prompts.length; i++) {
      // Merge voice payload vào settings để EditorExecutor đọc được (settings.voice)
      const itemSettings = settings ? { ...settings } : {};
      if (voice && voice.search_value) {
        itemSettings.voice = voice;
      }
      const item = new QueueItem({
        jobId: job.id,
        prompt: prompts[i],
        promptIndex: i,
        settings: Object.keys(itemSettings).length ? itemSettings : null,
        refFileIds: this._resolveRefForIndex(refFileIds, refFileIdsPerPrompt, refImageMode, i),
        refFileNames: refFileNames || {},
        refImageMode: refImageMode || 'none',
        mentionData: mentionData?.[i] || null,
      });
      // Support single task via submitJob (không qua submitTaskBatch)
      if (taskId) {
        item._taskId = taskId;
        item._autoDownload = autoDownload;
      }
      // Resolution forward cho mọi caller (workflow, gen, task, angles, effects).
      // Trước fix: chỉ set trong taskId branch → workflow video pipeline mất video_download_resolution
      // → fallback DOM settings cũ → bug 1080p config nhưng download 720p.
      // Caller truyền null/undefined → giữ null → _onTilesReady fallback DOM hoặc default ('1k'/'720p').
      if (downloadResolution !== undefined) {
        item._downloadResolution = downloadResolution || null;
      }
      if (videoDownloadResolution !== undefined) {
        item._videoDownloadResolution = videoDownloadResolution || null;
      }
      // taskName cho subfolder download (task_name, 'angles', 'effects', workflow name, etc.)
      if (request.taskName) {
        item._taskName = request.taskName;
      }
      job.items.push(item);
      this._itemQueue.push(item);
    }

    this._sortQueue();
    // K.15 (2026-05-29): Force load ExecutionConfig + re-read settings TRƯỚC khi start.
    // Trước fix: `_readSettings` chỉ chạy 1 lần ở `_ensureRunning` khi queue lần đầu khởi
    // động → nếu ExecutionConfig cache CHƯA load (race với background fetch) →
    // `safeGetQueueConfig` trả `{}` → fallback default queue_max_monitor=4 vĩnh viễn cho
    // session, dù admin set 8 trên server. Cache load xong (vài giây sau) cũng không
    // trigger re-read → user setting bị ignore.
    //
    // Mitigate cold start race: await ExecutionConfig.getConfig() để FORCE fetch nếu cache
    // empty. Sau đó re-read settings đảm bảo cap chính xác từ server. Best-effort —
    // không block submit nếu fetch fail (fallback default).
    try { await window.ExecutionConfig?.getConfig?.(); } catch (_) { /* ignore */ }
    this._readSettings();
    this._ensureRunning();
    this._emitStateChanged();

    // Trả về Promise resolve khi job hoàn tất hoặc bị dừng
    return new Promise(resolve => { job._resolve = resolve; });
  }

  /**
   * Chạy hàng loạt Tasks (Run All Tasks)
   * Lazy enqueue: task N+1 chỉ được đưa vào khi task N hoàn thành (sequential)
   * @param {Array} tasks - Danh sách task objects
   * @param {string} mode - 'sequential' | 'parallel'
   * @param {Array} settingsPerTask - Settings riêng cho từng task
   * @returns {Promise<{completed: number, failed: number, stopped: boolean}>}
   */
  async submitTaskBatch(tasks, mode, settingsPerTask, options = {}) {
    // ExecutionGate: reuse token từ caller nếu đã pass, không request lại
    let executionToken = options._executionToken || null;
    if (!executionToken && window.ExecutionGate) {
      try {
        const totalPrompts = tasks.reduce((sum, t) =>
          sum + ((t.prompts?.length > 1) ? t.prompts.length : 1), 0);
        // Bug fix 2026-05-22: pass provider nếu batch đồng nhất 1 provider.
        const _uniqProviders = new Set(tasks.map(t => t.provider || 'flow'));
        const _batchProvider = _uniqProviders.size === 1 ? [..._uniqProviders][0] : null;
        const gate = await ExecutionGate.request('task_run', totalPrompts, { owner: 'task', label: 'Task batch', provider: _batchProvider });
        if (!gate.allowed) {
          ExecutionGate.showDeniedDialog(gate, 'Task');
          return { completed: 0, failed: totalPrompts, stopped: false, reason: gate.reason };
        }
        executionToken = gate.token;
      } catch (e) {
        if (window.QuotaErrorHandler?.handleIfQuotaError(e, 'Task')) {
          console.warn('[PromptQueue] ExecutionGate batch denied:', e.code || e.reason);
          const totalPrompts = tasks.reduce((sum, t) => sum + ((t.prompts?.length > 1) ? t.prompts.length : 1), 0);
          return { completed: 0, failed: totalPrompts, stopped: false, reason: e.code || e.reason };
        }
        console.warn('[PromptQueue] ExecutionGate batch request failed, proceeding:', e.message);
      }
    }

    // CRITICAL: Ensure Flow tab active để tránh Chrome throttle inactive tabs
    // Throttle làm DOM không update → detectTileStatus() trả sai → retry vô ích
    await this._ensureFlowTabActive();

    // Xóa jobs cũ đã hoàn thành/dừng trước khi thêm job mới (tránh append history)
    this._clearCompletedJobs();

    // Clear retry tracking trong content.js khi job mới bắt đầu
    // Ngăn tiles từ job cũ bị skip retry trong job mới
    MessageBridge.sendToContentScript('pq:clearRetryTracking').catch(() => {});

    const job = new Job({
      owner: 'task',
      label: 'Run All Tasks',
    });
    job._executionToken = executionToken;
    job.taskBatch = { tasks, currentIdx: 0, mode, settingsPerTask };
    job.totalExpected = tasks.reduce((sum, t) =>
      sum + ((t.prompts?.length > 1) ? t.prompts.length : 1), 0);
    job.sequentialMode = false;  // Task batch always parallel monitor (per-prompt wait not needed)
    // Cache autoDownload lúc submit
    job._autoDownload = this._readAutoDownload();
    this._jobs.set(job.id, job);

    if (mode === 'sequential') {
      // Chỉ enqueue task đầu tiên, task tiếp theo khi task hiện tại xong
      this._enqueueTaskItems(job, 0);
    } else {
      // Enqueue tất cả tasks ngay
      for (let i = 0; i < tasks.length; i++) {
        this._enqueueTaskItems(job, i);
      }
    }

    this._sortQueue();
    this._readSettings(); // K.15: re-read fresh từ ExecutionConfig (same as submitJob)
    this._ensureRunning();
    this._emitStateChanged();

    return new Promise(resolve => { job._resolve = resolve; });
  }

  // ================================================================
  // ĐIỀU KHIỂN PER-JOB
  // ================================================================

  /** Dừng 1 job cụ thể */
  stopJob(jobId) {
    const job = this._jobs.get(jobId);
    if (!job || job.isDone) return;

    job.state = 'stopped';

    // ExecutionGate: cancel token khi job bị dừng
    if (window.ExecutionGate && job._executionToken) {
      ExecutionGate.cancel(job._executionToken);
      job._executionToken = null;
    }

    // Xóa items chưa xử lý khỏi hàng đợi
    this._itemQueue = this._itemQueue.filter(i => i.jobId !== jobId);

    // Cancel item đang được EditorExecutor xử lý (nếu thuộc job này)
    const currentItem = this._editorExecutor.currentItem;
    if (currentItem && currentItem.jobId === jobId) {
      currentItem.state = QueueItem.STATE.CANCELLED;
      // Signal EditorExecutor to abort current processing
      // _shouldAbortItem() sẽ detect job.state='stopped' tại abort points,
      // nhưng cần stop() để thoát _sleep() trong _runLoop sớm hơn
      this._editorExecutor.stop();
      // Khởi động lại EditorExecutor cho các jobs khác (nếu còn items)
      // start() sẽ reset _shouldStop=false trước khi chạy _runLoop
      if (this.hasItems()) {
        this._editorExecutor.start();
      }
    }

    // Hủy tiles đang theo dõi
    this._tileMonitor.abortJob(jobId);

    // Xóa downloads chưa xử lý thuộc job này
    this._downloadQueue = this._downloadQueue.filter(d => d.jobId !== jobId);

    // Resolve promise cho caller (guard chống gọi 2 lần)
    if (!job._resolved) {
      job._resolved = true;
      // Collect partial results (workflow cần biết kết quả đã có)
      const allResultTileIds = [];
      const allResultThumbnails = {};
      const failedPrompts = [];
      for (const item of job.items) {
        if (item.resultTileIds?.length > 0) {
          allResultTileIds.push(...item.resultTileIds);
          Object.assign(allResultThumbnails, item.resultThumbnails || {});
        }
        // Collect failed prompts (có error hoặc không có results)
        if (item.error || (item.isTerminal && (!item.resultTileIds || item.resultTileIds.length === 0))) {
          failedPrompts.push({
            index: item.promptIndex,
            prompt: item.prompt,
            error: item.error || 'Stopped by user',
            timestamp: item.completedAt || Date.now(),
          });
        }
      }
      job._resolve?.({
        completed: job.completedCount,
        failed: job.failedCount,
        stopped: true,
        resultTileIds: allResultTileIds,
        resultThumbnails: allResultThumbnails,
        failedPrompts: failedPrompts.length > 0 ? failedPrompts : [],
      });
      job._resolve = null;
    }

    this._emitStateChanged();
    this._checkAllDone();
  }

  /** Tạm dừng 1 job (chỉ hỗ trợ cho prompts owner) */
  pauseJob(jobId) {
    const job = this._jobs.get(jobId);
    if (!job || job.state !== 'running') return;
    // Chỉ GenTab hỗ trợ pause (các owner khác không có cơ chế resume phía UI)
    if (job.owner !== 'prompts') return;

    job.state = 'paused';

    // Đồng bộ pause với EditorExecutor (để _runLoop chờ)
    this._editorExecutor.pause();

    // Đồng bộ pause với content.js (legacy pauseExecution flag)
    if (window.MessageBridge) {
      MessageBridge.sendToContentScript('pq:pauseExecution', { paused: true }).catch(() => {});
    }

    this._emitStateChanged();
  }

  /** Tiếp tục 1 job đã tạm dừng */
  resumeJob(jobId) {
    const job = this._jobs.get(jobId);
    if (!job || job.state !== 'paused') return;

    job.state = 'running';

    // Đồng bộ resume với EditorExecutor
    this._editorExecutor.resume();

    // Đồng bộ resume với content.js
    if (window.MessageBridge) {
      MessageBridge.sendToContentScript('pq:pauseExecution', { paused: false }).catch(() => {});
    }

    this._ensureRunning(); // Khởi động lại EditorExecutor nếu đang idle
    this._emitStateChanged();
  }

  /** Dừng toàn bộ pipeline + external providers */
  stopAll() {
    console.log('[PromptQueue] stopAll called, stopping all jobs...');

    for (const [id] of this._jobs) {
      this.stopJob(id);
    }
    this._editorExecutor.stop();
    this._tileMonitor.stopAll();
    this._downloadQueue = [];
    this._isRunning = false;
    this._reloadPromptCounter = 0;
    this._reloadSuppressCount = 0;
    ExecutionLock.release('queue');

    // Set global stop flags
    window._taskShouldStop = true;
    window._taskBatchStopped = true;

    // Stop workflow executor nếu đang chạy
    if (window.workflowExecutor?.isRunning) {
      window.workflowExecutor.shouldStop = true;
      window.workflowExecutor.isRunning = false;
    }

    // Abort Grok session
    if (window.GrokSession?.getTabInfo) {
      window.GrokSession.getTabInfo().then(grokInfo => {
        if (grokInfo?.tabId && window.MessageBridge) {
          window.MessageBridge.grokAbort(grokInfo.tabId).catch(() => {});
        }
      }).catch(() => {});
    }

    // Abort ChatGPT session
    if (window.ChatGPTSession?.getTabInfo) {
      window.ChatGPTSession.getTabInfo().then(chatgptInfo => {
        if (chatgptInfo?.tabId && window.MessageBridge) {
          window.MessageBridge.chatgptAbort(chatgptInfo.tabId).catch(() => {});
        }
      }).catch(() => {});
    }

    // Hide ExecutionBlocker khi pipeline bị stop
    if (window.MessageBridge) {
      MessageBridge.sendToContentScript('pq:hideBlocker', {}).catch(() => {});
      // Also send stop to Flow content script
      MessageBridge.stopExecution().catch(() => {});
    }

    this._emitStateChanged();

    // Emit event
    window.eventBus?.emit('execution:force_stopped');
  }

  /**
   * Chờ đến khi download queue empty và EditorExecutor không đang download
   * Dùng cho workflow để đảm bảo không có downloads đang chạy trước khi submit node tiếp theo
   * @param {number} timeoutMs - Timeout tối đa (mặc định 60s)
   * @returns {Promise<boolean>} - true nếu downloads đã xong, false nếu timeout
   */
  async waitForDownloadsEmpty(timeoutMs = 60000) {
    const startTime = Date.now();
    let loggedOnce = false;
    while (Date.now() - startTime < timeoutMs) {
      // Check: download queue empty AND EditorExecutor không đang download
      const isDownloadQueueEmpty = this._downloadQueue.length === 0;
      const isNotDownloading = !this._editorExecutor?.isDownloading;

      if (!loggedOnce) {
        console.log('[PromptQueue] waitForDownloadsEmpty check:', {
          queueLength: this._downloadQueue.length,
          isDownloading: this._editorExecutor?.isDownloading,
          editorExecutorExists: !!this._editorExecutor,
        });
        loggedOnce = true;
      }

      if (isDownloadQueueEmpty && isNotDownloading) {
        return true;
      }

      await new Promise(r => setTimeout(r, 200));
    }
    console.warn('[PromptQueue] waitForDownloadsEmpty timeout after', timeoutMs, 'ms', {
      queueLength: this._downloadQueue.length,
      isDownloading: this._editorExecutor?.isDownloading,
    });
    return false;
  }

  /**
   * Suppress auto-reload — gọi khi multi-step caller (workflow) bắt đầu.
   * Workflow submit nodes tuần tự: giữa các nodes, queue rỗng nhưng workflow chưa xong.
   * Nếu reload lúc đó, tiles node trước mất → node sau fail.
   */
  suppressReload() {
    this._reloadSuppressCount++;
  }

  /**
   * Unsuppress auto-reload — gọi khi multi-step caller kết thúc.
   */
  unsuppressReload() {
    this._reloadSuppressCount = Math.max(0, this._reloadSuppressCount - 1);
  }

  // ================================================================
  // QUEUE MANAGEMENT (cho EditorExecutor gọi)
  // ================================================================

  /** Lấy item tiếp theo từ hàng đợi (priority cao trước, rồi FIFO) */
  dequeueNext() {
    if (this._itemQueue.length === 0) return null;

    // Tìm item priority cao nhất mà job vẫn đang active
    for (let i = 0; i < this._itemQueue.length; i++) {
      const item = this._itemQueue[i];
      const job = this._jobs.get(item.jobId);

      // Bỏ qua items của jobs đã dừng
      if (!job || job.state === 'stopped') {
        item.state = QueueItem.STATE.CANCELLED;
        this._itemQueue.splice(i, 1);
        i--;
        continue;
      }

      // Bỏ qua items của jobs đang tạm dừng (giữ lại trong queue)
      if (job.state === 'paused') continue;

      // Lấy item này
      this._itemQueue.splice(i, 1);
      return item;
    }

    return null;
  }

  /** Đưa item trở lại hàng đợi (retry) */
  enqueue(item) {
    this._itemQueue.push(item);
    this._sortQueue();
    this._ensureRunning();
  }

  /** Kiểm tra hàng đợi còn items không (submit + download) */
  hasItems() {
    // Kiểm tra có submit items nào thuộc job đang active không
    const hasSubmitItems = this._itemQueue.some(item => {
      const job = this._jobs.get(item.jobId);
      return job && (job.state === 'running' || job.state === 'paused');
    });
    if (hasSubmitItems) return true;

    // Kiểm tra download queue
    return this._downloadQueue.some(d => {
      const job = this._jobs.get(d.jobId);
      return job && (job.state === 'running' || job.state === 'paused');
    });
  }

  /** Lấy Job object theo ID */
  getJob(jobId) {
    return this._jobs.get(jobId) || null;
  }

  /** Lấy download item tiếp theo từ unified download queue */
  dequeueNextDownload() {
    while (this._downloadQueue.length > 0) {
      const dlItem = this._downloadQueue.shift();

      // Bỏ qua nếu job đã dừng
      const job = this._jobs.get(dlItem.jobId);
      if (!job || job.state === 'stopped') continue;

      // Bỏ qua nếu đã download rồi (dedup)
      if (this._downloadedTileIds.has(dlItem.tileId)) continue;

      return dlItem;
    }
    return null;
  }

  /** Đánh dấu tile đã download xong (dedup) */
  markDownloadCompleted(tileId) {
    this._downloadedTileIds.add(tileId);
    this._downloadCompletedCount++;
    // Track cho UI
    const dlItem = this._currentDownloadItem;
    let jobToCheck = null;
    if (dlItem && dlItem.tileId === tileId) {
      this._downloadHistory.push({ ...dlItem, state: 'COMPLETED', completedAt: Date.now() });
      this._currentDownloadItem = null;
      jobToCheck = this._jobs.get(dlItem.jobId);
    } else {
      // Fallback: _currentDownloadItem không match (race condition hoặc bug)
      // Tìm job bất kỳ đang active để check completion
      console.warn(`[PromptQueue] markDownloadCompleted: _currentDownloadItem mismatch for tile ${tileId?.substring(0, 8)}`);
      for (const job of this._jobs.values()) {
        if (job.isActive) {
          jobToCheck = job;
          break;
        }
      }
    }
    // Re-check job completion (downloads might have been blocking it)
    if (jobToCheck) this._checkJobDone(jobToCheck);
    this._emitStateChanged();
  }

  /** Đánh dấu download item thất bại */
  markDownloadFailed(tileId, error) {
    const dlItem = this._currentDownloadItem;
    let jobToCheck = null;
    if (dlItem && dlItem.tileId === tileId) {
      this._downloadHistory.push({ ...dlItem, state: 'FAILED', error, completedAt: Date.now() });
      this._currentDownloadItem = null;
      jobToCheck = this._jobs.get(dlItem.jobId);
    } else {
      // Fallback: tìm job active để check completion
      console.warn(`[PromptQueue] markDownloadFailed: _currentDownloadItem mismatch for tile ${tileId?.substring(0, 8)}`);
      for (const job of this._jobs.values()) {
        if (job.isActive) {
          jobToCheck = job;
          break;
        }
      }
    }
    // Re-check job completion (downloads might have been blocking it)
    if (jobToCheck) this._checkJobDone(jobToCheck);
    this._emitStateChanged();
  }

  /** Đặt download item đang xử lý (gọi bởi EditorExecutor) */
  setCurrentDownload(dlItem) {
    this._currentDownloadItem = dlItem || null;
    this._emitStateChanged();
  }

  // ================================================================
  // NỘI BỘ — WIRING EXECUTORS
  // ================================================================

  /** Khi EditorExecutor submit xong 1 item → chuyển cho TileMonitor */
  _onItemSubmitted(item) {
    this._reloadPromptCounter++;
    this._tileMonitor.monitor(item);
    this._emitStateChanged();
  }

  /** Khi TileMonitor xác nhận item hoàn thành (COMPLETED/PARTIAL_FAIL/FAILED) */
  _onItemCompleted(item) {
    const job = this._jobs.get(item.jobId);
    if (!job) return;

    if (item.state === QueueItem.STATE.COMPLETED ||
        item.state === QueueItem.STATE.PARTIAL_FAIL) {
      job.completedCount++;
      // Per-prompt success notification
      if (window.eventBus) {
        window.eventBus.emit('prompt:single_completed', {
          index: job.completedCount,
          total: job.items.length,
          prompt: item.prompt || '',
          provider: 'flow'
        });
      }
      // Phase FAR-2: Reset consecutive fail counter trên success
      this._consecutiveFailCount = 0;
    } else if (item.state === QueueItem.STATE.FAILED) {
      job.failedCount++;
      // Track flow_fail vào af_daily_stats (cho settings-popup display)
      EditorExecutor._incrementDailyStat('flow_fail');

      // Phase FAR-2: Pipeline consecutive fail recovery — trigger forceReloadAndStabilize
      // (đã có sẵn idle gate, chỉ reload khi pipeline gần idle). Plan Section 3.2.
      this._consecutiveFailCount = (this._consecutiveFailCount || 0) + 1;
      const recoveryEnabled = this._readFarSetting('flowAutoRecoveryEnabled', true) !== false;
      const threshold = parseInt(this._readFarSetting('flowConsecutiveFailThreshold', 2), 10);
      if (recoveryEnabled && this._consecutiveFailCount >= threshold) {
        // Fire-and-forget — forceReloadAndStabilize tự kiểm tra idle gate.
        // Nếu busy → skip + log, KHÔNG reload (giữ counter, lần sau thử lại).
        this.forceReloadAndStabilize('consecutive-fail-recovery')
          .then(reloaded => {
            if (reloaded) {
              this._consecutiveFailCount = 0;
              console.log('[PromptQueue] FAR-2: Consecutive fail recovery → reload OK, counter reset');
            }
          })
          .catch(e => console.warn('[PromptQueue] FAR-2 recovery error:', e.message));
      }
    }

    // Persist result_thumbnails cho task items
    if (item._taskId && item.resultTileIds?.length > 0) {
      this._persistTaskResult(item).catch(e =>
        console.warn('[PromptQueue] Persist task result failed:', e.message)
      );
    }

    // Emit task progress + handle failed task completion
    if (item._taskId && window.eventBus) {
      const taskItems = job.items.filter(i => i._taskId === item._taskId);
      const completedCount = taskItems.filter(i => i.isTerminal).length;
      const totalCount = taskItems.length;
      window.eventBus.emit('task:progress', {
        taskId: item._taskId,
        completed: completedCount,
        total: totalCount,
      });

      // Nếu tất cả items done nhưng item này FAILED (không có resultTileIds → _doPersistTaskResult không chạy)
      // → cần emit task:status_changed ở đây
      const allDone = completedCount === totalCount;
      const hasAnyResult = taskItems.some(i => i.resultTileIds?.length > 0);
      if (allDone && !hasAnyResult) {
        // Tất cả failed, không có result → set status failed
        if (window.storageManager) {
          window.storageManager.updateTaskStatus(item._taskId, 'failed').catch(() => {});
        }
        window.eventBus.emit('task:status_changed', { taskId: item._taskId, status: 'failed' });
      }
    }

    // Task batch: check ranh giới task → enqueue task tiếp (sequential)
    if (job.taskBatch && job.taskBatch.mode === 'sequential') {
      this._checkTaskBoundary(job, item);
    }

    // Kiểm tra job đã xong chưa
    this._checkJobDone(job);
    this._emitStateChanged();
  }

  /** Khi EditorExecutor kết thúc _runLoop → check pipeline done hoặc restart */
  _onRunLoopFinished() {
    // Race condition fix: downloads có thể arrive đúng lúc _runLoop exit
    // → _ensureRunning thấy isRunning=true → skip → không ai restart
    // → Gọi _ensureRunning sau khi _runLoop đã exit để catch pending items
    if (this.hasItems()) {
      this._ensureRunning();
    }
    this._checkAllDone();
    this._emitStateChanged();
  }

  /** Khi tiles sẵn sàng tải xuống → đưa vào unified download queue */
  _onTilesReady(item, tileIds) {
    // Check feature gate: user có quyền auto_download không?
    // Đồng bộ với UI disable toggles — đây là enforcement tầng execution
    const canUseAutoDownload = window.featureGate?.canUse('auto_download') ?? false;
    if (!canUseAutoDownload) return;

    // Check auto-download: item-level (task) > job-level (gen/workflow)
    // Task có auto_download per-task, Gen/Workflow dùng job._autoDownload (từ DOM toggle lúc submit)
    const job = this._jobs.get(item.jobId);
    const autoDownload = item._autoDownload ?? job?._autoDownload ?? false;
    if (!autoDownload) return;

    // Resolution: Video (720p/1080p) vs Image (1k/2k)
    // item-level (task) > UI element > null
    const isVideo = item._isVideo ?? item.settings?.genType === 'Video';
    let resolution;
    if (isVideo) {
      const videoResEl = document.getElementById('genTabVideoDownloadResolution');
      resolution = item._videoDownloadResolution || videoResEl?.value || '720p';
    } else {
      const resEl = document.getElementById('genTabDownloadResolution');
      resolution = item._downloadResolution || resEl?.value || '1k';
    }

    // Dedup + enqueue vào unified download queue
    const existingInQueue = new Set(this._downloadQueue.map(d => d.tileId));
    let enqueued = 0;
    let skippedDownloaded = 0;
    let skippedInQueue = 0;
    // FIX: Index 1-based cho mỗi tile để tránh filename collision
    let indexCounter = 1;
    for (const tid of tileIds) {
      if (this._downloadedTileIds.has(tid)) { skippedDownloaded++; continue; }
      if (existingInQueue.has(tid)) { skippedInQueue++; continue; }

      this._downloadQueue.push({
        tileId: tid,
        fileName: item.resultThumbnails?.[tid]?.file_name || null,
        promptText: item.prompt,
        taskName: item._taskName || null,
        jobId: item.jobId,
        flowFileId: null,
        resolution,
        index: indexCounter++, // FIX: Thêm index để tránh filename collision
      });
      enqueued++;
    }

    console.log(`[PromptQueue] _onTilesReady: ${tileIds.length} tiles → ${enqueued} enqueued, ${skippedDownloaded} already downloaded, ${skippedInQueue} already in queue. Queue size: ${this._downloadQueue.length}`);

    // Khởi động EditorExecutor nếu đang idle (có download mới cần xử lý)
    this._ensureRunning();
  }

  // ================================================================
  // TASK BATCH — LAZY ENQUEUE
  // ================================================================

  /** Đưa prompts của 1 task vào hàng đợi */
  _enqueueTaskItems(job, taskIdx) {
    const task = job.taskBatch.tasks[taskIdx];
    const settings = job.taskBatch.settingsPerTask?.[taskIdx] || job.settings;
    const rawPrompts = (task.multi_prompt && task.prompts?.length > 1)
      ? task.prompts
      : [task.prompt];

    // Parse ref_file_ids: có thể là string (comma-separated) hoặc array
    const rawRefIds = task.ref_file_ids || [];
    const refFileIds = typeof rawRefIds === 'string'
      ? rawRefIds.split(',').map(s => s.trim()).filter(Boolean)
      : rawRefIds;

    const refImageMode = task.ref_image_mode || 'all';

    // Mention mode: GIỮ NGUYÊN @mention_name trong prompt khi submit đến Flow
    // (trước đây strip @mentions, nhưng theo yêu cầu mới giữ nguyên prompt có @mention)
    // rawPrompts vẫn được dùng cho regex matching (build mentionData)
    const prompts = rawPrompts;

    // Xây dựng refFileIdsPerPrompt cho mode 'sequential' và 'mention'
    let refFileIdsPerPrompt = null;
    let taskMentionData = null;
    if (refImageMode === 'sequential' && refFileIds.length > 0) {
      refFileIdsPerPrompt = rawPrompts.map((_, idx) =>
        idx < refFileIds.length ? [refFileIds[idx]] : []
      );
    } else if (refImageMode === 'mention' && refFileIds.length > 0 && task.ref_image_names) {
      // Mention mode: resolve @mentions trong từng rawPrompt → chỉ ref matching
      const nameToFileId = {};
      for (const fid of refFileIds) {
        const name = task.ref_image_names[fid];
        // Index lower-case để case-insensitive match (autocomplete cũng case-insensitive)
        if (name) nameToFileId[name.toLowerCase()] = fid;
      }
      // Regex unicode (\p{L} = letter, \p{N} = number) — accept Vietnamese, emoji, accent
      refFileIdsPerPrompt = rawPrompts.map(prompt => {
        const mentions = prompt.match(/@([\p{L}\p{N}_]+)/gu) || [];
        const ids = [];
        for (const m of mentions) {
          const name = m.substring(1).toLowerCase();
          if (nameToFileId[name] && !ids.includes(nameToFileId[name])) {
            ids.push(nameToFileId[name]);
          }
        }
        return ids;
      });
      // Build mentionData per prompt cho EditorExecutor fileNameMap
      const fileNameMap = task.ref_file_names || {};
      taskMentionData = rawPrompts.map((_, i) => ({
        refImages: (refFileIdsPerPrompt[i] || []).map(fid => ({
          file_id: fid,
          file_name: fileNameMap[fid] || null,
        })),
      }));
    }

    for (let i = 0; i < prompts.length; i++) {
      const item = new QueueItem({
        jobId: job.id,
        prompt: prompts[i],
        promptIndex: i,
        settings: settings ? { ...settings } : null,
        refFileIds: this._resolveRefForIndex(refFileIds, refFileIdsPerPrompt, refImageMode, i),
        refFileNames: task.ref_file_names || {},
        refImageMode,
        mentionData: taskMentionData?.[i] || null,
      });
      item._taskIdx = taskIdx;
      item._taskId = task.task_id || task.id;
      item._taskName = task.task_name || null;
      // Pass task-level auto_download + resolution
      item._autoDownload = task.auto_download === true || task.auto_download === '1' || task.auto_download === 1;
      item._downloadResolution = task.download_resolution || null;
      item._videoDownloadResolution = task.video_download_resolution || null;
      item._isVideo = task.media_type === 'Video';
      job.items.push(item);
      this._itemQueue.push(item);
    }

    job.taskBatch.currentIdx = taskIdx;

    // Pipeline fix: Set task status to running + emit event (giống legacy path trong app.js)
    const taskId = task.task_id || task.id;
    if (taskId && window.storageManager) {
      window.storageManager.updateTaskStatus(taskId, 'running').catch(() => {});
    }
    if (taskId && window.eventBus) {
      window.eventBus.emit('task:status_changed', { taskId, status: 'running' });
    }
  }

  /** Kiểm tra ranh giới task: tất cả items của task hiện tại đã xong → enqueue task tiếp */
  _checkTaskBoundary(job, completedItem) {
    const taskIdx = completedItem._taskIdx;
    if (taskIdx === null || taskIdx === undefined) return;

    const taskItems = job.items.filter(i => i._taskIdx === taskIdx);
    const allDone = taskItems.every(i => i.isTerminal);

    if (allDone) {
      // Task này xong → enqueue task tiếp (nếu còn)
      const nextIdx = taskIdx + 1;
      if (nextIdx < job.taskBatch.tasks.length && job.state === 'running') {
        this._enqueueTaskItems(job, nextIdx);
        this._sortQueue();
        this._ensureRunning();
      }
    }
  }

  // ================================================================
  // JOB LIFECYCLE
  // ================================================================

  /** Kiểm tra job đã hoàn tất tất cả items chưa */
  _checkJobDone(job) {
    if (job.isDone || job._resolved) return;

    const allTerminal = job.items.every(i => i.isTerminal);
    if (!allTerminal) return;

    // Với task batch sequential: cần kiểm tra đã enqueue hết tasks chưa
    if (job.taskBatch && job.taskBatch.mode === 'sequential') {
      const lastIdx = job.taskBatch.currentIdx;
      if (lastIdx + 1 < job.taskBatch.tasks.length) return; // Còn tasks chưa enqueue
    }

    // CRITICAL: Không đánh dấu completed nếu còn downloads pending cho job này
    // Downloads được add vào queue SAU khi item terminal → race condition
    // FIX: Check cả downloads trong queue LẪN download đang xử lý (đã dequeue)
    const hasPendingDownloads = this._downloadQueue.some(d => d.jobId === job.id) ||
      (this._currentDownloadItem?.jobId === job.id);
    if (hasPendingDownloads) {
      // Defer completion check - sẽ được gọi lại sau mỗi download hoàn thành
      return;
    }

    job.state = 'completed';

    // ExecutionGate: complete token khi job hoàn tất.
    // Bug fix 2026-05-22: detect partial status + pass successful_count để backend refund đúng
    // (trước fix: partial coi như 'success' → 3 failed items không được refund quota).
    if (window.ExecutionGate && job._executionToken) {
      let gateStatus, extraData = {};
      if (job.failedCount === 0 || job.completedCount === 0) {
        gateStatus = job.completedCount === 0 ? 'failed' : 'success';
      } else {
        gateStatus = 'partial';
        extraData = { successful_count: job.completedCount, failed_count: job.failedCount };
      }
      ExecutionGate.complete(job._executionToken, gateStatus, extraData);
      job._executionToken = null;
    }

    // Guard chống resolve 2 lần (race giữa stopJob + _checkJobDone)
    if (!job._resolved) {
      job._resolved = true;
      // Collect result data từ all items (cho workflow/angles callers)
      const allResultTileIds = [];
      const allResultThumbnails = {};
      const failedPrompts = [];
      for (const item of job.items) {
        if (item.resultTileIds?.length > 0) {
          allResultTileIds.push(...item.resultTileIds);
          Object.assign(allResultThumbnails, item.resultThumbnails || {});
        }
        // Collect failed prompts (có error hoặc không có results)
        if (item.error || (item.isTerminal && (!item.resultTileIds || item.resultTileIds.length === 0))) {
          failedPrompts.push({
            index: item.promptIndex,
            prompt: item.prompt,
            error: item.error || 'No results generated',
            timestamp: item.completedAt || Date.now(),
          });
        }
      }
      job._resolve?.({
        completed: job.completedCount,
        failed: job.failedCount,
        stopped: false,
        resultTileIds: allResultTileIds,
        resultThumbnails: allResultThumbnails,
        failedPrompts: failedPrompts.length > 0 ? failedPrompts : [],
      });
      job._resolve = null;
    }

    this._checkAllDone();
  }

  /** Kiểm tra tất cả jobs đã xong → giải phóng resources */
  _checkAllDone() {
    const hasActive = Array.from(this._jobs.values()).some(j => j.isActive);
    if (hasActive) return;

    // Kiểm tra thêm: có items nào trong queue không
    if (this._itemQueue.length > 0) return;

    // Kiểm tra download queue + download đang xử lý
    if (this._downloadQueue.length > 0) return;
    if (this._currentDownloadItem) return;

    // Kiểm tra TileMonitor còn đang theo dõi không
    if (this._tileMonitor.activeCount > 0) return;

    // Pipeline hoàn toàn rỗng
    this._isRunning = false;
    this._reloadPromptCounter = 0;
    ExecutionLock.release('queue');

    // Hide ExecutionBlocker khi pipeline kết thúc
    if (window.MessageBridge) {
      MessageBridge.sendToContentScript('pq:hideBlocker', {}).catch(() => {});
    }

    // Dọn dẹp completed jobs cũ (giữ tối đa 10)
    this.cleanup();

    // Reset deduplication cho session mới (pipeline hoàn toàn rỗng, an toàn)
    this._tileMonitor.reset();
    this._downloadedTileIds.clear();
    // KHÔNG clear _downloadHistory và _downloadCompletedCount ở đây
    // Giữ lại để QueueMonitor hiển thị history sau khi pipeline hoàn tất
    // Sẽ clear khi submit job mới (trong _clearCompletedJobs)
    this._currentDownloadItem = null;

    this._emitStateChanged();
  }

  // ================================================================
  // HELPERS
  // ================================================================

  /**
   * Ensure Flow tab is active (tránh Chrome throttle inactive tabs)
   * Chrome throttle inactive tabs: setTimeout 1/sec, requestAnimationFrame stopped
   * → detectTileStatus() DOM không update → trả sai → false fail + retry vô ích
   * @returns {Promise<{isOpen: boolean, wasActivated?: boolean}>}
   */
  async _ensureFlowTabActive() {
    // Lấy targetTabId từ app.js (sidePanel) hoặc storage session (popup windows)
    let targetTabId = window._targetFlowTabId || null;

    // Popup windows không có _targetFlowTabId → fallback từ storage session
    if (!targetTabId) {
      try {
        const res = await chrome.storage?.session?.get('targetFlowTabId');
        targetTabId = res?.targetFlowTabId || null;
      } catch (e) {
        // storage session không khả dụng
      }
    }

    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'ensureFlowTabReady', targetTabId }, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ isOpen: false });
          return;
        }
        resolve(response || { isOpen: false });
      });
    });
  }

  /**
   * Kiểm tra và thực hiện auto-reload Flow tab nếu counter >= threshold
   * Gọi GIỮA các items trong EditorExecutor._runLoop()
   * @returns {Promise<boolean>} true nếu đã reload, false nếu không cần
   */
  async _checkAndPerformReload() {
    try {
      const settings = window.storageSettings?.getSettings?.();
      const enabled = settings?.autoReloadEnabled === true || settings?.autoReloadEnabled === '1' || settings?.autoReloadEnabled === 1;
      const threshold = parseInt(settings?.autoReloadThreshold || '0', 10);

      if (!enabled || threshold <= 0) return false;
      if (this._reloadPromptCounter < threshold) return false;

      // Skip reload khi multi-step caller (workflow) đang chạy
      // Workflow submit nodes tuần tự → giữa các nodes queue có thể rỗng
      // nhưng workflow chưa xong → reload sẽ mất tiles → node sau fail
      if (this._reloadSuppressCount > 0) {
        console.log('[PromptQueue] Auto-reload deferred: multi-step caller active (suppress count:', this._reloadSuppressCount, ')');
        return false;
      }

      // Chờ download queue rỗng trước khi reload
      const downloadsEmpty = await this.waitForDownloadsEmpty(30000);
      if (!downloadsEmpty) {
        console.log('[PromptQueue] Auto-reload skipped: downloads still pending');
        return false;
      }

      // Chờ TileMonitor active count = 0 (timeout 60s)
      const tileMonitorStart = Date.now();
      while (this._tileMonitor.activeCount > 0 && Date.now() - tileMonitorStart < 60000) {
        await new Promise(r => setTimeout(r, 500));
      }
      if (this._tileMonitor.activeCount > 0) {
        console.log('[PromptQueue] Auto-reload skipped: TileMonitor still active');
        return false;
      }

      // Reset counter
      this._reloadPromptCounter = 0;

      console.log('[PromptQueue] Auto-reloading Flow tab to free DOM memory...');

      // Gửi reload message đến content.js
      if (window.MessageBridge) {
        try {
          await MessageBridge.sendToContentScript('autoReloadFlow', {});
        } catch (e) {
          console.warn('[PromptQueue] Auto-reload message failed:', e.message);
          return false;
        }
      } else {
        return false;
      }

      // Chờ content script sẵn sàng sau reload
      const ready = await this._waitContentScriptReady(20000);
      if (!ready) {
        console.warn('[PromptQueue] Content script not ready after reload, continuing anyway');
      }

      // Chờ thêm 2s cho Flow render xong
      await new Promise(r => setTimeout(r, 2000));

      console.log('[PromptQueue] Auto-reload complete, resuming pipeline');
      return true;
    } catch (err) {
      console.warn('[PromptQueue] Auto-reload failed, skipping:', err.message);
      return false;
    }
  }

  /**
   * Poll content.js readiness sau khi reload
   * @param {number} timeoutMs - Timeout tối đa (mặc định 20s)
   * @returns {Promise<boolean>} true nếu content script sẵn sàng
   */
  async _waitContentScriptReady(timeoutMs = 20000) {
    const startTime = Date.now();
    const pollInterval = 1000;

    while (Date.now() - startTime < timeoutMs) {
      try {
        const response = await MessageBridge.sendToContentScript('checkContentScriptAlive', {});
        if (response?.alive) {
          console.log('[PromptQueue] Content script ready after reload (hasEditor:', response.hasEditor, ')');
          return true;
        }
      } catch (e) {
        // Content script chưa sẵn sàng, tiếp tục poll
      }
      await new Promise(r => setTimeout(r, pollInterval));
    }

    return false;
  }

  /**
   * Poll content.js + Flow editor readiness sau reload.
   * Khác `_waitContentScriptReady`: yêu cầu CẢ `alive=true` LẪN `hasEditor=true` →
   * đảm bảo Slate editor đã render trước khi caller (TileMonitor Tier 2) submit lại.
   * @param {number} timeoutMs - Timeout tối đa (mặc định 30s)
   * @returns {Promise<boolean>} true nếu editor sẵn sàng
   */
  async _waitFlowEditorReady(timeoutMs = 30000) {
    const startTime = Date.now();
    const pollInterval = 1000;
    let lastEditorCheck = false;
    let modalDismissAttempts = 0;
    const maxModalAttempts = 5; // Giới hạn số lần thử dismiss modal

    console.log('[PromptQueue] _waitFlowEditorReady started, timeout:', timeoutMs);

    while (Date.now() - startTime < timeoutMs) {
      try {
        const response = await MessageBridge.sendToContentScript('checkContentScriptAlive', {});
        console.log('[PromptQueue] checkContentScriptAlive:', response?.alive, 'hasEditor:', response?.hasEditor);

        if (response?.alive && response?.hasEditor) {
          // Step 1: Thử dismiss modal (giới hạn số lần)
          if (modalDismissAttempts < maxModalAttempts) {
            try {
              const modalCheck = await MessageBridge.sendToContentScript('dismissBlockingModal', {});
              if (modalCheck?.hadModal) {
                console.log('[PromptQueue] Dismissed blocking modal, attempt:', modalDismissAttempts + 1);
                modalDismissAttempts++;
                await new Promise(r => setTimeout(r, 1000));
                continue;
              }
            } catch (e) {
              // Ignore
            }
          }

          // Step 2: Check Slate ready (bỏ qua modal check để tránh false positive)
          try {
            const editorState = await MessageBridge.sendToContentScript('getEditor', {});
            console.log('[PromptQueue] getEditor:', editorState?.exists, 'hasSlateState:', editorState?.hasSlateState);

            if (editorState?.exists && editorState?.hasSlateState) {
              console.log('[PromptQueue] Flow editor + Slate ready!');
              return true;
            }
            if (!lastEditorCheck) {
              console.log('[PromptQueue] Editor exists but Slate not ready, waiting...');
              lastEditorCheck = true;
            }
          } catch (slateErr) {
            console.log('[PromptQueue] getEditor failed:', slateErr.message);
          }
        }
      } catch (e) {
        console.log('[PromptQueue] Poll error:', e.message);
      }
      await new Promise(r => setTimeout(r, pollInterval));
    }

    console.warn('[PromptQueue] _waitFlowEditorReady TIMEOUT after', timeoutMs, 'ms');
    return false;
  }

  /**
   * Force reload Flow tab + chờ editor ổn định (cho retry recovery).
   * Khác `_checkAndPerformReload`: KHÔNG gated bởi user setting `autoReloadEnabled` —
   * gọi explicit khi Tier 1 button retry hết maxRetries vẫn fail → reset editor state →
   * Tier 2 fallback submit có cơ hội thành công cao hơn.
   *
   * Idempotent: nếu reload đang trong progress (gọi đồng thời từ multiple monitors),
   * chỉ thực thi 1 lần qua `_forceReloadPromise` cache.
   *
   * @param {string} reason - Lý do reload (chỉ log)
   * @returns {Promise<boolean>} true nếu reload + editor ready, false nếu fail
   */
  async forceReloadAndStabilize(reason = 'retry-recovery') {
    // Dedup: nếu đang reload, await promise hiện tại
    if (this._forceReloadPromise) {
      console.log(`[PromptQueue] forceReload đang trong progress, await... (${reason})`);
      return await this._forceReloadPromise;
    }

    // Option A — Idle gate: chỉ reload khi pipeline gần idle để tránh phá items khác.
    // Lý do (xem analysis trong commit msg): reload xoá toàn bộ tiles + editor → bất kỳ
    // monitor/download/submit nào đang in-flight đều bị kill. Chỉ an toàn khi:
    //   - TileMonitor active = 0 (caller chưa enter activeMonitors) hoặc 1 (chỉ caller)
    //   - EditorExecutor không đang submit item khác (currentItem === null)
    //   - EditorExecutor không đang download (dl item đã dequeue, chưa xong)
    //   - Item queue rỗng (không có item pending sắp dequeue)
    //   - Download queue rỗng (không phá download in-flight)
    //   - reloadSuppressCount === 0 (workflow multi-step không ở giữa chuỗi)
    // Nếu busy → return false → caller (TileMonitor Tier 2) degrade thẳng `_requestFallbackSubmit`.
    const activeMonitors = this._tileMonitor?.activeCount ?? 0;
    const editorBusy = !!this._editorExecutor?.currentItem;
    const editorDownloading = !!this._editorExecutor?.isDownloading;
    const queueLen = this._itemQueue?.length || 0;
    const dlLen = this._downloadQueue?.length || 0;
    const suppressed = this._reloadSuppressCount > 0;
    if (activeMonitors > 1 || editorBusy || editorDownloading || queueLen > 0 || dlLen > 0 || suppressed) {
      console.log(
        `[PromptQueue] forceReload skipped (pipeline busy, reason=${reason}): ` +
        `activeMonitors=${activeMonitors}, editorBusy=${editorBusy}, ` +
        `editorDownloading=${editorDownloading}, queueLen=${queueLen}, ` +
        `dlLen=${dlLen}, suppressed=${suppressed}`
      );
      return false;
    }

    this._forceReloadPromise = (async () => {
      try {
        console.log(`[PromptQueue] Force reload Flow tab (reason: ${reason})...`);

        // Gửi reload message — không cần waitForDownloadsEmpty vì idle gate đã đảm bảo dlLen=0
        try {
          await MessageBridge.sendToContentScript('autoReloadFlow', {});
        } catch (e) {
          console.warn('[PromptQueue] forceReload: send message failed:', e.message);
          return false;
        }

        // CRITICAL: Chờ page thực sự reload trước khi poll
        // Content script làm setTimeout(() => location.reload(), 100)
        // Nếu poll ngay → OLD content script vẫn alive → false positive "ready"
        console.log('[PromptQueue] Waiting for page to start reloading...');
        await new Promise(r => setTimeout(r, 1500)); // Giảm từ 2s xuống 1.5s

        // Chờ content script + editor ready (max 30s)
        console.log('[PromptQueue] Polling for editor ready...');
        const editorReady = await this._waitFlowEditorReady(30000);
        if (!editorReady) {
          console.warn('[PromptQueue] forceReload: editor not ready after 30s, degrading');
          return false;
        }

        // Reset reload counter (vì đã reload thành công)
        this._reloadPromptCounter = 0;

        // Reset EditorExecutor cached settings — DOM mới, settings cũ stale
        if (this._editorExecutor) {
          this._editorExecutor._lastSettings = null;
        }

        // Extra settle delay cho React/Slate finalize render
        // Giảm từ 3.5s xuống 1s vì _waitFlowEditorReady đã check kỹ
        await new Promise(r => setTimeout(r, 1000));

        // 2026-05-25 BUG FIX: Sau Flow reload, tiles cũ chưa render lại trong DOM (Flow
        // lazy-load tiles theo viewport scroll). Step 3 `addRefImages` scan DOM theo
        // fe_id → KHÔNG tìm thấy → fail "Không tìm thấy file có ID...".
        // Fix: trigger ensureFlowTilesLoaded để force scroll + render tất cả tiles
        // TRƯỚC khi EditorExecutor retry. Tile cache populate đầy đủ → ref ID match được.
        try {
          if (MessageBridge?.prepareFlowForScan) {
            console.log('[PromptQueue] Force reload: ensure tiles loaded post-reload...');
            await MessageBridge.prepareFlowForScan().catch(() => {});
          }
        } catch (e) { /* best-effort */ }

        // Re-emit state để FloatingTracker (content.js singleton) lấy lại snapshot
        // sau reload (DOM bị destroy → tracker rỗng). Trigger ngay sau reload settle.
        try { this._emitStateChanged(); } catch (e) { /* ignore */ }

        console.log(`[PromptQueue] Force reload complete (${reason})`);
        return true;
      } finally {
        this._forceReloadPromise = null;
      }
    })();

    return await this._forceReloadPromise;
  }

  /** Khởi động EditorExecutor nếu chưa chạy */
  _ensureRunning() {
    const hasPendingWork = this._itemQueue.length > 0 || this._downloadQueue.length > 0;

    if (!this._isRunning && hasPendingWork) {
      this._isRunning = true;
      this._startedAt = Date.now();

      // Đọc settings từ UI
      this._readSettings();

      // Acquire lock với owner = 'queue' (không block owners khác)
      ExecutionLock.acquire('queue', 'Pipeline Queue');

      // Show ExecutionBlocker khi pipeline bắt đầu (block user interaction trên Flow)
      if (window.MessageBridge) {
        MessageBridge.sendToContentScript('pq:showBlocker', {}).catch(() => {});
      }

      this._editorExecutor.start();
    } else if (this._isRunning && !this._editorExecutor.isRunning && this.hasItems()) {
      // EditorExecutor đã dừng nhưng còn items mới (submit hoặc download) → khởi động lại
      this._editorExecutor.start();
    }
  }

  /**
   * Persist result_thumbnails + result_file_ids cho task khi item hoàn thành
   * Serialize per-task để tránh race condition khi nhiều items complete gần nhau
   */
  _persistTaskResult(item) {
    if (!item._taskId || !window.storageManager) return Promise.resolve();
    const taskId = item._taskId;
    const prev = this._persistQueues.get(taskId) || Promise.resolve();
    const next = prev.then(() => this._doPersistTaskResult(item));
    this._persistQueues.set(taskId, next.catch(() => {}));
    return next;
  }

  /** Internal: thực thi persist (đã được serialize per-task bởi _persistTaskResult) */
  async _doPersistTaskResult(item) {
    if (!item._taskId || !window.storageManager) return;

    const tileIds = item.resultTileIds || [];
    if (tileIds.length === 0) return;

    // Scan thumbnails + file_names từ DOM
    const thumbs = {};
    const fileNames = {};
    for (const tid of tileIds) {
      const info = item.resultThumbnails?.[tid];
      if (info?.thumbnail) thumbs[tid] = info.thumbnail;
      if (info?.file_name) fileNames[tid] = info.file_name;
    }

    // Scan missing từ MessageBridge
    const missingTiles = tileIds.filter(id => !thumbs[id]);
    if (missingTiles.length > 0 && window.MessageBridge) {
      try {
        const scanResult = await MessageBridge.getThumbnailsByIds(missingTiles);
        const results = scanResult?.results || {};
        for (const tid of missingTiles) {
          if (results[tid]?.thumbnail) thumbs[tid] = results[tid].thumbnail;
          if (results[tid]?.file_name) fileNames[tid] = results[tid].file_name;
        }
      } catch (e) {
        console.warn('[PromptQueue] Scan thumbnails failed:', e.message);
      }
    }

    // Persist vào task storage
    try {
      const freshTask = await window.storageManager.getTask(item._taskId);
      if (!freshTask) return;

      // Merge result_file_ids
      const existingIds = (freshTask.result_file_ids || '').split(',').map(s => s.trim()).filter(Boolean);
      const newIds = tileIds.filter(id => !existingIds.includes(id));
      if (newIds.length > 0) {
        freshTask.result_file_ids = [...existingIds, ...newIds].join(',');
      }

      // Merge result_thumbnails
      if (Object.keys(thumbs).length > 0) {
        freshTask.result_thumbnails = { ...(freshTask.result_thumbnails || {}), ...thumbs };
      }

      // Merge result_file_names
      if (Object.keys(fileNames).length > 0) {
        freshTask.result_file_names = { ...(freshTask.result_file_names || {}), ...fileNames };
      }

      // Chỉ set completed khi TẤT CẢ items của task này đã terminal
      const job = this._jobs.get(item.jobId);
      const taskItems = job ? job.items.filter(i => i._taskId === item._taskId) : [];
      const allTaskItemsDone = taskItems.length > 0 && taskItems.every(i => i.isTerminal);
      if (allTaskItemsDone) {
        freshTask.status = 'completed';
      }
      await window.storageManager.saveTask(freshTask);
      console.log(`[PromptQueue] Persisted ${tileIds.length} result tiles for task ${item._taskId}`);

      // Emit task:status_changed khi task hoàn tất (all items done)
      if (allTaskItemsDone && window.eventBus) {
        window.eventBus.emit('task:status_changed', {
          taskId: item._taskId,
          status: 'completed',
          // History fields for GenerationHistory.saveFromTask()
          prompt: freshTask.prompt || '',
          media_type: freshTask.media_type || 'image',
          model: freshTask.model || '',
          ratio: freshTask.ratio || '',
          prompt_count: (freshTask.multi_prompt && freshTask.prompts?.length) ? freshTask.prompts.length : 1,
          quantity: freshTask.quantity || 1,
          result_thumbnails: freshTask.result_thumbnails ? Object.values(freshTask.result_thumbnails) : [],
          result_file_ids: freshTask.result_file_ids || '',
          result_file_names: freshTask.result_file_names || {},
          project_id: freshTask.project_id || window._currentProjectId || null,
          auto_download: !!freshTask.auto_download,
        });
      }
    } catch (e) {
      console.warn('[PromptQueue] Save task result failed:', e.message);
    }
  }

  /** Đọc settings từ ExecutionConfig (server) với fallback StorageSettings (local) */
  _readSettings() {
    // Phase 2c+: Server-Only — ExecutionConfig source of truth, legacy af_settings.queueX/execX đã chết.
    const queueConfig = window.ExecutionConfig?.safeGetQueueConfig() || {};
    const wfConfig = window.ExecutionConfig?.safeGetWorkflowConfig() || {};

    const batchSize = queueConfig.batch_size ?? 4;
    const maxMonitor = queueConfig.max_monitor ?? 4;
    const restMin = queueConfig.rest_min_sec ?? 5;
    const restMax = queueConfig.rest_max_sec ?? 15;
    const execTimeout = wfConfig.timeout_sec ?? 180;
    let maxRetries = wfConfig.max_retries ?? 2;

    // Check retry_on_fail feature - override maxRetries = 0 nếu không có quyền
    // Đồng bộ với content.js legacy path và WorkflowExecutor
    const canUseRetry = window.featureGate?.canUseRetryOnFail?.() ?? true;
    if (!canUseRetry) {
      maxRetries = 0; // Force no retry
    }

    this._editorExecutor.updateSettings({ batchSize, restMin, restMax });
    this._tileMonitor.updateSettings({ maxMonitor, timeout: execTimeout, maxRetries });
  }

  /** Đọc trạng thái autoDownload từ DOM (cache lúc submit, tránh query lúc tile ready) */
  _readAutoDownload() {
    return !!(document.getElementById('genTabAutoDownload')?.checked
      || document.getElementById('autoDownloadToggle')?.checked);
  }

  /** Sắp xếp hàng đợi: priority cao trước, cùng priority thì FIFO (theo createdAt) */
  _sortQueue() {
    this._itemQueue.sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return a.createdAt - b.createdAt;
    });
  }

  /** Phân giải ref images cho prompt tại index cụ thể */
  _resolveRefForIndex(refFileIds, refFileIdsPerPrompt, refImageMode, index) {
    if (refImageMode === 'none') return [];
    if (refImageMode === 'sequential' && refFileIdsPerPrompt) {
      return refFileIdsPerPrompt[index] || [];
    }
    if (refImageMode === 'mention') {
      // @mention — ref được resolve per prompt
      return refFileIdsPerPrompt?.[index] || refFileIds || [];
    }
    // 'all' hoặc mặc định — tất cả ref images cho mọi prompt
    return refFileIds || [];
  }

  // ================================================================
  // FAR helpers — Phase 2c+ Server-Only: ExecutionConfig source of truth
  // ================================================================

  /**
   * Đọc 1 setting cho FAR features (session refresh, recovery, rate-limit, backoff).
   * Phase 2c+ Server-Only: Chỉ đọc từ ExecutionConfig.safeGetFlowRecoveryConfig().
   * Legacy af_settings.flowX + DOM input đã chết (UI input remove Phase 2c).
   *
   * @param {string} key - vd 'flowConsecutiveFailThreshold' / 'flowAutoRecoveryEnabled'
   * @param {number|boolean} fallback - dùng khi cache empty (cold-start race)
   */
  _readFarSetting(key, fallback) {
    const farConfig = window.ExecutionConfig?.safeGetFlowRecoveryConfig?.() || {};
    const keyMap = {
      'flowAutoRecoveryEnabled': farConfig.auto_recovery_enabled,
      'flowConsecutiveFailThreshold': farConfig.consecutive_fail_threshold,
      'flowSessionRefreshEnabled': farConfig.session_refresh_enabled,
      'flowSessionRefreshIntervalMin': farConfig.session_refresh_interval_min,
      'flowBackoffBaseSec': farConfig.backoff_base_sec,
      'flowBackoffMaxSec': farConfig.backoff_max_sec,
      'flowBackoffJitterPercent': farConfig.backoff_jitter_percent,
    };
    if (keyMap[key] !== undefined) return keyMap[key];
    return fallback;
  }

  // ================================================================
  // FAR-3: Pre-submit DOM gate — Flow concurrent generations cap
  // ================================================================

  /**
   * Đếm pending tiles thực tế trên Flow DOM (không success/failed).
   * Cache 1s để giảm DOM query overhead. Plan Section 3.3.2.
   * @returns {Promise<number>} Số tile in-flight
   */
  async _getPendingTileCount() {
    const now = Date.now();
    if (this._pendingTileCountCache && now - this._pendingTileCountCache.at < 1000) {
      return this._pendingTileCountCache.count;
    }
    try {
      const resp = await MessageBridge.sendToContentScript('getPendingTileCount');
      const count = parseInt(resp?.count, 10);
      const safeCount = Number.isFinite(count) ? count : 0;
      this._pendingTileCountCache = { count: safeCount, at: now };
      return safeCount;
    } catch (e) {
      // Content script chưa ready hoặc Flow tab không mở → 0 (không block submit)
      return 0;
    }
  }

  /**
   * Kiểm tra pending tile cap trước submit. Cap đọc từ TileMonitor.maxMonitor
   * (= queueMaxMonitor user setting). Plan FAR-3.2.
   * @returns {Promise<boolean>} true nếu cần wait (caller continue loop)
   */
  async _shouldWaitForPendingDrain() {
    // TileMonitor lưu vào _maxConcurrent (xem TileMonitor.updateSettings)
    const cap = parseInt(this._tileMonitor?._maxConcurrent || 4, 10);
    // K.16 (2026-05-29): Dùng TileMonitor.activeCount thay vì _getPendingTileCount (DOM query global).
    // Trước fix: count tất cả tiles status='processing' trên Flow DOM → bao gồm tile cũ chưa transition
    // valid `<img src>` (race) + tiles từ context khác (sidebar/popup cùng chạy) + false positive
    // detectTileStatus. User report chỉ run workflow only nhưng pending count = 4 (cap 4) → block.
    // Fix: count CHỈ tiles extension đang actively monitor (TileMonitor._activeMonitors.size) →
    // accurate cho workflow execution context, loại trừ noise DOM.
    const pendingCount = this._tileMonitor?.activeCount ?? 0;
    if (pendingCount >= cap) {
      console.log(`[PromptQueue] Active monitors ${pendingCount} >= cap ${cap} (queueMaxMonitor) — wait drain`);
      return true;
    }
    return false;
  }

  // ================================================================
  // EVENT EMISSION (throttled)
  // ================================================================

  /** Phát event trạng thái cho UI (throttle 500ms) */
  _emitStateChanged() {
    const now = Date.now();
    if (now - this._lastEmitTime < 500) {
      if (!this._emitScheduled) {
        this._emitScheduled = true;
        setTimeout(() => {
          this._emitScheduled = false;
          this._lastEmitTime = Date.now();
          this._doEmit();
        }, 500 - (now - this._lastEmitTime));
      }
      return;
    }

    this._lastEmitTime = now;
    this._doEmit();
  }

  /** Phát snapshot toàn bộ trạng thái pipeline */
  _doEmit() {
    if (!window.eventBus) return;

    const snapshot = this._buildSnapshot();

    // Emit local event ngay lập tức
    window.eventBus.emit('queue:state_changed', snapshot);

    // Broadcast đến các context khác qua throttle (giảm số lần gửi)
    this._throttledBroadcast(snapshot);
  }

  /** Tạo snapshot toàn bộ trạng thái pipeline */
  _buildSnapshot() {
    return {
      jobs: Array.from(this._jobs.values()).map(job => ({
        id: job.id,
        owner: job.owner,
        label: job.label,
        status: job.state,
        startedAt: job.createdAt,
        completedCount: job.completedCount,
        failedCount: job.failedCount,
        totalExpected: job.totalExpected,
        settings: job.settings,
        taskBatch: job.taskBatch ? {
          currentIdx: job.taskBatch.currentIdx,
          totalTasks: job.taskBatch.tasks.length,
          currentTaskName: job.taskBatch.tasks[job.taskBatch.currentIdx]?.name || '',
        } : null,
        items: job.items.map(item => ({
          id: item.id,
          promptIndex: item.promptIndex,
          promptText: item.promptText,
          state: item.state,
          tileId: item.tileId,
          retryCount: item.retrySubmitCount,
          error: item.error,
          _taskIdx: item._taskIdx,
          submittedAt: item.submittedAt,
          completedAt: item.completedAt,
          createdAt: item.createdAt,
        })),
      })),

      pipeline: {
        editor: {
          state: this._editorExecutor.state,
          currentItemId: this._editorExecutor.currentItem?.id || null,
          processedCount: this._editorExecutor.processedCount,
        },
        tileMonitor: {
          activeCount: this._tileMonitor.activeCount,
          completedCount: this._tileMonitor.completedCount,
          failedCount: this._tileMonitor.failedCount,
        },
        download: {
          state: this._currentDownloadItem ? 'downloading' :
                 (this._downloadQueue.length > 0 ? 'queued' : 'idle'),
          queueLength: this._downloadQueue.length,
          completedCount: this._downloadCompletedCount,
          items: [
            ...this._downloadQueue.slice(0, 10).map(d => ({
              tileId: d.tileId, promptText: d.promptText, state: 'PENDING', jobId: d.jobId,
            })),
            ...(this._currentDownloadItem ? [this._currentDownloadItem] : []),
            ...this._downloadHistory.slice(-10),
          ],
        },
      },

      elapsed: this._startedAt ? Date.now() - this._startedAt : 0,
    };
  }

  /** Throttle broadcast đến contexts khác (500ms) */
  _throttledBroadcast(snapshot) {
    // Luôn lưu snapshot mới nhất
    this._pendingSnapshot = snapshot;

    // Nếu timer đang chạy thì skip, chỉ lưu snapshot mới nhất
    if (this._broadcastThrottleTimer) return;

    // Đặt timer để broadcast sau 500ms
    this._broadcastThrottleTimer = setTimeout(() => {
      this._broadcastThrottleTimer = null;

      if (this._pendingSnapshot) {
        const snap = this._pendingSnapshot;
        this._pendingSnapshot = null;

        // Broadcast đến các context khác (sidePanel, popup windows) qua chrome.runtime
        // Giúp QueueMonitor trong sidePanel thấy jobs từ popup windows (workflow, angles)
        try {
          chrome.runtime.sendMessage({ action: 'pq:state_broadcast', snapshot: snap }).catch(() => {});
        } catch (_) {}

        // Gửi update đến FloatingTracker trong trang Flow
        this._sendToFlowTracker(snap);
      }
    }, 500);
  }

  /** Gửi state đến FloatingTracker inject trong content script */
  _sendToFlowTracker(snapshot) {
    const jobs = snapshot.jobs || [];
    const completed = jobs.reduce((sum, j) => sum + (j.completedCount || 0), 0);
    const total = jobs.reduce((sum, j) => sum + (j.totalExpected || 0), 0);

    const trackerData = {
      isRunning: this._isRunning,
      completed,
      total,
      elapsed: snapshot.elapsed || 0,
      pipeline: snapshot.pipeline,
      jobs: jobs.map(j => ({
        id: j.id,
        owner: j.owner,
        label: j.label,
        status: j.status,
        completed: j.completedCount || 0,
        failed: j.failedCount || 0,
        total: j.totalExpected || 0,
        startedAt: j.startedAt,
        // Gửi tối đa 15 items gần nhất để tránh message quá lớn
        items: (j.items || []).slice(-15).map(it => ({
          id: it.id,
          promptIndex: it.promptIndex,
          promptText: it.promptText,
          state: it.state,
          retryCount: it.retryCount || 0,
          error: it.error,
          submittedAt: it.submittedAt,
          completedAt: it.completedAt,
          // Chỉ gửi preTileIds cho items đang MONITORING (để FloatingTracker đọc % progress từ DOM)
          preTileIds: it.state === 'MONITORING' && it.preTileIds
            ? Array.from(it.preTileIds) : null,
        })),
      })),
    };

    // Gửi qua MessageBridge (async, không chờ)
    if (window.MessageBridge) {
      MessageBridge.sendToContentScript('pq:trackerUpdate', { data: trackerData }).catch(err => {
        // Chỉ log khi không phải lỗi tab không tồn tại (normal khi Flow tab đóng)
        if (!err?.message?.includes('No tab') && !err?.message?.includes('Receiving end')) {
          console.warn('[PromptQueue] TrackerUpdate failed:', err.message);
        }
      });
    }
  }

  // ================================================================
  // GETTERS CHO UI
  // ================================================================

  /** Số jobs đang active */
  get activeJobCount() {
    return Array.from(this._jobs.values()).filter(j => j.isActive).length;
  }

  /** Tổng số items trong hàng đợi chờ xử lý */
  get pendingCount() {
    return this._itemQueue.length;
  }

  /** Pipeline đang chạy */
  get isRunning() {
    return this._isRunning;
  }

  /** Danh sách tất cả jobs (cho QueueMonitor) */
  get allJobs() {
    return Array.from(this._jobs.values());
  }

  /** Lấy danh sách jobs đang active theo owner */
  getJobsByOwner(owner) {
    return Array.from(this._jobs.values()).filter(j => j.owner === owner && j.isActive);
  }

  /** Xóa tất cả jobs đã hoàn thành/dừng (gọi khi submit job mới) */
  _clearCompletedJobs() {
    for (const [id, job] of this._jobs) {
      if (job.isDone) {
        this._jobs.delete(id);
      }
    }
    // Cleanup persist queues cho tasks đã xong (tránh memory leak)
    if (this._persistQueues.size > 0 && this._jobs.size === 0) {
      this._persistQueues.clear();
    }
    // KHÔNG reset TileMonitor ở đây — có thể có monitors đang chạy từ job khác
    // TileMonitor.reset() chỉ được gọi trong _checkAllDone() khi pipeline hoàn toàn rỗng

    // Clear download history khi submit job mới (sau khi pipeline trước đã xong)
    // Giữ history cho user xem sau khi pipeline hoàn tất, chỉ clear khi bắt đầu session mới
    this._downloadHistory = [];
    this._downloadCompletedCount = 0;

    // Reset TileMonitor counter cho session mới (clean slate). Không reset trong
    // _checkAllDone() để counter giữ cumulative cho display sau khi pipeline xong.
    this._tileMonitor.resetCounters?.();
  }

  /** Dọn dẹp jobs đã hoàn thành cũ hơn 10 entries */
  cleanup() {
    const completedJobs = Array.from(this._jobs.values())
      .filter(j => j.isDone)
      .sort((a, b) => a.createdAt - b.createdAt);

    // Giữ tối đa 10 completed jobs
    while (completedJobs.length > 10) {
      const oldest = completedJobs.shift();
      this._jobs.delete(oldest.id);
    }
  }
}

window.PromptQueue = PromptQueue;
