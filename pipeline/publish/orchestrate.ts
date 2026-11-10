/**
 * One edition run, end to end (see "Pipeline" in docs/BUILD_PROMPT.md).
 *
 * Stage modules are injected so this file can be tested with fakes; the CLI in
 * pipeline/run.ts wires the real implementations. Outputs:
 *   <siteDir>/data/manifest.json, data/editions/<key>/{report,transcript}.json,
 *   data/editions/<key>/audio.mp3, data/run-summary.json, feed.xml
 *   <nextStateFile>  (committed to the `state` branch by the workflow only after deploy)
 */
import { existsSync } from 'node:fs';
import { cp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  BuildFeed,
  BuildScript,
  BuildStories,
  Collect,
  CollectResult,
  ExplainResult,
  ExplainStories,
  FetchLike,
  Logger,
  Narrate,
  ScoreStories,
  SelectStories,
  Selection,
} from '../../shared/contracts';
import { parseEditionKey, resolveEdition, type ResolvedEdition } from '../../shared/edition';
import {
  AudioInfo,
  emptyState,
  EditionReport,
  type Manifest,
  type PipelineState,
  type RunMetrics,
  type ScoredStory,
  type ScriptSegment,
  type Story,
} from '../../shared/schemas';
import { computeNextState, loadState, saveState } from '../state/index';
import { createLogger } from '../util/logger';
import { MemorySampler, type MemoryPeaks } from '../util/memory';
import { round, stopwatch } from '../util/timing';
import {
  ArchiveUnavailableError,
  assertArchiveUsable,
  fetchLiveManifest,
  stageArchive,
  type LiveManifest,
  type StagedArchive,
} from './archive';
import { buildManifest, manifestEntryFor, toReportStory, toWatchItem } from './assemble';
import { loadConfig, type ProductionConfig } from './config';

export interface EditionDeps {
  collect: Collect;
  buildStories: BuildStories;
  scoreStories: ScoreStories;
  selectStories: SelectStories;
  explainStories: ExplainStories;
  buildScript: BuildScript;
  narrate: Narrate;
  buildFeed: BuildFeed;
}

export interface RunEditionOptions {
  /** Directory the deployable site is assembled in (frontend is copied in later by the workflow). */
  siteDir: string;
  /** Previous state (read). */
  stateFile: string;
  /** Next state (written only on success). */
  nextStateFile: string;
  /** Scratch space (archive staging, WAVs, dry-run output). Default ".work". */
  workDir?: string;
  configDir?: string;
  siteUrl: string;
  /** Edition key override, e.g. "2026-11-10-evening". */
  editionOverride?: string;
  /** Publish even if the key is already live (replaces that edition). */
  force?: boolean;
  /** Do everything, but write under <workDir>/dry-run and never deploy. */
  dryRun?: boolean;
  /** Ollama model override. */
  model?: string;
  /**
   * Dry runs only: ignore saved cursors and story history and re-collect the
   * last N hours, to calibrate scoring on a realistic window.
   */
  replayHours?: number;
  forceFallback?: boolean;
  forceNoAudio?: boolean;
  allowEmptyArchive?: boolean;
  token?: string;
  ollamaUrl?: string;
  /** Piper voice override (name or path). Defaults to editorial.voice. */
  voice?: string;
  now?: Date;
  fetch?: FetchLike;
  logger?: Logger;
  archiveRetryDelayMs?: number;
  /** Timings measured by the workflow outside Node (Ollama install, model pull, ...). */
  infra?: Record<string, number | string | boolean>;
}

export interface CandidateRow {
  repo: string;
  title: string;
  status: string;
  total: number;
  /** Awarded points per dimension, in rubric order. */
  dims: Record<string, number>;
  outcome: string;
}

export type RunStatus = 'published' | 'dry-run' | 'skipped' | 'failed';

export interface RunSummary {
  status: RunStatus;
  editionKey?: string;
  dryRun: boolean;
  startedAt: string;
  finishedAt: string;
  reason?: string;
  failedStage?: string;
  quiet?: boolean;
  summarization?: EditionReport['summarization'];
  model?: string;
  storyCount?: number;
  watchingCount?: number;
  skippedCount?: number;
  /** Highest-scoring candidates with their outcome, for calibrating the rubric. */
  candidates?: CandidateRow[];
  carriedEditions?: string[];
  droppedEditions?: string[];
  failedRepos?: { repo: string; reason: string }[];
  audio?: { available: boolean; bytes?: number; durationSec?: number; unavailableReason?: string };
  metrics?: RunMetrics;
  memory?: MemoryPeaks;
  stageSeconds: Record<string, number>;
  infra?: Record<string, number | string | boolean>;
}

export interface RunEditionResult {
  status: RunStatus;
  /** True only when the workflow should deploy `siteDir` and then commit `nextStateFile`. */
  deploy: boolean;
  editionKey?: string;
  siteDir: string;
  nextStateFile: string;
  summary: RunSummary;
}

class StageError extends Error {
  constructor(
    readonly stage: string,
    readonly cause: unknown,
  ) {
    super(`${stage}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'StageError';
  }
}

const envFlag = (name: string) => process.env[name] === '1' || process.env[name] === 'true';

export async function runEdition(deps: EditionDeps, opts: RunEditionOptions): Promise<RunEditionResult> {
  const total = stopwatch();
  const memory = new MemorySampler().start();
  const now = opts.now ?? new Date();
  const logger = opts.logger ?? createLogger({ scope: 'edition', secrets: opts.token ? [opts.token] : [] });
  const workDir = opts.workDir ?? '.work';
  const dryRun = opts.dryRun ?? false;
  const siteDir = dryRun ? join(workDir, 'dry-run', 'site') : opts.siteDir;
  const nextStateFile = dryRun ? join(workDir, 'dry-run', 'next-state.json') : opts.nextStateFile;
  const forceFallback = opts.forceFallback ?? envFlag('FORCE_FALLBACK');
  const forceNoAudio = opts.forceNoAudio ?? envFlag('FORCE_NO_AUDIO');
  const allowEmptyArchive = opts.allowEmptyArchive ?? envFlag('ALLOW_EMPTY_ARCHIVE');
  const stageSeconds: Record<string, number> = {};
  const summary: RunSummary = {
    status: 'failed',
    dryRun,
    startedAt: now.toISOString(),
    finishedAt: now.toISOString(),
    stageSeconds,
    ...(opts.infra ? { infra: opts.infra } : {}),
  };
  const finish = (status: RunStatus, deploy: boolean, extra: Partial<RunSummary> = {}): RunEditionResult => {
    Object.assign(summary, extra, { status, finishedAt: new Date().toISOString(), memory: memory.stop() });
    stageSeconds.total = total();
    return { status, deploy, siteDir, nextStateFile, summary, ...(summary.editionKey ? { editionKey: summary.editionKey } : {}) };
  };

  async function stage<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
    const elapsed = stopwatch();
    try {
      return await fn();
    } catch (error) {
      throw new StageError(name, error);
    } finally {
      stageSeconds[name] = round((stageSeconds[name] ?? 0) + elapsed());
    }
  }

  // A stale next-state file must never be mistaken for this run's output.
  await rm(nextStateFile, { force: true });

  try {
    // 1. Edition identity.
    const edition: ResolvedEdition = await stage('resolve', () => {
      if (!opts.editionOverride) return resolveEdition(now);
      const parsed = parseEditionKey(opts.editionOverride);
      if (!parsed) throw new Error(`Invalid edition override "${opts.editionOverride}" (expected YYYY-MM-DD-morning|afternoon|evening)`);
      return parsed;
    });
    summary.editionKey = edition.key;
    logger.info('edition resolved', { key: edition.key, dryRun, force: opts.force ?? false });

    // 2. Config and state.
    const config: ProductionConfig = await stage('config', () => loadConfig(opts.configDir ?? 'config'));
    if (opts.replayHours !== undefined && !dryRun) throw new Error('replayHours is only allowed with a dry run');
    const state: PipelineState = await stage('state', async () =>
      opts.replayHours !== undefined ? emptyState() : loadState(opts.stateFile),
    );

    // 3. Live archive: duplicate guard and first-run rule.
    const fetchOpts = {
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      ...(opts.archiveRetryDelayMs !== undefined ? { retryDelayMs: opts.archiveRetryDelayMs } : {}),
      logger,
    };
    const live: LiveManifest = await stage('archive', () => fetchLiveManifest(opts.siteUrl, fetchOpts));
    const liveManifest: Manifest | null = live.status === 'ok' ? live.manifest : null;
    if (liveManifest?.editions.some((e) => e.key === edition.key) && !opts.force) {
      logger.info('already published; nothing to do', { key: edition.key });
      return finish('skipped', false, { reason: `Edition ${edition.key} is already published` });
    }
    await stage('archive', () =>
      assertArchiveUsable({
        live,
        allowEmptyArchive,
        ...(state.lastEditionKey ? { priorLastEditionKey: state.lastEditionKey } : {}),
      }),
    );
    const staged: StagedArchive = await stage('archive', () =>
      stageArchive({
        ...fetchOpts,
        siteUrl: opts.siteUrl,
        manifest: liveManifest,
        stagingDir: join(workDir, 'archive-staging'),
        now,
        retentionDays: config.editorial.retentionDays,
        replaceKey: edition.key,
      }),
    );
    summary.carriedEditions = staged.carried.map((e) => e.key);
    summary.droppedEditions = staged.dropped;
    if (live.status === 'missing') logger.warn('no live manifest; starting a new archive', { allowEmptyArchive });

    // 4. Collect. Any throw here means GitHub is unavailable: keep the last edition live.
    const collected: CollectResult = await stage('collect', () =>
      deps.collect({
        watchlist: config.watchlist,
        state,
        now,
        logger,
        ...(opts.replayHours !== undefined ? { initialLookbackHours: opts.replayHours } : {}),
        ...(opts.token ? { token: opts.token } : {}),
        ...(opts.fetch ? { fetch: opts.fetch } : {}),
      }),
    );
    summary.failedRepos = collected.failedRepos;
    logger.info('collected', {
      events: collected.events.length,
      requests: collected.requestCount,
      rateRemaining: collected.rateRemaining,
      failedRepos: collected.failedRepos.length,
    });

    // 5–7. Stories, scores, selection (deterministic).
    const stories: Story[] = await stage('stories', () => deps.buildStories(collected.events, state.stories));
    const scored: ScoredStory[] = await stage('score', () =>
      deps.scoreStories(stories, { editorial: config.editorial, repos: collected.repos }),
    );
    const selection: Selection = await stage('select', () => deps.selectStories(scored, state, config.editorial));

    // 8–9. Explain (LLM with validation and deterministic fallback).
    const model = opts.model ?? config.editorial.model;
    const explained: ExplainResult = await stage('explain', async () => {
      if (selection.selected.length === 0) {
        return { stories: [], summarization: forceFallback ? 'fallback' : 'llm', inferenceSeconds: 0 } satisfies ExplainResult;
      }
      return deps.explainStories(selection.selected, {
        editorial: config.editorial,
        model,
        forceFallback,
        logger,
        ...(opts.ollamaUrl ? { ollamaUrl: opts.ollamaUrl } : {}),
      });
    });

    // 10. Script.
    const segments: ScriptSegment[] = await stage('script', () =>
      deps.buildScript({
        edition: edition.edition,
        date: edition.date,
        stories: explained.stories,
        watching: selection.watching,
        editorial: config.editorial,
      }),
    );

    // 11. Narrate into scratch space; copied into the site at publish time.
    const audioWork = join(workDir, 'audio', edition.key);
    const audioOut = join(audioWork, 'audio.mp3');
    const voice = opts.voice ?? config.editorial.voice;
    const narrated: { audio: AudioInfo; audioSeconds: number } = await stage('audio', async () => {
      if (forceNoAudio) {
        logger.warn('FORCE_NO_AUDIO set; skipping speech synthesis');
        return {
          audio: { available: false, chapters: [], unavailableReason: 'Speech synthesis failed for this run (forced failure test). Use your browser\'s speech playback instead.' },
          audioSeconds: 0,
        };
      }
      await rm(audioWork, { recursive: true, force: true });
      await mkdir(audioWork, { recursive: true });
      try {
        const { audioSeconds, ...info } = await deps.narrate({ segments, voice, workDir: audioWork, outFile: audioOut, logger });
        let audio = AudioInfo.parse(info);
        if (audio.available) {
          if (!existsSync(audioOut)) {
            audio = { available: false, chapters: [], unavailableReason: 'Speech engine reported success but produced no file.' };
          } else {
            audio = { ...audio, file: 'audio.mp3', bytes: (await stat(audioOut)).size };
          }
        }
        return { audio, audioSeconds };
      } catch (error) {
        logger.error('narration failed; publishing without audio', { error });
        return {
          audio: { available: false, chapters: [], unavailableReason: `Speech synthesis failed: ${(error as Error).message}` },
          audioSeconds: 0,
        };
      }
    });

    // 12. Assemble and publish.
    return await stage('publish', async () => {
      const mem = memory.stop();
      memory.start();
      const metrics: RunMetrics = {
        githubRequests: collected.requestCount,
        ...(collected.rateRemaining !== undefined ? { githubRateRemaining: collected.rateRemaining } : {}),
        reposScanned: collected.repos.filter((r) => r.enabled).length - collected.failedRepos.length,
        eventsCollected: collected.events.length,
        storiesConsidered: scored.length,
        ...(typeof opts.infra?.modelLoadSeconds === 'number' ? { modelLoadSeconds: opts.infra.modelLoadSeconds } : {}),
        inferenceSeconds: round(explained.inferenceSeconds),
        ...(explained.tokensPerSecond !== undefined ? { tokensPerSecond: round(explained.tokensPerSecond) } : {}),
        audioSeconds: round(narrated.audioSeconds),
        totalSeconds: total(),
        peakMemoryMb: mem.peakSystemUsedMb ?? mem.peakRssMb,
      };
      const report = EditionReport.parse({
        schemaVersion: 1,
        key: edition.key,
        date: edition.date,
        edition: edition.edition,
        generatedAt: now.toISOString(),
        windowStart: collected.windowStart,
        windowEnd: collected.windowEnd,
        summarization: explained.summarization,
        ...(explained.model ? { model: explained.model } : {}),
        quiet: explained.stories.length === 0,
        stories: explained.stories.map((s) => toReportStory(s, state.stories)),
        worthWatching: selection.watching.map(toWatchItem),
        transcript: segments,
        audio: narrated.audio,
        metrics,
      });

      const reports: Record<string, EditionReport> = { ...staged.reports, [report.key]: report };
      const newEntry = manifestEntryFor(report, now.toISOString());
      const manifest = buildManifest({
        now,
        config,
        newEntry,
        carried: staged.carried,
        reports,
        collect: collected,
        previous: liveManifest,
      });
      const feed = deps.buildFeed({ manifest, reports, siteUrl: opts.siteUrl.endsWith('/') ? opts.siteUrl : `${opts.siteUrl}/` });

      // Everything is computed; only now touch the site directory.
      await rm(siteDir, { recursive: true, force: true });
      const editionsDir = join(siteDir, 'data', 'editions');
      await mkdir(editionsDir, { recursive: true });
      if (existsSync(join(staged.stagingDir, 'data', 'editions'))) {
        await cp(join(staged.stagingDir, 'data', 'editions'), editionsDir, { recursive: true });
      }
      await rm(staged.stagingDir, { recursive: true, force: true });
      const dir = join(editionsDir, report.key);
      await rm(dir, { recursive: true, force: true });
      await mkdir(dir, { recursive: true });
      await writeJson(join(dir, 'report.json'), report);
      await writeJson(join(dir, 'transcript.json'), report.transcript);
      if (report.audio.available) await cp(audioOut, join(dir, 'audio.mp3'));
      await writeJson(join(siteDir, 'data', 'manifest.json'), manifest);
      await writeFile(join(siteDir, 'feed.xml'), feed, 'utf8');

      const next = computeNextState({
        previous: state,
        collect: collected,
        stories,
        covered: report.stories.map((s) => ({ id: s.id, status: s.status })),
        editionKey: report.key,
        now,
      });
      await saveState(nextStateFile, next);

      const result = finish(dryRun ? 'dry-run' : 'published', !dryRun, {
        quiet: report.quiet,
        summarization: report.summarization,
        ...(report.model ? { model: report.model } : {}),
        storyCount: report.stories.length,
        watchingCount: report.worthWatching.length,
        skippedCount: selection.skipped.length,
        candidates: candidateRows(selection),
        audio: {
          available: report.audio.available,
          ...(report.audio.bytes !== undefined ? { bytes: report.audio.bytes } : {}),
          ...(report.audio.durationSec !== undefined ? { durationSec: report.audio.durationSec } : {}),
          ...(report.audio.unavailableReason ? { unavailableReason: report.audio.unavailableReason } : {}),
        },
        metrics,
      });
      await writeJson(join(siteDir, 'data', 'run-summary.json'), result.summary);
      logger.info('edition built', { key: report.key, stories: report.stories.length, quiet: report.quiet, deploy: result.deploy });
      return result;
    });
  } catch (error) {
    const failedStage = error instanceof StageError ? error.stage : 'unknown';
    const cause = error instanceof StageError ? error.cause : error;
    const reason =
      cause instanceof ArchiveUnavailableError
        ? `Live archive unavailable: ${cause.message}`
        : `${failedStage} failed: ${cause instanceof Error ? cause.message : String(cause)}`;
    logger.error('run failed; nothing will be deployed and state is unchanged', { stage: failedStage, reason });
    await rm(nextStateFile, { force: true });
    return finish('failed', false, { failedStage, reason });
  }
}

export interface PublishedCheck {
  editionKey: string;
  alreadyPublished: boolean;
  /** Whether the full run should go ahead (not yet published, or forced). */
  proceed: boolean;
  manifest: LiveManifest['status'];
}

/**
 * Cheap pre-flight used by the workflow before installing Ollama and Piper:
 * resolves the edition key and checks the live manifest. Throws
 * ArchiveUnavailableError when the live site cannot be read.
 */
export async function checkPublished(opts: {
  siteUrl: string;
  editionOverride?: string;
  force?: boolean;
  now?: Date;
  fetch?: FetchLike;
  logger?: Logger;
  archiveRetryDelayMs?: number;
}): Promise<PublishedCheck> {
  const now = opts.now ?? new Date();
  let editionKey: string;
  if (opts.editionOverride) {
    const parsed = parseEditionKey(opts.editionOverride);
    if (!parsed) throw new Error(`Invalid edition override "${opts.editionOverride}"`);
    editionKey = parsed.key;
  } else {
    editionKey = resolveEdition(now).key;
  }
  const live = await fetchLiveManifest(opts.siteUrl, {
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(opts.logger ? { logger: opts.logger } : {}),
    ...(opts.archiveRetryDelayMs !== undefined ? { retryDelayMs: opts.archiveRetryDelayMs } : {}),
  });
  const alreadyPublished = live.status === 'ok' && live.manifest.editions.some((e) => e.key === editionKey);
  return { editionKey, alreadyPublished, proceed: !alreadyPublished || (opts.force ?? false), manifest: live.status };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** Top candidates by score with what happened to each, so threshold and rubric can be tuned from real runs. */
function candidateRows(selection: Selection, limit = 20): CandidateRow[] {
  const rows = [
    ...selection.selected.map((story) => ({ story, outcome: 'selected' })),
    ...selection.watching.map((story) => ({ story, outcome: 'watching' })),
    ...selection.skipped.map(({ story, reason }) => ({ story, outcome: `skipped: ${reason}` })),
  ];
  return rows
    .sort((a, b) => b.story.score.total - a.story.score.total)
    .slice(0, limit)
    .map(({ story, outcome }) => ({
      repo: story.repo,
      title: story.title.slice(0, 80),
      status: story.status,
      total: story.score.total,
      dims: Object.fromEntries(story.score.dimensions.map((d) => [d.key, d.awarded])),
      outcome,
    }));
}
