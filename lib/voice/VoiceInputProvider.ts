import type {
  Room,
  RemoteParticipant,
  RemoteTrack,
  RemoteTrackPublication,
} from 'livekit-client';

export type VoiceInputEventType =
  | 'connection'
  | 'turn_start'
  | 'vad_start'
  | 'interim_transcript'
  | 'final_transcript'
  | 'vad_end'
  | 'turn_end'
  | 'error';

export interface VoiceInputEvent {
  type: VoiceInputEventType;
  at: number;
  message?: string;
  transcript?: string;
  connection?: 'disconnected' | 'connecting' | 'connected';
}

export interface VoiceInputListener {
  (event: VoiceInputEvent): void;
}

export interface VoiceInputProvider {
  readonly kind: 'livekit' | 'mock';
  start(): Promise<void>;
  stop(): Promise<void>;
  pushTranscript(transcript: string): void;
  getStatus(): { connected: boolean; capturing: boolean; lastTranscript: string | null };
  subscribe(listener: VoiceInputListener): () => void;
}

interface LiveKitSttOptions {
  livekitUrl?: string;
  livekitApiKey?: string;
  livekitApiSecret?: string;
  rimeModel?: string;
  language?: string;
  roomName?: string;
  participantName?: string;
  tokenEndpoint?: string;
}

function readEnv(key: string): string | undefined {
  try {
    const processEnv = (globalThis as unknown as { process?: { env?: Record<string, string> } }).process?.env;
    if (processEnv) {
      const v = processEnv[key];
      if (v && v.length) return v;
    }
  } catch { /* noop */ }
  try {
    const meta = (globalThis as unknown as { import?: { meta?: { env?: Record<string, string> } } }).import?.meta?.env;
    if (meta) {
      const direct = meta[key];
      if (direct && direct.length) return direct;
      if (key === 'LIVEKIT_URL') {
        const alt1 = meta.VITE_LIVEKIT_URL;
        const alt2 = meta.NEXT_PUBLIC_LIVEKIT_URL;
        const alt3 = meta.PUBLIC_LIVEKIT_URL;
        if (alt1 && alt1.length) return alt1;
        if (alt2 && alt2.length) return alt2;
        if (alt3 && alt3.length) return alt3;
      }
      if (key === 'RIME_MODEL') {
        const alt = meta.VITE_RIME_MODEL;
        if (alt && alt.length) return alt;
      }
      if (key === 'RIME_VOICE') {
        const alt = meta.VITE_RIME_VOICE;
        if (alt && alt.length) return alt;
      }
      if (key === 'RIME_LANGUAGE') {
        const alt = meta.VITE_RIME_LANGUAGE;
        if (alt && alt.length) return alt;
      }
    }
  } catch { /* noop */ }
  return undefined;
}

function isBrowserRuntime(): boolean {
  return typeof window !== 'undefined' && typeof document !== 'undefined';
}

export function hasLiveKitCredentials(options: LiveKitSttOptions = {}): boolean {
  const url = options.livekitUrl ?? readEnv('LIVEKIT_URL');
  if (!url) return false;
  const key = options.livekitApiKey ?? readEnv('LIVEKIT_API_KEY');
  const secret = options.livekitApiSecret ?? readEnv('LIVEKIT_API_SECRET');
  if (isBrowserRuntime()) {
    return Boolean(url) || Boolean(key && secret);
  }
  return Boolean(url && key && secret);
}

export class MockVoiceInputProvider implements VoiceInputProvider {
  readonly kind = 'mock' as const;
  private readonly listeners = new Set<VoiceInputListener>();
  private capturing = false;
  private connected = false;
  private lastTranscript: string | null = null;

  async start(): Promise<void> {
    this.connected = true;
    this.capturing = true;
    this.emit({ type: 'connection', at: Date.now(), connection: 'connected' });
  }

  async stop(): Promise<void> {
    this.capturing = false;
    this.connected = false;
    this.emit({ type: 'connection', at: Date.now(), connection: 'disconnected' });
  }

  pushTranscript(transcript: string): void {
    const at = Date.now();
    if (!transcript.trim()) return;
    this.emit({ type: 'turn_start', at });
    this.emit({ type: 'vad_start', at });
    this.emit({ type: 'interim_transcript', at, transcript: transcript.trim() });
    const finalText = transcript.trim();
    this.lastTranscript = finalText;
    this.emit({ type: 'final_transcript', at, transcript: finalText });
    this.emit({ type: 'vad_end', at });
    this.emit({ type: 'turn_end', at, message: finalText });
  }

  getStatus() {
    return { connected: this.connected, capturing: this.capturing, lastTranscript: this.lastTranscript };
  }

  subscribe(listener: VoiceInputListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: VoiceInputEvent): void {
    for (const l of this.listeners) {
      try { l(event); } catch { /* swallow listener errors */ }
    }
  }
}

interface SttDataMessage {
  type?: 'interim_transcript' | 'final_transcript' | 'vad_start' | 'vad_end' | 'turn_start' | 'turn_end';
  text?: string;
  transcript?: string;
  segment_id?: string;
  final?: boolean;
}

export class LiveKitSttProvider implements VoiceInputProvider {
  readonly kind = 'livekit' as const;

  private readonly opts: {
    livekitUrl: string | null;
    livekitApiKey: string | null;
    livekitApiSecret: string | null;
    rimeModel: string;
    language: string;
    roomName: string;
    participantName: string;
    tokenEndpoint: string;
  };

  private readonly listeners = new Set<VoiceInputListener>();
  private connected = false;
  private capturing = false;
  private lastTranscript: string | null = null;
  private room: Room | null = null;
  private roomCleanup: Array<() => void> = [];

  constructor(options: LiveKitSttOptions = {}) {
    this.opts = {
      livekitUrl: options.livekitUrl ?? readEnv('LIVEKIT_URL') ?? null,
      livekitApiKey: options.livekitApiKey ?? readEnv('LIVEKIT_API_KEY') ?? null,
      livekitApiSecret: options.livekitApiSecret ?? readEnv('LIVEKIT_API_SECRET') ?? null,
      rimeModel: options.rimeModel ?? readEnv('RIME_MODEL') ?? 'rime-1',
      language: options.language ?? readEnv('RIME_LANGUAGE') ?? 'en-IN',
      roomName: options.roomName ?? 'voice-checkpoint',
      participantName: options.participantName ?? 'judge',
      tokenEndpoint: options.tokenEndpoint ?? '/api/livekit-token',
    };
  }

  getConfig() {
    return {
      livekitUrl: this.opts.livekitUrl,
      rimeModel: this.opts.rimeModel,
      language: this.opts.language,
      roomName: this.opts.roomName,
      participantName: this.opts.participantName,
      hasCredentials: Boolean(this.opts.livekitUrl && this.opts.livekitApiKey && this.opts.livekitApiSecret),
    };
  }

  private async fetchToken(): Promise<string> {
    const endpoint = new URL(this.opts.tokenEndpoint, typeof window !== 'undefined' ? window.location.origin : 'http://localhost');
    endpoint.searchParams.set('room', this.opts.roomName);
    endpoint.searchParams.set('participant', this.opts.participantName);
    const res = await fetch(endpoint.toString(), {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(`Token endpoint failed: ${res.status} ${(body as { error?: string }).error ?? res.statusText}`);
    }
    const json = (await res.json()) as { token: string };
    if (!json.token) throw new Error('Token endpoint returned no token.');
    return json.token;
  }

  async start(): Promise<void> {
    if (!this.opts.livekitUrl) {
      const at = Date.now();
      this.emit({ type: 'error', at, message: 'LiveKitSttProvider: LIVEKIT_URL must be configured (server-side via env or options).' });
      throw new Error(
        'LiveKitSttProvider: LIVEKIT_URL must be configured (server-side via env or options).',
      );
    }

    this.emit({ type: 'connection', at: Date.now(), connection: 'connecting' });

    let RoomCtor: typeof Room | null = null;
    let TrackPub: typeof import('livekit-client').Track | null = null;
    let RoomEventCtor: typeof import('livekit-client').RoomEvent | null = null;
    try {
      const lk = await import('livekit-client');
      RoomCtor = lk.Room;
      TrackPub = lk.Track;
      RoomEventCtor = lk.RoomEvent;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const at = Date.now();
      this.emit({ type: 'error', at, message: `LiveKit SDK failed to load: ${msg}` });
      throw new Error(`LiveKit SDK failed to load: ${msg}`);
    }

    let token: string;
    try {
      token = await this.fetchToken();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const at = Date.now();
      this.emit({ type: 'connection', at, connection: 'disconnected' });
      this.emit({ type: 'error', at, message: `LiveKit token error: ${msg}` });
      throw new Error(`LiveKit token error: ${msg}`);
    }

    const room = new RoomCtor({
      adaptiveStream: true,
      dynacast: true,
    });
    this.room = room;

    const onData = (payload: Uint8Array, participant: RemoteParticipant | undefined) => {
      void participant;
      this.handleSttData(payload);
    };
    const onDisconnect = () => {
      this.connected = false;
      this.capturing = false;
      this.emit({ type: 'connection', at: Date.now(), connection: 'disconnected' });
    };
    const onTrackSubscribed = (
      track: RemoteTrack,
      _pub: RemoteTrackPublication,
      _participant: RemoteParticipant,
    ) => {
      void track;
      void _pub;
      void _participant;
    };
    type RoomEventKey = keyof import('livekit-client').RoomEventCallbacks;
    room.on(RoomEventCtor.DataReceived as RoomEventKey, onData as never);
    room.on(RoomEventCtor.Disconnected as RoomEventKey, onDisconnect as never);
    room.on(RoomEventCtor.TrackSubscribed as RoomEventKey, onTrackSubscribed as never);
    this.roomCleanup.push(() => {
      try { room.off(RoomEventCtor!.DataReceived as RoomEventKey, onData as never); } catch { /* noop */ }
      try { room.off(RoomEventCtor!.Disconnected as RoomEventKey, onDisconnect as never); } catch { /* noop */ }
      try { room.off(RoomEventCtor!.TrackSubscribed as RoomEventKey, onTrackSubscribed as never); } catch { /* noop */ }
    });

    try {
      await room.connect(this.opts.livekitUrl, token);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.cleanupRoom();
      const at = Date.now();
      this.emit({ type: 'connection', at, connection: 'disconnected' });
      this.emit({ type: 'error', at, message: `LiveKit connect error: ${msg}` });
      throw new Error(`LiveKit connect error: ${msg}`);
    }

    this.connected = true;
    this.emit({ type: 'connection', at: Date.now(), connection: 'connected' });

    try {
      if (TrackPub) {
        await room.localParticipant.setMicrophoneEnabled(true);
      }
      this.capturing = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.capturing = false;
      const at = Date.now();
      this.emit({ type: 'error', at, message: `Microphone permission/error: ${msg}` });
    }
  }

  private handleSttData(payload: Uint8Array): void {
    let parsed: SttDataMessage | null = null;
    try {
      const decoder = new TextDecoder('utf-8');
      const text = decoder.decode(payload);
      parsed = JSON.parse(text) as SttDataMessage;
    } catch {
      try {
        const decoder = new TextDecoder('utf-8');
        parsed = { type: 'interim_transcript', text: decoder.decode(payload) };
      } catch {
        return;
      }
    }
    if (!parsed) return;

    const at = Date.now();
    const transcriptText = parsed.transcript ?? parsed.text ?? '';
    const typeHint = parsed.type;

    switch (typeHint) {
      case 'turn_start':
        this.emit({ type: 'turn_start', at });
        break;
      case 'vad_start':
        this.emit({ type: 'vad_start', at });
        break;
      case 'interim_transcript':
        if (transcriptText) {
          this.emit({ type: 'interim_transcript', at, transcript: transcriptText });
        }
        break;
      case 'final_transcript': {
        const final = parsed.final !== false;
        void final;
        if (transcriptText) {
          this.lastTranscript = transcriptText;
          this.emit({ type: 'final_transcript', at, transcript: transcriptText });
        }
        break;
      }
      case 'vad_end':
        this.emit({ type: 'vad_end', at });
        break;
      case 'turn_end':
        this.emit({ type: 'turn_end', at, message: transcriptText || undefined });
        break;
      default:
        if (parsed.final === true && transcriptText) {
          this.lastTranscript = transcriptText;
          this.emit({ type: 'final_transcript', at, transcript: transcriptText });
        } else if (transcriptText && parsed.final !== true) {
          this.emit({ type: 'interim_transcript', at, transcript: transcriptText });
        }
        break;
    }
  }

  private cleanupRoom(): void {
    for (const fn of this.roomCleanup) { try { fn(); } catch { /* noop */ } }
    this.roomCleanup = [];
    if (this.room) {
      try { this.room.disconnect(); } catch { /* noop */ }
      this.room = null;
    }
  }

  async stop(): Promise<void> {
    this.capturing = false;
    this.cleanupRoom();
    this.connected = false;
    this.emit({ type: 'connection', at: Date.now(), connection: 'disconnected' });
  }

  pushTranscript(transcript: string): void {
    const at = Date.now();
    if (!transcript.trim()) return;
    this.emit({ type: 'turn_start', at });
    this.emit({ type: 'vad_start', at });
    this.emit({ type: 'interim_transcript', at, transcript: transcript.trim() });
    const finalText = transcript.trim();
    this.lastTranscript = finalText;
    this.emit({ type: 'final_transcript', at, transcript: finalText });
    this.emit({ type: 'vad_end', at });
    this.emit({ type: 'turn_end', at, message: finalText });
  }

  getStatus() {
    return { connected: this.connected, capturing: this.capturing, lastTranscript: this.lastTranscript };
  }

  subscribe(listener: VoiceInputListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: VoiceInputEvent): void {
    for (const l of this.listeners) {
      try { l(event); } catch { /* swallow listener errors */ }
    }
  }
}

export function createVoiceInputProvider(
  options: LiveKitSttOptions & { forceMock?: boolean } = {},
): VoiceInputProvider {
  if (options.forceMock) return new MockVoiceInputProvider();
  if (hasLiveKitCredentials(options)) {
    try {
      return new LiveKitSttProvider(options);
    } catch {
      return new MockVoiceInputProvider();
    }
  }
  return new MockVoiceInputProvider();
}
