/**
 * Seven-day archive carry-forward (D1).
 *
 * A Pages deploy replaces the whole site, so every run downloads the editions
 * that are currently live, drops expired ones, and republishes the rest beside
 * the new edition. If the live archive cannot be read completely, the run must
 * abort before deploying: publishing a partial site would wipe the archive.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FetchLike, Logger } from '../../shared/contracts';
import { isExpired } from '../../shared/edition';
import { EditionReport, Manifest, type ManifestEdition } from '../../shared/schemas';

export class ArchiveUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArchiveUnavailableError';
  }
}

export type LiveManifest = { status: 'ok'; manifest: Manifest } | { status: 'missing' };

export interface FetchOptions {
  fetch?: FetchLike;
  /** Attempts per request for network errors and 5xx responses. Default 3. */
  attempts?: number;
  /** Delay between attempts. Default 2000 ms. */
  retryDelayMs?: number;
  logger?: Logger;
}

function withSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}

/** Bypass the Pages CDN cache so a just-deployed edition is seen by the next run. */
function bust(url: string, now = Date.now()): string {
  return `${url}${url.includes('?') ? '&' : '?'}t=${now}`;
}

async function fetchWithRetry(url: string, options: FetchOptions): Promise<Response> {
  const doFetch = options.fetch ?? fetch;
  const attempts = Math.max(1, options.attempts ?? 3);
  const delay = options.retryDelayMs ?? 2000;
  let lastError = '';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await doFetch(url, { cache: 'no-store', headers: { 'Cache-Control': 'no-cache' } });
      if (res.status < 500) return res;
      lastError = `HTTP ${res.status}`;
    } catch (error) {
      lastError = (error as Error).message || String(error);
    }
    options.logger?.warn('archive fetch failed', { url, attempt, error: lastError });
    if (attempt < attempts && delay > 0) await new Promise((r) => setTimeout(r, delay));
  }
  throw new ArchiveUnavailableError(`Could not fetch ${url}: ${lastError}`);
}

/**
 * Read the live manifest. Returns `missing` only for a clean 404; every other
 * failure (network, 5xx, other status, invalid JSON, schema mismatch) throws.
 */
export async function fetchLiveManifest(siteUrl: string, options: FetchOptions = {}): Promise<LiveManifest> {
  const url = `${withSlash(siteUrl)}data/manifest.json`;
  const res = await fetchWithRetry(bust(url), options);
  if (res.status === 404) return { status: 'missing' };
  if (!res.ok) throw new ArchiveUnavailableError(`Live manifest returned HTTP ${res.status}`);
  let json: unknown;
  try {
    json = await res.json();
  } catch (error) {
    throw new ArchiveUnavailableError(`Live manifest is not valid JSON: ${(error as Error).message}`);
  }
  const parsed = Manifest.safeParse(json);
  if (!parsed.success) throw new ArchiveUnavailableError(`Live manifest failed validation: ${parsed.error.message}`);
  return { status: 'ok', manifest: parsed.data };
}

export interface FirstRunDecision {
  live: LiveManifest;
  /** `state.lastEditionKey` from the previous state. */
  priorLastEditionKey?: string;
  /** ALLOW_EMPTY_ARCHIVE=1 */
  allowEmptyArchive?: boolean;
}

/**
 * Whether an absent manifest may be treated as a first run. A 404 after the
 * pipeline has already published (state remembers an edition) means the site
 * is broken, not new, unless the operator explicitly allows starting empty.
 */
export function assertArchiveUsable({ live, priorLastEditionKey, allowEmptyArchive }: FirstRunDecision): void {
  if (live.status === 'ok') return;
  if (allowEmptyArchive || !priorLastEditionKey) return;
  throw new ArchiveUnavailableError(
    `Live manifest is missing (404) but state says ${priorLastEditionKey} was published. ` +
      'Refusing to publish a site that would wipe the archive. Set ALLOW_EMPTY_ARCHIVE=1 to start over deliberately.',
  );
}

export interface StagedArchive {
  /** Editions carried forward, in manifest order. */
  carried: ManifestEdition[];
  /** Keys dropped because they expired (or are being replaced by this run). */
  dropped: string[];
  /** Validated reports of carried editions, keyed by edition key. */
  reports: Record<string, EditionReport>;
  /** Directory holding `data/editions/<key>/...` for the carried editions. */
  stagingDir: string;
}

export interface StageArchiveOptions extends FetchOptions {
  siteUrl: string;
  manifest: Manifest | null;
  /** Where to download carried editions. Wiped first. */
  stagingDir: string;
  now: Date;
  retentionDays: number;
  /** Key being published by this run; an existing copy is replaced, not carried. */
  replaceKey?: string;
}

export function expectedReportPath(key: string): string {
  return `data/editions/${key}/report.json`;
}

export function expectedAudioPath(key: string): string {
  return `data/editions/${key}/audio.mp3`;
}

/**
 * Download every non-expired edition into `stagingDir`. Nothing is written to
 * the site directory here; on any failure the staging directory is removed and
 * ArchiveUnavailableError is thrown.
 */
export async function stageArchive(options: StageArchiveOptions): Promise<StagedArchive> {
  const { manifest, stagingDir, now, retentionDays, replaceKey } = options;
  const base = withSlash(options.siteUrl);
  await rm(stagingDir, { recursive: true, force: true });
  const result: StagedArchive = { carried: [], dropped: [], reports: {}, stagingDir };
  if (!manifest) return result;

  try {
    for (const entry of manifest.editions) {
      if (entry.key === replaceKey || isExpired(entry.date, now, retentionDays)) {
        result.dropped.push(entry.key);
        continue;
      }
      // Paths come from a remote file; accept only the layout this pipeline writes.
      if (entry.reportPath !== expectedReportPath(entry.key)) {
        throw new ArchiveUnavailableError(`Unexpected reportPath for ${entry.key}: ${entry.reportPath}`);
      }
      if (entry.audioPath !== undefined && entry.audioPath !== expectedAudioPath(entry.key)) {
        throw new ArchiveUnavailableError(`Unexpected audioPath for ${entry.key}: ${entry.audioPath}`);
      }

      const reportRes = await fetchWithRetry(bust(`${base}${entry.reportPath}`), options);
      if (!reportRes.ok) throw new ArchiveUnavailableError(`Report for ${entry.key} returned HTTP ${reportRes.status}`);
      let reportJson: unknown;
      try {
        reportJson = await reportRes.json();
      } catch (error) {
        throw new ArchiveUnavailableError(`Report for ${entry.key} is not valid JSON: ${(error as Error).message}`);
      }
      const report = EditionReport.safeParse(reportJson);
      if (!report.success) throw new ArchiveUnavailableError(`Report for ${entry.key} failed validation: ${report.error.message}`);
      if (report.data.key !== entry.key) throw new ArchiveUnavailableError(`Report key ${report.data.key} does not match ${entry.key}`);

      const dir = join(stagingDir, 'data', 'editions', entry.key);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'report.json'), `${JSON.stringify(report.data, null, 2)}\n`, 'utf8');
      await writeFile(join(dir, 'transcript.json'), `${JSON.stringify(report.data.transcript, null, 2)}\n`, 'utf8');

      if (entry.audioPath) {
        const audioRes = await fetchWithRetry(bust(`${base}${entry.audioPath}`), options);
        if (!audioRes.ok) throw new ArchiveUnavailableError(`Audio for ${entry.key} returned HTTP ${audioRes.status}`);
        const bytes = new Uint8Array(await audioRes.arrayBuffer());
        if (entry.audioBytes !== undefined && bytes.byteLength !== entry.audioBytes) {
          throw new ArchiveUnavailableError(
            `Audio for ${entry.key} is ${bytes.byteLength} bytes; manifest says ${entry.audioBytes}`,
          );
        }
        await writeFile(join(dir, 'audio.mp3'), bytes);
      }

      result.carried.push(entry);
      result.reports[entry.key] = report.data;
    }
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true });
    if (error instanceof ArchiveUnavailableError) throw error;
    throw new ArchiveUnavailableError(`Archive carry-forward failed: ${(error as Error).message}`);
  }
  options.logger?.info('archive staged', { carried: result.carried.length, dropped: result.dropped });
  return result;
}
