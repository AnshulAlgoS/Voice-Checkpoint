'use client';

import { useMemo, useState } from 'react';
import { ArrowDownToLine, GitBranch, GitCompareArrows, History, RotateCcw, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { IntentResolver } from '@/lib/agent/IntentResolver';
import { createDemoGraph, type TripState } from '@/lib/demo';
import type { GraphSnapshot, StateDiff } from '@/lib/state/types';

const fieldLabels: Record<string, string> = { budget: 'Budget', accommodation: 'Stay', transportation: 'Travel', duration: 'Duration', priorities: 'Priorities', destination: 'Destination' };

function displayValue(key: string, value: unknown) {
  if (key === 'budget' && typeof value === 'number') return `₹${value.toLocaleString('en-IN')}`;
  if (key === 'duration') return `${String(value)} days`;
  if (Array.isArray(value)) return value.join(' · ');
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : '—';
}

export function VoiceCheckpoint() {
  const [engine] = useState(createDemoGraph);
  const resolver = useMemo(() => new IntentResolver<TripState>(), []);
  const [snapshot, setSnapshot] = useState<GraphSnapshot<TripState>>(engine.export());
  const [diff, setDiff] = useState<StateDiff | null>(null);
  const [command, setCommand] = useState('');
  const [notice, setNotice] = useState('Version A is active and isolated.');
  const active = snapshot.checkpoints.find((checkpoint) => checkpoint.id === snapshot.activeCheckpointId)!;

  const refresh = (message: string) => { setSnapshot(engine.export()); setNotice(message); };

  const forkLuxury = () => {
    const existing = snapshot.checkpoints.find((item) => item.label === '₹60k luxury');
    if (existing) { engine.switchTo(existing.id); refresh('Luxury branch is active.'); return; }
    engine.fork('cp-1', { budget: 60000, accommodation: 'Taj Fort Aguada', transportation: 'Flight', priorities: ['comfort'] }, { label: '₹60k luxury', userInstruction: 'Make another version with a ₹60k budget.', summary: 'Comfort-first Goa plan.' });
    setDiff(null); refresh('Forked Version B. Version A remains unchanged.');
  };

  const switchOriginal = () => { engine.switchTo('cp-1'); setDiff(null); refresh('Switched to Version A. Its ₹40k budget is intact.'); };
  const compare = () => {
    const luxury = snapshot.checkpoints.find((item) => item.label === '₹60k luxury');
    if (!luxury) return setNotice('Create the luxury fork first.');
    setDiff(engine.compare('cp-1', luxury.id)); setNotice('Comparison is computed from semantic state.');
  };
  const mergeHotel = () => {
    const luxury = snapshot.checkpoints.find((item) => item.label === '₹60k luxury');
    if (!luxury) return setNotice('Create the luxury fork first.');
    if (engine.active?.id !== 'cp-1') return setNotice('Switch to Version A before the acceptance merge.');
    engine.merge(luxury.id, 'cp-1', ['accommodation'], { label: 'A · hotel from B', userInstruction: 'Take only the hotel from the luxury version.', summary: 'Practical plan with the luxury hotel.' });
    setDiff(null); refresh('Merged accommodation only. Budget remains ₹40,000.');
  };
  const undo = () => {
    try { engine.undo(); setDiff(null); refresh('Restored the exact graph and active state from before the last operation.'); }
    catch (error) { setNotice(error instanceof Error ? error.message : 'Nothing to undo.'); }
  };
  const runCommand = () => {
    const result = resolver.resolve(command, engine.list(), engine.active?.id ?? null);
    if (result.status !== 'resolved') { setNotice(result.message); return; }
    try {
      const outcome = engine.execute(result.operation);
      setDiff(outcome.diff ?? null); setSnapshot(outcome.snapshot);
      setNotice(`${result.operation.type.replaceAll('_', ' ').toLowerCase()} · ${Math.round(result.confidence * 100)}% confidence`); setCommand('');
    } catch (error) { setNotice(error instanceof Error ? error.message : 'The operation failed without changing state.'); }
  };

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-[1480px] px-5 py-5 md:px-8 md:py-7">
        <header className="mb-6 flex flex-col justify-between gap-4 border-b border-border/70 pb-5 md:flex-row md:items-end">
          <div>
            <div className="mb-2 flex items-center gap-2 text-[0.72rem] font-bold uppercase tracking-[0.18em] text-primary"><Sparkles className="size-3.5" /> Voice Checkpoint</div>
            <h1 className="font-heading text-[clamp(1.65rem,3vw,2.65rem)] font-semibold tracking-[-0.045em]">Think out loud. Change your mind. Keep every version.</h1>
          </div>
          <div className="flex items-center gap-2 self-start rounded-full border border-cyan-400/25 bg-cyan-400/10 px-3 py-2 text-xs font-semibold text-cyan-300 md:self-auto"><span className="size-2 rounded-full bg-cyan-300 shadow-[0_0_12px_rgba(103,232,249,.8)]" /> Phase 1 · semantic engine</div>
        </header>

        <section className="grid gap-5 xl:grid-cols-[minmax(0,1.25fr)_minmax(360px,.75fr)]">
          <div className="rounded-[1.65rem] border border-border bg-card p-5 shadow-[0_24px_80px_rgba(0,0,0,.22)] md:p-7">
            <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
              <div><p className="mb-1 text-xs font-bold uppercase tracking-[0.16em] text-primary">Active checkpoint</p><h2 className="text-2xl font-semibold tracking-tight">V{active.versionNumber} · {active.label}</h2><p className="mt-1 text-sm text-muted-foreground">{active.summary}</p></div>
              <span className="rounded-full bg-primary/12 px-3 py-1.5 text-xs font-bold text-primary">{active.branchId}</span>
            </div>
            <div className="grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-border bg-border md:grid-cols-3">
              {['destination', 'budget', 'accommodation', 'transportation', 'duration', 'priorities'].map((key) => <div key={key} className="min-h-28 bg-card p-4 md:p-5"><div className="mb-5 text-xs font-medium text-muted-foreground">{fieldLabels[key]}</div><div className="text-base font-semibold leading-snug md:text-lg">{displayValue(key, active.structuredState[key])}</div></div>)}
            </div>
            <div className="mt-5 rounded-2xl border border-border bg-muted/45 p-4">
              <div className="mb-3 flex items-center gap-2 text-xs font-bold uppercase tracking-[0.13em] text-muted-foreground"><History className="size-4" /> Operation console</div>
              <div className="flex flex-col gap-2 sm:flex-row"><Input value={command} onChange={(event) => setCommand(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && runCommand()} placeholder="Try: take the hotel from the luxury version" aria-label="Semantic state command" className="h-11 bg-background" /><Button onClick={runCommand} className="h-11 px-5">Resolve</Button></div>
              <p aria-live="polite" className="mt-3 min-h-5 text-sm text-muted-foreground">{notice}</p>
            </div>
          </div>

          <aside className="space-y-5">
            <div className="rounded-[1.65rem] border border-border bg-card p-5 md:p-6">
              <div className="mb-5 flex items-center justify-between"><div><p className="text-xs font-bold uppercase tracking-[0.16em] text-muted-foreground">State graph</p><h2 className="mt-1 text-lg font-semibold">Decision lineage</h2></div><span className="text-xs text-muted-foreground">{snapshot.checkpoints.length} checkpoints</span></div>
              <div className="relative space-y-3 before:absolute before:bottom-5 before:left-[17px] before:top-5 before:w-px before:bg-border">
                {snapshot.checkpoints.map((checkpoint) => <button key={checkpoint.id} onClick={() => { engine.switchTo(checkpoint.id); setDiff(null); refresh(`Switched to ${checkpoint.label}.`); }} className={`relative flex w-full items-center gap-3 rounded-xl border p-3 text-left transition ${checkpoint.id === active.id ? 'border-primary/60 bg-primary/10 shadow-[0_0_0_3px_rgba(250,204,21,.05)]' : 'border-border bg-muted/25 hover:bg-muted/55'}`}><span className={`z-10 grid size-9 shrink-0 place-items-center rounded-full border text-xs font-bold ${checkpoint.id === active.id ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-card text-muted-foreground'}`}>V{checkpoint.versionNumber}</span><span className="min-w-0"><span className="block truncate text-sm font-semibold">{checkpoint.label}</span><span className="block truncate text-xs text-muted-foreground">{checkpoint.parentId ? `from ${checkpoint.parentId}` : 'root checkpoint'}</span></span></button>)}
              </div>
            </div>
            <div className="rounded-[1.65rem] border border-border bg-card p-5 md:p-6"><p className="mb-4 text-xs font-bold uppercase tracking-[0.16em] text-muted-foreground">Acceptance path</p><div className="grid grid-cols-2 gap-2"><Button variant="outline" onClick={forkLuxury}><GitBranch /> Fork B</Button><Button variant="outline" onClick={switchOriginal}><ArrowDownToLine /> Switch A</Button><Button variant="outline" onClick={compare}><GitCompareArrows /> Compare</Button><Button variant="outline" onClick={mergeHotel}><Sparkles /> Merge hotel</Button><Button variant="outline" onClick={undo} className="col-span-2"><RotateCcw /> Undo last</Button></div></div>
          </aside>
        </section>

        {diff && <section className="mt-5 rounded-[1.65rem] border border-border bg-card p-5 md:p-7"><div className="mb-4 flex items-center gap-2"><GitCompareArrows className="size-5 text-primary" /><h2 className="text-lg font-semibold">Semantic diff</h2><span className="text-sm text-muted-foreground">{diff.fromCheckpointId} → {diff.toCheckpointId}</span></div><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{diff.changed.map((change) => <div key={change.path} className="rounded-xl border border-amber-300/20 bg-amber-300/5 p-4"><p className="mb-2 text-xs font-bold uppercase tracking-wider text-amber-300">{fieldLabels[change.path] ?? change.path}</p><p className="text-sm"><span className="text-muted-foreground line-through">{displayValue(change.path, change.before)}</span><span className="mx-2 text-amber-300">→</span><span className="font-semibold">{displayValue(change.path, change.after)}</span></p></div>)}</div></section>}
      </div>
    </main>
  );
}
