#!/usr/bin/env node
/**
 * Stand-in for `python3 -m piper` in tests. Accepts the same arguments
 * (-m VOICE --data-dir DIR and either -f OUT.wav or -d OUT_DIR), reads text from
 * stdin, and writes real 22.05 kHz mono 16-bit WAVs whose length is proportional
 * to the text: 0.05 s per character, minimum 0.5 s.
 *
 * -f: all text into one WAV. -d: one WAV per non-empty line, named by a
 * monotonic nanosecond clock, like piper1-gpl's default --output-dir naming.
 *
 * FAKE_PIPER_MODE=tone (default) | silent | fail
 * FAKE_PIPER_NO_DIR=1   reject -d (simulates a CLI without directory mode)
 * FAKE_PIPER_LOG=<file> appends one JSON line per call: { args, lines, chars }.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const valueOf = (...names) => {
  const i = args.findIndex((a) => names.includes(a));
  return i >= 0 ? args[i + 1] : undefined;
};
const outFile = valueOf('-f', '--output-file', '--output_file');
const outDir = valueOf('-d', '--output-dir', '--output_dir');
if (!outFile && !outDir) {
  process.stderr.write('fake-piper: -f OUTPUT_FILE or -d OUTPUT_DIR is required\n');
  process.exit(2);
}

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const lines = Buffer.concat(chunks)
  .toString('utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter(Boolean);
const mode = process.env.FAKE_PIPER_MODE ?? 'tone';

if (process.env.FAKE_PIPER_LOG) {
  appendFileSync(
    process.env.FAKE_PIPER_LOG,
    JSON.stringify({ args, lines: lines.length, chars: lines.join(' ').length }) + '\n',
  );
}
if (mode === 'fail') {
  process.stderr.write('fake-piper: simulated synthesis failure\n');
  process.exit(1);
}
if (outDir && process.env.FAKE_PIPER_NO_DIR === '1') {
  process.stderr.write('fake-piper: unrecognized arguments: -d\n');
  process.exit(2);
}

function writeWav(text, path) {
  const seconds = Math.max(0.5, Math.round(text.length * 0.05 * 1000) / 1000);
  const source = mode === 'silent' ? 'anullsrc=r=22050:cl=mono' : 'sine=frequency=440:sample_rate=22050,volume=0.5';
  const result = spawnSync(
    process.env.FFMPEG_PATH || 'ffmpeg',
    ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', source, '-t', String(seconds),
      '-ac', '1', '-ar', '22050', '-c:a', 'pcm_s16le', path],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (outFile) {
  writeWav(lines.join(' '), outFile);
} else {
  for (const line of lines) writeWav(line, join(outDir, `${process.hrtime.bigint()}.wav`));
}
