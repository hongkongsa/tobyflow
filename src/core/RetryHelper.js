/**
 * RetryHelper - Cơ chế retry thống nhất cho toàn bộ extension
 * Dùng chung cho: Tab 1 (Prompts), Tab 3 (Multi Task), Tab 4 (Workflow)
 *
 * Settings đọc từ af_settings (StorageSettings sync):
 *   execMaxRetries    - Số lần thử lại (0-5, mặc định 2)
 *   execRetryDelay    - Delay giữa các lần retry (giây, mặc định 3)
 *   execTileTimeout   - Timeout chờ kết quả tile (giây, mặc định 180)
 */
class RetryHelper {
  /**
   * Lấy retry config hiện tại từ settings
   * Ưu tiên: workflowExecutor.settings > defaults
   */
  static getConfig() {
    const s = window.workflowExecutor?.settings || {};
    return {
      maxRetries: s.maxRetries ?? 2,
      retryDelay: s.retryDelay ?? 3000,       // ms
      tileTimeout: s.tileTimeout ?? 180000,    // ms
      stopOnError: s.stopOnError ?? false
    };
  }

  /**
   * Thực thi một hàm với retry
   *
   * @param {Function} fn - Async function cần thực thi, nhận { attempt, maxRetries }
   * @param {Object} options
   * @param {Function} options.shouldStop - Trả về true nếu nên dừng
   * @param {Function} options.onRetry - Callback khi retry (attempt, maxRetries, error)
   * @param {Function} options.onFail - Callback khi thất bại hoàn toàn (error, attempts)
   * @param {string} options.label - Tên hiển thị cho log
   * @param {number} options.maxRetries - Override maxRetries từ config
   * @param {number} options.retryDelay - Override retryDelay từ config (ms)
   * @returns {Promise<*>} Kết quả từ fn
   */
  static async execute(fn, options = {}) {
    const config = this.getConfig();
    const maxRetries = options.maxRetries ?? config.maxRetries;
    const retryDelay = options.retryDelay ?? config.retryDelay;
    const shouldStop = options.shouldStop || (() => false);
    const onRetry = options.onRetry || (() => {});
    const onFail = options.onFail || (() => {});
    const label = options.label || 'action';

    // maxRetries = số lần THỬ LẠI (không tính lần chạy đầu)
    // Tổng số lần chạy = 1 (lần đầu) + maxRetries (retry)
    const totalAttempts = 1 + maxRetries;
    let attempt = 0;
    let lastError = null;

    while (attempt < totalAttempts) {
      if (shouldStop()) {
        throw new Error(`${label}: Đã dừng bởi người dùng`);
      }

      try {
        attempt++;
        const result = await fn({ attempt, totalAttempts });
        return result;
      } catch (error) {
        if (shouldStop()) throw error;

        lastError = error;
        console.warn(`[RetryHelper] ${label} attempt ${attempt}/${totalAttempts} failed:`, error.message);

        // Skip retry nếu error đánh dấu noRetry (vd: CONTENT_BLOCKED sau 1 lần retry)
        if (error.noRetry) {
          console.warn(`[RetryHelper] ${label}: error.noRetry=true — không retry thêm`);
          break;
        }

        if (attempt < totalAttempts) {
          onRetry(attempt, totalAttempts, error);
          // Interruptible delay: chia thành chunks 500ms
          await this._interruptibleDelay(retryDelay, shouldStop);
        }
      }
    }

    onFail(lastError, attempt);
    throw lastError;
  }

  /**
   * Delay có thể ngắt khi shouldStop() trả về true
   */
  static async _interruptibleDelay(ms, shouldStop) {
    const chunkSize = 500;
    let elapsed = 0;
    while (elapsed < ms) {
      if (shouldStop()) throw new Error('Đã dừng bởi người dùng');
      const wait = Math.min(chunkSize, ms - elapsed);
      await new Promise(r => setTimeout(r, wait));
      elapsed += wait;
    }
  }
}

// Export
window.RetryHelper = RetryHelper;
