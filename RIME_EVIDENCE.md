# RIME_EVIDENCE

## Scope

This file documents the verified Rime (LiveKit TTS) integration inside `Voice-Checkpoint` as of
the current HEAD. Any claim below is either statically verifiable from source or was run in
this sandbox. Claims that require external credentials/services are explicitly marked as
NOT VERIFIED.

## Model / Voice / Language

Source of truth: [`RimeVoiceOutputProvider` constructor in VoiceOutputProvider.ts](file:///c:/Users/Avanya/voicecheckpoint/Voice-Checkpoint/lib/voice/VoiceOutputProvider.ts#L142-L151)

| Field       | Default value     | Environment override |
|-------------|-------------------|----------------------|
| Rime model  | `rime-1`          | `RIME_MODEL`         |
| Rime voice  | `af_sky`          | `RIME_VOICE`         |
| Language    | `en-IN`           | `RIME_LANGUAGE`      |

These defaults are used both by the provider itself and by the `hasRimeCredentials()` /
`createVoiceOutputProvider()` factory. The factory itself is
[createVoiceOutputProvider](file:///c:/Users/Avanya/voicecheckpoint/Voice-Checkpoint/lib/voice/VoiceOutputProvider.ts#L221-L233).

## Endpoint / Inference path / Transport

- **LiveKit control plane URL**: read from `LIVEKIT_URL`, or passed explicitly as
  `RimeProviderOptions.livekitUrl`. Default: `undefined`.
- **Auth**: HTTP Basic-style pair `LIVEKIT_API_KEY` + `LIVEKIT_API_SECRET`, or passed
  explicitly. Default: `undefined`.
- **Transport**: WebRTC room + LiveKit Rime TTS audio track is the intended production
  transport (per Phase 3 specification).
- **Fallback when credentials are missing**: the factory falls back to
  `MockVoiceOutputProvider` deterministically. This fallback is used in unit tests and
  in local development without LiveKit.

**Important — NOT VERIFIED in this sandbox**: the actual production WebRTC Rime TTS SDK
(`@livekit/rtc-node` helpers or `@livekit/components-js` Rime audio output) is NOT
installed as a runtime npm dependency. The provider validates credentials and exposes the
`VoiceOutputProvider` contract, but the final `speak()` implementation inside
`RimeVoiceOutputProvider.speak()` uses the host `window.speechSynthesis` Web Speech API
as an in-browser placeholder audio path for environments where the Rime audio track has
not been connected yet. This does NOT exercise the real LiveKit Rime endpoint. A real
deployment should replace the body of `speak()` / `cancel()` with the installed LiveKit
Rime client methods and keep the interface / generation / stale fencing unchanged.

## Audio format

- Intended production codec: whatever LiveKit Rime TTS publishes on the audio track
  (typically Opus-encoded WebRTC).
- Dev/fallback codec: `SpeechSynthesisUtterance` output (format determined by the local
  browser's speech engine).

## Interface contract

The exposed `VoiceOutputProvider` interface (required for any replacement) lives in
[`lib/voice/types.ts`](file:///c:/Users/Avanya/voicecheckpoint/Voice-Checkpoint/lib/voice/types.ts)
and [`VoiceOutputProvider.ts`](file:///c:/Users/Avanya/voicecheckpoint/Voice-Checkpoint/lib/voice/VoiceOutputProvider.ts#L10-L21):

```ts
interface VoiceOutputProvider {
  readonly kind: 'rime' | 'mock';
  speak(text: string, context: VoiceOutputContext): Promise<VoiceOutputHandle>;
  cancel(handleId: string): Promise<void>;
  getStatus(): VoiceOutputStatus;
}
```

`context.generation` carries the `GenerationGate` token so the provider *and* any wrapping
playback layer can immediately drop utterances whose context generation is older than the
current gate. This is the core stale-response suppression mechanism.

## Test procedure

The following commands were run in this sandbox:

```bash
npm test                      # node:test suite (54 tests → 54 pass)
npx tsc --noEmit              # typecheck → exit 0
npm run build                 # vinext production build → exit 0
npm run lint                  # oxlint → exit 0
```

Phase-3-specific evidence tests that exercise voice-output without real audio:

- `tests/phase3.test.ts` — 19 tests all passing:
  - `GenerationGate` monotonic issuing and stale detection
  - `MockVoiceOutputProvider` `speak` / `cancel` / `getSpokenLog` contract
  - `RimeVoiceOutputProvider` credential check throws correctly when env vars are absent
  - `createVoiceOutputProvider` factory: returns `Rime` when credentials present in-memory
  - `VoiceOrchestrator` op resolution + FORK + SWITCH + MERGE + COMPARE + UNDO
  - `ResponsePlanner` FORK/SWITCH/MERGE/COMPARE/UNDO text generation and clarification/unsupported branches
  - interruption: newer `pipeline.submit()` supersedes older playback, older generation marked stale
  - exact-cancel: provider.cancel() removes queued utterance
  - `resetDemoGraph()` restores graph to its initial snapshot
  - 7-step deterministic judge sequence via real StateGraph + merge + undo semantics

## Observed result in this sandbox

- Interface tests: **PASS**.
- Provider construction / fallback / credential checks: **PASS**.
- Generation + stale fencing: **PASS** (1 stale → superseded, 1 interrupt).
- Actual Rime TTS audio over WebRTC: **NOT PRODUCED / NOT VERIFIED**
  - LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET not present in this environment.
  - No LiveKit Rime client npm packages are declared in package.json; adding them and
    wiring the `speak()`/`cancel()` body to real Rime tracks is the remaining deployment
    step.
- Fallback `window.speechSynthesis` path (used when credentials are present in provider
  options but no LiveKit SDK is yet wired): would run in a browser, but not exercised
  during this command-line build session.

## Evidence pointers (code refs)

1. Primary output factory → [createVoiceOutputProvider](file:///c:/Users/Avanya/voicecheckpoint/Voice-Checkpoint/lib/voice/VoiceOutputProvider.ts#L221-L233)
2. Rime provider → [RimeVoiceOutputProvider](file:///c:/Users/Avanya/voicecheckpoint/Voice-Checkpoint/lib/voice/VoiceOutputProvider.ts#L132-L212)
3. Mock provider → [MockVoiceOutputProvider](file:///c:/Users/Avanya/voicecheckpoint/Voice-Checkpoint/lib/voice/VoiceOutputProvider.ts#L32-L112)
4. Generation/stale boundary → [GenerationGate](file:///c:/Users/Avanya/voicecheckpoint/Voice-Checkpoint/lib/voice/GenerationGate.ts)
5. Pipeline wiring (ops → planner → provider) → [VoicePipeline.submit](file:///c:/Users/Avanya/voicecheckpoint/Voice-Checkpoint/lib/voice/VoicePipeline.ts#L34-L81)
6. Judge UI wiring → [voice-checkpoint.tsx pipeline](file:///c:/Users/Avanya/voicecheckpoint/Voice-Checkpoint/app/voice-checkpoint.tsx#L167-L177)
7. Tests → [phase3.test.ts](file:///c:/Users/Avanya/voicecheckpoint/Voice-Checkpoint/tests/phase3.test.ts)

## Reproduction commands

```bash
npm install
npm test                      # 54/54 pass
npx tsc --noEmit              # exit 0
npm run build                 # exit 0
npm run lint                  # exit 0
```

To exercise real Rime audio (outside this sandbox), set env vars then run the dev server:

```bash
export LIVEKIT_URL=wss://<your-project>.livekit.cloud
export LIVEKIT_API_KEY=<APIXxx>
export LIVEKIT_API_SECRET=<secret>
export RIME_MODEL=rime-1
export RIME_VOICE=af_sky
export RIME_LANGUAGE=en-IN
npm run dev
```

## Limitations

1. **Credentials required for real TTS**: without `LIVEKIT_URL` / `LIVEKIT_API_KEY` /
   `LIVEKIT_API_SECRET`, the factory deterministically returns `MockVoiceOutputProvider`.
2. **LiveKit Rime client SDK not installed**: production deployment should add the
   correct LiveKit npm package providing Rime TTS output and wire its output track
   lifecycle into the `speak()` / `cancel()` bodies while preserving the context
   generation check.
3. **Microphone / STT path symmetric**: the matching input boundary is exported as
   `createVoiceInputProvider()` / `LiveKitSttProvider` in
   [VoiceInputProvider.ts](file:///c:/Users/Avanya/voicecheckpoint/Voice-Checkpoint/lib/voice/VoiceInputProvider.ts)
   — same credential preconditions and dev-time Mock fallback apply.
4. **Server-only secrets**: API key/secret must stay server-side (use server route for
   token minting). The client code only reads env vars to decide `kind: 'rime'` vs
   `kind: 'mock'`. A future deploy route should mint short-lived LiveKit access tokens
   instead of leaking the API secret to the browser.
