import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EditorialConfig, type ManifestRepo } from '../../shared/schemas';
import { buildUserPrompt } from '../llm/prompt';
import { fallbackExplanation } from '../llm/fallback';
import { checkAgainstEvidence } from '../llm/validate';
import { scoreStories, selectStories } from '../score/index';
import { pull } from './event-factory';
import { buildStories, isRoundup } from './index';

const editorial = EditorialConfig.parse(JSON.parse(readFileSync('fixtures/config/editorial.json', 'utf8')));
const REPO = 'lightninglabs/wavelength';
const repoConfig: ManifestRepo = {
  repo: REPO,
  category: 'Bitcoin, lightning',
  priority: 3,
  enabled: true,
  topics: [],
  source: 'config',
  recentStoryIds: [],
};

// Real titles from lightninglabs/wavelength on 2026-11-10 (30 merged that day).
const TITLES = [
  'ci: Allow relay builds to share an image repository',
  'notifyrelay: Keep disabled-token grants retryable',
  'notifyrelay: Bound replay storage per installation',
  'notifyrelay: Support app-verified receipt hints',
  'notifyrelay: Add an authenticated APNs relay',
  'docs: map persistent round runtime and recovery',
  'sdk: expose paused host-driven startup',
  'sdk: Attempt warm receipt recovery and round maintenance',
  'sdk: Verify enrolled Bitcoin invoice receipt sources',
  'sdk: Add background start configuration',
  'mobile: fix round runtime restart after crash',
  'swaps: Add swap status reconciliation',
];

const merged = (n: number, title: string, extra: Partial<Parameters<typeof pull>[2]> = {}) =>
  pull(REPO, 1500 + n, {
    title,
    state: 'merged',
    mergedAt: `2026-11-10T${String(10 + (n % 10)).padStart(2, '0')}:00:00Z`,
    updatedAt: `2026-11-10T${String(10 + (n % 10)).padStart(2, '0')}:00:00Z`,
    repoStars: 58,
    ...extra,
  });

describe('busy-repository roundups', () => {
  it('folds many merged pull requests into one story that clears the reporting threshold', () => {
    const events = TITLES.map((t, i) => merged(i, t, i === 1 ? { labels: ['safety', 'P0'] } : {}));
    const stories = buildStories(events, {});
    expect(stories).toHaveLength(1);
    const roundup = stories[0]!;
    expect(isRoundup(roundup)).toBe(true);
    expect(roundup.title).toBe('12 pull requests merged in wavelength');
    expect(roundup.status).toBe('merged');

    const [scored] = scoreStories(stories, { editorial, repos: [repoConfig] });
    const reasons = scored!.score.dimensions.flatMap((d) => d.signals.map((s) => s.reason));
    expect(reasons).toEqual(
      expect.arrayContaining([
        'Pull request adds new functionality',
        expect.stringMatching(/merged pull requests add functionality/),
        '12 pull requests merged in this window',
        'Labeled as safety work',
        expect.stringMatching(/Matches your topics: bitcoin/),
      ]),
    );
    expect(scored!.score.total).toBeGreaterThanOrEqual(editorial.minScore);
    expect(selectStories([scored!], { schemaVersion: 1, repos: {}, stories: {} }, editorial).selected).toHaveLength(1);
  });

  it('keeps quiet repositories and sensitive pull requests as their own stories', () => {
    const few = buildStories(TITLES.slice(0, 5).map((t, i) => merged(i, t)), {});
    expect(few.some(isRoundup)).toBe(false);

    const withSecurity = buildStories(
      [...TITLES.map((t, i) => merged(i, t)), merged(99, 'auth: fix token vulnerability in relay')],
      {},
    );
    expect(withSecurity.filter(isRoundup)).toHaveLength(1);
    expect(withSecurity.find((s) => !isRoundup(s))?.title).toBe('auth: fix token vulnerability in relay');
  });

  it('gives the model every merged title and asks for a summary, not one PR', () => {
    const stories = buildStories(TITLES.map((t, i) => merged(i, t)), {});
    const [scored] = scoreStories(stories, { editorial, repos: [repoConfig] });
    const prompt = buildUserPrompt(scored!);
    for (const t of TITLES) expect(prompt).toContain(t);
    expect(prompt).toMatch(/roundup of 12 pull requests/);
    expect(prompt).toMatch(/Most active areas: notifyrelay \(4\), sdk \(4\)/);
  });

  it('has a deterministic fallback that summarizes the burst and passes the validator', () => {
    const stories = buildStories(TITLES.map((t, i) => merged(i, t)), {});
    const [scored] = scoreStories(stories, { editorial, repos: [repoConfig] });
    const fallback = fallbackExplanation(scored!, ['test']);
    expect(fallback.headline).toMatch(/wavelength merges 12 changes/);
    expect(fallback.whatHappened).toMatch(/merged 12 pull requests on 2026-11-10/);
    expect(checkAgainstEvidence(fallback, scored!)).toEqual([]);
  });
});

describe('scope-prefixed titles and multi-word categories', () => {
  it('credits "component: Add …" titles as new functionality', () => {
    const [scored] = scoreStories(buildStories([merged(1, 'notifyrelay: Add an authenticated APNs relay')], {}), {
      editorial,
      repos: [repoConfig],
    });
    const capability = scored!.score.dimensions.find((d) => d.key === 'capability')!;
    expect(capability.signals.map((s) => s.reason)).toContain('Pull request adds new functionality');
  });

  it('matches topics inside a category like "Bitcoin, lightning"', () => {
    const [scored] = scoreStories(buildStories([merged(1, 'docs: tidy readme')], {}), { editorial, repos: [repoConfig] });
    const relevance = scored!.score.dimensions.find((d) => d.key === 'relevance')!;
    expect(relevance.signals.map((s) => s.reason)).toContain('Matches your topics: bitcoin');
  });
});
