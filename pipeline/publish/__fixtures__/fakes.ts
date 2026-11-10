/**
 * Test doubles for the stage modules and the live site. They honor the shared
 * contracts but contain no real logic; orchestrator tests use them so the ops
 * layer can be verified without Ollama, Piper or the GitHub API.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { CollectResult, FetchLike } from '../../../shared/contracts';
import {
  bandFor,
  type DevStatus,
  type EditionReport,
  type ExplainedStory,
  type Manifest,
  type ManifestEdition,
  type ManifestRepo,
  type RawEvent,
  type ScoredStory,
  type Story,
  type WatchlistConfig,
} from '../../../shared/schemas';
import type { EditionDeps } from '../orchestrate';

export const SITE = 'https://example.test/TheRepoReport/';

// ───────── fake live site ─────────

export interface FakeResponse {
  status: number;
  body?: string | Uint8Array<ArrayBuffer>;
}

export class FakeSite {
  readonly files = new Map<string, FakeResponse>();
  readonly requests: string[] = [];
  /** URL path (relative to SITE) → error thrown instead of responding. */
  readonly networkErrors = new Set<string>();

  json(path: string, value: unknown, status = 200): this {
    this.files.set(path, { status, body: JSON.stringify(value) });
    return this;
  }

  raw(path: string, response: FakeResponse): this {
    this.files.set(path, response);
    return this;
  }

  fetch: FetchLike = async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    this.requests.push(url);
    const path = url.split('?')[0]!.replace(SITE, '');
    if (this.networkErrors.has(path)) throw new TypeError('fetch failed');
    const file = this.files.get(path);
    if (!file) return new Response('not found', { status: 404 });
    return new Response(file.body ?? null, { status: file.status });
  };
}

// ───────── data builders ─────────

export function event(partial: Partial<RawEvent> & Pick<RawEvent, 'id' | 'kind' | 'repo' | 'title' | 'state'>): RawEvent {
  return {
    body: '',
    url: `https://github.com/${partial.repo}/pull/${partial.number ?? 1}`,
    labels: [],
    refs: [],
    createdAt: '2026-11-10T10:00:00Z',
    updatedAt: '2026-11-10T11:00:00Z',
    ...partial,
  };
}

export function sampleEvents(): RawEvent[] {
  return [
    event({
      id: 'release:ollama/ollama:v0.9.0',
      kind: 'release',
      repo: 'ollama/ollama',
      title: 'v0.9.0',
      tagName: 'v0.9.0',
      state: 'published',
      url: 'https://github.com/ollama/ollama/releases/tag/v0.9.0',
    }),
    event({
      id: 'pull_request:bitcoin/bitcoin#100',
      kind: 'pull_request',
      repo: 'bitcoin/bitcoin',
      number: 100,
      title: 'Speed up block validation',
      state: 'merged',
      url: 'https://github.com/bitcoin/bitcoin/pull/100',
    }),
    event({
      id: 'issue:facebook/react#7',
      kind: 'issue',
      repo: 'facebook/react',
      number: 7,
      title: 'Proposal: new hook',
      state: 'open',
      url: 'https://github.com/facebook/react/issues/7',
    }),
  ];
}

const STATUS_BY_STATE: Record<RawEvent['state'], DevStatus> = {
  published: 'released',
  merged: 'merged',
  open: 'proposed',
  closed: 'merged',
};
const SCORE_BY_STATUS: Record<DevStatus, number> = { released: 80, merged: 60, proposed: 40, in_development: 40, deployed: 90 };

export function explanation(title: string, source: 'llm' | 'fallback') {
  return {
    headline: `News: ${title}`.padEnd(10, '.'),
    whatHappened: `Something happened in ${title} that is worth explaining.`,
    previously: 'Before this change things were different.',
    whatChanged: 'The behavior changed in a specific way.',
    whyItMatters: 'This matters because people rely on it every day.',
    nextConfirmed: '',
    nextSpeculative: '',
    glossary: [],
    analogy: '',
    intermediate: '',
    technical: '',
    source,
    ...(source === 'llm' ? { model: 'fake-model' } : {}),
    validationNotes: source === 'fallback' ? ['forced fallback'] : [],
  };
}

export interface FakeOptions {
  events?: RawEvent[];
  failedRepos?: { repo: string; reason: string }[];
  collectError?: Error;
  /** Score override; set below minScore to simulate a quiet day. */
  scoreFor?: (story: Story) => number;
}

export interface FakeDeps extends EditionDeps {
  calls: Record<string, number>;
}

export function fakeDeps(options: FakeOptions = {}): FakeDeps {
  const calls: Record<string, number> = {};
  const hit = (name: string) => {
    calls[name] = (calls[name] ?? 0) + 1;
  };
  const deps: FakeDeps = {
    calls,
    collect: async ({ watchlist, now }) => {
      hit('collect');
      if (options.collectError) throw options.collectError;
      const failed = options.failedRepos ?? [];
      const repos: ManifestRepo[] = watchlist.repos.map((r) => ({ ...r, source: 'config', recentStoryIds: [] }));
      const nextRepoState: CollectResult['nextRepoState'] = {};
      for (const r of watchlist.repos) {
        if (!failed.some((f) => f.repo === r.repo)) nextRepoState[r.repo] = { since: now.toISOString(), etags: { releases: '"new"' } };
      }
      return {
        events: options.events ?? sampleEvents(),
        repos,
        nextRepoState,
        windowStart: new Date(now.getTime() - 6 * 3600_000).toISOString(),
        windowEnd: now.toISOString(),
        requestCount: 42,
        rateRemaining: 958,
        failedRepos: failed,
      };
    },
    buildStories: (events) => {
      hit('buildStories');
      return events.map((e) => ({
        id: `story:${e.id}`,
        repo: e.repo,
        title: e.title,
        events: [e],
        status: STATUS_BY_STATE[e.state],
        statusEvidenceUrl: e.url,
        categories: [],
        firstSeen: e.createdAt,
        updatedAt: e.updatedAt,
      }));
    },
    scoreStories: (stories) => {
      hit('scoreStories');
      return stories
        .map((s): ScoredStory => {
          const total = options.scoreFor ? options.scoreFor(s) : SCORE_BY_STATUS[s.status];
          return {
            ...s,
            score: {
              total,
              band: bandFor(total),
              dimensions: [{ key: 'capability', max: 20, awarded: Math.min(20, total), signals: [{ points: Math.min(20, total), reason: 'fake' }] }],
              confidence: 'high',
              confidenceReason: 'fake',
            },
          };
        })
        .sort((a, b) => b.score.total - a.score.total);
    },
    selectStories: (scored, _state, editorial) => {
      hit('selectStories');
      const selected = scored.filter((s) => s.score.total >= editorial.minScore && s.status !== 'proposed');
      const watching = scored.filter((s) => s.status === 'proposed' && s.score.total >= editorial.minScore);
      const skipped = scored.filter((s) => !selected.includes(s) && !watching.includes(s)).map((story) => ({ story, reason: 'below threshold' }));
      return { selected, watching, skipped };
    },
    explainStories: async (stories, opts) => {
      hit('explainStories');
      const source = opts.forceFallback ? 'fallback' : 'llm';
      const out: ExplainedStory[] = stories.map((s) => ({ ...s, explanation: explanation(s.title, source) }));
      return {
        stories: out,
        summarization: source,
        ...(source === 'llm' ? { model: opts.model ?? 'fake-model', tokensPerSecond: 12.5 } : {}),
        inferenceSeconds: 3,
      };
    },
    buildScript: ({ stories, edition }) => {
      hit('buildScript');
      const intro = { id: 'intro', kind: 'intro' as const, title: 'Intro', text: `Good ${edition}.`, spokenText: `Good ${edition}.` };
      return [
        intro,
        ...stories.map((s, i) => ({
          id: `story-${i}`,
          kind: 'story' as const,
          title: s.explanation.headline,
          text: s.explanation.whatHappened,
          spokenText: s.explanation.whatHappened,
          storyId: s.id,
        })),
      ];
    },
    narrate: async ({ outFile, voice }) => {
      hit('narrate');
      await mkdir(dirname(outFile), { recursive: true });
      await writeFile(outFile, new Uint8Array(1234).fill(7));
      return { available: true, file: 'audio.mp3', bytes: 1234, durationSec: 61.5, voice, chapters: [{ id: 'intro', title: 'Intro', startSec: 0 }], audioSeconds: 4 };
    },
    buildFeed: ({ manifest }) => {
      hit('buildFeed');
      return `<rss>${manifest.editions.map((e) => `<item>${e.key}</item>`).join('')}</rss>`;
    },
  };
  return deps;
}

export function minimalReport(key: string, date: string, edition: EditionReport['edition'], withAudio = true): EditionReport {
  return {
    schemaVersion: 1,
    key,
    date,
    edition,
    generatedAt: `${date}T12:00:00Z`,
    windowStart: `${date}T06:00:00Z`,
    windowEnd: `${date}T12:00:00Z`,
    summarization: 'llm',
    quiet: true,
    stories: [],
    worthWatching: [],
    transcript: [{ id: 'intro', kind: 'intro', title: 'Intro', text: 'Hi', spokenText: 'Hi' }],
    audio: withAudio
      ? { available: true, file: 'audio.mp3', bytes: 10, durationSec: 5, chapters: [] }
      : { available: false, chapters: [], unavailableReason: 'none' },
    metrics: {},
  };
}

export function manifestEntry(report: EditionReport): ManifestEdition {
  return {
    key: report.key,
    date: report.date,
    edition: report.edition,
    publishedAt: report.generatedAt,
    storyCount: report.stories.length,
    quiet: report.quiet,
    summarization: report.summarization,
    reportPath: `data/editions/${report.key}/report.json`,
    ...(report.audio.available ? { audioPath: `data/editions/${report.key}/audio.mp3`, audioBytes: report.audio.bytes ?? 0 } : {}),
  };
}

export function liveManifest(watchlist: WatchlistConfig, editorial: Manifest['config']['editorial'], reports: EditionReport[]): Manifest {
  return {
    schemaVersion: 1,
    generatedAt: '2026-11-09T12:00:00Z',
    lastSuccessfulScan: '2026-11-09T12:00:00Z',
    retentionDays: 7,
    editions: reports.map(manifestEntry),
    repos: [],
    config: { watchlist, editorial },
  };
}

/** Publish reports (and 10-byte MP3s) on the fake site. */
export function publish(site: FakeSite, manifest: Manifest, reports: EditionReport[]): FakeSite {
  site.json('data/manifest.json', manifest);
  for (const r of reports) {
    site.json(`data/editions/${r.key}/report.json`, r);
    if (r.audio.available) site.raw(`data/editions/${r.key}/audio.mp3`, { status: 200, body: new Uint8Array(r.audio.bytes ?? 0).fill(1) });
  }
  return site;
}
