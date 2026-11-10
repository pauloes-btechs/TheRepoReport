import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EditorialConfig, WatchlistConfig } from '../../shared/schemas';
import { FakeSite, SITE, liveManifest, minimalReport, publish } from './__fixtures__/fakes';
import { ArchiveUnavailableError, assertArchiveUsable, fetchLiveManifest, stageArchive } from './archive';

const watchlist = WatchlistConfig.parse(JSON.parse(readFileSync('config/watchlist.json', 'utf8')));
const editorial = EditorialConfig.parse(JSON.parse(readFileSync('config/editorial.json', 'utf8')));
const now = new Date('2026-11-10T18:30:00Z');
const fast = { retryDelayMs: 0 };

describe('fetchLiveManifest', () => {
  it('treats only a clean 404 as missing', async () => {
    const site = new FakeSite();
    expect(await fetchLiveManifest(SITE, { fetch: site.fetch, ...fast })).toEqual({ status: 'missing' });
  });

  it('throws on 5xx after retrying', async () => {
    const site = new FakeSite().raw('data/manifest.json', { status: 503, body: 'down' });
    await expect(fetchLiveManifest(SITE, { fetch: site.fetch, ...fast })).rejects.toBeInstanceOf(ArchiveUnavailableError);
    expect(site.requests).toHaveLength(3);
  });

  it('throws on network errors, other statuses, bad JSON and schema mismatch', async () => {
    const net = new FakeSite();
    net.networkErrors.add('data/manifest.json');
    await expect(fetchLiveManifest(SITE, { fetch: net.fetch, ...fast })).rejects.toBeInstanceOf(ArchiveUnavailableError);
    const forbidden = new FakeSite().raw('data/manifest.json', { status: 403, body: '' });
    await expect(fetchLiveManifest(SITE, { fetch: forbidden.fetch, ...fast })).rejects.toBeInstanceOf(ArchiveUnavailableError);
    const html = new FakeSite().raw('data/manifest.json', { status: 200, body: '<html>' });
    await expect(fetchLiveManifest(SITE, { fetch: html.fetch, ...fast })).rejects.toBeInstanceOf(ArchiveUnavailableError);
    const wrong = new FakeSite().json('data/manifest.json', { schemaVersion: 1, editions: 'nope' });
    await expect(fetchLiveManifest(SITE, { fetch: wrong.fetch, ...fast })).rejects.toBeInstanceOf(ArchiveUnavailableError);
  });

  it('busts the CDN cache with a query string', async () => {
    const site = new FakeSite();
    await fetchLiveManifest(SITE, { fetch: site.fetch, ...fast });
    expect(site.requests[0]).toMatch(/manifest\.json\?t=\d+$/);
  });
});

describe('first-run rule', () => {
  it('allows an empty archive only for a 404 with no prior edition, or when explicitly allowed', () => {
    expect(() => assertArchiveUsable({ live: { status: 'missing' } })).not.toThrow();
    expect(() => assertArchiveUsable({ live: { status: 'missing' }, priorLastEditionKey: '2026-11-09-evening' })).toThrow(ArchiveUnavailableError);
    expect(() => assertArchiveUsable({ live: { status: 'missing' }, priorLastEditionKey: '2026-11-09-evening', allowEmptyArchive: true })).not.toThrow();
  });
});

describe('stageArchive', () => {
  const reports = [
    minimalReport('2026-11-10-morning', '2026-11-10', 'morning'),
    minimalReport('2026-11-04-evening', '2026-11-04', 'evening', false),
    minimalReport('2026-11-03-evening', '2026-11-03', 'evening'),
  ];

  it('keeps unexpired editions (with audio) and drops expired ones', async () => {
    const manifest = liveManifest(watchlist, editorial, reports);
    const site = publish(new FakeSite(), manifest, reports);
    const stagingDir = join(mkdtempSync(join(tmpdir(), 'arch-')), 'staging');
    const staged = await stageArchive({ siteUrl: SITE, manifest, stagingDir, now, retentionDays: 7, fetch: site.fetch, ...fast });
    expect(staged.carried.map((e) => e.key)).toEqual(['2026-11-10-morning', '2026-11-04-evening']);
    expect(staged.dropped).toEqual(['2026-11-03-evening']);
    expect(statSync(join(stagingDir, 'data/editions/2026-11-10-morning/audio.mp3')).size).toBe(10);
    expect(existsSync(join(stagingDir, 'data/editions/2026-11-10-morning/transcript.json'))).toBe(true);
    expect(existsSync(join(stagingDir, 'data/editions/2026-11-03-evening'))).toBe(false);
    expect(site.requests.some((u) => u.includes('2026-11-03-evening'))).toBe(false);
  });

  it('does not carry the edition being replaced', async () => {
    const manifest = liveManifest(watchlist, editorial, reports.slice(0, 1));
    const site = publish(new FakeSite(), manifest, reports.slice(0, 1));
    const stagingDir = join(mkdtempSync(join(tmpdir(), 'arch-')), 'staging');
    const staged = await stageArchive({ siteUrl: SITE, manifest, stagingDir, now, retentionDays: 7, fetch: site.fetch, replaceKey: '2026-11-10-morning', ...fast });
    expect(staged.carried).toEqual([]);
    expect(staged.dropped).toEqual(['2026-11-10-morning']);
  });

  it('throws and removes staging when a listed file is missing or the wrong size', async () => {
    const manifest = liveManifest(watchlist, editorial, reports.slice(0, 1));
    const missing = publish(new FakeSite(), manifest, reports.slice(0, 1));
    missing.files.delete('data/editions/2026-11-10-morning/audio.mp3');
    const stagingDir = join(mkdtempSync(join(tmpdir(), 'arch-')), 'staging');
    await expect(stageArchive({ siteUrl: SITE, manifest, stagingDir, now, retentionDays: 7, fetch: missing.fetch, ...fast })).rejects.toBeInstanceOf(ArchiveUnavailableError);
    expect(existsSync(stagingDir)).toBe(false);

    const truncated = publish(new FakeSite(), manifest, reports.slice(0, 1));
    truncated.raw('data/editions/2026-11-10-morning/audio.mp3', { status: 200, body: new Uint8Array(3) });
    await expect(stageArchive({ siteUrl: SITE, manifest, stagingDir, now, retentionDays: 7, fetch: truncated.fetch, ...fast })).rejects.toThrow(/bytes/);
    expect(existsSync(stagingDir)).toBe(false);
  });

  it('rejects manifest paths outside the expected layout', async () => {
    const manifest = liveManifest(watchlist, editorial, reports.slice(0, 1));
    manifest.editions[0]!.reportPath = '../../etc/passwd';
    const site = publish(new FakeSite(), manifest, reports.slice(0, 1));
    const stagingDir = join(mkdtempSync(join(tmpdir(), 'arch-')), 'staging');
    await expect(stageArchive({ siteUrl: SITE, manifest, stagingDir, now, retentionDays: 7, fetch: site.fetch, ...fast })).rejects.toThrow(/Unexpected reportPath/);
  });
});
