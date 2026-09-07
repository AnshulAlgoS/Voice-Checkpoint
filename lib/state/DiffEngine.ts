import type { FieldChange, SemanticState, StateDiff } from './types.ts';
import { clone, equal } from './value.ts';

function isRecord(value: unknown): value is SemanticState {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function walk(before: SemanticState, after: SemanticState, prefix = ''): FieldChange[] {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return keys.flatMap((key): FieldChange[] => {
    const path = prefix ? `${prefix}.${key}` : key;
    const left = before[key];
    const right = after[key];
    if (isRecord(left) && isRecord(right)) return walk(left, right, path);
    if (!(key in before)) return [{ path, after: clone(right), kind: 'added' }];
    if (!(key in after)) return [{ path, before: clone(left), kind: 'removed' }];
    if (equal(left, right)) return [{ path, before: clone(left), after: clone(right), kind: 'unchanged' }];
    return [{ path, before: clone(left), after: clone(right), kind: 'changed' }];
  });
}

export class DiffEngine {
  static compare(fromCheckpointId: string, toCheckpointId: string, before: SemanticState, after: SemanticState): StateDiff {
    const fields = walk(before, after);
    return {
      fromCheckpointId,
      toCheckpointId,
      added: fields.filter((field) => field.kind === 'added'),
      removed: fields.filter((field) => field.kind === 'removed'),
      changed: fields.filter((field) => field.kind === 'changed'),
      unchanged: fields.filter((field) => field.kind === 'unchanged'),
    };
  }
}
