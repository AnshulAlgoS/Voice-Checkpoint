"""LiveKit STT-only agent for Voice Checkpoint.

The browser publishes microphone audio to a LiveKit room. This worker subscribes,
transcribes with LiveKit Inference, and publishes transcription events back to the room.
"""

import os

from dotenv import load_dotenv
from livekit.agents import Agent, AgentServer, AgentSession, JobContext, cli, inference

load_dotenv(".env.local")
load_dotenv()

server = AgentServer()


@server.rtc_session(agent_name=os.getenv("LIVEKIT_AGENT_NAME", "voice-checkpoint-transcriber"))
async def transcriber(ctx: JobContext):
    session = AgentSession(
        stt=inference.STT(model=os.getenv("LIVEKIT_STT_MODEL", "deepgram/nova-3-general")),
    )
    await session.start(
        agent=Agent(instructions="Transcribe the user's speech accurately. Do not answer."),
        room=ctx.room,
    )
    await ctx.connect()


if __name__ == "__main__":
    cli.run_app(server)
