import { getRimeServerConfig } from '../../../lib/voice/RimeConfig.ts';

interface SynthesisRequest {
  text?: unknown;
  generation?: unknown;
  checkpointId?: unknown;
}

export async function POST(request: Request) {
  const config = getRimeServerConfig(process.env);
  if (!config.apiKey)
    return Response.json(
      { error: 'Rime is not configured on the server.' },
      { status: 503 },
    );

  let input: SynthesisRequest;
  try {
    input = (await request.json()) as SynthesisRequest;
  } catch {
    return Response.json(
      { error: 'Request body must be valid JSON.' },
      { status: 400 },
    );
  }

  const text = typeof input.text === 'string' ? input.text.trim() : '';
  if (!text || text.length > 500)
    return Response.json(
      { error: 'Text must contain between 1 and 500 characters.' },
      { status: 400 },
    );
  const requestId = crypto.randomUUID();
  const generation =
    typeof input.generation === 'string' ? input.generation : 'unknown';
  console.info('[Rime proxy] request started', {
    requestId,
    generation,
    model: config.model,
    voice: config.voice,
    language: config.language,
    audioFormat: config.audioFormat,
  });

  try {
    const upstream = await fetch(config.endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
        Accept: config.contentType,
      },
      body: JSON.stringify({
        speaker: config.voice,
        text,
        modelId: config.model,
        language: config.language,
      }),
      signal: request.signal,
    });
    if (!upstream.ok) {
      const upstreamRequestId = upstream.headers.get('x-request-id');
      console.error('[Rime proxy] upstream failed', {
        requestId,
        generation,
        status: upstream.status,
        upstreamRequestId,
      });
      return Response.json(
        {
          error: `Rime synthesis failed with status ${upstream.status}.`,
          requestId,
        },
        { status: 502 },
      );
    }
    if (!upstream.body)
      return Response.json(
        { error: 'Rime returned an empty audio stream.', requestId },
        { status: 502 },
      );
    return new Response(upstream.body, {
      status: 200,
      headers: {
        'Content-Type':
          upstream.headers.get('content-type') ?? config.contentType,
        'Cache-Control': 'no-store',
        'X-Voice-Provider': 'Rime',
        'X-Voice-Request-Id': requestId,
        'X-Rime-Model': config.model,
        'X-Rime-Voice': config.voice,
      },
    });
  } catch (cause) {
    if (request.signal.aborted) {
      console.info('[Rime proxy] request cancelled', { requestId, generation });
      return new Response(null, { status: 499 });
    }
    const message = cause instanceof Error ? cause.message : String(cause);
    console.error('[Rime proxy] request failed', {
      requestId,
      generation,
      error: message,
    });
    return Response.json(
      { error: 'Rime synthesis request failed.', requestId },
      { status: 502 },
    );
  }
}
