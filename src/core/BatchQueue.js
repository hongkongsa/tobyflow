/**
 * BatchQueue - Queue system cho batch tasks auto-run tuần tự
 * Xếp hàng prompts, tasks, workflows và chạy lần lượt
 */

(function() {
  'use strict';

  class BatchQueue {
    constructor() {
      this.queue = [];
      this.isRunning = false;
      this.isPaused = false;
      this.currentIndex = -1;
      this._completedCount = 0;
    }

    /**
     * Thêm item vào queue
     * @param {Object} item - { type: 'prompt'|'task'|'workflow', data: any, priority: number, name: string }
     */
    add(item) {
      const queueItem = {
        id: Date.now() + '_' + Math.random().toString(36).substr(2, 6),
        type: item.type || 'prompt',
        data: item.data,
        priority: item.priority || 0,
        name: item.name || this._getDefaultName(item),
        status: 'pending', // pending | running | completed | failed
        addedAt: Date.now(),
      };

      this.queue.push(queueItem);

      // Sort by priority (higher first)
      this.queue.sort((a, b) => b.priority - a.priority);

      window.eventBus.emit('queue:changed', { queue: this.queue });
      console.log('[TobyFlow] Queue: added item', queueItem.name);
      return queueItem;
    }

    /**
     * Xóa item khỏi queue theo index
     */
    remove(index) {
      if (index < 0 || index >= this.queue.length) return;

      // Không cho xóa item đang chạy
      if (this.isRunning && index === this.currentIndex) {
        console.log('[TobyFlow] Queue: cannot remove running item');
        return;
      }

      const removed = this.queue.splice(index, 1)[0];

      // Adjust currentIndex if needed
      if (this.isRunning && index < this.currentIndex) {
        this.currentIndex--;
      }

      window.eventBus.emit('queue:changed', { queue: this.queue });
      console.log('[TobyFlow] Queue: removed item', removed.name);
    }

    /**
     * Di chuyển item trong queue
     */
    reorder(fromIndex, toIndex) {
      if (fromIndex < 0 || fromIndex >= this.queue.length) return;
      if (toIndex < 0 || toIndex >= this.queue.length) return;
      if (fromIndex === toIndex) return;

      const item = this.queue.splice(fromIndex, 1)[0];
      this.queue.splice(toIndex, 0, item);

      window.eventBus.emit('queue:changed', { queue: this.queue });
    }

    /**
     * Bắt đầu chạy queue tuần tự
     */
    async start() {
      if (this.isRunning) {
        console.log('[TobyFlow] Queue: already running');
        return;
      }
      if (this.queue.length === 0) {
        console.log('[TobyFlow] Queue: empty, nothing to run');
        return;
      }

      this.isRunning = true;
      this.isPaused = false;
      this.currentIndex = 0;
      this._completedCount = 0;

      window.eventBus.emit('queue:started', {
        total: this.queue.length,
      });
      console.log('[TobyFlow] Queue: started, total items:', this.queue.length);

      await this._runNext();
    }

    /**
     * Tạm dừng (chờ item hiện tại xong rồi dừng)
     */
    pause() {
      if (!this.isRunning || this.isPaused) return;
      this.isPaused = true;
      window.eventBus.emit('queue:paused', {
        currentIndex: this.currentIndex,
        total: this.queue.length,
      });
      console.log('[TobyFlow] Queue: paused');
    }

    /**
     * Tiếp tục sau khi pause
     */
    async resume() {
      if (!this.isRunning || !this.isPaused) return;
      this.isPaused = false;
      window.eventBus.emit('queue:resumed', {
        currentIndex: this.currentIndex,
        total: this.queue.length,
      });
      console.log('[TobyFlow] Queue: resumed');
      await this._runNext();
    }

    /**
     * Dừng hoàn toàn và clear queue
     */
    stop() {
      this.isRunning = false;
      this.isPaused = false;
      this.currentIndex = -1;

      // Reset all pending items
      this.queue.forEach(item => {
        if (item.status === 'pending' || item.status === 'running') {
          item.status = 'pending';
        }
      });

      window.eventBus.emit('queue:stopped', {});
      window.eventBus.emit('queue:changed', { queue: this.queue });
      console.log('[TobyFlow] Queue: stopped');
    }

    /**
     * Xóa toàn bộ queue
     */
    clear() {
      this.stop();
      this.queue = [];
      this._completedCount = 0;
      window.eventBus.emit('queue:changed', { queue: this.queue });
      console.log('[TobyFlow] Queue: cleared');
    }

    /**
     * Chạy item tiếp theo trong queue
     */
    async _runNext() {
      if (!this.isRunning || this.isPaused) return;
      if (this.currentIndex >= this.queue.length) {
        // Hoàn thành toàn bộ queue
        this.isRunning = false;
        this.currentIndex = -1;
        window.eventBus.emit('queue:complete', {
          completed: this._completedCount,
          total: this.queue.length,
        });
        console.log('[TobyFlow] Queue: all items completed');
        return;
      }

      const item = this.queue[this.currentIndex];
      item.status = 'running';
      window.eventBus.emit('queue:item-start', {
        item,
        index: this.currentIndex,
        total: this.queue.length,
      });
      window.eventBus.emit('queue:changed', { queue: this.queue });

      try {
        await this._executeItem(item);
        item.status = 'completed';
        this._completedCount++;
      } catch (err) {
        item.status = 'failed';
        item.error = err.message;
        console.error('[TobyFlow] Queue: item failed', item.name, err);
      }

      window.eventBus.emit('queue:item-complete', {
        item,
        index: this.currentIndex,
        total: this.queue.length,
        completed: this._completedCount,
      });
      window.eventBus.emit('queue:changed', { queue: this.queue });

      this.currentIndex++;
      await this._runNext();
    }

    /**
     * Thực thi 1 item dựa trên type
     */
    async _executeItem(item) {
      switch (item.type) {
        case 'prompt':
          return await this._runPrompt(item.data);
        case 'task':
          return await this._runTask(item.data);
        case 'workflow':
          return await this._runWorkflow(item.data);
        default:
          throw new Error('Unknown queue item type: ' + item.type);
      }
    }

    /**
     * Chạy prompt qua runAutoPrompt
     */
    async _runPrompt(data) {
      if (typeof window.runAutoPrompt !== 'function') {
        throw new Error('runAutoPrompt is not available');
      }
      // Phase 2c+: Server-Only — delayBetweenPrompts từ ExecutionConfig, KHÔNG fallback af_settings.
      // inputTimeout vẫn là user setting hợp lệ (không nằm trong 16 deprecated keys).
      const settings = window.storageSettings?.getSettings?.() || {};
      const delayBetweenSec = window.ExecutionConfig?.safeGetDelayBetweenPromptsSec?.() ?? 5;
      const payload = {
        ...data,
        delayBetweenMs: data.delayBetweenMs ?? delayBetweenSec * 1000,
        inputTimeoutMs: data.inputTimeoutMs ?? (settings.inputTimeout || 1200),
      };
      await window.runAutoPrompt(payload);
    }

    /**
     * Chạy task execution
     */
    async _runTask(data) {
      // Task data chứa taskId hoặc full task object
      if (typeof window.runAutoPrompt !== 'function') {
        throw new Error('runAutoPrompt is not available');
      }

      // Phase 2c+: Server-Only — delayBetweenPrompts từ ExecutionConfig, KHÔNG fallback af_settings.
      // inputTimeout vẫn là user setting hợp lệ (không nằm trong 16 deprecated keys).
      const settings = window.storageSettings?.getSettings?.() || {};
      const delayBetweenSec = window.ExecutionConfig?.safeGetDelayBetweenPromptsSec?.() ?? 5;
      const payload = {
        prompts: data.prompts || [data.prompt || data.content],
        genType: data.media_type || data.genType || 'Image',
        aspectRatio: data.ratio || data.aspectRatio || '',
        modelName: data.model || data.modelName || '',
        delayBetweenMs: delayBetweenSec * 1000,
        inputTimeoutMs: settings.inputTimeout || 1200,
      };

      await window.runAutoPrompt(payload);
    }

    /**
     * Chạy workflow qua WorkflowExecutor
     */
    async _runWorkflow(data) {
      if (!window.workflowExecutor) {
        throw new Error('WorkflowExecutor is not available');
      }
      const workflowId = data.wf_id || data.id || data;
      await window.workflowExecutor.execute(workflowId);
    }

    /**
     * Lấy tên mặc định cho item
     */
    _getDefaultName(item) {
      switch (item.type) {
        case 'prompt':
          if (item.data && item.data.prompts && item.data.prompts[0]) {
            return item.data.prompts[0].substring(0, 40) + '...';
          }
          return 'Prompt';
        case 'task':
          return (item.data && item.data.name) || 'Task';
        case 'workflow':
          return (item.data && item.data.wf_name) || 'Workflow';
        default:
          return 'Item';
      }
    }

    /**
     * Lấy trạng thái queue
     */
    getStatus() {
      return {
        total: this.queue.length,
        completed: this._completedCount,
        isRunning: this.isRunning,
        isPaused: this.isPaused,
        currentIndex: this.currentIndex,
        queue: this.queue,
      };
    }
  }

  // Singleton
  window.batchQueue = new BatchQueue();
})();
