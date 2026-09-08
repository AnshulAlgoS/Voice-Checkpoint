import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = join(root, '.env.local');
const python = existsSync(join(root, '.venv', 'bin', 'python'))
  ? join(root, '.venv', 'bin', 'python')
  : 'python3';

if (Number(process.versions.node.split('.')[0]) < 22) {
  console.error('Voice Checkpoint requires Node.js 22.13 or newer.');
  process.exit(1);
}

if (!existsSync(envPath)) {
  console.error('Missing .env.local. Copy .env.example and add your credentials.');
  process.exit(1);
}

const configured = new Map(
  readFileSync(envPath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && line.includes('='))
    .map((line) => {
      const separator = line.indexOf('=');
      return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
    }),
);
const required = [
  'RIME_API_KEY',
  'LIVEKIT_URL',
  'LIVEKIT_API_KEY',
  'LIVEKIT_API_SECRET',
];
const missing = required.filter((key) => !configured.get(key));
if (missing.length) {
  console.error(`Missing values in .env.local: ${missing.join(', ')}`);
  process.exit(1);
}

const pythonCheck = spawnSync(
  python,
  ['-c', 'import dotenv; import livekit.agents'],
  { cwd: root, encoding: 'utf8' },
);
if (pythonCheck.status !== 0) {
  console.error(
    'Python voice packages are missing. Run: python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements-voice.txt',
  );
  process.exit(1);
}

console.log('Starting Voice Checkpoint web app and LiveKit transcription worker…');
console.log('Open http://localhost:3000, click Enable microphone, and speak.');

const children = [
  spawn(python, ['voice_agent.py', 'dev'], {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
  }),
  spawn(process.execPath, ['node_modules/vinext/dist/cli.js', 'dev'], {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
  }),
];

let stopping = false;
function stop(signal = 'SIGTERM') {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.killed) child.kill(signal);
  }
}

process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));

for (const child of children) {
  child.on('error', (error) => {
    console.error(error.message);
    process.exitCode = 1;
    stop();
  });
  child.on('exit', (code, signal) => {
    if (!stopping) {
      console.error(
        `A development process stopped unexpectedly (${signal ?? `exit ${code ?? 1}`}).`,
      );
      process.exitCode = code ?? 1;
      stop();
    }
  });
}
