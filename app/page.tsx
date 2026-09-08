import { VoiceCheckpoint } from './voice-checkpoint';
import { VoiceDebug } from './voice-debug';

export default function Home() {
  return (
    <div className="flex flex-col gap-4">
      <VoiceCheckpoint />
      <VoiceDebug />
    </div>
  );
}
