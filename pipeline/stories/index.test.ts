import { describe, expect, it } from 'vitest';
import { WatchlistConfig, emptyState, type PipelineState, type StoryState } from '../../shared/schemas';
import { fakeGitHub, loadFixture } from '../collect/fake-github';
import { createCollect } from '../collect/index';
import { advisory, issue, pull, release } from './event-factory';
import { buildStories, storyIdFor, urlForEventId } from './index';

const REPO = 'acme/lib';

function knownStory(overrides: Partial<StoryState>): StoryState {
  return {
    title: 'Known story',
    repo: REPO,
    status: 'merged',
    firstSeen: '2026-11-08T10:00:00Z',
    eventIds: [],
    updatedAt: '2026-11-09T10:00:00Z',
    ...overrides,
  };
}

describe('buildStories grouping', () => {
  it('folds a PR, the issue it fixes and the release that ships it into one story', () => {
    const events = [
      issue(REPO, 11, { title: 'Parser crashes on empty input', labels: ['bug'] }),
      pull(REPO, 12, { title: 'Fix parser crash on empty input', refs: [`${REPO}#11`] }),
      release(REPO, 'v1.4.2', { body: '- Fix parser crash (#12)', refs: [`${REPO}#12`] }),
      pull(REPO, 13, { title: 'Unrelated docs tweak' }),
    ];
    const stories = buildStories(events, {});
    expect(stories).toHaveLength(2);
    const main = stories.find((s) => s.events.length === 3)!;
    expect(main.events.map((e) => e.kind).sort()).toEqual(['issue', 'pull_request', 'release']);
    expect(main.title).toBe('Fix parser crash on empty input');
    expect(main.status).toBe('released');
    expect(main.statusEvidenceUrl).toBe(`https://github.com/${REPO}/releases/tag/v1.4.2`);
    expect(main.categories).toEqual(expect.arrayContaining(['Bug fix', 'Release']));
  });

  it('links a release to a PR whose title its notes quote without a number', () => {
    const events = [
      pull(REPO, 20, { title: 'feat: streaming responses for the chat API' }),
      release(REPO, 'v2.0.0', { body: '## Features\n- Streaming responses for the chat API' }),
    ];
    expect(buildStories(events, {})).toHaveLength(1);
  });

  it('keeps an advisory as its own story unless it references a PR', () => {
    const lone = buildStories([advisory(REPO, 'GHSA-aaaa-bbbb-cccc'), pull(REPO, 30)], {});
    expect(lone).toHaveLength(2);

    const linked = buildStories(
      [advisory(REPO, 'GHSA-aaaa-bbbb-cccc', { refs: [`${REPO}#30`] }), pull(REPO, 30)],
      {},
    );
    expect(linked).toHaveLength(1);
    expect(linked[0]!.title).toBe('Advisory GHSA-aaaa-bbbb-cccc');
  });

  it('does not merge two issues just because one mentions the other', () => {
    const events = [issue(REPO, 1, { refs: [`${REPO}#2`] }), issue(REPO, 2)];
    expect(buildStories(events, {})).toHaveLength(2);
  });

  it('joins near-identical same-repo titles conservatively', () => {
    const joined = buildStories(
      [
        issue(REPO, 40, { title: 'Crash when parsing empty config file' }),
        pull(REPO, 41, { title: 'Fix crash when parsing empty config file' }),
      ],
      {},
    );
    expect(joined).toHaveLength(1);

    const separate = buildStories(
      [
        issue(REPO, 40, { title: 'Crash when parsing empty config file' }),
        pull(REPO, 42, { title: 'Add YAML config file support' }),
        pull('other/repo', 43, { title: 'Fix crash when parsing empty config file' }),
      ],
      {},
    );
    expect(separate).toHaveLength(3);
  });

  it('assigns stable ids derived from the earliest event', () => {
    const events = [issue(REPO, 11), pull(REPO, 12, { refs: [`${REPO}#11`] })];
    const a = buildStories(events, {});
    const b = buildStories([...events].reverse(), {});
    expect(a[0]!.id).toBe(b[0]!.id);
    expect(a[0]!.id).toBe(storyIdFor(`issue:${REPO}#11`));
    expect(a[0]!.id).toMatch(/^s_[0-9a-f]{12}$/);
  });

  it('deduplicates the same event delivered twice', () => {
    const stories = buildStories([pull(REPO, 5), pull(REPO, 5, { updatedAt: '2026-11-10T09:00:00Z' })], {});
    expect(stories).toHaveLength(1);
    expect(stories[0]!.events).toHaveLength(1);
    expect(stories[0]!.updatedAt).toBe('2026-11-10T09:00:00Z');
  });

  it('returns nothing for a quiet day', () => {
    expect(buildStories([], {})).toEqual([]);
  });
});

describe('buildStories continuity with known state', () => {
  it('keeps the story id when a PR merged yesterday ships in a release today, and advances status', () => {
    const yesterdayId = storyIdFor(`pull_request:${REPO}#10`);
    const known: PipelineState['stories'] = {
      [yesterdayId]: knownStory({
        title: 'Add retry budget',
        status: 'merged',
        lastCoveredStatus: 'merged',
        eventIds: [`pull_request:${REPO}#10`],
      }),
    };
    const today = [release(REPO, 'v1.5.0', { body: 'Highlights: retry budget (#10)', refs: [`${REPO}#10`] })];
    const [story] = buildStories(today, known);
    expect(story!.id).toBe(yesterdayId);
    expect(story!.status).toBe('released');
    expect(story!.statusEvidenceUrl).toBe(`https://github.com/${REPO}/releases/tag/v1.5.0`);
    expect(story!.firstSeen).toBe('2026-11-08T10:00:00Z');
  });

  it('re-attaches an event already folded into a known story', () => {
    const known = { s_known000001: knownStory({ status: 'in_development', eventIds: [`pull_request:${REPO}#10`] }) };
    const [story] = buildStories([pull(REPO, 10)], known);
    expect(story!.id).toBe('s_known000001');
    expect(story!.status).toBe('merged');
  });

  it('never regresses below a status established earlier, citing the earlier evidence', () => {
    const known = {
      s_known000002: knownStory({
        status: 'released',
        eventIds: [`pull_request:${REPO}#10`, `release:${REPO}:v1.5.0`],
      }),
    };
    const followUp = issue(REPO, 77, { title: 'Question about the retry budget', refs: [`${REPO}#10`] });
    const [story] = buildStories([followUp], known);
    expect(story!.id).toBe('s_known000002');
    expect(story!.status).toBe('released');
    expect(story!.statusEvidenceUrl).toBe(`https://github.com/${REPO}/releases/tag/v1.5.0`);
  });
});

describe('buildStories status', () => {
  const statusOf = (...events: Parameters<typeof buildStories>[0]) => buildStories(events, {})[0]!.status;

  it('keeps merged distinct from released', () => {
    expect(statusOf(pull(REPO, 1, { state: 'merged' }))).toBe('merged');
  });

  it('classifies open work as in development or proposed', () => {
    expect(statusOf(pull(REPO, 1, { state: 'open', mergedAt: undefined }))).toBe('in_development');
    expect(statusOf(pull(REPO, 1, { state: 'open', draft: true, mergedAt: undefined }))).toBe('proposed');
    expect(statusOf(issue(REPO, 2, { state: 'open' }))).toBe('proposed');
  });

  it('treats an open PR untouched for over a week as proposed', () => {
    const stale = pull(REPO, 1, { state: 'open', mergedAt: undefined, updatedAt: '2026-10-20T00:00:00Z' });
    const fresh = issue(REPO, 2, { updatedAt: '2026-11-10T00:00:00Z' });
    const stories = buildStories([stale, fresh], {});
    expect(stories.find((s) => s.events[0]!.kind === 'pull_request')!.status).toBe('proposed');
  });

  it('treats a prerelease as merged code, not a release', () => {
    expect(statusOf(release(REPO, 'v2.0.0-rc.1', { prerelease: true }))).toBe('merged');
  });

  it('marks an advisory released only when a patched version exists', () => {
    expect(statusOf(advisory(REPO, 'GHSA-aaaa-bbbb-cccc', { body: 'Patched versions: 1.2.3\n\nDetails' }))).toBe('released');
    expect(statusOf(advisory(REPO, 'GHSA-aaaa-bbbb-cccc', { body: 'No fix yet.' }))).toBe('proposed');
  });

  it('never emits deployed', () => {
    const s = statusOf(release(REPO, 'v1.0.0', { body: 'Deployed to production everywhere!' }));
    expect(s).toBe('released');
  });
});

describe('urlForEventId', () => {
  it('rebuilds GitHub URLs from stable event ids', () => {
    expect(urlForEventId('pull_request:a/b#3')).toBe('https://github.com/a/b/pull/3');
    expect(urlForEventId('issue:a/b#4')).toBe('https://github.com/a/b/issues/4');
    expect(urlForEventId('release:a/b:v1.0.0')).toBe('https://github.com/a/b/releases/tag/v1.0.0');
    expect(urlForEventId('advisory:GHSA-aaaa-bbbb-cccc')).toBe('https://github.com/advisories/GHSA-aaaa-bbbb-cccc');
  });
});

describe('collect → buildStories on recorded fixtures', () => {
  it('turns the tinycrypt advisory, fix PR, issue and patch release into one released story', async () => {
    const github = fakeGitHub(loadFixture('acme-tinycrypt'));
    const collect = createCollect({ sleep: async () => {} });
    const result = await collect({
      watchlist: WatchlistConfig.parse({ version: 1, repos: [{ repo: 'acme/tinycrypt' }] }),
      state: emptyState(),
      now: new Date('2026-11-10T12:00:00Z'),
      fetch: github.fetch,
      logger: { info() {}, warn() {}, error() {} },
    });
    const stories = buildStories(result.events, {});
    expect(stories).toHaveLength(1);
    expect(stories[0]!.events).toHaveLength(4);
    expect(stories[0]!.status).toBe('released');
    expect(stories[0]!.title).toBe('Signature verification bypass in tinycrypt');
  });
});
