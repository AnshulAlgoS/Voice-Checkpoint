'use client';

import { useMemo, useState } from 'react';
import { Mic, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Alert } from '@/components/ui/alert';
import { Card } from '@/components/ui/card';
import { GenerationGate } from '@/lib/voice/GenerationGate';
import { VoiceIntentResolver } from '@/lib/voice/VoiceIntentResolver';
import { VoiceOrchestrator, type OrchestratorResult } from '@/lib/voice/VoiceOrchestrator';
import { createDemoGraph, type TripState } from '@/lib/demo';
import type { GraphSnapshot, StateDiff } from '@/lib/state/types';
import type { ResolutionResult } from '@/lib/voice/types';

export function VoiceDebug() {
  const [engine] = useState(createDemoGraph);
  const resolver = useMemo(() => new VoiceIntentResolver<TripState>(), []);
  const [gate] = useState(() => new GenerationGate());
  const orch = useMemo(() => new VoiceOrchestrator<TripState>(resolver, gate), [resolver, gate]);

  const [snapshot, setSnapshot] = useState<GraphSnapshot<TripState>>(engine.export());
  const [diff, setDiff] = useState<StateDiff | null>(null);
  const [transcript, setTranscript] = useState('');
  const [lastResolution, setLastResolution] = useState<ResolutionResult<TripState> | null>(null);
  const [_lastGeneration, setLastGeneration] = useState<string>('');
  const [taskGeneration, setTaskGeneration] = useState<string>('');
  const [wasStale, setWasStale] = useState(false);
  const [banner, setBanner] = useState<{ kind: 'ok' | 'err' | 'info' | 'warn'; text: string } | null>(null);
  const [sourceCp, setSourceCp] = useState<string>('');
  const [targetCp, setTargetCp] = useState<string>('');

  const active = snapshot.checkpoints.find((c) => c.id === snapshot.activeCheckpointId);

  function applyResult(result: OrchestratorResult<TripState>) {
    setTaskGeneration(result.generation);
    setLastGeneration(gate.currentGeneration);
    setWasStale(result.isStale);

    if (result.isStale) {
      setBanner({ kind: 'warn', text: `Stale response (${result.generation}) discarded; current is ${gate.currentGeneration}.` });
      setLastResolution(result.result.kind === 'executed' ? result.result.resolution : result.result.resolution);
      return;
    }

    const inner = result.result;
    setLastResolution(inner.resolution);

    if (inner.kind === 'executed') {
      const op = inner.resolution.kind === 'resolved' ? inner.resolution.operation : null;
      setSourceCp(
        op && 'sourceCheckpointId' in op && op.sourceCheckpointId ? op.sourceCheckpointId :
        op && 'fromCheckpointId' in op ? op.fromCheckpointId : '',
      );
      setTargetCp(
        op && 'checkpointId' in op ? (op.checkpointId ?? '') :
        op && 'targetCheckpointId' in op ? (op.targetCheckpointId ?? '') :
        op && 'toCheckpointId' in op ? (op.toCheckpointId ?? '') :
        inner.execution.checkpoint?.id ?? '',
      );
      setSnapshot(inner.execution.snapshot);
      setDiff(inner.execution.diff ?? null);
      setBanner({ kind: 'ok', text: `${inner.resolution.kind === 'resolved' ? inner.resolution.operation.type : inner.resolution.kind} applied.` });
    } else {
      setSourceCp('');
      setTargetCp('');
      if (inner.resolution.kind === 'clarification') {
        setBanner({ kind: 'warn', text: inner.resolution.question });
      } else if (inner.resolution.kind === 'unsupported') {
        setBanner({ kind: 'err', text: inner.resolution.reason });
      }
    }
  }

  function run() {
    if (!transcript.trim()) {
      setBanner({ kind: 'info', text: 'Type or paste a transcript above.' });
      return;
    }
    const result = orch.orchestrate(transcript, engine);
    applyResult(result);
    setTranscript('');
  }

  function interrupt() {
    const newer = gate.issueToken();
    setLastGeneration(newer);
    setBanner({ kind: 'info', text: `New generation ${newer} issued. Any in-flight older task will be dropped.` });
  }

  function runSuperseding() {
    const genA = gate.issueToken();
    setTranscript('Make another version assuming I can spend sixty thousand and prioritize comfort.');
    setBanner({ kind: 'info', text: `Issued gen ${genA}; now immediately superseded before resolve.` });
    const genB = gate.issueToken();
    const slow = orch.orchestrate('Make another version assuming I can spend sixty thousand and prioritize comfort.', engine, { generation: genA });
    applyResult(slow);
    const fast = orch.orchestrate('Change the budget to fifty thousand.', engine, { generation: genB });
    applyResult(fast);
    setLastGeneration(genB);
  }

  return (
    <section className="mx-auto mt-8 max-w-[1480px] px-5 pb-16 md:px-8">
      <Card className="rounded-[1.65rem] border border-border bg-card p-5 shadow-[0_24px_80px_rgba(0,0,0,.22)] md:p-7">
        <header className="mb-5 flex flex-wrap items-center justify-between gap-3 border-b border-border/70 pb-4">
          <div className="flex items-center gap-2">
            <Mic className="size-4 text-primary" />
            <h2 className="text-lg font-semibold tracking-tight">Phase 2 · voice-debug panel</h2>
          </div>
          <Badge variant="outline" className="gap-1.5 border-fuchsia-400/40 bg-fuchsia-400/10 text-fuchsia-300">
            <Zap className="size-3" /> Voice Intelligence
          </Badge>
        </header>

        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label htmlFor="transcript-input" className="mb-2 block text-xs font-bold uppercase tracking-[0.13em] text-muted-foreground">Transcript</label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                id="transcript-input"
                value={transcript}
                onChange={(e) => setTranscript(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && run()}
                placeholder="Try: &quot;Take the hotel from the luxury version but don&apos;t change anything else.&quot;"
                className="h-11 bg-background"
              />
              <Button onClick={run} className="h-11 px-5">Resolve</Button>
              <Button variant="outline" onClick={interrupt} className="h-11 px-4">Interrupt</Button>
              <Button variant="outline" onClick={runSuperseding} className="h-11 px-4">Supersede Demo</Button>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 text-sm">
            <div className="rounded-xl border border-border bg-muted/30 p-3">
              <p className="mb-1 text-[0.68rem] font-bold uppercase tracking-[0.14em] text-muted-foreground">Generation token (current)</p>
              <code className="text-xs font-semibold">{gate.currentGeneration || '—'}</code>
            </div>
            <div className="rounded-xl border border-border bg-muted/30 p-3">
              <p className="mb-1 text-[0.68rem] font-bold uppercase tracking-[0.14em] text-muted-foreground">Last task generation</p>
              <code className="text-xs font-semibold">{taskGeneration || '—'}</code>
            </div>
            <div className="rounded-xl border border-border bg-muted/30 p-3">
              <p className="mb-1 text-[0.68rem] font-bold uppercase tracking-[0.14em] text-muted-foreground">Current checkpoint</p>
              <code className="text-xs font-semibold">
                {active ? `V${active.versionNumber} · ${active.label}` : '—'}
              </code>
            </div>
            <div className="rounded-xl border border-border bg-muted/30 p-3">
              <p className="mb-1 text-[0.68rem] font-bold uppercase tracking-[0.14em] text-muted-foreground">Stale response</p>
              <code className={`text-xs font-semibold ${wasStale ? 'text-amber-300' : 'text-emerald-300'}`}>
                {wasStale ? 'DROPPED' : 'applied / current'}
              </code>
            </div>
          </div>
        </div>

        <div className="mt-4 grid gap-4 md:grid-cols-3">
          <div className="rounded-xl border border-border bg-muted/30 p-3">
            <p className="mb-1 text-[0.68rem] font-bold uppercase tracking-[0.14em] text-muted-foreground">Source checkpoint</p>
            <code className="text-xs font-semibold">{sourceCp || '—'}</code>
          </div>
          <div className="rounded-xl border border-border bg-muted/30 p-3">
            <p className="mb-1 text-[0.68rem] font-bold uppercase tracking-[0.14em] text-muted-foreground">Target checkpoint</p>
            <code className="text-xs font-semibold">{targetCp || '—'}</code>
          </div>
          <div className="rounded-xl border border-border bg-muted/30 p-3">
            <p className="mb-1 text-[0.68rem] font-bold uppercase tracking-[0.14em] text-muted-foreground">Resolved operation</p>
            <pre className="max-h-24 overflow-auto rounded-md bg-background/70 p-2 text-[11px] leading-relaxed">
              {lastResolution
                ? lastResolution.kind === 'resolved'
                  ? JSON.stringify(lastResolution.operation, null, 0)
                  : lastResolution.kind.toUpperCase()
                : '—'}
            </pre>
          </div>
        </div>

        {banner && (
          <Alert
            variant={
              banner.kind === 'warn' ? 'warning' :
              banner.kind === 'err' ? 'destructive' :
              banner.kind === 'ok' ? 'default' :
              'default'
            }
            className="mt-4 text-sm"
          >
            {banner.text}
          </Alert>
        )}

        {lastResolution && lastResolution.kind === 'clarification' && (
          <div className="mt-4 rounded-xl border border-amber-300/25 bg-amber-300/5 p-4">
            <p className="mb-2 text-sm font-semibold text-amber-200">Clarification: {lastResolution.question}</p>
            <ul className="space-y-1 text-xs">
              {lastResolution.candidates.map((c) => (
                <li key={c.id} className="flex items-center gap-2">
                  <Badge variant="outline" className="text-[10px]">V{c.versionNumber}</Badge>
                  <span className="font-semibold">{c.label}</span>
                  <span className="text-muted-foreground">
                    {c.whyMatched.join(' · ')}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {diff && (
          <div className="mt-4 rounded-xl border border-border bg-muted/30 p-4">
            <p className="mb-2 text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">Semantic diff</p>
            <pre className="max-h-48 overflow-auto rounded-md bg-background/70 p-2 text-[11px] leading-relaxed">
              {JSON.stringify(diff.changed.map((c) => ({ path: c.path, before: c.before, after: c.after })), null, 2)}
            </pre>
          </div>
        )}
      </Card>
    </section>
  );
}
