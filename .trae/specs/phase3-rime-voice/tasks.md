# Phase 3 Implementation Tasks

Each task maps to one or more Acceptance Criteria from `spec.md`. Task headings contain no status markers; status is stored in the `Status` field only.

Priority legend: `high` = preserves core or AC-4/5/6, `medium` = required feature, `low` = polish/documentation.

---

## Task 1: Voice Output Provider Abstraction + Mock Provider

**Priority**: high
**Depends on**: none
**Maps AC**: AC-1, AC-7, AC-10

Create `lib/voice/VoiceOutputProvider.ts` exporting:

```ts
export interface VoiceOutputHandle { id: string; }
export interface VoiceOutputContext { generation: string; checkpointId: string | null; }
export interface VoiceOutputProvider {
  readonly kind: 'rime' | 'mock';
  speak(text: string, context: VoiceOutputContext): Promise<VoiceOutputHandle>;
  cancel(handleId: string): Promise<void>;
  getStatus(): { playing: boolean; activeHandleId: string | null; lastSpoken: string | null; };
}
```

Implement `MockVoiceOutputProvider`:
- `speak()` stores `{ text, context, resolved: false, cancelled: false }` under a generated id; returns after `simulatedDelayMs` (configurable, default 0 for tests, 50ms default).
- If `cancel(id)` is called before delay resolves, `cancelled = true` and the promise resolves early without marking as "spoken".
- `getStatus()` returns current play state and last **non-cancelled** spoken text.
- Helper `getSpokenLog()` returns all non-cancelled utterances for assertions.

### Test Requirements (Task-local)
TR-1.1 (rule): `mock.speak("hello", ctx)` resolves to a handle; `getStatus().lastSpoken` equals `"hello"`.
TR-1.2 (rule): Calling `mock.cancel(handle.id)` before the speak delay resolves results in the utterance not appearing in the spoken log.
TR-1.3 (rule): Interface conformance: both providers expose `kind`, `speak`, `cancel`, `getStatus` with correct signatures.

### Status
pending

---

## Task 2: Rime Provider Factory + Integration Boundary

**Priority**: high
**Depends on**: Task 1
**Maps AC**: AC-7, AC-8

In the same file, create `RimeVoiceOutputProvider` (stub with correct boundary) and `createVoiceOutputProvider()` factory:

- `RimeVoiceOutputProvider` reads env vars: `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `RIME_VOICE`, `RIME_MODEL` (defaults documented in README). If any required vars are missing, the constructor throws OR the factory returns mock instead.
- Since LiveKit/Rime packages are not currently installed, implement the provider using a **thin boundary**:
  - Declare a minimal local interface representing the Rime TTS call shape (synchronous or async `synthesize(text, opts)` -> `Promise<Uint8Array | AudioBuffer>`).
  - Actually attempt to dynamically `import()` the relevant LiveKit module only when all env vars are truthy. If the import fails or module is missing, log a warning and re-throw OR (preferably) the factory detects the situation at startup and returns mock instead.
  - For audio playback in-browser, use the Web Audio API or an `<audio>` element with a Blob URL. The actual playback is isolated inside the provider.
- `createVoiceOutputProvider()`: inspects env vars. If Rime env vars are ALL present AND the LiveKit client module is importable, return `RimeVoiceOutputProvider`. Otherwise return `MockVoiceOutputProvider`. **Secrets are never serialized to the browser.**

### Test Requirements (Task-local)
TR-2.1 (rule): Without any `LIVEKIT_*` env vars set, `createVoiceOutputProvider()` returns a provider whose `kind === 'mock'`.
TR-2.2 (rule): `RimeVoiceOutputProvider` class exists and implements `VoiceOutputProvider`. If instantiated without required env vars, `speak()` rejects with a descriptive error (or factory returns mock, whichever strategy is chosen).
TR-2.3 (rule): grep of repository files for `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` literal placeholder values finds none. Only env-var access via `process.env` is used.

### Status
pending

---

## Task 3: Deterministic Response Planner

**Priority**: high
**Depends on**: none
**Maps AC**: AC-1, AC-4, AC-10

Create `lib/voice/ResponsePlanner.ts` that converts an orchestrator result (or raw operation result + metadata) into spoken text:

```ts
import type { OperationResult, SemanticState } from '../state/types.ts';
import type { OrchestratorResult } from './VoiceOrchestrator.ts';
import type { ResolutionResult } from './types.ts';

export class ResponsePlanner<T extends SemanticState = SemanticState> {
  plan(
    orchestration: OrchestratorResult<T>,
    opts?: { activeCheckpointId: string | null },
  ): { text: string; checkpointId: string | null } | null;
  // (and/or lower-level helpers for each operation type)
}
```

Rules:
- If `orchestration.isStale`, return `null` (nothing to speak — caller will cancel prior playback).
- If `kind === 'not-executed'`:
  - `resolution.kind === 'clarification'` → `"I need to clarify: {question}"` truncated to a single short sentence.
  - `resolution.kind === 'unsupported'` → short spoken unsupported message.
- If `kind === 'executed'`:
  - FORK/CREATE/UPDATE: summarize the new checkpoint's structured state (budget, destination, accommodation, duration for TripState; generic fallback for other domains listing top-level scalar fields).
  - SWITCH: `"Switched to Version N — {label}."`
  - COMPARE: summarize changed fields. E.g. `"Compared with original: budget, accommodation, and priorities differ. Destination unchanged."`
  - MERGE: `"Merged {fields} from Version N into Version M. Budget remains X."`
  - UNDO: `"Last operation undone. Back to Version N — {label}."`
  - REWIND: `"Rewound {steps} step(s). Back to Version N."`
  - DESCRIBE: list fields generically.

All text is deterministic given identical inputs. No LLM calls.

### Test Requirements (Task-local)
TR-3.1 (rule): Planning a stale result returns `null`.
TR-3.2 (rule): FORK result for V2 (₹60k comfort) produces text mentioning budget 60000 and comfort priority (exact phrasing unspecified, keywords required).
TR-3.3 (rule): MERGE result with fields `['accommodation']` produces text mentioning accommodation and budget unchanged from target.
TR-3.4 (rule): UNDO result mentions "undone" or "restored".
TR-3.5 (rule): COMPARE result mentions at least one changed-field keyword and an "unchanged" / "same" indicator for destination.
TR-3.6 (rule): Clarification/unsupported resolutions produce non-empty short text.

### Status
pending

---

## Task 4: Thin Orchestration Wrapper (Speak + Gate)

**Priority**: high
**Depends on**: Tasks 1, 2, 3
**Maps AC**: AC-2, AC-3, AC-10

Create `lib/voice/VoicePipeline.ts` that wraps `VoiceOrchestrator` + `ResponsePlanner` + `VoiceOutputProvider` + `GenerationGate`:

```ts
export type PipelineStepResult<T> = {
  orchestration: OrchestratorResult<T>;
  spoken: boolean;
  handleId: string | null;
  plannedText: string | null;
};

export class VoicePipeline<T extends SemanticState = SemanticState> {
  constructor(
    private orch: VoiceOrchestrator<T>,
    private planner: ResponsePlanner<T>,
    private provider: VoiceOutputProvider,
    private gate: GenerationGate,
    private graph: StateGraph<T>,
  ) {}

  // Submit a new user transcript.
  // 1. issues new generation (invalidates old)
  // 2. cancels any in-flight playback from prior generation
  // 3. runs orchestrator
  // 4. if not stale, plans text
  // 5. re-checks generation + active checkpoint before speak()
  // 6. calls speak() and returns
  submit(transcript: string): Promise<PipelineStepResult<T>>;

  // Interrupt: issue new generation and cancel current playback.
  interrupt(): Promise<void>;

  // Reset: interrupt, reset graph via demo reset callback, new generation.
  reset(resetGraph: () => void): Promise<void>;
}
```

Reuses `GenerationGate.authorize()` at every step. No duplicate fencing mechanism.

### Test Requirements (Task-local)
TR-4.1 (rule): Call `submit("A")`, then before it resolves call `submit("B")`. After both settle, provider's last non-cancelled spoken text equals the planner output for B, not A.
TR-4.2 (rule): `interrupt()` issues a newer generation and cancels any active handle.
TR-4.3 (rule): After a manual `gate.issueToken()` (bypassing pipeline), calling an internal `_trySpeak` helper with the older generation token skips `speak()` — provider's `lastSpoken` does not change.
TR-4.4 (rule): If active checkpoint id changes between plan and speak (e.g. mutated by a side path), the speak is skipped via context check.

### Status
pending

---

## Task 5: Demo Reset Helper + Deterministic Start State

**Priority**: high
**Depends on**: none
**Maps AC**: AC-4, AC-5

Extend `lib/demo.ts`:

```ts
import type { GraphSnapshot } from './state/types.ts';
import { createDemoGraph, practicalTrip, type TripState } from './demo.ts'; // existing

export const INITIAL_DEMO_SNAPSHOT: GraphSnapshot<TripState>; // frozen constant export

export function resetDemoGraph(graph: StateGraph<TripState>): void;
// 1. read INITIAL_DEMO_SNAPSHOT
// 2. graph.restore() via constructor-ish path
```

`StateGraph` already accepts a `snapshot` constructor arg. Add a public `restore(snapshot)` method to StateGraph (or use constructor pattern: discard old graph, create new from snapshot, swap references in the pipeline wrapper).

### Test Requirements (Task-local)
TR-5.1 (rule): `createDemoGraph().export()` deep-equals `resetDemoGraph(new StateGraph()).export()` (choose whichever restore API is exposed).
TR-5.2 (rule): Running 7-step demo through orchestrator, then reset, then `export()` deep-equals fresh `createDemoGraph().export()`.
TR-5.3 (rule): Reset works even after undo stack has entries (undo stack is also cleared).

### Status
pending

---

## Task 6: Polished Judge-Ready UI

**Priority**: medium
**Depends on**: Tasks 1-5
**Maps AC**: AC-4, AC-5, AC-9, AC-10

Refactor `app/voice-checkpoint.tsx` into a single Phase 3-ready panel. Keep `app/voice-debug.tsx` as-is for regression; remove duplicate engine instances by having `voice-checkpoint.tsx` own:

- `StateGraph<TripState>`, `GenerationGate`, `VoiceIntentResolver`, `VoiceOrchestrator`, `ResponsePlanner`, `VoiceOutputProvider` (via factory), `VoicePipeline`.
- Hook up transcript input → `pipeline.submit()`.
- "Interrupt" button → `pipeline.interrupt()`.
- "Demo Reset" button → `pipeline.reset(() => resetDemoGraph(engine))` + reload snapshot.
- Show all required sections (see AC-9 rubric):
  - Active checkpoint card (version, label, summary, branch, formatted field grid).
  - Checkpoint graph (timeline / lineage, clickable switch, active highlight).
  - Recent operation card (operation type, source/target cps, confidence).
  - Diff card (when applicable).
  - Merge fields card (when last op was MERGE).
  - Undo info: "N undo points available" + "Undo last" button.
  - Voice status: provider kind, playing indicator, last spoken text, active handle id.
  - Generation status: current token, last-task token, stale indicator.
  - Transcript input + Resolve + Interrupt + Demo Reset.
  - Resolved operation JSON preview.
  - Shortcut buttons for the 7-step demo (optional, not fake-state: they call `pipeline.submit(...)` with real transcripts).

Use existing `components/ui/*` primitives. No decorative animations.

### Test Requirements (Task-local)
TR-6.1 (rule): UI state for each displayed value is derived directly from `engine.export()` / `gate.currentGeneration` / `provider.getStatus()` — verified by grep for hardcoded strings matching demo values like `"₹40,000"` or `"Taj Fort Aguada"` outside of formatter helpers.
TR-6.2 (rubric, threshold ≥ 3/4): Layout renders without overlap at 1280px width; active checkpoint and graph are distinguishable; voice status visibly changes after submitting a command.
TR-6.3 (rule): Clicking "Demo Reset" followed by engine.export() matches fresh createDemoGraph().export().

### Status
pending

---

## Task 7: Phase 3 Test Suite

**Priority**: medium
**Depends on**: Tasks 1-6 (TRs from tasks 1-6 are added here as well as the integration-level tests)
**Maps AC**: AC-1..AC-8, AC-10

Create `tests/phase3.test.ts`. It must include, at minimum, tests named:

1. `Phase 3 MockVoiceOutputProvider: speak + cancel`
2. `Phase 3 createVoiceOutputProvider falls back to mock without env vars`
3. `Phase 3 ResponsePlanner: stale returns null, fork mentions budget, merge mentions fields, undo mentions restore`
4. `Phase 3 interruption: newer submit cancels older in-flight playback`
5. `Phase 3 stale suppression: older generation never reaches speak()`
6. `Phase 3 generation/state consistency: checkpoint drift prevents speak`
7. `Phase 3 Demo Reset: after 7-step flow, export matches fresh createDemoGraph`
8. `Phase 3 selective merge exact values: accommodation=Taj, budget=40000, transport unchanged`
9. `Phase 3 exact undo: post-merge export deep-equals pre-merge`
10. `Phase 3 end-to-end 7-step deterministic demo flow (orchestrator + planner)`

Run `npm test` and confirm all Phase 1, Phase 2, and Phase 3 tests pass.

### Test Requirements (Task-local)
TR-7.1 (rule): All 10 tests above exist and pass on first run.
TR-7.2 (rule): No existing tests from `state-engine.test.ts` or `phase2.test.ts` are modified, skipped, or weakened.
TR-7.3 (rule): `npm test` exits with code 0.

### Status
pending

---

## Task 8: RIME_EVIDENCE.md + README.md Updates

**Priority**: low
**Depends on**: Tasks 1-7
**Maps AC**: AC-7, AC-8

Create `RIME_EVIDENCE.md` with sections:

- claim (e.g. "Phase 3 uses Rime as primary voice output via LiveKit Agents integration")
- acceptance criterion (cross-reference AC-7)
- test procedure (how to run tests + how to trigger a spoken response)
- exact Rime model (mark "unverified — not yet configured" if env vars absent; otherwise record actual value from `RIME_MODEL` env)
- exact voice (actual value from `RIME_VOICE` env or "unverified")
- language (default: en-IN or "unverified")
- endpoint/inference path (LiveKit server URL from `LIVEKIT_URL` or "unverified")
- audio format (e.g. mp3/opus/pcm16 — or "unverified")
- transport (WSS to LiveKit server / HTTP TTS endpoint — or "unverified")
- observed result (provider.kind actually used during a local run: mock | rime)
- evidence/fixture (link to test file, command output snippets)
- limitations (list everything unverifiable without credentials; possible future improvements)
- reproduction commands (npm test, npm run dev, env var names)

Update `README.md` to add/extend:

- product/problem paragraph (why voice-first state branching is necessary)
- updated architecture ASCII diagram including STT → resolver → StateGraph → planner → provider → user
- Phase 1/2/3 responsibilities (bullet each)
- setup instructions (Node version, npm install)
- environment variables table (`LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `RIME_MODEL`, `RIME_VOICE`; note which are required)
- LiveKit + Rime setup pointers (no proprietary instructions; link to official LiveKit Agents docs + note that mock mode works without credentials)
- mock mode explanation (default; how to verify provider kind via UI badge)
- tests section (npm test, what each suite covers)
- deterministic demo walkthrough (7 steps with expected outputs; note that engine produces them)
- acceptance criteria summary (cross-reference AC list from spec.md)
- limitations (STT not included, credentials not shipped, Rime unverified if so, etc.)

### Test Requirements (Task-local)
TR-8.1 (rule): Both files exist, contain all required sections, values prefixed "unverified" where credentials are missing (no invented performance numbers).
TR-8.2 (rule): README update preserves the existing Phase 1/Phase 2 documentation body (amends, does not rewrite).

### Status
pending

---

## Task 9: Build, Typecheck, Lint, and Git Diff Verification

**Priority**: high
**Depends on**: Tasks 1-8
**Maps AC**: AC-6, AC-8

Run in this exact order and record outputs:

1. `npm test` — must pass.
2. `npm run build` — must produce build output; no type errors leaked into JS emit.
3. `npm run lint` (oxlint) — no new errors introduced.
4. `git diff` + grep for `LIVEKIT_API_KEY|LIVEKIT_API_SECRET|sk-` literals in source files to confirm no secrets.

If any step fails, fix the root cause, re-run the failed step and all later steps, and re-record.

### Test Requirements (Task-local)
TR-9.1 (rule): `npm test` exit code 0.
TR-9.2 (rule): `npm run build` exit code 0.
TR-9.3 (rule): `npm run lint` exit code 0.
TR-9.4 (rule): Grep for secret-like placeholders/values returns only matches that access `process.env`, not hardcoded keys.

### Status
pending
