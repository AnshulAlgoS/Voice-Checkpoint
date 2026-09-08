export const RIME_DEFAULTS = {
  endpoint: 'https://users.rime.ai/v1/rime-tts',
  model: 'coda',
  voice: 'celeste',
  language: 'en',
  audioFormat: 'mp3',
} as const;

export interface RimeServerConfig {
  apiKey: string | null;
  endpoint: string;
  model: string;
  voice: string;
  language: string;
  audioFormat: string;
  contentType: string;
}

const CONTENT_TYPES: Record<string, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  pcm: 'audio/pcm',
};

export function getRimeServerConfig(
  env: Record<string, string | undefined>,
): RimeServerConfig {
  const audioFormat = (
    env.RIME_AUDIO_FORMAT ?? RIME_DEFAULTS.audioFormat
  ).toLowerCase();
  return {
    apiKey: env.RIME_API_KEY?.trim() || null,
    endpoint: env.RIME_ENDPOINT?.trim() || RIME_DEFAULTS.endpoint,
    model: env.RIME_MODEL?.trim() || RIME_DEFAULTS.model,
    voice: env.RIME_VOICE?.trim() || RIME_DEFAULTS.voice,
    language: env.RIME_LANGUAGE?.trim() || RIME_DEFAULTS.language,
    audioFormat,
    contentType: CONTENT_TYPES[audioFormat] ?? CONTENT_TYPES.mp3!,
  };
}
