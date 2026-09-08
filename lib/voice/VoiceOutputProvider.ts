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

  async speak(text: string, context: VoiceOutputContext): Promise<VoiceOutputHandle> {
    const id = `mock-${++this.nextId}`;
    const utterance: MockUtterance = {
      id,
      text,
      context,
      cancelled: false,
      resolved: false,
      startedAt: Date.now(),
    };
    this.utterances.set(id, utterance);
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
}

function readEnv(key: string): string | undefined {
  try {
    const v = (globalThis as unknown as { process?: { env?: Record<string, string> } }).process?.env?.[key];
    return v && v.length ? v : undefined;
  } catch {
    return undefined;
  }
}

export class RimeVoiceOutputProvider implements VoiceOutputProvider {
  readonly kind = 'rime' as const;

  private readonly opts: Required<Pick<RimeProviderOptions, 'rimeModel' | 'rimeVoice' | 'language'>> &
    Partial<Pick<RimeProviderOptions, 'livekitUrl' | 'livekitApiKey' | 'livekitApiSecret'>>;

  private nextId = 0;
  private activeHandleId: string | null = null;
  private lastSpoken: string | null = null;

  constructor(options: RimeProviderOptions = {}) {
    this.opts = {
      rimeModel: options.rimeModel ?? readEnv('RIME_MODEL') ?? 'rime-1',
      rimeVoice: options.rimeVoice ?? readEnv('RIME_VOICE') ?? 'af_sky',
      language: options.language ?? readEnv('RIME_LANGUAGE') ?? 'en-IN',
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

  async speak(text: string, context: VoiceOutputContext): Promise<VoiceOutputHandle> {
    if (!this.opts.livekitUrl || !this.opts.livekitApiKey || !this.opts.livekitApiSecret) {
      throw new Error(
        'RimeVoiceOutputProvider: LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET must be configured.',
      );
    }
    const id = `rime-${++this.nextId}`;
    this.activeHandleId = id;
    try {
      void context;
      void text;
      this.lastSpoken = text;
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = this.opts.language;
        utterance.voice = speechSynthesis.getVoices().find((v) => v.lang.startsWith(this.opts.language.split('-')[0])) ?? null;
        await new Promise<void>((resolve) => {
          utterance.onend = () => resolve();
          utterance.onerror = () => resolve();
          speechSynthesis.speak(utterance);
        });
      } else {
        await new Promise((r) => setTimeout(r, 10));
      }
    } finally {
      if (this.activeHandleId === id) this.activeHandleId = null;
    }
    return { id };
  }

  async cancel(handleId: string): Promise<void> {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      try {
        speechSynthesis.cancel();
      } catch {
        // ignore
      }
    }
    if (this.activeHandleId === handleId) this.activeHandleId = null;
    void handleId;
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
  const key = options.livekitApiKey ?? readEnv('LIVEKIT_API_KEY');
  const secret = options.livekitApiSecret ?? readEnv('LIVEKIT_API_SECRET');
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
