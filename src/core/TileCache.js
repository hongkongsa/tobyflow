/**
 * TileCache - Session cache cho file_name/thumbnail_url → tile_id mapping
 * Memory only (không persist), vì tile_id thay đổi theo session
 *
 * Phase S2.3: Session Cache & Batch Resolution
 */
class TileCache {
  // file_name hoặc thumbnail_url → tile_id
  static _cache = new Map();

  // file_id → tile_id (persistent, highest priority)
  static _fileIdMap = new Map();

  // Keys đã fail resolution (để tránh retry liên tục)
  static _failedKeys = new Set();

  // Timestamp last DOM scan
  static _lastScanTime = 0;

  // Min interval giữa các lần scan (ms)
  static MIN_SCAN_INTERVAL = 1000;

  /**
   * Get tile_id từ cache
   * @param {string} key - file_name hoặc normalized thumbnail_url
   * @returns {string|null} - tile_id hoặc null nếu không có/đã fail
   */
  static get(key) {
    if (!key) return null;

    // Nếu key đã fail trước đó, trả về null
    if (this._failedKeys.has(key)) return null;

    return this._cache.get(key) || null;
  }

  /**
   * Get tile_id bằng file_id (persistent, highest priority)
   * @param {string} fileId - persistent file_id từ /project/{pid}/edit/{file_id}
   * @returns {string|null} - tile_id hoặc null
   */
  static getByFileId(fileId) {
    if (!fileId) return null;
    if (this._failedKeys.has(fileId)) return null;
    return this._fileIdMap.get(fileId) || null;
  }

  /**
   * Set tile_id vào cache
   * @param {string} key - file_name hoặc normalized thumbnail_url
   * @param {string} tileId - DOM tile ID
   */
  static set(key, tileId) {
    if (!key || !tileId) return;

    this._cache.set(key, tileId);
    // Xóa khỏi failed set nếu resolve thành công
    this._failedKeys.delete(key);
  }

  /**
   * Set tile_id bằng file_id (persistent key)
   * @param {string} fileId - persistent file_id
   * @param {string} tileId - DOM tile ID
   */
  static setByFileId(fileId, tileId) {
    if (!fileId || !tileId) return;

    this._fileIdMap.set(fileId, tileId);
    this._failedKeys.delete(fileId);
  }

  /**
   * Mark key đã fail resolution
   * Key sẽ bị skip trong các lần get() tiếp theo cho đến khi clearFailed()
   * @param {string} key
   */
  static markFailed(key) {
    if (!key) return;

    this._cache.delete(key);
    this._failedKeys.add(key);
  }

  /**
   * Clear tất cả failed keys để cho phép retry
   * Gọi sau khi trigger lazy load (ensureFlowTilesLoaded)
   */
  static clearFailed() {
    this._failedKeys.clear();
  }

  /**
   * Full clear cache (on major DOM changes như page reload)
   */
  static clear() {
    this._cache.clear();
    this._fileIdMap.clear();
    this._failedKeys.clear();
    this._lastScanTime = 0;
  }

  /**
   * Check có nên scan DOM không (rate limiting)
   * @returns {boolean}
   */
  static shouldScan() {
    const now = Date.now();
    if (now - this._lastScanTime < this.MIN_SCAN_INTERVAL) {
      return false;
    }
    return true;
  }

  /**
   * Mark đã scan xong
   */
  static markScanned() {
    this._lastScanTime = Date.now();
  }

  /**
   * Bulk set từ scan results
   * @param {Map<string, string>} mappings - key → tileId
   */
  static bulkSet(mappings) {
    for (const [key, tileId] of mappings) {
      this.set(key, tileId);
    }
  }

  /**
   * Get cache stats for debugging
   * @returns {{cached: number, failed: number, lastScan: number}}
   */
  static getStats() {
    return {
      cached: this._cache.size,
      cachedByFileId: this._fileIdMap.size,
      failed: this._failedKeys.size,
      lastScan: this._lastScanTime
    };
  }

  /**
   * Check if key exists in cache (not failed)
   * @param {string} key
   * @returns {boolean}
   */
  static has(key) {
    return this._cache.has(key) && !this._failedKeys.has(key);
  }
}

// Export
window.TileCache = TileCache;
