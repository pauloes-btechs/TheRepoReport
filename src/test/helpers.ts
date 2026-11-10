/** Test-only helpers. Reads the development fixtures from disk; the app never imports them. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EditionReport, Manifest } from '../../shared/schemas';

const FIXTURES = join(__dirname, '..', '..', 'fixtures', 'site-data');

export function fixtureManifest(): Manifest {
  return Manifest.parse(JSON.parse(readFileSync(join(FIXTURES, 'manifest.json'), 'utf8')));
}

export function fixtureReport(key: string): EditionReport {
  return EditionReport.parse(JSON.parse(readFileSync(join(FIXTURES, 'editions', key, 'report.json'), 'utf8')));
}

export const MORNING = '2026-11-10-morning';
export const EVENING_FALLBACK = '2026-11-09-evening';
export const QUIET = '2026-11-09-afternoon';

type Route = { status?: number; body?: unknown; text?: string; contentType?: string };

/** fetch mock keyed by path suffix (e.g. "data/manifest.json"). Unknown paths answer 404. */
export function mockFetch(routes: Record<string, Route>) {
  return async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    const match = Object.keys(routes).find((k) => url.endsWith(k));
    if (!match) return new Response('Not found', { status: 404 });
    const r = routes[match]!;
    const text = r.text ?? JSON.stringify(r.body);
    return new Response(text, { status: r.status ?? 200, headers: { 'content-type': r.contentType ?? 'application/json' } });
  };
}

export function siteRoutes(manifest: Manifest, reports: EditionReport[]): Record<string, Route> {
  const routes: Record<string, Route> = { 'data/manifest.json': { body: manifest } };
  for (const r of reports) routes[`data/editions/${r.key}/report.json`] = { body: r };
  return routes;
}
