import type { SemanticState } from '../state/types.ts';
import type { StateGraph } from '../state/StateGraph.ts';
import type { GenerationGate } from './GenerationGate.ts';
import type { OrchestratorResult } from './VoiceOrchestrator.ts';
import type { VoiceOrchestrator } from './VoiceOrchestrator.ts';
import type {
  VoiceOutputContext,
  VoiceOutputHandle,
  VoiceOutputProvider,
} from './VoiceOutputProvider.ts';
import type { PlannedResponse, ResponsePlanner } from './ResponsePlanner.ts';

export interface PipelineStepResult<T extends SemanticState> {
  orchestration: OrchestratorResult<T>;
  spoken: boolean;
  handleId: string | null;
  plannedText: string | null;
  cancelledPriorHandle: string | null;
}

export class VoicePipeline<T extends SemanticState = SemanticState> {
  private readonly orch: VoiceOrchestrator<T>;
  private readonly planner: ResponsePlanner<T>;
  private readonly provider: VoiceOutputProvider;
  private readonly gate: GenerationGate;
  private readonly graph: StateGraph<T>;
  private activeHandleId: string | null = null;
  private activeHandleGeneration: string | null = null;

  constructor(
    orch: VoiceOrchestrator<T>,
    planner: ResponsePlanner<T>,
    provider: VoiceOutputProvider,
    gate: GenerationGate,
    graph: StateGraph<T>,
  ) {
    this.orch = orch;
    this.planner = planner;
    this.provider = provider;
    this.gate = gate;
    this.graph = graph;
  }

  get providerKind(): 'rime' | 'mock' {
    return this.provider.kind;
  }

  get activeGeneration(): string {
    return this.gate.currentGeneration;
  }

  private async cancelPriorIfStale(): Promise<string | null> {
    const handle = this.activeHandleId;
    if (!handle) return null;
    const gen = this.activeHandleGeneration;
    if (gen && gen !== this.gate.currentGeneration) {
      await this.provider.cancel(handle);
      this.activeHandleId = null;
      this.activeHandleGeneration = null;
      return handle;
    }
    return null;
  }

  async submit(transcript: string): Promise<PipelineStepResult<T>> {
    const generation = this.gate.issueToken();
    const cancelledHandle = await this.cancelPriorIfStale();

    const _checkpoints = this.graph.list();
    const activeCheckpointIdBefore = this.graph.active?.id ?? null;

    const orchestration = this.orch.orchestrate(transcript, this.graph, { generation });

    if (orchestration.isStale) {
      return {
        orchestration,
        spoken: false,
        handleId: null,
        plannedText: null,
        cancelledPriorHandle: cancelledHandle,
      };
    }

    const planned: PlannedResponse | null = this.planner.plan(orchestration, {
      activeCheckpointId: this.graph.active?.id ?? activeCheckpointIdBefore,
      checkpoints: this.graph.list(),
    });

    if (!planned || !planned.text) {
      return {
        orchestration,
        spoken: false,
        handleId: null,
        plannedText: null,
        cancelledPriorHandle: cancelledHandle,
      };
    }

    if (!this.gate.authorize(generation)) {
      return {
        orchestration,
        spoken: false,
        handleId: null,
        plannedText: planned.text,
        cancelledPriorHandle: cancelledHandle,
      };
    }

    const activeCpIdNow = this.graph.active?.id ?? null;
    if (planned.checkpointId && activeCpIdNow && planned.checkpointId !== activeCpIdNow) {
      return {
        orchestration,
        spoken: false,
        handleId: null,
        plannedText: planned.text,
        cancelledPriorHandle: cancelledHandle,
      };
    }

    const ctx: VoiceOutputContext = {
      generation,
      checkpointId: planned.checkpointId,
    };

    const handlePromise: Promise<VoiceOutputHandle> = this.provider.speak(planned.text, ctx);
    this.activeHandleId = (await handlePromise).id;
    this.activeHandleGeneration = generation;

    if (!this.gate.authorize(generation)) {
      await this.provider.cancel(this.activeHandleId);
      this.activeHandleId = null;
      this.activeHandleGeneration = null;
      return {
        orchestration,
        spoken: false,
        handleId: null,
        plannedText: planned.text,
        cancelledPriorHandle: cancelledHandle,
      };
    }

    return {
      orchestration,
      spoken: true,
      handleId: (await handlePromise).id,
      plannedText: planned.text,
      cancelledPriorHandle: cancelledHandle,
    };
  }

  async interrupt(): Promise<void> {
    this.gate.issueToken();
    if (this.activeHandleId) {
      await this.provider.cancel(this.activeHandleId);
      this.activeHandleId = null;
      this.activeHandleGeneration = null;
    }
  }

  async reset(resetGraph: () => void): Promise<void> {
    this.gate.issueToken();
    if (this.activeHandleId) {
      await this.provider.cancel(this.activeHandleId);
      this.activeHandleId = null;
      this.activeHandleGeneration = null;
    }
    resetGraph();
  }

  getActiveHandleId(): string | null {
    return this.activeHandleId;
  }

  providerStatus(): ReturnType<VoiceOutputProvider['getStatus']> {
    return this.provider.getStatus();
  }
}
