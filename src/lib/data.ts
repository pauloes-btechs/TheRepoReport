/**
 * Loads the static JSON the pipeline publishes and validates it against the
 * shared contracts. Nothing here is bundled: every byte comes from the site.
 */
import type { z } from 'zod';
import { EditionReport, Manifest } from '../../shared/schemas';

export type DataErrorKind = 'network' | 'http' | 'parse' | 'schema';

export class DataError extends Error {
  readonly kind: DataErrorKind;
  readonly path: string;
  readonly detail?: string;
  constructor(kind: DataErrorKind, path: string, message: string, detail?: string) {
    super(message);
    this.name = 'DataError';
    this.kind = kind;
    this.path = path;
    this.detail = detail;
  }
}

/** Absolute URL path for a file published relative to the site root. */
export function siteUrl(path: string): string {
  const base = import.meta.env.BASE_URL ?? '/';
  return `${base.endsWith('/') ? base : `${base}/`}${path.replace(/^\/+/, '')}`;
}

/** Folder of an edition, from its manifest report path ("data/editions/<key>/report.json"). */
export function editionDir(reportPath: string): string {
  const i = reportPath.lastIndexOf('/');
  return i === -1 ? '' : reportPath.slice(0, i + 1);
}

export function audioPathFor(reportPath: string, file = 'audio.mp3'): string {
  return `${editionDir(reportPath)}${file}`;
}

export function reportPathFor(key: string): string {
  return `data/editions/${key}/report.json`;
}

interface FetchOptions {
  /** Return null instead of throwing when the file does not exist. */
  allowMissing?: boolean;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

function summarizeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 4)
    .map((issue) => `${issue.path.length ? issue.path.join('.') : '(root)'}: ${issue.message}`)
    .join('; ');
}

export async function fetchValidated<S extends z.ZodType>(
  path: string,
  schema: S,
  options: FetchOptions = {},
): Promise<z.output<S> | null> {
  const doFetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  let response: Response;
  try {
    response = await doFetch(siteUrl(path), { cache: 'no-cache', signal: options.signal });
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') throw err;
    throw new DataError('network', path, 'The site data could not be reached. Check your connection and try again.');
  }
  if (response.status === 404) {
    if (options.allowMissing) return null;
    throw new DataError('http', path, 'This file is no longer published. Editions are removed after seven days.');
  }
  if (!response.ok) {
    throw new DataError('http', path, `The server answered ${response.status} for ${path}.`);
  }
  // Static hosts and the dev server answer unknown paths with the HTML shell.
  const type = response.headers.get('content-type') ?? '';
  const text = await response.text();
  if (type.includes('text/html') || /^\s*</.test(text)) {
    if (options.allowMissing) return null;
    throw new DataError('http', path, 'This file is not published.');
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new DataError('parse', path, `${path} is not valid JSON.`);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new DataError(
      'schema',
      path,
      `${path} does not match the format this site expects. The pipeline and the site may be on different versions.`,
      summarizeIssues(parsed.error),
    );
  }
  return parsed.data;
}

export function loadManifest(options: Omit<FetchOptions, 'allowMissing'> = {}): Promise<Manifest | null> {
  return fetchValidated('data/manifest.json', Manifest, { ...options, allowMissing: true });
}

export async function loadReport(path: string, options: Omit<FetchOptions, 'allowMissing'> = {}): Promise<EditionReport> {
  const report = await fetchValidated(path, EditionReport, options);
  if (!report) throw new DataError('http', path, 'This edition is not published.');
  return report;
}

/** Session cache so a report is fetched once while the tab is open. */
const reportCache = new Map<string, Promise<EditionReport>>();

export function getReport(path: string): Promise<EditionReport> {
  let pending = reportCache.get(path);
  if (!pending) {
    pending = loadReport(path);
    reportCache.set(path, pending);
    pending.catch(() => reportCache.delete(path));
  }
  return pending;
}

export function clearReportCache(): void {
  reportCache.clear();
}
