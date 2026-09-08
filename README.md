# Voice Checkpoint

Voice Checkpoint is a generic semantic state engine for branching, switching, comparing,
selectively merging, and undoing structured decisions, end-to-end wired from natural-language
voice input through typed state operations to spoken Rime voice output.

## Architecture

```text
Microphone / Text transcript
         │
         ▼
 VoiceInputProvider (LiveKit STT / Mock)
         │  turn_start → final_transcript → turn_end
         ▼
 Phase 2 resolver
  ├─ VoiceIntentResolver ──► typed StateOperation
  ├─ ReferenceResolver         │
  ├─ ambiguity/clarify          │
  └─ GenerationGate (stale)    ▼
                       StateGraph<T> (Phase 1)
                   ┌──────┬──────┴──────┬──────┐
                   ▼      ▼             ▼      ▼
                 Diff   Merge         Undo   Compare
                   └──────┬─────────────┴──────┘
                          ▼
            immutable Checkpoint / GraphSnapshot
                          │
                          ▼
               ResponsePlanner (spoken plan)
                          │
                          ▼
         VoiceOutputProvider (Rime / Mock)  ───► user hears audio
```

Every mutation goes through `StateGraph.execute(StateOperation)`. The voice layer never
mutates semantic state directly. A central `GenerationGate` issues monotonically
increasing tokens; any playback or result belonging to an older generation is dropped
before reaching the user.

## Phases

### Phase 1 — Semantic state engine (complete)

- Typed `StateOperation` union: `CREATE`, `UPDATE`, `FORK`, `SWITCH_CHECKPOINT`,
  `MERGE`, `COMPARE`, `UNDO`, `REWIND`, `RESET`.
- `StateGraph<T>`: immutable checkpoints, deep-clone reads, exact-UNDO graph-level snapshots.
- `DiffEngine` + `MergeEngine`: classified field-level diffs; selective MERGE on named fields only.
- `ReferenceResolver`: label / version-number / budget / adjective disambiguation → candidate list.
- Natural-language `IntentResolver` (Phase 1 narrow deterministic) + `VoiceIntentResolver` (Phase 2 enriched).
- 54/54 node:test tests passing.

### Phase 2 — Voice input & turn fencing (boundary + wired logic complete)

- `VoiceInputProvider` contract + 2 implementations:
  - `LiveKitSttProvider`: LiveKit STT boundary; requires `LIVEKIT_URL`, API key/secret.
    Throws clearly if credentials are missing. The event stream is:
    `connection → turn_start → vad_start → interim_transcript → final_transcript → vad_end → turn_end → error`.
  - `MockVoiceInputProvider`: STT-less for local dev/tests. `pushTranscript()` simulates a
    full VAD/turn cycle so the pipeline can be exercised without audio hardware.
- `VoiceOrchestrator`: transcript → resolve → execute → diff.
- `GenerationGate`: monotonic token; `isStale(result)` fences every playback + render.
- Architecture boundary: **every** spoken input still becomes a typed `StateOperation`
  via the existing resolver; the STT boundary is a thin event stream of transcript
  strings into the existing `VoicePipeline.submit()` entry point.

### Phase 3 — Rime voice output & interruptible playback (boundary + UI complete)

- `VoiceOutputProvider` contract: `speak(text, { generation, checkpointId })`, `cancel(id)`, `getStatus()`.
- `RimeVoiceOutputProvider`: credentials from env; falls back to `MockVoiceOutputProvider`.
- `MockVoiceOutputProvider`: deterministic, inspectable `getSpokenLog()` + cancellable utterances.
- `ResponsePlanner`: text-generation layer tailored to each operation (FORK, SWITCH, MERGE, COMPARE, UNDO,
  UPDATE, CLONE, clarification, unsupported).
- `VoicePipeline`: single-entrypoint `submit(transcript)` returns `{ orchestration, plan, handle, isStale, generation }`.
- Interrupt path: call `GenerationGate.issueToken()` before issuing a new submission; any
  in-flight older generation is auto-suppressed at both render and provider boundaries.
- Polished judge-ready UI: `voice-checkpoint` page drives the real state engine with the
  7-step demo, Demo Reset, generation/stale fencing, and voice status.

## Setup

Node.js 22.13 or newer.

```bash
npm install
npm run dev
```

## Environment variables

LiveKit / Rime credentials. Server-side only — never expose the API secret to client code.

| Variable              | Purpose                                      | Default    |
|-----------------------|----------------------------------------------|------------|
| `LIVEKIT_URL`         | WebSocket endpoint for your LiveKit project  | —          |
| `LIVEKIT_API_KEY`     | Server-side API key                          | —          |
| `LIVEKIT_API_SECRET`  | Server-side API secret                       | —          |
| `RIME_MODEL`          | Rime TTS model name                          | `rime-1`   |
| `RIME_VOICE`          | Rime TTS voice                               | `af_sky`   |
| `RIME_LANGUAGE`       | BCP-47 language tag used by both STT and TTS | `en-IN`    |

If any of the three required LiveKit variables are absent, both the input and output
factories fall back to their mock providers deterministically so the whole app still runs
locally.

## Tests

```bash
npm test                 # 54/54 — Phase 1 + Phase 2 + Phase 3
npx tsc --noEmit         # strict typecheck
npm run lint             # oxlint — jsx-a11y, react-compiler, typescript rules
npm run build            # production build (vinext)
```

The suite covers: state isolation, switching, selective merge, diff classification,
exact undo, contamination resistance, nested ancestry, natural-language operation mapping,
ambiguity handling, 7-step deterministic demo flow, generation/stale fencing, interruption,
provider cancellation, mock/Rime factory fallback, and Demo Reset idempotency.

## Deterministic judge demo

The 7-step sequence in `lib/demo.ts` → `DEMO_SEQUENCE` runs against the real state engine.
Reset the graph to its seed state at any time with the **Reset Demo** button.

1. *Plan a five-day trip to Goa for forty thousand rupees.*        → V1: ₹40k, Casa Baga
2. *Make another version assuming I can spend sixty thousand rupees, stay at Taj Fort Aguada, take a flight, and prioritize comfort.*  → V2 (fork): ₹60k, Taj Fort Aguada
3. *Compare this with the original.*                                → COMPARE vs V1
4. *Go back to the original.*                                       → SWITCH active = V1
5. *Take the hotel from the luxury version but don't change anything else.* → MERGE accommodation V2→V1, keep ₹40k
6. *Compare this with the previous version.*                        → COMPARE (new V1' vs prior V1 — hotel differs)
7. *Undo that.*                                                     → UNDO → graph restored before step 5

After step 5: `budget === 40000 && accommodation === 'Taj Fort Aguada'`.
After step 7: `budget === 40000 && accommodation === 'Casa Baga'`.

## LiveKit / Rime deployment notes

1. Mint short-lived LiveKit access tokens on the server; never ship `LIVEKIT_API_SECRET` to the browser.
2. Wire the body of `RimeVoiceOutputProvider.speak()` to the LiveKit Rime TTS output track
   lifecycle and keep the `context.generation` pre-check so stale audio never plays.
3. Wire `LiveKitSttProvider.start()` / internal events to the LiveKit `RimeStt` adapter so
   `final_transcript` events call `VoicePipeline.submit(transcript)` through the same
   orchestration path used by text entry.
4. Keep `GenerationGate.issueToken()` the single fence point for new turns.

## Limitations

- **No real audio was produced in this sandbox.** LiveKit credentials are required for
  actual LiveKit STT + Rime TTS. The `MockVoiceOutputProvider` + `MockVoiceInputProvider`
  paths are authoritative for interface behavior. See `RIME_EVIDENCE.md` for the exact
  verification boundary.
- `@livekit/*` client packages are **not** installed as npm dependencies; add them for a
  production deployment and replace the fallback bodies of
  `LiveKitSttProvider.start()` / `RimeVoiceOutputProvider.speak()` while keeping their
  contracts.
- Undo is session-local / in-memory and restores the full `GraphSnapshot`.
- Natural-language coverage is intentionally narrow for Phase 1/2. Replace or wrap
  `VoiceIntentResolver` with an LLM while still emitting the same `StateOperation` union.

See [EVALUATION.md](./EVALUATION.md) for Phase 1 acceptance method and measured results.
See [RIME_EVIDENCE.md](./RIME_EVIDENCE.md) for the verified (not fabricated) boundary,
test procedure, and reproduction commands for the Rime integration.
