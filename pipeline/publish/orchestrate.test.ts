import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { EditionReport, EditorialConfig, Manifest, PipelineState, WatchlistConfig } from '../../shared/schemas';
import { memoryLogger } from '../util/logger';
import { FakeSite, SITE, fakeDeps, liveManifest, minimalReport, publish, type FakeOptions } from './__fixtures__/fakes';
import { checkPublished, runEdition, type RunEditionOptions } from './orchestrate';

const watchlist = WatchlistConfig.parse(JSON.parse(readFileSync('config/watchlist.json', 'utf8')));
const editorial = EditorialConfig.parse(JSON.parse(readFileSync('config/editorial.json', 'utf8')));
// 13:30 in New York → afternoon edition.
const now = new Date('2026-11-10T18:30:00Z');
const KEY = '2026-11-10-afternoon';

let root: string;
let site: FakeSite;

function options(extra: Partial<RunEditionOptions> = {}): RunEditionOptions {
  return {
    siteDir: join(root, 'site'),
    stateFile: join(root, 'state', 'state.json'),
    nextStateFile: join(root, 'state', 'next-state.json'),
    workDir: join(root, 'work'),
    configDir: 'config',
    siteUrl: SITE,
    now,
    fetch: site.fetch,
    logger: memoryLogger(),
    archiveRetryDelayMs: 0,
    forceFallback: false,
    forceNoAudio: false,
    allowEmptyArchive: false,
    ...extra,
  };
}

function writeState(state: PipelineState) {
  const path = join(root, 'state', 'state.json');
  return mkdir(dirname(path), { recursive: true }).then(() => writeFileSync(path, JSON.stringify(state)));
}

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));
const run = (deps: FakeOptions = {}, extra: Partial<RunEditionOptions> = {}) => {
  const d = fakeDeps(deps);
  return runEdition(d, options(extra)).then((result) => ({ result, deps: d }));
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'edition-'));
  site = new FakeSite();
});

describe('first run', () => {
  it('publishes a complete edition when no manifest exists and there is no prior state', async () => {
    const { result } = await run();
    expect(result.status).toBe('published');
    expect(result.deploy).toBe(true);
    expect(result.editionKey).toBe(KEY);

    const manifest = Manifest.parse(readJson(join(root, 'site/data/manifest.json')));
    expect(manifest.editions.map((e) => e.key)).toEqual([KEY]);
    expect(manifest.editions[0]).toMatchObject({ audioPath: `data/editions/${KEY}/audio.mp3`, audioBytes: 1234, storyCount: 2 });
    expect(manifest.repos.find((r) => r.repo === 'ollama/ollama')?.recentStoryIds).toEqual(['story:release:ollama/ollama:v0.9.0']);
    expect(manifest.repos.find((r) => r.repo === 'ollama/ollama')?.lastScannedAt).toBe(now.toISOString());

    const report = EditionReport.parse(readJson(join(root, `site/data/editions/${KEY}/report.json`)));
    expect(report.stories.map((s) => s.status)).toEqual(['released', 'merged']);
    expect(report.stories[0]?.links).toEqual([{ label: 'Release v0.9.0', url: 'https://github.com/ollama/ollama/releases/tag/v0.9.0', kind: 'release' }]);
    expect(report.worthWatching.map((w) => w.status)).toEqual(['proposed']);
    expect(report.metrics).toMatchObject({ githubRequests: 42, githubRateRemaining: 958, inferenceSeconds: 3, tokensPerSecond: 12.5, audioSeconds: 4 });
    expect(report.summarization).toBe('llm');
    expect(statSync(join(root, `site/data/editions/${KEY}/audio.mp3`)).size).toBe(1234);
    expect(existsSync(join(root, `site/data/editions/${KEY}/transcript.json`))).toBe(true);
    expect(readFileSync(join(root, 'site/feed.xml'), 'utf8')).toContain(KEY);
    expect(readJson(join(root, 'site/data/run-summary.json'))).toMatchObject({ status: 'published', editionKey: KEY });

    const next = PipelineState.parse(readJson(join(root, 'state/next-state.json')));
    expect(next.lastEditionKey).toBe(KEY);
    expect(next.stories['story:release:ollama/ollama:v0.9.0']?.lastCoveredEdition).toBe(KEY);
    // Watching items are not "covered".
    expect(next.stories['story:issue:facebook/react#7']?.lastCoveredEdition).toBeUndefined();
  });

  it('refuses a 404 manifest when state says an edition was already published', async () => {
    await writeState({ schemaVersion: 1, lastEditionKey: '2026-11-10-morning', repos: {}, stories: {} });
    const { result, deps } = await run();
    expect(result.status).toBe('failed');
    expect(result.summary.failedStage).toBe('archive');
    expect(deps.calls.collect).toBeUndefined();
    expect(existsSync(join(root, 'site'))).toBe(false);
    expect(existsSync(join(root, 'state/next-state.json'))).toBe(false);
  });

  it('allows starting over with ALLOW_EMPTY_ARCHIVE', async () => {
    await writeState({ schemaVersion: 1, lastEditionKey: '2026-11-10-morning', repos: {}, stories: {} });
    const { result } = await run({}, { allowEmptyArchive: true });
    expect(result.status).toBe('published');
  });
});

describe('archive carry-forward', () => {
  const carried = [
    minimalReport('2026-11-10-morning', '2026-11-10', 'morning'),
    minimalReport('2026-11-04-evening', '2026-11-04', 'evening'),
    minimalReport('2026-11-03-evening', '2026-11-03', 'evening'),
  ];

  it('republishes unexpired editions newest-first and drops expired ones', async () => {
    publish(site, liveManifest(watchlist, editorial, carried), carried);
    await writeState({ schemaVersion: 1, lastEditionKey: '2026-11-10-morning', repos: {}, stories: {} });
    const { result } = await run();
    expect(result.status).toBe('published');
    const manifest = Manifest.parse(readJson(join(root, 'site/data/manifest.json')));
    expect(manifest.editions.map((e) => e.key)).toEqual([KEY, '2026-11-10-morning', '2026-11-04-evening']);
    expect(existsSync(join(root, 'site/data/editions/2026-11-10-morning/audio.mp3'))).toBe(true);
    expect(existsSync(join(root, 'site/data/editions/2026-11-03-evening'))).toBe(false);
    expect(result.summary.droppedEditions).toEqual(['2026-11-03-evening']);
    expect(readFileSync(join(root, 'site/feed.xml'), 'utf8')).toBe(
      `<rss><item>${KEY}</item><item>2026-11-10-morning</item><item>2026-11-04-evening</item></rss>`,
    );
  });

  it('aborts before writing the site when the live archive is unreachable', async () => {
    site.raw('data/manifest.json', { status: 502, body: 'bad gateway' });
    const { result, deps } = await run();
    expect(result.status).toBe('failed');
    expect(result.deploy).toBe(false);
    expect(result.summary.reason).toMatch(/Live archive unavailable/);
    expect(deps.calls.collect).toBeUndefined();
    expect(existsSync(join(root, 'site'))).toBe(false);
    expect(existsSync(join(root, 'state/next-state.json'))).toBe(false);
  });

  it('aborts before writing the site when a listed edition file is missing', async () => {
    publish(site, liveManifest(watchlist, editorial, carried), carried);
    site.files.delete('data/editions/2026-11-04-evening/report.json');
    const { result } = await run();
    expect(result.status).toBe('failed');
    expect(existsSync(join(root, 'site'))).toBe(false);
    expect(existsSync(join(root, 'state/next-state.json'))).toBe(false);
  });
});

describe('duplicate guard', () => {
  const current = [minimalReport(KEY, '2026-11-10', 'afternoon')];

  it('skips an edition that is already live, with no outputs and no stage calls', async () => {
    publish(site, liveManifest(watchlist, editorial, current), current);
    const { result, deps } = await run();
    expect(result.status).toBe('skipped');
    expect(result.deploy).toBe(false);
    expect(Object.keys(deps.calls)).toEqual([]);
    expect(existsSync(join(root, 'site'))).toBe(false);
    expect(existsSync(join(root, 'state/next-state.json'))).toBe(false);
    expect(await checkPublished({ siteUrl: SITE, now, fetch: site.fetch })).toMatchObject({ editionKey: KEY, alreadyPublished: true, proceed: false });
  });

  it('replaces the live edition when forced', async () => {
    publish(site, liveManifest(watchlist, editorial, current), current);
    const { result } = await run({}, { force: true });
    expect(result.status).toBe('published');
    const manifest = Manifest.parse(readJson(join(root, 'site/data/manifest.json')));
    expect(manifest.editions.map((e) => e.key)).toEqual([KEY]);
    expect(manifest.editions[0]?.storyCount).toBe(2);
    expect(await checkPublished({ siteUrl: SITE, now, fetch: site.fetch, force: true })).toMatchObject({ proceed: true });
  });

  it('honors an edition override and rejects malformed keys', async () => {
    const { result } = await run({}, { editionOverride: '2026-11-09-evening' });
    expect(result.editionKey).toBe('2026-11-09-evening');
    expect(existsSync(join(root, 'site/data/editions/2026-11-09-evening/report.json'))).toBe(true);
    const bad = await run({}, { editionOverride: 'tomorrow' });
    expect(bad.result.status).toBe('failed');
    expect(bad.result.summary.failedStage).toBe('resolve');
  });
});

describe('failures and fallbacks', () => {
  it('collect failure: failed, nothing published, state untouched', async () => {
    const before = { schemaVersion: 1 as const, repos: { 'a/b': { since: 'x', etags: {} } }, stories: {} };
    await writeState(before);
    writeFileSync(join(root, 'state', 'next-state.json'), '{"stale": true}');
    const { result, deps } = await run({ collectError: new Error('GitHub API returned 503') });
    expect(result.status).toBe('failed');
    expect(result.summary.failedStage).toBe('collect');
    expect(deps.calls.buildStories).toBeUndefined();
    expect(existsSync(join(root, 'site'))).toBe(false);
    expect(existsSync(join(root, 'state/next-state.json'))).toBe(false);
    expect(readJson(join(root, 'state/state.json'))).toEqual(before);
  });

  it('quiet day still publishes a short edition', async () => {
    const { result, deps } = await run({ scoreFor: () => 5 });
    expect(result.status).toBe('published');
    expect(deps.calls.explainStories).toBeUndefined();
    const report = EditionReport.parse(readJson(join(root, `site/data/editions/${KEY}/report.json`)));
    expect(report.quiet).toBe(true);
    expect(report.stories).toEqual([]);
    expect(report.transcript.length).toBeGreaterThan(0);
    const manifest = Manifest.parse(readJson(join(root, 'site/data/manifest.json')));
    expect(manifest.editions[0]).toMatchObject({ quiet: true, storyCount: 0 });
    expect(manifest.editions[0]?.topHeadline).toBeUndefined();
  });

  it('FORCE_FALLBACK labels the edition as fallback summarization', async () => {
    const { result } = await run({}, { forceFallback: true });
    expect(result.status).toBe('published');
    const report = EditionReport.parse(readJson(join(root, `site/data/editions/${KEY}/report.json`)));
    expect(report.summarization).toBe('fallback');
    expect(report.stories.every((s) => s.explanation.source === 'fallback')).toBe(true);
    expect(Manifest.parse(readJson(join(root, 'site/data/manifest.json'))).editions[0]?.summarization).toBe('fallback');
  });

  it('FORCE_FALLBACK is also read from the environment', async () => {
    process.env.FORCE_FALLBACK = '1';
    try {
      const d = fakeDeps();
      const opts = options();
      delete opts.forceFallback;
      await runEdition(d, opts);
      const report = EditionReport.parse(readJson(join(root, `site/data/editions/${KEY}/report.json`)));
      expect(report.summarization).toBe('fallback');
    } finally {
      delete process.env.FORCE_FALLBACK;
    }
  });

  it('FORCE_NO_AUDIO publishes the written edition flagged as having no audio', async () => {
    const { result, deps } = await run({}, { forceNoAudio: true });
    expect(result.status).toBe('published');
    expect(deps.calls.narrate).toBeUndefined();
    const report = EditionReport.parse(readJson(join(root, `site/data/editions/${KEY}/report.json`)));
    expect(report.audio.available).toBe(false);
    expect(report.audio.unavailableReason).toMatch(/speech/i);
    const manifest = Manifest.parse(readJson(join(root, 'site/data/manifest.json')));
    expect(manifest.editions[0]?.audioPath).toBeUndefined();
    expect(existsSync(join(root, `site/data/editions/${KEY}/audio.mp3`))).toBe(false);
  });

  it('a throwing speech engine degrades to no audio instead of failing the run', async () => {
    const d = fakeDeps();
    d.narrate = async () => {
      throw new Error('piper: command not found');
    };
    const result = await runEdition(d, options());
    expect(result.status).toBe('published');
    const report = EditionReport.parse(readJson(join(root, `site/data/editions/${KEY}/report.json`)));
    expect(report.audio).toMatchObject({ available: false });
  });

  it('does not advance cursors for repos that failed to scan', async () => {
    await writeState({
      schemaVersion: 1,
      repos: { 'bitcoin/bitcoin': { since: '2026-11-09T00:00:00Z', etags: { releases: '"old"' } } },
      stories: {},
    });
    const { result } = await run({ failedRepos: [{ repo: 'bitcoin/bitcoin', reason: 'HTTP 502' }, { repo: 'facebook/react', reason: 'HTTP 404' }] });
    expect(result.status).toBe('published');
    const next = PipelineState.parse(readJson(join(root, 'state/next-state.json')));
    expect(next.repos['bitcoin/bitcoin']).toEqual({ since: '2026-11-09T00:00:00Z', etags: { releases: '"old"' } });
    expect(next.repos['facebook/react']).toBeUndefined();
    expect(next.repos['ollama/ollama']?.since).toBe(now.toISOString());
    const manifest = Manifest.parse(readJson(join(root, 'site/data/manifest.json')));
    expect(manifest.repos.find((r) => r.repo === 'bitcoin/bitcoin')?.lastScannedAt).toBeUndefined();
  });

  it('marks a story whose status advanced since it was last covered', async () => {
    await writeState({
      schemaVersion: 1,
      repos: {},
      stories: {
        'story:release:ollama/ollama:v0.9.0': {
          title: 'v0.9.0',
          repo: 'ollama/ollama',
          status: 'merged',
          firstSeen: '2026-11-08T00:00:00Z',
          lastCoveredAt: '2026-11-09T00:00:00Z',
          lastCoveredEdition: '2026-11-08-evening',
          lastCoveredStatus: 'merged',
          eventIds: [],
          updatedAt: '2026-11-09T00:00:00Z',
        },
      },
    });
    await run({}, { allowEmptyArchive: true });
    const report = EditionReport.parse(readJson(join(root, `site/data/editions/${KEY}/report.json`)));
    expect(report.stories[0]).toMatchObject({ status: 'released', previousStatus: 'merged' });
  });
});

describe('dry run', () => {
  it('writes everything under <workDir>/dry-run and never asks to deploy', async () => {
    const { result } = await run({}, { dryRun: true });
    expect(result.status).toBe('dry-run');
    expect(result.deploy).toBe(false);
    expect(existsSync(join(root, 'site'))).toBe(false);
    expect(existsSync(join(root, 'state/next-state.json'))).toBe(false);
    expect(existsSync(join(root, 'work/dry-run/site/data/manifest.json'))).toBe(true);
    expect(existsSync(join(root, 'work/dry-run/next-state.json'))).toBe(true);
  });
});

describe('replay (calibration dry runs)', () => {
  it('re-collects the requested window from empty state and never deploys', async () => {
    await writeState({ schemaVersion: 1, lastEditionKey: '2026-11-10-morning', repos: { 'a/b': { since: now.toISOString(), etags: {} } }, stories: {} });
    const d = fakeDeps();
    const seen: { lookback?: number; cursors: number }[] = [];
    const collect = d.collect;
    d.collect = (o) => {
      seen.push({ lookback: o.initialLookbackHours, cursors: Object.keys(o.state.repos).length });
      return collect(o);
    };
    const result = await runEdition(d, options({ dryRun: true, replayHours: 36, allowEmptyArchive: true }));
    expect(result.status).toBe('dry-run');
    expect(result.deploy).toBe(false);
    expect(seen).toEqual([{ lookback: 36, cursors: 0 }]);
    expect(result.summary.candidates?.length).toBeGreaterThan(0);
    expect(existsSync(join(root, 'state/next-state.json'))).toBe(false);
  });

  it('refuses replay outside a dry run', async () => {
    const result = await runEdition(fakeDeps(), options({ replayHours: 36, allowEmptyArchive: true }));
    expect(result.status).toBe('failed');
    expect(result.deploy).toBe(false);
  });
});
