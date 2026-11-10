/** Pure builders for the published report and manifest. */
import type { CollectResult } from '../../shared/contracts';
import {
  EDITIONS,
  EditionReport,
  Manifest,
  STATUS_LABELS,
  type EditionName,
  type ExplainedStory,
  type ManifestEdition,
  type ManifestRepo,
  type PipelineState,
  type RawEvent,
  type ReportStory,
  type ScoredStory,
} from '../../shared/schemas';
import { previousStatusIfAdvanced } from '../state/index';
import { expectedAudioPath, expectedReportPath } from './archive';
import type { ProductionConfig } from './config';

export function linkLabel(event: RawEvent): string {
  switch (event.kind) {
    case 'release':
      return `Release ${event.tagName ?? event.title}`;
    case 'pull_request':
      return event.number !== undefined ? `Pull request #${event.number}` : 'Pull request';
    case 'issue':
      return event.number !== undefined ? `Issue #${event.number}` : 'Issue';
    case 'discussion':
      return event.number !== undefined ? `Discussion #${event.number}` : 'Discussion';
    case 'advisory':
      return `Security advisory ${event.ghsaId ?? event.cveId ?? ''}`.trim();
  }
}

export function toReportStory(story: ExplainedStory, registry: PipelineState['stories']): ReportStory {
  const seen = new Set<string>();
  const links: ReportStory['links'] = [];
  for (const event of story.events) {
    if (seen.has(event.url)) continue;
    seen.add(event.url);
    links.push({ label: linkLabel(event), url: event.url, kind: event.kind });
  }
  const previousStatus = previousStatusIfAdvanced(registry[story.id], story.status);
  return {
    id: story.id,
    repo: story.repo,
    status: story.status,
    statusEvidenceUrl: story.statusEvidenceUrl,
    ...(previousStatus ? { previousStatus } : {}),
    categories: story.categories,
    score: story.score,
    explanation: story.explanation,
    links,
    updatedAt: story.updatedAt,
  };
}

export function toWatchItem(story: ScoredStory): EditionReport['worthWatching'][number] {
  return {
    title: story.title,
    repo: story.repo,
    url: story.statusEvidenceUrl,
    status: story.status,
    note: `${STATUS_LABELS[story.status]}; impact score ${story.score.total} (${story.score.band}). Nothing has shipped yet.`,
  };
}

/** Newest first: by date, then evening > afternoon > morning. */
export function compareEditionsDesc(a: { date: string; edition: EditionName }, b: { date: string; edition: EditionName }): number {
  if (a.date !== b.date) return a.date < b.date ? 1 : -1;
  return EDITIONS.indexOf(b.edition) - EDITIONS.indexOf(a.edition);
}

export function manifestEntryFor(report: EditionReport, publishedAt: string): ManifestEdition {
  const top = report.stories[0];
  const entry: ManifestEdition = {
    key: report.key,
    date: report.date,
    edition: report.edition,
    publishedAt,
    storyCount: report.stories.length,
    quiet: report.quiet,
    summarization: report.summarization,
    reportPath: expectedReportPath(report.key),
  };
  if (top) {
    entry.topHeadline = top.explanation.headline;
    entry.topScore = top.score.total;
  }
  if (report.audio.available && report.audio.file) {
    entry.audioPath = expectedAudioPath(report.key);
    if (report.audio.bytes !== undefined) entry.audioBytes = report.audio.bytes;
    if (report.audio.durationSec !== undefined) entry.durationSec = report.audio.durationSec;
  }
  return entry;
}

export interface ManifestInput {
  now: Date;
  config: ProductionConfig;
  newEntry: ManifestEdition;
  carried: readonly ManifestEdition[];
  /** All reports that will be on the site (new + carried), keyed by edition key. */
  reports: Record<string, EditionReport>;
  collect: Pick<CollectResult, 'repos' | 'events' | 'failedRepos'>;
  previous: Manifest | null;
}

export function buildRepos(input: ManifestInput): ManifestRepo[] {
  const failed = new Set(input.collect.failedRepos.map((f) => f.repo));
  const prevBySlug = new Map((input.previous?.repos ?? []).map((r) => [r.repo, r]));
  const latestActivity = new Map<string, string>();
  for (const event of input.collect.events) {
    const cur = latestActivity.get(event.repo);
    if (!cur || event.updatedAt > cur) latestActivity.set(event.repo, event.updatedAt);
  }
  const orderedReports = Object.values(input.reports).sort(compareEditionsDesc);
  return input.collect.repos.map((repo) => {
    const prev = prevBySlug.get(repo.repo);
    const recent: string[] = [];
    for (const report of orderedReports) {
      for (const story of report.stories) {
        if (story.repo === repo.repo && !recent.includes(story.id)) recent.push(story.id);
      }
    }
    const scanned = repo.enabled && !failed.has(repo.repo) ? input.now.toISOString() : (prev?.lastScannedAt ?? repo.lastScannedAt);
    const activity = latestActivity.get(repo.repo) ?? repo.lastActivityAt ?? prev?.lastActivityAt;
    const out: ManifestRepo = { ...repo, recentStoryIds: recent.slice(0, 10) };
    if (scanned) out.lastScannedAt = scanned;
    else delete out.lastScannedAt;
    if (activity) out.lastActivityAt = activity;
    else delete out.lastActivityAt;
    return out;
  });
}

export function buildManifest(input: ManifestInput): Manifest {
  const editions = [input.newEntry, ...input.carried.filter((e) => e.key !== input.newEntry.key)].sort(compareEditionsDesc);
  return Manifest.parse({
    schemaVersion: 1,
    generatedAt: input.now.toISOString(),
    lastSuccessfulScan: input.now.toISOString(),
    retentionDays: input.config.editorial.retentionDays,
    editions,
    repos: buildRepos(input),
    config: { watchlist: input.config.watchlist, editorial: input.config.editorial },
  });
}
