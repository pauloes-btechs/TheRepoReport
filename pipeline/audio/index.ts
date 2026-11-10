/**
 * Narration: Piper speaks each script segment to its own WAV (all segments in one
 * Piper process when possible, else one process per segment), FFmpeg joins them with
 * short pauses, loudness-normalizes, and encodes a mono MP3 with ID3 chapters.
 *
 * Piper (GPL-3.0) and FFmpeg are invoked as separate programs; nothing is linked.
 * A missing or failing engine never throws: the edition is published without
 * downloadable audio and the site falls back to browser speech synthesis.
 */
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { Logger, Narrate, NarrateOptions } from '../../shared/contracts';
import { EDITION_TITLES, parseEditionKey } from '../../shared/edition';
import type { Chapter, ScriptSegment } from '../../shared/schemas';
import { formatEditionDate } from '../feed/dates';
import { describeFailure, run } from './exec';

// ───────────────────────── Tunables ─────────────────────────

/** Pause inserted before a segment that opens a new section of the broadcast. */
export const PAUSE_LONG_SEC = 1.0;
/** Pause inserted before every other segment. */
export const PAUSE_SHORT_SEC = 0.6;
const LONG_PAUSE_KINDS: ReadonlySet<ScriptSegment['kind']> = new Set(['lead', 'story', 'watching', 'closing']);

/** Seconds of silence Piper inserts between sentences inside a segment. */
export const SENTENCE_SILENCE_SEC = 0.25;
export const MP3_BITRATE = '64k';
export const MP3_SAMPLE_RATE = 44_100;
/** Rate all segments are brought to before concatenation (Piper "medium" voices are 22.05 kHz). */
const MIX_SAMPLE_RATE = 22_050;
export const ID3_ARTIST = 'TheRepoReport';
export const ID3_ALBUM = 'TheRepoReport';
/** A decoded peak below this is treated as silence. */
export const SILENCE_THRESHOLD_DB = -50;

const DEFAULT_PIPER = ['python3', '-m', 'piper'];
const DEFAULT_VOICES_DIR = './.work/voices';

const TIMEOUT_PROBE_MS = 30_000;
const TIMEOUT_ENCODE_MS = 15 * 60_000;
/** Model load plus generous per-character synthesis time on a slow CPU. */
const piperTimeoutMs = (chars: number) => Math.min(30 * 60_000, 120_000 + chars * 200);

// ───────────────────────── Tool resolution ─────────────────────────

interface Tools {
  ffmpeg: string;
  ffprobe: string;
  /** argv prefix for Piper, e.g. ["python3", "-m", "piper"]. */
  piper: string[];
  piperOverridden: boolean;
  voicesDir: string;
}

/** PIPER_CMD may be a JSON array (`["node","/path with space/x.mjs"]`) or a whitespace-separated command. */
export function parseCommand(value: string): string[] {
  const trimmed = value.trim();
  if (trimmed.startsWith('[')) {
    const parsed: unknown = JSON.parse(trimmed);
    if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every((p) => typeof p === 'string')) {
      throw new Error('PIPER_CMD JSON must be a non-empty array of strings');
    }
    return parsed as string[];
  }
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length === 0) throw new Error('PIPER_CMD is empty');
  return parts;
}

function resolveTools(env: NodeJS.ProcessEnv = process.env): Tools {
  const override = env.PIPER_CMD?.trim();
  return {
    ffmpeg: env.FFMPEG_PATH?.trim() || 'ffmpeg',
    ffprobe: env.FFPROBE_PATH?.trim() || 'ffprobe',
    piper: override ? parseCommand(override) : DEFAULT_PIPER,
    piperOverridden: Boolean(override),
    voicesDir: resolve(env.PIPER_VOICES_DIR?.trim() || DEFAULT_VOICES_DIR),
  };
}

export interface PiperInvocation {
  command: string;
  args: string[];
}

/** Piper writes either one WAV (`-f`) or one WAV per stdin line into a directory (`-d`). */
export type PiperOutput = { file: string } | { dir: string };

/**
 * The single place the Piper command line is built (piper1-gpl `python3 -m piper`).
 * Text is supplied on stdin; `-m` takes a voice name resolved against `--data-dir`
 * (looks for `<dir>/<voice>.onnx` plus its `.onnx.json`) or a path to an .onnx file.
 */
export function buildPiperCommand(params: {
  base: readonly string[];
  voice: string;
  voicesDir: string;
  output: PiperOutput;
}): PiperInvocation {
  const [command, ...prefix] = params.base;
  if (!command) throw new Error('empty Piper command');
  const output = 'file' in params.output ? ['-f', params.output.file] : ['-d', params.output.dir];
  return {
    command,
    args: [
      ...prefix,
      '-m',
      params.voice,
      '--data-dir',
      params.voicesDir,
      ...output,
      '--sentence-silence',
      String(SENTENCE_SILENCE_SEC),
    ],
  };
}

/** Where Piper will look for a voice, or undefined when it is a path that exists. */
function missingVoice(voice: string, voicesDir: string): string | undefined {
  if (voice.endsWith('.onnx') || isAbsolute(voice)) {
    return existsSync(voice) ? undefined : `voice model not found at ${voice}`;
  }
  const model = join(voicesDir, `${voice}.onnx`);
  if (existsSync(model) && existsSync(`${model}.json`)) return undefined;
  return (
    `voice "${voice}" not found in ${voicesDir} ` +
    `(run: python3 -m piper.download_voices ${voice} --data-dir ${voicesDir})`
  );
}

// ───────────────────────── Text and chapters ─────────────────────────

/** Piper synthesizes one line at a time; one line per segment keeps sentence pauses uniform. */
export function toPiperInput(spokenText: string): string {
  return (
    spokenText
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim() + '\n'
  );
}

/** Silence placed before `segment` (none before the first). */
export function pauseBefore(segment: ScriptSegment, index: number): number {
  if (index === 0) return 0;
  return LONG_PAUSE_KINDS.has(segment.kind) ? PAUSE_LONG_SEC : PAUSE_SHORT_SEC;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** Chapter start = all earlier segment durations plus every pause up to and including this segment's. */
export function computeChapters(segments: readonly ScriptSegment[], durations: readonly number[]): Chapter[] {
  if (segments.length !== durations.length) throw new Error('one duration per segment is required');
  const chapters: Chapter[] = [];
  let cursor = 0;
  segments.forEach((segment, index) => {
    cursor += pauseBefore(segment, index);
    const chapter: Chapter = { id: segment.id, title: segment.title, startSec: round3(cursor) };
    if (segment.storyId) chapter.storyId = segment.storyId;
    chapters.push(chapter);
    cursor += durations[index] ?? 0;
  });
  return chapters;
}

/** Total programme length implied by the segment durations and pauses. */
export function expectedDuration(segments: readonly ScriptSegment[], durations: readonly number[]): number {
  return segments.reduce((sum, segment, i) => sum + pauseBefore(segment, i) + (durations[i] ?? 0), 0);
}

// ───────────────────────── FFmpeg helpers ─────────────────────────

async function probeDuration(ffprobe: string, file: string): Promise<number | string> {
  const result = await run(
    ffprobe,
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file],
    { timeoutMs: TIMEOUT_PROBE_MS },
  );
  if (result.code !== 0) return describeFailure('ffprobe', result);
  const value = Number.parseFloat(result.stdout.trim());
  return Number.isFinite(value) ? value : `ffprobe returned no duration for ${basename(file)}`;
}

/** Escapes a value for an FFMETADATA1 file. */
function ffmetaEscape(value: string): string {
  return value.replace(/[\\=;#\n]/g, (c) => `\\${c}`);
}

function ffmetadata(title: string, chapters: Chapter[], totalSec: number): string {
  const lines = [
    ';FFMETADATA1',
    `title=${ffmetaEscape(title)}`,
    `artist=${ffmetaEscape(ID3_ARTIST)}`,
    `album=${ffmetaEscape(ID3_ALBUM)}`,
    `album_artist=${ffmetaEscape(ID3_ARTIST)}`,
    'genre=Podcast',
  ];
  chapters.forEach((chapter, i) => {
    const start = Math.round(chapter.startSec * 1000);
    const next = chapters[i + 1];
    const end = Math.max(start + 1, Math.round((next ? next.startSec : totalSec) * 1000));
    lines.push('[CHAPTER]', 'TIMEBASE=1/1000', `START=${start}`, `END=${end}`, `title=${ffmetaEscape(chapter.title)}`);
  });
  return lines.join('\n') + '\n';
}

/** ID3 title. NarrateOptions carries no edition, so it is read from the conventional data/editions/<key>/ folder. */
function id3Title(outFile: string, segments: readonly ScriptSegment[]): string {
  const edition = parseEditionKey(basename(dirname(resolve(outFile))));
  if (edition) return `${EDITION_TITLES[edition.edition]}, ${formatEditionDate(edition.date)}`;
  return segments[0]?.title ? `TheRepoReport: ${segments[0].title}` : 'TheRepoReport';
}

/** Builds the FFmpeg argv that joins `wavs` with `gaps` (gap[i] = silence after wav[i]). */
export function buildEncodeArgs(params: {
  wavs: readonly string[];
  gapsAfter: readonly number[];
  metadataFile: string;
  outFile: string;
}): string[] {
  const { wavs, gapsAfter } = params;
  const args = ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error'];
  for (const wav of wavs) args.push('-i', wav);
  args.push('-f', 'ffmetadata', '-i', params.metadataFile);

  const parts: string[] = [];
  wavs.forEach((_, i) => {
    const gap = gapsAfter[i] ?? 0;
    const pad = gap > 0 ? `,apad=pad_dur=${gap.toFixed(3)}` : '';
    parts.push(
      `[${i}:a]aformat=sample_fmts=fltp:sample_rates=${MIX_SAMPLE_RATE}:channel_layouts=mono${pad}[s${i}]`,
    );
  });
  const inputs = wavs.map((_, i) => `[s${i}]`).join('');
  parts.push(`${inputs}concat=n=${wavs.length}:v=0:a=1[cat]`);
  parts.push(
    `[cat]loudnorm=I=-16:TP=-1.5:LRA=11,aresample=${MP3_SAMPLE_RATE},aformat=channel_layouts=mono[out]`,
  );

  const meta = String(wavs.length);
  args.push(
    '-filter_complex',
    parts.join(';'),
    '-map',
    '[out]',
    '-map_metadata',
    meta,
    '-map_chapters',
    meta,
    '-c:a',
    'libmp3lame',
    '-b:a',
    MP3_BITRATE,
    '-ac',
    '1',
    '-ar',
    String(MP3_SAMPLE_RATE),
    '-id3v2_version',
    '3',
    '-write_xing',
    '1',
    '-f',
    'mp3',
    params.outFile,
  );
  return args;
}

// ───────────────────────── Validation ─────────────────────────

export interface Mp3Expectation {
  /** Expected programme length (sum of segments plus pauses). */
  durationSec?: number;
  /** Allowed absolute deviation. Default: max(1.5 s, 3 % of expected). */
  toleranceSec?: number;
}

export interface Mp3Validation {
  ok: boolean;
  reason?: string;
  codec?: string;
  durationSec?: number;
  maxVolumeDb?: number;
}

/**
 * Proves an MP3 is usable: ffprobe sees an mp3 stream, the duration is plausible,
 * a full decode succeeds, and the decoded peak is above the silence threshold.
 */
export async function validateMp3(path: string, expect: Mp3Expectation = {}): Promise<Mp3Validation> {
  const tools = resolveTools();
  if (!existsSync(path)) return { ok: false, reason: `file not found: ${path}` };

  const probe = await run(
    tools.ffprobe,
    ['-v', 'error', '-show_entries', 'stream=codec_name,codec_type:format=duration', '-of', 'json', path],
    { timeoutMs: TIMEOUT_PROBE_MS },
  );
  if (probe.code !== 0) return { ok: false, reason: describeFailure('ffprobe', probe) };

  let codec: string | undefined;
  let durationSec: number | undefined;
  try {
    const info = JSON.parse(probe.stdout) as {
      streams?: { codec_name?: string; codec_type?: string }[];
      format?: { duration?: string };
    };
    codec = info.streams?.find((s) => s.codec_type === 'audio')?.codec_name;
    const d = Number.parseFloat(info.format?.duration ?? '');
    durationSec = Number.isFinite(d) ? d : undefined;
  } catch {
    return { ok: false, reason: 'ffprobe output was not JSON' };
  }

  if (codec !== 'mp3') return { ok: false, codec, durationSec, reason: `expected mp3 audio, found ${codec ?? 'none'}` };
  if (durationSec === undefined || durationSec <= 1) {
    return { ok: false, codec, durationSec, reason: `duration ${durationSec ?? 'unknown'}s is not over 1 s` };
  }
  if (expect.durationSec !== undefined) {
    const tolerance = expect.toleranceSec ?? Math.max(1.5, expect.durationSec * 0.03);
    if (Math.abs(durationSec - expect.durationSec) > tolerance) {
      return {
        ok: false,
        codec,
        durationSec,
        reason: `duration ${durationSec.toFixed(2)}s differs from expected ${expect.durationSec.toFixed(2)}s by more than ${tolerance.toFixed(2)}s`,
      };
    }
  }

  const decode = await run(
    tools.ffmpeg,
    ['-hide_banner', '-nostdin', '-nostats', '-xerror', '-i', path, '-af', 'volumedetect', '-f', 'null', '-'],
    { timeoutMs: TIMEOUT_ENCODE_MS },
  );
  if (decode.code !== 0) return { ok: false, codec, durationSec, reason: describeFailure('ffmpeg decode', decode) };
  const peak = /max_volume:\s*(-?inf|-?[\d.]+)\s*dB/.exec(decode.stderr)?.[1];
  if (peak === undefined) return { ok: false, codec, durationSec, reason: 'volumedetect reported no level' };
  const maxVolumeDb = peak.endsWith('inf') ? Number.NEGATIVE_INFINITY : Number.parseFloat(peak);
  if (!(maxVolumeDb > SILENCE_THRESHOLD_DB)) {
    return { ok: false, codec, durationSec, maxVolumeDb, reason: `audio is silent (peak ${peak} dB)` };
  }
  return { ok: true, codec, durationSec, maxVolumeDb };
}

// ───────────────────────── Synthesis ─────────────────────────

/** `retry: false` when trying again one segment at a time cannot help (Piper missing, or out of time). */
type Synthesis = { wavs: string[] } | { error: string; retry: boolean };

/**
 * All segments in one Piper process (the model loads once, ~3 s saved per segment).
 * Piper's directory mode writes one WAV per stdin line, named by a monotonic
 * nanosecond clock, so numeric order is line order. Any mismatch is an error and
 * the caller falls back to one process per segment.
 */
async function synthesizeBatch(tools: Tools, voice: string, inputs: string[], workDir: string): Promise<Synthesis> {
  const dir = join(workDir, 'piper-batch');
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const text = inputs.join('');
  const call = buildPiperCommand({ base: tools.piper, voice, voicesDir: tools.voicesDir, output: { dir } });
  const result = await run(call.command, call.args, { input: text, timeoutMs: piperTimeoutMs(text.length) });
  if (result.code !== 0) {
    return { error: describeFailure('piper', result), retry: !result.spawnError && !result.timedOut };
  }
  const names = (await readdir(dir)).filter((n) => /^\d+\.wav$/.test(n));
  if (names.length !== inputs.length) {
    return { error: `piper batch wrote ${names.length} files for ${inputs.length} segments`, retry: true };
  }
  names.sort((a, b) => {
    const x = BigInt(a.slice(0, -4));
    const y = BigInt(b.slice(0, -4));
    return x < y ? -1 : x > y ? 1 : 0;
  });
  return { wavs: names.map((n) => join(dir, n)) };
}

/** One Piper process per segment, sequentially. */
async function synthesizeEach(tools: Tools, voice: string, inputs: string[], workDir: string): Promise<Synthesis> {
  const wavs: string[] = [];
  for (const [index, input] of inputs.entries()) {
    const wav = join(workDir, `segment-${String(index).padStart(3, '0')}.wav`);
    await rm(wav, { force: true });
    const call = buildPiperCommand({ base: tools.piper, voice, voicesDir: tools.voicesDir, output: { file: wav } });
    const result = await run(call.command, call.args, { input, timeoutMs: piperTimeoutMs(input.length) });
    if (result.code !== 0) return { error: describeFailure('piper', result), retry: false };
    wavs.push(wav);
  }
  return { wavs };
}

// ───────────────────────── narrate ─────────────────────────

const noopLogger: Logger = { info() {}, warn() {}, error() {} };

async function moveFile(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch {
    await copyFile(from, to);
    await rm(from, { force: true });
  }
}

export const narrate: Narrate = async (options: NarrateOptions) => {
  const { segments, voice, workDir, outFile } = options;
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new Error('narrate: at least one script segment is required');
  }
  const logger = options.logger ?? noopLogger;
  const started = performance.now();
  const elapsed = () => Math.round((performance.now() - started) / 10) / 100;
  const unavailable = (reason: string) => {
    logger.warn('audio unavailable', { reason });
    return { available: false, unavailableReason: reason, chapters: [] as Chapter[], audioSeconds: elapsed() };
  };

  try {
    const tools = resolveTools();

    for (const [label, bin] of [
      ['ffmpeg', tools.ffmpeg],
      ['ffprobe', tools.ffprobe],
    ] as const) {
      const check = await run(bin, ['-version'], { timeoutMs: TIMEOUT_PROBE_MS });
      if (check.code !== 0) return unavailable(describeFailure(label, check));
    }

    if (!tools.piperOverridden) {
      const missing = missingVoice(voice, tools.voicesDir);
      if (missing) return unavailable(missing);
    }

    await mkdir(workDir, { recursive: true });
    const inputs = segments.map((segment) => toPiperInput(segment.spokenText));
    const empty = segments.find((_, i) => inputs[i]!.trim() === '');
    if (empty) return unavailable(`segment "${empty.id}" has no spoken text`);

    const t0 = performance.now();
    let synthesis: Synthesis = { error: 'batch mode disabled', retry: true };
    if (process.env.PIPER_BATCH !== '0' && segments.length > 1) {
      synthesis = await synthesizeBatch(tools, voice, inputs, workDir);
      if ('error' in synthesis) logger.warn('piper batch mode failed; retrying one segment at a time', { reason: synthesis.error });
    }
    let mode: 'batch' | 'per-segment' = 'batch';
    if ('error' in synthesis && synthesis.retry) {
      mode = 'per-segment';
      synthesis = await synthesizeEach(tools, voice, inputs, workDir);
    }
    const ttsSeconds = (performance.now() - t0) / 1000;
    if ('error' in synthesis) return unavailable(synthesis.error);
    const { wavs } = synthesis;

    const durations: number[] = [];
    for (const [index, wav] of wavs.entries()) {
      const id = segments[index]!.id;
      const size = existsSync(wav) ? (await stat(wav)).size : 0;
      if (size <= 44) return unavailable(`piper produced no audio for segment "${id}"`);
      const duration = await probeDuration(tools.ffprobe, wav);
      if (typeof duration === 'string') return unavailable(duration);
      if (duration <= 0) return unavailable(`segment "${id}" has zero duration`);
      durations.push(duration);
    }

    const chapters = computeChapters(segments, durations);
    const expected = expectedDuration(segments, durations);
    const gapsAfter = segments.map((_, i) => {
      const next = segments[i + 1];
      return next ? pauseBefore(next, i + 1) : 0;
    });

    const metadataFile = join(workDir, 'chapters.ffmeta');
    await writeFile(metadataFile, ffmetadata(id3Title(outFile, segments), chapters, expected), 'utf8');

    const tmpMp3 = join(workDir, 'narration.tmp.mp3');
    await rm(tmpMp3, { force: true });
    const t1 = performance.now();
    const encode = await run(tools.ffmpeg, buildEncodeArgs({ wavs, gapsAfter, metadataFile, outFile: tmpMp3 }), {
      timeoutMs: TIMEOUT_ENCODE_MS,
    });
    const encodeSeconds = (performance.now() - t1) / 1000;
    if (encode.code !== 0) return unavailable(describeFailure('ffmpeg encode', encode));

    const validation = await validateMp3(tmpMp3, { durationSec: expected });
    if (!validation.ok) return unavailable(`MP3 validation failed: ${validation.reason}`);

    await mkdir(dirname(resolve(outFile)), { recursive: true });
    await moveFile(tmpMp3, outFile);
    const bytes = (await stat(outFile)).size;
    const durationSec = Math.round((validation.durationSec ?? expected) * 100) / 100;

    logger.info('narration complete', {
      segments: segments.length,
      piperMode: mode,
      durationSec,
      bytes,
      ttsSeconds: Math.round(ttsSeconds * 100) / 100,
      encodeSeconds: Math.round(encodeSeconds * 100) / 100,
      realtimeFactor: Math.round((ttsSeconds / durationSec) * 1000) / 1000,
    });

    return {
      available: true,
      file: basename(outFile),
      bytes,
      durationSec,
      voice,
      chapters,
      audioSeconds: elapsed(),
    };
  } catch (error) {
    return unavailable(`unexpected audio error: ${error instanceof Error ? error.message : String(error)}`);
  }
};
