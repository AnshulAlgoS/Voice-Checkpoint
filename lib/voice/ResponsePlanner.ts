import type { Checkpoint, OperationResult, SemanticState, StateDiff } from '../state/types.ts';
import type { OrchestratorResult } from './VoiceOrchestrator.ts';
import type { ResolutionResult } from './types.ts';

const fieldLabels: Record<string, string> = {
  budget: 'budget',
  accommodation: 'stay',
  transportation: 'travel',
  duration: 'duration',
  priorities: 'priorities',
  destination: 'destination',
  travelers: 'travelers',
  activities: 'activities',
  constraints: 'constraints',
  currency: 'currency',
};

function formatValue(key: string, value: unknown): string {
  if (key === 'budget' && typeof value === 'number') {
    return `rupees ${value.toLocaleString('en-IN')}`;
  }
  if (key === 'duration' && typeof value === 'number') {
    return value === 1 ? 'one day' : `${value} days`;
  }
  if (key === 'travelers' && typeof value === 'number') {
    return value === 1 ? 'one traveler' : `${value} travelers`;
  }
  if (Array.isArray(value)) {
    const parts = value.map((v) => String(v));
    if (parts.length === 0) return 'none';
    if (parts.length === 1) return parts[0];
    if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
    return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`;
  }
  if (typeof value === 'boolean') return value ? 'enabled' : 'disabled';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (value === null || value === undefined) return 'not set';
  try {
    return JSON.stringify(value);
  } catch {
    return 'complex value';
  }
}

function labelFor(path: string): string {
  return fieldLabels[path] ?? path;
}

function summarizeFields(state: SemanticState, keys: string[]): string[] {
  const parts: string[] = [];
  for (const k of keys) {
    if (k in state) parts.push(`${labelFor(k)} ${formatValue(k, state[k])}`);
  }
  return parts;
}

function summarizeState(state: SemanticState, kindHint: string): string {
  const tripKeys = ['destination', 'budget', 'accommodation', 'transportation', 'duration', 'priorities'];
  const tripParts = summarizeFields(state, tripKeys);
  if (tripParts.length >= 2) {
    if (kindHint === 'fork') return `${tripParts.join('; ')}.`;
    return tripParts.join('; ') + '.';
  }
  const keys = Object.keys(state).filter((k) => {
    const v = state[k];
    return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || Array.isArray(v);
  }).slice(0, 5);
  const generic = summarizeFields(state, keys);
  if (generic.length === 0) return 'State updated.';
  return generic.join('; ') + '.';
}

function summarizeDiff(diff: StateDiff): string {
  const changed = diff.changed.map((c) => labelFor(c.path));
  const added = diff.added.map((c) => labelFor(c.path));
  const removed = diff.removed.map((c) => labelFor(c.path));
  const all = [...changed, ...added, ...removed];
  const unchangedCount = diff.unchanged.length;
  if (all.length === 0) return 'No differences.';
  const list =
    all.length === 1
      ? all[0]
      : all.length === 2
        ? `${all[0]} and ${all[1]}`
        : `${all.slice(0, -1).join(', ')}, and ${all[all.length - 1]}`;
  const unchanged =
    unchangedCount > 0
      ? `${unchangedCount === 1 ? `${labelFor(diff.unchanged[0].path)} stays` : `${unchangedCount} fields stay`} the same.`
      : '';
  const verb =
    added.length > 0
      ? 'Added'
      : removed.length > 0
        ? 'Removed'
        : 'Changed';
  return `${verb}: ${list}. ${unchanged}`.trim();
}

function checkpointRef(cp: Checkpoint | null | undefined): string {
  if (!cp) return 'the current version';
  return `Version ${cp.versionNumber}, ${cp.label}`;
}

export interface PlannedResponse {
  text: string;
  checkpointId: string | null;
}

export class ResponsePlanner<T extends SemanticState = SemanticState> {
  plan(
    orchestration: OrchestratorResult<T>,
    opts: { activeCheckpointId: string | null; checkpoints: Checkpoint<T>[] },
  ): PlannedResponse | null {
    if (orchestration.isStale) return null;

    const inner = orchestration.result;
    const checkpoints = opts.checkpoints;
    const byId = (id: string | null | undefined) =>
      id ? checkpoints.find((c) => c.id === id) ?? null : null;
    const activeCp = byId(opts.activeCheckpointId);

    if (inner.kind === 'not-executed') {
      const r = inner.resolution;
      return this.planResolution(r, activeCp);
    }

    const execution = inner.execution;
    const resolution = inner.resolution;
    const opType = execution.operation;

    let text: string;
    let checkpointId: string | null = execution.checkpoint?.id ?? opts.activeCheckpointId;

    switch (opType) {
      case 'CREATE_CHECKPOINT': {
        const cp = execution.checkpoint;
        text = cp
          ? `Created ${checkpointRef(cp)}. ${summarizeState(cp.structuredState, 'create')}`
          : 'Created a new checkpoint.';
        break;
      }
      case 'FORK': {
        const cp = execution.checkpoint;
        text = cp
          ? `Forked ${checkpointRef(cp)}. ${summarizeState(cp.structuredState, 'fork')}`
          : 'Created a new version.';
        break;
      }
      case 'SWITCH_CHECKPOINT': {
        const cp = execution.checkpoint;
        text = cp ? `Switched to ${checkpointRef(cp)}.` : 'Switched checkpoint.';
        break;
      }
      case 'REWIND': {
        const steps = resolution.kind === 'resolved' && resolution.operation.type === 'REWIND'
          ? resolution.operation.steps ?? 1
          : 1;
        const cp = execution.checkpoint;
        text = `Rewound ${steps === 1 ? 'one step' : `${steps} steps`}. ${cp ? `Now on ${checkpointRef(cp)}.` : ''}`;
        break;
      }
      case 'COMPARE': {
        const diff = execution.diff;
        const fromCp =
          resolution.kind === 'resolved' && resolution.operation.type === 'COMPARE'
            ? byId(resolution.operation.fromCheckpointId)
            : null;
        const toCp =
          resolution.kind === 'resolved' && resolution.operation.type === 'COMPARE'
            ? byId(resolution.operation.toCheckpointId)
            : activeCp;
        const header = diff
          ? `Comparing ${checkpointRef(fromCp)} with ${checkpointRef(toCp)}. `
          : 'Comparison computed. ';
        text = diff ? `${header}${summarizeDiff(diff)}` : header.trim();
        break;
      }
      case 'MERGE': {
        const cp = execution.checkpoint;
        const fields =
          resolution.kind === 'resolved' && resolution.operation.type === 'MERGE'
            ? resolution.operation.fields
            : [];
        const srcCp =
          resolution.kind === 'resolved' && resolution.operation.type === 'MERGE'
            ? byId(resolution.operation.sourceCheckpointId)
            : null;
        const tgtCp =
          resolution.kind === 'resolved' && resolution.operation.type === 'MERGE'
            ? byId(resolution.operation.targetCheckpointId)
            : activeCp;
        const fieldList =
          fields.length === 0
            ? 'selected fields'
            : fields.length === 1
              ? labelFor(fields[0])
              : fields.length === 2
                ? `${labelFor(fields[0])} and ${labelFor(fields[1])}`
                : `${fields.slice(0, -1).map(labelFor).join(', ')}, and ${labelFor(fields[fields.length - 1])}`;
        const unchanged = cp && tgtCp && 'budget' in tgtCp.structuredState && cp.structuredState.budget === tgtCp.structuredState.budget
          ? ` Budget remains ${formatValue('budget', tgtCp.structuredState.budget)}.`
          : '';
        text = `Merged ${fieldList} from ${checkpointRef(srcCp)} into ${checkpointRef(tgtCp)}.${unchanged} ${
          cp ? summarizeState(cp.structuredState, 'merge') : ''
        }`;
        break;
      }
      case 'UPDATE_STATE': {
        const cp = execution.checkpoint;
        text = cp
          ? `Updated ${checkpointRef(cp)}. ${summarizeState(cp.structuredState, 'update')}`
          : 'Updated active state.';
        break;
      }
      case 'UNDO': {
        const cp = execution.checkpoint;
        text = `Last operation undone. ${cp ? `Restored ${checkpointRef(cp)}.` : 'State restored.'}`;
        break;
      }
      case 'DESCRIBE_STATE': {
        const desc = execution.description;
        if (desc) {
          text = `Current state: ${summarizeState(desc as SemanticState, 'describe')}`;
        } else {
          text = 'State described.';
        }
        break;
      }
      default:
        text = 'Operation applied.';
    }

    return { text: text.trim(), checkpointId };
  }

  planResolution(
    resolution: ResolutionResult<T>,
    activeCp: Checkpoint<T> | null,
  ): PlannedResponse {
    if (resolution.kind === 'clarification') {
      const q = resolution.question.trim();
      const sentence = q.endsWith('?') || q.endsWith('.') || q.endsWith('!') ? q : `${q}.`;
      return { text: `I need to clarify: ${sentence}`, checkpointId: activeCp?.id ?? null };
    }
    if (resolution.kind === 'unsupported') {
      const reason = resolution.reason.trim();
      const sentence = reason.endsWith('.') || reason.endsWith('!') ? reason : `${reason}.`;
      return { text: `Not supported: ${sentence}`, checkpointId: activeCp?.id ?? null };
    }
    return { text: 'Operation resolved.', checkpointId: activeCp?.id ?? null };
  }
}
