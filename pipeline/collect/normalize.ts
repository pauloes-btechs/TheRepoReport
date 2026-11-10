/**
 * Candidate filters and conversion from GitHub API objects to RawEvents.
 * Event ids are stable across runs so stories can track them over time.
 */
import type { RawEvent } from '../../shared/schemas';
import type { GhAdvisory, GhIssue, GhLabel, GhPull, GhRelease, GhUser } from './github-types';
import { extractRefs, sanitizeText, sanitizeTitle } from './text';

const BOT_LOGINS = /^(dependabot|renovate|github-actions|greenkeeper|snyk-bot|mergify)(\[bot\])?$/i;
const SECURITY_LABEL = /security|vulnerab|cve/i;
const IMPORTANT_LABEL = /important|critical|security|breaking|high[- ]?priority|\bp0\b/i;
const SIGNAL_LABEL = /security|bug|breaking|regression|critical|rfc|proposal/i;
const ISSUE_ACTIVITY_THRESHOLD = 5;

export const eventIds = {
  release: (repo: string, tag: string) => `release:${repo}:${tag}`,
  pull: (repo: string, n: number) => `pull_request:${repo}#${n}`,
  issue: (repo: string, n: number) => `issue:${repo}#${n}`,
  advisory: (ghsa: string) => `advisory:${ghsa}`,
};

/** Half-open reporting window: (since, until]. */
export interface Window {
  since: number;
  until: number;
}

export function inWindow(iso: string | null | undefined, window: Window): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  return t > window.since && t <= window.until;
}

function labelNames(labels: (GhLabel | string)[] | undefined): string[] {
  return (labels ?? []).map((l) => (typeof l === 'string' ? l : l.name)).filter(Boolean);
}

export function isBot(user: GhUser | null | undefined): boolean {
  if (!user) return false;
  return user.type === 'Bot' || user.login.endsWith('[bot]') || BOT_LOGINS.test(user.login);
}

export interface Extras {
  repoStars?: number;
}

export function releaseToEvent(repo: string, r: GhRelease, extras: Extras): RawEvent {
  const body = sanitizeText(r.body);
  const published = r.published_at ?? r.created_at;
  return {
    id: eventIds.release(repo, r.tag_name),
    kind: 'release',
    repo,
    title: sanitizeTitle(r.name) || r.tag_name,
    body,
    url: r.html_url,
    author: r.author?.login,
    labels: [],
    state: 'published',
    createdAt: r.created_at,
    updatedAt: published,
    publishedAt: published,
    tagName: r.tag_name,
    prerelease: r.prerelease,
    refs: extractRefs(body, repo),
    repoStars: extras.repoStars,
  };
}

/** Merged PRs and notable open PRs; skips closed-unmerged, most drafts and bot noise. */
export function isCandidatePull(p: GhPull): boolean {
  const labels = labelNames(p.labels);
  if (isBot(p.user) && !labels.some((l) => SECURITY_LABEL.test(l))) return false;
  if (p.merged_at) return true;
  if (p.state !== 'open') return false;
  if (p.draft && !labels.some((l) => IMPORTANT_LABEL.test(l))) return false;
  return true;
}

export function pullToEvent(repo: string, p: GhPull, extras: Extras): RawEvent {
  const body = sanitizeText(p.body);
  const self = `${repo}#${p.number}`;
  return {
    id: eventIds.pull(repo, p.number),
    kind: 'pull_request',
    repo,
    number: p.number,
    title: sanitizeTitle(p.title),
    body,
    url: p.html_url,
    author: p.user?.login,
    labels: labelNames(p.labels),
    state: p.merged_at ? 'merged' : p.state,
    draft: p.draft ?? false,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
    mergedAt: p.merged_at ?? undefined,
    refs: extractRefs(`${p.title}\n${body}`, repo, self),
    repoStars: extras.repoStars,
  };
}

/** Issues only make the cut with a signal: a telling label or real community activity. */
export function isCandidateIssue(i: GhIssue): boolean {
  if (i.pull_request) return false;
  if (labelNames(i.labels).some((l) => SIGNAL_LABEL.test(l))) return true;
  return (i.comments ?? 0) >= ISSUE_ACTIVITY_THRESHOLD || (i.reactions?.total_count ?? 0) >= ISSUE_ACTIVITY_THRESHOLD;
}

export function issueToEvent(repo: string, i: GhIssue, extras: Extras): RawEvent {
  const body = sanitizeText(i.body);
  return {
    id: eventIds.issue(repo, i.number),
    kind: 'issue',
    repo,
    number: i.number,
    title: sanitizeTitle(i.title),
    body,
    url: i.html_url,
    author: i.user?.login,
    labels: labelNames(i.labels),
    state: i.state,
    createdAt: i.created_at,
    updatedAt: i.updated_at,
    comments: i.comments,
    reactions: i.reactions?.total_count,
    refs: extractRefs(`${i.title}\n${body}`, repo, `${repo}#${i.number}`),
    repoStars: extras.repoStars,
  };
}

/**
 * The schema has no field for patched versions, so the collector writes them
 * as the first line of the body ("Patched versions: …"). Stories read it back
 * with `patchedVersionsOf`.
 */
export const PATCHED_PREFIX = 'Patched versions: ';

export function advisoryToEvent(repo: string, a: GhAdvisory, extras: Extras): RawEvent {
  const patched = [
    ...new Set((a.vulnerabilities ?? []).map((v) => v.patched_versions?.trim()).filter((v): v is string => !!v)),
  ];
  const header = patched.length > 0 ? `${PATCHED_PREFIX}${patched.join(', ')}\n\n` : '';
  const body = sanitizeText(`${header}${a.description ?? ''}`);
  const published = a.published_at ?? a.updated_at ?? a.created_at ?? '';
  return {
    id: eventIds.advisory(a.ghsa_id),
    kind: 'advisory',
    repo,
    title: sanitizeTitle(a.summary),
    body,
    url: a.html_url,
    labels: ['security'],
    state: 'published',
    createdAt: a.created_at ?? published,
    updatedAt: a.updated_at ?? published,
    publishedAt: published,
    severity: a.severity ?? undefined,
    cveId: a.cve_id ?? undefined,
    ghsaId: a.ghsa_id,
    refs: extractRefs(body, repo),
    repoStars: extras.repoStars,
  };
}
