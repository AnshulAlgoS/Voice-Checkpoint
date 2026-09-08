import type { OperationResult, SemanticState } from '../state/types.ts';
import type { GenerationGate } from './GenerationGate.ts';
import type { GatedResponse, ResolutionResult } from './types.ts';
import type { VoiceIntentResolver } from './VoiceIntentResolver.ts';
import type { StateGraph } from '../state/StateGraph.ts';

export type OrchestratorResult<T extends SemanticState> = GatedResponse<
  | { kind: 'executed'; resolution: ResolutionResult<T>; execution: OperationResult<T> }
  | { kind: 'not-executed'; resolution: ResolutionResult<T> }
>;

export class VoiceOrchestrator<T extends SemanticState = SemanticState> {
  private readonly resolver: VoiceIntentResolver<T>;
  private readonly gate: GenerationGate;

  constructor(resolver: VoiceIntentResolver<T>, gate: GenerationGate) {
    this.resolver = resolver;
    this.gate = gate;
  }

  orchestrate(
    transcript: string,
    graph: StateGraph<T>,
    opts?: { generation?: ReturnType<GenerationGate['issueToken']> }
  ): OrchestratorResult<T> {
    const generation = opts?.generation ?? this.gate.issueToken();
    const stale: OrchestratorResult<T> = {
      result: {
        kind: 'not-executed',
        resolution: { kind: 'unsupported', reason: 'Stale response: a newer operation superseded this one.' },
      },
      isStale: true,
      generation,
    };

    if (!this.gate.authorize(generation)) {
      return stale;
    }

    const list = graph.list();
    const activeId = graph.active?.id ?? null;
    const resolution = this.resolver.resolve(transcript, list, activeId);

    if (!this.gate.authorize(generation)) {
      return stale;
    }

    if (resolution.kind !== 'resolved') {
      return {
        result: { kind: 'not-executed', resolution },
        isStale: false,
        generation,
      };
    }

    if (!this.gate.authorize(generation)) {
      return stale;
    }

    const execution = graph.execute(resolution.operation);

    if (!this.gate.authorize(generation)) {
      return stale;
    }

    return {
      result: { kind: 'executed', resolution, execution },
      isStale: false,
      generation,
    };
  }

  async orchestrateAsync(
    transcript: string,
    graph: StateGraph<T>,
    opts?: { generation?: ReturnType<GenerationGate['issueToken']>; delayMs?: number }
  ): Promise<OrchestratorResult<T>> {
    const generation = opts?.generation ?? this.gate.issueToken();
    const stale: OrchestratorResult<T> = {
      result: {
        kind: 'not-executed',
        resolution: { kind: 'unsupported', reason: 'Stale response: a newer operation superseded this one.' },
      },
      isStale: true,
      generation,
    };

    if (opts?.delayMs) {
      await new Promise((r) => setTimeout(r, opts.delayMs));
    }

    if (!this.gate.authorize(generation)) return stale;
    const list = graph.list();
    const activeId = graph.active?.id ?? null;
    const resolution = this.resolver.resolve(transcript, list, activeId);

    if (!this.gate.authorize(generation)) return stale;
    if (resolution.kind !== 'resolved') {
      return {
        result: { kind: 'not-executed', resolution },
        isStale: false,
        generation,
      };
    }

    if (!this.gate.authorize(generation)) return stale;
    const execution = graph.execute(resolution.operation);

    if (!this.gate.authorize(generation)) return stale;
    return {
      result: { kind: 'executed', resolution, execution },
      isStale: false,
      generation,
    };
  }
}
