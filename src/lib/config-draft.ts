/**
 * Helpers for the Settings page draft of the production configuration.
 * Drafts live in this browser only; they change nothing until committed.
 */
import {
  DIMENSION_KEYS,
  EditorialConfig,
  RepoSlug,
  WatchlistConfig,
  type WatchedRepo,
} from '../../shared/schemas';

export const REPO_FULL_NAME = 'pauloes-btechs/TheRepoReport';
export const GITHUB_EDIT_URLS = {
  watchlist: `https://github.com/${REPO_FULL_NAME}/edit/main/config/watchlist.json`,
  editorial: `https://github.com/${REPO_FULL_NAME}/edit/main/config/editorial.json`,
} as const;

export type ParseRepoResult = { ok: true; repo: string } | { ok: false; error: string };

/** Accepts "owner/name", GitHub URLs (https, without scheme, or SSH) and trims ".git" and sub-paths. */
export function parseRepoInput(input: string): ParseRepoResult {
  let value = input.trim();
  if (!value) return { ok: false, error: 'Enter a repository as owner/name or a GitHub URL.' };
  const ssh = /^git@github\.com:(.+)$/i.exec(value);
  if (ssh) value = ssh[1]!;
  else if (/^(https?:\/\/)?(www\.)?github\.com\//i.test(value)) {
    const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    value = url.pathname;
  } else if (/^https?:\/\//i.test(value)) {
    return { ok: false, error: 'Only github.com repositories can be watched.' };
  }
  const parts = value.replace(/^\/+/, '').split('/').filter(Boolean);
  if (parts.length < 2) return { ok: false, error: 'Include both the owner and the repository name, like owner/name.' };
  const owner = parts[0]!;
  const name = parts[1]!.replace(/\.git$/i, '');
  if (['orgs', 'users', 'settings', 'marketplace', 'topics', 'explore'].includes(owner.toLowerCase())) {
    return { ok: false, error: 'That link is not a repository. Open the repository page and copy its URL.' };
  }
  const repo = `${owner}/${name}`;
  if (!RepoSlug.safeParse(repo).success || name === '.' || name === '..') {
    return { ok: false, error: `"${repo}" is not a valid repository name.` };
  }
  return { ok: true, repo };
}

export function weightsTotal(weights: EditorialConfig['weights']): number {
  return DIMENSION_KEYS.reduce((sum, k) => sum + (Number(weights[k]) || 0), 0);
}

/** Human-readable problems with an editorial draft; empty when it is valid. */
export function validateEditorial(draft: EditorialConfig): string[] {
  const errors: string[] = [];
  const total = weightsTotal(draft.weights);
  if (total !== 100) errors.push(`Score weights must total 100. They currently total ${total}.`);
  if (DIMENSION_KEYS.some((k) => !(draft.weights[k] >= 0))) errors.push('Each weight must be a number of 0 or more.');
  if (!(draft.minScore >= 0 && draft.minScore <= 100)) errors.push('Minimum score must be between 0 and 100.');
  if (!Number.isInteger(draft.maxStories) || draft.maxStories < 1) errors.push('Maximum stories must be a whole number of at least 1.');
  if (!(draft.targetMinutes.min > 0) || !(draft.targetMinutes.max > 0)) errors.push('Target length must be positive.');
  else if (draft.targetMinutes.min > draft.targetMinutes.max) errors.push('Target length minimum cannot exceed the maximum.');
  if (!Number.isInteger(draft.retentionDays) || draft.retentionDays < 1) errors.push('Retention must be a whole number of days.');
  if (!draft.voice.trim()) errors.push('Choose a narrator voice.');
  if (!draft.model.trim()) errors.push('Choose a model.');
  if (errors.length === 0) {
    const parsed = EditorialConfig.safeParse(draft);
    if (!parsed.success) errors.push(...parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
  }
  return errors;
}

export function validateWatchlist(draft: WatchlistConfig): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const r of draft.repos) {
    const key = r.repo.toLowerCase();
    if (seen.has(key)) errors.push(`${r.repo} is listed twice.`);
    seen.add(key);
  }
  if (!Number.isInteger(draft.maxRepos) || draft.maxRepos < 1) errors.push('Maximum repositories must be a whole number of at least 1.');
  if (errors.length === 0) {
    const parsed = WatchlistConfig.safeParse(draft);
    if (!parsed.success) errors.push(...parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
  }
  return errors;
}

export interface ConfigChange {
  path: string;
  kind: 'added' | 'removed' | 'changed';
  before?: unknown;
  after?: unknown;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function diffValues(before: unknown, after: unknown, path: string, out: ConfigChange[]): void {
  if (isPlainObject(before) && isPlainObject(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
    for (const k of keys) {
      const p = path ? `${path}.${k}` : k;
      if (!(k in before) || before[k] === undefined) {
        if (after[k] !== undefined) out.push({ path: p, kind: 'added', after: after[k] });
      } else if (!(k in after) || after[k] === undefined) out.push({ path: p, kind: 'removed', before: before[k] });
      else diffValues(before[k], after[k], p, out);
    }
    return;
  }
  if (Array.isArray(before) && Array.isArray(after) && [...before, ...after].every((v) => typeof v !== 'object')) {
    for (const v of after) if (!before.includes(v)) out.push({ path, kind: 'added', after: v });
    for (const v of before) if (!after.includes(v)) out.push({ path, kind: 'removed', before: v });
    return;
  }
  if (JSON.stringify(before) !== JSON.stringify(after)) out.push({ path, kind: 'changed', before, after });
}

/** Watchlist diff, keyed by repository so reordering is not reported as a change. */
export function diffWatchlist(deployed: WatchlistConfig, draft: WatchlistConfig): ConfigChange[] {
  const out: ConfigChange[] = [];
  const { repos: beforeRepos, ...beforeRest } = deployed;
  const { repos: afterRepos, ...afterRest } = draft;
  diffValues(beforeRest, afterRest, '', out);
  const before = new Map(beforeRepos.map((r) => [r.repo.toLowerCase(), r]));
  const after = new Map(afterRepos.map((r) => [r.repo.toLowerCase(), r]));
  for (const [key, r] of after) {
    const prev = before.get(key);
    if (!prev) out.push({ path: `repos.${r.repo}`, kind: 'added', after: r });
    else diffValues(prev, r, `repos.${r.repo}`, out);
  }
  for (const [key, r] of before) if (!after.has(key)) out.push({ path: `repos.${r.repo}`, kind: 'removed', before: r });
  return out;
}

export function diffEditorial(deployed: EditorialConfig, draft: EditorialConfig): ConfigChange[] {
  const out: ConfigChange[] = [];
  diffValues(deployed, draft, '', out);
  return out;
}

export function serializeConfig(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function newWatchedRepo(repo: string, overrides: Partial<WatchedRepo> = {}): WatchedRepo {
  return { repo, category: 'Uncategorized', priority: 2, enabled: true, topics: [], ...overrides };
}

export function splitTopics(input: string): string[] {
  return [...new Set(input.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean))];
}

// ───────── Public stars import (unauthenticated) ─────────

export class StarImportError extends Error {
  readonly kind: 'not-found' | 'rate-limit' | 'network' | 'http' | 'invalid-user';
  readonly resetAt?: Date;
  constructor(kind: StarImportError['kind'], message: string, resetAt?: Date) {
    super(message);
    this.name = 'StarImportError';
    this.kind = kind;
    this.resetAt = resetAt;
  }
}

export const GITHUB_USERNAME = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

interface StarredRepoJson {
  full_name?: unknown;
  topics?: unknown;
  archived?: unknown;
  private?: unknown;
}

/** Public starred repositories for a user, newest star first, capped at maxRepos. */
export async function importStarred(
  username: string,
  maxRepos: number,
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<WatchedRepo[]> {
  const user = username.trim();
  if (!GITHUB_USERNAME.test(user)) throw new StarImportError('invalid-user', `"${user}" is not a valid GitHub username.`);
  const result: WatchedRepo[] = [];
  const perPage = Math.min(100, Math.max(1, maxRepos));
  for (let page = 1; result.length < maxRepos && page <= 10; page++) {
    let res: Response;
    try {
      res = await fetchImpl(`https://api.github.com/users/${encodeURIComponent(user)}/starred?per_page=${perPage}&page=${page}`, {
        headers: { Accept: 'application/vnd.github+json' },
      });
    } catch {
      throw new StarImportError('network', 'GitHub could not be reached. Check your connection and try again.');
    }
    if (res.status === 404) throw new StarImportError('not-found', `GitHub has no user named "${user}".`);
    if (res.status === 403 || res.status === 429) {
      const reset = Number(res.headers.get('x-ratelimit-reset'));
      const resetAt = Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000) : undefined;
      const when = resetAt ? ` Try again after ${resetAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.` : ' Try again in an hour.';
      throw new StarImportError('rate-limit', `GitHub's limit for unauthenticated requests from this network has been reached.${when}`, resetAt);
    }
    if (!res.ok) throw new StarImportError('http', `GitHub answered ${res.status}.`);
    const items = (await res.json()) as StarredRepoJson[];
    if (!Array.isArray(items)) throw new StarImportError('http', 'GitHub returned an unexpected response.');
    for (const item of items) {
      if (result.length >= maxRepos) break;
      if (item.private === true || typeof item.full_name !== 'string') continue;
      if (!RepoSlug.safeParse(item.full_name).success) continue;
      const topics = Array.isArray(item.topics) ? item.topics.filter((t): t is string => typeof t === 'string').slice(0, 5) : [];
      result.push(newWatchedRepo(item.full_name, { category: 'Starred', priority: 1, topics }));
    }
    if (items.length < perPage) break;
  }
  return result;
}

/** Adds imported repos that are not already present (case-insensitive). Returns the merged list and how many were new. */
export function mergeRepos(existing: WatchedRepo[], incoming: WatchedRepo[]): { repos: WatchedRepo[]; added: number } {
  const seen = new Set(existing.map((r) => r.repo.toLowerCase()));
  const repos = [...existing];
  let added = 0;
  for (const r of incoming) {
    if (seen.has(r.repo.toLowerCase())) continue;
    seen.add(r.repo.toLowerCase());
    repos.push(r);
    added++;
  }
  return { repos, added };
}
