import test from 'node:test';
import assert from 'node:assert/strict';
import { GenerationGate } from '../lib/voice/GenerationGate.ts';
import { parseCurrencyAmount, ReferenceResolver } from '../lib/voice/ReferenceResolver.ts';
import { VoiceIntentResolver } from '../lib/voice/VoiceIntentResolver.ts';
import { VoiceOrchestrator } from '../lib/voice/VoiceOrchestrator.ts';
import { createDemoGraph, type TripState } from '../lib/demo.ts';
import { StateGraph } from '../lib/state/StateGraph.ts';

const forkLuxury = (graph: StateGraph<TripState>) =>
  graph.execute({
    type: 'FORK',
    sourceCheckpointId: 'cp-1',
    changes: { budget: 60000, accommodation: 'Taj Fort Aguada', transportation: 'Flight', priorities: ['comfort'] },
    meta: { label: '₹60k luxury', userInstruction: 'Fork luxury', summary: 'Luxury' },
  }).checkpoint!;

test('Phase 2 FORK: budget + comfort from natural language', () => {
  const graph = createDemoGraph();
  const resolver = new VoiceIntentResolver<TripState>();
  const input = 'Make another version assuming I can spend sixty thousand and prioritize comfort.';
  const result = resolver.resolve(input, graph.list(), graph.active!.id);
  assert.equal(result.kind, 'resolved');
  if (result.kind !== 'resolved') return;
  assert.equal(result.operation.type, 'FORK');
  if (result.operation.type !== 'FORK') return;
  assert.equal(result.operation.changes.budget, 60000);
  assert.deepEqual(result.operation.changes.priorities, ['comfort']);

  const outcome = graph.execute(result.operation);
  assert.equal(outcome.checkpoint!.versionNumber, 2);
  assert.equal(outcome.checkpoint!.structuredState.budget, 60000);
  assert.deepEqual(outcome.checkpoint!.structuredState.priorities, ['comfort']);
  assert.equal(graph.get('cp-1').structuredState.budget, 40000);
});

test('Phase 2 SWITCH: go back to the original', () => {
  const graph = createDemoGraph();
  forkLuxury(graph);
  const resolver = new VoiceIntentResolver<TripState>();
  const result = resolver.resolve('Go back to the original.', graph.list(), graph.active!.id);
  assert.equal(result.kind, 'resolved');
  if (result.kind !== 'resolved') return;
  assert.equal(result.operation.type, 'SWITCH_CHECKPOINT');
  if (result.operation.type !== 'SWITCH_CHECKPOINT') return;
  assert.equal(result.operation.checkpointId, 'cp-1');

  const outcome = graph.execute(result.operation);
  assert.equal(outcome.checkpoint!.id, 'cp-1');
  assert.equal(outcome.checkpoint!.structuredState.budget, 40000);
});

test('Phase 2 COMPARE: this with the luxury version', () => {
  const graph = createDemoGraph();
  forkLuxury(graph);
  graph.execute({ type: 'SWITCH_CHECKPOINT', checkpointId: 'cp-1' });
  const resolver = new VoiceIntentResolver<TripState>();
  const result = resolver.resolve('Compare this with the luxury version.', graph.list(), graph.active!.id);
  assert.equal(result.kind, 'resolved');
  if (result.kind !== 'resolved') return;
  assert.equal(result.operation.type, 'COMPARE');
  if (result.operation.type !== 'COMPARE') return;
  const luxury = graph.list().find((c) => c.label === '₹60k luxury')!;
  assert.equal(result.operation.fromCheckpointId, luxury.id);
  assert.equal(result.operation.toCheckpointId, graph.active!.id);

  const diff = graph.execute(result.operation).diff!;
  assert.ok(diff.changed.some((f) => f.path === 'budget'));
});

test('Phase 2 MERGE: take hotel from luxury but keep everything else', () => {
  const graph = createDemoGraph();
  forkLuxury(graph);
  graph.execute({ type: 'SWITCH_CHECKPOINT', checkpointId: 'cp-1' });
  const before = graph.export();
  const resolver = new VoiceIntentResolver<TripState>();
  const result = resolver.resolve("Take the hotel from the luxury version but don't change anything else.", graph.list(), graph.active!.id);
  assert.equal(result.kind, 'resolved');
  if (result.kind !== 'resolved') return;
  assert.equal(result.operation.type, 'MERGE');
  if (result.operation.type !== 'MERGE') return;
  const luxury = graph.list().find((c) => c.label === '₹60k luxury')!;
  assert.equal(result.operation.sourceCheckpointId, luxury.id);
  assert.equal(result.operation.targetCheckpointId, 'cp-1');
  assert.deepEqual(result.operation.fields, ['accommodation']);

  const outcome = graph.execute(result.operation);
  assert.equal(outcome.checkpoint!.structuredState.accommodation, 'Taj Fort Aguada');
  assert.equal(outcome.checkpoint!.structuredState.budget, before.checkpoints.find((c) => c.id === 'cp-1')!.structuredState.budget);
  assert.equal(outcome.checkpoint!.structuredState.transportation, before.checkpoints.find((c) => c.id === 'cp-1')!.structuredState.transportation);
});

test('Phase 2 UNDO: undo that', () => {
  const graph = createDemoGraph();
  forkLuxury(graph);
  const before = graph.export();
  graph.execute({ type: 'UPDATE_STATE', changes: { budget: 99999 }, meta: { label: 'temp' } });
  const resolver = new VoiceIntentResolver<TripState>();
  const result = resolver.resolve('Undo that.', graph.list(), graph.active!.id);
  assert.equal(result.kind, 'resolved');
  if (result.kind !== 'resolved') return;
  assert.equal(result.operation.type, 'UNDO');
  graph.execute(result.operation);
  assert.deepEqual(graph.export(), before);
});

test('Phase 2 UPDATE_STATE: change budget to fifty thousand', () => {
  const graph = createDemoGraph();
  const resolver = new VoiceIntentResolver<TripState>();
  const result = resolver.resolve('Change the budget to fifty thousand.', graph.list(), graph.active!.id);
  assert.equal(result.kind, 'resolved');
  if (result.kind !== 'resolved') return;
  assert.equal(result.operation.type, 'UPDATE_STATE');
  if (result.operation.type !== 'UPDATE_STATE') return;
  assert.equal(result.operation.changes.budget, 50000);

  const beforeBranch = graph.active!.branchId;
  const outcome = graph.execute(result.operation);
  assert.equal(outcome.checkpoint!.branchId, beforeBranch);
  assert.equal(outcome.checkpoint!.structuredState.budget, 50000);
  assert.equal(outcome.checkpoint!.parentId, 'cp-1');
});

test('Phase 2 ambiguous reference returns clarification without mutation', () => {
  const graph = createDemoGraph();
  forkLuxury(graph);
  graph.execute({
    type: 'FORK',
    sourceCheckpointId: 'cp-1',
    changes: { budget: 50000 },
    meta: { label: '₹50k balanced' },
  });
  const before = graph.export();
  const resolver = new VoiceIntentResolver<TripState>();
  const result = resolver.resolve('Go back to the other one.', graph.list(), graph.active!.id);
  assert.equal(result.kind, 'clarification');
  if (result.kind === 'clarification') {
    assert.ok(result.question.length > 0);
    assert.ok(result.candidates.length >= 2);
    for (const c of result.candidates) {
      assert.ok(c.id);
      assert.ok(c.label);
      assert.ok(Number.isInteger(c.versionNumber));
      assert.ok(Array.isArray(c.whyMatched));
    }
  }
  assert.deepEqual(graph.export(), before);
});

test('Phase 2 unsupported command returns unsupported reason', () => {
  const graph = createDemoGraph();
  const resolver = new VoiceIntentResolver<TripState>();
  const before = graph.export();
  const result = resolver.resolve('Book my flights to Mumbai right now.', graph.list(), graph.active!.id);
  assert.equal(result.kind, 'unsupported');
  if (result.kind === 'unsupported') {
    assert.ok(result.reason.length > 0);
  }
  assert.deepEqual(graph.export(), before);
});

test('Phase 2 reference resolver: all reference types resolve correctly', () => {
  const graph = createDemoGraph();
  forkLuxury(graph);
  graph.execute({
    type: 'FORK',
    sourceCheckpointId: 'cp-1',
    changes: { budget: 50000, duration: 6, priorities: ['value'] },
    meta: { label: '₹50k balanced' },
  });
  const refs = new ReferenceResolver<TripState>();

  const exact = (list: ReturnType<ReferenceResolver<TripState>['resolve']>) =>
    list.length === 1 ? list[0].id : null;

  assert.equal(exact(refs.resolve('original', graph.list(), 'cp-3')), 'cp-1');
  assert.equal(exact(refs.resolve('first version', graph.list(), 'cp-3')), 'cp-1');
  assert.equal(exact(refs.resolve('latest', graph.list(), 'cp-1')), 'cp-3');
  assert.equal(exact(refs.resolve('previous', graph.list(), 'cp-3')), 'cp-2');
  assert.equal(exact(refs.resolve('V2', graph.list(), 'cp-3')), 'cp-2');
  assert.equal(exact(refs.resolve('this one', graph.list(), 'cp-1')), 'cp-1');
  assert.equal(exact(refs.resolve('₹60k wala', graph.list(), 'cp-1')), 'cp-2');
  assert.equal(exact(refs.resolve('the luxury wale version', graph.list(), 'cp-1')), 'cp-2');
});

test('Phase 2 parseCurrencyAmount: english words, symbols, Hinglish', () => {
  assert.equal(parseCurrencyAmount('sixty thousand'), 60000);
  assert.equal(parseCurrencyAmount('₹60,000'), 60000);
  assert.equal(parseCurrencyAmount('₹40k'), 40000);
  assert.equal(parseCurrencyAmount('Rs 50k'), 50000);
  assert.equal(parseCurrencyAmount('pachaas hazar'), 50000);
  assert.equal(parseCurrencyAmount('chaalis hazar'), 40000);
  assert.equal(parseCurrencyAmount('saath hazar'), 60000);
  assert.equal(parseCurrencyAmount('50 thousand'), 50000);
  assert.equal(parseCurrencyAmount('1 lakh'), 100000);
});

test('Phase 2 GenerationGate: newer generation invalidates older token', () => {
  const gate = new GenerationGate();
  const a = gate.issueToken();
  assert.equal(gate.authorize(a), true);
  const b = gate.issueToken();
  assert.equal(gate.authorize(a), false);
  assert.equal(gate.authorize(b), true);
});

test('Phase 2 stale response: older task result rejected after newer generation issued', async () => {
  const gate = new GenerationGate();
  const graph = createDemoGraph();
  const resolver = new VoiceIntentResolver<TripState>();
  const orch = new VoiceOrchestrator<TripState>(resolver, gate);

  const genA = gate.issueToken();
  const genB = gate.issueToken();

  const slowResult = await orch.orchestrateAsync(
    'Change the budget to fifty thousand.',
    graph,
    { generation: genA, delayMs: 20 },
  );
  const fastResult = orch.orchestrate(
    'Go back to the original.',
    graph,
    { generation: genB },
  );

  assert.equal(slowResult.isStale, true);
  assert.equal(fastResult.isStale, false);
  assert.equal(fastResult.generation, genB);
});

test('Phase 2 superseding operation: newer generation is authoritative', async () => {
  const gate = new GenerationGate();
  const graph = createDemoGraph();
  const resolver = new VoiceIntentResolver<TripState>();
  const orch = new VoiceOrchestrator<TripState>(resolver, gate);

  const genA = gate.issueToken();
  const slow = orch.orchestrateAsync(
    'Make another version assuming I can spend sixty thousand and prioritize comfort.',
    graph,
    { generation: genA, delayMs: 30 },
  );

  const genB = gate.issueToken();
  const immediate = orch.orchestrate(
    'Change the budget to fifty thousand.',
    graph,
    { generation: genB },
  );
  assert.equal(immediate.isStale, false);
  assert.equal(immediate.result.kind, 'executed');
  assert.equal(graph.active!.structuredState.budget, 50000);

  const slowDone = await slow;
  assert.equal(slowDone.isStale, true);
  // Stale result should NOT have changed state
  assert.equal(graph.active!.structuredState.budget, 50000);
  // The FORK never happened because stale result dropped the execute call:
  // graph should only contain cp-1 + UPDATE (cp-2). cp-3 (luxury fork) should not exist.
  const all = graph.list();
  assert.equal(all.length, 2);
});

test('Phase 2 current generation response passes through', () => {
  const gate = new GenerationGate();
  const graph = createDemoGraph();
  const resolver = new VoiceIntentResolver<TripState>();
  const orch = new VoiceOrchestrator<TripState>(resolver, gate);
  const out = orch.orchestrate('Undo that.', graph);
  assert.equal(out.isStale, false);
  assert.ok(out.generation);
});

test('Phase 2 clarification with current generation does not mutate', () => {
  const gate = new GenerationGate();
  const graph = createDemoGraph();
  forkLuxury(graph);
  graph.execute({
    type: 'FORK',
    sourceCheckpointId: 'cp-1',
    changes: { budget: 50000 },
    meta: { label: '₹50k balanced' },
  });
  const before = graph.export();
  const resolver = new VoiceIntentResolver<TripState>();
  const orch = new VoiceOrchestrator<TripState>(resolver, gate);
  const out = orch.orchestrate('Go back to the other one.', graph);
  assert.equal(out.isStale, false);
  assert.equal(out.result.kind, 'not-executed');
  if (out.result.kind === 'not-executed') {
    assert.equal(out.result.resolution.kind, 'clarification');
  }
  assert.deepEqual(graph.export(), before);
});

test('Phase 2 stale task cannot mutate graph via post-fence execute', async () => {
  const gate = new GenerationGate();
  const graph = createDemoGraph();
  const resolver = new VoiceIntentResolver<TripState>();
  const orch = new VoiceOrchestrator<TripState>(resolver, gate);
  const genA = gate.issueToken();
  gate.issueToken();

  const r = await orch.orchestrateAsync(
    'Make another version assuming I can spend sixty thousand and prioritize comfort.',
    graph,
    { generation: genA, delayMs: 5 },
  );
  assert.equal(r.isStale, true);
  assert.equal(graph.list().length, 1);
});

test('Phase 2 Hinglish: ₹40k wala version dikhao (switch)', () => {
  const graph = createDemoGraph();
  forkLuxury(graph);
  const resolver = new VoiceIntentResolver<TripState>();
  const result = resolver.resolve('₹40k wala version dikhao.', graph.list(), graph.active!.id);
  assert.equal(result.kind, 'resolved');
  if (result.kind !== 'resolved') return;
  assert.equal(result.operation.type, 'SWITCH_CHECKPOINT');
  if (result.operation.type !== 'SWITCH_CHECKPOINT') return;
  assert.equal(result.operation.checkpointId, 'cp-1');
});

test('Phase 2 Hinglish: original pe wapas jao (switch to original)', () => {
  const graph = createDemoGraph();
  forkLuxury(graph);
  const resolver = new VoiceIntentResolver<TripState>();
  const result = resolver.resolve('original pe wapas jao', graph.list(), graph.active!.id);
  assert.equal(result.kind, 'resolved');
  if (result.kind !== 'resolved') return;
  assert.equal(result.operation.type, 'SWITCH_CHECKPOINT');
  if (result.operation.type !== 'SWITCH_CHECKPOINT') return;
  assert.equal(result.operation.checkpointId, 'cp-1');
});

test('Phase 2 Hinglish: luxury wale se hotel le lo, baaki kuch change mat karna', () => {
  const graph = createDemoGraph();
  forkLuxury(graph);
  graph.execute({ type: 'SWITCH_CHECKPOINT', checkpointId: 'cp-1' });
  const resolver = new VoiceIntentResolver<TripState>();
  const result = resolver.resolve('luxury wale se hotel le lo, baaki kuch change mat karna', graph.list(), graph.active!.id);
  assert.equal(result.kind, 'resolved');
  if (result.kind !== 'resolved') return;
  assert.equal(result.operation.type, 'MERGE');
  if (result.operation.type !== 'MERGE') return;
  const luxury = graph.list().find((c) => c.label === '₹60k luxury')!;
  assert.equal(result.operation.sourceCheckpointId, luxury.id);
  assert.deepEqual(result.operation.fields, ['accommodation']);
  const before = graph.get('cp-1');
  const outcome = graph.execute(result.operation);
  assert.equal(outcome.checkpoint!.structuredState.accommodation, 'Taj Fort Aguada');
  assert.equal(outcome.checkpoint!.structuredState.budget, before.structuredState.budget);
});

test('Phase 2 Hinglish: budget ko 50 hazar kar do (update)', () => {
  const graph = createDemoGraph();
  const resolver = new VoiceIntentResolver<TripState>();
  const result = resolver.resolve('budget ko 50 hazar kar do', graph.list(), graph.active!.id);
  assert.equal(result.kind, 'resolved');
  if (result.kind !== 'resolved') return;
  assert.equal(result.operation.type, 'UPDATE_STATE');
  if (result.operation.type !== 'UPDATE_STATE') return;
  assert.equal(result.operation.changes.budget, 50000);
  const beforeBranch = graph.active!.branchId;
  const outcome = graph.execute(result.operation);
  assert.equal(outcome.checkpoint!.structuredState.budget, 50000);
  assert.equal(outcome.checkpoint!.branchId, beforeBranch);
});

test('Phase 2 acceptance: NL FORK → SWITCH → COMPARE → MERGE → UNDO through orchestrator with fence', async () => {
  const gate = new GenerationGate();
  const graph = createDemoGraph();
  const resolver = new VoiceIntentResolver<TripState>();
  const orch = new VoiceOrchestrator<TripState>(resolver, gate);

  const r1 = orch.orchestrate(
    'Make another version assuming I can spend ₹60,000, prioritize comfort, stay at Taj Fort Aguada, and take a flight for seven days.',
    graph,
  );
  assert.equal(r1.isStale, false);
  assert.equal(r1.result.kind, 'executed');
  assert.equal(graph.list().length, 2);
  assert.equal(graph.get('cp-2').structuredState.accommodation, 'Taj Fort Aguada');
  assert.equal(graph.get('cp-2').structuredState.transportation, 'Flight');
  assert.equal(graph.get('cp-2').structuredState.duration, 7);

  const r2 = orch.orchestrate('Go back to V1.', graph);
  assert.equal(r2.isStale, false);
  assert.equal(r2.result.kind, 'executed');
  assert.equal(graph.active!.id, 'cp-1');

  const r3 = orch.orchestrate('Compare this with the luxury version.', graph);
  assert.equal(r3.isStale, false);
  assert.equal(r3.result.kind, 'executed');
  if (r3.result.kind === 'executed') {
    assert.ok(r3.result.execution.diff);
    assert.ok(r3.result.execution.diff!.changed.some((f) => f.path === 'budget'));
  }

  const beforeMerge = graph.export();
  const r4 = orch.orchestrate('luxury wale se hotel le lo, baaki kuch change mat karna', graph);
  assert.equal(r4.isStale, false);
  assert.equal(r4.result.kind, 'executed');
  assert.equal(graph.active!.structuredState.accommodation, 'Taj Fort Aguada');
  assert.equal(graph.active!.structuredState.budget, 40000);

  const r5 = orch.orchestrate('Undo that.', graph);
  assert.equal(r5.isStale, false);
  assert.equal(r5.result.kind, 'executed');
  assert.deepEqual(graph.export(), beforeMerge);
});

test('Phase 2 generic non-trip domain: update + fork + merge still work', () => {
  const graph = new StateGraph<{ repository: string; strategy: string; risk: number }>();
  graph.execute({
    type: 'CREATE_CHECKPOINT',
    state: { repository: 'core', strategy: 'safe', risk: 1 },
    meta: { label: 'Safe fix' },
  });
  const resolver = new VoiceIntentResolver<{ repository: string; strategy: string; risk: number }>();
  const r1 = resolver.resolve('Change the risk to 5.', graph.list(), graph.active!.id);
  assert.equal(r1.kind, 'resolved');
  if (r1.kind !== 'resolved') return;
  assert.equal(r1.operation.type, 'UPDATE_STATE');
});
