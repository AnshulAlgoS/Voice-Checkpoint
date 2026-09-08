# Phase 3 Specification: Rime Voice Output & Interruptible Playback

## Problem

Voice Checkpoint has a working semantic state engine (Phase 1) and natural-language resolver with generation fencing (Phase 2). The missing pieces for a complete voice-first interface are:

1. **No voice output** — operation results are visible only in the UI; the assistant cannot speak responses.
2. **No interruption** — stale responses cannot be cancelled mid-playback when the user interrupts.
3. **No generation ↔ voice binding** — audio playback is not fenced to the authoritative generation, so stale text could be spoken.
4. **No judge-ready UI** — the current Phase 1 panel and Phase 2 debug panel are separate, minimal, and do not expose the complete application state needed for evaluation.
5. **No deterministic demo entry point** — the seven-step demo sequence can only be driven manually, with no reset.

## Users

- **Evaluators / judges**: need to verify that Rime speaks, interruptions cancel playback, selective merge produces the exact expected state, undo is exact, and the demo sequence works deterministically.
- **Developers**: need a mock voice output mode for local development without Rime credentials.
- **End-users**: experience voice-first operation where spoken responses stay consistent with the active checkpoint and generation.

## Goals

1. Integrate Rime as the primary voice output path behind an abstract `VoiceOutputProvider` interface, with a `MockVoiceOutputProvider` fallback for local/test use.
2. Make playback interruptible: issuing a newer generation must cancel any in-flight voice output from an older generation.
3. Bind every spoken response to a generation token / checkpoint / state graph so stale chunks never reach the audio channel.
4. Polish the existing UI into a single, clear, judge-ready panel that shows all relevant real state (active checkpoint, graph, diff, merge fields, undo history, voice status, generation, transcript, resolved operation).
5. Implement a `resetDemo()` helper and a visible "Demo Reset" control that restores the graph to its exact deterministic starting state so the 7-step demo can be repeated.
6. Ensure the exact 7-step demo sequence runs end-to-end using the real Phase 1/2 engine (no hardcoded UI state).
7. Add tests proving voice provider abstraction, cancellation, interruption, stale-response suppression, generation/state consistency, demo reset, selective merge, exact undo, and the deterministic demo flow.
8. Document setup, Rime configuration (only verifiable values), mock mode, and acceptance criteria in `README.md` and `RIME_EVIDENCE.md`.

## Non-Goals

- No LiveKit audio pipeline / STT implementation (the boundary is text-in → voice-out; we assume STT produces text that the existing resolver consumes).
- No LLM-based response generator — response text is produced by a deterministic response planner over the typed `OperationResult`.
- No new state engine. `StateGraph`, `StateOperation`, `GenerationGate`, and `VoiceOrchestrator` are preserved and extended only at boundaries.
- No decorative animations, elaborate styling, or refactoring of unrelated files.
- No secrets in code or documentation.

## Functional Requirements

### FR-1 — Voice Output Provider Abstraction

A `VoiceOutputProvider` interface must exist with, at minimum:

```ts
interface VoiceOutputHandle { id: string; }
interface VoiceOutputContext { generation: string; checkpointId: string | null; }
interface VoiceOutputProvider {
  speak(text: string, context: VoiceOutputContext): Promise<VoiceOutputHandle>;
  cancel(handleId: string): Promise<void>;
}
```

Two implementations:

- `RimeVoiceOutputProvider` — when Rime/LiveKit env vars are present, uses the currently supported LiveKit Agents Rime integration (inspect installed packages and use their actual API).
- `MockVoiceOutputProvider` — stores spoken utterances in memory, supports cancellation via a token/flag, resolves after a simulated delay. This is the default when credentials are missing or in tests.

Rime-specific logic, env-var reading, and any network calls are **isolated** inside `RimeVoiceOutputProvider`. Credentials are read only from `process.env` (server-side only); nothing is exposed to the browser bundle.

### FR-2 — Response Planner

A deterministic response planner converts an `OperationResult` (plus `isStale` flag, `generation`, and active `checkpointId`) into natural-language text suitable for speaking. It handles:

- FORK: "Created Version N — label. Budget is X, stay is Y."
- SWITCH: "Switched to Version N — label."
- COMPARE: summarises changed fields.
- MERGE: "Merged fields: X from source into Version N. Budget remains Y."
- UNDO: "Last operation undone. Active state is restored."
- UPDATE / CREATE / REWIND / DESCRIBE.
- Clarification / unsupported — short spoken prompts.

The planner never invokes state mutations; it reads values from the supplied result.

### FR-3 — Interruptible Playback + Generation Fencing for Voice

Before the orchestrator (or a new thin wrapper) passes text to the provider, and before each chunk of streaming text (if streaming is used), the implementation **re-verifies** that:

1. The generation token is still current (`gate.authorize(generation)`).
2. The associated `checkpointId` still exists (optional hardening).

If stale:

- The response is discarded.
- If a `VoiceOutputHandle` already exists, `cancel(handle.id)` is called.
- No audio is produced.

When a **new user operation** arrives (interrupt):

1. `gate.issueToken()` — invalidates previous generation.
2. If an active `VoiceOutputHandle` exists for an older generation, call `provider.cancel(handleId)`.
3. Proceed with the new operation and speak only the new result.

### FR-4 — State/Voice Consistency

Every spoken utterance is produced with a `VoiceOutputContext` that includes:

- `generation`: the `GenerationToken` issued for this operation.
- `checkpointId`: the active checkpoint id at the moment the operation was issued.

Both values are re-checked (against `gate.currentGeneration` and `graph.active?.id`) right before `speak()` is invoked. If either check fails, the call is skipped.

### FR-5 — UI Polish (Judge-Ready Single Panel)

The existing UI components are consolidated into a single clean panel that shows the **actual** application state:

- Active checkpoint (version, label, summary, branch, structured fields with formatted values).
- Checkpoint graph (lineage, each checkpoint's version, parent, active highlight; clickable to switch).
- Current semantic state (formatted fields).
- Recent operation (operation type, confidence, source/target checkpoint ids if applicable).
- Diff section (when present): changed / added / removed fields, formatted values.
- Selected merge fields (when applicable): which fields were carried over in the last MERGE.
- Undo history: how many undo points are available; "Undo last" control.
- Voice connection / status: current provider (`Rime` vs `Mock`), whether audio is playing, active handle id if any, last spoken text.
- Operation / generation status: current generation token, last task generation, stale indicator.
- Transcript area: text input + "Resolve" + "Interrupt" buttons.
- Resolved operation display (JSON summary of the typed operation that was executed).

Plus a clearly visible **"Demo Reset"** button that calls `resetDemo()` and restores the exact starting state.

No fake state. All values come directly from `StateGraph.export()`, `GenerationGate`, and the voice provider status.

Responsive layout, good spacing, and a clear visual hierarchy; avoid decorative animations.

### FR-6 — Deterministic Demo & Reset

`createDemoGraph()` already produces the starting state. Add:

- `resetDemo(graph)` or a method on a `DemoController` that resets the graph in-place to the exact initial snapshot (one checkpoint: V1 / ₹40k practical / Casa Baga / Konkan Express / 5d / Goa / value + local food).
- The UI exposes a visible "Demo Reset" button.
- After reset, the 7-step sequence must produce exactly:

| Step | Input | Expected result |
|------|-------|-----------------|
| 1 | "Plan a five-day trip to Goa for forty thousand." | (already in initial state, confirmed V1) |
| 2 | "Make another version assuming I can spend sixty thousand and prioritize comfort." | V2 (₹60k, comfort, Taj Fort Aguada, Flight) |
| 3 | "Compare this with the original." | Diff shows budget, accommodation, transportation, priorities changed, destination unchanged |
| 4 | "Go back to the original." | Active becomes V1 (₹40k, Casa Baga) |
| 5 | "Take the hotel from the luxury version but don't change anything else." | New checkpoint on V1 branch; accommodation = Taj Fort Aguada, budget still 40000 |
| 6 | "What changed?" | Compare with pre-merge: accommodation changed only |
| 7 | "Undo that." | Exact graph state restored to before step 5; V1 active with Casa Baga |

The sequence uses the **real** engine via the typed orchestrator/resolver; no hardcoded demo shims.

### FR-7 — Tests

At minimum, tests must cover:

1. Voice provider abstraction: `MockVoiceOutputProvider.speak()` and `cancel()` work; `RimeVoiceOutputProvider` has the correct interface (gated behind env vars so it degrades to no-op / mock in test).
2. Cancellation: cancelling an active mock handle prevents completion.
3. Interruption: issuing a newer generation causes the older in-flight speak to be cancelled or discarded.
4. Stale response suppression: speaking a result whose generation is no longer current does not produce audio.
5. Generation / state consistency: context check fails if checkpointId or generation no longer matches.
6. Demo Reset: `resetDemo()` returns the graph to an identical snapshot as a fresh `createDemoGraph()`.
7. Selective merge: merge of `accommodation` from V2 into V1 leaves budget, transport unchanged (exact values).
8. Exact undo: `undo()` after merge produces deep-equal snapshot to pre-merge.
9. Deterministic 7-step demo flow: run all 7 steps through the orchestrator, assert the exact state transitions from the table above.

All existing Phase 1 and Phase 2 tests must continue to pass without modification.

### FR-8 — Documentation

- `README.md` updated with: product/problem, why voice is necessary, architecture diagram covering all 3 phases, setup, env vars, LiveKit/Rime setup, mock mode, tests, deterministic demo walkthrough, acceptance criteria, limitations.
- `RIME_EVIDENCE.md` created with: claim, acceptance criterion, test procedure, exact Rime model / voice / language / endpoint / audio format / transport / observed result / evidence / limitations / reproduction commands. Values that cannot be verified are explicitly marked as not yet verified.

## Non-Functional Requirements

- **Preservation**: no existing Phase 1 or Phase 2 code is weakened, deleted, or bypassed. `StateGraph`, `GenerationGate`, `VoiceOrchestrator`, `VoiceIntentResolver`, and tests are preserved.
- **Abstraction reuse**: stale-response fencing reuses `GenerationGate.authorize()`; state operations still flow through `StateOperation` → `StateGraph.execute()`. No second state engine, checkpoint store, or stale-response system is created.
- **Minimal dependencies**: no new npm packages unless they are the actual LiveKit/Rime client libraries (and only if env vars require them). Mock mode must work with zero new runtime dependencies.
- **Server-side credentials**: Rime keys are read only from `process.env` on the server side; never serialized into the browser bundle.
- **Determinism**: response planner output and demo reset are fully deterministic.
- **Build / typecheck / lint**: `npm run build`, `npm test`, and `npm run lint` must pass.

## Constraints, Dependencies, Assumptions

- LiveKit/Rime packages are **not currently installed** (see `package.json`). If a LiveKit Agents / Rime client package is required, install it only if the provider cannot be cleanly abstracted behind a boundary that degrades to mock. Prefer a thin boundary that checks env vars first, so the app builds and runs without credentials.
- STT / microphone pipeline is out of scope. The UI accepts typed text as transcript; the architecture is text-in → voice-out.
- If Rime credentials are unavailable in this environment, the integration boundary is implemented correctly (provider API, env-var names, error path, graceful fallback to mock), and the limitation is clearly documented.
- The existing `VoiceOrchestrator.orchestrate()` / `orchestrateAsync()` are reused; if a thin wrapper is needed to bind the response planner + voice provider, it calls orchestrate and then gates + speaks — it does not reimplement resolution or execution.
- UI changes are confined to `app/voice-checkpoint.tsx` and possibly a new shared hook/provider; existing component files under `components/ui/` are not refactored.

## Open Questions

None. The spec assumes mock mode is the default path and Rime is activated only when the correct `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, and `RIME_VOICE` (or equivalent) env vars are present, following LiveKit Agents conventions.

## Acceptance Criteria

### Rule AC-1
When mock mode is active, calling the end-to-end pipeline (transcript → orchestrator → response planner → provider) results in exactly one call to `MockVoiceOutputProvider.speak()` with the planner's text and a context whose generation matches `gate.currentGeneration`.

### Rule AC-2
After an in-flight speak starts, issuing a newer generation and calling `cancel()` on the provider (via interruption flow) causes the in-flight handle to be marked cancelled and the provider's currently-playing text to be discarded before completion.

### Rule AC-3
Speaking a result whose generation is no longer authorised (`authorize(generation) === false`) skips the `speak()` call entirely and leaves the provider's play queue empty.

### Rule AC-4
Running the 7-step deterministic demo through the real orchestrator/resolver produces, after each step, the exact checkpoint/active state specified in FR-6. After step 7 (undo), `graph.export()` is deep-equal to `export()` from a graph just before step 5.

### Rule AC-5
Clicking "Demo Reset" in the UI restores a graph that is deep-equal to the export of a freshly-constructed `createDemoGraph()`.

### Rule AC-6
All existing Phase 1 and Phase 2 tests pass without modification: `npm test` succeeds. `npm run build` and `npm run lint` succeed.

### Rule AC-7
The `VoiceOutputProvider` interface and `RimeVoiceOutputProvider` are defined. In an environment without LiveKit env vars, the provider factory returns `MockVoiceOutputProvider` and the UI displays "Voice: Mock". With env vars present, the factory returns `RimeVoiceOutputProvider` and the UI displays "Voice: Rime".

### Rule AC-8
No `LIVEKIT_*` or `RIME_*` secrets are present anywhere in the working tree (checked via `git diff` and grep).

### Rubric AC-9 (UI Clarity, threshold ≥ 3/4)
- 4: Active checkpoint, graph, diff, merge fields, undo history, voice status, generation, transcript, and resolved operation are all visible, labelled clearly, non-overlapping, responsive, and read directly from real engine state with zero hardcoded demo values.
- 3: ≥ 7 of 9 sections present, all from real engine state, minor layout issues on small screens.
- 2: Some sections missing or contain static placeholder text.
- 1: Mostly unchanged from Phase 1/2 debug panels.

### Rubric AC-10 (Boundary Fidelity, threshold ≥ 2/2)
- 2: Every spoken response re-uses Phase 2 `GenerationGate` + `VoiceOrchestrator`. No second state/checkpoint engine. No direct state mutation from the voice layer. All changes flow through `StateOperation` → `StateGraph.execute()`.
- 1: One minor bypass.
- 0: Duplicate engine or direct mutation present.
