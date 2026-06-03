/**
 * TileMonitor — Theo dõi đồng thời nhiều tiles sau khi submit
 * Nhận QueueItems ở trạng thái SUBMITTED từ EditorExecutor
 * Monitor concurrent, giới hạn bởi maxConcurrent setting
 */
class TileMonitor {
  constructor() {
    this._activeMonitors = new Map(); // itemId -> { promise, item, abortController }
    this._maxConcurrent = 8;
    // Phase L: Centralized timeout from SystemConfig
    // Phase 3 fix: Use safeGetTimeout to avoid ConfigRequiredError during init
    this._timeout = window.SystemConfig?.safeGetTimeout?.('image_timeout_ms') || 300000;
    this._maxRetries = 2;
    this._queue = null;               // Reference đến PromptQueue
    this._onItemCompleted = null;     // Callback khi item hoàn thành
    this._onTilesReady = null;        // Callback khi tiles sẵn sàng tải xuống
    this._claimedTileIds = new Map(); // Map<tileId, { jobId, itemId, claimedAt }> — per-job tracking
    this._completedCount = 0;
    this._failedCount = 0;
  }

  /**
   * Thiết lập dependencies (inject từ PromptQueue)
   */
  setup({ queue, onItemCompleted, onTilesReady }) {
    this._queue = queue;
    this._onItemCompleted = onItemCompleted;
    this._onTilesReady = onTilesReady;
  }

  /**
   * Emit per-item status cho QueueMonitor render badge realtime.
   * Phase enum: 'monitoring' | 'fail_detected' | 'click_retry' | 'wait_retry'
   *           | 'tier2_reload' | 'tier2_resubmit' | 'completed' | 'failed' | 'partial_fail'
   */
  _emitItemStatus(item, phase, extra = {}) {
    if (!item || !window.eventBus) return;
    window.eventBus.emit('item:status', {
      itemId: item.id,
      jobId: item.jobId,
      phase,
      attempt: extra.attempt || 0,
      maxRetries: this._maxRetries,
      successCount: extra.successCount || (item.resultTileIds?.length || 0),
      failedCount: extra.failedCount || 0,
      text: extra.text || '',
      timestamp: Date.now(),
    });
  }

  /**
   * Cập nhật settings
   */
  updateSettings({ maxMonitor, timeout, maxRetries }) {
    if (maxMonitor !== undefined) this._maxConcurrent = maxMonitor;
    if (timeout !== undefined) this._timeout = timeout * 1000;
    if (maxRetries !== undefined) this._maxRetries = maxRetries;
  }

  /**
   * Bắt đầu theo dõi 1 item đã submit
   * Tự động chờ slot nếu đã đạt giới hạn đồng thời
   */
  async monitor(item) {
    // Chờ slot nếu đã đầy (timeout 200s để tránh deadlock)
    const slotTimeout = this._timeout + 20000; // timeout + 20s buffer
    while (this._activeMonitors.size >= this._maxConcurrent) {
      const monitors = Array.from(this._activeMonitors.values()).map(m => m.promise);
      if (monitors.length === 0) break; // Safety: không có promise nào để chờ
      await Promise.race([
        ...monitors,
        new Promise(r => setTimeout(r, slotTimeout)),
      ]);
    }

    item.state = QueueItem.STATE.MONITORING;
    const abortController = new AbortController();
    const promise = this._monitorItem(item, abortController.signal);
    this._activeMonitors.set(item.id, { promise, item, abortController });

    promise.finally(() => {
      this._activeMonitors.delete(item.id);
    });
  }

  /**
   * Theo dõi 1 item — chờ tiles hoàn thành hoặc thất bại
   * @param {AbortSignal} [abortSignal] - Signal để abort sớm khi job bị stop
   */
  async _monitorItem(item, abortSignal) {
    const job = this._queue?.getJob(item.jobId);

    // Kiểm tra job còn hoạt động không
    if (!job || job.state === 'stopped') {
      item.state = QueueItem.STATE.CANCELLED;
      return;
    }

    try {
      this._emitItemStatus(item, 'monitoring');

      // Gọi MessageBridge để chờ tiles mới xuất hiện (có abort signal)
      const result = await this._waitForTiles(item, abortSignal);

      // Kiểm tra lại trạng thái job (có thể đã dừng trong lúc chờ)
      if (item.state === QueueItem.STATE.CANCELLED || job.state === 'stopped') {
        return;
      }

      const expectedQuantity = parseInt(item.settings?.quantity) || 1;
      const earlyClaimedSet = new Set(item._earlyClaimedTiles || []);

      // === MRC-3.4.4: Xử lý kết quả từ _waitForTiles ===
      // _waitForTiles() đã dùng _waitClaimedTilesComplete, trả về successTids/failedTids trực tiếp
      // khi có early claimed tiles. Fallback result cũ vẫn cần xử lý.

      let successTids = result?.successTids || [];
      let failedTids = result?.failedTids || [];

      // Nếu _waitForTiles đã phân loại (có successTids/failedTids) → dùng trực tiếp
      // Nếu không (fallback path) → phải tự phân loại
      if (successTids.length === 0 && failedTids.length === 0 && result?.tiles?.length > 0) {
        // FALLBACK: result từ waitForNewTiles (flow cũ), cần claim và phân loại

        if (earlyClaimedSet.size > 0) {
          // Ưu tiên tiles đã early claimed
          result.tiles = result.tiles.filter(tid => {
            if (earlyClaimedSet.has(tid)) return true;
            const claimed = this._claimedTileIds.get(tid);
            return !claimed || claimed.jobId === item.jobId;
          });

          if (result.tiles.length > expectedQuantity) {
            result.tiles.sort((a, b) => {
              const aEarly = earlyClaimedSet.has(a) ? 0 : 1;
              const bEarly = earlyClaimedSet.has(b) ? 0 : 1;
              return aEarly - bEarly;
            });
            result.tiles = result.tiles.slice(0, expectedQuantity);
          }

          console.log(`[TileMonitor] Using ${earlyClaimedSet.size} early claimed tile(s) for item ${item.id.substring(0, 8)}`);
        } else {
          // Không có early claim → dùng submitOrder-based
          const waitStart = Date.now();
          while (Date.now() - waitStart < 5000) {
            const hasEarlier = [...this._activeMonitors.values()].some(
              m => m.item._submitOrder && item._submitOrder &&
                   m.item._submitOrder < item._submitOrder &&
                   m.item !== item &&
                   (m.item.state === 'MONITORING' || m.item.state === 'SUBMITTED')
            );
            if (!hasEarlier) break;
            await this._sleep(300);
          }

          result.tiles = result.tiles.filter(tid => {
            const claimed = this._claimedTileIds.get(tid);
            return !claimed || claimed.jobId === item.jobId;
          });

          if (result.tiles.length > expectedQuantity) {
            // [Bug fix 2026-05-10 Gap 6] slice(0, N) thay slice(-N) — same pattern Phase 3 fix.
            //   waitForNewTiles return tiles theo DOM order. Flow render newest tile ở TOP DOM
            //   (verified Phase 3 evidence — position top-left). slice(-N) lấy oldest = sai.
            //   slice(0, N) lấy newest = tile mới gen của user vừa submit.
            result.tiles = result.tiles.slice(0, expectedQuantity);
          }

          for (const tid of result.tiles) {
            this._claimedTileIds.set(tid, {
              jobId: item.jobId,
              itemId: item.id,
              claimedAt: Date.now()
            });
          }
        }

        // Phân loại tiles theo status
        for (const tid of result.tiles) {
          const status = await this._detectTileStatus(tid);
          if (status === 'failed') {
            failedTids.push(tid);
          } else {
            successTids.push(tid);
          }
        }
      }

      // Xử lý trường hợp không có tiles
      if (successTids.length === 0 && failedTids.length === 0) {
        if (earlyClaimedSet.size > 0) {
          // Có early claimed tiles nhưng completion timeout
          console.log(`[TileMonitor] Completion timeout nhưng có ${earlyClaimedSet.size} early claimed tile(s)`);
          // Classify early claimed tiles
          for (const tid of earlyClaimedSet) {
            const status = await this._detectTileStatus(tid);
            if (status === 'failed') {
              failedTids.push(tid);
            } else if (status === 'success') {
              successTids.push(tid);
            }
          }
        }

        // Vẫn không có gì sau classify
        if (successTids.length === 0 && failedTids.length === 0) {
          item.state = QueueItem.STATE.FAILED;
          item.error = 'Không phát hiện tiles mới';
          item.completedAt = Date.now();
          this._failedCount++;
          this._onItemCompleted?.(item);
          return;
        }
      }

      // Cập nhật thumbnails: chỉ giữ tiles đã claim
      if (result?.thumbnails) {
        const keptSet = new Set([...successTids, ...failedTids]);
        for (const tid of Object.keys(result.thumbnails)) {
          if (!keptSet.has(tid)) {
            delete result.thumbnails[tid];
          }
        }
      }

      console.log(`[TileMonitor] _monitorItem classified: ${successTids.length} success, ${failedTids.length} failed for item ${item.id.substring(0, 8)}`);

      if (failedTids.length === 0) {
        // Tất cả tiles thành công
        item.state = QueueItem.STATE.COMPLETED;
        item.resultTileIds = successTids;
        item.resultThumbnails = result?.thumbnails || {};
        item.tileId = successTids[0] || null;
        item.completedAt = Date.now();
        this._completedCount++;

        this._emitItemStatus(item, 'completed', { successCount: successTids.length });

        // CRITICAL: Gọi _onTilesReady TRƯỚC _onItemCompleted
        // Lý do: _onItemCompleted trigger _checkJobDone() kiểm tra hasPendingDownloads
        if (successTids.length > 0) {
          console.log(`[TileMonitor] Calling _onTilesReady with ${successTids.length} tiles:`, successTids.map(t => t.substring(0, 8)));
          this._onTilesReady?.(item, successTids);
        }

        // Rồi mới trigger job completion check
        this._onItemCompleted?.(item);
      } else {
        // Có tiles thất bại — xử lý retry
        this._emitItemStatus(item, 'fail_detected', {
          successCount: successTids.length,
          failedCount: failedTids.length,
        });
        await this._handleFailedTiles(item, result || {}, successTids, failedTids);
      }

    } catch (err) {
      // AbortError = job bị stop, không phải lỗi thật
      if (err.name === 'AbortError') {
        if (item.state !== QueueItem.STATE.CANCELLED) {
          item.state = QueueItem.STATE.CANCELLED;
        }
        return;
      }

      console.error('[TileMonitor] Lỗi theo dõi item:', err.message);
      item.state = QueueItem.STATE.FAILED;
      item.error = err.message;
      item.completedAt = Date.now();
      this._failedCount++;
      this._onItemCompleted?.(item);
    }
  }

  /**
   * MRC-3.4.3: Chờ tile MỚI xuất hiện trên DOM và claim ngay
   * Giải quyết race condition khi nhiều items cùng submit gần nhau
   * Sử dụng scanNewTiles handler để detect và claim tiles atomic
   *
   * @param {string[]} preTileIds - Baseline tile IDs trước khi submit
   * @param {number} timeoutMs - Timeout chờ tile xuất hiện (ms)
   * @param {AbortSignal} [abortSignal] - Signal để abort sớm
   * @param {number} expectedQuantity - Số tiles mong đợi (để limit claim)
   * @returns {Promise<{tile_id: string}[]>} - Array of {tile_id} objects đã claim
   */
  async _waitTileAppearance(preTileIds, timeoutMs, abortSignal, expectedQuantity = 1, preFileNames = null) {
    const startTime = Date.now();
    const pollInterval = 300; // Poll nhanh hơn (300ms) để bắt kịp tile xuất hiện
    let bestTiles = []; // Track tiles tốt nhất đã thấy

    while (Date.now() - startTime < timeoutMs) {
      // Check abort signal
      if (abortSignal?.aborted) {
        return bestTiles.length > 0 ? bestTiles : [];
      }

      try {
        // Sử dụng scanNewTiles handler để detect tiles mới
        // FIX MRC-3.4: key phải khớp với content.js handler (excludeTileIds, không phải baselineTileIds)
        // [Bug fix 2026-05-10] Truyền preFileNames để filter tiles cũ virtualize lại
        const response = await MessageBridge.sendToContentScript('scanNewTiles', {
          excludeTileIds: preTileIds || [],
          excludeFileNames: preFileNames ? Array.from(preFileNames) : []
        });

        if (response?.success && response.tiles?.length > 0) {
          bestTiles = response.tiles;

          // Đủ số lượng mong đợi → return ngay
          if (bestTiles.length >= expectedQuantity) {
            console.log(`[TileMonitor] Early detect: ${bestTiles.length}/${expectedQuantity} tile(s) sau ${Date.now() - startTime}ms`);
            return bestTiles;
          }

          // Chưa đủ → tiếp tục poll, chờ thêm tiles xuất hiện
          // (Google Flow có thể tạo tiles không đồng thời)
        }
      } catch (err) {
        console.warn('[TileMonitor] _waitTileAppearance poll error:', err.message);
      }

      await this._sleep(pollInterval);
    }

    // Timeout — trả về bao nhiêu tiles đã thấy (có thể < expectedQuantity)
    if (bestTiles.length > 0) {
      console.log(`[TileMonitor] _waitTileAppearance timeout, trả về ${bestTiles.length}/${expectedQuantity} tile(s) đã phát hiện`);
      return bestTiles;
    }

    console.log(`[TileMonitor] _waitTileAppearance timeout sau ${timeoutMs}ms, không phát hiện tile mới`);
    return [];
  }

  /**
   * MRC-3.4.4 + CONTINUOUS CLAIM FIX: Chờ tiles xuất hiện + claim liên tục + poll completion
   *
   * FIX: Khi quantity > 1, Google Flow có thể tạo tiles KHÔNG đồng thời.
   * Giải pháp: Unified loop claim tiles liên tục cho đến khi đủ hoặc settle.
   *
   * @param {Object} item - QueueItem cần theo dõi
   * @param {AbortSignal} [abortSignal] - Signal để abort
   * @returns {Promise<{tiles: string[], thumbnails: Object, failed?: boolean}>}
   */
  async _waitForTiles(item, abortSignal) {
    const expectedQuantity = parseInt(item.settings?.quantity) || 1;
    const claimedTileIds = [];

    // === CONFIG ===
    const INITIAL_WAIT = 3000;      // 3s chờ tile đầu tiên xuất hiện
    const BASE_SETTLE_DELAY = 3000; // 3s cơ bản cho settle
    const PER_TILE_SETTLE = 5000;   // +5s cho mỗi tile còn thiếu (Google Flow tạo tiles async)
    const POLL_INTERVAL = 400;      // Poll mỗi 400ms
    // Phase L: Use instance timeout with SystemConfig fallback
    const MAX_TIMEOUT = this._timeout || window.SystemConfig?.getTimeout('image_timeout_ms') || 300000;

    const startTime = Date.now();
    let lastClaimTime = 0;          // Timestamp lần claim gần nhất
    let hasAnyTile = false;         // Đã có ít nhất 1 tile chưa

    console.log(`[TileMonitor] Starting continuous claim for item ${item.id.substring(0, 8)}, expectedQuantity=${expectedQuantity}`);

    // === UNIFIED CLAIM + POLL LOOP ===
    while (Date.now() - startTime < MAX_TIMEOUT) {
      // Check abort signal
      if (abortSignal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }

      // Check job state
      const job = this._queue?.getJob(item.jobId);
      if (!job || job.state === 'stopped') {
        throw new DOMException('Aborted', 'AbortError');
      }

      try {
        // === STEP 1: Scan tiles mới và claim ===
        // [Bug fix 2026-05-10] Pass preFileNames để filter tiles cũ Flow virtualize lại với tile_id MỚI.
        //   Trước fix: excludeFileNames=[] → scanNewTiles chỉ filter tile_id → khi Flow lazy-load tiles cũ
        //   với tile_id mới → trông "new" → claim sai → download tile có sẵn.
        //   Sau fix: file_name (UUID persistent) trong baseline → filter chính xác bất kể tile_id.
        const alreadyClaimed = [...claimedTileIds, ...(item.preTileIds || [])];
        const response = await MessageBridge.sendToContentScript('scanNewTiles', {
          excludeTileIds: alreadyClaimed,
          excludeFileNames: Array.from(item.preFileNames || [])
        });

        if (response?.success && response.tiles?.length > 0) {
          // Có tiles mới chưa claim
          const remaining = expectedQuantity - claimedTileIds.length;

          if (remaining > 0) {
            // [REVERT v2 Phase 4-5] Bỏ state field detection vì không reliable.
            //   Take FIRST N tiles từ scan result. Flow render newest gen ở TOP DOM order.
            //   Phase 1 fix (excludeFileNames) vẫn active — filter tiles cũ.
            const tilesToClaim = response.tiles.length > remaining
              ? response.tiles.slice(0, remaining)
              : response.tiles;

            for (const tileObj of tilesToClaim) {
              const tid = typeof tileObj === 'string' ? tileObj : tileObj.tile_id;
              if (!tid) continue;

              // FIX: Skip duplicate trong local claimedTileIds array
              if (claimedTileIds.includes(tid)) continue;

              // Check chưa bị claim bởi job khác
              const existing = this._claimedTileIds.get(tid);
              if (!existing || existing.jobId === item.jobId) {
                this._claimedTileIds.set(tid, {
                  jobId: item.jobId,
                  itemId: item.id,
                  claimedAt: Date.now()
                });
                claimedTileIds.push(tid);
                lastClaimTime = Date.now();
                hasAnyTile = true;
                console.log(`[TileMonitor] Claimed tile ${tid.substring(0, 8)} (${claimedTileIds.length}/${expectedQuantity}) for item ${item.id.substring(0, 8)}`);
              }
            }
          }
        }

        // === STEP 2: Check completion conditions ===
        const elapsed = Date.now() - startTime;
        const timeSinceLastClaim = lastClaimTime > 0 ? (Date.now() - lastClaimTime) : elapsed;

        // Condition 1: Đủ tiles → exit loop, proceed to completion polling
        if (claimedTileIds.length >= expectedQuantity) {
          console.log(`[TileMonitor] Got all ${expectedQuantity} tile(s) for item ${item.id.substring(0, 8)} in ${elapsed}ms`);
          break;
        }

        // Condition 2: Settle - đã qua initial wait + có tiles + không có tile mới trong dynamic settle delay
        // Dynamic: chờ lâu hơn nếu còn thiếu nhiều tiles (Google Flow tạo tiles async)
        const missingTiles = expectedQuantity - claimedTileIds.length;
        const dynamicSettleDelay = BASE_SETTLE_DELAY + (missingTiles * PER_TILE_SETTLE);
        if (elapsed > INITIAL_WAIT && hasAnyTile && timeSinceLastClaim > dynamicSettleDelay) {
          // [Bug fix 2026-05-10 Gap 4] WARN nếu claim < expected (user kỳ vọng N tiles, nhận M < N).
          //   Trước fix dùng console.log → user không biết workflow incomplete.
          //   Cause khả thi: Flow gen chậm > settle delay, hoặc Flow lỗi tile sau, hoặc settle quá ngắn.
          if (claimedTileIds.length < expectedQuantity) {
            console.warn(`[TileMonitor] ⚠️ INCOMPLETE: settled with only ${claimedTileIds.length}/${expectedQuantity} tile(s) for item ${item.id.substring(0, 8)} — Flow gen có thể chậm hơn settle delay (${dynamicSettleDelay}ms). User nhận thiếu ${expectedQuantity - claimedTileIds.length} tile.`);
          } else {
            console.log(`[TileMonitor] Settled with ${claimedTileIds.length}/${expectedQuantity} tile(s) for item ${item.id.substring(0, 8)} (no new tiles in ${dynamicSettleDelay}ms)`);
          }
          break;
        }

        // Condition 3: Initial wait passed + no tiles → keep waiting (Google Flow có thể chậm)
        // Không break, tiếp tục poll

      } catch (err) {
        if (err.name === 'AbortError') throw err;
        console.warn('[TileMonitor] Continuous claim poll error:', err.message);
      }

      await this._sleep(POLL_INTERVAL);
    }

    // Lưu tiles đã claim để _monitorItem sử dụng
    item._earlyClaimedTiles = [...claimedTileIds];

    // === PHASE 2: WAIT FOR COMPLETION — Poll tiles đã claim đến khi settle ===
    if (claimedTileIds.length > 0) {
      console.log(`[TileMonitor] Waiting for ${claimedTileIds.length} claimed tile(s) to complete:`, claimedTileIds.map(t => t.substring(0, 8)));

      const remainingTimeout = Math.max(MAX_TIMEOUT - (Date.now() - startTime), 30000);
      // Truyền item → _waitClaimedTilesComplete dùng preTileIds/preFileNames re-scan tile gen mới
      // khi tile claim bị Flow đổi ID (DOM-gen heartbeat, tránh fail sớm video đang gen).
      const completionResult = await this._waitClaimedTilesComplete(
        claimedTileIds,
        remainingTimeout,
        item
      );

      console.log(`[TileMonitor] _waitForTiles returning: ${completionResult.success.length} success, ${completionResult.failed.length} failed`);

      // Chuyển đổi format để tương thích với code cũ
      const allTiles = [...completionResult.success, ...completionResult.failed];
      return {
        tiles: allTiles,
        thumbnails: completionResult.thumbnails,
        failed: completionResult.failed.length > 0,
        successTids: completionResult.success,
        failedTids: completionResult.failed
      };
    }

    // === FALLBACK: Không có tiles nào được claim → dùng flow cũ ===
    console.log(`[TileMonitor] No tiles claimed, falling back to waitForNewTiles for item ${item.id.substring(0, 8)}`);

    const tilePromise = MessageBridge.waitForNewTiles(
      item.preTileIds,
      this._timeout,
      {
        captureFileNames: true,
        preFileNames: item.preFileNames,
      }
    );

    // Nếu không có abort signal, chạy bình thường
    if (!abortSignal) return tilePromise;

    // Race: tile result vs abort
    return Promise.race([
      tilePromise,
      new Promise((_, reject) => {
        if (abortSignal.aborted) {
          reject(new DOMException('Aborted', 'AbortError'));
          return;
        }
        abortSignal.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        }, { once: true });
      }),
    ]);
  }

  /**
   * MRC-3.4.5: Xử lý tiles thất bại — Tier 1: Button retry với per-item tracking
   * Sau button retry, claim tiles mới và dùng _waitClaimedTilesComplete
   *
   * @param {Object} result - Kết quả từ _waitForTiles
   * @param {string[]} successTids - Tiles đã xác nhận thành công (classified bởi _monitorItem)
   * @param {string[]} failedTids - Tiles đã xác nhận thất bại (classified bởi _monitorItem)
   */
  async _handleFailedTiles(item, result, successTids, failedTids) {
    // Tiles đã được claim bởi _monitorItem (đồng bộ, trước khi vào đây)
    // Không cần claim lại

    // Track tất cả tiles thuộc item này (gốc + retry) để exclude đúng
    const itemOwnTileIds = [...(result.tiles || [])];

    // Merge thumbnails từ result vào item
    if (!item.resultThumbnails) item.resultThumbnails = {};
    if (result.thumbnails) {
      Object.assign(item.resultThumbnails, result.thumbnails);
    }

    // Tải xuống tiles thành công ngay (TRƯỚC _onItemCompleted)
    if (successTids.length > 0) {
      if (!item.resultTileIds) item.resultTileIds = [];
      item.resultTileIds.push(...successTids);
      this._onTilesReady?.(item, successTids);
    }

    // Tier 1: Click nút "Thử lại" trên tiles thất bại, loop maxRetries lần
    let remainingFailed = [...failedTids];
    let totalRetrySucceeded = 0;
    if (remainingFailed.length > 0 && this._maxRetries > 0) {
      for (let attempt = 1; attempt <= this._maxRetries && remainingFailed.length > 0; attempt++) {
        // Kiểm tra job có bị dừng trong lúc retry không
        const retryJob = this._queue?.getJob(item.jobId);
        if (!retryJob || retryJob.state === 'stopped' || item.state === QueueItem.STATE.CANCELLED) {
          break;
        }

        // Emit retry status cho UI
        window.eventBus?.emit('retry:status', { text: `Click Retry (${attempt}/${this._maxRetries})` });
        this._emitItemStatus(item, 'click_retry', {
          attempt,
          successCount: successTids.length + totalRetrySucceeded,
          failedCount: remainingFailed.length,
        });

        // Click retry buttons và lấy baseline tiles mới tạo
        const retryResult = await this._retryViaButton(remainingFailed, itemOwnTileIds);

        // Emit phase chính xác dựa trên clickedCount:
        // - clickedCount > 0 → đã click thật, đang chờ tile mới complete
        // - clickedCount === 0 → skip click (tile đã click trước hoặc button không tìm thấy)
        const clickedCount = retryResult?.clickedCount || 0;
        const phaseAfterCall = clickedCount > 0 ? 'wait_retry' : 'retry_skipped';
        this._emitItemStatus(item, phaseAfterCall, {
          attempt,
          successCount: successTids.length + totalRetrySucceeded,
          failedCount: remainingFailed.length,
          text: clickedCount > 0
            ? `Đã click ${clickedCount}, chờ tile`
            : `Skip click (đã click trước)`,
        });

        if (retryResult?.newTileIds?.length > 0) {
          // Claim retry tiles ngay lập tức
          const retryClaimedTileIds = [];
          for (const tid of retryResult.newTileIds) {
            const existing = this._claimedTileIds.get(tid);
            if (!existing || existing.jobId === item.jobId) {
              this._claimedTileIds.set(tid, {
                jobId: item.jobId,
                itemId: item.id,
                claimedAt: Date.now()
              });
              retryClaimedTileIds.push(tid);
              itemOwnTileIds.push(tid); // Track cho lần retry tiếp
            }
          }

          // Chờ retry tiles hoàn thành bằng _waitClaimedTilesComplete
          if (retryClaimedTileIds.length > 0) {
            const retryCompletion = await this._waitClaimedTilesComplete(
              retryClaimedTileIds,
              60000 // 60s timeout cho mỗi retry round
            );

            // Merge results
            if (retryCompletion.success.length > 0) {
              item.resultTileIds.push(...retryCompletion.success);
              Object.assign(item.resultThumbnails, retryCompletion.thumbnails);
              this._onTilesReady?.(item, retryCompletion.success);
              totalRetrySucceeded += retryCompletion.success.length;
            }

            // Cập nhật remaining failed cho lần retry tiếp
            remainingFailed = retryCompletion.failed;
          }
        } else if (retryResult?.succeeded?.length > 0) {
          // Fallback cho legacy retryViaButton format
          // Claim tiles trước
          for (const tid of retryResult.succeeded) {
            this._claimedTileIds.set(tid, {
              jobId: item.jobId,
              itemId: item.id,
              claimedAt: Date.now()
            });
            itemOwnTileIds.push(tid);
          }

          // FIX: Fetch thumbnails cho legacy retry tiles (giống NEW path)
          // Dùng _waitClaimedTilesComplete để lấy thumbnail info
          const legacyCompletion = await this._waitClaimedTilesComplete(
            retryResult.succeeded,
            30000 // 30s timeout - tiles đã success nên sẽ return nhanh
          );

          // Merge thumbnails vào item
          if (legacyCompletion.success.length > 0) {
            item.resultTileIds.push(...legacyCompletion.success);
            Object.assign(item.resultThumbnails, legacyCompletion.thumbnails);
            this._onTilesReady?.(item, legacyCompletion.success);
            totalRetrySucceeded += legacyCompletion.success.length;
          }

          // Cập nhật remaining failed (include tiles bị fail trong completion check)
          remainingFailed = [
            ...(retryResult?.stillFailed || []),
            ...legacyCompletion.failed
          ];
        } else {
          // Retry KHÔNG tạo tiles mới (timeout hoặc click fail). Giữ nguyên remainingFailed
          // cho attempt tiếp theo — KHÔNG dùng `retryResult.stillFailed || remainingFailed` vì
          // `[]` (empty array) is truthy → drop list → loop exit sớm sau attempt 1 →
          // bypass attempt 2/2 → vào Tier 2 luôn (bug user observe).
          // Chỉ override nếu stillFailed có entries (signal thực sự "đã settle ở những tile này").
          if (Array.isArray(retryResult?.stillFailed) && retryResult.stillFailed.length > 0) {
            remainingFailed = retryResult.stillFailed;
          }
          // else: keep remainingFailed cũ → retry attempt 2 chạy được.
        }

        // Tất cả đã thành công → dừng retry
        if (remainingFailed.length === 0) break;
      }

      // Kiểm tra job trước khi Tier 2 fallback submit
      const fallbackJob = this._queue?.getJob(item.jobId);
      if (!fallbackJob || fallbackJob.state === 'stopped' || item.state === QueueItem.STATE.CANCELLED) {
        // Job đã bị dừng — không fallback submit, kết thúc ngay
        if (item.state !== QueueItem.STATE.CANCELLED) {
          item.state = QueueItem.STATE.CANCELLED;
        }
        return;
      }

      // Tier 2: Fallback submit CHỈ khi 0 success từ cả original + retry
      // (KHÔNG check remainingFailed.length > 0 — content.js retryFailedTilesViaButton
      // có thể trả [] cho cả succeeded + stillFailed khi click retry OK nhưng Flow chậm
      // tạo tile mới trong timeout. Trường hợp đó remainingFailed=[] sai nghĩa là "đã xong"
      // → skip Tier 2 sai. Đúng: dùng totalSucceeded === 0 làm discriminator duy nhất —
      // nếu không có tile nào success suốt original + Tier 1 retry → cần fallback resubmit.)
      const totalSucceeded = successTids.length + totalRetrySucceeded;
      if (totalSucceeded === 0 && this._maxRetries > 0) {
        // Reload Flow page TRƯỚC fallback submit để reset editor state.
        // Lý do: Tier 1 button retry hết maxRetries vẫn fail thường ngụ ý Slate editor /
        // React state corrupted (DOM stale, event listener leak, memory pressure). Reload
        // hoàn toàn → chờ editor ready → Tier 2 fallback có DOM sạch để submit lại.
        // Job stop check: nếu user dừng giữa reload → KHÔNG fallback submit nữa.
        if (this._queue?.forceReloadAndStabilize) {
          window.eventBus?.emit('retry:status', { text: 'Reload Flow page...' });
          this._emitItemStatus(item, 'tier2_reload', { failedCount: remainingFailed.length });
          try {
            await this._queue.forceReloadAndStabilize('tier2-fallback');
          } catch (e) {
            console.warn('[TileMonitor] forceReload before fallback failed (degrade):', e.message);
          }

          // Re-check job state sau reload (user có thể đã stop)
          const postReloadJob = this._queue?.getJob(item.jobId);
          if (!postReloadJob || postReloadJob.state === 'stopped' || item.state === QueueItem.STATE.CANCELLED) {
            if (item.state !== QueueItem.STATE.CANCELLED) {
              item.state = QueueItem.STATE.CANCELLED;
            }
            return;
          }
        }

        // Emit retry status cho UI
        window.eventBus?.emit('retry:status', { text: 'Gửi lại Prompt' });
        this._emitItemStatus(item, 'tier2_resubmit', { failedCount: remainingFailed.length });
        this._requestFallbackSubmit(item);
        return;
      }
    }

    // Kết thúc: COMPLETED, PARTIAL_FAIL, hoặc FAILED
    const remainingFailedCount = remainingFailed.length;
    if (item.resultTileIds && item.resultTileIds.length > 0) {
      item.state = remainingFailedCount > 0 ? QueueItem.STATE.PARTIAL_FAIL : QueueItem.STATE.COMPLETED;
      item.tileId = item.resultTileIds[0] || null;
      this._completedCount++;
      this._emitItemStatus(item, remainingFailedCount > 0 ? 'partial_fail' : 'completed', {
        successCount: item.resultTileIds.length,
        failedCount: remainingFailedCount,
      });
    } else {
      item.state = QueueItem.STATE.FAILED;
      this._failedCount++;
      this._emitItemStatus(item, 'failed', { failedCount: remainingFailedCount || failedTids.length });
    }

    item.completedAt = Date.now();
    this._onItemCompleted?.(item);
  }

  /**
   * Tier 1: Click nút retry trên tiles thất bại (không cần editor)
   * Dùng MessageBridge.sendToContentScript để giao tiếp với content.js
   */
  async _retryViaButton(failedTids, itemOwnTileIds) {
    try {
      // Truyền excludeTileIds = tiles claimed bởi items KHÁC (không include item đang retry)
      // Lý do: retry tạo tile MỚI (Flow UUID), nhưng waitForNewTiles có thể bắt nhầm
      // tiles mới từ items khác đang submit đồng thời
      const ownTileSet = new Set(itemOwnTileIds || []);
      const excludeTileIds = Array.from(this._claimedTileIds.keys()).filter(tid => !ownTileSet.has(tid));
      const resp = await MessageBridge.sendToContentScript('retryFailedTilesViaButton', {
        failedTileIds: failedTids,
        timeout: this._timeout,
        excludeTileIds,
      });
      return resp || { succeeded: [], stillFailed: failedTids };
    } catch (err) {
      console.warn('[TileMonitor] Retry via button thất bại:', err.message);
      return { succeeded: [], stillFailed: failedTids };
    }
  }

  /**
   * Kiểm tra trạng thái của 1 tile qua content.js
   */
  async _detectTileStatus(tileId) {
    try {
      const resp = await MessageBridge.sendToContentScript('detectTileStatus', { tileId });
      return resp?.status || 'failed';
    } catch (err) {
      console.warn('[TileMonitor] Không thể kiểm tra trạng thái tile:', err.message);
      return 'failed';
    }
  }

  /**
   * Tier 2: Yêu cầu submit lại — đưa item về hàng đợi EditorExecutor
   * Chỉ cho phép retry submit tối đa 1 lần để tránh nhân chéo retry budget
   */
  _requestFallbackSubmit(item) {
    // Chỉ cho phép fallback submit nếu chưa vượt budget (thống nhất với EditorExecutor: < 1)
    if (item.retrySubmitCount < 1) {
      item.retrySubmitCount++;
      item.state = QueueItem.STATE.RETRY_SUBMIT;
      item.priority = 100; // Ưu tiên cao cho retry
      this._queue?.enqueue(item);
    } else {
      item.state = QueueItem.STATE.FAILED;
      item.completedAt = Date.now();
      this._failedCount++;
      this._onItemCompleted?.(item);
    }
  }

  /**
   * Hủy tất cả monitors thuộc 1 job
   * Không abort waitForNewTiles (tiles đang gen trên Flow)
   * Chỉ đánh dấu cancelled -> khi monitor xong sẽ bỏ qua
   */
  abortJob(jobId) {
    const toRemove = [];
    for (const [itemId, monitor] of this._activeMonitors) {
      if (monitor.item.jobId === jobId) {
        monitor.item.state = QueueItem.STATE.CANCELLED;
        // Abort waitForNewTiles sớm (không chờ hết timeout 180s)
        monitor.abortController?.abort();
        toRemove.push(itemId);
      }
    }
    // Giải phóng slot ngay
    for (const id of toRemove) {
      this._activeMonitors.delete(id);
    }
  }

  /**
   * Dừng tất cả monitors
   */
  stopAll() {
    for (const [, monitor] of this._activeMonitors) {
      monitor.item.state = QueueItem.STATE.CANCELLED;
      // Abort tất cả waitForNewTiles đang chạy
      monitor.abortController?.abort();
    }
    // Giải phóng tất cả slots ngay lập tức
    this._activeMonitors.clear();
  }

  /**
   * Clear claimed tiles map (cần thiết khi pipeline rỗng để giải phóng memory).
   * KHÔNG reset _completedCount/_failedCount — counter dùng cho display, giữ
   * cumulative đến khi user submit job mới hoặc reload extension. Reset counter
   * sớm khiến QueueMonitor TILES "0 active / 0 done / 0 failed" trong khi user
   * vẫn thấy items COMPLETED trong list → contradictory UX.
   */
  reset() {
    this._claimedTileIds.clear();
  }

  /**
   * Reset counter về 0 — gọi khi user submit job MỚI (clean slate cho session mới).
   */
  resetCounters() {
    this._completedCount = 0;
    this._failedCount = 0;
  }

  /**
   * Helper: Sleep async
   * @param {number} ms - Milliseconds to sleep
   * @returns {Promise<void>}
   */
  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * MRC-3.4.2: Chờ các tiles đã claim hoàn thành (success hoặc failed)
   * KHÔNG chờ tiles khác, CHỈ poll tiles trong claimedTileIds
   *
   * @param {string[]} claimedTileIds - Tiles đã claim cho item này
   * @param {number} timeoutMs - Timeout (default 180s)
   * @returns {Promise<{success: string[], failed: string[], thumbnails: Object}>}
   */
  async _waitClaimedTilesComplete(claimedTileIds, timeoutMs = 180000, item = null) {
    const startTime = Date.now();
    const pollInterval = 500;  // Poll mỗi 500ms
    // Bug fix 2026-05-28: tile video placeholder claim sớm bị Flow ĐỔI ID khi gen thật bắt đầu →
    // ID cũ not_found → fail SỚM dù video VẪN đang gen (user thấy gen chạy nhưng GenTab báo fail).
    // DOM-gen HEARTBEAT thay timeout cứng: trước khi finalize fail, check getPendingTileCount
    // (page còn tile gen?). Còn gen → re-scan tile mới + swap vào watch (KHÔNG fail) + GIA HẠN deadline.
    // Chỉ finalize fail khi page HẾT gen + grace. Abs cap = safety chống treo.
    const GEN_GRACE_MS = 12000;                          // page hết gen → chờ 12s mới finalize fail
    const MAX_READOPT = 6;                               // giới hạn swap ID stale (tránh loop)
    const ABS_CAP_MS = Math.max(timeoutMs, 1200000);     // hard cap 20 phút (an toàn)
    const GEN_EXTEND_MS = 60000;                         // còn gen → gia hạn deadline 60s rolling

    let watchIds = [...new Set(claimedTileIds)];
    const successSet = new Set();
    const thumbnails = {};
    let lastGenActiveAt = Date.now();
    let reAdoptCount = 0;
    let deadline = startTime + timeoutMs;

    while (Date.now() < deadline && Date.now() - startTime < ABS_CAP_MS) {
      // Check abort signal
      if (this._abortController?.signal.aborted) {
        throw new Error('Aborted');
      }

      // Poll status của các tiles đang watch
      const response = await MessageBridge.sendToContentScript('getTileStatuses', {
        tileIds: watchIds
      });

      if (!response?.success || !response.statuses) {
        await this._sleep(pollInterval);
        continue;
      }

      const statuses = response.statuses;
      const failedNow = [];
      const processing = [];

      for (const tileId of watchIds) {
        // Đã success → GIỮ (kết quả đã chốt + thumbnail đã lưu). Tránh DOM virtualize (scroll) khiến
        // tile success đọc lại 'not_found' → bị đẩy sang failed → TRÙNG ở cả success lẫn failed.
        if (successSet.has(tileId)) continue;
        const info = statuses[tileId];
        if (info?.status === 'success') {
          successSet.add(tileId);
          thumbnails[tileId] = {
            thumbnail: info.thumbnail,
            type: info.type,
            file_name: info.file_name,
            ...(info.video_url && { video_url: info.video_url })  // Include video_url for video tiles
          };
        } else if (!info || info.status === 'not_found' || info.status === 'failed') {
          failedNow.push(tileId);
        } else {
          processing.push(tileId);  // 'processing'
        }
      }

      // Còn tiles đang processing → tiếp tục poll. Gia hạn deadline CHỈ cho main path (item != null);
      // retry/legacy path (item=null) giữ timeout BOUNDED (60s/30s) — không extend tránh chờ lê thê.
      if (processing.length > 0) {
        lastGenActiveAt = Date.now();
        if (item) deadline = Math.max(deadline, Date.now() + GEN_EXTEND_MS);
        await this._sleep(pollInterval);
        continue;
      }

      // Watch tiles settle, KHÔNG còn fail → done
      if (failedNow.length === 0) {
        console.log(`[TileMonitor] _waitClaimedTilesComplete done: ${successSet.size} success, 0 failed`);
        return { success: [...successSet], failed: [], thumbnails };
      }

      // Retry/legacy path (item=null): KHÔNG dùng heartbeat/re-adopt (tile retry freshly claimed,
      // không kỳ vọng đổi ID) → finalize fail ngay khi settle, giữ hành vi bounded cũ.
      if (!item) {
        console.log(`[TileMonitor] _waitClaimedTilesComplete done: ${successSet.size} success, ${failedNow.length} failed (no-heartbeat path)`);
        return { success: [...successSet], failed: failedNow, thumbnails };
      }

      // Main path có fail → DOM-gen heartbeat.
      // LỚP 1: đếm CHỈ tile gen CHƯA-AI-CLAIM (loại _claimedTileIds) → monitor A không "kẹt chờ"
      // gen của B (tile B đã claim → không tính), chỉ "sống" khi có gen orphan = replacement của A.
      let pending = 0;
      try {
        pending = (await MessageBridge.sendToContentScript('getPendingTileCount', {
          excludeClaimedTileIds: [...this._claimedTileIds.keys()],
        }))?.count || 0;
      } catch (_) { /* heartbeat best-effort */ }

      if (pending > 0) {
        lastGenActiveAt = Date.now();
        deadline = Math.max(deadline, Date.now() + GEN_EXTEND_MS);

        // LỚP 2 (chống cướp tile): chỉ re-adopt khi KHÔNG có monitor submit TRƯỚC đang active
        // (mình là gen sớm nhất → tile orphan thuộc về mình theo FIFO). Monitor sau nhường —
        // tránh giành tile của nhau khi nhiều gen đổi ID cùng lúc (Flow không gắn nhãn tile/submit).
        // Cùng heuristic _submitOrder với fallback path (_monitorItem) để nhất quán.
        const hasEarlierActive = [...this._activeMonitors.values()].some(
          m => m.item !== item && m.item._submitOrder && item._submitOrder
            && m.item._submitOrder < item._submitOrder
            && (m.item.state === QueueItem.STATE.MONITORING || m.item.state === QueueItem.STATE.SUBMITTED)
        );

        // Tile đã claim bị Flow đổi ID (video) → re-scan tile gen mới, swap vào watch (giữ success).
        if (item && !hasEarlierActive && reAdoptCount < MAX_READOPT) {
          try {
            const scan = await MessageBridge.sendToContentScript('scanNewTiles', {
              excludeTileIds: [...watchIds, ...successSet, ...(item.preTileIds || [])],
              excludeFileNames: Array.from(item.preFileNames || []),
            });
            const fresh = (scan?.tiles || [])
              .map(t => (typeof t === 'string' ? t : t.tile_id))
              .filter(id => id && !successSet.has(id))
              // CONCURRENCY-SAFE: chỉ adopt tile CHƯA bị item KHÁC claim → tránh 2 monitor (batch/
              // nhiều prompt chạy song song) cướp tile của nhau. Tile owned bởi item này thì OK.
              .filter(id => {
                const owner = this._claimedTileIds.get(id);
                return !owner || owner.itemId === item.id;
              });
            if (fresh.length > 0) {
              reAdoptCount++;
              const adopt = fresh.slice(0, Math.max(failedNow.length, 1));
              // Claim tile mới cho item này (ghi _claimedTileIds) → monitor khác sẽ skip.
              for (const tid of adopt) {
                this._claimedTileIds.set(tid, { jobId: item.jobId, itemId: item.id, claimedAt: Date.now() });
              }
              watchIds = [...successSet, ...adopt];
              console.log(`[TileMonitor] Re-adopt: claimed tile stale (Flow đổi ID), page còn gen (pending=${pending}) → claim+watch ${adopt.map(t => t.substring(0, 8)).join(',')}`);
              await this._sleep(pollInterval);
              continue;
            }
          } catch (_) { /* re-scan best-effort */ }
        }
        // Còn gen nhưng (chưa thấy tile mới | nhường monitor submit trước) → chờ tiếp.
        // KHÔNG fail (heartbeat alive), KHÔNG cướp tile của monitor khác.
        await this._sleep(pollInterval);
        continue;
      }

      // Page HẾT gen. Grace: nếu vừa mới còn gen → chờ thêm (tile có thể vừa swap/render).
      if (Date.now() - lastGenActiveAt < GEN_GRACE_MS) {
        await this._sleep(pollInterval);
        continue;
      }

      // Finalize: page hết gen + grace qua → fail thật.
      console.log(`[TileMonitor] _waitClaimedTilesComplete done: ${successSet.size} success, ${failedNow.length} failed (page hết gen)`);
      return { success: [...successSet], failed: failedNow, thumbnails };
    }

    // Timeout (abs cap / hết gia hạn) → get final status, treat processing as failed
    console.warn('[TileMonitor] _waitClaimedTilesComplete timeout, treating processing as failed');
    const finalResponse = await MessageBridge.sendToContentScript('getTileStatuses', {
      tileIds: watchIds
    });

    const failed = [];
    for (const tileId of watchIds) {
      if (successSet.has(tileId)) continue;  // đã success → giữ, không đẩy sang failed (tránh trùng)
      const info = finalResponse?.statuses?.[tileId];
      if (info?.status === 'success') {
        successSet.add(tileId);
        thumbnails[tileId] = {
          thumbnail: info.thumbnail,
          type: info.type,
          file_name: info.file_name,
          ...(info.video_url && { video_url: info.video_url })  // Include video_url for video tiles
        };
      } else {
        failed.push(tileId);
      }
    }

    return { success: [...successSet], failed, thumbnails };
  }

  // --- Getters cho UI ---

  get activeCount() {
    return this._activeMonitors.size;
  }

  get completedCount() {
    return this._completedCount;
  }

  get failedCount() {
    return this._failedCount;
  }
}
