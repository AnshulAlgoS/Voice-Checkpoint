# Rime Evidence

Evidence recorded on 2026-09-08. Claims that require service credentials are deliberately separated from source, unit-test, build, and browser evidence.

## Integration

| Setting | Default | Environment variable |
|---|---|---|
| Model | `coda` | `RIME_MODEL` |
| Voice | `celeste` | `RIME_VOICE` |
| Language | `en` | `RIME_LANGUAGE` |
| Audio format | MP3 (`Accept: audio/mpeg`) | `RIME_AUDIO_FORMAT` |
| Endpoint | `https://users.rime.ai/v1/rime-tts` | `RIME_ENDPOINT` |
| Transport | HTTPS POST, streamed server pass-through; browser buffers the response Blob before playback | — |

Rime is the primary spoken-output provider. `VoicePipeline` calls `RimeVoiceOutputProvider`, which sends text plus generation/checkpoint context to `POST /api/rime-tts`. The server route adds the Rime bearer credential, sends `speaker`, `text`, `modelId`, and `language` to Rime, and passes the audio response to the browser. There is no browser speech-synthesis fallback. The mock provider remains available only when a caller explicitly requests it for tests.

The API key stays inside the server route. Logs include request ID, generation, model, voice, language, format, cancellation, playback start/stop, and stale-response discard. They do not include the key or authorization header.

Relevant source:

- `lib/voice/VoiceOutputProvider.ts`
- `lib/voice/RimeConfig.ts`
- `app/api/rime-tts/route.ts`
- `lib/voice/VoicePipeline.ts`

## Credentials

Copy `.env.example` to `.env.local` and supply:

```dotenv
RIME_API_KEY=
RIME_ENDPOINT=https://users.rime.ai/v1/rime-tts
RIME_MODEL=coda
RIME_VOICE=celeste
RIME_LANGUAGE=en
RIME_AUDIO_FORMAT=mp3
```

`RIME_API_KEY` is required. The other variables have the defaults shown. A credential was supplied for live verification and stored in the ignored `.env.local` with mode `0600`; its value is not recorded here. `.env.example` is the only environment file allowed by Git.

## Live Rime Result

On 2026-09-08, the application proxy made a credentialed request to the production Rime endpoint using Coda, Celeste, English, and MP3. Observed response:

```text
HTTP/1.1 200 OK
content-type: audio/mpeg
x-rime-model: coda
x-rime-voice: celeste
x-voice-provider: Rime
size: 96000 bytes
format: MPEG layer III, 160 kbps, 24 kHz, mono
sha256: bfcf6458981adf03a1d28d0d570389cfabe38dedb7f4571e4dc22b22bf6050f8
```

A browser-triggered command showed `PLAYING`, completed without error, and updated `LAST SPOKEN` to the Rime response text. This verifies both production synthesis and browser audio playback through the application path.

## LiveKit

Required variables:

```dotenv
LIVEKIT_URL=
LIVEKIT_API_KEY=
LIVEKIT_API_SECRET=
LIVEKIT_AGENT_NAME=voice-checkpoint-transcriber
LIVEKIT_STT_MODEL=deepgram/nova-3-general
```

A LiveKit Cloud credential set was supplied on 2026-09-08 and stored only in the ignored `.env.local` with mode `0600`. The values are not recorded here.

The browser requests `GET /api/livekit-token?room=...&participant=...`. The server returns the public WebSocket URL and a ten-minute participant token; it never returns the API key or secret. The token requests explicit dispatch of the named STT-only agent. The browser connects with `livekit-client`, enables its microphone track, and consumes standard `TranscriptionReceived` events. JSON data messages remain supported for compatible workers.

`voice_agent.py` runs a LiveKit `AgentSession` configured only for STT through LiveKit Inference. Start it separately:

```bash
source .venv/bin/activate
python voice_agent.py dev
```

The UI derives its labels from real provider state: `connecting`, `connected`, `reconnecting`, `disconnected`, or `failed`. Missing credentials produce `failed` with the server error rather than a fake connected state.

Credentialed verification succeeded against the configured LiveKit Cloud project. A server-side `RoomServiceClient.listRooms()` request authenticated successfully, reached the configured project host, and returned the current room list. The Python worker then connected to the same project and registered as `voice-checkpoint-transcriber` in the India South region before shutting down cleanly. This verifies the project URL, key/secret authentication, and worker registration path without exposing any credential.

An agentic Brave run then connected a real microphone track, received an explicitly dispatched LiveKit job, and attached the STT worker to the published microphone stream. The first spoken sentence exposed two adapter issues: LiveKit finalized one utterance as consecutive transcript segments, and reconnecting to a recently emptied fixed room could skip room-creation dispatch. `LiveKitSttProvider` now debounces and combines consecutive final segments into one command and generates a fresh room for every implicit-room `start()`. The core state engine was not changed. Regression tests cover both cases.

## End-to-End Demo

| Step | Voice input and semantic operation | Checkpoint/UI effect | Planned Rime output |
|---|---|---|---|
| 1. Plan a five-day trip to Goa for forty thousand. | Final LiveKit transcript selects the deterministic matching root with `SWITCH_CHECKPOINT`. | V1 is active: Goa, five days, ₹40,000. | Confirms Version 1. |
| 2. Make another version assuming I can spend sixty thousand and prioritize comfort. | `FORK` from V1 with `budget: 60000` and `priorities: ["comfort"]`. | V2 appears and becomes active. | Describes ₹60,000 and comfort. |
| 3. Compare this with the original. | `COMPARE` V1 → V2. | Semantic diff shows budget, accommodation, transport, and priorities. | Speaks changed and unchanged fields. |
| 4. Go back to the original. | `SWITCH_CHECKPOINT` to V1. | V1 is active with ₹40,000. | Confirms the switch. |
| 5. Take the hotel from the luxury version but don't change anything else. | Selective `MERGE` of `accommodation` from V2 into V1. | V3 becomes active with Taj Fort Aguada, ₹40,000, and the original transport/priorities. | Confirms the hotel merge and unchanged budget. |
| 6. What changed? | `COMPARE` active checkpoint with its parent. | Diff shows only accommodation changed. | Explains that only the stay changed and ten fields remain equal. |
| 7. Undo that. | `UNDO`. | Exact pre-merge graph returns: V1 active, ₹40,000, Casa Baga. | Confirms restoration. |

The full seven-command text/transcript path was verified both in the 64-test suite and in the browser UI. The browser visibly showed V3 with Taj Fort Aguada and ₹40,000 after step 5, only `STAY` in the step-6 diff, and V1/Casa Baga/₹40,000 after undo.

With Rime configured, a rapid seven-command browser run exercised real cancellation. Only generation 7 produced the final assistant playback/render, `LAST SPOKEN` contained the undo response, and the visible graph ended on V1 with ₹40,000 and Casa Baga. Older Rime completions did not overwrite the UI.

## Interruption Evidence

To reproduce with credentials:

1. Start a command that produces a long Rime response.
2. Speak a new command while playback is active.
3. Observe `turn_start` issue a newer generation and call `VoicePipeline.interrupt()`.
4. Confirm the active `HTMLAudioElement` pauses and the Rime HTTP request aborts.
5. Confirm the logs show cancellation or stale discard for the old request.
6. Confirm only the newest generation changes the final state and plays audio.

Automated coverage verifies that cancellation aborts the HTTP request, clears playback, never records the cancelled text as spoken, and that an older generation cannot reach output after a newer token is issued.

## Verification

The shell's default Node was version 20, below this repository's declared minimum. Final commands used the bundled Node 24.19 runtime:

```bash
PATH=/Users/anshulsaxena/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH npm test
PATH=/Users/anshulsaxena/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH npx tsc --noEmit
PATH=/Users/anshulsaxena/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH npm run lint
PATH=/Users/anshulsaxena/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH npm run build
/Users/anshulsaxena/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 -m py_compile voice_agent.py
/tmp/rime-voice-venv/bin/python voice_agent.py --help
```

Observed results:

- Tests: **64 passed, 0 failed**.
- Typecheck: **passed**.
- Lint: **passed**.
- Production build: **passed**; `/api/livekit-token` and `/api/rime-tts` were included.
- Python syntax: **passed**.
- LiveKit agent CLI dependency/startup surface: **loaded successfully** and exposed `console`, `start`, `dev`, `connect`, and `download-files` commands.
- Live Rime request: **HTTP 200; valid 96,000-byte MP3 generated**.
- Browser Rime playback: **started and completed successfully**.
- Browser UI: **loaded successfully**, completed the seven deterministic state operations, and passed rapid supersession with only generation 7 rendered/spoken last.
- LiveKit project API: **authenticated successfully** against the configured Cloud host.
- LiveKit STT worker: **registered successfully** as `voice-checkpoint-transcriber` in India South and shut down cleanly.
- LiveKit microphone path: **connected**, dispatched a worker job, attached the browser microphone stream, and returned live STT segments.
- Agentic browser flow: **passed** through fork, compare, switch, selective merge, one-field diff, and exact undo with real Rime playback.
- Demo recording: `evidence/voice-checkpoint-demo.mp4` (133.3 seconds, H.264/AAC, 1920×1100, 30 fps). The browser tabs and address bar are cropped out, and timed local narration explains each acceptance-test step.

The route tests use controlled fake upstream responses. They prove payload shape, proxy streaming, secret containment, token response shape, and state handling; they are not presented as evidence of external service connectivity.

## Phase 3 Status

Completed and verified locally:

- Rime TTS provider abstraction
- Rime primary output path
- Interruptible voice output
- Generation and stale-response fencing
- Voice output cancellation
- Voice connection/status UI
- Checkpoint graph and semantic-state UI
- Diff, merge, and undo visualization
- Reset/demo flow
- Actual Rime audio with real credentials
- Browser playback of production Rime audio
- LiveKit Cloud project authentication
- LiveKit STT worker registration
- 64 tests, typecheck, build, and lint

Implemented and awaiting a microphone-driven browser run:

- Full microphone → STT → state engine → Rime spoken demo

Final evidence document: **complete, with the credential boundary recorded here**.

## Known Limitations

Real Rime audio generation, browser playback, LiveKit project authentication, and LiveKit worker registration are **verified**. The full demo has not yet been completed through live microphone speech and audible Rime output; that interactive browser run is the remaining external verification step.
