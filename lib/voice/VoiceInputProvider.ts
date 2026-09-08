export type VoiceConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'failed';
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
  connection?: VoiceConnectionState;
}
export interface VoiceInputListener {
  (event: VoiceInputEvent): void;
}
export interface VoiceInputStatus {
  connected: boolean;
  capturing: boolean;
  lastTranscript: string | null;
  connectionState: VoiceConnectionState;
  error: string | null;
}
export interface VoiceInputProvider {
  readonly kind: 'livekit' | 'mock';
  start(): Promise<void>;
  stop(): Promise<void>;
  pushTranscript(transcript: string): void;
  getStatus(): VoiceInputStatus;
  subscribe(listener: VoiceInputListener): () => void;
}

export interface LiveKitSttOptions {
  livekitUrl?: string;
  roomName?: string;
  participantName?: string;
  tokenEndpoint?: string;
  forceMock?: boolean;
  livekitApiKey?: string;
  livekitApiSecret?: string;
  rimeModel?: string;
  language?: string;
  finalDebounceMs?: number;
}

abstract class EventedInput {
  protected readonly listeners = new Set<VoiceInputListener>();
  subscribe(listener: VoiceInputListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  protected emit(event: VoiceInputEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        /* isolate UI listeners */
      }
    }
  }
}

export class MockVoiceInputProvider
  extends EventedInput
  implements VoiceInputProvider
{
  readonly kind = 'mock' as const;
  private status: VoiceInputStatus = {
    connected: false,
    capturing: false,
    lastTranscript: null,
    connectionState: 'disconnected',
    error: null,
  };
  async start(): Promise<void> {
    this.status = {
      ...this.status,
      connected: true,
      capturing: true,
      connectionState: 'connected',
      error: null,
    };
    this.emit({ type: 'connection', at: Date.now(), connection: 'connected' });
  }
  async stop(): Promise<void> {
    this.status = {
      ...this.status,
      connected: false,
      capturing: false,
      connectionState: 'disconnected',
    };
    this.emit({
      type: 'connection',
      at: Date.now(),
      connection: 'disconnected',
    });
  }
  pushTranscript(transcript: string): void {
    this.publishTranscript(transcript.trim());
  }
  protected publishTranscript(text: string): void {
    if (!text) return;
    const at = Date.now();
    this.emit({ type: 'turn_start', at });
    this.emit({ type: 'vad_start', at });
    this.emit({ type: 'interim_transcript', at, transcript: text });
    this.status = { ...this.status, lastTranscript: text };
    this.emit({ type: 'final_transcript', at, transcript: text });
    this.emit({ type: 'vad_end', at });
    this.emit({ type: 'turn_end', at, message: text });
  }
  getStatus(): VoiceInputStatus {
    return { ...this.status };
  }
}

interface SttDataMessage {
  type?: VoiceInputEventType;
  text?: string;
  transcript?: string;
  final?: boolean;
}

let roomSequence = 0;
function freshRoomName(): string {
  roomSequence += 1;
  return `voice-checkpoint-${Date.now().toString(36)}-${roomSequence.toString(36)}`;
}

export class LiveKitSttProvider
  extends EventedInput
  implements VoiceInputProvider
{
  readonly kind = 'livekit' as const;
  private readonly opts: Required<
    Pick<LiveKitSttOptions, 'roomName' | 'participantName' | 'tokenEndpoint'>
  > &
    Pick<LiveKitSttOptions, 'livekitUrl'>;
  private status: VoiceInputStatus = {
    connected: false,
    capturing: false,
    lastTranscript: null,
    connectionState: 'disconnected',
    error: null,
  };
  private room: import('livekit-client').Room | null = null;
  private cleanup: Array<() => void> = [];
  private readonly completedSegments = new Set<string>();
  private readonly openSegments = new Set<string>();
  private readonly finalDebounceMs: number;
  private pendingFinalParts: string[] = [];
  private pendingFinalTimer: ReturnType<typeof setTimeout> | null = null;
  private turnOpen = false;
  private readonly hasExplicitRoomName: boolean;

  constructor(options: LiveKitSttOptions = {}) {
    super();
    this.hasExplicitRoomName = Boolean(options.roomName);
    this.opts = {
      livekitUrl: options.livekitUrl,
      roomName: options.roomName ?? freshRoomName(),
      participantName: options.participantName ?? `judge-${Date.now()}`,
      tokenEndpoint: options.tokenEndpoint ?? '/api/livekit-token',
    };
    this.finalDebounceMs = options.finalDebounceMs ?? 1_500;
  }
  private refreshGeneratedRoomName(): void {
    if (!this.hasExplicitRoomName) this.opts.roomName = freshRoomName();
  }
  getConfig() {
    return {
      livekitUrl: this.opts.livekitUrl ?? null,
      roomName: this.opts.roomName,
      participantName: this.opts.participantName,
      tokenEndpoint: this.opts.tokenEndpoint,
      hasCredentials: false,
    };
  }
  private setConnection(
    connectionState: VoiceConnectionState,
    error: string | null = null,
  ): void {
    this.status = {
      ...this.status,
      connected: connectionState === 'connected',
      capturing: connectionState === 'connected' && this.status.capturing,
      connectionState,
      error,
    };
    this.emit({
      type: 'connection',
      at: Date.now(),
      connection: connectionState,
      message: error ?? undefined,
    });
  }
  private async fetchConnection(): Promise<{ token: string; url: string }> {
    const endpoint = new URL(
      this.opts.tokenEndpoint,
      typeof window === 'undefined'
        ? 'http://localhost'
        : window.location.origin,
    );
    endpoint.searchParams.set('room', this.opts.roomName);
    endpoint.searchParams.set('participant', this.opts.participantName);
    const response = await fetch(endpoint, {
      headers: { Accept: 'application/json' },
    });
    const payload = (await response.json().catch(() => ({}))) as {
      token?: string;
      url?: string;
      error?: string;
    };
    if (!response.ok)
      throw new Error(
        payload.error ?? `Token endpoint failed with status ${response.status}`,
      );
    const url = this.opts.livekitUrl ?? payload.url;
    if (!payload.token || !url)
      throw new Error(
        'Token endpoint did not return both token and LiveKit URL.',
      );
    return { token: payload.token, url };
  }
  async start(): Promise<void> {
    if (this.room) await this.stop();
    this.refreshGeneratedRoomName();
    this.setConnection('connecting');
    try {
      const [connection, livekit] = await Promise.all([
        this.fetchConnection(),
        import('livekit-client'),
      ]);
      const room = new livekit.Room({ adaptiveStream: true, dynacast: true });
      this.room = room;
      type EventKey = keyof import('livekit-client').RoomEventCallbacks;
      const onData = (payload: Uint8Array) => this.handleData(payload);
      const onDisconnected = () => {
        this.status = { ...this.status, capturing: false };
        this.setConnection('disconnected');
      };
      const onReconnecting = () => {
        this.status = { ...this.status, capturing: false };
        this.setConnection('reconnecting');
      };
      const onReconnected = () => {
        this.status = { ...this.status, capturing: true };
        this.setConnection('connected');
      };
      const onTranscription = (
        segments: Array<{ id?: string; text: string; final?: boolean }>,
      ) => this.handleTranscription(segments);
      room.on(livekit.RoomEvent.DataReceived as EventKey, onData as never);
      room.on(
        livekit.RoomEvent.Disconnected as EventKey,
        onDisconnected as never,
      );
      room.on(
        livekit.RoomEvent.Reconnecting as EventKey,
        onReconnecting as never,
      );
      room.on(
        livekit.RoomEvent.Reconnected as EventKey,
        onReconnected as never,
      );
      room.on(
        livekit.RoomEvent.TranscriptionReceived as EventKey,
        onTranscription as never,
      );
      this.cleanup.push(() => {
        room.off(livekit.RoomEvent.DataReceived as EventKey, onData as never);
        room.off(
          livekit.RoomEvent.Disconnected as EventKey,
          onDisconnected as never,
        );
        room.off(
          livekit.RoomEvent.Reconnecting as EventKey,
          onReconnecting as never,
        );
        room.off(
          livekit.RoomEvent.Reconnected as EventKey,
          onReconnected as never,
        );
        room.off(
          livekit.RoomEvent.TranscriptionReceived as EventKey,
          onTranscription as never,
        );
      });
      await room.connect(connection.url, connection.token);
      await room.localParticipant.setMicrophoneEnabled(true);
      this.status = { ...this.status, capturing: true, error: null };
      this.setConnection('connected');
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      this.disposeRoom();
      this.status = { ...this.status, capturing: false };
      this.setConnection('failed', message);
      this.emit({
        type: 'error',
        at: Date.now(),
        message: `LiveKit connection failed: ${message}`,
      });
      throw new Error(`LiveKit connection failed: ${message}`);
    }
  }
  private handleTranscription(
    segments: Array<{ id?: string; text: string; final?: boolean }>,
  ): void {
    for (const segment of segments) {
      const text = segment.text?.trim();
      if (!text) continue;
      const id = segment.id ?? text;
      if (segment.final) {
        if (this.completedSegments.has(id)) continue;
        this.completedSegments.add(id);
        this.queueFinalSegment(text, id);
      } else {
        const at = Date.now();
        if (!this.openSegments.has(id)) {
          this.openSegments.add(id);
          this.ensureTurnStarted(at);
        }
        this.emit({ type: 'interim_transcript', at, transcript: text });
      }
    }
  }
  private ensureTurnStarted(at: number): void {
    if (this.turnOpen) return;
    this.turnOpen = true;
    this.emit({ type: 'turn_start', at });
    this.emit({ type: 'vad_start', at });
  }
  private queueFinalSegment(text: string, segmentId: string): void {
    const at = Date.now();
    this.ensureTurnStarted(at);
    this.openSegments.delete(segmentId);
    this.pendingFinalParts.push(text);
    if (this.pendingFinalTimer) clearTimeout(this.pendingFinalTimer);
    if (this.finalDebounceMs <= 0) {
      this.flushFinalSegments();
      return;
    }
    this.pendingFinalTimer = setTimeout(
      () => this.flushFinalSegments(),
      this.finalDebounceMs,
    );
  }
  private flushFinalSegments(): void {
    if (this.pendingFinalTimer) clearTimeout(this.pendingFinalTimer);
    this.pendingFinalTimer = null;
    const text = this.pendingFinalParts.join(' ').replace(/\s+/g, ' ').trim();
    this.pendingFinalParts = [];
    if (!text) return;
    const at = Date.now();
    this.status = { ...this.status, lastTranscript: text };
    this.emit({ type: 'final_transcript', at, transcript: text });
    this.emit({ type: 'vad_end', at });
    this.emit({ type: 'turn_end', at, message: text });
    this.turnOpen = false;
  }
  private publishFinal(text: string, segmentId?: string): void {
    const at = Date.now();
    this.ensureTurnStarted(at);
    this.status = { ...this.status, lastTranscript: text };
    this.emit({ type: 'final_transcript', at, transcript: text });
    this.emit({ type: 'vad_end', at });
    this.emit({ type: 'turn_end', at, message: text });
    this.turnOpen = false;
    if (segmentId) this.openSegments.delete(segmentId);
  }
  private handleData(payload: Uint8Array): void {
    try {
      const parsed = JSON.parse(
        new TextDecoder().decode(payload),
      ) as SttDataMessage;
      const text = (parsed.transcript ?? parsed.text ?? '').trim();
      if (parsed.type === 'final_transcript' || parsed.final)
        this.publishFinal(text);
      else if (text)
        this.emit({
          type: 'interim_transcript',
          at: Date.now(),
          transcript: text,
        });
    } catch {
      /* ignore unrelated room data */
    }
  }
  private disposeRoom(): void {
    if (this.pendingFinalTimer) clearTimeout(this.pendingFinalTimer);
    this.pendingFinalTimer = null;
    this.pendingFinalParts = [];
    this.turnOpen = false;
    for (const fn of this.cleanup.splice(0)) {
      try {
        fn();
      } catch {
        /* noop */
      }
    }
    if (this.room) {
      this.room.disconnect();
      this.room = null;
    }
  }
  async stop(): Promise<void> {
    if (this.room) {
      try {
        await this.room.localParticipant.setMicrophoneEnabled(false);
      } catch {
        /* already disconnected */
      }
    }
    this.disposeRoom();
    this.status = {
      ...this.status,
      connected: false,
      capturing: false,
      connectionState: 'disconnected',
    };
    this.emit({
      type: 'connection',
      at: Date.now(),
      connection: 'disconnected',
    });
  }
  pushTranscript(transcript: string): void {
    this.publishFinal(transcript.trim());
  }
  getStatus(): VoiceInputStatus {
    return { ...this.status };
  }
}

export function hasLiveKitCredentials(
  options: LiveKitSttOptions = {},
): boolean {
  if (options.forceMock) return false;
  if (options.livekitUrl) return true;
  return Boolean(
    typeof process !== 'undefined' &&
    process.env?.LIVEKIT_URL &&
    process.env?.LIVEKIT_API_KEY &&
    process.env?.LIVEKIT_API_SECRET,
  );
}
export function createVoiceInputProvider(
  options: LiveKitSttOptions = {},
): VoiceInputProvider {
  return options.forceMock
    ? new MockVoiceInputProvider()
    : new LiveKitSttProvider(options);
}
