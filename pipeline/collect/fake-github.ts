/**
 * Test double for the GitHub REST API, served from recorded-style fixtures in
 * fixtures/github/. Routes are keyed by path, plus "?page=N" for later pages.
 * A route may hold a list of responses, consumed in order (the last repeats).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { FetchLike } from '../../shared/contracts';

export interface FakeResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
  /** Simulate a network failure instead of responding. */
  networkError?: boolean;
}
export type Routes = Record<string, FakeResponse | FakeResponse[]>;

export interface RecordedCall {
  url: string;
  headers: Record<string, string>;
}

const FIXTURE_DIR = fileURLToPath(new URL('../../fixtures/github/', import.meta.url));

export function loadFixture(name: string): Routes {
  const raw = JSON.parse(readFileSync(`${FIXTURE_DIR}${name}.json`, 'utf8')) as Record<string, unknown>;
  delete raw._comment;
  return raw as Routes;
}

export function fakeGitHub(...routeSets: Routes[]) {
  const routes: Routes = Object.assign({}, ...routeSets);
  const calls: RecordedCall[] = [];

  const fetch: FetchLike = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    calls.push({ url: url.href, headers });

    const page = url.searchParams.get('page');
    const key = page && page !== '1' ? `${url.pathname}?page=${page}` : url.pathname;
    const route = routes[key];
    const response = Array.isArray(route) ? (route.length > 1 ? route.shift() : route[0]) : route;
    if (!response) return json(404, { message: 'Not Found' });
    if (response.networkError) throw new TypeError('fetch failed');

    const etag = response.headers?.etag;
    if (etag && headers['if-none-match'] === etag) return new Response(null, { status: 304, headers: { etag } });
    return json(response.status ?? 200, response.body ?? null, response.headers);
  };

  return { fetch, calls, routes };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}
