import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScriptSegment } from '../../shared/schemas';
import {
  PAUSE_LONG_SEC,
  PAUSE_SHORT_SEC,
  buildPiperCommand,
  computeChapters,
  expectedDuration,
  narrate,
  parseCommand,
  pauseBefore,
  toPiperInput,
  validateMp3,
} from './index';

const FIXTURES = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../fixtures/audio');
const FAKE_PIPER = join(FIXTURES, 'fake-piper.mjs');
const segments = ScriptSegment.array().parse(JSON.parse(readFileSync(join(FIXTURES, 'script.json'), 'utf8')));

const hasFfmpeg =
  spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0 &&
  spawnSync('ffprobe', ['-version'], { stdio: 'ignore' }).status === 0;

/** Duration the fake engine produces for a segment (see fake-piper.mjs). */
const fakeSeconds = (s: ScriptSegment) => Math.max(0.5, Math.round(toPiperInput(s.spokenText).trim().length * 0.05 * 1000) / 1000);

const readCalls = (log: string) =>
  readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { args: string[]; lines: number });

const roots: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'trr-audio-'));
  roots.push(dir);
  return dir;
}
afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('pure helpers', () => {
  it('builds the piper1-gpl CLI invocation with text on stdin', () => {
    const call = buildPiperCommand({
      base: ['python3', '-m', 'piper'],
      voice: 'en_US-lessac-medium',
      voicesDir: '/v',
      output: { file: '/w/a.wav' },
    });
    expect(call.command).toBe('python3');
    expect(call.args.slice(0, 8)).toEqual(['-m', 'piper', '-m', 'en_US-lessac-medium', '--data-dir', '/v', '-f', '/w/a.wav']);
    const batch = buildPiperCommand({ base: ['piper'], voice: 'x', voicesDir: '/v', output: { dir: '/w/out' } });
    expect(batch).toEqual({ command: 'piper', args: expect.arrayContaining(['-d', '/w/out']) });
    expect(batch.args).not.toContain('-f');
  });

  it('parses PIPER_CMD as JSON array or whitespace-separated words', () => {
    expect(parseCommand('node /x/fake.mjs')).toEqual(['node', '/x/fake.mjs']);
    expect(parseCommand('["node","/a b/fake.mjs"]')).toEqual(['node', '/a b/fake.mjs']);
    expect(() => parseCommand('[]')).toThrow();
  });

  it('flattens text to one clean line', () => {
    expect(toPiperInput('  a\nb\u0007  c ')).toBe('a b c\n');
  });

  it('computes chapter starts from durations plus section pauses', () => {
    const durations = segments.map(() => 2);
    const chapters = computeChapters(segments, durations);
    expect(chapters.map((c) => c.id)).toEqual(segments.map((s) => s.id));
    // intro 0; headlines after 2 + short; lead after +2 + long; story +2 + long; why +2 + short; watching +2 + long; closing +2 + long.
    const expected = [0];
    const gaps = [PAUSE_SHORT_SEC, PAUSE_LONG_SEC, PAUSE_LONG_SEC, PAUSE_SHORT_SEC, PAUSE_LONG_SEC, PAUSE_LONG_SEC];
    for (const gap of gaps) expected.push(expected.at(-1)! + 2 + gap);
    chapters.forEach((c, i) => expect(c.startSec).toBeCloseTo(expected[i]!, 6));
    expect(chapters[2]!.storyId).toBe('story-tiny-advisory');
    expect(chapters[0]!.storyId).toBeUndefined();
    expect(chapters[3]!.title).toBe('example/big ships v2.0.0 & drops Node 18');
    expect(expectedDuration(segments, durations)).toBeCloseTo(expected.at(-1)! + 2, 6);
    expect(pauseBefore(segments[0]!, 0)).toBe(0);
  });
});

describe('narrate input checks', () => {
  it('throws for a programmer error (no segments)', async () => {
    await expect(narrate({ segments: [], voice: 'v', workDir: tempDir(), outFile: join(tempDir(), 'a.mp3') })).rejects.toThrow(
      /segment/,
    );
  });
});

describe('narrate when an engine is missing', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('returns available:false when the Piper executable does not exist', async () => {
    vi.stubEnv('PIPER_CMD', '["/nonexistent/piper-binary"]');
    const out = join(tempDir(), 'audio.mp3');
    const info = await narrate({ segments, voice: 'en_US-lessac-medium', workDir: tempDir(), outFile: out });
    expect(info.available).toBe(false);
    expect(info.unavailableReason).toMatch(/piper not found/);
    expect(info.chapters).toEqual([]);
    expect(info.audioSeconds).toBeGreaterThanOrEqual(0);
    expect(existsSync(out)).toBe(false);
  });

  it('returns available:false when the voice model has not been downloaded', async () => {
    vi.stubEnv('PIPER_CMD', '');
    vi.stubEnv('PIPER_VOICES_DIR', tempDir());
    const info = await narrate({ segments, voice: 'en_US-lessac-medium', workDir: tempDir(), outFile: join(tempDir(), 'a.mp3') });
    expect(info.available).toBe(false);
    expect(info.unavailableReason).toMatch(/download_voices/);
  });

  it('returns available:false when ffmpeg is missing', async () => {
    vi.stubEnv('FFMPEG_PATH', '/nonexistent/ffmpeg');
    vi.stubEnv('PIPER_CMD', JSON.stringify(['node', FAKE_PIPER]));
    const info = await narrate({ segments, voice: 'v', workDir: tempDir(), outFile: join(tempDir(), 'a.mp3') });
    expect(info.available).toBe(false);
    expect(info.unavailableReason).toMatch(/ffmpeg not found/);
  });
});

describe.skipIf(!hasFfmpeg)('narrate with a fake Piper (ffmpeg)', () => {
  let log: string;
  beforeEach(() => {
    log = join(tempDir(), 'calls.jsonl');
    vi.stubEnv('PIPER_CMD', JSON.stringify(['node', FAKE_PIPER]));
    vi.stubEnv('FAKE_PIPER_LOG', log);
    vi.stubEnv('PIPER_VOICES_DIR', '/voices');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('produces a valid MP3 with correct, monotonic chapters', async () => {
    const editionDir = join(tempDir(), 'data', 'editions', '2026-11-10-morning');
    const outFile = join(editionDir, 'audio.mp3');
    const info = await narrate({ segments, voice: 'en_US-lessac-medium', workDir: tempDir(), outFile });

    expect(info.unavailableReason).toBeUndefined();
    expect(info.available).toBe(true);
    expect(info.file).toBe('audio.mp3');
    expect(info.voice).toBe('en_US-lessac-medium');
    expect(info.bytes).toBe(readFileSync(outFile).length);
    expect(info.audioSeconds).toBeGreaterThan(0);

    // One batch Piper call, one stdin line per segment, with the expected flags.
    const calls = readCalls(log);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.lines).toBe(segments.length);
    expect(calls[0]!.args).toEqual(expect.arrayContaining(['-m', 'en_US-lessac-medium', '--data-dir', '/voices', '-d']));

    const durations = segments.map(fakeSeconds);
    const expectedChapters = computeChapters(segments, durations);
    expect(info.chapters).toHaveLength(segments.length);
    info.chapters.forEach((chapter, i) => {
      expect(chapter.id).toBe(segments[i]!.id);
      expect(chapter.title).toBe(segments[i]!.title);
      expect(chapter.storyId).toBe(segments[i]!.storyId);
      expect(chapter.startSec).toBeCloseTo(expectedChapters[i]!.startSec, 1);
      if (i > 0) expect(chapter.startSec).toBeGreaterThan(info.chapters[i - 1]!.startSec);
    });

    const total = expectedDuration(segments, durations);
    expect(Math.abs(info.durationSec! - total)).toBeLessThan(0.3);

    const check = await validateMp3(outFile, { durationSec: total });
    expect(check).toMatchObject({ ok: true, codec: 'mp3' });
    expect(check.maxVolumeDb!).toBeGreaterThan(-50);

    // Mono, 44.1 kHz, ~64 kbps, ID3 tags and one ID3 chapter per segment.
    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-show_chapters', '-of', 'json', outFile], {
      encoding: 'utf8',
    });
    const meta = JSON.parse(probe.stdout) as {
      streams: { channels: number; sample_rate: string; bit_rate: string }[];
      format: { tags?: Record<string, string> };
      chapters: { tags?: { title?: string } }[];
    };
    expect(meta.streams[0]!.channels).toBe(1);
    expect(meta.streams[0]!.sample_rate).toBe('44100');
    expect(Number(meta.streams[0]!.bit_rate)).toBe(64000);
    expect(meta.format.tags?.artist).toBe('TheRepoReport');
    expect(meta.format.tags?.album).toBe('TheRepoReport');
    expect(meta.format.tags?.title).toBe('Morning Edition, Nov 10, 2026');
    expect(meta.chapters.map((c) => c.tags?.title)).toEqual(segments.map((s) => s.title));
  }, 60_000);

  it.each([
    ['directory mode is unsupported', 'FAKE_PIPER_NO_DIR', '1', 1],
    ['batch mode is disabled', 'PIPER_BATCH', '0', 0],
  ])('falls back to one Piper call per segment when %s', async (_label, name, value, failedBatchCalls) => {
    vi.stubEnv(name, value);
    const outFile = join(tempDir(), 'a.mp3');
    const info = await narrate({ segments, voice: 'v', workDir: tempDir(), outFile });
    expect(info.available).toBe(true);
    const calls = readCalls(log);
    expect(calls).toHaveLength(failedBatchCalls + segments.length);
    expect(calls.at(-1)!.args).toContain('-f');
    const expected = computeChapters(segments, segments.map(fakeSeconds));
    info.chapters.forEach((c, i) => expect(c.startSec).toBeCloseTo(expected[i]!.startSec, 1));
    expect((await validateMp3(outFile)).ok).toBe(true);
  }, 60_000);

  it('returns available:false when synthesis fails', async () => {
    vi.stubEnv('FAKE_PIPER_MODE', 'fail');
    const info = await narrate({ segments, voice: 'v', workDir: tempDir(), outFile: join(tempDir(), 'a.mp3') });
    expect(info.available).toBe(false);
    expect(info.unavailableReason).toMatch(/piper exited with 1.*simulated/);
  }, 30_000);

  it('rejects silent narration', async () => {
    vi.stubEnv('FAKE_PIPER_MODE', 'silent');
    const outFile = join(tempDir(), 'a.mp3');
    const info = await narrate({ segments, voice: 'v', workDir: tempDir(), outFile });
    expect(info.available).toBe(false);
    expect(info.unavailableReason).toMatch(/silent/);
    expect(existsSync(outFile)).toBe(false);
  }, 60_000);
});

describe.skipIf(!hasFfmpeg)('validateMp3', () => {
  const make = (args: string[], out: string) => {
    const r = spawnSync('ffmpeg', ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', ...args, out]);
    expect(r.status).toBe(0);
    return out;
  };

  it('fails on a silent MP3', async () => {
    const file = make(['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', '3', '-c:a', 'libmp3lame', '-b:a', '64k'], join(tempDir(), 's.mp3'));
    const result = await validateMp3(file);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/silent/);
  });

  it('fails on a non-MP3 file, a too-short file, and a duration mismatch', async () => {
    const wav = make(['-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '3'], join(tempDir(), 't.wav'));
    expect((await validateMp3(wav)).reason).toMatch(/expected mp3/);

    const short = make(['-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '0.5', '-c:a', 'libmp3lame'], join(tempDir(), 'short.mp3'));
    expect((await validateMp3(short)).reason).toMatch(/not over 1 s/);

    const tone = make(['-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '3', '-c:a', 'libmp3lame'], join(tempDir(), 'tone.mp3'));
    expect((await validateMp3(tone)).ok).toBe(true);
    expect((await validateMp3(tone, { durationSec: 30 })).reason).toMatch(/differs from expected/);
  });

  it('fails on a missing or corrupt file', async () => {
    expect((await validateMp3(join(tempDir(), 'nope.mp3'))).ok).toBe(false);
    const junk = join(tempDir(), 'junk.mp3');
    writeFileSync(junk, randomBytes(4096));
    expect((await validateMp3(junk)).ok).toBe(false);
  });
});
