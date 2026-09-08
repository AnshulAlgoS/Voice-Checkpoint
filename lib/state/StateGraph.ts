import { DiffEngine } from './DiffEngine.ts';
import { MergeEngine } from './MergeEngine.ts';
import type { Checkpoint, CheckpointMeta, GraphSnapshot, OperationResult, SemanticState, StateDiff, StateOperation } from './types.ts';
import { clone } from './value.ts';

interface InternalSnapshot<T extends SemanticState> extends GraphSnapshot<T> { sequence: number }

export class StateGraph<T extends SemanticState = SemanticState> {
  private checkpoints = new Map<string, Checkpoint<T>>();
  private activeCheckpointId: string | null = null;
  private history: InternalSnapshot<T>[] = [];
  private sequence = 0;

  constructor(snapshot?: GraphSnapshot<T>) {
    if (snapshot) this.restore(snapshot);
  }

  get active(): Checkpoint<T> | null {
    return this.activeCheckpointId ? this.get(this.activeCheckpointId) : null;
  }

  get(id: string): Checkpoint<T> {
    const checkpoint = this.checkpoints.get(id);
    if (!checkpoint) throw new Error(`Unknown checkpoint: ${id}`);
    return clone(checkpoint);
  }

  list(): Checkpoint<T>[] {
    return [...this.checkpoints.values()].sort((a, b) => a.versionNumber - b.versionNumber).map(clone);
  }

  export(): GraphSnapshot<T> {
    return { checkpoints: this.list(), activeCheckpointId: this.activeCheckpointId };
  }

  restore(snapshot: GraphSnapshot<T>): void {
    this.checkpoints = new Map(snapshot.checkpoints.map((item) => [item.id, clone(item)]));
    this.activeCheckpointId = snapshot.activeCheckpointId;
    this.sequence = snapshot.checkpoints.reduce((max, item) => Math.max(max, item.versionNumber), 0);
    this.history = [];
    if (this.activeCheckpointId && !this.checkpoints.has(this.activeCheckpointId)) {
      throw new Error('Snapshot active checkpoint is missing.');
    }
  }

  create(state: T, meta: CheckpointMeta): Checkpoint<T> {
    this.saveUndoPoint();
    return this.commit(null, `branch-${this.sequence + 1}`, state, meta);
  }

  fork(sourceCheckpointId: string, changes: Partial<T>, meta: CheckpointMeta): Checkpoint<T> {
    const source = this.get(sourceCheckpointId);
    this.saveUndoPoint();
    return this.commit(source.id, `branch-${this.sequence + 1}`, { ...source.structuredState, ...clone(changes) } as T, meta);
  }

  update(changes: Partial<T>, meta: CheckpointMeta): Checkpoint<T> {
    const source = this.requireActive();
    this.saveUndoPoint();
    return this.commit(source.id, source.branchId, { ...source.structuredState, ...clone(changes) } as T, meta);
  }

  switchTo(checkpointId: string): Checkpoint<T> {
    const target = this.get(checkpointId);
    if (target.id === this.activeCheckpointId) return target;
    this.saveUndoPoint();
    this.activeCheckpointId = target.id;
    return target;
  }

  rewind(steps = 1): Checkpoint<T> {
    if (!Number.isInteger(steps) || steps < 1) throw new Error('Rewind steps must be a positive integer.');
    let target = this.requireActive();
    for (let i = 0; i < steps; i += 1) {
      if (!target.parentId) throw new Error('Cannot rewind beyond the root checkpoint.');
      target = this.get(target.parentId);
    }
    return this.switchTo(target.id);
  }

  compare(fromCheckpointId: string, toCheckpointId: string): StateDiff {
    return DiffEngine.compare(fromCheckpointId, toCheckpointId, this.get(fromCheckpointId).structuredState, this.get(toCheckpointId).structuredState);
  }

  merge(sourceCheckpointId: string, targetCheckpointId: string, fields: string[], meta: CheckpointMeta): Checkpoint<T> {
    const source = this.get(sourceCheckpointId);
    const target = this.get(targetCheckpointId);
    const merged = MergeEngine.selective(target.structuredState, source.structuredState, fields);
    this.saveUndoPoint();
    return this.commit(target.id, target.branchId, merged, meta);
  }

  undo(): Checkpoint<T> | null {
    const previous = this.history.pop();
    if (!previous) throw new Error('Nothing to undo.');
    this.checkpoints = new Map(previous.checkpoints.map((item) => [item.id, clone(item)]));
    this.activeCheckpointId = previous.activeCheckpointId;
    this.sequence = previous.sequence;
    return this.active;
  }

  execute(operation: StateOperation<T>): OperationResult<T> {
    let checkpoint: Checkpoint<T> | undefined;
    let diff: StateDiff | undefined;
    let description: T | undefined;
    switch (operation.type) {
      case 'CREATE_CHECKPOINT': checkpoint = this.create(operation.state, operation.meta); break;
      case 'FORK': checkpoint = this.fork(operation.sourceCheckpointId ?? this.requireActive().id, operation.changes, operation.meta); break;
      case 'SWITCH_CHECKPOINT': checkpoint = this.switchTo(operation.checkpointId); break;
      case 'REWIND': checkpoint = this.rewind(operation.steps); break;
      case 'COMPARE': diff = this.compare(operation.fromCheckpointId, operation.toCheckpointId); break;
      case 'MERGE': checkpoint = this.merge(operation.sourceCheckpointId, operation.targetCheckpointId ?? this.requireActive().id, operation.fields, operation.meta); break;
      case 'UPDATE_STATE': checkpoint = this.update(operation.changes, operation.meta); break;
      case 'UNDO': checkpoint = this.undo() ?? undefined; break;
      case 'DESCRIBE_STATE': description = this.get(operation.checkpointId ?? this.requireActive().id).structuredState; break;
    }
    return { operation: operation.type, checkpoint, diff, description: description ? clone(description) : undefined, snapshot: this.export() };
  }

  private commit(parentId: string | null, branchId: string, state: T, meta: CheckpointMeta): Checkpoint<T> {
    const parent = parentId ? this.get(parentId) : null;
    const versionNumber = ++this.sequence;
    const checkpoint: Checkpoint<T> = {
      id: `cp-${versionNumber}`,
      parentId,
      branchId,
      createdAt: new Date().toISOString(),
      label: meta.label,
      userInstruction: meta.userInstruction ?? '',
      summary: meta.summary ?? meta.label,
      structuredState: clone(state),
      changesFromParent: parent ? [...this.compareStates(parent, state)] : [],
      versionNumber,
    };
    this.checkpoints.set(checkpoint.id, checkpoint);
    this.activeCheckpointId = checkpoint.id;
    return clone(checkpoint);
  }

  private compareStates(parent: Checkpoint<T>, state: T) {
    const diff = DiffEngine.compare(parent.id, 'pending', parent.structuredState, state);
    return [...diff.added, ...diff.removed, ...diff.changed];
  }

  private requireActive(): Checkpoint<T> {
    if (!this.activeCheckpointId) throw new Error('The graph has no active checkpoint.');
    return this.get(this.activeCheckpointId);
  }

  private saveUndoPoint(): void {
    this.history.push({ ...this.export(), sequence: this.sequence });
  }
}
