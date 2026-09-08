import type { Checkpoint, SemanticState, StateOperation } from '../state/types.ts';

export interface Candidate {
  id: string;
  label: string;
  versionNumber: number;
  whyMatched: string[];
}

export type ResolutionResult<T extends SemanticState = SemanticState> =
  | { kind: 'resolved'; operation: StateOperation<T> }
  | { kind: 'clarification'; question: string; candidates: Candidate[] }
  | { kind: 'unsupported'; reason: string };

export type GenerationToken = string & { readonly __brand: 'GenerationToken' };

export interface VoiceResolveRequest<T extends SemanticState = SemanticState> {
  transcript: string;
  generation: GenerationToken;
  checkpoints: Checkpoint<T>[];
  activeCheckpointId: string | null;
}

export interface GatedResponse<T> {
  result: T;
  isStale: boolean;
  generation: GenerationToken;
}

export type ResolvedFields = {
  fieldPaths: string[];
  budget?: number;
  duration?: number;
  priorities?: string[];
  rawChanges: Record<string, unknown>;
};
