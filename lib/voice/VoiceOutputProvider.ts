export interface VoiceOutputHandle {
  id: string;
}
export interface VoiceOutputContext {
  generation: string;
  checkpointId: string | null;
}
export interface VoiceOutputStatus {
  playing: boolean;
  activeHandleId: string | null;
  lastSpoken: string | null;
  error?: string | null;
}
export interface VoiceOutputProvider {
  readonly kind: 'rime' | 'mock';
  speak(text: string, context: VoiceOutputContext): Promise<VoiceOutputHandle>;
  cancel(handleId: string): Promise<void>;
  getStatus(): VoiceOutputStatus;
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
  private readonly spokenLog: Array<{
    id: string;
    text: string;
    context: VoiceOutputContext;
  }> = [];
  private activeHandleId: string | null = null;
  private lastSpoken: string | null = null;
  private nextId = 0;
  private readonly delayMs: number;
  constructor(options: { delayMs?: number } = {}) {
    this.delayMs = options.delayMs ?? 0;
  }
  reserveHandle(): string {
    const id = `mock-${++this.nextId}`;
    this.utterances.set(id, {
      id,
      text: '',
      context: { generation: '', checkpointId: null },
      cancelled: false,
      resolved: false,
      startedAt: Date.now(),
      reserved: true,
    });
    this.activeHandleId = id;
    return id;
  }
  async speak(
    text: string,
    context: VoiceOutputContext,
  ): Promise<VoiceOutputHandle> {
    let entry = [...this.utterances.values()].find(
      (item) => item.reserved && !item.resolved,
    );
    if (entry) {
      entry.reserved = false;
      entry.text = text;
      entry.context = context;
    } else {
      const id = `mock-${++this.nextId}`;
      entry = {
        id,
        text,
        context,
        cancelled: false,
        resolved: false,
        startedAt: Date.now(),
      };
      this.utterances.set(id, entry);
    }
    this.activeHandleId = entry.id;
    if (this.delayMs > 0) {
      const start = Date.now();
      while (Date.now() - start < this.delayMs && !entry.cancelled)
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(5, this.delayMs)),
        );
    }
    entry.resolved = true;
    if (!entry.cancelled) {
      this.spokenLog.push({ id: entry.id, text, context });
      this.lastSpoken = text;
    }
    if (this.activeHandleId === entry.id) this.activeHandleId = null;
    return { id: entry.id };
  }
  async cancel(handleId: string): Promise<void> {
    const entry = this.utterances.get(handleId);
    if (entry && !entry.resolved) entry.cancelled = true;
    if (this.activeHandleId === handleId) this.activeHandleId = null;
  }
  getStatus(): VoiceOutputStatus {
    return {
      playing: this.activeHandleId !== null,
      activeHandleId: this.activeHandleId,
      lastSpoken: this.lastSpoken,
      error: null,
    };
  }
  getSpokenLog() {
    return [...this.spokenLog];
  }
  getCancelledCount(): number {
    return [...this.utterances.values()].filter((item) => item.cancelled)
      .length;
  }
  clearHistory(): void {
    this.utterances.clear();
    this.spokenLog.length = 0;
    this.lastSpoken = null;
    this.activeHandleId = null;
  }
}

export interface RimeProviderOptions {
  endpoint?: string;
  rimeModel?: string;
  rimeVoice?: string;
  language?: string;
  audioFormat?: string;
  forceMock?: boolean;
  mockDelayMs?: number;
  livekitUrl?: string;
  livekitApiKey?: string;
  livekitApiSecret?: string;
  tokenEndpoint?: string;
  roomName?: string;
  participantName?: string;
}
interface ActivePlayback {
  id: string;
  controller: AbortController;
  audio: HTMLAudioElement | null;
  objectUrl: string | null;
  cancelled: boolean;
  reserved: boolean;
}

export class RimeVoiceOutputProvider implements VoiceOutputProvider {
  readonly kind = 'rime' as const;
  private readonly endpoint: string;
  private readonly config: {
    model: string;
    voice: string;
    language: string;
    audioFormat: string;
  };
  private nextId = 0;
  private activeHandleId: string | null = null;
  private lastSpoken: string | null = null;
  private error: string | null = null;
  private readonly playbacks = new Map<string, ActivePlayback>();
  constructor(options: RimeProviderOptions = {}) {
    this.endpoint = options.endpoint ?? '/api/rime-tts';
    this.config = {
      model: options.rimeModel ?? 'coda',
      voice: options.rimeVoice ?? 'celeste',
      language: options.language ?? 'en',
      audioFormat: options.audioFormat ?? 'mp3',
    };
  }
  getConfig() {
    return {
      ...this.config,
      endpoint: this.endpoint,
      livekitUrl: null,
      hasCredentials: false,
    };
  }
  reserveHandle(): string {
    const id = `rime-${++this.nextId}`;
    this.playbacks.set(id, {
      id,
      controller: new AbortController(),
      audio: null,
      objectUrl: null,
      cancelled: false,
      reserved: true,
    });
    this.activeHandleId = id;
    return id;
  }
  private takePlayback(): ActivePlayback {
    const reserved = [...this.playbacks.values()].find(
      (item) => item.reserved && !item.cancelled,
    );
    if (reserved) {
      reserved.reserved = false;
      return reserved;
    }
    const id = `rime-${++this.nextId}`;
    const playback: ActivePlayback = {
      id,
      controller: new AbortController(),
      audio: null,
      objectUrl: null,
      cancelled: false,
      reserved: false,
    };
    this.playbacks.set(id, playback);
    return playback;
  }
  async speak(
    text: string,
    context: VoiceOutputContext,
  ): Promise<VoiceOutputHandle> {
    const playback = this.takePlayback();
    const { id } = playback;
    this.activeHandleId = id;
    this.error = null;
    console.info('[Rime] request started', {
      requestId: id,
      generation: context.generation,
      model: this.config.model,
      voice: this.config.voice,
    });
    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'audio/mpeg, audio/wav;q=0.9',
        },
        body: JSON.stringify({
          text,
          generation: context.generation,
          checkpointId: context.checkpointId,
        }),
        signal: playback.controller.signal,
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(
          payload.error ?? `Rime request failed with status ${response.status}`,
        );
      }
      if (playback.cancelled) {
        console.info('[Rime] stale response discarded', {
          requestId: id,
          generation: context.generation,
        });
        return { id };
      }
      if (typeof Audio === 'undefined' || typeof URL === 'undefined')
        throw new Error('Audio playback requires a browser.');
      const blob = await response.blob();
      if (playback.cancelled) {
        console.info('[Rime] stale response discarded', {
          requestId: id,
          generation: context.generation,
        });
        return { id };
      }
      playback.objectUrl = URL.createObjectURL(blob);
      playback.audio = new Audio(playback.objectUrl);
      playback.audio.preload = 'auto';
      console.info('[Rime] playback started', {
        requestId: id,
        generation: context.generation,
      });
      await new Promise<void>((resolve, reject) => {
        const audio = playback.audio!;
        audio.onended = () => resolve();
        audio.onerror = () =>
          reject(
            new Error('The browser could not play the Rime audio response.'),
          );
        audio.play().catch(reject);
      });
      if (!playback.cancelled) this.lastSpoken = text;
    } catch (cause) {
      if (
        playback.cancelled ||
        (cause instanceof DOMException && cause.name === 'AbortError')
      )
        console.info('[Rime] playback stopped', {
          requestId: id,
          generation: context.generation,
          reason: 'cancelled',
        });
      else {
        this.error = cause instanceof Error ? cause.message : String(cause);
        console.error('[Rime] request failed', {
          requestId: id,
          generation: context.generation,
          error: this.error,
        });
        throw cause;
      }
    } finally {
      this.release(playback);
    }
    return { id };
  }
  private release(playback: ActivePlayback): void {
    if (playback.audio) {
      playback.audio.pause();
      playback.audio.removeAttribute('src');
      playback.audio.load();
      playback.audio = null;
    }
    if (playback.objectUrl && typeof URL !== 'undefined') {
      URL.revokeObjectURL(playback.objectUrl);
      playback.objectUrl = null;
    }
    if (this.activeHandleId === playback.id) this.activeHandleId = null;
    this.playbacks.delete(playback.id);
  }
  async cancel(handleId: string): Promise<void> {
    const playback = this.playbacks.get(handleId);
    if (!playback) return;
    playback.cancelled = true;
    playback.controller.abort();
    if (playback.audio) playback.audio.pause();
    console.info('[Rime] cancellation', { requestId: handleId });
    this.release(playback);
  }
  getStatus(): VoiceOutputStatus {
    return {
      playing: this.activeHandleId !== null,
      activeHandleId: this.activeHandleId,
      lastSpoken: this.lastSpoken,
      error: this.error,
    };
  }
}

export function hasRimeCredentials(options: RimeProviderOptions = {}): boolean {
  if (options.forceMock) return false;
  if (options.endpoint) return true;
  return Boolean(typeof process !== 'undefined' && process.env?.RIME_API_KEY);
}
export function createVoiceOutputProvider(
  options: RimeProviderOptions = {},
): VoiceOutputProvider {
  if (options.forceMock)
    return new MockVoiceOutputProvider({ delayMs: options.mockDelayMs });
  return new RimeVoiceOutputProvider(options);
}
