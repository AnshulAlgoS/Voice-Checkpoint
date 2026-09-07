export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type SemanticState = Record<string, JsonValue>;

export interface FieldChange {
  path: string;
  before?: JsonValue;
  after?: JsonValue;
  kind: 'added' | 'removed' | 'changed' | 'unchanged';
}

export interface StateDiff {
  fromCheckpointId: string;
  toCheckpointId: string;
  added: FieldChange[];
  removed: FieldChange[];
  changed: FieldChange[];
  unchanged: FieldChange[];
}

export interface Checkpoint<T extends SemanticState = SemanticState> {
  id: string;
  parentId: string | null;
  branchId: string;
  createdAt: string;
  label: string;
  userInstruction: string;
  summary: string;
  structuredState: T;
  changesFromParent: FieldChange[];
  versionNumber: number;
}

export interface GraphSnapshot<T extends SemanticState = SemanticState> {
  checkpoints: Checkpoint<T>[];
  activeCheckpointId: string | null;
}

export interface CheckpointMeta {
  label: string;
  userInstruction?: string;
  summary?: string;
}

export type StateOperation<T extends SemanticState = SemanticState> =
  | { type: 'CREATE_CHECKPOINT'; state: T; meta: CheckpointMeta }
  | { type: 'FORK'; sourceCheckpointId?: string; changes: Partial<T>; meta: CheckpointMeta }
  | { type: 'SWITCH_CHECKPOINT'; checkpointId: string }
  | { type: 'REWIND'; steps?: number }
  | { type: 'COMPARE'; fromCheckpointId: string; toCheckpointId: string }
  | { type: 'MERGE'; sourceCheckpointId: string; targetCheckpointId?: string; fields: string[]; meta: CheckpointMeta }
  | { type: 'UPDATE_STATE'; changes: Partial<T>; meta: CheckpointMeta }
  | { type: 'UNDO' }
  | { type: 'DESCRIBE_STATE'; checkpointId?: string };

export interface OperationResult<T extends SemanticState = SemanticState> {
  operation: StateOperation<T>['type'];
  checkpoint?: Checkpoint<T>;
  diff?: StateDiff;
  description?: T;
  snapshot: GraphSnapshot<T>;
}

export type ResolverResult<T extends SemanticState = SemanticState> =
  | { status: 'resolved'; operation: StateOperation<T>; confidence: number }
  | { status: 'clarification'; message: string; candidates: string[]; confidence: number }
  | { status: 'unsupported'; message: string; confidence: number };
