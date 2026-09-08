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
}

function readEnv(key: string): string | undefined {
  try {
    const v = (globalThis as unknown as { process?: { env?: Record<string, string> } }).process?.env?.[key];
    return v && v.length ? v : undefined;
  } catch {
    return undefined;
  }
}

export function hasLiveKitCredentials(options: LiveKitSttOptions = {}): boolean {
  const url = options.livekitUrl ?? readEnv('LIVEKIT_URL');
  const key = options.livekitApiKey ?? readEnv('LIVEKIT_API_KEY');
  const secret = options.livekitApiSecret ?? readEnv('LIVEKIT_API_SECRET');
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
  };

  private readonly listeners = new Set<VoiceInputListener>();
  private connected = false;
  private capturing = false;
  private lastTranscript: string | null = null;

  constructor(options: LiveKitSttOptions = {}) {
    this.opts = {
      livekitUrl: options.livekitUrl ?? readEnv('LIVEKIT_URL') ?? null,
      livekitApiKey: options.livekitApiKey ?? readEnv('LIVEKIT_API_KEY') ?? null,
      livekitApiSecret: options.livekitApiSecret ?? readEnv('LIVEKIT_API_SECRET') ?? null,
      rimeModel: options.rimeModel ?? readEnv('RIME_MODEL') ?? 'rime-1',
      language: options.language ?? readEnv('RIME_LANGUAGE') ?? 'en-IN',
      roomName: options.roomName ?? 'voice-checkpoint',
      participantName: options.participantName ?? 'judge',
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

  async start(): Promise<void> {
    if (!this.opts.livekitUrl || !this.opts.livekitApiKey || !this.opts.livekitApiSecret) {
      const at = Date.now();
      this.emit({ type: 'error', at, message: 'LiveKitSttProvider: LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET must be configured.' });
      throw new Error(
        'LiveKitSttProvider: LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET must be configured.',
      );
    }
    this.emit({ type: 'connection', at: Date.now(), connection: 'connecting' });
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
