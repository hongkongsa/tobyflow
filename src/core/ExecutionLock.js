/**
 * ExecutionLock - Quản lý quyền truy cập Google Flow
 *
 * Tại mỗi thời điểm chỉ có 1 tác vụ được sử dụng Flow editor.
 * Các tác vụ khác phải chờ hoặc yêu cầu dừng tác vụ hiện tại.
 *
 * Owner types: 'prompts' | 'task' | 'workflow' | 'angles' | 'effects' | 'queue'
 */
class ExecutionLock {
  static _owner = null;    // 'prompts' | 'task' | 'workflow' | 'angles' | 'queue' | null
  static _label = '';      // Tên hiển thị: "Task: Tạo ảnh SP" | "Workflow: Banner"
  static _lockedAt = null; // Timestamp

  /**
   * Lấy trạng thái lock hiện tại
   */
  static getState() {
    return {
      locked: this._owner !== null,
      owner: this._owner,
      label: this._label,
      lockedAt: this._lockedAt
    };
  }

  /**
   * Thử acquire lock. Trả về true nếu thành công.
   * @param {string} owner - 'prompts' | 'task' | 'workflow'
   * @param {string} label - Tên hiển thị cho UI
   * @returns {boolean}
   */
  static acquire(owner, label = '') {
    if (this._owner === null) {
      this._owner = owner;
      this._label = label;
      this._lockedAt = Date.now();
      this._emitChange();
      return true;
    }

    // Cùng owner type → cho phép (ví dụ: task batch chạy nhiều tasks)
    if (this._owner === owner) {
      this._label = label;
      return true;
    }

    // Pipeline mode bật → cho phép nhiều source hoạt động đồng thời
    // PromptQueue orchestrate xen kẽ prompts, không cần exclusive lock
    if (window.PromptQueue && PromptQueue.isEnabled()) {
      return true;
    }

    return false;
  }

  /**
   * Giải phóng lock
   * @param {string} owner - Chỉ owner hiện tại mới được release
   */
  static release(owner) {
    if (this._owner === owner) {
      this._owner = null;
      this._label = '';
      this._lockedAt = null;
      this._emitChange();
    }
  }

  /**
   * Force release (dùng khi stop tác vụ đang chạy)
   */
  static forceRelease() {
    this._owner = null;
    this._label = '';
    this._lockedAt = null;
    this._emitChange();
  }

  /**
   * Kiểm tra có bị lock bởi owner khác không
   * @param {string} owner - Owner muốn kiểm tra
   * @returns {boolean} true nếu đang bị block
   */
  static isBlockedBy(owner) {
    // Pipeline mode bật → không block, cho phép enqueue vào queue
    if (window.PromptQueue && PromptQueue.isEnabled()) {
      return false;
    }
    // Pipeline đang chạy (owner='queue') → không chặn các owner khác enqueue
    if (this._owner === 'queue') return false;
    return this._owner !== null && this._owner !== owner;
  }

  /**
   * Kiểm tra có đang ở chế độ pipeline queue không
   */
  static isQueueMode() {
    return this._owner === 'queue';
  }

  /**
   * Hiển thị dialog khi bị block
   * @param {string} requestingOwner - Owner đang muốn chạy
   * @returns {Promise<boolean>} true nếu user chọn "Dừng & chạy mới"
   */
  static async showBlockedDialog(requestingOwner) {
    const ownerLabels = {
      prompts: 'Prompt',
      task: 'Task',
      workflow: 'Workflow',
      angles: 'Angles',
      effects: 'Effects',
      queue: 'Queue'
    };

    const currentLabel = this._label || ownerLabels[this._owner] || this._owner;
    const requestLabel = ownerLabels[requestingOwner] || requestingOwner;

    if (!window.customDialog) {
      console.warn('[ExecutionLock] customDialog chưa sẵn sàng');
      return false;
    }

    const result = await window.customDialog.confirm(
      window.I18n?.t('exec.flowBusyMessage', { label: currentLabel }) || `Đang chạy: ${currentLabel}\n\nBạn cần dừng tác vụ hiện tại trước khi chạy ${requestLabel}.`,
      {
        title: window.I18n?.t('msg.flowBusy') || 'Google Flow đang bận',
        confirmText: window.I18n?.t('exec.stopAndContinue') || 'Dừng và chạy mới',
        cancelText: window.I18n?.t('common.cancel') || 'Hủy'
      }
    );

    return result;
  }

  /**
   * Dừng tác vụ hiện tại
   * @returns {Promise<boolean>} true nếu dừng thành công
   */
  static async stopCurrent() {
    if (!this._owner) return true;

    const owner = this._owner;

    try {
      if (owner === 'prompts') {
        // Dừng prompt execution
        if (window.MessageBridge) {
          await MessageBridge.stopExecution().catch(() => {});
        }
      } else if (owner === 'task') {
        // Dừng task execution
        window._taskShouldStop = true;
        window._taskBatchStopped = true;
        if (window.MessageBridge) {
          await MessageBridge.stopExecution().catch(() => {});
        }
        if (window.eventBus) {
          window.eventBus.emit('tasks:stop_all');
        }
      } else if (owner === 'workflow') {
        // Dừng workflow execution
        if (window.workflowExecutor) {
          await window.workflowExecutor.stop();
        }
      } else if (owner === 'angles') {
        // Dừng angles execution
        if (window.angleExecution) {
          window.angleExecution.stop();
        }
        if (window.MessageBridge) {
          await MessageBridge.stopExecution().catch(() => {});
        }
      } else if (owner === 'effects') {
        // Dừng effects execution
        if (window.effectsExecution) {
          window.effectsExecution.stop();
        }
        if (window.MessageBridge) {
          await MessageBridge.stopExecution().catch(() => {});
        }
      } else if (owner === 'queue') {
        // Dừng toàn bộ pipeline queue
        window.eventBus?.emit('queue:stop_all');
      }

      // Chờ một chút để tác vụ thực sự dừng
      await new Promise(resolve => setTimeout(resolve, 500));
      this.forceRelease();
      return true;
    } catch (err) {
      console.error('[ExecutionLock] Lỗi khi dừng tác vụ:', err);
      this.forceRelease();
      return true;
    }
  }

  /**
   * Broadcast tracker update cross-window
   * Gọi từ popup windows (angles, effects, workflow) để sidePanel nhận
   */
  static broadcastTracker(data) {
    if (window.eventBus) {
      window.eventBus.emit('execution:tracker_update', data);
    }
    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      chrome.runtime.sendMessage({
        action: 'execution:tracker_broadcast',
        data,
        _originId: this._contextId,
      }).catch(() => {});
    }
  }

  /**
   * Emit event khi trạng thái thay đổi
   * Broadcast cross-window qua chrome.runtime.sendMessage
   */
  static _emitChange() {
    const state = this.getState();
    if (window.eventBus) {
      window.eventBus.emit('execution:lock_changed', state);
    }
    // Broadcast đến các window khác (sidePanel ↔ popup windows)
    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      chrome.runtime.sendMessage({
        action: 'execution:lock_broadcast',
        state,
        _originId: this._contextId,
      }).catch(() => {});
    }
  }
}

// Unique context ID per browser context (sidebar, popup window, etc).
// Background relay broadcasts đến TẤT CẢ contexts kể cả sender → self-echo.
// Receiver dùng _originId để filter: nếu broadcast từ chính mình → skip local re-emit
// (vì local eventBus đã emit ngay trong _emitChange/broadcastTracker rồi).
ExecutionLock._contextId = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

window.ExecutionLock = ExecutionLock;
