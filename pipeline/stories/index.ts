/**
 * Turns raw events into stories: one story per underlying development, with a
 * stable id, a fact-based status and the URL that justifies it.
 */
import { createHash } from 'node:crypto';
import type { BuildStories } from '../../shared/contracts';
import type { PipelineState, RawEvent, Story, StoryState } from '../../shared/schemas';
import { groupEvents, type Component } from './group';
import { classify } from './status';

export { classify, statusRank, urlForEventId } from './status';

export const buildStories: BuildStories = (events, known) => {
  const unique = dedupeEvents(events);
  if (unique.length === 0) return [];
  const referenceTime = Math.max(...unique.map((e) => Date.parse(e.updatedAt)));

  return groupEvents(unique, known)
    .map((component) => toStory(component, known, referenceTime))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.id.localeCompare(b.id));
};

export function storyIdFor(primaryEventId: string): string {
  return `s_${createHash('sha1').update(primaryEventId).digest('hex').slice(0, 12)}`;
}

/** Keeps the most recently updated copy when the same event arrives twice. */
function dedupeEvents(events: RawEvent[]): RawEvent[] {
  const byId = new Map<string, RawEvent>();
  for (const e of events) {
    const existing = byId.get(e.id);
    if (!existing || Date.parse(e.updatedAt) > Date.parse(existing.updatedAt)) byId.set(e.id, e);
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function toStory(component: Component, known: PipelineState['stories'], referenceTime: number): Story {
  const events = [...component.events].sort(
    (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id),
  );
  const knownId = pickKnown(component.knownIds, known);
  const knownState: StoryState | undefined = knownId ? known[knownId] : undefined;
  const earliest = events[0]!;
  const id = knownId ?? storyIdFor(earliest.id);
  const verdict = classify(events, referenceTime, knownState);
  const headline = titleEvent(events);

  return {
    id,
    repo: headline.repo,
    title: headline.title,
    events,
    status: verdict.status,
    statusEvidenceUrl: verdict.evidenceUrl,
    categories: categoriesFor(events),
    firstSeen: knownState?.firstSeen ?? earliest.createdAt,
    updatedAt: events.reduce((max, e) => (Date.parse(e.updatedAt) > Date.parse(max) ? e.updatedAt : max), earliest.updatedAt),
  };
}

/** When one component swallowed several known stories, the oldest one keeps its id. */
function pickKnown(ids: string[], known: PipelineState['stories']): string | undefined {
  return [...ids].sort((a, b) => {
    const fa = Date.parse(known[a]?.firstSeen ?? '');
    const fb = Date.parse(known[b]?.firstSeen ?? '');
    return (fa || 0) - (fb || 0) || a.localeCompare(b);
  })[0];
}

/**
 * The event whose title best names the change: an advisory, else the single PR
 * behind it, else the release, else the first PR or issue.
 */
function titleEvent(events: RawEvent[]): RawEvent {
  const of = (kind: RawEvent['kind']) => events.filter((e) => e.kind === kind);
  const pulls = of('pull_request');
  return of('advisory')[0] ?? (pulls.length === 1 ? pulls[0] : undefined) ?? of('release')[0] ?? pulls[0] ?? events[0]!;
}

const CATEGORY_RULES: { pattern: RegExp; category: string }[] = [
  { pattern: /security|vulnerab|cve/i, category: 'Security' },
  { pattern: /breaking/i, category: 'Breaking change' },
  { pattern: /deprecat/i, category: 'Deprecation' },
  { pattern: /feature|enhancement/i, category: 'Feature' },
  { pattern: /bug|regression|crash/i, category: 'Bug fix' },
  { pattern: /perf/i, category: 'Performance' },
  { pattern: /doc/i, category: 'Documentation' },
  { pattern: /rfc|proposal/i, category: 'Proposal' },
];

/** Categories from labels and event kinds; the repo's own category is added during scoring. */
function categoriesFor(events: RawEvent[]): string[] {
  const found = new Set<string>();
  if (events.some((e) => e.kind === 'advisory')) found.add('Security');
  for (const label of events.flatMap((e) => e.labels)) {
    for (const rule of CATEGORY_RULES) if (rule.pattern.test(label)) found.add(rule.category);
  }
  if (events.some((e) => e.kind === 'release')) found.add('Release');
  return [...found];
}
