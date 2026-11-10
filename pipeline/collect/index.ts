/**
 * Incremental GitHub collector. For each enabled repository it reads what
 * changed since that repo's cursor: releases, merged and notable open PRs,
 * signal-bearing issues, and published security advisories.
 *
 * Cursors only advance for repos that scanned cleanly, and the caller stores
 * `nextRepoState` only if the whole run succeeds.
 */
import type { Collect, CollectOptions, CollectResult, Logger } from '../../shared/contracts';
import { RepoSlug, type ManifestRepo, type PipelineState, type RawEvent } from '../../shared/schemas';
import type { GhAdvisory, GhIssue, GhPull, GhRelease, GhRepo } from './github-types';
import { GitHubClient, RepoScanError, type GetResult } from './http';
import {
  advisoryToEvent,
  inWindow,
  isCandidateIssue,
  isCandidatePull,
  issueToEvent,
  pullToEvent,
  releaseToEvent,
  type Extras,
  type Window,
} from './normalize';

export { extractRefs, sanitizeText } from './text';

const DEFAULT_LOOKBACK_HOURS = 36;
const STARRED_MAX_PAGES = 10;
/** Cached repo metadata lives next to its ETag, because a 304 carries no body. */
const META_CACHE_KEY = 'repo:meta';

type RepoCursor = PipelineState['repos'][string];

export interface CollectDeps {
  sleep?: (ms: number) => Promise<void>;
  maxRateWaitMs?: number;
  retryDelayMs?: number;
  clock?: () => number;
}

const consoleLogger: Logger = {
  info: (message, data) => console.log(`[collect] ${message}`, data ?? ''),
  warn: (message, data) => console.warn(`[collect] ${message}`, data ?? ''),
  error: (message, data) => console.error(`[collect] ${message}`, data ?? ''),
};

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Builds a collector; tests inject `sleep` so rate-limit waits are instant. */
export function createCollect(deps: CollectDeps = {}): Collect {
  return (options) => runCollect(options, deps);
}

export const collect: Collect = createCollect();

async function runCollect(options: CollectOptions, deps: CollectDeps): Promise<CollectResult> {
  const logger = options.logger ?? consoleLogger;
  const client = new GitHubClient({
    fetch: options.fetch ?? globalThis.fetch,
    token: options.token,
    logger,
    sleep: deps.sleep ?? realSleep,
    maxRateWaitMs: deps.maxRateWaitMs,
    retryDelayMs: deps.retryDelayMs,
    clock: deps.clock,
  });
  const nowMs = options.now.getTime();
  const nowIso = options.now.toISOString();
  const lookbackMs = (options.initialLookbackHours ?? DEFAULT_LOOKBACK_HOURS) * 3_600_000;

  const repos: ManifestRepo[] = [
    ...options.watchlist.repos.map((r): ManifestRepo => ({ ...r, source: 'config', recentStoryIds: [] })),
    ...(await importStarred(client, options, logger)),
  ];

  const events: RawEvent[] = [];
  const failedRepos: CollectResult['failedRepos'] = [];
  const nextRepoState: PipelineState['repos'] = structuredClone(options.state.repos);
  let windowStart = nowMs;
  const enabled = repos.filter((r) => r.enabled);

  for (const entry of enabled) {
    const previous = options.state.repos[entry.repo];
    const since = cursorStart(previous, nowMs - lookbackMs);
    windowStart = Math.min(windowStart, since);
    try {
      const scan = await scanRepo(client, entry.repo, { since, until: nowMs }, previous?.etags ?? {});
      events.push(...scan.events);
      nextRepoState[entry.repo] = { since: nowIso, etags: scan.etags };
      entry.lastScannedAt = nowIso;
      if (scan.lastActivityAt) entry.lastActivityAt = scan.lastActivityAt;
      logger.info('scanned repository', { repo: entry.repo, events: scan.events.length });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      failedRepos.push({ repo: entry.repo, reason });
      logger.warn('repository scan failed; cursor kept', { repo: entry.repo, reason });
    }
  }

  logger.info('collection finished', {
    repos: enabled.length,
    failed: failedRepos.length,
    events: events.length,
    requests: client.requestCount,
    rateRemaining: client.rateRemaining,
  });
  if (enabled.length > 0 && failedRepos.length === enabled.length) {
    throw new Error(`All ${enabled.length} repositories failed to scan; state must not advance`);
  }

  return {
    events,
    repos,
    nextRepoState,
    windowStart: new Date(windowStart).toISOString(),
    windowEnd: nowIso,
    requestCount: client.requestCount,
    rateRemaining: client.rateRemaining,
    failedRepos,
  };
}

function cursorStart(previous: RepoCursor | undefined, fallback: number): number {
  const parsed = previous ? Date.parse(previous.since) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

interface RepoScan {
  events: RawEvent[];
  etags: Record<string, string>;
  lastActivityAt?: string;
}

async function scanRepo(
  client: GitHubClient,
  repo: string,
  window: Window,
  previousEtags: Record<string, string>,
): Promise<RepoScan> {
  const etags: Record<string, string> = { ...previousEtags };
  const remember = (key: string, etag: string | undefined) => {
    if (etag) etags[key] = etag;
  };

  const meta = await fetchRepoMeta(client, repo, etags);
  const extras: Extras = { repoStars: meta.stars };
  const sinceIso = new Date(window.since).toISOString();
  const olderThanCursor = (iso: string | null | undefined) => !iso || Date.parse(iso) <= window.since;

  const releases = await client.getPaged<GhRelease>(`/repos/${repo}/releases?per_page=30`, {
    etag: previousEtags.releases,
    maxPages: 3,
    stopWhen: (page) => page.every((r) => olderThanCursor(r.published_at ?? r.created_at)),
  });
  remember('releases', releases.etag);

  const pulls = await client.getPaged<GhPull>(
    `/repos/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=50`,
    { etag: previousEtags.pulls, maxPages: 4, stopWhen: (page) => page.some((p) => olderThanCursor(p.updated_at)) },
  );
  remember('pulls', pulls.etag);

  // The issues URL embeds the cursor, so an ETag would never match; skip it.
  const issues = await client.getPaged<GhIssue>(
    `/repos/${repo}/issues?state=all&sort=updated&direction=desc&per_page=100&since=${encodeURIComponent(sinceIso)}`,
    { maxPages: 3 },
  );

  // Advisories are often unavailable (feature off, or token lacks access): treat as none.
  const advisories = await client.getPaged<GhAdvisory>(
    `/repos/${repo}/security-advisories?state=published&sort=published&direction=desc&per_page=30`,
    { etag: previousEtags.advisories, maxPages: 1, allowMissing: true },
  );
  remember('advisories', advisories.etag);

  const events: RawEvent[] = [
    ...releases.items
      .filter((r) => !r.draft && inWindow(r.published_at, window))
      .map((r) => releaseToEvent(repo, r, extras)),
    ...pulls.items
      .filter((p) => inWindow(p.updated_at, window) && isCandidatePull(p))
      .map((p) => pullToEvent(repo, p, extras)),
    ...issues.items
      .filter((i) => inWindow(i.updated_at, window) && isCandidateIssue(i))
      .map((i) => issueToEvent(repo, i, extras)),
    ...advisories.items
      .filter((a) => inWindow(a.published_at, window))
      .map((a) => advisoryToEvent(repo, a, extras)),
  ];

  return { events, etags, lastActivityAt: latest([meta.pushedAt, ...events.map((e) => e.updatedAt)]) };
}

interface RepoMeta {
  stars?: number;
  pushedAt?: string;
}

async function fetchRepoMeta(client: GitHubClient, repo: string, etags: Record<string, string>): Promise<RepoMeta> {
  const result = await client.get<GhRepo>(`/repos/${repo}`, { etag: etags.repo });
  if (result.kind === 'not_modified') return parseMetaCache(etags[META_CACHE_KEY]);
  if (result.kind === 'missing') throw new RepoScanError(`repository ${repo} not found`);
  const meta: RepoMeta = {
    stars: result.data.stargazers_count,
    pushedAt: result.data.pushed_at ?? undefined,
  };
  if (result.etag) {
    etags.repo = result.etag;
    etags[META_CACHE_KEY] = JSON.stringify(meta);
  }
  return meta;
}

function parseMetaCache(raw: string | undefined): RepoMeta {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Partial<RepoMeta>;
    return {
      stars: typeof parsed.stars === 'number' ? parsed.stars : undefined,
      pushedAt: typeof parsed.pushedAt === 'string' ? parsed.pushedAt : undefined,
    };
  } catch {
    return {};
  }
}

function latest(values: (string | undefined)[]): string | undefined {
  let best: string | undefined;
  for (const v of values) {
    if (v && (!best || Date.parse(v) > Date.parse(best))) best = v;
  }
  return best;
}

/**
 * Adds the user's public stars, never pushing the total past maxRepos.
 * Config entries win: a starred repo already in config is not duplicated.
 * A failure here is logged and ignored, since the config watchlist still works.
 */
async function importStarred(client: GitHubClient, options: CollectOptions, logger: Logger): Promise<ManifestRepo[]> {
  const { watchlist } = options;
  if (!watchlist.includeStarred || !watchlist.githubUser) return [];
  const room = watchlist.maxRepos - watchlist.repos.length;
  if (room <= 0) return [];

  const seen = new Set(watchlist.repos.map((r) => r.repo.toLowerCase()));
  const imported: ManifestRepo[] = [];
  let url: string | undefined = `/users/${encodeURIComponent(watchlist.githubUser)}/starred?per_page=100`;
  try {
    for (let page = 0; url && page < STARRED_MAX_PAGES && imported.length < room; page++) {
      const result: GetResult<GhRepo[]> = await client.get<GhRepo[]>(url, { allowMissing: true });
      if (result.kind !== 'ok') break;
      for (const repo of result.data) {
        if (imported.length >= room) break;
        const key = repo.full_name.toLowerCase();
        if (seen.has(key) || !RepoSlug.safeParse(repo.full_name).success) continue;
        seen.add(key);
        imported.push({
          repo: repo.full_name,
          category: 'Starred',
          priority: 1,
          enabled: !repo.archived,
          topics: repo.topics ?? [],
          source: 'starred',
          recentStoryIds: [],
        });
      }
      url = result.next;
    }
  } catch (err) {
    logger.warn('starred import failed; continuing with config watchlist', {
      reason: err instanceof Error ? err.message : String(err),
    });
  }
  return imported;
}
