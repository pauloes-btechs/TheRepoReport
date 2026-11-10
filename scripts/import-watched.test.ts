import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { WatchlistConfig } from '../shared/schemas';
import { fetchSubscriptions, formatWatchlist, mergeWatched, nextLink } from './import-watched';

const config = WatchlistConfig.parse(JSON.parse(readFileSync('config/watchlist.json', 'utf8')));

describe('import-watched', () => {
  it('adds public watched repos with defaults and leaves existing entries alone', () => {
    const result = mergeWatched(config, [
      { full_name: 'Bitcoin/Bitcoin', private: false },
      { full_name: 'new/public', private: false, visibility: 'public', topics: ['x'] },
      { full_name: 'me/secret', private: true, visibility: 'private' },
      { full_name: 'org/internal', private: false, visibility: 'internal' },
      { full_name: 'old/archived', private: false, archived: true },
    ]);
    expect(result.added).toEqual(['new/public']);
    expect(result.alreadyPresent).toEqual(['Bitcoin/Bitcoin']);
    expect(result.skippedPrivate).toEqual(['me/secret', 'org/internal']);
    expect(result.skippedArchived).toEqual(['old/archived']);
    expect(result.config.repos.slice(0, config.repos.length)).toEqual(config.repos);
    expect(result.config.repos.at(-1)).toEqual({ repo: 'new/public', category: 'Watched', priority: 2, enabled: true, topics: ['x'] });
  });

  it('formats the file exactly like the hand-written watchlist', () => {
    expect(formatWatchlist(config)).toBe(readFileSync('config/watchlist.json', 'utf8'));
  });

  it('follows Link pagination and sends the token only in the Authorization header', async () => {
    const urls: string[] = [];
    const fake = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      urls.push(url);
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-token');
      expect(url).not.toContain('test-token');
      const page2 = 'https://api.github.com/user/subscriptions?per_page=100&page=2';
      if (url === page2) return new Response(JSON.stringify([{ full_name: 'b/b', private: false }]), { status: 200 });
      return new Response(JSON.stringify([{ full_name: 'a/a', private: false }]), {
        status: 200,
        headers: { link: `<${page2}>; rel="next", <${page2}>; rel="last"` },
      });
    };
    const subs = await fetchSubscriptions('test-token', fake as typeof fetch);
    expect(subs.map((s) => s.full_name)).toEqual(['a/a', 'b/b']);
    expect(urls).toHaveLength(2);
  });

  it('parses Link headers', () => {
    expect(nextLink(null)).toBeUndefined();
    expect(nextLink('<https://x/2>; rel="next"')).toBe('https://x/2');
    expect(nextLink('<https://x/1>; rel="prev"')).toBeUndefined();
  });

  it('reports HTTP errors without leaking the token', async () => {
    const fake = async () => new Response('Bad credentials', { status: 401 });
    await expect(fetchSubscriptions('test-token', fake as typeof fetch)).rejects.toThrow(/HTTP 401/);
    await expect(fetchSubscriptions('test-token', fake as typeof fetch)).rejects.not.toThrow(/test-token/);
  });
});
