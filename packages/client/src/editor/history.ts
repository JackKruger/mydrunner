// Undo / redo over whole-state snapshots.
//
// Snapshots rather than per-cell journals: at the shipped 128² a full
// edit state is ~48 KB, so a 60-step history costs under 3 MB, and the
// obviously correct version beats tracking which cells a stroke touched
// and reversing them in order.
//
// Generic over the snapshot type so the capture / restore pair stays
// with the thing being edited — the history knows only how to hold and
// hand back opaque states.

export interface HistoryHooks<T> {
  /** Copy the current state. Must deep-copy anything mutable, or the
   *  stack fills with aliases of the live state and undo does nothing. */
  capture(): T;
  restore(state: T): void;
}

export class History<T> {
  private undoStack: T[] = [];
  private redoStack: T[] = [];

  constructor(private hooks: HistoryHooks<T>, private limit = 60) {}

  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }

  /** Record the state as it is BEFORE an edit. Call once per undoable
   *  action — a drag calls it on pointerdown, not per move. */
  push(): void {
    this.undoStack.push(this.hooks.capture());
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    // A new edit invalidates the redo branch: keeping it would let redo
    // reapply a state that never followed from what is on screen now.
    this.redoStack.length = 0;
  }

  undo(): boolean {
    const prev = this.undoStack.pop();
    if (!prev) return false;
    this.redoStack.push(this.hooks.capture());
    this.hooks.restore(prev);
    return true;
  }

  redo(): boolean {
    const next = this.redoStack.pop();
    if (!next) return false;
    this.undoStack.push(this.hooks.capture());
    this.hooks.restore(next);
    return true;
  }

  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }
}
