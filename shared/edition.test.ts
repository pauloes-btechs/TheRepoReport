import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isExpired, newYorkClock, parseEditionKey, resolveEdition } from './edition';
import { EditorialConfig, WatchlistConfig, bandFor } from './schemas';

describe('resolveEdition', () => {
  it('maps New York wall-clock time to an edition in winter (EST, UTC-5)', () => {
    expect(resolveEdition(new Date('2026-01-15T12:15:00Z')).key).toBe('2026-01-15-morning');
    expect(resolveEdition(new Date('2026-01-15T18:15:00Z')).key).toBe('2026-01-15-afternoon');
    expect(resolveEdition(new Date('2026-01-16T00:15:00Z')).key).toBe('2026-01-15-evening');
  });

  it('maps New York wall-clock time to an edition in summer (EDT, UTC-4)', () => {
    expect(resolveEdition(new Date('2026-07-15T11:15:00Z')).key).toBe('2026-07-15-morning');
    expect(resolveEdition(new Date('2026-07-15T17:15:00Z')).key).toBe('2026-07-15-afternoon');
    expect(resolveEdition(new Date('2026-07-15T23:15:00Z')).key).toBe('2026-07-15-evening');
  });

  it('handles the spring-forward and fall-back days', () => {
    // 2026-03-08: clocks jump 2:00 -> 3:00. 7:15 AM EDT is 11:15 UTC.
    expect(resolveEdition(new Date('2026-03-08T11:15:00Z')).key).toBe('2026-03-08-morning');
    // 2026-11-01: clocks fall back. 7:15 AM EST is 12:15 UTC.
    expect(resolveEdition(new Date('2026-11-01T12:15:00Z')).key).toBe('2026-11-01-morning');
    expect(resolveEdition(new Date('2026-11-01T11:00:00Z')).key).toBe('2026-10-31-evening');
  });

  it('assigns late and early runs to the right slot', () => {
    // 50 minutes late is still the morning edition.
    expect(resolveEdition(new Date('2026-01-15T13:05:00Z')).key).toBe('2026-01-15-morning');
    // A scheduler firing five minutes early still counts.
    expect(resolveEdition(new Date('2026-01-15T12:10:00Z')).key).toBe('2026-01-15-morning');
    // 3 AM belongs to the previous evening.
    expect(resolveEdition(new Date('2026-01-15T08:00:00Z')).key).toBe('2026-01-14-evening');
  });
});

describe('helpers', () => {
  it('reads the New York clock', () => {
    expect(newYorkClock(new Date('2026-07-04T16:30:00Z'))).toEqual({ date: '2026-07-04', minutes: 12 * 60 + 30 });
  });

  it('parses edition keys', () => {
    expect(parseEditionKey('2026-11-10-evening')).toEqual({ key: '2026-11-10-evening', date: '2026-11-10', edition: 'evening' });
    expect(parseEditionKey('nonsense')).toBeUndefined();
  });

  it('expires editions after the retention period', () => {
    const now = new Date('2026-11-10T18:00:00Z');
    expect(isExpired('2026-11-04', now, 7)).toBe(false);
    expect(isExpired('2026-11-03', now, 7)).toBe(true);
  });

  it('maps scores to impact bands', () => {
    expect([95, 80, 60, 40, 10].map(bandFor)).toEqual(['critical', 'major', 'high', 'notable', 'routine']);
  });
});

describe('production configuration', () => {
  it('watchlist.json is valid', () => {
    const parsed = WatchlistConfig.parse(JSON.parse(readFileSync('config/watchlist.json', 'utf8')));
    expect(parsed.repos.length).toBeGreaterThan(0);
  });

  it('editorial.json is valid and weights total 100', () => {
    const parsed = EditorialConfig.parse(JSON.parse(readFileSync('config/editorial.json', 'utf8')));
    const total = Object.values(parsed.weights).reduce((a, b) => a + b, 0);
    expect(total).toBe(100);
  });
});

describe('published URLs', () => {
  it('accept only https links', async () => {
    const { HttpsUrl } = await import('./schemas');
    expect(HttpsUrl.safeParse('https://github.com/a/b/pull/1').success).toBe(true);
    for (const bad of ['javascript:alert(1)', 'http://github.com/a/b', 'data:text/html,hi']) {
      expect(HttpsUrl.safeParse(bad).success).toBe(false);
    }
  });
});
