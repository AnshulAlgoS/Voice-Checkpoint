import { AccessToken } from 'livekit-server-sdk';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const roomName = url.searchParams.get('room') ?? 'voice-checkpoint';
  const participantName = url.searchParams.get('participant') ?? `user-${Date.now()}`;

  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;

  if (!apiKey || !apiSecret) {
    return Response.json(
      { error: 'LiveKit credentials not configured on the server.' },
      { status: 503 },
    );
  }

  try {
    const at = new AccessToken(apiKey, apiSecret, {
      identity: participantName,
      name: participantName,
      ttl: '1h',
    });
    at.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });
    const token = await at.toJwt();
    return Response.json({ token });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json(
      { error: `Failed to generate LiveKit token: ${message}` },
      { status: 500 },
    );
  }
}
