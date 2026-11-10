#!/usr/bin/env node
/**
 * Stand-in for scripts/kokoro_tts.py in tests. Same arguments; reads a JSON
 * array of strings on stdin and writes 000.wav, 001.wav, ... (24 kHz mono tone,
 * 0.05 s per character, minimum 0.5 s) into --out-dir.
 *
 * FAKE_KOKORO_MODE=tone (default) | fail
 * FAKE_KOKORO_LOG=<file> appends one JSON line per call: { voice, segments }.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const valueOf = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const outDir = valueOf('--out-dir');
const voice = valueOf('--voice');
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const texts = JSON.parse(Buffer.concat(chunks).toString('utf8'));
if (process.env.FAKE_KOKORO_LOG) {
  appendFileSync(process.env.FAKE_KOKORO_LOG, JSON.stringify({ voice, segments: texts.length }) + '\n');
}
if (process.env.FAKE_KOKORO_MODE === 'fail') {
  process.stderr.write('fake-kokoro: simulated synthesis failure\n');
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });
texts.forEach((text, i) => {
  const seconds = Math.max(0.5, Math.round(text.length * 0.05 * 1000) / 1000);
  const out = join(outDir, `${String(i).padStart(3, '0')}.wav`);
  const r = spawnSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-f', 'lavfi',
    '-i', 'sine=frequency=330:sample_rate=24000,volume=0.5', '-t', String(seconds), '-ac', '1', '-c:a', 'pcm_s16le', out]);
  if (r.status !== 0) process.exit(1);
});
