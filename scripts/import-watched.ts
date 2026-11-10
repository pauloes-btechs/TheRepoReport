/**
 * Merge the repositories you *watch* on GitHub into config/watchlist.json.
 *
 *   GITHUB_TOKEN=... npm run import:watched            # writes config/watchlist.json
 *   GITHUB_TOKEN=... npm run import:watched -- --dry-run
 *   GITHUB_TOKEN=... npm run import:watched -- --file path/to/watchlist.json
 *
 * The watched list (GET /user/subscriptions) needs authentication, so this is a
 * local tool rather than a browser feature. Only public repositories are added.
 * Existing entries are never changed. The token is never printed.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { FetchLike } from '../shared/contracts';
import { WatchlistConfig, type WatchedRepo } from '../shared/schemas';

export interface Subscription {
  full_name: string;
  private: boolean;
  visibility?: string;
  topics?: string[];
  archived?: boolean;
}

export function nextLink(link: string | null): string | undefined {
  if (!link) return undefined;
  for (const part of link.split(',')) {
    const m = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
    if (m) return m[1];
  }
  return undefined;
}

export async function fetchSubscriptions(token: string, fetchImpl: FetchLike = fetch): Promise<Subscription[]> {
  const out: Subscription[] = [];
  let url: string | undefined = 'https://api.github.com/user/subscriptions?per_page=100';
  for (let page = 0; url && page < 50; page++) {
    const res: Response = await fetchImpl(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'TheRepoReport-import-watched',
      },
    });
    if (!res.ok) {
      // Do not echo headers or the request; they contain the token.
      throw new Error(`GitHub returned HTTP ${res.status} for /user/subscriptions (page ${page + 1})`);
    }
    out.push(...((await res.json()) as Subscription[]));
    url = nextLink(res.headers.get('link'));
  }
  return out;
}

export interface MergeResult {
  config: WatchlistConfig;
  added: string[];
  alreadyPresent: string[];
  skippedPrivate: string[];
  skippedArchived: string[];
}

export function mergeWatched(config: WatchlistConfig, subs: readonly Subscription[]): MergeResult {
  const existing = new Set(config.repos.map((r) => r.repo.toLowerCase()));
  const result: MergeResult = { config, added: [], alreadyPresent: [], skippedPrivate: [], skippedArchived: [] };
  const additions: WatchedRepo[] = [];
  for (const sub of subs) {
    const isPublic = sub.private === false && (sub.visibility === undefined || sub.visibility === 'public');
    if (!isPublic) {
      result.skippedPrivate.push(sub.full_name);
      continue;
    }
    if (existing.has(sub.full_name.toLowerCase())) {
      result.alreadyPresent.push(sub.full_name);
      continue;
    }
    if (sub.archived) {
      result.skippedArchived.push(sub.full_name);
      continue;
    }
    existing.add(sub.full_name.toLowerCase());
    additions.push({ repo: sub.full_name, category: 'Watched', priority: 2, enabled: true, topics: sub.topics ?? [] });
    result.added.push(sub.full_name);
  }
  result.config = WatchlistConfig.parse({ ...config, repos: [...config.repos, ...additions] });
  return result;
}

const inline = (v: unknown): string =>
  Array.isArray(v) ? `[${v.map((x) => JSON.stringify(x)).join(', ')}]` : JSON.stringify(v);

/** Same layout as the hand-written file: one repo per line. */
export function formatWatchlist(config: WatchlistConfig): string {
  const { repos, ...head } = config;
  const headLines = Object.entries(head).map(([k, v]) => `  ${JSON.stringify(k)}: ${inline(v)},`);
  const repoLines = repos.map((r, i) => {
    const body = Object.entries(r).map(([k, v]) => `${JSON.stringify(k)}: ${inline(v)}`).join(', ');
    return `    { ${body} }${i < repos.length - 1 ? ',' : ''}`;
  });
  return ['{', ...headLines, '  "repos": [', ...repoLines, '  ]', '}', ''].join('\n');
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const fileIdx = argv.indexOf('--file');
  const file = fileIdx >= 0 ? argv[fileIdx + 1] : 'config/watchlist.json';
  if (!file) throw new Error('--file needs a path');
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) {
    process.stderr.write('Set GITHUB_TOKEN (a token that can read your subscriptions) in the environment.\n');
    return 2;
  }
  const config = WatchlistConfig.parse(JSON.parse(readFileSync(file, 'utf8')));
  const subs = await fetchSubscriptions(token);
  const merged = mergeWatched(config, subs);
  const say = (s: string) => process.stdout.write(`${s}\n`);
  say(`Watched repositories found: ${subs.length}`);
  say(`  added:            ${merged.added.length}${merged.added.length ? `\n    + ${merged.added.join('\n    + ')}` : ''}`);
  say(`  already listed:   ${merged.alreadyPresent.length}`);
  say(`  skipped private:  ${merged.skippedPrivate.length}`);
  say(`  skipped archived: ${merged.skippedArchived.length}`);
  const enabled = merged.config.repos.filter((r) => r.enabled).length;
  if (enabled > merged.config.maxRepos) {
    say(`  note: ${enabled} enabled repos exceeds maxRepos (${merged.config.maxRepos}); the collector will cap the list.`);
  }
  if (merged.added.length === 0) {
    say('No changes.');
    return 0;
  }
  if (dryRun) {
    say(`Dry run: ${file} not modified.`);
    return 0;
  }
  writeFileSync(file, formatWatchlist(merged.config), 'utf8');
  say(`Updated ${file}. Review the diff, then commit it.`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`import-watched failed: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
