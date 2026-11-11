/**
 * Busy-repository roundups.
 *
 * Scoring works story by story, so a repository that merges dozens of ordinary
 * pull requests in one window never produces a headline, even though the burst
 * itself is news (lightninglabs/wavelength merged 30 PRs on 2026-11-10 and the
 * evening edition said nothing). When a repository merges at least
 * DIGEST_MIN_MERGED standalone pull requests in a window, they are folded into
 * one "roundup" story that the rubric and the explainer treat as a whole.
 *
 * Stories that look security-related or breaking are never folded in, so they
 * keep their own headline.
 */
import { createHash } from 'node:crypto';
import type { Story } from '../../shared/schemas';

export const DIGEST_MIN_MERGED = 6;
export const DIGEST_PREFIX = 's_roundup_';

const KEEP_SEPARATE_TITLE = /vulnerab|exploit|\bCVE-|\bGHSA-|security|breaking|deprecat/i;
const KEEP_SEPARATE_LABEL = /security|vulnerab|breaking|deprecat/i;

export const isRoundup = (story: Pick<Story, 'id'>) => story.id.startsWith(DIGEST_PREFIX);

/** A merged pull request (with any linked issues) that has not shipped and is not sensitive. */
function foldable(story: Story): boolean {
  if (story.status !== 'merged' || isRoundup(story)) return false;
  const pulls = story.events.filter((e) => e.kind === 'pull_request');
  if (pulls.length !== 1) return false;
  if (story.events.some((e) => e.kind === 'release' || e.kind === 'advisory')) return false;
  return !story.events.some((e) => KEEP_SEPARATE_TITLE.test(e.title) || e.labels.some((l) => KEEP_SEPARATE_LABEL.test(l)));
}

export function digestBusyRepos(stories: Story[], minMerged = DIGEST_MIN_MERGED): Story[] {
  const byRepo = new Map<string, Story[]>();
  for (const story of stories) {
    if (!foldable(story)) continue;
    const key = story.repo.toLowerCase();
    byRepo.set(key, [...(byRepo.get(key) ?? []), story]);
  }
  const folded = new Set<string>();
  const roundups: Story[] = [];
  for (const group of byRepo.values()) {
    if (group.length < minMerged) continue;
    for (const s of group) folded.add(s.id);
    roundups.push(toRoundup(group));
  }
  if (roundups.length === 0) return stories;
  return [...stories.filter((s) => !folded.has(s.id)), ...roundups].sort(
    (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.id.localeCompare(b.id),
  );
}

function toRoundup(group: Story[]): Story {
  const events = group
    .flatMap((s) => s.events)
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id));
  const pulls = events.filter((e) => e.kind === 'pull_request');
  const latest = [...pulls].sort((a, b) => Date.parse(b.mergedAt ?? b.updatedAt) - Date.parse(a.mergedAt ?? a.updatedAt))[0]!;
  const repo = group[0]!.repo;
  // A new id per window: the same repository can have a roundup in every edition.
  const id = DIGEST_PREFIX + createHash('sha1').update(pulls.map((p) => p.id).sort().join('|')).digest('hex').slice(0, 12);
  const repoName = repo.split('/')[1] ?? repo;
  return {
    id,
    repo,
    title: `${pulls.length} pull requests merged in ${repoName}`,
    events,
    status: 'merged',
    statusEvidenceUrl: latest.url,
    categories: [...new Set(group.flatMap((s) => s.categories))],
    firstSeen: group.map((s) => s.firstSeen).sort()[0]!,
    updatedAt: group.map((s) => s.updatedAt).sort().at(-1)!,
  };
}

/** Component prefixes ("sdk: …", "notifyrelay: …") ranked by how many pull requests touched them. */
export function roundupThemes(story: Story, limit = 4): { theme: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const e of story.events) {
    if (e.kind !== 'pull_request') continue;
    const theme = /^\s*([\w./-]{2,30})(?:\([^)]*\))?!?:\s/.exec(e.title)?.[1]?.toLowerCase();
    if (theme) counts.set(theme, (counts.get(theme) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([theme, count]) => ({ theme, count }))
    .sort((a, b) => b.count - a.count || a.theme.localeCompare(b.theme))
    .slice(0, limit);
}
