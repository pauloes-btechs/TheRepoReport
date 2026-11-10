import { describe, expect, it } from 'vitest';
import type { EditorialConfig, WatchlistConfig } from '../../shared/schemas';
import { fixtureManifest } from '../test/helpers';
import {
  StarImportError,
  diffEditorial,
  diffWatchlist,
  importStarred,
  mergeRepos,
  newWatchedRepo,
  parseRepoInput,
  validateEditorial,
  weightsTotal,
} from './config-draft';

describe('parseRepoInput', () => {
  it.each([
    ['ollama/ollama', 'ollama/ollama'],
    ['  vitejs/vite  ', 'vitejs/vite'],
    ['https://github.com/lightningnetwork/lnd', 'lightningnetwork/lnd'],
    ['https://github.com/bitcoin/bitcoin/pull/123', 'bitcoin/bitcoin'],
    ['github.com/facebook/react.git', 'facebook/react'],
    ['git@github.com:OHF-Voice/piper1-gpl.git', 'OHF-Voice/piper1-gpl'],
    ['https://www.github.com/vercel/next.js/', 'vercel/next.js'],
  ])('accepts %s', (input, repo) => {
    expect(parseRepoInput(input)).toEqual({ ok: true, repo });
  });

  it.each(['', 'ollama', 'https://gitlab.com/a/b', 'https://github.com/orgs/acme/repositories', 'bad owner/x', 'a/..'])('rejects %j', (input) => {
    expect(parseRepoInput(input).ok).toBe(false);
  });
});

describe('editorial validation', () => {
  const base = (): EditorialConfig => structuredClone(fixtureManifest().config.editorial);

  it('accepts the deployed config', () => {
    expect(weightsTotal(base().weights)).toBe(100);
    expect(validateEditorial(base())).toEqual([]);
  });

  it('requires weights to total 100', () => {
    const d = base();
    d.weights.security = 30;
    expect(weightsTotal(d.weights)).toBe(105);
    expect(validateEditorial(d).join(' ')).toMatch(/total 100.*105/);
  });

  it('rejects inverted target lengths and empty fields', () => {
    const d = base();
    d.targetMinutes = { min: 10, max: 5 };
    d.model = ' ';
    const errors = validateEditorial(d);
    expect(errors.some((e) => e.includes('minimum cannot exceed'))).toBe(true);
    expect(errors.some((e) => e.includes('model'))).toBe(true);
  });
});

describe('config diff', () => {
  const deployed = (): WatchlistConfig => structuredClone(fixtureManifest().config.watchlist);

  it('reports nothing when unchanged or merely reordered', () => {
    const d = deployed();
    expect(diffWatchlist(deployed(), d)).toEqual([]);
    d.repos.reverse();
    expect(diffWatchlist(deployed(), d)).toEqual([]);
  });

  it('reports added, removed and changed repositories by name', () => {
    const d = deployed();
    d.repos = d.repos.filter((r) => r.repo !== 'vexl-it/vexl');
    d.repos.push(newWatchedRepo('golang/go', { category: 'Languages' }));
    d.repos = d.repos.map((r) => (r.repo === 'ollama/ollama' ? { ...r, priority: 1, enabled: false } : r));
    d.maxRepos = 30;
    const changes = diffWatchlist(deployed(), d);
    expect(changes).toContainEqual(expect.objectContaining({ path: 'repos.golang/go', kind: 'added' }));
    expect(changes).toContainEqual(expect.objectContaining({ path: 'repos.vexl-it/vexl', kind: 'removed' }));
    expect(changes).toContainEqual({ path: 'repos.ollama/ollama.priority', kind: 'changed', before: 3, after: 1 });
    expect(changes).toContainEqual({ path: 'repos.ollama/ollama.enabled', kind: 'changed', before: true, after: false });
    expect(changes).toContainEqual({ path: 'maxRepos', kind: 'changed', before: 50, after: 30 });
  });

  it('diffs editorial weights and topic lists', () => {
    const before = fixtureManifest().config.editorial;
    const after = structuredClone(before);
    after.weights.security = 20;
    after.weights.capability = 25;
    after.topics = [...after.topics.filter((t) => t !== 'payments'), 'rust'];
    const changes = diffEditorial(before, after);
    expect(changes).toContainEqual({ path: 'weights.security', kind: 'changed', before: 25, after: 20 });
    expect(changes).toContainEqual({ path: 'topics', kind: 'added', after: 'rust' });
    expect(changes).toContainEqual({ path: 'topics', kind: 'removed', before: 'payments' });
  });
});

describe('importStarred', () => {
  const page = (names: string[]) => names.map((full_name) => ({ full_name, topics: ['x'] }));

  it('paginates until maxRepos and skips invalid entries', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      const n = Number(new URL(url).searchParams.get('page'));
      const names = Array.from({ length: 2 }, (_, i) => `owner${n}/repo${i}`);
      return new Response(JSON.stringify(n === 1 ? [...page(names), { full_name: 42 }] : page(names)), { status: 200 });
    }) as unknown as typeof fetch;
    const repos = await importStarred('octocat', 3, fetchImpl);
    expect(repos.map((r) => r.repo)).toEqual(['owner1/repo0', 'owner1/repo1', 'owner2/repo0']);
    expect(calls[0]).toBe('https://api.github.com/users/octocat/starred?per_page=3&page=1');
    expect(repos[0]).toMatchObject({ category: 'Starred', priority: 1, enabled: true, topics: ['x'] });
  });

  it('explains rate limits and unknown users', async () => {
    const limited = (async () =>
      new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1893456000' } })) as unknown as typeof fetch;
    const err = await importStarred('octocat', 10, limited).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StarImportError);
    expect((err as StarImportError).kind).toBe('rate-limit');
    expect((err as StarImportError).resetAt?.getTime()).toBe(1893456000 * 1000);

    const missing = (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch;
    expect(((await importStarred('nobody-here', 10, missing).catch((e: unknown) => e)) as StarImportError).kind).toBe('not-found');
    expect(((await importStarred('bad user', 10, missing).catch((e: unknown) => e)) as StarImportError).kind).toBe('invalid-user');
  });

  it('merges without duplicates (case-insensitive)', () => {
    const { repos, added } = mergeRepos([newWatchedRepo('Ollama/Ollama')], [newWatchedRepo('ollama/ollama'), newWatchedRepo('a/b')]);
    expect(added).toBe(1);
    expect(repos.map((r) => r.repo)).toEqual(['Ollama/Ollama', 'a/b']);
  });
});
