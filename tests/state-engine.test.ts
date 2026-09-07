import test from 'node:test';
import assert from 'node:assert/strict';
import { IntentResolver } from '../lib/agent/IntentResolver.ts';
import { createDemoGraph, type TripState } from '../lib/demo.ts';
import { StateGraph } from '../lib/state/StateGraph.ts';

const forkLuxury = (graph: StateGraph<TripState>) => graph.fork('cp-1', { budget: 60000, accommodation: 'Taj Fort Aguada', transportation: 'Flight', priorities: ['comfort'] }, { label: '₹60k luxury' });

test('fork creates an isolated child and preserves its parent', () => {
  const graph = createDemoGraph();
  forkLuxury(graph);
  assert.equal(graph.get('cp-1').structuredState.budget, 40000);
  assert.equal(graph.get('cp-2').structuredState.budget, 60000);
});

test('switching selects the exact branch state', () => {
  const graph = createDemoGraph(); forkLuxury(graph);
  graph.switchTo('cp-1'); assert.equal(graph.active?.structuredState.budget, 40000);
  graph.switchTo('cp-2'); assert.equal(graph.active?.structuredState.budget, 60000);
});

test('selective merge changes only the requested field', () => {
  const graph = createDemoGraph(); forkLuxury(graph); graph.switchTo('cp-1');
  const before = graph.active!.structuredState;
  const merged = graph.merge('cp-2', 'cp-1', ['accommodation'], { label: 'Practical + luxury hotel' });
  assert.equal(merged.structuredState.accommodation, 'Taj Fort Aguada');
  assert.equal(merged.structuredState.budget, 40000);
  assert.equal(merged.structuredState.transportation, before.transportation);
});

test('diff classifies changed and unchanged fields', () => {
  const graph = createDemoGraph(); forkLuxury(graph);
  const diff = graph.compare('cp-1', 'cp-2');
  assert.ok(diff.changed.some((field) => field.path === 'budget'));
  assert.ok(diff.unchanged.some((field) => field.path === 'destination'));
  assert.equal(diff.added.length, 0);
});

test('diff and merge support nested semantic field paths', () => {
  const graph = createDemoGraph();
  const source = graph.fork('cp-1', { preferences: { pace: 'slow', room: 'sea-view' } }, { label: 'Sea-view plan' });
  const diff = graph.compare('cp-1', source.id);
  assert.ok(diff.changed.some((field) => field.path === 'preferences.pace'));
  assert.ok(diff.added.some((field) => field.path === 'preferences.room'));
  const merged = graph.merge(source.id, 'cp-1', ['preferences.room'], { label: 'Practical + sea view' });
  assert.deepEqual(merged.structuredState.preferences, { pace: 'balanced', room: 'sea-view' });
});

test('undo restores the exact previous graph and active state', () => {
  const graph = createDemoGraph(); forkLuxury(graph); graph.switchTo('cp-1');
  const before = graph.export();
  graph.merge('cp-2', 'cp-1', ['accommodation'], { label: 'Temporary merge' });
  graph.undo();
  assert.deepEqual(graph.export(), before);
});

test('branch contamination cannot occur through returned snapshots', () => {
  const graph = createDemoGraph(); forkLuxury(graph); graph.switchTo('cp-1');
  const external = graph.active!.structuredState;
  external.budget = 999999;
  assert.equal(graph.active!.structuredState.budget, 40000);
  assert.equal(graph.get('cp-2').structuredState.budget, 60000);
});

test('nested fork preserves ancestry', () => {
  const graph = createDemoGraph(); forkLuxury(graph);
  const third = graph.fork('cp-2', { duration: 7 }, { label: 'Seven-day luxury' });
  assert.equal(third.parentId, 'cp-2');
  assert.equal(graph.get(third.parentId!).parentId, 'cp-1');
});

test('natural-language resolver maps realistic phrases', () => {
  const graph = createDemoGraph(); forkLuxury(graph); graph.switchTo('cp-1');
  const resolver = new IntentResolver<TripState>();
  const result = resolver.resolve('Take the hotel from the luxury version, but keep everything else from this one.', graph.list(), graph.active!.id);
  assert.equal(result.status, 'resolved');
  if (result.status === 'resolved') {
    assert.equal(result.operation.type, 'MERGE');
    if (result.operation.type === 'MERGE') assert.deepEqual(result.operation.fields, ['accommodation']);
  }
});

test('regression: formatted budget and comfort priority reach the forked checkpoint', () => {
  const graph = createDemoGraph();
  const input = 'Make another version assuming I can spend ₹60,000 and prioritize comfort.';
  const result = new IntentResolver<TripState>().resolve(input, graph.list(), graph.active!.id);

  assert.equal(result.status, 'resolved');
  if (result.status !== 'resolved') return;
  assert.equal(result.operation.type, 'FORK');
  if (result.operation.type !== 'FORK') return;
  assert.deepEqual(result.operation.changes, { budget: 60000, priorities: ['comfort'] });

  const created = graph.execute(result.operation).checkpoint!;
  assert.equal(created.versionNumber, 2);
  assert.equal(created.structuredState.budget, 60000);
  assert.deepEqual(created.structuredState.priorities, ['comfort']);
  assert.equal(graph.get('cp-1').structuredState.budget, 40000);
  assert.deepEqual(graph.get('cp-1').structuredState.priorities, ['value', 'local food']);
});

test('ambiguous references request clarification without mutation', () => {
  const graph = createDemoGraph(); forkLuxury(graph);
  graph.fork('cp-1', { budget: 50000 }, { label: '₹50k balanced' });
  const before = graph.export();
  const result = new IntentResolver<TripState>().resolve('Go back to the other one.', graph.list(), graph.active!.id);
  assert.equal(result.status, 'clarification');
  assert.deepEqual(graph.export(), before);
});

test('Phase 1 acceptance: fork, switch, compare, selective merge, undo', () => {
  const graph = createDemoGraph();
  forkLuxury(graph);
  graph.switchTo('cp-1');
  assert.equal(graph.active!.structuredState.budget, 40000);
  const diff = graph.compare('cp-1', 'cp-2');
  assert.ok(diff.changed.some((field) => field.path === 'budget'));
  const beforeMerge = graph.export();
  graph.merge('cp-2', 'cp-1', ['accommodation'], { label: 'Practical + luxury hotel' });
  assert.equal(graph.active!.structuredState.accommodation, 'Taj Fort Aguada');
  assert.equal(graph.active!.structuredState.budget, 40000);
  graph.undo();
  assert.deepEqual(graph.export(), beforeMerge);
});

test('generic state model supports a non-trip domain', () => {
  const graph = new StateGraph<{ repository: string; strategy: string; risk: number }>();
  graph.create({ repository: 'core', strategy: 'safe', risk: 1 }, { label: 'Safe fix' });
  graph.fork('cp-1', { strategy: 'rewrite', risk: 5 }, { label: 'Rewrite' });
  assert.equal(graph.get('cp-1').structuredState.strategy, 'safe');
});
