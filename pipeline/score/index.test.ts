import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  EditorialConfig,
  ManifestRepo,
  ScoredStory,
  WatchlistConfig,
  emptyState,
  type PipelineState,
  type RawEvent,
  type Story,
} from '../../shared/schemas';
import { fakeGitHub, loadFixture } from '../collect/fake-github';
import { createCollect } from '../collect/index';
import { advisory, issue, pull, release } from '../stories/event-factory';
import { buildStories } from '../stories/index';
import { parseSemver, scoreStories, selectStories } from './index';

const editorial = EditorialConfig.parse(JSON.parse(readFileSync(new URL('../../config/editorial.json', import.meta.url), 'utf8')));
const REPO = 'acme/lib';

function repoEntry(repo: string, overrides: Partial<ManifestRepo> = {}): ManifestRepo {
  return ManifestRepo.parse({ repo, category: 'Tools', priority: 2, topics: [], source: 'config', ...overrides });
}

function storyOf(events: RawEvent[], status: Story['status'] = 'merged', id = `s_${events[0]!.id}`): Story {
  return {
    id,
    repo: events[0]!.repo,
    title: events[0]!.title,
    events,
    status,
    statusEvidenceUrl: events[0]!.url,
    categories: [],
    firstSeen: events[0]!.createdAt,
    updatedAt: events[0]!.updatedAt,
  };
}

const dim = (s: ScoredStory, key: string) => s.score.dimensions.find((d) => d.key === key)!;

describe('scoreStories on recorded fixtures', () => {
  it('ranks a critical advisory in a small repo above routine work in a 212k-star repo', async () => {
    const github = fakeGitHub(loadFixture('acme-tinycrypt'), loadFixture('mega-framework'));
    const collected = await createCollect({ sleep: async () => {} })({
      watchlist: WatchlistConfig.parse({
        version: 1,
        repos: [
          { repo: 'acme/tinycrypt', category: 'Security', topics: ['security'] },
          { repo: 'mega/framework', category: 'Web', topics: ['web'] },
        ],
      }),
      state: emptyState(),
      now: new Date('2026-11-10T12:00:00Z'),
      fetch: github.fetch,
      logger: { info() {}, warn() {}, error() {} },
    });
    const scored = scoreStories(buildStories(collected.events, {}), { editorial, repos: collected.repos });

    const top = scored[0]!;
    expect(top.repo).toBe('acme/tinycrypt');
    expect(top.score.total).toBeGreaterThanOrEqual(editorial.minScore);
    expect(dim(top, 'security').awarded).toBe(25);
    expect(top.score.confidence).toBe('high');
    expect(top.categories[0]).toBe('Security');
    for (const other of scored.filter((s) => s.repo === 'mega/framework')) {
      expect(other.score.total).toBeLessThan(top.score.total);
      expect(other.score.total).toBeLessThan(editorial.minScore);
    }
    expect(top.score.ranksAboveNext).toMatch(/^Ranks above ".+" \(mega\/framework\) on security \(\+25: security advisory GHSA-2c4f-8mxq-3vh7 rated critical severity\)/);
    for (const s of scored) expect(() => ScoredStory.parse(s)).not.toThrow();

    const selection = selectStories(scored, emptyState(), editorial);
    expect(selection.selected.map((s) => s.repo)).toEqual(['acme/tinycrypt']);
  });

  it('gives the prompt-injection PR no points for what its body says', async () => {
    const github = fakeGitHub(loadFixture('mega-framework'));
    const collected = await createCollect({ sleep: async () => {} })({
      watchlist: WatchlistConfig.parse({ version: 1, repos: [{ repo: 'mega/framework' }] }),
      state: emptyState(),
      now: new Date('2026-11-10T12:00:00Z'),
      fetch: github.fetch,
      logger: { info() {}, warn() {}, error() {} },
    });
    const scored = scoreStories(buildStories(collected.events, {}), { editorial, repos: collected.repos });
    const injected = scored.find((s) => s.events.some((e) => e.number === 5004))!;
    expect(injected.status).toBe('in_development');
    expect(injected.score.total).toBeLessThan(editorial.minScore);
    expect(injected.score.confidence).toBe('low');
  });
});

describe('scoreStories rubric', () => {
  const everything = (): Story =>
    storyOf(
      [
        advisory(REPO, 'GHSA-aaaa-bbbb-cccc', { severity: 'critical', cveId: 'CVE-2026-1111', repoStars: 300_000 }),
        release(REPO, 'v3.0.0', {
          title: 'v3.0.0',
          body: '## Features\n- feat: new engine\n## BREAKING CHANGES\n- removed the legacy API\n- deprecated flags',
          repoStars: 300_000,
        }),
        pull(REPO, 9, {
          title: 'feat!: fix crash and memory leak, faster startup (RCE hardening)',
          labels: ['security', 'breaking', 'feature', 'performance', 'bug', 'deprecation'],
          comments: 80,
          reactions: 200,
          repoStars: 300_000,
        }),
      ],
      'released',
    );

  it('never lets a dimension exceed its configured maximum', () => {
    const [scored] = scoreStories([everything()], {
      editorial,
      repos: [repoEntry(REPO, { priority: 3, topics: ['security', 'ai', 'bitcoin'] })],
    });
    for (const d of scored!.score.dimensions) {
      expect(d.awarded).toBeLessThanOrEqual(d.max);
      expect(d.max).toBe(editorial.weights[d.key]);
    }
    expect(scored!.score.total).toBeLessThanOrEqual(100);
    expect(scored!.score.band).toBe('critical');
  });

  it('scales signals and caps to custom weights', () => {
    const weights = { security: 10, breaking: 10, capability: 10, reliability: 10, ecosystem: 30, relevance: 30 };
    const [scored] = scoreStories([everything()], { editorial: { ...editorial, weights }, repos: [repoEntry(REPO)] });
    expect(dim(scored!, 'security')).toMatchObject({ max: 10, awarded: 10 });
    expect(dim(scored!, 'ecosystem').max).toBe(30);
  });

  it('records a reason and evidence URL for every awarded signal', () => {
    const [scored] = scoreStories([everything()], { editorial, repos: [repoEntry(REPO, { topics: ['security'] })] });
    for (const d of scored!.score.dimensions) {
      if (d.awarded > 0) expect(d.signals.length).toBeGreaterThan(0);
      for (const signal of d.signals) {
        expect(signal.points).toBeGreaterThan(0);
        expect(signal.reason.length).toBeGreaterThan(5);
        expect(signal.evidenceUrl).toMatch(/^https:\/\/github\.com\//);
      }
    }
    const reasons = scored!.score.dimensions.flatMap((d) => d.signals.map((s) => s.reason));
    expect(reasons).toEqual(
      expect.arrayContaining([
        'Security advisory GHSA-aaaa-bbbb-cccc rated critical severity',
        'Assigned CVE-2026-1111',
        'Major version release v3.0.0',
        'Explicit breaking-change marker',
      ]),
    );
  });

  it('awards points only on evidence: stars alone earn nothing', () => {
    const [scored] = scoreStories([storyOf([issue(REPO, 1, { title: 'Question', repoStars: 250_000 })], 'proposed')], {
      editorial,
      repos: [],
    });
    expect(scored!.score.total).toBe(0);
    for (const key of ['security', 'breaking', 'capability', 'reliability', 'ecosystem', 'relevance']) {
      expect(dim(scored!, key).awarded).toBe(0);
    }
  });

  it('maps repo priority and topic overlap to relevance', () => {
    const story = storyOf([pull(REPO, 1, { labels: ['bitcoin'] })]);
    const [high] = scoreStories([story], { editorial, repos: [repoEntry(REPO, { priority: 3, topics: ['ai'] })] });
    expect(dim(high!, 'relevance').awarded).toBe(10);
    const [low] = scoreStories([story], { editorial: { ...editorial, topics: [] }, repos: [repoEntry(REPO, { priority: 1 })] });
    expect(dim(low!, 'relevance').awarded).toBe(1);
  });

  it('parses semver from common tag shapes', () => {
    expect(parseSemver('v1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(parseSemver('2.0')).toEqual({ major: 2, minor: 0, patch: 0 });
    expect(parseSemver('lnd/v0.19.0-beta')).toEqual({ major: 0, minor: 19, patch: 0 });
    expect(parseSemver('nightly')).toBeUndefined();
  });
});

describe('confidence', () => {
  const confidenceOf = (events: RawEvent[]) =>
    scoreStories([storyOf(events)], { editorial, repos: [] })[0]!.score;

  it('is high when two independent primary sources agree', () => {
    expect(confidenceOf([release(REPO, 'v1.0.1'), pull(REPO, 2)]).confidence).toBe('high');
    expect(confidenceOf([advisory(REPO, 'GHSA-aaaa-bbbb-cccc', { cveId: 'CVE-2026-2222' })]).confidence).toBe('high');
  });

  it('is medium for one authoritative source', () => {
    const score = confidenceOf([pull(REPO, 2)]);
    expect(score.confidence).toBe('medium');
    expect(score.confidenceReason).toContain('merged pull request');
    expect(confidenceOf([release(REPO, 'v1.0.1')]).confidence).toBe('medium');
    expect(confidenceOf([advisory(REPO, 'GHSA-aaaa-bbbb-cccc')]).confidence).toBe('medium');
  });

  it('is low for open proposals only', () => {
    expect(confidenceOf([issue(REPO, 3), pull(REPO, 4, { state: 'open', mergedAt: undefined })]).confidence).toBe('low');
  });
});

describe('ordering and ranksAboveNext', () => {
  it('sorts by total, then status, and explains each step', () => {
    const security = storyOf([advisory(REPO, 'GHSA-aaaa-bbbb-cccc', { title: 'Auth bypass', severity: 'high' })], 'released', 's_sec');
    const feature = storyOf([pull(REPO, 2, { title: 'Add dark mode', labels: ['feature'] })], 'merged', 's_feat');
    const proposal = storyOf([issue(REPO, 3, { title: 'Add dark mode toggle', labels: ['feature'] })], 'proposed', 's_prop');
    const scored = scoreStories([proposal, feature, security], { editorial, repos: [] });

    expect(scored.map((s) => s.id)).toEqual(['s_sec', 's_feat', 's_prop']);
    expect(scored[0]!.score.ranksAboveNext).toBe(
      'Ranks above "Add dark mode" (acme/lib) on security (+25: security advisory GHSA-aaaa-bbbb-cccc rated high severity) and relevance (+3: matches your topics: security).',
    );
    expect(scored[2]!.score.ranksAboveNext).toBeUndefined();
  });

  it('breaks score ties by development status', () => {
    const merged = storyOf([pull(REPO, 1, { title: 'Tidy code' })], 'merged', 's_a');
    const proposed = storyOf([issue(REPO, 2, { title: 'Tidy code' })], 'proposed', 's_b');
    const scored = scoreStories([proposed, merged], { editorial: { ...editorial, weights: { ...editorial.weights, ecosystem: 0 } }, repos: [] });
    expect(scored.map((s) => s.id)).toEqual(['s_a', 's_b']);
    expect(scored[0]!.score.ranksAboveNext).toMatch(/^Ties with "Tidy code".*status is further along/);
  });
});

describe('selectStories', () => {
  function scoredStory(id: string, total: number, status: Story['status']): ScoredStory {
    const base = storyOf([pull(REPO, Number(id.replace(/\D/g, '')) || 1)], status, id);
    return {
      ...base,
      score: { total, band: 'notable', dimensions: [], confidence: 'medium', confidenceReason: 'test' },
    };
  }
  const stateWith = (stories: PipelineState['stories']): PipelineState => ({ ...emptyState(), stories });
  const covered = (status: Story['status']) => ({
    title: 't',
    repo: REPO,
    status,
    firstSeen: '2026-11-08T00:00:00Z',
    lastCoveredAt: '2026-11-09T12:00:00Z',
    lastCoveredEdition: '2026-11-09-morning',
    lastCoveredStatus: status,
    eventIds: [],
    updatedAt: '2026-11-09T12:00:00Z',
  });

  it('selects stories at or above the threshold, capped by maxStories', () => {
    const scored = [scoredStory('s1', 80, 'released'), scoredStory('s2', 60, 'merged'), scoredStory('s3', 35, 'merged'), scoredStory('s4', 34, 'merged')];
    const result = selectStories(scored, emptyState(), { ...editorial, maxStories: 2 });
    expect(result.selected.map((s) => s.id)).toEqual(['s1', 's2']);
    expect(result.skipped.map((s) => [s.story.id, s.reason])).toEqual([
      ['s3', 'Scored 35 but the edition is capped at 2 stories.'],
      ['s4', 'Scored 34, below the 35-point threshold.'],
    ]);
  });

  it('excludes stories already covered at the same status', () => {
    const scored = [scoredStory('s1', 80, 'merged')];
    const result = selectStories(scored, stateWith({ s1: covered('merged') }), editorial);
    expect(result.selected).toEqual([]);
    expect(result.skipped[0]!.reason).toMatch(/Already covered as merged/);
  });

  it('includes a covered story whose status advanced', () => {
    const scored = [scoredStory('s1', 80, 'released')];
    const result = selectStories(scored, stateWith({ s1: covered('merged') }), editorial);
    expect(result.selected.map((s) => s.id)).toEqual(['s1']);
  });

  it('puts near-threshold proposals in worth watching, capped at four', () => {
    const scored = [
      scoredStory('s1', 30, 'proposed'),
      scoredStory('s2', 25, 'in_development'),
      scoredStory('s3', 22, 'proposed'),
      scoredStory('s4', 21, 'proposed'),
      scoredStory('s5', 20, 'proposed'),
      scoredStory('s6', 19, 'proposed'),
      scoredStory('s7', 30, 'merged'),
    ];
    const result = selectStories(scored, emptyState(), editorial);
    expect(result.watching.map((s) => s.id)).toEqual(['s1', 's2', 's3', 's4']);
    expect(result.skipped.map((s) => s.story.id)).toEqual(['s5', 's6', 's7']);
  });

  it('returns an empty selection on a quiet day', () => {
    expect(selectStories([], emptyState(), editorial)).toEqual({ selected: [], watching: [], skipped: [] });
    const low = selectStories([scoredStory('s1', 5, 'merged')], emptyState(), editorial);
    expect(low.selected).toEqual([]);
    expect(low.watching).toEqual([]);
  });
});
