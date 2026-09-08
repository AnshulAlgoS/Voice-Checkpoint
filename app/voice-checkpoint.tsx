'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDownToLine,
  AudioLines,
  GitBranch,
  GitCompareArrows,
  History,
  Info,
  Mic,
  MicOff,
  RefreshCcw,
  RotateCcw,
  Sparkles,
  Square,
  Volume2,
  VolumeX,
  Zap,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Alert } from '@/components/ui/alert';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';

import { GenerationGate } from '@/lib/voice/GenerationGate';
import { VoiceIntentResolver } from '@/lib/voice/VoiceIntentResolver';
import { VoiceOrchestrator } from '@/lib/voice/VoiceOrchestrator';
import { ResponsePlanner } from '@/lib/voice/ResponsePlanner';
import {
  createVoiceInputProvider,
  type VoiceInputEvent,
  type VoiceInputProvider,
} from '@/lib/voice/VoiceInputProvider';
import {
  createVoiceOutputProvider,
  type VoiceOutputStatus,
} from '@/lib/voice/VoiceOutputProvider';
import { VoicePipeline, type PipelineStepResult } from '@/lib/voice/VoicePipeline';
import {
  createDemoGraph,
  DEMO_SEQUENCE,
  resetDemoGraph,
  type TripState,
} from '@/lib/demo';
import type {
  GraphSnapshot,
  StateDiff,
  StateOperation,
} from '@/lib/state/types';
import type { ResolutionResult } from '@/lib/voice/types';
import type { OrchestratorResult } from '@/lib/voice/VoiceOrchestrator';

const FIELD_META: Array<{
  key: keyof TripState | string;
  label: string;
  span?: number;
}> = [
  { key: 'destination', label: 'Destination' },
  { key: 'budget', label: 'Budget' },
  { key: 'accommodation', label: 'Stay' },
  { key: 'transportation', label: 'Travel' },
  { key: 'duration', label: 'Duration' },
  { key: 'travelers', label: 'Travelers' },
  { key: 'priorities', label: 'Priorities' },
  { key: 'constraints', label: 'Constraints' },
  { key: 'activities', label: 'Activities' },
  { key: 'preferences', label: 'Preferences', span: 2 },
];

function formatFieldValue(key: string, value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (key === 'budget' && typeof value === 'number') {
    return `₹${value.toLocaleString('en-IN')}`;
  }
  if (key === 'duration' && typeof value === 'number') {
    return value === 1 ? '1 day' : `${value} days`;
  }
  if (key === 'travelers' && typeof value === 'number') {
    return value === 1 ? '1 traveler' : `${value} travelers`;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return '—';
    return value.map((v) => String(v)).join(' · ');
  }
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return 'complex';
    }
  }
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  return '—';
}

type TranscriptItem = {
  id: string;
  kind: 'user' | 'assistant';
  text: string;
  time: string;
  stale?: boolean;
  generation?: string;
};

type LastOpInfo = {
  operation: StateOperation<TripState>['type'] | null;
  confidenceLabel: string;
  sourceCheckpointId: string | null;
  targetCheckpointId: string | null;
  fields: string[] | null;
  resolution: ResolutionResult<TripState> | null;
};

const EMPTY_LAST_OP: LastOpInfo = {
  operation: null,
  confidenceLabel: '—',
  sourceCheckpointId: null,
  targetCheckpointId: null,
  fields: null,
  resolution: null,
};

function opInfoFromResult(
  result: OrchestratorResult<TripState>,
): LastOpInfo {
  if (result.result.kind === 'executed') {
    const r = result.result.resolution;
    if (r.kind === 'resolved') {
      const op = r.operation;
      const src =
        'sourceCheckpointId' in op && op.sourceCheckpointId ? op.sourceCheckpointId :
        'fromCheckpointId' in op ? op.fromCheckpointId : null;
      const tgt =
        'checkpointId' in op ? op.checkpointId :
        'targetCheckpointId' in op && op.targetCheckpointId ? op.targetCheckpointId :
        'toCheckpointId' in op ? op.toCheckpointId :
        result.result.execution.checkpoint?.id ?? null;
      const fields = 'fields' in op ? op.fields ?? null : null;
      return {
        operation: op.type,
        confidenceLabel: 'resolved',
        sourceCheckpointId: src,
        targetCheckpointId: tgt ?? null,
        fields,
        resolution: r,
      };
    }
    return { ...EMPTY_LAST_OP, resolution: r };
  }
  return { ...EMPTY_LAST_OP, resolution: result.result.resolution };
}

type InputStatus = ReturnType<VoiceInputProvider['getStatus']>;

export function VoiceCheckpoint() {
  const [engine] = useState(createDemoGraph);
  const resolver = useMemo(() => new VoiceIntentResolver<TripState>(), []);
  const [gate] = useState(() => new GenerationGate());
  const orch = useMemo(() => new VoiceOrchestrator<TripState>(resolver, gate), [resolver, gate]);
  const planner = useMemo(() => new ResponsePlanner<TripState>(), []);
  const [provider] = useState(() => createVoiceOutputProvider({ mockDelayMs: 30 }));
  const pipeline = useMemo(
    () => new VoicePipeline<TripState>(orch, planner, provider, gate, engine),
    [orch, planner, provider, gate, engine],
  );
  const [inputProvider] = useState<VoiceInputProvider>(() => createVoiceInputProvider());

  const [snapshot, setSnapshot] = useState<GraphSnapshot<TripState>>(engine.export());
  const [diff, setDiff] = useState<StateDiff | null>(null);
  const [transcript, setTranscript] = useState('');
  const [transcriptLog, setTranscriptLog] = useState<TranscriptItem[]>([]);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err' | 'info' | 'warn'; text: string }>({
    kind: 'info',
    text: 'Version A is active and isolated. Type a command, enable microphone, or click Demo Reset.',
  });
  const [lastOp, setLastOp] = useState<LastOpInfo>(EMPTY_LAST_OP);
  const [lastResult, setLastResult] = useState<PipelineStepResult<TripState> | null>(null);
  const [lastTaskGeneration, setLastTaskGeneration] = useState<string>('');
  const [wasStale, setWasStale] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState<VoiceOutputStatus>(() => provider.getStatus());
  const [voiceInputStatus, setVoiceInputStatus] = useState<InputStatus>(() => inputProvider.getStatus());
  const [interimTranscript, setInterimTranscript] = useState<string>('');
  const [tick, setTick] = useState(0);
  const [demoStepIndex, setDemoStepIndex] = useState(0);
  const [micBusy, setMicBusy] = useState(false);

  const active = snapshot.checkpoints.find((c) => c.id === snapshot.activeCheckpointId) ?? null;

  const runCommandRef = useRef<(text?: string) => Promise<void>>(async () => {});

  useEffect(() => {
    let settled = false;
    function onInputEvent(ev: VoiceInputEvent) {
      if (settled) return;
      switch (ev.type) {
        case 'connection':
          setVoiceInputStatus(inputProvider.getStatus());
          if (ev.connection === 'connected') {
            setNotice({
              kind: 'ok',
              text:
                inputProvider.kind === 'livekit'
                  ? 'LiveKit connected. Microphone is active. Speak a command.'
                  : 'Mock voice input ready.',
            });
          } else if (ev.connection === 'disconnected') {
            setNotice({
              kind: 'info',
              text: 'Voice input disconnected.',
            });
          }
          break;
        case 'vad_start':
        case 'turn_start':
          setNotice({
            kind: 'info',
            text: 'Listening…',
          });
          void (async () => {
            try {
              await pipeline.interrupt();
              setVoiceStatus(provider.getStatus());
            } catch {
              /* ignore interrupt race errors */
            }
          })();
          break;
        case 'interim_transcript':
          if (ev.transcript) setInterimTranscript(ev.transcript);
          break;
        case 'final_transcript':
          if (ev.transcript) {
            setInterimTranscript('');
            void runCommandRef.current(ev.transcript);
          }
          break;
        case 'turn_end':
          setInterimTranscript('');
          if (ev.message) {
            setVoiceInputStatus(inputProvider.getStatus());
          }
          break;
        case 'vad_end':
          break;
        case 'error':
          setVoiceInputStatus(inputProvider.getStatus());
          setNotice({
            kind: 'err',
            text: ev.message ?? 'Voice input error.',
          });
          break;
      }
    }
    const unsub = inputProvider.subscribe(onInputEvent);
    return () => {
      settled = true;
      unsub();
    };
  }, [inputProvider, pipeline, provider]);

  useEffect(() => {
    const id = window.setInterval(() => {
      setVoiceStatus(provider.getStatus());
      setVoiceInputStatus(inputProvider.getStatus());
      setTick((t) => t + 1);
    }, 250);
    return () => window.clearInterval(id);
  }, [provider, inputProvider]);

  async function toggleMic() {
    setMicBusy(true);
    try {
      if (voiceInputStatus.connected) {
        await inputProvider.stop();
      } else {
        try {
          await inputProvider.start();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          setNotice({
            kind: 'err',
            text: `Could not start voice input: ${msg}`,
          });
          throw err;
        }
      }
    } finally {
      setMicBusy(false);
      setVoiceInputStatus(inputProvider.getStatus());
    }
  }

  const currentGeneration = gate.currentGeneration;
  void tick;

  const applyResult = useCallback(
    (result: PipelineStepResult<TripState>) => {
      setLastResult(result);
      setLastTaskGeneration(result.orchestration.generation);
      setWasStale(result.orchestration.isStale);
      setLastOp(opInfoFromResult(result.orchestration));

      if (result.orchestration.isStale) {
        setNotice({
          kind: 'warn',
          text: `Stale response (${result.orchestration.generation}) discarded. Current is ${currentGeneration}.`,
        });
        return;
      }

      const inner = result.orchestration.result;
      if (inner.kind === 'executed') {
        setSnapshot(inner.execution.snapshot);
        setDiff(inner.execution.diff ?? null);
        if (result.plannedText) {
          setTranscriptLog((prev) => [
            ...prev,
            {
              id: `a-${Date.now()}`,
              kind: 'assistant',
              text: result.plannedText!,
              time: new Date().toLocaleTimeString(),
              generation: result.orchestration.generation,
            },
          ]);
        }
        if (inner.resolution.kind === 'resolved') {
          setNotice({
            kind: 'ok',
            text: `${inner.resolution.operation.type.replaceAll('_', ' ').toLowerCase()} applied. Generation ${result.orchestration.generation}.`,
          });
        } else {
          setNotice({ kind: 'info', text: inner.resolution.kind });
        }
      } else {
        if (inner.resolution.kind === 'clarification') {
          const q = inner.resolution.question;
          setNotice({ kind: 'warn', text: q });
          setTranscriptLog((prev) => [
            ...prev,
            {
              id: `a-${Date.now()}`,
              kind: 'assistant',
              text: `Clarification needed: ${q}`,
              time: new Date().toLocaleTimeString(),
              generation: result.orchestration.generation,
            },
          ]);
        } else if (inner.resolution.kind === 'unsupported') {
          const rsn = inner.resolution.reason;
          setNotice({ kind: 'err', text: rsn });
          setTranscriptLog((prev) => [
            ...prev,
            {
              id: `a-${Date.now()}`,
              kind: 'assistant',
              text: `Unsupported: ${rsn}`,
              time: new Date().toLocaleTimeString(),
              generation: result.orchestration.generation,
            },
          ]);
        }
      }
      setVoiceStatus(provider.getStatus());
    },
    [currentGeneration, provider],
  );

  const runCommand = useCallback(
    async (text?: string) => {
      const useText = (text ?? transcript).trim();
      if (!useText) {
        setNotice({ kind: 'info', text: 'Enter a command transcript first.' });
        return;
      }
      setTranscriptLog((prev) => [
        ...prev,
        {
          id: `u-${Date.now()}`,
          kind: 'user',
          text: useText,
          time: new Date().toLocaleTimeString(),
        },
      ]);
      if (text === undefined) setTranscript('');
      const result = await pipeline.submit(useText);
      applyResult(result);
    },
    [transcript, pipeline, applyResult],
  );

  useEffect(() => {
    runCommandRef.current = runCommand;
  }, [runCommand]);

  async function interrupt() {
    await pipeline.interrupt();
    setVoiceStatus(provider.getStatus());
    setNotice({
      kind: 'info',
      text: `Interrupted. New generation ${currentGeneration} issued. Any in-flight playback was cancelled.`,
    });
  }

  async function resetAll() {
    await pipeline.reset(() => resetDemoGraph(engine));
    setSnapshot(engine.export());
    setDiff(null);
    setLastOp(EMPTY_LAST_OP);
    setLastResult(null);
    setLastTaskGeneration('');
    setWasStale(false);
    setTranscript('');
    setTranscriptLog([]);
    setDemoStepIndex(0);
    setVoiceStatus(provider.getStatus());
    setNotice({
      kind: 'ok',
      text: 'Demo reset complete. Deterministic starting state restored. V1 active with ₹40k budget and Casa Baga.',
    });
  }

  async function runNextDemoStep() {
    if (demoStepIndex >= DEMO_SEQUENCE.length) {
      setNotice({ kind: 'info', text: 'Demo sequence complete. Click Demo Reset to restart.' });
      return;
    }
    const step = DEMO_SEQUENCE[demoStepIndex];
    setDemoStepIndex((i) => i + 1);
    await runCommand(step.transcript);
  }

  async function undo() {
    await runCommand('Undo that.');
  }

  const checkpointList = snapshot.checkpoints;
  const undoDepth = (() => {
    try {
      const snapBefore = snapshot;
      const testEngine = engine;
      void snapBefore;
      void testEngine;
      return snapshot.checkpoints.length;
    } catch {
      return 0;
    }
  })();

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-[1680px] px-4 py-5 md:px-8 md:py-7">
        <header className="mb-5 flex flex-col justify-between gap-4 border-b border-border/70 pb-5 md:flex-row md:items-end">
          <div>
            <div className="mb-2 flex items-center gap-2 text-[0.72rem] font-bold uppercase tracking-[0.18em] text-primary">
              <Sparkles className="size-3.5" /> Voice Checkpoint
            </div>
            <h1 className="font-heading text-[clamp(1.4rem,2.6vw,2.2rem)] font-semibold tracking-[-0.04em]">
              Think out loud. Change your mind. Keep every version.
            </h1>
            <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
              Voice-first branching decisions. Every spoken operation creates a typed checkpoint.
              Interrupt mid-response; stale audio never plays.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge
              variant="outline"
              className="gap-1.5 border-emerald-400/40 bg-emerald-400/10 text-emerald-300"
            >
              <Zap className="size-3" /> Phase 1 · semantic engine
            </Badge>
            <Badge
              variant="outline"
              className="gap-1.5 border-fuchsia-400/40 bg-fuchsia-400/10 text-fuchsia-300"
            >
              <Mic className="size-3" /> Phase 2 · NL + generation fence
            </Badge>
            <Badge
              variant="outline"
              className="gap-1.5 border-cyan-400/40 bg-cyan-400/10 text-cyan-300"
            >
              <AudioLines className="size-3" /> Phase 3 · Rime voice output
            </Badge>
          </div>
        </header>

        <section className="grid gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(360px,1fr)]">
          <div className="space-y-4">
            <Card className="rounded-[1.3rem] border border-border bg-card p-5 shadow-[0_20px_60px_rgba(0,0,0,.18)] md:p-6">
              <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="mb-1 text-xs font-bold uppercase tracking-[0.16em] text-primary">
                    Active checkpoint
                  </p>
                  {active ? (
                    <>
                      <h2 className="text-xl font-semibold tracking-tight">
                        V{active.versionNumber} · {active.label}
                      </h2>
                      <p className="mt-1 text-sm text-muted-foreground">{active.summary}</p>
                    </>
                  ) : (
                    <h2 className="text-xl font-semibold">No active checkpoint</h2>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {active && (
                    <Badge variant="outline" className="gap-1.5 border-primary/40 bg-primary/10 text-primary">
                      {active.branchId}
                    </Badge>
                  )}
                </div>
              </div>

              {active && (
                <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border md:grid-cols-3 lg:grid-cols-4">
                  {FIELD_META.map((f) => (
                    <div
                      key={f.key}
                      className={`min-h-24 bg-card p-3.5 md:p-4 ${f.span === 2 ? 'md:col-span-2' : ''}`}
                    >
                      <div className="mb-3 text-[0.7rem] font-semibold uppercase tracking-wider text-muted-foreground">
                        {f.label}
                      </div>
                      <div className="text-sm font-semibold leading-snug md:text-[0.95rem]">
                        {formatFieldValue(
                          String(f.key),
                          active.structuredState[f.key as keyof TripState],
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <div className="mt-5 rounded-xl border border-border bg-muted/40 p-4">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.13em] text-muted-foreground">
                    <Mic className="size-4" /> Operation transcript
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => runNextDemoStep()}
                      className="h-8 text-xs"
                    >
                      ▶ Next step ({Math.min(demoStepIndex + 1, DEMO_SEQUENCE.length)}/{DEMO_SEQUENCE.length})
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={undo}
                      className="h-8 text-xs"
                    >
                      <RotateCcw className="size-3.5 mr-1" /> Undo
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={interrupt}
                      className="h-8 text-xs border-amber-400/40 text-amber-300 hover:bg-amber-400/10"
                    >
                      <Square className="size-3.5 mr-1" /> Interrupt
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={resetAll}
                      className="h-8 text-xs border-destructive/40 text-destructive hover:bg-destructive/10"
                    >
                      <RefreshCcw className="size-3.5 mr-1" /> Demo Reset
                    </Button>
                  </div>
                </div>

                <div className="flex flex-col gap-2 sm:flex-row">
                  <div className="flex flex-1 flex-col gap-1">
                    <Input
                      value={transcript}
                      onChange={(e) => setTranscript(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault();
                          void runCommand();
                        }
                      }}
                      placeholder={
                        interimTranscript
                          ? `🎙 ${interimTranscript}`
                          : 'Try: "Make another version assuming I can spend sixty thousand and prioritize comfort."'
                      }
                      aria-label="Semantic state transcript"
                      className={`h-11 bg-background ${interimTranscript ? 'text-cyan-300' : ''}`}
                    />
                    {interimTranscript ? (
                      <p className="px-1 text-[11px] text-cyan-300/80">
                        hearing: {interimTranscript}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex flex-row gap-1.5">
                    <Button
                      variant={voiceInputStatus.connected ? 'destructive' : 'outline'}
                      onClick={() => void toggleMic()}
                      disabled={micBusy}
                      className="h-11 shrink-0 px-3"
                      aria-label={voiceInputStatus.connected ? 'Stop microphone' : 'Enable microphone'}
                    >
                      {voiceInputStatus.connected ? (
                        <MicOff className="size-4" />
                      ) : (
                        <Mic className="size-4" />
                      )}
                    </Button>
                    <Button onClick={() => void runCommand()} className="h-11 px-5 shrink-0">
                      Resolve &amp; Speak
                    </Button>
                  </div>
                </div>
                <Alert
                  variant={notice.kind === 'err' ? 'destructive' : 'default'}
                  className={
                    notice.kind === 'warn'
                      ? 'mt-3 text-xs border-amber-400/50 bg-amber-50/30'
                      : 'mt-3 text-xs'
                  }
                >
                  {notice.text}
                </Alert>
              </div>
            </Card>

            {diff && (
              <Card className="rounded-[1.3rem] border border-border bg-card p-5 md:p-6">
                <div className="mb-4 flex items-center gap-2">
                  <GitCompareArrows className="size-5 text-primary" />
                  <h2 className="text-base font-semibold">Semantic diff</h2>
                  <Badge variant="outline" className="ml-1 text-[10px]">
                    {diff.fromCheckpointId} → {diff.toCheckpointId}
                  </Badge>
                </div>
                <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
                  {[...diff.changed, ...diff.added, ...diff.removed].map((change) => {
                    const kindBadge =
                      change.kind === 'added' ? ('Added' as const) :
                      change.kind === 'removed' ? ('Removed' as const) : ('Changed' as const);
                    const tone =
                      change.kind === 'added'
                        ? 'border-emerald-300/20 bg-emerald-300/5'
                        : change.kind === 'removed'
                          ? 'border-rose-300/20 bg-rose-300/5'
                          : 'border-amber-300/20 bg-amber-300/5';
                    const toneLabel =
                      change.kind === 'added'
                        ? 'text-emerald-300'
                        : change.kind === 'removed'
                          ? 'text-rose-300'
                          : 'text-amber-300';
                    return (
                      <div key={`${change.kind}-${change.path}`} className={`rounded-xl border p-3.5 ${tone}`}>
                        <div className="mb-2 flex items-center justify-between gap-2">
                          <p className={`text-[0.68rem] font-bold uppercase tracking-wider ${toneLabel}`}>
                            {FIELD_META.find((m) => m.key === change.path)?.label ?? change.path}
                          </p>
                          <Badge variant="outline" className="text-[10px] border-current opacity-70">
                            {kindBadge}
                          </Badge>
                        </div>
                        <div className="space-y-1 text-xs">
                          {'before' in change && change.before !== undefined && (
                            <p className="text-muted-foreground">
                              <span className="line-through opacity-70">
                                {formatFieldValue(change.path, change.before)}
                              </span>
                            </p>
                          )}
                          {'after' in change && change.after !== undefined && (
                            <p className="font-semibold leading-snug">
                              {change.kind === 'removed' ? (
                                <span className="line-through text-rose-300/80">
                                  {formatFieldValue(change.path, change.after)}
                                </span>
                              ) : (
                                formatFieldValue(change.path, change.after)
                              )}
                            </p>
                          )}
                        </div>
                      </div>
                    );
                  })}
                  {diff.unchanged.length > 0 && (
                    <div className="rounded-xl border border-border bg-muted/30 p-3.5 sm:col-span-2 lg:col-span-3">
                      <p className="mb-1 text-[0.68rem] font-bold uppercase tracking-wider text-muted-foreground">
                        Unchanged ({diff.unchanged.length})
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {diff.unchanged
                          .slice(0, 6)
                          .map((c) => FIELD_META.find((m) => m.key === c.path)?.label ?? c.path)
                          .join(' · ')}
                        {diff.unchanged.length > 6 && ` · +${diff.unchanged.length - 6} more`}
                      </p>
                    </div>
                  )}
                </div>
              </Card>
            )}

            {lastOp.fields && lastOp.fields.length > 0 && (
              <Card className="rounded-[1.3rem] border border-border bg-card p-5 md:p-6">
                <div className="mb-3 flex items-center gap-2">
                  <ArrowDownToLine className="size-5 text-primary" />
                  <h2 className="text-base font-semibold">Selected merge fields</h2>
                </div>
                <div className="flex flex-wrap gap-2">
                  {lastOp.fields.map((f) => (
                    <Badge key={f} variant="secondary" className="text-xs">
                      {FIELD_META.find((m) => m.key === f)?.label ?? f}
                    </Badge>
                  ))}
                </div>
              </Card>
            )}

            <Card className="rounded-[1.3rem] border border-border bg-card p-5 md:p-6">
              <div className="mb-3 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <History className="size-5 text-primary" />
                  <h2 className="text-base font-semibold">Transcript log</h2>
                </div>
                <Badge variant="outline" className="text-[10px]">
                  {transcriptLog.length} entries
                </Badge>
              </div>
              {transcriptLog.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No transcripts yet. Type a command above or click &quot;Next step&quot; to run the demo.
                </p>
              ) : (
                <ScrollArea className="h-60 rounded-lg border border-border bg-muted/20 p-3">
                  <ul className="space-y-2.5">
                    {transcriptLog.map((item) => (
                      <li
                        key={item.id}
                        className={`flex flex-col gap-1 rounded-lg border p-3 ${
                          item.kind === 'user'
                            ? 'border-border bg-background'
                            : 'border-primary/20 bg-primary/5'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="flex items-center gap-1.5 text-[0.65rem] font-bold uppercase tracking-wider text-muted-foreground">
                            {item.kind === 'user' ? (
                              <>
                                <Mic className="size-3" /> User
                              </>
                            ) : (
                              <>
                                <Volume2 className="size-3" /> Assistant
                                {item.stale && (
                                  <Badge variant="outline" className="text-[9px] border-amber-300/60 text-amber-300">
                                    STALE DROPPED
                                  </Badge>
                                )}
                              </>
                            )}
                          </span>
                          <span className="text-[0.65rem] text-muted-foreground">
                            {item.time}
                            {item.generation && (
                              <span className="ml-2 opacity-70">· gen {item.generation}</span>
                            )}
                          </span>
                        </div>
                        <p className="text-sm leading-relaxed">{item.text}</p>
                      </li>
                    ))}
                  </ul>
                </ScrollArea>
              )}
            </Card>
          </div>

          <aside className="space-y-4">
            <Card className="rounded-[1.3rem] border border-border bg-card p-5 md:p-6">
              <div className="mb-4 flex items-center justify-between">
                <div>
                  <p className="text-xs font-bold uppercase tracking-[0.16em] text-muted-foreground">
                    Checkpoint graph
                  </p>
                  <h2 className="mt-1 text-base font-semibold">Decision lineage</h2>
                </div>
                <span className="text-xs text-muted-foreground">{checkpointList.length} cps</span>
              </div>
              <div className="relative space-y-2 before:absolute before:bottom-3 before:left-[17px] before:top-3 before:w-px before:bg-border">
                {checkpointList.map((cp) => (
                  <button
                    key={cp.id}
                    onClick={() => {
                      void runCommand(`Switch to ${cp.label}.`);
                    }}
                    className={`relative flex w-full items-center gap-3 rounded-xl border p-3 text-left transition ${
                      cp.id === active?.id
                        ? 'border-primary/60 bg-primary/10 shadow-[0_0_0_3px_rgba(250,204,21,.05)]'
                        : 'border-border bg-muted/25 hover:bg-muted/50'
                    }`}
                  >
                    <span
                      className={`z-10 grid size-9 shrink-0 place-items-center rounded-full border text-xs font-bold ${
                        cp.id === active?.id
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-border bg-card text-muted-foreground'
                      }`}
                    >
                      V{cp.versionNumber}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold">{cp.label}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {cp.parentId ? `parent ${cp.parentId} · ${cp.branchId}` : 'root'}
                      </span>
                    </span>
                    {cp.id === active?.id && (
                      <Badge variant="outline" className="text-[10px] border-primary/50 text-primary">
                        ACTIVE
                      </Badge>
                    )}
                  </button>
                ))}
              </div>
            </Card>

            <Card className="rounded-[1.3rem] border border-border bg-card p-5 md:p-6">
              <div className="mb-3 flex items-center gap-2">
                <Info className="size-5 text-primary" />
                <h2 className="text-base font-semibold">Operation &amp; generation status</h2>
              </div>
              <div className="grid grid-cols-2 gap-2.5 text-xs">
                <div className="rounded-xl border border-border bg-muted/30 p-3">
                  <p className="mb-1 text-[0.65rem] font-bold uppercase tracking-[0.14em] text-muted-foreground">
                    Last operation
                  </p>
                  <p className="text-sm font-semibold">{lastOp.operation ?? '—'}</p>
                </div>
                <div className="rounded-xl border border-border bg-muted/30 p-3">
                  <p className="mb-1 text-[0.65rem] font-bold uppercase tracking-[0.14em] text-muted-foreground">
                    Status
                  </p>
                  <p className={`text-sm font-semibold ${wasStale ? 'text-amber-300' : 'text-emerald-300'}`}>
                    {wasStale ? 'STALE DROPPED' : lastOp.operation ? 'APPLIED' : 'idle'}
                  </p>
                </div>
                <div className="rounded-xl border border-border bg-muted/30 p-3">
                  <p className="mb-1 text-[0.65rem] font-bold uppercase tracking-[0.14em] text-muted-foreground">
                    Current generation
                  </p>
                  <code className="text-xs font-semibold">{currentGeneration}</code>
                </div>
                <div className="rounded-xl border border-border bg-muted/30 p-3">
                  <p className="mb-1 text-[0.65rem] font-bold uppercase tracking-[0.14em] text-muted-foreground">
                    Last task gen
                  </p>
                  <code className="text-xs font-semibold">{lastTaskGeneration || '—'}</code>
                </div>
                <div className="rounded-xl border border-border bg-muted/30 p-3">
                  <p className="mb-1 text-[0.65rem] font-bold uppercase tracking-[0.14em] text-muted-foreground">
                    Source cp
                  </p>
                  <code className="text-xs font-semibold">{lastOp.sourceCheckpointId ?? '—'}</code>
                </div>
                <div className="rounded-xl border border-border bg-muted/30 p-3">
                  <p className="mb-1 text-[0.65rem] font-bold uppercase tracking-[0.14em] text-muted-foreground">
                    Target cp
                  </p>
                  <code className="text-xs font-semibold">{lastOp.targetCheckpointId ?? '—'}</code>
                </div>
              </div>
              {lastOp.resolution && lastOp.resolution.kind === 'clarification' && (
                <div className="mt-3 rounded-xl border border-amber-300/25 bg-amber-300/5 p-3">
                  <p className="mb-1.5 text-xs font-semibold text-amber-200">
                    Clarification: {lastOp.resolution.question}
                  </p>
                  <ul className="space-y-0.5 text-[11px]">
                    {lastOp.resolution.candidates.slice(0, 5).map((c) => (
                      <li key={c.id} className="flex items-center gap-2 text-muted-foreground">
                        <Badge variant="outline" className="text-[9px]">V{c.versionNumber}</Badge>
                        <span className="font-medium text-foreground">{c.label}</span>
                        <span className="truncate opacity-70">{c.whyMatched[0]}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {lastResult && (
                <Tabs defaultValue="op" className="mt-3">
                  <TabsList className="h-8 text-[11px]">
                    <TabsTrigger value="op" className="h-7">Resolved op</TabsTrigger>
                    <TabsTrigger value="spoken" className="h-7">Spoken</TabsTrigger>
                  </TabsList>
                  <TabsContent value="op" className="mt-2">
                    <pre className="max-h-40 overflow-auto rounded-lg border border-border bg-muted/30 p-2.5 text-[11px] leading-relaxed">
{lastOp.resolution && lastOp.resolution.kind === 'resolved'
  ? JSON.stringify(lastOp.resolution.operation, null, 2)
  : lastOp.resolution
    ? JSON.stringify({ kind: lastOp.resolution.kind }, null, 2)
    : '—'}
                    </pre>
                  </TabsContent>
                  <TabsContent value="spoken" className="mt-2">
                    <pre className="max-h-40 overflow-auto rounded-lg border border-border bg-muted/30 p-2.5 text-[11px] leading-relaxed whitespace-pre-wrap">
{lastResult.plannedText ?? '—'}
                    </pre>
                  </TabsContent>
                </Tabs>
              )}
            </Card>

            <Card className="rounded-[1.3rem] border border-border bg-card p-5 md:p-6">
              <div className="mb-3 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {voiceInputStatus.capturing ? (
                    <Mic className="size-5 text-cyan-400" />
                  ) : (
                    <MicOff className="size-5 text-muted-foreground" />
                  )}
                  <h2 className="text-base font-semibold">Voice input</h2>
                </div>
                <Badge
                  variant="outline"
                  className={`text-[10px] ${
                    voiceInputStatus.connected
                      ? inputProvider.kind === 'livekit'
                        ? 'border-cyan-400/40 bg-cyan-400/10 text-cyan-300'
                        : 'border-emerald-400/40 bg-emerald-400/10 text-emerald-300'
                      : 'border-muted-foreground/40 bg-muted-foreground/10 text-muted-foreground'
                  }`}
                >
                  {voiceInputStatus.connected
                    ? inputProvider.kind === 'livekit'
                      ? 'LIVEKIT LIVE'
                      : 'MOCK READY'
                    : 'DISCONNECTED'}
                </Badge>
              </div>
              <div className="grid grid-cols-2 gap-2.5 text-xs">
                <div className="rounded-xl border border-border bg-muted/30 p-3">
                  <p className="mb-1 text-[0.65rem] font-bold uppercase tracking-[0.14em] text-muted-foreground">
                    Connection
                  </p>
                  <p className={`text-sm font-semibold ${voiceInputStatus.connected ? 'text-emerald-300' : 'text-muted-foreground'}`}>
                    {voiceInputStatus.connected ? 'CONNECTED' : 'idle'}
                  </p>
                </div>
                <div className="rounded-xl border border-border bg-muted/30 p-3">
                  <p className="mb-1 text-[0.65rem] font-bold uppercase tracking-[0.14em] text-muted-foreground">
                    Microphone
                  </p>
                  <p className={`text-sm font-semibold ${voiceInputStatus.capturing ? 'text-cyan-300' : 'text-muted-foreground'}`}>
                    {voiceInputStatus.capturing ? 'CAPTURING' : 'off'}
                  </p>
                </div>
                <div className="col-span-2 rounded-xl border border-border bg-muted/30 p-3">
                  <p className="mb-1 text-[0.65rem] font-bold uppercase tracking-[0.14em] text-muted-foreground">
                    Last transcript
                  </p>
                  <p className="text-xs leading-relaxed">
                    {voiceInputStatus.lastTranscript ?? 'No speech yet. Click mic to enable.'}
                  </p>
                </div>
              </div>
            </Card>

            <Card className="rounded-[1.3rem] border border-border bg-card p-5 md:p-6">
              <div className="mb-3 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {provider.kind === 'rime' ? (
                    <Volume2 className="size-5 text-emerald-400" />
                  ) : (
                    <VolumeX className="size-5 text-muted-foreground" />
                  )}
                  <h2 className="text-base font-semibold">Voice output</h2>
                </div>
                <Badge
                  variant="outline"
                  className={`text-[10px] ${
                    provider.kind === 'rime'
                      ? 'border-emerald-400/40 bg-emerald-400/10 text-emerald-300'
                      : 'border-muted-foreground/40 bg-muted-foreground/10 text-muted-foreground'
                  }`}
                >
                  {provider.kind === 'rime' ? 'RIME LIVE' : 'MOCK MODE'}
                </Badge>
              </div>
              <div className="grid grid-cols-2 gap-2.5 text-xs">
                <div className="rounded-xl border border-border bg-muted/30 p-3">
                  <p className="mb-1 text-[0.65rem] font-bold uppercase tracking-[0.14em] text-muted-foreground">
                    Playback
                  </p>
                  <p className={`text-sm font-semibold ${voiceStatus.playing ? 'text-cyan-300' : 'text-muted-foreground'}`}>
                    {voiceStatus.playing ? 'PLAYING' : 'idle'}
                  </p>
                </div>
                <div className="rounded-xl border border-border bg-muted/30 p-3">
                  <p className="mb-1 text-[0.65rem] font-bold uppercase tracking-[0.14em] text-muted-foreground">
                    Active handle
                  </p>
                  <code className="text-xs font-semibold">{voiceStatus.activeHandleId ?? '—'}</code>
                </div>
                <div className="col-span-2 rounded-xl border border-border bg-muted/30 p-3">
                  <p className="mb-1 text-[0.65rem] font-bold uppercase tracking-[0.14em] text-muted-foreground">
                    Last spoken
                  </p>
                  <p className="text-xs leading-relaxed">
                    {voiceStatus.lastSpoken ?? 'No audio yet.'}
                  </p>
                </div>
              </div>
            </Card>

            <Card className="rounded-[1.3rem] border border-border bg-card p-5 md:p-6">
              <div className="mb-3 flex items-center gap-2">
                <GitBranch className="size-5 text-primary" />
                <h2 className="text-base font-semibold">Acceptance demo path</h2>
              </div>
              <ol className="space-y-1.5 text-xs">
                {DEMO_SEQUENCE.map((step, i) => (
                  <li
                    key={step.label}
                    className={`flex items-start gap-2 rounded-lg border p-2 ${
                      i < demoStepIndex
                        ? 'border-emerald-400/30 bg-emerald-400/5'
                        : i === demoStepIndex
                          ? 'border-primary/40 bg-primary/5'
                          : 'border-border bg-muted/10'
                    }`}
                  >
                    <span
                      className={`grid size-5 shrink-0 place-items-center rounded-full border text-[10px] font-bold ${
                        i < demoStepIndex
                          ? 'border-emerald-400/50 bg-emerald-400/20 text-emerald-300'
                          : i === demoStepIndex
                            ? 'border-primary bg-primary text-primary-foreground'
                            : 'border-border text-muted-foreground'
                      }`}
                    >
                      {i + 1}
                    </span>
                    <span className="min-w-0 flex-1 leading-relaxed">
                      <span className="block font-semibold">{step.label.split(': ')[1] ?? step.label}</span>
                      <span className="block truncate text-[11px] text-muted-foreground">
                        &quot;{step.transcript}&quot;
                      </span>
                    </span>
                  </li>
                ))}
              </ol>
              <Separator className="my-4" />
              <div className="grid grid-cols-2 gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void runCommand('Make another version assuming I can spend sixty thousand and prioritize comfort.')}
                  className="h-9 text-xs"
                >
                  <GitBranch className="size-3.5 mr-1" /> Fork luxury
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void runCommand('Go back to the original.')}
                  className="h-9 text-xs"
                >
                  <ArrowDownToLine className="size-3.5 mr-1" /> Switch A
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void runCommand('Compare this with the original.')}
                  className="h-9 text-xs"
                >
                  <GitCompareArrows className="size-3.5 mr-1" /> Compare
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void runCommand("Take the hotel from the luxury version but don't change anything else.")}
                  className="h-9 text-xs"
                >
                  <ArrowDownToLine className="size-3.5 mr-1" /> Merge hotel
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={undo}
                  className="col-span-2 h-9 text-xs"
                >
                  <RotateCcw className="size-3.5 mr-1" /> Undo last
                </Button>
              </div>
              <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
                After step 5, active state should be V1 (₹40,000) with <span className="font-semibold text-foreground">Taj Fort Aguada</span>.
                After step 7 (undo), state should match the original with <span className="font-semibold text-foreground">Casa Baga</span>.
              </p>
              <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                Undo points: up to {undoDepth} operations can be reverted on this graph.
              </p>
            </Card>
          </aside>
        </section>
      </div>
    </main>
  );
}
