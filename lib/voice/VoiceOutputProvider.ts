import type {
  Room,
  RemoteAudioTrack,
  RemoteParticipant,
  RemoteTrack,
  RemoteTrackPublication,
} from 'livekit-client';

export interface VoiceOutputHandle {
  id: string;
}

export interface VoiceOutputContext {
  generation: string;
  checkpointId: string | null;
}

export interface VoiceOutputProvider {
  readonly kind: 'rime' | 'mock';
  speak(text: string, context: VoiceOutputContext): Promise<VoiceOutputHandle>;
  cancel(handleId: string): Promise<void>;
  getStatus(): VoiceOutputStatus;
}

export interface VoiceOutputStatus {
  playing: boolean;
  activeHandleId: string | null;
  lastSpoken: string | null;
}

interface MockUtterance {
  id: string;
  text: string;
  context: VoiceOutputContext;
  cancelled: boolean;
  resolved: boolean;
  startedAt: number;
  reserved?: boolean;
}

export class MockVoiceOutputProvider implements VoiceOutputProvider {
  readonly kind = 'mock' as const;

  private readonly utterances = new Map<string, MockUtterance>();
  private readonly spokenLog: Array<{ id: string; text: string; context: VoiceOutputContext }> = [];
  private activeHandleId: string | null = null;
  private lastSpoken: string | null = null;
  private nextId = 0;
  private readonly delayMs: number;

  constructor(options: { delayMs?: number } = {}) {
    this.delayMs = options.delayMs ?? 0;
  }

  reserveHandle(): string {
    const id = `mock-${++this.nextId}`;
    const utterance: MockUtterance = {
      id,
      text: '',
      context: { generation: '', checkpointId: null },
      cancelled: false,
      resolved: false,
      startedAt: Date.now(),
      reserved: true,
    };
    this.utterances.set(id, utterance);
    this.activeHandleId = id;
    return id;
  }

  async speak(text: string, context: VoiceOutputContext): Promise<VoiceOutputHandle> {
    let id: string | null = null;
    let utterance: MockUtterance | null = null;
    for (const [key, u] of this.utterances) {
      if (u.reserved && !u.resolved) {
        id = key;
        utterance = u;
        utterance.reserved = false;
        utterance.text = text;
        utterance.context = context;
        break;
      }
    }
    if (!id || !utterance) {
      id = `mock-${++this.nextId}`;
      utterance = {
        id,
        text,
        context,
        cancelled: false,
        resolved: false,
        startedAt: Date.now(),
      };
      this.utterances.set(id, utterance);
    }
    this.activeHandleId = id;

    if (this.delayMs > 0) {
      const start = Date.now();
      while (Date.now() - start < this.delayMs) {
        if (utterance.cancelled) break;
        await new Promise((r) => setTimeout(r, Math.min(5, this.delayMs)));
      }
    }

    if (utterance.cancelled) {
      utterance.resolved = true;
      if (this.activeHandleId === id) this.activeHandleId = null;
      return { id };
    }

    utterance.resolved = true;
    this.spokenLog.push({ id, text, context });
    this.lastSpoken = text;
    if (this.activeHandleId === id) this.activeHandleId = null;
    return { id };
  }

  async cancel(handleId: string): Promise<void> {
    const utterance = this.utterances.get(handleId);
    if (utterance && !utterance.resolved) {
      utterance.cancelled = true;
    }
    if (this.activeHandleId === handleId) this.activeHandleId = null;
  }

  getStatus(): VoiceOutputStatus {
    return {
      playing: this.activeHandleId !== null,
      activeHandleId: this.activeHandleId,
      lastSpoken: this.lastSpoken,
    };
  }

  getSpokenLog(): ReadonlyArray<{ id: string; text: string; context: VoiceOutputContext }> {
    return [...this.spokenLog];
  }

  getCancelledCount(): number {
    let count = 0;
    for (const u of this.utterances.values()) if (u.cancelled) count += 1;
    return count;
  }

  clearHistory(): void {
    this.utterances.clear();
    this.spokenLog.length = 0;
    this.lastSpoken = null;
    this.activeHandleId = null;
  }
}

export interface RimeProviderOptions {
  livekitUrl?: string;
  livekitApiKey?: string;
  livekitApiSecret?: string;
  rimeModel?: string;
  rimeVoice?: string;
  language?: string;
  tokenEndpoint?: string;
  roomName?: string;
  participantName?: string;
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

interface ActiveRimePlayback {
  id: string;
  audioElement: HTMLAudioElement | null;
  mediaSource: MediaSource | null;
  room: Room | null;
  roomCleanup: Array<() => void>;
  cancelled: boolean;
  attachedTrack: RemoteAudioTrack | null;
}

export class RimeVoiceOutputProvider implements VoiceOutputProvider {
  readonly kind = 'rime' as const;

  private readonly opts: Required<Pick<RimeProviderOptions, 'rimeModel' | 'rimeVoice' | 'language' | 'tokenEndpoint' | 'roomName' | 'participantName'>> &
    Partial<Pick<RimeProviderOptions, 'livekitUrl' | 'livekitApiKey' | 'livekitApiSecret'>>;

  private nextId = 0;
  private activeHandleId: string | null = null;
  private lastSpoken: string | null = null;
  private readonly playback = new Map<string, ActiveRimePlayback>();

  constructor(options: RimeProviderOptions = {}) {
    this.opts = {
      rimeModel: options.rimeModel ?? readEnv('RIME_MODEL') ?? 'rime-1',
      rimeVoice: options.rimeVoice ?? readEnv('RIME_VOICE') ?? 'af_sky',
      language: options.language ?? readEnv('RIME_LANGUAGE') ?? 'en-IN',
      tokenEndpoint: options.tokenEndpoint ?? '/api/livekit-token',
      roomName: options.roomName ?? 'voice-checkpoint',
      participantName: options.participantName ?? `tts-listener-${Date.now()}`,
      livekitUrl: options.livekitUrl ?? readEnv('LIVEKIT_URL'),
      livekitApiKey: options.livekitApiKey ?? readEnv('LIVEKIT_API_KEY'),
      livekitApiSecret: options.livekitApiSecret ?? readEnv('LIVEKIT_API_SECRET'),
    };
  }

  getConfig() {
    return {
      model: this.opts.rimeModel,
      voice: this.opts.rimeVoice,
      language: this.opts.language,
      livekitUrl: this.opts.livekitUrl ?? null,
      hasCredentials: Boolean(this.opts.livekitApiKey && this.opts.livekitApiSecret && this.opts.livekitUrl),
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

  private async tryBrowserTts(text: string, handle: ActiveRimePlayback): Promise<void> {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
      await new Promise((r) => setTimeout(r, 10));
      return;
    }
    return new Promise<void>((resolve) => {
      try {
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = this.opts.language;
        const voices = speechSynthesis.getVoices();
        const preferredVoice =
          voices.find((v) => v.lang === this.opts.language) ??
          voices.find((v) => v.lang.startsWith(this.opts.language.split('-')[0])) ??
          null;
        if (preferredVoice) utterance.voice = preferredVoice;
        const finish = () => {
          try { utterance.onend = null; } catch { /* noop */ }
          try { utterance.onerror = null; } catch { /* noop */ }
          resolve();
        };
        utterance.onend = finish;
        utterance.onerror = finish;
        const startPoll = () => {
          if (handle.cancelled) {
            try { speechSynthesis.cancel(); } catch { /* noop */ }
            finish();
            return;
          }
          if (!handle.cancelled && speechSynthesis.speaking) {
            setTimeout(startPoll, 40);
          }
        };
        utterance.onstart = () => startPoll();
        speechSynthesis.speak(utterance);
        const failSafe = setTimeout(() => {
          if (!handle.cancelled) finish();
        }, Math.max(3000, text.length * 80));
        const cleanupOnCancel = () => {
          clearTimeout(failSafe);
        };
        handle.roomCleanup.push(cleanupOnCancel);
      } catch {
        resolve();
      }
    });
  }

  private cleanupPlayback(handleId: string): void {
    const pb = this.playback.get(handleId);
    if (!pb) return;
    pb.cancelled = true;
    for (const fn of pb.roomCleanup) { try { fn(); } catch { /* noop */ } }
    pb.roomCleanup = [];
    if (pb.attachedTrack) {
      try { pb.attachedTrack.detach(); } catch { /* noop */ }
      pb.attachedTrack = null;
    }
    if (pb.audioElement) {
      try { pb.audioElement.pause(); } catch { /* noop */ }
      try { pb.audioElement.removeAttribute('src'); } catch { /* noop */ }
      try { pb.audioElement.load(); } catch { /* noop */ }
      pb.audioElement = null;
    }
    if (pb.mediaSource) {
      try {
        if (pb.mediaSource.readyState === 'open') pb.mediaSource.endOfStream();
      } catch { /* noop */ }
      pb.mediaSource = null;
    }
    if (pb.room) {
      try { pb.room.disconnect(); } catch { /* noop */ }
      pb.room = null;
    }
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      try { speechSynthesis.cancel(); } catch { /* noop */ }
    }
  }

  async speak(text: string, context: VoiceOutputContext): Promise<VoiceOutputHandle> {
    if (!this.opts.livekitUrl || !this.opts.livekitApiKey || !this.opts.livekitApiSecret) {
      throw new Error(
        'RimeVoiceOutputProvider: LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET must be configured.',
      );
    }
    const id = `rime-${++this.nextId}`;
    const pb: ActiveRimePlayback = {
      id,
      audioElement: null,
      mediaSource: null,
      room: null,
      roomCleanup: [],
      cancelled: false,
      attachedTrack: null,
    };
    this.playback.set(id, pb);
    this.activeHandleId = id;
    try {
      void context;
      this.lastSpoken = text;

      const hasLiveKitEnv = Boolean(this.opts.livekitUrl && typeof window !== 'undefined');
      if (hasLiveKitEnv) {
        let RoomCtor: typeof Room | null = null;
        let RoomEventCtor: typeof import('livekit-client').RoomEvent | null = null;
        let TrackKind: typeof import('livekit-client').Track | null = null;
        try {
          const lk = await import('livekit-client');
          RoomCtor = lk.Room;
          RoomEventCtor = lk.RoomEvent;
          TrackKind = lk.Track;
        } catch {
          RoomCtor = null;
        }

        if (RoomCtor && RoomEventCtor && TrackKind) {
          let token: string | null = null;
          try {
            token = await this.fetchToken();
          } catch {
            token = null;
          }

          if (token && this.opts.livekitUrl && !pb.cancelled) {
            const room = new RoomCtor({
              adaptiveStream: true,
              dynacast: true,
            });
            pb.room = room;

            let audioEl: HTMLAudioElement | null = null;
            if (typeof document !== 'undefined') {
              try {
                audioEl = document.createElement('audio');
                audioEl.autoplay = true;
                audioEl.setAttribute('playsinline', 'true');
                audioEl.setAttribute('preload', 'auto');
                pb.audioElement = audioEl;
              } catch { /* noop */ }
            }

            const onTrackSubscribed = (
              track: RemoteTrack,
              _pub: RemoteTrackPublication,
              _participant: RemoteParticipant,
            ) => {
              if (pb.cancelled) return;
              if (track.kind === TrackKind!.Kind.Audio && audioEl) {
                try {
                  const remoteAudio = track as RemoteAudioTrack;
                  remoteAudio.attach(audioEl);
                  pb.attachedTrack = remoteAudio;
                } catch { /* noop */ }
              }
            };
            const onDisconnect = () => {
              /* disconnection is handled via cancel / cleanup */
            };
            type RoomEventKey = keyof import('livekit-client').RoomEventCallbacks;
            room.on(RoomEventCtor.TrackSubscribed as RoomEventKey, onTrackSubscribed as never);
            room.on(RoomEventCtor.Disconnected as RoomEventKey, onDisconnect as never);
            pb.roomCleanup.push(() => {
              try { room.off(RoomEventCtor!.TrackSubscribed as RoomEventKey, onTrackSubscribed as never); } catch { /* noop */ }
              try { room.off(RoomEventCtor!.Disconnected as RoomEventKey, onDisconnect as never); } catch { /* noop */ }
            });

            try {
              await room.connect(this.opts.livekitUrl, token);
            } catch {
              /* room connect failure — fall through to browser TTS fallback */
              this.cleanupPlayback(id);
              pb.cancelled = false;
            }

            if (pb.room && !pb.cancelled) {
              await new Promise<void>((resolve) => {
                const timeoutMs = Math.max(6000, text.length * 80);
                const timeout = setTimeout(() => resolve(), timeoutMs);
                const pollInterval = setInterval(() => {
                  if (pb.cancelled) {
                    clearInterval(pollInterval);
                    clearTimeout(timeout);
                    resolve();
                  }
                }, 50);
                pb.roomCleanup.push(() => {
                  clearInterval(pollInterval);
                  clearTimeout(timeout);
                });
              });
            }
          }
        }
      }

      if (!pb.cancelled) {
        await this.tryBrowserTts(text, pb);
      }
    } finally {
      if (this.activeHandleId === id) this.activeHandleId = null;
      this.cleanupPlayback(id);
    }
    return { id };
  }

  async cancel(handleId: string): Promise<void> {
    const pb = this.playback.get(handleId);
    if (pb) {
      this.cleanupPlayback(handleId);
    }
    if (this.activeHandleId === handleId) this.activeHandleId = null;
  }

  getStatus(): VoiceOutputStatus {
    return {
      playing: this.activeHandleId !== null,
      activeHandleId: this.activeHandleId,
      lastSpoken: this.lastSpoken,
    };
  }
}

export function hasRimeCredentials(options: RimeProviderOptions = {}): boolean {
  const url = options.livekitUrl ?? readEnv('LIVEKIT_URL');
  if (!url) return false;
  const key = options.livekitApiKey ?? readEnv('LIVEKIT_API_KEY');
  const secret = options.livekitApiSecret ?? readEnv('LIVEKIT_API_SECRET');
  if (isBrowserRuntime()) {
    return Boolean(url) || Boolean(key && secret);
  }
  return Boolean(url && key && secret);
}

export function createVoiceOutputProvider(
  options: RimeProviderOptions & { forceMock?: boolean; mockDelayMs?: number } = {},
): VoiceOutputProvider {
  if (options.forceMock) return new MockVoiceOutputProvider({ delayMs: options.mockDelayMs });
  if (hasRimeCredentials(options)) {
    try {
      return new RimeVoiceOutputProvider(options);
    } catch {
      return new MockVoiceOutputProvider({ delayMs: options.mockDelayMs });
    }
  }
  return new MockVoiceOutputProvider({ delayMs: options.mockDelayMs });
}
