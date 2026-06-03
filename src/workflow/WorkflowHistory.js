/**
 * WorkflowHistory — Snapshot-based undo/redo cho workflow editor.
 *
 * Strategy:
 *   - Mỗi action (create/delete/move/connect/edit) → push snapshot toàn bộ workflow
 *     (nodes + edges + positions + form data) lên undoStack.
 *   - Snapshot là JSON serialize từ DiagramCanvas.exportWorkflow() — đủ data để restore hoàn toàn.
 *   - Debounce 400ms cho rapid changes (drag move) để gộp thành 1 entry.
 *   - Max 50 entries (memory cost ~ 50 * 100KB = 5MB worst case).
 *
 * Integration:
 *   - WorkflowEditor đăng ký events từ DiagramCanvas → call scheduleSnapshot/takeSnapshot.
 *   - Keyboard: Ctrl/Cmd+Z = undo, Ctrl/Cmd+Shift+Z hoặc Ctrl+Y = redo.
 *   - Skip khi target là input/textarea (cho phép native undo trong text fields).
 */
class WorkflowHistory {
  constructor(editor) {
    this.editor = editor; // WorkflowEditor instance
    this._undoStack = [];
    this._redoStack = [];
    this._maxSize = 50;
    this._lastSnapshot = null; // String, để compare diff
    this._debounceTimer = null;
    this._suppressing = false; // Block snapshot khi đang restore
  }

  /**
   * Take snapshot ngay (no debounce). Dùng cho discrete actions (delete, connect, ...).
   * Skip nếu state không đổi từ snapshot trước.
   */
  takeSnapshot(label = 'change') {
    if (this._suppressing) return;
    if (!this.editor?.diagramCanvas?.editor) return;
    let data;
    try {
      data = this.editor.diagramCanvas.exportWorkflow();
    } catch (e) {
      console.warn('[WorkflowHistory] exportWorkflow failed:', e);
      return;
    }
    if (!data) return;
    const snapshot = JSON.stringify(data);
    if (snapshot === this._lastSnapshot) return; // No change
    this._undoStack.push({ label, data: snapshot, timestamp: Date.now() });
    if (this._undoStack.length > this._maxSize) this._undoStack.shift();
    this._redoStack = [];
    this._lastSnapshot = snapshot;
  }

  /**
   * Schedule debounced snapshot. Dùng cho continuous actions (drag move, typing).
   * Multiple calls trong delay window → chỉ 1 snapshot final state.
   */
  scheduleSnapshot(label = 'change', delay = 400) {
    if (this._suppressing) return;
    if (this._debounceTimer) clearTimeout(this._debounceTimer);
    this._debounceTimer = setTimeout(() => {
      this.takeSnapshot(label);
      this._debounceTimer = null;
    }, delay);
  }

  /**
   * Flush pending debounced snapshot ngay (vd: trước khi undo/save).
   */
  flushPending() {
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
      this.takeSnapshot('flush');
    }
  }

  canUndo() {
    return this._undoStack.length >= 2;
  }

  canRedo() {
    return this._redoStack.length > 0;
  }

  /**
   * Undo: pop current → push to redo → restore previous.
   * Cần ít nhất 2 entries (1 = initial state, 2+ = có change để undo).
   */
  undo() {
    this.flushPending();
    if (!this.canUndo()) return null;
    const current = this._undoStack.pop();
    this._redoStack.push(current);
    if (this._redoStack.length > this._maxSize) this._redoStack.shift();
    const prev = this._undoStack[this._undoStack.length - 1];
    this._lastSnapshot = prev.data;
    this._restore(prev.data);
    return prev;
  }

  /**
   * Redo: pop redoStack → push to undo → restore.
   */
  redo() {
    this.flushPending();
    if (!this.canRedo()) return null;
    const next = this._redoStack.pop();
    this._undoStack.push(next);
    this._lastSnapshot = next.data;
    this._restore(next.data);
    return next;
  }

  /**
   * Reset toàn bộ history (vd: load workflow mới).
   */
  reset() {
    this._undoStack = [];
    this._redoStack = [];
    this._lastSnapshot = null;
    if (this._debounceTimer) clearTimeout(this._debounceTimer);
    this._debounceTimer = null;
  }

  /**
   * Restore workflow từ snapshot JSON.
   * Suppress events trong khi restore để tránh recursive snapshot.
   */
  _restore(snapshotJson) {
    let data;
    try {
      data = JSON.parse(snapshotJson);
    } catch (e) {
      console.error('[WorkflowHistory] parse snapshot failed:', e);
      return;
    }
    this._suppressing = true;
    try {
      this.editor._restoreFromHistorySnapshot(data);
    } catch (e) {
      console.error('[WorkflowHistory] restore failed:', e);
    } finally {
      // Defer unsuppress để event sau restore không trigger snapshot
      setTimeout(() => { this._suppressing = false; }, 100);
    }
  }
}

window.WorkflowHistory = WorkflowHistory;
