# Voice Checkpoint

Voice Checkpoint is a generic semantic state engine for branching, switching, comparing, selectively merging, and undoing structured decisions.

Phase 1 contains the complete state layer, deterministic resolver, automated acceptance suite, and a browser UI that exercises the real graph. Realtime voice, STT, LiveKit, and Rime are intentionally outside this phase.

## Architecture

```text
UI / future voice transport
          │
          ▼
  IntentResolver ──► typed StateOperation
                          │
                          ▼
                     StateGraph
                 ┌────────┼────────┐
                 ▼        ▼        ▼
              Diff     Merge     Undo
                 └────────┼────────┘
                          ▼
              immutable Checkpoint<T>
```

The stable Phase 2 boundary is exported from `lib/state/index.ts`. `StateGraph<T>` accepts any JSON-compatible record, and `execute(operation)` is the single typed command interface for an orchestration layer.

```ts
const result = graph.execute({
  type: 'MERGE',
  sourceCheckpointId: 'cp-2',
  targetCheckpointId: 'cp-1',
  fields: ['accommodation'],
  meta: { label: 'A · hotel from B' },
});
```

All public reads return structured clones. A caller cannot mutate internal checkpoints accidentally. Forks copy parent state, merges copy only explicit field paths, and undo restores the entire prior graph snapshot including the active checkpoint.

## Run locally

Node.js 22.13 or newer is required.

```bash
npm install
npm run dev
```

Open the local URL printed by the development server. Use the Acceptance path controls in order: **Fork B → Switch A → Compare → Merge hotel → Undo last**.

The command console also resolves Phase 1 phrases such as:

- `Go back to the forty-thousand version.`
- `Compare this with the luxury version.`
- `Take the hotel from the luxury version, but keep everything else from this one.`
- `Undo that.`

## Test and build

```bash
npm test
npm run test:acceptance
npm run build
```

The suite covers isolation, switching, selective merge, diff classification, exact undo, contamination resistance, nested ancestry, natural-language operation mapping, ambiguity handling, the complete acceptance flow, and a non-trip state domain.

## Phase 1 boundaries

- No microphone, STT, synthesized audio, LiveKit, Rime, or realtime transport is implemented.
- The resolver is deterministic and intentionally narrow. Phase 2 can replace or wrap it with an LLM while continuing to emit the same `StateOperation` union.
- State is held in memory. `export()` and the snapshot constructor provide the persistence boundary for Phase 2.
- Undo is session-local and restores the complete graph to its exact previous snapshot.

See [EVALUATION.md](./EVALUATION.md) for the acceptance method and measured results.
