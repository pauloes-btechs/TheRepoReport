import { describe, expect, it } from 'vitest';
import { fixtureManifest, fixtureReport, mockFetch, MORNING } from '../test/helpers';
import { DataError, audioPathFor, loadManifest, loadReport, siteUrl } from './data';

describe('data loader', () => {
  it('builds URLs under the Vite base path', () => {
    expect(siteUrl('data/manifest.json')).toBe('/TheRepoReport/data/manifest.json');
    expect(audioPathFor('data/editions/2026-11-10-morning/report.json')).toBe('data/editions/2026-11-10-morning/audio.mp3');
  });

  it('loads and validates a manifest', async () => {
    const manifest = fixtureManifest();
    const result = await loadManifest({ fetchImpl: mockFetch({ 'data/manifest.json': { body: manifest } }) });
    expect(result?.editions.length).toBe(manifest.editions.length);
  });

  it('returns null when no manifest is published (404)', async () => {
    expect(await loadManifest({ fetchImpl: mockFetch({}) })).toBeNull();
  });

  it('returns null when the host answers with the HTML shell', async () => {
    const fetchImpl = mockFetch({ 'data/manifest.json': { text: '<!doctype html><html></html>', contentType: 'text/html' } });
    expect(await loadManifest({ fetchImpl })).toBeNull();
  });

  it('rejects a manifest that does not match the schema', async () => {
    const bad = { ...fixtureManifest(), schemaVersion: 2 };
    const err = await loadManifest({ fetchImpl: mockFetch({ 'data/manifest.json': { body: bad } }) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DataError);
    expect((err as DataError).kind).toBe('schema');
    expect((err as DataError).detail).toContain('schemaVersion');
  });

  it('rejects invalid JSON and server errors', async () => {
    const parse = await loadManifest({ fetchImpl: mockFetch({ 'data/manifest.json': { text: '{"oops":' } }) }).catch((e: unknown) => e);
    expect((parse as DataError).kind).toBe('parse');
    const http = await loadManifest({ fetchImpl: mockFetch({ 'data/manifest.json': { status: 500, text: 'x' } }) }).catch((e: unknown) => e);
    expect((http as DataError).kind).toBe('http');
  });

  it('reports network failures', async () => {
    const err = await loadManifest({ fetchImpl: async () => Promise.reject(new TypeError('Failed to fetch')) }).catch((e: unknown) => e);
    expect((err as DataError).kind).toBe('network');
  });

  it('loads a report and fails clearly when it is missing', async () => {
    const report = fixtureReport(MORNING);
    const path = `data/editions/${MORNING}/report.json`;
    expect((await loadReport(path, { fetchImpl: mockFetch({ [path]: { body: report } }) })).key).toBe(MORNING);
    const err = await loadReport(path, { fetchImpl: mockFetch({}) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DataError);
  });
});
