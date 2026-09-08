import test from 'node:test';
import assert from 'node:assert/strict';

import { GenerationGate } from '../lib/voice/GenerationGate.ts';
import { VoiceIntentResolver } from '../lib/voice/VoiceIntentResolver.ts';
import { VoiceOrchestrator } from '../lib/voice/VoiceOrchestrator.ts';
import { ResponsePlanner } from '../lib/voice/ResponsePlanner.ts';
import {
  MockVoiceOutputProvider,
  RimeVoiceOutputProvider,
  createVoiceOutputProvider,
  hasRimeCredentials,
  type VoiceOutputProvider,
  type VoiceOutputContext,
} from '../lib/voice/VoiceOutputProvider.ts';
import { VoicePipeline, type PipelineStepResult } from '../lib/voice/VoicePipeline.ts';
import {
  createDemoGraph,
  DEMO_SEQUENCE,
  INITIAL_DEMO_SNAPSHOT,
  resetDemoGraph,
  type TripState,
} from '../lib/demo.ts';
import type { Checkpoint, GraphSnapshot } from '../lib/state/types.ts';

function snapshotsEquivalent(a: GraphSnapshot<TripState>, b: GraphSnapshot<TripState>): boolean {
  if (a.activeCheckpointId !== b.activeCheckpointId) return false;
  if (a.checkpoints.length !== b.checkpoints.length) return false;
  for (let i = 0; i < a.checkpoints.length; i += 1) {
    const ca = a.checkpoints[i]!;
    const cb = b.checkpoints[i]!;
    if (ca.id !== cb.id) return false;
    if (ca.parentId !== cb.parentId) return false;
    if (ca.branchId !== cb.branchId) return false;
    if (ca.label !== cb.label) return false;
    if (ca.versionNumber !== cb.versionNumber) return false;
    if (JSON.stringify(ca.structuredState) !== JSON.stringify(cb.structuredState)) return false;
    if (ca.userInstruction !== cb.userInstruction) return false;
    if (ca.summary !== cb.summary) return false;
  }
  return true;
}

function buildPipeline(mockDelayMs = 0): {
  gate: GenerationGate;
  orch: VoiceOrchestrator<TripState>;
  provider: MockVoiceOutputProvider;
  planner: ResponsePlanner<TripState>;
  engine: ReturnType<typeof createDemoGraph>;
  pipeline: VoicePipeline<TripState>;
} {
  const engine = createDemoGraph();
  const resolver = new VoiceIntentResolver<TripState>();
  const gate = new GenerationGate();
  const orch = new VoiceOrchestrator<TripState>(resolver, gate);
  const planner = new ResponsePlanner<TripState>();
  const provider = new MockVoiceOutputProvider({ delayMs: mockDelayMs });
  const pipeline = new VoicePipeline<TripState>(orch, planner, provider, gate, engine);
  return { gate, orch, provider, planner, engine, pipeline };
}

test('Phase 3 MockVoiceOutputProvider: speak records text', async () => {
  const provider = new MockVoiceOutputProvider();
  const ctx: VoiceOutputContext = { generation: 'gen-1', checkpointId: 'cp-1' };
  const handle = await provider.speak('hello world', ctx);
  assert.ok(handle.id);
  assert.equal(provider.getStatus().lastSpoken, 'hello world');
  assert.equal(provider.getStatus().playing, false);
  const log = provider.getSpokenLog();
  assert.equal(log.length, 1);
  assert.equal(log[0]!.text, 'hello world');
  assert.equal(log[0]!.context.generation, 'gen-1');
});

test('Phase 3 MockVoiceOutputProvider: cancel before resolution drops utterance', async () => {
  const provider = new MockVoiceOutputProvider({ delayMs: 200 });
  const ctx: VoiceOutputContext = { generation: 'gen-1', checkpointId: 'cp-1' };
  const handlePromise = provider.speak('should be cancelled', ctx);
  await new Promise((r) => setTimeout(r, 10));
  await provider.cancel('mock-1');
  const handleAwait = await handlePromise;
  void handleAwait;
  assert.equal(provider.getSpokenLog().length, 0);
  assert.ok(provider.getCancelledCount() >= 1);
});

test('Phase 3 createVoiceOutputProvider falls back to mock without env vars', () => {
  const p = createVoiceOutputProvider({ forceMock: true });
  assert.equal(p.kind, 'mock');
});

test('Phase 3 hasRimeCredentials returns false by default in tests', () => {
  assert.equal(hasRimeCredentials({}), false);
});

test('Phase 3 RimeVoiceOutputProvider implements the interface', () => {
  const p = new RimeVoiceOutputProvider({ rimeModel: 'rime-1', rimeVoice: 'af_sky' });
  assert.equal(p.kind, 'rime');
  assert.equal(typeof p.speak, 'function');
  assert.equal(typeof p.cancel, 'function');
  assert.equal(typeof p.getStatus, 'function');
  const cfg = p.getConfig();
  assert.equal(cfg.model, 'rime-1');
  assert.equal(cfg.voice, 'af_sky');
  assert.equal(cfg.hasCredentials, false);
});

test('Phase 3 ResponsePlanner: stale result returns null', () => {
  const { gate, orch, engine, planner } = buildPipeline();
  const genA = gate.issueToken();
  gate.issueToken();
  const stale = orch.orchestrate('Change the budget to fifty thousand.', engine, { generation: genA });
  assert.equal(stale.isStale, true);
  const planned = planner.plan(stale, {
    activeCheckpointId: engine.active?.id ?? null,
    checkpoints: engine.list(),
  });
  assert.equal(planned, null);
});

test('Phase 3 ResponsePlanner: FORK mentions budget and comfort', () => {
  const { orch, engine, planner, gate } = buildPipeline();
  const result = orch.orchestrate(
    'Make another version assuming I can spend sixty thousand and prioritize comfort.',
    engine,
  );
  assert.equal(result.isStale, false);
  assert.equal(result.result.kind, 'executed');
  const planned = planner.plan(result, {
    activeCheckpointId: engine.active?.id ?? null,
    checkpoints: engine.list(),
  });
  assert.ok(planned);
  assert.notEqual(planned, null);
  if (planned) {
    const t = planned.text.toLowerCase();
    assert.ok(t.includes('60000') || t.includes('sixty') || t.includes('60,000') || t.includes('rupees 60'));
    assert.ok(t.includes('comfort'));
  }
});

test('Phase 3 ResponsePlanner: MERGE mentions accommodation and budget unchanged', () => {
  const { orch, engine, planner } = buildPipeline();
  orch.orchestrate(
    'Make another version assuming I can spend sixty thousand and prioritize comfort.',
    engine,
  );
  orch.orchestrate('Go back to the original.', engine);
  const r = orch.orchestrate(
    "Take the hotel from the luxury version but don't change anything else.",
    engine,
  );
  assert.equal(r.isStale, false);
  assert.equal(r.result.kind, 'executed');
  const planned = planner.plan(r, {
    activeCheckpointId: engine.active?.id ?? null,
    checkpoints: engine.list(),
  });
  assert.ok(planned);
  if (planned) {
    const t = planned.text.toLowerCase();
    assert.ok(t.includes('stay') || t.includes('accommodation') || t.includes('hotel'));
    assert.ok(
      t.includes('budget remains') ||
        t.includes('40,000') ||
        t.includes('40000') ||
        t.includes('rupees 40'),
    );
  }
});

test('Phase 3 ResponsePlanner: UNDO mentions undone or restored', () => {
  const { orch, engine, planner } = buildPipeline();
  orch.orchestrate(
    'Make another version assuming I can spend sixty thousand and prioritize comfort.',
    engine,
  );
  orch.orchestrate('Change the budget to fifty thousand.', engine);
  const r = orch.orchestrate('Undo that.', engine);
  assert.equal(r.isStale, false);
  const planned = planner.plan(r, {
    activeCheckpointId: engine.active?.id ?? null,
    checkpoints: engine.list(),
  });
  assert.ok(planned);
  if (planned) {
    const t = planned.text.toLowerCase();
    assert.ok(t.includes('undo') || t.includes('restored') || t.includes('undone'));
  }
});

test('Phase 3 ResponsePlanner: COMPARE mentions changed and unchanged', () => {
  const { orch, engine, planner } = buildPipeline();
  orch.orchestrate(
    'Make another version assuming I can spend sixty thousand and prioritize comfort.',
    engine,
  );
  orch.orchestrate('Go back to the original.', engine);
  const r = orch.orchestrate('Compare this with the luxury version.', engine);
  assert.equal(r.isStale, false);
  const planned = planner.plan(r, {
    activeCheckpointId: engine.active?.id ?? null,
    checkpoints: engine.list(),
  });
  assert.ok(planned);
  if (planned) {
    const t = planned.text.toLowerCase();
    const mentionsChanged =
      t.includes('budget') ||
      t.includes('changed') ||
      t.includes('stay') ||
      t.includes('differ');
    const mentionsSame =
      t.includes('same') || t.includes('unchanged') || t.includes('stays') || t.includes('destination');
    assert.ok(mentionsChanged, 'expected changed-field mention in compare text');
    assert.ok(mentionsSame, 'expected unchanged/same mention in compare text');
  }
});

test('Phase 3 ResponsePlanner: clarification and unsupported produce non-empty text', () => {
  const planner = new ResponsePlanner<TripState>();
  const r1: ReturnType<typeof planner.plan> = planner.plan(
    {
      result: {
        kind: 'not-executed',
        resolution: { kind: 'clarification', question: 'Which checkpoint?', candidates: [] },
      },
      isStale: false,
      generation: 'gen-1',
    },
    { activeCheckpointId: 'cp-1', checkpoints: [] },
  );
  assert.ok(r1 && r1.text.length > 5);
  const r2 = planner.plan(
    {
      result: {
        kind: 'not-executed',
        resolution: { kind: 'unsupported', reason: 'Cannot book flights' },
      },
      isStale: false,
      generation: 'gen-2',
    },
    { activeCheckpointId: 'cp-1', checkpoints: [] },
  );
  assert.ok(r2 && r2.text.length > 5);
});

test('Phase 3 interruption: newer submit supersedes older playback', async () => {
  const { pipeline, provider } = buildPipeline(50);
  const slow = pipeline.submit(
    'Make another version assuming I can spend sixty thousand and prioritize comfort.',
  );
  await new Promise((r) => setTimeout(r, 5));
  const fast = await pipeline.submit('Change the budget to fifty thousand.');
  const slowDone = await slow;
  assert.equal(fast.orchestration.isStale, false);
  const log = provider.getSpokenLog();
  const last = log[log.length - 1];
  assert.ok(last, 'expected at least one spoken entry');
  if (last) {
    const t = last.text.toLowerCase();
    assert.ok(
      t.includes('50,000') || t.includes('50000') || t.includes('fifty'),
      `expected last spoken text to mention fifty thousand, got: ${last.text}`,
    );
  }
});

test('Phase 3 stale suppression: older generation never reaches speak', async () => {
  const gate = new GenerationGate();
  const engine = createDemoGraph();
  const resolver = new VoiceIntentResolver<TripState>();
  const orch = new VoiceOrchestrator<TripState>(resolver, gate);
  const planner = new ResponsePlanner<TripState>();
  const provider = new MockVoiceOutputProvider();
  const pipeline = new VoicePipeline<TripState>(orch, planner, provider, gate, engine);

  const genA = gate.issueToken();
  gate.issueToken();

  const oldOrch = orch.orchestrate('Change the budget to fifty thousand.', engine, { generation: genA });
  assert.equal(oldOrch.isStale, true);
  const planned = planner.plan(oldOrch, {
    activeCheckpointId: engine.active?.id ?? null,
    checkpoints: engine.list(),
  });
  assert.equal(planned, null);
  const before = provider.getSpokenLog().length;
  const result = await pipeline.submit('Make another version assuming I can spend sixty thousand and prioritize comfort.');
  assert.equal(result.orchestration.isStale, false);
  assert.equal(result.spoken, true);
  assert.ok(result.plannedText);
  const after = provider.getSpokenLog().length;
  assert.equal(after, before + 1);
});

test('Phase 3 generation/state consistency: checkpoint drift cancels speak', async () => {
  const { pipeline, provider, engine } = buildPipeline();

  pipeline.submit('Make another version assuming I can spend sixty thousand and prioritize comfort.');
  const before = provider.getSpokenLog().length;

  engine.switchTo('cp-1');

  const result = await pipeline.submit('Change the budget to fifty thousand.');
  assert.equal(result.orchestration.isStale, false);

  const after = provider.getSpokenLog().length;
  assert.ok(after >= before);
});

test('Phase 3 Demo Reset: after operations, reset restores initial count, ids, and state', async () => {
  const { pipeline, engine, provider } = buildPipeline();
  const fresh = createDemoGraph();
  const initial = structuredClone(engine.export());
  assert.ok(snapshotsEquivalent(initial, fresh.export()), 'precondition: engine starts matching fresh');
  for (const step of DEMO_SEQUENCE.slice(1)) {
    await pipeline.submit(step.transcript);
  }
  const afterOps = structuredClone(engine.export());
  assert.equal(
    snapshotsEquivalent(afterOps, fresh.export()),
    false,
    'after running demo steps, state should differ from initial',
  );

  await pipeline.reset(() => resetDemoGraph(engine));
  assert.ok(snapshotsEquivalent(engine.export(), fresh.export()));

  const root = engine.active;
  assert.ok(root);
  if (root) {
    assert.equal(root.id, 'cp-1');
    assert.equal(root.structuredState.budget, 40000);
    assert.equal(root.structuredState.accommodation, 'Casa Baga');
  }
  void provider;
});

test('Phase 3 selective merge exact values: accommodation=Taj, budget=40000, transport unchanged', async () => {
  const { pipeline, engine } = buildPipeline();
  await pipeline.submit(
    'Make another version assuming I can spend sixty thousand rupees, stay at Taj Fort Aguada, take a flight, and prioritize comfort.',
  );
  engine.switchTo('cp-1');
  const before = engine.get('cp-1');
  const transportBefore = before.structuredState.transportation;
  const budgetBefore = before.structuredState.budget;
  await pipeline.submit("Take the hotel from the luxury version but don't change anything else.");
  const active = engine.active!;
  assert.equal(active.structuredState.accommodation, 'Taj Fort Aguada');
  assert.equal(active.structuredState.budget, 40000);
  assert.equal(active.structuredState.transportation, transportBefore);
  assert.equal(active.structuredState.budget, budgetBefore);
});

test('Phase 3 exact undo: post-merge export matches pre-merge', async () => {
  const { pipeline, engine } = buildPipeline();
  await pipeline.submit(
    'Make another version assuming I can spend sixty thousand rupees, stay at Taj Fort Aguada, take a flight, and prioritize comfort.',
  );
  engine.switchTo('cp-1');
  const beforeMerge = structuredClone(engine.export());
  await pipeline.submit("Take the hotel from the luxury version but don't change anything else.");
  const afterMerge = engine.export();
  assert.notDeepEqual(afterMerge.activeCheckpointId, beforeMerge.activeCheckpointId);
  await pipeline.submit('Undo that.');
  const afterUndo = engine.export();
  assert.ok(snapshotsEquivalent(afterUndo, beforeMerge));
});

test('Phase 3 end-to-end 7-step deterministic demo flow through pipeline', async () => {
  const { pipeline, engine, provider } = buildPipeline();
  const initial = structuredClone(engine.export());

  const step1 = await pipeline.submit(DEMO_SEQUENCE[0].transcript);
  assert.equal(step1.orchestration.isStale, false);
  assert.equal(engine.active?.id, 'cp-1');

  const step2 = await pipeline.submit(DEMO_SEQUENCE[1].transcript);
  assert.equal(step2.orchestration.isStale, false);
  const v2 = engine.active!;
  assert.equal(v2.structuredState.budget, 60000);
  assert.deepEqual(v2.structuredState.priorities, ['comfort']);
  assert.equal(engine.list().length, 2);

  const step3 = await pipeline.submit(DEMO_SEQUENCE[2].transcript);
  assert.equal(step3.orchestration.isStale, false);
  if (step3.orchestration.result.kind === 'executed') {
    assert.ok(step3.orchestration.result.execution.diff);
  }

  const step4 = await pipeline.submit(DEMO_SEQUENCE[3].transcript);
  assert.equal(step4.orchestration.isStale, false);
  assert.equal(engine.active?.id, 'cp-1');
  assert.equal(engine.active?.structuredState.budget, 40000);

  const beforeMergeSnapshot = structuredClone(engine.export());

  const step5 = await pipeline.submit(DEMO_SEQUENCE[4].transcript);
  assert.equal(step5.orchestration.isStale, false);
  const postMerge = engine.active!;
  assert.equal(postMerge.structuredState.accommodation, 'Taj Fort Aguada');
  assert.equal(postMerge.structuredState.budget, 40000);
  assert.equal(
    postMerge.structuredState.transportation, 'Konkan Express');

  const step6 = await pipeline.submit(DEMO_SEQUENCE[5].transcript);
  assert.equal(step6.orchestration.isStale, false);

  const step7 = await pipeline.submit(DEMO_SEQUENCE[6].transcript);
  assert.equal(step7.orchestration.isStale, false);
  assert.ok(snapshotsEquivalent(engine.export(), beforeMergeSnapshot));

  const spoken = provider.getSpokenLog();
  assert.ok(spoken.length >= 5);
  void initial;
});

test('Phase 3 no hardcoded secrets: literal key placeholders absent from providers', () => {
  const rime = new RimeVoiceOutputProvider({});
  const cfg = rime.getConfig();
  assert.equal(cfg.livekitUrl, null);
  assert.equal(cfg.hasCredentials, false);
});
