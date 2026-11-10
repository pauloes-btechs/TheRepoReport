/**
 * Minimal GitHub REST client: auth, conditional requests, Link pagination,
 * request counting, and the retry rules for rate limits and server errors.
 * Headers (and therefore the token) are never passed to the logger.
 */
import type { FetchLike, Logger } from '../../shared/contracts';

export const API_BASE = 'https://api.github.com';
export const USER_AGENT = 'TheRepoReport-collector';

/** A repository could not be scanned; its cursor must not advance. */
export class RepoScanError extends Error {
  constructor(
    message: string,
    readonly rateLimited = false,
  ) {
    super(message);
    this.name = 'RepoScanError';
  }
}

export type GetResult<T> =
  | { kind: 'ok'; data: T; etag?: string; next?: string }
  | { kind: 'not_modified' }
  | { kind: 'missing'; status: number };

export interface ClientOptions {
  fetch: FetchLike;
  token?: string;
  logger: Logger;
  sleep: (ms: number) => Promise<void>;
  /** Longest rate-limit wait we will sit through before giving up. */
  maxRateWaitMs?: number;
  /** Backoff before retrying a 5xx or network error. */
  retryDelayMs?: number;
  clock?: () => number;
}

export interface GetOptions {
  etag?: string;
  /** Treat 404/403/410 as "nothing here" instead of an error. */
  allowMissing?: boolean;
}

export interface PagedResult<T> {
  items: T[];
  etag?: string;
  notModified: boolean;
  missing: boolean;
}

export class GitHubClient {
  requestCount = 0;
  rateRemaining: number | undefined;
  private blockedUntil = 0;
  private readonly maxRateWaitMs: number;
  private readonly retryDelayMs: number;
  private readonly clock: () => number;

  constructor(private readonly options: ClientOptions) {
    this.maxRateWaitMs = options.maxRateWaitMs ?? 60_000;
    this.retryDelayMs = options.retryDelayMs ?? 2_000;
    this.clock = options.clock ?? Date.now;
  }

  async get<T>(pathOrUrl: string, opts: GetOptions = {}): Promise<GetResult<T>> {
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${API_BASE}${pathOrUrl}`;
    const label = new URL(url).pathname;

    for (let attempt = 0; attempt < 2; attempt++) {
      const isRetry = attempt > 0;
      if (this.blockedUntil > this.clock()) {
        throw new RepoScanError(`rate limit exhausted until ${new Date(this.blockedUntil).toISOString()}`, true);
      }

      let res: Response;
      this.requestCount++;
      try {
        res = await this.options.fetch(url, { headers: this.headers(opts.etag) });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        if (!isRetry) {
          this.options.logger.warn('github network error, retrying', { path: label, reason });
          await this.options.sleep(this.retryDelayMs);
          continue;
        }
        throw new RepoScanError(`network error on ${label}: ${reason}`);
      }
      this.trackRate(res);

      if (res.status === 304) return { kind: 'not_modified' };
      if (res.ok) {
        const data = (await res.json()) as T;
        return {
          kind: 'ok',
          data,
          etag: res.headers.get('etag') ?? undefined,
          next: parseNextLink(res.headers.get('link')),
        };
      }

      if (isRateLimited(res)) {
        const waitMs = this.rateLimitWaitMs(res);
        if (!isRetry && waitMs <= this.maxRateWaitMs) {
          this.options.logger.warn('github rate limited, waiting', { path: label, waitMs });
          await this.options.sleep(waitMs);
          continue;
        }
        this.blockedUntil = this.clock() + waitMs;
        throw new RepoScanError(`rate limited on ${label} (HTTP ${res.status}, wait ${Math.round(waitMs / 1000)}s)`, true);
      }

      if (res.status >= 500) {
        if (!isRetry) {
          this.options.logger.warn('github server error, retrying', { path: label, status: res.status });
          await this.options.sleep(this.retryDelayMs);
          continue;
        }
        throw new RepoScanError(`HTTP ${res.status} on ${label} after retry`);
      }

      if (opts.allowMissing && [403, 404, 410].includes(res.status)) return { kind: 'missing', status: res.status };
      throw new RepoScanError(`HTTP ${res.status} on ${label}`);
    }
    // The loop always returns or throws on its second pass.
    throw new RepoScanError(`request failed on ${label}`);
  }

  /**
   * Follows `rel="next"` links. Only the first page is conditional: a 304 there
   * means the whole listing is unchanged. `stopWhen` ends paging early once a
   * page reaches items older than the cursor.
   */
  async getPaged<T>(
    path: string,
    opts: GetOptions & { maxPages?: number; stopWhen?: (page: T[]) => boolean } = {},
  ): Promise<PagedResult<T>> {
    const maxPages = opts.maxPages ?? 5;
    const items: T[] = [];
    let etag: string | undefined;
    let url: string | undefined = path;

    for (let page = 0; url && page < maxPages; page++) {
      const result: GetResult<T[]> = await this.get<T[]>(url, {
        etag: page === 0 ? opts.etag : undefined,
        allowMissing: opts.allowMissing,
      });
      if (result.kind === 'not_modified') return { items: [], etag: opts.etag, notModified: true, missing: false };
      if (result.kind === 'missing') return { items: [], notModified: false, missing: true };
      if (page === 0) etag = result.etag;
      items.push(...result.data);
      if (opts.stopWhen?.(result.data)) break;
      url = result.next;
    }
    return { items, etag, notModified: false, missing: false };
  }

  private headers(etag?: string): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': USER_AGENT,
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (this.options.token) headers.Authorization = `Bearer ${this.options.token}`;
    if (etag) headers['If-None-Match'] = etag;
    return headers;
  }

  private trackRate(res: Response): void {
    const remaining = res.headers.get('x-ratelimit-remaining');
    if (remaining !== null && remaining !== '' && Number.isFinite(Number(remaining))) {
      this.rateRemaining = Number(remaining);
    }
  }

  private rateLimitWaitMs(res: Response): number {
    const retryAfter = Number(res.headers.get('retry-after'));
    if (res.headers.has('retry-after') && Number.isFinite(retryAfter)) return Math.max(0, retryAfter * 1000);
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    if (res.headers.has('x-ratelimit-reset') && Number.isFinite(reset)) return Math.max(0, reset * 1000 - this.clock());
    // Secondary limits without guidance: GitHub recommends waiting at least a minute.
    return 60_000;
  }
}

function isRateLimited(res: Response): boolean {
  if (res.status === 429) return true;
  if (res.status !== 403) return false;
  return res.headers.get('x-ratelimit-remaining') === '0' || res.headers.has('retry-after');
}

export function parseNextLink(link: string | null): string | undefined {
  if (!link) return undefined;
  for (const part of link.split(',')) {
    const match = /<([^>]+)>\s*;\s*rel="?next"?/.exec(part.trim());
    if (match) return match[1];
  }
  return undefined;
}
