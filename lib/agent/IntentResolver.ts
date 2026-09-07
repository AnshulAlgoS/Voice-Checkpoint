import type { Checkpoint, ResolverResult, SemanticState, StateOperation } from '../state/types.ts';

const currencyNumber = (text: string): number | undefined => {
  const match = text.match(/(?:₹|rs\.?|rupees?\s*)?\s*(\d[\d,]*(?:\.\d+)?)\s*(k|thousand|lakh)?/i);
  if (!match) return undefined;
  const base = Number(match[1].replaceAll(',', ''));
  return Math.round(base * (match[2]?.toLowerCase() === 'lakh' ? 100000 : match[2] ? 1000 : 1));
};

function findByReference<T extends SemanticState>(text: string, checkpoints: Checkpoint<T>[]): Checkpoint<T>[] {
  const normalized = text.toLowerCase();
  const direct = checkpoints.filter((checkpoint) => normalized.includes(checkpoint.label.toLowerCase()) || normalized.includes(`version ${checkpoint.versionNumber}`));
  if (direct.length) return direct;
  if (/original|first one|first version/.test(normalized)) return checkpoints.slice(0, 1);
  if (/previous|version before/.test(normalized)) return checkpoints.slice(-2, -1);
  const amount = currencyNumber(normalized);
  if (amount !== undefined) return checkpoints.filter((checkpoint) => checkpoint.structuredState.budget === amount);
  if (/luxury|comfort/.test(normalized)) return checkpoints.filter((checkpoint) => {
    const stateText = JSON.stringify(checkpoint.structuredState).toLowerCase();
    return stateText.includes('luxury') || stateText.includes('comfort');
  });
  if (/cheaper/.test(normalized)) {
    const sorted = checkpoints.filter((checkpoint) => typeof checkpoint.structuredState.budget === 'number').sort((a, b) => Number(a.structuredState.budget) - Number(b.structuredState.budget));
    return sorted.slice(0, 1);
  }
  return [];
}

export class IntentResolver<T extends SemanticState = SemanticState> {
  resolve(input: string, checkpoints: Checkpoint<T>[], activeCheckpointId: string | null): ResolverResult<T> {
    const text = input.trim().toLowerCase();
    const active = checkpoints.find((checkpoint) => checkpoint.id === activeCheckpointId);
    if (!text) return { status: 'unsupported', message: 'Enter an instruction.', confidence: 0 };
    if (/^(undo|undo that|actually,? undo that)[.!]?$/.test(text)) return this.resolved({ type: 'UNDO' }, 0.99);
    if (/what changed|compare/.test(text)) {
      const candidates = findByReference(text, checkpoints).filter((checkpoint) => checkpoint.id !== activeCheckpointId);
      const other = candidates.at(-1) ?? checkpoints.filter((checkpoint) => checkpoint.id !== activeCheckpointId).at(-1);
      if (!active || !other) return this.clarify(checkpoints, 'Which two versions should I compare?');
      return this.resolved({ type: 'COMPARE', fromCheckpointId: other.id, toCheckpointId: active.id }, 0.88);
    }
    if (/go back one step|rewind one step/.test(text)) return this.resolved({ type: 'REWIND', steps: 1 }, 0.98);
    if (/go back|switch|return to|continue from|use the previous plan/.test(text)) {
      const candidates = findByReference(text, checkpoints);
      if (candidates.length !== 1) return this.clarify(candidates.length ? candidates : checkpoints, 'Which checkpoint do you mean?');
      return this.resolved({ type: 'SWITCH_CHECKPOINT', checkpointId: candidates[0].id }, 0.94);
    }
    if (/take the hotel|keep the hotel|merge the hotel/.test(text)) {
      if (!active) return { status: 'unsupported', message: 'Create a checkpoint first.', confidence: 0.9 };
      const candidates = findByReference(text, checkpoints).filter((checkpoint) => checkpoint.id !== active.id);
      if (candidates.length !== 1) return this.clarify(candidates.length ? candidates : checkpoints.filter((checkpoint) => checkpoint.id !== active.id), 'Which version should supply the hotel?');
      return this.resolved({ type: 'MERGE', sourceCheckpointId: candidates[0].id, targetCheckpointId: active.id, fields: ['accommodation'], meta: { label: `${active.label} · hotel merged`, userInstruction: input, summary: 'Selective hotel merge' } }, 0.96);
    }
    if (/another version|fork|try another/.test(text) && active) {
      const amount = currencyNumber(text);
      const changes: SemanticState = {};
      if (amount !== undefined) changes.budget = amount;
      if (/luxury|comfort/.test(text)) changes.priorities = ['comfort'];
      return this.resolved({ type: 'FORK', sourceCheckpointId: active.id, changes: changes as Partial<T>, meta: { label: amount ? `₹${Math.round(amount / 1000)}k comfort` : 'New branch', userInstruction: input, summary: 'Forked decision state' } }, 0.9);
    }
    return { status: 'unsupported', message: 'That instruction does not map to a Phase 1 state operation.', confidence: 0.35 };
  }

  private resolved(operation: StateOperation<T>, confidence: number): ResolverResult<T> {
    return { status: 'resolved', operation, confidence };
  }

  private clarify(checkpoints: Checkpoint<T>[], message: string): ResolverResult<T> {
    return { status: 'clarification', message, candidates: checkpoints.map((checkpoint) => checkpoint.label), confidence: 0.45 };
  }
}
